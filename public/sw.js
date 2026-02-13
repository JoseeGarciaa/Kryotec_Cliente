const STATIC_CACHE = 'kryo-static-v6';
const OFFLINE_URL = '/pwa-start';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll([
      OFFLINE_URL,
      '/manifest.webmanifest',
      '/static/css/app.css',
      '/static/js/theme.js',
      '/static/js/ux.js',
      '/static/js/notifications.js',
      '/static/images/vect.png',
      '/icons/app-192.png?v=7',
      '/icons/app-512.png?v=7'
    ])).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Clean old caches
      const names = await caches.keys();
      await Promise.all(names.filter(n => n !== STATIC_CACHE).map(n => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Same-origin cache strategies
  if (url.origin === self.location.origin) {
    // Cache-first for static assets
    if (url.pathname.startsWith('/static/') || ['style','script','image','font'].includes(req.destination)) {
      event.respondWith(
        caches.match(req).then(res => res || fetch(req).then(resp => {
          const copy = resp.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(req, copy));
          return resp;
        }).catch(()=>caches.match(OFFLINE_URL)))
      );
      return;
    }
    // Network-first for pages/API, fallback to cache
    event.respondWith(
      fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(STATIC_CACHE).then(cache => cache.put(req, copy));
        return resp;
      }).catch(() => caches.match(req).then(r => r || caches.match(OFFLINE_URL)))
    );
  }
});
