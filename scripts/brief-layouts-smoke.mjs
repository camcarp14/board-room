// ─── Brief layout profiles: the arithmetic a saved layout depends on ─────────
// The schema under test is LIVE — boardroom.app_settings already holds real
// brief_layouts rows written by the production build this lib restores. These
// fixtures mirror that stored shape (string `columns`, numeric layoutColumns,
// authored uneven columnLayout), so a change that breaks a real saved profile
// breaks here first.
import {
  activeLayout, layoutColumnCount, defaultColumnCount,
  dealExplicit, explicitFlatOrder, addLayout, removeLayout, moveCard, setLayoutColumns,
} from "../src/lib/brief-layouts.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`ok: ${label}`);
  else { failed++; console.log(`FAIL: ${label}${detail ? ` ${detail}` : ""}`); }
};

const CARDS = [
  { id: "notes", w: 3 }, { id: "minicalendar", w: 2.5 }, { id: "birthdays", w: 1.5 },
  { id: "markets", w: 2.5 }, { id: "watch", w: 3 }, { id: "wire", w: 4.5 },
];

// The stored shape, verbatim from a production row: columns as a STRING,
// layoutColumns numeric, columns of uneven length.
const MAC = {
  id: "brief-mac", name: "Mac",
  order: ["minicalendar", "markets", "notes", "birthdays", "watch", "wire"],
  columns: "3",
  columnLayout: [["minicalendar", "markets"], ["notes", "birthdays"], ["watch", "wire"]],
  layoutColumns: 3,
};
const SETTINGS = { brief_layouts: [MAC], brief_active_layout: "brief-mac", brief_columns: 3 };

// ── resolution ───────────────────────────────────────────────────────────────
check("active profile resolves by id", activeLayout(SETTINGS)?.name === "Mac");
check("'default' resolves to null", activeLayout({ ...SETTINGS, brief_active_layout: "default" }) === null);
check("a dangling id resolves to null (deleted profile, stale pointer)",
  activeLayout({ ...SETTINGS, brief_active_layout: "brief-gone" }) === null);
check("column count prefers layoutColumns", layoutColumnCount(MAC) === 3);
check("string `columns` alone still counts", layoutColumnCount({ columns: "2", columnLayout: [[], [], []] }) === 2);
check("garbage counts fall back to the array", layoutColumnCount({ columns: "nine", columnLayout: [[], []] }) === 2);
check("brief_columns override wins for the default arrangement", defaultColumnCount({ brief_columns: 3 }, 2) === 3);
check("a missing override keeps the responsive fallback", defaultColumnCount({}, 2) === 2);

// ── dealing ──────────────────────────────────────────────────────────────────
const dealt = dealExplicit(CARDS, MAC, 3);
check("authored columns deal as authored",
  dealt[0].map(c => c.id).join(",") === "minicalendar,markets" &&
  dealt[1].map(c => c.id).join(",") === "notes,birthdays");
check("every card renders exactly once", dealt.flat().length === CARDS.length &&
  new Set(dealt.flat().map(c => c.id)).size === CARDS.length);

const withNew = [...CARDS, { id: "ponder", w: 2 }];
const dealtNew = dealExplicit(withNew, MAC, 3);
check("a card the profile never met still lands somewhere", dealtNew.flat().some(c => c.id === "ponder"));
check("…and joins the shortest column, not blindly the last",
  dealtNew[1].some(c => c.id === "ponder"), JSON.stringify(dealtNew.map(col => col.map(c => c.id))));

const folded = dealExplicit(CARDS, MAC, 2);
check("a 3-column profile folds into 2 without losing a card", folded.flat().length === CARDS.length);
check("ids for cards that no longer exist are skipped",
  dealExplicit(CARDS.slice(0, 2), MAC, 3).flat().length === 2);
check("duplicate ids in a stored layout render once",
  dealExplicit(CARDS, { ...MAC, columnLayout: [["notes", "notes"], ["notes"], []] }, 3)
    .flat().filter(c => c.id === "notes").length === 1);
check("the phone's flat order reads the columns left to right",
  explicitFlatOrder(CARDS, MAC).map(c => c.id).join(",") === "minicalendar,markets,notes,birthdays,watch,wire");

// ── editing ──────────────────────────────────────────────────────────────────
const movedRight = moveCard(MAC, "notes", "right");
check("right moves a card to the next column", movedRight.columnLayout[2].includes("notes"));
check("…and the flat order follows", movedRight.order.join(",") !== MAC.order.join(","));
check("moving keeps counts coherent", movedRight.layoutColumns === 3 && movedRight.columns === "3");
check("an impossible move is a no-op (same object)", moveCard(MAC, "minicalendar", "up") === MAC);
check("moving an unknown card is a no-op", moveCard(MAC, "ghost", "left") === MAC);
const movedDown = moveCard(MAC, "minicalendar", "down");
check("down swaps within the column", movedDown.columnLayout[0].join(",") === "markets,minicalendar");

const shrunk = setLayoutColumns(MAC, 2);
check("shrinking folds the tail column in, losing nothing",
  shrunk.layoutColumns === 2 && shrunk.columnLayout.flat().length === 6);
const grown = setLayoutColumns(shrunk, 3);
check("growing back yields the requested count", grown.layoutColumns === 3 && grown.columnLayout.length === 3);

const { layouts: added, id: newId } = addLayout([MAC], { name: "iPhone", columns: [[{ id: "notes" }], [{ id: "wire" }]] });
check("a new profile duplicates the given columns", added.length === 2 &&
  added[1].columnLayout[0].join(",") === "notes" && added[1].layoutColumns === 2 && added[1].id === newId);
check("removeLayout removes exactly the one", removeLayout(added, newId).length === 1);

if (failed) { console.log(`\n${failed} brief-layout check(s) failed`); process.exit(1); }
console.log("\nBRIEF LAYOUTS SMOKE PASS");
