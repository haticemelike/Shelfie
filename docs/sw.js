/* sw.js — offline shell.
 * Bump CACHE when you change any file below, or phones will keep the old copy.
 */

const CACHE = 'shelfie-v12';

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
  './js/version.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // `cache: 'reload'` bypasses the browser's own HTTP cache. Without it,
      // a new service worker can happily re-cache the files it was meant to
      // replace, because GitHub Pages sets a ten-minute max-age.
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

/* Lets the in-app "Check for updates" button hand over immediately. */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
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
