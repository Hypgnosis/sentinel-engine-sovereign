const CACHE_NAME = 'sentinel-core-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  console.log('Sentinel Engine: Service Worker Installed');
});

self.addEventListener('activate', (event) => {
  // Purge old caches on version bump
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // SKIP non-GET requests entirely (POST to Cloud Functions, etc.)
  // The Cache API does not support caching POST requests.
  if (request.method !== 'GET') return;

  // SKIP non-http(s) schemes (chrome-extension://, moz-extension://, etc.)
  // The Cache API only supports http/https — attempting to cache other schemes throws TypeError.
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Standard Asset Caching (Stale-While-Revalidate)
  // Only caches GET requests for static assets (JS, CSS, images, fonts).
  // The LLM inference endpoint is POST — it is never intercepted here.
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        // Only cache valid, non-opaque responses
        if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'opaque') {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });
        }
        return networkResponse;
      }).catch(() => null);

      return cachedResponse || fetchPromise;
    })
  );
});
