// ─── Resolving what an economic release actually printed ──────────────────────
// Replaces econ-result.js, which was synchronous and never once succeeded. Every
// call it made died on its own 8.5s stage timeout — usage_log recorded fifteen
// consecutive failures at 8.8s, 15.7s and one at 30.8s — because a web search
// plus an answer genuinely takes 10-20 seconds. Worse, an aborted call is still a
// billed call: we paid for roughly fifteen searches and displayed nothing.
//
// TWO THINGS WERE WRONG, and only one of them was the timeout.
//
//   1. It ran on the request path. A synchronous Netlify function has seconds;
//      this work needs tens of seconds. "-background" gets fifteen minutes, so
//      the deadline stops being the design constraint.
//
//   2. It resolved per event, PER DEVICE, PER PAGE LOAD, with retries. The same
//      FOMC print was looked up again on the phone, again on the desktop, and
//      again on every reload — and up to four times each when it failed. The
//      answer to "what did CPI print" is the same for everyone forever, so it
//      should be paid for exactly once.
//
// So verdicts are written to app_settings.econ_results, keyed by event identity,
// and every client reads that. Resolution happens once per event, ever.
//
// WHY app_settings AND NOT A NEW TABLE: this repo has no migration pipeline —
// SQL is pasted into the Supabase editor by hand — and a feature that needs a
// manual DDL step before it works is a feature that silently doesn't. The tally
// is one JSON row, read-modify-written by this function alone, pruned to the
// newest RESULT_KEEP entries so it can't grow without bound.
//
// THE SPEND CEILING, deliberately structural rather than a promise:
//   · MAX_PER_RUN events resolved per invocation
//   · a verdict is never re-asked — including a failed one, which is recorded as
//     `unresolved` so it costs nothing a second time
//   · one trigger per page load, not one call per event
//   · CLAIM-BEFORE-WORK: rows are marked in-flight and saved BEFORE any model
//     call, so two overlapping triggers can't both pay for the same event
// High/medium USD events run 10-16 a week. At one search plus a short answer
// each, that is cents a week, and it does not multiply by devices or reloads.
import { searchCall, MODELS, parseJsonLoose } from "../lib/upstream/llm.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const RESULT_KEY = "econ_results";
export const RESULT_KEEP = 60;      // newest verdicts retained in the settings row
export const MAX_PER_RUN = 6;       // hard ceiling on model calls per invocation
export const CLAIM_STALE_MS = 5 * 60 * 1000; // an in-flight claim older than this was orphaned by a crash
const PER_EVENT_MS = 90_000;        // generous: we are off the request path now
const MAX_AGE_MS = 14 * 86400 * 1000;

/**
 * Which of these events still need paying for?
 *
 * Exported and pure because this is where the spend ceiling actually lives, and
 * a ceiling nothing asserts is a wish. Anything already carrying a verdict — a
 * figure, a "nothing to print", or a recorded failure — is skipped. So is
 * anything another invocation claimed in the last few minutes.
 */
export function selectUnresolved(events, store, now = Date.now()) {
  const out = [];
  for (const e of events || []) {
    if (!e?.id || !e?.title) continue;
    const t = Date.parse(e.at || "");
    if (!Number.isFinite(t) || t > now || now - t > MAX_AGE_MS) continue;
    const prior = store?.[e.id];
    if (prior?.status && prior.status !== "claimed") continue;               // already answered, or already failed
    if (prior?.status === "claimed" && now - (prior.at || 0) < CLAIM_STALE_MS) continue; // in flight elsewhere
    out.push(e);
    if (out.length >= MAX_PER_RUN) break;
  }
  return out;
}

/** Keep the newest RESULT_KEEP verdicts. The row is a cache, not an archive. */
export function pruneStore(store) {
  const entries = Object.entries(store || {});
  if (entries.length <= RESULT_KEEP) return store || {};
  // Event ids lead with an ISO instant, so a plain string sort is chronological.
  entries.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  return Object.fromEntries(entries.slice(0, RESULT_KEEP));
}

/** Trim a model answer to the one clause the card has room for. */
function oneClause(s) {
  const t = String(s ?? "").replace(/\s+/g, " ").replace(/^["'`*\s]+|["'`*\s]+$/g, "").trim();
  return t.length > 180 ? `${t.slice(0, 177).trimEnd()}…` : t;
}

/**
 * Fold whatever the model returned into exactly three outcomes.
 *
 * This is where the "never show a forecast as a result" guarantee lives:
 *   released  → we have a figure. Requires a non-empty actual.
 *   no_number → nothing numeric was ever coming, but we know what happened.
 *   pending   → we could not establish it. Never carries a figure.
 */
export function normalizeVerdict(parsed, { numeric } = {}) {
  const take = oneClause(parsed?.take);
  const raw = parsed?.actual;
  const actual = raw == null || raw === "" || /^(null|n\/?a|unknown|tbd|—|-)$/i.test(String(raw).trim())
    ? null
    : String(raw).trim().slice(0, 40);
  const claimed = String(parsed?.status ?? "").toLowerCase();

  if (claimed === "released" && actual) return { status: "released", actual, take };
  if (claimed === "no_number" || (claimed === "released" && !actual && numeric === false)) {
    return { status: "no_number", actual: null, take };
  }
  if (claimed === "released" && !actual && take) return { status: "no_number", actual: null, take };
  return { status: "pending", actual: null, take: "" };
}

function systemPrompt(todayISO) {
  return `You look up the result of ONE US economic calendar event that has already passed, and report it. Today is ${todayISO}. Search the web for what was actually published or said.

Rules, in order of importance:
1. NEVER report the forecast, the consensus, or the prior as the actual. If you cannot find the published figure in a search result, the status is "pending" — that is a correct and useful answer.
2. Never estimate, round, or reconstruct a figure. Report it as published (e.g. "3.75%", "228K", "-0.2%").
3. If this release has no figure by nature — a statement, a press conference, a speech, meeting minutes, an auction, a holiday — the status is "no_number", and the take says what was actually decided or said.
4. Make sure the result you found is for THIS release date, not a neighbouring month's.

Reply with ONLY a JSON object. No prose, no markdown fence:
{"status":"released"|"no_number"|"pending","actual":"the published figure, or null","take":"ONE terse clause, 14 words max, on how it landed and the read for Bitcoin and equities — lead with beat/miss/in line, or with what was decided. No labels, no hedging, no disclaimers."}`;
}

/* ── Supabase, service-role, server-side only ─────────────────────────────── */
const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function verifyUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  return u?.id || null;
}

async function readStore(userId) {
  const url = `${SUPA}/rest/v1/app_settings?select=setting_value&user_id=eq.${userId}&setting_key=eq.${RESULT_KEY}`;
  const res = await fetch(url, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Accept-Profile": "boardroom" } });
  if (!res.ok) return {};
  const rows = await res.json().catch(() => []);
  const v = rows?.[0]?.setting_value;
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

async function writeStore(userId, store) {
  await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=user_id,setting_key`, {
    method: "POST",
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json", "Content-Profile": "boardroom",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ user_id: userId, setting_key: RESULT_KEY, setting_value: store, updated_at: new Date().toISOString() }),
  });
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: "invalid JSON" }); }

  const key = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
  if (body?.ping) return json(200, { success: true, service: "econ-resolve-background", configured: !!(key && SUPA && SERVICE), missing: key ? (SUPA && SERVICE ? undefined : "SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY") : "ANTHROPIC_API_KEY" });
  if (!key || !SUPA || !SERVICE) return json(500, { error: "server is missing ANTHROPIC_API_KEY or the Supabase service credentials" });

  // Header first: callFn() in lib/functions.js already attaches the session as
  // `Authorization: Bearer …` on every request, so reading only body.accessToken
  // (which the upstream worker happens to use) would have 401'd every trigger and
  // left the card pulsing exactly as before — a silent no-op wearing a fix.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || String(body?.accessToken || "");
  const userId = await verifyUser(token);
  if (!userId) return json(401, { error: "sign in first" });

  const store = await readStore(userId);
  const todo = selectUnresolved(body?.events, store);
  if (!todo.length) return json(202, { accepted: 0 });

  // CLAIM FIRST. Written before a single model call so a second trigger — another
  // device, a fast reload — sees these as in flight and doesn't pay for them too.
  const now = Date.now();
  for (const e of todo) store[e.id] = { status: "claimed", at: now };
  await writeStore(userId, pruneStore(store));

  // Netlify returns this 202 to the client immediately; the work below keeps
  // running in the background invocation.
  for (const e of todo) {
    const t = Date.parse(e.at);
    const when = new Date(t).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    const numeric = e.numeric !== false;
    const user = [
      `Event: ${e.title}`,
      `Released: ${when} America/Chicago`,
      `Forecast published beforehand: ${e.forecast || "none"}`,
      `Prior reading: ${e.previous || "none"}`,
      numeric ? "This release is expected to carry a figure." : "This release does not carry a figure — report what was decided or said.",
    ].join("\n");

    try {
      const res = await searchCall({
        model: MODELS.sonnet,
        system: systemPrompt(new Date().toISOString().slice(0, 10)),
        user,
        maxUses: 2,
        maxTokens: 4000,
        effort: "low",
        timeoutMs: PER_EVENT_MS,
      });
      const v = normalizeVerdict(parseJsonLoose(res.text) ?? parseJsonLoose(res.lastText), { numeric });
      // A "pending" answer is recorded as `unresolved`, not left blank. The model
      // searched and could not find the figure; asking again tomorrow costs money
      // to be told the same thing. This is the difference between a bounded cost
      // and the retry loop that burned fifteen searches for nothing.
      store[e.id] = v.status === "pending"
        ? { status: "unresolved", at: Date.now() }
        : { ...v, at: Date.now() };
    } catch (err) {
      console.error("econ-resolve failed for", e.id, err?.message || err);
      store[e.id] = { status: "unresolved", at: Date.now(), detail: String(err?.message || err).slice(0, 120) };
    }
    // Save after each one: a crash halfway through keeps what it already paid for.
    await writeStore(userId, pruneStore(store));
  }

  return json(202, { accepted: todo.length });
};
