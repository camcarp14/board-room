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
// v33: the Watch link in the Notes header. The v6 note again, and this one was
// caught by the owner opening Notes and finding nothing there — a new link in a
// section header is checked by LOOKING at it, so a stale shell reads exactly
// like the feature was never built.
// v34: sheets that animate on the way out, the compact scrolled header, pull to
// refresh, tweened numbers everywhere they appear, and eighteen re-solved
// palettes. That is the v6 note five times over in one deploy — every item is
// verified by LOOKING at it, and four of the five turn up in the first minute of
// ordinary use (open a sheet, scroll a page, pull the Brief, read a number).
// Nothing outside src/ changed, so without this line the worker stays
// byte-identical, no new worker installs, and the first launch paints the v33
// shell: a sheet that still vanishes, a header that still isn't there, a pull that
// still does nothing.
// v35: the vendor chunk actually surviving a deploy. vite.config.js splits
// react/react-dom/@supabase/@tanstack into their own hashed chunk on the stated
// grounds that the reload following every deploy then re-fetches only the app
// chunk and reads 402 kB of vendor out of the cache-first store below "because its
// filename genuinely did not change" — and the activate handler purged it anyway,
// because the store was named `${VERSION}-assets` and the purge deletes every cache
// that is not this VERSION's. The one deploy shape the split was written for was
// exactly the shape that dropped it, on every single deploy, silently. So the asset
// store is no longer version-keyed (see ASSET_CACHE) and this deploy is the last one
// that pays for the old name.
const VERSION = "br-v35";
// DELIBERATELY NOT VERSION-KEYED, and the reason it is safe is the filename: Vite
// content-hashes everything under /assets/, so a URL here can only ever mean one
// body. A changed file IS a changed URL, which is what makes an entry from four
// deploys ago as correct as one from this morning — the property cache-first was
// already relying on WITHIN a version.
//
// Two things the version key was quietly also doing, and why each is covered:
//   · Clearing a poisoned entry. The only poison this store has ever seen was the
//     SPA fallback answering a purged chunk with index.html and a 200 ("Failed to
//     load module script"), and the content-type guard in the fetch handler is what
//     stops that at the door now. A VERSION bump was the recovery, never the fix.
//   · Bounding the size. trimAssets() below replaces that, and has to, because
//     nothing else would ever delete an old build's chunks.
const ASSET_CACHE = "br-assets";
const PAGE_CACHE = `${VERSION}-pages`;

// THE BOUND THE PURGE USED TO PROVIDE FOR FREE. Every deploy adds a handful of new
// hashed filenames; with the store outliving VERSION, nothing removes the old ones.
// This runs on activate, which is the one moment we know a deploy just happened.
//
// Two properties make it safe to delete by AGE. Cache.keys() is in insertion order,
// and a cache-first store only ever inserts on a MISS, so the front of that list is
// the oldest build's chunks. And the shell precached on install NAMES this build's
// eager assets — Vite writes the entry script, its stylesheet and every statically
// imported chunk (vendor among them, which is the entire point) into index.html as a
// <script> tag and modulepreload links — so the files that must survive are
// recognised rather than guessed. Whatever is left to trim is a dead build's chunk
// or a lazily-imported one, and being wrong about a lazy chunk costs one refetch of
// a URL that still resolves. It cannot serve a wrong body; the filename is a hash.
//
// A build emits 27 files today and most are only fetched if you open that panel, so
// this keeps roughly three deploys' worth of real traffic.
const ASSET_KEEP = 80;
// Nothing in here may throw into the activate chain. A rejection there skips
// clients.claim(), the new worker never takes control of the open page, and the
// deploy reads as never having shipped — the failure this whole file is about.
async function trimAssets() {
  try {
    const cache = await caches.open(ASSET_CACHE);
    const keys = await cache.keys();
    if (keys.length <= ASSET_KEEP) return;
    const shell = await caches.open(PAGE_CACHE).then((c) => c.match("/"));
    const live = new Set((shell ? (await shell.text()).match(/\/assets\/[^"']+/g) : null) || []);
    // A shell we cannot read means we cannot tell this build's assets from a dead
    // build's, and deleting the wrong 400 kB is worse than a store that is one
    // deploy too big. So that case trims nothing at all.
    if (!live.size) return;
    const doomed = keys.filter((k) => !live.has(new URL(k.url).pathname)).slice(0, keys.length - ASSET_KEEP);
    await Promise.all(doomed.map((k) => cache.delete(k)));
  } catch { /* a store that cannot be trimmed is not a reason to spoil a deploy */ }
}

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
      Promise.all(keys.filter((k) => !k.startsWith(VERSION))
        // The asset store is exempt, and this second filter is how rather than a
        // rewritten predicate because the rule above is the one every past bump
        // relied on: old versions' pages AND their old `${VERSION}-assets` caches
        // still go, exactly as before. Only the shared name survives.
        .filter((k) => k !== ASSET_CACHE)
        .map((k) => caches.delete(k)))
    ).then(() => trimAssets()).then(() => self.clients.claim())
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
