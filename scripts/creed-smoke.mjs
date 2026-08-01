// ─── Creed logic smoke — PLANTED problems, known answers ──────────────────────
// The Creed's intelligence is pure (src/features/creed/creedLogic.js) because
// every way it can be wrong is a wrong-but-plausible answer rather than a crash:
//
//   · "today's line" that changes every time you open the tab, which is the one
//     thing a grounding room must not do
//   · a quote whose attribution gets swallowed into the quote
//   · a creed containing an em dash losing its last clause to quote parsing
//   · a row whose `kind` this build has never seen vanishing from the list
//
// None of those throw. `kind` is a free-text column, so it can hold values from
// an older build or typed by hand in the SQL editor, and this file is what
// stands between that and a row that silently disappears.
//
// Run by `npm run verify`.

import {
  KINDS, kindMeta, splitQuote, dailyIndex, dayKey, countsByKind, filterByKind, STARTERS,
} from "../src/features/creed/creedLogic.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

// ─── 1. the kinds ────────────────────────────────────────────────────────────
check("five kinds, creed first", KINDS.length === 5 && KINDS[0].key === "creed", KINDS.map(k => k.key).join(","));
check("every kind is fully specified",
  KINDS.every(k => k.key && k.label && k.blurb && k.tone && k.prompt && k.hint));
check("keys are unique", new Set(KINDS.map(k => k.key)).size === KINDS.length);
check("tones are real tokens", KINDS.every(k => /^var\(--[a-z-]+\)$/.test(k.tone)), KINDS.map(k => k.tone).join(","));
// The original two kinds are load-bearing: rows already in the table use them.
check("the shipped kinds survive", ["creed", "proof"].every(k => KINDS.some(x => x.key === k)));
// A free-text column means anything can turn up in it. Falling back beats
// rendering a row with no dot, no label and no filter that can reach it.
check("an unknown kind degrades to Creed", kindMeta("wisdom").key === "creed");
check("a null kind degrades to Creed", kindMeta(null).key === "creed" && kindMeta(undefined).key === "creed");
check("every kind has starters", KINDS.every(k => (STARTERS[k.key] || []).length > 0));

// ─── 2. quotes: the attribution is a line, not a dash ────────────────────────
{
  const q = splitQuote("What stands in the way becomes the way.\n— Marcus Aurelius");
  check("an em-dash line parses as the author",
    q.body === "What stands in the way becomes the way." && q.author === "Marcus Aurelius", JSON.stringify(q));
}
check("a hyphen works too", splitQuote("Line.\n- Someone").author === "Someone");
check("an en dash works too", splitQuote("Line.\n– Someone").author === "Someone");
check("spacing after the dash is optional", splitQuote("Line.\n—Someone").author === "Someone");
// THE GUARD. Anchored to the last LINE, not the last dash — otherwise a
// sentence that merely contains a dash loses its ending.
check("a dash inside one line is not an attribution", (() => {
  const q = splitQuote("Work — then rest — then work again.");
  return q.author === "" && q.body === "Work — then rest — then work again.";
})(), JSON.stringify(splitQuote("Work — then rest — then work again.")));
check("a multi-line quote keeps every line but the attribution", (() => {
  const q = splitQuote("One.\nTwo.\n— Author");
  return q.body === "One.\nTwo." && q.author === "Author";
})());
check("no attribution comes back empty, not undefined",
  splitQuote("Just a line.").author === "" && splitQuote("Just a line.").body === "Just a line.");
check("a dangling dash is not an author", splitQuote("Line.\n—").author === "");
check("splitQuote survives empty and null",
  splitQuote("").body === "" && splitQuote(null).body === "" && splitQuote(undefined).author === "");

// ─── 3. the day's line holds still ───────────────────────────────────────────
// This is the whole point: a room you open for grounding must not reshuffle.
check("the same day gives the same line", dailyIndex(7, "2026-8-1") === dailyIndex(7, "2026-8-1"));
check("the index is always in range",
  Array.from({ length: 60 }, (_, i) => dailyIndex(7, `2026-8-${i}`)).every(n => n >= 0 && n < 7));
check("a different day usually gives a different line", (() => {
  const seen = new Set(Array.from({ length: 30 }, (_, i) => dailyIndex(9, `2026-8-${i + 1}`)));
  return seen.size >= 5; // spread, not a constant
})());
check("one entry is always entry zero", dailyIndex(1, "2026-8-1") === 0);
check("an empty list doesn't divide by zero", dailyIndex(0, "2026-8-1") === 0);
check("a nonsense count is clamped", dailyIndex(-3, "x") === 0 && dailyIndex(NaN, "x") === 0);
check("a missing date key still returns a valid index", (() => {
  const n = dailyIndex(5, undefined);
  return n >= 0 && n < 5;
})());
// Local, not UTC — "today" has to change when your day does, not at 6pm.
check("dayKey is the local calendar day",
  dayKey(new Date(2026, 7, 1, 23, 30)) === "2026-8-1", dayKey(new Date(2026, 7, 1, 23, 30)));
check("dayKey changes across midnight",
  dayKey(new Date(2026, 7, 1, 23, 59)) !== dayKey(new Date(2026, 7, 2, 0, 1)));

// ─── 4. counts and filtering drive the pills ─────────────────────────────────
const rows = [
  { id: "1", kind: "creed", text: "A" },
  { id: "2", kind: "proof", text: "B" },
  { id: "3", kind: "goal", text: "C" },
  { id: "4", kind: "goal", text: "D" },
  { id: "5", kind: "wisdom", text: "E" },   // an unknown kind from somewhere else
  { id: "6", text: "F" },                    // no kind at all
];
{
  const n = countsByKind(rows);
  check("the total counts everything", n[""] === 6, String(n[""]));
  check("each kind counts its own", n.goal === 2 && n.proof === 1, `${n.goal}/${n.proof}`);
  // Both strays land in Creed — which is also what kindMeta renders them as, so
  // the pill count and the visible list agree.
  check("unknown and missing kinds count as Creed", n.creed === 3, String(n.creed));
  check("a kind with nothing still reports zero", n.quote === 0 && n.why === 0);
  check("countsByKind tolerates an empty list", countsByKind([])[""] === 0 && countsByKind(null)[""] === 0);
}
check("filtering to a kind keeps only that kind",
  filterByKind(rows, "goal").map(r => r.id).join(",") === "3,4");
check("the strays are reachable under Creed",
  filterByKind(rows, "creed").map(r => r.id).join(",") === "1,5,6");
check("no filter shows everything", filterByKind(rows, "").length === 6);
check("filterByKind tolerates nulls", filterByKind(null, "goal").length === 0);
// Every row must be reachable through exactly one pill, or an entry exists that
// no filter can show — the failure that would send you hunting for it.
check("every row is reachable through exactly one pill", (() => {
  const seen = KINDS.flatMap(k => filterByKind(rows, k.key).map(r => r.id));
  return seen.length === rows.length && new Set(seen).size === rows.length;
})());

console.log(failed ? `\n${failed} creed check(s) failed` : "\nCREED SMOKE PASS");
process.exit(failed ? 1 : 0);
