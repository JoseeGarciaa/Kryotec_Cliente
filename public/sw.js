self.addEventListener('install', event => {
  event.waitUntil(
    caches.open('kryo-static-v1').then(cache => cache.addAll([
      '/',
      '/static/css/app.css',
      '/static/js/theme.js',
      '/static/js/ux.js',
      '/static/js/notifications.js',
      '/static/images/favicon.png'
    ])).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Cache-first for static assets
  if (req.method === 'GET' && (req.url.includes('/static/') || req.destination === 'style' || req.destination === 'script' || req.destination === 'image')) {
    event.respondWith(
      caches.match(req).then(res => res || fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open('kryo-static-v1').then(cache => cache.put(req, copy));
        return resp;
      }).catch(()=>caches.match('/'))) 
    );
  }
});
