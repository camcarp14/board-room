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

import { readFileSync } from "node:fs";
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

// ─── 5. a deleted line is recoverable, and the logic can't be what hides it ───
// Deleting a line of the Creed used to destroy the row. It writes `deleted_at` now
// and db.restoreAffirmation puts it back, which is the whole reason this section
// exists — the recovery is only real if the row is still intact, and it is only
// invisible if something filters it.
//
// THAT SOMETHING CANNOT BE THIS FILE'S SUBJECT. creedLogic is pure and has never
// heard of deleted_at: hand it a deleted row and it counts it, files it under a
// pill, and puts it on the plate. That is not a bug to fix here — teaching the
// logic about deleted_at would mean every future caller has to remember to pass
// unfiltered rows and hope — it is the argument for the filter living in
// db.loadAffirmations, and this check is that argument written down.
{
  const deleted = [{ id: "x", kind: "creed", text: "Struck out yesterday", deleted_at: "2026-08-01T00:00:00Z" }];
  check("a deleted row reaches the plate if the READER lets it through",
    filterByKind(deleted, "creed").length === 1 && countsByKind(deleted)[""] === 1);
}

// The rest is text-based against src/data/db.js, like the setup-SQL section in
// dreams-smoke.mjs: these statements only ever run against Supabase, and the thing
// worth pinning is which columns they touch. dreams-smoke.mjs owns the sweep that
// proves nothing outside db.js reads either table; this owns what the Creed's own
// delete and restore are allowed to write.
const dbSrc = readFileSync("src/data/db.js", "utf8");
const body = (name) => dbSrc.match(new RegExp(`async ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\},`))?.[1] || "";
for (const name of ["loadAffirmations", "deleteAffirmation", "restoreAffirmation"]) {
  // Without this every check below goes quietly true if db.js is reshaped.
  check(`db.${name} is still where this check looks for it`, body(name).length > 0, name);
}
check("the reader hides deleted lines", /readUndeleted\(/.test(body("loadAffirmations")));
check("a delete marks the row rather than removing it",
  /deleted_at: now/.test(body("deleteAffirmation")) && !/\.delete\(/.test(body("deleteAffirmation")));
check("a restore clears the mark", /deleted_at: null/.test(body("restoreAffirmation")));
// THE ORDER IS THE NUMBERING. The Creed is read created_at ascending and CreedPanel
// renders those positions as Roman numerals, so a delete or a restore that touched
// created_at would renumber your own doctrine — VII comes back as XII. Neither may
// write it.
for (const name of ["deleteAffirmation", "restoreAffirmation"]) {
  check(`db.${name} leaves created_at alone, so the numbering survives`,
    !/created_at/.test(body(name)));
}

// The undo has to be reachable from the panel, and through the same query key, or
// the line comes back in the table and not on screen until a reload.
const creedSrc = readFileSync("src/data/creed.js", "utf8");
check("there is a restore hook next to the delete hook",
  /useRestoreAffirmation/.test(creedSrc) && /db\.restoreAffirmation/.test(creedSrc));
check("it invalidates the same query as everything else here",
  /useRestoreAffirmation = \(\) => useInvalidatingMutation/.test(creedSrc));

console.log(failed ? `\n${failed} creed check(s) failed` : "\nCREED SMOKE PASS");
process.exit(failed ? 1 : 0);
