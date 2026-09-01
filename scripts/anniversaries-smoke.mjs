// ─── Anniversaries smoke — the days that already happened, asserted ──────────
//
// A second annual-recurrence list beside birthdays, and the failure modes are
// not symmetrical with that one. What can go wrong here is worse:
//
//  1. A PASSING DESCRIBED AS A BIRTHDAY, or the reverse. `kind` is one text
//     column, read by a calendar that then chooses the words "In memory". A row
//     whose kind is missing, misspelt, or written by a later release must never
//     resolve to 'passing' — the wrong word on that day is not a cosmetic bug.
//  2. A GUESSED COUNT. "5 years today" is arithmetic on a year the user may
//     never have entered. Absent, future, or nonsense years have to produce NO
//     count rather than a confident wrong one.
//  3. THE LIST AND THE CALENDAR DISAGREEING. Two surfaces draw the same day —
//     the panel's row and the agenda line. They share one function here, and
//     this pins that they still do.
//  4. A DATE THAT LANDS ON THE WRONG DAY. Overlay rows are stamped at LOCAL
//     midnight; a UTC stamp reads as the previous day for anyone west of
//     Greenwich, which is how birthdays were once announced a day early.
//
// Pure functions in bare Node. Run by `npm run verify`.

import { readFileSync } from "node:fs";
import {
  ANNIVERSARY_KINDS, DEFAULT_KIND, normalizeKind, kindMeta, yearsSince,
  anniversaryLine, isValidDate, sortByNextOccurrence, filterByKind,
} from "../src/lib/anniversaries.js";
import { anniversaryOccurrences, withOverlays, startDayKey } from "../src/lib/calendar-overlays.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const DAD = { id: "a1", name: "Dad", kind: "passing", month: 3, day: 4, year: 2019 };
const SHOP = { id: "a2", name: "Store opened", kind: "milestone", month: 6, day: 1, year: 2021 };
const NOYEAR = { id: "a3", name: "Gran", kind: "passing", month: 12, day: 24, year: null };

// ── kind: wrong only in the harmless direction ───────────────────────────────
check("the stored kinds are the two the schema allows",
  ANNIVERSARY_KINDS.map((k) => k.key).sort().join(",") === "milestone,passing");
for (const [name, value] of [
  ["missing", undefined], ["null", null], ["empty", ""], ["a typo", "passsing"],
  ["a future kind", "adoption"], ["a number", 3], ["an object", {}],
]) {
  check(`an unrecognised kind (${name}) reads as a milestone, never a passing`,
    normalizeKind(value) === DEFAULT_KIND && normalizeKind(value) !== "passing");
}
check("a real kind is preserved", normalizeKind("passing") === "passing" && normalizeKind("milestone") === "milestone");
check("each kind has words to describe itself",
  ANNIVERSARY_KINDS.every((k) => k.label && k.line && k.plural));
check("kindMeta always answers", !!kindMeta("nonsense") && kindMeta("passing").line === "In memory");

// ── the count is never guessed ───────────────────────────────────────────────
check("a full year gives a count", yearsSince({ year: 2019 }, 2024) === 5);
check("the year it happened gives none", yearsSince({ year: 2024 }, 2024) === null);
check("no year gives none", yearsSince({ year: null }, 2024) === null && yearsSince({}, 2024) === null);
check("a year in the future gives none", yearsSince({ year: 2030 }, 2024) === null);
check("an implausible year gives none", yearsSince({ year: 1300 }, 2024) === null);
check("a non-numeric year gives none", yearsSince({ year: "sometime" }, 2024) === null);
check("one year is singular", anniversaryLine({ kind: "passing", year: 2023 }, 2024) === "In memory · 1 year");
check("more than one is plural", anniversaryLine(DAD, 2024) === "In memory · 5 years");
check("a milestone is worded as an anniversary", anniversaryLine(SHOP, 2024) === "Anniversary · 3 years");
check("no year still says what the day is", anniversaryLine(NOYEAR, 2024) === "In memory");

// ── a date the calendar can't use is dropped, not drawn wrong ────────────────
check("a real date is usable", isValidDate(DAD));
for (const bad of [{ month: 0, day: 4 }, { month: 13, day: 1 }, { month: 3, day: 0 }, { month: 3, day: 32 }, { month: "x", day: 1 }, {}, null]) {
  check(`an impossible date is rejected: ${JSON.stringify(bad)}`, !isValidDate(bad));
}

// ── the projection onto the calendar ─────────────────────────────────────────
const from = new Date(2026, 0, 1), to = new Date(2026, 11, 31);
const occ = anniversaryOccurrences([DAD, SHOP, NOYEAR], from, to);
check("one occurrence per row per year in the window", occ.length === 3);
check("each is an all-day overlay with no database identity",
  occ.every((o) => o.all_day && o.overlay === "anniversary" && String(o.id).startsWith("anniversary:")));
check("the day is stamped at LOCAL midnight, not UTC",
  occ.every((o) => /T00:00:00$/.test(o.start_time) && !/Z$/.test(o.start_time)));
const dad26 = occ.find((o) => o.title === "Dad");
check("it lands on its own day", startDayKey(dad26) === "2026-03-04");
check("it carries the same sentence the panel prints", dad26.line === anniversaryLine(DAD, 2026));
check("it carries its kind", dad26.kind === "passing");
check("a row with an unknown kind projects as a milestone",
  anniversaryOccurrences([{ ...DAD, kind: "???" }], from, to)[0].kind === "milestone");
check("an impossible date projects nothing",
  anniversaryOccurrences([{ id: "z", name: "Bad", month: 99, day: 1 }], from, to).length === 0);
check("a window in the past or the future is empty, not wrong",
  anniversaryOccurrences([DAD], new Date(2026, 5, 1), new Date(2026, 5, 30)).length === 0);
check("two years of window means two occurrences",
  anniversaryOccurrences([DAD], new Date(2026, 0, 1), new Date(2027, 11, 31)).length === 2);
check("a bad window returns nothing rather than throwing",
  anniversaryOccurrences([DAD], new Date("nope"), to).length === 0
  && anniversaryOccurrences(null, from, to).length === 0
  && anniversaryOccurrences([DAD], to, from).length === 0);

// Feb 29 rolls to Mar 1 in a common year, exactly as birthdays do — the date
// still arrives, which is the whole point of an annual remembrance.
const leap = anniversaryOccurrences([{ id: "l", name: "Leap", kind: "milestone", month: 2, day: 29 }], new Date(2027, 0, 1), new Date(2027, 11, 31));
check("Feb 29 in a common year still lands", leap.length === 1 && startDayKey(leap[0]) === "2027-03-01");

// ── merged with everything else the calendar draws ───────────────────────────
const real = { id: "e1", title: "9am standup", start_time: "2026-03-04T09:00:00", end_time: null, all_day: false, category: "work" };
const bday = { id: "b1", name: "Sister", month: 3, day: 4, year: 1990 };
const merged = withOverlays([real], { birthdays: [bday], anniversaries: [DAD], from, to, holidays: false })
  .filter((e) => startDayKey(e) === "2026-03-04");
check("your own event leads the day", !merged[0].overlay);
check("then the birthday", merged[1].overlay === "birthday");
check("then the anniversary", merged[2].overlay === "anniversary");
check("nothing is dropped or duplicated in the merge", merged.length === 3);
check("omitting anniversaries entirely still works (old callers)",
  withOverlays([real], { birthdays: [bday], from, to, holidays: false }).length === 2);

// ── the list order and the filter ────────────────────────────────────────────
const jan1 = new Date(2026, 0, 1);
const sorted = sortByNextOccurrence([SHOP, DAD, NOYEAR], jan1);
check("soonest next occurrence first", sorted.map((r) => r.name).join(",") === "Dad,Store opened,Gran");
check("every row carries the date the list labels it with",
  sorted.every((r) => r.next instanceof Date && Number.isFinite(r.daysUntil)));
check("a date already past this year rolls to next year",
  sortByNextOccurrence([DAD], new Date(2026, 5, 1))[0].next.getFullYear() === 2027);
check("an unusable row is dropped from the list, not rendered blank",
  sortByNextOccurrence([DAD, { id: "bad", name: "Bad", month: 44, day: 9 }], jan1).length === 1);
check("the list normalizes kind too",
  sortByNextOccurrence([{ ...DAD, kind: undefined }], jan1)[0].kind === "milestone");
check("all shows everything", filterByKind([DAD, SHOP], "all").length === 2);
check("no filter shows everything", filterByKind([DAD, SHOP]).length === 2);
check("passings filter to passings", filterByKind([DAD, SHOP, NOYEAR], "passing").map((r) => r.name).join(",") === "Dad,Gran");
check("milestones filter to milestones", filterByKind([DAD, SHOP], "milestone").map((r) => r.name).join(",") === "Store opened");
check("a row with no kind filters as a milestone",
  filterByKind([{ ...SHOP, kind: null }], "milestone").length === 1 && filterByKind([{ ...SHOP, kind: null }], "passing").length === 0);
check("the filter tolerates junk input", filterByKind(null, "passing").length === 0 && filterByKind([null, DAD], "passing").length === 1);

// ── the wiring, read out of the source ───────────────────────────────────────
// Pure functions can be perfect while nothing mounts them. These are the four
// edits that make the feature exist at all, and each is one deletion away from
// a panel that saves rows nobody ever sees.
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const page = src("src/pages/personal/PersonalPage.jsx");
check("Personal lists the sub-tab", /key: "anniversaries"/.test(page));
check("…and mounts the panel behind it", /sub === "anniversaries" && <AnniversariesPanel/.test(page));
const cal = src("src/pages/personal/CalendarPanel.jsx");
check("the calendar reads the table", /useAnniversaries\(\)/.test(cal));
check("…and hands it to both windows (grid and upcoming)",
  (cal.match(/anniversaries: anniversaries \|\| \[\]/g) || []).length === 2);
check("…and prints the day's own sentence rather than inventing one", /ev\.line \|\| "Anniversary"/.test(cal));
const panel = src("src/features/anniversaries/AnniversariesPanel.jsx");
check("the panel never writes a kind the schema rejects", !/kind: "(?!passing|milestone)/.test(panel));
const mig = src("supabase/migrations/0040_personal_anniversaries.sql");
check("the migration constrains kind to what the client normalizes to",
  /check \(kind in \('passing', 'milestone'\)\)/.test(mig));
check("the backup covers the new table",
  /"personal_anniversaries"/.test(src("netlify/functions/export-data.js")));

console.log(failed ? `\n${failed} check(s) failed` : "\nAll anniversary checks passed");
process.exit(failed ? 1 : 0);
