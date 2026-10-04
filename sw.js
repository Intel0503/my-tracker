/* Service worker: saves a copy of the app's files on the phone,
   so the app opens even with no internet.
   When you change any file later, increase VERSION (v1 -> v2)
   so phones pick up the new copy. Your data is NOT affected. */
const VERSION = 'v1';
const CACHE = `my-tracker-${VERSION}`;
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  // Remove copies from older versions
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('my-tracker-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Offline-first: answer from the saved copy, use the internet only if needed
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(hit => hit || fetch(event.request).catch(() => caches.match('./index.html')))
  );
});
