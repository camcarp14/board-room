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

// The zone is pinned. Most of what follows is zone-independent local-calendar
// math, but the UTC-vs-local bugs this file pins (an evening event read as
// tomorrow) only exist west of Greenwich, and a CI box in UTC would pass them
// vacuously. Chicago, because it is the owner's zone and the one every other
// date path is written for (lib/dates.js). Set before any Date is built.
process.env.TZ = "America/Chicago";

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

// ─── "This and all following" must not undo what the user already did ───────
// editFuture used to start the new master with `exdates: []` and the old
// master's full count, and editOccurrence wrote its standalone row with
// series_id null. Reproduced under TZ=America/Chicago: deleted Mondays after
// the split came back, a 10-session series edited from #5 grew to 14, and
// "delete all in series" left every separately-edited occurrence behind.
{
  const all = (rows, f = D(2026, 7, 1), t = D(2027, 6, 30)) => expandEvents(rows, f, t).map((o) => o.occurrenceDay);
  const apply = (rows, plan) => {
    let out = rows.map((r) => {
      const u = (plan.update || []).find((x) => x.id === r.id);
      return u ? { ...r, ...u } : r;
    });
    out = out.concat(plan.insert || []);
    return out.filter((r) => !(plan.delete || []).includes(r.id));
  };
  const weekly = ev({ rrule: { freq: "weekly", interval: 1 }, exdates: ["2026-08-10", "2026-08-24"] });

  // (a) deletions on or after the split survive it
  const fa = editFuture(weekly, "2026-08-17", { title: "Renamed", start_time: at(2026, 8, 17) }, "n1");
  check("editFuture carries the exdates on or after the split to the new master",
    fa.insert[0].exdates.join(",") === "2026-08-24", JSON.stringify(fa.insert[0].exdates));
  check("...and a Monday deleted after the split stays deleted",
    !all(apply([weekly], fa), D(2026, 8, 1), D(2026, 9, 7)).includes("2026-08-24")
    && all(apply([weekly], fa), D(2026, 8, 1), D(2026, 9, 7)).join(",") === "2026-08-03,2026-08-17,2026-08-31,2026-09-07",
    all(apply([weekly], fa), D(2026, 8, 1), D(2026, 9, 7)).join(","));
  const fShift = editFuture(weekly, "2026-08-17", { title: "Moved", start_time: at(2026, 8, 18) }, "n2");
  check("...and when the edit moves the occurrence a day, the deletion moves with it",
    fShift.insert[0].exdates.join(",") === "2026-08-25"
    && !all(apply([weekly], fShift), D(2026, 8, 1), D(2026, 9, 8)).includes("2026-08-25"),
    JSON.stringify(fShift.insert[0].exdates));
  {
    const one = editOccurrence(weekly, "2026-08-31", { title: "Special", start_time: at(2026, 8, 31, 15) }, "solo");
    const rows1 = apply([weekly], one);
    const fut = editFuture(rows1[0], "2026-08-17", { title: "Renamed", start_time: at(2026, 8, 17) }, "n3");
    const days = all(apply(rows1, fut), D(2026, 8, 1), D(2026, 9, 7));
    check("...and an occurrence edited on its own is not drawn twice after a later future-edit",
      days.filter((k) => k === "2026-08-31").length === 1, days.join(","));
  }

  // (b) a count-limited series keeps its total across the split
  const ten = ev({ rrule: { freq: "weekly", interval: 1, count: 10 } });
  check("a 10-session weekly series has ten sessions to begin with", all([ten]).length === 10);
  // #5 of the Mondays from Aug 3 is Aug 31. The form hands back the series'
  // own rule, count included, exactly as CalendarPanel does.
  const fb = editFuture(ten, "2026-08-31", { title: "Moved room", start_time: at(2026, 8, 31), rrule: { freq: "weekly", interval: 1, count: 10 } }, "n4");
  check("editFuture from session #5 still yields ten sessions, not fourteen",
    all(apply([ten], fb)).length === 10, String(all(apply([ten], fb)).length));
  check("...the new master carries the six that remain",
    fb.insert[0].rrule.count === 6, JSON.stringify(fb.insert[0].rrule));
  check("...and the old master is capped at the four it already had, by count and by date",
    fb.update[0].rrule.count === 4 && fb.update[0].rrule.until === "2026-08-30"
    && all([{ ...ten, rrule: fb.update[0].rrule }]).length === 4
    && describeRule(fb.update[0].rrule).endsWith("· 4 times"),
    JSON.stringify(fb.update[0].rrule));
  check("...with no rule in the patch the master's own count is converted too",
    editFuture(ten, "2026-08-31", { title: "x", start_time: at(2026, 8, 31) }, "n5").insert[0].rrule.count === 6);
  check("...a deleted session before the split still used up its slot",
    editFuture({ ...ten, exdates: ["2026-08-10"] }, "2026-08-31", { title: "x", start_time: at(2026, 8, 31) }, "n6").insert[0].rrule.count === 6
    && all(apply([{ ...ten, exdates: ["2026-08-10"] }], editFuture({ ...ten, exdates: ["2026-08-10"] }, "2026-08-31", { title: "x", start_time: at(2026, 8, 31) }, "n6"))).length === 9);
  check("...a count the master never had is the user's own and is left as typed",
    editFuture(weekly, "2026-08-31", { rrule: { freq: "weekly", interval: 1, count: 5 } }, "n7").insert[0].rrule.count === 5
    && editFuture(weekly, "2026-08-31", { rrule: { freq: "weekly", interval: 1, count: 5 } }, "n7").update[0].rrule.count === null);
  check("...and a total cut below what is already spent still keeps the edited session",
    editFuture(ten, "2026-08-31", { rrule: { freq: "weekly", interval: 1, count: 2 } }, "n8").insert[0].rrule.count === 1);

  // (c) an occurrence edited on its own stays in the series
  const oc = editOccurrence(weekly, "2026-08-17", { title: "Solo", start_time: at(2026, 8, 17, 15) }, "solo2");
  check("editOccurrence links the standalone row to its series",
    oc.insert[0].series_id === "e1" && oc.insert[0].rrule === null, String(oc.insert[0].series_id));
  check("...keeps the series id of a master that was itself split off",
    editOccurrence({ ...weekly, id: "m2", series_id: "e1" }, "2026-08-17", {}, "s3").insert[0].series_id === "e1");
  const rowsC = apply([weekly], oc);
  check("...is drawn exactly once, not re-expanded and not doubled by the master",
    all(rowsC, D(2026, 8, 1), D(2026, 8, 31)).filter((k) => k === "2026-08-17").length === 1
    && expandEvents(rowsC, D(2026, 8, 1), D(2026, 8, 31)).filter((o) => o.masterId === "solo2").length === 1);
  check("...and 'delete all in series' now takes it too",
    deleteSeries(weekly, rowsC).delete.sort().join(",") === "e1,solo2");
  {
    const early = editOccurrence(weekly, "2026-08-03", { title: "Early", start_time: at(2026, 8, 3, 15) }, "early").insert[0];
    const late = oc.insert[0];
    const plan = deleteFuture(weekly, "2026-08-17", [weekly, early, late, { id: "other", series_id: null, start_time: at(2026, 9, 1) }]);
    check("deleteFuture removes occurrences edited on their own on or after the cut, and only those",
      plan.delete.join(",") === "solo2", plan.delete.join(","));
    check("...and without the rows it behaves exactly as before",
      deleteFuture(weekly, "2026-08-17").delete.length === 0);
  }
  {
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("src/pages/personal/CalendarPanel.jsx", "utf8");
    check("CalendarPanel's plain save keeps a row's series_id instead of clearing it for a one-off",
      /series_id: \(master && master\.series_id\) \|\| \(rrule \? form\.id : null\)/.test(panel));
    check("CalendarPanel hands deleteFuture the rows",
      /deleteFuture\(master, day, events \|\| \[\]\)/.test(panel));
  }
}

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
check("...and the ceiling is on what comes OUT — the window gets its full 750",
  occurrenceDays(ev({ rrule: { freq: "daily", interval: 1 } }), D(2026, 8, 3), D(2060, 1, 1)).length === 750,
  String(occurrenceDays(ev({ rrule: { freq: "daily", interval: 1 } }), D(2026, 8, 3), D(2060, 1, 1)).length));

// ─── AN OLD SERIES IS STILL A SERIES ─────────────────────────────────────────
// The ceiling above used to count STEPS from the series start, so a daily
// reminder created in early 2024 stopped rendering in early 2026 — no until, no
// exdate, row still in the table — and a weekly one lasted fourteen years. The
// window is what bounds the walk now; the series' age must not.
check("a daily series started three years ago still fills this month",
  occurrenceDays(ev({ start_time: at(2024, 1, 1), rrule: { freq: "daily", interval: 1 } }), D(2026, 9, 1), D(2026, 9, 30)).length === 30,
  String(occurrenceDays(ev({ start_time: at(2024, 1, 1), rrule: { freq: "daily", interval: 1 } }), D(2026, 9, 1), D(2026, 9, 30)).length));
check("a weekly series started fifteen years ago still fills this month",
  // 2011-01-03 was a Monday; the Mondays of September 2026 are the 7th, 14th, 21st, 28th.
  occurrenceDays(ev({ start_time: at(2011, 1, 3), rrule: { freq: "weekly", interval: 1 } }), D(2026, 9, 1), D(2026, 9, 30)).join(",")
    === "2026-09-07,2026-09-14,2026-09-21,2026-09-28",
  occurrenceDays(ev({ start_time: at(2011, 1, 3), rrule: { freq: "weekly", interval: 1 } }), D(2026, 9, 1), D(2026, 9, 30)).join(","));
check("a monthly series from 2000 still clamps correctly a quarter-century on",
  occurrenceDays(ev({ start_time: at(2000, 1, 31), rrule: { freq: "monthly", interval: 1 } }), D(2026, 2, 1), D(2026, 3, 31)).join(",")
    === "2026-02-28,2026-03-31");

// The seek must land on the same PHASE the walk would have — every 3 days from
// Jan 1 2024 is not every 3 days from whatever day the month opens on. Compared
// against a naive walk from the series start (no seek, no ceiling), which is the
// definition of correct here.
{
  const walk = (row, from, to) => {
    const rule = normalizeRule(row.rrule);
    const start = new Date(row.start_time);
    const s0 = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    const out = [];
    let n = 0;
    if (rule.freq === "daily") {
      for (let d = s0; d <= to; d = add(d, rule.interval)) {
        if (rule.count != null && n >= rule.count) break;
        n += 1;
        if (d >= from) out.push(dayKey(d));
      }
    } else {
      const days = rule.byWeekday.length ? rule.byWeekday : [s0.getDay()];
      let ws = add(s0, -s0.getDay());
      outer: for (; ws <= to; ws = add(ws, 7 * rule.interval)) {
        for (const wd of days) {
          const d = add(ws, wd);
          if (d < s0) continue;
          if (rule.count != null && n >= rule.count) break outer;
          n += 1;
          if (d >= from && d <= to) out.push(dayKey(d));
        }
      }
    }
    return out.join(",");
  };
  const cases = [
    ["every 3 days keeps its phase across a seek", { start_time: at(2024, 1, 1), rrule: { freq: "daily", interval: 3 } }],
    ["every 2 weeks keeps its phase across a seek", { start_time: at(2024, 1, 3), rrule: { freq: "weekly", interval: 2 } }],
    ["every 5 weeks on Mon/Wed/Fri keeps its phase across a seek", { start_time: at(2023, 6, 14), rrule: { freq: "weekly", interval: 5, byWeekday: [1, 3, 5] } }],
    ["a mid-week start with an earlier byWeekday keeps its phase", { start_time: at(2024, 8, 7), rrule: { freq: "weekly", interval: 3, byWeekday: [1, 3] } }],
    ["a daily count is honoured across a seek", { start_time: at(2024, 1, 1), rrule: { freq: "daily", interval: 1, count: 700 } }],
    ["a weekly count is honoured across a seek", { start_time: at(2026, 8, 3), rrule: { freq: "weekly", interval: 1, byWeekday: [1, 3, 5], count: 10 } }],
  ];
  const windows = [[D(2025, 11, 1), D(2025, 12, 31)], [D(2026, 8, 17), D(2026, 9, 30)], [D(2026, 9, 1), D(2026, 9, 30)]];
  for (const [name, o] of cases) {
    const ok = windows.every(([f, t]) => occurrenceDays(ev(o), f, t).join(",") === walk(ev(o), f, t));
    check(name, ok, windows.map(([f, t]) => `${occurrenceDays(ev(o), f, t).join(",")} vs ${walk(ev(o), f, t)}`).join(" | "));
  }
  // The two count cases must actually reach their count inside a window —
  // otherwise the comparison above proves nothing about `emitted`.
  check("...the daily count case ends on its 700th day, inside the window",
    occurrenceDays(ev(cases[4][1]), D(2025, 11, 1), D(2025, 12, 31)).join(",").endsWith("2025-11-30")
    && occurrenceDays(ev(cases[4][1]), D(2025, 12, 1), D(2025, 12, 31)).length === 0);
  check("...the weekly count case emits its last four in a window that opens mid-series",
    occurrenceDays(ev(cases[5][1]), D(2026, 8, 17), D(2026, 9, 30)).join(",") === "2026-08-17,2026-08-19,2026-08-21,2026-08-24",
    occurrenceDays(ev(cases[5][1]), D(2026, 8, 17), D(2026, 9, 30)).join(","));
}

if (failed) { console.log(`\n${failed} recurrence check(s) failed`); process.exit(1); }

// ─── "All events in the series" must not delete the past ─────────────────────
// The edit form is seeded from the OCCURRENCE you tapped, and draftFields
// rebuilds start_time out of that date — so writing the result straight onto
// the master moved the SERIES START to whichever occurrence was on screen.
// occurrenceDays walks forward from master.start_time, so everything before it
// stopped existing: editing a weekly "Team sync" from an August occurrence,
// purely to fix a typo, took the series from 35 occurrences to 5. The scope
// sheet's own words are "All events in the series — including the ones already
// past"; it removed them instead.
//
// seriesFields carries the day the user moved the event BY, not the day they
// moved it TO. This is that arithmetic, lifted from CalendarPanel.
{
  const { calendarDaysBetween } = await import("../src/lib/dates.js");
  const seriesFields = (master, day, fields) => {
    const out = { ...fields };
    const formStart = new Date(fields.start_time);
    const masterStart = new Date(master.start_time);
    if (!day || isNaN(formStart) || isNaN(masterStart)) return out;
    const deltaDays = calendarDaysBetween(`${day}T12:00:00`, formStart);
    if (deltaDays == null) return out;
    const shift = (iso, refIso) => {
      if (!iso) return iso;
      const t = new Date(iso), ref = new Date(refIso);
      if (isNaN(t) || isNaN(ref)) return iso;
      const span = calendarDaysBetween(refIso, t) || 0;
      const d = new Date(masterStart.getFullYear(), masterStart.getMonth(),
        masterStart.getDate() + deltaDays + span, t.getHours(), t.getMinutes(), 0, 0);
      return d.toISOString();
    };
    out.start_time = shift(fields.start_time, fields.start_time);
    if (fields.end_time) out.end_time = shift(fields.end_time, fields.start_time);
    return out;
  };

  const master = {
    id: "m1", title: "Team sync", all_day: false,
    start_time: new Date(2026, 0, 5, 9, 0).toISOString(),
    end_time: new Date(2026, 0, 5, 9, 30).toISOString(),
    rrule: { freq: "weekly", interval: 1, byWeekday: [1] },
  };
  const nOcc = (ev) => expandEvents([ev], new Date(2026, 0, 1), new Date(2026, 7, 31)).length;
  const tapped = "2026-08-03";
  const at = (mo, d, h, mi) => new Date(2026, mo, d, h, mi).toISOString();
  const base = { title: "Team sync", notes: "", all_day: false, location: "", category: "work" };

  check("the series has its full history to begin with", nOcc(master) === 35, String(nOcc(master)));

  const titleOnly = { ...base, title: "renamed", start_time: at(7, 3, 9, 0), end_time: at(7, 3, 9, 30) };
  const afterTitle = { ...master, ...seriesFields(master, tapped, titleOnly) };
  check("a title-only edit from an August occurrence keeps every occurrence",
    nOcc(afterTitle) === 35, `${nOcc(afterTitle)} of 35 survived`);
  check("...because the master's start was not touched at all",
    afterTitle.start_time === master.start_time);

  const moved = { ...base, start_time: at(7, 5, 9, 0), end_time: at(7, 5, 9, 30) };
  const afterMove = { ...master, ...seriesFields(master, tapped, moved) };
  check("moving the occurrence two days moves the SERIES two days, not to August",
    new Date(afterMove.start_time).getMonth() === 0 && new Date(afterMove.start_time).getDate() === 7,
    new Date(afterMove.start_time).toDateString());

  const retimed = { ...base, start_time: at(7, 3, 14, 30), end_time: at(7, 3, 15, 0) };
  const afterTime = { ...master, ...seriesFields(master, tapped, retimed) };
  check("retiming the series keeps its start DAY and takes the new clock time",
    new Date(afterTime.start_time).getDate() === 5 && new Date(afterTime.start_time).getHours() === 14
    && nOcc(afterTime) === 35,
    `${new Date(afterTime.start_time).toDateString()} ${new Date(afterTime.start_time).getHours()}h, ${nOcc(afterTime)} occ`);

  check("a multi-day span keeps its length through the shift",
    (() => {
      const span = { ...base, start_time: at(7, 3, 9, 0), end_time: at(7, 5, 17, 0) };
      const r = seriesFields(master, tapped, span);
      return calendarDaysBetween(r.start_time, new Date(r.end_time)) === 2;
    })());
}

// ─── the bulk import never invents a birth year ──────────────────────────────
// Not recurrence arithmetic, but the same file the block above lifts from, and
// the same class of silent wrong number: the screenshot importer wrote the
// CALENDAR year of the screenshot (last year's, usually) into
// personal_birthdays.year, so every imported adult "turns 1" on the agenda. A
// screenshot cannot know a birth year; the row goes in with month/day only.
{
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync("src/pages/personal/CalendarPanel.jsx", "utf8");
  const review = panel.match(/const reviewed = merged\.map\([\s\S]*?\n    \}\);/)?.[0] || "";
  check("the bulk-import review builds birthday rows", review.length > 0);
  check("…without a birth year taken from the screenshot", /month: m, day: d, year: null,/.test(review) && !/year: y\b/.test(review));
  const confirm = panel.match(/const toBirthdays = [\s\S]*?\}\)\);/)?.[0] || "";
  check("…and the insert carries none either", confirm.length > 0 && /year: null/.test(confirm) && !/r\.year/.test(confirm));
}

// ─── the bulk import recognises an evening event it already has ──────────────
// The duplicate check compared start_time.slice(0, 10) — the UTC day — to the
// screenshot's local date. 7pm CDT is midnight UTC, so every evening event was
// "new" on every re-import and went in twice.
{
  const { isImportDuplicate, importNameKey } = await import("../src/lib/event-draft.js");
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync("src/pages/personal/CalendarPanel.jsx", "utf8");
  // 7pm CDT on Sep 28 is midnight UTC on the 29th — the stored stamp's own
  // date is the next day, which is the whole bug.
  const dinner = { id: "d1", title: "Dinner w/ Sam", start_time: "2026-09-29T00:00:00.000Z", all_day: false };
  check("a 7pm CDT event is recognised as a duplicate of the screenshot's same local day",
    isImportDuplicate(dinner, { title: "dinner w/ sam", date: "2026-09-28" }), dinner.start_time);
  check("...and is NOT matched against the UTC day it would have been filed under",
    !isImportDuplicate(dinner, { title: "Dinner w/ Sam", date: "2026-09-29" }));
  check("...an all-day row matches on its own day",
    isImportDuplicate({ title: "Trip", start_time: new Date(2026, 8, 28).toISOString(), all_day: true }, { title: "trip", date: "2026-09-28" }));
  check("...a different title on the same day is not a duplicate",
    !isImportDuplicate(dinner, { title: "Lunch", date: "2026-09-28" }));
  check("...a row with no start is never a duplicate rather than a throw",
    !isImportDuplicate({ title: "x" }, { title: "x", date: "2026-09-28" }));
  check("the name key folds the birthday words the screenshots add",
    importNameKey("Sam's Birthday") === importNameKey("sam bday"));
  check("CalendarPanel's import review uses the local-day check, not the UTC slice",
    /eventsList\.find\(e => isImportDuplicate\(e, item\)\)/.test(panel) && !/start_time\.slice\(0, 10\) === item\.date/.test(panel));
}

// The early exit above only guards the block before it; everything after it
// reported PASS regardless of what it found.
if (failed) { console.log(`\n${failed} recurrence check(s) failed`); process.exit(1); }
console.log("\nRECURRENCE SMOKE PASS");
