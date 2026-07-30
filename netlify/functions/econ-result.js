// One economic event that has already happened → what actually printed, and a
// one-clause read on it. This is the missing half of "Watch This Week".
//
// The free weekly feed calendar.js pulls has no `actual` field at all (see the
// note at the top of that file), so nothing in the app could ever say how a
// release landed: every past event sat on "Number's not out yet — check back
// after the print lands" until it aged out of the window, twelve hours later,
// still saying it. There is no second keyless feed that carries US actuals, so
// the number gets looked up the same way a person would — one web-searched
// Claude call, per event, cached.
//
// ONE EVENT PER INVOCATION, deliberately. Netlify's synchronous functions get
// ~10 seconds; a single search-and-answer fits in that, a batch of eight does
// not. The client fans out across the past events on the card and caches each
// verdict — a released figure never changes, so it is resolved once, ever.
//
// SPEND. Sonnet 5 with at most 2 searches is roughly $0.02 plus a few hundred
// tokens per event; high/medium USD events run ~10–16 a week and each resolves
// once, so this is cents a week. It is still real money leaving the owner's
// account, so: a session is required, events that haven't happened yet are
// refused outright, and a resolved verdict is cached rather than re-asked.
//
// THE ONE RULE THE PROMPT ENFORCES: never present the forecast as the actual.
// That confusion is exactly the bug this card already had once (a pre-event
// guess rendered as if it were the result), and it is worse than "no number".
import { searchCall, MODELS, parseJsonLoose } from "../lib/upstream/llm.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Netlify kills a synchronous function at ~10s with an opaque 502 and an HTML
// body. Give up just under that so the caller gets JSON it can read and retry
// from, instead of a wall it can't tell apart from a broken deploy.
const STAGE_MS = 8500;

const RESOLVED_TTL = 12 * 3600 * 1000; // a printed figure doesn't change; this is just instance hygiene
const PENDING_TTL = 10 * 60 * 1000;    // not out yet → let the next look actually look
const MAX_AGE_MS = 14 * 86400 * 1000;  // older than the feed's own reach; nothing legitimate asks
const cache = new Map(); // id -> { ts, ttl, body }
const CACHE_MAX = 200;

function cacheGet(id) {
  const hit = cache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.ts > hit.ttl) { cache.delete(id); return null; }
  return hit.body;
}

function cachePut(id, body, ttl) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // oldest insert first
  cache.set(id, { ts: Date.now(), ttl, body });
}

/** Trim a model answer down to the one clause the card has room for. */
function oneClause(s) {
  const t = String(s ?? "").replace(/\s+/g, " ").replace(/^["'`*\s]+|["'`*\s]+$/g, "").trim();
  return t.length > 180 ? `${t.slice(0, 177).trimEnd()}…` : t;
}

/**
 * Fold whatever the model returned into exactly three outcomes.
 *
 * Exported because this is where the "don't show a forecast as a result"
 * guarantee lives, and it must be assertable without an API key:
 *   released  → we have a figure we can print. Requires a non-empty actual.
 *   no_number → nothing numeric was ever coming (statement, presser, speech),
 *               but we know what happened.
 *   pending   → the honest "we could not establish it". Never carries a figure.
 */
export function normalizeVerdict(parsed, { numeric } = {}) {
  const take = oneClause(parsed?.take);
  const actualRaw = parsed?.actual;
  const actual = actualRaw == null || actualRaw === "" || /^(null|n\/?a|unknown|tbd|—|-)$/i.test(String(actualRaw).trim())
    ? null
    : String(actualRaw).trim().slice(0, 40);
  const claimed = String(parsed?.status ?? "").toLowerCase();

  // A "released" verdict with no figure is not a release — it's either an event
  // with nothing to print, or a failed lookup wearing a confident label.
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

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "invalid JSON" }); }

  const key = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
  if (body?.ping) {
    return json(200, { success: true, service: "econ-result", configured: !!key, missing: key ? undefined : "ANTHROPIC_API_KEY" });
  }
  if (!key) return json(500, { success: false, error: "ANTHROPIC_API_KEY is not set on this site" });

  // Same posture as claude.js / fetch-page.js: whenever the service key is set,
  // a valid session is required before spending the owner's API key. Without
  // this, a public domain is hosting a web-search-enabled LLM on someone's card.
  const supaUrl = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supaUrl && service) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { success: false, error: "sign in first" });
    const who = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!who.ok) return json(401, { success: false, error: "session expired — refresh and try again" });
  }

  const title = String(body?.title ?? "").trim().slice(0, 160);
  const at = String(body?.at ?? "").trim();
  const t = Date.parse(at);
  if (!title) return json(400, { success: false, error: "title is required" });
  if (!Number.isFinite(t)) return json(400, { success: false, error: "at must be an ISO timestamp" });

  const now = Date.now();
  // Spend guards, not politeness: an upcoming event has nothing to look up, and
  // an ancient one isn't on any card that could have asked for it.
  if (t > now) return json(400, { success: false, error: "that event hasn't happened yet" });
  if (now - t > MAX_AGE_MS) return json(400, { success: false, error: "that event is too old to resolve" });

  const id = `${new Date(t).toISOString()}|${title}`;
  const hit = cacheGet(id);
  if (hit) return json(200, { ...hit, cached: true });

  const numeric = body?.numeric !== false;
  const forecast = String(body?.forecast ?? "").trim() || null;
  const previous = String(body?.previous ?? "").trim() || null;
  const when = new Date(t).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

  const user = [
    `Event: ${title}`,
    `Released: ${when} America/Chicago`,
    `Forecast published beforehand: ${forecast ?? "none"}`,
    `Prior reading: ${previous ?? "none"}`,
    numeric ? "This release is expected to carry a figure." : "This release does not carry a figure — report what was decided or said.",
  ].join("\n");

  try {
    // One search, low effort. Not thrift for its own sake — the whole call has
    // to land inside STAGE_MS, and a second search round-trip is what pushes it
    // past that. "Federal Funds Rate, July 29 2026" is a one-search question;
    // when it genuinely isn't, the caller retries.
    //
    // maxTokens is deliberately far above what a two-field JSON answer needs.
    // Sonnet 5 runs adaptive thinking whenever `thinking` is unset — which
    // searchCall never sets — and max_tokens caps thinking AND response text
    // together. Size it for the answer alone and the thinking eats the budget,
    // which surfaces as searchCall's own TRUNCATED throw rather than a short
    // answer. It's a ceiling, not a target: `effort: "low"` is what actually
    // keeps the spend down.
    const res = await searchCall({
      model: MODELS.sonnet,
      system: systemPrompt(new Date(now).toISOString().slice(0, 10)),
      user,
      maxUses: 1,
      maxTokens: 4000,
      effort: "low",
      timeoutMs: STAGE_MS,
    });
    const verdict = normalizeVerdict(parseJsonLoose(res.text) ?? parseJsonLoose(res.lastText), { numeric });
    const payload = {
      success: true,
      id,
      ...verdict,
      searches: res.searchCount,
      resolvedAt: new Date().toISOString(),
    };
    cachePut(id, payload, verdict.status === "pending" ? PENDING_TTL : RESOLVED_TTL);
    return json(200, payload);
  } catch (e) {
    // Never cache a failure: a timeout says nothing about whether the number is
    // out, and the caller's own retry ceiling is what stops this from looping.
    const code = e?.code || "LOOKUP_FAILED";
    return json(502, { success: false, error: code === "STAGE_TIMEOUT" ? "the lookup ran out of time — will retry" : String(e?.message || e), code });
  }
};
