// ─── Holidays, birthdays and multi-day spans — the calendar's new date math ──
// Three pure modules' worth of arithmetic that nothing else exercises:
//
//   1. lib/holidays.js computes every holiday from the year. A closed form is
//      only better than a hosted list if it is RIGHT, and "the 4th Thursday of
//      November" is exactly the kind of rule that is off by a week in the years
//      where the month starts on the target weekday. Every date asserted here
//      is one a reader can check against a wall calendar.
//   2. lib/calendar-overlays.js turns a stored start/end into the set of day
//      cells it paints. Before it existed a multi-day event rendered on its
//      first day and nowhere else — not a visual bug, an event you could enter
//      and then not find.
//   3. Birthdays project into event-shaped rows without ever being written.
//      They must never acquire a database identity, because a save against one
//      targets a personal_events row that does not exist.
//
// The DST trap this suite guards: every date here is built with Date(y, m, d)
// and compared as a local day key. An implementation that reached for
// toISOString().slice(0,10) passes in London and reports Christmas as the 24th
// in Chicago, which is the single most likely way this code regresses.
//
// Zero network, zero DOM. Run with `node scripts/holidays-smoke.mjs`.

import esbuild from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const OUT_DIR = ".holidays-smoke";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

try {
  // Bundled the way Vite ships them, so a syntax error or a bad import is a
  // failure here rather than a white screen on the phone.
  const bundle = (entry, name) => {
    const out = resolve(OUT_DIR, `${name}.mjs`);
    esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: "neutral", format: "esm", outfile: out, logLevel: "silent" });
    return import(pathToFileURL(out).href);
  };
  const H = await bundle("src/lib/holidays.js", "holidays");
  const O = await bundle("src/lib/calendar-overlays.js", "overlays");

  // ─── 1. the fixed-date holidays ───────────────────────────────────────────
  const dayOf = (year, key) => (H.holidaysForYear(year).find((h) => h.key === key) || {}).day;
  check("New Year's Day is Jan 1", dayOf(2026, "new-years") === "2026-01-01", dayOf(2026, "new-years"));
  check("Juneteenth is Jun 19", dayOf(2026, "juneteenth") === "2026-06-19", dayOf(2026, "juneteenth"));
  check("Independence Day is Jul 4", dayOf(2026, "independence") === "2026-07-04", dayOf(2026, "independence"));
  check("Veterans Day is Nov 11", dayOf(2026, "veterans") === "2026-11-11", dayOf(2026, "veterans"));
  check("Christmas is Dec 25", dayOf(2026, "christmas") === "2026-12-25", dayOf(2026, "christmas"));
  check("Christmas Eve is the 24th, not the 25th shifted", dayOf(2026, "christmas-eve") === "2026-12-24", dayOf(2026, "christmas-eve"));
  check("New Year's Eve is Dec 31", dayOf(2026, "new-years-eve") === "2026-12-31", dayOf(2026, "new-years-eve"));
  check("Halloween is Oct 31", dayOf(2026, "halloween") === "2026-10-31", dayOf(2026, "halloween"));

  // ─── 2. the nth-weekday rules ─────────────────────────────────────────────
  // Verifiable by eye: Jan 2026 opens on a Thursday, so its Mondays are the
  // 5th, 12th, 19th and 26th, and the third is the 19th.
  check("MLK Day 2026 is Jan 19 (3rd Monday)", dayOf(2026, "mlk") === "2026-01-19", dayOf(2026, "mlk"));
  check("Presidents' Day 2026 is Feb 16", dayOf(2026, "presidents") === "2026-02-16", dayOf(2026, "presidents"));
  check("Labor Day 2026 is Sep 7 (1st Monday)", dayOf(2026, "labor") === "2026-09-07", dayOf(2026, "labor"));
  check("Indigenous Peoples' Day 2026 is Oct 12 (2nd Monday)", dayOf(2026, "indigenous") === "2026-10-12", dayOf(2026, "indigenous"));
  check("Thanksgiving 2026 is Nov 26 (4th Thursday)", dayOf(2026, "thanksgiving") === "2026-11-26", dayOf(2026, "thanksgiving"));
  check("Black Friday follows Thanksgiving, it is not a fixed ordinal",
    dayOf(2026, "black-friday") === "2026-11-27", dayOf(2026, "black-friday"));
  check("Mother's Day 2026 is May 10 (2nd Sunday)", dayOf(2026, "mothers") === "2026-05-10", dayOf(2026, "mothers"));
  check("Father's Day 2026 is Jun 21 (3rd Sunday)", dayOf(2026, "fathers") === "2026-06-21", dayOf(2026, "fathers"));

  // LAST Monday, not the 4th — the whole reason n === -1 exists. May 2027 has
  // five Mondays (3, 10, 17, 24, 31), so a 4th-Monday implementation would put
  // Memorial Day on the 24th and be a week early.
  check("Memorial Day 2026 is May 25", dayOf(2026, "memorial") === "2026-05-25", dayOf(2026, "memorial"));
  check("Memorial Day 2027 is May 31 — the LAST Monday, in a five-Monday May",
    dayOf(2027, "memorial") === "2027-05-31", dayOf(2027, "memorial"));
  check("nthWeekdayOfMonth(-1) picks the last one",
    H.nthWeekdayOfMonth(2027, 4, 1, -1).getDate() === 31, String(H.nthWeekdayOfMonth(2027, 4, 1, -1)));
  // A month whose 1st IS the target weekday: the 1st is the first occurrence,
  // not the 8th. Sep 2025 opens on a Monday.
  check("the 1st counts as the 1st occurrence when it lands on the weekday",
    H.nthWeekdayOfMonth(2025, 8, 1, 1).getDate() === 1, String(H.nthWeekdayOfMonth(2025, 8, 1, 1).getDate()));

  // ─── 3. Easter, and the two feasts hanging off it ─────────────────────────
  const easter = (y) => `${H.easterSunday(y).getFullYear()}-${String(H.easterSunday(y).getMonth() + 1).padStart(2, "0")}-${String(H.easterSunday(y).getDate()).padStart(2, "0")}`;
  check("Easter 2026 is April 5", easter(2026) === "2026-04-05", easter(2026));
  check("Easter 2025 is April 20", easter(2025) === "2025-04-20", easter(2025));
  check("Easter 2027 is March 28 — it does move into March", easter(2027) === "2027-03-28", easter(2027));
  check("Easter is always a Sunday, across a century",
    Array.from({ length: 100 }, (_, i) => H.easterSunday(1990 + i)).every((d) => d.getDay() === 0));
  check("Good Friday is two days before Easter", dayOf(2026, "good-friday") === "2026-04-03", dayOf(2026, "good-friday"));

  // ─── 4. windows, ordering and the year boundary ───────────────────────────
  const dec = H.holidaysBetween(new Date(2026, 11, 20), new Date(2027, 0, 5)).map((h) => h.key);
  check("a December→January window spans the year boundary",
    dec.includes("christmas") && dec.includes("new-years-eve") && dec.includes("new-years"),
    JSON.stringify(dec));
  check("...and comes back in date order",
    dec.indexOf("christmas-eve") < dec.indexOf("christmas") && dec.indexOf("new-years-eve") < dec.indexOf("new-years"));
  check("a window with no holiday in it is empty, not the whole year",
    H.holidaysBetween(new Date(2026, 7, 8), new Date(2026, 7, 20)).length === 0);
  check("a backwards window returns nothing rather than the whole year",
    H.holidaysBetween(new Date(2026, 5, 1), new Date(2026, 0, 1)).length === 0);
  check("eleven federal holidays a year, and the observances are not counted among them",
    H.holidaysForYear(2026).filter((h) => h.federal).length === 11,
    String(H.holidaysForYear(2026).filter((h) => h.federal).length));

  // ─── 5. multi-day spans ───────────────────────────────────────────────────
  const allDay = (s, e) => ({ all_day: true, start_time: `${s}T00:00:00.000Z`, end_time: e ? `${e}T00:00:00.000Z` : null });
  check("a single all-day event covers one cell",
    JSON.stringify(O.spanDayKeys(allDay("2026-08-06"))) === JSON.stringify(["2026-08-06"]));
  check("a four-day all-day event covers four cells, both ends inclusive",
    JSON.stringify(O.spanDayKeys(allDay("2026-08-06", "2026-08-09"))) ===
    JSON.stringify(["2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"]),
    JSON.stringify(O.spanDayKeys(allDay("2026-08-06", "2026-08-09"))));
  check("a span across a month boundary keeps walking",
    O.spanDayKeys(allDay("2026-01-30", "2026-02-02")).length === 4);
  check("a span across a year boundary keeps walking",
    JSON.stringify(O.spanDayKeys(allDay("2026-12-31", "2027-01-01"))) ===
    JSON.stringify(["2026-12-31", "2027-01-01"]));
  check("a leap day is a real day in the walk",
    O.spanDayKeys(allDay("2028-02-27", "2028-03-01")).length === 4,
    JSON.stringify(O.spanDayKeys(allDay("2028-02-27", "2028-03-01"))));
  check("an end BEFORE the start collapses to one day rather than looping",
    JSON.stringify(O.spanDayKeys(allDay("2026-08-09", "2026-08-06"))) === JSON.stringify(["2026-08-09"]));
  check("a row with no start covers nothing", O.spanDayKeys({ all_day: true }).length === 0);

  // A timed evening event that runs to midnight is ONE evening. Counting the
  // instant it ends as a day would paint tomorrow's cell for every dinner that
  // ends at 12:00am, which is most of them.
  const timed = (sIso, eIso) => ({ all_day: false, start_time: sIso, end_time: eIso });
  const local = (y, m, d, h, min) => new Date(y, m - 1, d, h, min, 0, 0).toISOString();
  check("8pm→midnight is one day, not two",
    JSON.stringify(O.spanDayKeys(timed(local(2026, 8, 6, 20, 0), local(2026, 8, 7, 0, 0)))) ===
    JSON.stringify(["2026-08-06"]),
    JSON.stringify(O.spanDayKeys(timed(local(2026, 8, 6, 20, 0), local(2026, 8, 7, 0, 0)))));
  check("8pm→1am is two days — past midnight really does claim the next cell",
    JSON.stringify(O.spanDayKeys(timed(local(2026, 8, 6, 20, 0), local(2026, 8, 7, 1, 0)))) ===
    JSON.stringify(["2026-08-06", "2026-08-07"]));
  check("a timed event with no end covers one day",
    JSON.stringify(O.spanDayKeys(timed(local(2026, 8, 6, 9, 0), null))) === JSON.stringify(["2026-08-06"]));
  check("spanPosition reports which day of the span a cell is",
    (() => {
      const ev = allDay("2026-08-06", "2026-08-09");
      const p = O.spanPosition(ev, "2026-08-08");
      return p.total === 4 && p.index === 2;
    })());
  check("spanPosition on a day outside the span does not go negative",
    O.spanPosition(allDay("2026-08-06", "2026-08-09"), "2026-09-01").index === 0);

  // ─── 6. birthdays project, they never persist ─────────────────────────────
  const PEOPLE = [
    { id: "p1", name: "Mom", month: 3, day: 14, year: 1962 },
    { id: "p2", name: "Dev", month: 8, day: 6, year: null },
    { id: "p3", name: "Bad", month: 13, day: 40, year: 1990 },
  ];
  const bdays = O.birthdayOccurrences(PEOPLE, new Date(2026, 0, 1), new Date(2026, 11, 31));
  check("one occurrence per valid birthday per year", bdays.length === 2, String(bdays.length));
  check("an out-of-range month/day is dropped, not clamped into a wrong date",
    !bdays.some((b) => b.title === "Bad"));
  check("the age is the age reached on that birthday",
    (bdays.find((b) => b.title === "Mom") || {}).turns === 64,
    String((bdays.find((b) => b.title === "Mom") || {}).turns));
  check("no birth year means no age, not a guessed one",
    (bdays.find((b) => b.title === "Dev") || {}).turns === null);
  check("every projected birthday is flagged as an overlay and is all-day",
    bdays.every((b) => b.overlay === "birthday" && b.all_day === true));
  check("no projected row can be mistaken for a saveable event id",
    bdays.every((b) => String(b.id).startsWith("birthday:")));
  check("a two-year window yields two occurrences of the same person",
    O.birthdayOccurrences([PEOPLE[0]], new Date(2026, 0, 1), new Date(2027, 11, 31)).length === 2);
  check("a window that misses the date yields nothing",
    O.birthdayOccurrences([PEOPLE[0]], new Date(2026, 5, 1), new Date(2026, 6, 1)).length === 0);

  // ─── 7. the merge ─────────────────────────────────────────────────────────
  const real = [{ id: "e1", title: "Standup", all_day: false, start_time: local(2026, 8, 6, 9, 0), end_time: null }];
  const merged = O.withOverlays(real, { birthdays: PEOPLE, from: new Date(2026, 7, 1), to: new Date(2026, 7, 31) });
  check("the merge keeps the real event and adds the day's birthday",
    merged.length === 2 && merged.some((m) => m.title === "Standup") && merged.some((m) => m.title === "Dev"));
  check("your own event sorts ahead of the overlay on the same day",
    merged[0].title === "Standup", JSON.stringify(merged.map((m) => m.title)));
  check("holidays can be switched off without touching birthdays",
    O.withOverlays([], { birthdays: PEOPLE, from: new Date(2026, 11, 20), to: new Date(2026, 11, 31), holidays: false })
      .every((m) => m.overlay !== "holiday"));
  check("holidays are on by default",
    O.withOverlays([], { birthdays: [], from: new Date(2026, 11, 20), to: new Date(2026, 11, 31) })
      .some((m) => m.overlay === "holiday"));
  check("a projected holiday is all-day and carries no saveable id",
    O.holidayOccurrences(new Date(2026, 11, 24), new Date(2026, 11, 26))
      .every((h) => h.all_day && h.overlay === "holiday" && String(h.id).startsWith("holiday:")));
} catch (e) {
  failed++;
  console.error(`FAIL: smoke crashed — ${(e && e.stack) || e}`);
} finally {
  rmSync(OUT_DIR, { recursive: true, force: true });
}


// ─── calendar days, not elapsed 24-hour blocks ───────────────────────────────
// The Markets tabs printed a flag's age with Math.floor(ms / 86400000), which
// answers a different question: a flag that fired at 4:05pm Thursday, read at
// 8am Friday, is sixteen hours old, so it read "Flagged today" — on the line
// whose only job is telling you how fresh the plan is, on the morning you act.
{
  const { calendarDaysBetween } = await import("../src/lib/dates.js");
  const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
  check("same day is zero, whatever the hours",
    calendarDaysBetween(at(2026, 8, 6, 1), at(2026, 8, 6, 23)) === 0);
  check("a flag from after Thursday's close is ONE day old on Friday morning",
    calendarDaysBetween(at(2026, 8, 6, 16, 5), at(2026, 8, 7, 8, 0)) === 1,
    String(calendarDaysBetween(at(2026, 8, 6, 16, 5), at(2026, 8, 7, 8, 0))));
  check("...which the millisecond version got wrong",
    Math.floor((at(2026, 8, 7, 8, 0) - at(2026, 8, 6, 16, 5)) / 86400000) === 0);
  check("two minutes either side of midnight is still a day",
    calendarDaysBetween(at(2026, 8, 6, 23, 59), at(2026, 8, 7, 0, 1)) === 1);
  check("a week is seven", calendarDaysBetween(at(2026, 8, 1), at(2026, 8, 8)) === 7);
  // DST: 8 Mar 2026 is the US spring-forward. The quotient is 0.958 of a day
  // across it, which floors to 0 and rounds to 1 — one is the right answer.
  check("a spring-forward night is one day, not zero",
    calendarDaysBetween(at(2026, 3, 7, 12), at(2026, 3, 8, 12)) === 1);
  check("an autumn fall-back night is one day, not two",
    calendarDaysBetween(at(2026, 11, 1, 12), at(2026, 11, 2, 12)) === 1);
  check("a malformed stamp yields null rather than NaN",
    calendarDaysBetween("not a date") === null && calendarDaysBetween(null) === null);
  check("the future reads negative rather than wrapping",
    calendarDaysBetween(at(2026, 8, 8), at(2026, 8, 6)) === -2);

  const { readFileSync } = await import("node:fs");
  for (const f of ["StocksPanel", "AltSeasonPanel", "StockSheet", "AltCoinSheet"]) {
    check(`${f} no longer divides milliseconds to get a day`,
      !readFileSync(`src/pages/markets/${f}.jsx`, "utf8").includes("86400000"));
  }
}

console.log(failed ? `\nHOLIDAYS SMOKE FAILED (${failed})` : "\nHOLIDAYS SMOKE PASS");
process.exit(failed ? 1 : 0);
