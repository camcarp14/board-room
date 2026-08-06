// ─── US holidays, computed — no network, no API key, no list to go stale ─────
// Every date here is derivable from the year, so the calendar can show 2019 and
// 2043 with the same code path and nothing to refresh. A hosted holiday API
// would be one more feed that can 429, one more thing to cache, and one more
// reason a month grid renders empty — for data that is a closed-form function
// of the calendar itself.
//
// LOCAL-CALENDAR MATH, NOT MILLISECOND MATH — same rule as lib/recurrence.js:
// every date is built with Date(y, m, d) so it resolves in the user's own zone,
// and day keys are formatted from local parts rather than toISOString(), which
// is the UTC day and reports Christmas as the 24th for anyone west of London.
//
// SCOPE: US federal holidays plus the observances people actually want to see
// on a personal calendar (Valentine's, Easter, Mother's/Father's Day,
// Halloween, the two Eves). Deliberately NOT: bank-only observed-Monday
// shifts, state holidays, or religious calendars beyond Easter — each would be
// a judgment call this file has no way to get right for one specific person.
//
// Pure. scripts/holidays-smoke.mjs checks every rule against dates you can
// verify by eye.

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The nth `weekday` of a month. n >= 1 counts forward; n === -1 is the LAST
 * one, which is how Memorial Day is defined and cannot be expressed as a fixed
 * ordinal (May has four Mondays some years and five in others).
 *
 * @param month 0-11
 * @param weekday 0 = Sunday
 */
export function nthWeekdayOfMonth(year, month, weekday, n) {
  if (n === -1) {
    const last = new Date(year, month + 1, 0);          // day 0 of next month
    const back = (last.getDay() - weekday + 7) % 7;
    return new Date(year, month, last.getDate() - back);
  }
  const first = new Date(year, month, 1);
  const forward = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + forward + (n - 1) * 7);
}

/**
 * Easter Sunday, by the anonymous Gregorian algorithm (Meeus/Jones/Butcher).
 * Valid for any Gregorian year. It is the only moving feast here, and four
 * other things people put on a calendar hang off it, so it is worth the
 * fifteen lines rather than a lookup table that ends in 2030.
 */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);  // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * Every holiday in one year, in date order.
 *
 * `federal` marks the eleven days that are actual US federal holidays — banks
 * shut, mail stops. The rest are observances, and the distinction is kept so a
 * caller can show one set and not the other without re-deriving the list.
 */
export function holidaysForYear(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return [];
  const easter = easterSunday(y);

  const out = [
    { key: "new-years", name: "New Year's Day", date: new Date(y, 0, 1), federal: true },
    { key: "mlk", name: "MLK Day", date: nthWeekdayOfMonth(y, 0, 1, 3), federal: true },
    { key: "valentines", name: "Valentine's Day", date: new Date(y, 1, 14), federal: false },
    { key: "presidents", name: "Presidents' Day", date: nthWeekdayOfMonth(y, 1, 1, 3), federal: true },
    { key: "st-patricks", name: "St. Patrick's Day", date: new Date(y, 2, 17), federal: false },
    { key: "good-friday", name: "Good Friday", date: addDays(easter, -2), federal: false },
    { key: "easter", name: "Easter", date: easter, federal: false },
    { key: "mothers", name: "Mother's Day", date: nthWeekdayOfMonth(y, 4, 0, 2), federal: false },
    { key: "memorial", name: "Memorial Day", date: nthWeekdayOfMonth(y, 4, 1, -1), federal: true },
    { key: "fathers", name: "Father's Day", date: nthWeekdayOfMonth(y, 5, 0, 3), federal: false },
    { key: "juneteenth", name: "Juneteenth", date: new Date(y, 5, 19), federal: true },
    { key: "independence", name: "Independence Day", date: new Date(y, 6, 4), federal: true },
    { key: "labor", name: "Labor Day", date: nthWeekdayOfMonth(y, 8, 1, 1), federal: true },
    { key: "indigenous", name: "Indigenous Peoples' Day", date: nthWeekdayOfMonth(y, 9, 1, 2), federal: true },
    { key: "halloween", name: "Halloween", date: new Date(y, 9, 31), federal: false },
    { key: "veterans", name: "Veterans Day", date: new Date(y, 10, 11), federal: true },
    { key: "thanksgiving", name: "Thanksgiving", date: nthWeekdayOfMonth(y, 10, 4, 4), federal: true },
    // The day after Thanksgiving moves with it, so it is derived rather than
    // pinned — "the 4th Friday of November" is wrong in years where the month
    // starts on a Friday.
    { key: "black-friday", name: "Black Friday", date: addDays(nthWeekdayOfMonth(y, 10, 4, 4), 1), federal: false },
    { key: "christmas-eve", name: "Christmas Eve", date: new Date(y, 11, 24), federal: false },
    { key: "christmas", name: "Christmas", date: new Date(y, 11, 25), federal: true },
    { key: "new-years-eve", name: "New Year's Eve", date: new Date(y, 11, 31), federal: false },
  ];

  return out
    .map((h) => ({ key: h.key, name: h.name, day: dayKey(h.date), federal: h.federal }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Every holiday whose day falls inside [from, to], inclusive on both ends.
 * Spans year boundaries — a December-to-January window is the normal case for
 * a month grid with a week of slack on each side, and a single-year list would
 * silently drop New Year's Day from it.
 */
export function holidaysBetween(from, to) {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return [];
  const lo = dayKey(a);
  const hi = dayKey(b);
  const out = [];
  for (let y = a.getFullYear(); y <= b.getFullYear(); y++) {
    for (const h of holidaysForYear(y)) {
      if (h.day >= lo && h.day <= hi) out.push(h);
    }
  }
  return out;
}
