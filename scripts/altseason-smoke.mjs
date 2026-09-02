// ─── Alt Season smoke — the hourly brain's math, with known answers ──────────
// alt-cron-background.js is the only place the Alt Season tab's judgment lives: the
// 100-point screen, the season regime, the price targets, and the flag log's
// entire grading ladder. None of it is exercised by `vite build`, none of it
// throws when a threshold drifts, and the flag log is APPEND-ONLY history — a
// transition bug doesn't show up as an error, it shows up three weeks later as
// a record that quietly graded every episode wrong and cannot be rebuilt.
//
// So: bundle the function the way Netlify does (the functions-smoke technique —
// read that file's header for the triple outage behind it), require the output,
// and assert the exported pure helpers against fixtures with answers a reader
// can verify by eye. The specific regressions pinned here:
//
//   1. parts[] always sums to score — the penalty is clamped to points earned,
//      so a parabolic coin floors at a true 0 and the table never lies.
//   2. priorLow excludes the last day. Pentagon's sentinel once compared price
//      to a minimum taken over a window CONTAINING that price, and "invalidation
//      hit" fired on every row making its own 7-day low — the series testing
//      itself, 1,276 times in 20,000 tapes.
//   3. The flag ladder ratchets up only, against targets FROZEN at flag time,
//      and a re-scan never resets first_flagged_at. The log's one job is
//      remembering the FIRST day; a reset erases the record's reason to exist.
//
// Zero network. Run with `node scripts/altseason-smoke.mjs`.

import esbuild from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const FN_DIR = "netlify/functions";
const OUT_DIR = ".altseason-smoke";
const require_ = createRequire(import.meta.url);

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
// Float-safe equality — the target math multiplies decimals and 1.5/1.2 is not
// exactly 1.25 in binary.
const near = (a, b, eps = 1e-6) =>
  Number.isFinite(a) && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

try {
  // ─── 0. the functions-smoke assertion, early: a bundle with no handler is a
  // 502 that deploys clean. All three alt functions, before any math. ─────────
  const mods = {};
  for (const name of ["alt-cron-background", "alt-scan", "alt-candles"]) {
    try {
      const out = resolve(OUT_DIR, `${name}.cjs`);
      esbuild.buildSync({
        entryPoints: [join(FN_DIR, `${name}.js`)],
        bundle: true, platform: "node", format: "cjs",
        outfile: out, logLevel: "silent",
      });
      mods[name] = require_(out);
      check(`${name} bundles with a callable handler`, typeof mods[name].handler === "function",
        `exports are ${JSON.stringify(Object.keys(mods[name] || {}))}`);
    } catch (e) {
      failed++;
      console.error(`FAIL: ${name} did not bundle/load — ${(e.message || String(e)).split("\n")[0]}`);
    }
  }

  const cron = mods["alt-cron-background"];
  if (!cron) throw new Error("alt-cron-background did not load — the fixture suite cannot run");
  const {
    parseMarketsRow, priceAgo, isStablecoin, isWrapper, structure7d, PHASE_GATE,
    screenCoin, screenUniverse, seasonRead, targetsFor, flagTier, transitionFlags,
    DOM_WINDOW_DAYS, DOM_KEEP_DAYS,
  } = cron;

  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const NOW = Date.parse("2026-08-05T12:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();

  // The shared BTC bar: +2% on the week, +5% on the month.
  const BTC = { id: "bitcoin", symbol: "BTC", name: "Bitcoin", rank: 1, price: 60000, mcap: 2e12, vol24h: 3e10, chg1h: 0.1, chg24h: 0.5, chg7d: 2, chg30d: 5, sparkline7d: null, ath: 73000, athChangePct: -17, athDate: "2024-03-14T00:00:00.000Z" };

  // 28 points, so a "day" is 4. Prior 24 top out at 0.95; the last day clears
  // it and closes at the high of its own week — a clean ignition tape.
  const IGNITION_SPARK = [
    0.80, 0.82, 0.81, 0.83, 0.84, 0.83, 0.85, 0.86,
    0.85, 0.87, 0.88, 0.87, 0.89, 0.90, 0.89, 0.91,
    0.90, 0.92, 0.91, 0.93, 0.92, 0.94, 0.93, 0.95,
    0.96, 0.97, 0.99, 1.00,
  ];

  // ─── 1. screenCoin — parts[] sums to score, and the clamp is real ──────────
  // Every threshold this row crosses is written next to the field it earns:
  // rs7 12 (+12pts) · rs30 5 (+5) · accel24 7 (+14) · accel7v30 1.67 (+12) ·
  // turnover 0.12 (+11) · pos 1.0 (+10) · fresh break (+10) · 75% off ATH (+8).
  const cleanRaw = {
    id: "altcoin", symbol: "ALT", name: "Alt Coin", rank: 40,
    price: 1.0, mcap: 5e8, vol24h: 6e7,
    chg1h: 1, chg24h: 9, chg7d: 14, chg30d: 10,
    sparkline7d: IGNITION_SPARK, ath: 4, athChangePct: -75, athDate: "2025-01-01T00:00:00.000Z",
  };
  const clean = screenCoin(cleanRaw, { btcRow: BTC });
  const sumParts = (r) => r.parts.reduce((s, p) => s + p.points, 0);
  check("clean ignition scores 82 — every point accounted for", clean.score === 82, `got ${clean.score}`);
  check("clean ignition parts[] sums to score", sumParts(clean) === clean.score);
  check("clean ignition bands 'starting'", clean.band === "starting", clean.band);

  // MEASURED IS NOT ZERO — the same stamp the equity engine carries, because
  // the two sheets that read parts[] are twins and a per-part bar must not
  // draw "BTC didn't return" as "worst coin on the board".
  check("every part says whether it was measured",
    clean.parts.every((p) => typeof p.measured === "boolean"),
    clean.parts.filter((p) => typeof p.measured !== "boolean").map((p) => p.key).join(","));
  check("with BTC present, every part of a full row is measured",
    clean.parts.every((p) => p.measured), clean.parts.filter((p) => !p.measured).map((p) => p.key).join(","));
  const noBtc = screenCoin(cleanRaw, {});
  const cKey = Object.fromEntries(noBtc.parts.map((p) => [p.key, p]));
  check("no BTC row marks RS unmeasured rather than scoring it zero",
    cKey.rs7.measured === false && cKey.rs30.measured === false && cKey.rs7.points === 0,
    JSON.stringify([cKey.rs7, cKey.rs30]));
  check("...while turnover and structure, which never needed BTC, stay measured",
    cKey.range.measured && cKey.room.measured);
  check("an unmeasured part still contributes its 0, so the sum survives",
    sumParts(noBtc) === noBtc.score, `${sumParts(noBtc)} vs ${noBtc.score}`);
  // Both engines must agree on the block architecture — one shared sheet
  // component reads both, so a max that drifts on one side silently rescales
  // every bar on the other.
  const maxOf = (r) => r.parts.filter((p) => p.max > 0).reduce((s, p) => s + p.max, 0);
  check("the crypto ladder offers exactly 100 points", maxOf(clean) === 100, String(maxOf(clean)));

  // A blow-off that EARNED only 6 points: the −25 must land as −6, not drive
  // the score below zero and not break the by-eye arithmetic.
  const blowoff = screenCoin({ id: "moon", symbol: "MOON", name: "Moon Token", price: 2, chg24h: 45, chg7d: 308 }, {});
  check("parabolic row floors at a true 0, never negative", blowoff.score === 0, `got ${blowoff.score}`);
  check("parabolic parts[] still sums to score", sumParts(blowoff) === blowoff.score);
  check("parabolic penalty clamps to the points earned",
    blowoff.parts.find((p) => p.key === "parabolic")?.points === -6,
    JSON.stringify(blowoff.parts.map((p) => [p.key, p.points])));
  check("parabolic flag is set", blowoff.flags.parabolic === true);

  // ─── 2. the exclusion sets — a dollar is not a mover ───────────────────────
  check("USDT is a stablecoin", isStablecoin({ symbol: "USDT" }));
  check("PAXG (gold peg) is a stablecoin", isStablecoin({ symbol: "PAXG" }));
  check("a flat $1B+ unknown trips the flatness heuristic",
    isStablecoin({ id: "flatco", symbol: "FLT", name: "FlatCo", price: 0.999, mcap: 1.5e9, chg24h: 0.1, chg7d: 0.4, chg30d: 1.1 }));
  check("BTC in a quiet month is NEVER deleted by the heuristic",
    !isStablecoin({ id: "bitcoin", symbol: "BTC", name: "Bitcoin", price: 60000, mcap: 2e12, chg24h: 0.1, chg7d: 0.4, chg30d: 1.0 }));
  check("WSTETH is a wrapper", isWrapper({ symbol: "WSTETH" }));
  check("a coin NAMED 'Wrapped Foo' is a wrapper", isWrapper({ symbol: "FOO", name: "Wrapped Foo" }));
  check("WIF is not eaten by the wrapper heuristics", !isWrapper({ id: "dogwifhat", symbol: "WIF", name: "dogwifhat" }));

  // ─── 3. structure7d — levels come from bars that are DONE ──────────────────
  // 14 points → a "day" is 2. Prior twelve range 1.0–1.2.
  const PRIOR = [1.0, 1.05, 1.1, 1.12, 1.15, 1.18, 1.2, 1.14, 1.1, 1.16, 1.19, 1.18];
  const sBreak = structure7d([...PRIOR, 1.21, 1.25]);
  const sInside = structure7d([...PRIOR, 1.15, 1.18]);
  const sTouch = structure7d([...PRIOR, 1.1, 1.2]);
  const sNewLow = structure7d([...PRIOR, 0.9, 0.8]);
  check("fresh break: last day clears the prior high", sBreak.freshBreak === true && near(sBreak.priorHigh, 1.2));
  check("no break while the last day stays inside", sInside.freshBreak === false);
  check("touching the prior high is not a break (strict >)", sTouch.freshBreak === false);
  check("pos stays in [0,1] across the tapes",
    [sBreak, sInside, sTouch, sNewLow].every((s) => s.pos >= 0 && s.pos <= 1),
    JSON.stringify([sBreak.pos, sInside.pos, sTouch.pos, sNewLow.pos]));
  // THE SENTINEL BUG. A row making its own 7-day low: `low` follows price down,
  // priorLow must not — a level that moves with price is not a level.
  check("priorLow excludes the last day", near(sNewLow.priorLow, 1.0), `got ${sNewLow.priorLow}`);
  check("...while the range low includes it", near(sNewLow.low, 0.8) && sNewLow.priorLow > sNewLow.low);
  check("a short series answers null, not garbage",
    structure7d([1, 2, 3]).pos === null && structure7d([1, 2, 3]).priorHigh === null);
  check("a dead-flat series has no pos (zero range)", structure7d(Array(14).fill(1)).pos === null);

  // ─── 4. band ordering — 'late' is a verdict, not a score bucket ────────────
  // Same ignition tape, but up 45% today: parabolic must beat 'starting'.
  const late = screenCoin({ ...cleanRaw, chg24h: 45, chg7d: 30, chg30d: 20 }, { btcRow: BTC });
  check("parabolic → late beats starting", late.band === "late", late.band);
  // Up 60% on the week and breaking out: running, not lighting.
  const running = screenCoin({ ...cleanRaw, chg24h: 15, chg7d: 60, chg30d: 70 }, { btcRow: BTC });
  check("a +60% week breaking out is NOT 'starting'", running.band !== "starting", running.band);
  check("...it is 'underway'", running.band === "underway", running.band);

  // ─── 5. targetsFor — measured moves off a 1.0–1.5 base (h = 0.5) ───────────
  const tRow = (price, priorHigh, priorLow, freshBreak, ath = null) =>
    ({ price, ath, range7d: { priorHigh, priorLow, freshBreak } });

  const building = targetsFor(tRow(1.2, 1.5, 1.0, false));
  check("building T1 IS the prior high", near(building.t1, 1.5), `got ${building?.t1}`);
  check("building T2/T3 step +0.5h/+1.0h", near(building.t2, 1.75) && near(building.t3, 2.0));
  check("building invalidation is the prior low", near(building.invalidation, 1.0));
  check("t1Pct is % vs current price, 1dp", near(building.t1Pct, 25.0, 1e-3), `got ${building?.t1Pct}`);

  const breakout = targetsFor(tRow(1.6, 1.5, 1.0, true));
  check("breakout targets are the measured moves (0.382/0.618/1.0)",
    near(breakout.t1, 1.691) && near(breakout.t2, 1.809) && near(breakout.t3, 2.0),
    JSON.stringify(breakout));
  check("breakout invalidation is the 0.382 retrace", near(breakout.invalidation, 1.309));

  const clamped = targetsFor(tRow(1.65, 1.5, 1.0, true));
  check("a T1 under +5% is bumped to +5%", near(clamped.t1, 1.65 * 1.05), `got ${clamped?.t1}`);
  // THE DEAD BAND. The bump used to fire under +4% while the flag gate asked
  // for +5%, so a structural T1 3.9% away was lifted and flagged while one at
  // 4.5% was refused: the gate read backwards across [4%, 5%). One threshold.
  const t45 = targetsFor(tRow(1.0, 1.045, 0.85, false));
  check("a T1 4.5% away is bumped to +5% too — no dead band under the gate",
    t45 && near(t45.t1, 1.05) && t45.t1Pct === 5, JSON.stringify(t45));

  // Price already through the prior high — breakout path without a fresh-break
  // flag — and far enough that the clamp cascades through T2.
  const cascade = targetsFor(tRow(1.79, 1.5, 1.0, false));
  check("price above the prior high takes the breakout path", near(cascade.invalidation, 1.309), JSON.stringify(cascade));
  check("cascade keeps T1<T2<T3 strictly", cascade.t1 < cascade.t2 && cascade.t2 < cascade.t3, JSON.stringify(cascade));

  const snapped = targetsFor(tRow(1.2, 1.5, 1.0, false, 1.9));
  check("an ATH just under T3 snaps T3 onto it", near(snapped.t3, 1.9), `got ${snapped?.t3}`);
  check("...without touching the targets below it", near(snapped.t1, 1.5) && near(snapped.t2, 1.75));
  check("an ATH far above T3 snaps nothing", near(targetsFor(tRow(1.2, 1.5, 1.0, false, 5)).t3, 2.0));

  check("T1 ≥ price×1.05 on every result",
    [[1.2, building], [1.6, breakout], [1.65, clamped], [1.79, cascade], [1.2, snapped]]
      .every(([p, t]) => t && t.t1 >= p * 1.05 - 1e-9));
  // T3 IS NEVER THE CLAMP'S. Every ladder above tops out at the measured move
  // (priorHigh + h = 2.0, or the ATH it snapped to) — the clamps may lift T1
  // and T2 under it, never T3 past it.
  check("T3 is the structure's on every result, never a clamped number",
    near(building.t3, 2.0) && near(breakout.t3, 2.0) && near(clamped.t3, 2.0) && near(cascade.t3, 2.0) && near(snapped.t3, 1.9),
    JSON.stringify([building.t3, breakout.t3, clamped.t3, cascade.t3, snapped.t3]));
  // THE MANUFACTURED LADDER. Price 1.20 through a 0.90–1.10 base: structural
  // T1 1.176 and T2 1.224 are behind or under the bump, and T3 1.30 sits under
  // the clamped T2's +2% step. This used to ship +5/+7.1/+9.2% — three numbers
  // no chart drew, which a bull hour cleared and the Record then graded as a
  // T3 hit. Forty-six of the first fifty-five flags carried that T1.
  check("price through most of its measured move gets no ladder, not an invented one",
    targetsFor(tRow(1.2, 1.1, 0.9, false)) === null, JSON.stringify(targetsFor(tRow(1.2, 1.1, 0.9, false))));
  check("price above the structural T3 yields no targets",
    targetsFor(tRow(2.1, 1.5, 1.0, false)) === null);
  check("a base too tight to measure a move off yields no targets",
    targetsFor(tRow(1.0, 1.02, 0.99, false)) === null);
  check("...while a move with its T3 still ahead keeps the real T3",
    near(targetsFor(tRow(1.0, 1.01, 0.9, false)).t3, 1.12), JSON.stringify(targetsFor(tRow(1.0, 1.01, 0.9, false))));
  check("a flat sparkline yields no targets",
    targetsFor({ price: 1, range7d: structure7d(Array(14).fill(1)) }) === null);
  check("an invalidation at price is no structure at all — null",
    targetsFor(tRow(1.21, 1.5, 1.2, false)) === null);

  // ─── 6. flagTier — the thresholds, and the rows that must never flag ───────
  const T_OK = { t1: 1.08, t2: 1.15, t3: 1.25, invalidation: 0.9, t1Pct: 8, t2Pct: 15, t3Pct: 25, invPct: -10 };
  const fRow = (o = {}) => ({
    id: "altcoin", symbol: "ALT", name: "Alt Coin", rank: 40,
    price: 1, mcap: 5e8, vol24h: 5e7,
    chg1h: 1, chg24h: 9, chg7d: 14, chg30d: 10,
    score: 60, band: "starting",
    flags: { stablecoin: false, wrapper: false, parabolic: false, thinLiquidity: false, freshBreak: true, newListing: false },
    accel: { d24VsWeek: 7, weekVsMonth: 1.7, daily7d: 2, daily30d: 0.33 },
    range7d: { low: 0.8, high: 1, last: 1, pos: 1, freshBreak: true, priorHigh: 0.95, priorLow: 0.8, points: 28 },
    rsVsBtc7d: 12, targets: T_OK,
    ...o,
  });
  // The floor is the REGIME's now, not a constant — see PHASE_GATE. These use
  // the default gate (floor 70) unless they pass one explicitly.
  const GATE_ALT = PHASE_GATE.alt_season;      // loosest: max 14 / floor 62
  const GATE_BTC = PHASE_GATE.btc_only;        // tightest real tape: 5 / 74

  check("starting clears the alt-season floor and ignites", flagTier(fRow({ score: 62 }), GATE_ALT) === "igniting");
  check("one point under that floor does not", flagTier(fRow({ score: 61 }), GATE_ALT) === null);
  // The same 62-score chart in a Bitcoin-only tape: identical setup, no flag.
  // This is the whole point of the gate — 52 open flags in a btc_only market
  // is what it exists to prevent.
  check("the SAME setup is refused in a btc_only regime", flagTier(fRow({ score: 62 }), GATE_BTC) === null);
  check("...and clears it once it is genuinely exceptional", flagTier(fRow({ score: 74 }), GATE_BTC) === "igniting");
  check("no gate passed falls back to the default floor, not to free rein",
    flagTier(fRow({ score: 69 })) === null && flagTier(fRow({ score: 70 })) === "igniting");

  check("underway ignites on real acceleration", flagTier(fRow({ band: "underway", score: 70, chg24h: 20, accel: { d24VsWeek: 4 } })) === "igniting");
  check("underway up 21% on the day is a chase, not a flag", flagTier(fRow({ band: "underway", score: 70, chg24h: 21, accel: { d24VsWeek: 4 } })) === null);
  check("underway without the acceleration is not igniting", flagTier(fRow({ band: "underway", score: 70, chg24h: 20, accel: { d24VsWeek: 3.9 } })) === null);
  check("warming over the floor builds", flagTier(fRow({ band: "warming", score: 70 })) === "building");
  check("warming under it does not", flagTier(fRow({ band: "warming", score: 69 })) === null);
  // 'quiet' was the rung that supplied most of the fifty-two. It is gone: a
  // base with nothing lifting it is a watchlist entry, and the board lists it.
  check("quiet never flags now, however high it scores",
    flagTier(fRow({ band: "quiet", score: 95, range7d: { pos: 0.9 }, rsVsBtc7d: 5 })) === null);
  check("losing to BTC disqualifies an alt setup outright",
    flagTier(fRow({ score: 90, rsVsBtc7d: 0 })) === null && flagTier(fRow({ score: 90, rsVsBtc7d: -1 })) === null);
  check("BTC is never flagged", flagTier(fRow({ symbol: "BTC", score: 90 })) === null);
  check("thin liquidity is never flagged", flagTier(fRow({ flags: { thinLiquidity: true } })) === null);
  check("under $1M of volume is never flagged", flagTier(fRow({ vol24h: 9e5 })) === null);
  check("a T1 under 5% away is never flagged", flagTier(fRow({ targets: { ...T_OK, t1Pct: 4.9 } })) === null);
  // ...and the gate is monotone in the structure: a T1 4.5% away (bumped to 5,
  // see section 5's t45) flags exactly as one 3.9% away does — the [4%, 5%)
  // dead band where the bump and the gate disagreed is gone.
  check("a structural T1 in the old dead band flags like one under it",
    flagTier(fRow({ score: 70, targets: targetsFor(tRow(1.0, 1.039, 0.85, false)) })) === "igniting" &&
    flagTier(fRow({ score: 70, targets: t45 })) === "igniting");
  check("no targets, no flag", flagTier(fRow({ targets: null })) === null);

  // ─── 7. transitionFlags — the episode ladder, end to end ───────────────────
  // The screened row as the cron hands it over: screenCoin output + targets.
  const screened = { ...clean, targets: targetsFor(clean) };
  check("the clean ignition is flag-eligible end to end", flagTier(screened) === "igniting");

  const run1 = transitionFlags([], { altcoin: screened }, NOW);
  const ep = run1.inserts[0];
  check("first sight inserts one episode", run1.inserts.length === 1 && run1.updates.length === 0);
  check("the id embeds the UTC day of the FIRST flag", ep?.id === "altcoin:20260805", ep?.id);
  check("the episode opens active with frozen targets",
    ep?.status === "active" && ep?.tier === "igniting" && near(ep?.t1, screened.targets.t1) && ep?.resolved_at === null);

  // THE REGRESSION THAT MATTERS MOST: the same scan an hour later.
  const run2 = transitionFlags([ep], { altcoin: screened }, NOW + HOUR);
  const u2 = run2.updates.find((u) => u.id === ep.id);
  check("a re-scan of an open flag inserts NOTHING", run2.inserts.length === 0, JSON.stringify(run2.inserts.map((i) => i.id)));
  check("...and never touches first_flagged_at", !u2 || !("first_flagged_at" in u2), JSON.stringify(u2));

  // Update-path fixtures: frozen targets t1 1.1 / t2 1.2 / t3 1.4 / inv 0.9.
  // The live screened row deliberately carries DIFFERENT targets — the ladder
  // must grade against the frozen ones.
  const mkFlag = (o = {}) => ({
    id: "altcoin:20260801", coin_id: "altcoin", symbol: "ALT", name: "Alt Coin",
    tier: "building", status: "active",
    first_flagged_at: iso(NOW - 4 * DAY), flag_price: 1.0, score: 55,
    t1: 1.1, t2: 1.2, t3: 1.4, invalidation: 0.9,
    peak_price: 1.0, peak_at: iso(NOW - 4 * DAY),
    last_price: 1.0, last_seen_at: iso(NOW - HOUR),
    resolved_at: null, notes: {},
    ...o,
  });
  const scr = (price, o = {}) => fRow({
    price, score: 55, band: "warming",
    flags: { stablecoin: false, wrapper: false, parabolic: false, thinLiquidity: false, freshBreak: false, newListing: false },
    accel: { d24VsWeek: 1, weekVsMonth: 0.5, daily7d: 2, daily30d: 0.33 },
    range7d: { low: 0.8, high: 1.2, last: price, pos: 0.8, freshBreak: false, priorHigh: 1.1, priorLow: 0.8, points: 28 },
    targets: { t1: 9, t2: 9.5, t3: 10, invalidation: 0.1, t1Pct: 800, t2Pct: 850, t3Pct: 900, invPct: -90 },
    ...o,
  });
  const step = (flag, row) => transitionFlags([flag], { altcoin: row }, NOW).updates.find((u) => u.id === flag.id);

  const dip = step(mkFlag({ status: "hit_t2", peak_price: 1.3 }), scr(1.05));
  check("the peak never falls", dip && dip.last_price === 1.05 && !("peak_price" in dip), JSON.stringify(dip));
  const push = step(mkFlag({ status: "hit_t2", peak_price: 1.3 }), scr(1.45));
  check("the peak ratchets up and carries peak_at", push?.peak_price === 1.45 && !!push?.peak_at);
  check("peak 1.45 grades hit_t3 on the FROZEN t3", push?.status === "hit_t3", push?.status);
  // THE CLOSE THAT NEVER CAME. hit_t3 is the top of the ladder and the equity
  // engine closes on it; this one left the row open until the 14-day stale
  // timer, which every new peak reset — so twelve month-old winners held the
  // whole regime budget and no flag opened for four weeks.
  check("peak through T3 closes the episode", !!push?.resolved_at && push?.notes?.closedBy === "target", JSON.stringify(push));
  const alreadyT3 = step(mkFlag({ status: "hit_t3", peak_price: 1.45, peak_at: iso(NOW - 2 * DAY) }), scr(1.3));
  check("an open row already at hit_t3 is closed on sight", !!alreadyT3?.resolved_at && alreadyT3?.notes?.closedBy === "target", JSON.stringify(alreadyT3));
  const unseenT3 = transitionFlags([mkFlag({ status: "hit_t3", peak_price: 1.45, peak_at: iso(NOW - 2 * DAY) })], {}, NOW)
    .updates.find((u) => u.id === "altcoin:20260801");
  check("...with or without a screened row this pass", !!unseenT3?.resolved_at && unseenT3?.notes?.closedBy === "target");
  const t3Then = step(mkFlag({ status: "hit_t3", peak_price: 1.45 }), scr(0.85));
  check("a T3 winner through its level closes as the round-trip, not the target",
    !!t3Then?.resolved_at && t3Then?.status === undefined && t3Then?.notes?.closedBy === "invalidation", JSON.stringify(t3Then));

  const rung1 = step(mkFlag(), scr(1.15));
  check("active → hit_t1 against the frozen T1, not the live one", rung1?.status === "hit_t1" && !("resolved_at" in rung1), JSON.stringify(rung1));
  const noDown = step(mkFlag({ status: "hit_t2", peak_price: 1.25 }), scr(0.95));
  check("the ladder never ratchets down", !noDown || !("status" in noDown), JSON.stringify(noDown));

  const inval = step(mkFlag(), scr(0.85));
  check("price through invalidation closes the episode", !!inval?.resolved_at && inval?.status === "invalidated");
  check("...and records why", inval?.notes?.closedBy === "invalidation");
  const invalKept = step(mkFlag({ status: "hit_t1", peak_price: 1.15 }), scr(0.85));
  check("a hit that round-tripped keeps its hit, closed by invalidation",
    !!invalKept?.resolved_at && invalKept?.status !== "invalidated" && invalKept?.notes?.closedBy === "invalidation",
    JSON.stringify(invalKept));

  const faded = step(mkFlag({ first_flagged_at: iso(NOW - 100 * HOUR), peak_at: iso(NOW - 100 * HOUR) }), scr(1.02, { score: 30, band: "cold" }));
  check("a dead setup past 72h fades", faded?.status === "faded" && !!faded?.resolved_at, JSON.stringify(faded));
  const young = step(mkFlag({ first_flagged_at: iso(NOW - 24 * HOUR), peak_at: iso(NOW - 24 * HOUR) }), scr(1.02, { score: 30, band: "cold" }));
  check("faded needs >72h — one bad day is not a fade", !young || !("resolved_at" in young), JSON.stringify(young));
  const alive = step(mkFlag({ first_flagged_at: iso(NOW - 100 * HOUR), peak_at: iso(NOW - 100 * HOUR) }), scr(1.02, { score: 50 }));
  check("faded needs score<35 — a live setup stays open", !alive || !("resolved_at" in alive), JSON.stringify(alive));

  const stale = transitionFlags([mkFlag({ status: "hit_t1", peak_price: 1.15, peak_at: iso(NOW - 15 * DAY) })], {}, NOW)
    .updates.find((u) => u.id === "altcoin:20260801");
  check("14 days without a new peak closes, status kept",
    !!stale?.resolved_at && !("status" in stale), JSON.stringify(stale));

  const upgrade = step(mkFlag(), scr(1.0, { score: 60, band: "starting" }));
  check("building upgrades to igniting when the move ignites",
    upgrade?.tier === "igniting" && !!upgrade?.notes?.tierUpgradedAt);
  check("...and the upgrade never resets first_flagged_at", !upgrade || !("first_flagged_at" in upgrade));

  const reflag = transitionFlags(
    [mkFlag({ id: "altcoin:20260728", resolved_at: iso(NOW - 2 * DAY) })],
    { altcoin: screened }, NOW,
  );
  check("a closed episode re-flagging starts a NEW episode with a NEW id",
    reflag.inserts.length === 1 && reflag.inserts[0].id === "altcoin:20260805" && reflag.updates.length === 0,
    JSON.stringify({ inserts: reflag.inserts.map((i) => i.id), updates: reflag.updates.length }));

  // ─── 7b. the regime's flag budget — the fifty-two-flag fix ─────────────────
  // Twelve identical-quality candidates, scored 90 down to 79, into a
  // `btc_only` tape whose budget is five. The cap has to bite, and it has to
  // spend the five on the BEST five rather than on whichever the iteration
  // order reached first (that order is market-cap rank, i.e. unrelated to the
  // setup).
  const many = {};
  for (let i = 0; i < 12; i++) {
    const id = `c${String(i).padStart(2, "0")}`;
    many[id] = { ...screened, id, symbol: `C${i}`, name: `Coin ${i}`, score: 90 - i };
  }
  const capped = transitionFlags([], many, NOW, PHASE_GATE.btc_only);
  check("the regime cap bites — 12 qualifiers, 5 opened",
    capped.inserts.length === 5, String(capped.inserts.length));
  check("...and it spends the budget on the highest scores",
    capped.inserts.map((r) => r.symbol).sort().join(",") === "C0,C1,C2,C3,C4",
    capped.inserts.map((r) => `${r.symbol}:${r.score}`).join(" "));
  check("a looser regime opens more of the same list",
    transitionFlags([], many, NOW, PHASE_GATE.alt_season).inserts.length === 12);
  // Rows already open consume the budget — the cap is on OPEN episodes, not on
  // inserts per pass, or every hour would top the list back up to five.
  const openAlready = capped.inserts.map((r) => ({ ...r, notes: {} }));
  check("existing open flags spend the budget too",
    transitionFlags(openAlready, many, NOW, PHASE_GATE.btc_only).inserts.length === 0);
  // A FLAG CLOSED THIS PASS IS NOT OPEN. One of the five prints its T3 on this
  // scan: the slot it frees goes to the best of the seven still waiting, on
  // the same pass — not to nobody, and not back to the coin that just closed.
  const oneDone = openAlready.map((r, i) => (i === 0 ? { ...r, t3: many[r.coin_id].price * 0.5 } : r));
  const freed = transitionFlags(oneDone, many, NOW, PHASE_GATE.btc_only);
  check("a slot freed by a close this pass is filled on the same pass",
    freed.inserts.length === 1 && freed.inserts[0].symbol === "C5",
    JSON.stringify({ inserts: freed.inserts.map((r) => r.symbol), closed: freed.updates.filter((u) => u.resolved_at).map((u) => u.id) }));

  // ─── 8. seasonRead — renormalisation, and the phase ladder's edges ─────────
  // 100 eligible alts (BTC is the bar, passed separately), exact beat counts so
  // every breadth percentage is checkable on a phone calculator.
  const seasonUniverse = (beat7, beat30) =>
    Array.from({ length: 100 }, (_, i) => ({
      id: `alt-${i}`, symbol: `A${i}`, name: `Alt ${i}`, rank: i + 1,
      price: 2, mcap: 5e8, vol24h: 2e7,
      chg24h: 2, chg7d: i < beat7 ? 10 : -10, chg30d: i < beat30 ? 20 : -20,
    }));
  const BTC0 = { ...BTC, chg7d: 0, chg30d: 0 };
  const dom = (delta) => Array.from({ length: 8 }, (_, k) => ({ t: NOW - (7 - k) * DAY, dom: 60 + (delta * k) / 7 }));
  const season = (beat7, beat30, o = {}) => seasonRead({
    universe: seasonUniverse(beat7, beat30), btcRow: BTC0,
    ethRow: { symbol: "ETH", chg7d: -2, chg30d: -2 },
    fearGreed: { value: 0 }, domHistory: dom(0), now: NOW,
    ...o,
  });
  const earnedOf = (r) => r.parts.reduce(
    (a, p) => (p.points == null ? a : { earned: a.earned + p.points, of: a.of + p.max }),
    { earned: 0, of: 0 });

  // Fully measured (of=100): score IS the part sum, so the boundaries are exact.
  const r70 = season(100, 100);                                            // 35+25+10 = 70
  const r69 = season(97, 100);                                             // 34+25+10 = 69
  const r55 = season(100, 40);                                             // 35+10+10 = 55
  const r54 = season(100, 36);                                             // 35+9+10  = 54
  const r40 = season(0, 20, { domHistory: dom(-3), ethRow: { chg7d: 2, chg30d: -2 }, fearGreed: { value: 100 } }); // 5+20+5+10 = 40
  const r39 = season(0, 20, { domHistory: dom(-3), ethRow: { chg7d: 2, chg30d: -2 }, fearGreed: { value: 90 } });  // 5+20+5+9  = 39
  const r25 = season(0, 0, { domHistory: dom(-3), ethRow: { chg7d: 2, chg30d: -2 } });                             // 20+5      = 25
  const r24 = season(20, 28, { domHistory: dom(3), fearGreed: { value: 100 } });                                   // 7+7+10    = 24
  check("70 is alt_season", r70.score === 70 && r70.phase === "alt_season", `${r70.score}/${r70.phase}`);
  check("69 is majors_rotating", r69.score === 69 && r69.phase === "majors_rotating", `${r69.score}/${r69.phase}`);
  check("55 is majors_rotating", r55.score === 55 && r55.phase === "majors_rotating", `${r55.score}/${r55.phase}`);
  check("54 is mixed", r54.score === 54 && r54.phase === "mixed", `${r54.score}/${r54.phase}`);
  check("40 is mixed", r40.score === 40 && r40.phase === "mixed", `${r40.score}/${r40.phase}`);
  check("39 is btc_only", r39.score === 39 && r39.phase === "btc_only", `${r39.score}/${r39.phase}`);
  check("25 is btc_only", r25.score === 25 && r25.phase === "btc_only", `${r25.score}/${r25.phase}`);
  check("24 is risk_off", r24.score === 24 && r24.phase === "risk_off", `${r24.score}/${r24.phase}`);
  check("fully measured parts sum to the score",
    [r70, r69, r55, r54, r40, r39, r25, r24].every((r) => {
      const { earned, of } = earnedOf(r);
      return of === 100 && earned === r.score;
    }));

  // Dominance unmeasured (day one): the part is dropped from BOTH sides and the
  // 76 earned of 80 offered renormalises to 95 — still reported out of 100.
  const thin = season(100, 100, { domHistory: [], ethRow: { chg7d: 2, chg30d: 2 }, fearGreed: { value: 60 } });
  const thinEO = earnedOf(thin);
  check("dominance unmeasured drops from both sides (76 of 80)",
    thinEO.earned === 76 && thinEO.of === 80, JSON.stringify(thinEO));
  check("...and the score renormalises to /100", thin.score === 95, `got ${thin.score}`);
  check("...still landing on the ladder", thin.phase === "alt_season", thin.phase);
  check("the unmeasured part is still listed at its full max",
    thin.parts.length === 6 && thin.parts.find((p) => p.key === "dominance")?.max === 20 &&
    thin.parts.find((p) => p.key === "dominance")?.points == null);
  check("domTrend is honestly null on day one", thin.domTrend === null, String(thin.domTrend));

  // ─── 9. odds and ends the pipeline leans on ────────────────────────────────
  check("parseMarketsRow uppercases the symbol and maps the CG fields",
    (() => {
      const r = parseMarketsRow({
        id: "altcoin", symbol: "alt", name: "Alt Coin", market_cap_rank: 40,
        current_price: 1.5, market_cap: 5e8, total_volume: 6e7,
        price_change_percentage_1h_in_currency: 1.2,
        price_change_percentage_24h_in_currency: 9,
        price_change_percentage_7d_in_currency: null,
        price_change_percentage_30d_in_currency: 10,
        sparkline_in_7d: { price: [1, 1.1, 1.2] },
        ath: 4, ath_change_percentage: -62.5, ath_date: "2025-01-01T00:00:00.000Z",
      });
      return r.symbol === "ALT" && r.price === 1.5 && r.chg24h === 9 && r.chg7d === null &&
        r.athChangePct === -62.5 && Array.isArray(r.sparkline7d);
    })());
  check("screenUniverse drops excluded rows and orders deterministically",
    (() => {
      const out = screenUniverse([cleanRaw, { ...BTC, sparkline7d: null }, { id: "tether", symbol: "USDT", name: "Tether", price: 1, mcap: 1e11, vol24h: 8e10 }], { btcRow: BTC });
      return out.every((r) => r.symbol !== "USDT") && out[0].symbol === "ALT";
    })());

  // ── priceAgo: the 4h/12h reference read off the hourly sparkline ───────────
  // These two windows have no CoinGecko field, and the sparkline is the only
  // source that can price them on a cold start. The index arithmetic is the
  // whole risk: off by a few slots and the column shows a confident wrong
  // number, which is worse than the "—" it replaced.
  //
  // A full-length tape: 169 points = the last close plus exactly 168 hours.
  // Value equals index, so the assertion reads as "how many hours back".
  const FULL = Array.from({ length: 169 }, (_, i) => i);
  check("priceAgo(4) steps back 4 hourly closes on a full tape",
    priceAgo(FULL, 4) === 164, String(priceAgo(FULL, 4)));
  check("priceAgo(12) steps back 12", priceAgo(FULL, 12) === 156, String(priceAgo(FULL, 12)));
  check("priceAgo never returns the last point (that would compare price to itself)",
    priceAgo(FULL, 0) === null);
  check("a truncated tape scales by its own length, it does not step 4 raw slots",
    // 41 points spanning the same 7 days ⇒ ~4.1h per point, so 4h back is one
    // slot, not four. Stepping four would silently report a ~17-hour move.
    priceAgo(Array.from({ length: 41 }, (_, i) => i), 4) === 39,
    String(priceAgo(Array.from({ length: 41 }, (_, i) => i), 4)));
  check("too short to read returns null, not a guess", priceAgo([1, 2, 3], 4) === null);
  check("a missing sparkline returns null", priceAgo(null, 4) === null && priceAgo(undefined, 4) === null);
  check("non-finite points are filtered before indexing",
    priceAgo([...FULL.slice(0, 100), NaN, null, ...FULL.slice(100)].filter((x) => x !== undefined), 4) != null);
  check("a zero or negative price is refused (it would divide the board by zero)",
    priceAgo(Array.from({ length: 169 }, () => 0), 4) === null);

  // ─── 10. the entry read (alt-scan) ─────────────────────────────────────────
  // This one verdict decides which of three sections a coin appears under, and
  // a section heading is read as an instruction in a way a 68/100 never was.
  // Getting it wrong is therefore worse than the ambiguity it replaced, so the
  // ordering of its tests — which failure wins when several apply — is pinned.
  const { entryRead, liveTargets } = mods["alt-scan"];
  // price 100, invalidation 90 (−10%), T1 105, T3 130 ⇒ room +30, risk −10,
  // pays 3.0×. Every case below perturbs exactly one thing off this baseline.
  const TGT = { t1: 105, t2: 115, t3: 130, invalidation: 90 };
  const live = (p) => liveTargets(TGT, p);

  const cleanEntry = entryRead({ band: "starting", flags: {} }, live(100), 100);
  check("a clean 'starting' setup is an entry", cleanEntry.state === "entry", JSON.stringify(cleanEntry));
  check("room is measured to T3, not T1", cleanEntry.roomPct === 30, String(cleanEntry.roomPct));
  check("risk is the invalidation, signed negative", cleanEntry.riskPct === -10, String(cleanEntry.riskPct));
  check("rr is room over the stop", cleanEntry.rr === 3, String(cleanEntry.rr));
  // 'underway' USED TO READ AS AN ENTRY HERE, and this assertion pinned it.
  // alt-cron's flagTier has never flagged that band — on this tab it means a
  // coin already 15%+ into its week — so the board painted green Entry pills on
  // coins the Flags card could never contain. The read now agrees with the
  // ladder; the invariant a few blocks down is what stops it drifting back.
  check("'underway' is a watch on the crypto side, because the ladder will not flag it",
    entryRead({ band: "underway", flags: {} }, live(100), 100).state === "watch",
    entryRead({ band: "underway", flags: {} }, live(100), 100).state);
  check("'warming' is a watch — nothing has taken the level yet",
    entryRead({ band: "warming", flags: {} }, live(100), 100).state === "watch");
  check("'quiet' and 'cold' are watches, not entries",
    entryRead({ band: "quiet", flags: {} }, live(100), 100).state === "watch" &&
    entryRead({ band: "cold", flags: {} }, live(100), 100).state === "watch");

  // Price walking through T1 is the case NO band knows about: the screener
  // still reads 'starting' for hours after the entry stopped existing.
  const through = entryRead({ band: "starting", flags: {} }, live(106), 106);
  check("past T1 is late even while the band still says 'starting'",
    through.state === "late", JSON.stringify(through));
  check("...and it still reports the room it has left", through.roomPct != null && through.roomPct > 0);
  check("price above T3 reports non-positive room (the UI prints 'done')",
    entryRead({ band: "underway", flags: {} }, live(140), 140).roomPct <= 0);

  // Exclusions outrank everything, in the order a trade actually fails.
  check("parabolic beats a 'starting' band",
    entryRead({ band: "starting", flags: { parabolic: true } }, live(100), 100).state === "late");
  check("thin liquidity beats parabolic (you cannot exit either way)",
    entryRead({ band: "starting", flags: { thinLiquidity: true, parabolic: true } }, live(100), 100).why.includes("thin"));
  check("band 'late' is late even with clean levels",
    entryRead({ band: "late", flags: {} }, live(100), 100).state === "late");

  // Payoff and structure gates.
  check("a payoff under 1.5x the stop is a watch, not an entry",
    // invalidation 90 (−10%), T3 112 (+12%) ⇒ 1.2x
    entryRead({ band: "starting", flags: {} }, liveTargets({ ...TGT, t3: 112 }, 100), 100).state === "watch");
  check("exactly 1.5x still clears",
    entryRead({ band: "starting", flags: {} }, liveTargets({ ...TGT, t3: 115 }, 100), 100).state === "entry");
  check("an invalidation already above price is a lost structure, not an entry",
    entryRead({ band: "starting", flags: {} }, liveTargets({ ...TGT, invalidation: 101 }, 100), 100).state === "watch");
  check("no targets at all is a watch with every number null",
    (() => {
      const r = entryRead({ band: "starting", flags: {} }, null, 100);
      return r.state === "watch" && r.roomPct === null && r.riskPct === null && r.rr === null;
    })());
  check("a coin off the board (no band) is never promoted to an entry",
    entryRead(null, live(100), 100).state === "watch");

  // liveTargets: PRICES frozen, PERCENTAGES live. The whole point of the split.
  const moved = liveTargets(TGT, 120);
  check("liveTargets never moves a target price",
    moved.t1 === 105 && moved.t3 === 130 && moved.invalidation === 90);
  check("liveTargets recomputes every % against the live price",
    moved.t1Pct === -12.5 && moved.invPct === -25, JSON.stringify(moved));
  check("liveTargets passes a null price through untouched",
    liveTargets(TGT, null) === TGT && liveTargets(null, 100) === null);

  // ─── 11. the move read (alt-scan) ──────────────────────────────────────────
  // entryRead says whether to act; this says WHERE THE MOVE IS, and it is the
  // only thing on the row that claims to describe the chart. Two classes of
  // bug are pinned here. The first is the confident wrong number: a division
  // by a null that yields Infinity, a give-back formula that overstates on the
  // biggest winners, a pace word invented for a coin whose 12h window has no
  // baseline. The second is CONTRADICTION — the stage and the section sit two
  // inches apart, so "Move spent" must be arithmetically incapable of
  // appearing under "Worth an entry now".
  const { moveRead } = mods["alt-scan"];
  const RANGE = { low: 88, high: 104, pos: 0.75, freshBreak: false, priorHigh: 102, priorLow: 90, points: 168 };
  const ctxOf = (over = {}) => ({ flags: {}, range7d: RANGE, chg12h: 2, chg24h: 3, accel: { d24VsWeek: 1 }, ...over });
  const mv = (ctx, t, p, ep) => moveRead(ctx, t, p, ep || null);

  // Baseline: price 100, level (priorHigh) 102, so 2% under it.
  const base = mv(ctxOf({ range7d: { ...RANGE, priorHigh: 108 } }), live(100), 100);
  check("well under the level, inside its range, is 'base'", base.stage === "base", JSON.stringify(base));
  check("distance to the level is measured off priorHigh (108), not range7d.high (104)",
    base.toLevelPct === -7.4, String(base.toLevelPct));
  check("within 3% of the level is 'atLevel'",
    mv(ctxOf({ range7d: { ...RANGE, priorHigh: 101 } }), live(100), 100).stage === "atLevel");
  check("just past 3% under is still 'base', not 'atLevel'",
    mv(ctxOf({ range7d: { ...RANGE, priorHigh: 104 } }), live(100), 100).stage === "base");
  check("over the level is 'breaking'",
    mv(ctxOf({ range7d: { ...RANGE, priorHigh: 98 } }), live(100), 100).stage === "breaking");
  check("a fresh break on a full series is 'breaking' even from under the level",
    mv(ctxOf({ flags: { freshBreak: true } }), live(100), 100).stage === "breaking");
  const shortBreak = mv(ctxOf({ flags: { freshBreak: true }, range7d: { ...RANGE, priorHigh: 108, points: 30 } }), live(100), 100);
  check("a fresh break on a SHORT series is not — 'one day' there is four hours",
    shortBreak.stage === "base", JSON.stringify(shortBreak));

  // The terminal reads, in the order they must win.
  check("price at or through the invalidation is 'broken'",
    mv(ctxOf(), live(89), 89).stage === "broken");
  check("past T3 is 'spent'", mv(ctxOf(), live(140), 140).stage === "spent");
  check("parabolic is 'spent' even with room left",
    mv(ctxOf({ flags: { parabolic: true } }), live(100), 100).stage === "spent");
  check("past T1 but not T3 is 'extending'", mv(ctxOf(), live(110), 110).stage === "extending");
  check("'broken' outranks 'spent' — a lost stop is not a completed move",
    mv(ctxOf({ flags: { parabolic: true } }), liveTargets({ ...TGT, invalidation: 200 }, 100), 100).stage === "broken");

  // THE NON-CONTRADICTION INVARIANTS. These are the whole reason the stage can
  // sit next to the verdict without a reader having to reconcile them.
  const pairs = [89, 100, 106, 110, 140].flatMap((p) =>
    [{}, { flags: { parabolic: true } }, { flags: { thinLiquidity: true } }].map((o) => {
      const t = live(p);
      return { p, o, m: mv(ctxOf(o), t, p), e: entryRead(ctxOf(o), t, p) };
    }));
  check("'broken' never lands on an entry — invPct IS entry.riskPct",
    pairs.filter((x) => x.m.stage === "broken").every((x) => x.e.state !== "entry"));
  check("...and on a clean row it is exactly entryRead's 'structure already lost'",
    pairs.filter((x) => x.m.stage === "broken" && !x.o.flags).every((x) => x.e.state === "watch"));
  check("'spent' always lands on a late — t3Pct <= 0 is entry.roomPct <= 0",
    pairs.filter((x) => x.m.stage === "spent").every((x) => x.e.state === "late"));
  check("'extending' always lands on a late — t1Pct <= 0 is entry.nextPct <= 0",
    pairs.filter((x) => x.m.stage === "extending").every((x) => x.e.state === "late"));
  check("no terminal stage can ever appear under 'Worth an entry now'",
    !pairs.some((x) => ["broken", "spent", "extending"].includes(x.m.stage) && x.e.state === "entry"));

  // thin is a FLAG, not a stage: a coin can be genuinely breaking out and
  // still impossible to get out of, and the row has to say both.
  const thinBreak = mv(ctxOf({ flags: { thinLiquidity: true }, range7d: { ...RANGE, priorHigh: 98 } }), live(100), 100);
  check("thin liquidity rides alongside the stage rather than replacing it",
    thinBreak.thin === true && thinBreak.stage === "breaking", JSON.stringify(thinBreak));

  // The honest non-answers.
  check("no targets is 'none', not a guessed stage", mv(ctxOf(), null, 100).stage === "none");
  check("a coin off the 60-row board gets 'offboard', never a forward stage",
    mv(null, live(100), 100).stage === "offboard");
  check("a dead-flat series with no level is 'offboard', not 'base'",
    mv(ctxOf({ range7d: { low: 100, high: 100, pos: null, priorHigh: null, priorLow: null, points: 168 } }), live(100), 100).stage === "offboard");
  check("a null priorHigh yields a null distance, NEVER Infinity",
    mv(ctxOf({ range7d: { ...RANGE, priorHigh: null } }), live(100), 100).toLevelPct === null);
  check("a zero priorHigh is refused rather than dividing by it",
    mv(ctxOf({ range7d: { ...RANGE, priorHigh: 0 } }), live(100), 100).toLevelPct === null);

  // Pace: disjoint 12h legs, exact because the live price divides out.
  // +2% this half-day after +0.98% the half-day before ⇒ turn ≈ +1.0pp.
  check("the pace compares this 12h leg against the previous one",
    mv(ctxOf({ chg12h: 6, chg24h: 3 }), live(100), 100).motion === "up",
    JSON.stringify(mv(ctxOf({ chg12h: 6, chg24h: 3 }), live(100), 100)));
  check("a decelerating tape reads 'down'",
    mv(ctxOf({ chg12h: 1, chg24h: 8 }), live(100), 100).motion === "down");
  check("an unchanged pace reads 'flat' — measured, and flat",
    mv(ctxOf({ chg12h: 2, chg24h: 4.04 }), live(100), 100).motion === "flat",
    JSON.stringify(mv(ctxOf({ chg12h: 2, chg24h: 4.04 }), live(100), 100).motion));
  check("no 12h baseline falls back to the cron's day-vs-week excess",
    mv(ctxOf({ chg12h: null, accel: { d24VsWeek: 5 } }), live(100), 100).motion === "up");
  check("no baseline AND no fallback means NO pace word — absent never means flat",
    mv(ctxOf({ chg12h: null, accel: null }), live(100), 100).motion === null,
    String(mv(ctxOf({ chg12h: null, accel: null }), live(100), 100).motion));
  check("a -99.5% row does not explode into violent acceleration",
    mv(ctxOf({ chg12h: -99.5, chg24h: 3, accel: null }), live(100), 100).motion === null);

  // The give-back. peakPct − sinceFlagPct is the wrong formula and it is wrong
  // WORST on the winners: at peak +100 / since +50 it prints −50% for a coin
  // that is 25% off its high.
  const epi = (since, peak) => ({ sinceFlagPct: since, peakPct: peak });
  check("off-high is percent off the PEAK, not the difference of two percentages",
    mv(ctxOf(), live(100), 100, epi(50, 100)).offPeakPct === -25,
    String(mv(ctxOf(), live(100), 100, epi(50, 100)).offPeakPct));
  check("a small give-back is suppressed as noise",
    mv(ctxOf(), live(100), 100, epi(48, 50)).offPeakPct === null);
  check("no episode means no give-back number", mv(ctxOf(), live(100), 100).offPeakPct === null);
  check("a flag sitting at its own high reports no give-back",
    mv(ctxOf(), live(100), 100, epi(30, 30)).offPeakPct === null);

  // ─── the read and the ladder must agree about what is buyable ─────────────
  // The equity side once had this backwards: flagTier refused a band entryRead
  // simultaneously called an entry, and the board painted green Entry pills on
  // names the Flags card could never contain. Crypto had the SAME
  // contradiction in the same direction and it survived that fix — 'underway'
  // here is chg7d >= 15, a coin already well into its week, which alt-cron has
  // always refused to flag.
  {
    const { entryRead: er } = mods["alt-scan"];
    const good = { t1: 110, t2: 120, t3: 140, invalidation: 95, t1Pct: 10, t3Pct: 40, invPct: -5 };
    const verdictFor = (band) => er({ band, flags: {} }, good, 100).state;
    check("'underway' is not called an entry on a tab whose ladder will not flag it",
      verdictFor("underway") !== "entry", verdictFor("underway"));
    check("...and says why, rather than going quiet",
      /already well into the move/.test(er({ band: "underway", flags: {} }, good, 100).why));
    check("'starting' is still an entry — the ladder does flag it", verdictFor("starting") === "entry");
    check("'warming' is still a watch", verdictFor("warming") === "watch");

    // The invariant, stated once: every band this read calls an ENTRY is a band
    // the ladder is willing to flag.
    const { flagTier: ft } = cron;
    const flagRow = (band) => ({
      symbol: "AAA", score: 90, band, flags: {}, rsVsBtc7d: 5, vol24h: 5e7,
      mcap: 5e8, targets: { t1Pct: 10 },
    });
    const flaggable = ["starting", "warming", "underway", "quiet", "cold", "late"]
      .filter((band) => ft(flagRow(band), { floor: 50 }));
    const entryBands = ["starting", "warming", "underway", "quiet", "cold", "late"]
      .filter((band) => verdictFor(band) === "entry");
    check("every band the read calls an ENTRY is a band the ladder will flag",
      entryBands.every((b) => flaggable.includes(b)),
      `entry: ${entryBands.join(",")} | flaggable: ${flaggable.join(",")}`);
  }

  // ─── the dominance sentence states the span it MEASURED ────────────────────
  // DOM_WINDOW_DAYS is how far back we are WILLING to look, not how far back
  // the samples go. Seven of them can sit inside six days — after a deploy, or
  // the far side of a gap in the history — and the sentence announced them as
  // "over the last 30 days" regardless. A -0.61 point move is a signal over a
  // month and noise over a week, the reader has no other way to tell which one
  // they are looking at, and dominance carries 20 of the season's 100 points.
  {
    const { domTrendOf } = cron;
    const D = 86400000;
    const at = (daysAgo, dom) => ({ t: Date.now() - daysAgo * D, dom });
    const say = (rows) => { const f = []; domTrendOf(rows, f); return f.join(" "); };

    const sixDays = [at(6, 58.0), at(5, 57.9), at(4, 57.8), at(3, 57.7), at(2, 57.6), at(1, 57.5), at(0, 57.4)];
    check("seven samples inside six days say SIX days, not thirty",
      /over the last 6 days/.test(say(sixDays)), say(sixDays));
    check("...and the change itself is still measured end to end",
      Math.abs(domTrendOf(sixDays).changePts + 0.6) < 1e-9, String(domTrendOf(sixDays).changePts));
    check("...and the real span rides on the return for anything downstream",
      domTrendOf(sixDays).spanDays === 6, String(domTrendOf(sixDays).spanDays));

    const fullMonth = Array.from({ length: 10 }, (_, i) => at(28 - i * 3, 58 - i * 0.1));
    check("a genuine month still says the month it covers",
      /over the last 2[0-9] days/.test(say(fullMonth)), say(fullMonth));

    const sameDay = Array.from({ length: 7 }, (_, i) => ({ t: Date.now() - i * 3600000, dom: 58 - i * 0.05 }));
    check("samples inside one day do not claim a day",
      /under a day/.test(say(sameDay)), say(sameDay));

    check("too few samples still refuses to call a trend at all",
      domTrendOf([at(3, 58), at(2, 57.9), at(1, 57.8)]).trend === null);
    check("an empty history is not a trend",
      domTrendOf([]).trend === null && domTrendOf(null).samples === 0);
  }

  /* ─── 9. the capital ladder ────────────────────────────────────────────────
     The surface that claims to see AHEAD, so its two failure modes both get
     fixtures: a mean instead of a median (one 400% micro-cap lighting a rung
     nothing is bidding) and a wrapper counted a rung below the coin it wraps
     (Bitcoin's own return faking a rotation into large caps). ───────────── */
  {
    const { capitalLadder } = cron;
    const coin = (symbol, mcap, chg30d, chg7d = 0, extra = {}) =>
      ({ id: symbol.toLowerCase(), symbol, name: symbol, mcap, chg30d, chg7d, vol24h: 5e6, ...extra });
    // Four rows per bucket — LADDER_MIN_ROWS — so every rung is measurable.
    const bucket = (prefix, mcap, values) =>
      values.map((v, i) => coin(`${prefix}${i}`, mcap, v));

    const rotating = [
      coin("BTC", 1.3e12, 18), coin("ETH", 2.3e11, 31),
      ...bucket("L", 2e10, [44, 46, 42, 44]),
      ...bucket("M", 3e9, [38, 36, 40, 38]),
      ...bucket("S", 3e8, [12, 10, 14, 12]),
      ...bucket("U", 5e7, [-2, -3, -1, -2]),
    ];
    const lad = capitalLadder(rotating);
    check("the ladder lights the strongest measured rung",
      lad.leadKey === "major", String(lad.leadKey));
    check("...and names the rung flow reaches next, in curve order",
      lad.nextLabel === "Mid", String(lad.nextLabel));
    check("...and says so in a sentence rather than leaving it to be inferred",
      /large.*Mid is next/i.test(lad.read || ""), lad.read);
    check("every rung is published, measured or not",
      lad.rungs.length === 6 && lad.rungs[0].key === "btc" && lad.rungs[5].key === "micro");

    // THE MEDIAN TEST. Three rows going nowhere and one up 900%: the mean is
    // +225% and would light micro over every other rung on the card.
    const spike = [
      coin("BTC", 1.3e12, 18), coin("ETH", 2.3e11, 12),
      ...bucket("L", 2e10, [8, 7, 9, 8]),
      ...bucket("M", 3e9, [3, 2, 4, 3]),
      ...bucket("S", 3e8, [1, 0, 2, 1]),
      ...bucket("U", 5e7, [0, -1, 1, 900]),
    ];
    const sp = capitalLadder(spike);
    check("one 900% micro-cap does not light the micro rung",
      sp.leadKey === "btc", `${sp.leadKey} @ ${JSON.stringify(sp.rungs.find((r) => r.key === "micro"))}`);
    check("...because the rung is a median, not a mean",
      sp.rungs.find((r) => r.key === "micro").chg30d === 0.5,
      String(sp.rungs.find((r) => r.key === "micro").chg30d));

    // A bucket under the floor is UNMEASURED, not zero — the distinction this
    // codebase refuses to collapse anywhere else.
    const thin = [coin("BTC", 1.3e12, 5), coin("ETH", 2.3e11, 4), ...bucket("L", 2e10, [3, 2])];
    check("a bucket thinner than the floor reports null, never a confident zero",
      capitalLadder(thin).rungs.find((r) => r.key === "major").chg30d === null);

    // Wrappers in a bucket are the same coin's return counted twice, one rung
    // too low — and it fakes rotation in exactly the direction that matters.
    const wrapped = [
      coin("BTC", 1.3e12, 40), coin("ETH", 2.3e11, 5),
      coin("WBTC", 2e10, 40), coin("CBBTC", 2e10, 40), coin("LBTC", 2e10, 40), coin("TBTC", 2e10, 40),
    ];
    check("wrapped BTC never lights the large-cap rung with Bitcoin's own return",
      capitalLadder(wrapped).rungs.find((r) => r.key === "major").chg30d === null,
      String(capitalLadder(wrapped).rungs.find((r) => r.key === "major").chg30d));

    // Everything negative is NOT a rotation into whatever fell least.
    const bleeding = [
      coin("BTC", 1.3e12, -4), coin("ETH", 2.3e11, -9),
      ...bucket("L", 2e10, [-12, -11, -13, -12]),
      ...bucket("M", 3e9, [-20, -19, -21, -20]),
      ...bucket("S", 3e8, [-30, -29, -31, -30]),
      ...bucket("U", 5e7, [-40, -39, -41, -40]),
    ];
    const bl = capitalLadder(bleeding);
    check("a ladder that is negative all the way down never says flow 'reached' anything",
      !/reached/i.test(bl.read) && /sold, not rotated/i.test(bl.read), bl.read);
  }

  /* ─── 10. the regime's own drift ───────────────────────────────────────── */
  {
    const { mergeScoreSample, scoreDriftOf } = cron;
    const day = 86400000;
    const now = Date.parse("2026-08-15T12:00:00Z");

    let hist = [];
    for (let i = 29; i >= 0; i--) hist = mergeScoreSample(hist, now - i * day, 25 + (29 - i) * 0.5);
    check("one sample per UTC day, however many passes ran", hist.length === 30, String(hist.length));

    // The load-bearing property: a later pass on the SAME day replaces the
    // day's sample rather than appending a second one, so a 24-pass day cannot
    // out-vote a quiet one in the window count.
    const twice = mergeScoreSample(hist, now + 3600000, 99);
    check("a second pass the same day replaces the day, never appends",
      twice.length === 30 && twice[twice.length - 1].v === 99, String(twice.length));

    const drift = scoreDriftOf(hist);
    check("a rising regime is called rising", drift.direction === "rising", String(drift.direction));
    check("...with the change measured end to end", near(drift.changePts, 14.5), String(drift.changePts));
    check("...and the span measured, not assumed", drift.spanDays === 29, String(drift.spanDays));

    const flat = scoreDriftOf(Array.from({ length: 10 }, (_, i) => ({ t: now - (9 - i) * day, v: 40 + (i % 2) })));
    check("a wobble inside the noise band is 'flat', not a trend", flat.direction === "flat", String(flat.direction));

    check("too few samples refuses to call a direction",
      scoreDriftOf([{ t: now, v: 40 }, { t: now - day, v: 38 }]).direction === null);
    check("an empty series is not a drift", scoreDriftOf([]).direction === null && scoreDriftOf(null).samples === 0);

    // A null score must never enter the series as a zero — 0/100 is the most
    // alarming reading on the scale, and it is the shape Number(null) produces.
    check("an unpublished score is not merged as a zero",
      mergeScoreSample([], now, null).length === 0 && mergeScoreSample([], now, undefined).length === 0);
  }

  /* ─── 11. cohorts, and the excess that reads them ──────────────────────── */
  {
    const { cohortStats, cohortRead, parseCategoryIndex } = cron;
    const { cohortExcess } = mods["alt-scan"];
    const raw = (id, chg7d, chg30d, vol = 5e6) =>
      ({ id, symbol: id, name: id, current_price: 1, market_cap: 1e9, total_volume: vol,
        price_change_percentage_7d_in_currency: chg7d, price_change_percentage_30d_in_currency: chg30d });

    const c = cohortStats("x", "X", "X names", [raw("a", 10, 20), raw("b", -2, 5), raw("c", 6, 12), raw("d", 4, 9)], 1e10);
    check("a cohort's return is the median of its members", c.chg7d === 5, String(c.chg7d));
    check("...and breadth counts how many are actually lifting",
      c.lifting === 3 && c.n === 4, `${c.lifting}/${c.n}`);

    // Dust is the thing that makes a cohort lie: rows that have not traded drag
    // both the median and the breadth denominator toward nothing.
    const dusty = cohortStats("x", "X", "X", [
      raw("a", 10, 20), raw("b", 12, 22), raw("c", 11, 21), raw("d", 9, 19),
      raw("z1", 0, 0, 100), raw("z2", 0, 0, 100), raw("z3", 0, 0, 100),
    ], 1e10);
    check("untraded dust is excluded from both the median and the denominator",
      dusty.n === 4 && dusty.chg7d === 10.5, `${dusty.n} @ ${dusty.chg7d}`);

    check("a cohort under the floor is not published at all",
      cohortStats("x", "X", "X", [raw("a", 10, 20), raw("b", 8, 18)], 1e10) === null);

    // Membership ties break on the AUTHORED order, and determinism is the whole
    // requirement: a coin that changed cohort between passes would change its
    // excess without its price moving.
    const index = parseCategoryIndex([
      { id: "ai-agents", name: "AI Agents", market_cap: 5e9 },
      { id: "meme-token", name: "Meme", market_cap: 9e9 },
    ]);
    const pages = new Map([
      ["ai-agents", [raw("shared", 30, 40), raw("a1", 20, 30), raw("a2", 22, 32), raw("a3", 21, 31)]],
      ["meme-token", [raw("shared", 30, 40), raw("m1", 1, 2), raw("m2", 2, 3), raw("m3", 0, 1)]],
    ]);
    const read = cohortRead(index, pages);
    check("a coin in two cohorts lands in the one listed first", read.coinCohort.shared === "ai-agents", read.coinCohort.shared);
    check("cohorts rank by the 30-day read", read.leadId === "ai-agents", String(read.leadId));
    check("the lead is stated with its breadth, not just its number",
      /AI agents leads — \d+ of \d+/.test(read.read), read.read);
    check("membership scaffolding never reaches the payload",
      read.cohorts.every((x) => x.memberIds === undefined));

    // ── the excess: five states, and the two that matter are the two a board
    // sorted by return can never show.
    const bid = { id: "x", label: "X", chg7d: 20, lifting: 9, n: 11 };
    const flatGrp = { id: "y", label: "Y", chg7d: 0.5, lifting: 2, n: 20 };
    check("ahead of a bidding group is rotation",
      cohortExcess(bid, 30).state === "leading", cohortExcess(bid, 30).state);
    check("behind a bidding group is the laggard entry, not a dud",
      cohortExcess(bid, 3).state === "lagging" && /better entry/.test(cohortExcess(bid, 3).read));
    check("inside the noise band is 'moving with its group'",
      cohortExcess(bid, 21).state === "with", cohortExcess(bid, 21).state);
    check("far ahead of a group going nowhere is idiosyncratic",
      cohortExcess(flatGrp, 45).state === "alone" && /listing or unlock/.test(cohortExcess(flatGrp, 45).read));
    check("...but a few points ahead of a flat group is just a coin",
      cohortExcess(flatGrp, 6).state === "quiet", cohortExcess(flatGrp, 6).state);
    // The bug the fixture above caught: `bid = base > 0` made a +0.5% sector
    // count as bought, so a coin up 45% against it read as rotation.
    check("a barely-positive cohort is flat, not bid",
      cohortExcess({ id: "y", label: "Y", chg7d: 0.5 }, 45).state === "alone");
    check("...and a genuinely falling group says so rather than saying 'flat'",
      /Falling with/.test(cohortExcess({ id: "y", label: "Y", chg7d: -14 }, -12).read));
    check("the excess is POINTS, and it is the plain difference",
      cohortExcess(bid, 30).excessPp === 10, String(cohortExcess(bid, 30).excessPp));
    check("no cohort is no verdict, not a neutral one",
      cohortExcess(null, 30) === null && cohortExcess({ id: "z", label: "Z", chg7d: null }, 30).state === "unknown");
  }

  /* ─── 12. the exit ladder ──────────────────────────────────────────────────
     Pure and importable, so it is asserted directly rather than through a
     bundle. The ladder decides the outcome the whole tab exists to serve, and
     every rule in it is invisible on screen when it is wrong. ───────────── */
  {
    const { ALT_LADDER, ALT_TRAIL_PCT, ladderState, averageIn, regimeOverride } =
      await import("../src/lib/altLadder.js");

    const sold = ALT_LADDER.reduce((s, r) => s + r.sell, 0) + ALT_TRAIL_PCT;
    check("the ladder sells exactly 100% of a position", sold === 100, String(sold));
    check("the rungs ascend", ALT_LADDER.every((r, i) => i === 0 || r.mult > ALT_LADDER[i - 1].mult));

    const pos = (basis, hit) => ({ cost_basis: basis, rungs_hit: hit });
    const at3 = ladderState(pos(10, 0), 31);
    check("the multiple is price over basis", at3.mult === 3.1, String(at3.mult));
    check("...and the next rung is the first UNSOLD one", at3.next.mult === 3, String(at3.next && at3.next.mult));

    // THE STATE THE SHAPE EXISTS TO REPRESENT: price is through a rung that has
    // not been sold. Deriving rungs_hit from price would make this unrepresentable
    // — the row would congratulate you on a ladder you never executed.
    check("price through an unsold rung is 'due'", at3.due === true);
    check("...and selling it advances the ladder rather than the price doing so",
      ladderState(pos(10, 1), 31).due === false && ladderState(pos(10, 1), 31).next.mult === 5);

    check("a target price is the basis times the rung", ladderState(pos(10, 1), 31).targetPrice === 50);
    check("...and 'away' is measured from the live price",
      near(ladderState(pos(10, 1), 40).awayPct, 25), String(ladderState(pos(10, 1), 40).awayPct));

    const done = ladderState(pos(10, 4), 200);
    check("every rung sold leaves the trailing slice, which has no target",
      done.trailing === true && done.next === null && done.targetPrice === null);

    check("a zero basis is a missing position, not a free one",
      ladderState(pos(0, 0), 50).mult === null && ladderState(pos(null, 0), 50).next === null);

    // WEIGHTED BY UNITS. $400 at $10 and $100 at $20 is a basis of $11.11; the
    // arithmetic mean says $15 and moves every rung ~35% out of place.
    const avg = averageIn({ cost_basis: 10, units: 40 }, 20, 5);
    check("a tranche averages in by units, not by price", near(avg.cost_basis, 500 / 45), String(avg.cost_basis));
    check("...and the units accumulate", avg.units === 45);
    check("a first buy needs no prior basis", averageIn({ cost_basis: null, units: null }, 7, 3).cost_basis === 7);
    check("a tranche with no unit count is refused, never guessed",
      averageIn({ cost_basis: 10, units: 40 }, 20, null) === null &&
      averageIn({ cost_basis: 10, units: 40 }, 20, 0) === null);

    // THE LEG THE FEED COULD NEVER SUPPLY. OVERRIDE_DOM_DAYS was 60 against a
    // domSpanDays read off the cron's 30-day window, so the fixture below
    // armed on a span the engine never publishes and the footer promised a
    // switch welded open. The span now comes off the full kept history, and
    // this pins that it reaches — through seasonRead, the way the book gets it.
    const { OVERRIDE_DOM_DAYS } = await import("../src/lib/altLadder.js");
    check("the override's dominance days sit inside the history the cron keeps",
      OVERRIDE_DOM_DAYS < DOM_KEEP_DAYS && DOM_WINDOW_DAYS < DOM_KEEP_DAYS, `${OVERRIDE_DOM_DAYS} / ${DOM_WINDOW_DAYS} / ${DOM_KEEP_DAYS}`);
    const daily = (days, domAt) => Array.from({ length: days + 1 }, (_, k) => ({ t: NOW - (days - k) * DAY, dom: domAt(days - k) }));
    const longFall = seasonRead({
      universe: seasonUniverse(100, 100), btcRow: BTC0, ethRow: { symbol: "ETH", chg7d: 2, chg30d: 2 },
      fearGreed: { value: 84 }, domHistory: daily(70, (ago) => 50 + ago * 0.1), now: NOW,
    });
    check("seventy days of falling dominance publish a span past the override's 60",
      longFall.domTrend === "falling" && longFall.domSpanDays === 70, `${longFall.domTrend} ${longFall.domSpanDays}`);
    check("...and the override arms on what seasonRead actually publishes",
      regimeOverride({ score: longFall.score, fearGreed: longFall.fearGreed, domTrend: longFall.domTrend, domSpanDays: longFall.domSpanDays }).armed === true,
      JSON.stringify({ score: longFall.score, fg: longFall.fearGreed, span: longFall.domSpanDays }));
    // A month-old fall inside a quarter that rose: the direction is the month's
    // and the span is the month's — the history does not vouch for more.
    const youngFall = seasonRead({
      universe: seasonUniverse(100, 100), btcRow: BTC0, ethRow: { symbol: "ETH", chg7d: 2, chg30d: 2 },
      fearGreed: { value: 84 }, domHistory: daily(70, (ago) => (ago > 29 ? 40 + (70 - ago) * 0.5 : 60 - (29 - ago) * 0.1)), now: NOW,
    });
    check("a fall younger than the history spans only the month it holds for",
      youngFall.domTrend === "falling" && youngFall.domSpanDays != null && youngFall.domSpanDays < DOM_WINDOW_DAYS,
      `${youngFall.domTrend} ${youngFall.domSpanDays}`);
    check("...and does not arm the override",
      regimeOverride({ score: youngFall.score, fearGreed: youngFall.fearGreed, domTrend: youngFall.domTrend, domSpanDays: youngFall.domSpanDays }).armed === false);

    // ALL THREE LEGS, NOT ANY. Each fires alone several times a cycle.
    const armed = regimeOverride({ score: 72, fearGreed: 84, domTrend: "falling", domSpanDays: 70 });
    check("the override fires only with all three legs", armed.armed === true && armed.met === 3);
    check("two of three is not the top",
      regimeOverride({ score: 72, fearGreed: 84, domTrend: "falling", domSpanDays: 20 }).armed === false);
    check("...and it still reports how close it is, so it isn't a switch nobody has seen move",
      regimeOverride({ score: 72, fearGreed: 84, domTrend: "rising", domSpanDays: 90 }).met === 2);
    check("missing inputs never arm it",
      regimeOverride({}).armed === false && regimeOverride({ score: null, fearGreed: null }).met === 0);
  }
} catch (e) {
  failed++;
  console.error(`FAIL: smoke crashed — ${(e && e.stack) || e}`);
} finally {
  rmSync(OUT_DIR, { recursive: true, force: true });
}

console.log(failed ? `\nALT SEASON SMOKE FAILED (${failed})` : "\nALT SEASON SMOKE PASS");
process.exit(failed ? 1 : 0);
