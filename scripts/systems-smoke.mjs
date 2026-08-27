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
//   5. THAT A CRASH IS BOTH RECORDED AND READ. ErrorBoundary wrote every crash
//      into localStorage.br_crashes and nothing in src/ ever read that key —
//      write-only telemetry, which is indistinguishable from none. Errors thrown
//      outside a render weren't recorded at all. Both halves are checked here,
//      and so is the thing that keeps the reporter safe: a render loop throws
//      hundreds of times a second, so the dedupe and the caps have to run
//      BEFORE the first await or the burst outruns them.
//
// Section 6 pins something else invisible: WHICH settings keys are written by the
// merging path and how each shape is combined. That list exists twice by necessity
// — once as a CASE inside boardroom.settings_merge, once as MERGING_SETTINGS in
// data/db.js — and a key on one side only is either a write that the database
// refuses outright or a write that quietly goes back to overwriting the whole
// value. Neither is visible from the app.
//
// Sections 1–7 are text-based (the sources are JSX; there is no bundler here),
// like brief-order-smoke.mjs. SECTION 8 IS NOT, and the reason is written at the
// top of it: four data-loss paths in the settings write/retry machinery all read
// fine and all fail the moment responses arrive in an inconvenient order, so db.js
// is bundled with esbuild against a stubbed client and the reproductions are
// replayed — the same trick ambient-smoke.mjs uses for the sheet gesture.
//
// Run by `npm run verify`.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { rm as rmFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`ok: ${label}`);
  else { failed++; console.log(`FAIL: ${label}${detail ? ` ${detail}` : ""}`); }
};

const systems = readFileSync("src/pages/systems/SystemsPage.jsx", "utf8");
// Hoisted: two sections below assert what the CODE does, and this repo
// explains itself in prose at length, so both need code read as code.
const uncomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w])\/\/[^\n]*/g, "$1");

// CONN_GROUPS/CONN_META moved next door with the hook — see the bundle note.
const conns = readFileSync("src/pages/systems/connections.js", "utf8");

// ── 1. where everything lives now ────────────────────────────────────────────
const nav = readFileSync("src/shell/nav.js", "utf8");
const app = readFileSync("src/App.jsx", "utf8");
const sheet = readFileSync("src/shell/SettingsSheet.jsx", "utf8");
const kit = readFileSync("src/ui/kit.jsx", "utf8");

const navKeys = [...(nav.match(/export const NAV = \[([\s\S]*?)\n\];/)?.[1] || "")
  .matchAll(/^\s*\{ key: "(\w+)"/gm)].map(m => m[1]);
check("the nav is Brief, Personal, Train, Creed, Grocery, Markets, Finances, Guitar",
  navKeys.join(",") === "brief,personal,train,creed,grocery,markets,finances,guitar", navKeys.join(","));
// A tab with no route renders a blank titled page. The nav entry and the switch
// case in App are two separate edits and only one of them is visible when you
// forget the other — the icon/header pairs are already checked per key below,
// but nothing was checking that the tab actually goes anywhere.
check("every tab has a route", navKeys.every(k => new RegExp(`case "${k}":`).test(app)),
  navKeys.filter(k => !new RegExp(`case "${k}":`).test(app)).join(","));
// EIGHT, AND THE NUMBER MOVED BECAUSE SOMEBODY MEASURED IT. This said seven, and
// nav.js said the proof burden for an eighth was a screenshot at 375pt rather
// than arithmetic. Guitar took the eighth slot after exactly that: the real dock
// CSS, rendered in Chromium at three device pixel ratios, with the label widths
// read off the DOM.
//
//   375pt (iPhone 12–15)  columns 46.9px · longest label "Finances" 44px · 0 clipped
//   390pt                 columns 48.8px · longest label 44px            · 0 clipped
//   320pt (SE, 1st gen)   columns 38.8–44.2px (flex gives the long ones room) · 0 clipped
//
// So it fits, with 2.9px of gutter on the tightest common phone — tight, legible,
// and not the fudge the old note feared. What has NOT moved is the burden: a
// ninth needs its own measurement, and `.dock-label` now carries text-overflow so
// a label that one day does not fit degrades to an ellipsis instead of a letter
// sliced down the middle. Twelve is the hard stop below, well past anything that
// could be read, so a runaway loop still fails.
check("the tab bar stays at eight or fewer", navKeys.length <= 8, String(navKeys.length));
// Dreams is a sub-tab of Creed now. Both halves matter: it must not be a nav
// destination, and the page must actually mount it — a half-fold leaves a
// panel nothing can reach.
const creedPage = readFileSync("src/pages/creed/CreedPage.jsx", "utf8");
check("Dreams is not a nav destination", !navKeys.includes("dreams"));
check("Creed mounts both sub-tabs",
  /key: "creed".*key: "dreams"/s.test(creedPage) && /<DreamBoardPanel/.test(creedPage) && /<CreedPanel/.test(creedPage));
check("Creed lands on the Creed, not the boards", /useState\("creed"\)/.test(creedPage));
check("a saved dreams link opens the boards sub-tab",
  /if \(key === "dreams"\) key = "creed";/.test(app) && /t\.page === "dreams".*sub: "dreams"/s.test(app));
check("the boards still get the settings they need for the board list",
  /<CreedPage[^>]*updateSetting=\{updateSetting\}/.test(app) && /updateSetting=\{updateSetting\}/.test(creedPage));
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
// Tabs is third: which rooms are on the bar is configuration you set once,
// like the theme — it earns a sheet tab, never a nav slot.
check("Systems first, Theme second, Tabs third",
  sheetTabs.join(",") === "systems,theme,tabs", sheetTabs.join(","));
const sysTabs = [...(sheet.match(/const SYS_TABS = \[([\s\S]*?)\n\];/)?.[1] || "").matchAll(/key: "(\w+)"/g)].map(m => m[1]);
// Deploy joined the four when Rollback shipped. DeployTab had been exported
// from SystemsPage.jsx and mounted nowhere since Assets left the nav — which
// meant the one control you want during a bad deploy was reachable only from
// the Netlify dashboard, on a laptop, during whatever went wrong.
// Supabase joined them the same way and for the same reason, one audit later:
// SupabaseTab had been sitting in SystemsPage.jsx exported and mounted nowhere
// since that same nav change, and it is the ONLY thing in the app that issues
// `purge deleted > 30d` — the command src/data/db.js names as what finally
// destroys a soft-deleted dream tile or Creed line, "a deliberate, counted act
// rather than a cron nobody watches". Unrouted, that act had nowhere to be
// performed from and the rows just accumulated.
check("Systems holds Status, Usage, Deploy, Supabase, Miner and Account",
  sysTabs.slice().sort().join(",") === "account,deploy,miner,status,supabase,usage", sysTabs.join(","));
// The list and the mounts are one act — a key with no panel behind it renders a
// tab that does nothing, which is the failure mode this whole section is about,
// arriving from the other direction.
for (const key of sysTabs.filter((k) => k !== "account")) {
  check(`Systems → ${key} actually mounts a panel`,
    new RegExp(`sys === "${key}" &&`).test(sheet), sysTabs.join(","));
}
// Deleted with AssetsPage's route: a second, exported list of these sub-tabs that
// disagreed with the live one (no Account, and for a long while it was the only
// one that still remembered Supabase).
check("there is only one list of the Systems sub-tabs",
  !/SYSTEMS_SUBTABS\s*=/.test(systems));
check("the sheet lands on Systems → Usage",
  /useState\("systems"\)/.test(sheet) && /useState\("usage"\)/.test(sheet));
// Landing on Systems makes this guard load-bearing rather than merely tidy: a
// paid Claude ping on every tap of the sun/moon button would be a real bill.
check("Usage is the first Systems panel", sysTabs[0] === "usage", sysTabs.join(","));

// THE BUNDLE INVARIANT. Both halves matter: the panels must be lazy, and App
// must reach the hook WITHOUT touching SystemsPage — either one alone fails.
for (const panel of ["UsageTab", "StatusTab", "MinerPanel", "DeployTab", "SupabaseTab"]) {
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
check("sheets move focus inside and restore it on close",
  /restoreFocusRef/.test(kit) && /focusInitial/.test(kit) && /restoreFocusRef\.current\?\.isConnected/.test(kit));
check("only the top sheet traps Tab navigation",
  /e\.key !== "Tab"/.test(kit) && /sheetStack\[sheetStack\.length - 1\] !== id/.test(kit) && /last\.focus\(\)/.test(kit));

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
const missing = [...written].filter(f => !labelled.has(f) && !UNLABELLED_OK.has(f)).sort();
check("every fn the code can log has a label", missing.length === 0, missing.join(", "));

// The `discord_<stage>` family used to need a prefix fallback here, being a
// family rather than a fixed key. Both the exemption above and the branch it
// pointed at are gone with the Discord path, and this asserts the removal is
// COMPLETE — a stray prefix branch left behind would be dead code claiming to
// serve rows that no writer can produce.
//
// COMMENT-STRIPPED, and the first cut of this check was not: it read the raw file
// and failed on the paragraph explaining the retirement. That is the same trap
// spend-smoke and dreams-smoke both document — this repo explains itself in prose
// at length, so any assertion about what the CODE does has to read code as code.
check("no discord label branch survives the retirement",
  !/discord/i.test(uncomment(systems)), "SystemsPage still has discord in its code");
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

// ── 6. two devices, one settings row ─────────────────────────────────────────
// app_settings is loaded once at sign-in and nothing in src/ subscribes to
// changes, so every whole-value upsert of a document-shaped setting is a write
// against a copy that may already be wrong. ponder_items and finance_rules now go
// through boardroom.settings_merge instead. Four things about that are invisible:
// which keys take that path, how each SHAPE is combined, that a refused write is
// reported rather than retried into a loop, and that the refusal exists at all —
// none of which shows up unless you have two devices and notice something missing.
const merge = readFileSync("supabase/migrations/0033_settings_merge_rpc.sql", "utf8");
const dataDb = readFileSync("src/data/db.js", "utf8");
// Same reason migrations-smoke.mjs does it: this file explains itself in prose at
// length, and a claim in a comment is not a behaviour.
const mergeSql = merge.replace(/^\s*--.*$/gm, "");

const sqlKeys = Object.fromEntries([...mergeSql.matchAll(/when\s+'([a-z_]+)'\s+then\s+'(merge|replace)'/g)].map(m => [m[1], m[2]]));
const jsKeys = Object.fromEntries([...(dataDb.match(/export const MERGING_SETTINGS = \{([^}]*)\}/)?.[1] || "")
  .matchAll(/(\w+):\s*"(merge|replace)"/g)].map(m => [m[1], m[2]]));
const listOf = (o) => Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join(",");
check("both sides of the merging allowlist are readable",
  Object.keys(sqlKeys).length > 0 && Object.keys(jsKeys).length > 0, `${listOf(sqlKeys)} vs ${listOf(jsKeys)}`);
// THE ONE WITH TEETH IN THIS SECTION. A key the client sends and the function does
// not know is refused outright (loudly, at least); a key the function knows and the
// client never routes goes on being upserted whole, which is the silent bug.
check("the SQL allowlist and MERGING_SETTINGS are the same list",
  listOf(sqlKeys) === listOf(jsKeys), `${listOf(sqlKeys)} vs ${listOf(jsKeys)}`);
// The valve. Growing this is a deliberate act — four Netlify functions write
// app_settings with the service-role key and none of them carries an expected
// revision, so "route everything through the merge" is not a one-line change.
check("the allowlist is still just the two keys it started as",
  listOf(sqlKeys) === "finance_rules=merge,ponder_items=replace", listOf(sqlKeys));
// The strategy has to match the shape the PANEL actually reads, which is the only
// place the shape is really decided. An object merged as an array (or the reverse)
// is a settings row mangled by the function that exists to protect it.
const ponder = readFileSync("src/pages/personal/PonderPanel.jsx", "utf8");
const finances = readFileSync("src/features/finances/FinancesPanel.jsx", "utf8");
check("ponder_items is an array in the panel, and is replaced not merged",
  /Array\.isArray\(settings\?\.ponder_items\)/.test(ponder) && sqlKeys.ponder_items === "replace");
check("finance_rules is an object in the panel, and is merged not replaced",
  /settings\?\.finance_rules \|\| \{\}/.test(finances) && sqlKeys.finance_rules === "merge");

// The function itself. SECURITY INVOKER is what keeps RLS in force; a DEFINER here
// would hand every caller the owner's reach over every row in the table.
check("settings_merge runs as its caller, never as its owner",
  /security invoker/.test(mergeSql) && !/security definer/i.test(mergeSql));
check("…and scopes every statement to auth.uid()'s own row",
  /v_uid\s+uuid\s*:=\s*auth\.uid\(\)/.test(mergeSql) &&
  mergeSql.split("\n").filter((l) => /from boardroom\.app_settings|values \(v_uid/.test(l)).length >= 3 &&
  !/where\s+s\.setting_key\s*=\s*p_key\s*;/.test(mergeSql));
check("a caller with no session is refused rather than treated as somebody",
  /if v_uid is null then/.test(mergeSql) && /raise exception/.test(mergeSql));
// The compare-and-set. Without the where clause on the update, a stale array
// writer wins exactly as it did before — the function would have moved the
// overwrite into the database rather than stopped it.
check("a stale array write is refused by a compare-and-set on updated_at",
  /where v_strategy = 'merge'\s*\n\s*or s\.updated_at is not distinct from p_expected_updated_at/.test(mergeSql));
check("…and the refusal says nothing was applied, with the row that beat it",
  /'applied',\s*false/.test(mergeSql) && /'stale',\s*true/.test(mergeSql) && /'value',\s*v_cur/.test(mergeSql));
// An array is written verbatim or not at all. The moment this branch starts
// combining anything, an item can go missing without a refusal.
check("the array strategy never combines — it writes the patch or nothing",
  /else\s*\n\s*v_next := p_patch;/.test(mergeSql));
// The object strategy is a real patch: null means remove, and the removal happens
// before the concatenation or the key comes back holding null instead of leaving.
check("the object strategy merges onto the current row and honours deletions",
  /\(v_base - v_drop\) \|\| \(p_patch - v_drop\)/.test(mergeSql) &&
  /jsonb_typeof\(e\.value\) = 'null'/.test(mergeSql));
// The conflict path recomputes from the row rather than from what was read, so
// even the sliver between the select and the insert cannot lose a write.
check("the upsert's conflict path merges from the stored row, not the read copy",
  /coalesce\(nullif\(s\.setting_value/.test(mergeSql));
// Re-runnable and reachable: create-or-replace cannot change a return type, a
// fresh create restores PUBLIC execute, and PostgREST caches the schema — without
// the reload the rpc 404s exactly like a function that was never created.
check("the migration can be pasted twice", /drop function if exists boardroom\.settings_merge/.test(mergeSql));
check("execute is granted to authenticated and taken back from public",
  /grant\s+execute on function boardroom\.settings_merge/.test(mergeSql) && /revoke execute on function boardroom\.settings_merge/.test(mergeSql));
check("the schema cache is reloaded so the rpc is reachable at all",
  /notify pgrst, 'reload schema'/.test(mergeSql));

// NO NETLIFY FUNCTION IN FRONT OF IT, deliberately. supabase-js sends
// Content-Profile: boardroom on rpc and the schema is exposed, so the browser
// calls a boardroom function directly under RLS — which is not a guess: the Usage
// card has been calling boardroom.usage_summary that way with the anon key since
// it was written. A function here would add an owner gate nobody needs and a
// service-role key that bypasses the RLS this design leans on.
check("no settings-merge Netlify function was added — the client calls the rpc",
  !existsSync("netlify/functions/settings-merge.js"));
check("the precedent it relies on is still there",
  /supabase\.rpc\("usage_summary"/.test(systems) &&
  /grant execute on function boardroom\.usage_summary/.test(readFileSync("supabase-usage-fix.sql", "utf8")));

// The client half.
const mergeBody = dataDb.match(/async mergeSetting\([\s\S]*?\n  \},/)?.[0] || "";
check("db.mergeSetting is where this check expects it", mergeBody.length > 0);
check("it calls the rpc, once", (mergeBody.match(/supabase\.rpc\(/g) || []).length === 1);
// The expectation is the whole mechanism. Sending null every time would turn the
// compare-and-set into a coin toss the writer always loses.
check("it claims the revision it last saw", /at: base\?\.at \?\? null/.test(mergeBody) && /p_expected_updated_at: sent\.at/.test(mergeBody));
check("…and holds that revision as the string Postgres sent it",
  /lastSeen\.set\(key, \{ value: data\.value, at: data\.updated_at \}\)/.test(dataDb) && !/new Date\(data\./.test(dataDb));
// THE BASELINE HAS ONE MOVER IN THE WRITE PATH. This is the structural half of the
// fix for the retry that advanced lastSeen and told nobody: adopted() assigns the
// map and announces in the same function, so there is no way to reach one without
// the other. loadSettings is the only other setter allowed, and it needs no
// announcement because the row it is seeding from IS its return value — the caller
// cannot receive the baseline without receiving the settings it belongs to. A third
// one anywhere is that bug's door propped back open.
const setters = [...dataDb.matchAll(/^.*lastSeen\.set\(.*$/gm)].map((m) => m[0].trim());
check("the baseline moves in exactly two places", setters.length === 2, setters.join(" | "));
check("…and the one that is not the full read is adopted()",
  setters.filter((s) => /r\.setting_key/.test(s)).length === 1 &&
  setters.filter((s) => /data\.updated_at/.test(s)).length === 1, setters.join(" | "));
check("…and it announces in the same function",
  /function adopted\(key, data\) \{\s*\n\s*lastSeen\.set\(key, \{ value: data\.value, at: data\.updated_at \}\);[\s\S]*?tell\(\{ kind: "adopt"/.test(dataDb));
// A retry has to re-send the SAME claim. Recomputing it would quietly turn "save
// mine again" into "save mine over whatever is there now", which is the bug.
check("a retry re-claims the revision the first attempt was built for",
  /let sent = null;/.test(mergeBody) && /if \(!sent\) \{/.test(mergeBody) && /p_patch: sent\.patch/.test(mergeBody));
// The write that was already queued behind a refusal was built on the value that
// got replaced. It must refuse itself rather than land.
check("an array write built on a revision that has since been replaced is never sent",
  /strategy === "replace" && !sent && movesOf\(key\) !== gen/.test(mergeBody) &&
  /countMove\(key, data\.updated_at\)/.test(mergeBody));
// The move counter is keyed by the REVISION that beat us, so this device's own
// Retry — which re-sends the same claim and is refused by the same revision — is
// one move met twice rather than two moves. Counting it twice armed the guard
// above against the next legitimate edit, which was then dropped unsent.
check("a move is counted once per revision, not once per refusal",
  /const countMove = \(key, at\) => \{[\s\S]*?if \(seen && seen\.at === at\) return;/.test(dataDb));
// Adopting on a refusal too: the value that beat us is the one the screen should
// show, and leaving the refused edit up would be a list the database does not have.
// It leaves through settingsNews rather than the return value — see section 8.
check("what comes back is adopted whenever the row had moved, refused or not",
  /if \(!data\.stale\) return false;\s*\n\s*tell\(\{ kind: "adopt", key, value: data\.value \}\);/.test(dataDb));
check("mergeSetting hands back no second copy of the adopt to be used instead",
  !/\badopt\s*:/.test(mergeBody), (mergeBody.match(/.*\badopt\s*:.*/g) || []).join(" | ").slice(0, 120));
check("loadSettings reads updated_at, or there is no revision to claim",
  /select\("setting_key,setting_value,updated_at"\)/.test(dataDb));
// One store for failed writes, one entry per setting. A refusal filed under a key
// of its own would put two chips in the top bar for one setting, and neither would
// clear when the next write landed.
check("a refusal is filed through reported(), under saveSetting's own key",
  /reported\(`setting:\$\{key\}`/.test(mergeBody));
check("no second failure mechanism was invented",
  (dataDb.match(/const failureListeners = new Set\(\)/g) || []).length === 1 &&
  (dataDb.match(/export const writeFailures = \{/g) || []).length === 1);
check("the refusal is thrown, so the store hears about it", /e\.stale = true;\s*\n\s*throw e;/.test(mergeBody));
// Writes to one key are serialised, or this device's own previous write looks like
// another device: Ponder sends the whole array on every tap, and two taps in a row
// would have the second one refused as stale by the first.
check("merges to the same key go out one at a time", /queued\(key,/.test(mergeBody) && /const queued = \(key, run\) =>/.test(dataDb));

// App routes only the allowlisted keys, and adopts what comes back.
check("App routes the merging keys through mergeSetting",
  /if \(MERGING_SETTINGS\[key\]\) return await db\.mergeSetting\(key, value\);/.test(app));
check("…and every other setting keeps the plain upsert", /return await db\.saveSetting\(key, value\);/.test(app));
// ONE PLACE PAINTS THE ADOPT, and it is not the return value. Reading res.adopt
// covered the write in front of you and missed the chip's Retry entirely, which is
// how the baseline advanced while the screen stood still.
check("App adopts over the news channel, so a retry repaints too",
  /settingsNews\.subscribe\(/.test(app) &&
  /news\.kind === "adopt"/.test(app) &&
  /setSettings\(prev => \(prev \? \{ \.\.\.prev, \[news\.key\]: news\.value \} : prev\)\)/.test(app));
check("…and nothing in App reads an adopt off mergeSetting's return", !/res\?\.adopt/.test(app));
// The pre-migration fallback is visible or it is the old silent overwrite with
// better paperwork. The write SAVED, so it must not be filed as a failure — a
// notice is the only honest shape.
check("the unprotected write says so on screen, naming the migration to run",
  /news\.kind === "unprotected"/.test(app) && /unprotectedKey && \(/.test(app) &&
  /0033_settings_merge_rpc\.sql/.test(app));
check("…in the toast stack, with no hardcoded colour",
  /className="toasts"/.test(app) && /var\(--amber\)/.test(app) &&
  !/#[0-9a-fA-F]{3,8}\b/.test(app.match(/\{unprotectedKey && \([\s\S]*?\n      \)\}/)?.[0] || ""));
check("signing out forgets which revision this device had seen",
  /db\.forgetSettings\(\)/.test(app) && /forgetSettings\(\) \{ lastSeen\.clear\(\); foreignMoves\.clear\(\); \}/.test(dataDb));

// ── 7. a crash is recorded, and something reads it ───────────────────────────
// The gap this closes: ErrorBoundary wrote localStorage.br_crashes and nothing in
// src/ read the key, so every crash the app caught was filed for nobody and
// evicted with the origin's storage. Nothing at all caught an error thrown
// outside a render. Both halves are pinned here, plus the two ways the new
// version could be worse than the old one — a reporter that can throw, and a
// reporter that a render loop turns into a flood of inserts.
const boundary = readFileSync("src/shell/ErrorBoundary.jsx", "utf8");
const telemetry = readFileSync("src/lib/telemetry.js", "utf8");
const mainJsx = readFileSync("src/main.jsx", "utf8");
const crashMigration = readFileSync("supabase/migrations/0034_client_errors.sql", "utf8");

// The local log needs no network, no session and no working database, which makes
// it the record that survives the case you most want a record of. It was never
// the problem; nothing reading it was.
check("the boundary still writes the local crash log", /localStorage\.setItem\("br_crashes"/.test(boundary));
check("…and something finally reads it back", /localStorage\.getItem\("br_crashes"\)/.test(systems));
check("the boundary also files the durable row", /kind: "render"/.test(boundary) && /reportClientError\(/.test(boundary));

// One module writes telemetry. A second insert site somewhere else is how the
// usage log grew six writers with six different ideas about failure.
check("the crash insert lives in telemetry.js beside logUsage",
  /export async function reportClientError/.test(telemetry) && /from\("client_errors"\)/.test(telemetry));
check("nothing else inserts crashes directly",
  !/from\("client_errors"\)\.insert/.test(boundary) && !/from\("client_errors"\)\.insert/.test(mainJsx));

const reporter = telemetry.match(/export async function reportClientError[\s\S]*$/)?.[0] || "";
check("reportClientError is still where this check expects it", reporter.length > 0);
// A reporter that throws is a joke, and here it is also a loop: a rejection out
// of this function lands in the unhandledrejection handler that called it.
check("the only throw in the reporter is the one it catches itself",
  (reporter.match(/\bthrow\b/g) || []).length === 1, String((reporter.match(/\bthrow\b/g) || []).length));
check("…and the catch names the failure instead of swallowing it",
  /console\.warn\(`\[telemetry\] client_errors/.test(reporter));

// THE ONE WITH TEETH. A render loop throws hundreds of times a second. Every
// decision about whether to send has to be made — and recorded — before the first
// await, or two hundred throws in one tick all read an empty set, all conclude
// they are the first, and all two hundred inserts go out.
const gate = reporter.slice(0, reporter.indexOf("await"));
check("the dedupe runs before the first await", /sentThisSession\.has\(hash\)/.test(gate));
check("both caps run before the first await", /PER_SESSION_CAP/.test(gate) && /PER_BUILD_CAP/.test(gate));
check("the hash is marked spent before the insert is attempted", /sentThisSession\.add\(hash\)/.test(gate));
// A crash on first render means a reload, and a reload is a fresh session with an
// empty Set — so the ceiling has to outlive the page, and reset on the next build.
check("the cap survives a reload", /localStorage\.setItem\(SENT_KEY/.test(telemetry));
check("…and starts clean on the next build", /raw\.build !== BUILD/.test(telemetry));
check("every row carries the build, or a crash can't be pinned to a deploy",
  /build: BUILD/.test(telemetry) && /__BUILD__/.test(telemetry));

// Registered at the top of the entry module: everything below it — the persister,
// the hydrate, the root render, the service worker — can throw.
check("window errors are handled, before anything that could throw",
  /window\.addEventListener\("error"/.test(mainJsx) && mainJsx.indexOf('addEventListener("error"') < mainJsx.indexOf("createRoot("));
check("unhandled rejections are handled, in the same place",
  /window\.addEventListener\("unhandledrejection"/.test(mainJsx) && mainJsx.indexOf('addEventListener("unhandledrejection"') < mainJsx.indexOf("createRoot("));
// window.onerror holds one function, so assigning it evicts whoever else set it.
// COMMENTS ARE STRIPPED FOR THIS ONE, and for the placement check further down.
// This repo explains itself in prose at length, and the note above those handlers
// says in words that `window.onerror =` is the wrong spelling — so a check that
// reads prose as code fails on the very file that documents it. Same trap
// migrations-smoke.mjs strips comments to avoid, same fix.
const mainCode = uncomment(mainJsx), systemsCode = uncomment(systems);
check("neither handler is installed by assignment",
  !/window\.onerror\s*=/.test(mainCode) && !/window\.onunhandledrejection\s*=/.test(mainCode));
check("both handlers go through the one reporter",
  (mainJsx.match(/reportClientError\(\{/g) || []).length === 2);

// `kind` is the vocabulary this table is documented in. A fourth value spelled
// only in the writer is one nothing reading the table would know to expect.
const kinds = [...`${boundary}\n${mainJsx}`.matchAll(/kind: "(\w+)"/g)].map(m => m[1]);
check("the writers use exactly render, window and rejection",
  kinds.slice().sort().join(",") === "rejection,render,window", kinds.join(","));
for (const k of kinds) {
  check(`'${k}' is written down in 0034_client_errors.sql`, crashMigration.includes(`'${k}'`));
}

// The Status row. Three ways it could lie, and all three are pinned: a number it
// never read, a capped list standing in for a total, and a calm zero over a read
// that failed.
check("Status reads the crashes for the build this device is running",
  /from\("client_errors"\)/.test(systems) && /\.eq\("build", BUILD\)/.test(systems));
check("the headline number is an exact count, not the length of a capped list",
  /count: "exact"/.test(systems) && /\.limit\(20\)/.test(systems));
check("a count that didn't arrive is never printed as a number", /typeof count !== "number"/.test(systems));
check("a failed read says it failed", /read failed/.test(systems) && /state\?\.err/.test(systems));
check("a missing table names the file to paste", /0034_client_errors\.sql/.test(systems));
check("zero crashes reads as a sentence, not an empty row",
  /Nothing has thrown since this build went out\./.test(systems));
check("the crash row sits in the card with the build stamp it describes",
  systemsCode.includes("<CrashRow />") && systemsCode.indexOf("<CrashRow />") < systemsCode.indexOf("Build {BUILD}"));

/* ── 8. THE WRITE MACHINERY, EXECUTED ─────────────────────────────────────────
   Everything above is text, and text was not enough. Four data-loss paths lived
   in the code section 6 checks — all four of them reachable by reading the file
   and concluding it was fine, all four of them obvious the moment the thing is
   RUN with responses arriving in an inconvenient order:

     1. The chip's Retry advanced this device's baseline and told nobody, so the
        NEXT edit claimed a revision the screen had never seen. The compare-and-set
        passed, the write landed, the chip cleared, and another device's work was
        gone under a green "saved".
     2. The guard against sending an array built on a replaced revision counted
        this device's own Retry as somebody else's edit, then dropped the next
        legitimate edit WITHOUT SENDING IT and blamed "another device" for it.
     3. Failures coalesced on whichever attempt SETTLED last rather than the newest
        one, so on a flaky link the Retry saved the value you dragged away from.
     4. Both merging keys routed exclusively at an rpc that does not exist until
        0033 is pasted in by hand, so they stopped saving at all in the window
        before that — keys that upserted fine for a year.

   A grep for a variable name catches none of these. So db.js is bundled with
   esbuild (bare Node cannot resolve its Vite-style import.meta.env dependency),
   lib/supabase.js is replaced with a stub whose responses this file decides, and
   the reproductions are replayed — including a fake App that adopts exactly the
   way src/App.jsx does, because two of the four are only visible from up there. */
const dbMod = await (async () => {
  const out = path.resolve(".systems-smoke-db.tmp.mjs");
  // The stub is not a file on disk: a plugin answers for lib/supabase.js, which
  // keeps the fake next to the assertions that depend on its shape. Everything it
  // exposes is delegated to globalThis.__srv so each scenario can rewrite the
  // server's behaviour between calls without re-importing the module under test —
  // module state (the baseline, the move counter, the failure store) has to
  // survive from one step of a reproduction to the next, exactly as it does in a
  // browser tab.
  const stub = `
    export const ANTHROPIC_API_KEY = "";
    export const supabase = {
      auth: { getUser: async () => ({ data: { user: { id: "smoke-user" } } }) },
      from: (t) => globalThis.__srv.from(t),
      rpc: (n, a) => globalThis.__srv.rpc(n, a),
    };
  `;
  await build({
    entryPoints: ["src/data/db.js"], bundle: true, platform: "node", format: "esm",
    outfile: out, logLevel: "error",
    plugins: [{
      name: "stub-supabase",
      setup(b) {
        b.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "supabase-stub", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }));
      },
    }],
  });
  try { return await import(pathToFileURL(out).href); }
  finally { await rmFile(out, { force: true }); }
})();
const { db: DB, writeFailures: WF, settingsNews } = dbMod;
check("db.js is importable with a stubbed client",
  typeof DB?.mergeSetting === "function" && typeof WF?.retryAll === "function" && typeof settingsNews?.subscribe === "function");

const srv = { upserts: [], rpcs: [], onSelect: null, onUpsert: null, onRpc: null };
globalThis.__srv = {
  from: () => ({
    select: () => Promise.resolve(srv.onSelect ? srv.onSelect() : { data: [], error: null }),
    upsert: (row) => Promise.resolve(srv.onUpsert ? srv.onUpsert(row) : { error: null }).then((r) => { srv.upserts.push(row); return r; }),
  }),
  rpc: (name, args) => { srv.rpcs.push(args); return Promise.resolve(srv.onRpc ? srv.onRpc(args) : { data: null, error: null }); },
};

// The fake App: it does what src/App.jsx does and nothing else — paint the
// optimistic value, then paint whatever the news channel says was adopted.
const screen = {};
const notices = [];
settingsNews.subscribe((n) => {
  if (n.kind === "adopt") screen[n.key] = n.value;
  else notices.push(n);
});
const edit = async (key, value) => { screen[key] = value; return DB.mergeSetting(key, value); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => {
  WF.clearAll(); DB.forgetSettings();
  srv.upserts = []; srv.rpcs = []; srv.onSelect = null; srv.onUpsert = null; srv.onRpc = null;
  notices.length = 0;
  for (const k of Object.keys(screen)) delete screen[k];
};
const seed = async (key, value, at) => {
  srv.onSelect = () => ({ data: [{ setting_key: key, setting_value: value, updated_at: at }], error: null });
  screen[key] = value;
  return DB.loadSettings();
};
const applied = (value, at) => ({ data: { key: "k", applied: true, stale: false, value, updated_at: at }, error: null });
const refused = (value, at) => ({ data: { key: "k", applied: false, stale: true, value, updated_at: at }, error: null });
const entryFor = (key) => WF.list().find((f) => f.key === `setting:${key}`);

// ── 8a. THE RETRY THAT MOVED THE BASELINE AND TOLD NOBODY ─────────────────────
// iPad archives an item, the request dies on the wire, the chip says 1 unsaved.
// The phone parks a thought. Retry is refused — correctly — and everything now
// depends on the refusal reaching the screen, because it carries the row that beat
// it AND it is what the next edit will be diffed against.
reset();
await seed("ponder_items", ["a", "b"], "R1");
srv.onRpc = () => ({ data: null, error: { message: "Failed to fetch", code: "" } });
let r = await edit("ponder_items", ["b"]);
check("a merge that dies on the wire is reported and filed", r.ok === false && !!entryFor("ponder_items"));
srv.onRpc = () => refused(["c", "a", "b"], "R2");
await WF.retryAll();
check("THE RETRY'S REFUSAL REACHES THE SCREEN", same(screen.ponder_items, ["c", "a", "b"]), JSON.stringify(screen.ponder_items));
check("…and the refused retry is still on the chip", !!entryFor("ponder_items"));
// The next real edit, built on what was adopted. This is the assertion the old code
// failed: it sent ["d","b"], claimed R2, and passed the compare-and-set.
srv.rpcs = [];
srv.onRpc = (args) => applied(args.p_patch, "R3");
r = await edit("ponder_items", ["d", ...screen.ponder_items]);
check("the next edit claims the revision that was adopted", srv.rpcs[0]?.p_expected_updated_at === "R2", String(srv.rpcs[0]?.p_expected_updated_at));
check("…and carries the thought the other device parked",
  same(srv.rpcs[0]?.p_patch, ["d", "c", "a", "b"]), JSON.stringify(srv.rpcs[0]?.p_patch));
check("…and lands, clearing the chip", r.applied === true && !entryFor("ponder_items"));

// finance_rules is the worse half: the retry SUCCEEDS, so without the adopt nothing
// ever appears on screen and the following edit patches Delta out with a null.
reset();
await seed("finance_rules", { Kroger: "grocery" }, "R1");
srv.onRpc = () => ({ data: null, error: { message: "Failed to fetch", code: "" } });
await edit("finance_rules", { Kroger: "grocery", Shell: "gas" });
srv.onRpc = () => ({ data: { applied: true, stale: true, value: { Kroger: "grocery", Delta: "travel", Shell: "gas" }, updated_at: "R2" }, error: null });
await WF.retryAll();
check("a retry that SUCCEEDS with a merged value repaints too",
  same(screen.finance_rules, { Kroger: "grocery", Delta: "travel", Shell: "gas" }), JSON.stringify(screen.finance_rules));
srv.rpcs = [];
srv.onRpc = (args) => applied(args.p_patch, "R3");
await edit("finance_rules", { ...screen.finance_rules, Kroger: "dining" });
check("…so the next patch changes one rule and deletes none",
  same(srv.rpcs[0]?.p_patch, { Kroger: "dining" }), JSON.stringify(srv.rpcs[0]?.p_patch));

// ── 8b. THE GUARD MUST NOT FIRE ON THIS DEVICE'S OWN RETRY ────────────────────
// A refused write sits in the chip. Retry, then archive something 5ms later while
// the retry is still in flight — the exact sequence that used to drop the archive
// without sending it and blame a device that had done nothing.
reset();
await seed("ponder_items", ["a", "b"], "R1");
srv.onRpc = () => refused(["c", "a", "b"], "R2");
await edit("ponder_items", ["b"]);
check("the first refusal is adopted and filed", same(screen.ponder_items, ["c", "a", "b"]) && !!entryFor("ponder_items"));
// The retry re-sends the SAME claim, so it is refused again by the SAME revision —
// one move, met twice. Anything else the server sees here is a write built on what
// was adopted, and there is nothing stale about it: R2 is still the row.
srv.onRpc = async (args) => {
  await sleep(30);
  return same(args.p_patch, ["b"]) ? refused(["c", "a", "b"], "R2") : applied(args.p_patch, "R3");
};
const retrying = WF.retryAll();
await sleep(5);
srv.rpcs = [];
const archive = edit("ponder_items", screen.ponder_items.slice(1));
await Promise.all([retrying, archive]);
const arch = await archive;
check("AN EDIT MADE DURING A RETRY IS ACTUALLY SENT", srv.rpcs.length === 1, `${srv.rpcs.length} rpc call(s)`);
check("…claiming the revision the retry re-confirmed", srv.rpcs[0]?.p_expected_updated_at === "R2", String(srv.rpcs[0]?.p_expected_updated_at));
check("…and it is not reported as a failure", arch.ok === true, JSON.stringify(arch.error?.message || ""));

// The guard still exists for the case it was written for: a write queued behind one
// that comes back refused was built on a revision that has since been replaced.
reset();
await seed("ponder_items", ["a", "b"], "R1");
let hold = null;
srv.onRpc = () => new Promise((res) => { hold = () => res(refused(["c", "a", "b"], "R2")); });
const first = DB.mergeSetting("ponder_items", ["b"]);
await sleep(5);
srv.rpcs = [];
const second = DB.mergeSetting("ponder_items", ["a"]);
await sleep(5);
hold();
const [r1, r2] = [await first, await second];
check("a write queued behind a refusal refuses itself", r1.ok === false && r2.ok === false);
check("…without sending anything", srv.rpcs.length === 0, `${srv.rpcs.length} rpc call(s)`);
check("…and says so without naming a cause it never checked",
  /wasn't saved/.test(r2.error?.message || "") && !/another device/i.test(r2.error?.message || ""), r2.error?.message || "");
check("a plain refusal names no cause either",
  !/another device/i.test(r1.error?.message || ""), r1.error?.message || "");
// Belt and braces on the message: the strings in db.js may not blame a device.
// Comments are stripped, because this file explains the bug in prose at length and
// prose about a lie is not a lie.
const dbCode = dataDb.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w])\/\/[^\n]*/g, "$1");
check("no message in db.js blames another device", !/another device/i.test(dbCode),
  (dbCode.match(/.*another device.*/i) || []).join(" ").slice(0, 120));

// ── 8c. COALESCING IS ON THE NEWEST ATTEMPT, NOT THE NEWEST FAILURE ───────────
// Two tab-bar drops in a burst, both failing, the FIRST one's response arriving
// LAST. saveSetting has no per-key queue, so this is genuinely concurrent.
reset();
const settled = [];
srv.onUpsert = async (row) => {
  await sleep(row.setting_value === "dragged-away-from" ? 40 : 5);
  settled.push(row.setting_value);
  return { error: { message: "offline", code: "" } };
};
const a = DB.saveSetting("navigation", "dragged-away-from");
await sleep(1);
const b = DB.saveSetting("navigation", "what-you-meant");
await Promise.all([a, b]);
check("the older attempt really did settle last", same(settled, ["what-you-meant", "dragged-away-from"]), settled.join(","));
check("one failure entry for the key, not two", WF.list().filter((f) => f.key === "setting:navigation").length === 1);
srv.upserts = [];
srv.onUpsert = null; // the link comes back
await entryFor("navigation").retry();
check("THE RETRY SENDS WHAT YOU LAST MEANT", srv.upserts[0]?.setting_value === "what-you-meant", String(srv.upserts[0]?.setting_value));
check("…and the chip clears once it lands", !entryFor("navigation"));

// The mirror image: a superseded attempt that eventually SUCCEEDS must not clear a
// newer attempt's chip, or the one sign that the value on screen never saved goes
// away.
reset();
srv.onUpsert = async (row) => {
  await sleep(row.setting_value === "old" ? 40 : 5);
  return row.setting_value === "old" ? { error: null } : { error: { message: "offline", code: "" } };
};
await Promise.all([DB.saveSetting("navigation", "old"), (await sleep(1), DB.saveSetting("navigation", "new"))]);
check("a late success does not clear a newer failure", !!entryFor("navigation"));

// ── 8d. IT STILL SAVES BEFORE 0033 IS PASTED IN ───────────────────────────────
// PostgREST answers PGRST202 for an rpc it has never heard of. Both keys upserted
// fine before this branch; a fix that stops them saving is not a fix.
reset();
await seed("finance_rules", { Kroger: "grocery" }, "R1");
srv.onRpc = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function boardroom.settings_merge(p_expected_updated_at, p_key, p_patch) in the schema cache" } });
r = await edit("finance_rules", { Kroger: "grocery", Shell: "gas" });
check("a missing settings_merge falls back to the old upsert", r.ok === true && srv.upserts.length === 1);
check("…sending the WHOLE value, not the patch the rpc wanted",
  same(srv.upserts[0]?.setting_value, { Kroger: "grocery", Shell: "gas" }), JSON.stringify(srv.upserts[0]?.setting_value));
check("…filing no failure for a write that saved", !entryFor("finance_rules"));
check("…and SAYING the protection is not active yet",
  notices.some((n) => n.kind === "unprotected" && n.key === "finance_rules" && /0033/.test(n.migration || "")), JSON.stringify(notices));
check("…which the caller can also see on the result", r.unprotected === true);
// THE HALF THAT MATTERS MORE. A stale-write refusal must never reach the fallback:
// upserting the whole value there is precisely the overwrite 0033 exists to refuse.
reset();
await seed("ponder_items", ["a", "b"], "R1");
srv.onRpc = () => refused(["c", "a", "b"], "R2");
r = await edit("ponder_items", ["b"]);
check("A REFUSAL NEVER FALLS BACK TO THE BLIND UPSERT", srv.upserts.length === 0, `${srv.upserts.length} upsert(s)`);
check("…it is reported as the failure it is", r.ok === false && r.applied === false && !!entryFor("ponder_items"));
check("…and no unprotected notice is invented for it", notices.length === 0, JSON.stringify(notices));
// Any other rpc error is still a failure, not an excuse to overwrite the row.
reset();
await seed("ponder_items", ["a", "b"], "R1");
srv.onRpc = () => ({ data: null, error: { code: "42501", message: "new row violates row-level security policy" } });
r = await edit("ponder_items", ["b"]);
check("an RLS refusal does not fall back either", r.ok === false && srv.upserts.length === 0);

console.log(failed ? `\n${failed} systems check(s) failed` : "\nsystems: all checks passed");
process.exit(failed ? 1 : 0);
