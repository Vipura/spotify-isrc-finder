import express from 'express';
import cors from 'cors';
import { Agent, fetch as undiciFetch } from 'undici';
import fs from 'fs';

// Safely load local .env if present (Render supplies env vars via its dashboard)
if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch (e) {
    // ignore
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Load credentials from environment ──────────────────────────────────
const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in environment!');
  process.exit(1);
}

// ─── Bypass corporate proxy with direct Undici agent ────────────────────
const directAgent = new Agent({ connect: { rejectUnauthorized: false } });
const directFetch = (url, opts = {}) =>
  undiciFetch(url, { ...opts, dispatcher: directAgent });

app.use(cors());
app.use(express.json());

// Health check route
app.get('/', (req, res) => res.status(200).send('Backend is awake and running!'));

// ─── Internal: get Spotify access token (server-side client credentials) ─
let cachedToken = null;
let tokenExpiresAt = 0;

async function getSpotifyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  
  const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await directFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${authString}`,
      'User-Agent': 'curl/8.4.0',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'Failed to authenticate with Spotify');
  
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Shared track mapper ─────────────────────────────────────────────────
function mapTrack(t) {
  return {
    id: t.id,
    name: t.name,
    artists: t.artists.map(a => a.name).join(', '),
    album: t.album?.name,
    albumArt: t.album?.images?.[0]?.url || t.album?.images?.[1]?.url || null,
    previewUrl: t.preview_url || null,
    isrc: t.external_ids?.isrc || null,
    duration: t.duration_ms,
    spotifyUrl: t.external_urls?.spotify,
    popularity: t.popularity || 0,
    uri: t.uri || `spotify:track:${t.id}`,
  };
}

// ─── Simple In-Memory Cache ──────────────────────────────────────────────
class APICache {
  constructor(ttlMs) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }
  get(key) {
    if (!this.cache.has(key)) return null;
    const item = this.cache.get(key);
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    return item.data;
  }
  set(key, data) {
    this.cache.set(key, { data, expiry: Date.now() + this.ttlMs });
    if (this.cache.size > 1000) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }
}

const isrcCache = new APICache(24 * 60 * 60 * 1000); // 24 hours
const searchCache = new APICache(24 * 60 * 60 * 1000); // 24 hours
const artistTopCache = new APICache(24 * 60 * 60 * 1000); // 24 hours

// ─── Public endpoint: get ISRC for a track ID ───────────────────────────
app.get('/api/isrc/:id', async (req, res) => {
  const id = req.params.id;
  const cached = isrcCache.get(id);
  if (cached) return res.json(cached);

  try {
    const token = await getSpotifyToken();
    const response = await directFetch(
      `https://api.spotify.com/v1/tracks/${id}`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' } }
    );
    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); }
    catch {
      return res.status(500).json({ error: 'Invalid response from Spotify: ' + responseText.slice(0, 100) });
    }
    if (!response.ok) return res.status(response.status).json(data);
    
    isrcCache.set(id, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public endpoint: search tracks by name / artist ────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Missing search query.' });
  
  const normalizedQ = q.trim().toLowerCase().replace(/\s+/g, ' ');
  const cached = searchCache.get(normalizedQ);
  if (cached) return res.json(cached);

  try {
    const token = await getSpotifyToken();
    const encoded = encodeURIComponent(normalizedQ);

    const response = await directFetch(
      `https://api.spotify.com/v1/search?q=${encoded}&type=track,artist&limit=10&market=US`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' } }
    );
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    const tracks = (data.tracks?.items || []).map(mapTrack);

    const artists = (data.artists?.items || []).slice(0, 5).map(a => ({
      id: a.id,
      name: a.name,
      imageUrl: a.images?.[0]?.url || a.images?.[1]?.url || null,
      followers: a.followers?.total || 0,
      spotifyUrl: a.external_urls?.spotify,
    }));

    const result = { tracks, artists };
    searchCache.set(normalizedQ, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public endpoint: featured / popular tracks ──────────────────────────
const FEATURED_GENRES = [
  'pop', 'hip hop', 'rap', 'r&b', 'dance', 'latin', 'k-pop', 'rock',
  'indie', 'electronic', 'afrobeats', 'bollywood', 'punjabi', 'edm', 'alternative',
];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const FEATURED_TTL_MS   = 4 * 24 * 60 * 60 * 1000; // refresh Popular section once per 4 days
const FEATURED_RETRY_MS = 15 * 60 * 1000;           // back off 15 min after a failed refresh
let cachedFeaturedPool = [];
let featuredPoolExpiresAt = 0;
let featuredRefreshPromise = null;

async function refreshFeaturedPool() {
  {
    {
      const token = await getSpotifyToken();
      const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' };

      const years = `${new Date().getFullYear() - 1}-${new Date().getFullYear()}`;
      const genres = shuffle(FEATURED_GENRES).slice(0, 5);
      const results = await Promise.all(genres.map(async (genre) => {
        try {
          const offset = Math.floor(Math.random() * 20);
          const q = encodeURIComponent(`genre:"${genre}" year:${years}`);
          const r = await directFetch(
            `https://api.spotify.com/v1/search?q=${q}&type=track&limit=10&offset=${offset}&market=US`,
            { headers }
          );
          if (!r.ok) return [];
          const d = await r.json();
          return (d.tracks?.items || []).filter(Boolean).map(mapTrack);
        } catch { return []; }
      }));
      let tracksPool = results.flat();

      if (tracksPool.length === 0) {
        const r = await directFetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent('year:' + years)}&type=track&limit=10&market=US`,
          { headers }
        );
        if (r.ok) tracksPool = ((await r.json()).tracks?.items || []).filter(Boolean).map(mapTrack);
      }

      const seenIds = new Set();
      const seenArt = new Set();
      const uniquePool = [];
      for (const t of tracksPool) {
        if (!t.id || seenIds.has(t.id) || (t.albumArt && seenArt.has(t.albumArt))) continue;
        seenIds.add(t.id);
        if (t.albumArt) seenArt.add(t.albumArt);
        uniquePool.push(t);
      }
      
      if (uniquePool.length >= 8) {
        cachedFeaturedPool = uniquePool;
        featuredPoolExpiresAt = Date.now() + FEATURED_TTL_MS;
      } else {
        // Not enough fresh data: keep any stale pool and retry later
        if (uniquePool.length > cachedFeaturedPool.length) cachedFeaturedPool = uniquePool;
        featuredPoolExpiresAt = Date.now() + FEATURED_RETRY_MS;
      }
    }
  }
}

app.get('/api/featured', async (req, res) => {
  try {
    if (Date.now() > featuredPoolExpiresAt || cachedFeaturedPool.length < 8) {
      // Share one refresh between concurrent visitors
      if (!featuredRefreshPromise) {
        featuredRefreshPromise = refreshFeaturedPool()
          .catch(err => {
            console.error('Featured refresh failed:', err.message);
            featuredPoolExpiresAt = Date.now() + FEATURED_RETRY_MS;
          })
          .finally(() => { featuredRefreshPromise = null; });
      }
      await featuredRefreshPromise;
    }

    if (cachedFeaturedPool.length === 0) return res.status(503).json({ error: 'Popular songs temporarily unavailable.' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ tracks: shuffle(cachedFeaturedPool).slice(0, 8) });
  } catch (err) {
    console.error('Featured tracks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Public endpoint: get artist top tracks (popularity sorted) ──────────
app.get('/api/artists/:id/top-tracks', async (req, res) => {
  const artistId = req.params.id;
  const cached = artistTopCache.get(artistId);
  if (cached) return res.json(cached);

  try {
    const token = await getSpotifyToken();

    // Try the official top-tracks endpoint (returns tracks in popularity order - same as Spotify app)
    const response = await directFetch(
      `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' } }
    );

    if (response.ok) {
      const data = await response.json();
      const tracks = (data.tracks || []).slice(0, 10).map(mapTrack);
      const result = { tracks };
      artistTopCache.set(artistId, result);
      return res.json(result);
    }

    // Fallback: get artist name, then search 3 pages of 10 tracks (to bypass Spotify limits) and sort by popularity
    console.warn(`top-tracks returned ${response.status} for artist ${artistId}, falling back to multi-page search`);

    const artistRes = await directFetch(
      `https://api.spotify.com/v1/artists/${artistId}`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' } }
    );
    const artistData = await artistRes.json();
    const artistName = artistData.name || artistId;

    let allTracks = [];
    const encodedName = encodeURIComponent(artistName);

    // Fetch up to 3 pages to gather a good pool of tracks
    for (let offset of [0, 10, 20]) {
      const searchRes = await directFetch(
        `https://api.spotify.com/v1/search?q=${encodedName}&type=track&limit=10&market=US&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' } }
      );
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        if (searchData.tracks && searchData.tracks.items) {
          allTracks.push(...searchData.tracks.items);
        }
      }
    }

    if (allTracks.length === 0) {
      return res.status(404).json({ error: 'No tracks found' });
    }

    const artistTracks = allTracks
      .filter(track =>
        track.artists && track.artists.some(a =>
          a.id === artistId || a.name.toLowerCase() === artistName.toLowerCase()
        )
      )
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
      // Filter unique by ID (in case search returned duplicates across pages)
      .filter((track, index, self) => index === self.findIndex(t => t.id === track.id))
      .slice(0, 10)
      .map(mapTrack);

    const resultFallback = { tracks: artistTracks, artistName };
    artistTopCache.set(artistId, resultFallback);
    return res.json(resultFallback);
  } catch (err) {
    console.error('Artist top tracks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Public endpoint: resolve a 30s preview (Deezer by ISRC → iTunes verified) ─
const norm = s => (s || '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ').trim();

app.get('/api/preview', async (req, res) => {
  const { isrc, title, artist, duration } = req.query;
  const durMs = Number(duration) || 0;

  // 1. Deezer: exact lookup by ISRC (free, no key)
  if (isrc) {
    try {
      const r = await directFetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
      const d = await r.json();
      if (d && !d.error && d.preview) {
        return res.json({ previewUrl: d.preview, source: 'deezer' });
      }
    } catch (e) {
      console.warn('Deezer preview error:', e.message);
    }
  }

  // 2. iTunes fallback, strictly verified by title + artist + duration
  if (title && artist) {
    try {
      const mainArtist = String(artist).split(',')[0].trim();
      const term = encodeURIComponent(`${title} ${mainArtist}`);
      const r = await directFetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=10`);
      const d = JSON.parse(await r.text());
      const wantTitle = norm(title);
      const wantArtist = norm(mainArtist);
      const match = (d.results || []).find(x =>
        x.previewUrl &&
        norm(x.trackName) === wantTitle &&
        norm(x.artistName).includes(wantArtist) &&
        (!durMs || Math.abs((x.trackTimeMillis || 0) - durMs) <= 5000)
      );
      if (match) return res.json({ previewUrl: match.previewUrl, source: 'itunes' });
    } catch (e) {
      console.warn('iTunes preview error:', e.message);
    }
  }

  res.json({ previewUrl: null, source: null });
});

app.listen(PORT, () => console.log(`✓ Backend running at http://localhost:${PORT}`));
