// ─── Month-grid layout — the lane packer, with answers you can draw ──────────
// lib/calendar-layout.js is the only thing standing between "one trip" and
// "four unrelated chips that happen to share a name". Nothing else exercises
// it: a lane collision does not throw, it renders two bars on top of each
// other and looks like one event with a strange colour. A week-boundary bug
// does not throw either — it draws a five-day trip as two three-day trips.
//
// So every assertion here is a shape a reader can draw on paper first:
//
//   1. A bar that crosses a week boundary becomes TWO segments, and the cut
//      ends are marked so the renderer can square exactly those corners. This
//      is the only cue on screen that the trip continues onto the next row.
//   2. Two events on the same day never share a lane. A lane is a vertical
//      slot held for the segment's whole width, which is the reason this
//      cannot be done per-cell at all.
//   3. Longest-first placement. Placing shortest-first strands long bars in
//      the bottom lane and — worse — makes the same trip change lanes between
//      week rows, so it reads as two different things.
//   4. Overflow counts per DAY, not per week: "+2" under the 14th has to mean
//      two more things happen on the 14th.
//   5. Identical input lays out identically, every render. A grid that
//      reshuffles on re-render reads as live movement.
//
// Zero network, zero DOM. Run with `node scripts/calendar-layout-smoke.mjs`.

import esbuild from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const OUT_DIR = ".callayout-smoke";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

try {
  const out = resolve(OUT_DIR, "layout.mjs");
  esbuild.buildSync({
    entryPoints: ["src/lib/calendar-layout.js"],
    bundle: true, platform: "neutral", format: "esm", outfile: out, logLevel: "silent",
  });
  const L = await import(pathToFileURL(out).href);

  const ev = (id, start, end, extra = {}) => ({
    id, title: id, all_day: true, category: "personal",
    start_time: `${start}T00:00:00.000Z`,
    end_time: end ? `${end}T00:00:00.000Z` : null,
    ...extra,
  });
  const segOf = (r, id) => r.segments.find((s) => s.ev.id === id);

  // ─── 1. weeksOfMonth ──────────────────────────────────────────────────────
  // August 2026 opens on a Saturday and closes on a Monday, so the grid needs
  // Jul 26 at the front and Sep 5 at the back.
  const aug = L.weeksOfMonth(2026, 7);
  check("every row is a whole week, Sunday first", aug.every((w) => w.length === 7));
  check("the grid opens on the Sunday before the 1st", aug[0][0] === "2026-07-26", aug[0][0]);
  check("...and closes on the Saturday after the last", aug[aug.length - 1][6] === "2026-09-05", aug[aug.length - 1][6]);
  check("neighbouring-month days are PRESENT, not blanks — a bar has to be able to cross",
    aug[0].includes("2026-07-31") && aug[0].includes("2026-08-01"));
  check("consecutive rows are exactly 7 days apart",
    aug.every((w, i) => i === 0 || (Date.parse(`${w[0]}T00:00:00Z`) - Date.parse(`${aug[i - 1][0]}T00:00:00Z`)) === 7 * 86400000));
  check("February in a leap year still lays out as whole weeks",
    L.weeksOfMonth(2028, 1).every((w) => w.length === 7));
  check("a month that starts on Sunday needs no leading days",
    L.weeksOfMonth(2026, 2)[0][0] === "2026-03-01", L.weeksOfMonth(2026, 2)[0][0]);

  // ─── 2. one bar, one week ─────────────────────────────────────────────────
  const W = ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"];
  const trip = L.layoutWeek([ev("trip", "2026-08-04", "2026-08-06")], W);
  check("a 3-day event is ONE segment, not three", trip.segments.length === 1, JSON.stringify(trip.segments.length));
  check("...starting in the right column and spanning the right width",
    segOf(trip, "trip").col === 2 && segOf(trip, "trip").span === 3,
    JSON.stringify(segOf(trip, "trip")));
  check("...with both ends its own", !segOf(trip, "trip").continuesLeft && !segOf(trip, "trip").continuesRight);
  check("a single-day event is a 1-column segment",
    L.layoutWeek([ev("one", "2026-08-05")], W).segments[0].span === 1);
  check("an event entirely outside the week is not laid out at all",
    L.layoutWeek([ev("far", "2026-09-01", "2026-09-03")], W).segments.length === 0);

  // ─── 3. the week boundary ─────────────────────────────────────────────────
  // Aug 6 → Aug 11 crosses from the Aug 2 week into the Aug 9 week.
  const W2 = ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15"];
  const long = ev("austin", "2026-08-06", "2026-08-11");
  const a = L.layoutWeek([long], W);
  const b = L.layoutWeek([long], W2);
  check("a bar crossing a week boundary appears in BOTH rows",
    a.segments.length === 1 && b.segments.length === 1);
  check("the first row runs to the week's end and is cut on the right",
    a.segments[0].col === 4 && a.segments[0].span === 3 && a.segments[0].continuesRight === true && a.segments[0].continuesLeft === false,
    JSON.stringify(a.segments[0]));
  check("the second row starts at column 0 and is cut on the left",
    b.segments[0].col === 0 && b.segments[0].span === 3 && b.segments[0].continuesLeft === true && b.segments[0].continuesRight === false,
    JSON.stringify(b.segments[0]));
  // Both rows print it. A continuation with no text is a mystery bar; the
  // squared corner is what says "this is the same trip", not an absent label.
  check("a continuation still carries its title",
    L.segmentShowsTitle(a.segments[0]) === true && L.segmentShowsTitle(b.segments[0]) === true);
  check("the two segments carry different keys, so React cannot reuse one for the other",
    a.segments[0].key !== b.segments[0].key);

  // A bar that swallows a whole week is cut on BOTH sides.
  const both = L.layoutWeek([ev("month", "2026-07-20", "2026-08-20")], W).segments[0];
  check("a bar spanning the entire week is cut at both ends",
    both.col === 0 && both.span === 7 && both.continuesLeft && both.continuesRight, JSON.stringify(both));

  // ─── 4. lanes ─────────────────────────────────────────────────────────────
  const overlap = L.layoutWeek([
    ev("A", "2026-08-03", "2026-08-06"),
    ev("B", "2026-08-04", "2026-08-05"),
    ev("C", "2026-08-05"),
  ], W);
  const lanes = overlap.segments.map((s) => [s.ev.id, s.lane]).sort();
  check("three events overlapping on the 5th take three distinct lanes",
    new Set(overlap.segments.filter((s) => s.col <= 3 && s.col + s.span > 3).map((s) => s.lane)).size === 3,
    JSON.stringify(lanes));
  check("the longest bar takes lane 0",
    segOf(overlap, "A").lane === 0, JSON.stringify(lanes));
  check("no two segments in one lane ever cover the same column",
    (() => {
      const seen = {};
      for (const s of overlap.segments) {
        for (let c = s.col; c < s.col + s.span; c++) {
          const k = `${s.lane}:${c}`;
          if (seen[k]) return false;
          seen[k] = true;
        }
      }
      return true;
    })());
  // Non-overlapping bars REUSE a lane — otherwise a week with six scattered
  // one-day events is six rows tall for no reason.
  const reuse = L.layoutWeek([ev("mon", "2026-08-03"), ev("fri", "2026-08-07")], W);
  check("bars that do not touch share a lane", reuse.segments.every((s) => s.lane === 0), JSON.stringify(reuse.segments.map((s) => s.lane)));
  check("...and the row reports the one lane it actually used", reuse.laneCount === 1, String(reuse.laneCount));

  // ─── 5. overflow, counted per day ─────────────────────────────────────────
  const many = L.layoutWeek(
    Array.from({ length: 7 }, (_, i) => ev(`e${i}`, "2026-08-05")),
    W,
  );
  check("only MAX_LANES bars are drawn", many.segments.length === L.MAX_LANES, String(many.segments.length));
  check("the rest are counted against the day they fall on",
    many.overflow["2026-08-05"] === 7 - L.MAX_LANES, JSON.stringify(many.overflow));
  check("a day with nothing hidden has no overflow entry", many.overflow["2026-08-03"] === undefined);
  // An overflowing multi-day bar counts against EVERY day it would have
  // covered — "+1" under the 6th must mean something is hidden on the 6th.
  // MAX_LANES bars fill every lane across Tue-Fri; the shorter one has nowhere
  // to go and must be counted on the two days it would have covered.
  const spillMulti = L.layoutWeek([
    ...Array.from({ length: L.MAX_LANES }, (_, i) => ev(`f${i}`, "2026-08-04", "2026-08-07")),
    ev("hidden", "2026-08-05", "2026-08-06"),
  ], W);
  check("a hidden multi-day bar increments every day it covers",
    spillMulti.overflow["2026-08-05"] === 1 && spillMulti.overflow["2026-08-06"] === 1 &&
    spillMulti.overflow["2026-08-04"] === undefined,
    JSON.stringify(spillMulti.overflow));

  // ─── 6. determinism ───────────────────────────────────────────────────────
  const set = [ev("x", "2026-08-03", "2026-08-05"), ev("y", "2026-08-04"), ev("z", "2026-08-04", "2026-08-08")];
  const r1 = L.layoutWeek(set, W);
  const r2 = L.layoutWeek([...set].reverse(), W);
  const shape = (r) => r.segments.map((s) => `${s.ev.id}:${s.lane}:${s.col}:${s.span}`).sort().join("|");
  check("input order does not change the layout", shape(r1) === shape(r2), `${shape(r1)} vs ${shape(r2)}`);

  // ─── 7. the shapes that must not crash ────────────────────────────────────
  check("an empty week lays out empty", L.layoutWeek([], W).segments.length === 0);
  check("a null occurrence list is handled", L.layoutWeek(null, W).segments.length === 0);
  check("a row with no start_time is skipped rather than thrown on",
    L.layoutWeek([{ id: "bad", title: "Bad" }], W).segments.length === 0);
  check("a timed event still lays out",
    L.layoutWeek([{ id: "t", title: "T", all_day: false, start_time: new Date(2026, 7, 5, 9, 0).toISOString(), end_time: null }], W).segments.length === 1);
  check("an overlay row lays out like any other",
    L.layoutWeek([ev("bday", "2026-08-05", null, { overlay: "birthday" })], W).segments[0].ev.overlay === "birthday");

  // ─── 8. the agenda comparator ─────────────────────────────────────────────
  const rows = [
    { overlay: "holiday", title: "Christmas", start_time: "2026-12-25T00:00:00.000Z" },
    { title: "Standup", start_time: new Date(2026, 11, 25, 9, 0).toISOString() },
    { overlay: "birthday", title: "Mom", start_time: "2026-12-25T00:00:00.000Z" },
    { title: "Dinner", start_time: new Date(2026, 11, 25, 19, 0).toISOString() },
  ].sort(L.agendaOrder);
  check("your own events come first, in clock order, then the overlays",
    rows.map((r) => r.title).join(",") === "Standup,Dinner,Christmas,Mom",
    rows.map((r) => r.title).join(","));
} catch (e) {
  failed++;
  console.error(`FAIL: smoke crashed — ${(e && e.stack) || e}`);
} finally {
  rmSync(OUT_DIR, { recursive: true, force: true });
}

console.log(failed ? `\nCALENDAR LAYOUT SMOKE FAILED (${failed})` : "\nCALENDAR LAYOUT SMOKE PASS");
process.exit(failed ? 1 : 0);
