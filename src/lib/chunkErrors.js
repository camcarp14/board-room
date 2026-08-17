// ─── The crash that is not a bug: a page chunk that isn't on the server ──────
//
// App.jsx code-splits six of the eight pages behind React.lazy, so opening a tab
// for the first time in a session is an HTTP request for a hashed chunk. Two
// things in this repo are deliberately arranged so that request can 404:
//
//   • netlify.toml sends /assets/* to a 404 rather than through the SPA
//     catch-all, on purpose — a stale shell importing a vanished chunk must fail
//     fast instead of receiving index.html with a 200 and poisoning caches.
//   • public/sw.js purges the previous build's hashed assets when it activates.
//
// So: deploy while the app is open on the phone, tap a tab you have not opened
// this launch, and the import rejects. That is not a defect in the panel — the
// panel is fine, and the build that contains it is sitting on the server. The
// running document is simply last week's.
//
// WHAT USED TO HAPPEN IS THE PART WORTH WRITING DOWN. The rejection reached the
// per-page ErrorBoundary, which drew its ordinary card: an error message, "Try
// again", "Reload app". netlify.toml's own comment says this path should
// "trigger the error boundary's reload" — it never did, and worse, the primary
// button on that card CANNOT work. React.lazy caches the outcome of its import
// permanently: once the payload is Rejected, every subsequent render throws the
// same stored error without re-requesting anything. So "Try again" re-rendered a
// component whose loader had already given up, produced the identical card, and
// went on doing that for as long as the tab was open. The only way out was the
// second button, and nothing on screen said so.
//
// main.jsx already knows how to notice a new build and reload for it — but it
// asks at launch and at every return to the foreground, and this failure happens
// mid-session, on a tap, between those two moments. This module is the third
// place the same question gets asked: not on a schedule, but at the instant the
// stale shell is actually caught reaching for something that no longer exists.

// Every browser words this differently and none of them types an error code.
// Chrome/Edge: "Failed to fetch dynamically imported module: <url>".
// Firefox:     "error loading dynamically imported module".
// Safari:      "Importing a module script failed." (and, older, "Unable to load…")
// Vite's own preload helper throws "Unable to preload CSS for <url>".
// Webpack-era bundles said "Loading chunk 12 failed" / ChunkLoadError, which this
// build does not emit — kept because the cost of matching it is a few characters
// and the cost of missing a shape is the dead card above.
const CHUNK_MESSAGE =
  /(failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload|loading chunk \S+ failed|loading css chunk)/i;

/**
 * Is this crash a stale document reaching for an asset the server no longer has,
 * rather than a fault in the code that was loaded?
 *
 * DELIBERATELY NARROW. Everything this answers true for gets a page reload, and a
 * reload applied to a genuine render crash is an infinite loop wearing a
 * recovery's clothes — so an unrecognised error must fall through to the ordinary
 * card. That is the same asymmetry lib/authErrors.js reasons about: one wrong
 * guess costs a card the user has to read, the other costs the app.
 */
export function isChunkLoadError(error) {
  if (!error) return false;
  if (error.name === "ChunkLoadError") return true;
  return CHUNK_MESSAGE.test(String(error.message || error));
}

/**
 * One reload per build, and the storage is what makes it "per build".
 *
 * A reload that WORKS lands on a different build, so the key changes and the next
 * stale-shell failure — whenever it comes, on whatever future deploy — is allowed
 * its own reload. A reload that does NOT work (a CDN still handing out the same
 * stale HTML, a chunk genuinely missing from the deploy) comes back to a key that
 * is already set, takes the refusal, and the boundary draws a card instead. That
 * is the whole loop protection, and it needs no counter.
 *
 * sessionStorage, not localStorage: it is scoped to this tab and dies with it, so
 * a spent budget can never outlive the situation that spent it. A localStorage
 * entry left behind by one bad afternoon would silently disable this recovery for
 * that build on every later launch — including the launch where it would have
 * worked.
 *
 * Storage that throws (Safari private mode, an origin over quota) reads as
 * "already spent" rather than as "go ahead": with no way to record the attempt
 * there is no way to stop the second one, and a reload loop is worse than a card.
 */
const RELOAD_KEY = "br_chunk_reload";

export function claimChunkReload(build, storage) {
  const store = storage !== undefined ? storage
    : (typeof sessionStorage !== "undefined" ? sessionStorage : null);
  if (!store) return false;
  const key = `${RELOAD_KEY}:${build || "dev"}`;
  try {
    if (store.getItem(key)) return false;
    store.setItem(key, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}
