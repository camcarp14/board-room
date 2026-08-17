// ─── Function smoke: does every Netlify function still export a handler? ──────
// This repo has a specific, silent, production-only failure mode that has now
// caused an outage three times:
//
//   package.json declares "type":"module", so a .js file under netlify/functions
//   is ESM by Node's rules. esbuild (which is what Netlify bundles with) then
//   treats `module`/`exports` inside a REQUIRED helper as the bundle's own CJS
//   wrapper — so `module.exports = { foo }` in that helper REPLACES the bundle's
//   exports, wiping the `exports.handler` the function assigned. The function
//   deploys successfully, reports no error, and 502s on every call.
//
// Nothing else catches this: the file lints, `vite build` never touches
// functions, and esbuild only emits a WARNING (commonjs-variable-in-esm) that is
// easy to wave off because the entry files trip it harmlessly too. tmdb.js and
// workout-import.js both carry comments about it. It still happened again.
//
// So: bundle every function the way Netlify does, load the output, and assert a
// callable handler survived. ~2s, and it fails loudly.
//
// If this fails, the fix is NOT a cleverer helper — inline what you need into the
// function. Self-contained is the house pattern here, deliberately.
//
// ─── the file's second job: who is allowed to call these ─────────────────────
// Once every handler is bundled and loaded, the bundles are still sitting there
// — so the same pass CALLS each gated one and insists it refuses. That replaced a
// substring test (does "BOARD_USER_ID" appear in the file) which was worse than
// nothing: see the inventory comment below for how it let a wide-open endpoint
// pass for its entire life. Every file in the directory now has to be named as
// owner-gated, shared-secret or deliberately-public, and an unnamed one fails the
// build.
//
// IT KNOCKS THREE TIMES, AND THE SECOND AND THIRD ARE THE ONES THAT WERE MISSING.
// For most of this file's life the only knock was with NO credential at all, and
// that is the weakest possible question to ask a door. A gate that degrades from
// "the correct secret" to "any secret" — `if (!process.env.BACKUP_SECRET ||
// !body.secret)` instead of a comparison, or `if (!req.headers.get(SECRET_HEADER))`
// instead of secretOk() — still refuses an anonymous caller, so the old single
// knock printed "ok: 401 to an anonymous caller" while `{"secret":"x"}` returned
// all 32 tables and any POST with `x-internal-worker-secret: x` read every seat
// note through the service-role key. Both mutations were applied by hand and the
// whole suite stayed green. So:
//
//   1. absent      — no Authorization header, no secret header, no token.
//   2. wrong       — every credential slot filled with a WRONG value, and the
//                    identity check answers "that token is not a session".
//   3. not yours   — the shared secrets replaced by wrong values OF EXACTLY THE
//                    RIGHT LENGTH (a length compare is not a compare), and the
//                    identity check answers with a VALID session belonging to
//                    somebody else. An owner gate that degrades to "any signed-in
//                    account" is invisible to knocks 1 and 2 and is the whole
//                    reason BOARD_USER_ID exists.
//
// The invocation is safe by construction, not by care: global fetch is replaced
// with a stub that throws and counts. Knock 1 asserts NOTHING was reached at all;
// knocks 2 and 3 assert nothing but the caller-identity check was reached, since
// an owner gate cannot refuse a wrong bearer token without asking Supabase whose
// token it is. A gated function that reaches any other upstream before deciding
// whether the caller is allowed has already done work for a stranger, and this
// suite must never be the thing that spends money on a build.

import esbuild from "esbuild";
import { mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, basename } from "node:path";

const FN_DIR = "netlify/functions";
const OUT_DIR = ".fn-smoke";
const require_ = createRequire(import.meta.url);

// Nothing under netlify/functions/ carries a third-party import that has to stay
// out of the bundle any more. tweetnacl lived here for discord-board's Ed25519
// check and left with it. Kept as an empty list rather than deleted: the next
// function that needs a native or otherwise unbundleable dependency wants this
// hook, and the shape of it is the documentation for how.
const EXTERNALS = [];

// ─── the front-door inventory ────────────────────────────────────────────────
// This used to be one list and one test: does the string "BOARD_USER_ID" appear
// anywhere in the file. That test was worth nothing, and it is worth writing down
// exactly why, because the same shortcut is available every time this file is
// edited.
//
//   · It could not tell a gate from a mention. The function that proved it is no
//     longer in this directory — board-work-background.js, the Discord board
//     worker, deleted when that feature was retired — but the shape is worth
//     keeping because the shortcut is available again every time this file is
//     edited. It carried the string BOARD_USER_ID inside its Supabase config,
//     where that id was the user_id it WROTE ROWS AS rather than a caller it
//     checked, and on the strength of that substring it counted as gated while
//     spending its entire life accepting anonymous POSTs that read every seat
//     note and the last eight chat messages through the service-role key, spent
//     Anthropic budget synthesising an answer out of them, and PATCHed the answer
//     to whatever Discord webhook the caller named.
//   · It only looked at files that were already on the list, so a new function
//     was un-checked by default. The default has to be the other way round.
//   · It said nothing about the two other kinds of door this app actually has: a
//     shared secret (no Supabase session exists inside a Shortcut, a TRMNL
//     device, or a Discord interaction) and deliberately open (a price proxy with
//     no credential worth stealing).
//
// So every .js file in netlify/functions now has to appear in exactly one of the
// three maps below, with a reason written next to it, and the smoke fails on any
// file that appears in none. That failure is the feature: adding a function
// forces the decision, in the diff, where a reviewer can see it. And the two
// gated maps are not read for their strings — the handler is bundled and CALLED
// with no credential, and it has to refuse.

// Owner-only. These read connected business data, spend API budget, or write
// through privileged credentials; a valid session for a second account must
// never be sufficient. netlify/functions/deploy.js is the canonical shape —
// refuse before the first fetch, 401 with no session, 403 for the wrong user.
const OWNER_GATED = {
  audit: "runs Claude over a live site and writes auditor_findings",
  "auto-fix": "opens commits against the repo with GITHUB_TOKEN",
  "calendar-events": "fetches an arbitrary URL the caller names",
  claude: "the model proxy — the whole Anthropic bill runs through it",
  "clarify-pipeline": "reads the Clarify agency pipeline",
  "db-admin": "prunes and purges tables through the service-role key",
  deploy: "triggers and rolls back Netlify builds with NETLIFY_API_TOKEN",
  "econ-resolve-background": "spends a web-searching model call per event",
  "fetch-page": "fetches an arbitrary URL the caller names",
  gsc: "reads Search Console for the owner's properties",
  "mini-worker": "runs queued model tasks against the owner's key",
  "note-capture": "writes into personal_notes on the owner's behalf",
  plaid: "holds PLAID_SECRET and the bank access tokens it buys",
  shopify: "reads the ZTS store's orders and customers",
  "site-status": "fetches an arbitrary URL the caller names",
  "upstream-run-background": "runs the UPSTREAM engines — minutes of model time",
  "workout-import": "writes workouts from the watch seam",
  "zts-pipeline": "reads the ZTS pipeline",
};

// A shared secret, because the caller cannot hold a Supabase session: a watchOS
// Shortcut, a TRMNL device, a Discord interaction, a scheduled backup. The secret
// IS the identity, so an absent one has to refuse AND a wrong one has to refuse —
// including a wrong one of exactly the right length, which is what tells a real
// comparison apart from a presence test or a length test.
const SHARED_SECRET = {
  "export-data": "BACKUP_SECRET — one correct guess returns the entire database",
  trmnl: "TRMNL_TOKEN — the device fetches the URL server-side, so a URL token is the model",
};

// Open on purpose. Each of these is a read-only proxy or a scheduled worker whose
// payload is public information, and each entry has to say why being open is
// acceptable — that sentence is the decision, and it is what a reviewer argues
// with. Note what is NOT here: nothing that reaches a model. That is asserted
// below rather than trusted, because an open faucet on the model budget is the
// concrete cost of getting this list wrong.
const DELIBERATELY_PUBLIC = {
  "alt-candles": "CoinGecko OHLC for one coin id — public market data, cached",
  "alt-cron-background": "the hourly crypto screener; writes only its own board, takes no caller input",
  "alt-scan": "serves the stored board plus live prices — the same numbers coinmarketcap shows",
  btc: "the CoinGecko price proxy that exists because a phone's IP gets rate-limited",
  "btc-candles": "public BTC candles",
  calendar: "the Forex-factory econ calendar, identical for everyone",
  health: "a config-presence probe — reports whether env vars are SET, never their values",
  markets: "Yahoo quotes for four public tickers",
  "stock-cron-background": "the hourly equity tick; presents INTERNAL_WORKER_SECRET when set but must still run for the scheduler, which cannot hold one",
  "stock-scan": "serves the stored board — public prices and the screener's own arithmetic",
  "stock-settle-background": "the after-close settle; same scheduler constraint as stock-cron-background",
  "ticker-candles": "public candles for one symbol",
  tmdb: "TMDB title search — TMDB_API_KEY is a read-only catalogue key",
  wire: "the news wire, identical for everyone",
};

// A privileged fake for every variable a function reads, so the gate under test
// is the AUTHORIZATION check and not the "not configured yet" branch in front of
// it. What has never been tested is the far more dangerous state, which is a
// fully configured deployment answering a caller who presented nothing. The
// values are shaped like the real thing and are all unusable.
const FAKE_ENV = {
  SUPABASE_URL: "https://smoke.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "smoke-service-role-key-not-real",
  BOARD_USER_ID: "00000000-0000-4000-8000-000000000000",
  ANTHROPIC_API_KEY: "sk-ant-smoke-not-real",
  VITE_ANTHROPIC_API_KEY: "sk-ant-smoke-not-real",
  INTERNAL_WORKER_SECRET: "smoke-internal-worker-secret",
  BACKUP_SECRET: "smoke-backup-secret",
  TRMNL_TOKEN: "smoke-trmnl-token",
  TRMNL_USER_ID: "00000000-0000-4000-8000-000000000000",
  MINER_USER_ID: "00000000-0000-4000-8000-000000000000",
  NETLIFY_API_TOKEN: "smoke-netlify-token",
  GITHUB_TOKEN: "smoke-github-token",
  GSC_CLIENT_EMAIL: "smoke@example.invalid",
  GSC_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nsmoke\n-----END PRIVATE KEY-----\n",
  GSC_SITE_URL: "https://example.invalid",
  PLAID_CLIENT_ID: "smoke-plaid-client",
  PLAID_SECRET: "smoke-plaid-secret",
  PLAID_ENV: "sandbox",
  SHOPIFY_CLIENT_ID: "smoke-shopify-client",
  SHOPIFY_CLIENT_SECRET: "smoke-shopify-secret",
  SHOPIFY_SHOP: "smoke.myshopify.com",
  TMDB_API_KEY: "smoke-tmdb-key",
  CLARIFY_SUPABASE_URL: "https://clarify.smoke.invalid",
  CLARIFY_SUPABASE_ANON_KEY: "smoke-clarify-anon",
  // 32 bytes of hex, so a signature check that gets as far as nacl has something
  // well-formed to reject rather than throwing on a malformed key.
  DISCORD_PUBLIC_KEY: "00".repeat(32),
  URL: "https://smoke.invalid",
  DEPLOY_URL: "https://smoke.invalid",
  DEPLOY_PRIME_URL: "https://smoke.invalid",
};
// Set before anything is bundled or required: econ-resolve-background.js reads
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BOARD_USER_ID into module-level
// consts at import time, so a value assigned after the require never reaches it.
for (const [k, v] of Object.entries(FAKE_ENV)) process.env[k] = v;

// ─── the network, nailed shut ────────────────────────────────────────────────
// A suite that invokes twenty-two handlers is one missing `return` away from
// being a suite that spends money, and it would spend it silently on somebody
// else's machine. So fetch throws, and it COUNTS, because a handler with a catch
// around its own call would otherwise swallow the evidence. The count being zero
// after every auth-failure invocation is itself an assertion below: a function
// that reaches an upstream before deciding whether the caller is allowed has
// already done work for a stranger.
//
// ONE DOOR OPENS, AS NARROWLY AS IT CAN BE WRITTEN. Knocks 2 and 3 present a
// wrong credential, and an owner gate cannot refuse a wrong bearer token without
// asking Supabase whose token it is — that call IS the gate working, so refusing
// to answer it would only test the catch block around it (plaid.js and shopify.js
// turn a thrown verify into a 503, which would have made every one of those knocks
// pass for the wrong reason). So when `identity` is set, and only then, exactly two
// URL shapes answer: the auth endpoint that resolves a bearer token to a user, and
// the app_settings row that resolves a Shortcut capture/import token to one.
// Everything else still throws, and every knock asserts that nothing but those two
// was reached.
// Calls are recorded as { url, presented } rather than as strings: `presented` is
// the bearer token the function put on the call, and a gate that verifies the
// SERVICE key instead of the caller's token would otherwise look identical here.
const fetchCalls = [];
let identity = null;
const AUTH_URL = `${FAKE_ENV.SUPABASE_URL}/auth/v1/user`;
const TOKEN_LOOKUP = `${FAKE_ENV.SUPABASE_URL}/rest/v1/app_settings?setting_key=eq.`;
// Deliberately not "anything under SUPABASE_URL": seat_notes and chat_messages
// live under the same host, and reading one of those on the way to a 401 is
// exactly the disclosure board-work-background's comment is about.
const isIdentityCall = (u) => u.startsWith(AUTH_URL) || u.startsWith(TOKEN_LOOKUP);
globalThis.fetch = (...args) => {
  const url = String(args[0]);
  const h = args[1]?.headers || {};
  fetchCalls.push({ url, presented: String(h.Authorization || h.authorization || "").replace(/^Bearer\s+/i, "") });
  if (identity && isIdentityCall(url)) {
    // A real Response, because every one of these gates reads .ok / .status and
    // awaits .json(): a hand-rolled shape would be testing the stub.
    const answer = (status, body) => Promise.resolve(new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    }));
    if (url.startsWith(AUTH_URL)) return answer(identity.status, identity.user ? { id: identity.user } : {});
    // The token → user lookup answers 200 WITH NO ROW for a token nobody owns,
    // because that is what PostgREST does. Answering 401 here would exercise
    // note-capture's "settings lookup failed" branch — a 502 — instead of its gate.
    return answer(200, identity.user ? [{ user_id: identity.user }] : []);
  }
  throw new Error("functions-smoke: fetch is closed — nothing here may reach an upstream");
};

// ─── extra assertions on pure helpers a function exports for testing ─────────
// Netlify only reads `handler`, so a function may export a pure helper purely so
// it can be asserted here. Keep these to logic that would otherwise be
// untestable — anything richer belongs in src/ with its own smoke.
const EXTRA = {
  // The econ feed has no `actual` field, so the only thing calendar.js can say
  // about a released event is what KIND of event it was. Get that wrong and the
  // Brief shows "awaiting a number" for a press conference — forever, because no
  // number is coming. These are the rows that were actually on the card.
  calendar: (mod) => {
    const { isNumericRow, windowRows, toEvent } = mod;
    if (typeof isNumericRow !== "function" || typeof windowRows !== "function" || typeof toEvent !== "function") {
      return [["calendar exports isNumericRow + windowRows + toEvent", false, "not exported"]];
    }
    const NOW = Date.parse("2026-07-29T23:37:00-05:00");
    const hrs = (n) => new Date(NOW + n * 3600000).toISOString();
    const row = (title, extra = {}) => ({ title, country: "USD", impact: "High", date: hrs(-1), forecast: null, previous: null, ...extra });
    const ids = (rows) => windowRows(rows, NOW).map((x) => x.r.title).join(",");
    return [
      ["a figure is expected when the feed quotes one", isNumericRow(row("Federal Funds Rate", { forecast: "3.75%", previous: "3.75%" }))],
      ["no forecast and no prior ⇒ no figure is coming", !isNumericRow(row("FOMC Statement"))],
      ["a press conference never carries a figure", !isNumericRow(row("FOMC Press Conference"))],
      ["meeting minutes never carry a figure", !isNumericRow(row("FOMC Meeting Minutes", { previous: "0.2%" }))],
      ["a speech never carries a figure", !isNumericRow(row("FOMC Member Waller Speaks"))],
      ["a bond auction never carries a figure", !isNumericRow(row("10-y Bond Auction", { previous: "4.21|2.5" }))],
      ["an ordinary release still expects a figure", isNumericRow(row("Core CPI m/m", { forecast: "0.3%", previous: "0.2%" }))],
      ["non-USD rows are dropped", ids([row("Keep", { forecast: "1" }), { ...row("Drop"), country: "EUR" }]) === "Keep"],
      ["low-impact rows are dropped", ids([row("Keep"), { ...row("Drop"), impact: "Low" }]) === "Keep"],
      ["rows before the look-back are dropped", ids([row("Keep"), { ...row("Drop"), date: hrs(-19) }]) === "Keep"],
      ["rows past +7 days are dropped", ids([row("Keep"), { ...row("Drop"), date: hrs(24 * 8) }]) === "Keep"],
      ["an 18h-old release is still on the card", ids([{ ...row("Keep"), date: hrs(-17) }]) === "Keep"],
      ["an unparseable date is dropped, not NaN-sorted", ids([row("Keep"), { ...row("Drop"), date: "not a date" }]) === "Keep"],
      // The reason past rows get their own cap: an ascending sort under one
      // shared cap let a busy morning push the whole rest of the week off.
      ["a flood of past rows can't crowd out what's ahead", (() => {
        const past = Array.from({ length: 30 }, (_, i) => ({ ...row(`p${i}`), date: hrs(-1) }));
        const ahead = Array.from({ length: 10 }, (_, i) => ({ ...row(`a${i}`), date: hrs(24 + i) }));
        const out = windowRows([...past, ...ahead], NOW).map((x) => x.r.title);
        return out.filter((t) => t.startsWith("a")).length === 10 && out.filter((t) => t.startsWith("p")).length === 8;
      })()],
      ["events come back oldest-first", (() => {
        const out = windowRows([{ ...row("later"), date: hrs(5) }, { ...row("sooner"), date: hrs(2) }], NOW);
        return out.map((x) => x.r.title).join(",") === "sooner,later";
      })()],
      ["toEvent ships `at` so the client can re-derive isPast", (() => {
        const e = toEvent({ r: row("Core CPI m/m", { forecast: "0.3%", previous: "0.2%" }), t: NOW - 3600000 }, NOW);
        return e.at === new Date(NOW - 3600000).toISOString() && e.isPast === true && e.numeric === true
          && e.id === `${e.at}|Core CPI m/m` && e.text === "Core CPI m/m — forecast 0.3% — prior 0.2%";
      })()],
      // The bug in one assertion: nothing may claim to carry a released figure,
      // because this feed has never had one.
      ["no row ever claims an actual", (() => {
        const e = toEvent({ r: { ...row("Federal Funds Rate", { forecast: "3.75%", previous: "3.75%" }), actual: "3.75%" }, t: NOW - 3600000 }, NOW);
        return e.actual === undefined && !/actual/.test(e.text);
      })()],
    ];
  },
  "mini-worker": (mod) => {
    const m = mod.mergeTasks;
    if (typeof m !== "function") return [["mini-worker exports mergeTasks", false, "not exported"]];
    const A = { id: "a", status: "delivered", output: "done" };   // ours, finished this run
    const B = { id: "b", status: "queued" };                      // ours, untouched
    const C = { id: "c", status: "queued" };                      // queued by the CLIENT mid-run
    return [
      // the bug this fixes: a task the client queued during a run must survive our write
      ["mergeTasks keeps a task queued mid-run", m([A, B], [C, { ...A, status: "queued" }, B]).some(t => t.id === "c")],
      ["mergeTasks lets our version win for ids we touched",
        m([A, B], [C, { ...A, status: "queued", output: null }, B]).find(t => t.id === "a")?.output === "done"],
      ["mergeTasks preserves live order (client prepends, so new stays on top)",
        m([A, B], [C, A, B]).map(t => t.id).join() === "c,a,b"],
      ["mergeTasks appends ours when the live row hasn't seen it",
        m([A, B], [A]).map(t => t.id).join() === "a,b"],
      ["mergeTasks falls back to ours when live is absent/garbage",
        m([A, B], null).length === 2 && m([A, B], "nope").length === 2],
      ["mergeTasks tolerates empty/idless input",
        m([], []).length === 0 && m(null, null).length === 0 && m([{ status: "queued" }], []).length === 0],
    ];
  },
  "calendar-events": (mod) => {
    const badUrl = mod.badUrl;
    if (typeof badUrl !== "function") return [["calendar-events exports badUrl", false, "not exported"]];
    return [
      ["calendar events allow a public HTTPS host", !badUrl("https://calendar.google.com/calendar/ical/example/basic.ics")],
      ["calendar events reject loopback hosts", !!badUrl("http://127.0.0.1:8080/private.ics")],
      ["calendar events reject IPv6 loopback", !!badUrl("http://[::1]/private.ics")],
      ["calendar events reject metadata hosts", !!badUrl("http://169.254.169.254/latest/meta-data/")],
      ["calendar events reject embedded credentials", !!badUrl("https://user:pass@example.com/feed.ics")],
    ];
  },
  "site-status": (mod) => {
    const badUrl = mod.badUrl;
    if (typeof badUrl !== "function") return [["site-status exports badUrl", false, "not exported"]];
    return [
      ["site status allows a public HTTPS host", !badUrl("https://zerotosecure.com")],
      ["site status rejects loopback hosts", !!badUrl("http://localhost:3000")],
      ["site status rejects private networks", !!badUrl("http://10.0.0.8/admin")],
      ["site status rejects IPv6 local networks", !!badUrl("http://[fe80::1]/")],
      ["site status rejects non-web schemes", !!badUrl("file:///etc/passwd")],
    ];
  },
  "fetch-page": (mod) => {
    const badUrl = mod.badUrl;
    if (typeof badUrl !== "function") return [["fetch-page exports badUrl", false, "not exported"]];
    return [
      ["page fetch allows a public HTTPS host", !badUrl("https://developers.openai.com" )],
      ["page fetch rejects local IPv6", !!badUrl("http://[::1]/" )],
      ["page fetch rejects private IPv4", !!badUrl("http://192.168.1.1/" )],
      ["page fetch rejects embedded credentials", !!badUrl("https://user:pass@example.com/" )],
    ];
  },
  audit: (mod) => {
    const badUrl = mod.badUrl;
    if (typeof badUrl !== "function") return [["audit exports badUrl", false, "not exported"]];
    return [
      ["site auditor allows a public HTTPS host", !badUrl("https://zerotosecure.com" )],
      ["site auditor rejects metadata hosts", !!badUrl("http://169.254.169.254/latest/meta-data/" )],
      ["site auditor rejects IPv6 local networks", !!badUrl("http://[fd00::1]/" )],
      ["site auditor rejects local hostnames", !!badUrl("http://app.internal/" )],
    ];
  },
};

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const fns = readdirSync(FN_DIR).filter(f => f.endsWith(".js")).sort();
let pass = 0;
const failures = [];
// Bundles are kept until the auth inventory below has invoked them, then the
// directory goes. The invocation needs the bundle, not the source.
const loaded = new Map();
const bundleText = new Map();

for (const file of fns) {
  const name = basename(file, ".js");
  const out = resolve(OUT_DIR, `${name}.cjs`);
  try {
    esbuild.buildSync({
      entryPoints: [join(FN_DIR, file)],
      bundle: true, platform: "node", format: "cjs",
      external: EXTERNALS, outfile: out, logLevel: "silent",
    });
  } catch (e) {
    failures.push([name, `did not bundle: ${(e.message || String(e)).split("\n")[0]}`]);
    continue;
  }
  // The assertion that matters. A function with no handler is a 502.
  try {
    const mod = require_(out);
    bundleText.set(name, readFileSync(out, "utf8"));
    if (typeof mod.handler === "function" || typeof mod.default === "function") {
      pass++;
      loaded.set(name, mod);
      console.log(`ok:   ${name}`);
      for (const [label, cond, detail = ""] of (EXTRA[name]?.(mod) || [])) {
        if (cond) console.log(`ok:     ${label}`);
        else failures.push([`${name} · ${label}`, detail || "assertion failed"]);
      }
    } else {
      failures.push([name, `bundled with NO handler — exports are ${JSON.stringify(Object.keys(mod))}. `
        + `A required helper's module.exports has clobbered the bundle's exports; inline it into the function instead.`]);
    }
  } catch (e) {
    failures.push([name, `bundle threw on load: ${e.message}`]);
  }
}

console.log(`\n${pass}/${fns.length} functions export a callable handler`);

// ─── the auth inventory: every door is named, and every gated one is knocked on ─
{
  const named = [
    ["owner-gated", OWNER_GATED], ["shared-secret", SHARED_SECRET], ["deliberately-public", DELIBERATELY_PUBLIC],
  ];
  const listing = new Map();
  for (const [list, map] of named) {
    for (const [name, why] of Object.entries(map)) {
      if (listing.has(name)) failures.push([`${name} · inventory`, `listed in both ${listing.get(name).list} and ${list} — a function has exactly one front door`]);
      else listing.set(name, { list, why });
      if (!why || !why.trim()) failures.push([`${name} · inventory`, `listed in ${list} with no reason written down`]);
    }
  }
  // A file with no entry FAILS. That is the whole point of the map: adding a
  // function to this directory now costs one line here, and forgetting it is
  // loud instead of being a silently open endpoint.
  const unlisted = fns.map((f) => basename(f, ".js")).filter((n) => !listing.has(n));
  if (unlisted.length) {
    failures.push(["function inventory", `not listed as owner-gated, shared-secret or deliberately-public: ${unlisted.join(", ")}. `
      + `Add each one to the map in scripts/functions-smoke.mjs that matches its front door, with the reason beside it.`]);
  } else console.log(`ok:   every function names its front door (${Object.keys(OWNER_GATED).length} owner-gated, ${Object.keys(SHARED_SECRET).length} shared-secret, ${Object.keys(DELIBERATELY_PUBLIC).length} public)`);
  // The other direction: a stale entry for a file that has been renamed or
  // deleted would leave the inventory looking complete while covering nothing.
  const present = new Set(fns.map((f) => basename(f, ".js")));
  const ghosts = [...listing.keys()].filter((n) => !present.has(n));
  if (ghosts.length) failures.push(["function inventory", `listed but no such file: ${ghosts.join(", ")}`]);
  // _shared/ IS GONE, AND NOTHING MAY TAKE ITS PLACE.
  //
  // It held exactly one file, response.js, and that file was used by nobody. Four
  // functions carry a comment saying they are "deliberately self-contained — no
  // require of _shared/response", which is the whole story: its own docstring
  // opened with "Drop this in as netlify/functions/_shared/response.js, then:
  // const { json, error, methodGuard } = require('./_shared/response')" — the
  // precise instruction this file's header says has caused three production
  // outages. package.json declares "type":"module", so a required CJS helper's
  // `module.exports` becomes the bundle's own exports and REPLACES the
  // exports.handler the function assigned; the function deploys clean, reports no
  // error, and 502s on every call.
  //
  // So the directory was a working example of the one mistake this suite exists
  // to catch, sitting in the functions folder with usage instructions on it,
  // costing nothing to follow and everything to ship. Deleted rather than
  // rewritten in ESM, because the house pattern is stated a few lines up and is
  // not "a better helper": inline what you need, self-contained, deliberately.
  //
  // The check is now "nothing but function entry points", which is stricter than
  // what it replaced and is the point — a helper directory cannot come back by
  // accident, only by someone editing this assertion and reading why.
  const others = readdirSync(FN_DIR).filter((e) => !e.endsWith(".js"));
  if (others.length) {
    failures.push(["function inventory", `${FN_DIR} holds nothing but function entry points: found ${others.join(", ")}. `
      + `A shared helper required from a function is how exports.handler gets clobbered under "type":"module" — inline what you need instead.`]);
  }

  // ── an open faucet on the model budget ────────────────────────────────────
  // The one property of the public list worth checking rather than trusting.
  // Everything else a public function touches is public information; a model
  // call is the owner's money, and every function that makes one is on a gated
  // list today. Tested against the BUNDLE so an indirect reach — through
  // netlify/lib/upstream/llm.js, or the Anthropic SDK — counts the same as a
  // literal fetch to the API.
  const reachesAModel = (name) => /api\.anthropic\.com/.test(bundleText.get(name) || "");
  const openFaucets = Object.keys(DELIBERATELY_PUBLIC).filter(reachesAModel);
  if (openFaucets.length) failures.push(["public functions", `these are listed public and reach a model: ${openFaucets.join(", ")}`]);
  else console.log(`ok:   no deliberately-public function can reach a model`);

  // ── the knock ─────────────────────────────────────────────────────────────
  // A gated function has to refuse — and on knock 1 it has to refuse WITHOUT a
  // network call, which deploy.js gets right (`if (!auth) return 401` sits above
  // its first fetch) and is the shape every one of these should copy.
  //
  // 401 unauthenticated, 403 wrong account, 503 refusing because the server is
  // not in a state where it may answer. Anything else — a 200, a 400, a 500 from
  // a crash — is a function that did something with a request it should have
  // turned away.
  const REFUSALS = new Set([401, 403, 503]);

  // ── what a wrong credential looks like ────────────────────────────────────
  // EVERY SLOT AT ONCE, and that is what keeps this honest as the functions
  // drift: a bearer token, the internal worker secret header, the TRMNL token in
  // both the places it is read, the two Shortcut tokens, a Discord signature
  // pair, and the body fields (secret / token / accessToken). Whatever a given
  // gate reads, it reads something WRONG — so nobody has to maintain a map of
  // which function checks which header, and a function that starts reading a
  // different one is still covered on the day it changes.
  //
  // 60 characters of url-safe wrong, and the length is load-bearing rather than
  // arbitrary: the two Shortcut seams insist their token is 16-80 characters. A
  // shorter value gets a 400 for its SHAPE from in front of the gate, which is a
  // refusal that proves nothing about the door — the knock has to be a credential
  // that is well-formed and simply not the right one.
  const WRONG = `smoke-wrong-credential-${"0".repeat(37)}`;
  // Same length as the real secret, different at every single byte. A gate that
  // compares lengths, or compares a prefix, refuses knock 2 and waves this one
  // through — which is the whole reason secretOk() exists rather than `===`.
  const sameLengthButWrong = (real) => [...String(real)].map((c) => (c === "z" ? "y" : "z")).join("");
  // 64 bytes of hex: the right SIZE, the wrong bytes. Nothing in this directory
  // verifies a signature today — discord-board was the only one, and it left with
  // the Discord feature — so this slot currently proves nothing. It stays because
  // the knock's whole design is to fill EVERY slot rather than maintain a map of
  // which function reads which header, and because the sizing rule is the part
  // that is easy to get wrong later: a signature check is typically a library
  // call that THROWS on a wrong-size input rather than returning false, and a
  // gate that throws answers 502, which would test the error handler instead of
  // the door.
  const WRONG_SIGNATURE = "ab".repeat(64);
  const credsFor = (equalLength) => {
    const secret = (real) => (equalLength ? sameLengthButWrong(real) : WRONG);
    return {
      bearer: WRONG,
      worker: secret(FAKE_ENV.INTERNAL_WORKER_SECRET),
      trmnl: secret(FAKE_ENV.TRMNL_TOKEN),
      backup: secret(FAKE_ENV.BACKUP_SECRET),
    };
  };
  const wrongHeaders = (c) => ({
    "content-type": "application/json",
    authorization: `Bearer ${c.bearer}`,
    "x-internal-worker-secret": c.worker,
    "x-board-token": c.trmnl,
    "x-capture-token": c.bearer,
    "x-import-token": c.bearer,
    "x-signature-ed25519": WRONG_SIGNATURE,
    "x-signature-timestamp": "1754838000",
  });
  // Enough of a payload to REACH the gate instead of a 400 in front of it:
  // note-capture normalises the note before it looks the token up, and "400,
  // your note was empty" would say nothing about the door. `ping` is deliberately
  // absent — several of these answer a ping with a 200 by design.
  const wrongBody = (c) => JSON.stringify({
    secret: c.backup, token: c.bearer, accessToken: c.bearer,
    text: "smoke knock", question: "smoke knock",
    application_id: "000000000000000000", workouts: [],
  });

  // Netlify's legacy event, as the runtime builds it. Headers arrive lowercased,
  // and on knock 1 the authorization key is deliberately ABSENT rather than empty
  // — that is the case a gate is most likely to get wrong, because `event.headers
  // .authorization` is then undefined and a gate that reads it without the `|| ""`
  // guard crashes into a 502 instead of answering 401.
  const legacyEvent = (creds) => ({
    httpMethod: "POST", path: "/.netlify/functions/x",
    rawUrl: `https://smoke.invalid/.netlify/functions/x${creds ? `?token=${creds.trmnl}` : ""}`,
    headers: creds ? wrongHeaders(creds) : { "content-type": "application/json" },
    queryStringParameters: creds ? { token: creds.trmnl } : {},
    body: creds ? wrongBody(creds) : "{}", isBase64Encoded: false,
  });
  const modernRequest = (name, creds) => new Request(
    `https://smoke.invalid/.netlify/functions/${name}${creds ? `?token=${creds.trmnl}` : ""}`,
    { method: "POST", headers: creds ? wrongHeaders(creds) : { "content-type": "application/json" }, body: creds ? wrongBody(creds) : "{}" },
  );

  // BOTH SHAPES, READ FROM THE ANSWER RATHER THAN ASSUMED. A v2 handler answers
  // with a WHATWG Response, which carries `status` and NO `statusCode` — so a
  // harness that reads only `res.statusCode` sees undefined on every one of them
  // and would have to treat undefined as either a pass (which excuses exactly the
  // functions that were open) or a fail (which makes the modern convention
  // untestable). Both are read, the shape is recorded, and the tally is printed
  // so a convention change cannot quietly leave one reader unexercised.
  const codeOf = (res) => {
    if (res && typeof res.status === "number" && typeof res.headers?.get === "function") {
      return { code: res.status, shape: "Response", statusCodeField: res.statusCode };
    }
    if (res && typeof res.statusCode === "number") return { code: res.statusCode, shape: "legacy", statusCodeField: res.statusCode };
    return { code: null, shape: res == null ? "nothing" : typeof res, statusCodeField: res?.statusCode };
  };

  const shapes = { Response: [], legacy: [] };
  const carriesAStatusCode = [];
  const gated = [...Object.keys(OWNER_GATED), ...Object.keys(SHARED_SECRET)].sort();

  // One invocation, either handler convention, with the fetches it attempted
  // recorded next to the answer it gave.
  const invoke = async (name, mod, creds) => {
    const before = fetchCalls.length;
    let res = null, threw = null;
    try {
      res = typeof mod.default === "function"
        ? await mod.default(modernRequest(name, creds))
        : await mod.handler(legacyEvent(creds), {});
    } catch (e) { threw = e; }
    return { res, threw, spent: fetchCalls.slice(before) };
  };

  // ── knock 1: nothing at all ───────────────────────────────────────────────
  identity = null; // the network stays shut: an absent credential needs no lookup
  for (const name of gated) {
    const mod = loaded.get(name);
    if (!mod) continue; // already reported above as un-bundleable / handler-less
    const { res, threw, spent } = await invoke(name, mod, null);
    if (threw) {
      failures.push([`${name} · refuses an anonymous caller`,
        `threw instead of answering: ${threw.message}`
        + (spent.length ? ` — and it called fetch first (${spent[0].url})` : "")]);
      continue;
    }
    const { code, shape, statusCodeField } = codeOf(res);
    if (shape === "Response" || shape === "legacy") shapes[shape].push(name);
    if (shape === "Response" && statusCodeField !== undefined) carriesAStatusCode.push(`${name} (${statusCodeField})`);
    if (!REFUSALS.has(code)) {
      failures.push([`${name} · refuses an anonymous caller`,
        `answered ${code === null ? `a ${shape}` : code} to a request with no Authorization header, no secret header and no token. `
        + `Expected 401, 403 or 503.`]);
      continue;
    }
    if (spent.length) {
      failures.push([`${name} · refuses before spending anything`,
        `refused with ${code}, but reached ${spent.length} upstream(s) getting there — first was ${spent[0].url}. `
        + `Decide whether the caller is allowed BEFORE the first fetch (netlify/functions/deploy.js is the pattern).`]);
      continue;
    }
    console.log(`ok:     ${name} · ${code} to an anonymous caller, no upstream touched (${shape})`);
  }

  // ── knocks 2 and 3: a credential that is wrong, and one that is somebody else's ─
  // A gate that answers before it ever looks at the caller. There is one, it is
  // deliberate, and naming it here is the only way this pass stays honest: a
  // function listed below has its owner check UNEXERCISED, and the assertion after
  // the loop is bidirectional, so the day PAUSED goes false this entry goes stale
  // and fails rather than quietly excusing a live endpoint.
  const UNREACHABLE_GATE = {
    "upstream-run-background": "PAUSED = true answers 503 above the token read — the engines are off on purpose, "
      + "so nothing downstream of the gate can run and nothing about the gate can be observed",
  };
  const STRANGER = "11111111-1111-4111-8111-111111111111"; // a valid session, not the owner's
  const gateSeen = { wrong: new Set(), stranger: new Set() };
  const PASSES = [
    {
      key: "wrong", label: "a wrong credential", equalLength: false,
      // "not a session" — the answer Supabase gives for a token it does not know.
      identity: { status: 401, user: null },
      expect: null, // any refusal will do: 401 is the honest answer, 503 is allowed
    },
    {
      key: "stranger", label: "a valid session that is not the owner's", equalLength: true,
      identity: { status: 200, user: STRANGER },
      // THE ONE THAT MATTERS. The caller proved who they are and it is not
      // Cameron, so the only correct answer from a function that got as far as
      // comparing is 403 — an owner gate that degrades to "any signed-in account"
      // answers 200 here and is invisible to both other knocks.
      expect: 403,
    },
  ];
  for (const pass of PASSES) {
    identity = pass.identity;
    const creds = credsFor(pass.equalLength);
    if (pass.equalLength) {
      // The equal-length values have to BE equal-length and BE wrong, or knock 3
      // is knock 2 wearing a different name.
      for (const [k, real] of [["worker", FAKE_ENV.INTERNAL_WORKER_SECRET], ["trmnl", FAKE_ENV.TRMNL_TOKEN], ["backup", FAKE_ENV.BACKUP_SECRET]]) {
        if (creds[k].length !== real.length || creds[k] === real) {
          failures.push(["knock 3 fixture", `${k} is meant to be a wrong secret of the same length as the real one, and is not (${creds[k].length} vs ${real.length})`]);
        }
      }
    }
    for (const name of gated) {
      const mod = loaded.get(name);
      if (!mod) continue;
      const { res, threw, spent } = await invoke(name, mod, creds);
      const label = `${name} · refuses ${pass.label}`;
      if (threw) {
        failures.push([label, `threw instead of answering: ${threw.message}`]);
        continue;
      }
      const { code } = codeOf(res);
      const identityCalls = spent.filter((c) => isIdentityCall(c.url));
      const stray = spent.filter((c) => !isIdentityCall(c.url));
      if (identityCalls.length) gateSeen[pass.key].add(name);
      if (!REFUSALS.has(code)) {
        failures.push([label, `answered ${code === null ? "no status at all" : code} to ${pass.label}. `
          + `Expected 401, 403 or 503 — this credential is not valid for this endpoint.`]);
        continue;
      }
      if (stray.length) {
        failures.push([`${name} · refuses ${pass.label} before spending anything`,
          `refused with ${code}, but reached ${stray.length} upstream(s) that are not a caller-identity check — first was ${stray[0].url}.`]);
        continue;
      }
      // The identity call has to be ABOUT US. A gate that hands the auth endpoint
      // its own service-role key instead of the caller's token is asking who the
      // server is, gets a 200, and lets the caller in.
      const askedAboutUs = identityCalls.every((c) => c.presented === creds.bearer || c.url.includes(creds.bearer));
      if (!askedAboutUs) {
        failures.push([`${name} · verifies the credential the caller presented`,
          `it called ${identityCalls[0].url} but presented ${JSON.stringify(identityCalls[0].presented.slice(0, 24))} rather than the caller's token — `
          + `that asks who the SERVER is, and the answer is always yes.`]);
        continue;
      }
      if (pass.expect && identityCalls.length && code !== pass.expect) {
        failures.push([label, `answered ${code} after verifying that the session belongs to ${STRANGER}, not to BOARD_USER_ID. `
          + `Expected ${pass.expect} — a session for a second account must never be sufficient.`]);
        continue;
      }
      console.log(`ok:     ${name} · ${code} to ${pass.label}${identityCalls.length ? ", after verifying whose it was" : ""}`);
    }
  }
  identity = null;

  // Bidirectional, so neither direction can rot: every gated function either
  // consulted the identity check when handed somebody else's valid session, or is
  // a shared secret (compared locally, nothing to consult), or is named in
  // UNREACHABLE_GATE with the reason. A name that stops needing its excuse fails
  // here, which is the only thing that stops this list from becoming a place to
  // hide an open endpoint.
  {
    const shared = new Set(Object.keys(SHARED_SECRET));
    const silent = gated.filter((n) => loaded.has(n) && !gateSeen.stranger.has(n) && !shared.has(n));
    const excused = Object.keys(UNREACHABLE_GATE).sort();
    if (silent.sort().join(",") !== excused.join(",")) {
      failures.push(["owner gates exercised",
        `these owner-gated functions never checked whose session they were handed: ${silent.join(", ") || "(none)"} — `
        + `expected exactly ${excused.join(", ")}. Either a gate has gone missing, or one of them can now be reached and `
        + `UNREACHABLE_GATE in scripts/functions-smoke.mjs is out of date.`]);
    } else {
      console.log(`ok:   every owner gate verified the session it was handed, except ${excused.length} named as unreachable`);
      for (const [n, why] of Object.entries(UNREACHABLE_GATE)) console.log(`note:   ${n}'s owner check is unexercised — ${why}`);
    }
    const sharedTalked = [...gateSeen.wrong, ...gateSeen.stranger].filter((n) => shared.has(n));
    if (sharedTalked.length) {
      failures.push(["shared secrets are compared locally",
        `these called out to verify a shared secret: ${[...new Set(sharedTalked)].join(", ")} — the secret IS the identity, `
        + `so there is nothing to look up and a network round trip is a new failure mode in front of the door.`]);
    }
  }

  // Printed every run, because "which convention is this function on" is the
  // thing a reader of this file needs and cannot get from the lists above.
  console.log(`ok:   ${shapes.Response.length} gated function(s) answer with a v2 Response (statusCode is undefined on all of them): ${shapes.Response.join(", ")}`);
  console.log(`ok:   ${shapes.legacy.length} gated function(s) answer with a legacy { statusCode }`);
  if (!shapes.Response.length || !shapes.legacy.length) {
    failures.push(["handler conventions", `only one convention was exercised (Response: ${shapes.Response.length}, legacy: ${shapes.legacy.length}) — `
      + `the reader for the other one is now untested; either the inventory is wrong or a convention has been retired and codeOf() should follow it`]);
  }
  // The Response-shaped ones must genuinely carry `statusCode: undefined`. That
  // is the fact the old shape of this check depended on without knowing it, and
  // asserting it keeps the sentence above from going stale: if a future runtime
  // starts populating both fields, this says so instead of the note quietly
  // becoming wrong.
  if (carriesAStatusCode.length) {
    failures.push(["handler conventions",
      `these answered with a Response that ALSO carries a statusCode: ${carriesAStatusCode.join(", ")} — `
      + `the note printed above is now wrong and codeOf() should prefer whichever field the runtime actually honours`]);
  }

  // The whole-file version of the per-knock assertion above. It can no longer be
  // "zero fetches", because knocks 2 and 3 make the owner gates verify a token and
  // that verification is the gate doing its job — so it is "zero fetches that are
  // not that", which is the strongest true statement available. The per-function
  // checks already insist that knock 1 reached nothing whatsoever.
  const strays = fetchCalls.filter((c) => !isIdentityCall(c.url));
  if (!strays.length) console.log(`ok:   no refused invocation reached anything but a caller-identity check (${fetchCalls.length} of those)`);
  else failures.push(["outbound during auth failure", `${strays.length} fetch(es) attempted that are not an identity check: ${[...new Set(strays.map((c) => c.url))].join(", ")}`]);
}

rmSync(OUT_DIR, { recursive: true, force: true });

// ─── every outbound fetch carries a deadline ─────────────────────────────────
// A fetch with no timeout in a Netlify function does not fail — it HANGS, until
// the platform kills the invocation. On a synchronous function that is ~10
// seconds of a spinner and then a 502 with nothing readable in it; on a
// background one it burns the 15-minute budget doing nothing. Twenty of these
// shipped without one, against CoinGecko, Yahoo, Plaid, Shopify, TMDB, the
// Forex calendar and Anthropic — every upstream the app has.
//
// The deadline is sized to the work: a JSON API that has not answered in eight
// seconds is not going to, and an LLM generation legitimately takes minutes.
{
  const { readdirSync, readFileSync: rf } = await import("node:fs");
  const files = readdirSync("netlify/functions").filter((f) => f.endsWith(".js"));
  const naked = [], tooShortForAnLLM = [];
  for (const f of files) {
    const src = rf(`netlify/functions/${f}`, "utf8");
    if (!/\bfetch\(/.test(src)) continue;
    if (!/AbortSignal\.timeout|AbortController/.test(src)) { naked.push(f); continue; }
    // An Anthropic call on a short deadline is worse than none: it fails every
    // time the model thinks for longer than a page load.
    for (const line of src.split("\n")) {
      const m = line.match(/api\.anthropic\.com[\s\S]*?AbortSignal\.timeout\((\d+)\)/);
      if (m && Number(m[1]) < 60000) tooShortForAnLLM.push(`${f} (${m[1]}ms)`);
    }
  }
  if (naked.length) failures.push(["outbound timeouts", `these fetch with no deadline: ${naked.join(", ")}`]);
  else console.log(`ok:   every function that fetches carries a deadline`);
  if (tooShortForAnLLM.length) failures.push(["LLM deadlines", `sized for a page load, not a generation: ${tooShortForAnLLM.join(", ")}`]);
  else console.log(`ok:   LLM calls get generation-sized deadlines`);
}

if (failures.length) {
  for (const [name, why] of failures) console.error(`FAIL: ${name}\n      ${why}`);
  console.error("FUNCTION SMOKE FAILED");
  process.exit(1);
}

console.log("FUNCTION SMOKE PASS");
