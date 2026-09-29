// ─── Event sheet + screenshot import — the small rules with big consequences ──
// CalendarPanel is a thousand-line component, and the few decisions in it that
// silently write the wrong row are pure functions of their inputs. They live
// here so scripts/recurrence-smoke.mjs can run them directly, rather than
// pattern-matching the panel's source and hoping the pattern still means what
// it did.
//
// LOCAL DAYS THROUGHOUT — see lib/dates.js for why never toISOString().slice.

import { localDayKey } from "./dates.js";

/**
 * A title reduced to what a duplicate check should compare: lower-case,
 * alphanumerics only, with the birthday words the screenshots add or drop
 * stripped, so "Sam's Birthday" and "sam bday" are the same person.
 */
export const importNameKey = (s) =>
  (s || "").toLowerCase().replace(/'s birthday|birthday|bday|born/gi, "").replace(/[^a-z0-9]/g, "").trim();

/**
 * Is `existing` (a stored personal_events row) the same event as `item` (one
 * row read off a screenshot: { title, date: "YYYY-MM-DD" })?
 *
 * THE DAY IS THE LOCAL DAY. This compared `start_time.slice(0, 10)` — the UTC
 * day — to the screenshot's local date, and every evening event in the
 * Americas starts on the next UTC day: a 7pm CDT dinner is 00:00Z tomorrow.
 * So re-importing last month's screenshots re-created every evening event as
 * a fresh duplicate, which is the one thing this check exists to prevent.
 */
export function isImportDuplicate(existing, item) {
  if (!existing || !item || !existing.start_time || !item.date) return false;
  return importNameKey(existing.title) === importNameKey(item.title)
    && localDayKey(existing.start_time) === String(item.date);
}
