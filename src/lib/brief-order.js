// ─── Manual Brief card order ──────────────────────────────────────────────────
// The Brief's eleven cards were laid out in a hard-coded array, greedy-packed
// into columns by weight. Good default, but the order was the developer's, not
// the user's — the only way to put Markets above Notes was to edit the source.
//
// The order lives in `app_settings.brief_order` as an array of card ids, exactly
// like notes_order (see lib/notes-order.js): no migration, per-account, synced
// across devices for free.
//
// ── Why unknown cards keep their DEFAULT position, unlike notes ──────────────
// applyNotesOrder puts unknown notes FIRST, because a note you just captured has
// to be visible. The opposite is true here: cards are a fixed set that changes
// only when a release adds one, and a new card shoving itself to the top of
// everyone's Brief would be obnoxious. So an id absent from the saved order
// stays where the default array put it, relative to its neighbours — you get the
// new card roughly where the designer intended, and your own arrangement of
// everything else survives the upgrade untouched.
//
// Pure, so scripts/brief-order-smoke.mjs can test it without a browser.

/** Sort `cards` (each { id, ... }) by the saved id order.
 *
 *  Cards not in `orderIds` hold their default index; cards in it are pulled into
 *  the saved sequence. Ids for cards that no longer exist are ignored rather
 *  than leaving a hole, so removing a card in a later release can't corrupt a
 *  saved order.
 */
export function applyBriefOrder(cards, orderIds) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  const order = Array.isArray(orderIds) ? orderIds : [];
  if (!order.length) return list;

  const rank = new Map();
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); }); // first win — tolerate dupes

  // Walk the saved order to build the known sequence, then splice each unknown
  // card back in at its default index. Doing it in that direction (rather than
  // sorting one combined list) is what makes an unknown card land next to the
  // neighbours it shipped with instead of at an end.
  const known = list.filter((c) => rank.has(c.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const out = known.slice();
  list.forEach((c, defaultIdx) => {
    if (rank.has(c.id)) return;
    out.splice(Math.min(defaultIdx, out.length), 0, c);
  });
  return out;
}

/** The order to persist after a drag: the full visible sequence, so every card
 *  that was only implicitly ordered becomes explicit and can't drift later. */
export const orderOf = (cards) => (Array.isArray(cards) ? cards.filter(Boolean).map((c) => c.id) : []);

/** Greedy min-load packing into `nCols` columns.
 *
 *  Each card carries a weight `w` standing in for its rendered height, and the
 *  next card goes to whichever column is currently shortest — ties resolve left,
 *  which keeps the result stable for a given input. Sequence order is preserved
 *  within a column, which is what makes a drag predictable: you are reordering
 *  ONE sequence, and the columns are just how that sequence is dealt out.
 *
 *  Pure and separated from the render so the smoke test can assert the packing
 *  directly — it used to be six lines inlined in the middle of a 700-line
 *  component, where nothing could reach it.
 */
export function packColumns(cards, nCols) {
  const n = Math.max(1, nCols | 0);
  const columns = Array.from({ length: n }, () => []);
  const loads = Array.from({ length: n }, () => 0);
  for (const card of Array.isArray(cards) ? cards.filter(Boolean) : []) {
    let target = 0;
    for (let i = 1; i < n; i++) if (loads[i] < loads[target]) target = i;
    columns[target].push(card);
    loads[target] += Number(card.w) || 1;
  }
  return columns;
}
