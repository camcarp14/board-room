// Full data export for local backups — pulls every table in the boardroom
// schema and returns it as JSON: one file when it fits, one table at a time
// when it does not.
//
// IT COULD NOT BE RETURNED AT ALL. This is a synchronous function, and Netlify
// caps a synchronous function's response at 6 MB. usage_log alone is ~14 MB of
// JSON (51k rows and growing on every call), alt_snapshots another ~3.6 MB — so
// every backup call for months answered with a platform 502, and the scheduled
// task that was supposed to be keeping a copy on disk received nothing. The
// smoke stayed green because it exercises the handler against empty tables.
// The file's own header said a backup that fails without a copy on disk "stops
// you looking for a real one", and there was no real one.
//
// So the contract is page-able now, and the whole-file path refuses honestly:
//
//   { secret }                   the whole database, as before — but only when
//                                it fits under the cap. Over it, a 413 that
//                                names the tables and says to page instead.
//   { secret, list: true }       the tables the export covers, so the caller
//                                can loop without knowing the list.
//   { secret, table, offset }    one table from `offset`, as many rows as fit
//                                in a page, with `next` (the next offset) or
//                                null when the table is finished, plus `total`.
//
// IT USED TO COVER NINE TABLES OUT OF THIRTY-TWO. No transactions, no workouts,
// no body weight, no Creed, no dream boards, no upkeep, no Record — the flags and
// sessions the screeners have been grading for months. The header said it pulled
// "every table that holds something you'd actually be upset to lose" and it did
// not, and there was no way to notice: the response looked identical whether a
// table was absent from the list or absent from the database. A backup you have
// never restored from is a promise, and this one was not keeping it.
//
// THE LIST IS DUPLICATED FROM supabase/migrations/, ON PURPOSE. It cannot be a
// shared require: under this repo's "type":"module" + esbuild bundling, a
// required helper's `module.exports` replaces the bundle's own exports and wipes
// the `exports.handler` assigned below — the function deploys clean, reports no
// error, and 502s on every call. See the note at the top of
// netlify/functions/audit.js, and the same scar in tmdb.js and workout-import.js.
// Self-contained is the house pattern here, deliberately. What makes the copy
// safe is scripts/migrations-smoke.mjs, which fails if this list and the
// migrations directory disagree in either direction.
//
// SECURITY: this uses the Supabase SERVICE ROLE key (not the anon key), which
// bypasses RLS entirely — necessary so a scheduled task with no logged-in
// session can still pull everything. That means this endpoint must never be
// callable by just anyone. It requires a shared secret (BACKUP_SECRET) that only
// you and your scheduled task know.
//
// Setup, one time:
//   1. Generate a random secret (anything long and unguessable works —
//      a password manager's generator is fine).
//   2. Netlify → Site configuration → Environment variables → add
//      BACKUP_SECRET with that value.
//   3. Supabase → Project Settings → API → copy the "service_role" key
//      (NOT the anon key) → add it to Netlify as SUPABASE_SERVICE_ROLE_KEY.
//   4. The Cowork scheduled task, with the same BACKUP_SECRET, runs the loop:
//      POST { secret, list: true } for the table names, then for each table
//      POST { secret, table, offset: 0 } and follow `next` until it is null,
//      concatenating `rows`; write one file per table (or one file of all of
//      them) with the `total` alongside so a short copy is visible. A single
//      POST { secret } still works while the database fits in one response,
//      and tells you — with a 413 — the moment it stops fitting.

const { createClient } = require("@supabase/supabase-js");
const { timingSafeEqual } = require("node:crypto");

const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Every table in supabase/migrations/, in the same order. Adding a table to the
// app means adding a migration AND adding it here; the smoke enforces both.
const TABLES = [
  "app_settings", "seat_notes", "chat_messages", "usage_log", "auditor_findings",
  "personal_events", "personal_birthdays", "personal_anniversaries", "personal_notes", "upkeep_items",
  "movies", "grocery_items", "saved_recipes",
  "affirmations", "dream_items",
  "workout_templates", "workout_sessions", "body_weight_log",
  "transactions", "plaid_items",
  "mini_skills", "mini_feed", "miner_samples",
  "alt_state", "alt_flags", "alt_snapshots", "alt_positions",
  "stock_state", "stock_flags", "stock_sessions",
  "upstream_runs", "upstream_run_events", "upstream_predictions", "upstream_tell_checks",
  // client_errors joined the record when crash telemetry landed. It belongs in the
  // backup rather than in SKIP below: a crash log holds no credentials, and the
  // history of what broke on which build is exactly the kind of thing you only
  // want after you have lost it.
  "client_errors",
  // The Guitar tab. guitar_sessions is the one that matters most here: the chord
  // library and the curriculum ship in the bundle and come back with a deploy,
  // but a practice log is a record of things that happened once and cannot be
  // reconstructed from anything.
  "guitar_sessions", "guitar_skills", "guitar_songs",
];

// LEFT OUT, AND SAID OUT LOUD. The reason travels in the response next to the
// data, because the failure this whole rewrite is about is a backup that omits
// something without mentioning it. Anything in here must also be in TABLES above,
// so the inventory stays complete and only the export opts out.
//
// The old header claimed it skipped auditor_findings, mini_feed and usage_log as
// "operational logs, not data, that regenerate on their own". Two of those three
// do not regenerate: auditor_findings is a history of what was wrong with your
// sites and usage_log is the only record of what you have spent. They are backed
// up now. Only one exclusion survives, and it is not about size.
const SKIP = {
  plaid_items: "holds live bank access tokens — a JSON file on a laptop is the wrong place for a credential, and re-linking an institution takes two minutes",
};

// ─── rate limit ──────────────────────────────────────────────────────────────
// One correct guess of BACKUP_SECRET returned the entire database, and nothing
// slowed a guesser down. Five wrong answers per ten minutes per source address
// does.
//
// BE CLEAR ABOUT WHAT THIS IS. It is a Map in one warm container's memory. It
// resets on a cold start and it does not coordinate across the concurrent
// instances Netlify may run, so it is a speed bump on a single-source brute force
// rather than a lock. The real defence is still the length and randomness of the
// secret. What this buys is that an automated guesser stops getting free
// unlimited attempts, and it costs nothing when the legitimate caller — which
// presents the right secret — never counts against the window at all.
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX = 5;
const failures = new Map();

// THE BUCKET KEY, AND EXACTLY WHAT IT IS WORTH. This used to fall back to the
// LEFTMOST entry of X-Forwarded-For, which is the one end of that header nobody
// verifies: it is whatever the client typed. On any path where Netlify's own
// x-nf-client-connection-ip was missing, a guesser got a fresh five-attempt
// bucket per forged header value — unlimited attempts at BACKUP_SECRET for the
// price of one header field, which is the same as no rate limit at all.
//
// So there is exactly one header trusted here, and it is the one the platform
// writes rather than the caller: x-nf-client-connection-ip. Netlify sets it on
// every invocation and lowercases the whole header map, so the lowercase spelling
// is the only one read — reading a Titlecase variant too would mean honouring a
// name a client could send, which is the hole being closed.
//
// WHEN IT IS ABSENT (local invocation, a smoke, some future platform) every such
// caller shares ONE bucket. That is deliberate: a shared bucket cannot be escaped
// by forging a header, and a per-forged-value bucket is not a rate limit. What it
// cannot be trusted to mean is "one person" — the shared bucket is filled by
// anyone on that path, so a determined caller can spend the window and make the
// legitimate backup wait ten minutes. That is the same trade the previous
// `|| "unknown"` fallback already made, and it is the right side of it: a delayed
// backup is recoverable, an unmetered secret guess is not. The real defence
// remains the length and randomness of BACKUP_SECRET.
function clientIp(event) {
  const h = event.headers || {};
  const platform = String(h["x-nf-client-connection-ip"] || "").trim();
  return platform || "unverified-source";
}

function rateLimited(ip, now) {
  const recent = (failures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (recent.length) failures.set(ip, recent); else failures.delete(ip);
  // The map is swept opportunistically rather than on a timer — a background
  // interval in a function that may be frozen between invocations is a leak
  // waiting to happen.
  if (failures.size > 500) {
    for (const [k, v] of failures) if (!v.some((t) => now - t < FAIL_WINDOW_MS)) failures.delete(k);
  }
  return recent.length >= FAIL_MAX;
}

function noteFailure(ip, now) {
  failures.set(ip, [...(failures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS), now]);
}

// timingSafeEqual THROWS on buffers of unequal length instead of returning false,
// so the lengths are compared first. That comparison is not constant time and does
// not need to be: the length of the secret is not the secret, and an attacker who
// learns it still has to guess its bytes. Same shape as secretOk() in
// hopSecretOk() in stock-settle-background.js.
function secretOk(presented, expected) {
  const a = Buffer.from(String(presented == null ? "" : presented), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── the read ────────────────────────────────────────────────────────────────
// PAGED AND COUNTED, because an unpaged select is exactly how a backup goes
// quietly short. PostgREST applies a max-rows ceiling when the project sets one,
// and it does not tell you it truncated: you get a 200 with fewer rows than exist.
// usage_log and miner_samples are the two tables big enough for that to bite —
// miner_samples takes a sample every two minutes.
//
// Paging alone would not be enough either. The obvious rule — stop when a page
// comes back shorter than requested — is wrong under exactly the condition it is
// meant to defend against: if the ceiling is lower than the page size, the FIRST
// page comes back short and the loop declares the table finished. So the first
// request asks for an exact count and the total is checked against what arrived.
// The export either has the whole table or it says which table it could not
// finish. There is no third outcome where it guesses.
//
// PAGE stays at 1,000 (the conventional Supabase ceiling) so the common case is
// one round trip per table, and the count is what makes a lower ceiling loud
// instead of silent.
const PAGE = 1000;
const MAX_ROWS = 500_000;

// THE PLATFORM'S CEILING, WITH ROOM UNDER IT. Netlify drops a synchronous
// function response over 6 MB on the floor — the caller sees a 502 and nothing
// this function computed. The budget is measured in JSON string length while
// rows are read (a lower bound for multi-byte text) and the whole-file body is
// measured in real bytes before it is returned, so the slack below the cap is
// what absorbs the difference and the envelope around the rows.
const RESPONSE_CAP = 5_500_000;
// One table page: smaller again, so a page that stops one row short of the
// budget still fits with its envelope, whatever the row.
const PAGE_CAP = 4_500_000;

// STABLE ORDER, OR PAGING IS A LIE. A range with no ORDER BY is whatever order
// Postgres felt like returning, and it is allowed to feel differently between
// two calls — so two pages of a table fetched in two invocations can overlap or
// miss rows and still add up to `total`. Every table pages on its primary key.
// The tables keyed by a pair are listed; everything else has an `id`.
// scripts/migrations-smoke.mjs checks each name here against the DDL.
const ORDER = {
  app_settings: ["user_id", "setting_key"],
  seat_notes: ["user_id", "seat_key"],
  transactions: ["user_id", "id"],
  plaid_items: ["user_id", "item_id"],
  stock_sessions: ["session_date"],
  guitar_skills: ["user_id", "skill_id"],
  guitar_songs: ["user_id", "id"],
};
const orderOf = (table) => ORDER[table] || ["id"];

/**
 * Read `table` from `offset`, stopping when the table ends or the rows read so
 * far would serialize past `maxBytes`. Returns { rows, total, next, bytes }:
 * `next` is the offset to continue from, or null when the table is finished.
 *
 * A stop for size is never reported as a finished table — that is what `next`
 * is for — and a table that ENDS short of its own count still throws, exactly
 * as before: there is no outcome where fewer rows than exist are called a
 * backup.
 */
async function readTable(supabase, table, { offset = 0, maxBytes = Infinity } = {}) {
  const rows = [];
  let bytes = 0;
  let total = null;
  let next = null;
  let from = offset;

  for (let first = true; ; first = false) {
    let q = supabase.from(table).select("*", first ? { count: "exact" } : undefined);
    for (const col of orderOf(table)) q = q.order(col);
    const res = await q.range(from, from + PAGE - 1);
    if (res.error) throw new Error(res.error.message);
    if (first) total = typeof res.count === "number" ? res.count : null;
    const page = res.data || [];

    // Rows are admitted one at a time against the budget, so a page of wide
    // rows (alt_snapshots runs ~5 KB each) cannot overshoot it by a whole page.
    // The first row always goes in: a response that makes no progress is a
    // loop that never ends.
    for (let i = 0; i < page.length; i++) {
      const size = JSON.stringify(page[i]).length + 1;
      if (rows.length && bytes + size > maxBytes) { next = from + i; break; }
      rows.push(page[i]);
      bytes += size;
    }
    if (next != null) break;
    from += page.length;

    // Two stop conditions, and the one that applies depends on whether PostgREST
    // gave us a count. With a count it is authoritative. Without one — some
    // configurations return none — fall back to the short-page rule and be clear
    // in the comment that this is the weaker of the two.
    if (total != null ? from >= total : page.length < PAGE) break;
    if (!page.length) break; // no forward progress; the count check below decides
    if (rows.length >= MAX_ROWS) {
      throw new Error(`over ${MAX_ROWS} rows — this export would be truncated, so it is refused instead`);
    }
  }

  // An offset past the end reads nothing and finishes cleanly (offset + 0 is
  // not short of the count); a read that stops short of it is the failure.
  if (next == null && total != null && offset + rows.length < total) {
    throw new Error(`read ${offset + rows.length} of ${total} rows — refusing to report a partial table as a backup`);
  }
  return { rows, total, next, bytes };
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const configured = !!(process.env.BACKUP_SECRET && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  // The Status tab pings this with { ping: true } and needs a 200, so the ping
  // answers before the rate limiter sees the request. It reveals nothing but
  // which environment variables are missing, and it is not a guess at the secret,
  // so limiting it would only turn a healthy row red under load.
  if (body.ping) {
    const missing = [!process.env.BACKUP_SECRET && "BACKUP_SECRET", !process.env.SUPABASE_URL && "SUPABASE_URL", !process.env.SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean).join(" / ");
    return json(200, { success: true, service: "export-data", configured, missing: configured ? undefined : missing });
  }

  const ip = clientIp(event);
  const now = Date.now();
  if (rateLimited(ip, now)) {
    return json(429, { success: false, error: "too many failed attempts — wait ten minutes." });
  }

  // One message for both "no secret configured" and "wrong secret". Saying which
  // it was tells an unauthenticated caller whether the endpoint is live.
  if (!process.env.BACKUP_SECRET || !secretOk(body.secret, process.env.BACKUP_SECRET)) {
    noteFailure(ip, now);
    return json(401, { success: false, error: "Missing or incorrect secret." });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { success: false, error: "SUPABASE_SERVICE_ROLE_KEY isn't set in Netlify yet — see the comment at the top of this file." });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "boardroom" } });
  const wanted = TABLES.filter((t) => !SKIP[t]);
  const exportedAt = new Date().toISOString();

  // ── the table list, for a caller that loops ─────────────────────────────────
  if (body.list) return json(200, { success: true, exportedAt, tables: wanted, skipped: SKIP });

  // ── one table, one page ─────────────────────────────────────────────────────
  // Validated against the export's own list: a name that is not a table here is
  // refused before it reaches PostgREST, and a skipped table is refused WITH its
  // reason rather than silently answered empty.
  if (body.table != null) {
    const table = String(body.table);
    if (SKIP[table]) return json(400, { success: false, error: `${table} is not exported — ${SKIP[table]}` });
    if (!wanted.includes(table)) return json(400, { success: false, error: `no such table in the export: ${table} — POST { secret, list: true } for the list` });
    const offset = Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
    try {
      const { rows, total, next } = await readTable(supabase, table, { offset, maxBytes: PAGE_CAP });
      return json(200, { success: true, exportedAt, table, offset, rows, total, next });
    } catch (e) {
      return json(500, { success: false, error: `export failed — ${table}: ${e.message || String(e)}. Nothing was written.`, failed: { [table]: e.message || String(e) } });
    }
  }

  // ── the whole database, when it fits ────────────────────────────────────────
  try {
    // Each table reads under the whole-response budget on its own, so a table
    // that alone cannot fit stops reading early instead of paging through 14 MB
    // to be told so; `next` on any result means the answer is a 413 either way.
    const results = await Promise.all(wanted.map(async (table) => {
      try { return [table, await readTable(supabase, table, { maxBytes: RESPONSE_CAP })]; }
      catch (e) { return [table, null, e.message || String(e)]; }
    }));

    // A TABLE THAT ERRORED FAILS THE WHOLE EXPORT. It used to embed { error }
    // inside a 200, next to the tables that worked, under a payload the caller
    // would then write to disk as a backup. A backup that reports success while
    // missing a table is worse than no backup at all, because it stops you
    // looking for a real one. So: 500, and name every table that broke.
    const failed = {};
    for (const [table, , err] of results) if (err) failed[table] = err;
    if (Object.keys(failed).length) {
      return json(500, {
        success: false,
        error: `export failed — ${Object.keys(failed).length} of ${wanted.length} tables could not be read. Nothing was written.`,
        failed,
      });
    }

    // TOO BIG TO RETURN IS A 413, NOT A 502 FROM THE PLATFORM. The sizes go in
    // the response, largest first, so the caller can see which table is the
    // weight and page it — a whole-file backup that used to fail with no body
    // at all now says exactly why and what to do instead.
    const sizes = {};
    let totalBytes = 0;
    let cut = false;
    for (const [table, r] of results) { sizes[table] = r.bytes; totalBytes += r.bytes; if (r.next != null) cut = true; }
    const tooBig = (measured) => json(413, {
      success: false,
      error: `export is ${cut ? "over" : "about"} ${(measured / 1e6).toFixed(1)} MB — over the 6 MB a synchronous function can return, so nothing was written. Fetch it table by table with { secret, table, offset } (see { secret, list: true }).`,
      sizes: Object.fromEntries(Object.entries(sizes).sort((a, b) => b[1] - a[1])),
    });
    if (cut || totalBytes > RESPONSE_CAP) return tooBig(totalBytes);

    const tables = {};
    const rowCounts = {};
    for (const [table, r] of results) { tables[table] = r.rows; rowCounts[table] = r.rows.length; }

    const out = JSON.stringify({
      success: true,
      exportedAt,
      // Counts alongside the data so a restore can be sanity-checked without
      // parsing the whole payload, and so an all-zeros export is obvious.
      rowCounts,
      // Never silently short. Anything left out says so, with the reason.
      skipped: SKIP,
      tables,
    });
    // The real size of the real body, in bytes — the per-row budget above is an
    // estimate, and the cap is the platform's, not ours to round.
    const bytes = Buffer.byteLength(out, "utf8");
    if (bytes > RESPONSE_CAP) return tooBig(bytes);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: out };
  } catch (e) {
    return json(500, { success: false, error: e.message });
  }
};
