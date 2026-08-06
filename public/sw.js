// Board Room service worker — conservative by design.
// · hashed build assets (/assets/*): cache-first (immutable by filename)
// · navigations + everything else same-origin: network-first, cache fallback
// · /.netlify/functions/* and cross-origin: never touched
// Bump VERSION to invalidate old caches on deploy of this file.
//
// v5 exists to drop a stale PAGE_CACHE, not because the caching rules changed.
// The shell cached under v4 belongs to a build whose main.jsx has no update
// check in it (see below), and serving that shell one more time would delay the
// fix by exactly the launch it exists to save. Changing this file at all also
// installs a new worker, which fires `controllerchange` in the running page and
// gets THIS deploy onto the device in one launch through the path that already
// existed.
//
// WHY THE CHECK ISN'T IN HERE. The obvious version — compare the revalidated
// shell against the served one and postMessage the page — does not work, and
// looks like it does. The navigate handler runs BEFORE the new document exists,
// so `clients.matchAll({type:"window"})` finds the outgoing page or nothing at
// all, and the message is delivered to a document that is being torn down. It
// passed every static check I wrote and failed the first time it met a browser.
// The page asks instead (src/main.jsx), which needs no cooperation from here.
//
// v6, same reason as v5 and worth restating because it will come up again: the
// brand-mark deploys changed only src/, so this file was byte-identical across
// them, no new worker installed, and a launch kept painting the v5 shell — the
// change landed on the SECOND launch, which reads as "the code never shipped".
// Any deploy whose whole point is that you SEE something different has to touch
// this file too. Bumping VERSION purges the stale PAGE_CACHE on activate, so the
// next navigate finds nothing cached and awaits the live shell.
//
// v7: the Markets tab. A seventh destination in the bottom bar is exactly the
// kind of deploy the v6 note warns about — its whole point is that you see it.
// v8: the restoration deploy — navigation order/hidden, Brief layout profiles
// and Ponder, all reading the account's existing settings. The owner is
// actively comparing this build against what he lost; a stale shell here
// would read as the restoration not having happened.
// v9/v10: Markets opens on Crypto at the top, the 4h/12h columns carry a
// number instead of an em-dash, and the coin sheet was rebuilt. Every one of
// those is checked by LOOKING at the tab, which is exactly the case the v6
// note says must bump this file.
const VERSION = "br-v29";
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
  // …but ONLY for the app itself. Every in-app URL is "/" (tabs are state, not
  // routes), so any other path is a real static page — /privacy.html — and
  // answering it with the cached shell would serve the app under a URL someone
  // was sent to read a document. Those fall through to network-first below.
  if (req.mode === "navigate" && url.pathname === "/") {
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
