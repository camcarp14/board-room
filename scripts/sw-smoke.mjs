// ─── The update check — the "you didn't ship it" bug ─────────────────────────
// Runs AFTER the build (see package.json), because the thing most worth
// asserting can only be checked against real build output.
//
// THE BUG. Navigations are stale-while-revalidate: the cached shell paints
// instantly and the fresh one is stored for next time. The reload meant to close
// that gap hung off `controllerchange`, which only fires when sw.js ITSELF
// changes — and a normal deploy doesn't touch sw.js. So every deploy was
// invisible until you happened to launch the app a second time, which from a
// phone is indistinguishable from the deploy never having happened.
//
// THE FIX, AND WHY IT LIVES IN THE PAGE. The first attempt put it in the worker:
// compare the revalidated shell to the served one and postMessage the page. It
// passed a static check very like this one and then failed the first time it met
// a browser — the navigate handler runs before the new document exists, so
// clients.matchAll finds the outgoing page or nothing at all. So the page asks
// instead, and these checks are worth what they're worth: they pin the parts
// that can rot silently. The behaviour itself was verified in Chromium against a
// real build and a simulated deploy (new build on the same launch; no reload
// while typing; no reload mid-session until the next foreground; offline keeps
// the running build and doesn't loop).
//
// Every failure mode here is silent — no error, no crash, just the old app.
// Run by `npm run verify`.

import { readFileSync, existsSync } from "node:fs";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const sw = readFileSync("public/sw.js", "utf8");
const main = readFileSync("src/main.jsx", "utf8");

// ─── 1. the build id has to match REAL build output ──────────────────────────
check("dist/index.html exists — this smoke runs after the build",
  existsSync("dist/index.html"), "run `npm run build` first");
const html = existsSync("dist/index.html") ? readFileSync("dist/index.html", "utf8") : "";

const src = main.match(/const BUILD = \/(.+?)\/;/)?.[1];
check("the page's build-id pattern is discoverable", !!src, src);
const re = new RegExp(src);
const hit = html.match(re)?.[0] || "";
// THE ONE THAT MATTERS. If Vite's output naming changes — or someone edits this
// regex — it stops matching, `next` is undefined, the check returns early
// forever, and the app silently goes back to being one launch behind with
// nothing in any log to say so.
check("it matches the entry script Vite actually emits", !!hit,
  `pattern ${src} found nothing in dist/index.html`);
// A pattern matching a CONSTANT filename would pass the line above and still be
// useless: it has to differ between builds to name a build at all.
check("what it matches carries a content hash, so it differs between builds",
  /index-[A-Za-z0-9_-]{6,}\.js/.test(hit), hit);
// The page compares the fetched shell against its OWN <script> src. If the built
// HTML ever stopped loading the entry as a real script element, `now` would be
// empty and the check would go permanently quiet.
check("the shell loads that entry as a script element the page can read",
  new RegExp(`<script[^>]+src="/?${hit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(html), hit);

// ─── 2. it asks the network, and only acts on a clear answer ─────────────────
check("the check fetches the shell fresh", /fetch\("\/", \{ cache: "no-store" \}\)/.test(main));
// A plain fetch is not a navigation, so it takes the worker's network-first
// branch rather than the stale-while-revalidate one — which is the entire reason
// this sees the truth.
check("the worker answers non-navigation GETs network-first",
  /const res = await fetch\(req\);[\s\S]{0,120}return res;[\s\S]{0,120}catch/.test(sw));
check("a shell it can't parse means do nothing, never reload",
  /if \(!next \|\| !now \|\| next === now\) return;/.test(main));
check("a failed check keeps the running build", /catch \{ \/\* offline/.test(main));
check("it reloads at most once per launch",
  /if \(reloaded\) return;/.test(main) && /reloaded = true;\s*\n\s*window\.location\.reload\(\);/.test(main));

// ─── 3. it must not interrupt you ────────────────────────────────────────────
// The reason this isn't an unconditional reload the moment a change is seen: a
// list half-typed at the till is worth more than being one build newer.
check("it never reloads while you're typing",
  /el\.tagName === "INPUT" \|\| el\.tagName === "TEXTAREA" \|\| el\.isContentEditable/.test(main) &&
  /if \(typing\(\)\) return;/.test(main));
check("it runs at launch — the case this exists for",
  /window\.addEventListener\("load", \(\) => \{ checkBuild\(\); \}\)/.test(main));
check("…and at every return to the foreground",
  /visibilitychange", \(\) => \{ if \(!document\.hidden\) checkBuild\(\); \}/.test(main));

// ─── 4. the caching rules this rests on ──────────────────────────────────────
check("hashed assets stay cache-first", /url\.pathname\.startsWith\("\/assets\/"\)/.test(sw));
check("HTML is still never cached under an asset URL",
  /ct\.includes\("text\/html"\)/.test(sw), "the SPA fallback would poison the immutable cache again");
check("functions are never intercepted", /url\.pathname\.startsWith\("\/\.netlify\/"\)/.test(sw));
check("old caches are purged on activate", /keys\.filter\(\(k\) => !k\.startsWith\(VERSION\)\)/.test(sw));
check("the revalidation outlives the cached response", /e\.waitUntil\(fresh\)/.test(sw));
// The worker holds a shell whose main.jsx has no check in it. Leaving VERSION
// alone would serve that shell one more time and delay this fix by exactly the
// launch it exists to save.
check("VERSION was bumped past the build that has the bug",
  /const VERSION = "br-v(?!4")/.test(sw), sw.match(/const VERSION = "[^"]+"/)?.[0]);
// The worker must not try to announce updates itself — that version looked
// correct and never fired. Its return would be silent too.
// Comments stripped first — the note explaining WHY it isn't there mentions it
// by name, and a check that can't tell code from the comment warning against it
// is a check that fails for being right.
check("the worker doesn't try to message the page about builds",
  !/postMessage/.test(sw.replace(/^\s*\/\/.*$/gm, "")),
  "clients.matchAll runs before the new document exists");

// ─── 5. the privacy policy has to be reachable BY A STRANGER ─────────────────
// Plaid's diligence links to it, so the failure that matters is not "the page is
// wrong" — it's "the URL serves the app". Three separate things would each do
// that silently: the file not being published, the SPA catch-all swallowing
// /privacy, and the service worker answering the navigation with the cached
// shell for anyone who has the app installed.
{
  check("the policy is published as a real page", existsSync("dist/privacy.html"));
  const policy = existsSync("dist/privacy.html") ? readFileSync("dist/privacy.html", "utf8") : "";
  // No script and no third-party anything: a privacy policy that loads a tracker
  // is a joke, and one that needs the app to boot can't be read when it can't.
  check("…that runs no script of its own", !/<script/i.test(policy));
  // Links OUT are fine — Plaid's own policy is linked deliberately. What must
  // not exist is anything the page LOADS: a font, a stylesheet, an image or an
  // import, each of which would report the reader's IP to a third party from
  // inside the document telling them nobody is watching.
  check("…and loads nothing off-origin",
    !/\ssrc\s*=/i.test(policy) && !/<link\b/i.test(policy) && !/@import/i.test(policy) && !/url\(\s*['"]?https?:/i.test(policy),
    (policy.match(/\ssrc\s*=[^>]*|<link\b[^>]*|@import[^;]*/i) || ["clean"])[0]);
  // The claims Plaid is being pointed at. If the app stops doing one of these,
  // the policy becomes a misrepresentation, which is the one thing worse than
  // not having one.
  for (const claim of ["TLS 1.2", "AES-256", "no policy at all", "/item/remove", "Reviewed annually", "never stored"]) {
    check(`the policy still states: ${claim}`, policy.includes(claim));
  }

  const toml = readFileSync("netlify.toml", "utf8");
  check("/privacy resolves to the policy, not the app shell", /from = "\/privacy"/.test(toml));
  check("…and is declared above the SPA catch-all — order is what decides it",
    toml.indexOf('from = "/privacy"') < toml.indexOf('from = "/*"'));
  // The worker used to answer EVERY navigation with the cached "/" shell, which
  // would hand the app to someone who followed a link to read a document.
  check("the worker only shells the app's own URL",
    /req\.mode === "navigate" && url\.pathname === "\/"/.test(sw));

  // ── the response headers the shell ships with ──────────────────────────────
  // The app was frameable by any site and shipped no nosniff or referrer
  // policy; the block that fixes it is a few lines of TOML that nothing would
  // notice going missing. Asserted as one block under "/*", so a header moved
  // to a narrower path does not pass.
  const shellHeaders = toml.match(/\[\[headers\]\]\s*\n\s*for = "\/\*"\s*\n\s*\[headers\.values\]([\s\S]*?)(?=\n\[\[|\s*$)/)?.[1] || "";
  check("the shell is served with X-Frame-Options: DENY", /X-Frame-Options = "DENY"/.test(shellHeaders));
  check("…and X-Content-Type-Options: nosniff", /X-Content-Type-Options = "nosniff"/.test(shellHeaders));
  check("…and a strict referrer policy", /Referrer-Policy = "strict-origin-when-cross-origin"/.test(shellHeaders));
  // The guitar tuner opens the microphone. A Permissions-Policy that shuts it
  // would fail in the one place no smoke can see — the browser's permission
  // prompt — so the absence is asserted, with the reason beside it in the TOML.
  // Comments stripped first: the TOML explains the absence by naming the value.
  check("no Permissions-Policy shuts the microphone the tuner needs",
    !/microphone=\(\)/.test(toml.replace(/^\s*#.*$/gm, "")));
}

console.log(failed ? `\n${failed} update-check failure(s)` : "\nSW SMOKE PASS");
process.exit(failed ? 1 : 0);
