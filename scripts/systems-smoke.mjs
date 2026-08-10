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
// Text-based (the sources are JSX; there is no bundler here), like
// brief-order-smoke.mjs.

import { readFileSync, readdirSync, existsSync } from "node:fs";

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
const kit = readFileSync("src/ui/kit.jsx", "utf8");

const navKeys = [...(nav.match(/export const NAV = \[([\s\S]*?)\n\];/)?.[1] || "")
  .matchAll(/^\s*\{ key: "(\w+)"/gm)].map(m => m[1]);
check("the nav is Brief, Personal, Train, Creed, Grocery, Markets, Finances",
  navKeys.join(",") === "brief,personal,train,creed,grocery,markets,finances", navKeys.join(","));
// A tab with no route renders a blank titled page. The nav entry and the switch
// case in App are two separate edits and only one of them is visible when you
// forget the other — the icon/header pairs are already checked per key below,
// but nothing was checking that the tab actually goes anywhere.
check("every tab has a route", navKeys.every(k => new RegExp(`case "${k}":`).test(app)),
  navKeys.filter(k => !new RegExp(`case "${k}":`).test(app)).join(","));
// Seven is the ceiling for a phone tab bar with readable labels — Markets took
// the seventh slot after measuring the real fit (~53px columns at 375pt, the
// longest label ~46px at 10px/600; see the note in nav.js). An eighth needs a
// different chrome, not a smaller font.
check("the tab bar stays at seven or fewer", navKeys.length <= 7, String(navKeys.length));
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
check("Systems holds Status, Usage, Deploy, Miner and Account",
  sysTabs.slice().sort().join(",") === "account,deploy,miner,status,usage", sysTabs.join(","));
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
  /lastSeen\.set\(key, \{ value: data\.value, at: data\.updated_at \}\)/.test(mergeBody) && !/new Date\(/.test(mergeBody));
// A retry has to re-send the SAME claim. Recomputing it would quietly turn "save
// mine again" into "save mine over whatever is there now", which is the bug.
check("a retry re-claims the revision the first attempt was built for",
  /let sent = null;/.test(mergeBody) && /if \(!sent\) \{/.test(mergeBody) && /p_patch: sent\.patch/.test(mergeBody));
// The write that was already queued behind a refusal was built on the value that
// got replaced. It must refuse itself rather than land.
check("an array write built on a version another device replaced is never sent",
  /strategy === "replace" && !sent && \(foreignMoves\.get\(key\) \|\| 0\) !== gen/.test(mergeBody) &&
  /foreignMoves\.set\(key, \(foreignMoves\.get\(key\) \|\| 0\) \+ 1\)/.test(mergeBody));
// Adopting on a refusal too: the value that beat us is the one the screen should
// show, and leaving the refused edit up would be a list the database does not have.
check("what comes back is adopted whenever the row had moved, refused or not",
  /adopt: !!data\.stale/.test(mergeBody));
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
  /if \(MERGING_SETTINGS\[key\]\) \{\s*\n\s*const res = await db\.mergeSetting\(key, value\);/.test(app));
check("…and every other setting keeps the plain upsert", /return await db\.saveSetting\(key, value\);/.test(app));
check("App adopts the merged value when the row had moved under it",
  /if \(res\?\.adopt\) setSettings\(prev => \(\{ \.\.\.\(prev \|\| \{\}\), \[key\]: res\.value \}\)\)/.test(app));
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
const uncomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w])\/\/[^\n]*/g, "$1");
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

console.log(failed ? `\n${failed} systems check(s) failed` : "\nsystems: all checks passed");
process.exit(failed ? 1 : 0);
