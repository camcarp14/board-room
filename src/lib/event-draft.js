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

/* ══ the event sheet's draft ════════════════════════════════════════════════
 * The sheet holds a flat draft — { date, endDate, time, endTime, allDay, … },
 * all strings the inputs produce ("YYYY-MM-DD", "HH:MM", "" for empty) — and
 * two things read it: the sentence under the fields that says what you are
 * about to save, and the save. They used to work the end out separately, and
 * disagreed about exactly one case, the one below.
 */

const nextDayKey = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  return localDayKey(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
};

/**
 * Where a draft ends: { timed, endDate, endTime, overnight }.
 *
 * AN END TIME EARLIER THAN THE START, WITH NO END DATE, IS TOMORROW. From
 * 23:00 to 01:00 is a late night, not a negative duration. The readback said
 * "11:00 PM – 1:00 AM" while the save built 01:00 on the START day, found it
 * before the start and quietly stored no end at all — so the event showed as
 * an open-ended 11pm on the grid, the Brief and TRMNL, under a sentence that
 * had promised otherwise. The end rolls to the next day now, and both sides
 * read it from here. An explicit end date always wins; an end time equal to
 * the start is a zero-length event on the day, not a 24-hour one.
 *
 * `overnight` is true whenever the end lands on the next day at an earlier
 * clock time than the start — rolled here, or typed as an explicit end date —
 * so an overnight event reads the same when it is reopened for edit (where
 * the stored end comes back as an explicit end date) as when it was typed.
 *
 * Untimed drafts carry only the all-day span's last day, if it has one.
 */
export function draftEnd(f) {
  const timed = !f.allDay && !!f.time;
  const explicit = f.endDate && f.endDate > f.date ? f.endDate : null;
  if (!timed) return { timed, endDate: explicit, endTime: null, overnight: false };
  if (!f.endTime && !explicit) return { timed, endDate: null, endTime: null, overnight: false };
  const endTime = f.endTime || f.time;
  const rolled = !explicit && !!f.endTime && f.endTime < f.time ? nextDayKey(f.date) : null;
  const endDate = explicit || rolled || f.date;
  const overnight = endDate === nextDayKey(f.date) && endTime < f.time;
  return { timed, endDate, endTime, overnight };
}

/**
 * Draft → the stored row. Three things this gets right that it once didn't:
 *
 *   A BLANK TIME IS ALL-DAY, not midnight. The switch and the empty field are
 *   two ways of saying the same thing, and treating an empty `time` as
 *   00:00 silently filed a lunch as a 12am appointment.
 *
 *   THE END CAN BE ON A DIFFERENT DAY. `end_time` used to be built from
 *   `f.date` no matter what, which made a multi-day event unrepresentable —
 *   not hard, unrepresentable — and an end earlier than the start is clamped
 *   away rather than stored as a negative duration that expandEvents would
 *   carry into every occurrence. (An end TIME earlier than the start with no
 *   end date is not one of those: it is overnight — see draftEnd.)
 *
 *   AN ALL-DAY SPAN ENDS AT MIDNIGHT ON ITS LAST DAY, inclusive: the grid
 *   keys all-day rows off the stored date string (see calendar-overlays.js),
 *   so `${endDate}T00:00:00` is exactly the last cell it should paint.
 */
export function draftToFields(f) {
  const end = draftEnd(f);
  const start_time = end.timed
    ? new Date(`${f.date}T${f.time}:00`).toISOString()
    : new Date(`${f.date}T00:00:00`).toISOString();

  let end_time = null;
  if (end.timed) {
    // A timed event's end takes the end date when there is one, and the end
    // time when there is one; either alone is still an end.
    if (end.endTime) {
      end_time = new Date(`${end.endDate}T${end.endTime}:00`).toISOString();
      if (new Date(end_time) < new Date(start_time)) end_time = null;
    }
  } else if (end.endDate) {
    end_time = new Date(`${end.endDate}T00:00:00`).toISOString();
  }

  return {
    title: String(f.title || "").trim(), notes: f.notes, start_time, end_time,
    all_day: !end.timed, location: f.location, category: f.category,
  };
}

const shortDay = (key) => {
  const d = key ? new Date(`${key}T00:00:00`) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
};
const clock = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return null;
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
};

/** The draft's dates and times, said back as one sentence — the save's own end. */
export function draftReadback(f) {
  const end = draftEnd(f);
  const multi = f.endDate && f.endDate > f.date;
  const days = multi
    ? Math.round((new Date(`${f.endDate}T00:00:00`) - new Date(`${f.date}T00:00:00`)) / 86400000) + 1
    : 1;
  if (!end.timed) {
    const span = multi
      ? `All day · ${shortDay(f.date)} – ${shortDay(f.endDate)} (${days} days)`
      : `All day · ${shortDay(f.date)}`;
    // The switch is off but no time was typed. That saves as all-day, which is
    // right — but it has to SAY so, or the switch reads as a promise the save
    // then quietly breaks.
    return f.allDay ? span : `${span} — add a start time to give it one`;
  }
  const from = clock(f.time);
  const to = clock(end.endTime);
  // Overnight names both days, so "1:00 AM" can't be read as this morning.
  if (end.overnight) return `${shortDay(f.date)} ${from} → ${shortDay(end.endDate)} ${to} (overnight)`;
  if (multi) return `${shortDay(f.date)} ${from} → ${shortDay(f.endDate)} ${to || from} (${days} days)`;
  return f.endTime ? `${shortDay(f.date)} · ${from} – ${to}` : `${shortDay(f.date)} · ${from}`;
}
