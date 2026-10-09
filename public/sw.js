self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('isrc-store').then((cache) => cache.addAll([
      '/',
      '/index.html'
    ]))
  );
});

self.addEventListener('fetch', (e) => {
  // Let the browser handle fetching for this simple PWA
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
