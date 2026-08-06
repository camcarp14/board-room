// ─── Recurrence smoke — the arithmetic a repeating event depends on ─────────
// Recurring events fail quietly and expensively: a rule that drifts by a day
// doesn't throw, it just puts rent on the 3rd. The three classic ways this
// breaks, all pinned here:
//
//   1. MILLISECOND MATH. Stepping a week with +7*864e5 lands an hour off
//      across a DST boundary, and "the 5th of every month" is not a fixed
//      number of ms in the first place. Every step here is a local calendar
//      step, and the DST cases below cross both US transitions.
//   2. MONTH-END ROLLOVER. Date(y, m+1, 31) for a February silently becomes
//      March 3rd. A monthly bill that hops to the 3rd is only noticed after
//      it is missed, so the 31st clamps to the month's own last day.
//   3. DELETING ONE TUESDAY DELETING ALL TUESDAYS. The scope helpers are the
//      whole point of the feature; each returns writes, and the writes are
//      asserted directly.
//
// Zero network, zero DOM. Run with `node scripts/recurrence-smoke.mjs`.

import {
  dayKey, parseDayKey, normalizeRule, occurrenceDays, expandEvents,
  deleteOccurrence, deleteFuture, deleteSeries, editOccurrence, editFuture,
  describeRule,
} from "../src/lib/recurrence.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

// Local noon on purpose: a midnight start would make every DST assertion below
// a test of midnight rather than of the step.
const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm).toISOString();
const ev = (o = {}) => ({
  id: "e1", title: "Thing", notes: "", start_time: at(2026, 8, 3), end_time: null,
  all_day: false, location: "", category: "personal", rrule: null, exdates: [], series_id: null, ...o,
});
const D = (y, m, d) => new Date(y, m - 1, d);

// ─── day keys are LOCAL, not UTC ──────────────────────────────────────────────
check("dayKey reads the local calendar day", dayKey(new Date(2026, 7, 5, 23, 30)) === "2026-08-05");
check("a late-evening date does not roll to tomorrow", dayKey(new Date(2026, 0, 1, 22, 0)) === "2026-01-01");
check("parseDayKey round-trips", dayKey(parseDayKey("2026-03-09")) === "2026-03-09");
check("parseDayKey refuses junk", parseDayKey("nope") === null && parseDayKey("") === null);

// ─── normalizeRule — shapes that cannot terminate are refused ────────────────
check("a null rule is a one-off", normalizeRule(null) === null);
check("an unknown freq is refused", normalizeRule({ freq: "fortnightly" }) === null);
check("interval 0 cannot spin the loop", normalizeRule({ freq: "daily", interval: 0 }).interval === 1);
check("byWeekday is deduped and sorted", normalizeRule({ freq: "weekly", byWeekday: [3, 1, 3] }).byWeekday.join(",") === "1,3");
check("byWeekday is dropped for non-weekly rules", normalizeRule({ freq: "monthly", byWeekday: [1] }).byWeekday.length === 0);
check("out-of-range weekdays are dropped", normalizeRule({ freq: "weekly", byWeekday: [9, -1, 2] }).byWeekday.join(",") === "2");

// ─── daily + interval ────────────────────────────────────────────────────────
const daily = ev({ rrule: { freq: "daily", interval: 1 } });
check("daily fills the window",
  occurrenceDays(daily, D(2026, 8, 3), D(2026, 8, 6)).join(",") === "2026-08-03,2026-08-04,2026-08-05,2026-08-06");
check("nothing before the series starts",
  occurrenceDays(daily, D(2026, 8, 1), D(2026, 8, 4)).join(",") === "2026-08-03,2026-08-04");
check("every 3 days steps by 3",
  occurrenceDays(ev({ rrule: { freq: "daily", interval: 3 } }), D(2026, 8, 3), D(2026, 8, 12)).join(",")
    === "2026-08-03,2026-08-06,2026-08-09,2026-08-12");

// ─── count and until both END the series ─────────────────────────────────────
check("count stops the series at N",
  occurrenceDays(ev({ rrule: { freq: "daily", interval: 1, count: 3 } }), D(2026, 8, 1), D(2026, 8, 30)).length === 3);
check("count is counted from the SERIES start, not from the window",
  // Days 3,4,5 are the three; a window opening on the 5th must see only one.
  occurrenceDays(ev({ rrule: { freq: "daily", interval: 1, count: 3 } }), D(2026, 8, 5), D(2026, 8, 30)).join(",") === "2026-08-05");
check("until is inclusive of its own day",
  occurrenceDays(ev({ rrule: { freq: "daily", interval: 1, until: "2026-08-05" } }), D(2026, 8, 1), D(2026, 8, 30)).join(",")
    === "2026-08-03,2026-08-04,2026-08-05");

// ─── weekly, with and without byWeekday ──────────────────────────────────────
// 2026-08-03 is a Monday.
check("weekly with no byWeekday repeats the start's own weekday",
  occurrenceDays(ev({ rrule: { freq: "weekly", interval: 1 } }), D(2026, 8, 1), D(2026, 8, 31)).join(",")
    === "2026-08-03,2026-08-10,2026-08-17,2026-08-24,2026-08-31");
check("weekly on Mon/Wed/Fri lands on all three",
  occurrenceDays(ev({ rrule: { freq: "weekly", interval: 1, byWeekday: [1, 3, 5] } }), D(2026, 8, 3), D(2026, 8, 9)).join(",")
    === "2026-08-03,2026-08-05,2026-08-07");
check("every 2 weeks skips the odd week",
  occurrenceDays(ev({ rrule: { freq: "weekly", interval: 2 } }), D(2026, 8, 1), D(2026, 9, 15)).join(",")
    === "2026-08-03,2026-08-17,2026-08-31,2026-09-14");
check("a weekday earlier in the start's own week is not emitted before the start",
  // Starts Monday the 3rd, repeats Sun+Mon: the Sunday of that first week (the
  // 2nd) predates the series and must not appear.
  occurrenceDays(ev({ rrule: { freq: "weekly", interval: 1, byWeekday: [0, 1] } }), D(2026, 8, 1), D(2026, 8, 11)).join(",")
    === "2026-08-03,2026-08-09,2026-08-10");

// ─── monthly, and the month-end clamp ────────────────────────────────────────
check("monthly holds the day of month",
  occurrenceDays(ev({ start_time: at(2026, 1, 15), rrule: { freq: "monthly", interval: 1 } }), D(2026, 1, 1), D(2026, 4, 30)).join(",")
    === "2026-01-15,2026-02-15,2026-03-15,2026-04-15");
check("the 31st CLAMPS into February instead of rolling into March",
  occurrenceDays(ev({ start_time: at(2026, 1, 31), rrule: { freq: "monthly", interval: 1 } }), D(2026, 1, 1), D(2026, 3, 31)).join(",")
    === "2026-01-31,2026-02-28,2026-03-31",
  occurrenceDays(ev({ start_time: at(2026, 1, 31), rrule: { freq: "monthly", interval: 1 } }), D(2026, 1, 1), D(2026, 3, 31)).join(","));
check("...and recovers the 31st in the next long month, not the clamped 28th",
  occurrenceDays(ev({ start_time: at(2026, 1, 31), rrule: { freq: "monthly", interval: 1 } }), D(2026, 3, 1), D(2026, 3, 31)).join(",")
    === "2026-03-31");
check("every 2 months steps two",
  occurrenceDays(ev({ start_time: at(2026, 1, 10), rrule: { freq: "monthly", interval: 2 } }), D(2026, 1, 1), D(2026, 6, 30)).join(",")
    === "2026-01-10,2026-03-10,2026-05-10");
check("yearly holds the date, leap day included",
  occurrenceDays(ev({ start_time: at(2028, 2, 29), rrule: { freq: "yearly", interval: 1 } }), D(2028, 1, 1), D(2029, 12, 31)).join(",")
    === "2028-02-29,2029-02-28");

// ─── DST — the reason none of this is millisecond math ───────────────────────
// US spring-forward 2026-03-08, fall-back 2026-11-01. A +7*864e5 step across
// either lands an hour out and, for a late/early event, a DAY out.
check("weekly crosses spring-forward without drifting",
  occurrenceDays(ev({ start_time: at(2026, 3, 1), rrule: { freq: "weekly", interval: 1 } }), D(2026, 3, 1), D(2026, 3, 29)).join(",")
    === "2026-03-01,2026-03-08,2026-03-15,2026-03-22,2026-03-29");
check("daily crosses fall-back without repeating or skipping a day",
  occurrenceDays(ev({ start_time: at(2026, 10, 30), rrule: { freq: "daily", interval: 1 } }), D(2026, 10, 30), D(2026, 11, 3)).join(",")
    === "2026-10-30,2026-10-31,2026-11-01,2026-11-02,2026-11-03");
check("an occurrence keeps its wall-clock time across DST",
  // 9:00am before the change and 9:00am after it — not 8:00 or 10:00.
  expandEvents([ev({ start_time: at(2026, 3, 1, 9, 0), rrule: { freq: "weekly", interval: 1 } })], D(2026, 3, 1), D(2026, 3, 15))
    .every((o) => new Date(o.start_time).getHours() === 9));

// ─── exdates — deleting one Tuesday must not delete Tuesdays ─────────────────
check("an exdate removes exactly one occurrence",
  occurrenceDays(ev({ rrule: { freq: "daily", interval: 1 }, exdates: ["2026-08-04"] }), D(2026, 8, 3), D(2026, 8, 6)).join(",")
    === "2026-08-03,2026-08-05,2026-08-06");
check("an exdate still consumes its slot against `count`",
  // count:3 means three were scheduled; deleting one leaves two, not a
  // silently-extended series that reaches for a fourth.
  occurrenceDays(ev({ rrule: { freq: "daily", interval: 1, count: 3 }, exdates: ["2026-08-04"] }), D(2026, 8, 1), D(2026, 8, 30)).join(",")
    === "2026-08-03,2026-08-05");

// ─── expandEvents — occurrence identity and duration ─────────────────────────
const expanded = expandEvents([ev({ start_time: at(2026, 8, 3, 9, 30), end_time: at(2026, 8, 3, 10, 45), rrule: { freq: "daily", interval: 1 } })], D(2026, 8, 3), D(2026, 8, 5));
check("expansion yields one row per occurrence", expanded.length === 3);
check("each occurrence carries its own day and a synthetic id",
  expanded[1].occurrenceDay === "2026-08-04" && expanded[1].id === "e1@2026-08-04" && expanded[1].masterId === "e1");
check("the master id is preserved for one-offs (nothing to expand)",
  expandEvents([ev()], D(2026, 8, 1), D(2026, 8, 31))[0].id === "e1");
check("duration rides along to every occurrence",
  expanded.every((o) => new Date(o.end_time) - new Date(o.start_time) === 75 * 60 * 1000));
check("time of day rides along too",
  expanded.every((o) => new Date(o.start_time).getHours() === 9 && new Date(o.start_time).getMinutes() === 30));
check("expansion is sorted by start", expanded.map((o) => o.occurrenceDay).join(",") === "2026-08-03,2026-08-04,2026-08-05");
check("a one-off outside the window is not returned",
  expandEvents([ev()], D(2026, 9, 1), D(2026, 9, 30)).length === 0);

// ─── the three editing scopes ────────────────────────────────────────────────
const master = ev({ rrule: { freq: "weekly", interval: 1 }, series_id: "e1" });

const delOne = deleteOccurrence(master, "2026-08-10");
check("deleting one occurrence only adds an exdate",
  delOne.update.length === 1 && delOne.update[0].exdates.join(",") === "2026-08-10" && delOne.delete.length === 0);
check("...and the series still runs around the hole",
  occurrenceDays({ ...master, exdates: delOne.update[0].exdates }, D(2026, 8, 1), D(2026, 8, 24)).join(",")
    === "2026-08-03,2026-08-17,2026-08-24");

const delFut = deleteFuture(master, "2026-08-17");
check("deleting future caps the series the day BEFORE",
  delFut.update[0].rrule.until === "2026-08-16", JSON.stringify(delFut.update[0].rrule));
check("...leaving the earlier occurrences untouched",
  occurrenceDays({ ...master, rrule: delFut.update[0].rrule }, D(2026, 8, 1), D(2026, 8, 31)).join(",")
    === "2026-08-03,2026-08-10");
check("cutting at the first occurrence deletes the row outright, not an unrenderable stub",
  deleteFuture(master, "2026-08-03").delete.join(",") === "e1");

check("deleting the series spans masters split by an earlier future-edit",
  deleteSeries(master, [master, { id: "e2", series_id: "e1" }, { id: "other", series_id: null }]).delete.join(",") === "e1,e2");

const editOne = editOccurrence(master, "2026-08-10", { title: "Moved" }, "new1");
check("editing one occurrence punches it out and writes a standalone row",
  editOne.update[0].exdates.join(",") === "2026-08-10" &&
  editOne.insert.length === 1 && editOne.insert[0].id === "new1" &&
  editOne.insert[0].rrule === null && editOne.insert[0].title === "Moved");

const editFut = editFuture(master, "2026-08-17", { title: "Renamed" }, "new2");
check("editing future caps the old master and starts a new one",
  editFut.update[0].rrule.until === "2026-08-16" &&
  editFut.insert[0].id === "new2" && editFut.insert[0].title === "Renamed");
check("...and the new master stays in the same series",
  editFut.insert[0].series_id === "e1");
check("editing future FROM the first occurrence is just an edit of the whole series",
  editFuture(master, "2026-08-03", { title: "X" }, "new3").insert.length === 0 &&
  editFuture(master, "2026-08-03", { title: "X" }, "new3").update[0].title === "X");

// ─── plain English ───────────────────────────────────────────────────────────
check("a one-off says so", describeRule(null) === "Does not repeat");
check("daily reads plainly", describeRule({ freq: "daily", interval: 1 }) === "Every day");
check("an interval is spelled out", describeRule({ freq: "daily", interval: 3 }) === "Every 3 days");
check("weekly names its days",
  describeRule({ freq: "weekly", interval: 2, byWeekday: [1, 3] }) === "Every 2 weeks on Mon, Wed",
  describeRule({ freq: "weekly", interval: 2, byWeekday: [1, 3] }));
check("count is stated", describeRule({ freq: "daily", interval: 1, count: 5 }).endsWith("· 5 times"));
check("until is stated as a date", describeRule({ freq: "daily", interval: 1, until: "2026-12-01" }).includes("until Dec 1, 2026"));

// ─── the runaway guard ───────────────────────────────────────────────────────
check("a forever rule over a wide window still terminates",
  occurrenceDays(ev({ rrule: { freq: "daily", interval: 1 } }), D(2026, 8, 3), D(2060, 1, 1)).length <= 750);

if (failed) { console.log(`\n${failed} recurrence check(s) failed`); process.exit(1); }
console.log("\nRECURRENCE SMOKE PASS");
