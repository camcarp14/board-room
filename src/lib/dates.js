// Date + birthday helpers, shared across Brief, the Docket, and Birthdays.
// Feb 29 falls back to Feb 28 in common years — a fine convention for birthdays,
// and the ONE convention: annualDate below is what the Brief, the Birthdays and
// Anniversaries lists, the calendar grid (lib/calendar-overlays.js) and the
// TRMNL feed (an inline copy — it cannot import) all land the day on. They used
// to disagree, the grid rolling to Mar 1 while the Brief said Feb 28, so the
// same person's birthday was on two different days depending on where you looked.

// LOCAL calendar-day helpers. The whole app stores timestamps as UTC ISO but
// the user lives in one local timezone, so "which day is this" and "what's
// today" must be computed from local parts — never `toISOString().slice(0,10)`,
// which is the UTC day and jumps a day early every evening in the Americas.
// This was the single most common bug across the app (evening events shifting
// +1 day on edit, upkeep logging tomorrow, the wrong "today" ring).
export function localDayKey(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function todayISO() { return localDayKey(new Date()); }

/**
 * Whole LOCAL CALENDAR DAYS between two instants — not elapsed 24-hour blocks.
 *
 * `Math.floor((Date.now() - t) / 86400000)` is the tempting version and it is
 * answering a different question. A flag that fired at 4:05pm Thursday, read at
 * 8am Friday, is sixteen hours old — so the ms version says 0 and the Markets
 * tabs printed "Flagged today", on the line whose only job is telling you how
 * fresh the plan is, on the morning you act on it. It is worse on a
 * session-clocked tab: "3d" could span a weekend and mean one trading session,
 * or span midweek and mean three.
 *
 * Both instants are floored to local midnight first, so the answer is a count
 * of date boundaries crossed and DST cannot shift it — the same rule the rest
 * of this file exists to enforce.
 */
export function calendarDaysBetween(fromIso, toDate = new Date()) {
  // NULL IS NOT THE EPOCH. `new Date(null)` is 1970-01-01 and perfectly valid,
  // so the obvious isNaN guard sails straight past a missing stamp and reports
  // an age of twenty thousand days. Same shape as the Number(null) === 0 trap
  // this codebase keeps paying for, one constructor along.
  if (fromIso == null || fromIso === "" || toDate == null) return null;
  const a = fromIso instanceof Date ? fromIso : new Date(fromIso);
  const b = toDate instanceof Date ? toDate : new Date(toDate);
  if (isNaN(a) || isNaN(b)) return null;
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Divide a whole number of local midnights, then round: the quotient is only
  // non-integral across a DST boundary, where it lands on 0.958 or 1.042.
  return Math.round((midnight(b) - midnight(a)) / 86400000);
}

export function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

/** Days in a 1-based month. With no year, February gets its leap-year 29. */
export function daysInMonth(month, year = null) {
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) return 0;
  if (m === 2) return year == null || isLeapYear(Number(year)) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/**
 * Is (month, day) a real date — in `year` when one is given, in SOME year when
 * not? The birthday importer used to accept any day 1–31 in any month, so a
 * pasted "Feb 31" went in as a birthday that the calendar then drew on Mar 3.
 * Feb 29 is real with no year (someone born on a leap day) and in a leap year,
 * and not in a stated common year: nobody was born on 29 Feb 1990.
 */
export function isValidMonthDay(month, day, year = null) {
  const d = Number(day);
  return Number.isInteger(d) && d >= 1 && d <= daysInMonth(month, year);
}

/**
 * The year to show in a date picker for a birthday whose year is not tracked.
 * A native <input type="date"> needs SOME year, and the current one was used
 * blind — which for a Feb 29 birthday built "2026-02-29", a date the input
 * refuses, so the field opened empty and a save without re-picking failed. The
 * current year when the day exists in it, else the most recent leap year.
 */
export function placeholderYear(month, day, fromDate = new Date()) {
  const now = new Date(fromDate).getFullYear();
  for (let y = now; y > now - 9; y--) if (isValidMonthDay(month, day, y)) return y;
  return now;
}

/**
 * The date an annual (month, day) lands on in `year`, as local midnight.
 * A day the month does not have that year CLAMPS to its last day — Feb 29 is
 * Feb 28 in a common year — rather than letting Date(y, 1, 29) roll into
 * March on its own. See the note at the top of this file for why every
 * surface must agree on this.
 */
export function annualDate(year, month, day) {
  const d = Math.min(Number(day), daysInMonth(month, year) || Number(day));
  return new Date(year, Number(month) - 1, d);
}

export function nextBirthdayOccurrence(month, day, fromDate = new Date()) {
  const today = new Date(fromDate); today.setHours(0, 0, 0, 0);
  const tryDate = (y) => annualDate(y, month, day);
  let next = tryDate(today.getFullYear());
  if (next < today) next = tryDate(today.getFullYear() + 1);
  const daysUntil = Math.round((next - today) / 86400000);
  return { next, daysUntil };
}

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
