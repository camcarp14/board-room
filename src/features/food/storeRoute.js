// ─── Store routes — the order you should walk, per store ─────────────────────
//
// WHAT THIS IS, AND WHAT IT IS NOT. There is no public floor-plan or aisle-
// directory data for these stores. Kroger (Mariano's) and Albertsons (Jewel)
// both hold aisle numbers behind their own apps and give no public API; Costco
// publishes nothing at all. So this is NOT a licensed floor plan and does not
// pretend to be one: it is a WALKING ORDER — the sequence of departments that
// gets you through the store without doubling back — plus a schematic drawn
// from that order. The order is the part that saves you steps; the exact
// footprint of the building is not.
//
// Three things make that honest rather than a guess:
//
//   1. The orders below are the layout GRAMMAR each chain actually uses — a
//      warehouse flows non-food → dry grocery → refrigerated back wall →
//      frozen → checkout; a full-service supermarket runs the perimeter
//      (produce, bakery, deli, butcher) before the centre aisles and puts dairy
//      on the back wall. That is why the same walk works in any Jewel.
//   2. Mariano's Lakeview is two floors — prepared food and dining on 1,
//      produce/bakery/meat/seafood and the grocery aisles on 2 — which is
//      specific, verifiable, and the single most useful thing to know before
//      you walk in. The route says it out loud.
//   3. YOU CAN REORDER IT. You shop these stores; the app doesn't. The saved
//      order lives in app_settings.store_routes and wins over everything here,
//      so the first time a stop is in the wrong place you fix it once and it
//      stays fixed. That is what turns an informed default into your store.
//
// Everything here is pure so scripts/route-smoke.mjs can assert it without a
// browser — the failure modes are all wrong-but-plausible (a stop that never
// appears because no aisle maps to it, a route that sends you back across the
// shop) rather than crashes.

import { AISLES, aisleOf, parseItem, isStore } from "./groceryLogic.js";

/** Every zone a route can contain.
 *
 *  `aisles` are the groceryLogic aisle keys that land in it — the mapping from
 *  what you typed to where it lives. `short` is what the MAP says: a box on the
 *  schematic is about 150px wide on a phone, and "Household & Paper" set at a
 *  legible size does not fit in one, so the map gets a word and the stop list
 *  gets the name. Two labels beats one label shrunk to 9px.
 *
 *  `alias` is what a PERSON types into the section field, which is not the same
 *  vocabulary at all: nobody pins "#Frozen", they pin "#Freezer"; nobody types
 *  "#Centre aisles", they type "#Pantry". Matching only on our own names meant a
 *  pinned section that reads perfectly well in the list quietly fell through to
 *  the lexicon's guess on the route — the two views disagreeing about the same
 *  item, which is the one thing this feature must never do. */
const ZONE = {
  produce:   { label: "Produce", short: "Produce", tone: "var(--green)", aisles: ["produce"],
               alias: ["fruit", "fruits", "veg", "vegetables", "veggies", "greens", "salad"] },
  bakery:    { label: "Bakery", short: "Bakery", tone: "var(--amber)", aisles: ["bakery"],
               alias: ["bread", "baked", "baked goods"] },
  deli:      { label: "Deli", short: "Deli", tone: "var(--amber)", aisles: ["deli"],
               alias: ["deli counter", "prepared", "prepared food"] },
  butcher:   { label: "Meat & Seafood", short: "Meat", tone: "var(--red)", aisles: ["meat", "seafood"],
               alias: ["butcher", "fish", "fish counter", "meat counter", "protein"] },
  dairy:     { label: "Dairy & Eggs", short: "Dairy", tone: "var(--blue)", aisles: ["dairy"],
               alias: ["eggs", "fridge", "refrigerated", "cheese", "milk"] },
  frozen:    { label: "Frozen", short: "Frozen", tone: "var(--blue)", aisles: ["frozen"],
               alias: ["freezer", "frozen food", "frozen foods", "ice"] },
  center:    { label: "Centre aisles", short: "Aisles", tone: "var(--purple)", aisles: ["pantry", "snacks"],
               alias: ["aisles", "center", "centre", "center aisles", "dry goods", "grocery", "canned", "baking", "cupboard"] },
  drinks:    { label: "Drinks", short: "Drinks", tone: "var(--purple)", aisles: ["drinks"],
               alias: ["beverages", "beverage", "soda", "booze", "alcohol"] },
  household: { label: "Household & Paper", short: "Household", tone: "var(--sub)", aisles: ["household"],
               alias: ["home", "paper", "paper goods", "cleaning", "toiletries", "non-food", "pharmacy", "health"] },
  other:     { label: "Everything else", short: "Other", tone: "var(--faint)", aisles: ["other"], alias: [] },
};

/** Zone keys in their canonical (declaration) order — the identity of the set,
 *  used to validate a saved order rather than trusting whatever is in settings. */
export const ZONE_KEYS = Object.keys(ZONE);

/**
 * The stores, and the order each one walks.
 *
 * `match` is a substring test against whatever you typed as the store tag, so
 * "Costco", "costco lp" and "Costco Lincoln Park" all find the same route. Any
 * store that matches nothing gets GENERIC, which means the feature works for a
 * shop you add tomorrow instead of only for these three.
 */
export const STORE_ROUTES = [
  {
    key: "costco",
    match: /costco/i,
    name: "Costco · Lincoln Park",
    where: "2746 N Clybourn Ave",
    // A warehouse is the one format that genuinely does not run a perimeter:
    // you are walked past the high-margin non-food first, then dry grocery,
    // and the entire refrigerated block sits together at the back.
    note: "One loop: non-food first, dry grocery through the middle, the whole cold block at the back.",
    zones: ["household", "center", "drinks", "bakery", "deli", "butcher", "produce", "dairy", "frozen", "other"],
  },
  {
    key: "jewel",
    match: /jewel/i,
    name: "Jewel-Osco · Lakeview",
    where: "2940 N Ashland Ave",
    note: "Perimeter first — produce, bakery, deli, butcher — then the centre aisles, dairy on the back wall, frozen last.",
    zones: ["produce", "bakery", "deli", "butcher", "center", "household", "drinks", "dairy", "frozen", "other"],
  },
  {
    key: "marianos",
    match: /mariano/i,
    name: "Mariano's · Lakeview",
    where: "3030 N Broadway St",
    // The verified, specific one: this store is two storeys, and everything on
    // a grocery list is upstairs. Walking the ground floor looking for produce
    // is the mistake this line prevents.
    note: "Two floors — the prepared-food hall is on 1, everything on your list is on 2. Go up first.",
    floors: { 1: "Prepared food & dining", 2: "Groceries" },
    zones: ["produce", "bakery", "butcher", "deli", "center", "household", "drinks", "dairy", "frozen", "other"],
  },
];

/** The fallback: a standard full-service supermarket walk. Any store you add
 *  gets this rather than nothing, and can then be reordered like the rest. */
export const GENERIC = {
  key: "generic",
  name: "Standard supermarket",
  note: "Perimeter first, centre aisles next, frozen last — the layout most supermarkets use.",
  zones: ["produce", "bakery", "deli", "butcher", "center", "household", "drinks", "dairy", "frozen", "other"],
};

export const routeFor = (store) =>
  STORE_ROUTES.find((r) => r.match.test(String(store ?? ""))) || GENERIC;

export const zoneMeta = (key) => ZONE[key] || ZONE.other;

/** aisle key → zone key. Built once; an aisle in no zone falls to "other", so a
 *  new aisle in groceryLogic can never make items silently vanish from a route. */
const ZONE_OF_AISLE = (() => {
  const m = {};
  for (const [zk, z] of Object.entries(ZONE)) for (const a of z.aisles) m[a] = zk;
  for (const a of AISLES) if (!m[a.key]) m[a.key] = "other";
  return m;
})();
export const zoneOfAisle = (aisle) => ZONE_OF_AISLE[aisle] || "other";

/**
 * A section you PINNED yourself ("#Freezer"), matched to a zone.
 *
 * The list already lets a typed section override the guessed aisle, and it has
 * to override it here too — otherwise pinning "#Freezer" moves the item in the
 * list and leaves it filed under the lexicon's guess on the route, so the two
 * views of the same list disagree about where you're standing. Matched against
 * the zone key, its full label, its short label, the aisle keys inside it, and
 * the words people actually type (see `alias`) — so "frozen", "Freezer",
 * "Dairy & Eggs", "meat" and "veg" all land somewhere sensible.
 *
 * Returns "" for a section that matches nothing — a heading you invented ("Ben's
 * birthday") is not a department, and forcing it into one would be worse than
 * letting the item fall back to what its words say it is.
 */
const SECTION_INDEX = (() => {
  const m = new Map();
  const put = (k, zk) => { const s = String(k).toLowerCase().trim(); if (s && !m.has(s)) m.set(s, zk); };
  for (const [zk, z] of Object.entries(ZONE)) {
    if (zk === "other") continue;   // "other" is a fallback, not a name to match
    put(zk, zk); put(z.label, zk); put(z.short, zk);
    for (const a of z.aisles) put(a, zk);
    for (const a of z.alias || []) put(a, zk);
  }
  for (const a of AISLES) { const zk = ZONE_OF_AISLE[a.key]; if (zk && zk !== "other") { put(a.key, zk); put(a.label, zk); } }
  return m;
})();
export const zoneOfSection = (section) => SECTION_INDEX.get(String(section ?? "").toLowerCase().trim()) || "";

/**
 * Move one stop up or down the walk, and give back the FULL zone order.
 *
 * Two lists are in play and conflating them is the bug here: you can only see
 * the zones you're actually buying from, but what gets saved is the order of all
 * of them. So the swap is made against the nearest VISIBLE neighbour — tapping ↑
 * on stop 3 must put it above stop 2 and nothing else — while the zones you have
 * nothing in today ride along in place, keeping the arrangement you'll see next
 * week when you do have something in them.
 *
 * Returns null when the stop is already at an end, so the caller can disable the
 * control rather than write an identical order back to the server.
 */
export function moveZone(zones, visible, key, dir) {
  const list = (zones || []).slice();
  const i = list.indexOf(key);
  if (i < 0) return null;
  const step = dir < 0 ? -1 : 1;
  const seen = new Set(visible || []);
  let j = i + step;
  while (j >= 0 && j < list.length && !seen.has(list[j])) j += step;
  if (j < 0 || j >= list.length) return null;
  list.splice(i, 1);
  // After the removal every index above `i` has shifted down one, which is
  // exactly what makes this single splice correct in both directions: going up
  // it lands before the neighbour, going down it lands after it.
  list.splice(j, 0, key);
  return list;
}

/**
 * The saved order for a store, if you've rearranged it.
 *
 * Stored per route key in app_settings.store_routes. Applied like every other
 * saved order in this app: zones you've placed come first in your sequence,
 * zones the saved order has never seen keep their default position rather than
 * jumping to an end — so a zone added in a later release lands roughly where it
 * was designed to, and your arrangement of everything else survives.
 */
export function applyZoneOrder(zones, saved) {
  const order = Array.isArray(saved) ? saved : [];
  if (!order.length) return zones;
  const rank = new Map();
  order.forEach((z, i) => { if (!rank.has(z)) rank.set(z, i); });
  const known = zones.filter((z) => rank.has(z)).sort((a, b) => rank.get(a) - rank.get(b));
  const out = known.slice();
  zones.forEach((z, def) => { if (!rank.has(z)) out.splice(Math.min(def, out.length), 0, z); });
  return out;
}

/**
 * The route: only the stops you actually need, in walk order.
 *
 * Zones with nothing in them are DROPPED, not greyed — a stop you don't have to
 * make is not information, it's a thing to read past while holding a trolley.
 * Checked items are dropped for the same reason: the route is what's left.
 *
 * Untagged staples ride along with every store, exactly as they do in the list
 * (see inStore) — the bread you'd buy anywhere still has to be picked up
 * somewhere, and dropping it here is how you get home without it.
 */
export function buildRoute(items, store, savedOrder) {
  const route = routeFor(store);
  const zones = applyZoneOrder(route.zones, savedOrder?.[route.key]);
  const mine = (items || []).filter((it) => !it.checked && (!store || isStore(it.item, store) || !parseItem(it.item).store));

  const byZone = new Map();
  for (const it of mine) {
    // A section you pinned yourself wins over the lexicon's guess, exactly as it
    // does in the list — see zoneOfSection.
    const z = zoneOfSection(parseItem(it.item).section) || zoneOfAisle(aisleOf(it.item));
    if (!byZone.has(z)) byZone.set(z, []);
    byZone.get(z).push(it);
  }
  // Numbered AFTER the empty zones are dropped, so the stops read 1,2,3 — the
  // numbers are the walk, not the position in some longer list you can't see.
  const stops = zones
    .filter((z) => byZone.has(z))
    .map((z, i) => ({ zone: z, ...zoneMeta(z), n: i + 1, items: byZone.get(z) }));

  return { route, zones, stops, total: mine.length };
}

/**
 * Where each stop sits on the schematic.
 *
 * A SERPENTINE, generated from the order rather than hand-placed per store —
 * which is the honest thing to draw when you have the sequence but not the
 * building. Down one side, across, back up the other: that is what walking a
 * store feels like, and it means the picture can never disagree with the list
 * underneath it, because both come from the same array.
 *
 * Two columns, because on a phone three would put four-character labels in
 * 28px boxes.
 *
 * The units are the SVG's, 100 wide, and the defaults ARE the ones the map
 * renders with — there is no second set of numbers in the component, so a test
 * that measures these is measuring the picture on the phone. At a 350px card
 * that puts a stop box at ~150 × 49px with a 15px label: tappable, readable, and
 * ten stops still fit in about a screen.
 */
export function serpentine(stops, { w = 100, cols = 2, cell = 14, gap = 6, pad = 4 } = {}) {
  const colW = (w - pad * 2 - gap * (cols - 1)) / cols;
  return stops.map((s, i) => {
    const row = Math.floor(i / cols);
    const inRow = i % cols;
    // Odd rows run right-to-left, which is what makes it a walk and not a grid.
    const col = row % 2 === 0 ? inRow : cols - 1 - inRow;
    const x = pad + col * (colW + gap);
    const y = pad + row * (cell + gap);
    return { ...s, x, y, w: colW, h: cell, cx: x + colW / 2, cy: y + cell / 2 };
  });
}

/** Total height the schematic needs for n stops — so the SVG can size itself
 *  instead of cropping the last row or leaving a field of empty below it. */
export const serpentineHeight = (n, { cols = 2, cell = 14, gap = 6, pad = 4 } = {}) =>
  pad * 2 + Math.max(0, Math.ceil(n / cols)) * (cell + gap) - (n ? gap : 0);
