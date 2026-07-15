// Board Room service worker — conservative by design.
// · hashed build assets (/assets/*): cache-first (immutable by filename)
// · navigations + everything else same-origin: network-first, cache fallback
// · /.netlify/functions/* and cross-origin: never touched
// Bump VERSION to invalidate old caches on deploy of this file.
const VERSION = "br-v2"; // SESSION redesign — invalidate every pre-redesign cache
const ASSET_CACHE = `${VERSION}-assets`;
const PAGE_CACHE = `${VERSION}-pages`;

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/.netlify/")) return;

  // Immutable hashed assets: cache-first.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Navigations + other same-origin GETs: network-first so deploys land
  // immediately; the cache only answers when the network can't.
  e.respondWith(
    caches.open(PAGE_CACHE).then(async (cache) => {
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req);
        if (hit) return hit;
        if (req.mode === "navigate") {
          const shell = await cache.match("/");
          if (shell) return shell;
        }
        throw new Error("offline and uncached");
      }
    })
  );
});
