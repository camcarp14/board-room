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

/**
 * ONE upcoming list: birthdays and anniversaries, merged, soonest first.
 *
 * The Brief's "Birthdays" card used to read one table and the TRMNL feed used
 * to publish one table, and both were about to grow a second copy of the same
 * "next occurrence within N days" arithmetic. This is that arithmetic, once.
 *
 * The rows come back UNIFORM — `{ key, id, name, kind, note, next, daysUntil }`
 * — so a renderer never branches on which table a row came from. `kind` is
 * "birthday" for a birthday and the anniversary's own kind otherwise, which is
 * what lets a surface tint or label the three differently without knowing how
 * either table is shaped. `note` is the trailing descriptor already worded:
 * "turns 41", "In memory · 5 years", "Anniversary".
 *
 * `key` is prefixed by family because both tables generate their own uuids and
 * a React list keyed on a bare id would be one collision away from dropping a
 * row silently.
 *
 * Everything is computed against the OCCURRENCE year, not this year: a birthday
 * on Jan 2 read on Dec 30 turns the age it will turn in January, and an
 * anniversary the same. Getting that wrong is invisible for 50 weeks a year.
 */
export function upcomingDates({ birthdays, anniversaries, withinDays = 14, from = new Date() } = {}) {
  const out = [];
  for (const b of Array.isArray(birthdays) ? birthdays.filter(Boolean) : []) {
    if (!isValidDate(b)) continue;
    const { next, daysUntil } = nextBirthdayOccurrence(Number(b.month), Number(b.day), from);
    const born = Number(b.year);
    const turns = Number.isFinite(born) && born > 1900 && born <= next.getFullYear() ? next.getFullYear() - born : null;
    out.push({
      key: `birthday:${b.id}`, id: b.id, name: b.name || "Birthday", kind: "birthday",
      note: turns == null ? "" : `turns ${turns}`, next, daysUntil,
    });
  }
  for (const a of Array.isArray(anniversaries) ? anniversaries.filter(Boolean) : []) {
    if (!isValidDate(a)) continue;
    const { next, daysUntil } = nextBirthdayOccurrence(Number(a.month), Number(a.day), from);
    out.push({
      key: `anniversary:${a.id}`, id: a.id, name: a.name || "Anniversary", kind: normalizeKind(a.kind),
      note: anniversaryLine(a, next.getFullYear()), next, daysUntil,
    });
  }
  const cap = Number.isFinite(Number(withinDays)) ? Number(withinDays) : 14;
  return out
    .filter((r) => r.daysUntil >= 0 && r.daysUntil <= cap)
    .sort((a, b) => a.daysUntil - b.daysUntil || String(a.name).localeCompare(String(b.name)));
}

/** The panel's filter. "all" is not a kind — it's the absence of one. */
export function filterByKind(rows, kind) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!kind || kind === "all") return list;
  return list.filter((r) => normalizeKind(r.kind) === kind);
}
