// ─── stock-cron-background — the Stocks tab's brain, clocked in SESSIONS ─────
//
// This is the Alt Season engine ported to equities, and the port's whole thesis
// is in one sentence: THE ATOM IS THE SESSION, NOT THE HOUR. The crypto engine
// measures a market that never closes with clocks that never stop, and every
// place that assumption leaks is a place this would ship a confident wrong
// number rather than an error:
//
//   · 1h/4h/12h windows. At 3am on a Sunday, four of crypto's six mover windows
//     would be Friday's close against Friday's close — four identical lists of
//     zeroes under labels claiming to measure the last few hours. Deleted, not
//     approximated. And priceAgo does not fail safe on equity data, it LIES: on
//     a ~35-bar hourly series perHour = 34/168 = 0.202, so "4 hours ago"
//     resolves to about ONE bar back, clears the idx < len-1 guard that exists
//     precisely to stop a price being compared against itself, and ships as a
//     measured 4h return.
//   · structure7d. range=7d&interval=1d returns FIVE bars, fails its own
//     `s.length < 8` guard, and returns all nulls — so pos scores 0, priorHigh
//     is null, targetsFor returns null, flagTier rejects on !t, and the engine
//     flags nothing, silently, forever, with no error anywhere.
//   · turnover = volume / market cap. There is NO market cap on this endpoint —
//     it is a price-history API — and liquid equities turn 0.5-2% of float
//     against a top rung of 50%, so 15 of 100 points would stop ranking.
//   · isStablecoin's flatness heuristic. Flat across day, week AND month with a
//     $1B+ cap deletes every quiet mega-cap, utility and REIT in a flat month.
//
// THREE PASS TYPES, ONE HOURLY SCHEDULE. The function reads the ET clock and
// SPY's own printed-session dates and decides which pass it is:
//   SETTLE  first fire at/after 16:45 ET on a day SPY printed, if that session
//           has no board yet. Every symbol, all judgment, once a day.
//   TICK    inside the session. Open flags + SPY only (<=11 requests). Ratchets
//           peaks off the running day high, tests invalidation. Recomputes NO
//           score, band, target or regime — judgment moves at the close.
//   IDLE    everything else. A weekend or holiday spends ZERO requests.
//
// WHY JUDGMENT MOVES ONCE A DAY: crypto redraws priorHigh every hour, so its
// levels creep under the trade. Here a flag's levels are stable for a whole
// session, which is what makes the episode gradeable at all.
//
// Self-contained by house rule — see the scripts/functions-smoke.mjs header for
// the outage that rule paid for.

const { createClient } = require("@supabase/supabase-js");

const CHART = (sym, range) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;

// A SEPARATE User-Agent from markets.js and ticker-candles.js, deliberately.
// Yahoo throttles on IP/ASN/UA heuristics, and if the screener gets the shared
// identity throttled the casualties are features that work today: the Brief's
// Markets card degrades to em-dashes and every ticker chart 502s.
const UA = "Mozilla/5.0 (compatible; BoardRoomScreener/1.0)";
const FETCH_TIMEOUT_MS = 6000;
const CONCURRENCY = 3;            // markets.js proves 4; never exceed the evidence
const MIN_GAP_MS = 2000;          // token bucket: sustained 0.5 req/s
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const SESSION_KEEP = 260;         // ~one year, counted in SESSIONS not calendar days
const BOARD_SIZE = 96;
const SPARK_POINTS = 28;
const MIN_BARS = 60;              // under three months of trading is not screenable
const SETTLE_AFTER_ET_MIN = 16 * 60 + 45;   // 16:45 ET
const OPEN_ET_MIN = 9 * 60 + 30;
const CLOSE_ET_MIN = 16 * 60;

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/* ═══ the universe ═══════════════════════════════════════════════════════════
 *
 * AUTHORED, because there is no /coins/markets for equities — so the list is
 * the product decision and it lives here where it can be read.
 *
 * Authorship also DELETES the entire crypto exclusion apparatus (isStablecoin,
 * isWrapper, the ~200 lines of symbol sets and three regexes, tierOf). ETFs,
 * ETNs, leveraged and inverse products, ADRs, preferreds, SPACs and dual-class
 * double-counts are excluded by NOT BEING TYPED, which is strictly better than
 * detecting them after the fact.
 *
 *   id       a slug WE mint. FB→META is a one-line `symbol` edit and every open
 *            episode keeps pointing at the same row. That is the ONLY claim
 *            made for it — an authored id does NOT stop a reissued ticker
 *            re-pointing an episode (nothing on the wire is compared against
 *            it); the oldest-bar identity guard in settle() is what catches it.
 *   sector   authored. Not on the chart endpoint at any price.
 *   company  a dedupe tag. Two entries sharing one is a dual-class double-count
 *            in breadth, so GOOG and GOOGL cannot both be listed by accident.
 *
 * SHIPPING SMALL ON PURPOSE. A rate-limit ban on an undocumented endpoint is
 * not recoverable by a code fix, so this lands at ~50 names and widens on
 * evidence rather than opening at 250.
 */
const EQUITIES = [
  ["apple", "AAPL", "tech", "Apple"], ["microsoft", "MSFT", "tech", "Microsoft"],
  ["alphabet", "GOOGL", "tech", "Alphabet"], ["amazon", "AMZN", "tech", "Amazon"],
  ["meta", "META", "tech", "Meta"], ["salesforce", "CRM", "tech", "Salesforce"],

  ["nvidia", "NVDA", "semis", "Nvidia"], ["amd", "AMD", "semis", "AMD"],
  ["broadcom", "AVGO", "semis", "Broadcom"], ["micron", "MU", "semis", "Micron"],
  ["qualcomm", "QCOM", "semis", "Qualcomm"], ["arm", "ARM", "semis", "Arm"],

  ["jpmorgan", "JPM", "financials", "JPMorgan"], ["goldman", "GS", "financials", "Goldman Sachs"],
  ["bofa", "BAC", "financials", "Bank of America"], ["morganstanley", "MS", "financials", "Morgan Stanley"],
  ["visa", "V", "financials", "Visa"], ["coinbase", "COIN", "financials", "Coinbase"],
  ["strategy", "MSTR", "financials", "Strategy"],

  ["lilly", "LLY", "healthcare", "Eli Lilly"], ["unitedhealth", "UNH", "healthcare", "UnitedHealth"],
  ["jnj", "JNJ", "healthcare", "Johnson & Johnson"], ["abbvie", "ABBV", "healthcare", "AbbVie"],
  ["merck", "MRK", "healthcare", "Merck"], ["intuitive", "ISRG", "healthcare", "Intuitive Surgical"],

  ["exxon", "XOM", "energy", "Exxon Mobil"], ["chevron", "CVX", "energy", "Chevron"],
  ["conoco", "COP", "energy", "ConocoPhillips"], ["slb", "SLB", "energy", "SLB"],
  ["freeport", "FCX", "energy", "Freeport-McMoRan"], ["oxy", "OXY", "energy", "Occidental"],

  ["caterpillar", "CAT", "industrials", "Caterpillar"], ["boeing", "BA", "industrials", "Boeing"],
  ["ge", "GE", "industrials", "GE Aerospace"], ["deere", "DE", "industrials", "Deere"],
  ["honeywell", "HON", "industrials", "Honeywell"], ["uber", "UBER", "industrials", "Uber"],

  ["tesla", "TSLA", "consumer", "Tesla"], ["netflix", "NFLX", "consumer", "Netflix"],
  ["homedepot", "HD", "consumer", "Home Depot"], ["nike", "NKE", "consumer", "Nike"],
  ["starbucks", "SBUX", "consumer", "Starbucks"], ["mcdonalds", "MCD", "consumer", "McDonald's"],

  ["walmart", "WMT", "defensives", "Walmart"], ["costco", "COST", "defensives", "Costco"],
  ["pg", "PG", "defensives", "Procter & Gamble"], ["coke", "KO", "defensives", "Coca-Cola"],
  ["pepsi", "PEP", "defensives", "PepsiCo"], ["altria", "MO", "defensives", "Altria"],
].map(([id, symbol, sector, company]) => ({ id, symbol, sector, company }));

// Fetched every settle, NEVER screened, NEVER counted in breadth, never
// flaggable — the same contract `isExcluded` gives crypto's stablecoins.
const INSTRUMENTS = [
  { id: "spy", symbol: "SPY", role: "benchmark" },
  { id: "rsp", symbol: "RSP", role: "equalweight" },
  { id: "iwm", symbol: "IWM", role: "smallcap" },
  { id: "xly", symbol: "XLY", role: "discretionary" },
  { id: "xlp", symbol: "XLP", role: "staples" },
];

const BENCHMARK = "SPY";

/* ── tiny helpers, ported verbatim from the crypto side ───────────────────── */
// NULL IS NOT ZERO. Number(null) is 0 and finite, so the obvious version of
// this turned Yahoo's null OHLC legs — which are common, one leg at a time —
// into a price of exactly zero that then survived every `?? close` fallback
// and every `> 0` guard downstream. Same bug alt-scan's num() shipped.
function fin(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
// NULL IS NOT ZERO — Number(null) is 0 and finite, which turned every absent
// value into a confident zero on the crypto side until fixtures caught it.
function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
function pct(x, d = 1) { return Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}%` : "—"; }
function pts(x, d = 1) { return Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)} pts` : "—"; }
function signed(x, d = 1) { return Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "—"; }
function px(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1000) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`;
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}
function usd(n) {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${Math.round(n / 1e6)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}
function listOf(xs) {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
// Percentage change of `a` over `b`, in percentage POINTS of b.
const chgPct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? ((a - b) / b) * 100 : null);
/**
 * Relative performance of two returns, as a RATIO and not a subtraction.
 * Ported verbatim from computeEthBtc, docstring included: the subtraction is
 * nearly right at small numbers and badly wrong at exactly the numbers that
 * would make someone act on it.
 */
function pair(aPct, bPct) {
  if (!Number.isFinite(aPct) || !Number.isFinite(bPct)) return null;
  const den = 1 + bPct / 100;
  if (!(den > 0.01)) return null;
  return ((1 + aPct / 100) / den - 1) * 100;
}

/* ═══ the ET session clock ═══════════════════════════════════════════════════
 *
 * The clock appears in exactly ONE place — answering "could a session be open
 * right now" — and it is never the authority on whether one actually is. That
 * authority is SPY's own printed-session dates, because holidays are simply
 * ABSENT from a daily timestamp array. It is definitive, self-maintaining, and
 * it repairs itself when the NYSE adds an unscheduled closure; a hardcoded
 * holiday table needs an annual edit and rots silently between them.
 *
 * Intl with an IANA zone handles DST for free, which a fixed UTC offset does
 * not: the ET open is 13:30 UTC in summer and 14:30 in winter.
 */
function etParts(now) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const out = {};
  for (const p of f.formatToParts(new Date(now))) if (p.type !== "literal") out[p.type] = p.value;
  const hour = Number(out.hour) === 24 ? 0 : Number(out.hour);   // en-US hour12:false can emit "24"
  return {
    date: `${out.year}-${out.month}-${out.day}`,
    minutes: hour * 60 + Number(out.minute),
    weekday: out.weekday,
    isWeekend: out.weekday === "Sat" || out.weekday === "Sun",
  };
}

/** A bar's ET session date, from its epoch-seconds timestamp. */
function sessionDateOf(tsSeconds) {
  const d = new Date(tsSeconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(d);
}

/**
 * Which pass this fire is, decided from the ET clock and SPY's printed dates.
 *
 * @param spyDates  ascending session dates SPY actually printed (may be null on
 *                  a feed failure — in which case nothing is claimed)
 * @param settled   the session date already settled, or null
 */
function decidePass(now, spyDates, settled) {
  const et = etParts(now);
  const dates = Array.isArray(spyDates) ? spyDates : [];
  const newest = dates.length ? dates[dates.length - 1] : null;

  // Unsettled history, whatever the clock says — a missed evening is repaired
  // at the next fire rather than leaving a hole in the graded record.
  if (newest && (!settled || settled < newest)) {
    // ...but not while today's bar is still forming: settling an open session
    // grades against a price that is still moving.
    if (newest === et.date && et.minutes < SETTLE_AFTER_ET_MIN) return { pass: "tick", et, newest };
    return { pass: "settle", et, newest };
  }
  if (newest && newest === et.date && et.minutes >= OPEN_ET_MIN && et.minutes < CLOSE_ET_MIN) {
    return { pass: "tick", et, newest };
  }
  return { pass: "idle", et, newest };
}

/** Is the tape printing right now, as far as we can tell. */
function sessionState(now, newestDate) {
  const et = etParts(now);
  const live = !!newestDate && newestDate === et.date && et.minutes >= OPEN_ET_MIN && et.minutes < CLOSE_ET_MIN;
  return live ? "open" : "closed";
}

/* ═══ fetching ═══════════════════════════════════════════════════════════════ */

/** One chart response → ascending daily bars, nulls dropped. */
function parseChart(payload) {
  const res = payload && payload.chart && Array.isArray(payload.chart.result) ? payload.chart.result[0] : null;
  if (!res) return null;
  const ts = Array.isArray(res.timestamp) ? res.timestamp : [];
  const q = res.indicators && Array.isArray(res.indicators.quote) ? res.indicators.quote[0] : null;
  const meta = res.meta || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = fin(q && q.close ? q.close[i] : null);
    if (close == null || close <= 0) continue;      // a hole in the series, not a session
    const date = sessionDateOf(ts[i]);
    if (!date) continue;
    bars.push({
      date,
      open: fin(q.open ? q.open[i] : null) ?? close,
      high: fin(q.high ? q.high[i] : null) ?? close,
      low: fin(q.low ? q.low[i] : null) ?? close,
      close,
      volume: fin(q.volume ? q.volume[i] : null),
    });
  }
  return {
    bars,
    price: fin(meta.regularMarketPrice),
    prevClose: fin(meta.chartPreviousClose) ?? fin(meta.previousClose),
    dayHigh: fin(meta.regularMarketDayHigh),
    dayLow: fin(meta.regularMarketDayLow),
    marketTime: fin(meta.regularMarketTime),
    instrumentType: meta.instrumentType || null,
  };
}

/**
 * A paced, bounded sweep with a circuit breaker.
 *
 * THE BREAKER IS THE POINT. On a 429 or a 401 or an HTML body (Yahoo's block
 * page is a 200), the sweep STOPS — it does not finish the remaining requests
 * and it does not queue them for retry. Hammering an endpoint that just told
 * you to stop is how an unrecoverable ban happens, and a ban cannot be undone
 * by a code fix.
 */
async function sweep(symbols, range, onResult) {
  const state = { blocked: false, reason: null, done: 0, failed: [] };
  let cursor = 0;
  let lastStart = 0;

  const worker = async () => {
    for (;;) {
      if (state.blocked) return;
      const i = cursor++;
      if (i >= symbols.length) return;
      const sym = symbols[i];
      // token bucket, shared across workers
      const wait = Math.max(0, lastStart + MIN_GAP_MS - Date.now());
      lastStart = Math.max(Date.now(), lastStart + MIN_GAP_MS);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (state.blocked) return;
      try {
        const res = await fetch(CHART(sym, range), {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.status === 429 || res.status === 401 || res.status === 403) {
          state.blocked = true; state.reason = `HTTP ${res.status}`; return;
        }
        const ct = String(res.headers.get("content-type") || "");
        if (!ct.includes("json")) { state.blocked = true; state.reason = `content-type ${ct || "unknown"}`; return; }
        if (!res.ok) { state.failed.push(sym); continue; }
        const parsed = parseChart(await res.json());
        if (!parsed || !parsed.bars.length) { state.failed.push(sym); continue; }
        state.done++;
        onResult(sym, parsed);
      } catch (e) {
        state.failed.push(sym);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, worker));
  return state;
}

/* ═══ step 1 — structure, over SESSIONS ══════════════════════════════════════
 *
 * structure20 replaces structure7d, and the two-pairs contract ports VERBATIM
 * including the argument that decides it:
 *
 *   low/high            the 20-session RANGE, today INCLUDED — the only correct
 *                       denominator for pos.
 *   priorHigh/priorLow  the LEVELS, today EXCLUDED. A level drawn from a window
 *                       that contains the price it is compared against equals
 *                       that price on every row making its own low, and
 *                       "invalidation hit" becomes the series testing itself.
 *                       A level that moves with price is not a level.
 *
 * TWENTY because four trading weeks is the shortest window in which an equity
 * base is a base rather than a week of noise — a 5-session range on a stock is
 * routinely one earnings candle wide.
 *
 * HIGHS AND LOWS, NOT CLOSES — the upgrade the crypto side cannot have, since a
 * sparkline is closes only and its "priorHigh" is really the highest CLOSE.
 * Yahoo gives true OHLC, so this is the level a trader actually draws and the
 * level an intraday print actually tests. The break test then splits into two
 * facts crypto could not produce: freshBreak on the CLOSE (conservative, or
 * every intraday poke is a breakout), and `probing` when the HIGH cleared the
 * level but the close did not.
 *
 * And `day = Math.max(2, Math.round(len / 7))` DELETES rather than retunes: one
 * bar is one session, so the heuristic that existed only because CoinGecko
 * truncates young series has no job here.
 */
function structure20(bars) {
  const out = {
    low: null, high: null, last: null, pos: null,
    freshBreak: false, probing: false, priorHigh: null, priorLow: null, sessions: 0,
  };
  const s = Array.isArray(bars) ? bars.slice(-20) : [];
  out.sessions = s.length;
  if (s.length < 8) return out;
  const low = Math.min(...s.map((b) => b.low));
  const high = Math.max(...s.map((b) => b.high));
  const last = s[s.length - 1];
  out.low = low; out.high = high; out.last = last.close;
  // A dead-flat series is a real input; dividing by a zero range would put NaN
  // into the score, and NaN sorts nowhere.
  out.pos = high > low ? (last.close - low) / (high - low) : null;

  const prior = s.slice(0, -1);
  out.priorHigh = Math.max(...prior.map((b) => b.high));
  out.priorLow = Math.min(...prior.map((b) => b.low));
  out.freshBreak = last.close > out.priorHigh;
  out.probing = !out.freshBreak && last.high > out.priorHigh;
  return out;
}

/** Average true range over `n` sessions, as a % of the last close. */
function atrPct(bars, n = 14) {
  const s = Array.isArray(bars) ? bars.slice(-(n + 1)) : [];
  if (s.length < n + 1) return null;
  let sum = 0;
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1].close;
    sum += Math.max(s[i].high - s[i].low, Math.abs(s[i].high - prev), Math.abs(s[i].low - prev));
  }
  const last = s[s.length - 1].close;
  return last > 0 ? r2((sum / n / last) * 100) : null;
}

const median = (xs) => {
  const a = xs.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Simple moving average of the last `n` closes. Null when the series is short. */
function sma(bars, n) {
  const s = Array.isArray(bars) ? bars.slice(-n) : [];
  if (s.length < n) return null;
  return s.reduce((t, b) => t + b.close, 0) / n;
}

/** Return over `n` completed sessions, in percent. */
function retSessions(bars, n) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  const last = bars[bars.length - 1].close;
  const base = bars[bars.length - 1 - n].close;
  return chgPct(last, base);
}

/* ═══ step 2 — the screen ════════════════════════════════════════════════════
 *
 * 100 points, six blocks, parts[] always sums to score. step() ports verbatim:
 * first threshold wins, a non-finite input scores 0 and not a neutral half,
 * because the board ranks evidence.
 *
 * Note the deliberate asymmetry with the regime read, which is already in the
 * crypto code and is kept: the SCREEN does not renormalise (a missing input
 * costs points), the REGIME does (a missing part leaves both sides of the
 * fraction).
 *
 * EVERY LADDER IS RE-DERIVED FROM EQUITY DISPERSION, not rescaled by feel.
 * Daily sigma is roughly 1.0% for SPY, 1.9% for a typical large cap, 3-4% for
 * high beta; a 5-session excess-vs-SPY across a mixed universe is ~4pp sigma,
 * 21-session ~7pp, one-session ~1.7pp. Crypto's rungs sit near the 3rd/15th/
 * 30th/50th/70th percentile of ITS distribution — the percentiles are held and
 * the magnitudes moved.
 */
const RS5 = [[8, 15], [4, 12], [1.5, 9], [0, 6], [-4, 3]];
const RS21 = [[15, 10], [6, 8], [0, 5], [-8, 2]];
const A_SESSION = [[3.5, 18], [2, 14], [1, 10], [0.3, 6], [-0.6, 3]];
const A_5V21 = [[0.6, 12], [0.3, 9], [0.1, 6], [0, 3]];
const RVOL_T = [[5, 15], [3, 13], [2, 11], [1.5, 8], [1.0, 4], [0.7, 1]];
const POS = [[0.9, 10], [0.7, 8], [0.5, 5], [0.3, 2]];
// INVERTED FROM CRYPTO'S `ROOM`, and this is the single change most likely to
// be missed by a mechanical port and most catastrophic if it is. Crypto pays
// MORE points the further a coin sits below its high — room to run. In
// equities that is a broken chart: the 52-week-high effect is one of the most
// durable momentum facts there is, and a name near its high is the one that
// keeps going. So the ladder runs on DISTANCE FROM THE HIGH (a negative
// number), and being close to it pays.
const HIGH_T = [[-2, 10], [-6, 8], [-12, 5], [-25, 2]];

// A memecoin doubles in a week; a mega-cap that does has been acquired. These
// are ~4-5 sigma on their own windows rather than crypto's +40%/+100%.
const PARABOLIC_SESSION = 15;
const PARABOLIC_5 = 35;
const THIN_DOLLAR_VOL = 5_000_000;   // median daily dollar volume you can't exit

function step(value, table) {
  if (!Number.isFinite(value)) return 0;
  for (const [min, points] of table) if (value >= min) return points;
  return 0;
}

/**
 * Screen one symbol. `bench` carries SPY's returns — the bar every relative
 * number is measured against, exactly as btcRow is for crypto. `regime`
 * contributes a FACT and never a point: folding it into the score would make
 * the same chart rank differently in different markets, and the regime already
 * gates things downstream.
 */
function screenStock(row, ctx = {}) {
  const { bench = null, regime = null, sectorMedians = null } = ctx;
  const bars = row && Array.isArray(row.bars) ? row.bars : [];
  const base = { ...(row || {}) };
  const sym = String((row && row.symbol) ?? "").toUpperCase();

  // Too young to screen. Yahoo returns a SHORTER array for a recent listing,
  // not nulls, so the tell is length — which is why this replaces crypto's
  // `newListing` (a null 30d return) rather than porting it.
  if (bars.length < MIN_BARS) {
    return {
      ...base, score: null, band: "cold", parts: [],
      facts: [`${sym || "this row"} has only ${bars.length} printed sessions — listed too recently to screen`],
      flags: { tooYoung: true, parabolic: false, thinLiquidity: false, freshBreak: false, probing: false, noPrint: false },
      rvol: null, rs5: null, rs21: null, accel: { dSessionVsWeek: null, weekVsMonth: null, daily5: null, daily21: null },
      fromHighPct: null, atrPct: null, range20: structure20(bars), dollarVol: null, aboveSma200: null,
    };
  }

  const chgSession = retSessions(bars, 1);
  const chg5 = retSessions(bars, 5);
  const chg21 = retSessions(bars, 21);
  const chg63 = retSessions(bars, 63);
  const overnight = (() => {
    if (bars.length < 2) return null;
    const last = bars[bars.length - 1];
    return chgPct(last.open, bars[bars.length - 2].close);
  })();

  const b5 = bench ? num(bench.chg5) : null;
  const b21 = bench ? num(bench.chg21) : null;
  const rs5 = chg5 != null && b5 != null ? chg5 - b5 : null;
  const rs21 = chg21 != null && b21 != null ? chg21 - b21 : null;

  // Differences, never ratios — a ratio against a return near zero (exactly the
  // name we hunt) divides by ~0 and sorts an infinity to the top.
  const daily5 = chg5 != null ? chg5 / 5 : null;
  const daily21 = chg21 != null ? chg21 / 21 : null;
  const dSessionVsWeek = chgSession != null && daily5 != null ? chgSession - daily5 : null;
  const weekVsMonth = daily5 != null && daily21 != null ? daily5 - daily21 : null;
  const accel = { dSessionVsWeek, weekVsMonth, daily5, daily21 };

  const range20 = structure20(bars);

  // RVOL against the MEDIAN of the prior 20 printed sessions. Median, not mean:
  // one 8x earnings day drags a mean up ~35% and desensitises the measure for a
  // month — and that spike is exactly what we are detecting.
  const vols = bars.slice(-21, -1).map((b) => b.volume).filter(Number.isFinite);
  const medVol = median(vols);
  const lastVol = bars[bars.length - 1].volume;
  const rvol = medVol != null && medVol > 0 && Number.isFinite(lastVol) ? r2(lastVol / medVol) : null;
  const dollarVol = medVol != null ? medVol * bars[bars.length - 1].close : null;

  // The window high, computed BY US from max(high[]) over everything returned —
  // so the label can name the count the response actually carried rather than
  // claiming a year it did not compute. meta.fiftyTwoWeekHigh is UNVERIFIED and
  // deliberately not used.
  const windowHigh = Math.max(...bars.map((b) => b.high));
  const last = bars[bars.length - 1].close;
  const fromHighPct = chgPct(last, windowHigh);   // <= 0
  const sma200 = sma(bars, 200);
  const aboveSma200 = sma200 != null ? last > sma200 : null;

  const parts = [];
  const facts = [];

  // ── relative strength vs SPY (0-25) ──
  parts.push({ key: "rs5", max: 15, points: step(rs5, RS5), label: rs5 == null ? "no 5-session RS (SPY or symbol missing)" : `5-session RS vs SPY ${pts(rs5)}` });
  parts.push({ key: "rs21", max: 10, points: step(rs21, RS21), label: rs21 == null ? "no 21-session RS" : `21-session RS vs SPY ${pts(rs21)}` });
  if (rs5 != null) facts.push(`5 sessions ${pct(chg5)} vs SPY ${pct(b5)} — ${pts(rs5)} of relative strength`);
  if (rs21 != null) facts.push(`21 sessions ${pct(chg21)} vs SPY ${pct(b21)} — ${pts(rs21)}`);

  // ── acceleration (0-30) — the "starting, not started" block ──
  parts.push({ key: "accelSession", max: 18, points: step(dSessionVsWeek, A_SESSION), label: dSessionVsWeek == null ? "no session acceleration" : `last session vs the week's pace ${pts(dSessionVsWeek)}` });
  parts.push({ key: "accel5v21", max: 12, points: step(weekVsMonth, A_5V21), label: weekVsMonth == null ? "no week/month acceleration" : `week vs month pace ${pts(weekVsMonth)}/session` });
  if (dSessionVsWeek != null) facts.push(`last session ${pct(chgSession)} against a 5-session pace of ${pct(daily5, 2)}/session — ${pts(dSessionVsWeek)} of one-day excess`);

  // ── relative volume (0-15) — replaces turnover, which is uncomputable here ──
  parts.push({ key: "rvol", max: 15, points: step(rvol, RVOL_T), label: rvol == null ? "no volume history" : `${rvol}x its own 20-session median volume` });
  if (rvol != null) facts.push(`traded ${rvol}x its normal volume — ${usd(dollarVol)} a day is its median`);

  // ── 20-session structure (0-20) ──
  parts.push({ key: "range", max: 10, points: step(range20.pos, POS), label: range20.pos == null ? "no 20-session range" : `${Math.round(range20.pos * 100)}% up its own 20-session range` });
  parts.push({ key: "break", max: 10, points: range20.freshBreak ? 10 : 0, label: range20.priorHigh == null ? "no break read" : range20.freshBreak ? "closed above the prior 19-session high" : range20.probing ? "poked through the level intraday, closed back under" : "no break of the prior 19-session high" });
  if (range20.pos != null) facts.push(`price sits ${Math.round(range20.pos * 100)}% up its 20-session range (${px(range20.low)}–${px(range20.high)})`);
  if (range20.freshBreak) facts.push(`the last session closed above the prior 19-session high ${px(range20.priorHigh)}`);
  else if (range20.probing) facts.push(`it traded through ${px(range20.priorHigh)} intraday and closed back under it`);

  // ── distance from the window high (0-10) — INVERTED from crypto's ROOM ──
  parts.push({ key: "high", max: 10, points: step(fromHighPct, HIGH_T), label: fromHighPct == null ? "no high reference" : `${Math.abs(Math.round(fromHighPct))}% below its ${bars.length}-session high` });
  if (fromHighPct != null) facts.push(`${Math.abs(Math.round(fromHighPct))}% below its ${bars.length}-session high ${px(windowHigh)}`);

  // ── penalties, clamped to points earned so the floor is a true 0 and parts[]
  //    keeps summing to score ──
  const parabolic = (chgSession != null && chgSession > PARABOLIC_SESSION) || (chg5 != null && chg5 > PARABOLIC_5);
  const thinLiquidity = dollarVol != null && dollarVol < THIN_DOLLAR_VOL;

  let budget = parts.reduce((s, p) => s + p.points, 0);
  if (parabolic) {
    const applied = -Math.min(budget, 25);
    budget += applied;
    parts.push({ key: "parabolic", max: 0, points: applied, label: "parabolic — already gone" });
    facts.push(chgSession != null && chgSession > PARABOLIC_SESSION
      ? `PARABOLIC: ${pct(chgSession)} in one session — this is a chase, not an entry`
      : `PARABOLIC: ${pct(chg5)} in five sessions — this is a chase, not an entry`);
  }
  if (thinLiquidity) {
    const applied = -Math.min(budget, 15);
    budget += applied;
    parts.push({ key: "thin", max: 0, points: applied, label: "too thin to trade" });
    facts.push(`only ${usd(dollarVol)} of median daily volume — you can get in but not out`);
  }

  const score = parts.reduce((s, p) => s + p.points, 0);
  const flags = { tooYoung: false, parabolic, thinLiquidity, freshBreak: range20.freshBreak, probing: range20.probing, noPrint: !!row.noPrint };
  const band = bandOf({ chg5, chg21, rs5, dSessionVsWeek, rvol, pos: range20.pos, flags });

  // The sector fact — a SENTENCE and never a point. Scoring it would create a
  // block that silently penalises any name whose cohort came back thin on a
  // partial pass, and unlike the regime the screen does not renormalise.
  if (sectorMedians && row.sector && Number.isFinite(rs21)) {
    const m = sectorMedians[row.sector];
    if (m && m.n >= 4) {
      facts.push(`${rs21 >= m.median ? "stronger" : "weaker"} than the median of its ${m.n} ${row.sector} peers this month`);
    }
  }
  if ((band === "starting" || band === "warming") && regime && (regime.phase === "risk_off" || regime.phase === "defensive")) {
    facts.push(`this is lifting into a ${regime.label} tape (${regime.score}/100) — the setup is real, the tape is not helping it`);
  }

  return {
    ...base,
    score, band, parts, facts, flags,
    chgSession, overnight, chg5, chg21, chg63,
    rs5, rs21, accel, rvol, dollarVol,
    fromHighPct, windowHigh, atrPct: atrPct(bars), aboveSma200,
    range20, price: last,
  };
}

/**
 * The band is a STATE, not a score bucket — first match wins, in the order a
 * move actually happens, so it reads without the number. `chg5 <= 15` is the
 * ceiling on ignition: a name already up 20% this week breaking to new highs is
 * running, not lighting.
 */
function bandOf({ chg5, chg21, rs5, dSessionVsWeek, rvol, pos, flags }) {
  if (flags.parabolic || (chg21 != null && chg21 > 60 && pos != null && pos >= 0.75)) return "late";
  if (flags.freshBreak && dSessionVsWeek != null && dSessionVsWeek >= 1 && rs5 != null && rs5 > 0 &&
      chg5 != null && chg5 <= 15) return "starting";
  if (chg5 != null && chg5 >= 5 && rs5 != null && rs5 > 0 && pos != null && pos >= 0.5) return "underway";
  if (dSessionVsWeek != null && dSessionVsWeek >= 0.3 && rs5 != null && rs5 >= 0 && (pos == null || pos >= 0.4)) return "warming";
  if (chg5 != null && Math.abs(chg5) <= 4 && rvol != null && rvol >= 0.7 && !flags.thinLiquidity) return "quiet";
  return "cold";
}

/**
 * Screen the whole universe. Rows that cannot be ranked are DROPPED, not sorted
 * to the bottom. Ties break on RVOL, then dollar volume, then symbol — without
 * a total order the board reshuffles between renders of identical data, which
 * reads as live movement and kills trust in the screen.
 */
function screenUniverse(rows, ctx = {}) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const s = screenStock(row, ctx);
    if (s.score == null) continue;
    out.push(s);
  }
  out.sort((a, b) =>
    b.score - a.score ||
    (b.rvol ?? -1) - (a.rvol ?? -1) ||
    (b.dollarVol ?? -1) - (a.dollarVol ?? -1) ||
    String(a.symbol).localeCompare(String(b.symbol)));
  return out;
}

/* ═══ step 3 — the regime read ═══════════════════════════════════════════════
 *
 * THE QUESTION CHANGES. "Is capital rotating into alts" has no equity
 * translation and none of its four inputs survives: breadth ports, BTC
 * dominance has no analogue, ETH/BTC has no analogue, and the crypto Fear &
 * Greed index is crypto-only. The equity question is IS THIS A TAPE THAT PAYS A
 * BREAKOUT — the right question because it is the one that governs the gate,
 * and it is answerable entirely from daily bars we already fetch.
 *
 * THE ALLOCATION IS DESIGNED AROUND THE RENORMALISATION FLOOR. The three
 * droppable parts — the ETF pairs, each an extra request that can fail — sum to
 * exactly 30, leaving 70 in the parts that come from the universe sweep we are
 * making anyway. All three pairs can fail and the read still publishes off 70
 * measured points, comfortably clear of the 50-point refusal floor.
 */
const REGIME_MAX = 100;
const REGIME_MIN_POINTS = REGIME_MAX / 2;
const REGIME_LADDER = [
  { min: 70, phase: "risk_on", label: "Risk on" },
  { min: 55, phase: "broadening", label: "Broadening out" },
  { min: 40, phase: "mixed", label: "Mixed tape" },
  { min: 25, phase: "narrow", label: "Narrow — few names working" },
  { min: -Infinity, phase: "risk_off", label: "Risk off" },
];
const REGIME_PART_NAMES = {
  breadth5: "5-session breadth", breadth21: "21-session breadth",
  participation: "participation above the 200-day",
  rspSpy: "equal-weight vs cap-weight", iwmSpy: "small caps vs large",
  xlyXlp: "discretionary vs staples",
};

function regimeRead({ screened = null, bench = null, instruments = null } = {}) {
  const facts = [];
  const breadth = computeBreadth(screened, bench, facts);
  const participation = computeParticipation(screened, facts);
  const inst = instruments || {};
  const spy21 = bench ? num(bench.chg21) : null;
  const legOf = (key) => (inst[key] ? num(inst[key].chg21) : null);

  const empty = (label) => ({
    score: null, phase: null, label, parts: [], facts,
    breadth5: breadth.beat5Pct, breadth21: breadth.beat21Pct,
    participation: participation.pct, measured: { earned: 0, of: 0 },
  });
  // No breadth means no read: everything else is a tilt around breadth, and on
  // their own they describe the weather, not the rotation.
  if (breadth.beat5Pct == null && breadth.beat21Pct == null) return empty("No read");

  const part = (key, max, points, label) => ({ key, label, points, max, measured: points != null });
  const parts = [];

  parts.push(part("breadth5", 30,
    breadth.beat5Pct == null ? null : Math.round(0.30 * breadth.beat5Pct),
    breadth.beat5Pct == null ? "no 5-session breadth — not scored" : `${Math.round(breadth.beat5Pct)}% of the board beat SPY over 5 sessions`));
  parts.push(part("breadth21", 20,
    breadth.beat21Pct == null ? null : Math.round(0.20 * breadth.beat21Pct),
    breadth.beat21Pct == null ? "no 21-session breadth — not scored" : `${Math.round(breadth.beat21Pct)}% beat SPY over 21 sessions`));
  parts.push(part("participation", 20,
    participation.pct == null ? null : Math.round(0.20 * participation.pct),
    participation.pct == null
      ? `participation not measured (${participation.n} names with 200 sessions of history) — not scored`
      : `${Math.round(participation.pct)}% of the board is above its own 200-day`));

  const pairLeg = (key, aKey, label) => {
    const v = pair(legOf(aKey), spy21);
    return part(key, 10,
      v == null ? null : v > 2 ? 10 : v > 0 ? 7 : v > -2 ? 3 : 0,
      v == null ? `${label} unavailable — not scored` : `${label} ${signed(v)}% over 21 sessions`);
  };
  parts.push(pairLeg("rspSpy", "rsp", "equal-weight vs cap-weight"));
  parts.push(pairLeg("iwmSpy", "iwm", "small caps vs large"));
  parts.push((() => {
    const v = pair(legOf("xly"), legOf("xlp"));
    return part("xlyXlp", 10,
      v == null ? null : v > 2 ? 10 : v > 0 ? 7 : v > -2 ? 3 : 0,
      v == null ? "discretionary vs staples unavailable — not scored" : `discretionary vs staples ${signed(v)}% over 21 sessions`);
  })());

  const scored = parts.filter((p) => p.measured);
  const earned = scored.reduce((s, x) => s + x.points, 0);
  const of = scored.reduce((s, x) => s + x.max, 0);
  const publish = of >= REGIME_MIN_POINTS;
  const score = publish ? Math.max(0, Math.min(100, Math.round((100 * earned) / of))) : null;

  const missing = parts.filter((x) => !x.measured);
  if (missing.length > 0) {
    facts.push(
      `${earned} of the ${of} points on offer were earned${publish ? `, renormalised to ${score} out of 100` : ""}: ` +
      `${listOf(missing.map((x) => REGIME_PART_NAMES[x.key]))} ${missing.length === 1 ? "was" : "were"} not measured, ` +
      "so nothing was scored for " + (missing.length === 1 ? "it" : "them") + " on either side of the fraction");
  }
  if (!publish) facts.push(`only ${of} of ${REGIME_MAX} points had an input — under half, so no regime score is published off it`);

  const rung = publish ? REGIME_LADDER.find((x) => score >= x.min) : null;
  const out = publish ? { score, phase: rung.phase, label: rung.label } : { score: null, phase: null, label: "Not enough measured" };
  return {
    ...out, parts, facts,
    breadth5: breadth.beat5Pct, breadth21: breadth.beat21Pct,
    participation: participation.pct,
    measured: { earned, of },
  };
}

/**
 * Share of the screened board beating SPY over each window. EACH WINDOW KEEPS
 * ITS OWN DENOMINATOR — a name with a 5-session return and no 21-session one
 * would otherwise understate 21-session breadth by exactly the number of recent
 * listings, which spikes in exactly the market where this number matters most.
 */
function computeBreadth(screened, bench, facts) {
  const empty = { beat5Pct: null, beat21Pct: null, n5: 0, n21: 0 };
  if (!Array.isArray(screened) || !screened.length) {
    facts.push("no screened rows — breadth cannot be counted");
    return empty;
  }
  const b5 = bench ? num(bench.chg5) : null;
  const b21 = bench ? num(bench.chg21) : null;
  if (b5 == null && b21 == null) {
    facts.push("no SPY row — there is no bar to measure breadth against");
    return empty;
  }
  let beat5 = 0, n5 = 0, beat21 = 0, n21 = 0;
  for (const r of screened) {
    // A name that did not print when everything else did is dropped from the
    // denominator, not counted as a miss — crypto has no equivalent because
    // crypto never halts.
    if (r.flags && r.flags.noPrint) continue;
    if (b5 != null && Number.isFinite(r.chg5)) { n5++; if (r.chg5 > b5) beat5++; }
    if (b21 != null && Number.isFinite(r.chg21)) { n21++; if (r.chg21 > b21) beat21++; }
  }
  if (n5 > 0) facts.push(`${beat5} of ${n5} names beat SPY over 5 sessions (${Math.round((beat5 / n5) * 100)}%) — SPY did ${pct(b5)}`);
  return {
    beat5Pct: n5 > 0 ? (beat5 / n5) * 100 : null,
    beat21Pct: n21 > 0 ? (beat21 / n21) * 100 : null,
    n5, n21,
  };
}

/**
 * Share of the board trading above its OWN 200-session average.
 *
 * THE DOMINANCE REPLACEMENT, and better-founded than what it replaces: a
 * stock-by-stock binary with no benchmark in it at all, so it is not breadth
 * wearing a hat. It is what distinguishes "the index is up because five names
 * are up" from "the market is up". 200 rather than 21 deliberately — a 21-SMA
 * participation count correlates hard with breadth5 and would be the same
 * measurement paid for twice.
 */
function computeParticipation(screened, facts) {
  if (!Array.isArray(screened) || !screened.length) return { pct: null, n: 0 };
  let above = 0, n = 0;
  for (const r of screened) {
    if (r.flags && r.flags.noPrint) continue;
    if (typeof r.aboveSma200 === "boolean") { n++; if (r.aboveSma200) above++; }
  }
  if (n < 20) {
    if (facts) facts.push(`only ${n} names carry 200 sessions of history — participation not measured`);
    return { pct: null, n };
  }
  return { pct: (above / n) * 100, n };
}

/* ═══ step 4 — price targets ═════════════════════════════════════════════════
 *
 * Measured moves off the 20-session structure. h = priorHigh − priorLow is the
 * base the move is measured from — both ends drawn from SESSIONS THAT ARE DONE
 * (see structure20), so no target or invalidation can move with the price it is
 * later compared against.
 *
 * The fibonacci geometry ports unchanged; what changes is the CLAMP FLOOR. T1
 * at +5% is a coin's floor. For an equity it must scale with the name's own
 * volatility, or a 1.2%-a-day utility gets a target it will not reach for a
 * month while a 6%-a-day biotech gets one it clears before lunch. So the floor
 * is 1.5 x ATR, bounded to [2%, 12%] — ATR is the only unit that means the same
 * thing on both.
 */
function targetsFor(row) {
  const price = row && Number.isFinite(row.price) ? row.price : null;
  const r = row && row.range20 ? row.range20 : null;
  const priorHigh = r && Number.isFinite(r.priorHigh) ? r.priorHigh : null;
  const priorLow = r && Number.isFinite(r.priorLow) ? r.priorLow : null;
  if (price == null || price <= 0 || priorHigh == null || priorHigh <= 0 || priorLow == null) return null;
  const h = priorHigh - priorLow;
  if (!(h > 0)) return null;

  const breakout = !!(r.freshBreak || price > priorHigh);
  let t1, t2, t3, invalidation;
  if (breakout) {
    t1 = priorHigh + 0.382 * h;
    t2 = priorHigh + 0.618 * h;
    t3 = priorHigh + 1.0 * h;
    invalidation = priorHigh - 0.382 * h;
  } else {
    t1 = priorHigh;
    t2 = priorHigh + 0.5 * h;
    t3 = priorHigh + 1.0 * h;
    invalidation = priorLow;
  }

  // The window high is a real wall — the nearest target at or above it snaps
  // onto it rather than pretending the market will pick our number over the
  // market's.
  const wh = row && Number.isFinite(row.windowHigh) ? row.windowHigh : null;
  if (wh != null && wh > price && wh <= t3 * 1.05) {
    if (t1 >= wh) t1 = wh;
    else if (t2 >= wh) t2 = wh;
    else if (t3 >= wh) t3 = wh;
  }

  // Volatility-scaled floor, then >=2% between rungs — not merely ascending.
  const atr = Number.isFinite(row.atrPct) ? row.atrPct : null;
  const minMovePct = Math.min(12, Math.max(2, (atr != null ? atr : 2) * 1.5));
  if (t1 < price * (1 + minMovePct / 100)) t1 = price * (1 + minMovePct / 100);
  if (t2 < t1 * 1.02) t2 = t1 * 1.02;
  if (t3 < t2 * 1.02) t3 = t2 * 1.02;
  if (!(invalidation < price * 0.99)) return null;

  const pctVs = (t) => Math.round((t / price - 1) * 1000) / 10;
  return {
    t1, t2, t3, invalidation, minMovePct: r1(minMovePct),
    t1Pct: pctVs(t1), t2Pct: pctVs(t2), t3Pct: pctVs(t3), invPct: pctVs(invalidation),
  };
}

/* ═══ step 5 — flags ═════════════════════════════════════════════════════════
 *
 * Two tiers: 'igniting' (the move is starting now) and 'building' (a base
 * lifting over days). A flag needs a tradeable name, a target structure worth
 * flagging, and a band+score that says the move is starting rather than started.
 */
function igniteCond(row) {
  if (!row || !Number.isFinite(row.score)) return false;
  if (row.band === "starting" && row.score >= 55) return true;
  const a = row.accel && Number.isFinite(row.accel.dSessionVsWeek) ? row.accel.dSessionVsWeek : null;
  return row.band === "underway" && a != null && a >= 2 &&
    Number.isFinite(row.chgSession) && row.chgSession <= 8 && row.score >= 60;
}

/**
 * How many open flags a tape is allowed to carry, and how good a setup has to
 * be to earn one. THE TOOL SHOULD BE QUIET WHEN THE MARKET IS — the crypto side
 * shipped fifty-two open flags in a hostile tape before this existed, and a
 * list that long is not a signal, it is the absence of one wearing a signal's
 * clothes.
 */
const PHASE_GATE = {
  risk_on: { max: 10, floor: 60 },
  broadening: { max: 8, floor: 64 },
  mixed: { max: 6, floor: 68 },
  narrow: { max: 4, floor: 72 },
  risk_off: { max: 2, floor: 76 },
};
const DEFAULT_GATE = { max: 6, floor: 68 };
function gateFor(regime) {
  const phase = regime && regime.phase;
  return (phase && PHASE_GATE[phase]) || DEFAULT_GATE;
}

/**
 * The percentile leg. In a hot tape everything clears a fixed floor, so the bar
 * also has to move with the day's own distribution. It can only ever RAISE the
 * bar — it cannot manufacture flags in a cold tape, and claiming otherwise was
 * the one overclaim worth naming.
 */
function effectiveFloor(gate, scoreDist) {
  const p = scoreDist && Number.isFinite(scoreDist.p90) ? scoreDist.p90 : null;
  const floor = gate.floor ?? DEFAULT_GATE.floor;
  return { value: p != null ? Math.max(floor, p) : floor, bindingLeg: p != null && p > floor ? "percentile" : "floor" };
}

function flagTier(row, gate = DEFAULT_GATE, floorValue = null) {
  if (!row || !Number.isFinite(row.score)) return null;
  if (row.flags && (row.flags.thinLiquidity || row.flags.tooYoung || row.flags.noPrint)) return null;
  const t = row.targets;
  if (!t || !Number.isFinite(t.t1Pct) || t.t1Pct < (t.minMovePct ?? 2)) return null;
  // Losing to SPY disqualifies the setup whatever the chart looks like, and it
  // is MORE defensible here than in crypto: SPY is a literal alternative
  // position he can hold instead of this name.
  if (!Number.isFinite(row.rs5) || row.rs5 <= 0) return null;
  if (row.score < (floorValue ?? gate.floor ?? DEFAULT_GATE.floor)) return null;

  if (igniteCond(row)) return "igniting";
  if (row.band === "warming" || row.band === "starting") return "building";
  return null;
}

const STATUS_RANK = { active: 0, hit_t1: 1, hit_t2: 2, hit_t3: 3 };
const FADE_MIN_SESSIONS = 3;
const FADE_SCORE = 35;
const STALE_SESSIONS = 20;   // ~one trading month, counted in SESSIONS

/**
 * Transition the flag log for one settled session.
 *
 * THE LADDER RATCHETS UP ONLY, against targets FROZEN at flag time, and a
 * re-scan NEVER resets first_flagged_at — remembering the first day is the
 * log's entire reason to exist.
 *
 * Grading uses the session's real HIGH and LOW, not its close. An equity can
 * gap through T2 at the open and be back under T1 within a minute, and the
 * opening print is exactly the price a close series is worst at. Crypto has no
 * opening gap, which is why its hourly close sampler was adequate and ours
 * would not be.
 */
function transitionFlags(openRows, screenedById, session, gate = DEFAULT_GATE, floorValue = null) {
  const asOf = session.at;
  const sessionIndex = session.index ?? 0;
  const inserts = [];
  const updates = [];
  const openIds = new Set();

  for (const row of openRows || []) {
    openIds.add(row.ticker_id);
    const s = screenedById.get(row.ticker_id);
    const patch = { id: row.id, last_seen_at: asOf };

    if (!s) {
      // No screened row this session. Not graded, not closed — a name can miss
      // a pass. The delisted/identity guards close it deliberately elsewhere.
      updates.push(patch);
      continue;
    }
    const high = Number.isFinite(s.sessionHigh) ? s.sessionHigh : s.price;
    const low = Number.isFinite(s.sessionLow) ? s.sessionLow : s.price;
    patch.last_price = s.price;

    const peak = Math.max(num(row.peak_price) ?? -Infinity, high);
    if (Number.isFinite(peak) && peak > (num(row.peak_price) ?? -Infinity)) {
      patch.peak_price = peak;
      patch.peak_at = asOf;
    }

    // Invalidation first: a level lost is lost even if the same session also
    // tagged a target, because the stop would have been hit on the way.
    const inv = num(row.invalidation);
    if (inv != null && low <= inv) {
      patch.status = "invalidated";
      patch.resolved_at = asOf;
      updates.push(patch);
      continue;
    }

    let status = row.status;
    const rank = STATUS_RANK[status] ?? 0;
    const t3 = num(row.t3), t2 = num(row.t2), t1 = num(row.t1);
    if (t3 != null && high >= t3 && rank < 3) status = "hit_t3";
    else if (t2 != null && high >= t2 && rank < 2) status = "hit_t2";
    else if (t1 != null && high >= t1 && rank < 1) status = "hit_t1";
    if (status !== row.status) patch.status = status;
    if (status === "hit_t3") patch.resolved_at = asOf;

    const ageSessions = Number.isFinite(row.first_session_index) ? sessionIndex - row.first_session_index : null;
    const age = ageSessions != null ? ageSessions : Math.floor((Date.parse(asOf) - Date.parse(row.first_flagged_at)) / DAY / 1.4);
    if (!patch.resolved_at && age >= FADE_MIN_SESSIONS && Number.isFinite(s.score) && s.score < FADE_SCORE) {
      patch.status = "faded";
      patch.resolved_at = asOf;
    }
    if (!patch.resolved_at && age >= STALE_SESSIONS) patch.resolved_at = asOf;
    updates.push(patch);
  }

  // Room left under the cap, filled by SCORE and not by arrival order.
  const room = Math.max(0, (gate.max ?? DEFAULT_GATE.max) - openIds.size);
  if (room > 0) {
    const candidates = [];
    for (const [id, s] of screenedById) {
      if (openIds.has(id)) continue;
      const tier = flagTier(s, gate, floorValue);
      if (tier) candidates.push({ s, tier });
    }
    candidates.sort((a, b) => b.s.score - a.s.score || String(a.s.symbol).localeCompare(String(b.s.symbol)));
    for (const { s, tier } of candidates.slice(0, room)) {
      inserts.push({
        id: `${s.id}:${session.date}`,
        ticker_id: s.id, symbol: s.symbol, name: s.company || s.symbol,
        tier, status: "active",
        first_flagged_at: asOf,
        flag_price: s.price, score: s.score,
        t1: s.targets.t1, t2: s.targets.t2, t3: s.targets.t3, invalidation: s.targets.invalidation,
        peak_price: s.price, peak_at: asOf,
        last_price: s.price, last_seen_at: asOf,
        notes: { flagSession: session.date, flagSessionIndex: sessionIndex, band: s.band },
      });
    }
  }
  return { inserts, updates };
}

/* ═══ the payload row (client contract) ══════════════════════════════════════ */
function sampleSpark(bars, n) {
  const closes = (Array.isArray(bars) ? bars : []).slice(-63).map((b) => b.close);
  if (closes.length <= n) return closes;
  const stepBy = (closes.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(closes[Math.round(i * stepBy)]);
  return out;
}

function boardRow(r) {
  return {
    id: r.id, symbol: r.symbol, name: r.company || r.symbol, sector: r.sector,
    price: r.price,
    chgSession: r1(r.chgSession), overnight: r1(r.overnight),
    chg5: r1(r.chg5), chg21: r1(r.chg21), chg63: r1(r.chg63),
    score: r.score, band: r.band, parts: r.parts, facts: r.facts,
    // flags{} rides along so the client's entry read can NAME why a name isn't
    // an entry rather than inferring it back out of the band, which collapses
    // parabolic and thin into one word.
    flags: r.flags,
    // accel is the pace reference, so the client never re-derives a screener
    // input; atrPct so the sheet can say what a normal day looks like for it.
    accel: r.accel, atrPct: r.atrPct,
    rvol: r.rvol, rs5: r1(r.rs5), rs21: r1(r.rs21),
    fromHighPct: r1(r.fromHighPct), windowHigh: r.windowHigh, windowSessions: (r.bars || []).length,
    aboveSma200: r.aboveSma200,
    range20: {
      low: r.range20.low, high: r.range20.high, pos: r.range20.pos,
      freshBreak: r.range20.freshBreak, probing: r.range20.probing,
      priorHigh: r.range20.priorHigh, priorLow: r.range20.priorLow,
      // sessions guards exactly one claim: "breaking out" must not be asserted
      // off a short series.
      sessions: r.range20.sessions,
    },
    spark: sampleSpark(r.bars, SPARK_POINTS),
    targets: r.targets || null,
  };
}

/* ═══ the passes ═════════════════════════════════════════════════════════════ */

async function runPass(now = Date.now()) {
  const counts = { pass: null, requests: 0, screened: 0, board: 0, flagsInserted: 0, flagsUpdated: 0, flagsClosed: 0, stateWritten: false };
  const errors = [];

  const configured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!configured) return { counts, errors: ["supabase env not set — nothing to do"] };
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: "boardroom" }, auth: { persistSession: false },
  });

  const { data: stateRow, error: stateErr } = await db.from("stock_state").select("payload").eq("id", "latest").maybeSingle();
  if (stateErr) return { counts, errors: [`stock_state read: ${stateErr.message}`] };
  const prev = (stateRow && stateRow.payload) || null;

  // A blocked feed backs off for a full session rather than retrying hourly
  // into a wall.
  if (prev && prev.feed && prev.feed.blocked) {
    const since = Date.parse(prev.feed.since || "");
    if (Number.isFinite(since) && now - since < 12 * HOUR) {
      counts.pass = "backoff";
      return { counts, errors: [`feed blocked since ${prev.feed.since} (${prev.feed.reason || "unknown"}) — backing off`] };
    }
  }

  // One request to learn the calendar. On a weekend with a settled book we do
  // not even spend that.
  const et = etParts(now);
  const settled = prev ? prev.settledSession || null : null;
  if (et.isWeekend && settled) {
    counts.pass = "idle";
    return { counts, errors };
  }

  let spy = null;
  const spyState = await sweep([BENCHMARK], "1y", (_s, parsed) => { spy = parsed; });
  counts.requests += 1;
  if (spyState.blocked) {
    await db.from("stock_state").upsert({
      id: "latest", updated_at: new Date(now).toISOString(),
      payload: { ...(prev || {}), feed: { blocked: true, since: new Date(now).toISOString(), reason: spyState.reason } },
    });
    counts.pass = "blocked";
    return { counts, errors: [`feed blocked: ${spyState.reason}`] };
  }
  if (!spy || !spy.bars.length) {
    counts.pass = "idle";
    return { counts, errors: ["SPY returned no bars — cannot establish the session calendar"] };
  }

  const spyDates = spy.bars.map((b) => b.date);
  const decision = decidePass(now, spyDates, settled);
  counts.pass = decision.pass;

  if (decision.pass === "idle") return { counts, errors };
  if (decision.pass === "tick") {
    const t = await tick(db, prev, spy, now);
    Object.assign(counts, t.counts);
    counts.pass = "tick";
    return { counts, errors: errors.concat(t.errors) };
  }
  const s = await settle(db, prev, spy, now, decision);
  Object.assign(counts, s.counts);
  counts.pass = "settle";
  return { counts, errors: errors.concat(s.errors) };
}

/**
 * SETTLE — the day's judgment, once, after the close.
 *
 * Everything the tab shows is decided here and then holds still for a whole
 * session, which is what makes an episode gradeable at all.
 */
async function settle(db, prev, spy, now, decision) {
  const counts = { requests: 1, screened: 0, board: 0, flagsInserted: 0, flagsUpdated: 0, flagsClosed: 0, stateWritten: false };
  const errors = [];
  const nowIso = new Date(now).toISOString();
  const spyDates = spy.bars.map((b) => b.date);
  const sessionDate = spyDates[spyDates.length - 1];
  const sessionIndex = spyDates.length;

  const fetched = new Map();
  const symbols = [...EQUITIES.map((e) => e.symbol), ...INSTRUMENTS.filter((i) => i.symbol !== BENCHMARK).map((i) => i.symbol)];
  const state = await sweep(symbols, "1y", (sym, parsed) => fetched.set(sym, parsed));
  counts.requests += state.done + state.failed.length;
  if (state.blocked) {
    await db.from("stock_state").upsert({
      id: "latest", updated_at: nowIso,
      payload: { ...(prev || {}), feed: { blocked: true, since: nowIso, reason: state.reason } },
    });
    return { counts, errors: [`feed blocked mid-sweep: ${state.reason}`] };
  }
  fetched.set(BENCHMARK, spy);

  // COVERAGE GATE. A pass that saw most of the universe still writes; a pass
  // that saw half of it must not overwrite a good board with a thin one — the
  // regime, the breadth denominators and the percentile floor would all be
  // computed off a sample nobody chose.
  const coverage = EQUITIES.length ? EQUITIES.filter((e) => fetched.has(e.symbol)).length / EQUITIES.length : 0;

  const benchBars = spy.bars;
  const bench = {
    symbol: BENCHMARK,
    chgSession: retSessions(benchBars, 1),
    chg5: retSessions(benchBars, 5),
    chg21: retSessions(benchBars, 21),
  };
  const instruments = {};
  for (const inst of INSTRUMENTS) {
    const p = fetched.get(inst.symbol);
    if (p && p.bars.length) instruments[inst.id] = { chg21: retSessions(p.bars, 21), chg5: retSessions(p.bars, 5) };
  }

  const health = { tooYoung: [], noPrint: [], notFound: [] };
  const rows = [];
  for (const e of EQUITIES) {
    const p = fetched.get(e.symbol);
    if (!p || !p.bars.length) { health.notFound.push(e.symbol); continue; }
    const last = p.bars[p.bars.length - 1];
    // Did not print when everything else did — dropped from the board and from
    // every breadth denominator rather than counted as a miss.
    const noPrint = last.date !== sessionDate;
    if (noPrint) health.noPrint.push(e.symbol);
    if (p.bars.length < MIN_BARS) health.tooYoung.push(e.symbol);
    rows.push({
      ...e, bars: p.bars, noPrint,
      sessionHigh: last.high, sessionLow: last.low,
    });
  }

  // Two-stage screen: once to get rs21 for the sector medians, once with them.
  const first = screenUniverse(rows, { bench });
  const bySector = {};
  for (const r of first) {
    if (!r.sector || !Number.isFinite(r.rs21)) continue;
    (bySector[r.sector] = bySector[r.sector] || []).push(r.rs21);
  }
  const sectorMedians = {};
  for (const [k, v] of Object.entries(bySector)) sectorMedians[k] = { median: median(v), n: v.length };

  const screened = screenUniverse(rows, { bench, sectorMedians });
  counts.screened = screened.length;
  for (const r of screened) r.targets = targetsFor(r);

  const regime = regimeRead({ screened, bench, instruments });
  // The regime needs the screened rows, so it is computed after — but the
  // sector facts wanted it. One more cheap pass rather than a wrong fact.
  const finalRows = screenUniverse(rows, { bench, sectorMedians, regime });
  for (const r of finalRows) r.targets = targetsFor(r);

  const scores = finalRows.map((r) => r.score).filter(Number.isFinite).sort((a, b) => a - b);
  const at = (q) => (scores.length ? scores[Math.min(scores.length - 1, Math.floor(q * scores.length))] : null);
  const scoreDist = { p50: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95), max: scores[scores.length - 1] ?? null, n: scores.length };

  const gate = gateFor(regime);
  const floor = effectiveFloor(gate, scoreDist);
  const qualifiers = finalRows.filter((r) => flagTier(r, gate, floor.value)).length;

  if (coverage < 0.8) {
    errors.push(`coverage ${Math.round(coverage * 100)}% — board and flags not written this pass`);
    await db.from("stock_state").upsert({
      id: "latest", updated_at: nowIso,
      payload: { ...(prev || {}), coverage: r2(coverage), missing: health.notFound, feed: { blocked: false } },
    });
    return { counts, errors };
  }

  // ── flags ──
  const { data: openRows, error: openErr } = await db.from("stock_flags").select("*").is("resolved_at", null);
  if (openErr) errors.push(`flags read: ${openErr.message}`);
  else {
    const byId = new Map(finalRows.map((r) => [r.id, r]));
    const { inserts, updates } = transitionFlags(openRows || [], byId, { date: sessionDate, at: nowIso, index: sessionIndex }, gate, floor.value);
    if (inserts.length) {
      const up = await db.from("stock_flags").upsert(inserts, { onConflict: "id", ignoreDuplicates: true }).select("id");
      if (up.error) errors.push(`flag insert: ${up.error.message}`);
      else counts.flagsInserted = (up.data || []).length;
    }
    if (updates.length) {
      // ONE round trip for the whole batch, and each row spread over its
      // ORIGINAL columns — a multi-row upsert unions the column set across the
      // batch, so a row missing a column another row supplies would get that
      // column NULLED rather than left alone.
      const openById = new Map((openRows || []).map((r) => [r.id, r]));
      const merged = updates.map((u) => ({ ...openById.get(u.id), ...u }));
      const up = await db.from("stock_flags").upsert(merged, { onConflict: "id" }).select("id");
      if (up.error) errors.push(`flag update: ${up.error.message}`);
      else {
        counts.flagsUpdated = (up.data || []).length;
        counts.flagsClosed = updates.filter((u) => u.resolved_at).length;
      }
    }
  }

  // ── the session row ──
  const closes = {};
  for (const r of finalRows) if (Number.isFinite(r.price)) closes[r.symbol] = r.price;
  const sIns = await db.from("stock_sessions").upsert({
    session_date: sessionDate, settled_at: nowIso,
    regime_score: regime.score, regime_phase: regime.phase,
    breadth5: r1(regime.breadth5), breadth21: r1(regime.breadth21), participation: r1(regime.participation),
    score_dist: scoreDist, qualifiers, coverage: r2(coverage), closes, anchor: {},
  }, { onConflict: "session_date" });
  if (sIns.error) errors.push(`session upsert: ${sIns.error.message}`);

  const board = finalRows.slice(0, BOARD_SIZE).map(boardRow);
  counts.board = board.length;

  const spanOf = (n) => {
    if (spyDates.length < 2) return null;
    const prevDate = spyDates[spyDates.length - 2];
    const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short" });
    return `${fmt(prevDate)} close → ${fmt(sessionDate)} open`;
  };
  const label = new Date(`${sessionDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });

  const topBy = (pick) => finalRows
    .map((r) => ({ r, v: pick(r) }))
    .filter((x) => Number.isFinite(x.v) && !x.r.flags.noPrint)
    .sort((a, b) => b.v - a.v)
    .slice(0, 12)
    .map(({ r, v }) => ({ id: r.id, symbol: r.symbol, name: r.company, price: r.price, pct: r1(v), spark: sampleSpark(r.bars, SPARK_POINTS) }));

  const payload = {
    asOf: nowIso,
    settledSession: sessionDate,
    settledAt: nowIso,
    session: {
      state: sessionState(now, spyDates[spyDates.length - 1]),
      lastSessionDate: sessionDate,
      lastSessionLabel: label,
      overnightSpan: spanOf(),
      verdictLive: false,
    },
    regime: { ...regime, gate: { ...gate, effectiveFloor: floor.value, bindingLeg: floor.bindingLeg } },
    board,
    movers: {
      "1s": topBy((r) => r.chgSession),
      overnight: topBy((r) => r.overnight),
      "5s": topBy((r) => r.chg5),
      "21s": topBy((r) => r.chg21),
    },
    coverage: r2(coverage),
    missing: health.notFound,
    scoreDist, qualifiers,
    universeHealth: { tooYoung: health.tooYoung, noPrint: health.noPrint, notFound: health.notFound },
    live: null,
    feed: { blocked: false },
  };
  const up = await db.from("stock_state").upsert({ id: "latest", updated_at: nowIso, payload });
  if (up.error) errors.push(`stock_state upsert: ${up.error.message}`);
  else counts.stateWritten = true;

  const cut = spyDates[Math.max(0, spyDates.length - SESSION_KEEP)];
  if (cut) {
    const del = await db.from("stock_sessions").delete().lt("session_date", cut);
    if (del.error) errors.push(`session prune: ${del.error.message}`);
  }
  return { counts, errors };
}

/**
 * TICK — inside the session. Open flags only, plus SPY (already fetched).
 *
 * Recomputes NO score, band, target or regime. Its whole job is the three
 * things that genuinely cannot wait for the close: the peak ratchet, the
 * invalidation test, and a live price for the names you actually hold a plan
 * on. Ticking the whole board would be ~4x the rest of the design's traffic to
 * keep fresh a price column on a folded card whose judgment does not move.
 */
async function tick(db, prev, spy, now) {
  const counts = { requests: 1, flagsUpdated: 0, flagsClosed: 0, stateWritten: false };
  const errors = [];
  const nowIso = new Date(now).toISOString();

  const { data: openRows, error } = await db.from("stock_flags").select("*").is("resolved_at", null);
  if (error) return { counts, errors: [`flags read: ${error.message}`] };
  const open = openRows || [];
  if (!open.length && prev) {
    // Nothing to watch — just refresh the session state so the tab stops
    // saying "closed" the moment the bell rings.
    const payload = { ...prev, asOf: nowIso, session: { ...(prev.session || {}), state: sessionState(now, prev.settledSession) } };
    await db.from("stock_state").upsert({ id: "latest", updated_at: nowIso, payload });
    counts.stateWritten = true;
    return { counts, errors };
  }

  const quotes = new Map();
  const state = await sweep(open.map((r) => r.symbol), "1d", (sym, parsed) => quotes.set(sym, parsed));
  counts.requests += state.done + state.failed.length;
  if (state.blocked) {
    await db.from("stock_state").upsert({
      id: "latest", updated_at: nowIso,
      payload: { ...(prev || {}), feed: { blocked: true, since: nowIso, reason: state.reason } },
    });
    return { counts, errors: [`feed blocked on tick: ${state.reason}`] };
  }

  const updates = [];
  const prices = {}, dayHighs = {};
  for (const row of open) {
    const q = quotes.get(row.symbol);
    if (!q || q.price == null) continue;
    prices[row.symbol] = q.price;
    // The day high is itself a running maximum, so sampling it hourly loses
    // almost nothing — unlike sampling closes, which loses the opening print.
    const high = Number.isFinite(q.dayHigh) ? q.dayHigh : q.price;
    const low = Number.isFinite(q.dayLow) ? q.dayLow : q.price;
    dayHighs[row.symbol] = high;

    const patch = { id: row.id, last_price: q.price, last_seen_at: nowIso };
    const peakStored = num(row.peak_price);
    if (peakStored == null || high > peakStored) { patch.peak_price = high; patch.peak_at = nowIso; }

    const inv = num(row.invalidation);
    if (inv != null && low <= inv) { patch.status = "invalidated"; patch.resolved_at = nowIso; }
    else {
      const rank = STATUS_RANK[row.status] ?? 0;
      const t3 = num(row.t3), t2 = num(row.t2), t1 = num(row.t1);
      if (t3 != null && high >= t3 && rank < 3) { patch.status = "hit_t3"; patch.resolved_at = nowIso; }
      else if (t2 != null && high >= t2 && rank < 2) patch.status = "hit_t2";
      else if (t1 != null && high >= t1 && rank < 1) patch.status = "hit_t1";
    }
    updates.push(patch);
  }

  if (updates.length) {
    const byId = new Map(open.map((r) => [r.id, r]));
    const merged = updates.map((u) => ({ ...byId.get(u.id), ...u }));
    const up = await db.from("stock_flags").upsert(merged, { onConflict: "id" }).select("id");
    if (up.error) errors.push(`tick update: ${up.error.message}`);
    else {
      counts.flagsUpdated = (up.data || []).length;
      counts.flagsClosed = updates.filter((u) => u.resolved_at).length;
    }
  }

  if (prev) {
    const payload = {
      ...prev,
      asOf: nowIso,
      session: { ...(prev.session || {}), state: sessionState(now, prev.settledSession), verdictLive: false },
      live: { asOf: nowIso, prices, dayHigh: dayHighs },
      feed: { blocked: false },
    };
    const up = await db.from("stock_state").upsert({ id: "latest", updated_at: nowIso, payload });
    if (up.error) errors.push(`stock_state upsert: ${up.error.message}`);
    else counts.stateWritten = true;
  }
  return { counts, errors };
}

// Scheduled hourly via netlify.toml as a background invocation. Netlify does
// not route public HTTP to a scheduled function in production; the ping and
// POST paths here are reachable only under `netlify dev`. Counts only on every
// path — the payload never leaves through this endpoint, and error DETAIL stays
// in the function log.
exports.handler = async (event) => {
  const configured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  let body = {};
  try { body = JSON.parse((event && event.body) || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "stock-cron-background", configured, scheduled: true });

  try {
    const { counts, errors } = await runPass(Date.now());
    console.log(
      `[stock-cron-background] pass=${counts.pass} requests=${counts.requests} screened=${counts.screened} ` +
      `board=${counts.board} flags +${counts.flagsInserted} ~${counts.flagsUpdated} closed=${counts.flagsClosed} ` +
      `state=${counts.stateWritten}` + (errors.length ? ` errors=${errors.length} [${errors.join(" | ")}]` : ""));
    return json(200, { success: true, service: "stock-cron-background", counts, errorCount: errors.length });
  } catch (e) {
    console.error("stock-cron-background failed:", e);
    return json(200, { success: false, service: "stock-cron-background", error: String((e && e.message) || e) });
  }
};

// Pure helpers, exported for scripts/stocks-smoke.mjs (Netlify only reads
// `handler`).
exports.EQUITIES = EQUITIES;
exports.INSTRUMENTS = INSTRUMENTS;
exports.parseChart = parseChart;
exports.structure20 = structure20;
exports.atrPct = atrPct;
exports.retSessions = retSessions;
exports.sma = sma;
exports.pair = pair;
exports.screenStock = screenStock;
exports.screenUniverse = screenUniverse;
exports.bandOf = bandOf;
exports.regimeRead = regimeRead;
exports.targetsFor = targetsFor;
exports.flagTier = flagTier;
exports.effectiveFloor = effectiveFloor;
exports.transitionFlags = transitionFlags;
exports.gateFor = gateFor;
exports.decidePass = decidePass;
exports.etParts = etParts;
exports.sessionDateOf = sessionDateOf;
exports.PHASE_GATE = PHASE_GATE;
