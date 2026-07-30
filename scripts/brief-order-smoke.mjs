// ─── Brief order smoke — the Brief's manual card arrangement, asserted ───────
//
// applyBriefOrder decides where every card on the landing tab appears, from a
// list of ids saved months ago on a different device. It is pure, so it is
// cheap to pin — and the two failure modes it has are both silent:
//
//  1. A LOST ARRANGEMENT. A saved order that no longer round-trips means the
//     user's Brief quietly rearranges itself on some future load. Nothing
//     errors; the tiles are just in the wrong places.
//  2. A CARD THAT VANISHES OR DUPLICATES. The function reconciles a saved id
//     list against the live card set, so a release that adds or removes a card
//     is exactly when it can drop one or emit it twice — and the render would
//     happily draw eleven cards as ten.
//
// packColumns is asserted here too because it used to be six lines inlined in
// the middle of a 700-line component, where no test could reach it.
//
// Run by `npm run verify`.

import { applyBriefOrder, orderOf, packColumns } from "../src/lib/brief-order.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const ids = (cards) => cards.map((c) => c.id).join(",");

// A stand-in for the real set: same shape, same weights, order irrelevant.
const CARDS = [
  { id: "notes", w: 3 }, { id: "minicalendar", w: 2.5 }, { id: "birthdays", w: 1.5 },
  { id: "markets", w: 2.5 }, { id: "watch", w: 3 }, { id: "wire", w: 4.5 },
  { id: "gsc", w: 2.5 }, { id: "meetings", w: 2 }, { id: "clarify", w: 1.5 },
  { id: "zts", w: 1.5 }, { id: "shopify", w: 1.5 },
];
const DEFAULT_IDS = ids(CARDS);

// ── the arrangement round-trips ──────────────────────────────────────────────
check("no saved order leaves the default arrangement alone",
  ids(applyBriefOrder(CARDS, null)) === DEFAULT_IDS);
check("an empty saved order leaves the default alone",
  ids(applyBriefOrder(CARDS, [])) === DEFAULT_IDS);

const moved = ["wire", "markets", "notes", "minicalendar", "birthdays", "watch", "gsc", "meetings", "clarify", "zts", "shopify"];
check("a saved order is applied exactly",
  ids(applyBriefOrder(CARDS, moved)) === moved.join(","));
check("applying an order is idempotent",
  ids(applyBriefOrder(applyBriefOrder(CARDS, moved), moved)) === moved.join(","));
check("orderOf round-trips through applyBriefOrder",
  ids(applyBriefOrder(CARDS, orderOf(applyBriefOrder(CARDS, moved)))) === moved.join(","));

// ── the card set is never corrupted ──────────────────────────────────────────
// Every reconciliation path has to return each card exactly once. This is the
// assertion that would catch a render drawing ten tiles where eleven exist.
const CASES = [
  ["no order", null],
  ["empty", []],
  ["full order", moved],
  ["partial order", ["wire", "notes"]],
  ["order with an unknown id", [...moved, "a-card-that-was-removed"]],
  ["order with duplicates", ["wire", "wire", "notes", "notes"]],
  ["order of only unknown ids", ["gone-1", "gone-2"]],
  ["reversed", [...DEFAULT_IDS.split(",")].reverse()],
];
for (const [label, order] of CASES) {
  const out = applyBriefOrder(CARDS, order);
  const set = new Set(out.map((c) => c.id));
  check(`every card survives: ${label}`,
    out.length === CARDS.length && set.size === CARDS.length,
    `got ${out.length} card(s), ${set.size} unique — ${ids(out)}`);
}

// ── a new card lands where it shipped, not at the top ────────────────────────
// The deliberate difference from applyNotesOrder, which puts unknowns FIRST. A
// card added by a release must not shove itself above everything the user
// arranged; it should turn up next to the neighbours it was designed beside.
const WITH_NEW = [...CARDS.slice(0, 4), { id: "brand-new", w: 2 }, ...CARDS.slice(4)];
const savedBefore = orderOf(applyBriefOrder(CARDS, moved)); // an order predating the new card
const afterUpgrade = applyBriefOrder(WITH_NEW, savedBefore);
check("an unknown card does not jump to the front", afterUpgrade[0].id !== "brand-new", ids(afterUpgrade));
check("an unknown card lands at its default index",
  afterUpgrade.findIndex((c) => c.id === "brand-new") === 4,
  `landed at ${afterUpgrade.findIndex((c) => c.id === "brand-new")} — ${ids(afterUpgrade)}`);
check("the saved arrangement survives the upgrade",
  ids(afterUpgrade).split(",").filter((i) => i !== "brand-new").join(",") === moved.join(","),
  ids(afterUpgrade));
check("a removed card leaves no hole",
  applyBriefOrder(CARDS.filter((c) => c.id !== "wire"), moved).length === CARDS.length - 1);

// ── packing ──────────────────────────────────────────────────────────────────
for (const n of [1, 2, 3]) {
  const cols = packColumns(CARDS, n);
  check(`packs into ${n} column(s)`, cols.length === n);
  check(`every card is dealt exactly once at ${n} column(s)`,
    cols.flat().length === CARDS.length && new Set(cols.flat().map((c) => c.id)).size === CARDS.length);
}
// One column must be the sequence verbatim — that IS the phone's scroll order.
check("one column preserves the sequence exactly",
  ids(packColumns(applyBriefOrder(CARDS, moved), 1)[0]) === moved.join(","));
// Within a column, sequence order holds; that is what makes a drag predictable.
for (const col of packColumns(CARDS, 3)) {
  const idxs = col.map((c) => CARDS.findIndex((x) => x.id === c.id));
  check(`column stays in sequence order (${col.map((c) => c.id).join(">")})`,
    idxs.every((v, i) => i === 0 || idxs[i - 1] < v));
}
// Greedy min-load should keep the columns within one card's weight of each other.
const loads = packColumns(CARDS, 3).map((col) => col.reduce((s, c) => s + c.w, 0));
const heaviest = Math.max(...CARDS.map((c) => c.w));
check("three columns balance to within the heaviest card",
  Math.max(...loads) - Math.min(...loads) <= heaviest,
  `loads ${loads.join(" / ")}`);
check("packing is stable for the same input",
  JSON.stringify(packColumns(CARDS, 3)) === JSON.stringify(packColumns(CARDS, 3)));
check("packColumns tolerates a nonsense column count", packColumns(CARDS, 0).length === 1);

// ── the ids are the persistence key, so they must be stable ──────────────────
// A rename resets that card to its default slot for anyone who had moved it.
// Pinning the list here makes that a deliberate decision rather than a typo.
import { readFileSync } from "node:fs";
const brief = readFileSync("src/pages/brief/BriefPage.jsx", "utf8");
const declared = [...(brief.match(/const DEFAULT_CARDS = \[([\s\S]*?)\n  \];/)?.[1] || "").matchAll(/id: "([\w-]+)"/g)].map((m) => m[1]);
check("BriefPage declares the expected card ids",
  declared.join(",") === DEFAULT_IDS,
  `\n  page  ${declared.join(",")}\n  test  ${DEFAULT_IDS}`);
check("every card id is unique", new Set(declared).size === declared.length);
check("the order is saved under app_settings.brief_order",
  /updateSetting\?\.\("brief_order", ids\)/.test(brief));

// The Wire's feed and its packing weight have to move together — a taller card
// with a stale weight is exactly how a column ends up lopsided.
check("The Wire's feed is 480px (50% up from 320)", /maxHeight: 480/.test(brief));
const wireW = brief.match(/id: "wire", c: card_wire, w: ([\d.]+)/)?.[1];
check("The Wire's packing weight grew with it", Number(wireW) >= 4, `w: ${wireW}`);

console.log(failed ? `\n${failed} brief-order check(s) failed` : "\nbrief-order: all checks passed");
process.exit(failed ? 1 : 0);
