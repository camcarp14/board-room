// Full data export for local backups — pulls every table in the boardroom
// schema and returns it as one JSON file.
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
//   4. Use the same BACKUP_SECRET value in the Cowork scheduled task prompt.

const { createClient } = require("@supabase/supabase-js");
const { timingSafeEqual } = require("node:crypto");

const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Every table in supabase/migrations/, in the same order. Adding a table to the
// app means adding a migration AND adding it here; the smoke enforces both.
const TABLES = [
  "app_settings", "seat_notes", "chat_messages", "usage_log", "auditor_findings",
  "personal_events", "personal_birthdays", "personal_notes", "upkeep_items",
  "movies", "grocery_items", "saved_recipes",
  "affirmations", "dream_items",
  "workout_templates", "workout_sessions", "body_weight_log",
  "transactions", "plaid_items",
  "mini_skills", "mini_feed", "miner_samples",
  "alt_state", "alt_flags", "alt_snapshots",
  "stock_state", "stock_flags", "stock_sessions",
  "upstream_runs", "upstream_run_events", "upstream_predictions", "upstream_tell_checks",
  // client_errors joined the record when crash telemetry landed. It belongs in the
  // backup rather than in SKIP below: a crash log holds no credentials, and the
  // history of what broke on which build is exactly the kind of thing you only
  // want after you have lost it.
  "client_errors",
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

function clientIp(event) {
  const h = event.headers || {};
  return String(
    h["x-nf-client-connection-ip"] ||
    (h["x-forwarded-for"] || "").split(",")[0] ||
    h["client-ip"] || "unknown",
  ).trim() || "unknown";
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
// board-work-background.js and hopDenied() in stock-settle-background.js.
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

async function readTable(supabase, table) {
  const first = await supabase.from(table).select("*", { count: "exact" }).range(0, PAGE - 1);
  if (first.error) throw new Error(first.error.message);
  const rows = [...(first.data || [])];
  const total = typeof first.count === "number" ? first.count : null;

  for (;;) {
    // Two stop conditions, and the one that applies depends on whether PostgREST
    // gave us a count. With a count it is authoritative. Without one — some
    // configurations return none — fall back to the short-page rule and be clear
    // in the comment that this is the weaker of the two.
    if (total != null ? rows.length >= total : rows.length % PAGE !== 0) break;
    if (rows.length >= MAX_ROWS) {
      throw new Error(`over ${MAX_ROWS} rows — this export would be truncated, so it is refused instead`);
    }
    const next = await supabase.from(table).select("*").range(rows.length, rows.length + PAGE - 1);
    if (next.error) throw new Error(next.error.message);
    const page = next.data || [];
    if (!page.length) break; // no forward progress; the count check below decides
    rows.push(...page);
  }

  if (total != null && rows.length !== total) {
    throw new Error(`read ${rows.length} of ${total} rows — refusing to report a partial table as a backup`);
  }
  return rows;
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

  try {
    const wanted = TABLES.filter((t) => !SKIP[t]);
    const results = await Promise.all(wanted.map(async (table) => {
      try { return [table, await readTable(supabase, table)]; }
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

    const tables = {};
    const rowCounts = {};
    for (const [table, rows] of results) { tables[table] = rows; rowCounts[table] = rows.length; }

    return json(200, {
      success: true,
      exportedAt: new Date().toISOString(),
      // Counts alongside the data so a restore can be sanity-checked without
      // parsing the whole payload, and so an all-zeros export is obvious.
      rowCounts,
      // Never silently short. Anything left out says so, with the reason.
      skipped: SKIP,
      tables,
    });
  } catch (e) {
    return json(500, { success: false, error: e.message });
  }
};
