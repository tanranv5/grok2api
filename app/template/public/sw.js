const CACHE_PREFIX = "grok2api-pwa-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const cacheablePathPrefixes = [
    "/static/",
    "/public/login",
    "/imagine",
    "/video",
    "/voice",
    "/nsfw",
    "/imagine-workbench",
    "/manifest.webmanifest"
  ];
  const isCacheable = cacheablePathPrefixes.some((prefix) => url.pathname.startsWith(prefix));
  if (!isCacheable) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
        return response;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw error;
      }
    })()
  );
});
