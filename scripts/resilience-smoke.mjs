// ─── Resilience smoke — the failures that used to have no way out ────────────
//
// Six things are pinned here, and each one shipped as a state the app could
// enter and not leave, or a statement it made that was not true. None of them is
// visible to the other suites: they are not a render, not a colour, not a pure
// function's arithmetic, but a decision about what happens when something has
// already gone wrong.
//
//   1. A STALE SHELL REACHING FOR A CHUNK THAT IS GONE. This is arranged to be
//      possible on purpose (netlify.toml 404s /assets/*, sw.js purges the old
//      build), and it landed on an ErrorBoundary card whose primary button was
//      incapable of working — React.lazy caches a rejected import for the life of
//      the document, so "Try again" re-threw the stored error forever. The
//      predicate and the one-reload-per-build gate are pure and live in
//      lib/chunkErrors.js precisely so this file can DRIVE them rather than grep
//      for them; a gate that has silently become "always allow" greps fine and is
//      a reload loop.
//   2. THE REFRESH THAT WASN'T FINISHED. App's refreshData dropped the promise
//      from invalidateQueries, so "refreshing" described three reads while most of
//      the app was still fetching — and MobileShell's pull gauge is documented to
//      last exactly as long as onRefresh's promise.
//   3. THE FILTER STRIPS THAT WOULD NOT SAY WHICH ONE WAS ON. PillRow claimed
//      role="tablist" over children that were never role="tab", so the structure
//      was invalid AND the active pill was carried by colour alone.
//   4. A USAGE ROW THAT SAID "ok" ABOUT A CALL THAT RETURNED NULL.
//   5. THE SIGN-OUT THAT REACHED THE OTHER DEVICE, AND THE EXPIRY THAT ATE THE
//      QUEUE. supabase-js signs out every device unless told otherwise, under a
//      confirm that promised only this one; and the SIGNED_OUT a dead session
//      sends looked identical to the button's, so App purged the failed-writes
//      queue a moment after a write had filed itself there to be retried.
//   6. THE TAB BAR THAT VANISHED IN LANDSCAPE. The keyboard heuristic compared
//      the visual viewport to iOS's portrait-only screen.height.
//
// Run by `npm run verify`.

import { readFileSync } from "node:fs";
import { isChunkLoadError, claimChunkReload } from "../src/lib/chunkErrors.js";
import { formatSnapshotForChat, updateSnapshot } from "../src/lib/snapshot.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

// ══ 1. the stale shell ═══════════════════════════════════════════════════════

// Every wording a browser actually uses. These are not hypothetical variants —
// the four engines this app runs on each phrase it differently and none of them
// sets a code, so a predicate that knows only Chrome's sentence recovers only on
// Chrome. iOS Safari is the one that matters most here and is the odd one out.
const REAL_CHUNK_FAILURES = [
  "Failed to fetch dynamically imported module: https://board.example/assets/MarketsPage-a1b2c3.js", // Chrome / Edge
  "error loading dynamically imported module",                                                        // Firefox
  "Importing a module script failed.",                                                                // Safari
  "Unable to preload CSS for /assets/TrainPage-9f8e7d.css",                                           // Vite's preload helper
  "Loading chunk 42 failed.",                                                                         // webpack-era wording
];
for (const m of REAL_CHUNK_FAILURES) {
  check(`a stale-shell failure is recognised: ${m.slice(0, 42)}…`, isChunkLoadError(new Error(m)));
}
check("…and by name, for the engines that set one", isChunkLoadError(Object.assign(new Error("boom"), { name: "ChunkLoadError" })));

// THE OTHER DIRECTION IS THE ONE THAT COSTS THE APP. Everything this answers true
// for gets a page reload, so a genuine render crash misread as a stale chunk is an
// infinite reload loop — the app would be unusable rather than showing a card.
const REAL_CRASHES = [
  "Cannot read properties of undefined (reading 'map')",
  "Element type is invalid: expected a string or a class/function but got: undefined",
  "x is not a function",
  "Maximum update depth exceeded",
  "NetworkError when attempting to fetch resource.", // a plain fetch failure is NOT a chunk failure
];
for (const m of REAL_CRASHES) {
  check(`an ordinary crash is left alone: ${m.slice(0, 42)}…`, !isChunkLoadError(new Error(m)));
}
check("nothing thrown at all is not a chunk failure", !isChunkLoadError(null) && !isChunkLoadError(undefined));

// The gate, driven rather than described. A fake Storage so this runs in node and
// so the assertions are about behaviour, not about sessionStorage existing.
const fakeStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _size: () => m.size };
};
{
  const s = fakeStore();
  check("the first stale-shell crash on a build is allowed its reload", claimChunkReload("build-a", s) === true);
  // THE WHOLE LOOP PROTECTION IS THIS ONE LINE. Reloading and landing on the same
  // broken build must not reload again, or the app spins forever on a bad deploy.
  check("…and the second one on that same build is refused", claimChunkReload("build-a", s) === false);
  check("…and a third, and a tenth", [...Array(8)].every(() => claimChunkReload("build-a", s) === false));
  // A reload that WORKED lands on a different build id, so the next stale shell —
  // whenever it comes — gets its own attempt. Sharing one budget across builds
  // would disable the recovery permanently after a single bad afternoon.
  check("a different build gets its own reload", claimChunkReload("build-b", s) === true);
}
{
  // Storage that refuses (Safari private mode, an origin over quota) must read as
  // "already spent". With nowhere to record the attempt there is nothing that
  // could stop the second one, and a card beats a loop.
  const dead = { getItem() { throw new Error("QuotaExceededError"); }, setItem() { throw new Error("QuotaExceededError"); } };
  check("unusable storage refuses the reload rather than looping", claimChunkReload("build-a", dead) === false);
  check("absent storage does the same", claimChunkReload("build-a", null) === false);
}

// The boundary has to actually USE both halves, and has to stop offering the
// button that cannot work. Source-read, because this half is a React lifecycle.
{
  const eb = readFileSync("src/shell/ErrorBoundary.jsx", "utf8");
  check("the boundary asks the predicate", /isChunkLoadError\(error\)/.test(eb));
  check("…claims the gate before reloading", /claimChunkReload\(BUILD\)\)\s*\{\s*window\.location\.reload\(\)/.test(eb));
  // Where the reload is attempted is not a style question. getDerivedStateFromError
  // and render both run in React's render phase, which is re-entrant and may be
  // discarded — navigating from either is a side effect fired from a computation
  // React is allowed to run more than once. componentDidCatch is the commit-phase
  // hook, which happens exactly once per caught error. (indexOf on the CALL, not
  // on the name: the import sits at the top of the file and would win.)
  const at = eb.indexOf("claimChunkReload(BUILD)");
  check("…and does it in componentDidCatch, not in the render phase",
    at > eb.indexOf("componentDidCatch") && at < eb.indexOf("render()"));
  // React.lazy caches a rejection forever, so Try again cannot re-request the
  // chunk. Offering it anyway is a control that does nothing, which is worse than
  // no control — it teaches you not to trust the one beside it.
  check("Try again is withheld on a stale shell", /\{!stale && <button className="btn quiet md"/.test(eb));
  check("…and Reload app is always there", /onClick=\{\(\) => window\.location\.reload\(\)\}>Reload app/.test(eb));
  check("the stale card does not ask for a bug report", /nothing you've saved is affected/.test(eb));
}

// ══ 2. the refresh that finishes ═════════════════════════════════════════════
{
  const app = readFileSync("src/App.jsx", "utf8");
  // The promise has to be KEPT and then SETTLED. Keeping it without awaiting is
  // the bug wearing a variable name, so both halves are checked.
  check("invalidateQueries' promise is kept", /const queries = queryClient\.invalidateQueries\(\)/.test(app));
  check("…and settled with the direct reads", /Promise\.allSettled\(\[[\s\S]{0,160}?queries,?\s*\]\)/.test(app));
  // It must NOT feed the freshness pill: a cache in which some queries refetched
  // and some failed has no single answer, and each of those cards draws its own
  // error state already.
  check("…without letting the query cache stamp the freshness pill",
    /\[chatR, notesR, setsR\]\.some\(\(r\) => r\.status === "fulfilled"\)\) setDataStamp/.test(app));

  const shell = readFileSync("src/shell/MobileShell.jsx", "utf8");
  check("the pull gauge still lasts exactly as long as that promise",
    /ptrProps\.current\.onRefresh\?\.\(\)\)[\s\S]{0,120}running = false/.test(shell));

  // A JS scroll animation is not a CSS animation, so the reduced-motion block at
  // the bottom of components.css has no opinion about it — this was the one thing
  // still travelling for a user who asked for stillness.
  check("nav's scroll-to-top jumps under reduced motion",
    /prefers-reduced-motion: reduce[\s\S]{0,200}behavior: still \? "auto" : "smooth"/.test(app));
}

// ══ 3. the filter strips ═════════════════════════════════════════════════════
{
  const kit = readFileSync("src/ui/kit.jsx", "utf8");
  // A tablist whose children are not tabs is an invalid structure AND drops the
  // selected state on the floor. The kit already had the right pattern one
  // component away: Segmented announces through aria-pressed.
  check("PillRow no longer claims to be a tablist", !/role="tablist"/.test(kit));
  check("…and its pills say which one is on", /<Pill key=\{k\} active=\{active\} aria-pressed=\{active\}/.test(kit));
  check("…inside a named group, so the strip is still one thing",
    /className="pillrow"[^>]*role="group" aria-label=\{label\}/.test(kit));
  check("Segmented's aria-pressed is untouched — one grammar, not two",
    /className=\{`seg-opt\$\{active \? " active" : ""\}`\} onClick=\{\(\) => onChange\(k\)\} aria-pressed=\{active\}/.test(kit));
  // Pill must keep spreading rest onto the button or the attribute above is
  // silently dropped — the failure would look exactly like the bug being fixed.
  check("Pill passes arbitrary aria through to the button",
    /export function Pill\(\{ active, onClick, children, style, \.\.\.rest \}\)[\s\S]{0,200}\{\.\.\.rest\}/.test(kit));
  // The strip re-centres itself on every selection change, in JS — the second of
  // the two scroll animations in the app that the CSS reduced-motion block cannot
  // reach (App.jsx's scroll-to-top is the other, checked above).
  check("…and the strip stops gliding under reduced motion",
    /row\.scrollBy\(\{ left: delta, behavior: first \|\| still \? "auto" : "smooth" \}\)/.test(kit));
}

// ══ 4. nothing states a reading it does not have ═════════════════════════════
{
  const fns = readFileSync("src/lib/functions.js", "utf8");
  // `ok` latched true at res.ok and was never revisited, so a 200 with an
  // unparseable body (a proxy's HTML error page) logged a success for a call that
  // handed its caller null.
  check("callFn only logs ok once the body has actually parsed",
    /const data = await res\.json\(\);[\s\S]{0,900}ok = true;\s*\n\s*return data;/.test(fns));
  check("…and marks the call failed when it doesn't", /\} catch \(e\) \{\s*\n\s*ok = false;/.test(fns));
  check("callFnFull records an unreadable body rather than logging a bare ok",
    /if \(ok && unreadable\) detail = "answered, body unreadable";/.test(fns));

  // The snapshot block is pasted into every seat's system prompt under "treat as
  // current, not something to caveat", so a placeholder here is not an em-dash a
  // reader discounts — it is a number stated to a model as fact.
  updateSnapshot({ btc: { price: 64000, changePct: null }, stocks: null, wire: null, todayEvents: null, todayBirthdays: null });
  const noChange = formatSnapshotForChat();
  check("an unknown 24h move is not reported as flat", !/\+0\.0%/.test(noChange), noChange);
  check("…it says so instead", /24h change not available/.test(noChange), noChange);
  check("…while the price it does have is still reported", /\$64,000/.test(noChange), noChange);

  updateSnapshot({ btc: { price: 64000, changePct: -2.35 } });
  check("a known move still prints with its sign", /-2\.4% 24h|-2\.3% 24h/.test(formatSnapshotForChat()));

  // Gold used to gate all four tickers and only gold was tested, so a pass where
  // NVDA had not resolved sent the literal string "NVDA undefined" to the model.
  updateSnapshot({ btc: null, stocks: { gold: { value: "$3,410" }, nvda: null, mstr: { value: "—" }, strc: undefined } });
  const partial = formatSnapshotForChat();
  check("a ticker with no reading is left out, not printed as undefined",
    !/undefined/.test(partial) && !/NVDA/.test(partial) && !/MSTR/.test(partial), partial);
  check("…and the ones that resolved are still reported", /Markets: Gold \$3,410/.test(partial), partial);

  updateSnapshot({ stocks: { gold: null, nvda: null, mstr: null, strc: null } });
  check("no tickers at all drops the markets line entirely", !/Markets:/.test(formatSnapshotForChat()));
}

// ══ 5. every outbound fetch on the server has a deadline ════════════════════
// This repo already did this work once — one pass put AbortSignal.timeout on
// every fetch in netlify/functions, on the stated grounds that a fetch with no
// signal has no ceiling and a wedged connection does not fail, it never answers.
// The pass walked netlify/functions/*.js, so netlify/lib/ was never visited, and
// netlify/lib/upstream/store.js — the file through which EVERY Supabase read and
// write the Upstream engine makes actually leaves the machine, including the
// caller-identity gate — kept both of its fetches unbounded for the whole time.
// upstream-run-background is a background function, so there is not even a
// synchronous 26s platform cap to cut a hung call short.
//
// An invariant that has already been broken once by being a habit rather than a
// check gets to be a check. Whole tree under netlify/, not just the functions
// directory, because the directory is exactly what the first pass scoped to.
{
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files = [];
  (function walk(d) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".js")) files.push(p);
    }
  })("netlify");
  const naked = [];
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    // Count call sites, not the word: `fetch(` inside a comment or a string is
    // not a request. Crude but conservative in the safe direction — a false
    // positive here is a file someone has to look at, which is the cost of the
    // check being worth having.
    const calls = (s.match(/(?:^|[^.\w])fetch\s*\(/g) || []).length;
    if (!calls) continue;
    if (!/AbortSignal\.timeout|AbortController|signal:\s*\w/.test(s)) naked.push(f);
  }
  check("every file under netlify/ that fetches carries a deadline", naked.length === 0, naked.join(" "));
  // The two in store.js specifically, since they are the ones this check was
  // written for and a whole-file regex would go on passing if only one came back.
  const store = readFileSync("netlify/lib/upstream/store.js", "utf8");
  check("…including the Upstream engine's REST helper",
    /fetch\(`\$\{c\.url\}\/rest\/v1\/\$\{path\}`, \{\s*\n\s*method,\s*\n\s*signal: AbortSignal\.timeout\(REST_TIMEOUT_MS\)/.test(store));
  check("…and its caller-identity gate, which runs before anything else",
    /fetch\(`\$\{c\.url\}\/auth\/v1\/user`, \{\s*\n\s*signal: AbortSignal\.timeout\(IDENTITY_TIMEOUT_MS\)/.test(store));
}

// ══ 6. the tree has no unreachable modules ═══════════════════════════════════
// AssetsPage.jsx sat here for months: unrouted (App.jsx sends `assets` and
// `systems` to the Brief), imported by nothing, and — the part that made it worth
// a check rather than a shrug — carrying a named import of MinerPanel from
// SystemsPage.jsx that had stopped resolving when that re-export was removed. It
// could not have rendered. Nothing caught it because nothing loaded it: a module
// no bundle reaches is a module no build, no smoke and no type checker will ever
// have an opinion about, so the only thing that finds this class of rot is asking
// what main.jsx can actually get to.
{
  const { readdirSync, statSync } = await import("node:fs");
  const { resolve, dirname, join, relative } = await import("node:path");
  const all = [];
  (function walk(d) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|jsx)$/.test(f)) all.push(resolve(p));
    }
  })("src");
  const seen = new Set();
  const queue = [resolve("src/main.jsx")];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = readFileSync(f, "utf8"); } catch { continue; }
    // Static `from "…"` and dynamic `import("…")` both, since every page below
    // the Brief is reached through the latter.
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const t = resolve(dirname(f), m[1]);
      if (/\.(js|jsx)$/.test(t)) queue.push(t);
    }
  }
  // DocketCard is named because it is a known, deliberate exception rather than an
  // oversight: the Brief retired the card (its greeting and date duplicated the
  // page header) and the component was kept whole, still exercised by
  // page-render-smoke, in case it comes back. Anything else appearing here is rot.
  const KNOWN_UNROUTED = new Set(["src/pages/brief/DocketCard.jsx"]);
  const orphans = all.map((f) => relative(process.cwd(), f).replace(/\\/g, "/"))
    .filter((f) => !seen.has(resolve(f)) && !KNOWN_UNROUTED.has(f));
  check("every module in src/ is reachable from main.jsx", orphans.length === 0, orphans.join(" "));
}

// ══ 5. the sign-out that reached the other device, and the expiry that ate the queue
{
  const app = readFileSync("src/App.jsx", "utf8");
  const sheet = readFileSync("src/shell/SettingsSheet.jsx", "utf8");
  // supabase-js's default scope is 'global': every device's refresh token is
  // revoked, so the phone's Sign out reached the iPad up to an hour later, mid-use,
  // under a confirm that promised only this device's cache would be touched.
  check("sign-out is scoped to this device", /supabase\.auth\.signOut\(\{ scope: "local" \}\)/.test(app));
  // The call, not the sheet's history of it in prose.
  check("…and it is the only signOut in the shell",
    !/await supabase\.auth\.signOut\(/.test(sheet) && (app.match(/await supabase\.auth\.signOut\(/g) || []).length === 1);
  check("…so the confirm's promise is still true", /This device's cached notes/.test(sheet));
  // The same SIGNED_OUT arrives from the button and from a dead session. Only the
  // button's may purge: an expiry keeps the failed-writes queue it used to throw
  // away a moment after a write had filed itself "Not signed in".
  check("the button records its intent before signing out",
    /explicitSignOut\.current = true;\s*\n\s*try \{ await supabase\.auth\.signOut/.test(app));
  check("…and lowers it whether or not the event came", /finally \{ explicitSignOut\.current = false; \}/.test(app));
  check("only an explicit sign-out purges the device",
    /if \(explicit\) purgeDevice\(\);\s*\n\s*else setSessionExpired\(true\);/.test(app));
  check("…and clearAll lives inside that purge alone",
    (app.match(/writeFailures\.clearAll\(\)/g) || []).length === 1 &&
    /const purgeDevice = \(\) => \{[\s\S]*?writeFailures\.clearAll\(\)/.test(app));
  check("a different account arriving gets the purge instead",
    /if \(lastUser\.current && lastUser\.current !== s\.user\.id\) purgeDevice\(\);/.test(app));
  check("an expiry is said over the login screen, with what is waiting",
    /Your session expired\./.test(app) && /unsaved change/.test(app) && /\{ambient\}\{gate\}\{expiredNote\}/.test(app));
}

// ══ 6. the tab bar that vanished in landscape ════════════════════════════════
{
  const shell = readFileSync("src/shell/MobileShell.jsx", "utf8");
  // iOS reports screen.height in portrait however the phone is held, so an SE
  // turned sideways (667×375) read as "keyboard up" and lost the bar. innerHeight
  // is the window's own height and does not shrink for the keyboard on iOS.
  check("the keyboard heuristic measures against the window, not the portrait screen",
    /const keyboardOpen = vvh != null && window\.innerHeight \? vvh < window\.innerHeight \* 0\.72 : false;/.test(shell));
  check("…and the dock still leaves when it fires", /display: keyboardOpen \? "none" : undefined/.test(shell));
  // The arithmetic, on the two windows that used to lose the bar and the one that
  // must still lose it.
  const open = (vvh, innerHeight) => vvh < innerHeight * 0.72;
  check("an SE turned sideways keeps its tab bar", !open(375, 375));
  check("a narrow Split View window on a landscape iPad keeps its tab bar", !open(744, 744));
  check("a keyboard over a portrait phone still hides it", open(812 - 336, 812));
}

console.log(`\n${failed ? `${failed} FAILURE(S)` : "RESILIENCE SMOKE: ALL CLEAN"}`);
if (failed) { console.error("RESILIENCE SMOKE FAILED"); process.exit(1); }
