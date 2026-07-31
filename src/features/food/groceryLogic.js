// ─── Grocery list intelligence ────────────────────────────────────────────────
// Everything that makes the list smarter than a flat array, as pure functions.
//
// THE CONSTRAINT THAT SHAPED THIS: grocery_items has four columns that matter —
// id, item, checked, created_at. There is no aisle column, no quantity column,
// and no schema migration pipeline in this repo (the SQL is applied by hand in
// the Supabase editor). So aisle and quantity are *derived from the item text*
// on the client. That is a real constraint, not laziness, and it has one good
// consequence: nothing here can corrupt stored data, because none of it is
// stored. Rename an aisle, fix a keyword, change the walk order — every existing
// list re-sorts on the next render with no backfill.
//
// Pure, because every failure mode is a wrong-but-plausible answer rather than a
// crash: peanut butter filed under Dairy, "2x milk" shown as an item literally
// named "2x milk", a duplicate row instead of a merge. Asserted end-to-end by
// scripts/grocery-smoke.mjs.

/**
 * The aisles, in the order you walk them.
 *
 * This ordering IS the feature — a list sorted by when you'll reach it beats a
 * list sorted by when you typed it, which is the only order the table can give.
 * Perimeter first (produce → bakery → deli → butcher → dairy), then frozen, then
 * the centre aisles, then the far wall, then non-food. "Other" is last and is
 * where anything unrecognised lands.
 */
export const AISLES = [
  { key: "produce", label: "Produce", tone: "var(--green)" },
  { key: "bakery", label: "Bakery", tone: "var(--amber)" },
  { key: "deli", label: "Deli", tone: "var(--amber)" },
  { key: "meat", label: "Meat", tone: "var(--red)" },
  { key: "seafood", label: "Seafood", tone: "var(--blue)" },
  { key: "dairy", label: "Dairy & Eggs", tone: "var(--blue)" },
  { key: "frozen", label: "Frozen", tone: "var(--blue)" },
  { key: "pantry", label: "Pantry", tone: "var(--purple)" },
  { key: "snacks", label: "Snacks", tone: "var(--purple)" },
  { key: "drinks", label: "Drinks", tone: "var(--purple)" },
  { key: "household", label: "Household", tone: "var(--sub)" },
  { key: "other", label: "Other", tone: "var(--faint)" },
];

const AISLE_BY_KEY = Object.fromEntries(AISLES.map((a) => [a.key, a]));
export const aisleMeta = (key) => AISLE_BY_KEY[key] || AISLE_BY_KEY.other;

/**
 * Title Case, applied to everything on the way in AND on the way out.
 *
 * A shopping list you typed one-handed is all lowercase, and reading "milk,
 * greek yogurt, paper towels" is worse than reading "Milk, Greek Yogurt, Paper
 * Towels" — so this is a formatting rule, not a preference toggle.
 *
 * It capitalises the first letter of each word and TOUCHES NOTHING ELSE, which
 * is the difference between a helper and a vandal: lowercasing the remainder
 * (the usual one-liner) turns "BBQ Sauce" into "Bbq Sauce" and "2% Milk" into
 * "2% milk".
 *
 * A word starts at the string's start or after a character that is neither a
 * letter nor a DIGIT. The digit half of that is what keeps units intact: match
 * on "the first letter after a non-letter" alone and "1lb ground beef" becomes
 * "1Lb Ground Beef" and "7up" becomes "7Up" — both wrong, and both things you
 * actually write on a shopping list. Punctuation still breaks a word, so
 * "half-and-half" comes out "Half-And-Half" and "(organic) milk" gets its
 * bracketed word too.
 *
 * Applied at BOTH ends on purpose. On the way in so what's stored is what you'd
 * want to read; on the way out so the hundreds of rows already in the table look
 * right immediately, with no backfill and nothing to migrate.
 */
const WORD_START = /(^|[^A-Za-zÀ-ÖØ-öø-ÿ0-9])([a-zà-öø-ÿ])/g;
export function titleCase(text) {
  return String(text ?? "").replace(WORD_START, (_m, before, letter) => before + letter.toUpperCase());
}

/**
 * Keyword → aisle.
 *
 * Matched LONGEST PHRASE FIRST, which is the whole reason this is a flat list of
 * phrases rather than a per-aisle word bag. "Peanut butter" is Pantry and
 * "butter" is Dairy; "sour cream" is Dairy and "ice cream" is Frozen; "protein
 * drinks" is Drinks and "protein powder" is Pantry. Shortest-first or
 * first-match-wins gets every one of those pairs wrong, and the first list this
 * ran against had peanut butter on it.
 */
const LEXICON = {
  produce: [
    "produce", "apple", "banana", "orange", "lemon", "lime", "grape", "berry", "berries",
    "strawberry", "strawberries", "blueberry", "blueberries", "raspberry", "raspberries",
    "avocado", "tomato", "tomatoes", "potato", "potatoes", "sweet potato", "onion", "garlic",
    "lettuce", "spinach", "kale", "arugula", "salad", "cucumber", "pepper", "bell pepper",
    "carrot", "celery", "broccoli", "cauliflower", "asparagus", "zucchini", "squash",
    "mushroom", "mushrooms", "cilantro", "parsley", "basil", "ginger", "melon", "watermelon",
    "pineapple", "mango", "peach", "pear", "plum", "cherry", "cherries", "grapefruit",
    "green beans", "brussels sprouts", "cabbage", "corn", "herbs", "fruit", "vegetables", "veggies",
  ],
  bakery: [
    "bread", "sourdough", "baguette", "bagel", "bagels", "roll", "rolls", "bun", "buns",
    "tortilla", "tortillas", "pita", "naan", "croissant", "muffin", "muffins", "donut",
    "donuts", "cake", "pastry", "pastries", "cookie dough", "pie crust", "brioche",
  ],
  deli: [
    "deli", "sliced turkey", "sliced ham", "salami", "prosciutto", "pepperoni", "hummus",
    "olives", "rotisserie", "charcuterie",
  ],
  meat: [
    "meat", "meat pack", "meat packs", "chicken", "chicken breast", "chicken thigh", "thighs",
    "beef", "ground beef", "steak", "ribeye", "sirloin", "pork", "pork chop", "bacon",
    "sausage", "ribs", "brisket", "lamb", "turkey", "ground turkey", "hot dog", "hot dogs",
    "burger", "burgers", "jerky",
  ],
  seafood: [
    "fish", "salmon", "tuna", "cod", "tilapia", "halibut", "shrimp", "prawns", "crab",
    "lobster", "scallops", "mussels", "clams", "oysters", "sardines", "anchovies", "seafood",
  ],
  dairy: [
    "milk", "whole milk", "oat milk", "almond milk", "soy milk", "cream", "heavy cream",
    "half and half", "sour cream", "butter", "ghee", "cheese", "cheddar", "mozzarella",
    "parmesan", "feta", "goat cheese", "cream cheese", "cottage cheese", "string cheese",
    "yogurt", "greek yogurt", "kefir", "egg", "eggs", "egg whites", "creamer",
  ],
  frozen: [
    "frozen", "ice cream", "gelato", "popsicle", "popsicles", "frozen pizza", "frozen fruit",
    "frozen berries", "frozen vegetables", "frozen veggies", "waffles", "ice",
  ],
  pantry: [
    "pantry", "rice", "brown rice", "jasmine rice", "quinoa", "couscous", "pasta", "spaghetti",
    "penne", "noodles", "ramen", "oats", "oatmeal", "cereal", "granola", "flour", "sugar",
    "brown sugar", "honey", "maple syrup", "syrup", "salt", "black pepper", "spices",
    "cinnamon", "cumin", "paprika", "oregano", "olive oil", "avocado oil", "coconut oil",
    "vegetable oil", "vinegar", "balsamic", "soy sauce", "hot sauce", "sriracha", "ketchup",
    "mustard", "mayo", "mayonnaise", "salsa", "peanut butter", "almond butter", "nutella",
    "jam", "jelly", "canned tomatoes", "tomato paste", "tomato sauce", "pasta sauce",
    "marinara", "beans", "black beans", "chickpeas", "lentils", "broth", "stock",
    "chicken broth", "coconut milk", "baking powder", "baking soda", "vanilla", "yeast",
    "protein powder", "supplements", "vitamins", "creatine", "tea", "coffee", "coffee beans",
    "espresso", "cocoa",
  ],
  snacks: [
    "snack", "snacks", "chips", "tortilla chips", "pretzels", "popcorn", "crackers", "nuts",
    "almonds", "cashews", "peanuts", "pistachios", "walnuts", "trail mix", "granola bar",
    "granola bars", "protein bar", "protein bars", "candy", "chocolate", "cookies", "gum",
  ],
  drinks: [
    "drink", "drinks", "protein drink", "protein drinks", "protein shake", "water",
    "sparkling water", "seltzer", "soda", "coke", "juice", "orange juice", "lemonade",
    "energy drink", "gatorade", "electrolytes", "kombucha", "beer", "wine", "liquor",
    "whiskey", "vodka", "tequila", "champagne",
  ],
  household: [
    "paper towels", "toilet paper", "tissues", "napkins", "trash bags", "ziploc",
    "aluminum foil", "foil", "plastic wrap", "parchment paper", "dish soap", "dishwasher",
    "detergent", "laundry", "fabric softener", "bleach", "cleaner", "disinfectant",
    "sponge", "sponges", "toothpaste", "toothbrush", "floss", "shampoo", "conditioner",
    "body wash", "soap", "deodorant", "razors", "sunscreen", "lotion", "batteries",
    "light bulb", "light bulbs", "dog food", "cat food", "litter", "diapers", "wipes",
  ],
};

// Flattened and sorted longest-first, once, at module load — see LEXICON's note
// on why the order is load-bearing. Word-boundary anchored with an optional
// trailing "s" so "avocado" matches "avocados" without also matching "avocadoes
// something else entirely"; \b on both ends keeps "ice" out of "juice".
const MATCHERS = Object.entries(LEXICON)
  .flatMap(([aisle, words]) => words.map((w) => ({ aisle, w })))
  .sort((a, b) => b.w.length - a.w.length)
  .map(({ aisle, w }) => ({
    aisle,
    re: new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`, "i"),
  }));

/**
 * Which aisle is this item in? Falls back to "other" — never guesses wildly.
 * Takes the raw item text; the quantity prefix is stripped first so "2x milk"
 * classifies the same as "milk".
 */
export function aisleOf(text) {
  const name = parseItem(text).name;
  if (!name) return "other";
  for (const m of MATCHERS) if (m.re.test(name)) return m.aisle;
  return "other";
}

/**
 * Store and section, stored the only place there is room for them: the text.
 *
 * `grocery_items` still has no column for either (see the header), so a store
 * is a trailing "@Costco" and a pinned section a trailing "#Freezer" — the same
 * trick "2x milk" already plays with quantity, and it inherits the same
 * property: nothing stored can be corrupted by a change here, because none of
 * this is stored as structure. Rename a store and every row re-reads.
 *
 * Tags run to the END of the string and a store name may contain spaces
 * ("@Whole Foods"), so the split is positional rather than word-based: the name
 * is everything before the first " @" or " #", and each tag runs to the next
 * one. Typing the tag yourself works exactly as well as picking it in the UI,
 * which is the point of choosing a syntax a person can type.
 *
 * A string that is ONLY a tag ("@costco") keeps its full text as the name. An
 * item called "@" is nonsense, but a row that silently loses its whole name is
 * worse than nonsense.
 */
function splitTags(raw) {
  const at = raw.search(/\s[@#]/);
  if (at < 0) return { base: raw, store: "", section: "" };
  const base = raw.slice(0, at).trim();
  if (!base) return { base: raw, store: "", section: "" };
  let store = "", section = "";
  // No leading \s in THIS pattern, unlike the search above. The value class
  // [^@#]+ is greedy and swallows the space that separates one tag from the
  // next, so requiring whitespace before the marker matched the first tag and
  // then went blind: "#freezer @whole foods" parsed the section and dropped the
  // store entirely. Everything from `at` onward is already known to be tag
  // territory, so the marker alone is enough to anchor on.
  for (const m of raw.slice(at).matchAll(/([@#])\s*([^@#]+)/g)) {
    const val = m[2].trim();
    if (!val) continue;
    if (m[1] === "@") store = val; else section = val;
  }
  return { base, store, section };
}

/**
 * Split a stored item string into { qty, name, store, section }.
 *
 * ONLY the explicit multiplier forms are recognised — "2x milk", "2 x milk",
 * "milk x2", "milk x 2". A bare leading number is deliberately NOT a quantity:
 * "2% milk", "1lb ground beef", "12 eggs" and "7up" all lead with a digit and
 * mean four different things, and guessing wrong renames the item on screen.
 * An unrecognised string comes back as { qty: 1, name: <the whole string> },
 * which is exactly how the list behaved before quantities existed.
 *
 * `name` is Title Cased here, which is what makes the rule apply to every row
 * already in the table rather than only to what gets typed from now on.
 */
export function parseItem(text) {
  const whole = String(text ?? "").trim();
  if (!whole) return { qty: 1, name: "", store: "", section: "" };
  const { base: raw, store, section } = splitTags(whole);
  const tags = { store: titleCase(store), section: titleCase(section) };
  const lead = raw.match(/^(\d{1,3})\s*[x×]\s+(.*)$/i) || raw.match(/^(\d{1,3})[x×]\s*(.+)$/i);
  if (lead) {
    const qty = parseInt(lead[1], 10);
    const name = lead[2].trim();
    if (qty >= 1 && name) return { qty, name: titleCase(name), ...tags };
  }
  const trail = raw.match(/^(.*?)\s+[x×]\s*(\d{1,3})$/i);
  if (trail) {
    const qty = parseInt(trail[2], 10);
    const name = trail[1].trim();
    if (qty >= 1 && name) return { qty, name: titleCase(name), ...tags };
  }
  return { qty: 1, name: titleCase(raw), ...tags };
}

/**
 * { qty, name, store, section } → the string we store. Inverse of parseItem for
 * qty ≥ 1. The third argument is optional so the older two-argument calls (the
 * quantity stepper) keep meaning exactly what they meant.
 */
export function formatItem(qty, name, tags) {
  const n = titleCase(String(name ?? "").trim());
  const q = Number.isFinite(qty) ? Math.max(1, Math.round(qty)) : 1;
  const store = titleCase(String(tags?.store ?? "").trim());
  const section = titleCase(String(tags?.section ?? "").trim());
  let out = q > 1 ? `${q}x ${n}` : n;
  if (section) out += ` #${section}`;
  if (store) out += ` @${store}`;
  return out;
}

/**
 * The key two items must share to count as "the same thing".
 * Case- and quantity-insensitive, and singular/plural-insensitive so adding
 * "egg" to a list that already has "Eggs" bumps the count instead of opening a
 * second line three aisles away.
 *
 * The STORE is part of the key, because milk at Costco and milk at the corner
 * shop are two errands, not one item bought twice. Merging them would silently
 * drop one of the two stops. The section deliberately is NOT part of the key —
 * it's a display preference, and two rows that differ only by which heading
 * they sit under are the duplicate this function exists to prevent.
 */
export function canonicalName(text) {
  const { name, store } = parseItem(text);
  const n = name.toLowerCase().replace(/\s+/g, " ").replace(/[.,;!]+$/, "").trim();
  const stem = n.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
  return store ? `${stem}@${store.toLowerCase()}` : stem;
}

/**
 * Is this new text already on the list? Returns the existing row, or null.
 * The caller bumps that row's quantity rather than inserting — the duplicate
 * line is the single most annoying thing a shared shopping list does.
 */
export function findDuplicate(items, text) {
  const key = canonicalName(text);
  if (!key) return null;
  return (items || []).find((it) => canonicalName(it.item) === key) || null;
}

// ─── The add, decided once ────────────────────────────────────────────────────
// An optimistic add has to put something on screen before the server has given
// it an id, so it invents one. The prefix is what keeps that visible: a
// temporary id is a uuid column's worth of nothing, and any request built around
// one — PATCH /grocery_items?id=eq.tmp-1785391991627 — comes back 400.
export const TMP_PREFIX = "tmp-";
export const isTempId = (id) => typeof id === "string" && id.startsWith(TMP_PREFIX);

/**
 * What an add MEANS: merge into a row already on the list, or insert a new one.
 *
 * THE MOMENT THIS IS CALLED IS THE WHOLE POINT. It must see the list as it stands
 * *before* anything optimistic has been written to it.
 *
 * The first version of the optimistic list decided this inside react-query's
 * mutation function, which runs AFTER onMutate. So the duplicate lookup saw the
 * row onMutate had just invented, matched the new item against itself, and
 * issued a merge against a temporary id. Every add — duplicate or not — became
 * `PATCH ?id=eq.tmp-…` → 400 → rollback, and the list silently refused every
 * item for four days. Nothing threw, nothing logged, the row just faded out.
 *
 * Returning a plan is what makes that unrepeatable. One decision, taken once,
 * from one snapshot; the optimistic patch (applyAdd) and the request
 * (requestFor) are both derived from it, so they cannot disagree and neither
 * needs to read the list again.
 *
 * @param items  the list BEFORE this add
 * @param text   whatever was typed
 * @param tmpId  id to carry the optimistic row until the insert answers
 * @returns {null|{kind:"insert"|"merge", id:string, item:string, typed:string}}
 */
export function planAdd(items, text, tmpId = `${TMP_PREFIX}0`) {
  const typed = String(text ?? "").trim();
  if (!typed) return null;
  const dup = findDuplicate(items, typed);
  // A duplicate whose own insert hasn't landed yet has no server row to merge
  // into, so it gets an insert instead. Two lines both saying milk is a cosmetic
  // annoyance the stepper fixes in one tap; a request against a temporary id is
  // an item that never saves.
  if (dup && !isTempId(dup.id)) {
    // Re-format from the EXISTING row, not the typed text: a bump must not
    // silently strip the store or the pinned section off a row that already had
    // them ("2x Milk @Costco" + "milk" is three milks at Costco, not three
    // milks nowhere).
    const { qty, name, store, section } = parseItem(dup.item);
    return { kind: "merge", id: dup.id, item: formatItem(qty + parseItem(typed).qty, name, { store, section }), typed };
  }
  // Normalised on the way in, so what lands in the table is already Title Cased
  // with its tags in canonical order — the row you see is the row that is stored.
  const p = parseItem(typed);
  return { kind: "insert", id: tmpId, item: formatItem(p.qty, p.name, p), typed };
}

/**
 * The plan applied to the list — the optimistic half of the same decision.
 * `at` is passed in rather than read off the clock so this stays pure.
 */
export function applyAdd(items, plan, at) {
  const list = items || [];
  if (!plan) return list;
  if (plan.kind === "merge") {
    return list.map((it) => (it.id === plan.id ? { ...it, item: plan.item, checked: false } : it));
  }
  return [...list, { id: plan.id, item: plan.item, checked: false, created_at: at }];
}

/**
 * The plan as the request to send — the other half. Split out from the mutation
 * function so the id that goes over the wire is inspectable by a test that runs
 * without React, which is the one thing the old code had no way to check.
 */
export function requestFor(plan) {
  if (!plan) return null;
  return plan.kind === "merge"
    ? { op: "update", id: plan.id, patch: { item: plan.item, checked: false } }
    : { op: "insert", item: plan.item };
}

/**
 * Every store on the list, plus any you've named but not shopped yet.
 *
 * Derived from the items first (so a store can never go missing while it still
 * has something in it) and unioned with the saved list (so a store you just
 * created survives having nothing in it yet). Compared case-insensitively but
 * displayed as written — "costco" and "Costco" are one store.
 */
export function storesOf(items, saved) {
  const seen = new Map();
  for (const name of [...(saved || []), ...(items || []).map((it) => parseItem(it.item).store)]) {
    const label = titleCase(String(name ?? "").trim());
    if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Does this item belong to the store being shopped? "" means every store.
 *
 * An item with NO store belongs to all of them. Bread is bread — you'll buy it
 * wherever you end up, and a staple that hid itself the moment you picked a
 * shop is a bug you'd only discover at the till.
 */
export const inStore = (item, store) => {
  if (!store) return true;
  const s = parseItem(item).store;
  return !s || s.toLowerCase() === String(store).toLowerCase();
};

/**
 * Renaming or removing a store, planned as one operation.
 *
 * The store lives IN THE TEXT, so renaming one isn't a settings edit — it is a
 * rewrite of every item tagged with it. That has a consequence worth being
 * deliberate about: the rewrite can land a row on top of one that already
 * exists. Rename "HEB" to "Costco" while both shops have milk on the list and
 * you get two rows that both say Milk at Costco — precisely the duplicate the
 * whole add path exists to prevent, arriving through the back door.
 *
 * So this MERGES rather than colliding: quantities add up, the redundant row is
 * deleted, and the surviving row is the one that was already at the
 * destination. Removing a store is the same operation with an empty
 * destination — the items lose their tag and stay on the list, because deleting
 * someone's groceries to tidy up a label would be indefensible.
 *
 * Checked state is part of the merge key. An item you've already put in the
 * trolley must not be absorbed into one you haven't; they're the same words but
 * not the same fact.
 *
 * Pure, and returns a plan rather than performing it — same shape and the same
 * reason as planAdd: the optimistic write and the requests are both derived
 * from ONE decision, so they cannot disagree.
 *
 * @returns {{updates: Array<{id, item}>, deletes: string[]}}
 */
export function planRetag(items, from, to) {
  const list = items || [];
  const f = titleCase(String(from ?? "").trim()).toLowerCase();
  if (!f) return { updates: [], deletes: [] };
  const dest = titleCase(String(to ?? "").trim());
  const keyFor = (name, store, checked) => `${canonicalName(formatItem(1, name, { store }))}|${checked ? 1 : 0}`;

  const entries = new Map();
  const moving = [];
  for (const it of list) {
    const p = parseItem(it.item);
    if (p.store.toLowerCase() === f) { moving.push({ it, p }); continue; }
    const k = keyFor(p.name, p.store, it.checked);
    if (!entries.has(k)) entries.set(k, { id: it.id, orig: it.item, ...p, checked: it.checked, touched: false });
  }
  if (!moving.length) return { updates: [], deletes: [] };

  const deletes = [];
  for (const { it, p } of moving) {
    const k = keyFor(p.name, dest, it.checked);
    const hit = entries.get(k);
    if (hit) { hit.qty += p.qty; hit.touched = true; deletes.push(it.id); }
    else entries.set(k, { id: it.id, orig: it.item, ...p, store: dest, checked: it.checked, touched: true });
  }

  // Strings are emitted only after every merge has landed, so a row that
  // absorbed two others carries the full count rather than the first one.
  const updates = [];
  for (const e of entries.values()) {
    if (!e.touched) continue;
    const item = formatItem(e.qty, e.name, { store: e.store, section: e.section });
    if (item !== e.orig) updates.push({ id: e.id, item });
  }
  return { updates, deletes };
}

/** The retag plan applied to a list — the optimistic half of the same decision. */
export function applyRetag(items, plan) {
  const gone = new Set(plan?.deletes || []);
  const patch = new Map((plan?.updates || []).map((u) => [u.id, u.item]));
  return (items || []).filter((it) => !gone.has(it.id))
    .map((it) => (patch.has(it.id) ? { ...it, item: patch.get(it.id) } : it));
}

/**
 * The manual order, applied. Ids the saved order has never seen keep their
 * default position rather than jumping to an end — same rule, and the same
 * reasoning, as the Brief's card order (see lib/brief-order.js).
 */
export function applyOrder(list, orderIds) {
  const rank = new Map();
  (Array.isArray(orderIds) ? orderIds : []).forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  if (!rank.size) return list;
  const known = list.filter((it) => rank.has(it.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const out = known.slice();
  list.forEach((it, defaultIdx) => {
    if (rank.has(it.id)) return;
    out.splice(Math.min(defaultIdx, out.length), 0, it);
  });
  return out;
}

/**
 * The whole list, arranged for shopping.
 *
 * Returns ordered sections of what's still to get, the cart (checked items) as
 * one bucket at the bottom, and the counts the header reads from.
 *
 * THREE ORGANISING RULES, in priority order, because they answer different
 * questions and only one of them can win at a time:
 *
 *   1. STORE filters. You are standing in one shop; the others are noise. An
 *      item with no store belongs to every shop (bread is bread), so it shows
 *      under every filter rather than only under "All" — a staple that hid
 *      itself the moment you picked a store would be a bug you'd discover at
 *      the till.
 *   2. A PINNED SECTION ("#Freezer") beats the guessed aisle, and pinned
 *      sections sort to the top. You named it, so you meant it; the lexicon is
 *      only there for everything you didn't.
 *   3. Otherwise the AISLE, in walk order — the original feature, untouched.
 *
 * Within a section the manual drag order wins, falling back to insertion order.
 * Sorting alphabetically on top of that would reshuffle the list under your
 * thumb every time you added something.
 *
 * `opts` is optional so every existing two-argument-free caller keeps working.
 */
export function groupList(items, opts) {
  const store = opts?.store || "";
  const order = opts?.order;
  const all = (items || []).filter((it) => inStore(it.item, store));
  const cart = applyOrder(all.filter((it) => it.checked), order);
  const todo = all.filter((it) => !it.checked);

  const pinned = new Map();   // label → items, for "#Freezer" style overrides
  const byAisle = new Map();
  for (const it of todo) {
    const { section } = parseItem(it.item);
    if (section) {
      if (!pinned.has(section)) pinned.set(section, []);
      pinned.get(section).push(it);
    } else {
      const key = aisleOf(it.item);
      if (!byAisle.has(key)) byAisle.set(key, []);
      byAisle.get(key).push(it);
    }
  }
  const sections = [
    ...[...pinned.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, list]) => ({ key: `pin:${label}`, label, tone: "var(--accent)", pinned: true, items: list })),
    ...AISLES.filter((a) => byAisle.has(a.key)).map((a) => ({ ...a, items: byAisle.get(a.key) })),
  ].map((s) => ({ ...s, items: applyOrder(s.items, order) }));

  return { sections, cart, remaining: todo.length, total: all.length };
}

/**
 * Frequent items, learned from what you actually clear.
 *
 * A tally of canonical names, kept in app_settings (so it follows the account
 * across devices) and incremented when a checked item is cleared — i.e. when you
 * actually bought it, not merely when you typed it. Suggestions exclude whatever
 * is already on the list, because offering to add milk to a list that has milk
 * on it is noise.
 */
export const STAPLES_KEY = "grocery_frequency";
export const STAPLE_MIN_BUYS = 2; // twice is a pattern; once is a Tuesday

export function bumpFrequency(tally, items) {
  const next = { ...(tally || {}) };
  for (const it of items || []) {
    const key = canonicalName(it.item);
    if (!key) continue;
    const prev = next[key];
    next[key] = {
      // Keep the nicest label we've seen rather than the canonical stem, so the
      // chip reads "Greek yogurt", not "greek yogurt" or "greek yogurt"-minus-s.
      label: prev?.label || parseItem(it.item).name,
      buys: (prev?.buys || 0) + 1,
    };
  }
  return next;
}

export function frequentSuggestions(tally, items, limit = 6) {
  const onList = new Set((items || []).map((it) => canonicalName(it.item)));
  return Object.entries(tally || {})
    .filter(([key, v]) => v?.buys >= STAPLE_MIN_BUYS && !onList.has(key))
    .sort((a, b) => (b[1].buys - a[1].buys) || a[1].label.localeCompare(b[1].label))
    .slice(0, limit)
    .map(([key, v]) => ({ key, label: v.label, buys: v.buys }));
}
