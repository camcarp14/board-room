// ─── Schema invariants: the record has to stay complete and stay boardroom ────
// Board Room's tables live in the `boardroom` schema. src/lib/supabase.js pins
// the browser client with db: { schema: "boardroom" }, and every Netlify function
// that talks to PostgREST sends Accept-Profile / Content-Profile: boardroom. A
// table created in `public` is therefore one this app can NEVER see: the loader
// 404s forever while the setup card that just "worked" keeps offering itself.
// Nothing about that is visible from either side.
//
// That shipped once, with the Dream boards, and the note at
// src/features/finances/financeLogic.js:653 records it. supabase/migrations/ is
// the answer to the other half of the problem — 22 of the 32 tables this app uses
// had no DDL written down anywhere, so there was nothing to be wrong or right
// about. Four things about that directory are invisible in a diff:
//
//   1. THAT IT IS COMPLETE. A table the code reaches with no file here is a table
//      whose shape lives only in production. Adding a .from() is one edit;
//      writing down what it reads is another, and only the first one is visible
//      when you forget the second.
//
//   2. THAT EVERY FILE IS boardroom-QUALIFIED. This is the one with teeth, and
//      the reason this file exists at all. An unqualified or public-qualified
//      create is a migration that builds a database the app cannot read.
//
//   3. THAT EVERY FILE IS RE-RUNNABLE. These get pasted into the Supabase SQL
//      editor by hand, sometimes twice, and a file that errors half-way through
//      leaves a schema in a state nobody designed.
//
//   4. THAT THE BACKUP COVERS ALL OF IT. netlify/functions/export-data.js
//      duplicates the table list because a shared require would clobber its
//      handler (see the note in netlify/functions/audit.js). Duplication is the
//      established pattern here; this check is the thing that makes it safe.
//      It shipped covering nine tables out of 32 — no transactions, no workouts,
//      no creed, no dreams, no upkeep, no Record — for as long as it existed.
//
// Text-based (the sources are JSX and the migrations are SQL; there is no
// bundler here), like systems-smoke.mjs.

import { readFileSync, readdirSync } from "node:fs";

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`ok: ${label}`);
  else { failed++; console.log(`FAIL: ${label}${detail ? ` ${detail}` : ""}`); }
};

const MIG_DIR = "supabase/migrations";

// ─── the true table inventory, read out of the code ──────────────────────────
// Two ways the app names a table, and both have to be swept or the inventory
// undercounts:
//
//   · supabase-js — `.from("name")`. Excludes the built-ins that share the
//     method name; Buffer.from and Array.from are everywhere in this repo.
//   · raw PostgREST — `/rest/v1/<name>`, plus the helpers that take the table as
//     an argument (`rest(cfg, "usage_log", …)`, `sb("plaid_items", …)`). Those
//     helpers are why plaid_items and upstream_run_events are invisible to a
//     `.from()` sweep alone: plaid.js and netlify/lib/upstream/store.js never
//     call .from() at all.
const NOT_A_TABLE = new Set(["Buffer", "Array", "String", "Object", "Date", "Set", "Map", "Uint8Array", "Int8Array", "Float64Array", "BigInt", "Number", "Promise"]);

// COMMENTS ARE STRIPPED FIRST, and that is not tidiness. src/data/db.js opens
// with a scar-tissue block whose example is `await supabase.from("t")` —
// illustrating that a PostgREST rejection RESOLVES rather than throws. Swept
// naively, that comment invents a table called `t`, and the smoke then demands a
// migration for it. This repo explains itself in prose at length; a sweep over its
// sources has to read code as code.
//
// `//` is only treated as a comment when it is not preceded by a colon, so the
// http:// and https:// literals all over the functions survive intact.
const stripJs = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:\w])\/\/[^\n]*/g, "$1");

const sources = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) sources.push([p, stripJs(readFileSync(p, "utf8"))]);
  }
};
walk("src"); walk("netlify");

const fromTables = new Map();   // table -> first file that reaches it
for (const [path, src] of sources) {
  for (const m of src.matchAll(/(?:(\w+)\s*)?\.from\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g)) {
    if (NOT_A_TABLE.has(m[1])) continue;
    if (!fromTables.has(m[2])) fromTables.set(m[2], path);
  }
}
const restTables = new Map();
for (const [path, src] of sources) {
  for (const m of src.matchAll(/rest\/v1\/([a-z][a-z0-9_]*)/g)) {
    if (!restTables.has(m[1])) restTables.set(m[1], path);
  }
  // The helper-argument form: rest(cfg, "table", …) / sb("table", …) / rest(c, `table?…`)
  for (const m of src.matchAll(/\b(?:rest|sb)\(\s*(?:\w+\s*,\s*)?["'`]([a-z][a-z0-9_]*)[?"'`]/g)) {
    if (!restTables.has(m[1])) restTables.set(m[1], path);
  }
}

// NOT OURS. These two live in a different Supabase project entirely
// (CLARIFY_SUPABASE_URL), and `creators` sits under a `zts` schema selected by
// its own Accept-Profile header. clarify-pipeline.js and zts-pipeline.js read
// them cross-tool for the Pentagon roll-up; Board Room does not own their shape
// and must not ship DDL for them. Listed explicitly so the next person to run
// this can't helpfully "complete" the inventory with two foreign tables.
const FOREIGN = new Set(["outreach", "creators"]);

const wanted = [...new Set([...fromTables.keys(), ...restTables.keys()])]
  .filter((t) => !FOREIGN.has(t)).sort();

// ─── the migration files ─────────────────────────────────────────────────────
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
check("the migrations directory has files", files.length > 0, MIG_DIR);

const sql = new Map(files.map((f) => [f, readFileSync(`${MIG_DIR}/${f}`, "utf8")]));

// A sortable numeric prefix, so "run them in order" is a fact about the
// filenames rather than a thing you have to know.
for (const f of files) {
  check(`${f} sorts by a numeric prefix`, /^\d{4}_[a-z0-9_]+\.sql$/.test(f), f);
}

// Comments are stripped before every content assertion below. A `public.` inside
// a `--` line is documentation (0014_dream_items.sql ends with the drop statement
// for the table the old setup card created); one in a statement is the bug.
const stripped = new Map([...sql].map(([f, s]) => [f, s.replace(/^\s*--.*$/gm, "")]));

// ── 1. the record is complete ────────────────────────────────────────────────
const declared = new Map();     // table -> file that creates it
for (const [f, s] of stripped) {
  for (const m of s.matchAll(/create table if not exists\s+boardroom\.([a-z][a-z0-9_]*)/gi)) {
    declared.set(m[1], f);
  }
}
const missing = wanted.filter((t) => !declared.has(t));
check("every table the code reaches has a migration", missing.length === 0, missing.join(", "));

// The other direction. A file for a table nothing reads is either a table that
// was removed and left its DDL behind, or a typo in a name — both look like a
// complete record and neither is one.
const orphans = [...declared.keys()].filter((t) => !wanted.includes(t)).sort();
check("no migration describes a table nothing reads", orphans.length === 0, orphans.join(", "));

// 33 is not a magic number, it is the count that was true when this was last
// touched. If it moves, the number here should move WITH a file, not instead of
// one. It went 32 → 33 when crash telemetry added client_errors.
check("the inventory is the 33 tables this app uses", wanted.length === 33, String(wanted.length));

// One file per table, named after it — a file that creates two tables hides one
// of them from anyone reading the directory listing.
for (const [table, f] of declared) {
  check(`${f} is named for boardroom.${table}`, f.includes(table), `${f} vs ${table}`);
}
for (const t of FOREIGN) {
  check(`${t} stays out of this schema — it belongs to another project`, !declared.has(t));
}

// ── 2. everything is boardroom-qualified ─────────────────────────────────────
// THE ONE WITH TEETH. Both halves matter: the creates must say boardroom, and no
// statement anywhere may say public.
for (const [f, s] of stripped) {
  const creates = [...s.matchAll(/create table[^(]*?\s([a-z_][a-z0-9_.]*)\s*\(/gi)].map((m) => m[1]);
  check(`${f} qualifies every create table with boardroom.`,
    creates.every((c) => c.startsWith("boardroom.")),
    creates.filter((c) => !c.startsWith("boardroom.")).join(", "));
  check(`${f} has no uncommented public.<table>`, !/\bpublic\.[a-z_]/i.test(s),
    (s.match(/\bpublic\.[a-z_]+/i) || [""])[0]);
  // An index or policy on the right table in the wrong schema is the same bug
  // one statement later.
  const targets = [...s.matchAll(/\bon\s+([a-z_][a-z0-9_]*\.[a-z0-9_]+)/gi)].map((m) => m[1]);
  check(`${f} points its indexes and policies at boardroom.`,
    targets.every((t) => t.startsWith("boardroom.")),
    targets.filter((t) => !t.startsWith("boardroom.")).join(", "));
}
// The schema in the migrations has to be the schema the client is pinned to —
// checked against supabase.js rather than against the string "boardroom", which
// is the same test dreams-smoke.mjs makes of the in-app setup cards.
const SCHEMA = readFileSync("src/lib/supabase.js", "utf8").match(/db:\s*\{\s*schema:\s*"(\w+)"/)?.[1];
check("the client is pinned to a schema at all", !!SCHEMA, String(SCHEMA));
check("the migrations use the schema the client reads", SCHEMA === "boardroom", String(SCHEMA));
check("0000 creates that schema before anything needs it",
  new RegExp(`create schema if not exists ${SCHEMA}`).test(sql.get("0000_schema.sql") || ""));
check("…and grants usage on it, because RLS filters but never grants",
  new RegExp(`grant usage on schema ${SCHEMA}`).test(sql.get("0000_schema.sql") || ""));

// ── 3. every file can be run twice ───────────────────────────────────────────
// These are pasted into the SQL editor by hand. A file that throws on the second
// run leaves a schema half-applied, and the only way to find out is to do it.
for (const [f, s] of stripped) {
  const bareCreateTable = /create table(?!\s+if not exists)/i.test(s);
  check(`${f} creates tables only with "if not exists"`, !bareCreateTable);
  const bareCreateIndex = /create\s+(?:unique\s+)?index(?!\s+if not exists)/i.test(s);
  check(`${f} creates indexes only with "if not exists"`, !bareCreateIndex);
  // A second CREATE POLICY under the same name errors; under a DIFFERENT name it
  // succeeds and quietly doubles the policy set, because permissive policies OR
  // together. supabase-usage-fix.sql paid for that one on usage_log. Either
  // guard is fine — drop-then-create, or a pg_policies existence test.
  if (/create policy/i.test(s)) {
    check(`${f} guards its policies against a second run`,
      /drop policy if exists/i.test(s) || /from pg_policies/i.test(s));
  }
  check(`${f} never drops a table`, !/drop table(?!\s+if exists)/i.test(s));
}

// ── 4. the backup covers the whole record ────────────────────────────────────
// export-data.js DUPLICATES this list on purpose. Under this repo's
// "type":"module" + esbuild bundling, a required helper's module.exports replaces
// the bundle's exports and wipes the exports.handler the function assigned — the
// function deploys clean and 502s on every call (see netlify/functions/audit.js,
// tmdb.js, workout-import.js; functions-smoke.mjs is what catches it). So the
// list is copied and this check is what stops the copies from drifting.
const exportSrc = readFileSync("netlify/functions/export-data.js", "utf8");
const exportList = [...(exportSrc.match(/const TABLES = \[([\s\S]*?)\];/)?.[1] || "")
  .matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
check("export-data.js declares a TABLES list", exportList.length > 0, String(exportList.length));
const notBacked = wanted.filter((t) => !exportList.includes(t));
check("the backup covers every table in the record", notBacked.length === 0, notBacked.join(", "));
const backedUpGhosts = exportList.filter((t) => !wanted.includes(t));
check("the backup names no table the app doesn't use", backedUpGhosts.length === 0, backedUpGhosts.join(", "));
check("export-data.js points at the migrations so the next reader finds them",
  /supabase\/migrations/.test(exportSrc));

// A table left out of the payload has to be left out LOUDLY, with a reason, in
// the response — a backup that quietly omits something is the failure this whole
// check exists to prevent, and "we skipped your bank tokens" is a sentence the
// caller is entitled to read.
const skipped = [...(exportSrc.match(/const SKIP = \{([\s\S]*?)\n\};/)?.[1] || "")
  .matchAll(/([a-z][a-z0-9_]*):\s*["'`]([^"'`]+)/g)].map((m) => [m[1], m[2]]);
for (const [t, why] of skipped) {
  check(`${t} is skipped from the export with a stated reason`, exportList.includes(t) && why.length > 20, why);
}
check("a skipped table is reported in the response, not silently dropped",
  /skipped/.test(exportSrc) && /SKIP\b/.test(exportSrc));

// ── 5. the failure the backup used to have ───────────────────────────────────
// It embedded { error } per table inside a 200. A backup that reports success
// while missing a table is worse than no backup: you find out when you need it.
check("a table that errors fails the whole export with a 500",
  /json\(500,/.test(exportSrc) && /failed\b/.test(exportSrc));
check("the secret is compared in constant time, length guarded first",
  /timingSafeEqual/.test(exportSrc) && /\.length === /.test(exportSrc));
check("guessing the secret is rate limited", /rateLimited|tooMany|RATE_/.test(exportSrc));
// The Status tab pings this function with { ping: true } and expects a 200. If
// the limiter sat in front of that, a healthy row would go red under load. The
// comparison is inside the handler on purpose — the helper's DECLARATION sits
// above everything, so comparing whole-file offsets would measure nothing.
{
  // lastIndexOf, not indexOf: the file's header comment mentions exports.handler
  // while explaining the bundling trap, and slicing from there would put the
  // helper declarations inside the "handler".
  const handler = exportSrc.slice(exportSrc.lastIndexOf("exports.handler = async"));
  const ping = handler.indexOf("body.ping"), limit = handler.indexOf("rateLimited(");
  check("the ping path stays ahead of the rate limiter", ping >= 0 && limit > ping, `ping@${ping} limit@${limit}`);
}

// ── 6. the in-app setup cards, which are NOT fixed by this directory ─────────
// Five constants still hand the user `public.` SQL for tables the app reads in
// `boardroom`. They live in files this change did not touch; the migrations here
// are correct and those cards are not. Pinned so the disagreement is a visible,
// failing fact rather than something to rediscover.
const CARDS = [
  ["src/WorkoutPanel.jsx", "WORKOUT_SETUP_SQL", ["workout_templates", "workout_sessions", "body_weight_log"]],
  ["src/features/upkeep/UpkeepPanel.jsx", "UPKEEP_SETUP_SQL", ["upkeep_items"]],
  ["src/LearnPanel.jsx", "SKILLS_SETUP_SQL", ["mini_skills"]],
  ["src/pages/personal/NotesPanel.jsx", "NOTES_UPGRADE_SQL", ["personal_notes"]],
];
const readme = readFileSync(`${MIG_DIR}/README.md`, "utf8");
const stale = [];
for (const [path, constant, tables] of CARDS) {
  const src = readFileSync(path, "utf8");
  const block = src.match(new RegExp(`${constant} = \`([\\s\\S]*?)\`;`))?.[1] || "";
  // Without this the whole section goes quietly vacuous: a renamed constant or a
  // moved panel makes `block` the empty string, every public.<table> test comes
  // back false, and the smoke reports that nothing is wrong because it stopped
  // looking. The one failure mode a check like this actually has.
  check(`${constant} is still where this check expects it`, block.length > 0, path);
  for (const t of tables) if (new RegExp(`public\\.${t}\\b`).test(block)) stale.push([constant, t]);
}
// THE CHECK RUNS FORWARD ONLY, AND THE ASYMMETRY IS DELIBERATE. Every card that
// currently ships `public.` SQL has to be named in README.md, so a NEW one — or a
// new table added to an existing one — fails here until somebody writes down that
// following those instructions builds a table this app cannot read.
//
// There is no matching check that a card still IS wrong. An excuse list would
// have to be edited by whoever eventually fixes those panels, and a smoke that
// fails because someone repaired an unrelated file trains people to delete
// smokes. The cost of leaving it one-directional is that the README can outlive
// the problem it describes, which is why its wording is dated rather than
// present-tense.
for (const [constant, t] of stale) {
  check(`${constant}'s public.${t} is written down in the migrations README`,
    readme.includes(constant) && readme.includes(t), `${constant}:${t}`);
}

// ── 7. the README does not overclaim ─────────────────────────────────────────
// These files were reconstructed from usage. Saying so is the difference between
// documentation and a lie about where the schema came from.
check("the README says these were backfilled from live usage", /backfilled from live usage/i.test(readme));
check("…and that they are a record, not necessarily the live DDL",
  /record, not/i.test(readme) && /not a dump of the live DDL|NOT the live DDL/i.test(readme));

console.log(failed ? `\n${failed} migrations check(s) failed` : "\nmigrations: all checks passed");
process.exit(failed ? 1 : 0);
