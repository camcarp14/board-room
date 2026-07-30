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
const QTY = [["2x milk", 2, "milk"], ["2 x milk", 2, "milk"], ["12x eggs", 12, "eggs"],
  ["milk x2", 2, "milk"], ["milk x 2", 2, "milk"], ["2×milk", 2, "milk"]];
for (const [text, qty, name] of QTY) {
  const p = parseItem(text);
  check(`"${text}" → ${qty} × ${name}`, p.qty === qty && p.name === name, JSON.stringify(p));
}
// THE GUARD. Each of these leads with a digit and means something else entirely;
// parsing them as a quantity silently renames the item on screen.
for (const text of ["2% milk", "1lb ground beef", "12 eggs", "7up", "5 guys", "100 calorie packs"]) {
  const p = parseItem(text);
  check(`"${text}" is left alone`, p.qty === 1 && p.name === text, JSON.stringify(p));
}
check("format is the inverse of parse", ["milk", "2x milk", "12x eggs"].every((s) => {
  const { qty, name } = parseItem(s);
  return formatItem(qty, name) === s;
}));
check("qty 1 formats without a multiplier", formatItem(1, "milk") === "milk");
check("qty below 1 clamps rather than storing 0x", formatItem(0, "milk") === "milk" && formatItem(-3, "milk") === "milk");
check("a non-numeric qty falls back to 1", formatItem(undefined, "milk") === "milk" && formatItem(NaN, "milk") === "milk");
check("empty text parses to empty, not a crash", parseItem("").name === "" && parseItem(undefined).qty === 1);

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
