// ─── Calendar overlays and multi-day spans ───────────────────────────────────
// Two jobs the month grid needed and did not have:
//
//   1. SPANS. An event stored with a start and an end could only ever appear on
//      its start day, because the grid keyed every occurrence by exactly one
//      date. A trip from the 6th to the 9th showed up on the 6th and nowhere
//      else, which is indistinguishable from not having entered it.
//
//   2. OVERLAYS. Birthdays live in their own table (month/day/year, no row per
//      year) and holidays are a closed-form function of the year — neither is a
//      personal_events row and neither should become one. They are projected
//      into event-SHAPED objects here, at render time, so the grid can treat
//      everything uniformly without anything being written to the database.
//
// Overlay rows carry `overlay: 'birthday' | 'holiday'` and a synthetic id
// prefixed with that word. Nothing may pass one to a save or a delete: they
// have no database identity, and the panel keys its edit affordances off this
// flag rather than off the id's shape.
//
// LOCAL-CALENDAR MATH, NOT MILLISECOND MATH — see lib/recurrence.js for why.
// Pure. scripts/holidays-smoke.mjs exercises it.

import { holidaysBetween } from "./holidays.js";

const pad = (n) => String(n).padStart(2, "0");
const dayKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// A corrupt or hand-edited row must not be able to paint a decade of cells.
// Nothing legitimate on a personal calendar spans a year.
const MAX_SPAN_DAYS = 400;

/**
 * The local day key an occurrence STARTS on.
 *
 * All-day rows are keyed off the stored string rather than the parsed date,
 * matching what the grid has always done: an all-day event is written as
 * midnight local, and re-deriving its day from the instant would move it a day
 * for anyone whose offset makes local midnight fall in the previous UTC day.
 */
export function startDayKey(ev) {
  if (!ev || !ev.start_time) return null;
  if (ev.all_day) return String(ev.start_time).slice(0, 10);
  const d = new Date(ev.start_time);
  return Number.isNaN(d.getTime()) ? null : dayKeyOf(d);
}

function endDayKey(ev) {
  if (!ev || !ev.end_time) return startDayKey(ev);
  if (ev.all_day) return String(ev.end_time).slice(0, 10);
  const d = new Date(ev.end_time);
  if (Number.isNaN(d.getTime())) return startDayKey(ev);
  // A timed event that ends exactly at midnight belongs to the day before it —
  // 8pm-to-midnight is one evening, not two days. Only an end PAST midnight
  // claims the next cell.
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
    const prev = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
    const k = dayKeyOf(prev);
    const s = startDayKey(ev);
    return s && k < s ? s : k;
  }
  return dayKeyOf(d);
}

/**
 * Every local day key an occurrence covers, start and end inclusive.
 *
 * A single-day event returns one key, so callers can use this unconditionally
 * instead of branching on whether an end exists.
 */
export function spanDayKeys(ev) {
  const start = startDayKey(ev);
  if (!start) return [];
  const end = endDayKey(ev);
  if (!end || end <= start) return [start];

  const parse = (k) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = parse(start), b = parse(end);
  if (!a || !b) return [start];

  const out = [];
  for (let d = a, i = 0; d <= b && i < MAX_SPAN_DAYS; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), i++) {
    out.push(dayKeyOf(d));
  }
  return out.length ? out : [start];
}

/** How many days an occurrence spans, and which one of them `day` is. */
export function spanPosition(ev, day) {
  const keys = spanDayKeys(ev);
  const idx = keys.indexOf(day);
  return { total: keys.length, index: idx < 0 ? 0 : idx };
}

/**
 * Birthdays → all-day, event-shaped rows for every year the window touches.
 *
 * A birthday is a (month, day) with an optional birth year, so it repeats by
 * construction and never needs an rrule. `turns` is the age reached ON that
 * occurrence — null when no birth year is recorded, because a guessed age on
 * somebody's birthday is worse than no age at all.
 *
 * Feb 29 lands on Mar 1 in common years: Date(y, 1, 29) rolls over on its own,
 * and rolling forward is what almost everyone does with the date in practice.
 */
export function birthdayOccurrences(birthdays, from, to) {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (!Array.isArray(birthdays) || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return [];
  const lo = dayKeyOf(a), hi = dayKeyOf(b);
  const out = [];
  for (let y = a.getFullYear(); y <= b.getFullYear(); y++) {
    for (const p of birthdays) {
      const m = Number(p && p.month), d = Number(p && p.day);
      if (!Number.isFinite(m) || !Number.isFinite(d) || m < 1 || m > 12 || d < 1 || d > 31) continue;
      const when = new Date(y, m - 1, d);
      const key = dayKeyOf(when);
      if (key < lo || key > hi) continue;
      const born = Number(p.year);
      const turns = Number.isFinite(born) && born > 1900 && born <= y ? y - born : null;
      out.push({
        id: `birthday:${p.id || `${m}-${d}-${p.name}`}:${y}`,
        overlay: "birthday",
        title: p.name || "Birthday",
        notes: p.notes || "",
        location: "",
        category: "personal",
        all_day: true,
        start_time: `${key}T00:00:00.000Z`,
        end_time: null,
        turns,
      });
    }
  }
  return out;
}

/** Holidays → all-day, event-shaped rows. Same contract as birthdays. */
export function holidayOccurrences(from, to) {
  return holidaysBetween(from, to).map((h) => ({
    id: `holiday:${h.key}:${h.day}`,
    overlay: "holiday",
    title: h.name,
    notes: "",
    location: "",
    category: "personal",
    all_day: true,
    start_time: `${h.day}T00:00:00.000Z`,
    end_time: null,
    federal: h.federal,
  }));
}

/**
 * One merged, date-ordered list of real occurrences plus overlays.
 *
 * Real events sort ahead of overlays on the same day: a birthday is context
 * for the day, your 9am is the day. Within overlays, birthdays lead holidays
 * for the same reason.
 */
export function withOverlays(occurrences, { birthdays, from, to, holidays = true } = {}) {
  const extra = [
    ...birthdayOccurrences(birthdays || [], from, to),
    ...(holidays ? holidayOccurrences(from, to) : []),
  ];
  const rank = (e) => (!e.overlay ? 0 : e.overlay === "birthday" ? 1 : 2);
  return [...(Array.isArray(occurrences) ? occurrences : []), ...extra].sort((x, y) => {
    const kx = startDayKey(x) || "", ky = startDayKey(y) || "";
    if (kx !== ky) return kx < ky ? -1 : 1;
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    return new Date(x.start_time) - new Date(y.start_time);
  });
}
