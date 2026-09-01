// ─── The Brief's card catalogue, and which of them you've put away ────────────
// Two things live here, and they're together because the second is meaningless
// without the first.
//
// THE CATALOGUE is the list of every widget the Brief can draw — id, display
// name, and the rough relative height the packer deals columns by. It used to
// be `DEFAULT_CARDS` inside BriefPage.jsx, next to the eleven rendered nodes,
// which meant the only way to ask "what cards exist?" was to import a 900-line
// page that mounts a dozen queries. Settings needs that question answered from
// a sheet that is imported EAGERLY by App, so the answer moved somewhere cheap.
// BriefPage still owns the rendering: it maps id → node and never re-states the
// order.
//
// VISIBILITY is `app_settings.brief_hidden` — an array of card ids you've
// switched off, account-scoped and synced like brief_order and navigation
// beside it. Same shape and same spirit as `navigation.hidden`, which takes a
// tab off the bar: the widget stops being drawn, nothing is deleted, and the
// switch comes back on to exactly where the card was.
//
// A CARD THE LIST HAS NEVER MET IS VISIBLE. Absence means "not hidden", so a
// release that adds a widget shows it to everyone (the opposite default would
// ship features nobody could find), and an id for a card that no longer exists
// is ignored rather than shifting anything.
//
// Pure — no React, no JSX — so scripts/brief-cards-smoke.mjs can run it in bare
// Node, and so importing the catalogue costs a settings sheet nothing.

// `id` is the persistence key for both the manual order (app_settings
// .brief_order) and this list, so these strings are PERMANENT: renaming one
// resets that card to its default slot and un-hides it for everyone who had put
// it away.
//
// The sequence is the glance order. On the phone (one column) this array IS the
// scroll order, which is what it's tuned for: Birthdays sits directly under the
// calendar because it's a calendar concern ("who's coming up"). `w` is a rough
// relative height, eyeballed not measured — it only has to be ordinally right,
// and being wrong costs a slightly uneven column, never a bug. The Wire is 4.5
// rather than 3 because its feed is 480px tall, and that weight is what stops
// the packer stacking it under another tall card.
//
// `label` is what the layout sheet and the settings switches call the card —
// the card's own title, not a second name for it.
export const BRIEF_CARDS = [
  { id: "notes", w: 3, label: "Notes" },
  { id: "minicalendar", w: 2.5, label: "Calendar" },
  // Birthdays AND anniversaries — one card, because they answer the same
  // question. The id stays "birthdays": it is the persistence key for the order
  // and the hidden list, and renaming it would reset the card for anyone who
  // had moved or switched it off.
  { id: "birthdays", w: 1.5, label: "Birthdays & Dates" },
  { id: "markets", w: 2.5, label: "Markets" },
  { id: "watch", w: 3, label: "Watch This Week" },
  { id: "wire", w: 4.5, label: "The Wire" },
  { id: "gsc", w: 2.5, label: "Search Console" },
  { id: "meetings", w: 2, label: "Meetings" },
  { id: "clarify", w: 1.5, label: "Clarify" },
  { id: "zts", w: 1.5, label: "ZTS" },
  { id: "shopify", w: 1.5, label: "Shopify" },
];

/** The ids you've switched off, as a Set. Tolerant of anything: a missing key,
 *  a value that isn't an array, junk entries inside it — all read as "nothing
 *  hidden", because the failure mode of guessing wrong here is a Brief that
 *  renders blank. */
export function hiddenBriefCards(settings) {
  const raw = Array.isArray(settings?.brief_hidden) ? settings.brief_hidden : [];
  return new Set(raw.filter((id) => typeof id === "string" && id));
}

/** Drop the switched-off cards from a card list, keeping its order. */
export function visibleBriefCards(cards, hidden) {
  const h = hidden instanceof Set ? hidden : hiddenBriefCards({ brief_hidden: hidden });
  return (Array.isArray(cards) ? cards.filter(Boolean) : []).filter((c) => !h.has(c.id));
}

/** Flip one card, returning the new stored array (never mutating).
 *
 *  Ids for cards that don't exist any more are dropped on the way through, so
 *  the list can't accumulate ghosts across releases — but only here, on a write
 *  you asked for. Nothing rewrites the setting behind your back on load. */
export function toggleBriefCard(hidden, id) {
  const h = hidden instanceof Set ? new Set(hidden) : hiddenBriefCards({ brief_hidden: hidden });
  if (h.has(id)) h.delete(id); else h.add(id);
  const known = new Set(BRIEF_CARDS.map((c) => c.id));
  return [...h].filter((k) => known.has(k));
}

/** True when every card in the catalogue is switched off. */
export const allBriefCardsHidden = (hidden) => visibleBriefCards(BRIEF_CARDS, hidden).length === 0;

/**
 * Fold the hidden ids back into an order the user just dragged.
 *
 * A drag reports the VISIBLE sequence — that's all it can see — so saving it
 * verbatim would delete every hidden card from brief_order. They'd survive
 * (applyBriefOrder puts an unknown id back at its DEFAULT slot), but switching
 * one back on months later would drop it wherever the release wanted it rather
 * than where you left it, which reads as the app losing your arrangement.
 *
 * So each hidden id is re-inserted directly after whatever preceded it in the
 * old order, which is the one anchor still meaningful: reorder around a hidden
 * card and it keeps the same neighbour it had. A hidden card the old order
 * never listed stays absent — it has no position to preserve, and inventing
 * one would be worse than the default slot it already falls back to.
 */
export function mergeHiddenOrder(nextIds, prevOrder, hidden) {
  const h = hidden instanceof Set ? hidden : hiddenBriefCards({ brief_hidden: hidden });
  const next = (Array.isArray(nextIds) ? nextIds : []).filter((id) => typeof id === "string" && !h.has(id));
  const seen = new Set();
  const out = next.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  const prev = (Array.isArray(prevOrder) ? prevOrder : []).filter((id) => typeof id === "string");
  if (!prev.some((id) => h.has(id))) return out;

  // Walk the old order with a cursor that tracks where we are in the new one.
  // A visible id moves the cursor to where it actually sits now; a hidden id is
  // spliced in just after the cursor, so a run of hidden cards stays in its own
  // sequence instead of reversing.
  let cursor = -1;
  for (const id of prev) {
    if (h.has(id)) {
      if (seen.has(id)) continue;
      seen.add(id);
      cursor = Math.min(cursor + 1, out.length);
      out.splice(cursor, 0, id);
    } else {
      const at = out.indexOf(id);
      if (at !== -1) cursor = at;
    }
  }
  return out;
}
