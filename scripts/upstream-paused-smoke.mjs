// ─── Upstream pause smoke ─────────────────────────────────────────────────────
// UPSTREAM and Nostradamus are the two most expensive things this app can do —
// ~$1 a run, and 36% of the last 30 days' Anthropic spend went to runs of theirs
// that failed. They are currently switched off, and "off" is asserted in TWO
// places that must agree:
//
//   netlify/functions/upstream-run-background.js   PAUSED   ← the real gate
//   src/lib/upstream.js                            ENGINES_PAUSED   ← the UI
//
// The server one is what actually stops tokens: it is a plain HTTP endpoint, so
// a tab left open from before the pause, a replayed request, or a curl with a
// live token all reach it without going near the client bundle. The client one
// only makes the pages say so and skip a doomed round trip.
//
// WHY TWO DECLARATIONS AND NOT ONE IMPORT. This repo's Netlify bundling turns a
// required helper's module.exports into the function bundle's own exports and
// deploys the function with NO handler — a 502 on every call, documented in
// netlify/functions/audit.js, which the repo has already paid for once. Sharing
// a module between a function and the client is the exact shape that triggers
// it. So the duplication is deliberate and this file is what makes it safe.
//
// The half-reconnected states are the ones worth failing the build over:
//   · UI live, gate paused   → every launch throws; the tool looks broken.
//   · UI paused, gate live   → a stale tab or a direct POST still spends money
//                              while the app insists nothing is running.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const read = (p) => readFileSync(p, "utf8");
// Strip comments before matching. Without this the checks below would pass on
// the PROSE above rather than on code — the same unfalsifiable-assertion trap
// that spend-smoke walked into (a /usage_log/ test that matched a comment
// explaining why the file did NOT log). Line comments only; that is all these
// two files use for the declarations in question.
const code = (src) => src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

const FN = "netlify/functions/upstream-run-background.js";
const LIB = "src/lib/upstream.js";
const PAGE = "src/pages/upstream/UpstreamPage.jsx";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "ok" : "FAIL"}: ${label}`);
  if (!ok) failures++;
};

for (const p of [FN, LIB, PAGE]) check(`${p} exists`, existsSync(p));
if (failures) { console.log("\nupstream-paused: missing files"); process.exit(1); }

const fn = code(read(FN));
const lib = code(read(LIB));
const page = code(read(PAGE));

// ── 1. both flags are declared, and they agree ───────────────────────────────
const fnPaused = fn.match(/^const PAUSED = (true|false);/m)?.[1];
const libPaused = lib.match(/^export const ENGINES_PAUSED = (true|false);/m)?.[1];

check("the function declares PAUSED", fnPaused !== undefined);
check("the client declares ENGINES_PAUSED", libPaused !== undefined);
check(`both agree (function=${fnPaused}, client=${libPaused})`, fnPaused === libPaused);

// ── 2. the gate actually refuses, and refuses everything ─────────────────────
// Asserting the flag exists proves nothing on its own — it has to be READ, and
// read before any work happens. `kind` is parsed from the body, so a gate that
// runs after the body parse could still be made kind-specific by a later edit;
// requiring the refusal to precede the parse is what keeps it total.
const gateAt = fn.search(/if \(PAUSED\) return json\(503,/);
const bodyAt = fn.search(/await req\.json\(\)/);
check("the function returns 503 when paused", gateAt >= 0);
check("it refuses before parsing the body (so it covers every kind)", gateAt >= 0 && bodyAt > gateAt);
// tell_check is Nostradamus's follow-up pass and calls sonnet with web search.
// It is the easy one to forget, because it launches from a prediction card
// rather than from either tool's main button.
check("the gate is not scoped to particular kinds",
  !/if \(PAUSED && .*kind/.test(fn));

// ── 3. the client blocks too, and says why ───────────────────────────────────
check("startJob throws while paused", /if \(ENGINES_PAUSED\) throw new Error/.test(lib));
check("the client exports the user-facing copy", /export const PAUSED_NOTE/.test(lib) && /export const PAUSED_TITLE/.test(lib));
// The whole point of the request: the user must be TOLD, not silently blocked.
check("the note says it needs reconnecting", /reconnect/i.test(lib.match(/PAUSED_NOTE\s*=([\s\S]*?);/)?.[1] || ""));

// ── 4. the pages show it on BOTH tools ───────────────────────────────────────
// Two banners, because Upstream and Nostradamus are separate surfaces in one
// file — landing on either must make the state obvious without hunting.
const banners = (page.match(/<PausedBanner \/>/g) || []).length;
check(`both tools render the paused banner (found ${banners})`, banners >= 2);
// Every control that would spend has to be disabled, not merely explained.
// Three of them: Upstream's Run, Nostradamus's Consult, and the tell check.
const disabled = (page.match(/disabled=\{ENGINES_PAUSED \|\|/g) || []).length;
check(`every spending control is disabled while paused (found ${disabled}/3)`, disabled >= 3);

// ── 5. the reconnect instruction names files that exist ──────────────────────
// A pause note pointing at the wrong path is worse than none: it sends whoever
// reconnects this to a file that isn't there and costs them the trail.
// `./x` and `../x` resolve against the FUNCTION's directory (that is what the
// import statements above mean); anything else is written as a repo path,
// because that is how a human reading the comment would type it into an editor.
// Conflating the two was the first version of this check, and it "failed" on
// three imports that were perfectly correct.
for (const m of [...read(FN).matchAll(/[\w./-]+\.(?:mjs|js|jsx)/g)].map((x) => x[0])) {
  if (!m.includes("/") || m.startsWith("http")) continue;
  const resolved = m.startsWith(".") ? resolve(dirname(FN), m) : m;
  check(`${FN} names a real file: ${m}`, existsSync(resolved));
}

console.log(failures ? `\n${failures} pause check(s) failed` : "\nupstream-paused: all checks passed");
process.exit(failures ? 1 : 0);
