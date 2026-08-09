// sw.js — offline app-shell cache for Dynamic Spatial Model Builder PWA.
//
// Network-first, not cache-first: every load tries the network first and
// only falls back to the cache when offline/unreachable. The previous
// version was cache-first for same-origin files, which meant that once
// anything was cached, the browser could keep serving a STALE mix of HTML/
// JS indefinitely even after a new version was deployed — the cache always
// won before the network was ever consulted, so a shipped fix could appear
// to silently "not take" in a live tab. The only cost is one extra network
// round-trip per load when online, negligible for an app this size.
const CACHE_NAME = 'warehouse-builder-v44';
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
    caches.open(CACHE_NAME).then((cache) =>
      // Each file is fetched individually and a failure is swallowed rather
      // than propagated. cache.addAll() rejects — aborting the WHOLE
      // install — if even one file 404s or fails to fetch, which leaves the
      // browser stuck on the previous service worker (and therefore the
      // previous app version) indefinitely, with no visible error to the
      // user. A best-effort pre-cache is enough here since the network-
      // first fetch handler below re-populates the cache from every
      // successful load anyway.
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
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

  // Network-first, falling back to whatever's cached only when the network
  // request fails outright (offline, DNS failure, etc.) — applies equally
  // to the app's own files and third-party CDN assets (Three.js).
  event.respondWith(
    fetch(req).then((res) => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
      return res;
    }).catch(() => caches.match(req))
  );
});
