// ─── Anniversaries — the days that already happened ──────────────────────────
// Birthdays answer "who is coming up". This answers the other half of a
// personal calendar: the day somebody died, the day the business started, the
// day you moved in. Same arithmetic — a (month, day) that repeats every year —
// and a deliberately different table, because the two lists are read for
// opposite reasons and mixing them would put a funeral in the gift list.
//
// ONE TABLE, TWO KINDS. `kind` is what the toggle in the panel writes:
// "passing" for a person who died, "milestone" for anything else worth
// remembering on its date. It changes the words and the filter, never the
// mechanics — both repeat annually, both project onto the calendar the same
// way. Adding a third kind later is a row in KINDS and nothing else.
//
// THE YEAR IS THE YEAR IT HAPPENED, and it is optional. When it's there the app
// can say "five years today"; when it isn't, the date still lands on the
// calendar with no count attached. A guessed year on the date somebody died is
// worse than no year at all — the same rule birthdays already follow for ages.
//
// Pure — no React, no Supabase — so scripts/anniversaries-smoke.mjs runs it in
// bare Node.

import { nextBirthdayOccurrence } from "./dates.js";

// `key` is stored in the database and is therefore permanent. `label` is the
// switch in the form and the filter pill; `line` is how the day describes
// itself on the calendar and in the list.
export const ANNIVERSARY_KINDS = [
  { key: "passing", label: "Passed", line: "In memory", plural: "Passed" },
  { key: "milestone", label: "Milestone", line: "Anniversary", plural: "Milestones" },
];

const KIND_KEYS = new Set(ANNIVERSARY_KINDS.map((k) => k.key));
export const DEFAULT_KIND = "milestone";

/** Anything unrecognised reads as a milestone.
 *
 *  Deliberately not "passing": a row whose kind was lost or written by a later
 *  release must not silently describe someone as dead. Wrong in the harmless
 *  direction, on purpose. */
export const normalizeKind = (kind) => (typeof kind === "string" && KIND_KEYS.has(kind) ? kind : DEFAULT_KIND);

export const kindMeta = (kind) => ANNIVERSARY_KINDS.find((k) => k.key === normalizeKind(kind)) || ANNIVERSARY_KINDS[1];

/** Whole years between the year it happened and the occurrence being drawn.
 *
 *  Null unless there is a real, sane year AND at least one full year has
 *  passed: "0 years" on the day itself is noise, and a year from the future or
 *  from 1802 is a typo the calendar shouldn't repeat back with confidence. */
export function yearsSince(row, occurrenceYear) {
  const from = Number(row && row.year);
  const y = Number(occurrenceYear);
  if (!Number.isFinite(from) || !Number.isFinite(y)) return null;
  if (from < 1900 || from > y) return null;
  const n = y - from;
  return n >= 1 ? n : null;
}

/** How an occurrence describes itself: "In memory · 5 years", "Anniversary". */
export function anniversaryLine(row, occurrenceYear) {
  const n = yearsSince(row, occurrenceYear);
  const base = kindMeta(row && row.kind).line;
  return n == null ? base : `${base} · ${n} year${n === 1 ? "" : "s"}`;
}

/** A (month, day) that a calendar can actually use. */
export const isValidDate = (row) => {
  const m = Number(row && row.month), d = Number(row && row.day);
  return Number.isFinite(m) && Number.isFinite(d) && m >= 1 && m <= 12 && d >= 1 && d <= 31;
};

/** Rows in the order the list shows them: soonest next occurrence first.
 *
 *  Each row is returned with `next` and `daysUntil` attached, so the panel
 *  groups and labels off the same numbers this sorted by rather than
 *  recomputing them against a clock that has moved on since.
 */
export function sortByNextOccurrence(rows, fromDate = new Date()) {
  return (Array.isArray(rows) ? rows : [])
    .filter(isValidDate)
    .map((r) => ({ ...r, kind: normalizeKind(r.kind), ...nextBirthdayOccurrence(Number(r.month), Number(r.day), fromDate) }))
    .sort((a, b) => a.daysUntil - b.daysUntil || String(a.name || "").localeCompare(String(b.name || "")));
}

/** The panel's filter. "all" is not a kind — it's the absence of one. */
export function filterByKind(rows, kind) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!kind || kind === "all") return list;
  return list.filter((r) => normalizeKind(r.kind) === kind);
}
