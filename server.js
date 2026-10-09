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
async function getSpotifyToken() {
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
  return data.access_token;
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

// ─── Public endpoint: get ISRC for a track ID ───────────────────────────
app.get('/api/isrc/:id', async (req, res) => {
  try {
    const token = await getSpotifyToken();
    const response = await directFetch(
      `https://api.spotify.com/v1/tracks/${req.params.id}`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' } }
    );
    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); }
    catch {
      return res.status(500).json({ error: 'Invalid response from Spotify: ' + responseText.slice(0, 100) });
    }
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public endpoint: search tracks by name / artist ────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Missing search query.' });

  try {
    const token = await getSpotifyToken();
    const encoded = encodeURIComponent(q.trim());

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

    res.json({ tracks, artists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public endpoint: featured / popular tracks ──────────────────────────
app.get('/api/featured', async (req, res) => {
  try {
    const token = await getSpotifyToken();

    const playlistId = '37i9dQZF1DXcBWIGoYBM5M'; // Today's Top Hits
    const response = await directFetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=8&market=US&fields=items(track(id,name,artists,album,preview_url,external_ids,external_urls,duration_ms,popularity,uri))`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' } }
    );
    const data = await response.json();

    if (!response.ok) {
      // Fallback: use search for popular tracks
      const fallback = await directFetch(
        `https://api.spotify.com/v1/search?q=genre:pop&type=track&limit=8&market=US`,
        { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' } }
      );
      const fbData = await fallback.json();
      const tracks = (fbData.tracks?.items || []).map(mapTrack);
      return res.json({ tracks });
    }

    const tracks = (data.items || [])
      .map(item => item.track)
      .filter(Boolean)
      .slice(0, 8)
      .map(mapTrack);

    res.json({ tracks });
  } catch (err) {
    console.error('Featured tracks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Public endpoint: get artist top tracks (popularity sorted) ──────────
app.get('/api/artists/:id/top-tracks', async (req, res) => {
  try {
    const token = await getSpotifyToken();
    const artistId = req.params.id;

    // Try the official top-tracks endpoint (returns tracks in popularity order - same as Spotify app)
    const response = await directFetch(
      `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'curl/8.4.0' } }
    );

    if (response.ok) {
      const data = await response.json();
      const tracks = (data.tracks || []).slice(0, 10).map(mapTrack);
      return res.json({ tracks });
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

    return res.json({ tracks: artistTracks, artistName });
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
