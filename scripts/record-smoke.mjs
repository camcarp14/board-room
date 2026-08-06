// ─── Record smoke — the one card that is allowed to say "trust this" ────────
//
// Everything else on the Markets tabs is a claim about the future, which cannot
// be tested. The Record is a claim about the PAST, which can — and a
// performance card that overstates is worse than no performance card at all,
// because it is the thing a reader uses to decide whether to believe the rest
// of the page.
//
// So the failures worth pinning are the ones that all flatter the screener:
//
//   1. THE DENOMINATOR. A hit rate over `total` counts every still-running
//      flag as a loss, so the number sags every time the screener does its
//      job — and the fix (count them as wins) is the far worse bug. Only
//      CLOSED episodes are graded, and this file proves the open ones are
//      excluded from the rate and still reported beside it.
//   2. THE BAR THAT DOES NOT ADD UP. The outcome bar's widths are only
//      meaningful if every graded episode lands in exactly one segment. Fold
//      an open T1-tagger into the green side and the bar silently overstates
//      by however many flags happen to be running today.
//   3. A STATUS WITH NO LABEL. The engines write six terminal statuses; the
//      card maps them by key. A status the card has never heard of falls
//      through to the default and gets drawn as somebody else's outcome —
//      grey where it should be red, in the one place that must not lie.
//   4. CLIENT-SIDE ARITHMETIC. The panels hold the last 25 closed episodes.
//      Any rate computed from that array is "the last 25" printed under the
//      words "all time". Every number on the card has to come from the server.
//   5. THE TWO TABS GRADING THEMSELVES DIFFERENTLY. Both scan functions carry
//      their own copy of flagStats (house rule: functions are self-contained).
//      Copies drift. Byte-equality is the only thing that stops it.
//
// Plus resolveSymbol, which is here because the chart it feeds was broken for
// every ticker on a 49-name board while claiming the symbol did not exist.
//
// Zero network. Run with `node scripts/record-smoke.mjs`.

import esbuild from "esbuild";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const FN_DIR = "netlify/functions";
const OUT_DIR = ".record-smoke";
const require_ = createRequire(import.meta.url);

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// A resolved episode. `last` is where it closed, `peak` is the best it ever
// looked — the two numbers the card reports separately and must never swap.
const ep = (symbol, status, { flag = 100, peak = 100, last = 100, days = 4, open = false } = {}) => ({
  symbol, status,
  flag_price: flag, peak_price: peak, last_price: last,
  first_flagged_at: "2026-07-01T00:00:00Z",
  resolved_at: open ? null : new Date(Date.parse("2026-07-01T00:00:00Z") + days * 86400000).toISOString(),
});

try {
  const mods = {};
  for (const name of ["stock-scan", "alt-scan", "ticker-candles"]) {
    const out = resolve(OUT_DIR, `${name}.cjs`);
    esbuild.buildSync({
      entryPoints: [join(FN_DIR, `${name}.js`)],
      bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent",
    });
    mods[name] = require_(out);
  }
  const S = mods["stock-scan"];
  const A = mods["alt-scan"];
  const TC = mods["ticker-candles"];

  check("both scan functions export flagStats",
    typeof S.flagStats === "function" && typeof A.flagStats === "function");

  // ─── 1. the denominator ───────────────────────────────────────────────────
  // Six closed (three winners), four still running. The honest rate is 3/6.
  const mixed = [
    ep("AAA", "hit_t1", { peak: 112, last: 108 }),
    ep("BBB", "hit_t2", { peak: 124, last: 119 }),
    ep("CCC", "hit_t3", { peak: 141, last: 136 }),
    ep("DDD", "faded", { peak: 103, last: 99 }),
    ep("EEE", "invalidated", { peak: 101, last: 91 }),
    ep("FFF", "active", { peak: 104, last: 100 }),
    ep("GGG", "hit_t1", { peak: 118, last: 116, open: true }),
    ep("HHH", "active", { peak: 102, last: 101, open: true }),
    ep("III", "active", { peak: 100, last: 100, open: true }),
    ep("JJJ", "active", { peak: 100, last: 100, open: true }),
  ];
  const st = S.flagStats(mixed);
  check("the rate is graded over CLOSED episodes only", st.hitT1Rate === 50,
    `got ${st.hitT1Rate} — 3 of 6 closed reached T1`);
  check("...so an open winner cannot inflate it", st.hitT1 === 3, `hitT1=${st.hitT1}`);
  check("open episodes are counted and reported, not discarded", st.open === 4 && st.total === 10,
    `open=${st.open} total=${st.total}`);
  check("resolved is the population the card names", st.resolved === 6, `resolved=${st.resolved}`);

  // ─── 2. the bar adds up ───────────────────────────────────────────────────
  // The exact arithmetic RecordCard's OutcomeBar performs, restated here: if
  // this ever fails to equal `resolved`, the widths on screen are fiction.
  const segments = st.hitT3 + (st.hitT2 - st.hitT3) + (st.hitT1 - st.hitT2)
    + st.faded + st.expired + st.invalidated;
  check("every graded episode lands in exactly one bar segment", segments === st.resolved,
    `segments=${segments} resolved=${st.resolved}`);
  check("the ladder counts nest — T3 ⊆ T2 ⊆ T1",
    st.hitT3 <= st.hitT2 && st.hitT2 <= st.hitT1, `${st.hitT3}/${st.hitT2}/${st.hitT1}`);
  check("a closed 'active' row is an expiry, not a loss and not an open flag",
    st.expired === 1 && st.invalidated === 1 && st.faded === 1,
    `expired=${st.expired} invalidated=${st.invalidated} faded=${st.faded}`);

  // ─── the two numbers that must not swap ──────────────────────────────────
  // Best is the PEAK (what the flag was worth at its best — the thing the
  // targets were graded against); worst is the CLOSE (what it actually cost).
  check("best reads the peak", st.best && st.best.symbol === "CCC" && Math.round(st.best.pct) === 41,
    JSON.stringify(st.best));
  check("worst reads the close, not the peak", st.worst && st.worst.symbol === "EEE" && Math.round(st.worst.pct) === -9,
    JSON.stringify(st.worst));
  check("median hold is in days and finite", st.medianHeldDays === 4, String(st.medianHeldDays));
  check("the form strip is resolved-only", st.form.length === 6 && st.form.every((f) => f.status !== undefined),
    `${st.form.length} entries`);

  // ─── the thin gate ────────────────────────────────────────────────────────
  // Two closed episodes cannot produce a base rate, and a card that prints one
  // anyway is the single most misleading thing this widget could do.
  const thin = S.flagStats([
    ep("AAA", "hit_t1", { peak: 110, last: 108 }),
    ep("BBB", "faded", { peak: 101, last: 99 }),
    ep("CCC", "hit_t1", { peak: 111, last: 110, open: true }),
    ep("DDD", "hit_t1", { peak: 111, last: 110, open: true }),
  ]);
  check("two closed episodes produce no rate at all", thin.hitT1Rate === null, String(thin.hitT1Rate));
  check("...and open ones cannot pad the sample past the gate", thin.resolved === 2 && thin.medianPeakPct === null,
    `resolved=${thin.resolved} medianPeak=${thin.medianPeakPct}`);

  // A log with nothing closed at all: still a valid object, no NaN anywhere.
  const allOpen = S.flagStats([ep("AAA", "active", { open: true }), ep("BBB", "active", { open: true })]);
  check("an all-open log yields no NaN and no rate",
    allOpen.hitT1Rate === null && allOpen.resolved === 0 && allOpen.best === null && allOpen.worst === null);
  check("an empty log does not throw", S.flagStats([]).total === 0);

  // ─── a win that gave it all back ─────────────────────────────────────────
  // The rung survives a stop-out on BOTH engines now, which is right — the
  // target really did print. But it means the hit rate cannot tell "reached T2
  // and held" from "reached T2 and round-tripped through the stop", and on a
  // tool for deciding what to buy that is the difference between a signal and
  // a tease. closedBy is the only field that distinguishes them.
  const withNotes = [
    ep("AAA", "hit_t2", { peak: 124, last: 96 }),   // tagged T2, then stopped
    ep("BBB", "hit_t1", { peak: 112, last: 111 }),  // tagged T1 and held
    ep("CCC", "hit_t1", { peak: 113, last: 90 }),   // tagged T1, then stopped
    ep("DDD", "invalidated", { peak: 101, last: 91 }),
    ep("EEE", "faded", { peak: 102, last: 99 }),
  ];
  withNotes[0].notes = { closedBy: "invalidation" };
  withNotes[2].notes = { closedBy: "invalidation" };
  withNotes[1].notes = { closedBy: "stale" };
  withNotes[3].notes = { closedBy: "invalidation" };   // never reached a rung
  const rt = S.flagStats(withNotes);
  check("a win that round-tripped through the stop is counted", rt.roundTrip === 2, String(rt.roundTrip));
  check("...and still counts as a hit, because the target really did print",
    rt.hitT1 === 3 && rt.hitT2 === 1, `hitT1=${rt.hitT1} hitT2=${rt.hitT2}`);
  check("a stop-out that never reached a rung is NOT a round-trip",
    rt.invalidated === 1 && rt.roundTrip === 2);
  check("a win closed by timeout is not a round-trip either", rt.roundTrip === 2);
  check("both tabs compute it identically", A.flagStats(withNotes).roundTrip === 2);
  check("a log with no notes at all yields 0 rather than NaN",
    S.flagStats(mixed).roundTrip === 0, String(S.flagStats(mixed).roundTrip));
  check("the select actually asks for notes, or the count is always zero",
    /select\("symbol, status, flag_price, peak_price, last_price, first_flagged_at, resolved_at, notes"\)/.test(readFileSync(`${FN_DIR}/stock-scan.js`, "utf8"))
    && /select\("symbol, status, flag_price, peak_price, last_price, first_flagged_at, resolved_at, notes"\)/.test(readFileSync(`${FN_DIR}/alt-scan.js`, "utf8")));
  check("both scan functions surface closedBy on an episode, not just in the stats",
    /notes\.closedBy\) view\.closedBy/.test(readFileSync(`${FN_DIR}/stock-scan.js`, "utf8"))
    && /notes\.closedBy\) view\.closedBy/.test(readFileSync(`${FN_DIR}/alt-scan.js`, "utf8")));
  const cardSrc = readFileSync("src/pages/markets/RecordCard.jsx", "utf8");
  check("the card says it out loud when it happens", /lost the level/.test(cardSrc));
  check("...and never divides by a zero hit count", /s\.roundTrip > 0 && s\.hitT1 > 0/.test(cardSrc));

  // ─── 5. one arithmetic, two tabs ──────────────────────────────────────────
  const grab = (src) => {
    const i = src.indexOf("/**\n * The track record");
    const j = src.indexOf("\n}\n", src.indexOf("function flagStats"));
    return i >= 0 && j > i ? src.slice(i, j + 2) : null;
  };
  const stockBlock = grab(readFileSync(`${FN_DIR}/stock-scan.js`, "utf8"));
  const altBlock = grab(readFileSync(`${FN_DIR}/alt-scan.js`, "utf8"));
  check("both copies of flagStats are byte-identical",
    Boolean(stockBlock) && stockBlock === altBlock);
  // And they agree on live input, not just on source text.
  check("...and agree on the same fixture", JSON.stringify(A.flagStats(mixed)) === JSON.stringify(st));

  // ─── 3 & 4. the card ──────────────────────────────────────────────────────
  const card = readFileSync("src/pages/markets/RecordCard.jsx", "utf8");
  const STATUSES = ["hit_t1", "hit_t2", "hit_t3", "faded", "invalidated", "active"];
  check("every status the engines can write has a label on the card",
    STATUSES.every((s) => new RegExp(`\\b${s}:\\s*\\{`).test(card)),
    STATUSES.filter((s) => !new RegExp(`\\b${s}:\\s*\\{`).test(card)).join(","));
  // The statuses the engines actually write, read off the settle code rather
  // than trusted from memory — a seventh outcome added there and not here
  // would be drawn as somebody else's result.
  const engineSrc = readFileSync(`${FN_DIR}/stock-settle-background.js`, "utf8");
  const written = [...engineSrc.matchAll(/status:\s*"([a-z_0-9]+)"/g)].map((m) => m[1]);
  check("no status the settle writes is missing from the card's vocabulary",
    written.every((s) => STATUSES.includes(s)), [...new Set(written.filter((s) => !STATUSES.includes(s)))].join(","));

  check("the card computes no rate of its own — every number is the server's",
    !/hitT1\s*\/|\.filter\([^)]*hit_t|\/\s*recent\.length/.test(card));
  check("the panels no longer carry their own outcome vocabulary",
    !/const OUTCOME =/.test(readFileSync("src/pages/markets/AltSeasonPanel.jsx", "utf8"))
    && !/const OUTCOME =/.test(readFileSync("src/pages/markets/StocksPanel.jsx", "utf8")));
  check("both tabs render the same Record component",
    /<RecordCard[\s\S]{0,200}stats=\{stats\}/.test(readFileSync("src/pages/markets/AltSeasonPanel.jsx", "utf8"))
    && /<RecordCard[\s\S]{0,200}stats=\{stats\}/.test(readFileSync("src/pages/markets/StocksPanel.jsx", "utf8")));
  // Touch targets and type floors are house rules; the form strip is the one
  // thing here small enough to break them by accident.
  const smallType = [...card.matchAll(/fontSize:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check("nothing on the card drops under the 9.5px floor the house allows for tags",
    smallType.every((n) => n >= 9.5), smallType.filter((n) => n < 9.5).join(","));
  // No emoji in chrome. The check and ballot marks are deliberately NOT caught
  // by this: ✓ and ✗ are set in the type at the type's weight and colour —
  // part of the label, not a sticker on it — which is the same call
  // AltCoinSheet's HIT_LABEL already made. Extended_Pictographic is exactly
  // the line between the two.
  check("no emoji in the card's chrome", !/\p{Extended_Pictographic}/u.test(card));

  // ─── resolveSymbol — the chart that rejected its own board ────────────────
  check("resolveSymbol is exported", typeof TC.resolveSymbol === "function");
  const cases = [
    ["BA", "BA"], ["ba", "BA"], ["  nvda  ", "NVDA"], ["gold", "GC=F"], ["GOLD", "GC=F"],
    ["brk.b", "BRK.B"], ["BRK-B", "BRK-B"],
    ["", null], ["   ", null], ["../etc/passwd", null], ["A B", null], ["TOOOOOOLONGX", null],
    ["1BA", null], ["BA?x=1", null], [null, null], [undefined, null],
  ];
  for (const [input, want] of cases) {
    const got = TC.resolveSymbol(input);
    check(`resolveSymbol(${JSON.stringify(input)}) → ${JSON.stringify(want)}`, got === want, `got ${JSON.stringify(got)}`);
  }
  // The whole point of the fix: an arbitrary board name must reach the chart.
  const board = ["NVDA", "FCX", "BA", "AMD", "XOM", "JPM", "CAT", "UNH"];
  check("every plain ticker on the board resolves to itself",
    board.every((s) => TC.resolveSymbol(s) === s), board.filter((s) => TC.resolveSymbol(s) !== s).join(","));
  const tcSrc = readFileSync(`${FN_DIR}/ticker-candles.js`, "utf8");
  check("the symbol only ever lands in the path of one fixed Yahoo host",
    (tcSrc.match(/https:\/\//g) || []).length === 1 && tcSrc.includes("query1.finance.yahoo.com"));
  check("the fetch cannot hang the request forever", /AbortSignal\.timeout\(\d+\)/.test(tcSrc));
} catch (e) {
  failed++;
  console.error(`FAIL: smoke crashed — ${(e && e.stack) || e}`);
} finally {
  rmSync(OUT_DIR, { recursive: true, force: true });
}

console.log(failed ? `\nRECORD SMOKE FAILED (${failed})` : "\nRECORD SMOKE PASS");
process.exit(failed ? 1 : 0);
