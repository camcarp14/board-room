// ─── Brief layout profiles ────────────────────────────────────────────────────
// The Brief's arrangement has three tiers, and the SETTINGS SCHEMA CAME FIRST:
// these keys were already in production app_settings (written by the build this
// module restores) before this file existed, so every shape here is read from
// what the account actually stores, not designed fresh. Changing a key or a
// field silently orphans a real saved layout.
//
//   brief_order          [id…]        the flat glance order (lib/brief-order.js)
//   brief_columns        number|str   desktop column-count override for the
//                                     default (auto-packed) arrangement
//   brief_layouts        [profile…]   named profiles — explicit columns
//   brief_active_layout  "default" | profile.id
//
// A profile: { id, name, order: [id…], columns, columnLayout: [[id…]…],
//   layoutColumns }. `columnLayout` is the authored truth — which card sits in
// which column, in what order. `order` is the same cards flattened, kept
// because the phone renders ONE column and the flat glance order is the honest
// sequence there. `columns`/`layoutColumns` both appear in stored rows (one is
// a string in old writes); layoutColumns wins, then columns, then the array
// length — never trust one field when three disagree.
//
// Pure. The smoke (scripts/brief-layouts-smoke.mjs) exercises everything here.

/** The active profile object, or null when the default arrangement applies. */
export function activeLayout(settings) {
  const id = settings?.brief_active_layout;
  if (!id || id === "default") return null;
  const list = Array.isArray(settings?.brief_layouts) ? settings.brief_layouts : [];
  return list.find((l) => l && l.id === id) || null;
}

/** Column count for a profile — layoutColumns, then columns, then the array. */
export function layoutColumnCount(profile) {
  const n = Number(profile?.layoutColumns ?? profile?.columns);
  if (Number.isFinite(n) && n >= 1 && n <= 4) return Math.floor(n);
  const arr = Array.isArray(profile?.columnLayout) ? profile.columnLayout.length : 0;
  return arr >= 1 && arr <= 4 ? arr : 2;
}

/** Desktop column count for the DEFAULT arrangement: the stored override when
 *  sane, else the responsive fallback the caller measured. */
export function defaultColumnCount(settings, fallback) {
  const n = Number(settings?.brief_columns);
  return Number.isFinite(n) && n >= 1 && n <= 4 ? Math.floor(n) : fallback;
}

/**
 * Deal `cards` into a profile's explicit columns.
 *
 * Every card renders exactly once, whatever the stored layout says:
 * duplicate ids keep their first appearance, ids for cards that no longer
 * exist are skipped, and cards the profile has never seen are appended to the
 * SHORTEST column by weight — a new card must land somewhere reachable, and
 * quietly growing the last column double-stacks it under the wire.
 */
export function dealExplicit(cards, profile, nCols) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const n = Math.max(1, nCols | 0);
  const columns = Array.from({ length: n }, () => []);
  const loads = Array.from({ length: n }, () => 0);
  const placed = new Set();

  const stored = Array.isArray(profile?.columnLayout) ? profile.columnLayout : [];
  stored.forEach((colIds, i) => {
    const col = Math.min(i, n - 1); // a 3-column layout squeezed to 2 folds its tail column in
    for (const id of Array.isArray(colIds) ? colIds : []) {
      const card = byId.get(id);
      if (!card || placed.has(id)) continue;
      placed.add(id);
      columns[col].push(card);
      loads[col] += Number(card.w) || 1;
    }
  });
  for (const card of list) {
    if (placed.has(card.id)) continue;
    let target = 0;
    for (let i = 1; i < n; i++) if (loads[i] < loads[target]) target = i;
    columns[target].push(card);
    loads[target] += Number(card.w) || 1;
  }
  return columns;
}

/** The flat phone order for a profile: its columns read left-to-right, with
 *  unknown-to-the-profile cards appended in their default order. */
export function explicitFlatOrder(cards, profile) {
  const cols = dealExplicit(cards, profile, layoutColumnCount(profile));
  return cols.flat();
}

/* ══ editing ops — each returns a NEW layouts array, never mutates ═══════════ */

const flatten = (columnLayout) => columnLayout.flat();

/** Duplicate the current on-screen arrangement into a new named profile. */
export function addLayout(layouts, { name, columns }) {
  const list = Array.isArray(layouts) ? layouts.slice() : [];
  const id = `brief-${Date.now().toString(36)}`;
  const columnLayout = columns.map((col) => col.map((c) => c.id));
  list.push({
    id,
    name: String(name || "Layout").slice(0, 40),
    order: flatten(columnLayout),
    columns: String(columnLayout.length),
    columnLayout,
    layoutColumns: columnLayout.length,
  });
  return { layouts: list, id };
}

export function renameLayout(layouts, id, name) {
  return (layouts || []).map((l) => (l && l.id === id ? { ...l, name: String(name || l.name).slice(0, 40) } : l));
}

export function removeLayout(layouts, id) {
  return (layouts || []).filter((l) => l && l.id !== id);
}

/** Move a card within/between columns. dir: 'up' | 'down' | 'left' | 'right'.
 *  Returns an updated profile (order + columnLayout + counts kept coherent). */
export function moveCard(profile, cardId, dir) {
  const n = layoutColumnCount(profile);
  const cols = Array.from({ length: n }, (_, i) =>
    (Array.isArray(profile?.columnLayout?.[i]) ? profile.columnLayout[i] : []).slice());
  // Cards may live past the folded column count — normalize first.
  (profile?.columnLayout || []).slice(n).forEach((extra) => cols[n - 1].push(...(extra || [])));

  let ci = -1, ri = -1;
  cols.forEach((col, i) => { const j = col.indexOf(cardId); if (j !== -1 && ci === -1) { ci = i; ri = j; } });
  if (ci === -1) return profile; // not in the layout — the render appends it; nothing to move

  if (dir === "up" && ri > 0) { cols[ci].splice(ri, 1); cols[ci].splice(ri - 1, 0, cardId); }
  else if (dir === "down" && ri < cols[ci].length - 1) { cols[ci].splice(ri, 1); cols[ci].splice(ri + 1, 0, cardId); }
  else if (dir === "left" && ci > 0) { cols[ci].splice(ri, 1); cols[ci - 1].push(cardId); }
  else if (dir === "right" && ci < n - 1) { cols[ci].splice(ri, 1); cols[ci + 1].push(cardId); }
  else return profile;

  return { ...profile, columnLayout: cols, order: flatten(cols), columns: String(n), layoutColumns: n };
}

/** Change a profile's column count, folding or spreading its columns. */
export function setLayoutColumns(profile, nCols) {
  const n = Math.max(1, Math.min(4, nCols | 0));
  const flat = flatten(Array.isArray(profile?.columnLayout) ? profile.columnLayout : [[]]);
  // Re-deal round-robin only when GROWING (new empty columns need seeds);
  // shrinking folds tail columns into the last kept one, preserving authored
  // runs of cards instead of interleaving them.
  let cols;
  if (n >= layoutColumnCount(profile)) {
    cols = Array.from({ length: n }, () => []);
    const old = Array.isArray(profile?.columnLayout) ? profile.columnLayout : [flat];
    old.forEach((col, i) => cols[Math.min(i, n - 1)].push(...(col || [])));
  } else {
    cols = Array.from({ length: n }, () => []);
    (profile.columnLayout || []).forEach((col, i) => cols[Math.min(i, n - 1)].push(...(col || [])));
  }
  return { ...profile, columnLayout: cols, order: flatten(cols), columns: String(n), layoutColumns: n };
}
