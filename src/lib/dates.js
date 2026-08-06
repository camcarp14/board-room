// Date + birthday helpers, shared across Brief, the Docket, and Birthdays.
// Feb 29 falls back to Feb 28 in common years — a fine convention for birthdays.

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

function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
export function nextBirthdayOccurrence(month, day, fromDate = new Date()) {
  const today = new Date(fromDate); today.setHours(0, 0, 0, 0);
  const tryDate = (y) => {
    const d = (month === 2 && day === 29 && !isLeapYear(y)) ? 28 : day;
    return new Date(y, month - 1, d);
  };
  let next = tryDate(today.getFullYear());
  if (next < today) next = tryDate(today.getFullYear() + 1);
  const daysUntil = Math.round((next - today) / 86400000);
  return { next, daysUntil };
}

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
