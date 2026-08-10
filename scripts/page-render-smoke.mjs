// ─── Page render smoke — the components, at a frozen clock, in four states ────
//
// Every other smoke in this directory tests a pure function. That is where the
// arithmetic lives, so that is where most of the assertions belong — but it is
// not where the app lies. A screener's hit rate is computed in stock-scan.js and
// PRINTED in RecordCard.jsx, and the two failures that shipped were both in the
// printing: a green em-dash on a median nobody measured, and a confident board
// of prices left on screen by a refresh that had failed. Neither function was
// wrong. Nothing in the suite executed the component that was.
//
// So this renders the real components, to a string, under a real
// QueryClientProvider, in the four states a query can actually be in — loading,
// empty, loaded, error — and asserts HONESTY rather than markup. There are no
// snapshots here on purpose: a snapshot fails on every deliberate design change
// and passes on every lie that keeps the same shape, which is exactly backwards
// for this app. What is asserted instead is the four house rules that a card can
// break without anyone noticing:
//
//   1. A card whose query is in `error` never renders a number. A figure on
//      screen is a claim that somebody measured it.
//   2. A "Live" / fresh label never renders over a query in error, or over data
//      the source did not refresh. The pill answers "is what I am reading
//      current", and it is worse than useless when it answers wrong.
//   3. An empty list renders a designed empty state, not blank space. A blank
//      card reads as a broken tool, and the reader cannot tell which it is.
//   4. A loading state renders a skeleton, not a zero. "0 flags" before the
//      first read is a number the app invented.
//
// THE CLOCK IS FROZEN AND THE ZONE IS PINNED. Half of these components read
// `new Date()` during render — the Docket greets you by time of day, works out
// which events are today, and counts what is overdue — so without a fixed clock
// this file would pass all day and fail at midnight, in whatever zone the
// machine happens to be in. Chicago, because that is the zone every other date
// path in the app is written for (see lib/dates.js, trmnl.js, note-capture.js).
//
// NOTHING HERE TOUCHES THE NETWORK, and that is enforced rather than promised:
// `fetch` is replaced with a stub that throws and counts, and the last check in
// the file asserts the count is zero. The four states are staged by priming the
// query cache directly, so no queryFn ever runs.
//
// WHAT IS NOT COVERED IS PRINTED, EVERY RUN. A component this file cannot render
// server-side is listed with the reason, because a harness that quietly renders
// three of thirty panels and reports "all checks passed" is the same class of
// lie it exists to catch.
//
//   node scripts/page-render-smoke.mjs
//
// This file is its own esbuild wrapper — the components are JSX and bare Node
// cannot load them. scripts/render-smoke.mjs is where that trick came from; the
// only difference is that the entry point here is this same file, re-entered
// with BR_PAGE_RENDER_BUNDLED set, so the harness and its fixtures stay in one
// place instead of being split across a wrapper and a body.

import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Set before the first Date is constructed anywhere in the process.
process.env.TZ = "America/Chicago";

const REENTRY = "BR_PAGE_RENDER_BUNDLED";

if (process.env[REENTRY] !== "1") {
  const root = path.resolve(import.meta.dirname, "..");
  const out = path.join(root, ".page-render-smoke.tmp.mjs");
  await build({
    entryPoints: [path.join(root, "scripts", "page-render-smoke.mjs")],
    bundle: true, platform: "node", format: "esm", outfile: out,
    loader: { ".jsx": "jsx" }, jsx: "automatic",
    // React and TanStack stay external so the components and this harness share
    // one copy of each. Two copies of react-dom would render, and two copies of
    // @tanstack/react-query would give the provider a cache the hooks can't see —
    // every query would read as loading and every assertion below would pass for
    // the wrong reason.
    external: ["react", "react-dom", "react-dom/server", "@tanstack/react-query", "esbuild"],
    define: {
      "import.meta.env": JSON.stringify({
        VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", VITE_ANTHROPIC_API_KEY: "", DEV: false,
      }),
    },
    logLevel: "error",
  });
  process.env[REENTRY] = "1";
  try {
    await import(pathToFileURL(out).href);
  } finally {
    await rm(out, { force: true });
  }
} else {
  await harness();
}

async function harness() {
  // ── the frozen clock ───────────────────────────────────────────────────────
  // Monday 10 Aug 2026, 09:15 Central. A weekday morning is the state the Docket
  // is read in, and picking a Monday puts the fixtures in the middle of a trip
  // that began on the Saturday — so the "Day 3/4" span arithmetic, the morning
  // greeting and the market-is-shut branches are all the ones that ship.
  const NOW = Date.parse("2026-08-10T09:15:00-05:00");
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  globalThis.Date = FrozenDate;

  // ── the network, closed ────────────────────────────────────────────────────
  // A render smoke that can reach the internet is one bad `useEffect` away from
  // spending money on a build. The stub counts as well as throws, because a
  // caller with a catch around it would otherwise swallow the evidence.
  const fetchCalls = [];
  globalThis.fetch = (...a) => {
    fetchCalls.push(String(a[0]));
    throw new Error("page-render-smoke: fetch is closed — this suite never touches the network");
  };

  let failed = 0;
  const check = (name, cond, detail = "") => {
    if (cond) console.log(`ok: ${name}`);
    else { failed++; console.error(`FAIL: ${name} ${detail}`); }
  };
  // Printed, never silent. See the header: a component this harness cannot
  // render is a hole in the coverage, and a hole nobody reads about is the same
  // as no harness at all.
  const skips = [];
  const skip = (what, why) => skips.push([what, why]);
  // A real honesty gap found while writing these fixtures that lives in a file
  // this smoke is not allowed to change. Asserting it would fail the build for
  // something no edit here can fix, and dropping it would lose it — so it is
  // printed alongside the passes and carried in the commit message.
  const notes = [];
  const note = (what, why) => notes.push([what, why]);

  // The specifiers are written out as literals because esbuild has to see each
  // one to inline it into the bundle — a computed path would be left as a runtime
  // import of a .jsx file bare Node cannot load. Import failures are reported
  // rather than thrown: one module with a bad top-level side effect should not
  // take the checks for the other seven with it.
  const M = {};
  for (const [name, load] of [
    ["DocketCard", () => import("../src/pages/brief/DocketCard.jsx")],
    ["TopStatus", () => import("../src/shell/TopStatus.jsx")],
    ["RecordCard", () => import("../src/pages/markets/RecordCard.jsx")],
    ["shared", () => import("../src/ui/shared.jsx")],
    ["CryptoPanel", () => import("../src/pages/markets/CryptoPanel.jsx")],
    ["StocksPanel", () => import("../src/pages/markets/StocksPanel.jsx")],
    ["AltSeasonPanel", () => import("../src/pages/markets/AltSeasonPanel.jsx")],
    ["ScoreCard", () => import("../src/pages/markets/ScoreCard.jsx")],
    ["kit", () => import("../src/ui/kit.jsx")],
    ["primitives", () => import("../src/ui/primitives.jsx")],
  ]) {
    try { M[name] = await load(); }
    catch (e) { failed++; console.error(`FAIL: ${name} did not even import\n      ${e.message}`); }
  }

  // ── staging a state ────────────────────────────────────────────────────────
  // `seed` is a list of [queryKey, value] to write straight into the cache, and
  // `broken` a list of keys to leave in `error`. A rejecting queryFn is run
  // through the real cache (see breakQuery) so the error is a real error on a
  // real entry — the component's own useQuery then finds it by key and reads
  // status "error", exactly as it would after a failed read in the browser.
  // Nothing here fabricates a result object, so a change in how TanStack reports
  // failure cannot make these checks quietly pass.
  // retryOnMount:false IS LOAD-BEARING, and it took a wrong pass of this file to
  // find out why. TanStack's getOptimisticResult() rewrites an errored, data-less
  // query back to `{ status: "pending", error: null }` whenever the observer
  // would fetch on mount — which is truthful in the browser (that is the one
  // frame before the retry lands) and useless here, because every "a failed read
  // renders X" check would have been asserting the skeleton instead. Turning the
  // mount retry off is what makes the render the SETTLED state rather than the
  // frame in front of it. staleTime Infinity keeps the seeded caches from being
  // treated as refetchable for the same reason.
  const stage = async ({ seed = [], broken = [] } = {}) => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity, networkMode: "always" },
      },
    });
    for (const [key, value] of seed) qc.setQueryData(key, value);
    for (const [key, message] of broken) await breakQuery(qc, key, message);
    return qc;
  };
  // Put one key into `error` for real. staleTime 0 is required on the fetch
  // itself: fetchQuery returns the cached value without calling the queryFn when
  // the entry is still fresh, so under the Infinity default above a "broken"
  // query that already holds seeded data would have quietly stayed successful —
  // which is exactly the state the failed-refresh checks below need to produce.
  const breakQuery = (qc, key, message) => qc.fetchQuery({
    queryKey: key, queryFn: () => Promise.reject(new Error(message)), retry: false, staleTime: 0,
  }).catch(() => {});
  const draw = (qc, el) => renderToString(React.createElement(QueryClientProvider, { client: qc }, el));

  // ── staging a state that only a tap can otherwise reach ────────────────────
  // Some of what a panel says lives behind a control. CryptoPanel's explanation
  // of the pending 4h/12h windows renders only while the board is SORTED by one
  // of them, and `sort` is a useState inside the component — there is no prop for
  // it, and renderToString dispatches no events, so from the outside that
  // sentence is unreachable. That is exactly how its check came to be written as
  // a disjunction that asserted nothing: the state it was about was never staged.
  //
  // What makes it reachable: React resolves every hook through
  // ReactCurrentDispatcher, and the server renderer writes that slot on each
  // render. So for exactly one render, a useState whose initial value is `from`
  // is answered with `to`. This is the component's OWN state hook, seeded — not a
  // fabricated result object, which is the same distinction the note above
  // `stage` draws about query state.
  //
  // THE SEED IS COUNTED AND EVERY CALLER ASSERTS THE COUNT. A seeder that
  // silently stopped matching would turn its check back into a check of the
  // DEFAULT state, quietly, which is the failure this whole file is being edited
  // for. The dispatcher is COPIED rather than mutated: react-dom hands the same
  // object to every render in the process, so writing onto it would leak this
  // seed into every check below it.
  const drawSeeded = (qc, el, from, to) => {
    const slot = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher;
    if (!slot) return { html: "", seeded: 0 };
    const original = Object.getOwnPropertyDescriptor(slot, "current");
    let live = slot.current, seeded = 0;
    Object.defineProperty(slot, "current", {
      configurable: true,
      get: () => live,
      set: (d) => {
        live = d && typeof d.useState === "function"
          ? { ...d, useState: (init) => (init === from ? (seeded++, d.useState(to)) : d.useState(init)) }
          : d;
      },
    });
    try { return { html: draw(qc, el), seeded }; }
    finally { Object.defineProperty(slot, "current", original); }
  };

  // ── reading the html ───────────────────────────────────────────────────────
  // THE HOUSE HAS ONE VOICE FOR NUMBERS: .t-num, plus the StatTile's own value
  // and delta spans. Testing for that rather than "does a digit appear anywhere"
  // is what keeps these checks honest in both directions. A digit inside an
  // error string is not a claim about the market — "HTTP 502" has to be allowed
  // to render — while a figure set in the number voice IS the claim, and is the
  // thing that must not appear over data nobody has.
  const NUMBER_VOICE = /class="(?:[^"]*\bt-num\b[^"]*|stattile-value|stattile-delta)"/;
  const numbersIn = (html) => NUMBER_VOICE.test(html);
  const SKELETON = /class="sk(?:[ "])/;
  // Tags and comments come out to NOTHING, not to a space, and both halves of
  // that matter. React separates adjacent text children with <!-- -->, so "46%"
  // arrives as "46<!-- -->%"; and a figure over its denominator is written
  // `<span>{points}</span>/{max}`, so replacing the closing tag with a space
  // turns "12/20" into "12 /20". Either way the assertion would be testing the
  // renderer's node boundaries rather than the sentence on screen. Dropping both
  // reassembles the sentence: every phrase checked below lives in one string
  // literal or one template in the source, spaces included.
  const text = (html) => html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&#x2F;/g, "/").replace(/&quot;/g, '"')
    .replace(/[ \t\n]+/g, " ")
    .trim();
  // One card out of a panel, by the heading it is drawn under. The market panels
  // stack several cards with different feeds behind them, so "this panel renders
  // no number" is too coarse a question to ask — the BTC hero on the Crypto tab
  // is fed by a prop, not by the query under test, and it is right for it to
  // keep printing a price while the scan is down.
  const card = (html, heading, until) => {
    const from = html.indexOf(`>${heading}<`);
    if (from < 0) return "";
    const end = until ? html.indexOf(`>${until}<`, from) : -1;
    return html.slice(from, end < 0 ? html.length : end);
  };
  // One Record tile, by its label: the figure and the colour it is drawn in.
  // RecordCard's own comment is the reason this exists — `null >= 0` is true, so
  // an unmeasured median once rendered GREEN, a positive colour on a statistic
  // nobody computed. The value div has to be matched directly rather than by
  // scanning backwards for the nearest `color:`, because the label div carries
  // one of its own and it sits between them.
  const tile = (html, label) => {
    const m = new RegExp(`<div class="t-num" style="([^"]*)">([^<]*)</div><div class="t-cap" style="[^"]*">${label}</div>`).exec(html);
    if (!m) return { tone: null, value: null };
    const c = /color:\s*([^;"]+)/.exec(m[1]);
    return { tone: c ? c[1].trim() : null, value: m[2].trim() };
  };

  // ══ 1. TopStatus — the freshness pill and the unsaved chip ═════════════════
  // The pill is the app's single answer to "is this current", it sits on every
  // screen, and it is read without being looked at. There is no state in which
  // it may say "Live" over anything but data from the last sixty seconds.
  if (M.TopStatus) {
    const { TopStatus, WriteFailures } = M.TopStatus;
    const top = async (props, ctx) => {
      const qc = await stage();
      const el = React.createElement(TopStatus, { now: NOW, ...props });
      return draw(qc, ctx ? React.createElement(WriteFailures.Provider, { value: ctx }, el) : el);
    };

    const noData = await top({ dataStamp: null });
    check("TopStatus · no data yet reads em-dash, never Live", !noData.includes("Live") && noData.includes("—"),
      `got ${JSON.stringify(text(noData))}`);
    check("TopStatus · no data yet gets no pulse", !noData.includes("pulse"));

    const live = await top({ dataStamp: NOW - 20_000 });
    check("TopStatus · a 20-second-old read is Live, and pulses", live.includes("Live") && live.includes("pulse"));

    const stale = await top({ dataStamp: NOW - 45 * 60_000 });
    check("TopStatus · 45-minute-old data says 45m and never Live", stale.includes("45m") && !stale.includes("Live"),
      `got ${JSON.stringify(text(stale))}`);
    check("TopStatus · 45-minute-old data does not pulse", !stale.includes("pulse"));
    check("TopStatus · 45-minute-old data is not drawn green", !stale.includes("var(--green)"));

    const old = await top({ dataStamp: NOW - 3 * 3600_000 });
    check("TopStatus · three-hour-old data says 3h in red", old.includes("3h") && old.includes("var(--red)") && !old.includes("Live"));

    const clean = await top({ dataStamp: NOW }, { failed: [], retrying: false, onRetry: null });
    check("TopStatus · no failed writes draws no chip", !clean.includes("unsaved"));

    const unsaved = await top({ dataStamp: NOW }, {
      failed: [{ key: "setting:budgets", label: "budgets" }, { key: "setting:finance_rules", label: "finance rules" }],
      retrying: false, onRetry: () => {},
    });
    check("TopStatus · two failed writes draw a red 2 unsaved chip",
      unsaved.includes("2 unsaved") && unsaved.includes("var(--red)"));
    check("TopStatus · the chip names what didn't save",
      unsaved.includes("budgets, finance rules"), `got ${JSON.stringify(text(unsaved))}`);
    // The chip is the only place a failed write is ever visible. A retry in
    // flight must not read as "still unsaved, tap me" — it has already been
    // tapped — and it must not read as saved either.
    const retrying = await top({ dataStamp: NOW }, {
      failed: [{ key: "setting:budgets", label: "budgets" }], retrying: true, onRetry: () => {},
    });
    check("TopStatus · a retry in flight says Retrying, and stays red",
      retrying.includes("Retrying") && retrying.includes("var(--red)") && !retrying.includes("1 unsaved"));
  }

  // ══ 2. StatusTag — the component that draws the word "Live" ════════════════
  // Every market card hands its freshness through here, so this is where rule 2
  // is actually enforced. `stale` means the function served its last-good value
  // because the upstream did not answer, and the honest answer to that is WHEN
  // the data is from — never the word Live, and never a bare label.
  if (M.shared) {
    const { StatusTag } = M.shared;
    const tag = async (status) => draw(await stage(), React.createElement(StatusTag, { status }));

    check("StatusTag · a live feed says Live", (await tag({ state: "live" })).includes("Live"));
    const err = await tag({ state: "error", detail: "HTTP 502" });
    check("StatusTag · an errored feed says Error, never Live", err.includes("Error") && !err.includes("Live"));

    const served = await tag({ state: "live", stale: true, at: new FrozenDate(NOW - 90 * 60_000).toISOString() });
    check("StatusTag · last-good data timestamps itself instead of saying Live",
      !served.includes("Live") && served.includes("CT"), `got ${JSON.stringify(text(served))}`);
    const yesterday = await tag({ state: "live", stale: true, at: new FrozenDate(NOW - 26 * 3600_000).toISOString() });
    check("StatusTag · yesterday's data cannot be mistaken for a time today",
      yesterday.includes("yesterday") && !yesterday.includes("Live"), `got ${JSON.stringify(text(yesterday))}`);
    check("StatusTag · last-good data with no stamp says nothing at all",
      (await tag({ state: "live", stale: true, at: null })) === "");
    check("StatusTag · an unreadable stamp says nothing, never Invalid Date",
      (await tag({ state: "live", stale: true, at: "whenever" })) === "");
  }

  // ══ 3. DocketCard — the top of the Brief, in all four states ═══════════════
  // Two queries behind one card (events + upkeep), which is what makes it the
  // right first target: the card has to be honest about a partial read as well
  // as a total one.
  if (M.DocketCard) {
    const { DocketCard } = M.DocketCard;
    const EVENTS = ["events"], UPKEEP = ["upkeep"];
    // 09:00 and 15:30 Central on the frozen day, plus a four-day trip that
    // started on the Saturday — the multi-day case that used to vanish after its
    // first day.
    const events = [
      { id: "e1", title: "Board sync", start_time: "2026-08-10T14:00:00.000Z", end_time: "2026-08-10T14:30:00.000Z", all_day: false, location: "Zoom", category: "work", rrule: null, exdates: [] },
      { id: "e2", title: "Dentist", start_time: "2026-08-10T20:30:00.000Z", end_time: null, all_day: false, location: "", category: "personal", rrule: null, exdates: [] },
      { id: "e3", title: "Austin trip", start_time: "2026-08-08T12:00:00.000Z", end_time: "2026-08-11T22:00:00.000Z", all_day: true, location: "Austin", category: "personal", rrule: null, exdates: [] },
    ];
    // Due 30 Jun, so 41 days past due on the frozen day. The second is fresh and
    // must not appear at all.
    const upkeep = [
      { id: "u1", name: "Furnace filter", interval_days: 90, last_done: "2026-04-01", notes: "" },
      { id: "u2", name: "Gutters", interval_days: 180, last_done: "2026-08-01", notes: "" },
    ];
    const props = {
      isMobile: true,
      birthdays: [{ id: "b1", name: "Mom", month: 8, day: 10 }],
      macroEvents: [{ id: "m1", isPast: false, time: "7:30", text: "Core CPI m/m — forecast 0.3%" }],
      settings: { mini_tasks: [{ status: "queued" }, { status: "queued" }, { status: "delivered" }] },
      onOpenCalendar: () => {}, onOpenQueue: () => {}, onOpenBirthdays: () => {},
    };
    const docket = async (opts) => draw(await stage(opts), React.createElement(DocketCard, props));

    // loading — nothing in the cache, so both queries are pending
    const loading = await docket({});
    check("Docket · loading draws a skeleton", SKELETON.test(loading));
    check("Docket · loading says it is still working", loading.includes("Pulling the day together"));
    // The rule this pins: a card that has read nothing may not summarise
    // anything. "0 on the calendar" is a number the app made up.
    check("Docket · loading counts nothing",
      !/on the calendar|upkeep item|birthday/.test(text(loading)), `got ${JSON.stringify(text(loading))}`);
    check("Docket · loading does not claim a clear day", !loading.includes("Clear slate"));

    // empty — both reads succeeded and there is genuinely nothing
    const empty = await stage({ seed: [[EVENTS, []], [UPKEEP, []]] });
    const emptyHtml = draw(empty, React.createElement(DocketCard, { ...props, birthdays: [], macroEvents: [], settings: {} }));
    check("Docket · an empty day draws a designed empty state, not blank space",
      emptyHtml.includes("Clear slate — nothing on the books"), `got ${JSON.stringify(text(emptyHtml))}`);
    check("Docket · an empty day is not a skeleton", !SKELETON.test(emptyHtml));

    // loaded
    const loaded = await docket({ seed: [[EVENTS, events], [UPKEEP, upkeep]] });
    const loadedText = text(loaded);
    check("Docket · loaded greets the morning", loadedText.includes("Good morning, Cameron."), `got ${JSON.stringify(loadedText.slice(0, 80))}`);
    check("Docket · loaded counts the day it actually read",
      loadedText.includes("3 on the calendar") && loadedText.includes("1 upkeep item due") && loadedText.includes("1 birthday this week"),
      `got ${JSON.stringify(loadedText.slice(0, 240))}`);
    check("Docket · a multi-day trip says which day of it today is", loadedText.includes("Day 3/4"),
      `got ${JSON.stringify(loadedText.slice(0, 320))}`);
    check("Docket · an overdue upkeep item says how far past due", loadedText.includes("41 days past due"));
    check("Docket · fresh upkeep stays off the card", !loadedText.includes("Gutters"));
    check("Docket · the queue count is the queued tasks only", loadedText.includes("2 tasks waiting"));

    // error — both reads failed
    const broke = await docket({ broken: [[EVENTS, "PGRST301 JWT expired"], [UPKEEP, "PGRST301 JWT expired"]] });
    const brokeText = text(broke);
    // RULE 1. There is nothing to count, so nothing may be counted — not even
    // zero, and not by omission.
    check("Docket · a failed read counts nothing",
      !/on the calendar|upkeep item due/.test(brokeText), `got ${JSON.stringify(brokeText.slice(0, 240))}`);
    check("Docket · a failed read is not dressed as a skeleton", !SKELETON.test(broke));
    check("Docket · a failed read still renders the card rather than crashing", broke.includes("The Docket"));
    // RULE 2. And it must not offer the empty state instead. This card used to
    // say "Clear slate — nothing on the books. Set the agenda yourself." with both
    // reads in error, which is a sentence you act on — you go and do something
    // else, having been told the calendar was empty by a card that never saw it.
    check("Docket · a failed read is never dressed as a clear day",
      !/Clear slate/.test(brokeText), `got ${JSON.stringify(brokeText.slice(0, 240))}`);
    check("Docket · a failed read says which read failed",
      /couldn't reach/i.test(brokeText) && /calendar/.test(brokeText) && /upkeep/.test(brokeText),
      `got ${JSON.stringify(brokeText.slice(0, 240))}`);

    // A PARTIAL READ IS THE COMMON ONE. Two independent queries fail
    // independently, so the state that actually reaches the phone is one feed
    // down and one feed up — and a card that drops the working half is as
    // misleading as one that invents the broken half.
    const half = await docket({ seed: [[EVENTS, events]], broken: [[UPKEEP, "upkeep_items 42P01"]] });
    const halfText = text(half);
    check("Docket · one feed down still reports the feed that answered",
      halfText.includes("3 on the calendar"), `got ${JSON.stringify(halfText.slice(0, 240))}`);
    check("Docket · one feed down invents nothing for the feed that didn't",
      !halfText.includes("upkeep item") && !halfText.includes("Furnace filter"));
  }

  // ══ 4. RecordCard — the only card allowed to say "trust this" ══════════════
  if (M.RecordCard) {
    const RecordCard = M.RecordCard.default;
    const rec = async (stats, recent) => draw(await stage(), React.createElement(RecordCard, {
      stats, recent, noun: "flags", collapseProps: { id: "record", collapsed: false, onToggle: () => {} },
    }));

    const none = await rec(null, null);
    check("Record · no stats draws the designed empty state", none.includes('class="empty"') && none.includes("Not enough graded yet"));
    check("Record · no stats prints no rate", !/\d+%/.test(text(none)), `got ${JSON.stringify(text(none))}`);

    // The engines refuse to compute a rate under three resolved episodes. The
    // card has to refuse to imply one — including from the counts it DOES have.
    const thin = await rec({ total: 12, open: 2, resolved: 2, hitT1: 1, hitT1Rate: null, form: [] }, null);
    check("Record · a two-episode log prints no rate", !/\d+%/.test(text(thin)), `got ${JSON.stringify(text(thin))}`);
    check("Record · a two-episode log still says how many flags it has", text(thin).includes("12 flags"));

    const stats = {
      total: 30, open: 6, resolved: 24,
      hitT1: 11, hitT2: 5, hitT3: 1, faded: 8, expired: 2, invalidated: 3, roundTrip: 4,
      hitT1Rate: 45.8, medianPeakPct: 6.4, medianHeldDays: 5.2,
      best: { symbol: "NVDA", pct: 31.2 }, worst: { symbol: "BA", pct: -9.4 },
      form: [
        { symbol: "NVDA", status: "hit_t2" }, { symbol: "BA", status: "invalidated" },
        { symbol: "AMD", status: "faded" }, { symbol: "XOM", status: "hit_t1" },
      ],
    };
    const full = await rec(stats, [{ id: "f1", symbol: "NVDA", status: "hit_t2", firstFlaggedAt: "2026-07-20T00:00:00Z", resolvedAt: "2026-07-27T00:00:00Z", peakPct: 12.4 }]);
    const fullText = text(full);
    check("Record · a graded log prints the rate with its denominator",
      fullText.includes("46%") && fullText.includes("of 24 closed flags reached their first target"),
      `got ${JSON.stringify(fullText.slice(0, 260))}`);
    // The bar's widths only mean anything if every closed episode lands in
    // exactly one segment. Fold an open flag into the green side and the picture
    // overstates by however many are running today, with nothing on screen to
    // say so — so the legend counts are read back off the card and made to sum
    // to the denominator the card printed one line above them.
    const legend = [...full.replace(/<!--[\s\S]*?-->/g, "").matchAll(/(\d+)<\/span>\s*(Hit T3|Hit T2|Hit T1|Faded|Expired|Stopped)/g)];
    const legendSum = legend.reduce((s, m) => s + Number(m[1]), 0);
    check("Record · the outcome bar partitions every closed flag, exactly once",
      legend.length === 6 && legendSum === stats.resolved,
      `${legend.length} segments summing to ${legendSum}, resolved is ${stats.resolved}`);
    check("Record · the round-trip asterisk is printed", fullText.includes("hit their target and then lost the level"));
    check("Record · the open flags are reported beside the rate, not inside it", fullText.includes("30 flags · 6 open"));

    // THE BUG THIS CARD ALREADY SHIPPED ONCE. `null >= 0` is true, so an
    // unmeasured median was drawn in green — a positive colour on a statistic
    // nobody computed, in the one card whose job is not overstating.
    const unmeasured = await rec({ ...stats, medianPeakPct: null, medianHeldDays: null, best: null, worst: null }, null);
    const peakAbsent = tile(unmeasured, "median peak");
    check("Record · an unmeasured median peak renders an em-dash", peakAbsent.value === "—", `got ${JSON.stringify(peakAbsent.value)}`);
    check("Record · an unmeasured median peak has no tone", peakAbsent.tone === "var(--faint)", `got ${peakAbsent.tone}`);
    const peakDown = tile(await rec({ ...stats, medianPeakPct: -3.1 }, null), "median peak");
    check("Record · a measured negative median peak is red and signed",
      peakDown.tone === "var(--red)" && peakDown.value === "-3.1%", `got ${JSON.stringify(peakDown)}`);
    check("Record · an unmeasured median hold renders an em-dash", tile(unmeasured, "median hold").value === "—");
    // Same absence, one tile over, still coloured. flagStats fills `best` from
    // the same `peaks` array medianPeakPct is computed from, so the two are null
    // together — which means the fixture above is not hypothetical: it is what
    // the card draws for a log whose rows carry no peak price.
    // These two used to pass tone unconditionally, so an unmeasured best/worst
    // drew a GREEN and a RED em-dash side by side — two coloured verdicts on
    // statistics nobody computed, next to a median tile that was already getting
    // it right.
    check("Record · an unmeasured best has no tone",
      tile(unmeasured, "best").tone === "var(--faint)", `got ${tile(unmeasured, "best").tone}`);
    check("Record · an unmeasured worst has no tone",
      tile(unmeasured, "worst").tone === "var(--faint)", `got ${tile(unmeasured, "worst").tone}`);
  }

  // ══ 5. StocksPanel — a whole tab, four states, two feeds ═══════════════════
  if (M.StocksPanel) {
    const { StocksPanel } = M.StocksPanel;
    const QUOTES = ["markets"], SCAN = ["stock-scan"];
    const quotes = {
      success: true,
      gold: { price: "$3,412", delta: "+0.4%", up: true },
      nvda: { price: "$184.22", delta: "-1.2%", up: false },
      mstr: { price: "$291.10", delta: "+2.1%", up: true },
      strc: { price: "$88.40", delta: "+0.2%", up: true },
    };
    // A payload that ARRIVED and is empty — the state that separates rule 3
    // from rule 4. Board and flags are deliberately bare: an empty list is the
    // case that used to render as a blank card.
    const settled = {
      success: true, asOf: "2026-08-07T21:05:00.000Z", stale: false, coverage: 0.94,
      session: { state: "closed", lastSessionLabel: "Friday" },
      regime: {
        phase: "mixed", label: "Mixed", score: 41,
        facts: ["Half the board is above its 50-day."],
        parts: [{ key: "breadth", label: "Breadth", points: null, max: 20 }, { key: "leadership", label: "Leadership", points: 8, max: 20 }],
        gate: { floor: 62, effectiveFloor: 62 },
      },
      board: [], movers: { "1s": [], overnight: [], "5s": [], "21s": [] },
      flags: { active: [], recent: [], stats: null },
    };
    const stocks = async (opts) => draw(await stage(opts), React.createElement(StocksPanel, { isMobile: true }));

    const loading = await stocks({});
    check("Stocks · loading draws a skeleton", SKELETON.test(loading));
    check("Stocks · loading prints no number at all", !numbersIn(loading),
      `number voice rendered: ${JSON.stringify((loading.match(NUMBER_VOICE) || [])[0])}`);

    // RULE 1, on a whole tab. Both feeds are down and no payload has ever
    // landed, so there is no figure anywhere the panel is entitled to print.
    const down = await stocks({ broken: [[QUOTES, "HTTP 502"], [SCAN, "HTTP 502"]] });
    check("Stocks · both feeds down prints no number",
      !numbersIn(down), `number voice rendered: ${JSON.stringify((down.match(NUMBER_VOICE) || [])[0])}`);
    check("Stocks · both feeds down offers a retry", down.includes("Retry"));
    check("Stocks · both feeds down never says Live", !down.includes(">Live<"));

    // THE ONE THAT SHIPPED BROKEN: data wins over isError, so a failed refresh
    // used to leave four confident prices on screen saying nothing.
    //
    // AND THEN THE CHECK SHIPPED BROKEN TOO. It read
    // `includes("Refresh failed") || includes("Retry")`, and in this fixture the
    // screener card always renders a FallbackRow, which always renders a Retry
    // button — so the second half was unconditionally true and the whole
    // assertion was satisfied by the existence of a button. Proven by replacing
    // the panel's detail with the literal "Running the screener — a full pass
    // takes a couple of minutes.", the fabricated progress message the comment
    // two lines above it forbids: the check named "still says the screener
    // failed" reported ok while the card claimed a pass was in flight.
    //
    // So the failure is seeded with a sentence nothing else in this panel can
    // produce, and read back off the screen. `text()` rather than the raw html,
    // because the detail arrives inside a template with the message interpolated.
    const SCAN_DOWN = "stock-scan answered 502 and the pass never landed";
    const staleQuotes = await stocks({ seed: [[QUOTES, quotes]], broken: [[SCAN, SCAN_DOWN]] });
    const staleQuotesText = text(staleQuotes);
    check("Stocks · quotes on screen with the screener down says what the screener actually did",
      staleQuotesText.includes(SCAN_DOWN), `got ${JSON.stringify(staleQuotesText.slice(0, 300))}`);
    // The other half of the same rule: nothing may invent a friendlier state than
    // the one the query is in. Neither a run in progress nor a run that timed out
    // is true here — the read simply failed.
    check("Stocks · …and never dresses that failure as a run in progress",
      !/Running the screener|takes a couple of minutes|didn't finish inside/.test(staleQuotesText),
      `got ${JSON.stringify(staleQuotesText.slice(0, 300))}`);
    check("Stocks · …and still offers a retry", staleQuotes.includes("Retry"));
    check("Stocks · the last good prices are kept, not blanked", staleQuotes.includes("$184.22"));

    // The same key holding data AND an error — the exact shape of a refresh that
    // failed under a loaded card, which is the state that used to say nothing.
    const quotesStale = await stage({ seed: [[QUOTES, quotes], [SCAN, settled]] });
    await breakQuery(quotesStale, QUOTES, "HTTP 502");
    const refreshFailed = draw(quotesStale, React.createElement(StocksPanel, { isMobile: true }));
    check("Stocks · a failed quote refresh labels the tiles stale and offers a retry",
      refreshFailed.includes("stale · retry"), `got ${JSON.stringify(text(refreshFailed).slice(0, 200))}`);
    check("Stocks · a failed quote refresh never says Live over the tiles", !refreshFailed.includes(">Live<"));

    const empty = await stocks({ seed: [[QUOTES, quotes], [SCAN, settled]] });
    const emptyText = text(empty);
    check("Stocks · an empty flag list draws a designed empty state",
      empty.includes('class="empty"') && emptyText.includes("Nothing to take at the open"));
    check("Stocks · the empty state says what the bar was", emptyText.includes("Nothing cleared 62/100 off Friday"),
      `got ${JSON.stringify(emptyText.slice(0, 400))}`);
    check("Stocks · an empty board draws a designed empty state", emptyText.includes("No board yet"));
    check("Stocks · a settled payload is dated by session, never by a countdown",
      emptyText.includes("settled Friday") && !/\d+\s?(?:s|sec|seconds) ago/.test(emptyText));
    // A REGIME WITH NO SCORE PRINTS NO SCORE. The strip is a sum over measured
    // parts, so a tape too thin to measure has no number — and "0" would read as
    // the most risk-off print the engine can produce, which is the opposite of
    // "we don't know". The sentence under it has to carry that, because the strip
    // has no room for a fallback row.
    const noRead = await stocks({ seed: [[QUOTES, quotes], [SCAN, { ...settled, regime: { phase: null, label: null, score: null } }]] });
    const noReadStrip = card(noRead, "No read", "Flags");
    // The `!== ""` belongs in the same condition as the negative it guards: it was
    // asserted one check later, which left this one able to pass because the strip
    // had vanished.
    check("Stocks · a regime with no score prints no score", noReadStrip !== "" && !numbersIn(noReadStrip),
      `number voice rendered: ${JSON.stringify((noReadStrip.match(NUMBER_VOICE) || [])[0])}`);
    check("Stocks · a regime with no score says why, and does not offer a Why",
      text(noRead).includes("The score publishes once the screener has breadth to measure") && noReadStrip !== "" && !noReadStrip.includes(">Why<"),
      `got ${JSON.stringify(text(noReadStrip).slice(0, 200))}`);

    // RULE 2, on real data: a payload the function served from its own cache is
    // dated, not called Live.
    const servedFromCache = await stocks({ seed: [[QUOTES, quotes], [SCAN, { ...settled, stale: true }]] });
    check("Stocks · a cache-served payload is timestamped, never labelled Live",
      !servedFromCache.includes(">Live<"), `got ${JSON.stringify(text(servedFromCache).slice(0, 200))}`);
  }

  // ══ 6. AltSeasonPanel — the same anatomy on the other tab ══════════════════
  if (M.AltSeasonPanel) {
    const AltSeasonPanel = M.AltSeasonPanel.default;
    const SCAN = ["alt-scan"];
    const scan = {
      success: true, asOf: "2026-08-10T13:00:00.000Z", stale: false,
      season: { phase: "mixed", label: "Mixed", score: 38, fearGreed: 52, domTrend: "rising", ethBtc7d: -2.1 },
      global: { btcDominance: 57.4, totalMcapUsd: 3.42e12, mcapChange24hPct: -0.8 },
      board: [], movers: { "24h": [] },
      flags: { active: [], recent: [], stats: null },
    };
    const alt = async (opts) => draw(await stage(opts), React.createElement(AltSeasonPanel, { isMobile: true }));

    const loading = await alt({});
    check("Alt Season · loading draws a skeleton", SKELETON.test(loading));
    check("Alt Season · loading prints no number", !numbersIn(loading),
      `number voice rendered: ${JSON.stringify((loading.match(NUMBER_VOICE) || [])[0])}`);

    const down = await alt({ broken: [[SCAN, "HTTP 502"]] });
    check("Alt Season · a failed scan prints no number", !numbersIn(down),
      `number voice rendered: ${JSON.stringify((down.match(NUMBER_VOICE) || [])[0])}`);
    check("Alt Season · a failed scan offers a retry and never says Live",
      down.includes("Retry") && !down.includes(">Live<"));

    const empty = await alt({ seed: [[SCAN, scan]] });
    const emptyText = text(empty);
    check("Alt Season · an empty radar draws a designed empty state",
      empty.includes('class="empty"') && emptyText.includes("Nothing on the radar"));
    check("Alt Season · an empty board draws a designed empty state", emptyText.includes("No board yet"));

    const served = await alt({ seed: [[SCAN, { ...scan, stale: true }]] });
    check("Alt Season · a cache-served scan is timestamped, never labelled Live", !served.includes(">Live<"));
  }

  // ══ 7. CryptoPanel — one card per feed, and they do not share a fate ═══════
  if (M.CryptoPanel) {
    const { CryptoPanel } = M.CryptoPanel;
    const SCAN = ["alt-scan"];
    const btc = { price: 118420, changePct: 1.8, points: [117000, 117900, 118420], high24: 119000, low24: 116400, loading: false, error: null, stale: false };
    const scan = {
      success: true, asOf: "2026-08-10T13:00:00.000Z", stale: false,
      season: { fearGreed: 52, domTrend: "rising", ethBtc7d: -2.1 },
      global: { btcDominance: 57.4, totalMcapUsd: 3.42e12, mcapChange24hPct: -0.8 },
      board: [], movers: { "4h": null }, flags: { active: [] },
    };
    const crypto = async (opts, btcProp = btc) => draw(await stage(opts), React.createElement(CryptoPanel, { isMobile: true, btc: btcProp }));

    // RULE 1, scoped to the card whose feed is down. The BTC hero is fed by a
    // prop from a different upstream and is right to keep printing — which is
    // exactly why "does this panel render a number" is the wrong question and
    // "does THIS CARD render one" is the right one.
    const down = await crypto({ broken: [[SCAN, "HTTP 502"]] });
    const pulse = card(down, "Market pulse", "Alt season read lives in the Alt Season tab");
    check("Crypto · the market-pulse card prints no number while its scan is down",
      pulse !== "" && !numbersIn(pulse), `number voice rendered: ${JSON.stringify((pulse.match(NUMBER_VOICE) || [])[0])}`);
    // `card()` returns "" for a heading it cannot find, and "" contains no number
    // — so every negative assertion about one card has to say that it FOUND the
    // card first. The same shape as the disjunctions further down: an assertion
    // satisfied by its own subject going missing.
    const boardDown = card(down, "Board", "Market pulse");
    check("Crypto · the board card prints no number while its scan is down",
      boardDown !== "" && !numbersIn(boardDown), `number voice rendered: ${JSON.stringify((boardDown.match(NUMBER_VOICE) || [])[0])}`);
    check("Crypto · a down scan does not take the BTC hero with it", down.includes("118,420"));
    check("Crypto · a down scan offers a retry", down.includes("Retry"));
    // This row used to read "showing the last good scan" whenever the query
    // errored — including on this exact fixture, a cold cache with no earlier scan
    // to show. It told you the numbers on screen were merely old when there were
    // no numbers on screen at all.
    check("Crypto · a down scan with no cached scan does not claim to show one",
      !/last good scan/.test(down), `got ${JSON.stringify((down.match(/[^<>]*last good scan[^<>]*/) || [])[0])}`);
    check("Crypto · …and says there is no earlier scan on this device",
      /no earlier one on this device/.test(down));

    const loading = await crypto({}, { price: null, changePct: null, points: [], loading: true, error: null });
    check("Crypto · loading draws skeletons for both scan cards",
      SKELETON.test(card(loading, "Board", "Market pulse")) && SKELETON.test(card(loading, "Market pulse", "Alt season read lives")));
    check("Crypto · a loading BTC hero shows an ellipsis, never a zero",
      text(loading).includes("…") && !/\$0\b/.test(text(loading)));
    const pulseLoading = card(loading, "Market pulse", "Alt season read lives");
    check("Crypto · loading prints no stat tile",
      pulseLoading !== "" && !pulseLoading.includes("stattile-value"));

    const empty = await crypto({ seed: [[SCAN, scan]] });
    check("Crypto · an empty board says so in words, not blank space",
      text(empty).includes("No board yet — the hourly screener hasn't completed a pass"), `got ${JSON.stringify(text(empty).slice(0, 300))}`);
    check("Crypto · the pulse tiles print the numbers the scan actually carried",
      text(empty).includes("57.4%") && text(empty).includes("$3.42T"));
    // Our own derived windows are absent until the snapshot series is old
    // enough, and the panel says so rather than drawing zeros.
    //
    // THIS CHECK ASSERTED NOTHING AT ALL. It was
    // `includes("measured once the series is old enough") || !includes("+0.0%")`
    // against the empty-board fixture above — where the explanation cannot render
    // (it is behind sort 4h/12h) and there is no row to print a +0.0% in, so the
    // first half was false, the second was trivially true, and deleting the whole
    // explanatory block left it green. Both halves are staged now: a board with
    // rows whose 4h and 12h are genuinely null, and the sort those windows live
    // under.
    const pendingBoard = {
      ...scan,
      board: [
        { id: "ethereum", symbol: "ETH", name: "Ethereum", price: 3120, mcap: 3.7e11, chg4h: null, chg12h: null, chg24h: 1.4, chg7d: -3.2, chg30d: 8.1 },
        { id: "solana", symbol: "SOL", name: "Solana", price: 184.22, mcap: 8.6e10, chg4h: null, chg12h: null, chg24h: -0.6, chg7d: 2.7, chg30d: 15.4 },
      ],
      movers: { "4h": null },   // what "the series isn't old enough yet" looks like
    };
    const pending = drawSeeded(
      await stage({ seed: [[SCAN, pendingBoard]] }),
      React.createElement(CryptoPanel, { isMobile: true, btc }), "chg24h", "chg4h");
    const pendingText = text(pending.html);
    // FIRST, THAT THE STATE IS THE ONE UNDER TEST. Without this the seeder could
    // stop matching and the two checks below would quietly go back to describing
    // the default sort — which is how the disjunction above got away with it.
    check("Crypto · the board is genuinely sorted by 4h for this check",
      pending.seeded === 1 && /class="pill active"[^>]*>4h</.test(pending.html),
      `seeded ${pending.seeded} hook(s), active pill ${JSON.stringify((/class="pill active"[^>]*>([^<]*)</.exec(pending.html) || [])[1])}`);
    check("Crypto · pending 4h/12h windows are explained in words",
      pendingText.includes("4h/12h come from our own hourly snapshots — measured once the series is old enough"),
      `got ${JSON.stringify(pendingText.slice(0, 400))}`);
    // …and not drawn as a flat zero, which is a measurement. Counted rather than
    // searched: two rows, five windows each, and exactly the four unmeasured cells
    // may be em-dashes — a board that started printing +0.0% would still contain
    // an em-dash somewhere, so "an em-dash appears" is not the assertion.
    const pendingCard = card(pending.html, "Board", "Market pulse");
    const absentCells = (pendingCard.match(/>—<\/div>/g) || []).length;
    check("Crypto · …and drawn as absent, never as a flat zero",
      pendingCard !== "" && absentCells === 4 && !/[+-]0\.0%/.test(pendingText)
      && pendingText.includes("+1.4%") && pendingText.includes("-0.6%"),
      `${absentCells} absent cell(s) in ${JSON.stringify(text(pendingCard).slice(0, 220))}`);
  }

  // ══ 8. ScoreCard — "not measured is not zero", drawn ═══════════════════════
  // No query behind this one; the dishonesty it can commit is arithmetic. An
  // empty bar that means "SPY did not come back" is a claim about the stock that
  // nobody made, and the card's own header says so — which makes it exactly the
  // sort of promise worth holding a component to.
  if (M.ScoreCard) {
    const ScoreCard = M.ScoreCard.default;
    const parts = [
      { key: "rs5", label: "5 sess +2.1 vs SPY", points: 12, max: 20, measured: true },
      { key: "breadth", label: "SPY never answered", points: 0, max: 20, measured: false },
      { key: "parabolic", label: "up 41% in three sessions", points: -25, max: 0 },
    ];
    const blocks = [
      { key: "tape", label: "The tape", keys: ["rs5"] },
      { key: "peers", label: "Versus SPY", keys: ["breadth"] },
    ];
    const html = draw(await stage(), React.createElement(ScoreCard, {
      row: { symbol: "NVDA", name: "NVIDIA" }, parts, score: 41,
      band: "Mixed", bandTone: "var(--amber)", blocks, facts: ["Half the board is above its 50-day."],
    }));
    const scored = text(html);
    check("ScoreCard · a measured block prints its points over its weight", scored.includes("12/20"), `got ${JSON.stringify(scored)}`);
    check("ScoreCard · an unmeasured block says so, and never prints 0/20",
      scored.includes("not measured") && !scored.includes("0/20"), `got ${JSON.stringify(scored)}`);
    // The fill is the claim. An unmeasured block draws a track and nothing in it,
    // so exactly one fill element may exist on a card with one measured block.
    check("ScoreCard · an unmeasured block draws no fill",
      (html.match(/border-radius:999px"><\/div>/g) || []).length === 1,
      `fills rendered: ${(html.match(/border-radius:999px"><\/div>/g) || []).length}`);
    check("ScoreCard · a penalty is drawn as a deduction, not as a meter",
      scored.includes("-25") && scored.includes("earned 12 of 40 · docked 25"), `got ${JSON.stringify(scored)}`);
    check("ScoreCard · a null score renders nothing rather than a bar at zero",
      draw(await stage(), React.createElement(ScoreCard, { row: {}, parts, score: null, blocks })) === "");
  }

  // ══ 9. the kit's number instrument — StatTile, Delta, NumTween ═════════════
  // Every number in the app tweens now, and the detection that decides whether a
  // value CAN be tweened moved into one place — kit.jsx's `instrument` — instead of
  // living at the seventy-nine call sites that print one. That is the right trade
  // and a dangerous one: a parser that guesses wrong prints a figure nobody
  // measured, in the voice this app reserves for measurements, on every screen at
  // once. These render the resting frame, which is the frame that ships: no effect
  // runs under renderToString, so what comes out is exactly the first paint.
  if (M.kit && M.primitives) {
    const { StatTile, Delta } = M.kit;
    const { NumTween } = M.primitives;
    const kit = async (el) => draw(await stage(), el);
    // The value slot on its own. A tween wraps the figure in an element of its own,
    // so the span's contents are what has to be read back — and read through text(),
    // for the same reason everything else here is (see the note above it).
    const statValue = (html) => text((/<span class="stattile-value"[^>]*>([\s\S]*?)<\/span>/.exec(html) || [, ""])[1]);

    // THE CRITICAL ONE. A null reading has to pass through untouched end to end: a
    // tween that painted a 0 on its way to an absent value would be the app
    // inventing a number, in the number voice, on the one tile whose entire message
    // is that it does not have one.
    const absent = await kit(React.createElement(StatTile, { value: null, label: "net worth" }));
    check("StatTile · a null value renders no digit at all",
      statValue(absent) === "" && !/\d/.test(text(absent)), `got ${JSON.stringify(text(absent))}`);

    // RULE 2 FROM THE KIT'S OWN NOTE: the first paint is the final value. useTween
    // seeds its state from its target, so a mount is already at rest — nothing
    // counts up from zero when a page opens, and no intermediate frame exists to be
    // caught here.
    const flat = await kit(React.createElement(StatTile, { value: 1240, label: "sessions" }));
    check("StatTile · a number's first paint is the number, not a count from zero",
      statValue(flat) === "1240", `got ${JSON.stringify(statValue(flat))}`);

    // AND THE PARSER DECLINES WHAT IT CANNOT REBUILD. "3/5" carries two numbers, so
    // there is no single figure to interpolate and no scaffolding to reprint it in
    // — tweening it would animate one of the two and leave the other standing.
    const ratio = await kit(React.createElement(StatTile, { value: "3/5", label: "targets hit" }));
    check("StatTile · a non-numeric shape declines the tween and prints unchanged",
      statValue(ratio) === "3/5", `got ${JSON.stringify(statValue(ratio))}`);

    // The delta's glyph and tone come from the target, never from a frame in flight,
    // and the string it hands to `instrument` is its own formatted output — so the
    // resting frame is character for character what this component always printed.
    const delta = await kit(React.createElement(Delta, { pct: 1.234 }));
    check("Delta · a positive delta prints its arrow and two decimals",
      text(delta) === "▲ 1.23%", `got ${JSON.stringify(text(delta))}`);

    // THE REGRESSION GUARD FOR A BUG THIS SHIPPED. useTween rounds to the value's
    // own scale, so NumTween printed f(Math.round(v)) at rest — and the sheets hand
    // it a formatter that prints two decimals between $1 and $1000. A stock at
    // 174.32 counted up and then simply stayed at "$174.00", cents silently zeroed,
    // on the one screen you open to read the price. The formatter here is
    // StockSheet's own two-decimal branch.
    const px = (x) => `$${(Math.round(x * 100) / 100).toFixed(2)}`;
    const quote = await kit(React.createElement(NumTween, { v: 174.32, f: px }));
    check("NumTween · the resting frame is the real quote, cents and all",
      text(quote) === "$174.32", `got ${JSON.stringify(text(quote))}`);
  }

  // ══ what this harness cannot reach ════════════════════════════════════════
  // Not a wish list — every entry here was attempted and failed for the stated
  // reason. Anything that renders clean belongs above instead.
  skip("every kit Sheet, and the panels that open one (StockSheet, AltCoinSheet, CaptureSheet, SettingsSheet, BriefLayoutSheet, WatchSheet, SeatNotesModal)",
    "kit.jsx's Sheet is createPortal(…, document.body); renderToString has no document. A sheet only mounts behind "
    + "a tap, so the panels above render fine with theirs closed — the sheet bodies themselves need jsdom, which is a dependency this repo does not take.");
  skip("BtcChartModal.jsx, GscLineChart.jsx",
    "lightweight-charts binds to a canvas element on mount; there is no canvas server-side and no honest way to stub one.");
  skip("MobileShell.jsx, SidebarShell.jsx, App.jsx and every src/pages/*Page.jsx",
    "useIsMobile() and IS_STANDALONE (src/hooks/index.js:57,94) call window.matchMedia during render, so the shells "
    + "and the page wrappers throw before their first element. Stubbing matchMedia here would make this file assert "
    + "against a browser it invented; the panels those pages compose are rendered directly instead.");
  skip("NotesTile.jsx, FinancesPanel.jsx, GroceryPanel.jsx, CreedPanel.jsx, DreamBoardPanel.jsx, UpkeepPanel.jsx, MoviesPanel.jsx, BirthdaysPanel.jsx",
    "each takes the whole settings/updateSetting surface plus its own editor state, and their numbers are already "
    + "asserted by the logic smokes (finance, grocery, creed, dreams, notes-order). They are the next ones to add "
    + "here, in that order — none of them is blocked, only unwritten.");

  for (const [what, why] of skips) console.log(`skip: ${what}\n      ${why}`);
  for (const [what, why] of notes) console.log(`note: ${what}\n      ${why}`);

  // The last assertion, and the one that keeps this file cheap forever.
  check("nothing in this suite touched the network", fetchCalls.length === 0, fetchCalls.join(", "));

  console.log(failed
    ? `\n${failed} render honesty check(s) failed — ${skips.length} component group(s) skipped`
    : `\nrender honesty: all checks passed — ${skips.length} component group(s) skipped, ${notes.length} gap(s) noted`);
  // exitCode, NOT process.exit(). This function runs inside the bundle, which
  // runs inside the wrapper's try — and process.exit() skips the finally that
  // deletes the temp bundle, so the first version of this file left
  // .page-render-smoke.tmp.mjs sitting in the repo root on every run.
  process.exitCode = failed ? 1 : 0;
}
