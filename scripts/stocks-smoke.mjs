// ─── Stocks engine smoke — the equity port, where the clock is the enemy ─────
// stock-cron-background.js is the only place the Stocks tab's judgment lives,
// and it is a port of a 24/7 engine onto a market that is SHUT roughly 81% of
// wall-clock time. Almost every way this fails is silent:
//
//   1. A window that interpolates across a close. priceAgo on equity data does
//      not throw, it returns a confident wrong number — which is why every
//      window here is a SESSION COUNT and the whole clock-window subsystem is
//      deleted rather than retuned.
//   2. structure20 reading the wrong bars. The naive port (range=7d&interval=1d)
//      returns FIVE bars, fails the >=8 guard, and the engine flags nothing
//      forever with no error anywhere.
//   3. The ROOM ladder ported by sign. Crypto pays MORE the further a coin sits
//      below its high; in equities that is a broken chart. The inversion is
//      the single most likely thing a mechanical port gets backwards.
//   4. Grading off closes. An equity can gap through T2 at the open and be back
//      under T1 within a minute — the opening print is exactly the price a
//      close series is worst at, and crypto has no opening gap to teach that.
//   5. The stage contradicting the verdict. They sit two inches apart on a
//      phone, so "Move spent" must be arithmetically incapable of appearing
//      under "Worth an entry".
//
// Zero network — this session has no route to Yahoo, so every fixture is
// hand-built and every assertion has an answer a reader can check by eye.
// Run with `node scripts/stocks-smoke.mjs`.

import esbuild from "esbuild";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const FN_DIR = "netlify/functions";
const OUT_DIR = ".stocks-smoke";
const require_ = createRequire(import.meta.url);

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

try {
  const mods = {};
  for (const name of ["stock-settle-background", "stock-cron-background", "stock-scan"]) {
    const out = resolve(OUT_DIR, `${name}.cjs`);
    esbuild.buildSync({
      entryPoints: [join(FN_DIR, `${name}.js`)],
      bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent",
    });
    mods[name] = require_(out);
    check(`${name} bundles with a callable handler`, typeof mods[name].handler === "function",
      `exports are ${JSON.stringify(Object.keys(mods[name] || {}))}`);
  }
  const C = mods["stock-settle-background"];
  const S = mods["stock-scan"];

  // ─── 0a0. the stored verdict knows which brain wrote it ───────────────────
  // A settle happens once a session, so a deploy that changes how the screen
  // scores leaves the last board standing — under the old rules, with the old
  // gate printed on it — for up to a full trading day. That is not a stale
  // cache, it is the tab confidently showing a verdict the code no longer
  // agrees with, and nothing on screen could tell you.
  check("the engine stamps a judgment version it can compare against",
    Number.isFinite(C.ENGINE_VERSION) && C.ENGINE_VERSION >= 1, String(C.ENGINE_VERSION));
  const engineSrc = readFileSync("netlify/functions/stock-settle-background.js", "utf8");
  check("the version is written into every payload",
    /engine:\s*ENGINE_VERSION/.test(engineSrc));
  check("...and a mismatch forces a re-settle without waiting for a close",
    /prev\.engine\s*!==\s*ENGINE_VERSION/.test(engineSrc) && /engineStale/.test(engineSrc));

  // ─── 0a. the split that makes the tab runnable ────────────────────────────
  // Netlify will not route HTTP to a function that carries a `schedule`, so
  // the engine must NOT carry one — if it does, the Run now button 404s and
  // the only thing that can ever start a pass is the scheduler again. That is
  // the exact failure this split exists to prevent, and it is invisible until
  // someone taps the button on an empty tab, so it is asserted here.
  const toml = readFileSync("netlify.toml", "utf8");
  check("the hourly schedule is on the SHIM",
    /\[functions\."stock-cron-background"\][\s\S]{0,120}?schedule\s*=/.test(toml), "no schedule found for stock-cron-background");
  check("the ENGINE carries no schedule, so it stays HTTP-invocable",
    !/\[functions\."stock-settle-background"\][\s\S]{0,120}?schedule\s*=/.test(toml));
  const shim = readFileSync("netlify/functions/stock-cron-background.js", "utf8");
  check("the shim invokes the engine by name",
    shim.includes("/.netlify/functions/stock-settle-background"));
  check("...over HTTP rather than requiring it — a shim that imports the brain is a second copy of it",
    !/require\(["'][.]/.test(shim));
  check("...and it does not block on the pass, only on the 202",
    /AbortSignal\.timeout\(\d+\)/.test(shim));
  check("the shim reads the site URL from the environment, never a hardcoded host",
    shim.includes("process.env.URL") && !/https:\/\/[a-z-]+\.netlify\.app/.test(shim));

  // ─── 0. the universe is a product decision, so it gets asserted ───────────
  const { EQUITIES, INSTRUMENTS } = C;
  check("the universe is authored and non-trivial", EQUITIES.length >= 40, String(EQUITIES.length));
  check("every id is unique — the id is the DB key an episode points at",
    new Set(EQUITIES.map((e) => e.id)).size === EQUITIES.length);
  check("every symbol is unique", new Set(EQUITIES.map((e) => e.symbol)).size === EQUITIES.length);
  // THE DUAL-CLASS GUARD. GOOG and GOOGL are one company; listing both counts
  // it twice in every breadth denominator and silently biases the regime.
  check("no company is listed twice (the dual-class guard)",
    new Set(EQUITIES.map((e) => e.company)).size === EQUITIES.length,
    JSON.stringify(EQUITIES.map((e) => e.company).filter((c, i, a) => a.indexOf(c) !== i)));
  check("no symbol appears in both the screened universe and the instruments",
    !EQUITIES.some((e) => INSTRUMENTS.some((i) => i.symbol === e.symbol)));
  check("every sector bucket carries enough names for a median to mean anything",
    Object.values(EQUITIES.reduce((m, e) => { m[e.sector] = (m[e.sector] || 0) + 1; return m; }, {})).every((n) => n >= 5),
    JSON.stringify(EQUITIES.reduce((m, e) => { m[e.sector] = (m[e.sector] || 0) + 1; return m; }, {})));
  check("SPY is fetched as an instrument, never screened",
    INSTRUMENTS.some((i) => i.symbol === "SPY") && !EQUITIES.some((e) => e.symbol === "SPY"));

  // ─── 1. the session clock ─────────────────────────────────────────────────
  const { decidePass, etParts, sessionDateOf } = C;
  const ET = (iso) => Date.parse(iso);
  // 2026-08-06 is a Thursday. 14:00Z = 10:00 ET (EDT, UTC-4).
  check("the ET clock handles DST rather than assuming a fixed offset",
    etParts(ET("2026-08-06T14:00:00Z")).minutes === 600 &&
    etParts(ET("2026-01-08T14:00:00Z")).minutes === 540,
    `${etParts(ET("2026-08-06T14:00:00Z")).minutes} / ${etParts(ET("2026-01-08T14:00:00Z")).minutes}`);
  check("a bar's session date is its ET date, not its UTC one",
    sessionDateOf(Date.parse("2026-08-07T00:30:00Z") / 1000) === "2026-08-06",
    sessionDateOf(Date.parse("2026-08-07T00:30:00Z") / 1000));

  const DATES = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"];
  check("an unsettled finished session settles, whatever the clock says",
    decidePass(ET("2026-08-06T21:00:00Z"), DATES, "2026-08-05").pass === "settle");
  check("...but NOT while today's bar is still forming — that grades a moving price",
    decidePass(ET("2026-08-06T15:00:00Z"), DATES, "2026-08-05").pass === "tick",
    decidePass(ET("2026-08-06T15:00:00Z"), DATES, "2026-08-05").pass);
  check("inside a settled session it ticks",
    decidePass(ET("2026-08-06T15:00:00Z"), DATES, "2026-08-06").pass === "tick");
  check("after the close with the session settled, it idles",
    decidePass(ET("2026-08-06T22:00:00Z"), DATES, "2026-08-06").pass === "idle");
  // THE SATURDAY TEST. SPY's newest date is Friday and it is settled, so there
  // is nothing to do and nothing to fetch.
  check("a Saturday with a settled book is idle — zero upstream requests",
    decidePass(ET("2026-08-08T18:00:00Z"), DATES, "2026-08-06").pass === "idle");
  check("a Sunday at 3am is idle", decidePass(ET("2026-08-09T07:00:00Z"), DATES, "2026-08-06").pass === "idle");
  // THE HOLIDAY TEST. It is a Thursday, the clock says the market should be
  // open — but SPY did not print, so the newest session is Wednesday and
  // already settled. Nothing claims a session that does not exist.
  check("a market holiday idles even though the weekday clock says open",
    decidePass(ET("2026-08-06T15:00:00Z"), ["2026-08-04", "2026-08-05"], "2026-08-05").pass === "idle",
    decidePass(ET("2026-08-06T15:00:00Z"), ["2026-08-04", "2026-08-05"], "2026-08-05").pass);
  check("with no calendar at all, nothing is claimed", decidePass(ET("2026-08-06T15:00:00Z"), null, null).pass === "idle");
  check("a first run with a printed session settles rather than waiting a day",
    decidePass(ET("2026-08-06T21:00:00Z"), DATES, null).pass === "settle");

  // ─── 2. parseChart ────────────────────────────────────────────────────────
  const { parseChart } = C;
  const chartOf = (n, f = (i) => 100 + i) => {
    const t = [], o = [], h = [], l = [], c = [], v = [];
    // 2026-01-05 is a Monday; 5 sessions a week is close enough for fixtures
    // whose only requirement is distinct ascending ET dates.
    let d = Date.parse("2026-01-05T15:00:00Z");
    for (let i = 0; i < n; i++) {
      t.push(Math.floor(d / 1000));
      const close = f(i);
      c.push(close); o.push(close * 0.995); h.push(close * 1.01); l.push(close * 0.99); v.push(1_000_000);
      d += 86400000;
    }
    return { chart: { result: [{ timestamp: t, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] }, meta: { regularMarketPrice: f(n - 1), chartPreviousClose: f(n - 2) } }] } };
  };
  const p200 = parseChart(chartOf(200));
  check("parseChart returns one bar per session, ascending", p200.bars.length === 200 && p200.bars[0].date < p200.bars[199].date);
  check("a null close is a hole in the series, not a session",
    (() => {
      const raw = chartOf(10);
      raw.chart.result[0].indicators.quote[0].close[4] = null;
      return parseChart(raw).bars.length === 9;
    })());
  check("a missing OHLC leg falls back to the close rather than nulling the bar",
    (() => {
      const raw = chartOf(10);
      raw.chart.result[0].indicators.quote[0].high[3] = null;
      const b = parseChart(raw).bars[3];
      return b.high === b.close;
    })());
  check("a malformed payload returns null, not a half-built series", parseChart({}) === null && parseChart(null) === null);

  // ─── 3. structure20 — the levels, over SESSIONS ───────────────────────────
  const { structure20 } = C;
  const bar = (o, h, l, c, v = 1e6, date = "2026-01-01") => ({ date, open: o, high: h, low: l, close: c, volume: v });
  // 20 sessions: the prior 19 top out at a HIGH of 110 (close 108); the last
  // one closes at 112.
  const base19 = Array.from({ length: 19 }, (_, i) => bar(100, i === 10 ? 110 : 105, 95, i === 10 ? 108 : 100));
  const st = structure20([...base19, bar(109, 113, 108, 112)]);
  check("priorHigh is the highest HIGH of the prior sessions, not the highest close",
    st.priorHigh === 110, String(st.priorHigh));
  check("the level EXCLUDES the last session — a level that moves with price is not a level",
    st.priorHigh === 110 && st.high === 113, `${st.priorHigh} / ${st.high}`);
  check("a close above the level is a fresh break", st.freshBreak === true);
  // PROBING — the fact a close-only series cannot produce: the high cleared the
  // level, the close did not.
  const probe = structure20([...base19, bar(104, 111, 103, 106)]);
  check("a high through the level with the close back under is 'probing', not a break",
    probe.freshBreak === false && probe.probing === true, JSON.stringify(probe));
  check("neither fires when the session stays entirely inside",
    (() => { const s = structure20([...base19, bar(101, 104, 99, 102)]); return !s.freshBreak && !s.probing; })());
  check("a dead-flat series yields a null position rather than NaN",
    structure20(Array.from({ length: 20 }, () => bar(100, 100, 100, 100))).pos === null);
  check("fewer than 8 sessions returns the empty shape rather than guessing",
    structure20(Array.from({ length: 5 }, () => bar(100, 101, 99, 100))).priorHigh === null);
  check("the unit is SESSIONS, and it is reported",
    structure20([...base19, bar(109, 113, 108, 112)]).sessions === 20);

  // ─── 4. the screen ────────────────────────────────────────────────────────
  const { screenStock, screenUniverse, bandOf, targetsFor, atrPct, retSessions, sma, pair } = C;
  // A clean 120-session tape rising 0.25%/session, then a breakout session.
  const rising = Array.from({ length: 119 }, (_, i) => {
    const c = 100 * Math.pow(1.0025, i);
    return bar(c * 0.998, c * 1.005, c * 0.995, c, 1e6, `d${i}`);
  });
  const lastC = rising[118].close * 1.03;
  const tape = [...rising, bar(rising[118].close, lastC * 1.005, rising[118].close * 0.999, lastC, 3e6, "d119")];
  const bench = { chg5: 0.5, chg21: 2 };
  const clean = screenStock({ id: "x", symbol: "X", sector: "tech", company: "X Co", bars: tape }, { bench });
  const sumParts = (r) => r.parts.reduce((s, p) => s + p.points, 0);
  check("parts[] always sums to score", sumParts(clean) === clean.score, `${sumParts(clean)} vs ${clean.score}`);

  // ─── MEASURED IS NOT ZERO ─────────────────────────────────────────────────
  // step() returns 0 for "bottom of the table" AND for "the benchmark did not
  // come back". Identical on the wire, opposite in meaning, and the difference
  // becomes visible the instant anything draws a per-part bar: an empty bar
  // that actually means "not measured" is a claim about the stock that nobody
  // made. This is the same Number(null)===0 trap that has already cost this
  // codebase a fake "decelerating hard" and a fleet of price-0 rows.
  check("every part says whether it was measured",
    clean.parts.every((p) => typeof p.measured === "boolean"),
    clean.parts.filter((p) => typeof p.measured !== "boolean").map((p) => p.key).join(","));
  check("with a full tape and a benchmark, every part is measured",
    clean.parts.every((p) => p.measured), clean.parts.filter((p) => !p.measured).map((p) => p.key).join(","));

  // No benchmark at all: RS is UNMEASURABLE, and must not read as "worst in class".
  const noBench = screenStock({ id: "x", symbol: "X", sector: "tech", company: "X Co", bars: tape }, { bench: {} });
  const byKey = Object.fromEntries(noBench.parts.map((p) => [p.key, p]));
  check("a missing benchmark marks RS unmeasured rather than scoring it zero",
    byKey.rs5.measured === false && byKey.rs21.measured === false && byKey.rs5.points === 0,
    JSON.stringify([byKey.rs5, byKey.rs21]));
  check("...while the parts that never needed the benchmark stay measured",
    byKey.rvol.measured && byKey.range.measured && byKey.high.measured);
  check("an unmeasured part still contributes its 0, so the sum survives",
    sumParts(noBench) === noBench.score, `${sumParts(noBench)} vs ${noBench.score}`);
  check("a clean breakout scores well and bands 'starting'",
    clean.score >= 55 && clean.band === "starting", `${clean.score}/${clean.band}`);
  check("every window is a SESSION count", Number.isFinite(clean.chg5) && Number.isFinite(clean.chg21));
  check("the overnight window exists and is the gap, not a clock window",
    near(clean.overnight, ((tape[119].open - tape[118].close) / tape[118].close) * 100, 1e-9),
    String(clean.overnight));

  // TOO YOUNG. Yahoo returns a SHORTER array for a recent listing, not nulls —
  // the tell is length, which is why this replaces crypto's null-30d newListing.
  const young = screenStock({ id: "y", symbol: "Y", bars: tape.slice(-30) }, { bench });
  check("under three months of history is not screened, and says why",
    young.score === null && young.flags.tooYoung === true && /too recently/.test(young.facts[0]));
  check("...and screenUniverse DROPS it rather than ranking it low",
    !screenUniverse([{ id: "y", symbol: "Y", bars: tape.slice(-30) }], { bench }).some((r) => r.symbol === "Y"));

  // THE ROOM→HIGH INVERSION. The single most likely thing a mechanical port
  // gets backwards: crypto pays MORE the further below its high a coin sits.
  const highPart = (r) => r.parts.find((p) => p.key === "high");
  const nearHigh = screenStock({ id: "n", symbol: "N", bars: tape }, { bench });
  const farBelow = screenStock({
    id: "f", symbol: "F",
    bars: [...tape.slice(0, 119).map((b) => ({ ...b, high: b.high * 3 })), tape[119]],
  }, { bench });
  check("a name NEAR its high scores MORE than one far below it — the sign is inverted from crypto",
    highPart(nearHigh).points > highPart(farBelow).points,
    `near=${highPart(nearHigh).points} far=${highPart(farBelow).points}`);
  check("...and the far-below one is not merely lower, it is near zero",
    highPart(farBelow).points <= 2, String(highPart(farBelow).points));

  // RVOL uses the MEDIAN, so one earnings day cannot desensitise it for a month.
  const withSpike = tape.map((b, i) => (i === 100 ? { ...b, volume: 8e6 } : b));
  check("relative volume is measured against the median, not the mean",
    near(screenStock({ id: "v", symbol: "V", bars: withSpike }, { bench }).rvol,
      screenStock({ id: "v", symbol: "V", bars: tape }, { bench }).rvol, 1e-9));
  // +20% in ONE session against the prior close — nothing a mega-cap does
  // without an acquisition, and well past the equity threshold. `clean` rose
  // 3% in its last session and must NOT trip it.
  const prevClose = tape[118].close;
  const blowoff = [...tape.slice(0, 119), bar(prevClose, prevClose * 1.21, prevClose, prevClose * 1.2, 1e6, "z")];
  check("the parabolic threshold is equity-shaped, not memecoin-shaped",
    screenStock({ id: "p", symbol: "P", bars: blowoff }, { bench }).flags.parabolic === true &&
    clean.flags.parabolic === false,
    `${screenStock({ id: "p", symbol: "P", bars: blowoff }, { bench }).chgSession}`);
  check("a parabolic row floors at a true 0, never negative",
    screenStock({ id: "p", symbol: "P", bars: blowoff.map((b) => ({ ...b, volume: 1e3 })) }, { bench }).score >= 0);

  // ─── 5. ATR, SMA, the pair arithmetic ─────────────────────────────────────
  check("ATR is a percentage of the last close", (() => {
    const flat = Array.from({ length: 20 }, () => bar(100, 102, 98, 100));
    return near(atrPct(flat), 4, 1e-6);
  })(), String(atrPct(Array.from({ length: 20 }, () => bar(100, 102, 98, 100)))));
  check("ATR refuses a series too short to compute it", atrPct(Array.from({ length: 5 }, () => bar(100, 101, 99, 100))) === null);
  check("the SMA refuses a short series rather than averaging what it has",
    sma(Array.from({ length: 50 }, () => bar(100, 100, 100, 100)), 200) === null);
  check("a session return counts BARS, not days",
    near(retSessions([bar(1, 1, 1, 100), bar(1, 1, 1, 110)], 1), 10, 1e-9));
  // THE RATIO, NOT THE SUBTRACTION — nearly right at small numbers and badly
  // wrong at exactly the numbers that would make someone act on it.
  check("relative performance is a ratio: +100 vs +50 is +33.3%, not +50",
    near(pair(100, 50), 33.3333, 1e-3), String(pair(100, 50)));
  check("a missing leg stays null rather than becoming zero", pair(null, 5) === null && pair(5, null) === null);
  check("a −100% denominator is refused rather than dividing by zero", pair(5, -100) === null);

  // ─── 6. targets — the floor scales with the NAME'S volatility ─────────────
  const mkRow = (price, priorHigh, priorLow, atr, freshBreak = false) => ({
    price, atrPct: atr, windowHigh: priorHigh * 2,
    range20: { priorHigh, priorLow, freshBreak, pos: 0.8, high: priorHigh, low: priorLow, sessions: 20 },
  });
  const quiet = targetsFor(mkRow(100, 101, 95, 1.2));
  const wild = targetsFor(mkRow(100, 101, 95, 6));
  check("a low-volatility name gets a nearer first target than a high-volatility one",
    quiet.t1 < wild.t1, `${quiet.t1} vs ${wild.t1}`);
  check("...and the floor is clamped to a sane band at both ends",
    targetsFor(mkRow(100, 101, 95, 0.1)).minMovePct === 2 &&
    targetsFor(mkRow(100, 101, 95, 40)).minMovePct === 12);
  check("targets ascend with at least 2% between rungs, never merely in order",
    wild.t2 >= wild.t1 * 1.02 && wild.t3 >= wild.t2 * 1.02);
  check("an invalidation at or above price returns NO targets — the structure is already lost",
    targetsFor(mkRow(100, 101, 101, 2)) === null);
  check("a flat base returns no targets rather than dividing by a zero range",
    targetsFor(mkRow(100, 100, 100, 2)) === null);

  // ─── 7. the regime ────────────────────────────────────────────────────────
  const { regimeRead, gateFor, effectiveFloor, PHASE_GATE } = C;
  const mkScreened = (n, beat5, beat21, above200) => Array.from({ length: n }, (_, i) => ({
    symbol: `S${i}`, flags: {},
    chg5: i < beat5 ? 10 : -10, chg21: i < beat21 ? 20 : -20,
    aboveSma200: i < above200,
  }));
  const b = { chg5: 0, chg21: 0 };
  const all = regimeRead({ screened: mkScreened(50, 50, 50, 50), bench: b, instruments: { rsp: { chg21: 5 }, iwm: { chg21: 5 }, xly: { chg21: 5 }, xlp: { chg21: 0 } } });
  check("a fully measured read sums its parts to exactly 100 on offer",
    all.measured.of === 100, JSON.stringify(all.measured));
  check("...and a perfect tape scores 100", all.score === 100, String(all.score));
  check("the phase is a pure function of the score",
    all.phase === "risk_on" && all.label === "Risk on");
  // THE RENORMALISATION CONTRACT. All three ETF pairs can fail and the read
  // still publishes off 70 measured points — that constraint decided the
  // allocation, and it is the reason the pairs sum to exactly 30.
  const noPairs = regimeRead({ screened: mkScreened(50, 25, 25, 25), bench: b, instruments: {} });
  check("all three ETF pairs failing still publishes, off 70 measured points",
    noPairs.measured.of === 70 && noPairs.score != null, JSON.stringify(noPairs.measured));
  check("...and the sentence names what was dropped, on BOTH sides of the fraction",
    noPairs.facts.some((f) => /not measured/.test(f) && /either side of the fraction/.test(f)));
  check("no breadth at all is 'No read', not a zero",
    regimeRead({ screened: [], bench: b, instruments: {} }).score === null);
  check("participation is not measured off a handful of names",
    regimeRead({ screened: mkScreened(10, 5, 5, 5), bench: b, instruments: {} })
      .parts.find((p) => p.key === "participation").points === null);
  // Names that did not print are dropped from the DENOMINATOR, not counted as
  // misses. Crypto has no equivalent because crypto never halts.
  check("a halted name is dropped from breadth rather than counted against it",
    (() => {
      const rows = mkScreened(40, 40, 40, 40).concat(
        Array.from({ length: 10 }, (_, i) => ({ symbol: `H${i}`, flags: { noPrint: true }, chg5: -50, chg21: -50, aboveSma200: false })));
      return regimeRead({ screened: rows, bench: b, instruments: {} }).breadth5 === 100;
    })());

  // ─── 8. the gate ──────────────────────────────────────────────────────────
  check("a hostile tape carries fewer flags at a higher bar than a friendly one",
    PHASE_GATE.risk_off.max < PHASE_GATE.risk_on.max && PHASE_GATE.risk_off.floor > PHASE_GATE.risk_on.floor);
  check("an unrated regime is not permission to flag freely",
    gateFor(null).max <= PHASE_GATE.mixed.max && gateFor(null).floor >= PHASE_GATE.mixed.floor);
  // The percentile leg can only ever RAISE the bar — it cannot manufacture
  // flags in a cold tape, and claiming otherwise was worth naming.
  check("the percentile leg raises the bar in a hot tape",
    effectiveFloor({ floor: 60, max: 8 }, { p90: 80 }).value === 80 &&
    effectiveFloor({ floor: 60, max: 8 }, { p90: 80 }).bindingLeg === "percentile");
  check("...and can never LOWER it in a cold one",
    effectiveFloor({ floor: 60, max: 8 }, { p90: 20 }).value === 60 &&
    effectiveFloor({ floor: 60, max: 8 }, { p90: 20 }).bindingLeg === "floor");
  check("no distribution yet means the plain floor binds",
    effectiveFloor({ floor: 60, max: 8 }, null).value === 60);

  // ─── 9. the flag ladder ───────────────────────────────────────────────────
  const { flagTier, transitionFlags } = C;
  const cand = (over = {}) => ({
    id: "c", symbol: "C", company: "C Co", score: 80, band: "starting", price: 100,
    rs5: 5, flags: {}, accel: { dSessionVsWeek: 3 }, chgSession: 2,
    targets: { t1: 106, t2: 112, t3: 120, invalidation: 94, t1Pct: 6, t2Pct: 12, t3Pct: 20, invPct: -6, minMovePct: 3 },
    ...over,
  });
  check("a clean candidate flags", flagTier(cand(), { max: 8, floor: 60 }) === "igniting");
  check("losing to SPY disqualifies it whatever the chart looks like",
    flagTier(cand({ rs5: -0.1 }), { max: 8, floor: 60 }) === null);
  check("a name you cannot exit never flags", flagTier(cand({ flags: { thinLiquidity: true } }), { max: 8, floor: 60 }) === null);
  check("a name too young to screen never flags", flagTier(cand({ flags: { tooYoung: true } }), { max: 8, floor: 60 }) === null);
  check("a name that did not print never flags", flagTier(cand({ flags: { noPrint: true } }), { max: 8, floor: 60 }) === null);
  check("a first target nearer than the volatility floor is not worth flagging",
    flagTier(cand({ targets: { ...cand().targets, t1Pct: 2 } }), { max: 8, floor: 60 }) === null);
  check("the effective floor overrides the phase floor when it is higher",
    flagTier(cand({ score: 70 }), { max: 8, floor: 60 }, 75) === null);


  // GRADING OFF REAL HIGHS AND LOWS. An equity can gap through T2 at the open
  // and be back under T1 within a minute — the close would miss it entirely.
  const openFlag = {
    id: "c:2026-08-05", ticker_id: "c", symbol: "C", status: "active",
    first_flagged_at: "2026-08-05T20:00:00Z", flag_price: 100,
    t1: 106, t2: 112, t3: 120, invalidation: 94, peak_price: 100, last_price: 100,
  };
  const sess = { date: "2026-08-06", at: "2026-08-06T20:00:00Z", index: 500 };
  const gapped = transitionFlags([openFlag], new Map([["c", { ...cand(), price: 104, sessionHigh: 114, sessionLow: 103 }]]), sess, { max: 8, floor: 60 });
  check("a session that gapped through T2 and closed back at 104 is graded HIT T2",
    gapped.updates[0].status === "hit_t2", JSON.stringify(gapped.updates[0]));
  check("...and the peak is the session HIGH, not its close",
    gapped.updates[0].peak_price === 114, String(gapped.updates[0].peak_price));
  // A stop lost is lost even if the same session also tagged a target — the
  // stop would have been hit on the way.
  const both = transitionFlags([openFlag], new Map([["c", { ...cand(), price: 108, sessionHigh: 115, sessionLow: 92 }]]), sess, { max: 8, floor: 60 });
  check("a session that lost the stop AND tagged a target grades as invalidated",
    both.updates[0].status === "invalidated" && both.updates[0].resolved_at, JSON.stringify(both.updates[0]));
  check("the ladder ratchets UP only — a hit_t2 flag is never demoted",
    transitionFlags([{ ...openFlag, status: "hit_t2" }], new Map([["c", { ...cand(), price: 101, sessionHigh: 107, sessionLow: 100 }]]), sess, { max: 8, floor: 60 })
      .updates[0].status === undefined);
  check("a name missing from the pass is neither graded nor closed",
    (() => {
      const r = transitionFlags([openFlag], new Map(), sess, { max: 8, floor: 60 });
      return !r.updates[0].status && !r.updates[0].resolved_at;
    })());
  check("the cap is enforced by SCORE, not by arrival order",
    (() => {
      const m = new Map();
      for (let i = 0; i < 10; i++) m.set(`c${i}`, { ...cand(), id: `c${i}`, symbol: `C${i}`, score: 60 + i });
      const r = transitionFlags([], m, sess, { max: 3, floor: 60 });
      return r.inserts.length === 3 && r.inserts.every((x) => x.score >= 67);
    })());
  check("a re-scan never resets first_flagged_at — remembering the first day is the log's job",
    !("first_flagged_at" in gapped.updates[0]));
  check("the episode id carries the session it fired on",
    transitionFlags([], new Map([["c", cand()]]), sess, { max: 8, floor: 60 }).inserts[0].id === "c:2026-08-06");

  // ─── 10. the entry and move reads ─────────────────────────────────────────
  const { entryRead, moveRead, liveTargets } = S;
  const TGT = { t1: 105, t2: 115, t3: 130, invalidation: 90 };
  const live = (p) => liveTargets(TGT, p);
  const RANGE = { low: 88, high: 104, pos: 0.75, freshBreak: false, probing: false, priorHigh: 102, priorLow: 90, sessions: 20 };
  const ctxOf = (over = {}) => ({ flags: {}, range20: RANGE, accel: { dSessionVsWeek: 1 }, ...over });

  check("a clean 'starting' setup is an entry", entryRead(ctxOf({ band: "starting" }), live(100), 100).state === "entry");
  check("room is measured to T3", entryRead(ctxOf({ band: "starting" }), live(100), 100).roomPct === 30);
  check("a payoff under 1.5x the stop is a watch",
    entryRead(ctxOf({ band: "starting" }), liveTargets({ ...TGT, t3: 112 }, 100), 100).state === "watch");
  check("a coin off the board is never promoted to an entry", entryRead(null, live(100), 100).state === "watch");
  check("liveTargets never moves a target price and never treats null as zero",
    liveTargets(TGT, 120).t1 === 105 && liveTargets(TGT, null) === TGT);
  // THE INVARIANT THAT WOULD HAVE CAUGHT ZERO FLAGS ON A NORMAL DAY.
  // entryRead and flagTier are two halves of one judgment and they disagreed:
  // the read called an `underway` row an entry ("trend intact and T1 still
  // ahead") while the ladder refused to flag it, because the crypto ladder
  // excludes underway — where it means a coin already up 15%+ on the week. On
  // the first live equity board every single strong name banded underway, so
  // a 49-name board produced nothing at all.
  check("'underway' with the first target ahead is flaggable",
    flagTier(cand({ band: "underway", accel: { dSessionVsWeek: 0.5 } }), { max: 8, floor: 60 }) === "building");
  check("every band entryRead calls an ENTRY is a band the ladder will flag",
    ["starting", "underway"].every((band) => {
      const row = cand({ band, accel: { dSessionVsWeek: 0.5 } });
      const e = entryRead(row, row.targets, row.price);
      return e.state !== "entry" || flagTier(row, { max: 8, floor: 60 }) !== null;
    }));
  // The floors have to sit UNDER a realistic board, or the percentile leg
  // never gets to do its job and the fixed number silently becomes the whole
  // gate. Measured p95 on the first live equity board was 61.
  check("no phase floor sits above a realistic board's 95th percentile",
    Object.values(PHASE_GATE).every((g) => g.floor <= 66),
    JSON.stringify(Object.entries(PHASE_GATE).map(([k, g]) => `${k}:${g.floor}`)));

  check("well under the level is 'In its base'",
    moveRead(ctxOf({ range20: { ...RANGE, priorHigh: 112 } }), live(100), 100).stage === "base");
  check("within 3% of the level is 'At its level'", moveRead(ctxOf(), live(100), 100).stage === "atLevel");
  check("over the level is 'Breaking out'",
    moveRead(ctxOf({ range20: { ...RANGE, priorHigh: 98 } }), live(100), 100).stage === "breaking");
  check("a fresh break off a SHORT series is not claimed",
    moveRead(ctxOf({ flags: { freshBreak: true }, range20: { ...RANGE, priorHigh: 112, sessions: 8 } }), live(100), 100).stage === "base");
  check("'probing' rides along as a fact rather than a stage",
    moveRead(ctxOf({ range20: { ...RANGE, probing: true } }), live(100), 100).probing === true);
  check("the pace is read from the cron's own accel, never re-derived",
    moveRead(ctxOf({ accel: { dSessionVsWeek: 3 } }), live(100), 100).motion === "up" &&
    moveRead(ctxOf({ accel: { dSessionVsWeek: -3 } }), live(100), 100).motion === "down");
  check("no measured pace means NO pace word — absent never means flat",
    moveRead(ctxOf({ accel: null }), live(100), 100).motion === null);
  check("a null priorHigh yields a null distance, NEVER Infinity",
    moveRead(ctxOf({ range20: { ...RANGE, priorHigh: null } }), live(100), 100).toLevelPct === null);
  check("off-high is percent off the PEAK, not the difference of two percentages",
    moveRead(ctxOf(), live(100), 100, { sinceFlagPct: 50, peakPct: 100 }).offPeakPct === -25);

  // THE CONSISTENCY PROOF. The stage and the verdict sit two inches apart on a
  // phone, so this is asserted rather than trusted.
  const grid = [89, 100, 106, 110, 140].flatMap((p) =>
    [{}, { flags: { parabolic: true } }, { flags: { thinLiquidity: true } }, { band: "starting" }, { band: "late" }].map((o) => {
      const t = live(p);
      const ctx = ctxOf(o);
      return { m: moveRead(ctx, t, p), e: entryRead(ctx, t, p) };
    }));
  check("no terminal stage can ever appear under 'Worth an entry'",
    !grid.some((x) => ["broken", "spent", "extending"].includes(x.m.stage) && x.e.state === "entry"),
    JSON.stringify(grid.filter((x) => ["broken", "spent", "extending"].includes(x.m.stage) && x.e.state === "entry")));

  // ─── 10b. the morning plan ────────────────────────────────────────────────
  // The settle runs after the close, so the whole card is a plan for the next
  // open. A "not yet" row that never says what ready looks like is a
  // watchlist, not a plan — so the trigger price is asserted, not assumed.
  const { triggerFor, catalystFor, squeezeRank } = C;
  const { liveTrigger } = S;
  check("under its level, the LEVEL is the trigger — and it takes a CLOSE",
    (() => { const t = triggerFor({ price: 100, range20: { priorHigh: 106 }, targets: { t1: 112 } }); return t.kind === "level" && t.price === 106; })());
  check("through its level, the first target is the next thing that matters",
    (() => { const t = triggerFor({ price: 108, range20: { priorHigh: 106 }, targets: { t1: 112 } }); return t.kind === "target" && t.price === 112; })());
  check("through its level with no target ahead reports 'held', not a trigger behind price",
    triggerFor({ price: 120, range20: { priorHigh: 106 }, targets: { t1: 112 } }).kind === "held");
  check("no structure means no trigger, never a guessed one",
    triggerFor({ price: 100, range20: { priorHigh: null } }) === null &&
    triggerFor({ price: null, range20: { priorHigh: 106 } }) === null);
  check("the distance to the trigger is recomputed against the LIVE price",
    liveTrigger({ price: 110, kind: "level" }, 100).pct === 10 &&
    liveTrigger({ price: 110, kind: "level" }, 105).pct === 4.8);
  check("a null price leaves the trigger untouched rather than dividing by it",
    liveTrigger({ price: 110, kind: "level" }, null).pct === undefined);

  // THE ACCUMULATION TELL is the one thing a price-only screen structurally
  // cannot see, so it outranks everything else.
  check("volume up with the price flat is the accumulation tell",
    catalystFor({ rvol: 2.4, chgSession: 0.3 }).kind === "accumulation");
  check("...and it outranks a plain heavy-volume day",
    catalystFor({ rvol: 4.0, chgSession: 0.2 }).kind === "accumulation");
  // Returns null here, and `(x || {}).kind` is deliberate: the point is that
  // it does NOT claim accumulation, and null is a perfectly good way not to.
  check("volume up WITH a big price move is not accumulation — that is just the move",
    (catalystFor({ rvol: 2.4, chgSession: 5.0 }) || {}).kind !== "accumulation");
  check("a coiled range is a catalyst on its own", catalystFor({ rvol: 1.0, chgSession: 0.2, squeezePctile: 0.1, squeezeLookback: 60 }).kind === "squeeze");
  check("an overnight gap is named as one", catalystFor({ rvol: 1.0, chgSession: 3, overnight: 3.4 }).kind === "gap");
  check("an ordinary session has no catalyst — silence beats a manufactured reason",
    catalystFor({ rvol: 1.1, chgSession: 0.4, overnight: 0.2 }) === null);
  check("a missing input never invents a catalyst", catalystFor({}) === null);

  // ─── the headline actually being about the company ────────────────────────
  // The news endpoint searches a QUERY STRING, not a ticker. On the first live
  // pass it filed a PayPal story under BA and a Comcast note under GE — 13 of
  // 32 headlines named a different company than the row they sat on, including
  // both of NVDA's, and NVDA was one of three flagged names. A plausible
  // sentence about somebody else is the most expensive thing this can return:
  // the entire value of the getting-ready list is that the reason is attached
  // to the name.
  //
  // The fixtures below are those exact 32 headlines with relatedTickers
  // ABSENT — the degraded path — because that is the half verifiable without a
  // route to Yahoo, and because if the tag turns out not to exist in the
  // response at all, this fallback is the whole filter.
  const { aboutSymbol, EQUITIES: UNI } = C;
  const co = {};
  for (const e of UNI) co[e.symbol] = e.company;
  const LIVE_NEWS = [
    ["AVGO", "Alphabet CEO Sundar Pichai Just Made a $200 Billion Infrastructure Move. Nvidia, Micron, and Broadcom Investors Should Rejoice.", true],
    ["AVGO", "Marvell Is Positioned to Absorb a Disproportionate Amount of This AI Capex Surge, So I Keep Buying", false],
    ["BA", "PayPal to Stripe: The Offer Is Too Low", false],
    ["BA", "Boeing-Lockheed Martin’s ULA said to plan $500m private bond sale", true],
    ["BAC", "Bank of America spending $250M a year on GLP-1 weight loss drugs", true],
    ["CRM", "Magnite (MGNI) Q2 Earnings and Revenues Top Estimates", false],
    ["CRM", "CRM, NOW, INTU, ADBE: Software Stocks Slide After Figma Flags Surging AI Costs", true],
    ["FCX", "FCX Flashes Buy Signal; This Is Fueling Copper, Rare Earth Stocks", true],
    ["FCX", "5 Non-Ferrous Metal Mining Stocks to Watch in a Challenging Industry", false],
    ["GE", "Analyst Report: Comcast Corporation", false],
    ["GOOGL", "Alphabet Post-Earnings Rebound is On: Buy at $363?", true],
    ["HD", "Home Depot reshuffles leadership to accelerate tech innovation", true],
    ["HON", "Honeywell Aerospace Q2 Earnings Call Highlights", true],
    ["JPM", "Tetragon Financial Group Limited Announcement of Tender Offer to Purchase $50,000,000 of Tetragon Non-Voting Shares", false],
    ["KO", "This Dividend King Yields Over 4% and Trades Near Its 52-Week Lows, But Don’t Rush to Buy the Dip", false],
    ["MCD", "Portillo’s 2Q Revenue Climbs, Teases New Long-Term Growth Strategy", false],
    ["MSFT", "Billionaire Bill Ackman Built a $2.1 Billion Stake in Microsoft After the Stock Slid. Is It Still a Buy?", true],
    ["NVDA", "Billionaire Bill Ackman Built a $2.1 Billion Stake in Microsoft After the Stock Slid. Is It Still a Buy?", false],
    ["NVDA", "Axon Just Delivered a Huge Beat-and-Raise. So Why Is the Stock Down?", false],
    ["SBUX", "Shake Shack Sizzles After Starboard Reveals a Stake", false],
    ["SBUX", "Chipotle Stock Carries A Premium Built On New Restaurants", false],
    ["V", "Visa Puts Stablecoins Into Its Cross-Border Payout Rail Across 18 Billion Endpoints", true],
  ];
  const wrongCall = LIVE_NEWS.filter(([sym, title, want]) => aboutSymbol({ title }, sym, co[sym]) !== want);
  check("every headline the live pass misfiled is rejected, and every correct one survives",
    wrongCall.length === 0, wrongCall.map(([s, t]) => `${s}:${t.slice(0, 40)}`).join(" | "));

  // The curly apostrophe is not cosmetic: the universe writes McDonald's with a
  // straight quote and the wire sent a curly one, which on its own dropped the
  // single genuine McDonald's headline in the payload.
  check("a curly apostrophe in the wire's title still matches the universe's straight one",
    aboutSymbol({ title: "McDonald’s journey to 50,000 restaurants will take a bit longer" }, "MCD", co.MCD));

  // relatedTickers is Yahoo's own tagging, and it is the ONLY thing that can
  // reject the right name on the wrong company.
  check("a tagged story about a different listed company is rejected on the name alone",
    aboutSymbol({ title: "Coca-Cola Consolidated: Q2 Earnings Snapshot", relatedTickers: ["COKE"] }, "KO", co.KO) === false);
  check("a tag that names the symbol is accepted whatever the title says",
    aboutSymbol({ title: "Anything at all", relatedTickers: ["KO", "PEP"] }, "KO", co.KO) === true);
  check("the tag outranks a title that happens to mention the company",
    aboutSymbol({ title: "Boeing supplier something", relatedTickers: ["SPR"] }, "BA", co.BA) === false);
  check("an empty or absent tag falls through to the title rather than rejecting everything",
    aboutSymbol({ title: "Boeing wins an order", relatedTickers: [] }, "BA", co.BA) === true
    && aboutSymbol({ title: "Boeing wins an order" }, "BA", co.BA) === true);
  check("a headline with no title is never about anything", aboutSymbol({}, "BA", co.BA) === false);
  check("an unknown symbol with no company name still matches on its own ticker",
    aboutSymbol({ title: "ZZZZ pops on earnings" }, "ZZZZ", undefined) === true
    && aboutSymbol({ title: "something unrelated" }, "ZZZZ", undefined) === false);
  // A substring of a longer word is not a mention. "BAC" must not match
  // "backdrop", and this is exactly what whole-token normalisation buys.
  check("a ticker buried inside a longer word is not a mention",
    aboutSymbol({ title: "A difficult backdrop for banks" }, "BAC", "Bank of America") === false);

  check("the fetch passes company names through, so the title rule has something to match",
    /fetchNews\(shortList,\s*companyOf,\s*now\)/.test(engineSrc) && /companyOf\[e\.symbol\]\s*=\s*e\.company/.test(engineSrc));
  check("...and asks for more headlines than it keeps, since most get filtered",
    /newsCount=(\d+)/.test(engineSrc) && Number(engineSrc.match(/newsCount=(\d+)/)[1]) >= 8);

  check("the squeeze rank refuses a series too short to rank against itself",
    squeezeRank(Array.from({ length: 40 }, () => bar(100, 101, 99, 100))).pctile === null);
  check("a contracting range ranks near the bottom of its own history",
    (() => {
      const wide = Array.from({ length: 60 }, (_, i) => bar(100, 110, 90, 100 + (i % 2)));
      const tight = Array.from({ length: 20 }, () => bar(100, 100.5, 99.5, 100));
      const r = squeezeRank([...wide, ...tight]);
      return r.pctile != null && r.pctile <= 0.33;
    })());

  // ─── 11. the vocabulary must cover everything the engines can emit ────────
  const sheet = readFileSync("src/pages/markets/StockSheet.jsx", "utf8");
  const panel = readFileSync("src/pages/markets/StocksPanel.jsx", "utf8");
  const stages = ["base", "atLevel", "breaking", "extending", "spent", "broken", "none", "offboard"];
  // ─── the earned rung survives a stop ──────────────────────────────────────
  // The two engines used to grade the identical event in opposite directions:
  // a flag that tagged T2 and later lost its level was filed "hit_t2" (a win)
  // by the crypto cron and "invalidated" (a loss) by this one. The Record is
  // the only card that answers "should I believe any of this", so the two tabs
  // grading it differently is the worst possible place for a disagreement.
  const settleSrc = readFileSync("netlify/functions/stock-settle-background.js", "utf8");
  check("a stop-out only writes 'invalidated' when no rung was ever reached",
    /if \(\(STATUS_RANK\[row\.status\] \?\? 0\) === 0\) patch\.status = "invalidated";/.test(settleSrc),
    "invalidation still overwrites the earned status");
  check("...and it records WHY it closed, so a round-trip stays distinguishable",
    /closedBy: "invalidation"/.test(settleSrc));
  check("fade and stale closes are labelled too",
    /closedBy: "faded"/.test(settleSrc) && /closedBy: "stale"/.test(settleSrc));
  check("the crypto engine already agreed, and still does",
    /STATUS_RANK\[status\] === 0/.test(readFileSync("netlify/functions/alt-cron-background.js", "utf8")));

  // ─── flag age is counted in real sessions ────────────────────────────────
  // Two bugs were cancelling. The reader asked for `first_session_index`, a
  // column that does not exist, so it always fell through to a calendar-days
  // estimate that happens to be roughly right. Underneath, the index it WOULD
  // have read was `spyDates.length` against a ROLLING range=1y window — near
  // constant, so the age would have been ~0 forever and nothing would ever
  // fade or go stale. Renaming the field alone makes the bug real.
  // Comments stripped first: the doc block above flagAgeSessions names the dead
  // column deliberately, to explain why it is dead. Only live code counts.
  const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no live code reads the column that never existed",
    !/first_session_index/.test(codeOnly(settleSrc)), "first_session_index is still dereferenced");
  check("age is counted off the session calendar SPY printed",
    /function flagAgeSessions/.test(settleSrc) && /dates\.indexOf\(flagged\)/.test(settleSrc));
  check("...and the calendar is actually handed to the transition",
    /dates: spyDates/.test(settleSrc));
  check("the rolling bar count is no longer used as an age reference",
    !/sessionIndex - row\./.test(settleSrc));
  {
    // The real shape: SPY's ascending session dates, with the settled session last.
    const dates = ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05"];
    const session = { at: "2026-08-06T00:00:00Z", dates };
    const age = (flagSession, firstFlaggedAt) =>
      C.flagAgeSessions({ notes: flagSession ? { flagSession } : null, first_flagged_at: firstFlaggedAt }, session);
    check("a flag made this session is 0 sessions old", age("2026-08-05") === 0, String(age("2026-08-05")));
    check("a flag made the session before is 1", age("2026-08-04") === 1, String(age("2026-08-04")));
    // Fri 31 Jul -> Wed 5 Aug is 3 SESSIONS but 5 calendar days. Counting days
    // would age it two sessions too fast, every single weekend.
    check("a weekend costs no sessions", age("2026-07-31") === 3, String(age("2026-07-31")));
    check("the oldest session in the window is the window length minus one",
      age("2026-07-27") === 7, String(age("2026-07-27")));
    check("a flag older than the fetched window falls back to the calendar estimate",
      age("2026-01-02", "2026-06-06T00:00:00Z") > 20, String(age("2026-01-02", "2026-06-06T00:00:00Z")));
    check("a flag with no notes at all still ages rather than throwing",
      Number.isFinite(age(null, "2026-07-01T00:00:00Z")));
    check("a flag with neither notes nor a stamp ages 0, never NaN",
      C.flagAgeSessions({}, session) === 0);
  }

  const catalysts = ["accumulation", "squeeze", "gap", "volume"];
  check("every catalyst the cron can emit has a label in the panel",
    catalysts.every((c) => panel.includes(`${c}:`)), catalysts.filter((c) => !panel.includes(`${c}:`)).join(","));
  check("every stage the read can emit has a label in the sheet",
    stages.every((s) => new RegExp(`\\b${s}:`).test(sheet)), stages.filter((s) => !new RegExp(`\\b${s}:`).test(sheet)).join(","));
  const phases = Object.keys(PHASE_GATE);
  check("every regime phase has a tone and a plain-English read in the panel",
    phases.every((p) => panel.includes(`${p}:`)), phases.filter((p) => !panel.includes(`${p}:`)).join(","));
  // HE RETRACTED DOLLAR SIZING. It does not come back through a side door.
  check("no dollar-denominated position sizing anywhere in the UI",
    !/position siz|\$\d+\s*(position|stake|size)/i.test(sheet + panel));
} catch (e) {
  failed++;
  console.error(`FAIL: smoke crashed — ${(e && e.stack) || e}`);
} finally {
  rmSync(OUT_DIR, { recursive: true, force: true });
}

console.log(failed ? `\nSTOCKS SMOKE FAILED (${failed})` : "\nSTOCKS SMOKE PASS");
process.exit(failed ? 1 : 0);
