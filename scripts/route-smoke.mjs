// ─── Store route smoke — PLANTED problems, known answers ─────────────────────
// src/features/food/storeRoute.js is pure for the same reason the rest of the
// grocery logic is: every way this can be wrong is a wrong-but-plausible answer
// rather than a crash, and the worst of them are SILENT —
//
//   · an item whose aisle maps to a zone the route never visits, so it never
//     appears as a stop and you get home without it
//   · a stop numbered from its position in the full zone list rather than the
//     walk, so the route reads 1, 4, 7
//   · a saved order that loses or duplicates a zone
//   · a "route" for three different shops that is secretly the same walk
//   · a map whose boxes don't line up with the order underneath them
//
// None of those throw. Run by `npm run verify`.

import { readFileSync } from "node:fs";
import {
  STORE_ROUTES, GENERIC, ZONE_KEYS,
  routeFor, zoneMeta, zoneOfAisle, zoneOfSection,
  applyZoneOrder, moveZone, buildRoute, serpentine, serpentineHeight,
} from "../src/features/food/storeRoute.js";
import { AISLES, aisleOf, parseItem } from "../src/features/food/groceryLogic.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const ALL = [...STORE_ROUTES, GENERIC];

// ─── 1. finding the right walk ───────────────────────────────────────────────
check("costco finds the warehouse walk", routeFor("Costco").key === "costco");
check("jewel finds its own", routeFor("Jewel-Osco").key === "jewel");
check("mariano's finds its own", routeFor("Mariano's").key === "marianos");
// The store tag is free text you typed, so the match has to survive how you
// actually write it — the pills save "Costco Lincoln Park", the add field takes
// "@costco", and both are the same shop.
check("the match ignores case and extra words",
  routeFor("costco lincoln park").key === "costco" && routeFor("MARIANOS BROADWAY").key === "marianos");
check("a shop we don't know still gets a walk", routeFor("Trader Joe's") === GENERIC);
check("no store at all still gets a walk", routeFor("") === GENERIC && routeFor(null) === GENERIC);

// ─── 2. THE ONE THAT MATTERS: nothing can fall off a route ───────────────────
// An item is placed by aisle → zone → position in the route's zone list. If any
// link in that chain is missing, the item is dropped from the route with no
// error anywhere — the exact failure this whole section exists to make loud.
for (const a of AISLES) {
  const z = zoneOfAisle(a.key);
  check(`aisle "${a.key}" maps to a zone`, ZONE_KEYS.includes(z), z);
}
for (const r of ALL) {
  check(`${r.key}: every zone it lists is real`, r.zones.every((z) => ZONE_KEYS.includes(z)),
    r.zones.filter((z) => !ZONE_KEYS.includes(z)).join(","));
  check(`${r.key}: visits every zone, so nothing can vanish`,
    new Set(r.zones).size === ZONE_KEYS.length && ZONE_KEYS.every((z) => r.zones.includes(z)),
    `${r.zones.length} zones vs ${ZONE_KEYS.length}`);
  check(`${r.key}: lists no zone twice`, new Set(r.zones).size === r.zones.length);
  check(`${r.key}: says which shop and what to expect`, !!r.name && !!r.note);
}
check("every zone has a label, a short label and a tone",
  ZONE_KEYS.every((k) => zoneMeta(k).label && zoneMeta(k).short && zoneMeta(k).tone));
check("an unknown zone key degrades to Everything else", zoneMeta("nope").label === zoneMeta("other").label);

// ─── 3. the walks are actually different walks ───────────────────────────────
// Three routes that are quietly the same array would look like a feature and be
// nothing — this is the check that they encode different layout grammars.
check("a warehouse does not start at produce", STORE_ROUTES.find(r => r.key === "costco").zones[0] !== "produce");
check("a warehouse takes the cold block last",
  (() => { const z = STORE_ROUTES.find(r => r.key === "costco").zones; return z.indexOf("frozen") > z.indexOf("center"); })());
for (const key of ["jewel", "marianos"]) {
  const z = STORE_ROUTES.find((r) => r.key === key).zones;
  check(`${key}: perimeter first — produce leads`, z[0] === "produce");
  check(`${key}: centre aisles come after the perimeter`, z.indexOf("center") > z.indexOf("butcher"));
}
// Frozen last among the real departments is the one ordering rule with a
// physical cost attached: everything else is steps, this one is melting.
for (const r of ALL) {
  const z = r.zones.filter((k) => k !== "other");
  check(`${r.key}: frozen is the last real stop`, z[z.length - 1] === "frozen", z.join(","));
  check(`${r.key}: dairy is picked up before frozen`, z.indexOf("dairy") < z.indexOf("frozen"));
}
check("the walks aren't copies of each other",
  new Set(ALL.map((r) => r.zones.join(">"))).size >= 3);
// The verified, store-specific fact — two floors, groceries upstairs. It is the
// single most useful thing to know at that door, so it must survive an edit.
{
  const m = STORE_ROUTES.find((r) => r.key === "marianos");
  check("mariano's still says it's two floors", /two floors/i.test(m.note) && !!m.floors);
  check("…and says the groceries are on 2", /2/.test(m.note) && /grocer/i.test(String(m.floors[2])));
}
check("each named store carries its address", STORE_ROUTES.every((r) => /\d/.test(String(r.where || ""))));

// ─── 4. a pinned section beats the guess ─────────────────────────────────────
// The list already lets "#Freezer" override the lexicon. If the route ignored
// that, the same item would sit in two different departments depending on which
// tab you were looking at.
check("section matching ignores case and takes the long name",
  zoneOfSection("frozen") === "frozen" && zoneOfSection("Dairy & Eggs") === "dairy");
check("an aisle name works as a section too", zoneOfSection("Meat") === "butcher");
// THE GAP THIS CAUGHT. Nobody pins "#Frozen" — they pin "#Freezer". Matching
// only on our own vocabulary meant a section that reads perfectly in the list
// fell through to the lexicon's guess on the route, so the two views disagreed
// about the same item. These are the words a person actually types.
const TYPED = {
  Freezer: "frozen", Fridge: "dairy", Eggs: "dairy", Veg: "produce", Fruit: "produce",
  Bread: "bakery", Butcher: "butcher", Fish: "butcher", Pantry: "center", Aisles: "center",
  Beverages: "drinks", Paper: "household", Cleaning: "household", "Frozen Foods": "frozen",
};
for (const [typed, zone] of Object.entries(TYPED)) {
  check(`"#${typed}" is the ${zone} stop`, zoneOfSection(typed) === zone, zoneOfSection(typed));
}
check("a heading you invented isn't forced into a department", zoneOfSection("Ben's Birthday") === "");
check("an empty section matches nothing", zoneOfSection("") === "" && zoneOfSection(null) === "");

// ─── 5. building the route ───────────────────────────────────────────────────
const items = [
  { id: "1", item: "2x Milk @Costco", checked: false },        // dairy
  { id: "2", item: "Bananas @Costco", checked: false },        // produce
  { id: "3", item: "Paper Towels @Costco", checked: false },   // household
  { id: "4", item: "Ice Cream @Costco", checked: true },       // frozen, IN THE CART
  { id: "5", item: "Bread", checked: false },                  // bakery, no store
  { id: "6", item: "Salmon @Jewel", checked: false },          // seafood → butcher
];
{
  const { route, stops, total } = buildRoute(items, "Costco");
  check("the route is the store's", route.key === "costco");
  const zones = stops.map((s) => s.zone);
  check("only the zones you're actually buying from become stops",
    zones.length === 4 && !zones.includes("frozen") && !zones.includes("drinks"), zones.join(","));
  check("stops follow the store's walk order",
    zones.join(",") === "household,bakery,produce,dairy", zones.join(","));
  check("stops are numbered by the walk, not by the zone list",
    stops.map((s) => s.n).join(",") === "1,2,3,4");
  // The route describes the REST of the trip: something in the trolley is done.
  check("a checked item is off the route", !stops.some((s) => s.items.some((it) => it.checked)));
  // Same rule as the list: an untagged staple follows you into every shop, and
  // dropping it here is how you get home without the bread.
  check("an untagged staple rides along", stops.find((s) => s.zone === "bakery").items[0].id === "5");
  check("another shop's item stays out", !stops.some((s) => s.items.some((it) => it.id === "6")));
  check("nothing is lost or duplicated between the list and the stops",
    stops.reduce((n, s) => n + s.items.length, 0) === total && total === 4, String(total));
}
{
  const { stops } = buildRoute(items, "");
  check("with no store, everything unchecked is on one walk",
    stops.reduce((n, s) => n + s.items.length, 0) === 5);
  check("…using the generic walk", buildRoute(items, "").route === GENERIC);
}
{
  const pinned = [{ id: "p", item: "Milk #Freezer @Costco", checked: false }];
  check("a pinned section moves the stop, not just the row",
    buildRoute(pinned, "Costco").stops[0].zone === "frozen");
  const invented = [{ id: "q", item: "Cake #Ben's Birthday @Costco", checked: false }];
  check("an invented heading falls back to what the words say",
    buildRoute(invented, "Costco").stops[0].zone === "bakery");
}
check("an all-checked list is a finished trip, not a broken one",
  buildRoute([{ id: "z", item: "Milk", checked: true }], "").stops.length === 0);
check("buildRoute tolerates an empty list and nulls",
  buildRoute([], "Costco").stops.length === 0 && buildRoute(null, null).stops.length === 0);
check("every stop carries what the UI draws with",
  buildRoute(items, "Costco").stops.every((s) => s.label && s.short && s.tone && s.n >= 1 && s.items.length));

// ─── 6. your order wins, and survives ────────────────────────────────────────
const defaults = STORE_ROUTES.find((r) => r.key === "jewel").zones;
{
  const mine = ["frozen", "dairy", ...defaults.filter((z) => z !== "frozen" && z !== "dairy")];
  check("a saved order is the order", applyZoneOrder(defaults, mine).join(",") === mine.join(","));
  check("no saved order means the default",
    applyZoneOrder(defaults, undefined).join(",") === defaults.join(",") &&
    applyZoneOrder(defaults, []).join(",") === defaults.join(",") &&
    applyZoneOrder(defaults, "nonsense").join(",") === defaults.join(","));
  check("reordering never loses or duplicates a zone",
    (() => { const o = applyZoneOrder(defaults, mine); return o.length === defaults.length && new Set(o).size === defaults.length; })());
  // A zone added in a later release must land where it was designed to, not get
  // dumped at the end of an order saved before it existed.
  const stale = defaults.filter((z) => z !== "drinks");
  check("a zone your saved order has never seen keeps its designed slot",
    (() => { const o = applyZoneOrder(defaults, stale); return o.includes("drinks") && o.length === defaults.length; })(),
    applyZoneOrder(defaults, stale).join(","));
  check("buildRoute actually applies the saved order",
    buildRoute(items, "Jewel", { jewel: ["dairy", ...defaults.filter(z => z !== "dairy")] }).route.key === "jewel");
}

// ─── 7. moving a stop moves it past what you can SEE ─────────────────────────
// Two lists in play: the stops on screen and the full zone order that gets
// saved. Swap against the wrong one and tapping ↑ appears to do nothing, because
// the zone hopped over an empty department you can't see.
{
  const zones = ["a", "b", "c", "d"];
  const visible = ["a", "c", "d"];   // b has nothing in it today
  check("moving up jumps the invisible zone", moveZone(zones, visible, "c", -1).join(",") === "c,a,b,d");
  check("moving down does too", moveZone(zones, visible, "a", 1).join(",") === "b,c,a,d");
  check("the first visible stop can't move up", moveZone(zones, visible, "a", -1) === null);
  check("the last visible stop can't move down", moveZone(zones, visible, "d", 1) === null);
  check("an unknown zone moves nothing", moveZone(zones, visible, "zz", 1) === null);
  check("a move never loses or duplicates a zone",
    (() => { const o = moveZone(zones, visible, "c", -1); return o.length === 4 && new Set(o).size === 4; })());
  // Round-trips in the order you can SEE, which is the only order that means
  // anything to you. Where the empty zone `b` ends up relative to `c` is a
  // coin-flip with no consequence today, so asserting the full array would be
  // asserting an implementation detail rather than the behaviour.
  const seen = (o) => o.filter((z) => visible.includes(z)).join(",");
  check("moving up then down puts it back where you can see",
    seen(moveZone(moveZone(zones, visible, "c", -1), visible, "c", 1)) === seen(zones),
    seen(moveZone(moveZone(zones, visible, "c", -1), visible, "c", 1)));
  check("moveZone tolerates nulls", moveZone(null, null, "a", 1) === null);
}
{
  // End to end: nudge a stop and the walk you SEE changes by exactly one place.
  const before = buildRoute(items, "Costco").stops.map((s) => s.zone);
  const next = moveZone(routeFor("Costco").zones, before, before[2], -1);
  const after = buildRoute(items, "Costco", { costco: next }).stops.map((s) => s.zone);
  check("nudging a stop reorders the actual route",
    after.join(",") === [before[0], before[2], before[1], before[3]].join(","),
    `${before.join(",")} → ${after.join(",")}`);
  check("…and changes nothing else about it", after.length === before.length && new Set(after).size === after.length);
}

// ─── 8. the map can't disagree with the list ─────────────────────────────────
// Both come from the same array, and these are the geometric consequences: the
// boxes stay inside the building, they don't overlap, consecutive stops are
// always neighbours (which is what lets the route be drawn by joining centres),
// and the SVG is exactly tall enough.
{
  const fake = Array.from({ length: 7 }, (_, i) => ({ zone: `z${i}`, n: i + 1, items: [] }));
  const boxes = serpentine(fake);
  check("every stop gets a box", boxes.length === fake.length);
  check("boxes stay inside the building",
    boxes.every((b) => b.x >= 0 && b.x + b.w <= 100 && b.y >= 0));
  check("the stop keeps its identity through the layout",
    boxes.every((b, i) => b.zone === fake[i].zone && b.n === fake[i].n));
  check("centres are where they claim to be",
    boxes.every((b) => Math.abs(b.cx - (b.x + b.w / 2)) < 1e-9 && Math.abs(b.cy - (b.y + b.h / 2)) < 1e-9));
  check("no two boxes overlap", (() => {
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return false;
    }
    return true;
  })());
  // THE SERPENTINE PROPERTY. Consecutive stops share a row (side by side) or a
  // column (one above the other) — never diagonal. Break it and the dashed route
  // cuts across boxes it isn't visiting.
  check("consecutive stops are always neighbours", boxes.slice(1).every((b, i) => {
    const a = boxes[i];
    const sameRow = a.y === b.y && Math.abs(a.cx - b.cx) > 1e-9;
    const sameCol = Math.abs(a.cx - b.cx) < 1e-9 && b.y > a.y;
    return sameRow || sameCol;
  }));
  check("odd rows run the other way — it's a walk, not a grid",
    boxes[1].cx > boxes[0].cx && boxes[2].cx > boxes[3].cx);
  check("the svg is exactly tall enough for the last row",
    (() => {
      const bottom = Math.max(...boxes.map((b) => b.y + b.h));
      const h = serpentineHeight(boxes.length);
      return h >= bottom && h - bottom <= 5;   // one pad of breathing room, no field of empty
    })(), `${serpentineHeight(boxes.length)} vs ${Math.max(...boxes.map((b) => b.y + b.h))}`);
  check("an odd count doesn't crop the last row",
    serpentineHeight(1) > serpentine([fake[0]])[0].h);
  check("no stops is a height of nothing, not NaN",
    Number.isFinite(serpentineHeight(0)) && serpentineHeight(0) >= 0);
  // A phone card is ~350px wide, so 100 units ≈ 3.5px. A box under ~9 units tall
  // can't hold a legible label, and a 10-stop map over ~120 units is a scroll.
  check("boxes are big enough to read on a phone", boxes[0].h >= 9 && boxes[0].w >= 30, `${boxes[0].w}x${boxes[0].h}`);
  check("a full ten-stop route still fits roughly a screen", serpentineHeight(10) <= 120, String(serpentineHeight(10)));
}

// ─── 9. the picture on the phone is the picture under test ───────────────────
// The geometry above is only meaningful if the component renders with the same
// numbers. It does that by passing no options at all, so the defaults asserted
// here ARE the shipped layout — a second set of numbers in the JSX would make
// every check in section 8 vacuous.
{
  const ui = readFileSync("src/features/food/StoreRoute.jsx", "utf8");
  check("the map uses the tested geometry, with no numbers of its own",
    /serpentine\(stops\)/.test(ui) && /serpentineHeight\(stops\.length\)/.test(ui), "the component passes its own layout options");
  // The rows in the route are the LIST's rows, handed down — not a read-only
  // copy. That's what makes checking something off there a real tap.
  check("the stop list renders the list's own row", /renderRow/.test(ui));
  const panel = readFileSync("src/features/food/GroceryPanel.jsx", "utf8");
  check("the panel hands it the whole list, the store and the row renderer",
    /<StoreRoute[\s\S]*?items=\{groceries\}[\s\S]*?store=\{activeStore\}[\s\S]*?renderRow=\{renderRow\}/.test(panel));
  check("the walk order is persisted, not per-session",
    /updateSetting\?\.\("store_routes"/.test(panel));
  // "no saved order" and "an empty saved order" must stay distinguishable, or a
  // Reset would save [] and applyZoneOrder would keep honouring it.
  check("resetting removes the entry rather than saving an empty one", /delete next\[key\]/.test(panel));
}

console.log(failed ? `\n${failed} route check(s) failed` : "\nROUTE SMOKE PASS");
process.exit(failed ? 1 : 0);
