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

import esbuild from "esbuild";
import { readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

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

// 38 is not a magic number, it is the count that was true when this was last
// touched. If it moves, the number here should move WITH a file, not instead of
// one. It went 32 → 33 when crash telemetry added client_errors, 33 → 34 when
// the Alt Season tab grew a book of its own (alt_positions), 34 → 37 when the
// Guitar tab arrived with a practice log, a skill table and a repertoire, and
// 37 → 38 with personal_anniversaries — the days that already happened.
check("the inventory is the 38 tables this app uses", wanted.length === 38, String(wanted.length));

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

// ── 5. the export, RUN RATHER THAN READ ──────────────────────────────────────
// EVERY CHECK IN THIS SECTION USED TO BE A GREP OVER THE SOURCE, and every one of
// them survived having the behaviour it named deleted. That was demonstrated, not
// guessed:
//
//   · "a table that errors fails the whole export with a 500" tested
//     /json\(500,/ && /failed\b/. Delete the entire per-table aggregation, go back
//     to embedding { error } inside a 200, and it still passes: the generic catch
//     at the bottom contains json(500, and the word "failed" appears in the prose
//     above.
//   · "a skipped table is reported in the response" tested /skipped/ && /SKIP\b/,
//     both of which appear in comments — so deleting `skipped: SKIP` from the
//     payload, the one line that makes an omission visible, passed.
//   · "guessing the secret is rate limited" tested for the WORD rateLimited.
//     Reduce the call to `rateLimited(ip, now);` with the result thrown away and
//     delete noteFailure entirely, and it passes with no limiter at all.
//   · the ping-ordering check compared two string offsets inside the handler,
//     which says nothing about what either branch does.
//
// export-data.js is a plain handler over one dependency, so none of that needs to
// be inferred: it bundles against a createClient that answers from a fixture this
// file writes, and the assertions read real statuses out of real responses. What
// remains textual is called out where it sits, with the reason.
const EXPORT_DIR = ".export-smoke";
const requireCjs = createRequire(import.meta.url);
let exportHandler = null;
try {
  rmSync(EXPORT_DIR, { recursive: true, force: true });
  mkdirSync(EXPORT_DIR, { recursive: true });
  // .cjs ON PURPOSE. package.json says "type":"module", so a .js stub here would
  // be ESM and its `exports.createClient` would be the exact bundling trap the
  // header of scripts/functions-smoke.mjs is about — the alias would resolve, the
  // bundle would build, and createClient would be undefined at call time.
  writeFileSync(`${EXPORT_DIR}/supabase-stub.cjs`, `
// The one dependency export-data.js has, replaced by a fixture. Only the calls
// readTable() makes are implemented: .from(t).select("*", {count}).order(col)
// .range(from, to). A table with no entry in the plan comes back as an ERROR
// rather than as an empty read, so a table the export starts reading without the
// fixture knowing about it is loud instead of silently zero. The order columns
// asked for are recorded per table, so the smoke can assert paging is ordered.
exports.createClient = () => ({
  from: (table) => ({
    select: (_cols, opts) => {
      const q = {
        order: (col) => { ((globalThis.__EXPORT_SMOKE_ORDERED__ ||= {})[table] ||= []).push(col); return q; },
        range: async (from, to) => {
          const plan = (globalThis.__EXPORT_SMOKE_PLAN__ || {})[table];
          if (!plan) return { data: null, error: { message: "no fixture for " + table }, count: null };
          if (plan.error) return { data: null, error: { message: plan.error }, count: null };
          const rows = plan.rows || [];
          // A plan may claim a count LARGER than the rows it hands back: that is how
          // PostgREST reports a read the project's max-rows ceiling truncated, and
          // it is the case readTable's count check exists for.
          const count = opts && opts.count === "exact" ? (plan.count == null ? rows.length : plan.count) : null;
          return { data: rows.slice(from, to + 1), error: null, count };
        },
      };
      return q;
    },
  }),
});
`);
  esbuild.buildSync({
    entryPoints: ["netlify/functions/export-data.js"],
    bundle: true, platform: "node", format: "cjs",
    outfile: `${EXPORT_DIR}/export-data.cjs`,
    alias: { "@supabase/supabase-js": resolve(`${EXPORT_DIR}/supabase-stub.cjs`) },
    logLevel: "silent",
  });
  exportHandler = requireCjs(resolve(`${EXPORT_DIR}/export-data.cjs`)).handler;
} catch (e) {
  check("export-data.js bundles for execution", false, (e.message || String(e)).split("\n")[0]);
}
check("export-data.js exports a callable handler", typeof exportHandler === "function", typeof exportHandler);

// try/finally, so a scenario that throws still takes the bundle directory with it
// rather than leaving one in the repo root for the next reader to wonder about.
try {
 if (typeof exportHandler === "function") {
  const SECRET = "smoke-backup-secret-not-real";
  process.env.BACKUP_SECRET = SECRET;
  process.env.SUPABASE_URL = "https://smoke.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "smoke-service-role-key-not-real";

  const skippedNames = skipped.map(([t]) => t);
  const allRead = () => Object.fromEntries(exportList.map((t) => [t, { rows: [] }]));
  const plan = (spec) => { globalThis.__EXPORT_SMOKE_PLAN__ = spec; };
  // The event Netlify builds, with the one header the limiter is allowed to trust.
  // Each scenario below uses its own source address so the limiter's window from
  // one cannot decide the answer to another.
  // A THROW IS AN OUTCOME, NOT AN ACCIDENT. timingSafeEqual raises on buffers of
  // unequal length, so a gate written without the length guard does not answer at
  // all — and an uncaught throw here would end this file in a stack trace with
  // every check after it unrun. Caught and reported as what it is: the endpoint
  // did not answer.
  const call = async ({ secret = SECRET, ip = "203.0.113.1", ...rest }) => {
    let res;
    try {
      res = await exportHandler({
        httpMethod: "POST", headers: { "content-type": "application/json", "x-nf-client-connection-ip": ip },
        body: JSON.stringify({ ...(secret === null ? {} : { secret }), ...rest }), isBase64Encoded: false,
      });
    } catch (e) {
      const why = `threw instead of answering: ${e.message || String(e)}`;
      return { code: why, body: null, raw: why };
    }
    let body = null;
    try { body = JSON.parse(res.body); } catch {}
    return { code: res.statusCode, body, raw: String(res.body) };
  };

  // ── a good export ─────────────────────────────────────────────────────────
  plan({ ...allRead(), app_settings: { rows: [{ id: 1 }, { id: 2 }] } });
  const good = await call({ ip: "203.0.113.10" });
  check("a correct secret gets the export", good.code === 200 && good.body?.success === true, `${good.code} ${good.raw.slice(0, 120)}`);
  const returned = Object.keys(good.body?.tables || {});
  check("the export returns every table it declares and nothing else",
    returned.length === exportList.length - skippedNames.length && returned.every((t) => exportList.includes(t)),
    `${returned.length} tables for ${exportList.length} declared minus ${skippedNames.length} skipped`);
  check("the export counts the rows it actually returned", good.body?.rowCounts?.app_settings === 2, String(good.body?.rowCounts?.app_settings));
  // A table left out of the payload has to be left out LOUDLY, with a reason, IN
  // THE RESPONSE — a backup that quietly omits something is the failure this whole
  // check exists to prevent, and "we skipped your bank tokens" is a sentence the
  // caller is entitled to read. Asserted against the payload the caller receives,
  // because the word "skipped" appearing in the source proves nothing.
  for (const [t, why] of skipped) {
    check(`${t} is named as skipped in the response, with its reason`,
      String(good.body?.skipped?.[t] || "") === why && why.length > 20, JSON.stringify(good.body?.skipped?.[t]));
    check(`${t} is genuinely absent from the payload`, !(t in (good.body?.tables || {})));
  }

  // ── a table that errors ───────────────────────────────────────────────────
  // It embedded { error } per table inside a 200. A backup that reports success
  // while missing a table is worse than no backup: you find out when you need it.
  plan({ ...allRead(), seat_notes: { error: "permission denied for table seat_notes" } });
  const broke = await call({ ip: "203.0.113.11" });
  check("a table that errors fails the whole export with a 500", broke.code === 500, `${broke.code} ${broke.raw.slice(0, 160)}`);
  check("…and the response names the table that broke",
    /seat_notes/.test(String(broke.body?.error || "") + JSON.stringify(broke.body?.failed || {})), broke.raw.slice(0, 200));
  check("…and hands back no partial payload to write to disk as a backup",
    !("tables" in (broke.body || {})) && !("rowCounts" in (broke.body || {})) && broke.body?.success === false,
    Object.keys(broke.body || {}).join(", "));

  // A read that came back SHORT of its own count is the silent version of the
  // same failure: a 200 with fewer rows than exist, which is what an unpaged
  // select or a low max-rows ceiling produces.
  plan({ ...allRead(), usage_log: { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], count: 5 } });
  const short = await call({ ip: "203.0.113.12" });
  check("a table that comes back short of its own count fails the export too",
    short.code === 500 && /usage_log/.test(JSON.stringify(short.body?.failed || {})) && /3 of 5/.test(JSON.stringify(short.body?.failed || {})),
    `${short.code} ${short.raw.slice(0, 200)}`);

  // ── a database that no longer fits in one response ────────────────────────
  // Netlify drops a synchronous response over 6 MB: the caller gets a 502 with
  // nothing this function computed in it. That was every backup call for
  // months — usage_log alone is 14 MB — and this section ran against empty
  // tables and stayed green. So: rows that serialize past the cap, and the
  // handler has to say so itself, name the weight, and hand back no partial
  // payload to be written to disk as a backup.
  const wide = (n, id0 = 0) => Array.from({ length: n }, (_, i) => ({ id: id0 + i, blob: "x".repeat(1000) }));
  plan({ ...allRead(), usage_log: { rows: wide(6500) } });
  const big = await call({ ip: "203.0.113.13" });
  check("an export over the platform's 6 MB cap is refused with a 413, not returned",
    big.code === 413 && big.body?.success === false, `${big.code} ${big.raw.slice(0, 200)}`);
  check("…the refusal names the table that is the weight, and how to page it",
    Object.keys(big.body?.sizes || {})[0] === "usage_log" && /table by table/.test(String(big.body?.error)), big.raw.slice(0, 300));
  check("…and carries no partial payload", !("tables" in (big.body || {})) && !("rowCounts" in (big.body || {})));

  // The table list a looping caller starts from: exactly the export's own
  // tables, with the skipped ones named beside them.
  plan(allRead());
  const list = await call({ ip: "203.0.113.14", list: true });
  check("{ list: true } returns the tables the export covers",
    list.code === 200 && JSON.stringify(list.body?.tables) === JSON.stringify(exportList.filter((t) => !skippedNames.includes(t))),
    `${list.code} ${list.raw.slice(0, 200)}`);
  check("…and names the skipped ones with their reasons", skippedNames.every((t) => typeof list.body?.skipped?.[t] === "string"));

  // Per-table paging: every row exactly once, in order, across as many calls
  // as it takes, and `next` goes null only at the end. 2,500 rows is three
  // PostgREST pages inside one response (~2.5 MB, under the page budget); the
  // scenario after this one pushes past the budget.
  const ROWS = 2500;
  plan({ ...allRead(), usage_log: { rows: wide(ROWS) } });
  const seen = [];
  let offset = 0, pages = 0, total = null, bad = null;
  for (;;) {
    const page = await call({ ip: "203.0.113.15", table: "usage_log", offset });
    pages++;
    if (page.code !== 200 || !page.body?.success) { bad = `${page.code} ${page.raw.slice(0, 160)}`; break; }
    total = page.body.total;
    seen.push(...page.body.rows.map((r) => r.id));
    if (page.body.next == null) break;
    if (page.body.next <= offset || pages > 50) { bad = `no forward progress: next=${page.body.next} offset=${offset}`; break; }
    offset = page.body.next;
  }
  check("{ table, offset } pages a table to the end", bad === null && total === ROWS, bad || `total ${total}`);
  check("…every row exactly once, in order", seen.length === ROWS && seen.every((id, i) => id === i), `${seen.length} rows, first ${seen.slice(0, 3)}`);
  check("…ordered by the table's primary key, so pages from separate calls line up",
    JSON.stringify((globalThis.__EXPORT_SMOKE_ORDERED__ || {}).usage_log?.slice(0, 1)) === JSON.stringify(["id"]),
    JSON.stringify((globalThis.__EXPORT_SMOKE_ORDERED__ || {}).usage_log));
  // A table too wide for one page: the page stops under the budget, says where
  // to continue, and the two pages together are the whole table.
  plan({ ...allRead(), usage_log: { rows: wide(6000) } });
  const p1 = await call({ ip: "203.0.113.16", table: "usage_log", offset: 0 });
  check("a page stops under the page budget and points at the next offset",
    p1.code === 200 && p1.body?.next != null && p1.body.rows.length < 6000 && p1.body.rows.length === p1.body.next && p1.raw.length < 6_000_000,
    `${p1.code} rows=${p1.body?.rows?.length} next=${p1.body?.next} bytes=${p1.raw.length}`);
  const p2 = await call({ ip: "203.0.113.16", table: "usage_log", offset: p1.body?.next || 0 });
  check("…and the continuation finishes the table",
    p2.code === 200 && p2.body?.next === null && (p1.body?.rows?.length || 0) + (p2.body?.rows?.length || 0) === 6000,
    `${p2.code} rows=${p2.body?.rows?.length} next=${p2.body?.next}`);
  // The same short-read refusal applies per table: a page that ends short of
  // the count is not a page, it is the truncation this file exists to catch.
  plan({ ...allRead(), usage_log: { rows: [{ id: 1 }, { id: 2 }], count: 9 } });
  const shortPage = await call({ ip: "203.0.113.17", table: "usage_log", offset: 0 });
  check("a per-table read short of its count is refused too", shortPage.code === 500 && /2 of 9/.test(shortPage.raw), `${shortPage.code} ${shortPage.raw.slice(0, 160)}`);
  const unknown = await call({ ip: "203.0.113.18", table: "not_a_table" });
  check("a table outside the export is refused before it reaches the database", unknown.code === 400, `${unknown.code} ${unknown.raw.slice(0, 120)}`);
  const skippedOne = await call({ ip: "203.0.113.18", table: skippedNames[0] });
  check("a skipped table is refused WITH its reason", skippedOne.code === 400 && String(skippedOne.body?.error).includes(skipped[0][1]), `${skippedOne.code} ${skippedOne.raw.slice(0, 160)}`);

  // Every order column names a real column of its table's DDL: a typo here
  // would 400 from PostgREST on every page of that table, in production only.
  const orderMap = exportSrc.match(/const ORDER = \{([\s\S]*?)\n\};/)?.[1] || "";
  for (const m of orderMap.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    const table = m[1];
    const cols = [...m[2].matchAll(/"(\w+)"/g)].map((c) => c[1]);
    const ddlFile = declared.get(table);
    const ddl = ddlFile ? (stripped.get(ddlFile) || "").match(new RegExp(`create table if not exists boardroom\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`))?.[1] || "" : "";
    check(`export pages ${table} on columns its DDL declares`, !!ddlFile && cols.length > 0 && cols.every((c) => new RegExp(`^\\s*${c}\\s`, "m").test(ddl)), `${cols.join(",")} in ${ddlFile}`);
  }

  // ── the secret ────────────────────────────────────────────────────────────
  plan(allRead());
  const noSecret = await call({ secret: null, ip: "203.0.113.20" });
  check("an absent secret is refused", noSecret.code === 401, String(noSecret.code));
  const wrongShort = await call({ secret: "x", ip: "203.0.113.21" });
  // NOT JUST "IT REFUSES". timingSafeEqual THROWS on buffers of unequal length,
  // so a comparison written without the length guard in front of it does not
  // refuse a short secret — it crashes into a 500, and the length guard is the
  // half of "constant time, length guarded first" that IS observable from here.
  check("a wrong secret of a different length is refused, not crashed into a 500",
    wrongShort.code === 401, `${wrongShort.code} ${wrongShort.raw.slice(0, 120)}`);
  const sameLength = SECRET.replace(/[\s\S]/g, "z");
  check("the equal-length fixture is genuinely equal-length and genuinely wrong",
    sameLength.length === SECRET.length && sameLength !== SECRET, `${sameLength.length} vs ${SECRET.length}`);
  const wrongSame = await call({ secret: sameLength, ip: "203.0.113.22" });
  check("a wrong secret of exactly the right length is refused", wrongSame.code === 401, `${wrongSame.code} ${wrongSame.raw.slice(0, 120)}`);
  check("no refusal says which kind of wrong it was", noSecret.raw === wrongShort.raw && wrongShort.raw === wrongSame.raw,
    `${noSecret.raw} / ${wrongShort.raw} / ${wrongSame.raw}`);

  // THE ONE THAT STAYS TEXTUAL, AND WHY. Constant time is a property of how long
  // the comparison takes, and nothing this file can execute measures that
  // honestly — a wall-clock assertion on a millisecond of Buffer comparison would
  // be a flake generator, and the adversary's mutation (secretOk replaced by
  // `!==`) refuses every wrong secret above exactly as it should. So the grep is
  // aimed at the one thing that mutation DOES change: which comparison the gate
  // performs. lastIndexOf, not indexOf — the file's header comment mentions
  // exports.handler while explaining the bundling trap.
  const gate = exportSrc.slice(exportSrc.lastIndexOf("exports.handler = async"));
  check("the gate compares the secret through secretOk, not with an operator",
    /secretOk\(\s*body\.secret\s*,\s*process\.env\.BACKUP_SECRET\s*\)/.test(gate)
    && !/BACKUP_SECRET\s*(?:={2,3}|!={1,2})/.test(gate)
    && !/(?:={2,3}|!={1,2})\s*process\.env\.BACKUP_SECRET/.test(gate),
    gate.slice(gate.indexOf("BACKUP_SECRET") - 40, gate.indexOf("BACKUP_SECRET") + 60));
  check("…and secretOk is a length guard in front of timingSafeEqual",
    /function secretOk[\s\S]{0,400}?a\.length === b\.length && timingSafeEqual\(a, b\)/.test(exportSrc));

  // ── the rate limit ────────────────────────────────────────────────────────
  // Five wrong answers per ten minutes per source address. Executed, because the
  // word "rateLimited" appearing in the file was true of a version that called it
  // and discarded the answer.
  const guesser = "198.51.100.7";
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call({ secret: "wrong-guess", ip: guesser })).code);
  check("the first five wrong guesses from one source are each refused", codes.slice(0, 5).every((c) => c === 401), codes.join(","));
  check("the sixth wrong guess from the same source is rate limited", codes[5] === 429, codes.join(","));
  check("a different source address still gets its own attempts",
    (await call({ secret: "wrong-guess", ip: "198.51.100.8" })).code === 401);
  // The Status tab pings this function with { ping: true } and expects a 200. If
  // the limiter sat in front of that, a healthy row would go red under load — so
  // the ping is asked FROM THE SOURCE THAT IS CURRENTLY LIMITED, which is the only
  // arrangement that can tell the two orderings apart.
  const pingWhileLimited = await call({ secret: "wrong-guess", ping: true, ip: guesser });
  check("the health ping is answered even from a source the limiter has shut out",
    pingWhileLimited.code === 200 && pingWhileLimited.body?.success === true, `${pingWhileLimited.code} ${pingWhileLimited.raw.slice(0, 120)}`);
  check("…and the ping reveals only whether the variables are set",
    pingWhileLimited.body?.configured === true && !new RegExp(SECRET).test(pingWhileLimited.raw), pingWhileLimited.raw.slice(0, 200));

  delete globalThis.__EXPORT_SMOKE_PLAN__;
 }
} finally {
  rmSync(EXPORT_DIR, { recursive: true, force: true });
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
  // The Guitar card is here because src/data/guitar.js:112 says it is — it cites
  // this file by name as the thing that stops the public-vs-boardroom scar
  // recurring, and that was a false claim in a load-bearing comment: the string
  // "guitar" did not appear anywhere in this script. This card is CORRECT today
  // and pinned so it stays that way; the section below only fails on a `public.`
  // reference, which is exactly the mistake being guarded against.
  ["src/data/guitar.js", "GUITAR_SETUP_SQL", ["guitar_sessions", "guitar_skills", "guitar_songs"]],
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

// ── 6b. the Guitar card and the Guitar migrations describe the same schema ───
// The card is what a user actually runs, and the migrations are the record. They
// drifted once already (the card kept `id text primary key` after 0039 was
// re-keyed to the pair), and nothing would have caught it: the card is not
// applied by any tooling, so only a check like this can notice.
{
  const card = readFileSync("src/data/guitar.js", "utf8")
    .match(/GUITAR_SETUP_SQL = `([\s\S]*?)`;/)?.[1] || "";
  check("the Guitar setup card is still where this check expects it", card.length > 0);
  const mig = ["0037_guitar_sessions", "0038_guitar_skills", "0039_guitar_songs"]
    .map((f) => readFileSync(`${MIG_DIR}/${f}.sql`, "utf8")).join("\n");
  const norm = (t) => t.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();
  const c = norm(card), m = norm(mig);
  for (const t of ["guitar_sessions", "guitar_skills", "guitar_songs"]) {
    check(`the card creates boardroom.${t}`, c.includes(`create table if not exists boardroom.${t}`));
    check(`…and so does a migration`, m.includes(`create table if not exists boardroom.${t}`));
    check(`…with row level security on, in both`,
      c.includes(`alter table boardroom.${t} enable row level security`)
      && m.includes(`alter table boardroom.${t} enable row level security`));
    check(`…and an own-rows policy, in both`,
      c.includes(`create policy "own ${t}"`) && m.includes(`create policy "own ${t}"`));
  }
  // The keys, which is what actually drifted.
  check("guitar_skills is keyed by the user and the skill, in both",
    c.includes("primary key (user_id, skill_id)") && m.includes("primary key (user_id, skill_id)"));
  check("guitar_songs is keyed by the user and the id, in both",
    c.includes("primary key (user_id, id)") && m.includes("primary key (user_id, id)"));
  // …and the code's upsert has to name that key, or PostgREST rejects it.
  const dbjs = readFileSync("src/data/db.js", "utf8");
  check("saveGuitarSong's onConflict names the composite key",
    /guitar_songs"\)\.upsert\([^)]*onConflict: "user_id,id"/.test(dbjs.replace(/\s+/g, " ")));
  check("a custom schema grants nothing by default, so the card grants explicitly",
    ["guitar_sessions", "guitar_skills", "guitar_songs"].every((t) =>
      c.includes(`on boardroom.${t} to authenticated`)));
}

// ── 7. the README does not overclaim ─────────────────────────────────────────
// These files were reconstructed from usage. Saying so is the difference between
// documentation and a lie about where the schema came from.
check("the README says these were backfilled from live usage", /backfilled from live usage/i.test(readme));
check("…and that they are a record, not necessarily the live DDL",
  /record, not/i.test(readme) && /not a dump of the live DDL|NOT the live DDL/i.test(readme));

console.log(failed ? `\n${failed} migrations check(s) failed` : "\nmigrations: all checks passed");
process.exit(failed ? 1 : 0);
