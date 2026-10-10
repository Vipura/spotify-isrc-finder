import express from 'express';
import cors from 'cors';
import { createProviders } from './lib/providers.js';
import { createStore } from './lib/cache.js';
import { Stats, isProviderDown } from './lib/resilience.js';
import { normalizeIsrc, norm } from './lib/isrc.js';

const DAY = 24 * 60 * 60 * 1000;
const TTL = {
  search: DAY,                 // normalised query → results
  searchFallback: 10 * 60_000, // results served only because Deezer was down
  track: 30 * DAY,             // ISRC + metadata (never preview URLs)
  meta: DAY,                   // metadata of search hits (needed for fallbacks)
  alts: DAY,
  top: DAY,
  featured: 4 * DAY,
};
const FEATURED_RETRY_MS = 15 * 60_000;
const ID_RE = /^(sp:[A-Za-z0-9]+|\d+)$/;
const BUSY_MSG = 'Our music sources are busy right now. Please try again in a moment.';

/**
 * Builds the Express app. Providers are reachable only through `fetchFn`
 * (injected) so tests can mock Deezer / Spotify / iTunes completely.
 */
export function createApp({ fetchFn, clientId, clientSecret, store = createStore(), now = Date.now, statsToken = '' }) {
  const { cache, state } = store;
  const stats = new Stats(state.stats);
  state.stats = stats.data;
  const providers = createProviders({ fetchFn, stats, clientId, clientSecret, now });
  const { deezer, spotify, itunes, breakers } = providers;

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '4kb' }));
  app.use('/api', (req, res, next) => { res.on('finish', () => store.markDirty()); next(); });

  app.get('/', (req, res) => res.status(200).send('Backend is awake and running!'));

  // ─── helpers ──────────────────────────────────────────────────────────
  const route = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      console.error(`${req.method} ${req.path} failed:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'server', message: 'Something went wrong. Please try again.' });
    }
  };
  const busy = (res, e) => res.status(503).json({
    error: 'busy', message: BUSY_MSG, retryInMs: e?.retryInMs ?? 60_000, source: 'cache',
  });
  const cacheHit = (kind) => stats.cacheHit(kind);

  const toPublic = (t) => ({
    id: t.id, title: t.title, artist: t.artist, artwork: t.artwork || null,
    album: t.album || null, duration: t.duration || 0, isrc: t.isrc || null,
    source: t.source, spotifyUrl: t.spotifyUrl || null,
  });
  const toRecord = (t, source) => ({
    id: t.id, title: t.title, artist: t.artist, mainArtist: t.mainArtist || t.artist,
    artwork: t.artwork || null, album: t.album || null, duration: t.duration || 0,
    isrc: t.isrc || null, source, spotifyUrl: t.spotifyUrl || null,
  });
  const toMeta = (t) => ({
    id: t.id, title: t.title, artist: t.artist, mainArtist: t.mainArtist || t.artist,
    artwork: t.artwork || null, album: t.album || null, duration: t.duration || 0,
  });
  const rememberMeta = (items) => items.forEach((t) => cache.set(`meta:${t.id}`, toMeta(t), TTL.meta));
  const rememberTrack = (rec) => cache.set(`track:${rec.id}`, rec, TTL.track);

  /** Best known title/artist/duration for an id without any external call. */
  const knownRef = (id) => cache.get(`track:${id}`, { stale: true }) || cache.get(`meta:${id}`, { stale: true });

  // ─── GET /api/search?q= ───────────────────────────────────────────────
  app.get('/api/search', route(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (q.length < 3) return res.status(400).json({ error: 'too_short', message: 'Type at least 3 characters.' });

    const key = `search:${q}`;
    const hit = cache.get(key);
    if (hit) { cacheHit('search'); return res.json({ ...hit, source: 'cache' }); }

    let result = null;
    let deezerDown = false;
    let spotifyDown = false;
    let ttl = TTL.search;

    try {
      const items = await deezer.search(q, 8);
      if (items.length) {
        rememberMeta(items);
        const seen = new Set();
        const artists = [];
        for (const t of items) {
          if (!t.artistId || seen.has(t.artistId)) continue;
          seen.add(t.artistId);
          artists.push({ id: t.artistId, name: t.artist, imageUrl: t.artistImage });
          if (artists.length === 5) break;
        }
        result = {
          tracks: items.map((t) => toPublic({ ...t, isrc: null, source: 'deezer' })), // search results carry no ISRC
          artists,
          source: 'deezer',
        };
      }
    } catch (e) { if (!isProviderDown(e)) throw e; deezerDown = true; }

    if (!result) {
      // Automatic Spotify fallback: Deezer found nothing or is unavailable
      try {
        const items = (await spotify.search(q, 5)).filter((t) => t.isrc);
        items.forEach((t) => { rememberTrack(toRecord(t, 'spotify')); rememberMeta(t.id ? [t] : []); });
        result = { tracks: items.map((t) => toPublic({ ...t, source: 'spotify' })), artists: [], source: 'spotify' };
        ttl = deezerDown ? TTL.searchFallback : (items.length ? TTL.search : 60 * 60_000);
      } catch (e) { if (!isProviderDown(e)) throw e; spotifyDown = true; }
    }

    if (!result) {
      const stale = cache.get(key, { stale: true });
      if (stale) { cacheHit('searchStale'); return res.json({ ...stale, source: 'cache', stale: true }); }
      return busy(res, deezerDown ? breakers.deezer.status() : breakers.spotify.status());
    }
    cache.set(key, result, ttl);
    res.json(result);
  }));

  // ─── Track resolution (shared by /api/track and /api/isrc) ───────────
  async function resolveSpotifyTrack(id) {
    const t = await spotify.track(id.slice(3));
    if (!t || !t.isrc) return null;
    const rec = toRecord(t, 'spotify');
    rememberTrack(rec);
    return rec;
  }

  app.get('/api/track/:id', route(async (req, res) => {
    const id = req.params.id;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad_id', message: 'Invalid track id.' });

    const hit = cache.get(`track:${id}`);
    if (hit) { cacheHit('track'); return res.json({ track: toPublic(hit), source: 'cache' }); }

    let down = false;

    if (id.startsWith('sp:')) {
      try {
        const rec = await resolveSpotifyTrack(id);
        if (rec) return res.json({ track: toPublic(rec), source: 'spotify' });
        return res.status(404).json({ error: 'no_isrc', message: "We couldn't find a valid ISRC for this track." });
      } catch (e) {
        if (!isProviderDown(e)) throw e;
        return busy(res, e);
      }
    }

    // 1) Deezer track endpoint
    let ref = cache.get(`meta:${id}`);
    try {
      const t = await deezer.track(id);
      if (t) {
        ref = toMeta(t);
        if (t.isrc) {
          const rec = toRecord(t, 'deezer');
          rememberTrack(rec);
          return res.json({ track: toPublic(rec), source: 'deezer' });
        }
      }
    } catch (e) { if (!isProviderDown(e)) throw e; down = true; }

    // 2) Automatic Spotify fallback (Deezer failed / ISRC missing or invalid)
    if (ref) {
      try {
        const m = await spotify.findMatch(ref);
        if (m) {
          const rec = toRecord({ ...ref, isrc: m.isrc, spotifyUrl: m.spotifyUrl }, 'spotify');
          rememberTrack(rec);
          return res.json({ track: toPublic(rec), source: 'spotify' });
        }
      } catch (e) { if (!isProviderDown(e)) throw e; down = true; }
    } else {
      down = true; // no metadata to search with and Deezer unavailable
    }

    if (down) {
      const stale = cache.get(`track:${id}`, { stale: true });
      if (stale) { cacheHit('trackStale'); return res.json({ track: toPublic(stale), source: 'cache', stale: true }); }
      return busy(res);
    }
    res.status(404).json({ error: 'no_isrc', message: "We couldn't find a valid ISRC for this track." });
  }));

  // Pasted Spotify link → Spotify track lookup (cached 30 days)
  app.get('/api/isrc/:id', route(async (req, res) => {
    const sid = req.params.id;
    if (!/^[A-Za-z0-9]+$/.test(sid)) return res.status(400).json({ error: 'bad_id', message: 'Invalid track id.' });
    const id = `sp:${sid}`;
    const hit = cache.get(`track:${id}`);
    if (hit) { cacheHit('track'); return res.json({ track: toPublic(hit), source: 'cache' }); }
    try {
      const rec = await resolveSpotifyTrack(id);
      if (!rec) return res.status(404).json({ error: 'no_isrc', message: "We couldn't find a valid ISRC for this track." });
      res.json({ track: toPublic(rec), source: 'spotify' });
    } catch (e) {
      if (!isProviderDown(e)) throw e;
      const stale = cache.get(`track:${id}`, { stale: true });
      if (stale) return res.json({ track: toPublic(stale), source: 'cache', stale: true });
      busy(res, e);
    }
  }));

  // ─── GET /api/track/:id/alternatives (Deezer only, free) ─────────────
  app.get('/api/track/:id/alternatives', route(async (req, res) => {
    const id = req.params.id;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad_id', message: 'Invalid track id.' });

    const hit = cache.get(`alts:${id}`);
    if (hit) { cacheHit('alts'); return res.json({ ...hit, source: 'cache' }); }

    try {
      let ref = knownRef(id);
      if (!ref && !id.startsWith('sp:')) {
        const t = await deezer.track(id);
        if (t) { ref = toMeta(t); }
      }
      if (!ref) return res.status(404).json({ error: 'unknown_track', message: 'Track not found.' });

      const main = ref.mainArtist || ref.artist;
      const list = await deezer.search(`artist:"${main}" track:"${ref.title}"`, 25);
      const wantTitle = norm(ref.title);
      const wantArtist = norm(main);
      const seen = new Set();
      const alternatives = list
        .filter((t) => t.id !== id)
        .filter((t) => {
          const nt = norm(t.title);
          const na = norm(t.artist);
          return nt && (nt === wantTitle || nt.includes(wantTitle) || wantTitle.includes(nt)) &&
            (na === wantArtist || na.includes(wantArtist) || wantArtist.includes(na));
        })
        .filter((t) => { const k = `${t.album}|${t.duration}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 8);
      rememberMeta(alternatives);
      const payload = { alternatives: alternatives.map((t) => toPublic({ ...t, isrc: null, source: 'deezer' })) };
      cache.set(`alts:${id}`, payload, TTL.alts);
      res.json({ ...payload, source: 'deezer' });
    } catch (e) {
      if (!isProviderDown(e)) throw e;
      busy(res, e);
    }
  }));

  // ─── GET /api/track/:id/spotify ("Spotify's code", at most one call) ──
  app.get('/api/track/:id/spotify', route(async (req, res) => {
    const id = req.params.id;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad_id', message: 'Invalid track id.' });

    const current = cache.get(`track:${id}`, { stale: true });
    const hit = cache.get(`spotifyalt:${id}`);
    const respond = (alt, source) => res.json({
      track: alt, differs: Boolean(alt && current?.isrc && alt.isrc !== current.isrc), source,
    });
    if (hit) { cacheHit('spotifyalt'); return respond(hit.track, 'cache'); }

    // Current code already came from Spotify → nothing different to offer
    if (id.startsWith('sp:') || current?.source === 'spotify') {
      return res.json({ track: null, differs: false, source: 'cache' });
    }
    const ref = knownRef(id);
    if (!ref) return res.status(404).json({ error: 'unknown_track', message: 'Track not found.' });

    try {
      const m = await spotify.findMatch(ref);
      const track = m ? toPublic({ ...ref, isrc: m.isrc, spotifyUrl: m.spotifyUrl, source: 'spotify' }) : null;
      cache.set(`spotifyalt:${id}`, { track }, TTL.track); // negative results cached too → max one call
      respond(track, 'spotify');
    } catch (e) {
      if (!isProviderDown(e)) throw e;
      busy(res, e);
    }
  }));

  // ─── GET /api/preview/:id (never cached) ─────────────────────────────
  app.get('/api/preview/:id', route(async (req, res) => {
    const id = req.params.id;
    res.set('Cache-Control', 'no-store');
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad_id', message: 'Invalid track id.' });

    let ref = knownRef(id);
    if (!ref && req.query.title && req.query.artist) {
      ref = { title: String(req.query.title), artist: String(req.query.artist), duration: Number(req.query.duration) || 0 };
    }
    let consulted = 'deezer';

    if (!id.startsWith('sp:')) {
      try {
        const t = await deezer.track(id); // fresh URL on every play
        if (t) {
          ref = ref || toMeta(t);
          if (t.previewUrl) return res.json({ previewUrl: t.previewUrl, source: 'deezer' });
        }
      } catch (e) { if (!isProviderDown(e)) throw e; }
    }

    if (ref) {
      consulted = 'itunes';
      try {
        const url = await itunes.findPreview({ title: ref.title, artist: ref.mainArtist || ref.artist, duration: ref.duration });
        if (url) return res.json({ previewUrl: url, source: 'itunes' });
      } catch (e) { if (!isProviderDown(e)) throw e; }
    }
    res.json({ previewUrl: null, source: consulted, message: 'No preview available' });
  }));

  // ─── Popular on Spotify tab: one shared set, refreshed every 4 days ──
  let featuredRetryAt = 0;
  let featuredPromise = null;

  async function refreshFeatured() {
    let tracks = [];
    let source = 'deezer';
    try {
      const chart = await deezer.chart(12);
      rememberMeta(chart);
      for (const c of chart) {
        if (tracks.length >= 8) break;
        const t = await deezer.track(c.id).catch((e) => { if (!isProviderDown(e)) throw e; return null; });
        if (t?.isrc) { const rec = toRecord(t, 'deezer'); rememberTrack(rec); tracks.push(rec); }
      }
    } catch (e) { if (!isProviderDown(e)) throw e; }

    if (tracks.length < 8) {
      source = 'spotify';
      const y = new Date().getFullYear();
      try {
        const items = (await spotify.search(`year:${y - 1}-${y}`, 10)).filter((t) => t.isrc);
        tracks = items.slice(0, 8).map((t) => { const rec = toRecord(t, 'spotify'); rememberTrack(rec); return rec; });
      } catch (e) { if (!isProviderDown(e)) throw e; }
    }
    if (tracks.length >= 8) {
      cache.set('featured', { tracks, expiresAt: now() + TTL.featured, source }, 30 * DAY);
    } else {
      featuredRetryAt = now() + FEATURED_RETRY_MS;
    }
  }

  app.get('/api/featured', route(async (req, res) => {
    let data = cache.get('featured', { stale: true });
    if ((!data || now() > data.expiresAt) && now() >= featuredRetryAt) {
      featuredPromise ||= refreshFeatured().finally(() => { featuredPromise = null; });
      await featuredPromise;
      data = cache.get('featured', { stale: true });
    } else if (data) {
      cacheHit('featured');
    }
    if (!data) return busy(res);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({
      tracks: data.tracks.map(toPublic),
      expiresAt: now() > data.expiresAt ? now() + FEATURED_RETRY_MS : data.expiresAt,
      source: now() > data.expiresAt ? 'cache' : (data.source || 'cache'),
    });
  }));

  // ─── Artist top tracks (Deezer, free) ────────────────────────────────
  app.get('/api/artists/:id/top-tracks', route(async (req, res) => {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'bad_id', message: 'Invalid artist id.' });
    const hit = cache.get(`top:${id}`);
    if (hit) { cacheHit('top'); return res.json({ ...hit, source: 'cache' }); }
    try {
      const items = await deezer.artistTop(id, 10);
      rememberMeta(items);
      const payload = { tracks: items.map((t) => toPublic({ ...t, isrc: null, source: 'deezer' })) };
      cache.set(`top:${id}`, payload, TTL.top);
      res.json({ ...payload, source: 'deezer' });
    } catch (e) {
      if (!isProviderDown(e)) throw e;
      const stale = cache.get(`top:${id}`, { stale: true });
      if (stale) return res.json({ ...stale, source: 'cache', stale: true });
      busy(res, e);
    }
  }));

  // ─── Feedback + stats ────────────────────────────────────────────────
  const fbHits = new Map(); // ip → [timestamps] (tiny abuse guard, no personal data stored)
  app.post('/api/feedback', route(async (req, res) => {
    const ip = req.ip || 'x';
    const t = now();
    const recent = (fbHits.get(ip) || []).filter((x) => x > t - 60_000);
    if (recent.length >= 20) return res.status(429).json({ error: 'slow_down', message: 'Too many submissions, please wait a moment.', source: 'cache' });
    fbHits.set(ip, [...recent, t]);
    if (fbHits.size > 5000) fbHits.clear();

    const isrc = normalizeIsrc(req.body?.isrc);
    const source = req.body?.source;
    const result = req.body?.result;
    if (!isrc || !['deezer', 'spotify'].includes(source) || !['worked', 'failed'].includes(result)) {
      return res.status(400).json({ error: 'bad_feedback', message: 'Invalid feedback.' });
    }
    const fb = state.feedback;
    fb.counts[source] ||= { worked: 0, failed: 0 };
    fb.counts[source][result]++;
    fb.log.push({ isrc, source, timestamp: new Date(t).toISOString(), result });
    if (fb.log.length > 2000) fb.log.splice(0, fb.log.length - 2000);
    res.json({ ok: true, source: 'cache' });
  }));

  app.get('/api/stats', route(async (req, res) => {
    if (statsToken && req.query.token !== statsToken) return res.status(401).json({ error: 'unauthorized' });
    res.json({
      since: stats.data.since,
      calls: stats.data.calls,
      cacheHits: stats.data.cacheHits,
      breakers: Object.fromEntries(Object.entries(breakers).map(([k, b]) => [k, b.status()])),
      feedback: state.feedback.counts,
      feedbackTotal: state.feedback.log.length,
      cacheEntries: cache.cache.size,
      source: 'cache',
    });
  }));

  return { app, providers, stats, store };
}
