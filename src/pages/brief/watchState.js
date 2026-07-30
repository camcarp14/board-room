// ─── Watch This Week: what a row says, and when ───────────────────────────────
// Pure, because every failure mode here is a sentence that is quietly wrong
// rather than an exception. The one that shipped: a row whose event had already
// happened rendered "Number's not out yet — check back after the print lands",
// and kept rendering it, because the calendar feed has no `actual` field and
// never would (see netlify/functions/calendar.js). Ten hours after the FOMC
// decision the card was still asking you to check back, and two of those three
// rows — the statement and the press conference — had no number to wait for in
// the first place.
//
// So the states are explicit, and each one owns its own copy:
//
//   upcoming    it hasn't happened; show the forward-looking lean
//   settling    it just happened; the number is due, don't spend a lookup yet
//   looking     a lookup is in flight
//   released    we have the figure that printed
//   landed      it happened and there was never going to be a figure
//   unresolved  it happened, a figure was expected, and we couldn't confirm it
//   blocked     the lookup isn't available (not deployed / no API key)
//
// "unresolved" is the state the old card was missing. It is allowed to say we
// don't know. It is not allowed to imply the number hasn't printed.
//
// Asserted by scripts/watch-smoke.mjs (npm run smoke:watch).

/** Grace period after the scheduled time before a lookup is worth spending. */
export const RESULT_SETTLE_MS = 10 * 60 * 1000;
/** How long the card waits for the background resolver before it stops saying
 *  "checking" and settles. Resolution runs off the request path now, so this is a
 *  patience budget, not a retry budget — nothing is re-paid for when it lapses. */
export const POLL_EVERY_MS = 20 * 1000;
export const POLL_MAX = 9; // ≈3 minutes, then the row settles for good
/** A claim older than this was orphaned by a crashed invocation, so the row must
 *  stop reading as in-flight rather than pulse forever waiting on a dead worker. */
export const CLAIM_STALE_MS = 5 * 60 * 1000;

/** The event's identity. Server-provided; the fallback covers an older payload. */
export const eventId = (e) => e?.id || `${e?.at || ""}|${e?.title || e?.text || ""}`;

/**
 * Key for a FORWARD-looking take: identity plus the numbers it was written
 * against, so a revised forecast regenerates the lean. Resolved results are
 * keyed on identity alone — what printed doesn't change when the forecast is
 * revised after the fact.
 */
export const takeKey = (e) => `${eventId(e)}|${e?.forecast ?? ""}|${e?.previous ?? ""}`;

/**
 * Has this event happened, by the browser's clock?
 *
 * Deliberately NOT the server's isPast: calendar.js caches for 20 minutes, so a
 * server-stamped flag can be a third of an hour behind — long enough to still
 * be showing a forward-looking guess for a print that already landed.
 */
export function hasPassed(e, now = Date.now()) {
  const t = Date.parse(e?.at || "");
  return Number.isFinite(t) ? t <= now : !!e?.isPast;
}

/** Past the grace period, so a lookup has something to find. */
export function isSettled(e, now = Date.now()) {
  const t = Date.parse(e?.at || "");
  if (!Number.isFinite(t)) return !!e?.isPast; // no timestamp to reason about — fall back to the feed's word
  return now - t >= RESULT_SETTLE_MS;
}

/** Does a figure exist for this row, ever? calendar.js decides; default yes. */
export const expectsNumber = (e) => e?.numeric !== false;

/**
 * The event line. Rebuilt client-side rather than using the server's `text`
 * because the actual arrives later, from somewhere else, and has to lead.
 */
export function displayLine(e, actual) {
  const bits = [e?.title, actual ? `actual ${actual}` : null, e?.forecast ? `forecast ${e.forecast}` : null, e?.previous ? `prior ${e.previous}` : null].filter(Boolean);
  return bits.length > 1 || e?.title ? bits.join(" — ") : (e?.text || "");
}

/**
 * event + resolved result + forward take → everything the row renders.
 *
 * `result` is what netlify/functions/econ-result.js returned for this event, or
 * the string "loading", or undefined. `take` is the forward-looking take for an
 * upcoming event ("loading" / "error" / text), and is ignored once it's passed.
 */
export function watchRowState(e, result, take, now = Date.now()) {
  const r = result && typeof result === "object" ? result : null;
  const loading = result === "loading";

  if (!hasPassed(e, now)) {
    return {
      phase: "upcoming",
      badge: null,
      bg: "var(--surface-2)",
      line: displayLine(e, null),
      note: take && take !== "loading" && take !== "error" ? take
        : take === "error" ? "Couldn't get a read on this one."
        : "Reading the likely impact…",
      pulse: !take || take === "loading",
    };
  }

  if (r?.status === "released" && r.actual) {
    return { phase: "released", badge: "Result", badgeColor: "var(--green)", bg: "var(--green-a06)", line: displayLine(e, r.actual), note: r.take || "Printed.", pulse: false };
  }

  if (r?.status === "no_number") {
    return { phase: "landed", badge: "Landed", badgeColor: "var(--sub)", bg: "var(--surface-2)", line: displayLine(e, null), note: r.take || "Happened — no figure to publish.", pulse: false };
  }

  if (r?.status === "blocked") {
    return { phase: "blocked", badge: "Landed", badgeColor: "var(--sub)", bg: "var(--surface-2)", line: displayLine(e, null), note: `Happened — ${r.detail || "the result lookup isn't available"}.`, pulse: false };
  }

  // Everything below is "it happened and we don't have the answer yet".
  //
  // ONLY A LOOKUP GENUINELY IN FLIGHT PULSES. Three separate states used to
  // animate — in-flight, waiting-to-retry, and within the settle window — which
  // made a dead lookup indistinguishable from a live one. Every failure looked
  // like loading, forever, and that is precisely what shipped broken.
  const claimLive = r?.status === "claimed" && now - (r.at || 0) < CLAIM_STALE_MS;
  if (loading || claimLive) {
    return { phase: "looking", badge: "Awaiting", badgeColor: "var(--faint)", bg: "var(--surface-2)", line: displayLine(e, null), note: "Checking what printed…", pulse: true };
  }

  if (!isSettled(e, now)) {
    return { phase: "settling", badge: "Awaiting", badgeColor: "var(--faint)", bg: "var(--surface-2)", line: displayLine(e, null), note: "Due any minute — checking as soon as it lands.", pulse: true };
  }

  // Terminal. Reached when the resolver recorded `unresolved`, when a claim went
  // stale, or when the card ran out of patience — and it is STILL, because a
  // motionless row is how you tell "we don't know" from "still working".
  return {
    phase: "unresolved",
    badge: "Unconfirmed", badgeColor: "var(--faint)", bg: "var(--surface-2)",
    line: displayLine(e, null),
    // The honest end state, and the whole point of this file: it happened, and
    // we could not establish the result. Never "check back after the print".
    note: expectsNumber(e) ? "Happened — couldn't confirm the published number." : "Happened — nothing published to read.",
    pulse: false,
  };
}
