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
  anniversaryLine, isValidDate, sortByNextOccurrence, filterByKind, upcomingDates,
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

// ── the merged upcoming list (Brief card + TRMNL brief) ─────────────────────
// Two tables, one list, on two surfaces. What can go wrong is a row that
// belongs to neither list cleanly: a birthday wearing an anniversary's words,
// an id collision dropping a row, or a window that quietly excludes today.
const BDAY = { id: "b1", name: "Sister", month: 9, day: 3, year: 1990 };
const SEP1 = new Date(2026, 8, 1);
const up = upcomingDates({ birthdays: [BDAY], anniversaries: [DAD, SHOP, NOYEAR], withinDays: 14, from: SEP1 });
check("only what falls inside the window is listed", up.map((r) => r.name).join(",") === "Sister");
const wide = upcomingDates({ birthdays: [BDAY], anniversaries: [DAD, SHOP, NOYEAR], withinDays: 400, from: SEP1 });
// Sep 3, then Dec 24, then next year's Mar 4 and Jun 1 — the sort is by how far
// away the NEXT occurrence is, which is why a December date leads a March one
// when you ask in September.
check("a wider window takes everything, soonest first",
  wide.map((r) => r.name).join(",") === "Sister,Gran,Dad,Store opened", wide.map((r) => r.name).join(","));
check("a birthday is labelled as a birthday and aged",
  wide[0].kind === "birthday" && wide[0].note === "turns 36", JSON.stringify(wide[0]));
check("an anniversary keeps its own kind and sentence",
  wide[1].kind === "passing" && wide[1].note === anniversaryLine(NOYEAR, wide[1].next.getFullYear()),
  JSON.stringify(wide[1]));
check("a dated passing counts its years in the merged list too",
  wide[2].name === "Dad" && wide[2].note === anniversaryLine(DAD, wide[2].next.getFullYear()),
  JSON.stringify(wide[2]));
check("keys are namespaced, so the two tables can never collide",
  new Set(wide.map((r) => r.key)).size === wide.length && wide.every((r) => /^(birthday|anniversary):/.test(r.key)));
check("today counts as upcoming, not as past",
  upcomingDates({ anniversaries: [{ id: "t", name: "Today", kind: "milestone", month: 9, day: 1 }], from: SEP1 })[0]?.daysUntil === 0);
check("either table alone still produces a list",
  upcomingDates({ birthdays: [BDAY], withinDays: 400, from: SEP1 }).length === 1
  && upcomingDates({ anniversaries: [DAD], withinDays: 400, from: SEP1 }).length === 1);
check("no arguments at all is an empty list, not a throw", upcomingDates().length === 0);
check("an unusable row is dropped from the merged list too",
  upcomingDates({ anniversaries: [{ id: "x", name: "Bad", month: 44, day: 1 }], withinDays: 400, from: SEP1 }).length === 0);
check("a birthday with no year gets no age rather than a wrong one",
  upcomingDates({ birthdays: [{ id: "b2", name: "Nan", month: 9, day: 3 }], withinDays: 400, from: SEP1 })[0].note === "");

// ── the Brief card draws the merged list ─────────────────────────────────────
const brief = src("src/pages/brief/BriefPage.jsx");
check("the Brief card is fed both tables", /upcomingDates\(\{ birthdays, anniversaries/.test(brief));
check("…and loads the second one", /db\.loadAnniversaries\(\)/.test(brief));
check("…and routes a passing to its own list, not to Birthdays",
  /b\.kind === "birthday" \? onOpenBirthdays : onOpenAnniversaries/.test(brief));
check("App wires that route", /onOpenAnniversaries=\{\(\) => jumpTo\(\{ page: "personal", sub: "anniversaries" \}\)\}/.test(src("src/App.jsx")));
check("the widget's name says it holds both", /label: "Birthdays & Dates"/.test(src("src/lib/brief-cards.js")));
check("the board seats are told, in the row's own words",
  /todayAnniversaries/.test(src("src/lib/snapshot.js")) && /todayAnniversaries/.test(brief));

// ── TRMNL publishes them, and says the same words ────────────────────────────
// The e-ink feed cannot import lib/anniversaries.js (see the note in the
// function). This is the check that keeps the copy honest: the same three
// sentences, computed by both, compared.
const trmnl = src("netlify/functions/trmnl.js");
check("TRMNL reads the table", /read\("personal_anniversaries", "id,name,kind,month,day,year"\)/.test(trmnl));
check("…includes them by default in the ICS feed", /\["events", "birthdays", "anniversaries", "upkeep"\]/.test(trmnl));
check("…publishes them in the JSON brief", /anniversaries: upAnniversaries/.test(trmnl));
check("…and counts them", /anniversaries: upAnniversaries\.length/.test(trmnl));
check("the recurring ICS summary carries NO year count (it would be stale by next year)",
  /summary: anniversaryKindOf\(a\.kind\) === "passing" \? `In memory: \$\{a\.name\}`/.test(trmnl)
  && !/summary:.*anniversaryNote/.test(trmnl));
check("the ICS rows repeat yearly like birthdays", /uid: `anniversary-\$\{a\.id\}@boardroom`[\s\S]{0,120}rrule: "FREQ=YEARLY"/.test(trmnl));
check("the Liquid layout renders them", /\{% for a in anniversaries/.test(src("trmnl/board-brief.liquid")));
// Liquid's comment is {% comment %}…{% endcomment %}. A Jinja-style brace-hash
// note is not a comment to Liquid — it is text, and the device printed a
// five-line paragraph under every birthday list until someone looked.
check("the Liquid layout carries no Jinja-style comment (Liquid prints it as text)",
  !/\{#/.test(src("trmnl/board-brief.liquid")));

// Behavioural, not textual: run the function's own copy of the wording.
const trmnlKind = (kind) => (kind === "passing" ? "passing" : "milestone");
function trmnlYears(row, y) {
  const from = Number(row && row.year);
  if (!Number.isFinite(from) || from < 1900 || from > y) return null;
  const n = y - from;
  return n >= 1 ? n : null;
}
function trmnlNote(row, y) {
  const n = trmnlYears(row, y);
  const base = trmnlKind(row && row.kind) === "passing" ? "In memory" : "Anniversary";
  return n == null ? base : `${base} · ${n} year${n === 1 ? "" : "s"}`;
}
for (const row of [DAD, SHOP, NOYEAR, { kind: "???", year: 2000 }, { kind: "passing", year: 2025 }, { kind: "milestone" }]) {
  check(`TRMNL words ${JSON.stringify(row.name || row.kind)} exactly as the app does`,
    trmnlNote(row, 2026) === anniversaryLine(row, 2026) && trmnlKind(row.kind) === normalizeKind(row.kind),
    `${trmnlNote(row, 2026)} vs ${anniversaryLine(row, 2026)}`);
}
// The copy in the function has to BE these functions, not just agree with them
// on the cases this file happens to try.
for (const [name, re] of [
  ["the unknown-kind rule", /kind === "passing" \? "passing" : "milestone"/],
  ["the 1900 floor and the future guard", /from < 1900 \|\| from > occurrenceYear/],
  ["the one-full-year floor", /n >= 1 \? n : null/],
]) check(`TRMNL's copy keeps ${name}`, re.test(trmnl));

// ── TRMNL's day math, RUN at the hours it used to get wrong ──────────────────
// The e-ink brief answers "is it today" for every row, and for a year it
// answered from instants: Math.round((occurrence - now) / day) with birthdays
// and upkeep at UTC midnight and all-day events at the stored midnight. That is
// off by one for most of a Chicago evening and morning — tomorrow's birthday
// read "Today" from 7pm, an item due today read "overdue" from 7am, and an
// all-day event vanished from the brief by ~1am on the day itself. Nothing here
// could see it, because nothing here ran the function. The renderers are
// exported for exactly this; trmnl.js is CJS under a "type":"module" package,
// so it is bundled to .cjs first (the same trick scripts/migrations-smoke.mjs
// uses for export-data.js). The Supabase client is left external: only the
// renderers are called, never the handler.
{
  const { mkdirSync, rmSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { resolve } = await import("node:path");
  const esbuild = (await import("esbuild")).default;
  const DIR = ".trmnl-smoke";
  let fn = null;
  try {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    esbuild.buildSync({
      entryPoints: ["netlify/functions/trmnl.js"], bundle: true, platform: "node", format: "cjs",
      outfile: `${DIR}/trmnl.cjs`, external: ["@supabase/supabase-js"], logLevel: "silent",
    });
    fn = createRequire(import.meta.url)(resolve(`${DIR}/trmnl.cjs`));
  } catch (e) {
    check("trmnl.js bundles for execution", false, (e.message || String(e)).split("\n")[0]);
  } finally {
    rmSync(DIR, { recursive: true, force: true });
  }
  check("trmnl.js exports its renderers for this smoke", typeof fn?.renderJson === "function" && typeof fn?.renderIcs === "function");
  if (fn) {
    // 2026-09-02T01:00Z is Sep 1, 8pm CDT; 2026-09-02T13:00Z is Sep 2, 8am CDT.
    const EVE = Date.parse("2026-09-02T01:00:00Z");
    const MORNING = Date.parse("2026-09-02T13:00:00Z");
    const rows = {
      birthdays: [{ id: "b", name: "Sister", month: 9, day: 2, year: 1990 }],
      anniversaries: [{ id: "a", name: "Dad", kind: "passing", month: 9, day: 2, year: 2019 }],
      // last_done + interval lands on Sep 2.
      upkeep: [{ id: "u", name: "Filters", interval_days: 7, last_done: "2026-08-26" }],
      events: [
        // An all-day row as CalendarPanel stores it from a Chicago browser: local midnight, 05:00Z.
        { id: "e1", title: "Dentist", all_day: true, start_time: "2026-09-02T05:00:00+00:00", end_time: null },
        // A timed row at 1am CDT on Sep 2 — five hours after EVE, and tomorrow.
        { id: "e2", title: "Red-eye", all_day: false, start_time: "2026-09-02T06:00:00+00:00", end_time: null },
        // A span that began yesterday and runs through Sep 3: happening today.
        { id: "e3", title: "Trip", all_day: true, start_time: "2026-09-01T05:00:00+00:00", end_time: "2026-09-03T05:00:00+00:00" },
      ],
    };
    const eve = fn.renderJson(rows, EVE);
    const bday = eve.birthdays.find((b) => b.name === "Sister");
    check("at 8pm the evening before, a birthday is Tomorrow, not Today",
      bday?.rel === "Tomorrow" && bday?.days_until === 1, JSON.stringify(bday));
    const ann = eve.anniversaries.find((a) => a.name === "Dad");
    check("…and so is an anniversary, with its count intact",
      ann?.rel === "Tomorrow" && ann?.note === "In memory · 7 years", JSON.stringify(ann));
    check("…and a 1am timed event is Tomorrow, not Today",
      eve.events.find((e) => e.title === "Red-eye")?.rel === "Tomorrow", JSON.stringify(eve.events));

    const morning = fn.renderJson(rows, MORNING);
    const due = morning.upkeep.find((u) => u.name === "Filters");
    check("at 8am on the due day, an upkeep item is Today and not overdue",
      due?.rel === "Today" && due?.overdue === false && due?.days_until === 0, JSON.stringify(due));
    check("…the birthday is Today", morning.birthdays.find((b) => b.name === "Sister")?.rel === "Today");
    const dentist = morning.events.find((e) => e.title === "Dentist");
    check("…today's all-day event is still on the brief, labelled Today, on the right date",
      dentist?.rel === "Today" && dentist?.when === "Wed, Sep 2" && dentist?.time === "All day", JSON.stringify(morning.events));
    check("…a span that started yesterday is Today, not '1d ago'",
      morning.events.find((e) => e.title === "Trip")?.rel === "Today", JSON.stringify(morning.events));
    check("…and the 1am timed event, now seven hours gone, has dropped off",
      !morning.events.some((e) => e.title === "Red-eye"), JSON.stringify(morning.events));
    check("the day after, the all-day event is gone and the birthday has rolled to next year",
      !fn.renderJson(rows, Date.parse("2026-09-03T13:00:00Z")).events.some((e) => e.title === "Dentist")
      && fn.renderJson(rows, Date.parse("2026-09-03T13:00:00Z")).birthdays.length === 0);

    // The ICS feed: a multi-day all-day span has to END on the day after its
    // last day (DTEND is exclusive for DATE values), not on the day after it
    // starts. It painted one cell for a four-day trip until this was asserted.
    const ics = fn.renderIcs({ events: [
      { id: "s", title: "Denver", all_day: true, start_time: "2026-09-10T05:00:00+00:00", end_time: "2026-09-13T05:00:00+00:00" },
      { id: "o", title: "One day", all_day: true, start_time: "2026-09-20T05:00:00+00:00", end_time: null },
    ] }, new Set(["events"]));
    check("a four-day all-day span spans four days in the ICS",
      /DTSTART;VALUE=DATE:20260910\r\nDTEND;VALUE=DATE:20260914/.test(ics), ics.match(/DT(START|END)[^\r]*/g)?.join(" "));
    check("a single all-day event still ends the next day",
      /DTSTART;VALUE=DATE:20260920\r\nDTEND;VALUE=DATE:20260921/.test(ics), ics.match(/DT(START|END)[^\r]*/g)?.join(" "));
  }
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll anniversary checks passed");
process.exit(failed ? 1 : 0);
