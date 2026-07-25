// ─── Manual note order ────────────────────────────────────────────────────────
// Notes had no user-controllable order: both surfaces sorted pinned-first then
// newest-first, so the only way to move a note was to edit it and bump its
// timestamp. This adds a real order you set by dragging.
//
// The order lives in `app_settings.notes_order` as an array of note ids, NOT as a
// column on personal_notes. Two reasons: it needs no migration (personal_notes
// has no position column, and db.loadNotes already carries a legacy fallback for
// the last two columns that were added), and ordering is a per-account preference,
// which is exactly what app_settings is for. It syncs across devices for free.
//
// Pure so scripts/notes-order-smoke.mjs can test it.

/** Sort notes by the manual order.
 *
 *  Notes NOT yet in the order come first, newest-first — a note you just captured
 *  has to be visible, and on the first drag the whole visible list is written back
 *  so "unknown" empties itself out.
 *
 *  Ids in `orderIds` whose note has been deleted are ignored rather than leaving
 *  a hole. Manual order is ABSOLUTE: `pinned` no longer forces position, because
 *  a drag that silently snaps back somewhere else isn't a drag. Pinning instead
 *  bumps the note to the front of the order (see bumpToFront), so the pin still
 *  means "put this on top" — it just does it by writing the order you can see.
 */
export function applyNotesOrder(notes, orderIds) {
  const list = Array.isArray(notes) ? notes.filter(Boolean) : [];
  const order = Array.isArray(orderIds) ? orderIds : [];
  const rank = new Map();
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); }); // first win — tolerate dupes
  const known = [];
  const unknown = [];
  for (const n of list) (rank.has(n.id) ? known : unknown).push(n);
  known.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  unknown.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  return [...unknown, ...known];
}

/** Move `id` so it sits where `beforeId` was. `beforeId` null ⇒ move to the end.
 *  Returns a NEW id array; the input is untouched. */
export function reorder(ids, id, beforeId) {
  const src = Array.isArray(ids) ? ids : [];
  // Dropping something on itself must be a no-op. Without this guard the id was
  // filtered out, then `indexOf(beforeId)` couldn't find it either, and it fell
  // through to the append branch — so a drop that went nowhere sent the note to
  // the bottom of the list.
  if (id === beforeId) return [...src];
  const out = src.filter((x) => x !== id);
  if (beforeId == null) return [...out, id];
  const at = out.indexOf(beforeId);
  if (at < 0) return [...out, id];
  return [...out.slice(0, at), id, ...out.slice(at)];
}

/** Put `id` first — what pinning does now that manual order wins. */
export function bumpToFront(ids, id) {
  return [id, ...(Array.isArray(ids) ? ids : []).filter((x) => x !== id)];
}

/** The order to persist after a drag: the full visible sequence, so every note
 *  that was only implicitly ordered becomes explicit and can't drift later. */
export const orderOf = (notes) => (Array.isArray(notes) ? notes.filter(Boolean).map((n) => n.id) : []);
