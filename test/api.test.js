import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createStore } from '../server/lib/cache.js';
import { normalizeIsrc } from '../server/lib/isrc.js';

// ─── Mock providers (no network) ────────────────────────────────────────
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const DZ_TRACK = (over = {}) => ({
  id: 1, title: 'Blinding Lights', duration: 200, link: 'https://deezer/1',
  artist: { id: 9, name: 'The Weeknd', picture_medium: 'pic' },
  album: { title: 'After Hours', cover_big: 'cover' },
  ...over,
});
const SP_TRACK = (over = {}) => ({
  id: 'sp1', name: 'Blinding Lights', duration_ms: 200_000,
  artists: [{ name: 'The Weeknd' }], album: { name: 'After Hours', images: [{ url: 'img' }] },
  external_ids: { isrc: 'USUG11904206' }, external_urls: { spotify: 'https://open.spotify.com/track/sp1' },
  ...over,
});

function setup(handlers = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    calls.push(`${u.hostname}${u.pathname}`);
    const h = u.hostname === 'api.deezer.com' ? handlers.deezer
      : u.hostname === 'api.spotify.com' ? handlers.spotify
      : u.hostname === 'accounts.spotify.com' ? (handlers.token || (() => json({ access_token: 'T', expires_in: 3600 })))
      : u.hostname === 'itunes.apple.com' ? handlers.itunes : null;
    if (!h) throw new Error(`unmocked ${url}`);
    return h(u);
  };
  const defaultDeezer = (u) => {
    if (u.pathname === '/search') return json({ data: [DZ_TRACK()] });
    if (u.pathname.startsWith('/track/')) return json(DZ_TRACK({ isrc: 'usug11904206', preview: 'https://cdn/preview.mp3' }));
    return json({ data: [] });
  };
  const built = createApp({
    fetchFn,
    clientId: 'id',
    clientSecret: 'secret',
    store: createStore(),
    minScore: 0,
    ...{},
  });
  // swap in handlers lazily (so each test can define behaviour before use)
  handlers.deezer ||= defaultDeezer;
  handlers.spotify ||= () => json({ tracks: { items: [SP_TRACK()] } });
  handlers.itunes ||= () => json({ results: [] });
  return { ...built, calls, handlers };
}

async function withServer(ctx, fn) {
  const server = ctx.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ get, post }); } finally { server.close(); }
}
const count = (ctx, host) => ctx.calls.filter((c) => c.startsWith(host)).length;
const spotifySearches = (ctx) => ctx.calls.filter((c) => c === 'api.spotify.com/v1/search').length;

// ─── Tests ──────────────────────────────────────────────────────────────
test('normalizeIsrc trims, uppercases and rejects invalid codes', () => {
  assert.equal(normalizeIsrc('  usug11904206 '), 'USUG11904206');
  assert.equal(normalizeIsrc('US-UG1-19-04206'), null);
  assert.equal(normalizeIsrc('USUG1190420'), null);
  assert.equal(normalizeIsrc(''), null);
  assert.equal(normalizeIsrc(null), null);
});

test('repeated search → zero external calls', async () => {
  const ctx = setup();
  await withServer(ctx, async ({ get }) => {
    const a = await get('/api/search?q=Blinding%20Lights');
    assert.equal(a.body.source, 'deezer');
    const before = ctx.calls.length;
    const b = await get('/api/search?q=  blinding   LIGHTS ');
    assert.equal(b.body.source, 'cache');
    assert.equal(ctx.calls.length, before);
  });
});

test('search needs at least 3 characters', async () => {
  const ctx = setup();
  await withServer(ctx, async ({ get }) => {
    const r = await get('/api/search?q=ab');
    assert.equal(r.status, 400);
    assert.equal(ctx.calls.length, 0);
  });
});

test('normal search + tap → zero Spotify calls, valid ISRC', async () => {
  const ctx = setup();
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    assert.equal(s.body.tracks[0].isrc, null); // search carries no ISRC
    const t = await get(`/api/track/${s.body.tracks[0].id}`);
    assert.equal(t.body.track.isrc, 'USUG11904206');
    assert.equal(t.body.source, 'deezer');
    assert.equal(count(ctx, 'api.spotify.com') + count(ctx, 'accounts.spotify.com'), 0);
    const again = await get(`/api/track/${s.body.tracks[0].id}`);
    assert.equal(again.body.source, 'cache');
  });
});

test('song missing on Deezer → exactly one Spotify search', async () => {
  const ctx = setup({ deezer: () => json({ data: [] }) });
  await withServer(ctx, async ({ get }) => {
    const r = await get('/api/search?q=blinding lights');
    assert.equal(r.body.source, 'spotify');
    assert.equal(r.body.tracks[0].isrc, 'USUG11904206');
    assert.equal(spotifySearches(ctx), 1);
  });
});

test('invalid ISRCs never reach the UI', async () => {
  const ctx = setup({
    deezer: (u) => u.pathname === '/search'
      ? json({ data: [DZ_TRACK()] })
      : json(DZ_TRACK({ isrc: 'NOT-AN-ISRC' })),
    spotify: () => json({ tracks: { items: [SP_TRACK({ external_ids: { isrc: 'bad' } })] } }),
  });
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    const t = await get(`/api/track/${s.body.tracks[0].id}`);
    assert.equal(t.status, 404);
    assert.equal(t.body.track, undefined);
  });
});

test('Deezer ISRC missing → automatic Spotify fallback, Deezer id kept', async () => {
  const ctx = setup({
    deezer: (u) => u.pathname === '/search' ? json({ data: [DZ_TRACK()] }) : json(DZ_TRACK({ isrc: '' })),
  });
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    const t = await get(`/api/track/${s.body.tracks[0].id}`);
    assert.equal(t.body.source, 'spotify');
    assert.equal(t.body.track.id, '1');
    assert.equal(spotifySearches(ctx), 1);
  });
});

test('"Spotify\'s code" → at most one Spotify call, then cached; shown only if different', async () => {
  const ctx = setup({ spotify: () => json({ tracks: { items: [SP_TRACK({ external_ids: { isrc: 'USUG11999999' } })] } }) });
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    const id = s.body.tracks[0].id;
    await get(`/api/track/${id}`);
    const a = await get(`/api/track/${id}/spotify`);
    assert.equal(a.body.differs, true);
    assert.equal(a.body.track.isrc, 'USUG11999999');
    const b = await get(`/api/track/${id}/spotify`);
    assert.equal(b.body.source, 'cache');
    assert.equal(spotifySearches(ctx), 1);
  });
});

test('"Spotify\'s code" with identical ISRC → differs=false', async () => {
  const ctx = setup();
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    const id = s.body.tracks[0].id;
    await get(`/api/track/${id}`);
    const a = await get(`/api/track/${id}/spotify`);
    assert.equal(a.body.differs, false);
  });
});

test('alternatives come from Deezer only (zero Spotify)', async () => {
  const ctx = setup({
    deezer: (u) => {
      if (u.pathname === '/search') return json({ data: [DZ_TRACK(), DZ_TRACK({ id: 2, title: 'Blinding Lights (Remastered)', album: { title: 'Remaster', cover_big: 'c2' } })] });
      return json(DZ_TRACK({ isrc: 'usug11904206' }));
    },
  });
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    const alts = await get(`/api/track/${s.body.tracks[0].id}/alternatives`);
    assert.equal(alts.body.alternatives.length, 1);
    assert.equal(alts.body.alternatives[0].id, '2');
    assert.equal(count(ctx, 'api.spotify.com') + count(ctx, 'accounts.spotify.com'), 0);
  });
});

test('Spotify 429 → app keeps working via Deezer; Spotify is then skipped', async () => {
  const ctx = setup({ spotify: () => json({}, 429, { 'retry-after': '120' }) });
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    const t = await get(`/api/track/${s.body.tracks[0].id}`);
    assert.equal(t.body.track.isrc, 'USUG11904206');
    // Deezer search for a song only on Spotify-fallback path → blocked, friendly
    const ctx2 = setup({ deezer: () => json({ data: [] }), spotify: () => json({}, 429, { 'retry-after': '120' }) });
    await withServer(ctx2, async ({ get: g2 }) => {
      const r1 = await g2('/api/search?q=nothing here');
      assert.equal(r1.status, 503);
      assert.match(r1.body.message, /try again/i);
      const spCalls = count(ctx2, 'api.spotify.com') + count(ctx2, 'accounts.spotify.com');
      await g2('/api/search?q=other nothing');
      assert.equal(count(ctx2, 'api.spotify.com') + count(ctx2, 'accounts.spotify.com'), spCalls); // breaker open
      const st = await g2('/api/stats');
      assert.equal(st.body.breakers.spotify.blocked, true);
    });
  });
});

test('Deezer failing → falls back to Spotify (search + track)', async () => {
  const ctx = setup({ deezer: () => json({}, 500) });
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    assert.equal(s.body.source, 'spotify');
    const t = await get(`/api/track/${s.body.tracks[0].id}`);
    assert.equal(t.body.track.isrc, 'USUG11904206');
  });
});

test('Deezer 429 blocks Deezer; Spotify serves', async () => {
  const ctx = setup({ deezer: () => json({}, 429) });
  await withServer(ctx, async ({ get }) => {
    const a = await get('/api/search?q=blinding lights');
    assert.equal(a.body.source, 'spotify');
    const dz = count(ctx, 'api.deezer.com');
    await get('/api/search?q=another query');
    assert.equal(count(ctx, 'api.deezer.com'), dz); // blocked, not called again
  });
});

test('Spotify token is requested once and reused', async () => {
  const ctx = setup({ deezer: () => json({ data: [] }) });
  await withServer(ctx, async ({ get }) => {
    await get('/api/search?q=first query');
    await get('/api/search?q=second query');
    await get('/api/search?q=third query');
    assert.equal(count(ctx, 'accounts.spotify.com'), 1);
    assert.ok(spotifySearches(ctx) >= 3);
  });
});

test('iTunes: unverified matches are never played; verified ones are', async () => {
  const ctx = setup({
    deezer: (u) => u.pathname === '/search' ? json({ data: [DZ_TRACK()] }) : json(DZ_TRACK({ isrc: 'usug11904206', preview: '' })),
    itunes: () => json({ results: [
      { trackName: 'Blinding Lights', artistName: 'The Weeknd', trackTimeMillis: 260_000, previewUrl: 'wrong-duration' },
      { trackName: 'Blinding Lights (Cover)', artistName: 'Someone Else', trackTimeMillis: 200_000, previewUrl: 'wrong-artist' },
      { trackName: 'Other Song', artistName: 'The Weeknd', trackTimeMillis: 200_000, previewUrl: 'wrong-title' },
    ] }),
  });
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    const p = await get(`/api/preview/${s.body.tracks[0].id}`);
    assert.equal(p.body.previewUrl, null);

    ctx.handlers.itunes = () => json({ results: [
      { trackName: 'Blinding Lights', artistName: 'The Weeknd', trackTimeMillis: 201_500, previewUrl: 'good' },
    ] });
    const p2 = await get(`/api/preview/${s.body.tracks[0].id}`);
    assert.equal(p2.body.previewUrl, 'good');
    assert.equal(p2.body.source, 'itunes');
  });
});

test('preview: Deezer preview used first and fetched fresh every play', async () => {
  const ctx = setup();
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    const id = s.body.tracks[0].id;
    const a = await get(`/api/preview/${id}`);
    const b = await get(`/api/preview/${id}`);
    assert.equal(a.body.source, 'deezer');
    assert.equal(a.body.previewUrl, 'https://cdn/preview.mp3');
    assert.equal(b.body.source, 'deezer'); // not served from cache
    assert.equal(count(ctx, 'itunes.apple.com'), 0);
  });
});

test('feedback is validated, counted per source, and exposed at /api/stats', async () => {
  const ctx = setup();
  await withServer(ctx, async ({ get, post }) => {
    assert.equal((await post('/api/feedback', { isrc: 'bad', source: 'deezer', result: 'worked' })).status, 400);
    assert.equal((await post('/api/feedback', { isrc: 'USUG11904206', source: 'deezer', result: 'worked' })).status, 200);
    await post('/api/feedback', { isrc: 'USUG11904206', source: 'deezer', result: 'failed' });
    await post('/api/feedback', { isrc: 'USUG11904206', source: 'spotify', result: 'worked' });
    const st = await get('/api/stats');
    assert.deepEqual(st.body.feedback.deezer, { worked: 1, failed: 1 });
    assert.deepEqual(st.body.feedback.spotify, { worked: 1, failed: 0 });
    assert.ok(st.body.calls.spotify && st.body.calls.deezer && st.body.calls.itunes && st.body.cacheHits);
  });
});

test('every response includes a source', async () => {
  const ctx = setup();
  await withServer(ctx, async ({ get }) => {
    const s = await get('/api/search?q=blinding lights');
    assert.ok(s.body.source);
    const id = s.body.tracks[0].id;
    for (const p of [`/api/track/${id}`, `/api/track/${id}/alternatives`, `/api/preview/${id}`, '/api/featured', '/api/stats']) {
      const r = await get(p);
      assert.ok(['cache', 'deezer', 'spotify', 'itunes'].includes(r.body.source), `${p} → ${r.body.source}`);
    }
  });
});

test('featured tab: built from Deezer chart, shared set, zero Spotify, cached for 4 days', async () => {
  const chart = Array.from({ length: 12 }, (_, i) => DZ_TRACK({ id: 100 + i, title: `Hit ${i}` }));
  const ctx = setup({
    deezer: (u) => {
      if (u.pathname.startsWith('/chart')) return json({ data: chart });
      if (u.pathname.startsWith('/track/')) return json(DZ_TRACK({ id: Number(u.pathname.split('/')[2]), isrc: 'usug11904206' }));
      return json({ data: [] });
    },
  });
  await withServer(ctx, async ({ get }) => {
    const a = await get('/api/featured');
    assert.equal(a.body.tracks.length, 8);
    assert.ok(a.body.tracks.every((t) => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(t.isrc)));
    const before = ctx.calls.length;
    const b = await get('/api/featured');
    assert.deepEqual(b.body.tracks, a.body.tracks); // same set for everyone
    assert.equal(ctx.calls.length, before);
    assert.equal(count(ctx, 'api.spotify.com') + count(ctx, 'accounts.spotify.com'), 0);
  });
});
