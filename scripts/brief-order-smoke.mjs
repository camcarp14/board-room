// ─── Brief order smoke — the Brief's manual card arrangement, asserted ───────
//
// applyBriefOrder decides where every card on the landing tab appears, from a
// list of ids saved months ago on a different device. It is pure, so it is
// cheap to pin — and the two failure modes it has are both silent:
//
//  1. A LOST ARRANGEMENT. A saved order that no longer round-trips means the
//     user's Brief quietly rearranges itself on some future load. Nothing
//     errors; the tiles are just in the wrong places.
//  2. A CARD THAT VANISHES OR DUPLICATES. The function reconciles a saved id
//     list against the live card set, so a release that adds or removes a card
//     is exactly when it can drop one or emit it twice — and the render would
//     happily draw eleven cards as ten.
//
// packColumns is asserted here too because it used to be six lines inlined in
// the middle of a 700-line component, where no test could reach it.
//
// Run by `npm run verify`.

import { applyBriefOrder, orderOf, packColumns } from "../src/lib/brief-order.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const ids = (cards) => cards.map((c) => c.id).join(",");

// A stand-in for the real set: same shape, same weights, order irrelevant.
const CARDS = [
  { id: "notes", w: 3 }, { id: "minicalendar", w: 2.5 }, { id: "birthdays", w: 1.5 },
  { id: "markets", w: 2.5 }, { id: "watch", w: 3 }, { id: "wire", w: 4.5 },
  { id: "gsc", w: 2.5 }, { id: "meetings", w: 2 }, { id: "clarify", w: 1.5 },
  { id: "zts", w: 1.5 }, { id: "shopify", w: 1.5 },
];
const DEFAULT_IDS = ids(CARDS);

// ── the arrangement round-trips ──────────────────────────────────────────────
check("no saved order leaves the default arrangement alone",
  ids(applyBriefOrder(CARDS, null)) === DEFAULT_IDS);
check("an empty saved order leaves the default alone",
  ids(applyBriefOrder(CARDS, [])) === DEFAULT_IDS);

const moved = ["wire", "markets", "notes", "minicalendar", "birthdays", "watch", "gsc", "meetings", "clarify", "zts", "shopify"];
check("a saved order is applied exactly",
  ids(applyBriefOrder(CARDS, moved)) === moved.join(","));
check("applying an order is idempotent",
  ids(applyBriefOrder(applyBriefOrder(CARDS, moved), moved)) === moved.join(","));
check("orderOf round-trips through applyBriefOrder",
  ids(applyBriefOrder(CARDS, orderOf(applyBriefOrder(CARDS, moved)))) === moved.join(","));

// ── the card set is never corrupted ──────────────────────────────────────────
// Every reconciliation path has to return each card exactly once. This is the
// assertion that would catch a render drawing ten tiles where eleven exist.
const CASES = [
  ["no order", null],
  ["empty", []],
  ["full order", moved],
  ["partial order", ["wire", "notes"]],
  ["order with an unknown id", [...moved, "a-card-that-was-removed"]],
  ["order with duplicates", ["wire", "wire", "notes", "notes"]],
  ["order of only unknown ids", ["gone-1", "gone-2"]],
  ["reversed", [...DEFAULT_IDS.split(",")].reverse()],
];
for (const [label, order] of CASES) {
  const out = applyBriefOrder(CARDS, order);
  const set = new Set(out.map((c) => c.id));
  check(`every card survives: ${label}`,
    out.length === CARDS.length && set.size === CARDS.length,
    `got ${out.length} card(s), ${set.size} unique — ${ids(out)}`);
}

// ── a new card lands where it shipped, not at the top ────────────────────────
// The deliberate difference from applyNotesOrder, which puts unknowns FIRST. A
// card added by a release must not shove itself above everything the user
// arranged; it should turn up next to the neighbours it was designed beside.
const WITH_NEW = [...CARDS.slice(0, 4), { id: "brand-new", w: 2 }, ...CARDS.slice(4)];
const savedBefore = orderOf(applyBriefOrder(CARDS, moved)); // an order predating the new card
const afterUpgrade = applyBriefOrder(WITH_NEW, savedBefore);
check("an unknown card does not jump to the front", afterUpgrade[0].id !== "brand-new", ids(afterUpgrade));
check("an unknown card lands at its default index",
  afterUpgrade.findIndex((c) => c.id === "brand-new") === 4,
  `landed at ${afterUpgrade.findIndex((c) => c.id === "brand-new")} — ${ids(afterUpgrade)}`);
check("the saved arrangement survives the upgrade",
  ids(afterUpgrade).split(",").filter((i) => i !== "brand-new").join(",") === moved.join(","),
  ids(afterUpgrade));
check("a removed card leaves no hole",
  applyBriefOrder(CARDS.filter((c) => c.id !== "wire"), moved).length === CARDS.length - 1);

// ── packing ──────────────────────────────────────────────────────────────────
for (const n of [1, 2, 3]) {
  const cols = packColumns(CARDS, n);
  check(`packs into ${n} column(s)`, cols.length === n);
  check(`every card is dealt exactly once at ${n} column(s)`,
    cols.flat().length === CARDS.length && new Set(cols.flat().map((c) => c.id)).size === CARDS.length);
}
// One column must be the sequence verbatim — that IS the phone's scroll order.
check("one column preserves the sequence exactly",
  ids(packColumns(applyBriefOrder(CARDS, moved), 1)[0]) === moved.join(","));
// Within a column, sequence order holds; that is what makes a drag predictable.
for (const col of packColumns(CARDS, 3)) {
  const idxs = col.map((c) => CARDS.findIndex((x) => x.id === c.id));
  check(`column stays in sequence order (${col.map((c) => c.id).join(">")})`,
    idxs.every((v, i) => i === 0 || idxs[i - 1] < v));
}
// Greedy min-load should keep the columns within one card's weight of each other.
const loads = packColumns(CARDS, 3).map((col) => col.reduce((s, c) => s + c.w, 0));
const heaviest = Math.max(...CARDS.map((c) => c.w));
check("three columns balance to within the heaviest card",
  Math.max(...loads) - Math.min(...loads) <= heaviest,
  `loads ${loads.join(" / ")}`);
check("packing is stable for the same input",
  JSON.stringify(packColumns(CARDS, 3)) === JSON.stringify(packColumns(CARDS, 3)));
check("packColumns tolerates a nonsense column count", packColumns(CARDS, 0).length === 1);

// ── the ids are the persistence key, so they must be stable ──────────────────
// A rename resets that card to its default slot for anyone who had moved it.
// Pinning the list here makes that a deliberate decision rather than a typo.
import { readFileSync } from "node:fs";
import { BRIEF_CARDS } from "../src/lib/brief-cards.js";
const brief = readFileSync("src/pages/brief/BriefPage.jsx", "utf8");
// The card list left BriefPage for lib/brief-cards.js when the widget switches
// landed — Settings has to name the same eleven cards without importing the
// page. The ids are still what this file pins; only their address moved.
// (brief-cards-smoke.mjs is what checks the catalogue and the page's rendered
// nodes are still the same set.)
const declared = BRIEF_CARDS.map((c) => c.id);
check("the catalogue declares the expected card ids",
  declared.join(",") === DEFAULT_IDS,
  `\n  catalogue  ${declared.join(",")}\n  test       ${DEFAULT_IDS}`);
check("every card id is unique", new Set(declared).size === declared.length);
check("the order is saved under app_settings.brief_order",
  /updateSetting\?\.\("brief_order",/.test(brief));

// The Wire's feed and its packing weight have to move together — a taller card
// with a stale weight is exactly how a column ends up lopsided.
check("The Wire's feed is 480px (50% up from 320)", /maxHeight: 480/.test(brief));
const wireW = BRIEF_CARDS.find((c) => c.id === "wire")?.w;
check("The Wire's packing weight grew with it", Number(wireW) >= 4, `w: ${wireW}`);

// ── the thumb rails ──────────────────────────────────────────────────────────
// Both tall feeds are inner scrollers with `overscroll-behavior: contain`, so
// between them they can own the whole phone screen and leave no pixel that
// scrolls the PAGE. .feed-rails is the escape lane; a feed that loses its
// wrapper silently re-traps the thumb, which is invisible in a diff and
// obvious the moment you hold the phone. Pin both ends: the wrapper here, the
// geometry that makes the lane thumb-wide in the stylesheet.
const scrollers = (brief.match(/className="brief-scroll"/g) || []).length;
const railed = (brief.match(/className="feed-rails"/g) || []).length;
check("every capped feed is wrapped in a thumb rail", scrollers === 2 && railed === 2,
  `${scrollers} scroller(s), ${railed} rail wrapper(s)`);
const css = readFileSync("src/design/components.css", "utf8");
const rails = css.match(/@media \(max-width: 760px\) \{\s*\.feed-rails \{([^}]*)\}/);
check("the rails only exist on the phone", !!rails);
// 26px of rail against the card's 12px of padding = a real cost of 14px a
// side, and a lane that meets the 12px page gutter at ~38px. Both numbers
// matter: shrink the rail and the thumb misses, grow it and the headlines wrap.
check("the rail is thumb-wide and paid for by the card padding",
  /--rail: 26px/.test(rails?.[1] || "") && /margin-inline: -12px/.test(rails?.[1] || ""), rails?.[1]);
check("the feed is inset by the rail, not overlaid by it",
  /\.feed-rails > \.brief-scroll \{ margin-inline: var\(--rail\)/.test(css));

// ── the feeds behind the cards ───────────────────────────────────────────────
// Not arrangement, but the same file and the same failure shape: nothing
// throws, the card just says something untrue. Each of these was shipped.

// ONLY `stale` MEANS LAST-GOOD. The functions answer `cached: true` for a warm
// in-TTL hit and reserve `cached: true, stale: true` for the upstream-failure
// fallback (calendar.js:125 vs :144, same in markets/wire/btc). Reading either
// flag as stale swapped the Live dot for a "last good data" stamp on three of
// every four Brief refreshes — calendar caches for 20 minutes, the Brief asks
// every 5 — and told the Markets card to say "showing the last good prices"
// whenever another tab had asked a moment earlier.
check("the Brief reads only `stale` as last-good, never `cached`",
  !/\.cached\b/.test(brief) && (brief.match(/liveStatus\(!!res\.data\.stale\)/g) || []).length === 3,
  `${(brief.match(/liveStatus\(!!res\.data\.stale\)/g) || []).length} honest stamp(s), cached read: ${/\.cached\b/.test(brief)}`);
const hooks = readFileSync("src/hooks/index.js", "utf8");
check("the BTC hook reads only `stale` as last-good, never `cached`",
  /stale: !!data\.stale,/.test(hooks) && !/data\.cached/.test(hooks));

// THE MINI CALENDAR PAINTS OCCURRENCES, NOT ROWS. A repeating event is one row
// dated the day its series began, so grouping raw rows by start_time drew the
// weekly standup once, in whatever month it was created, and a four-day trip
// on its first day only. The card has to go through the same two functions the
// month grid uses — pinned here as the exact expression, and exercised below on
// a September with a Monday series (one Monday exdated) and a four-day trip, so
// the outcome is stated rather than implied.
check("the mini calendar expands occurrences with expandEvents and keys them by spanDayKeys",
  /expandEvents\(miniEvents \|\| \[\], miniFrom, miniTo\)\.forEach\(ev => \{ for \(const k of spanDayKeys\(ev\)\)/.test(brief)
  && !/localDayKey\(ev\.start_time\)/.test(brief));
import { expandEvents } from "../src/lib/recurrence.js";
import { spanDayKeys } from "../src/lib/calendar-overlays.js";
{
  const miniYear = 2026, miniMonth = 8; // September 2026 — the 7th is a Monday
  const miniEvents = [
    { id: "w", title: "Standup", start_time: "2026-06-01T14:00:00.000Z", end_time: null, all_day: false, rrule: { freq: "weekly", interval: 1, byWeekday: [1] }, exdates: ["2026-09-14"], category: "work" },
    { id: "t", title: "Trip", start_time: "2026-09-10T05:00:00.000Z", end_time: "2026-09-13T05:00:00.000Z", all_day: true, rrule: null, exdates: [], category: "personal" },
  ];
  const miniEventsByDay = {};
  const miniFrom = new Date(miniYear, miniMonth, 1), miniTo = new Date(miniYear, miniMonth + 1, 0, 23, 59);
  expandEvents(miniEvents || [], miniFrom, miniTo).forEach(ev => { for (const k of spanDayKeys(ev)) (miniEventsByDay[k] = miniEventsByDay[k] || []).push(ev); });
  const days = (title) => Object.keys(miniEventsByDay).filter((k) => miniEventsByDay[k].some((e) => e.title === title)).sort().join(",");
  check("a weekly series paints every Monday of the month it is open on, minus the exdated one",
    days("Standup") === "2026-09-07,2026-09-21,2026-09-28", days("Standup"));
  check("a four-day trip paints all four cells, not just the first",
    days("Trip") === "2026-09-10,2026-09-11,2026-09-12,2026-09-13", days("Trip"));
}

// WATCH THIS WEEK TRIGGERS ONCE PER EVENT, NOT ONCE PER PAGE LOAD. The trigger
// guard was a boolean, so a page left open through a release morning resolved
// only what had already passed at mount; every later print settled on
// "couldn't confirm the published number" when nobody had looked.
check("the econ trigger remembers ids, not a boolean",
  /econTriggered = useRef\(new Set\(\)\)/.test(brief) && !/econTriggered\.current = true/.test(brief)
  && /unresolvedPast\.filter\(\(e\) => !econTriggered\.current\.has\(eventId\(e\)\)\)/.test(brief));

// A HIDDEN TAB DOES NOT POLL. Each Brief pass is eight function invocations and
// eight usage_log rows; a Mac tab left on the Brief all day was spending ~96 of
// each an hour for nobody. The tick checks visibility; the visibilitychange
// handler is what catches up on return.
check("the Brief's 5-minute tick skips a hidden tab",
  /setInterval\(\(\) => \{ if \(document\.visibilityState !== "hidden"\) refreshBrief\(\); \}, 5 \* 60 \* 1000\)/.test(brief));
check("the Brief still refreshes on return to the tab", /addEventListener\("visibilitychange", onVisible\)/.test(brief));
check("the BTC hook's tick skips a hidden tab and catches up on return",
  /if \(document\.visibilityState !== "hidden"\) \{ lastLoad = Date\.now\(\); load\(\); \}/.test(hooks)
  && /addEventListener\("visibilitychange", onVisible\)/.test(hooks));

// A PING OF A "-background" FUNCTION IS ANSWERED BY NETLIFY, NOT THE HANDLER:
// 202 and an empty body, before the code that would say {configured:false} has
// run. pingFn parsed that empty body to null and reported "responding" with
// every key missing. Bundled through esbuild because lib/functions.js reads
// import.meta.env on load (same recipe page-render-smoke.mjs uses).
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
{
  const out = path.resolve(import.meta.dirname, "..", ".brief-order-smoke.tmp.mjs");
  await build({
    entryPoints: [path.resolve(import.meta.dirname, "..", "src", "lib", "functions.js")],
    bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error",
    define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", VITE_ANTHROPIC_API_KEY: "", DEV: false }) },
  });
  let pingFn;
  try { ({ pingFn } = await import(pathToFileURL(out).href)); } finally { await rm(out, { force: true }); }
  const realFetch = globalThis.fetch;
  const answer = (status, body) => { globalThis.fetch = async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }); };
  try {
    answer(202, ""); // what Netlify sends for econ-resolve-background
    const bg = await pingFn("econ-resolve-background");
    check("a 202 with no body is reported as accepted, and says the keys were not checked",
      bg.status === "ok" && /background/.test(bg.detail) && /not checkable/.test(bg.detail), JSON.stringify(bg));
    answer(200, JSON.stringify({ configured: false, missing: "ANTHROPIC_API_KEY" }));
    const partial = await pingFn("audit");
    check("a synchronous function's {configured:false} still reads as partial",
      partial.status === "warn" && /ANTHROPIC_API_KEY/.test(partial.detail), JSON.stringify(partial));
    answer(404, "");
    check("a 404 still reads as not deployed", (await pingFn("gone")).status === "off");
  } finally { globalThis.fetch = realFetch; }
}

console.log(failed ? `\n${failed} brief-order check(s) failed` : "\nbrief-order: all checks passed");
process.exit(failed ? 1 : 0);
