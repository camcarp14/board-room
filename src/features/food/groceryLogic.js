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
 * Split a stored item string into { qty, name }.
 *
 * ONLY the explicit multiplier forms are recognised — "2x milk", "2 x milk",
 * "milk x2", "milk x 2". A bare leading number is deliberately NOT a quantity:
 * "2% milk", "1lb ground beef", "12 eggs" and "7up" all lead with a digit and
 * mean four different things, and guessing wrong renames the item on screen.
 * An unrecognised string comes back as { qty: 1, name: <the whole string> },
 * which is exactly how the list behaved before quantities existed.
 */
export function parseItem(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { qty: 1, name: "" };
  const lead = raw.match(/^(\d{1,3})\s*[x×]\s+(.*)$/i) || raw.match(/^(\d{1,3})[x×]\s*(.+)$/i);
  if (lead) {
    const qty = parseInt(lead[1], 10);
    const name = lead[2].trim();
    if (qty >= 1 && name) return { qty, name };
  }
  const trail = raw.match(/^(.*?)\s+[x×]\s*(\d{1,3})$/i);
  if (trail) {
    const qty = parseInt(trail[2], 10);
    const name = trail[1].trim();
    if (qty >= 1 && name) return { qty, name };
  }
  return { qty: 1, name: raw };
}

/** { qty, name } → the string we store. Inverse of parseItem for qty ≥ 1. */
export function formatItem(qty, name) {
  const n = String(name ?? "").trim();
  const q = Number.isFinite(qty) ? Math.max(1, Math.round(qty)) : 1;
  return q > 1 ? `${q}x ${n}` : n;
}

/**
 * The key two items must share to count as "the same thing".
 * Case- and quantity-insensitive, and singular/plural-insensitive so adding
 * "egg" to a list that already has "Eggs" bumps the count instead of opening a
 * second line three aisles away.
 */
export function canonicalName(text) {
  const n = parseItem(text).name.toLowerCase().replace(/\s+/g, " ").replace(/[.,;!]+$/, "").trim();
  return n.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
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

/**
 * The whole list, arranged for shopping.
 *
 * Returns ordered aisle sections of what's still to get, the cart (checked
 * items) as one bucket at the bottom, and the counts the header reads from.
 * Within a section items keep the order they came in — the query sorts by
 * created_at, and re-sorting alphabetically on top of the aisle grouping would
 * make the list reshuffle under your thumb every time you add something.
 */
export function groupList(items) {
  const all = items || [];
  const cart = all.filter((it) => it.checked);
  const todo = all.filter((it) => !it.checked);
  const byAisle = new Map();
  for (const it of todo) {
    const key = aisleOf(it.item);
    if (!byAisle.has(key)) byAisle.set(key, []);
    byAisle.get(key).push(it);
  }
  const sections = AISLES
    .filter((a) => byAisle.has(a.key))
    .map((a) => ({ ...a, items: byAisle.get(a.key) }));
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
