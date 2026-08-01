// ─── Systems + Settings invariants ────────────────────────────────────────────
// The machine room moved: Usage, Status and Miner were the Assets page, and
// Assets has left the nav entirely — they now live behind Settings → Systems.
// Four things about that are invisible in a diff and obvious the moment you use
// the app, so they get pinned here:
//
//   1. WHERE THE PANELS LIVE, and that Assets really is gone from the nav — a
//      half-move leaves a tab pointing at a page nothing renders.
//
//   2. THE BUNDLE SPLIT. The Settings sheet is imported eagerly (it opens from
//      anywhere) and lazy-imports the panels. One static import of SystemsPage
//      from App silently cancels that and drags the whole usage table into the
//      first-load bundle — Rollup warns, nobody reads build output, and the app
//      just gets slower. Hence the hook living in its own module.
//
//   3. THAT MODEL CONTROL IS REALLY GONE. It steered layers (Mind, Mini Me) that
//      are no longer reachable. Half a removal is how dead controls come back.
//
//   4. THAT EVERY LOGGED PULL HAS A NAME. The one with teeth. The Usage table
//      exists to answer "what is costing me money", and it can only do that if
//      usage_log.fn values are translated into what the pull actually does. Add
//      a function or a callClaude site without a label and the row reverts to a
//      wire identifier — the state this table was rewritten to escape.
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
// CONN_GROUPS/CONN_META moved next door with the hook — see the bundle note.
const conns = readFileSync("src/pages/systems/connections.js", "utf8");

// ── 1. where everything lives now ────────────────────────────────────────────
const nav = readFileSync("src/shell/nav.js", "utf8");
const app = readFileSync("src/App.jsx", "utf8");
const sheet = readFileSync("src/shell/SettingsSheet.jsx", "utf8");

const navKeys = [...(nav.match(/export const NAV = \[([\s\S]*?)\n\];/)?.[1] || "")
  .matchAll(/^\s*\{ key: "(\w+)"/gm)].map(m => m[1]);
check("the nav is Brief, Personal, Train, Creed, Dreams, Grocery",
  navKeys.join(",") === "brief,personal,train,creed,dreams,grocery", navKeys.join(","));
// Six is the ceiling for a phone tab bar with readable labels. A seventh needs
// a different chrome, not a smaller font.
check("the tab bar stays at six or fewer", navKeys.length <= 6, String(navKeys.length));
check("Assets is not a destination any more", !navKeys.includes("assets"));
// Every nav key needs an icon pair and a header, or the tab bar renders a hole
// and the large title comes up blank — both only visible by opening the app.
const icons = readFileSync("src/ui/icons.jsx", "utf8");
const iconKeys = new Set([...(icons.match(/export const NAV_ICONS = \{([\s\S]*?)\n\};/)?.[1] || "")
  .matchAll(/^\s*(\w+):/gm)].map(m => m[1]));
const headerKeys = new Set([...(nav.match(/export const HEADERS = \{[\s\S]*?\n\};/)?.[0] || "")
  .matchAll(/^\s*(\w+):/gm)].map(m => m[1]));
for (const k of navKeys) {
  check(`"${k}" has an icon pair`, iconKeys.has(k));
  check(`"${k}" has a page header`, headerKeys.has(k));
}
// Creed graduated out of Personal; a section left in both places is a panel you
// can reach two ways that disagree about where it lives.
const personal = readFileSync("src/pages/personal/PersonalPage.jsx", "utf8");
check("Creed is gone from Personal's pill row", !/key: "creed"/.test(personal));
check("…and Personal no longer mounts it", !/<CreedPanel/.test(personal));
check("an old personal→creed deep link is remapped",
  /t\.page === "personal" && t\.sub === "creed"/.test(app));
// A header for a page nothing routes to is how a stale link renders a titled
// blank; the redirect below is the only correct answer.
check("no page header survives for the retired keys",
  !/^\s*(assets|systems|boardroom):/m.test(nav.match(/export const HEADERS = \{[\s\S]*?\n\};/)?.[0] || ""));
check("App routes nothing to an assets page", !/case "assets":/.test(app));
check("a saved assets/systems/boardroom link lands on the Brief",
  /if \(key === "assets" \|\| key === "systems" \|\| key === "boardroom"\) key = "brief";/.test(app));

// ── 2. the Settings sheet, and the split that keeps it cheap ─────────────────
const sheetTabs = [...(sheet.match(/const SHEET_TABS = \[([^\]]*)\]/)?.[1] || "").matchAll(/key: "(\w+)"/g)].map(m => m[1]);
check("Systems is the first tab, Theme second",
  sheetTabs.join(",") === "systems,theme", sheetTabs.join(","));
const sysTabs = [...(sheet.match(/const SYS_TABS = \[([\s\S]*?)\n\];/)?.[1] || "").matchAll(/key: "(\w+)"/g)].map(m => m[1]);
check("Systems holds Status, Usage, Miner and Account",
  sysTabs.slice().sort().join(",") === "account,miner,status,usage", sysTabs.join(","));
check("the sheet lands on Systems → Usage",
  /useState\("systems"\)/.test(sheet) && /useState\("usage"\)/.test(sheet));
// Landing on Systems makes this guard load-bearing rather than merely tidy: a
// paid Claude ping on every tap of the sun/moon button would be a real bill.
check("Usage is the first Systems panel", sysTabs[0] === "usage", sysTabs.join(","));

// THE BUNDLE INVARIANT. Both halves matter: the panels must be lazy, and App
// must reach the hook WITHOUT touching SystemsPage — either one alone fails.
for (const panel of ["UsageTab", "StatusTab", "MinerPanel"]) {
  check(`${panel} is lazy-loaded, not statically imported`,
    new RegExp(`const ${panel} = lazy\\(`).test(sheet) && !new RegExp(`^import \\{[^}]*\\b${panel}\\b`, "m").test(sheet));
}
check("App imports the connections hook from its own module",
  /import \{ useConnections \} from "\.\/pages\/systems\/connections\.js"/.test(app));
check("App never statically imports SystemsPage", !/from "\.\/pages\/systems\/SystemsPage\.jsx"/.test(app));
check("SystemsPage does not re-export MinerPanel back into the chain",
  !/export \{ MinerPanel \}/.test(systems));
// A paid Anthropic ping fires in runAll, so opening Settings must not start it.
check("the status run waits for the Status panel, not the sheet",
  /if \(tab !== "systems" \|\| sys !== "status" \|\| started\.current/.test(sheet));
check("the hook is hosted in App so a run survives closing the sheet",
  /const conn = useConnections\(\{ session, btc \}\)/.test(app) && /conn=\{conn\}/.test(app));

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
// Every group folds by default: the tab answers "is anything broken" with four
// tally lines, and the twenty-five rows are the follow-up question.
const groups = [...conns.matchAll(/\{ title: "([^"]+)", keys:/g)].map(m => m[1]);
check("Status still has its four groups", groups.length === 4, groups.join(","));
check("in the reading order Core, AI, Market data, then the long tail",
  groups.join(",") === "Core,AI,Market data,Netlify functions", groups.join(","));
check("nothing is open until you open it", /const isOpen = \(g\) => openMap\[g\.title\] === true;/.test(systems));
check("no group can opt itself open again", !/bulk/.test(systems) && !/bulk/.test(conns));
// Folding is only defensible while the header still reports failures. If the
// red count stopped rendering, a down function inside a shut group would be
// genuinely invisible — which is the one outcome this layout must not have.
check("a collapsed header still counts what's down",
  /if \(bad\) bits\.push\(\{ t: `\$\{bad\} down`, c: "var\(--red\)" \}\)/.test(systems));
check("the down count is outside the collapsible body",
  systems.indexOf("bits.map(") < systems.indexOf('className={`expand${open ? " open" : ""}`}'));

// Usage's disclosures are closed on arrival too — the long tail and the raw log.
check("the usage long tail starts closed", /const \[fnsOpen, setFnsOpen\] = useState\(false\)/.test(systems));
check("the raw log starts closed", /const \[showLog, setShowLog\] = useState\(false\)/.test(systems));

console.log(failed ? `\n${failed} systems check(s) failed` : "\nsystems: all checks passed");
process.exit(failed ? 1 : 0);
