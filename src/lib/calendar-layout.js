// ─── Month-grid layout — continuous bars, packed into lanes ──────────────────
// A multi-day event is ONE THING. The grid used to draw it as a separate chip
// in each day cell, which is not a smaller version of a bar — it is a
// different claim: four chips saying "Austin trip" reads as four events that
// happen to share a name, and nothing on screen says the 6th and the 9th are
// the same trip.
//
// So the week is the unit of layout, not the day. For each week row this
// computes SEGMENTS: one per event per week it touches, carrying the column it
// starts in, how many columns it covers, and whether it was cut by the week
// boundary on either side (a cut end renders flat, an owned end renders
// rounded — that shape is the only thing telling you the trip continues onto
// the next row).
//
// Segments are then packed into LANES, greedily, longest-first. Lane index is
// the vertical slot inside the week row, and a segment holds its lane for its
// whole width — which is the entire reason this cannot be done per-cell: a
// bar spanning Wed→Sat has to sit at the same height in all four columns, and
// a day cell rendering its own list has no way to know that.
//
// Pure — no DOM, no clock. scripts/calendar-layout-smoke.mjs exercises it.

import { spanDayKeys, startDayKey } from "./calendar-overlays.js";

// Lanes drawn before the row gives up and counts the rest. A lane is 26px so a
// chip in a 50px column can wrap to two lines instead of truncating "Standup"
// to "Stan…", and three of those plus the date row puts a BUSY week at ~110px.
// A row only gets as tall as the lanes it actually uses, so a quiet week is
// still one lane — the height is adaptive, not budgeted.
export const MAX_LANES = 3;

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * The visible grid as a list of weeks, each a list of 7 local day keys.
 *
 * Always whole weeks, Sunday-first, including the leading and trailing days
 * that belong to the neighbouring months — a bar that starts on Jan 31 and
 * runs to Feb 2 has to have somewhere to be drawn in BOTH months, and a grid
 * that renders blanks for those cells cuts the bar off at the month edge.
 */
export function weeksOfMonth(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const last = new Date(year, month + 1, 0);
  const end = new Date(year, month + 1, 0 + (6 - last.getDay()));
  const weeks = [];
  let cursor = start;
  // 6 rows is the maximum a Gregorian month can occupy; the guard is against a
  // corrupt date rather than a real calendar.
  while (cursor <= end && weeks.length < 6) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(keyOf(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + i)));
    }
    weeks.push(week);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7);
  }
  return weeks;
}

/**
 * Lay one week out.
 *
 * @param occurrences expanded occurrences + overlays, any order
 * @param week        7 local day keys, Sunday first
 * @returns { segments, overflow } — segments carry lane/col/span/edges;
 *          overflow is { dayKey: count } for what the lanes could not hold
 *
 * ORDERING IS THE WHOLE ALGORITHM. Longest bars are placed first so a
 * four-day trip gets lane 0 and the single-day appointments pack around it;
 * placing shortest-first strands long bars in the bottom lane where they read
 * as an afterthought, and makes the same trip jump lanes between week rows.
 * Ties break on start day then title, so identical data lays out identically
 * every render — a grid that reshuffles on re-render looks like live movement.
 */
export function layoutWeek(occurrences, week) {
  const first = week[0];
  const last = week[week.length - 1];
  const colOf = (key) => week.indexOf(key);

  const items = [];
  for (const ev of Array.isArray(occurrences) ? occurrences : []) {
    const days = spanDayKeys(ev);
    if (!days.length) continue;
    const evStart = days[0];
    const evEnd = days[days.length - 1];
    if (evEnd < first || evStart > last) continue;      // not in this week at all

    const from = evStart < first ? first : evStart;
    const to = evEnd > last ? last : evEnd;
    const col = colOf(from);
    const endCol = colOf(to);
    if (col < 0 || endCol < 0) continue;
    items.push({
      ev,
      col,
      span: endCol - col + 1,
      // A cut end is the week boundary, not the event's own. The renderer
      // squares that corner off, which is the only cue that the bar keeps
      // going on the row below.
      continuesLeft: evStart < first,
      continuesRight: evEnd > last,
      _sortStart: evStart,
      _len: days.length,
    });
  }

  items.sort((a, b) =>
    b.span - a.span ||
    b._len - a._len ||
    (a._sortStart < b._sortStart ? -1 : a._sortStart > b._sortStart ? 1 : 0) ||
    String(a.ev.title || "").localeCompare(String(b.ev.title || "")));

  // lanes[i] is a 7-slot occupancy row for lane i.
  const lanes = [];
  const segments = [];
  const overflow = {};

  for (const it of items) {
    let placed = -1;
    for (let i = 0; i < lanes.length && placed < 0; i++) {
      let free = true;
      for (let c = it.col; c < it.col + it.span; c++) if (lanes[i][c]) { free = false; break; }
      if (free) placed = i;
    }
    if (placed < 0 && lanes.length < MAX_LANES) {
      lanes.push(new Array(7).fill(false));
      placed = lanes.length - 1;
    }
    if (placed < 0) {
      // No lane left. Count it against every day it would have covered, so the
      // "+2" in a cell means "two more things happen on THIS day" rather than
      // "two more bars exist somewhere in this week".
      for (let c = it.col; c < it.col + it.span; c++) overflow[week[c]] = (overflow[week[c]] || 0) + 1;
      continue;
    }
    for (let c = it.col; c < it.col + it.span; c++) lanes[placed][c] = true;
    segments.push({
      ev: it.ev,
      key: `${it.ev.id}@${week[it.col]}`,
      lane: placed,
      col: it.col,
      span: it.span,
      continuesLeft: it.continuesLeft,
      continuesRight: it.continuesRight,
    });
  }

  return { segments, overflow, laneCount: lanes.length };
}

/**
 * Whether a segment should carry its title. Always — a continuation with no
 * text is a mystery bar, and the squared corner already says it is a
 * continuation. This was briefly the other way round on the theory that a
 * repeated title reads as a weekly recurrence; on screen it just read as an
 * unexplained block of colour, which is worse.
 *
 * Kept as a function rather than inlined because it IS a judgment call and the
 * next person to reconsider it should find the reasoning, not a boolean.
 */
export function segmentShowsTitle(seg) { // eslint-disable-line no-unused-vars
  return true;
}

/** Sort key for the day agenda: real events by time, overlays last. */
export function agendaOrder(a, b) {
  return (a.overlay ? 1 : 0) - (b.overlay ? 1 : 0) ||
    new Date(a.start_time) - new Date(b.start_time) ||
    String(a.title || "").localeCompare(String(b.title || ""));
}

export { startDayKey };
