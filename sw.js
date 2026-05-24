const CACHE_NAME = 'ble-dfu-v1';
const FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/app-controller.js',
  '/manifest.json',
  '/icon.svg',
  '/core/events.js',
  '/core/provider.js',
  '/core/registry.js',
  '/core/detect.js',
  '/core/filter-store.js',
  '/bluetooth/connect.js',
  '/smp/smp-provider.js',
  '/smp/mcumgr.js',
  '/smp/cbor.js',
  '/nordic/nordic-provider.js',
  '/nordic/secure-dfu.js',
  '/nordic/package.js',
  '/vendor/cbor-x.js',
  '/vendor/jszip.mjs',
  '/vendor/crc32.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});
