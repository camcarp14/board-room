// ─── Assets page invariants ───────────────────────────────────────────────────
// Three things about Assets that are invisible in a diff and obvious on the
// phone, so they get pinned here rather than rediscovered:
//
//   1. WHICH TABS EXIST. Properties, Deploy and Supabase were retired from the
//      pill row; Mind was retired from the app. A stray re-add — or an
//      accidental re-import of a tab component — should be a deliberate edit to
//      this file, not something that slips back in.
//
//   2. THAT MODEL CONTROL IS REALLY GONE. It was removed because the layers it
//      steered (Mind, Mini Me) are no longer reachable. Half a removal — the
//      picker gone but the estimate left, or the import left dangling — is how
//      dead controls come back.
//
//   3. THAT EVERY LOGGED PULL HAS A NAME. This is the one with teeth. The Usage
//      table exists to answer "what is costing me money", and it can only do
//      that if `usage_log.fn` values are translated into what the pull actually
//      does. Add a Netlify function or a new callClaude site without adding a
//      label and the row silently reverts to a wire identifier — which is
//      exactly the state this table was rewritten to escape. So: every fn the
//      codebase can write must be either labelled or explicitly excused.
//
// Text-based (the sources are JSX; there is no bundler here), like
// brief-order-smoke.mjs.

import { readFileSync, readdirSync } from "node:fs";

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`ok: ${label}`);
  else { failed++; console.log(`FAIL: ${label}${detail ? ` ${detail}` : ""}`); }
};

const systems = readFileSync("src/pages/systems/SystemsPage.jsx", "utf8");
const assets = readFileSync("src/pages/assets/AssetsPage.jsx", "utf8");

// ── 1. the tab row ───────────────────────────────────────────────────────────
const subtabs = assets.match(/const ASSETS_SUBTABS = \[([\s\S]*?)\n\];/)?.[1] || "";
const tabKeys = [...subtabs.matchAll(/key === "(\w+)"|SYSTEMS_SUBTABS\[0\]/g)].map(m => m[1] || "usage");
check("Assets shows exactly Usage, Status, Miner", tabKeys.join(",") === "usage,status,miner", tabKeys.join(","));
for (const gone of ["properties", "deploy", "supabase", "mind"]) {
  check(`no "${gone}" tab in the row`, !new RegExp(`key: "${gone}"`).test(subtabs));
}
// The render switch must not still mount a tab nothing can select — that's a
// component kept alive by a branch that can never be true.
for (const gone of ["DeployTab", "SupabaseTab"]) {
  check(`${gone} is not mounted by Assets`, !new RegExp(`<${gone}`).test(assets));
}
check("three tabs use Segmented, not the scrolling PillRow",
  /<Segmented options=\{ASSETS_SUBTABS\}/.test(assets) && !/<PillRow options=\{ASSETS_SUBTABS\}/.test(assets));

// ── 2. Model Control ─────────────────────────────────────────────────────────
check("the model picker is gone", !/ModelPicker/.test(systems));
check("its imports went with it",
  !/DEFAULT_MODELS|MODEL_META/.test(systems) && !/from "\.\.\/\.\.\/lib\/storage\.js"/.test(systems));
check("UsageTab no longer takes settings it can't use",
  /export function UsageTab\(\{ isMobile \}\)/.test(systems),
  systems.match(/export function UsageTab\([^)]*\)/)?.[0]);
check("Assets stopped passing them", !/<UsageTab[^>]*updateSetting/.test(assets));

// ── 3. every logged fn has a plain-English name ──────────────────────────────
const labelled = new Set([...systems.matchAll(/^\s+"?([\w.-]+)"?:\s*\{ label:/gm)].map(m => m[1]));
check("the label map is populated", labelled.size > 30, String(labelled.size));

// Everything the codebase can write into usage_log.fn: the literals passed to
// callClaude/logUsage, plus every deployed Netlify function (callFn logs by
// name for each one it hits).
const sources = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.(js|jsx)$/.test(e.name)) sources.push(readFileSync(p, "utf8"));
  }
};
walk("src"); walk("netlify");
const written = new Set([...sources.join("\n").matchAll(/\bfn:\s*["'`]([\w.-]+)["'`]/g)].map(m => m[1]));
for (const f of readdirSync("netlify/functions")) {
  if (f.endsWith(".js") && !f.startsWith("_")) written.add(f.replace(/\.js$/, ""));
}

// Excused, each for a stated reason. Adding to this list is the deliberate act;
// forgetting a label is not.
const UNLABELLED_OK = new Set([
  "conn_check",              // labelled — listed here only if the map is trimmed
]);
const missing = [...written].filter(f => !labelled.has(f) && !UNLABELLED_OK.has(f) && !/^discord_/.test(f)).sort();
check("every fn the code can log has a label", missing.length === 0, missing.join(", "));

// Discord writes fn as `discord_<stage>` — a family, not a key, so it needs the
// prefix fallback rather than an entry per stage.
check("the discord_ family falls back by prefix", /\/\^discord_\/\.test/.test(systems));
check("an unknown fn falls back to its raw id, never to blank",
  /USAGE_META\[fn\]\?\.label\s*\n?\s*\|\|/.test(systems));

// ── 4. the Pentagon roll-up ──────────────────────────────────────────────────
const tools = [...(systems.match(/const PENTAGON_TOOLS = \[([^\]]*)\]/)?.[1] || "").matchAll(/"([^"]+)"/g)].map(m => m[1]);
check("all four Pentagon tools get a row", tools.length === 4, tools.join(","));
const properties = readFileSync("src/pages/assets/properties.js", "utf8");
// The roll-up is only meaningful if its tool names are the venture names — a
// typo here shows an always-zero row that looks like a real finding.
for (const t of tools) {
  check(`"${t}" is a real property name`, properties.includes(`name: "${t}"`));
}
const attributed = [...systems.matchAll(/tool: "([^"]+)"/g)].map(m => m[1]);
check("every attributed pull points at a listed tool", attributed.every(t => tools.includes(t)), attributed.join(","));
check("at least one pull is attributed", attributed.length > 0);

// ── 5. Status consolidates without hiding trouble ────────────────────────────
// Exactly one group folds by default — the twenty-one Netlify functions. If
// `bulk` ever spread to Core, AI or Market data the tab would open showing
// nothing but four headers, which is consolidation past the point of use.
const groups = [...systems.matchAll(/\{ title: "([^"]+)",( bulk: (true),)? keys:/g)].map(m => [m[1], m[3] === "true"]);
check("Status still has its four groups", groups.length === 4, groups.map(g => g[0]).join(","));
check("only the function list folds by default",
  groups.filter(([, bulk]) => bulk).map(([t]) => t).join(",") === "Netlify functions",
  groups.map(([t, b]) => `${t}:${b}`).join(" "));
check("Core, AI and Market data open by default",
  groups.filter(([, bulk]) => !bulk).map(([t]) => t).join(",") === "Core,AI,Market data",
  groups.map(([t, b]) => `${t}:${b}`).join(" "));
check("an explicit toggle outranks the default, in both directions",
  /openMap\[g\.title\] != null \? openMap\[g\.title\] : !g\.bulk/.test(systems));
// Folding is only defensible while the header still reports failures. If the
// red count stopped rendering, a down function inside a shut group would be
// genuinely invisible — which is the one outcome this layout must not have.
check("a collapsed header still counts what's down",
  /if \(bad\) bits\.push\(\{ t: `\$\{bad\} down`, c: "var\(--red\)" \}\)/.test(systems));
check("the down count is outside the collapsible body",
  systems.indexOf("bits.map(") < systems.indexOf('className={`expand${open ? " open" : ""}`}'));

console.log(failed ? `\n${failed} assets check(s) failed` : "\nassets: all checks passed");
process.exit(failed ? 1 : 0);
