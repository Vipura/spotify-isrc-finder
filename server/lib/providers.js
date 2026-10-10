import {
  Breaker, Throttle, ProviderError, ProviderBlockedError, parseRetryAfter,
} from './resilience.js';
import { normalizeIsrc, norm, durationClose, matchesReference } from './isrc.js';

const UA = 'curl/8.4.0';
const TIMEOUT_MS = 8000;

/**
 * Provider clients (Deezer / Spotify / iTunes). Every outbound call goes through
 * `request()`, which applies the circuit breaker, throttle, timeout and counters.
 * `fetchFn` is injected so tests can mock providers without any network.
 */
export function createProviders({ fetchFn, stats, clientId, clientSecret, now = Date.now }) {
  const breakers = {
    deezer:  new Breaker('deezer',  { now, defaultCooldownMs: 60_000 }),
    spotify: new Breaker('spotify', { now, defaultCooldownMs: 60_000 }),
    itunes:  new Breaker('itunes',  { now, defaultCooldownMs: 60_000 }),
  };
  // Stay safely under Deezer (~50 / 5s) and iTunes (~20 / min)
  const throttles = {
    deezer: new Throttle('deezer', 40, 5_000, 2_000, now),
    itunes: new Throttle('itunes', 18, 60_000, 3_000, now),
  };
  const spotifyEnabled = Boolean(clientId && clientSecret);

  async function request(name, kind, url, opts = {}) {
    const br = breakers[name];
    br.assertOpen();
    if (throttles[name]) await throttles[name].acquire();
    stats.hit(name, kind);

    let res;
    try {
      res = await fetchFn(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      br.fail();
      throw new ProviderError(name, e.message);
    }
    if (res.status === 429 || res.status === 403) {
      br.block(parseRetryAfter(res.headers?.get?.('retry-after'), br.defaultCooldownMs));
      throw new ProviderError(name, `HTTP ${res.status}`);
    }
    if (res.status >= 500) {
      br.fail();
      throw new ProviderError(name, `HTTP ${res.status}`);
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (res.status === 404) { br.ok(); return { ok: false, status: 404, data: null }; }
    if (!res.ok && !data) { br.fail(); throw new ProviderError(name, `HTTP ${res.status}`); }
    br.ok();
    return { ok: res.ok, status: res.status, data };
  }

  // ── Deezer ────────────────────────────────────────────────────────────
  async function deezerGet(path, kind) {
    const { data } = await request('deezer', kind, `https://api.deezer.com${path}`, { headers: { 'User-Agent': UA } });
    if (data?.error) {
      const code = data.error.code;
      if (code === 4 || /quota/i.test(data.error.type || data.error.message || '')) {
        breakers.deezer.block(breakers.deezer.defaultCooldownMs);
        throw new ProviderError('deezer', 'quota');
      }
      if (code === 800 || /data/i.test(data.error.type || '')) return null; // not found
      breakers.deezer.fail();
      throw new ProviderError('deezer', data.error.message || 'error');
    }
    return data;
  }

  const mapDeezer = (t) => ({
    id: String(t.id),
    title: t.title,
    artist: t.artist?.name || '',
    mainArtist: t.artist?.name || '',
    artistId: t.artist?.id ? String(t.artist.id) : null,
    artistImage: t.artist?.picture_medium || t.artist?.picture_big || null,
    album: t.album?.title || null,
    artwork: t.album?.cover_big || t.album?.cover_medium || t.album?.cover || null,
    duration: (t.duration || 0) * 1000,
    isrc: normalizeIsrc(t.isrc),
    deezerUrl: t.link || null,
  });

  const deezer = {
    async search(q, limit = 8, strict = false) {
      const strictParam = strict ? '&strict=on' : '';
      const d = await deezerGet(`/search?q=${encodeURIComponent(q)}${strictParam}&limit=${limit}`, 'search');
      return (d?.data || []).filter((t) => t && t.id).map(mapDeezer);
    },
    async artistSearch(q, limit = 10) {
      const d = await deezerGet(`/search/artist?q=${encodeURIComponent(q)}&limit=${limit}`, 'artistSearch');
      return (d?.data || []).filter(a => a && a.id).map(a => ({
        id: String(a.id),
        name: a.name,
        imageUrl: a.picture_xl || a.picture_big || a.picture_medium || null,
        nb_fan: a.nb_fan || 0,
      }));
    },
    /** Full track (includes ISRC + preview). Returns null if not found. */
    async track(id) {
      const d = await deezerGet(`/track/${encodeURIComponent(id)}`, 'track');
      if (!d || !d.id) return null;
      return { ...mapDeezer(d), previewUrl: d.preview || null, rawIsrc: d.isrc || null };
    },
    async artistTop(artistId, limit = 10) {
      const d = await deezerGet(`/artist/${encodeURIComponent(artistId)}/top?limit=${limit}`, 'artistTop');
      return (d?.data || []).filter((t) => t && t.id).map(mapDeezer);
    },
    async artist(artistId) {
      const d = await deezerGet(`/artist/${encodeURIComponent(artistId)}`, 'artist');
      if (!d || !d.id) return null;
      return {
        id: String(d.id),
        name: d.name,
        imageUrl: d.picture_xl || d.picture_big || d.picture_medium || null,
        nb_fan: d.nb_fan || 0,
      };
    },
    async chart(limit = 8) {
      const d = await deezerGet(`/chart/0/tracks?limit=${limit}`, 'chart');
      return (d?.data || []).filter((t) => t && t.id).map(mapDeezer);
    },
  };

  // ── Spotify ───────────────────────────────────────────────────────────
  let token = null;
  let tokenExpiresAt = 0;
  let tokenPromise = null;

  async function spotifyToken() {
    if (token && now() < tokenExpiresAt) return token;
    if (!tokenPromise) {
      tokenPromise = (async () => {
        const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const r = await request('spotify', 'token', 'https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${auth}`,
            'User-Agent': UA,
          },
          body: 'grant_type=client_credentials',
        });
        if (!r.data?.access_token) { breakers.spotify.fail(); throw new ProviderError('spotify', 'token'); }
        token = r.data.access_token;
        tokenExpiresAt = now() + Math.max(60, (r.data.expires_in || 3600) - 60) * 1000;
        return token;
      })().finally(() => { tokenPromise = null; });
    }
    return tokenPromise;
  }

  async function spotifyGet(path, kind) {
    if (!spotifyEnabled) throw new ProviderError('spotify', 'not configured');
    breakers.spotify.assertOpen();
    const tk = await spotifyToken();
    const r = await request('spotify', kind, `https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${tk}`, 'User-Agent': UA },
    });
    if (r.status === 401) { token = null; breakers.spotify.fail(); throw new ProviderError('spotify', 'unauthorized'); }
    return r.data;
  }

  const mapSpotify = (t) => {
    const names = (t.artists || []).map((a) => a.name);
    return {
      id: `sp:${t.id}`,
      title: t.name,
      name: t.name,
      artist: names.join(', '),
      mainArtist: names[0] || '',
      artistList: names,
      album: t.album?.name || null,
      artwork: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
      duration: t.duration_ms || 0,
      isrc: normalizeIsrc(t.external_ids?.isrc),
      spotifyUrl: t.external_urls?.spotify || null,
    };
  };

  const spotify = {
    enabled: spotifyEnabled,
    /** Spotify search, limit 5 by default. */
    async search(q, limit = 5) {
      const d = await spotifyGet(`/search?q=${encodeURIComponent(q)}&type=track&limit=${limit}&market=US`, 'search');
      return (d?.tracks?.items || []).filter(Boolean).map(mapSpotify);
    },
    async track(spotifyId) {
      const d = await spotifyGet(`/tracks/${encodeURIComponent(spotifyId)}`, 'track');
      return d?.id ? mapSpotify(d) : null;
    },
    /** One Spotify search; best match by normalised title + artist + duration (3s). */
    async findMatch(ref) {
      const list = await this.search(`${ref.title} ${ref.mainArtist || ref.artist}`.trim(), 5);
      return list.find((c) => c.isrc && matchesReference(c, { name: ref.title, mainArtist: ref.mainArtist || ref.artist, duration: ref.duration })) || null;
    },
  };

  // ── iTunes (preview fallback only; never trusted unless verified) ──────
  const itunes = {
    async findPreview({ title, artist, duration }) {
      if (!title || !artist) return null;
      const mainArtist = String(artist).split(',')[0].trim();
      const term = encodeURIComponent(`${title} ${mainArtist}`);
      const { data } = await request('itunes', 'search', `https://itunes.apple.com/search?term=${term}&entity=song&limit=10`, { headers: { 'User-Agent': UA } });
      const wantTitle = norm(title);
      const wantArtist = norm(mainArtist);
      const hit = (data?.results || []).find((x) =>
        x.previewUrl &&
        norm(x.trackName) === wantTitle &&
        norm(x.artistName).includes(wantArtist) &&
        duration > 0 && durationClose(x.trackTimeMillis, duration));
      return hit ? hit.previewUrl : null;
    },
  };

  return { deezer, spotify, itunes, breakers, ProviderBlockedError };
}
