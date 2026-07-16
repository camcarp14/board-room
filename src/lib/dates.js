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
