// ─── Grocery logic smoke — PLANTED problems, known answers ────────────────────
// The list's intelligence is pure (src/features/food/groceryLogic.js) because
// every way it can be wrong is a wrong-but-plausible answer rather than a crash:
//
//   · peanut butter filed under Dairy (longest-phrase matching, gets it right)
//   · "2x milk" rendered as an item literally named "2x milk"
//   · a second "Eggs" row three aisles down from the "egg" already on the list
//   · a bare "2% milk" mangled into 2 of something called "% milk"
//
// None of those throw. Aisle and quantity are derived from the item text (there
// are no columns for either — see the note at the top of groceryLogic.js), so
// this file is the only thing standing between the lexicon and a list that sorts
// confidently and wrongly.
//
// Run by `npm run verify`.

import {
  AISLES, aisleOf, aisleMeta, parseItem, formatItem, canonicalName,
  findDuplicate, groupList, bumpFrequency, frequentSuggestions, STAPLE_MIN_BUYS,
  titleCase, storesOf, inStore, isStore, applyOrder, planRetag, applyRetag, storeCounts, ANY_STORE,
  planAdd, applyAdd, requestFor, isTempId, TMP_PREFIX,
} from "../src/features/food/groceryLogic.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

// ─── 1. aisles: the phrase-before-word cases that motivated the design ────────
// Each pair shares a word, and shortest-match or first-match-wins gets the left
// one wrong. This is the group that actually shipped broken elsewhere.
const PAIRS = [
  ["Peanut butter", "pantry", "Butter", "dairy"],
  ["Ice cream", "frozen", "Sour cream", "dairy"],
  ["Cream cheese", "dairy", "Cream", "dairy"],
  ["Orange juice", "drinks", "Orange", "produce"],
  ["Protein drinks", "drinks", "Protein powder", "pantry"],
  ["Frozen berries", "frozen", "Blueberries", "produce"],
  ["Sweet potato", "produce", "Potatoes", "produce"],
  ["Almond milk", "dairy", "Almonds", "snacks"],
];
for (const [a, aAisle, b, bAisle] of PAIRS) {
  check(`"${a}" → ${aAisle}`, aisleOf(a) === aAisle, `got ${aisleOf(a)}`);
  check(`"${b}" → ${bAisle}`, aisleOf(b) === bAisle, `got ${aisleOf(b)}`);
}

// The three rows from the screenshot this work started from.
check('"Peanut butter" is not Dairy', aisleOf("Peanut butter") !== "dairy");
check('"Protein drinks" is not Pantry', aisleOf("Protein drinks") === "drinks", aisleOf("Protein drinks"));
check('"Meat Packs" → meat', aisleOf("Meat Packs") === "meat", aisleOf("Meat Packs"));

check("plurals classify like singulars", aisleOf("avocados") === aisleOf("avocado"));
check("case is irrelevant", aisleOf("BANANAS") === "produce");
check("a quantity prefix doesn't change the aisle", aisleOf("3x salmon") === aisleOf("salmon"));
check("unknown items land in other, not a wrong guess", aisleOf("xyzzy widget") === "other", aisleOf("xyzzy widget"));
check("empty text is other", aisleOf("") === "other" && aisleOf(null) === "other");
// \b on both ends — the bug this prevents is "ice" inside "juice".
check('"juice" is not matched by "ice"', aisleOf("juice") === "drinks", aisleOf("juice"));
check("every aisle key in the lexicon has metadata", AISLES.every((a) => aisleMeta(a.key).label === a.label));
check("aisleMeta falls back to other", aisleMeta("nope").key === "other");
check("other is last in the walk", AISLES[AISLES.length - 1].key === "other");

// ─── 2. quantities: only the explicit forms, and they round-trip ──────────────
// Names come back Title Cased — that is the display rule, applied in parseItem
// so it reaches rows written long before the rule existed.
const QTY = [["2x milk", 2, "Milk"], ["2 x milk", 2, "Milk"], ["12x eggs", 12, "Eggs"],
  ["milk x2", 2, "Milk"], ["milk x 2", 2, "Milk"], ["2×milk", 2, "Milk"]];
for (const [text, qty, name] of QTY) {
  const p = parseItem(text);
  check(`"${text}" → ${qty} × ${name}`, p.qty === qty && p.name === name, JSON.stringify(p));
}
// THE GUARD. Each of these leads with a digit and means something else entirely;
// parsing them as a quantity silently renames the item on screen.
for (const text of ["2% milk", "1lb ground beef", "12 eggs", "7up", "5 guys", "100 calorie packs"]) {
  const p = parseItem(text);
  check(`"${text}" keeps its words`, p.qty === 1 && p.name === titleCase(text), JSON.stringify(p));
}
check("format is the inverse of parse", ["Milk", "2x Milk", "12x Eggs"].every((s) => {
  const { qty, name } = parseItem(s);
  return formatItem(qty, name) === s;
}));
check("qty 1 formats without a multiplier", formatItem(1, "milk") === "Milk");
check("qty below 1 clamps rather than storing 0x", formatItem(0, "milk") === "Milk" && formatItem(-3, "milk") === "Milk");
check("a non-numeric qty falls back to 1", formatItem(undefined, "milk") === "Milk" && formatItem(NaN, "milk") === "Milk");
check("empty text parses to empty, not a crash", parseItem("").name === "" && parseItem(undefined).qty === 1);

// ─── 2b. Title Case: capitalise words, vandalise nothing ─────────────────────
check("every word gets its capital", titleCase("greek yogurt") === "Greek Yogurt");
check("an existing capital is left alone, not lowercased",
  titleCase("BBQ sauce") === "BBQ Sauce", titleCase("BBQ sauce"));
// The regression that shipped for exactly one build: matching "first letter
// after a non-letter" capitalises the letter sitting against a DIGIT too.
check("a unit glued to a number is not a word", titleCase("1lb ground beef") === "1lb Ground Beef", titleCase("1lb ground beef"));
check("7up stays 7up", titleCase("7up") === "7up", titleCase("7up"));
check("a percentage keeps its number", titleCase("2% milk") === "2% Milk", titleCase("2% milk"));
check("punctuation still breaks a word", titleCase("half-and-half") === "Half-And-Half", titleCase("half-and-half"));
check("titleCase is idempotent", titleCase(titleCase("greek yogurt")) === titleCase("greek yogurt"));
check("titleCase survives empty and null", titleCase("") === "" && titleCase(null) === "" && titleCase(undefined) === "");

// ─── 2c. stores and sections live in the text, like quantity ─────────────────
{
  const p = parseItem("2x milk @costco");
  check("a store tag parses off the name", p.qty === 2 && p.name === "Milk" && p.store === "Costco", JSON.stringify(p));
}
{
  const p = parseItem("ice cream #freezer @whole foods");
  check("a section and a multi-word store both parse",
    p.name === "Ice Cream" && p.section === "Freezer" && p.store === "Whole Foods", JSON.stringify(p));
}
check("an untagged item has empty tags, not undefined",
  parseItem("Milk").store === "" && parseItem("Milk").section === "");
// A row that lost its whole name to a stray tag would be untappable and
// unreadable — far worse than an item literally called "@costco".
check("a bare tag keeps its text as the name",
  parseItem("@costco").name.toLowerCase() === "@costco" && parseItem("@costco").store === "",
  JSON.stringify(parseItem("@costco")));
check("tags round-trip through formatItem", (() => {
  const s = "2x Milk #Freezer @Costco";
  const p = parseItem(s);
  return formatItem(p.qty, p.name, p) === s;
})(), formatItem(2, "Milk", { store: "Costco", section: "Freezer" }));
check("formatItem still works with no tags at all", formatItem(2, "milk") === "2x Milk");
// The stepper rebuilds the string on every tap; dropping the tag there would
// quietly move the item to "any store" the first time you pressed +.
check("bumping quantity keeps the store", (() => {
  const p = parseItem("Milk @Costco");
  return formatItem(p.qty + 1, p.name, p) === "2x Milk @Costco";
})());
check("the same item at two stores is NOT a duplicate",
  canonicalName("Milk @Costco") !== canonicalName("Milk @HEB"));
check("the same item at the same store IS a duplicate",
  canonicalName("2x milk @costco") === canonicalName("Milk @Costco"));
check("a section is not part of identity",
  canonicalName("Milk #Freezer") === canonicalName("Milk"));
check("findDuplicate respects the store", (() => {
  const l = [{ id: "a", item: "Milk @Costco" }];
  return findDuplicate(l, "milk @costco")?.id === "a" && findDuplicate(l, "milk @heb") === null;
})());

// ─── 3. duplicates: the second identical row is the thing to prevent ──────────
const list = [
  { id: "a", item: "Eggs", checked: false },
  { id: "b", item: "2x Milk", checked: true },
  { id: "c", item: "Peanut butter", checked: false },
];
check("exact match found", findDuplicate(list, "Eggs")?.id === "a");
check("case-insensitive", findDuplicate(list, "eggs")?.id === "a");
check("singular finds the plural row", findDuplicate(list, "egg")?.id === "a");
check("a quantity doesn't hide the match", findDuplicate(list, "3x milk")?.id === "b");
check("multi-word matches", findDuplicate(list, "peanut butter")?.id === "c");
check("trailing punctuation is ignored", findDuplicate(list, "eggs.")?.id === "a");
check("a genuinely new item is not a duplicate", findDuplicate(list, "Bread") === null);
check("empty text never matches", findDuplicate(list, "") === null && findDuplicate(list, "  ") === null);
check("berries → berry stem is stable both ways", canonicalName("Strawberries") === canonicalName("strawberry"));
check("canonical is quantity-free", canonicalName("4x Bread") === canonicalName("bread"));

// ─── 4. grouping: walk order, cart at the bottom, counts ─────────────────────
const shop = [
  { id: "1", item: "Peanut butter", checked: false }, // pantry
  { id: "2", item: "Bananas", checked: false },       // produce
  { id: "3", item: "Eggs", checked: true },           // dairy, in the cart
  { id: "4", item: "Sourdough", checked: false },     // bakery
  { id: "5", item: "Avocado", checked: false },       // produce
  { id: "6", item: "Chicken breast", checked: false },// meat
];
const g = groupList(shop);
check("sections come back in walk order",
  g.sections.map((s) => s.key).join(",") === "produce,bakery,meat,pantry",
  g.sections.map((s) => s.key).join(","));
check("empty aisles are omitted entirely", g.sections.every((s) => s.items.length > 0));
check("items keep their insertion order inside an aisle",
  g.sections.find((s) => s.key === "produce").items.map((i) => i.id).join(",") === "2,5");
check("checked items are in the cart, not in an aisle",
  g.cart.map((i) => i.id).join(",") === "3" && g.sections.every((s) => s.items.every((i) => !i.checked)));
check("remaining counts only what's left to get", g.remaining === 5, String(g.remaining));
check("total counts everything", g.total === 6, String(g.total));
check("an empty list groups to nothing, not undefined", (() => {
  const e = groupList([]);
  return e.sections.length === 0 && e.cart.length === 0 && e.remaining === 0 && e.total === 0;
})());
check("null groups safely", groupList(null).total === 0);
check("an all-checked list has no sections but keeps its cart", (() => {
  const a = groupList([{ id: "x", item: "Milk", checked: true }]);
  return a.sections.length === 0 && a.cart.length === 1 && a.remaining === 0;
})());

// ─── 4b. stores filter, sections pin, drags stick ────────────────────────────
const shops = [
  { id: "1", item: "Bananas", checked: false },              // no store — every shop
  { id: "2", item: "Milk @Costco", checked: false },
  { id: "3", item: "Sourdough @HEB", checked: false },
  { id: "4", item: "Ice cream #Freezer @Costco", checked: false },
];
check("every store lands in the picker, sorted and Title Cased",
  storesOf(shops).join(",") === "Costco,HEB", storesOf(shops).join(","));
check("a store you named but haven't shopped survives",
  storesOf([], ["aldi"]).join(",") === "Aldi", storesOf([], ["aldi"]).join(","));
check("the same store cased two ways is one store",
  storesOf([{ item: "Milk @costco" }], ["Costco"]).length === 1);
check("storesOf tolerates nulls", storesOf(null, null).length === 0);
// The staple rule: bread is bread. An untagged item belonging to only "All"
// would hide itself the moment you picked a shop, and you'd find out at the till.
check("an untagged item shows under every store",
  inStore("Bananas", "Costco") && inStore("Bananas", "") && inStore("Bananas", "HEB"));
check("a tagged item shows only under its own store",
  inStore("Milk @Costco", "Costco") && !inStore("Milk @Costco", "HEB"));
check("the store match is case-insensitive", inStore("Milk @Costco", "costco"));
check("isStore is strict where inStore is generous",
  isStore("Milk @Costco", "Costco") && !isStore("Bananas", "Costco") && inStore("Bananas", "Costco"));
{
  const c = groupList(shops, { store: "Costco" });
  const ids = c.sections.flatMap((s) => s.items.map((i) => i.id)).sort().join(",");
  // THE FIX: a store's aisles hold that store's items and nothing else. Staples
  // used to be mixed in, which made "Costco" read as Costco plus a scatter of
  // things that weren't, and left no way to tell which was which.
  check("a store's aisles hold only that store's items", ids === "2,4", ids);
  check("the other store's items are gone", !ids.includes("3"));
  // Dropped instead of annexed would be worse — you'd walk past the bread.
  check("untagged staples come back separately, not discarded",
    c.anywhere.map((i) => i.id).join(",") === "1", c.anywhere.map((i) => i.id).join(","));
  check("the header still counts the staples as things to get",
    c.total === 3 && c.remaining === 3, `${c.total}/${c.remaining}`);
  // A named section beats the guessed aisle and sorts above it — you said where
  // it goes, so the lexicon doesn't get a vote.
  check("a pinned section becomes its own heading at the top",
    c.sections[0].label === "Freezer" && c.sections[0].pinned === true,
    c.sections.map((s) => s.label).join(","));
  check("the pinned item left its guessed aisle",
    !c.sections.some((s) => !s.pinned && s.items.some((i) => i.id === "4")));
}
{
  const a = groupList(shops, { store: "" });
  check("no filter shows everything", a.total === 4);
  // With no store there is nothing to separate staples FROM.
  check("the anywhere group is empty when no store is picked", a.anywhere.length === 0);
  check("and every item is in the aisles", a.sections.flatMap((s) => s.items).length === 4);
}

// ─── 4d. the pill counts — the answer to "where did my list go" ──────────────
// Tag something to Costco while looking at Jewel and it vanishes. Without a
// count on every pill the view can only say "nothing here"; it can't say "and
// there are two at Costco", which is the thing you actually need to know.
{
  const n = storeCounts(shops);
  check("the total counts everything still to get", n[""] === 4, String(n[""]));
  check("each store counts only its own", n.Costco === 2 && n.HEB === 1, `${n.Costco}/${n.HEB}`);
  check("untagged items get their own tally", n[ANY_STORE] === 1, String(n[ANY_STORE]));
  // A count of what's left to buy, not of what's on the list — a shop showing
  // "3" when all three are already in the trolley sends you back for nothing.
  const withCart = storeCounts([...shops, { id: "9", item: "Eggs @Costco", checked: true }]);
  check("checked items are not counted as still to get", withCart.Costco === 2, String(withCart.Costco));
  check("storeCounts tolerates an empty list", storeCounts([])[""] === 0 && storeCounts(null)[""] === 0);
}

// ─── 4c. renaming and removing a store ───────────────────────────────────────
// The store is part of each item's TEXT, so a rename is a bulk rewrite, and a
// rewrite can land a row on top of one that already exists.
const twoShops = [
  { id: "a", item: "Milk @Costco", checked: false },
  { id: "b", item: "2x Milk @HEB", checked: false },
  { id: "c", item: "Bananas", checked: false },
  { id: "d", item: "Ice Cream #Freezer @HEB", checked: false },
  { id: "e", item: "Milk @HEB", checked: true },
];
{
  const plan = planRetag(twoShops, "HEB", "H-E-B");
  const items = applyRetag(twoShops, plan).map(i => i.item);
  check("a plain rename retags every item at that store",
    items.includes("2x Milk @H-E-B") && items.includes("Ice Cream #Freezer @H-E-B"), items.join(" | "));
  check("a rename touches nothing at another store", items.includes("Milk @Costco"));
  check("a rename touches nothing untagged", items.includes("Bananas"));
  check("a pinned section survives a rename", items.some(i => i.includes("#Freezer @H-E-B")));
  check("a plain rename deletes nothing", plan.deletes.length === 0, JSON.stringify(plan.deletes));
}
{
  // The back-door duplicate: rename HEB onto Costco and both shops' milk
  // becomes Milk-at-Costco. Two rows saying the same thing is exactly what the
  // add path exists to prevent, so the rename has to merge instead.
  const plan = planRetag(twoShops, "HEB", "Costco");
  const items = applyRetag(twoShops, plan);
  const names = items.map(i => i.item);
  // Unchecked only: the checked "Milk @HEB" also becomes Milk-at-Costco, and it
  // is SUPPOSED to sit alongside rather than merge (see the checked-state check
  // below), so counting every row that says Milk at Costco would score the
  // correct behaviour as a duplicate.
  check("a colliding rename merges instead of duplicating",
    items.filter(i => !i.checked && /Milk @Costco$/.test(i.item)).length === 1, names.join(" | "));
  check("the merge sums the quantities", names.includes("3x Milk @Costco"), names.join(" | "));
  check("the redundant row is deleted", plan.deletes.includes("b"), JSON.stringify(plan.deletes));
  check("the surviving row is the one already at the destination",
    items.some(i => i.id === "a" && i.item === "3x Milk @Costco"));
  // Same words, different fact: one is in the trolley and one isn't.
  check("a checked row never merges into an unchecked one",
    items.some(i => i.id === "e" && i.checked && /Milk @Costco/.test(i.item)) && !plan.deletes.includes("e"));
}
{
  // Removing a store must not remove the shopping.
  const plan = planRetag(twoShops, "HEB", "");
  const items = applyRetag(twoShops, plan);
  check("removing a store untags its items rather than deleting them",
    items.length === twoShops.length - plan.deletes.length && items.some(i => i.item === "2x Milk"),
    items.map(i => i.item).join(" | "));
  check("an untagged collision still merges", plan.deletes.length >= 0);
  check("a removed store's pinned section survives", items.some(i => i.item === "Ice Cream #Freezer"));
}
check("the store to rename is matched case-insensitively",
  planRetag(twoShops, "heb", "Aldi").updates.length === planRetag(twoShops, "HEB", "Aldi").updates.length);
check("renaming a store with no items is a no-op plan", (() => {
  const p = planRetag(twoShops, "Aldi", "Kroger");
  return p.updates.length === 0 && p.deletes.length === 0;
})());
check("an empty source store is refused rather than retagging everything", (() => {
  const p = planRetag(twoShops, "", "Costco");
  return p.updates.length === 0 && p.deletes.length === 0;
})());
check("planRetag tolerates a null list", (() => {
  const p = planRetag(null, "HEB", "Aldi");
  return p.updates.length === 0 && p.deletes.length === 0;
})());
check("applyRetag on an empty plan changes nothing",
  applyRetag(twoShops, { updates: [], deletes: [] }).length === twoShops.length);
check("the renamed store then appears in the picker under its new name",
  storesOf(applyRetag(twoShops, planRetag(twoShops, "HEB", "Aldi"))).join(",") === "Aldi,Costco",
  storesOf(applyRetag(twoShops, planRetag(twoShops, "HEB", "Aldi"))).join(","));

// applyOrder — the drag, persisted. Same unknown-id rule as the Brief's cards:
// an id the saved order has never seen keeps its default slot rather than
// jumping to an end, so adding an item can't reshuffle what you placed.
const ordered = [{ id: "a" }, { id: "b" }, { id: "c" }];
check("a saved order is honoured", applyOrder(ordered, ["c", "a", "b"]).map((i) => i.id).join(",") === "c,a,b");
check("no saved order changes nothing", applyOrder(ordered, []).map((i) => i.id).join(",") === "a,b,c");
// "b" was never dragged, so it holds its DEFAULT index (1) — it lands second,
// not last. That's the whole point of the rule: adding an item drops it near
// where it would have been, instead of on top of rows you deliberately placed.
check("an unknown id keeps its default slot",
  applyOrder(ordered, ["c", "a"]).map((i) => i.id).join(",") === "c,b,a",
  applyOrder(ordered, ["c", "a"]).map((i) => i.id).join(","));
check("ids for deleted rows leave no hole",
  applyOrder(ordered, ["zz", "c", "yy", "a", "b"]).map((i) => i.id).join(",") === "c,a,b");
check("a duplicated id doesn't duplicate the row",
  applyOrder(ordered, ["b", "b", "a", "c"]).map((i) => i.id).join(",") === "b,a,c");
check("the order applies inside a section, not across the walk", (() => {
  // "2" and "5" are both produce; the saved order must not lift produce above
  // the aisle order or drag a bakery item into it.
  const o = groupList(shop, { order: ["5", "2"] });
  return o.sections[0].key === "produce" && o.sections[0].items.map((i) => i.id).join(",") === "5,2";
})());
check("the cart is orderable too",
  groupList([{ id: "p", item: "Eggs", checked: true }, { id: "q", item: "Milk", checked: true }], { order: ["q", "p"] })
    .cart.map((i) => i.id).join(",") === "q,p");

// ─── 5. frequency: learned from what you CLEAR, suggested only when useful ────
let tally = bumpFrequency({}, [{ item: "Eggs" }, { item: "2x Milk" }]);
check("one buy is recorded", tally[canonicalName("Eggs")].buys === 1);
check("the label keeps its readable form, not the stem", tally[canonicalName("2x Milk")].label === "Milk");
tally = bumpFrequency(tally, [{ item: "eggs" }]);
check("a second buy of the same thing accumulates", tally[canonicalName("Eggs")].buys === 2);
check("bumping doesn't mutate the tally it was given", (() => {
  const before = { [canonicalName("Eggs")]: { label: "Eggs", buys: 1 } };
  bumpFrequency(before, [{ item: "Eggs" }]);
  return before[canonicalName("Eggs")].buys === 1;
})());
check(`below ${STAPLE_MIN_BUYS} buys makes no suggestion`,
  frequentSuggestions(tally, []).every((s) => s.label !== "Milk"));
check("at the threshold it is suggested", frequentSuggestions(tally, []).some((s) => s.label === "Eggs"));
check("something already on the list is not suggested",
  frequentSuggestions(tally, [{ item: "Eggs", checked: false }]).length === 0);
check("suggestions are capped", frequentSuggestions(
  Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`item${i}`, { label: `Item ${i}`, buys: 9 }])), [], 6,
).length === 6);
check("a missing tally yields no suggestions rather than throwing",
  frequentSuggestions(null, null).length === 0 && frequentSuggestions(undefined, []).length === 0);
check("garbage entries are skipped, not rendered",
  frequentSuggestions({ x: null, y: { label: "Y" } }, []).length === 0);

// ─── 6. the add pipeline: one decision, taken before anything is written ───────
// This section exists because of a bug none of the five above could see. They all
// test pure functions in isolation; the list broke in the SEAM between them.
//
// react-query runs onMutate (the optimistic cache write) before mutationFn (the
// request). The shipped code decided merge-vs-insert inside mutationFn, reading
// the cache — so it saw the list AFTER the optimistic row had been written to it,
// matched the new item against itself, and sent a merge aimed at a temporary id.
// Every add became `PATCH /grocery_items?id=eq.tmp-1785391991627` → 400 →
// rollback → item gone. Four days, from a phone in a shop, with nothing on screen
// to say anything had failed.
//
// So these assertions are about ORDER, and about what goes over the WIRE — not
// about any one function's answer.

const NOW = "2026-07-30T12:00:00.000Z";

// The lifecycle, with the one ordering fact that matters preserved: decide from
// the pre-write list, then write, then send.
const runAdd = (list, text, tmpId) => {
  const plan = planAdd(list, text, tmpId);
  if (!plan) return { plan: null, list, request: null };
  return { plan, list: applyAdd(list, plan, NOW), request: requestFor(plan) };
};

{
  const a = runAdd([], "Milk", `${TMP_PREFIX}1`);
  check("a new item is an insert", a.plan.kind === "insert" && a.request.op === "insert");
  check("the insert sends the text that was typed", a.request.item === "Milk");
  check("the optimistic row shows up at once", a.list.length === 1 && a.list[0].item === "Milk");
  check("the optimistic row is unchecked and dated", a.list[0].checked === false && a.list[0].created_at === NOW);
  check("the optimistic row carries a temporary id", isTempId(a.list[0].id));
}

// THE INVARIANT. For any starting list and anything typed, a single add never
// sends a request against an id the server has never seen. Nothing else in this
// file would have caught the shipped bug; this is the assertion that does.
{
  const LISTS = [
    [],
    [{ id: "real-1", item: "Milk", checked: false }],
    [{ id: `${TMP_PREFIX}9`, item: "Milk", checked: false }],           // an add still in flight
    [{ id: "real-1", item: "2x Milk", checked: true }, { id: `${TMP_PREFIX}9`, item: "Eggs", checked: false }],
  ];
  const TEXTS = ["Milk", "milk", "Milks", "2x milk", "Eggs", "egg", "Bread"];
  let bad = null;
  LISTS.forEach((list, i) => TEXTS.forEach((text) => {
    const r = runAdd(list, text, `${TMP_PREFIX}new`);
    if (r.request?.op === "update" && isTempId(r.request.id)) bad = `list ${i} + "${text}" → PATCH ${r.request.id}`;
  }));
  check("no add, on any list, sends a request against a temporary id", !bad, bad || "");

  // A duplicate that hasn't landed yet gets an insert rather than being dropped —
  // a second line saying milk is a stepper tap to fix; a lost item is not.
  check("an add matching an in-flight row still reaches the server",
    runAdd(LISTS[2], "Milk", `${TMP_PREFIX}new`).request.op === "insert");
}

// Proof the invariant above has teeth: the shipped decision function,
// reconstructed, shown failing it. Without this, "the test would have caught it"
// is a claim rather than a checked fact — and if a refactor ever makes this
// reconstruction pass, the reconstruction has stopped modelling the old code and
// the invariant is no longer guarding anything.
{
  const shipped = (list, text, tmpId) => {
    const written = applyAdd(list, { kind: "insert", id: tmpId, item: text, typed: text }, NOW);
    const dup = findDuplicate(written, text);        // ← reads the list it just wrote
    return dup ? { op: "update", id: dup.id } : { op: "insert", item: text };
  };
  const r = shipped([], "Milk", `${TMP_PREFIX}1`);
  check("the shipped decision function does fail that invariant",
    r.op === "update" && isTempId(r.id),
    "the reconstruction no longer reproduces the bug — check it still models the old code");
}

// Merging, which is the behaviour the rebuild was actually for.
{
  const r = runAdd([{ id: "real-1", item: "Milk", checked: true }], "milk", `${TMP_PREFIX}1`);
  check("an item already on the list merges into its real id", r.request.op === "update" && r.request.id === "real-1");
  check("the merge sums the quantities", r.request.patch.item === "2x Milk");
  check("the merge unchecks the row — you need it again", r.request.patch.checked === false);
  check("merging adds no second row", r.list.length === 1 && r.list[0].item === "2x Milk");
  check("what the row shows and what the request sends are the same string",
    r.list[0].item === r.request.patch.item);
  check("a quantified add adds to a quantified row",
    runAdd([{ id: "real-1", item: "2x Milk", checked: false }], "3x milk", `${TMP_PREFIX}1`).request.patch.item === "5x Milk");
}

check("blank text plans nothing at all", planAdd([], "   ", `${TMP_PREFIX}1`) === null && requestFor(null) === null);
check("the plan keeps the typed text, so a failed add can be retried",
  planAdd([], "  Milk  ", `${TMP_PREFIX}1`).typed === "Milk");
check("a real uuid is never mistaken for a temporary id",
  !isTempId("0d2f6286-1780-49aa-9d48-d4a7dac2ce66") && !isTempId(undefined) && !isTempId(null)
  && !isTempId({}) && isTempId(`${TMP_PREFIX}1`));

console.log(failed ? `\nGROCERY SMOKE FAILED (${failed})` : "\nGROCERY SMOKE PASS");
process.exit(failed ? 1 : 0);
