// Board Room service worker — conservative by design.
// · hashed build assets (/assets/*): cache-first (immutable by filename)
// · navigations + everything else same-origin: network-first, cache fallback
// · /.netlify/functions/* and cross-origin: never touched
// Bump VERSION to invalidate old caches on deploy of this file.
const VERSION = "br-v4"; // never cache HTML under asset URLs; waitUntil revalidation
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

  // Immutable hashed assets: cache-first. (/icons/ stays network-first below —
  // its filenames are stable, so cache-first would pin an old icon forever.)
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        // Never cache an HTML body under an asset URL: the SPA fallback used to
        // answer purged hashed chunks with index.html + 200, and caching that
        // here poisoned the immutable cache ("Failed to load module script").
        const ct = res.headers.get("content-type") || "";
        if (res.ok && !ct.includes("text/html")) cache.put(req, res.clone());
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
        // Keep the worker alive until the background revalidation lands —
        // without this the browser may reap the SW right after the cached
        // response is returned, and the shell never actually refreshes.
        e.waitUntil(fresh);
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
