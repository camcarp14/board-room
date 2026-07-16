// Board Room service worker — conservative by design.
// · hashed build assets (/assets/*): cache-first (immutable by filename)
// · navigations + everything else same-origin: network-first, cache fallback
// · /.netlify/functions/* and cross-origin: never touched
// Bump VERSION to invalidate old caches on deploy of this file.
const VERSION = "br-v3"; // precache shell + stale-while-revalidate navigations
const ASSET_CACHE = `${VERSION}-assets`;
const PAGE_CACHE = `${VERSION}-pages`;

self.addEventListener("install", (e) => {
  // Precache the app shell so the very first reopen after a deploy still paints
  // instantly instead of blocking on the HTML network round-trip.
  e.waitUntil(
    caches.open(PAGE_CACHE).then((c) => c.addAll(["/"])).catch(() => {}).then(() => self.skipWaiting())
  );
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

  // Navigations: stale-while-revalidate against the shell. Serve the cached
  // shell immediately (instant reopen, works offline), and refresh it in the
  // background so the next launch is up to date — the app already re-checks the
  // SW on every foreground, so being one launch behind is the accepted trade.
  if (req.mode === "navigate") {
    e.respondWith(
      caches.open(PAGE_CACHE).then(async (cache) => {
        const cached = (await cache.match("/")) || (await cache.match(req));
        const fresh = fetch(req).then((res) => { if (res.ok) cache.put("/", res.clone()); return res; }).catch(() => null);
        return cached || (await fresh) || new Response("offline", { status: 503 });
      })
    );
    return;
  }

  // Other same-origin GETs: network-first so live data/config stays current;
  // the cache only answers when the network can't.
  e.respondWith(
    caches.open(PAGE_CACHE).then(async (cache) => {
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw new Error("offline and uncached");
      }
    })
  );
});
