// ─── Manual note order smoke — PLANTED problems, known answers ────────────────
// The ordering is pure (src/lib/notes-order.js) because the failure modes are all
// silent: a note that vanishes from the list, a deleted id leaving a hole, or a
// drag that doesn't survive a refetch. None of those throw.
//
// The order lives in app_settings.notes_order rather than a column on
// personal_notes — no migration, and it syncs across devices for free.
//
// Run by `npm run verify`.

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

console.log(`\n${failed ? `${failed} FAILURE(S)` : "NOTES ORDER SMOKE: ALL CLEAN"}`);
if (failed) { console.error("NOTES ORDER SMOKE FAILED"); process.exit(1); }
