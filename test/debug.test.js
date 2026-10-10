import test from 'node:test';
import { createApp } from '../server/app.js';
import { createStore } from '../server/lib/cache.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const DZ_TRACK = (over = {}) => ({
  id: 1, title: 'Blinding Lights', duration: 200, link: 'https://deezer/1',
  artist: { id: 9, name: 'The Weeknd', picture_medium: 'pic' },
  album: { title: 'After Hours', cover_big: 'cover' },
  ...over,
});

test('debug search', async () => {
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'api.deezer.com') {
        if (u.pathname === '/search') return json({ data: [DZ_TRACK()] });
        return json({ data: [] });
    }
    return json({});
  };
  const app = createApp({ fetchFn, clientId: '1', clientSecret: '2', store: createStore(), minScore: 0 });
  const server = app.app.listen(0);
  
  await new Promise(r => server.on('listening', r));
  
  const base = `http://127.0.0.1:${server.address().port}`;
  
  const r = await fetch(`${base}/api/search?q=blinding lights`);
  console.log('Status:', r.status);
  console.log('Body:', await r.text());
  server.close();
});
