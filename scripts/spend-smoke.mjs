// ─── Spend smoke — the money ledger, asserted ────────────────────────────────
//
// Every failure this catches is one the app cannot tell you about at runtime,
// because every spend writer is deliberately best-effort: telemetry.js swallows
// insert errors ("never break the caller"), mini-worker's write is .catch(()=>{}),
// and the two new ones are fire-and-forget by design. That is the right call —
// accounting must never fail a user's request — but it means a broken ledger
// shows up as a plausible-looking $0.000, not as an error. So the invariants
// get a test.
//
// Four classes of failure, all of which have already happened here:
//
//  1. A SPENDER THAT DOESN'T LOG. Three functions billed the Anthropic key and
//     wrote nothing: audit and auto-fix appeared as kind:"call" rows at $0, and
//     the Discord board worker left no row at all — that third one is gone from
//     the repo now, retired with the feature, but it is the reason this check
//     discovers its callers instead of trusting a list. Adding a spender is a
//     one-line fetch; forgetting the usage_log write beside it is just as easy,
//     and nothing downstream would complain.
//  2. PRICING DRIFT. The rate table is duplicated FOUR times and cannot be
//     shared: under this repo's "type":"module" + esbuild bundling, a required
//     helper's module.exports clobbers a function bundle's exports and it
//     deploys with no handler (see the note in audit.js). Enforcement is the
//     only safe substitute for extraction.
//  3. A STALE RATE. Sonnet 5's introductory pricing ends 2026-08-31. Before
//     this test, every copy billed list price and overstated Sonnet by 50%.
//     After the window closes the intro branch is dead weight — this says so.
//  4. A LEDGER WITH NO SCHEMA. usage_log and usage_summary had no DDL anywhere
//     in the repo, while the UI told you by name to run a file that didn't
//     exist. A rebuilt Supabase project would have silently stopped accounting.
//
// Run by `npm run verify`.

import { readFileSync, existsSync } from "node:fs";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const read = (p) => readFileSync(p, "utf8");
/** Strip comments so prose about a rule can't satisfy a test for it. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── 1. every Anthropic caller logs what it spent ─────────────────────────────
// Discovered, not hard-coded: a new file that calls the Messages API is held to
// the same bar the moment it lands, without anyone remembering to list it here.
const CALLERS = [
  "netlify/functions/claude.js",
  "netlify/functions/audit.js",
  "netlify/functions/auto-fix.js",
  "netlify/functions/mini-worker.js",
  "netlify/lib/upstream/llm.js",
  "netlify/functions/econ-resolve-background.js",
];
import { readdirSync } from "node:fs";
// A function that spends THROUGH THE ROUTER never names the API or the SDK, so
// the discovery below would not see it — and did not: econ-resolve-background
// billed Sonnet plus a web search per event for months, invisible to this file
// and to Systems → Usage alike. So a function that imports lib/upstream/llm.js
// is a spender too. Functions only: the engine files under netlify/lib/upstream
// also import the router, and they are accounted for through store.js below.
const importsRouter = (p) => /from ['"]\.\.\/lib\/upstream\/llm\.js['"]/.test(code(read(p)));
const discovered = [
  ...readdirSync("netlify/functions").map(f => `netlify/functions/${f}`),
  ...readdirSync("netlify/lib/upstream").map(f => `netlify/lib/upstream/${f}`),
].filter(p => p.endsWith(".js") && (/api\.anthropic\.com|@anthropic-ai\/sdk/.test(read(p)) || (p.startsWith("netlify/functions/") && importsRouter(p))));

check("the known Anthropic-caller list is complete",
  discovered.every(p => CALLERS.includes(p)),
  `unlisted: ${discovered.filter(p => !CALLERS.includes(p)).join(" ")}`);

for (const p of CALLERS) {
  // code(), not read(): every one of these files explains in a comment that it
  // used to skip usage_log, so a raw substring match passes on the prose alone.
  // Caught by mutation-testing this very check — gutting audit.js's write left
  // the test green.
  const src = code(read(p));
  // claude.js is the browser proxy: it returns the raw response (usage and all)
  // to callClaude, which does the logging. It is the one legitimate exception.
  if (p.endsWith("functions/claude.js")) {
    check("claude.js proxy returns usage to the client rather than logging",
      /return json\(res\.status, data\)/.test(src));
    continue;
  }
  // llm.js accumulates into the Upstream ledger; store.js writes the row.
  if (p.endsWith("upstream/llm.js")) {
    check("upstream ledger records cache tokens", /cache_read_input_tokens/.test(src) && /cache_creation_input_tokens/.test(src));
    check("upstream store writes the ledger to usage_log", /usage_log/.test(code(read("netlify/lib/upstream/store.js"))));
    continue;
  }
  // A router caller prices through the ledger, not estCost(): it has to make a
  // ledger, HAND IT to the call (searchCall's ledgerAdd is a no-op without one —
  // which is precisely how the spend went missing), and write the total out.
  if (importsRouter(p)) {
    const name = p.split("/").pop();
    check(`${name} keeps a ledger`, /makeLedger\(/.test(src));
    check(`${name} hands the ledger to the router call`, /\bledger\s*[,}]/.test(src));
    check(`${name} writes the ledger total to usage_log`, /ledgerTotal\(/.test(src) && /logUsage\(/.test(src));
    continue;
  }
  check(`${p.split("/").pop()} writes a usage_log row`, /usage_log/.test(src));
  check(`${p.split("/").pop()} prices the call`, /estCost\(/.test(src));
}

// THE SERVER SIDE HAS ONE NAME FOR THE KEY. Two callers used to fall back to
// VITE_ANTHROPIC_API_KEY, which made a VITE_-prefixed secret a working server
// configuration — and Vite exposes that prefix to the browser by design. The
// build-side canary in scripts/key-exposure-smoke.mjs catches the leak; this
// catches the habit that invites it.
{
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : (/\.(js|mjs)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const readers = walk("netlify").filter(p => /VITE_ANTHROPIC_API_KEY/.test(code(read(p))));
  check("no server-side file reads VITE_ANTHROPIC_API_KEY", readers.length === 0, readers.join(" "));
}

// The client path: one wrapper, one place to check.
const clientSrc = read("src/lib/claude.js");
const clientCode = code(clientSrc);
check("callClaude logs tokens and cost", /logUsage\(\{[^}]*in_tokens[^}]*cost_usd/.test(clientCode.replace(/\n/g, " ")));
check("callClaude counts cache tokens as input", /cache_creation_input_tokens/.test(clientCode) && /cache_read_input_tokens/.test(clientCode));

// ── 2. the four rate tables agree ────────────────────────────────────────────
// Two shapes: keyed by layer name (haiku/sonnet/opus) and keyed by model id.
const LAYER_TABLES = [
  "src/lib/claude.js",
  "netlify/functions/mini-worker.js",
  "netlify/functions/audit.js",
  "netlify/functions/auto-fix.js",
];
/** Pull `haiku: { in: 1, out: 5, ... }` rows out of a PRICING literal. */
function layerRates(src) {
  const block = code(src).match(/const PRICING\s*=\s*\{([\s\S]*?)\n\};/);
  if (!block) return null;
  const out = {};
  for (const m of block[1].matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
    const f = {};
    for (const kv of m[2].matchAll(/(\w+):\s*([\d.]+|SONNET_INTRO_ENDS)/g)) f[kv[1]] = kv[2];
    out[m[1]] = f;
  }
  return out;
}
const baseline = layerRates(read(LAYER_TABLES[0]));
check("src/lib/claude.js declares a PRICING table", !!baseline);
for (const p of LAYER_TABLES.slice(1)) {
  const t = layerRates(read(p));
  check(`${p.split("/").pop()} PRICING matches src/lib/claude.js`,
    !!t && JSON.stringify(t) === JSON.stringify(baseline),
    t ? `\n  got      ${JSON.stringify(t)}\n  expected ${JSON.stringify(baseline)}` : "(no PRICING table found)");
}

// The model-id-keyed copy has to agree on the models it shares with the others.
const upstreamSrc = read("netlify/lib/upstream/llm.js");
const idTable = {};
const idBlock = code(upstreamSrc).match(/const PRICE_TABLE\s*=\s*\{([\s\S]*?)\n\};/);
if (idBlock) {
  for (const m of idBlock[1].matchAll(/'([\w.-]+)':\s*\{([^}]*)\}/g)) {
    const f = {};
    for (const kv of m[2].matchAll(/(\w+):\s*([\d.]+|SONNET_INTRO_ENDS)/g)) f[kv[1]] = kv[2];
    idTable[m[1]] = f;
  }
}
check("upstream declares a PRICE_TABLE", Object.keys(idTable).length > 0);
// MODEL_IDS maps layer -> id; the shared models must price identically.
const modelIds = {};
for (const m of code(clientSrc).matchAll(/(\w+):\s*"(claude-[\w.-]+)"/g)) modelIds[m[1]] = m[2];
for (const [layer, id] of Object.entries(modelIds)) {
  if (!idTable[id] || !baseline?.[layer]) continue;
  check(`upstream prices ${id} the same as layer "${layer}"`,
    JSON.stringify(idTable[id]) === JSON.stringify(baseline[layer]),
    `\n  upstream ${JSON.stringify(idTable[id])}\n  layer    ${JSON.stringify(baseline[layer])}`);
}

// ── 3. rates are current ─────────────────────────────────────────────────────
// Checked against Anthropic's published per-MTok rates. A model move that
// forgets the price is otherwise invisible — the estimate just goes quietly
// wrong, in whichever direction the new model happens to differ.
const LIST = { haiku: [1, 5], sonnet: [2, 10], opus: [5, 25] };
for (const [layer, [i, o]] of Object.entries(LIST)) {
  const r = baseline?.[layer];
  check(`${layer} list price is $${i}/$${o} per MTok`,
    r && Number(r.in) === i && Number(r.out) === o,
    r ? `got $${r.in}/$${r.out}` : "(missing)");
}
check("fable-5 is priced at $10/$50", idTable["claude-fable-5"] && Number(idTable["claude-fable-5"].in) === 10 && Number(idTable["claude-fable-5"].out) === 50);
check("web search is priced at $10/1k ($0.01 each)", /SEARCH_COST\s*=\s*0\.01/.test(upstreamSrc));

// SONNET'S "INTRODUCTORY" WINDOW IS OVER AND THE PRICE DID NOT MOVE.
//
// This block used to be a clock. Sonnet 5 launched at $2/$10 billed as
// introductory pricing through 2026-08-31, with $3/$15 scheduled for September
// 1 — so all five copies carried introIn/introOut/introUntil and resolved the
// rate at call time, and this check flipped itself over on the 1st to say "the
// dead branch can come out now".
//
// It flipped, and the instruction it printed was WRONG. Anthropic cancelled the
// increase: the pricing page now lists Sonnet 5 at $2/$10 with a note that the
// launch rate "is now the standard price" and that the September 1 increase
// "will not occur". Following the smoke would have doubled every Sonnet row in
// the ledger — Upstream routes every web-search stage and judge to Sonnet, so
// that is the app's most expensive surface, mis-billed by 50%.
//
// What replaced it is not a clock. $2/$10 is the list rate, asserted in LIST
// above like every other model, and the three assertions below only make sure
// the time-travelling machinery cannot come back with a date attached to it.
const s = baseline?.sonnet;
check("sonnet's price is a plain rate, not a window",
  s && !s.introIn && !s.introOut && !s.introUntil,
  s ? JSON.stringify(s) : "(missing)");
for (const p of LAYER_TABLES.concat("netlify/lib/upstream/llm.js")) {
  const src = code(read(p));
  check(`${p.split("/").pop()} bills one rate rather than resolving one by date`,
    !/introUntil/.test(src) && !/SONNET_INTRO_ENDS/.test(src));
}
check("the model picker's label and multiple track the price",
  /label: "Sonnet", price: "\$2\/\$10", mult: 2/.test(code(read("src/lib/claude.js"))));

// ── 4. the ledger has a schema, and it is the one the app talks to ───────────
const SQL_PATH = "supabase-usage-fix.sql";
check("supabase-usage-fix.sql exists (the UI names this file by path)", existsSync(SQL_PATH));
if (existsSync(SQL_PATH)) {
  const sql = read(SQL_PATH);
  check("it creates usage_log", /create table if not exists boardroom\.usage_log/i.test(sql));
  // Both halves, in order. `create or replace` alone was the original bug: it
  // cannot change a function's return type, so against a database holding an
  // older usage_summary the whole script aborted with 42P13. Asserting the drop
  // is what stops that regressing — and asserting it comes FIRST is what stops
  // someone "fixing" it by appending a drop after the create.
  const dropAt = sql.search(/drop function if exists boardroom\.usage_summary\(timestamptz\)/i);
  const createAt = sql.search(/create function boardroom\.usage_summary/i);
  check("it drops the old usage_summary before creating it", dropAt >= 0 && createAt > dropAt);
  check("it does not use create-or-replace on usage_summary (42P13)",
    !/create or replace function boardroom\.usage_summary/i.test(sql));
  // The client pins db.schema and the functions send Content-Profile: boardroom.
  // public-schema DDL would apply cleanly and still leave the app talking to a
  // table that isn't there.
  check("it targets the boardroom schema, not public", !/create table if not exists public\.usage_log/i.test(sql) && /create schema if not exists boardroom/i.test(sql));
  check("RLS is on", /alter table boardroom\.usage_log enable row level security/i.test(sql));
  // The policy guards must test the COMMAND, not the policy NAME. Production's
  // policies were hand-made and called "own rows select" / "own rows insert", so
  // a name-based `if not exists` matched nothing and added a duplicate policy on
  // every run. Permissive policies OR together, so this never threw — it just
  // silently grew the policy set, which is exactly the kind of drift nobody
  // notices until an audit.
  check("policy guards key off cmd, not policyname",
    /and cmd = 'SELECT'/i.test(sql) && !/and policyname = 'usage_log_/i.test(sql));
  // The retention sweep on Systems → Database runs as the user. Without a DELETE
  // policy RLS filters every row out and it deletes nothing, silently.
  check("a DELETE policy exists (the 30d sweep is a no-op without it)",
    /create policy \w+ on boardroom\.usage_log\s+for delete/i.test(sql));
  check("the aggregate is granted to authenticated", /grant execute on function boardroom\.usage_summary/i.test(sql));
  // Every column the readers and writers name must exist in the DDL.
  const cols = ["user_id", "fn", "kind", "model", "in_tokens", "out_tokens", "cost_usd", "ms", "ok", "detail", "created_at"];
  const ddl = sql.match(/create table if not exists boardroom\.usage_log\s*\(([\s\S]*?)\n\);/i)?.[1] || "";
  for (const c of cols) check(`usage_log defines ${c}`, new RegExp(`\\b${c}\\b`).test(ddl));
  const selected = read("src/pages/systems/SystemsPage.jsx").match(/\.select\("([^"]*created_at[^"]*)"\)/)?.[1] || "";
  for (const c of selected.split(",").map(x => x.trim()).filter(Boolean)) {
    check(`usage_log has the column Systems selects: ${c}`, new RegExp(`\\b${c}\\b`).test(ddl));
  }
  check("the RPC name matches what SystemsPage calls",
    /rpc\("usage_summary"/.test(read("src/pages/systems/SystemsPage.jsx")));
}

// ── 5. model ids are spelled one way ─────────────────────────────────────────
// Dated snapshots and aliases resolve to the same model, so drift is invisible
// until a model move leaves half the spellings behind.
const idSpellings = new Map();
for (const p of [...discovered, "src/lib/claude.js"]) {
  for (const m of code(read(p)).matchAll(/"(claude-[\w.-]+)"|'(claude-[\w.-]+)'/g)) {
    const id = m[1] || m[2];
    if (!idSpellings.has(id)) idSpellings.set(id, []);
    idSpellings.get(id).push(p.split("/").pop());
  }
}
const dated = [...idSpellings.keys()].filter(id => /-\d{8}$/.test(id));
check("no dated model snapshots (use the alias so a model move is one edit)",
  dated.length === 0, dated.map(d => `${d} in ${idSpellings.get(d).join(",")}`).join(" | "));
// The proxy allowlist gates what the browser may request — a client id missing
// from it comes back as "unsupported model", which looks nothing like the cause.
const allowed = read("netlify/functions/claude.js").match(/ALLOWED_MODELS = new Set\(\[([^\]]*)\]/)?.[1] || "";
for (const [layer, id] of Object.entries(modelIds)) {
  check(`proxy allowlist carries ${layer} (${id})`, allowed.includes(id));
}

// ── 6. no phantom files ──────────────────────────────────────────────────────
// This repo has shipped the same bug twice: Systems → Usage told you by name to
// run a SQL file that was never written, and mini-worker.js claimed its merge
// logic was asserted by a smoke script that does not exist. A named file
// reads as a promise that something is covered, so the cheapest guard is to
// make the promise checkable. Only paths that look like repo files count —
// prose that merely mentions a directory doesn't.
const PROMISE_RE = /\b((?:scripts|supabase|netlify|src)[\w./-]*\.(?:mjs|sql)|[\w-]+\.sql)\b/g;
const SEARCHED = [
  ...readdirSync("scripts").map(f => `scripts/${f}`),
  ...readdirSync("netlify/functions").map(f => `netlify/functions/${f}`),
  ...readdirSync("src/lib").map(f => `src/lib/${f}`),
  "src/pages/systems/SystemsPage.jsx",
].filter(p => /\.(js|jsx|mjs)$/.test(p));

// A bare `0014_dream_items.sql` is still a promise, but it is not a path — and
// since the schema record landed there are 34 of them, all living in
// supabase/migrations/. Resolve an unqualified .sql name against the places this
// repo actually keeps SQL (the root, for supabase-usage-fix.sql, and the
// migrations directory) before calling it a phantom. Qualified paths are
// unaffected: they still have to exist exactly where they say they do.
const SQL_DIRS = ["", "supabase/migrations/"];
const resolves = (named) =>
  named.includes("/") ? existsSync(named) : SQL_DIRS.some(d => existsSync(`${d}${named}`));

const phantoms = new Map();
for (const p of SEARCHED) {
  for (const m of read(p).matchAll(PROMISE_RE)) {
    const named = m[1];
    if (resolves(named)) continue;
    if (!phantoms.has(named)) phantoms.set(named, new Set());
    phantoms.get(named).add(p.split("/").pop());
  }
}
check("every .sql / .mjs file named in a comment actually exists",
  phantoms.size === 0,
  [...phantoms].map(([f, where]) => `${f} (named in ${[...where].join(", ")})`).join(" | "));

console.log(failed ? `\n${failed} spend check(s) failed` : "\nspend: all checks passed");
process.exit(failed ? 1 : 0);
