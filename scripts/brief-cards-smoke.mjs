// ─── Brief cards smoke — which widgets are on the page, asserted ─────────────
//
// The Brief can now be edited down: a switch per widget in Settings → Tabs and
// in the desktop Layout sheet, stored as app_settings.brief_hidden. That is a
// small feature with three silent ways to lose a card, and none of them throw:
//
//  1. A CARD WITH NO SWITCH, OR A SWITCH WITH NO CARD. The catalogue lives in
//     lib/brief-cards.js and the rendered nodes live in BriefPage.jsx. If the
//     two ever disagree, a widget either can't be turned off or — worse — is
//     listed, toggled, and never drawn. This file reads the page and compares
//     the two sets literally.
//  2. A LOST PLACE. Hide a card, rearrange the rest, switch it back on, and it
//     has to return where it was. That's mergeHiddenOrder's whole job, and its
//     failure looks like the app forgetting an arrangement months later.
//  3. A BLANK BRIEF FROM A BAD READ. brief_hidden arrives from a database row
//     written by another device and another release: null, a string, junk
//     entries. Read it wrong and the landing page renders nothing at all.
//
// Pure functions, so it runs in bare Node. Run by `npm run verify`.

import { readFileSync } from "node:fs";
import {
  BRIEF_CARDS, hiddenBriefCards, visibleBriefCards, toggleBriefCard,
  allBriefCardsHidden, mergeHiddenOrder,
} from "../src/lib/brief-cards.js";
import { applyBriefOrder, orderOf } from "../src/lib/brief-order.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const ids = (cards) => cards.map((c) => c.id).join(",");
const ALL = BRIEF_CARDS.map((c) => c.id);

// ── the catalogue itself ─────────────────────────────────────────────────────
check("every card has a unique id", new Set(ALL).size === ALL.length);
check("every card has a label and a positive weight",
  BRIEF_CARDS.every((c) => typeof c.label === "string" && c.label.trim() && Number(c.w) > 0));

// ── the catalogue and the page agree, card for card ──────────────────────────
// The page's `NODES` map is the other half of the same list. Read as text on
// purpose: importing BriefPage.jsx here would drag React, the query client and
// a dozen data modules into a smoke that exists to check two arrays match.
const pageSrc = readFileSync(new URL("../src/pages/brief/BriefPage.jsx", import.meta.url), "utf8");
const nodesBlock = pageSrc.match(/const NODES = \{([\s\S]*?)\n {2}\};/);
check("BriefPage still declares a NODES map", !!nodesBlock);
const nodeIds = nodesBlock ? [...nodesBlock[1].matchAll(/(\w+):\s*card_\w+/g)].map((m) => m[1]) : [];
check("every catalogue card has a rendered node",
  ALL.every((id) => nodeIds.includes(id)), `missing: ${ALL.filter((id) => !nodeIds.includes(id))}`);
check("every rendered node is in the catalogue (or it can never be switched off)",
  nodeIds.every((id) => ALL.includes(id)), `orphans: ${nodeIds.filter((id) => !ALL.includes(id))}`);

// The switches have to be REACHABLE FROM THE PHONE, which has no Layout button.
// This is the assertion that catches someone tidying the list out of Settings.
const settingsSrc = readFileSync(new URL("../src/shell/SettingsSheet.jsx", import.meta.url), "utf8");
check("Settings mounts the widget switches", /<BriefWidgetList/.test(settingsSrc));
const sheetSrc = readFileSync(new URL("../src/pages/brief/BriefLayoutSheet.jsx", import.meta.url), "utf8");
check("the Layout sheet mounts them too", /<BriefWidgetList/.test(sheetSrc));

// ── reading the setting can't blank the page ─────────────────────────────────
for (const [name, value] of [
  ["missing", undefined], ["null", null], ["a string", "gsc"], ["a number", 3],
  ["an object", { gsc: true }], ["an array of junk", [null, 7, {}, ""]],
]) {
  check(`brief_hidden as ${name} hides nothing`,
    visibleBriefCards(BRIEF_CARDS, hiddenBriefCards({ brief_hidden: value })).length === BRIEF_CARDS.length);
}
check("an id for a card that no longer exists is ignored",
  visibleBriefCards(BRIEF_CARDS, hiddenBriefCards({ brief_hidden: ["a-card-that-was-removed"] })).length === BRIEF_CARDS.length);

// ── hiding hides exactly what was asked for, and nothing else ────────────────
const hid2 = hiddenBriefCards({ brief_hidden: ["gsc", "wire"] });
check("hidden cards are dropped", !visibleBriefCards(BRIEF_CARDS, hid2).some((c) => c.id === "gsc" || c.id === "wire"));
check("the rest keep their glance order",
  ids(visibleBriefCards(BRIEF_CARDS, hid2)) === ALL.filter((id) => id !== "gsc" && id !== "wire").join(","));
check("nothing is duplicated by hiding",
  new Set(visibleBriefCards(BRIEF_CARDS, hid2).map((c) => c.id)).size === BRIEF_CARDS.length - 2);
check("hiding everything is allowed and reported", allBriefCardsHidden(new Set(ALL))
  && visibleBriefCards(BRIEF_CARDS, new Set(ALL)).length === 0);
check("nothing hidden is not 'all hidden'", !allBriefCardsHidden(new Set()));

// ── the switch ───────────────────────────────────────────────────────────────
const once = toggleBriefCard([], "gsc");
check("a switch off adds exactly one id", once.length === 1 && once[0] === "gsc");
check("a switch on removes it again", toggleBriefCard(once, "gsc").length === 0);
const before = ["gsc"];
toggleBriefCard(before, "wire");
check("toggling never mutates what it was given", before.length === 1 && before[0] === "gsc");
check("a write drops ids for cards that no longer exist",
  !toggleBriefCard(["a-card-that-was-removed", "gsc"], "wire").includes("a-card-that-was-removed"));
check("…while still recording the card you actually switched",
  toggleBriefCard(["a-card-that-was-removed", "gsc"], "wire").sort().join(",") === "gsc,wire");

// ── a hidden card keeps its place ────────────────────────────────────────────
// The scenario in full: an arrangement, one card put away, the rest dragged
// around, then the card switched back on. It must come back where it was.
const arrangement = ["wire", "notes", "gsc", "markets", "minicalendar", "birthdays", "watch", "meetings", "clarify", "zts", "shopify"];
const hidGsc = hiddenBriefCards({ brief_hidden: ["gsc"] });
const visible = applyBriefOrder(visibleBriefCards(BRIEF_CARDS, hidGsc), arrangement);
check("the visible cards follow the saved arrangement",
  ids(visible) === arrangement.filter((id) => id !== "gsc").join(","));
const dragged = orderOf(visible);
const saved = mergeHiddenOrder(dragged, arrangement, hidGsc);
check("the hidden card survives a drag of the others", saved.includes("gsc"));
check("…directly after the neighbour it had", saved[saved.indexOf("notes") + 1] === "gsc");
check("switching it back on restores its place",
  ids(applyBriefOrder(BRIEF_CARDS, saved)) === arrangement.join(","));

// A run of hidden cards keeps its own sequence rather than reversing.
const runHidden = hiddenBriefCards({ brief_hidden: ["gsc", "meetings"] });
const runPrev = ["notes", "gsc", "meetings", "wire"];
const runSaved = mergeHiddenOrder(["wire", "notes"], runPrev, runHidden);
check("a run of hidden cards keeps its order", runSaved.join(",") === "wire,notes,gsc,meetings");
check("a hidden card with nothing before it lands first",
  mergeHiddenOrder(["notes"], ["gsc", "notes"], hidGsc).join(",") === "gsc,notes");
check("a hidden card the old order never listed stays out",
  !mergeHiddenOrder(["notes", "wire"], ["notes", "wire"], hidGsc).includes("gsc"));
check("no saved order means nothing to preserve",
  mergeHiddenOrder(["notes", "wire"], null, hidGsc).join(",") === "notes,wire");
check("a duplicate in the drag is collapsed",
  mergeHiddenOrder(["notes", "notes", "wire"], null, new Set()).join(",") === "notes,wire");

// ── the invariant, over every single-card hide ───────────────────────────────
// Whatever is hidden, the render must draw each remaining card exactly once and
// the saved order must round-trip through a drag.
for (const id of ALL) {
  const h = hiddenBriefCards({ brief_hidden: [id] });
  const shown = applyBriefOrder(visibleBriefCards(BRIEF_CARDS, h), arrangement);
  const unique = new Set(shown.map((c) => c.id));
  const ok = shown.length === BRIEF_CARDS.length - 1 && unique.size === shown.length && !unique.has(id);
  const round = mergeHiddenOrder(orderOf(shown), arrangement, h);
  check(`hiding ${id} draws every other card exactly once and keeps its place`,
    ok && new Set(round).size === BRIEF_CARDS.length && round.length === BRIEF_CARDS.length);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll brief-card checks passed");
process.exit(failed ? 1 : 0);
