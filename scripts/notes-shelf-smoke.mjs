// ─── The shelf, the bin, and the two surfaces that must agree ────────────────
//
// Notes are read by two components that never import each other — the Notes tab
// (pages/personal/NotesPanel.jsx) and the Brief's tile (pages/brief/NotesTile.jsx)
// — and they now have to agree about three new things: which notes are on the
// homescreen, which are in the bin, and what colour does to a card. A note
// archived off the Brief that still shows on the Brief is a bug you cannot see by
// reading either file, because each one looks correct on its own.
//
// So the rules live in src/lib/notes-shelf.js as pure functions and this file
// drives them, then reads both call sites to confirm they actually go through
// them. The second half is what makes the first half worth anything: a perfect
// filter that one surface forgets to call is the same bug with better paperwork.
//
// It also pins the parts that span the browser and the server — the delete is
// soft, the fallback exists, and the thirty days this app PROMISES are the same
// thirty days db-admin's purge enforces.
//
// Run by `npm run verify`.

import { readFileSync } from "node:fs";
import {
  shelfOf, onShelf, homescreenNotes, panelNotes, deletedNotes, lastDeletion,
  isDeleted, isArchived, noteTint, daysLeft, SHELVES, PURGE_AFTER_DAYS,
  UNDO_GROUP_MS, TINT_PCT, TINT_PCT_STRONG,
} from "../src/lib/notes-shelf.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const read = (p) => readFileSync(p, "utf8");
/** Strip comments so prose about a rule cannot satisfy a test for it. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── 1. the classifier ────────────────────────────────────────────────────────
const A = { id: "a", title: "active" };
const B = { id: "b", title: "archived", archived: true };
const C = { id: "c", title: "binned", deleted_at: "2026-08-17T10:00:00Z" };
const D = { id: "d", title: "binned too", archived: true, deleted_at: "2026-08-17T10:00:01Z" };
const E = { id: "e", title: "older bin", deleted_at: "2026-08-01T09:00:00Z" };
const rows = [A, B, C, D, E];

check("a plain note is active", shelfOf(A) === "active");
check("an archived note is archived", shelfOf(B) === "archived");
// THE BIN WINS OVER THE SHELF, and it has to: a note that is both archived and
// deleted appearing in the Archived list would be a deleted note on screen in a
// list that offers no way to undelete it.
check("a deleted note is deleted even when it was archived", shelfOf(D) === "deleted");
check("…and is not also reported as archived", !isArchived(D) && isDeleted(D));
check("every row lands on exactly one shelf",
  SHELVES.reduce((n, sh) => n + onShelf(rows, sh).length, 0) === rows.length);

// ── 2. the homescreen ────────────────────────────────────────────────────────
// The whole contract of the archive toggle, in one assertion.
check("the Brief shows active notes only", homescreenNotes(rows).map((n) => n.id).join(",") === "a");
check("the Notes tab's Archived shelf shows the archived one", panelNotes(rows, "archived").map((n) => n.id).join(",") === "b");
// An unknown shelf must not fall through to "everything" — a typo that puts the
// bin on the homescreen is worse than a typo that shows an empty list.
check("an unknown shelf returns nothing, never everything", onShelf(rows, "achived").length === 0);
check("a non-array is survivable", homescreenNotes(null).length === 0 && panelNotes(undefined).length === 0);

// ── 3. the bin, and what a bare Undo restores ────────────────────────────────
check("the bin is newest-deleted first", deletedNotes(rows).map((n) => n.id).join(",") === "d,c,e");
// A BULK DELETE UNDOES AS ONE ACT. Nine notes deleted in one tap are stamped in
// the same instant; restoring one row of that would look like the button
// half-worked. Rows within UNDO_GROUP_MS of the newest count as the same act.
check("Undo restores the whole of the last deletion", lastDeletion(rows).map((n) => n.id).sort().join(",") === "c,d");
check("…and does not reach back to an older, separate deletion", !lastDeletion(rows).some((n) => n.id === "e"));
check("an empty bin has nothing to undo", lastDeletion([A, B]).length === 0);
check("a row with an unparseable stamp still undoes as itself",
  lastDeletion([{ id: "x", deleted_at: "not a date" }]).map((n) => n.id).join(",") === "x");
check("the grouping window is a stated constant, not a magic number", UNDO_GROUP_MS >= 500 && UNDO_GROUP_MS <= 10000);

// ── 4. days left ─────────────────────────────────────────────────────────────
const now = Date.parse("2026-08-20T10:00:00Z");
check("a note deleted three days ago has the rest of the window",
  daysLeft({ deleted_at: "2026-08-17T10:00:00Z" }, now) === PURGE_AFTER_DAYS - 3);
// Past the window is "waiting to be collected", never a negative number on screen.
check("a note past its window floors at zero, never negative",
  daysLeft({ deleted_at: "2026-01-01T00:00:00Z" }, now) === 0);
check("an unparseable stamp reports nothing rather than a number", daysLeft({ deleted_at: "" }, now) === null);

// ── 5. the tint ──────────────────────────────────────────────────────────────
// A WASH OVER --surface, never the semantic colour itself: a note filled with
// --red is an error state in this app's vocabulary.
check("no seal means no background at all", noteTint(null, () => "var(--red)") === null);
check("an unknown seal is left alone", noteTint("chartreuse", () => null) === null);
const tint = noteTint("red", () => "var(--red)");
check("a seal mixes into the card material", tint === `color-mix(in srgb, var(--red) ${TINT_PCT}%, var(--surface))`, tint);
check("…and resolves against --surface, so all twenty palettes get it free", /var\(--surface\)/.test(tint));
check("the editor's mix is stronger than the list's", TINT_PCT_STRONG > TINT_PCT);
check("both mixes stay a tint rather than a fill", TINT_PCT_STRONG <= 25);

// ── 6. both surfaces actually go through the module ──────────────────────────
const tile = read("src/pages/brief/NotesTile.jsx");
const panel = read("src/pages/personal/NotesPanel.jsx");
check("the Brief tile filters through homescreenNotes", /homescreenNotes\(/.test(code(tile)));
check("the Notes tab filters through panelNotes", /panelNotes\(sorted, shelf\)/.test(code(panel)));
check("both surfaces tint through noteTint", /noteTint\(/.test(code(tile)) && /noteTint\(/.test(code(panel)));
// THE COUNT HAS TO BE ABOUT THE SAME SET AS THE LIST. "Show all 23" over a list
// of nine is the same lie as showing the archived ones, so the tile's cap and
// its count both read `sorted`, which is already filtered.
check("the tile counts what it can actually show",
  /const sorted = homescreenNotes\(sortedAll\)/.test(code(tile)) && /sorted\.length > LIST_CAP/.test(code(tile)));
// …while the SAVED ORDER still sees every note. Handing the filtered list to
// mergeOrder would drop every archived note to the bottom of both surfaces on
// the next drag — the same failure mergeOrder's own docstring describes for
// search, arriving through a new door.
check("…but the saved order is still merged against every note",
  /mergeOrder\(ids, sortedAll\)/.test(code(tile)));
// Archiving is not deleting. Archiving the note you are editing on the Brief must
// not take its editor down with whatever is typed in it — so the rescue that keeps
// an open editor on screen searches the UNFILTERED list. Caught by writing this
// check: the first version of the filter left it searching the filtered one.
check("…and an open editor survives its own note being archived",
  /const edited = sortedAll\.find\(n => n\.id === editing\.id\)/.test(code(tile)));

// ── 7. the delete is soft, and degrades honestly ─────────────────────────────
const db = code(read("src/data/db.js"));
check("deleting a note writes a stamp instead of removing the row",
  /\.update\(\{ deleted_at: now \}\)\.in\("id", list\)\.is\("deleted_at", null\)/.test(db));
// Deleting twice must not push the thirty-day clock forward — deleted_at means
// when it was deleted. Same guard the two tables that had this first use.
check("…and deleting the same note twice cannot restart its clock", /\.is\("deleted_at", null\)/.test(db));
check("the old hard delete survives as the pre-migration fallback",
  /isMissingShelf\(soft\.error\)/.test(db) && /\.delete\(\)\.in\("id", list\)/.test(db));
check("the caller is told which regime ran", /return \{ soft: true \}/.test(db) && /return \{ soft: false \}/.test(db));
check("restoring clears the stamp rather than re-upserting the row",
  /undeleteNotes/.test(db) && /\.update\(\{ deleted_at: null \}\)/.test(db));
// The one irreversible call in the notes path must be unable to reach a live
// note even if handed its id.
check("purging can only ever touch a row that is already in the bin",
  /purgeNotes[\s\S]{0,320}\.delete\(\)\.in\("id", list\)\.not\("deleted_at", "is", null\)/.test(db));
check("the live read excludes the bin at the source", /\.is\("deleted_at", null\)/.test(db) && /loadDeletedNotes/.test(db));
check("archived is only written when the caller means it", /if \(note\.archived !== undefined\) row\.archived = note\.archived/.test(db));

// ── 8. thirty days means thirty days ─────────────────────────────────────────
// The number is promised in the panel's copy and enforced by db-admin. Two
// places, one constant — a drift here is a promise broken silently.
const admin = code(read("netlify/functions/db-admin.js"));
check("the purge collects personal_notes alongside the other two soft-delete tables",
  /\["dream_items", "affirmations", "personal_notes"\]/.test(admin));
check("…on the same window the app promises",
  new RegExp(`Date\\.now\\(\\) - ${PURGE_AFTER_DAYS} \\* 86400000`).test(admin), `PURGE_AFTER_DAYS=${PURGE_AFTER_DAYS}`);
check("the panel quotes the constant rather than typing a number",
  /\$\{PURGE_AFTER_DAYS\} days/.test(read("src/pages/personal/NotesPanel.jsx")));

// ── 9. the migration, and the paste that stands in for it ────────────────────
const mig = read("supabase/migrations/0036_notes_archive_undo.sql");
for (const col of ["archived", "deleted_at"]) {
  check(`0036 adds ${col} idempotently`, new RegExp(`add column if not exists\\s+${col}\\b`).test(mig));
}
check("0036 is boardroom-qualified, like every other migration",
  !/alter table (?!boardroom\.)/i.test(mig) && /boardroom\.personal_notes/.test(mig));
// The banner's SQL is what actually gets run in practice, so it has to cover the
// same columns — a paste that unlocks half the feature leaves the panel showing
// a banner for something the user believes they already did.
const sql = (read("src/pages/personal/NotesPanel.jsx").match(/NOTES_UPGRADE_SQL = `([\s\S]*?)`/) || [])[1] || "";
for (const col of ["pinned", "color", "archived", "deleted_at"]) {
  check(`the in-app SQL covers ${col}`, new RegExp(`add column if not exists ${col}\\b`).test(sql));
}
check("…and every statement in it is re-runnable",
  sql.trim().split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"))
    .every((l) => /add column if not exists/.test(l)), sql);

console.log(`\n${failed ? `${failed} FAILURE(S)` : "NOTES SHELF SMOKE: ALL CLEAN"}`);
if (failed) { console.error("NOTES SHELF SMOKE FAILED"); process.exit(1); }
