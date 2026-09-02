// ─── Manual note order smoke — PLANTED problems, known answers ────────────────
// The ordering is pure (src/lib/notes-order.js) because the failure modes are all
// silent: a note that vanishes from the list, a deleted id leaving a hole, or a
// drag that doesn't survive a refetch. None of those throw.
//
// The order lives in app_settings.notes_order rather than a column on
// personal_notes — no migration, and it syncs across devices for free.
//
// Run by `npm run verify`.

import { readFileSync } from "node:fs";
import { applyNotesOrder, reorder, bumpToFront, orderOf } from "../src/lib/notes-order.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const n = (id, mins) => ({ id, updated_at: new Date(Date.now() - mins * 60000).toISOString() });
const A = n("a", 50), B = n("b", 40), C = n("c", 30), D = n("d", 10); // D newest
const ALL = [A, B, C, D];
const ids = (list) => list.map((x) => x.id).join("");

// 0 — no order set yet: the previous behaviour, newest first
check("no order ⇒ newest first", ids(applyNotesOrder(ALL, null)) === "dcba", ids(applyNotesOrder(ALL, null)));
check("empty order ⇒ newest first", ids(applyNotesOrder(ALL, [])) === "dcba");

// 1 — a manual order is honoured exactly. This is the whole feature: a drag that
// lands somewhere other than where you dropped it isn't a drag.
check("full manual order is exact", ids(applyNotesOrder(ALL, ["b", "d", "a", "c"])) === "bdac");
check("manual order beats updated_at", ids(applyNotesOrder(ALL, ["a", "b", "c", "d"])) === "abcd");

// 2 — a NEW note (not in the order yet) has to be visible, so it goes first.
check("an unordered note surfaces above the ordered ones",
  ids(applyNotesOrder(ALL, ["a", "b", "c"])) === "dabc", ids(applyNotesOrder(ALL, ["a", "b", "c"])));
check("several unordered notes stay newest-first among themselves",
  ids(applyNotesOrder(ALL, ["a"])) === "dcba".replace("a", "") + "a");

// 3 — a deleted note's id must not leave a hole or drop a survivor.
check("stale ids in the order are ignored", ids(applyNotesOrder([A, C], ["a", "zzz", "c"])) === "ac");
check("every note survives whatever the order says",
  applyNotesOrder(ALL, ["zzz", "yyy"]).length === 4);
check("duplicate ids in the order don't duplicate or drop notes",
  ids(applyNotesOrder(ALL, ["b", "b", "a", "c", "d"])) === "bacd");

// 4 — garbage in, list out. This runs on every render.
check("null notes ⇒ empty", applyNotesOrder(null, ["a"]).length === 0);
check("garbage order ⇒ still sorted", ids(applyNotesOrder(ALL, "nope")) === "dcba");
check("holes in the notes array are dropped", applyNotesOrder([A, null, C], null).length === 2);

// 5 — reorder(): the move a drop performs
check("move before another id", reorder(["a", "b", "c", "d"], "d", "b").join("") === "adbc");
check("move to the end with a null target", reorder(["a", "b", "c"], "a", null).join("") === "bca");
check("moving onto itself is a no-op", reorder(["a", "b", "c"], "b", "b").join("") === "abc");
check("an unknown target appends rather than throwing", reorder(["a", "b"], "a", "zzz").join("") === "ba");
check("reorder does not mutate its input", (() => { const src = ["a", "b", "c"]; reorder(src, "c", "a"); return src.join("") === "abc"; })());
check("reorder tolerates a non-array", Array.isArray(reorder(null, "a", null)));

// 6 — bumpToFront(): what pinning does now that manual order wins
check("bump moves to the front", bumpToFront(["a", "b", "c"], "c").join("") === "cab");
check("bumping the first is a no-op", bumpToFront(["a", "b"], "a").join("") === "ab");
check("bumping an absent id adds it", bumpToFront(["a"], "z").join("") === "za");

// 7 — orderOf(): what gets persisted after a drag. Writing the WHOLE visible
// sequence is what turns implicitly-ordered notes explicit, so they can't drift.
check("orderOf captures the full sequence", orderOf(applyNotesOrder(ALL, ["b", "a"])).join("") === "dcba".slice(0, 2) + "ba");
check("orderOf on garbage is empty", orderOf(null).length === 0 && orderOf("x").length === 0);

// 8 — round trip: drop, persist, refetch in a different order ⇒ same list.
const dropped = reorder(orderOf(applyNotesOrder(ALL, null)), "a", "d"); // drag A above D
const persisted = orderOf(applyNotesOrder(ALL, dropped));
check("a drag survives a refetch that returns rows in another order",
  ids(applyNotesOrder([C, A, D, B], persisted)) === ids(applyNotesOrder(ALL, persisted)),
  ids(applyNotesOrder([C, A, D, B], persisted)));
check("re-applying a persisted order is stable (no drift on every render)",
  ids(applyNotesOrder(ALL, persisted)) === ids(applyNotesOrder(ALL, orderOf(applyNotesOrder(ALL, persisted)))));

// 9 — THE WRITE THAT KEEPS ALL OF THE ABOVE. Everything up to here checks that
// the order is computed right; a computed order nobody manages to store is worth
// nothing. It persists through db.saveSetting("notes_order", …), and that
// function was `try { await supabase…upsert(…) } catch {}` for a long time —
// which catches nothing, because supabase-js resolves with { data: null, error }
// instead of rejecting on a PostgREST rejection, an RLS denial or a 500. A drag
// the database refused was therefore indistinguishable from one it accepted: the
// list was already reordered on screen, the write went out unobserved, and the
// next reload put the old order back with nothing having said no.
//
// Text-based, like systems-smoke.mjs — the sources are ESM/JSX and there is no
// bundler here. These are cheap to keep and they pin the one shape that must not
// come back.
const dbSrc = readFileSync("src/data/db.js", "utf8");
// The comments in there narrate this bug at length and quote the old shape
// verbatim, so the prose comes off before looking for that shape in the code.
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("db.js swallows nothing — no empty catch anywhere in the data layer",
  !/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(codeOnly(dbSrc)));
const helper = dbSrc.match(/async function write\([\s\S]*?\n\}/)?.[0] || "";
check("there is a single write() helper", helper.length > 0);
check("write() reads .error off the resolved query", /const \{ error \} = await query;/.test(helper));
check("…and throws it rather than returning it", /\bthrow e;/.test(helper));
for (const fn of ["saveMessage", "saveSeatNote", "saveSetting", "saveFindings"]) {
  const body = dbSrc.match(new RegExp(`async ${fn}\\([\\s\\S]*?\\n  \\},`))?.[0] || "";
  check(`${fn} routes through write()`, /\bwrite\(/.test(body), body ? "" : "(function not found)");
  check(`${fn} reports its failure instead of dropping it`, /\breported\(/.test(body));
}
// The throw has to stay opt-in. updateSetting is handed to onChange handlers all
// over the app, most of which never await it — a saveSetting that rejected by
// default would turn a failed write into an unhandled rejection or a dead panel.
check("the throw is opt-in, and off by default", /\{ strict = false \} = \{\}/.test(dbSrc));
// A failure nobody is told about is the bug itself, so the store and its one
// consumer are part of the invariant.
check("failed writes are recorded for the shell to show", /export const writeFailures = \{/.test(dbSrc));
const appSrc = readFileSync("src/App.jsx", "utf8");
check("App awaits the setting write instead of dropping the promise",
  /await db\.saveSetting\(key, value\)/.test(appSrc));
check("App subscribes to the failed-write store", /writeFailures\.subscribe\(/.test(appSrc));
check("signing out clears another account's unsaved writes", /writeFailures\.clearAll\(\)/.test(appSrc));
// Same class of bug, same fix, one file over: the workout db layer had one write
// left wrapped in an empty catch.
const workout = codeOnly(readFileSync("src/WorkoutPanel.jsx", "utf8"));
check("the workout db layer swallows no write either",
  !/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(workout.match(/function makeWdb\(sb\)[\s\S]*?\n\}/)?.[0] || "x catch {}"));
check("deleting a routine reads .error",
  /async deleteTemplate\(id\) \{[\s\S]*?const \{ error \} = await sb[\s\S]*?if \(error\) throw error;/.test(workout));
const topStatus = readFileSync("src/shell/TopStatus.jsx", "utf8");
check("the chip only draws when there is a real failure", /\{n > 0 && \(/.test(topStatus));
check("…and it offers the retry", /onClick=\{onRetry\}/.test(topStatus));

// 10 — THE PIN THAT WRITES THE ORDER. Section 6 proves bumpToFront works; for
// a long time nothing called it. Manual order is absolute, so the pinned flag
// alone draws a hairline and moves nothing — "Pin to top" left the note exactly
// where it was on both surfaces. The panel has to write the order when a note
// is pinned, from the editor's pin button and from the select sheet alike.
const panel = readFileSync("src/pages/personal/NotesPanel.jsx", "utf8");
check("NotesPanel imports bumpToFront", /import \{[^}]*\bbumpToFront\b[^}]*\} from "\.\.\/\.\.\/lib\/notes-order\.js"/.test(panel));
check("…and calls it on the persisted order", /bumpToFront\(order, id\)/.test(panel) && /saveOrder\(order\)/.test(panel));
check("the editor's pin button moves the note", /if \(!draft\.pinned\) pinToTop\(\[activeId\]\)/.test(panel));
check("the select sheet's Pin moves every picked note", /if \(pin\) pinToTop\(/.test(panel));

// 11 — UNDO AFTER A MERGE RESTORES THE TARGET. The folded notes are deleted and
// come back by clearing their stamp; the target was overwritten in place and
// has no stamp to clear — its old body exists only in this tab's copy. Undo used
// to un-delete the folded notes and leave the merged text on the target, so the
// words were there three times and the original never returned. The merge must
// arm undo with the regime bulkDeleteNotes actually ran under AND the target's
// original row to re-upsert.
check("bulkMerge reads the delete regime instead of assuming soft",
  /const \{ soft \} = await db\.bulkDeleteNotes\(/.test(panel));
check("…and arms undo with the target's original row",
  /armUndo\(`Merged \$\{picks\.length\} notes`, restOriginals, \{ soft, rewrite: \[targetOriginal\] \}\)/.test(panel));
check("runUndo re-upserts overwritten rows whichever regime the delete ran under",
  /if \(u\.rewrite\?\.length\) await db\.restoreNotes\(u\.rewrite\)/.test(panel));

console.log(`\n${failed ? `${failed} FAILURE(S)` : "NOTES ORDER SMOKE: ALL CLEAN"}`);
if (failed) { console.error("NOTES ORDER SMOKE FAILED"); process.exit(1); }
