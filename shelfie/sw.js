/* sw.js — offline shell.
 * Bump CACHE when you change any file below, or phones will keep the old copy.
 */

const CACHE = 'shelfie-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './vendor/zxing.min.js',
  './js/app.js',
  './js/db.js',
  './js/store.js',
  './js/prefs.js',
  './js/theme.js',
  './js/router.js',
  './js/ui.js',
  './js/covers.js',
  './js/lookup.js',
  './js/scanner.js',
  './js/goodreads.js',
  './js/view-library.js',
  './js/view-book.js',
  './js/view-add.js',
  './js/view-stats.js',
  './js/view-settings.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Book lookups and cover downloads always go to the network.
  // Offline they simply fail, which the app already handles.
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // Refresh in the background so the next launch is current.
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
