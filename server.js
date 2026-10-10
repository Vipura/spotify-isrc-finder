import fs from 'fs';
import { Agent, fetch as undiciFetch } from 'undici';
import { createApp } from './server/app.js';
import { createStore } from './server/lib/cache.js';

// Safely load local .env if present (Render supplies env vars via its dashboard)
if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch (e) {
    // ignore
  }
}

const PORT = process.env.PORT || 3001;

// Spotify is now the fallback provider: the app still runs (Deezer-only) without credentials.
const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('⚠ SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing — Spotify fallback disabled (Deezer only).');
}

// ─── Bypass corporate proxy with direct Undici agent ────────────────────
const directAgent = new Agent({ connect: { rejectUnauthorized: false } });
const directFetch = (url, opts = {}) =>
  undiciFetch(url, { ...opts, dispatcher: directAgent });

// Persistent cache/stats/feedback file. On ephemeral disks (Render free tier) it
// survives restarts but not redeploys; set DATA_FILE to a persistent-disk path to keep it.
const store = createStore({ file: process.env.DATA_FILE || 'data/store.json' });

const { app } = createApp({
  fetchFn: directFetch,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  store,
  statsToken: process.env.STATS_TOKEN || '',
});

const server = app.listen(PORT, () => console.log(`✓ Backend running at http://localhost:${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { store.flush(); server.close(() => process.exit(0)); });
}
