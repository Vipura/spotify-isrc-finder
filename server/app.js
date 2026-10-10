import express from 'express';
import cors from 'cors';
import { createProviders } from './lib/providers.js';
import { createStore } from './lib/cache.js';
import { Stats, isProviderDown } from './lib/resilience.js';
import { normalizeIsrc, norm, scoreTrack, parseQuery, cleanQuery, jaroWinkler, generateSpellingVariants } from './lib/isrc.js';

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
export function createApp({ fetchFn, clientId, clientSecret, store = createStore(), now = Date.now, statsToken = '', minScore = 0.45 }) {
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

  const MIN_SCORE = minScore;
  const SPOTIFY_FALLBACK_THRESHOLD = 0.60;
  const ARTIST_MIN_SCORE = 0.55;

  // ─── GET /api/search?q= ───────────────────────────────────────────────
  app.get('/api/search', route(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const forceSpotify = req.query.forceSpotify === 'true';
    if (q.length < 3) return res.status(400).json({ error: 'too_short', message: 'Type at least 3 characters.' });

    const key = forceSpotify ? `search:sp:${q}` : `search:${q}`;
    const hit = cache.get(key);
    if (hit) { cacheHit('search'); return res.json({ ...hit, source: 'cache' }); }

    let result = null;
    let deezerDown = false;
    let spotifyDown = false;
    let ttl = TTL.search;

    const queryInfo = parseQuery(q);
    const variants = generateSpellingVariants(queryInfo.cleaned);

    let spotifyUsed = false;
    let subQueries = 0;
    let bestScore = 0;

    if (forceSpotify) {
      try {
        let spQ = `track:"${queryInfo.cleaned}"`;
        if (queryInfo.splits.length > 0) spQ += ` artist:"${queryInfo.splits[0].artist}"`;
        const items = (await spotify.search(spQ, 10)).filter((t) => t.isrc);
        spotifyUsed = true;
        subQueries++;
        items.forEach((t) => { rememberTrack(toRecord(t, 'spotify')); rememberMeta(t.id ? [t] : []); });
        result = { tracks: items.map((t) => toPublic({ ...t, source: 'spotify' })), artists: [], source: 'spotify' };
      } catch (e) { if (!isProviderDown(e)) throw e; spotifyDown = true; }
    } else {
      try {
        const dPromises = [];
        dPromises.push(deezer.search(`track:"${queryInfo.cleaned}"`, 50, true));
        dPromises.push(deezer.search(queryInfo.cleaned, 50, true));
        subQueries += 2;

        if (queryInfo.splits.length > 0) {
          for (const split of queryInfo.splits) {
            dPromises.push(deezer.search(`artist:"${split.artist}" track:"${split.title}"`, 25, true));
            subQueries++;
          }
        }
        
        for (const v of variants) {
          dPromises.push(deezer.search(v, 25, true));
          subQueries++;
        }

        const dResults = await Promise.all(dPromises);
        const artistProm = deezer.artistSearch(queryInfo.cleaned, 10).catch(() => []);

        const trackMap = new Map();
        dResults.flat().forEach(t => {
          if (!trackMap.has(t.id)) trackMap.set(t.id, t);
        });

        let scored = Array.from(trackMap.values()).map(t => ({ track: t, score: scoreTrack(t, queryInfo) }));
        scored.sort((a, b) => b.score - a.score);
        
        bestScore = scored.length > 0 ? scored[0].score : 0;
        let exactMatch = scored.some(s => cleanQuery(s.track.title) === queryInfo.cleaned || queryInfo.splits.some(split => cleanQuery(s.track.title) === split.title));

        if (bestScore < SPOTIFY_FALLBACK_THRESHOLD) {
          try {
            const fuzzy = await deezer.search(queryInfo.cleaned, 50, false);
            subQueries++;
            fuzzy.forEach(t => {
              if (!trackMap.has(t.id)) {
                trackMap.set(t.id, t);
                scored.push({ track: t, score: scoreTrack(t, queryInfo) });
              }
            });
            scored.sort((a, b) => b.score - a.score);
            bestScore = scored.length > 0 ? scored[0].score : 0;
            exactMatch = scored.some(s => cleanQuery(s.track.title) === queryInfo.cleaned || queryInfo.splits.some(split => cleanQuery(s.track.title) === split.title));
          } catch (e) { /* ignore */ }
        }

        if (bestScore < SPOTIFY_FALLBACK_THRESHOLD || !exactMatch) {
          try {
            let spQ = `track:"${queryInfo.cleaned}"`;
            if (queryInfo.splits.length > 0) {
              spQ += ` artist:"${queryInfo.splits[0].artist}"`;
            }
            const spItems = (await spotify.search(spQ, 10)).filter(t => t.isrc);
            spotifyUsed = true;
            
            let scoredSp = spItems.map(t => ({ track: { ...t, source: 'spotify' }, score: scoreTrack(t, queryInfo) }));
            let bestSp = scoredSp.length > 0 ? Math.max(...scoredSp.map(s => s.score)) : 0;
            
            if (bestSp < SPOTIFY_FALLBACK_THRESHOLD && variants.length > 0) {
              const spItems2 = (await spotify.search(`track:"${variants[0]}"`, 10)).filter(t => t.isrc);
              const scoredSp2 = spItems2.map(t => ({ track: { ...t, source: 'spotify' }, score: scoreTrack(t, queryInfo) }));
              scoredSp.push(...scoredSp2);
            }
            
            scored.push(...scoredSp);
            scored.sort((a, b) => b.score - a.score);
          } catch (e) { if (!isProviderDown(e)) throw e; spotifyDown = true; }
        }

        scored = scored.filter(s => s.score >= MIN_SCORE);
        
        const items = scored.map(s => s.track);

        const finalTracks = items.map(t => {
          const isSp = t.source === 'spotify';
          if (isSp) {
            const rec = toRecord(t, 'spotify');
            rememberTrack(rec);
            rememberMeta(t.id ? [t] : []);
            return toPublic({ ...t, source: 'spotify' });
          } else {
            return toPublic({ ...t, isrc: null, source: 'deezer' });
          }
        });

        const dzItems = items.filter(t => t.source !== 'spotify');
        rememberMeta(dzItems);

        const rawArtists = await artistProm;
        const scoredArtists = rawArtists.map(a => {
           let sim = jaroWinkler(cleanQuery(a.name), queryInfo.cleaned);
           if (queryInfo.splits.length > 0) {
              const artistSim = Math.max(...queryInfo.splits.map(s => jaroWinkler(cleanQuery(a.name), s.artist)));
              sim = Math.max(sim, artistSim);
           }
           return { artist: a, score: sim };
        }).filter(a => a.score >= ARTIST_MIN_SCORE).sort((a, b) => b.score - a.score);
        
        const artists = scoredArtists.map(a => a.artist);

        const hasSpotify = items.some(t => t.source === 'spotify');
        if (items.length === 0 && (deezerDown || spotifyDown)) {
          result = null;
        } else {
          result = { tracks: finalTracks, artists, source: hasSpotify ? (artists.length === 0 && items.every(t => t.source === 'spotify') ? 'spotify' : 'mixed') : 'deezer' };
        }
      } catch (e) { if (!isProviderDown(e)) throw e; deezerDown = true; }

      if (!result) {
        try {
          let spQ = `track:"${queryInfo.cleaned}"`;
          if (queryInfo.splits.length > 0) spQ += ` artist:"${queryInfo.splits[0].artist}"`;
          const items = (await spotify.search(spQ, 10)).filter((t) => t.isrc);
          spotifyUsed = true;
          subQueries++;
          items.forEach((t) => { rememberTrack(toRecord(t, 'spotify')); rememberMeta(t.id ? [t] : []); });
          result = { tracks: items.map((t) => toPublic({ ...t, source: 'spotify' })), artists: [], source: 'spotify' };
          ttl = deezerDown ? TTL.searchFallback : (items.length ? TTL.search : 60 * 60_000);
        } catch (e) { if (!isProviderDown(e)) throw e; spotifyDown = true; }
      }
    }

    if (!result) {
      const stale = cache.get(key, { stale: true });
      if (stale) { cacheHit('searchStale'); return res.json({ ...stale, source: 'cache', stale: true }); }
      return busy(res, deezerDown ? breakers.deezer.status() : breakers.spotify.status());
    }
    
    console.log(`[search] q="${q}" subQueries=${subQueries} results=${result.tracks.length} bestScore=${bestScore.toFixed(2)} spotifyUsed=${spotifyUsed}`);
    cache.set(key, result, ttl);
    res.json(result);
  }));

  // ─── Artist detail ──────────────────────────────────────────────
  app.get('/api/artists/:id', route(async (req, res) => {
    const id = req.params.id;
    const name = req.query.name;
    const isDeezerId = /^\d+$/.test(id);
    
    const hit = cache.get(`artist:${id}`);
    if (hit) { cacheHit('artist'); return res.json({ ...hit, source: 'cache' }); }
    
    try {
      let artist = null;
      if (isDeezerId) {
        artist = await deezer.artist(id);
      }
      
      if (!artist && name) {
        const dArtists = await deezer.artistSearch(name, 5).catch(() => []);
        const match = dArtists.find(a => cleanQuery(a.name) === cleanQuery(name));
        if (match) artist = match;
      }
      
      if (!artist) {
         if (name) {
            artist = { id, name, imageUrl: null, nb_fan: 0, isSpotifyOnly: true };
         } else {
            return res.status(404).json({ error: 'not_found', message: 'Artist not found.' });
         }
      }

      cache.set(`artist:${id}`, artist, 7 * DAY);
      res.json(artist);
    } catch(e) {
      if (!isProviderDown(e)) throw e;
      const stale = cache.get(`artist:${id}`, { stale: true });
      if (stale) { cacheHit('artistStale'); return res.json({ ...stale, source: 'cache', stale: true }); }
      return busy(res, breakers.deezer.status());
    }
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
    const name = req.query.name;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'bad_id', message: 'Invalid artist id.' });
    const hit = cache.get(`top:${id}`);
    if (hit) { cacheHit('top'); return res.json({ ...hit, source: 'cache' }); }
    try {
      let items = await deezer.artistTop(id, 10);
      let source = 'deezer';

      if (items.length === 0 && name) {
        try {
          const spotifyItems = await spotify.search(`artist:"${name}"`, 10);
          items = spotifyItems.filter(t => t.isrc);
          items.forEach(t => { const rec = toRecord(t, 'spotify'); rememberTrack(rec); });
          source = 'spotify';
        } catch (e) {
          if (!isProviderDown(e)) throw e;
        }
      }

      if (items.length > 0 && source === 'deezer') {
        rememberMeta(items);
      }
      
      const payload = { tracks: items.map((t) => toPublic({ ...t, isrc: source === 'spotify' ? t.isrc : null, source })) };
      cache.set(`top:${id}`, payload, TTL.top);
      res.json({ ...payload, source });
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
