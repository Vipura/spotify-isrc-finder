import express from 'express';
import cors from 'cors';
import { Agent, fetch as undiciFetch } from 'undici';

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Load credentials from environment ──────────────────────────────────
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in environment!');
  console.error('   Create a .env file with those values and run: node --env-file=.env server.js');
  process.exit(1);
}

// ─── Bypass corporate proxy with direct Undici agent ────────────────────
const directAgent = new Agent({ connect: { rejectUnauthorized: false } });
const directFetch = (url, opts = {}) =>
  undiciFetch(url, { ...opts, dispatcher: directAgent });

app.use(cors());
app.use(express.json());

// ─── Internal: get Spotify access token (server-side only) ──────────────
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
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error('Non-JSON from Spotify:', responseText.slice(0, 200));
      return res.status(500).json({ error: 'Invalid response from Spotify: ' + responseText.slice(0, 100) });
    }

    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('ISRC lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✓ Backend running at http://localhost:${PORT}`));
