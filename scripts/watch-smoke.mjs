// ─── Watch This Week smoke — the post-event states, with known answers ────────
// This card shipped a sentence that was permanently false: an event that had
// already happened rendered "Number's not out yet — check back after the print
// lands", and went on rendering it, because the free econ feed has no `actual`
// field and never would. Ten hours after the FOMC decision the card was still
// asking you to check back; the statement and the press conference had no number
// to wait for at all.
//
// Nothing about that throws. It builds, it deploys, it renders, it lies. So the
// state machine is pure (src/pages/brief/watchState.js) and the copy for each
// state is asserted here — including the two rules that matter most:
//
//   1. a "released" verdict without a figure is NEVER shown as a result
//   2. an event that has happened NEVER says "check back after the print lands"
//
// Run by `npm run verify`.

import { eventId, takeKey, hasPassed, isSettled, displayLine, watchRowState, expectsNumber, RESULT_SETTLE_MS, CLAIM_STALE_MS } from "../src/pages/brief/watchState.js";
import { normalizeVerdict, selectUnresolved, pruneStore, MAX_PER_RUN, RESULT_KEEP } from "../netlify/functions/econ-resolve-background.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const NOW = Date.parse("2026-07-29T23:37:00-05:00"); // the moment in the screenshot
const min = (n) => n * 60000;
const at = (ms) => new Date(NOW + ms).toISOString();

// The three rows from that screenshot, as calendar.js now emits them.
const funds = { id: `${at(-min(637))}|Federal Funds Rate`, at: at(-min(637)), title: "Federal Funds Rate", forecast: "3.75%", previous: "3.75%", numeric: true, text: "Federal Funds Rate — forecast 3.75% — prior 3.75%" };
const statement = { id: `${at(-min(637))}|FOMC Statement`, at: at(-min(637)), title: "FOMC Statement", forecast: null, previous: null, numeric: false, text: "FOMC Statement" };
const presser = { id: `${at(-min(607))}|FOMC Press Conference`, at: at(-min(607)), title: "FOMC Press Conference", forecast: null, previous: null, numeric: false, text: "FOMC Press Conference" };
const cpiTomorrow = { id: `${at(min(600))}|Core CPI m/m`, at: at(min(600)), title: "Core CPI m/m", forecast: "0.3%", previous: "0.2%", numeric: true, text: "Core CPI m/m — forecast 0.3% — prior 0.2%" };

// ─── 0. identity ──────────────────────────────────────────────────────────────
check("id survives a forecast revision", eventId({ ...funds, forecast: "4.00%" }) === eventId(funds));
check("take key does NOT survive a forecast revision", takeKey({ ...funds, forecast: "4.00%" }) !== takeKey(funds));
check("id falls back to at|title with no server id", eventId({ at: "2026-07-29T18:00:00.000Z", title: "X" }) === "2026-07-29T18:00:00.000Z|X");

// ─── 1. passed / settled, on the browser's clock ──────────────────────────────
check("a past event has passed", hasPassed(funds, NOW));
check("a future event has not", !hasPassed(cpiTomorrow, NOW));
check("`at` beats a stale server isPast", !hasPassed({ at: at(min(30)), isPast: true }, NOW));
check("no `at` falls back to the feed's isPast", hasPassed({ isPast: true }, NOW) && !hasPassed({ isPast: false }, NOW));
check("just-passed is not yet settled", !isSettled({ at: at(-min(3)) }, NOW));
check("past the grace period is settled", isSettled({ at: at(-(RESULT_SETTLE_MS + 1000)) }, NOW));

// ─── 2. THE REGRESSION. Nothing that happened says "check back". ──────────────
const passedRows = [
  ["numeric, nothing known", watchRowState(funds, undefined, undefined, NOW)],
  ["numeric, lookup in flight", watchRowState(funds, "loading", undefined, NOW)],
  ["numeric, claim in flight", watchRowState(funds, { status: "claimed", at: NOW - 1000 }, undefined, NOW)],
  ["numeric, resolver gave up", watchRowState(funds, { status: "unresolved", at: NOW - 1000 }, undefined, NOW)],
  ["numeric, claim orphaned by a crash", watchRowState(funds, { status: "claimed", at: NOW - CLAIM_STALE_MS - 1 }, undefined, NOW)],
  ["non-numeric, nothing known", watchRowState(statement, undefined, undefined, NOW)],
  ["non-numeric, resolved", watchRowState(presser, { status: "no_number", take: "Powell kept optionality; no cut signalled." }, undefined, NOW)],
  ["numeric, released", watchRowState(funds, { status: "released", actual: "3.75%", take: "Held at 3.75% — in line, muted." }, undefined, NOW)],
];
for (const [label, row] of passedRows) {
  check(`${label} → no "check back"`, !/check back/i.test(row.note), row.note);
  check(`${label} → says something`, !!row.note && row.note.length > 4, row.note);
}
// The specific sentence that was wrong, gone for good.
check("the old copy is unreachable for a passed event",
  !passedRows.some(([, r]) => /not out yet/i.test(r.note)));
// ...and still correct for one that hasn't happened: no result state at all.
check("an upcoming row shows the forward lean", watchRowState(cpiTomorrow, undefined, "Hot print risks risk-off; both lower.", NOW).note === "Hot print risks risk-off; both lower.");
check("an upcoming row has no badge", watchRowState(cpiTomorrow, undefined, "x", NOW).badge === null);
check("an upcoming row ignores a stray result", watchRowState(cpiTomorrow, { status: "released", actual: "9.9%" }, "x", NOW).line === displayLine(cpiTomorrow, null));

// ─── 3. each state's badge and phase ──────────────────────────────────────────
check("released → Result", watchRowState(funds, { status: "released", actual: "3.75%", take: "t" }, undefined, NOW).badge === "Result");
check("released shows the actual first", displayLine(funds, "3.75%").startsWith("Federal Funds Rate — actual 3.75% — forecast"));
check("no figure coming → Landed, not Awaiting", watchRowState(statement, { status: "no_number", take: "t" }, undefined, NOW).badge === "Landed");
check("resolver gave up → Unconfirmed", watchRowState(funds, { status: "unresolved" }, undefined, NOW).badge === "Unconfirmed");
check("unresolved, numeric → names the missing number",
  /couldn't confirm the published number/i.test(watchRowState(funds, { status: "unresolved" }, undefined, NOW).note));
check("unresolved, non-numeric → doesn't mention a number",
  !/number/i.test(watchRowState(statement, { status: "unresolved" }, undefined, NOW).note));

// ─── THE REGRESSION THAT PROMPTED THIS FILE'S SECOND PASS ────────────────────
// Three states used to pulse — in flight, waiting to retry, and inside the
// settle window — so a lookup that had died looked exactly like one still
// working. Every failure read as "stuck loading", because that is what it was.
// Exactly one state may animate now: a lookup genuinely in flight.
check("a live claim pulses", watchRowState(funds, { status: "claimed", at: NOW - 1000 }, undefined, NOW).pulse === true);
check("an orphaned claim does NOT pulse",
  watchRowState(funds, { status: "claimed", at: NOW - CLAIM_STALE_MS - 1 }, undefined, NOW).pulse === false);
check("an orphaned claim settles on Unconfirmed",
  watchRowState(funds, { status: "claimed", at: NOW - CLAIM_STALE_MS - 1 }, undefined, NOW).badge === "Unconfirmed");
check("giving up does NOT pulse", watchRowState(funds, { status: "unresolved" }, undefined, NOW).pulse === false);
check("no verdict and no live poll does NOT pulse",
  watchRowState(funds, { status: "unresolved" }, undefined, NOW).pulse === false);
check("only in-flight animates", (() => {
  const terminal = [{ status: "unresolved" }, { status: "released", actual: "3.75%", take: "t" }, { status: "no_number", take: "t" }];
  return terminal.every((r) => watchRowState(funds, r, undefined, NOW).pulse === false);
})());
check("in flight pulses", watchRowState(funds, "loading", undefined, NOW).pulse === true);
check("released does not pulse", watchRowState(funds, { status: "released", actual: "3.75%", take: "t" }, undefined, NOW).pulse === false);
check("just-passed → settling copy", /due any minute/i.test(watchRowState({ ...funds, at: at(-min(2)) }, undefined, undefined, NOW).note));
check("lookup unavailable → says why, still Landed", (() => {
  const r = watchRowState(funds, { status: "blocked", detail: "the result lookup isn't deployed yet" }, undefined, NOW);
  return r.badge === "Landed" && /isn't deployed yet/.test(r.note);
})());
check("expectsNumber reads the feed's classification", expectsNumber(funds) && !expectsNumber(statement) && expectsNumber({}));

// ─── 4. the server's verdict guard — a forecast is never a result ─────────────
check("released with a figure stands", (() => {
  const v = normalizeVerdict({ status: "released", actual: "3.75%", take: "Held — in line." }, { numeric: true });
  return v.status === "released" && v.actual === "3.75%";
})());
check("released with NO figure is not a result", (() => {
  const v = normalizeVerdict({ status: "released", actual: null, take: "Held at 3.75%." }, { numeric: true });
  return v.status !== "released" && v.actual === null;
})());
for (const junk of ["", null, "null", "N/A", "n/a", "unknown", "TBD", "—", "-"]) {
  const v = normalizeVerdict({ status: "released", actual: junk, take: "t" }, { numeric: true });
  check(`"${junk}" is not a figure`, v.actual === null && v.status !== "released");
}
check("pending never carries a figure or a take", (() => {
  const v = normalizeVerdict({ status: "pending", actual: "3.75%", take: "made up" }, { numeric: true });
  return v.status === "pending" && v.actual === null && v.take === "";
})());
check("garbage in → pending", (() => {
  const v = normalizeVerdict(null, { numeric: true });
  return v.status === "pending" && v.actual === null;
})());
check("no_number keeps its take", normalizeVerdict({ status: "no_number", actual: null, take: "Powell held the line." }, { numeric: false }).take === "Powell held the line.");
check("a non-numeric event claimed 'released' with no figure becomes no_number",
  normalizeVerdict({ status: "released", actual: null, take: "Statement kept the door open." }, { numeric: false }).status === "no_number");
check("a long take is capped at 180 chars", normalizeVerdict({ status: "no_number", take: "x".repeat(400) }, { numeric: false }).take.length <= 180);
check("whitespace and newlines collapse to one line", normalizeVerdict({ status: "no_number", take: " held  the\n line " }, { numeric: false }).take === "held the line");
check("surrounding quotes are stripped", normalizeVerdict({ status: "no_number", take: `"held the line"` }, { numeric: false }).take === "held the line");

// ─── 5. the spend ceiling ────────────────────────────────────────────────────
// The old design paid per event, per device, per page load, with up to four
// retries — and every retry was billed even though it timed out. usage_log
// recorded fifteen consecutive paid failures. These are the caps that replaced
// it, asserted here because a ceiling nothing checks is a wish.
const past = (n) => new Date(NOW - n * 60000).toISOString();
const ev = (id, mins = 60) => ({ id: `${past(mins)}|${id}`, title: id, at: past(mins) });

check("nothing to do when everything is resolved", selectUnresolved(
  [ev("a"), ev("b")],
  { [ev("a").id]: { status: "released", actual: "1%" }, [ev("b").id]: { status: "no_number" } },
  NOW,
).length === 0);

// The one that stops the bleeding: a lookup that failed is recorded, not retried.
check("an event we already failed to resolve is never re-asked",
  selectUnresolved([ev("a")], { [ev("a").id]: { status: "unresolved" } }, NOW).length === 0);

check("a fresh claim is left to the invocation that owns it",
  selectUnresolved([ev("a")], { [ev("a").id]: { status: "claimed", at: NOW - 1000 } }, NOW).length === 0);
check("a stale claim is picked back up", selectUnresolved(
  [ev("a")], { [ev("a").id]: { status: "claimed", at: NOW - CLAIM_STALE_MS - 1 } }, NOW,
).length === 1);

check(`no more than ${MAX_PER_RUN} events are priced out per invocation`,
  selectUnresolved(Array.from({ length: 40 }, (_, i) => ev(`e${i}`)), {}, NOW).length === MAX_PER_RUN);
check("an event that hasn't happened is never looked up",
  selectUnresolved([{ id: "x", title: "x", at: new Date(NOW + 3600000).toISOString() }], {}, NOW).length === 0);
check("an ancient event is not looked up",
  selectUnresolved([ev("old", 60 * 24 * 20)], {}, NOW).length === 0);
check("a malformed event is skipped, not sent to the model",
  selectUnresolved([{ title: "no id" }, { id: "no at", title: "t" }, null], {}, NOW).length === 0);
check("a missing event list costs nothing", selectUnresolved(null, {}, NOW).length === 0 && selectUnresolved(undefined, null, NOW).length === 0);

check("the verdict store is pruned to the newest entries", (() => {
  const big = Object.fromEntries(Array.from({ length: RESULT_KEEP + 25 }, (_, i) => [
    `${new Date(NOW - i * 86400000).toISOString()}|e${i}`, { status: "released" },
  ]));
  const kept = pruneStore(big);
  return Object.keys(kept).length === RESULT_KEEP;
})());
check("pruning keeps the NEWEST, not an arbitrary slice", (() => {
  const big = Object.fromEntries(Array.from({ length: RESULT_KEEP + 5 }, (_, i) => [
    `${new Date(NOW - i * 86400000).toISOString()}|e${i}`, { status: "released", i },
  ]));
  const kept = pruneStore(big);
  return Object.values(kept).every((v) => v.i < RESULT_KEEP);
})());
check("a small store is returned untouched", Object.keys(pruneStore({ a: 1 })).length === 1);
check("an empty store prunes to empty", Object.keys(pruneStore(null)).length === 0);

console.log(failed ? `\nWATCH SMOKE FAILED (${failed})` : "\nWATCH SMOKE PASS");
process.exit(failed ? 1 : 0);
