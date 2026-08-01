// ─── Finance logic smoke — PLANTED problems, known answers ───────────────────
// src/features/finances/financeLogic.js is pure because every way it can be
// wrong is A NUMBER THAT LOOKS FINE:
//
//   · a merchant with a comma in it shifting every column, so the amount column
//     becomes " CHICAGO IL" and the row imports as $0
//   · a sign flip turning a refund into a purchase
//   · float cents drifting a penny per row
//   · a credit-card payment counted as spending, inflating the month by however
//     much you paid off
//   · a dedupe key that collapses two real identical coffees into one, or that
//     doubles your March when you re-import an overlapping export
//
// None of those throw. You would simply believe the wrong total, which is worse
// than a crash. Run by `npm run verify`.

import { readFileSync } from "node:fs";
import {
  CATEGORIES, SPEND_CATEGORIES, catMeta, isSpendCategory, SETUP_SQL,
  parseCsv, toCents, money, toISO, monthOf, monthLabel, detectFormat,
  merchantOf, merchantKey, categorise, txKey, parseChaseCsv,
  monthsOf, summarise, compare, budgetStatus, recurring, largest,
  fromPlaid, fromPlaidSync, PLAID_PREFIX,
  effectiveCategory, applyRule, ruleReach,
} from "../src/features/finances/financeLogic.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

// ─── 1. CSV: the comma inside the merchant ───────────────────────────────────
{
  const rows = parseCsv('a,b,c\n1,"STARBUCKS #123, CHICAGO IL",-4.75\n');
  check("a quoted comma stays one field", rows[1].length === 3, JSON.stringify(rows[1]));
  check("…and keeps its text", rows[1][1] === "STARBUCKS #123, CHICAGO IL", rows[1][1]);
  check("the amount column is still the amount", rows[1][2] === "-4.75", rows[1][2]);
}
check("CRLF is handled — it is what Chase actually emits",
  parseCsv("a,b\r\n1,2\r\n").length === 2);
check("a file with no trailing newline keeps its last row",
  parseCsv("a,b\n1,2").length === 2);
check('escaped quotes ("") survive', parseCsv('a\n"He said ""hi"""\n')[1][0] === 'He said "hi"');
check("blank lines are dropped, not imported as empty rows", parseCsv("a,b\n\n1,2\n\n").length === 2);
check("parseCsv tolerates empty and null", parseCsv("").length === 0 && parseCsv(null).length === 0);

// ─── 2. money is integer cents, always ───────────────────────────────────────
check("a plain amount", toCents("-45.67") === -4567, String(toCents("-45.67")));
check("dollar signs and thousands separators", toCents("$1,234.56") === 123456, String(toCents("$1,234.56")));
check("accounting negatives", toCents("(45.67)") === -4567, String(toCents("(45.67)")));
check("a leading plus", toCents("+100.00") === 10000);
check("whole dollars", toCents("50") === 5000);
// THE FLOAT TRAP. 0.1 + 0.2 !== 0.3; a budget tool that drifts a cent a row is
// not trusted by March. Everything is integers after this one conversion.
check("cents never drift", toCents("0.10") + toCents("0.20") === toCents("0.30"));
check("a hundred rows of 0.07 is exactly 7.00",
  Array.from({ length: 100 }, () => toCents("0.07")).reduce((a, b) => a + b, 0) === 700);
check("junk is null, not zero — a $0 row is a lie that balances",
  toCents("") === null && toCents("N/A") === null && toCents(null) === null && toCents("abc") === null);
check("money formats with separators", money(123456) === "$1,234.56", money(123456));
check("negatives use a real minus, which aligns", money(-4567).startsWith("−"), money(-4567));
check("signed money marks income", money(10000, { signed: true }) === "+$100.00");
check("zero is zero", money(0) === "$0.00");

// ─── 3. dates ────────────────────────────────────────────────────────────────
check("Chase's MM/DD/YYYY", toISO("08/01/2026") === "2026-08-01", toISO("08/01/2026"));
check("single-digit months and days pad", toISO("8/1/2026") === "2026-08-01", toISO("8/1/2026"));
check("two-digit years", toISO("08/01/26") === "2026-08-01");
check("an ISO date passes through", toISO("2026-08-01") === "2026-08-01");
check("a non-date is null", toISO("Posting Date") === null && toISO("") === null);
check("the month is the month", monthOf("2026-08-01") === "2026-08");
// Built with UTC on purpose: `new Date("2026-08-01")` is midnight UTC, and
// formatting that in a western timezone renders it as July.
check("a month label doesn't slip a timezone", monthLabel("2026-08") === "August 2026", monthLabel("2026-08"));

// ─── 4. both Chase formats, detected not asked ───────────────────────────────
const CARD_CSV = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
08/02/2026,08/03/2026,"TRADER JOE'S #702, CHICAGO IL",Groceries,Sale,-84.31,
08/03/2026,08/04/2026,SQ *BLUE BOTTLE COFFEE 0123,Food & Drink,Sale,-4.75,
08/03/2026,08/04/2026,SQ *BLUE BOTTLE COFFEE 0123,Food & Drink,Sale,-4.75,
08/05/2026,08/06/2026,NETFLIX.COM,Entertainment,Sale,-15.49,
08/09/2026,08/10/2026,AMZN Mktp US*2Z4KL,Shopping,Sale,-62.10,
08/12/2026,08/13/2026,Payment Thank You - Web,Payment,Payment,1200.00,
08/15/2026,08/16/2026,TRADER JOE'S #702,Groceries,Return,22.15,
`;
const BANK_CSV = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,08/01/2026,PROPERTY MGMT RENT AUG,-1800.00,ACH_DEBIT,4210.55,
CREDIT,08/01/2026,PENTAGON LLC PAYROLL DIRECT DEP,5400.00,ACH_CREDIT,6010.55,
DEBIT,08/12/2026,CHASE CREDIT CRD AUTOPAY,-1200.00,ACCT_XFER,4810.55,
DEBIT,08/04/2026,COMED UTILITY BILL,-96.42,ACH_DEBIT,4714.13,
`;
check("a card export is recognised", detectFormat(CARD_CSV.split("\n")[0].split(","))?.key === "card");
check("a checking export is recognised", detectFormat(BANK_CSV.split("\n")[0].split(","))?.key === "bank");
check("something else is refused rather than half-read", detectFormat(["a", "b", "c"]) === null);

const card = parseChaseCsv(CARD_CSV, { account: "Sapphire" });
const bank = parseChaseCsv(BANK_CSV, { account: "Checking" });
check("the card file parses every row", card.rows.length === 7 && !card.error, `${card.rows.length} ${card.error || ""}`);
check("the checking file parses every row", bank.rows.length === 4 && !bank.error, `${bank.rows.length} ${bank.error || ""}`);
check("the comma'd merchant kept its full amount",
  card.rows[0].amount === -8431, String(card.rows[0].amount));
check("a refund stays positive — it is money coming back",
  card.rows.find((r) => r.description.includes("#702") && r.amount > 0)?.amount === 2215);
check("a file that isn't a Chase export says so instead of importing nothing",
  /doesn't look like a Chase export/.test(parseChaseCsv("name,age\nbob,3\n").error || ""));
check("an empty file says so", /empty/.test(parseChaseCsv("").error || ""));
{
  const bad = parseChaseCsv(CARD_CSV + "08/20/2026,08/21/2026,,Groceries,Sale,,\n", { account: "S" });
  check("a broken row is skipped, not fatal — 7 good rows still import", bad.rows.length === 7);
  check("…and it is reported rather than swallowed", bad.skipped.length === 1 && bad.skipped[0].line === 9,
    JSON.stringify(bad.skipped));
}

// ─── 5. merchants ────────────────────────────────────────────────────────────
check("a processor prefix comes off", merchantOf("SQ *BLUE BOTTLE COFFEE 0123") === "BLUE BOTTLE COFFEE",
  merchantOf("SQ *BLUE BOTTLE COFFEE 0123"));
check("a store number comes off", merchantKey("TRADER JOE'S #702") === merchantKey("TRADER JOE'S #331"),
  `${merchantKey("TRADER JOE'S #702")} vs ${merchantKey("TRADER JOE'S #331")}`);
check("the same shop across months is one key",
  merchantKey("SQ *BLUE BOTTLE 0123 CHICAGO IL") === merchantKey("SQ *BLUE BOTTLE 0987"),
  `${merchantKey("SQ *BLUE BOTTLE 0123 CHICAGO IL")} vs ${merchantKey("SQ *BLUE BOTTLE 0987")}`);
// The other direction matters just as much: over-trimming merges two real
// merchants and there is no way to see that on a chart.
check("two different shops stay two", merchantKey("WHOLE FOODS") !== merchantKey("TRADER JOES"));
check("a name that is only noise still keeps something", merchantOf("#### 123456") !== "");
// Trimming a store number out of the middle strands the punctuation that was
// holding it: "TRADER JOE'S #702, CHICAGO IL" became "TRADER JOE'S ," on screen,
// which looks like a bug in every row it appears in.
check("no punctuation is left dangling",
  merchantOf("TRADER JOE'S #702, CHICAGO IL") === "TRADER JOE'S",
  merchantOf("TRADER JOE'S #702, CHICAGO IL"));
check("…and the apostrophe inside the name survives", merchantOf("TRADER JOE'S #702").includes("'"));
check("merchantOf tolerates nulls", merchantOf(null) === "" && merchantKey(undefined) === "");

// ─── 6. categories ───────────────────────────────────────────────────────────
check("Chase's own label is used when it has one",
  categorise({ description: "WEIRD UNKNOWN VENDOR", chaseCat: "Groceries", amount: -1000 }) === "groceries");
check("the lexicon covers a checking row, which has no label",
  categorise({ description: "PROPERTY MGMT RENT AUG", amount: -180000 }) === "housing");
check("longest phrase wins", categorise({ description: "CHASE CREDIT CRD AUTOPAY", amount: -120000 }) === "transfer");
check("payroll is income", categorise({ description: "PENTAGON LLC PAYROLL DIRECT DEP", amount: 540000 }) === "income");
// An unrecognised deposit filed under "Other" shows a month where you earned
// nothing, which is worse than a rough guess.
check("an unrecognised deposit is income, not Other",
  categorise({ description: "ZZZ MYSTERY DEPOSIT", amount: 50000 }) === "income");
check("an unrecognised debit is Other", categorise({ description: "ZZZ MYSTERY", amount: -50000 }) === "other");
check("your override beats everything",
  categorise({ description: "TRADER JOE'S #702", chaseCat: "Groceries", amount: -1000 },
    { [merchantKey("TRADER JOE'S #702")]: "dining" }) === "dining");
check("a nonsense override is ignored rather than shown as a blank category",
  categorise({ description: "X", chaseCat: "Groceries", amount: -1 }, { [merchantKey("X")]: "not_a_category" }) === "groceries");
check("every category has a label and a tone", CATEGORIES.every((c) => c.label && c.tone));
check("an unknown key degrades to Other", catMeta("nope").key === "other");
check("income and transfers are not spend",
  !isSpendCategory("income") && !isSpendCategory("transfer") && isSpendCategory("groceries"));
check("SPEND_CATEGORIES excludes exactly those two",
  SPEND_CATEGORIES.length === CATEGORIES.length - 2);

// ─── 7. THE DEDUPE KEY ───────────────────────────────────────────────────────
// Two identical coffees on one day are two transactions; re-importing an
// overlapping export is one. A key that gets either wrong loses or invents money.
{
  const coffees = card.rows.filter((r) => /BLUE BOTTLE/.test(r.description));
  check("two identical same-day charges both survive", coffees.length === 2, String(coffees.length));
  check("…with different ids", coffees[0].id !== coffees[1].id, coffees.map((c) => c.id).join(" / "));
  // Re-importing the SAME file must produce the SAME ids, or every import doubles.
  const again = parseChaseCsv(CARD_CSV, { account: "Sapphire" });
  check("re-importing the same export produces identical ids",
    again.rows.map((r) => r.id).join() === card.rows.map((r) => r.id).join());
  // The realistic case: next month you export July–August and the August rows overlap.
  const overlap = parseChaseCsv(CARD_CSV.split("\n").slice(0, 5).join("\n") + "\n", { account: "Sapphire" });
  const ids = new Set(card.rows.map((r) => r.id));
  check("an overlapping export re-uses the ids it overlaps",
    overlap.rows.every((r) => ids.has(r.id)), overlap.rows.map((r) => r.id).find((i) => !ids.has(i)));
  check("the same charge on a different account is a different row",
    txKey({ account: "A", date: "2026-08-01", amount: -100, description: "X" }) !==
    txKey({ account: "B", date: "2026-08-01", amount: -100, description: "X" }));
}

// ─── 8. THE TOTALS — where a budget usually lies ─────────────────────────────
const ALL = [...card.rows, ...bank.rows];
{
  const s = summarise(ALL, "2026-08");
  // Card purchases: 84.31 + 4.75 + 4.75 + 15.49 + 62.10 = 171.40, minus the
  // 22.15 refund = 149.25. Plus rent 1800 and ComEd 96.42 = 2045.67.
  check("spend is the sum of real spending", s.spent === 204567, `${s.spent} (${money(s.spent)})`);
  check("income is the paycheque", s.income === 540000, money(s.income));
  // THE BIG ONE. The $1,200 card payment appears TWICE — positive on the card,
  // negative on checking. Counting either inflates the month by $1,200.
  check("a credit-card payment is NOT spending", s.spent < 300000, money(s.spent));
  check("…it is shown as a transfer instead of vanishing", s.transfers === 240000, money(s.transfers));
  // AND THE SAME THING PER ACCOUNT, which is the check with teeth. Import both
  // sides and the card's +1200 and checking's −1200 cancel, so a broken rule
  // still totals correctly and the bug hides. One account at a time is where it
  // shows: the card alone would UNDERSTATE by 1200, checking alone OVERSTATE.
  const cardOnly = summarise(card.rows, "2026-08");
  check("the card alone: the payment doesn't reduce what you spent",
    cardOnly.spent === 14925, `${cardOnly.spent} (${money(cardOnly.spent)})`);
  const bankOnly = summarise(bank.rows, "2026-08");
  check("checking alone: the autopay doesn't count as an expense",
    bankOnly.spent === 189642, `${bankOnly.spent} (${money(bankOnly.spent)})`);
  check("the two accounts sum to the whole", cardOnly.spent + bankOnly.spent === s.spent);
  // A transfer must not appear in the breakdown either — a "Transfers" slice
  // sitting in a spending pie chart is the same lie, drawn.
  check("no non-spend category reaches the breakdown",
    s.categories.every((c) => isSpendCategory(c.key)), s.categories.map((c) => c.key).join(","));
  check("net is income minus spend", s.net === s.income - s.spent);
  // A refund reduces the category it came from — what "what did groceries cost
  // me" actually means — rather than counting as income.
  check("a refund nets against its own category",
    s.categories.find((c) => c.key === "groceries").cents === 8431 - 2215,
    money(s.categories.find((c) => c.key === "groceries").cents));
  check("categories are ordered by size", s.categories.every((c, i, a) => !i || a[i - 1].cents >= c.cents));
  check("percentages sum to roughly 100", Math.abs(s.categories.reduce((n, c) => n + c.pct, 0) - 100) <= 2,
    String(s.categories.reduce((n, c) => n + c.pct, 0)));
  check("every row is accounted for somewhere", s.count === ALL.length);
  check("summarise tolerates an empty ledger",
    summarise([], "2026-08").spent === 0 && summarise(null, null).count === 0);
}
check("months come back newest first", monthsOf(ALL).join() === "2026-08");
{
  const july = [{ date: "2026-07-04", amount: -10000, description: "WHOLE FOODS", category: "groceries" }];
  const c = compare([...ALL, ...july], "2026-08", "2026-07");
  check("month over month compares", c.spentDelta === 204567 - 10000, String(c.spentDelta));
  check("…per category too",
    c.categories.find((x) => x.key === "groceries").delta === (8431 - 2215) - 10000);
}

// ─── 9. budgets ──────────────────────────────────────────────────────────────
{
  const s = summarise(ALL, "2026-08");
  const b = budgetStatus(s, { groceries: 50000, dining: 500, travel: 20000 });
  const g = b.rows.find((r) => r.key === "groceries");
  check("a budget knows what's left", g.limit === 50000 && g.left === 50000 - 6216, JSON.stringify(g.left));
  check("…and its percentage", g.pct === Math.round((6216 / 50000) * 100), String(g.pct));
  // Dining: two $4.75 coffees against a $5 budget.
  const d = b.rows.find((r) => r.key === "dining");
  check("going over is flagged", d.over === true && b.overCount >= 1, JSON.stringify({ spent: d.spent, limit: d.limit, over: d.over }));
  check("…and by how much", d.left === 500 - 950, String(d.left));
  // A bar sized from an unclamped percentage blows the card apart; 190% here is
  // real, so the clamp needs its own case with an absurd budget.
  check("a wild overspend doesn't render a 4000%-wide bar",
    budgetStatus(s, { dining: 1 }).rows.find((r) => r.key === "dining").pct === 999,
    String(budgetStatus(s, { dining: 1 }).rows.find((r) => r.key === "dining").pct));
  // A category with no budget that ate $1,800 is the most useful row on screen.
  check("an unbudgeted category still shows if you spent in it",
    !!b.rows.find((r) => r.key === "housing" && r.limit === null && r.spent === 180000));
  // A budget you set but haven't spent against must not disappear.
  check("a budget with no spending yet still shows",
    !!b.rows.find((r) => r.key === "travel" && r.limit === 20000 && r.spent === 0));
  check("categories with neither budget nor spend stay out of the way",
    !b.rows.find((r) => r.key === "fees"));
  check("budgetStatus survives no budgets at all", budgetStatus(s, null).rows.length > 0);
}

// ─── 10. subscriptions, found rather than declared ───────────────────────────
{
  const months = ["2026-05", "2026-06", "2026-07", "2026-08"];
  const subs = months.flatMap((m, i) => [
    { date: `${m}-05`, amount: -1549, description: "NETFLIX.COM", category: "entertainment" },
    { date: `${m}-01`, amount: -180000, description: "PROPERTY MGMT RENT", category: "housing" },
    // Coffee: frequent, but the amount wanders and it is not a subscription.
    { date: `${m}-0${(i % 8) + 1}`, amount: -(300 + i * 220), description: "SQ *BLUE BOTTLE", category: "dining" },
  ]);
  // Twice in one month is not a pattern across months.
  subs.push({ date: "2026-08-02", amount: -999, description: "ONE OFF THING", category: "other" });
  subs.push({ date: "2026-08-19", amount: -999, description: "ONE OFF THING", category: "other" });
  const r = recurring(subs);
  const keys = r.map((x) => x.key);
  check("a steady monthly charge is found", keys.includes(merchantKey("NETFLIX.COM")));
  check("rent counts too — the big ones matter most", keys.includes(merchantKey("PROPERTY MGMT RENT")));
  check("a wandering amount is not a subscription", !keys.includes(merchantKey("SQ *BLUE BOTTLE")), keys.join(","));
  // Distinct MONTHS, not three charges — or a fortnightly habit reads as a bill.
  check("two charges in one month is not recurring", !keys.includes(merchantKey("ONE OFF THING")));
  check("it says what the year costs", r.find((x) => x.key === merchantKey("NETFLIX.COM")).yearly === 1549 * 12);
  check("biggest first", r.every((x, i, a) => !i || a[i - 1].typical >= x.typical));
  check("income is never a subscription",
    recurring([...subs, ...months.map((m) => ({ date: `${m}-15`, amount: 540000, description: "PAYROLL" }))])
      .every((x) => x.key !== merchantKey("PAYROLL")));
  check("recurring tolerates an empty ledger", recurring([]).length === 0 && recurring(null).length === 0);
}

// ─── 11. the biggest hits ────────────────────────────────────────────────────
{
  const top = largest(summarise(ALL, "2026-08"), 3);
  check("largest is sorted by size", top[0].amount === -180000, String(top[0]?.amount));
  check("…and excludes transfers, which are not spending",
    top.every((t) => isSpendCategory(t.category_override || t.category)));
  check("…and excludes income", top.every((t) => t.amount < 0));
}

// ─── 11b. Plaid, whose conventions are the OPPOSITE of the CSV's ─────────────
// Both of these are silent if wrong, and one of them inverts the entire app.
{
  const p = fromPlaid({
    transaction_id: "abc123", date: "2026-08-03", amount: 4.75,
    merchant_name: "Blue Bottle Coffee", name: "SQ *BLUE BOTTLE COFFEE 0123",
    personal_finance_category: { primary: "FOOD_AND_DRINK" },
  }, { account: "Sapphire" });
  // THE ONE THAT MATTERS MOST IN THIS FILE. Plaid documents `amount` as POSITIVE
  // when money moves OUT — the exact opposite of every Chase export. Passed
  // through unchanged, every purchase reads as income and every paycheque as
  // spending: the month isn't wrong, it's backwards.
  check("a Plaid purchase becomes NEGATIVE, like the rest of the ledger",
    p.amount === -475, String(p.amount));
  const paid = fromPlaid({ transaction_id: "x", date: "2026-08-01", amount: -5400, name: "PAYROLL" });
  check("…and a Plaid deposit becomes positive", paid.amount === 540000, String(paid.amount));
  check("the id is Plaid's own, prefixed", p.id === `${PLAID_PREFIX}abc123`, p.id);
  // A synced row and an imported row must never share an id: a collision leaves
  // one path unable to update its own row, forever, with nothing to show for it.
  check("a synced id can never collide with an imported one",
    !card.rows.some((r) => r.id.startsWith(PLAID_PREFIX)) && p.id.startsWith(PLAID_PREFIX));
  check("it is the same row shape the CSV path produces",
    ["id", "account", "date", "amount", "description", "merchant", "category"].every((k) => k in p));
  check("merchant_name is preferred over the raw name", p.merchant === "Blue Bottle Coffee", p.merchant);
  check("categories come from OUR set, not Plaid's taxonomy",
    CATEGORIES.some((c) => c.key === p.category), p.category);
  // A row missing any of the three things that make it a transaction is skipped
  // rather than stored as a $0 on 1970-01-01.
  check("a row with no id, date or amount is skipped",
    fromPlaid({ date: "2026-08-01", amount: 1, name: "x" }) === null &&
    fromPlaid({ transaction_id: "a", amount: 1, name: "x" }) === null &&
    fromPlaid({ transaction_id: "a", date: "2026-08-01", name: "x" }) === null &&
    fromPlaid({ transaction_id: "a", date: "2026-08-01", amount: 1 }) === null);
  check("fromPlaid tolerates junk", fromPlaid(null) === null && fromPlaid({}) === null);
}
{
  const page = fromPlaidSync({
    added: [{ transaction_id: "a", date: "2026-08-01", amount: 10, name: "A" }],
    modified: [{ transaction_id: "b", date: "2026-08-02", amount: 20, name: "B" }],
    removed: [{ transaction_id: "c" }],
    next_cursor: "CURSOR_2", has_more: true,
  }, { account: "Checking" });
  // Modified rows go through the SAME upsert as added ones — Plaid corrects
  // pending amounts after they settle, and dropping those leaves the ledger
  // holding the guess instead of the charge.
  check("added and modified both become upsertable rows", page.rows.length === 2, String(page.rows.length));
  check("removed comes back as prefixed ids to delete",
    page.removed.join() === `${PLAID_PREFIX}c`, page.removed.join());
  check("the cursor is carried forward", page.cursor === "CURSOR_2" && page.more === true);
  check("an empty page is empty, not an error",
    fromPlaidSync({}).rows.length === 0 && fromPlaidSync(null).rows.length === 0);
}

// ─── 11d. merchant rules — what stops the tool asking twice ──────────────────
// With a live sync the same merchants return every month. Without rules you'd
// recategorise the same coffee shop forever, so a rule has to beat the imported
// category — and it must lose to a change you made to one specific row.
{
  const key = merchantKey("SQ *BLUE BOTTLE COFFEE 0123");
  const tx = { description: "SQ *BLUE BOTTLE COFFEE 0123", category: "other", amount: -475, date: "2026-08-01" };
  check("with no rule, the imported category stands", effectiveCategory(tx, null) === "other");
  const rules = applyRule({}, key, "dining");
  check("a rule beats what the bank said", effectiveCategory(tx, rules) === "dining");
  // Most specific wins: you touched this row on purpose.
  check("a per-row override still beats the rule",
    effectiveCategory({ ...tx, category_override: "travel" }, rules) === "travel");
  check("clearing a rule reverts, rather than storing a blank",
    effectiveCategory(tx, applyRule(rules, key, "")) === "other" && !(key in applyRule(rules, key, "")));
  check("a nonsense rule is ignored, not rendered as an empty category",
    effectiveCategory(tx, { [key]: "not_a_category" }) === "other");
  check("a nonsense override is ignored too",
    effectiveCategory({ ...tx, category_override: "nope" }, null) === "other");
  check("applyRule doesn't mutate what it was given",
    (() => { const before = { a: "dining" }; applyRule(before, "b", "travel"); return Object.keys(before).length === 1; })());
  check("a rule says how many rows it moves", ruleReach(card.rows, key) === 2, String(ruleReach(card.rows, key)));
  check("effectiveCategory tolerates junk", CATEGORIES.some(c => c.key === effectiveCategory({}, null)));

  // THE POINT OF ALL OF IT: a rule applies RETROACTIVELY, so the totals move.
  // A rule that only affected future rows would be filing, not fixing.
  const withRule = summarise(card.rows, "2026-08", applyRule({}, merchantKey("AMZN Mktp US*2Z4KL"), "groceries"));
  const without = summarise(card.rows, "2026-08");
  check("a new rule re-files history and the breakdown moves",
    (withRule.categories.find(c => c.key === "groceries")?.cents || 0) ===
    (without.categories.find(c => c.key === "groceries")?.cents || 0) + 6210,
    JSON.stringify(withRule.categories.map(c => [c.key, c.cents])));
  check("…without changing the total spent", withRule.spent === without.spent);
  // A rule that moved something INTO transfers would silently shrink the month;
  // that's legitimate (you might tag a savings transfer) but it must be exact.
  const toTransfer = summarise(card.rows, "2026-08", applyRule({}, merchantKey("AMZN Mktp US*2Z4KL"), "transfer"));
  check("ruling something a transfer removes exactly its own amount from spend",
    toTransfer.spent === without.spent - 6210, `${toTransfer.spent} vs ${without.spent}`);
}

// ─── 11c. the server's copy of the mapping ───────────────────────────────────
// netlify/functions/plaid.js duplicates mapTx rather than importing it: with
// this repo's "type":"module" + esbuild bundling, a required helper's
// module.exports clobbers the bundle's exports and the function deploys with NO
// handler (see the note in workout-import.js). Duplication is the lesser evil,
// but it means the two copies can drift — and the sign is the one place where
// drift inverts the whole app rather than nudging it.
{
  const fn = readFileSync("netlify/functions/plaid.js", "utf8");
  check("the function negates Plaid's amount, exactly like fromPlaid",
    /amount_cents: -cents/.test(fn), "an un-negated server mapping makes every purchase read as income");
  check("…and prefixes ids the same way, so the two paths can't collide",
    /id: `plaid:\$\{id\}`/.test(fn));
  check("it writes to the schema the client reads",
    /"Content-Profile": "boardroom"/.test(fn) && /"Accept-Profile": "boardroom"/.test(fn));
  // The cursor is what makes a sync incremental. Saved only at the end, a
  // timeout mid-backfill replays from zero forever on a big account.
  check("the sync cursor is saved after every page, not at the end",
    /cursor, synced_at/.test(fn) && fn.indexOf("more = !!page.has_more") < fn.indexOf("cursor, synced_at"));
  // The blast radius of this function is a bank feed. These two are the reason
  // it is safe: the caller is identified by their own JWT, and no secret ever
  // travels back to the browser.
  check("the caller is identified from their own session, never from the body",
    /auth\/v1\/user/.test(fn) && !/body\.user_id/.test(fn));
  check("no access token is ever returned to the client",
    !/json\(200, \{[^}]*access_token/.test(fn));
  check("the handler is assigned — this repo has shipped functions with none",
    /exports\.handler\s*=/.test(fn));
  check("…and it is self-contained, which is why", !/require\(["'][^"']*_shared/.test(fn));
}
{
  const cli = readFileSync("src/features/finances/plaid.js", "utf8");
  // RLS with no policy, on purpose: this table holds long-lived bank tokens and
  // only the service role should ever read it. A policy here would be a bug.
  check("the token table grants nothing to the browser",
    /revoke all on boardroom\.plaid_items from anon, authenticated/.test(cli) &&
    !/create policy[^;]*plaid_items/.test(cli));
  check("row-level security is still switched on for it",
    /alter table boardroom\.plaid_items enable row level security/.test(cli));
  // Chase is OAuth-only; without a redirect_uri Link refuses to open it at all,
  // and says nothing that names the cause.
  check("the redirect_uri Chase requires is sent", /origin: window\.location\.origin/.test(cli));
  check("Plaid Link is loaded on demand, not bundled", /document\.createElement\("script"\)/.test(cli));
}

// ─── 11e. the sync behaviours that are only visible in the panel ─────────────
// Not logic, but each of these is a way the live sync could be quietly wrong or
// quietly expensive, and none of them shows up in a diff.
{
  const ui = readFileSync("src/features/finances/FinancesPanel.jsx", "utf8");
  // Connecting a bank was meant to END manual work. A sync that only happens
  // when you remember to press a button is a button, not a sync.
  check("opening the tab syncs when the data is stale", /SYNC_AFTER/.test(ui) && /callPlaid\("sync"\)/.test(ui));
  // Once per mount. React re-renders freely and this costs a Plaid call.
  check("…at most once per mount", /autoSynced\.current = true/.test(ui) && /if \(autoSynced\.current\) return;/.test(ui));
  // An unconfigured install must never call the function on a page view.
  check("…and only when a bank is actually connected", /if \(!st\.items\?\.length\) return;/.test(ui));
  // A background failure painting the screen red over a month you're reading is
  // worse than a stale number; Sync now exists to surface it deliberately.
  check("a background sync fails silently", /catch \{ \/\* silent/.test(ui));
  // The category chip and the filter must both read the RESOLVED category, or a
  // merchant rule shows in one place and not the other.
  check("the row chip reads the resolved category, not the raw one",
    /const cat = catMeta\(t\.category\);/.test(ui) && !/catMeta\(t\.category_override \|\| t\.category\)/.test(ui));
  check("recategorising sets a merchant RULE by default",
    /if \(onlyThis\) setCat\.mutate/.test(ui) && /updateSetting\?\.\("finance_rules"/.test(ui));
  check("…and still offers the one-row escape hatch", /Just this one/.test(ui));

  // THE BUG THIS EXISTS FOR. The empty state early-returns before the Accounts
  // card, so for a while the ONLY thing on a fresh install was "Import from
  // Chase" — Connect a bank was further down a page you could not reach until
  // you already had transactions. The one path that ends manual work was gated
  // behind doing the manual work.
  const empty = ui.match(/if \(rows !== null && all\.length === 0\) \{[\s\S]*?\n  \}/)?.[0] || "";
  check("the empty state is findable", !!empty);
  check("a fresh install can connect a bank without importing first",
    /onClick=\{connect\}/.test(empty), "Connect a bank is unreachable until you have transactions");
  check("…and CSV is still offered as the alternative", /setImporting\(true\)/.test(empty));
  // A connect failure on the very first screen needs somewhere to appear, or it
  // is a button that does nothing.
  check("…and a connect error has somewhere to show", /linkErr/.test(empty));
}

// ─── 12. the setup SQL has to be runnable, in the right schema ───────────────
// The panel tells you to paste this into Supabase, so a mistake is a dead end
// with no error anyone can act on — and this app has already shipped exactly
// that once, creating public.dream_items for a client pinned to `boardroom`.
// The schema is read out of supabase.js so the two cannot drift.
const SCHEMA = readFileSync("src/lib/supabase.js", "utf8").match(/db:\s*\{\s*schema:\s*"(\w+)"/)?.[1];
check("the client's schema is discoverable", !!SCHEMA, SCHEMA);
check("the SQL creates the table where the client will look",
  new RegExp(`create table if not exists ${SCHEMA}\\.transactions`).test(SETUP_SQL), SCHEMA);
check("nothing is left pointing at public",
  !/\bpublic\.transactions\b/.test(SETUP_SQL.replace(/^\s*--.*$/gm, "")));
check("the schema itself is created first", new RegExp(`create schema if not exists ${SCHEMA}`).test(SETUP_SQL));
// RLS filters; it does not grant.
check("usage on the schema is granted", new RegExp(`grant usage on schema ${SCHEMA}`).test(SETUP_SQL));
check("the table is granted to the signed-in role",
  new RegExp(`grant [^;]*on ${SCHEMA}\\.transactions to [^;]*authenticated`).test(SETUP_SQL));
check("row-level security is on", /enable row level security/.test(SETUP_SQL));
check("the policy scopes reads and writes to the owner",
  /using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\)/.test(SETUP_SQL));
check("it is safe to run twice",
  /create table if not exists/.test(SETUP_SQL) && /drop policy if exists/.test(SETUP_SQL));
// The id is derived, not supplied by Chase, so it is only unique WITHIN a user —
// a plain primary key on id alone would collide across accounts.
check("the key is scoped to the user", /primary key \(user_id, id\)/.test(SETUP_SQL));
check("every column the client writes exists",
  ["account", "date", "amount_cents", "description", "merchant", "category", "category_override"]
    .every((c) => new RegExp(`\\n\\s+${c}\\b`).test(SETUP_SQL)));

console.log(failed ? `\n${failed} finance check(s) failed` : "\nFINANCE SMOKE PASS");
process.exit(failed ? 1 : 0);
