// sw.js — basic offline app-shell cache for Warehouse Builder PWA
const CACHE_NAME = 'warehouse-builder-v12';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/model.js',
  './js/main.js',
  './js/canvas2d.js',
  './js/three3d.js',
  './js/baypreview3d.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/logo/spatialis-cube.png',
  './assets/logo/spatialis-horizontal-colour.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache the warehouses API — it's live database data, not app shell,
  // and must always reflect the current server state (and support non-GET verbs).
  if (url.pathname.startsWith('/api/')) {
    return; // let the browser handle it normally, no SW interception
  }

  if (req.method !== 'GET') return;

  // App-shell files: cache-first for reliable offline app boot.
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return res;
        }).catch(() => cached);
      })
    );
  } else {
    // Third-party CDN (Three.js): network-first, fall back to cache when offline.
    event.respondWith(
      fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
