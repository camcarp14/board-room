// ─── Finances — the money, made legible ──────────────────────────────────────
// Pure, like groceryLogic and the rest, and for a sharper reason than usual:
// every failure mode here is a NUMBER THAT LOOKS FINE. A misparsed sign turns a
// refund into a purchase, a dropped quote turns "STARBUCKS #123, CHICAGO" into
// two columns, a bad dedupe key either doubles your March or quietly swallows
// the second coffee you actually bought. None of that throws. You'd just believe
// a wrong total. Asserted end to end by scripts/finance-smoke.mjs.
//
// TWO DECISIONS THAT SHAPE EVERYTHING BELOW.
//
// MONEY IS INTEGER CENTS. Never floats. 0.1 + 0.2 is not 0.3, and a budgeting
// tool that is off by a cent per row is a budgeting tool nobody trusts by March.
// Parsing goes straight from the string to cents, and only the formatter ever
// divides.
//
// NEGATIVE IS MONEY LEAVING. Chase exports both cards and checking with that
// convention already, so it's theirs, not an invention — a purchase is -45.67 on
// a card and a debit is -100.00 on checking. What that buys is that the two file
// formats normalise into one shape and every total downstream is a plain sum.

// ─── Categories ──────────────────────────────────────────────────────────────
// Deliberately few. Twenty categories is a taxonomy you have to maintain and
// then argue with; a dozen is a shape you can see at a glance, which is the
// entire point of the breakdown. `spend: false` is the crucial flag — see
// TRANSFERS below.
export const CATEGORIES = [
  { key: "groceries", label: "Groceries", tone: "var(--green)" },
  { key: "dining", label: "Dining & Coffee", tone: "var(--amber)" },
  { key: "transport", label: "Transport", tone: "var(--blue)" },
  { key: "shopping", label: "Shopping", tone: "var(--purple)" },
  { key: "bills", label: "Bills & Utilities", tone: "var(--red)" },
  { key: "housing", label: "Housing", tone: "var(--red)" },
  { key: "health", label: "Health", tone: "var(--green)" },
  { key: "entertainment", label: "Entertainment", tone: "var(--pink)" },
  { key: "travel", label: "Travel", tone: "var(--blue)" },
  { key: "fees", label: "Fees & Interest", tone: "var(--red)" },
  { key: "other", label: "Other", tone: "var(--faint)" },
  // Not spending. Money you were paid.
  { key: "income", label: "Income", tone: "var(--green)", income: true, spend: false },
  // THE ONE THAT KEEPS THE TOTALS HONEST. Paying your credit card off is not an
  // expense — the expense was the purchase, weeks earlier, and it is already in
  // this list. Import the card AND the checking account (which you should, or
  // you can't see rent) and every payment appears twice: positive on the card,
  // negative on checking. Counting either one inflates your month by however
  // much you paid off. So transfers are their own category, shown, never summed
  // into spend. This is the single most common way a home-made budget lies.
  { key: "transfer", label: "Transfers & Payments", tone: "var(--sub)", spend: false },
];

const BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
export const catMeta = (key) => BY_KEY[key] || BY_KEY.other;
/** Categories that count as money spent — everything except income and transfers. */
export const SPEND_CATEGORIES = CATEGORIES.filter((c) => c.spend !== false);
export const isSpendCategory = (key) => catMeta(key).spend !== false;

// ─── CSV ─────────────────────────────────────────────────────────────────────

/**
 * A real CSV parser, because merchant names contain commas.
 *
 * "STARBUCKS #123, CHICAGO IL" is one field, and a split(",") turns it into two
 * — shifting every column after it, so the amount column becomes the state
 * abbreviation and the row silently imports as $0. Quoted fields, escaped
 * quotes ("" inside a quoted field), CRLF (which is what Chase actually emits)
 * and a trailing newline all have to work.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }   // "" is a literal quote
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;                          // CRLF — Chase emits it
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  // A file with no trailing newline still has a last row.
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => String(f).trim() !== ""));
}

/**
 * Money → integer cents, from whatever the bank wrote.
 *
 * Handles "$1,234.56", "(45.67)" (accounting negatives), a leading "+", and a
 * bare "-". Returns null for anything it can't read, which callers treat as a
 * row to skip rather than a zero to add — a $0 row in a ledger is a lie that
 * balances.
 *
 * Rounding is on the STRING, via Math.round on a scaled float, and that is safe
 * here in a way general float arithmetic is not: one multiply of a two-decimal
 * value, then round. It is the conversion that matters; nothing after this ever
 * touches a float.
 */
export function toCents(v) {
  let t = String(v ?? "").trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[$\s,]/g, "");
  if (t.startsWith("+")) t = t.slice(1);
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const cents = Math.round(parseFloat(t) * 100);
  return neg ? -cents : cents;
}

/** Cents → "$1,234.56". `signed` prints a leading + for money coming in. */
export function money(cents, { signed = false, centsShown = true } = {}) {
  const n = Number.isFinite(cents) ? cents : 0;
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = centsShown ? `$${grouped}.${frac}` : `$${grouped}`;
  if (neg) return `−${body}`;              // U+2212, not a hyphen: it aligns
  return signed ? `+${body}` : body;
}

/** "08/01/2026" or "2026-08-01" → "2026-08-01". Null if it isn't a date. */
export function toISO(v) {
  const t = String(v ?? "").trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yr}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export const monthOf = (iso) => String(iso ?? "").slice(0, 7);
export function monthLabel(ym) {
  const [y, m] = String(ym ?? "").split("-").map(Number);
  if (!y || !m) return "";
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

// ─── The two Chase formats ───────────────────────────────────────────────────
// Detected by header, not by asking you which file you're holding — you exported
// it from the same site five seconds ago and shouldn't have to know Chase's
// internal naming. A card export leads "Transaction Date,Post Date,Description";
// a checking export leads "Details,Posting Date,Description".
const FORMATS = [
  {
    key: "card",
    label: "Chase credit card",
    has: ["transaction date", "description", "amount"],
    map: (r) => ({ date: r["transaction date"], desc: r.description, amount: r.amount, chaseCat: r.category, type: r.type }),
  },
  {
    key: "bank",
    label: "Chase checking or savings",
    has: ["posting date", "description", "amount"],
    map: (r) => ({ date: r["posting date"], desc: r.description, amount: r.amount, chaseCat: "", type: r.type || r.details }),
  },
];

export function detectFormat(headerRow) {
  const cols = (headerRow || []).map((h) => String(h).trim().toLowerCase());
  return FORMATS.find((f) => f.has.every((h) => cols.includes(h))) || null;
}

// ─── Merchant names ──────────────────────────────────────────────────────────
/**
 * The human name inside a bank string.
 *
 * "SQ *BLUE BOTTLE COFFEE 0123 CHICAGO IL 08/01" is one merchant seen five
 * different ways across five months, and everything interesting here — is this
 * recurring, what do I actually spend at, are these two rows the same shop —
 * depends on collapsing them to the same key. Processor prefixes, store numbers,
 * trailing city/state and embedded dates all go; what's left is the name.
 *
 * Kept conservative on purpose. Over-trimming merges two real merchants into one
 * and there is no way to notice from a chart.
 */
export function merchantOf(description) {
  let t = String(description ?? "").trim();
  if (!t) return "";
  t = t.replace(/^(sq|tst|sp|py|pp|ec|iat|ach|pos|dbt crd|debit card purchase|recurring card purchase|card purchase)\s*[*\-–]?\s*/i, "");
  t = t.replace(/\b\d{2}\/\d{2}(\/\d{2,4})?\b/g, " ");        // embedded dates
  t = t.replace(/\b\d{6,}\b/g, " ");                           // long reference numbers
  t = t.replace(/\s+#?\d{1,5}\b/g, " ");                       // store numbers
  t = t.replace(/[*#]+/g, " ").replace(/\s{2,}/g, " ").trim();
  // Trailing location. Chase writes "<MERCHANT> <CITY> <STATE>", so stripping
  // only the state leaves the city behind and the SAME shop forks into two keys
  // the moment one row carries a city and another doesn't — which quietly breaks
  // subscription detection and every "what do I spend here" total.
  //
  // City and state come off as a PAIR, guarded by what's left: only if at least
  // two tokens remain. Without that guard "TRADER JOES IL" loses "JOES" and
  // becomes "TRADER", and over-trimming is the worse failure — it merges two
  // real merchants into one and there is no way to see that on a chart.
  const pair = t.match(/^(.*?)\s+[A-Za-z][A-Za-z.'-]*\s+[A-Z]{2}$/);
  if (pair && pair[1].trim().split(/\s+/).length >= 2) t = pair[1];
  else t = t.replace(/\s+[A-Z]{2}$/, "");
  // Punctuation stranded by the trimming above. "TRADER JOE'S #702, CHICAGO IL"
  // loses the store number and then the city, and what's left is "TRADER JOE'S ,"
  // — which is only a display problem (merchantKey strips punctuation anyway)
  // and looks exactly like a bug in every list it appears in.
  t = t.replace(/\s+([,;:])/g, "$1").replace(/[,;:.\-–\s]+$/, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t || String(description).trim();
}

/** The key two rows must share to be "the same merchant". */
export const merchantKey = (description) =>
  merchantOf(description).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// ─── Categorising ────────────────────────────────────────────────────────────
// Chase already labels card transactions, so those are used as given (mapped
// onto our smaller set) — their data is better than any guess made from the
// string. Checking exports carry NO category at all, which is exactly where rent,
// utilities, payroll and transfers live, so those fall to the lexicon.
const CHASE_MAP = {
  "gas": "transport", "automotive": "transport", "travel": "travel",
  "groceries": "groceries", "food & drink": "dining", "restaurants": "dining",
  "shopping": "shopping", "personal": "shopping", "home": "housing",
  "bills & utilities": "bills", "health & wellness": "health", "education": "other",
  "entertainment": "entertainment", "gifts & donations": "other",
  "fees & adjustments": "fees", "professional services": "other",
  "payment": "transfer", "credit card payment": "transfer",
};

// Longest phrase first, same reasoning as the grocery lexicon: "whole foods" is
// groceries and "foods" alone is nothing; "chase credit crd autopay" is a
// transfer and "chase" alone is not enough to say.
const LEXICON = {
  transfer: ["payment thank you", "autopay", "auto pay", "credit crd", "card payment", "online transfer", "transfer to", "transfer from", "zelle", "venmo", "cash app", "paypal transfer", "atm withdrawal", "withdrawal"],
  income: ["payroll", "direct dep", "direct deposit", "salary", "dividend", "interest payment", "refund", "reimbursement", "tax refund"],
  housing: ["rent", "mortgage", "hoa", "property mgmt", "apartment", "landlord", "leasing"],
  bills: ["comed", "peoples gas", "electric", "water bill", "internet", "comcast", "xfinity", "at&t", "verizon", "t-mobile", "spectrum", "utility", "insurance", "geico", "state farm", "progressive"],
  groceries: ["whole foods", "trader joe", "jewel osco", "jewel-osco", "mariano", "costco", "aldi", "safeway", "kroger", "target", "walmart", "grocery", "fresh market", "sprouts"],
  dining: ["starbucks", "dunkin", "blue bottle", "chipotle", "sweetgreen", "mcdonald", "restaurant", "coffee", "cafe", "pizza", "sushi", "doordash", "uber eats", "grubhub", "seamless", "bar & grill", "brewing", "tavern"],
  transport: ["uber", "lyft", "shell", "bp ", "exxon", "mobil", "chevron", "citgo", "marathon", "parking", "cta ", "metra", "divvy", "toll", "gas station"],
  shopping: ["amazon", "amzn", "best buy", "apple store", "nike", "lululemon", "rei", "home depot", "lowes", "ikea", "etsy", "ebay", "nordstrom", "zara", "uniqlo"],
  health: ["cvs", "walgreens", "pharmacy", "dental", "dentist", "clinic", "hospital", "medical", "gym", "fitness", "equinox", "planet fitness", "physical therapy"],
  entertainment: ["netflix", "spotify", "hulu", "disney", "hbo", "max ", "youtube premium", "steam", "playstation", "xbox", "cinema", "amc ", "regal", "ticketmaster", "concert"],
  travel: ["airline", "united air", "american air", "delta air", "southwest", "airbnb", "hotel", "marriott", "hilton", "hyatt", "expedia", "booking.com", "amtrak"],
  fees: ["service fee", "annual fee", "late fee", "overdraft", "interest charge", "atm fee", "foreign transaction"],
};

const MATCHERS = Object.entries(LEXICON)
  .flatMap(([cat, words]) => words.map((w) => ({ cat, w: w.trim() })))
  .sort((a, b) => b.w.length - a.w.length);

/**
 * What is this transaction?
 *
 * Priority, and the order is load-bearing:
 *   1. YOUR override. You recategorised it; nothing gets to argue.
 *   2. Chase's own label, when the export has one.
 *   3. The lexicon, on the merchant name.
 *   4. Sign — an unrecognised deposit is income, an unrecognised debit is other.
 *      Better than filing every paycheque under "Other" and showing a month
 *      where you apparently earned nothing.
 */
export function categorise(tx, overrides) {
  const ov = overrides?.[merchantKey(tx.description)];
  if (ov && BY_KEY[ov]) return ov;
  const chase = CHASE_MAP[String(tx.chaseCat ?? "").trim().toLowerCase()];
  if (chase) return chase;
  const hay = ` ${merchantOf(tx.description).toLowerCase()} `;
  for (const m of MATCHERS) if (hay.includes(m.w)) return m.cat;
  return (tx.amount ?? 0) > 0 ? "income" : "other";
}

// ─── Import ──────────────────────────────────────────────────────────────────

/**
 * The dedupe key.
 *
 * Chase's CSV carries no transaction id, so one has to be derived — and this is
 * the decision that makes re-importing safe. Export August, export
 * July-through-August next month, and the overlap must not double.
 *
 * The trap: two identical $4.75 coffees on the same day at the same shop are two
 * real transactions, and a pure hash of (date, amount, merchant) collapses them
 * into one — silently losing money from the total. So the key carries an
 * OCCURRENCE INDEX within the batch. Import the same rows again and the same
 * indices come out, so it still dedupes; import a genuine second coffee and it
 * gets index 1 and survives.
 */
export function txKey(tx, occurrence = 0) {
  return [tx.account || "", tx.date, tx.amount, merchantKey(tx.description), occurrence].join("|");
}

/**
 * A Chase CSV → rows ready to store, plus everything that went wrong.
 *
 * Returns problems rather than throwing them. A 400-row export with three
 * unparseable lines should import 397 and TELL you about the three; refusing the
 * file outright over a blank row at the end is how a tool gets abandoned.
 */
export function parseChaseCsv(text, { account = "", overrides } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], format: null, skipped: [], error: "That file is empty." };
  const format = detectFormat(rows[0]);
  if (!format) {
    return {
      rows: [], format: null, skipped: [],
      error: "That doesn't look like a Chase export. Expected a header row with Transaction Date (card) or Posting Date (checking).",
    };
  }
  const cols = rows[0].map((h) => String(h).trim().toLowerCase());
  const seen = new Map();
  const out = [], skipped = [];

  for (let i = 1; i < rows.length; i++) {
    const r = Object.fromEntries(cols.map((c, j) => [c, rows[i][j] ?? ""]));
    const m = format.map(r);
    const date = toISO(m.date);
    const amount = toCents(m.amount);
    const description = String(m.desc ?? "").trim();
    if (!date || amount === null || !description) {
      skipped.push({ line: i + 1, reason: !date ? "no date" : amount === null ? "no amount" : "no description", raw: rows[i].join(",").slice(0, 80) });
      continue;
    }
    const base = { account, date, amount, description, chaseCat: m.chaseCat, merchant: merchantOf(description) };
    // Occurrence index — see txKey. Counted per identical (date, amount,
    // merchant) triple so a genuine repeat survives and a re-import doesn't.
    const dupKey = txKey(base, 0);
    const n = seen.get(dupKey) || 0;
    seen.set(dupKey, n + 1);
    out.push({ ...base, id: txKey(base, n), category: categorise(base, overrides) });
  }
  return { rows: out, format, skipped, error: null };
}

// ─── Plaid ───────────────────────────────────────────────────────────────────

/**
 * A Plaid transaction → the same row shape a CSV import produces.
 *
 * TWO THINGS THAT ARE OPPOSITE TO THE CSV PATH, and both are silent:
 *
 * 1. THE SIGN IS INVERTED. Plaid documents `amount` as POSITIVE when money
 *    moves OUT of the account — the exact opposite of every Chase export, where
 *    a purchase is negative. Pass it through unchanged and every purchase reads
 *    as income, every paycheque as spending, and the month is not merely wrong
 *    but backwards. It is negated here, once, at the boundary.
 *
 * 2. THE ID IS REAL. Plaid gives a stable `transaction_id`, so none of the
 *    derived-key machinery the CSV path needs applies. It is prefixed so a
 *    synced row can never collide with an imported one — the same coffee coming
 *    down both paths is two rows, which is honest (you did import it twice) and
 *    fixable by forgetting one account, whereas a silent collision would leave
 *    one path unable to update its own row.
 *
 * Category comes from OUR lexicon, not Plaid's taxonomy: it is the same set the
 * CSV path uses, so a month assembled from both doesn't have two vocabularies in
 * one chart. Plaid's own label is passed to `categorise` as a hint in the same
 * slot Chase's occupies.
 */
export const PLAID_PREFIX = "plaid:";
export function fromPlaid(t, { account = "", overrides } = {}) {
  const id = String(t?.transaction_id || "").trim();
  const date = toISO(t?.date || t?.authorized_date);
  const cents = toCents(t?.amount);
  if (!id || !date || cents === null) return null;
  const description = String(t?.merchant_name || t?.name || "").trim();
  if (!description) return null;
  const base = {
    account,
    date,
    amount: -cents,                       // see (1) — Plaid's sign is inverted
    description,
    // personal_finance_category is the modern field; `category` is the legacy
    // array. Either is only a hint: categorise() still prefers your override.
    chaseCat: t?.personal_finance_category?.primary || (Array.isArray(t?.category) ? t.category[0] : "") || "",
    merchant: merchantOf(description),
  };
  return { ...base, id: PLAID_PREFIX + id, category: categorise(base, overrides) };
}

/** A Plaid /transactions/sync page → rows to upsert and ids to remove. */
export function fromPlaidSync(page, opts) {
  const added = [...(page?.added || []), ...(page?.modified || [])]
    .map((t) => fromPlaid(t, opts)).filter(Boolean);
  const removed = (page?.removed || []).map((r) => PLAID_PREFIX + String(r?.transaction_id || "")).filter((s) => s !== PLAID_PREFIX);
  return { rows: added, removed, cursor: page?.next_cursor || "", more: !!page?.has_more };
}

// ─── Balances ────────────────────────────────────────────────────────────────
// A month's spending answers "where did it go". These answer "where do I stand",
// which is the other half and the one you check most often. The numbers come
// from Plaid's /accounts/get — included with Transactions, no extra product —
// and are never stored: a stale balance is worse than no balance, so it is
// fetched when the tab opens and thrown away when it closes.

/**
 * What an account does to your net worth.
 *
 * THE SIGN IS THE WHOLE THING HERE, exactly as it is for transactions. Plaid
 * reports a credit card's `current` as a POSITIVE number meaning "you owe this",
 * and a checking account's as a positive number meaning "you have this". Adding
 * them up without knowing which is which produces a total that grows when you
 * borrow money.
 *
 * "other" is real, not a fallback for tidiness: Plaid types things this app has
 * no opinion about, and quietly filing an unknown type as an asset would inflate
 * the one number the card exists to state.
 */
const ACCOUNT_KIND = {
  depository: "asset", investment: "asset", brokerage: "asset",
  credit: "debt", loan: "debt",
};
export const accountKind = (a) => ACCOUNT_KIND[String(a?.type || "").toLowerCase()] || "other";

/** The balance as a number that can be added up: negative when it's owed. */
export function accountCents(a) {
  const c = a?.current_cents;
  if (!Number.isFinite(c)) return 0;
  return accountKind(a) === "debt" ? -c : c;
}

/**
 * Assets, debts, cash and the net.
 *
 * NOT Math.abs on the debts. An overpaid card has a NEGATIVE current balance —
 * the bank owes you — and taking the magnitude would turn a $50 credit into $50
 * of debt. Keeping the sign makes that case come out right for free.
 *
 * `unknown` counts accounts Plaid returned with no balance at all. They are left
 * out of the sum rather than counted as zero, and the count is reported so the
 * card can say the total is partial instead of quietly understating it.
 */
export function netWorth(accounts = []) {
  let assets = 0, debts = 0, cash = 0, unknown = 0;
  for (const a of accounts || []) {
    const kind = accountKind(a);
    if (kind === "other") continue;
    if (!Number.isFinite(a?.current_cents)) { unknown++; continue; }
    if (kind === "debt") debts += a.current_cents;
    else {
      assets += a.current_cents;
      if (String(a.type).toLowerCase() === "depository") cash += a.current_cents;
    }
  }
  return { assets, debts, cash, unknown, net: assets - debts };
}

/** Accounts grouped under the bank they came from, assets before debts — the
 *  order you'd read them in, and the order that puts the money above the bills. */
export function groupAccounts(accounts = []) {
  const rank = (a) => (accountKind(a) === "asset" ? 0 : accountKind(a) === "debt" ? 1 : 2);
  const by = new Map();
  for (const a of accounts || []) {
    const k = String(a?.institution || "Bank");
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(a);
  }
  return [...by.entries()]
    .map(([institution, list]) => ({
      institution,
      accounts: [...list].sort((x, y) => rank(x) - rank(y) || String(x?.name || "").localeCompare(String(y?.name || ""))),
      net: netWorth(list).net,
    }))
    .sort((a, b) => b.net - a.net || a.institution.localeCompare(b.institution));
}

// ─── What a transaction's category actually IS ───────────────────────────────

/**
 * Precedence, decided in one place so nothing downstream can disagree.
 *
 *   1. category_override — you changed THIS row. Most specific, wins outright.
 *   2. A MERCHANT RULE — "Blue Bottle is always Dining". This is the one that
 *      makes the tool stop asking: a live sync brings the same merchants back
 *      every month, and without rules you'd recategorise the same coffee shop
 *      forever. Rules beat the imported category deliberately — the whole point
 *      is to override what the bank guessed.
 *   3. The category stored at import.
 *   4. The lexicon, for a row that somehow has none.
 *
 * Rules live in app_settings.finance_rules keyed by merchantKey, so they cost no
 * database write and apply RETROACTIVELY: set one and every past charge from
 * that merchant re-files itself, which is what makes fixing a category feel
 * worth doing rather than like filing.
 */
export function effectiveCategory(tx, rules) {
  if (tx?.category_override && catMeta(tx.category_override).key === tx.category_override) return tx.category_override;
  const r = rules?.[merchantKey(tx?.description)];
  if (r && catMeta(r).key === r) return r;
  return tx?.category || categorise(tx || {}, rules);
}

/** Set or clear a merchant rule. Clearing removes the key rather than storing a
 *  blank, so "no rule" and "a rule that happens to be empty" stay distinct. */
export function applyRule(rules, key, category) {
  const next = { ...(rules || {}) };
  if (category && catMeta(category).key === category) next[key] = category;
  else delete next[key];
  return next;
}

/** How many rows a rule would move — so the sheet can say "applies to 14
 *  charges" instead of asking you to take it on faith. */
export const ruleReach = (txs, key) =>
  (txs || []).filter((t) => merchantKey(t.description) === key).length;

// ─── Aggregation ─────────────────────────────────────────────────────────────

/** Every month present in the data, newest first — the month picker's options. */
export function monthsOf(txs) {
  const set = new Set((txs || []).map((t) => monthOf(t.date)).filter(Boolean));
  return [...set].sort().reverse();
}

/**
 * One month, totalled.
 *
 * `spent` counts only spend categories (see the note on CATEGORIES.transfer) and
 * only money going OUT, so a refund reduces the category it came from rather
 * than counting as income — which is what you mean when you ask what dinner cost
 * you in March.
 */
export function summarise(txs, month, overrides) {
  const rows = (txs || []).filter((t) => !month || monthOf(t.date) === month)
    .map((t) => ({ ...t, category: effectiveCategory(t, overrides) }));
  let income = 0, spent = 0, transfers = 0;
  const byCat = new Map();
  for (const t of rows) {
    const meta = catMeta(t.category);
    if (meta.income) { income += t.amount; continue; }
    if (meta.spend === false) { transfers += Math.abs(t.amount); continue; }
    spent += -t.amount;                       // amount is negative for spend
    byCat.set(t.category, (byCat.get(t.category) || 0) + -t.amount);
  }
  const categories = [...byCat.entries()]
    .map(([key, cents]) => ({ key, ...catMeta(key), cents, pct: spent > 0 ? Math.round((cents / spent) * 100) : 0 }))
    .sort((a, b) => b.cents - a.cents);
  return { month, rows, income, spent, transfers, net: income - spent, categories, count: rows.length };
}

/** Month-over-month, per category and overall. Positive delta = spent more. */
export function compare(txs, month, prevMonth, overrides) {
  const now = summarise(txs, month, overrides);
  const was = summarise(txs, prevMonth, overrides);
  const wasBy = new Map(was.categories.map((c) => [c.key, c.cents]));
  return {
    now, was,
    spentDelta: now.spent - was.spent,
    categories: now.categories.map((c) => ({ ...c, prev: wasBy.get(c.key) || 0, delta: c.cents - (wasBy.get(c.key) || 0) })),
  };
}

/**
 * Budgets: what you set against what you spent.
 *
 * Categories with no budget are returned too, with `limit: null` — an unbudgeted
 * category that ate $600 is the most useful row on the screen and hiding it
 * until you've set a number is backwards.
 */
export function budgetStatus(summary, budgets) {
  const b = budgets || {};
  const rows = SPEND_CATEGORIES.map((c) => {
    const spent = summary.categories.find((x) => x.key === c.key)?.cents || 0;
    const limit = Number.isFinite(b[c.key]) && b[c.key] > 0 ? b[c.key] : null;
    return {
      ...c, spent, limit,
      pct: limit ? Math.min(999, Math.round((spent / limit) * 100)) : null,
      left: limit ? limit - spent : null,
      over: limit ? spent > limit : false,
    };
  }).filter((r) => r.spent > 0 || r.limit);
  const totalLimit = rows.reduce((n, r) => n + (r.limit || 0), 0);
  const budgetedSpend = rows.filter((r) => r.limit).reduce((n, r) => n + r.spent, 0);
  return { rows: rows.sort((a, b2) => b2.spent - a.spent), totalLimit, budgetedSpend, overCount: rows.filter((r) => r.over).length };
}

/**
 * Subscriptions, found rather than declared.
 *
 * A merchant charged in at least three DISTINCT months, at an amount that barely
 * moves, is a recurring bill whether or not you remember signing up for it — and
 * the whole value of this is the one you don't remember. Distinct months, not
 * "three charges", or a fortnightly coffee habit reads as a subscription.
 *
 * The amount tolerance is proportional, so a $9.99 streaming service and a
 * $1,800 rent are judged on the same terms.
 */
export function recurring(txs, { minMonths = 3, tolerance = 0.15, rules } = {}) {
  const by = new Map();
  for (const t of txs || []) {
    if (t.amount >= 0) continue;                       // money in isn't a subscription
    const k = merchantKey(t.description);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of by) {
    const months = new Set(list.map((t) => monthOf(t.date)));
    if (months.size < minMonths) continue;
    const amounts = list.map((t) => Math.abs(t.amount));
    const typical = amounts.slice().sort((a, b) => a - b)[Math.floor(amounts.length / 2)];
    if (!typical) continue;
    const steady = amounts.filter((a) => Math.abs(a - typical) <= typical * tolerance).length;
    if (steady / amounts.length < 0.6) continue;       // amount jumps around — not a subscription
    const last = list.slice().sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    out.push({
      key: k, merchant: merchantOf(last.description), typical, months: months.size,
      lastDate: last.date, category: effectiveCategory(last, rules),
      yearly: typical * 12,
    });
  }
  return out.sort((a, b) => b.typical - a.typical);
}

/** The biggest single hits of the month — the other question you always ask. */
// summary.rows already carry the resolved category (see summarise), so this
// must NOT re-resolve — reading category_override here would ignore a rule.
export const largest = (summary, n = 5) =>
  summary.rows.filter((t) => t.amount < 0 && isSpendCategory(t.category))
    .sort((a, b) => a.amount - b.amount).slice(0, n);

/**
 * The one-time setup, in the schema the CLIENT ACTUALLY READS.
 *
 * `boardroom`, not `public` — src/lib/supabase.js pins the client there, and a
 * table created in public is one this app can never see (that exact mistake
 * shipped once already, with the Dream boards). The grants are not optional
 * either: Supabase's defaults cover `public`, and RLS filters without granting.
 */
export const SETUP_SQL = `-- Board Room · Finances — one-time setup
-- Safe to run as many times as you like.
create schema if not exists boardroom;

create table if not exists boardroom.transactions (
  id                text not null,
  user_id           uuid not null references auth.users(id) on delete cascade,
  account           text not null default '',
  date              date not null,
  amount_cents      bigint not null,
  description       text not null default '',
  merchant          text not null default '',
  category          text not null default 'other',
  category_override text,
  created_at        timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists transactions_date_idx on boardroom.transactions (user_id, date desc);

alter table boardroom.transactions enable row level security;
drop policy if exists "transactions own rows" on boardroom.transactions;
create policy "transactions own rows" on boardroom.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- RLS filters; it does not grant. Without these the table is invisible to the
-- signed-in role no matter what the policy says.
grant usage on schema boardroom to anon, authenticated;
grant select, insert, update, delete on boardroom.transactions to authenticated;`;
