// ─── Where a note lives: on the wall, on the shelf, or in the bin ────────────
//
// Three questions this file answers, and every one of them used to be answered
// in two places or not at all.
//
//   WHICH NOTES ARE ON THE BRIEF. The Brief's tile took the first five of
//   everything. There was no way to keep a note and not have it on the landing
//   page, so the only way to clear the homescreen was to delete the note.
//
//   WHICH NOTES ARE GONE, AND FOR HOW LONG. A delete was a DELETE — the row left
//   the table — and the only undo was a six-second toast holding the rows in
//   memory. Miss it, background the PWA, or reload, and the note was
//   unrecoverable. Every other table in this app that lost something valuable
//   got a soft delete (affirmations, dream_items, see the long note in
//   src/data/db.js); personal_notes is the one that kept the hard one, and it is
//   the table people type into most.
//
//   WHAT COLOUR A NOTE IS. `color` has existed since the pins/seals upgrade and
//   only ever drew a 8px dot. The value was there; nothing spent it.
//
// PURE, AND THAT IS THE POINT. Both note surfaces (pages/personal/NotesPanel.jsx
// and pages/brief/NotesTile.jsx) filter the same rows and must not disagree — a
// note archived off the homescreen that still shows on the homescreen is the bug
// this module exists to make impossible, and it is a bug you cannot see by
// reading either file alone. scripts/notes-shelf-smoke.mjs drives these
// directly, so "the two surfaces agree" is executed rather than trusted.

/** A row is in the bin if it carries a deletion stamp. Nothing else counts:
 *  `archived` is a place, not a state of being deleted. */
export const isDeleted = (n) => !!(n && n.deleted_at);

/** Archived means "keep it, but off the homescreen". A DELETED note is not
 *  archived-and-deleted, it is deleted — the bin wins, so a note cannot appear
 *  in two lists at once. */
export const isArchived = (n) => !isDeleted(n) && !!(n && n.archived);

export const SHELVES = ["active", "archived", "deleted"];

/** The one classifier. Everything below is a filter over this, so a fourth
 *  shelf added here cannot be forgotten by one of the two surfaces. */
export function shelfOf(note) {
  if (isDeleted(note)) return "deleted";
  if (isArchived(note)) return "archived";
  return "active";
}

/** Rows on one shelf, order untouched — callers apply their own sort. An
 *  unknown shelf name returns nothing rather than everything: a typo that shows
 *  the bin on the homescreen is worse than a typo that shows an empty list. */
export function onShelf(rows, shelf) {
  if (!Array.isArray(rows)) return [];
  if (!SHELVES.includes(shelf)) return [];
  return rows.filter((n) => shelfOf(n) === shelf);
}

/**
 * What the Brief is allowed to show. Active only — never archived, never
 * deleted.
 *
 * This is the whole contract of the archive toggle, and it is one function so
 * that the toggle cannot half-work. The tile also has to stop counting what it
 * cannot show: "Show all 23" over a list of 9 is the same lie as showing the
 * archived ones.
 */
export const homescreenNotes = (rows) => onShelf(rows, "active");

/**
 * What the Notes tab shows for a given shelf. Same rows, different question —
 * and the panel's own search/seal filters compose on top of this rather than
 * replacing it.
 */
export const panelNotes = (rows, shelf = "active") => onShelf(rows, shelf);

/** The bin, newest deletion first — which is the order you want to undo in. */
export function deletedNotes(rows) {
  return onShelf(rows, "deleted")
    .slice()
    .sort((a, b) => String(b.deleted_at || "").localeCompare(String(a.deleted_at || "")));
}

/**
 * The single most recent deletion, which is what a bare "Undo" restores.
 *
 * A bulk delete stamps every row in the same act, so undoing it has to bring
 * back the whole act rather than one row of it — otherwise "delete 9, undo"
 * leaves you with 8 gone and no indication that the button did anything much.
 * Rows deleted within GROUP_MS of the newest one count as the same act.
 */
export const UNDO_GROUP_MS = 2000;

export function lastDeletion(rows) {
  const bin = deletedNotes(rows);
  if (!bin.length) return [];
  const newest = Date.parse(bin[0].deleted_at);
  if (Number.isNaN(newest)) return [bin[0]];
  return bin.filter((n) => {
    const t = Date.parse(n.deleted_at);
    return !Number.isNaN(t) && newest - t <= UNDO_GROUP_MS;
  });
}

/**
 * The card's background for a seal.
 *
 * A WASH OVER --surface, NOT THE SEAL ITSELF. A note filled with --red is an
 * error state in this app's vocabulary, and DESIGN.md §3 spends the semantic
 * colours on meaning rather than decoration. Mixing a few percent into the card
 * material keeps the card a card — it reads as tinted paper — and because the
 * mix resolves against --surface it lands correctly in Porcelain and Graphite
 * and in all twenty palettes without a second value being authored anywhere.
 *
 * Returns null for no seal, so a call site can spread it and get the default
 * card back rather than an explicit "no tint" that would override a parent.
 */
export const TINT_PCT = 9;
export const TINT_PCT_STRONG = 14; // the open editor, where the note fills the screen

export function noteTint(color, seal, pct = TINT_PCT) {
  if (!color) return null;
  const c = typeof seal === "function" ? seal(color) : seal;
  if (!c) return null;
  return `color-mix(in srgb, ${c} ${pct}%, var(--surface))`;
}

/**
 * How long the bin keeps a note, stated here because two other places have to
 * agree with it: the copy in the Notes panel ("Deleted notes are kept for 30
 * days") and `purge deleted > 30d` in netlify/functions/db-admin.js, which is
 * the act that actually destroys the row. A number that drifts between the
 * promise and the deletion is a promise broken silently.
 */
export const PURGE_AFTER_DAYS = 30;

/** Days left before the purge takes it, for the bin's own rows. Floors at 0 —
 *  a row past its window is not "-3 days", it is waiting to be collected. */
export function daysLeft(note, now = Date.now()) {
  const t = Date.parse(note?.deleted_at || "");
  if (Number.isNaN(t)) return null;
  const gone = t + PURGE_AFTER_DAYS * 86400000;
  return Math.max(0, Math.ceil((gone - now) / 86400000));
}
