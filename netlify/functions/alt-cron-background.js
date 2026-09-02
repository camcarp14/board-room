// ─── alt-cron-background — the hourly alt-season brain ───────────────────────
// Scheduled hourly (netlify.toml). Does ALL the heavy math for the Markets →
// Alt Season tab so the client-facing alt-scan.js stays light: three keyless
// HTTP calls, screen the top 250, read the rotation regime, compute targets,
// tier flags, transition the flag log, and persist everything to Supabase
// (schema "boardroom"). Zero LLM calls, by design.
//
// "-BACKGROUND" IS LOAD-BEARING, NOT COSMETIC. It shipped as plain "alt-cron"
// first and ran clean exactly once (empty flag table, nothing to update) —
// then never wrote another snapshot for eleven hours straight. The second
// pass had to individually UPDATE every open flag, one Supabase round trip
// each, sequentially, in a for-loop — and a synchronous Netlify function has
// seconds, not minutes: econ-resolve-background.js's own header cites this
// account's actual measured deaths at 8.8s, 15.7s and 30.8s before it moved
// off the request path for the same reason. A flag count that only grows
// turns that loop into a time bomb with a fuse that gets shorter every pass.
// "-background" gets fifteen minutes, which makes the deadline stop being the
// design constraint — the same fix this repo already made once elsewhere.
//
// THIS FUNCTION MUST NEVER THROW. A scheduled function that 500s writes
// nothing, and two of the things it writes cannot be backfilled:
//   - the hourly alt_snapshots row (the only source of 4h/12h mover baselines)
//   - today's dominance sample in domHistory (CoinGecko's free tier has no
//     dominance history endpoint at any price we pay — "is dominance falling?",
//     the most load-bearing question in an alt-season read, is only answerable
//     because this pass writes the number down every day)
// So every failure path still writes what it can: a dead markets feed still
// records dominance; a dead Supabase still returns counts. Errors are collected
// and reported, never thrown.
//
// Self-contained on purpose — no shared helpers. See the header of
// scripts/functions-smoke.mjs for the triple outage that rule comes from.
// Pure helpers are exported for the smoke (scripts/altseason-smoke.mjs), the
// calendar.js precedent.
//
// Screener and season math ported from the-pentagon (apps/macro/src/lib/alts/
// screen.js + season.js) — thresholds identical, phase ladder per the Board
// Room contract.

const { createClient } = require("@supabase/supabase-js");

const MARKETS_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=1h%2C24h%2C7d%2C30d";
// The page asks for 250. Anything under this is a broken response rather than
// a smaller market, and must not be allowed to redefine the board or the season
// score. Same intent as the equity engine's 80% coverage gate, against a
// universe whose size we control by request rather than by authored list.
const MIN_UNIVERSE = 200;
const GLOBAL_URL = "https://api.coingecko.com/api/v3/global";
const FNG_URL = "https://api.alternative.me/fng/?limit=1";
// Every category CoinGecko knows, with ids and caps. Read for TWO reasons: it
// is how the authored NARRATIVES list below is validated against reality (a
// slug that has drifted resolves to nothing and says so, instead of silently
// contributing an empty cohort forever), and it supplies the cap used to rank
// them. The per-cohort RETURNS do not come from here — see cohortRead.
const CATEGORIES_URL = "https://api.coingecko.com/api/v3/coins/categories";
const categoryMarketsUrl = (id) =>
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false" +
  `&price_change_percentage=7d%2C30d&category=${encodeURIComponent(id)}`;

const FETCH_TIMEOUT_MS = 8000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const SNAPSHOT_KEEP_DAYS = 100; // baselines need 12h; 100d gives the record depth
const DOM_KEEP_DAYS = 90;
const DOM_CAP = 2000;
const BOARD_SIZE = 60;
const SPARK_POINTS = 28;
const BASELINE_TOLERANCE_MS = 45 * 60 * 1000; // a snapshot within ±45min "is" the window
// The season score's own history, kept exactly like domHistory (one sample per
// UTC day, last write wins) and for exactly the same reason: CoinGecko has no
// endpoint for "what was the regime a month ago", so if this pass does not
// write the number down, the question is unanswerable forever.
const SCORE_KEEP_DAYS = 90;
const SCORE_CAP = 400;
// How many authored narratives get their own /coins/markets call. Each is one
// keyless request; the pass already makes three, and a background invocation
// has fifteen minutes. Twelve is the point past which the tiles stop fitting a
// phone and start being another list to scan.
const COHORT_MAX = 12;
const COHORT_FETCH_SPACING_MS = 1200; // serialized — see fetchCohorts

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/* ═══ small numeric + formatting helpers ═════════════════════════════════════
 * fin(): number-or-null. Upstream sends numbers, numeric strings and nulls in
 * the same field depending on the coin — and Number('') is 0, which would turn
 * a blank dominance field into a measured 0% and write it into a series that
 * can never be rebuilt. A blank field is an ABSENT measurement, and absent is
 * null. */
function fin(v) {
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return Number.isFinite(v) ? v : null;
}

function str(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(x) {
  return Number.isFinite(x) ? x : null;
}

// One decimal, or null. Percentages that reach the client are rounded HERE and
// not at render time, so the number the ladder was judged by and the number on
// screen are the same number — the same rule the board already follows.
function r1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function pct(x, d = 1) {
  if (!Number.isFinite(x)) return "—";
  return `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
}

// Percentage POINTS — a difference of two percentages is not a percentage.
function pts(x, d = 1) {
  if (!Number.isFinite(x)) return "—";
  return `${x >= 0 ? "+" : ""}${x.toFixed(d)} pts`;
}

function signed(x, d = 1) {
  if (!Number.isFinite(x)) return "—";
  return `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
}

function usd(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1e12) return `$${(x / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(x / 1e3)}k`;
  return `$${Math.round(x)}`;
}

// Sub-dollar prices get significant digits, not two decimals — "$0.00" is not
// a price, and users read levels off exactly these strings.
function px(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1000) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`;
  if (a === 0) return "$0";
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}

function parseTs(v) {
  const t = typeof v === "number" ? v : Date.parse(v || "");
  return Number.isFinite(t) ? t : null;
}

/* ═══ step 2 — normalize a CoinGecko /coins/markets row ══════════════════════
 * One bad row never kills the board: a row that cannot be priced or capped
 * cannot be ranked, scored or targeted, so it is dropped rather than carried
 * as a null-riddled passenger. */
function parseMarketsRow(r) {
  if (!r || typeof r !== "object") return null;
  const price = fin(r.current_price);
  const mcap = fin(r.market_cap);
  if (price == null || mcap == null) return null;
  return {
    id: str(r.id),
    symbol: str(r.symbol).toUpperCase(),
    name: str(r.name),
    rank: fin(r.market_cap_rank),
    price,
    mcap,
    vol24h: fin(r.total_volume),
    chg1h: fin(r.price_change_percentage_1h_in_currency),
    // The `_in_currency` fields only exist because the URL asks for them; the
    // bare 24h field is always present, so it backstops the headline number.
    chg24h: fin(r.price_change_percentage_24h_in_currency) ?? fin(r.price_change_percentage_24h),
    chg7d: fin(r.price_change_percentage_7d_in_currency),
    chg30d: fin(r.price_change_percentage_30d_in_currency),
    sparkline7d: parseSparkline(r.sparkline_in_7d && r.sparkline_in_7d.price),
    ath: fin(r.ath),
    athChangePct: fin(r.ath_change_percentage),
    athDate: typeof r.ath_date === "string" ? r.ath_date : null,
  };
}

// ~168 hourly closes. A series with a hole is dropped WHOLE, not compacted:
// structure7d reads it positionally ("did the last day break the prior six
// days' high"), and silently removing a null shifts every bar left an hour.
// No sparkline is an honest null; a re-spaced one is a wrong chart.
function parseSparkline(prices) {
  if (!Array.isArray(prices) || prices.length < 2) return null;
  return prices.every((p) => Number.isFinite(p)) ? prices.slice() : null;
}

/* ═══ step 3 — the screener (ported from pentagon screen.js) ═════════════════
 *
 * Ranks rows by how likely each is at the START of a move, not by how much it
 * already moved — a board sorted by 30d return is a list of things you missed.
 * The two biggest score blocks are ACCELERATION (24h vs the week's own pace)
 * and 7-DAY STRUCTURE (position in range + fresh break). Raw 30d return only
 * ever appears as a denominator or a penalty trigger.
 *
 * The 100 points, in full — parts[] always sums to score, every ladder is
 * "first threshold met wins":
 *   RS vs BTC     0–25   rs7d (max 15) + rs30d (max 10)
 *   Acceleration  0–30   24h vs week pace (max 18) + week vs month (max 12)
 *   Turnover      0–15   vol24h ÷ mcap
 *   7d structure  0–20   position in range (max 10) + fresh break (max 10)
 *   ATH room      0–10   drawdown from the all-time high
 *   Penalties     to −40 parabolic −25 (24h > +40% or 7d > +100%),
 *                        thin −15 (vol24h < $250k) — each clamped to the
 *                        points actually earned, so parts[] keeps summing to
 *                        score and the floor is a true 0.
 * Missing input scores zero, not a neutral half: the board ranks evidence.
 */

// The exclusion sets are load-bearing, not hygiene. Left in, USDT posts an
// off-the-chart turnover on a ±0.1% month, and stETH reads as a flawless mover
// while being a receipt for ETH. Symbols first — the symbol is the only field
// guaranteed present.
const STABLECOIN_SYMBOLS = new Set([
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "USDD", "FDUSD", "PYUSD", "USDE", "SUSDE",
  "USDS", "SUSDS", "FRAX", "SFRAX", "LUSD", "USDP", "GUSD", "USDY", "USD0", "USD0++",
  "CRVUSD", "GHO", "MIM", "DOLA", "USDX", "USDB", "RLUSD", "EURC", "EURS", "EURT",
  "AEUR", "XSGD", "BSC-USD", "USDT0", "BUIDL", "USTC",
  // Metal-pegged tokens for the same reason: their "return" is the peg's.
  "PAXG", "XAUT",
]);

const WRAPPER_SYMBOLS = new Set([
  "WBTC", "WETH", "STETH", "WSTETH", "WBETH", "WEETH", "EETH", "RETH", "CBBTC", "CBETH",
  "SETH", "SETH2", "OSETH", "EZETH", "RSETH", "PUFETH", "SWETH", "METH", "ANKRETH",
  "SFRXETH", "FRXETH", "RSWETH", "LSETH", "ETHX", "OETH", "WOETH",
  "BTCB", "TBTC", "RENBTC", "HBTC", "SOLVBTC", "LBTC", "BBTC", "FBTC", "CLBTC", "ENZOBTC",
  "WBNB", "WSOL", "WAVAX", "WMATIC", "WPOL", "WHYPE", "WS", "WCRO", "WFTM", "WKAVA",
  "MSOL", "JITOSOL", "BNSOL", "JUPSOL", "STSOL", "BSOL", "INF", "HSOL", "EDGESOL",
  "STHYPE", "WSTHYPE", "STETH.E", "RSTETH",
]);

// Authored override for the flatness heuristic below — real assets that must
// never be mistaken for a stablecoin during a quiet month. BTC in a flat month
// is an ordinary market state; silently deleting Bitcoin from the market is a
// far worse failure than leaving one unknown stablecoin on the board.
const UTILITY_SYMBOLS = new Set([
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOT", "TRX", "LINK", "MATIC", "POL",
  "TON", "ICP", "NEAR", "APT", "SUI", "SEI", "TIA", "ARB", "OP", "ATOM", "FIL", "HBAR",
  "ALGO", "XLM", "ETC", "LTC", "BCH", "XMR", "ZEC", "DASH", "EOS", "XTZ", "FLOW", "EGLD",
  "UNI", "AAVE", "MKR", "SKY", "CRV", "LDO", "SNX", "COMP", "SUSHI", "BAL", "YFI", "ENA",
  "PENDLE", "GMX", "DYDX", "JUP", "RAY", "JTO", "CAKE", "1INCH", "RUNE", "INJ", "KAVA",
  "GRT", "RENDER", "RNDR", "FET", "AGIX", "OCEAN", "TAO", "AR", "STX", "IMX", "AXS",
  "SAND", "MANA", "GALA", "ENJ", "CHZ", "APE", "BLUR", "ENS", "LPT", "STRK", "ZK", "W",
  "HYPE", "S", "FTM", "KAS", "ROSE", "MINA", "CFX", "ONE", "QNT", "VET", "THETA", "IOTA",
]);

const STABLE_NAME_RE = /\b(usd|dollar|stable|euro|tether)\b/i;
const WRAPPER_NAME_RE = /\b(wrapped|staked|restaked|restaking|bridged|peg|pegged|liquid staking)\b/i;
const WRAPPER_ID_RE = /^(wrapped|staked|bridged|binance-peg)[-]/i;

// Is this row a dollar (or a gram of gold) wearing a ticker? Static set first,
// then a flatness heuristic for stablecoins that launched after the list was
// written. The heuristic is deliberately tight: flat across ALL THREE windows
// at once (day, week AND month inside the noise), because "|30d| < 2% on a
// $1B+ cap" alone fires on BTC in a quiet month — hence the authored override.
function isStablecoin(row) {
  const sym = String((row && row.symbol) ?? "").toUpperCase();
  if (STABLECOIN_SYMBOLS.has(sym)) return true;
  if (UTILITY_SYMBOLS.has(sym)) return false; // authored override — see above
  const { mcap, chg24h, chg7d, chg30d, price, name } = row || {};
  const flat =
    Number.isFinite(chg24h) && Math.abs(chg24h) < 0.5 &&
    Number.isFinite(chg7d) && Math.abs(chg7d) < 1 &&
    Number.isFinite(chg30d) && Math.abs(chg30d) < 2;
  if (flat && Number.isFinite(mcap) && mcap > 1e9) return true;
  if (
    flat &&
    Number.isFinite(price) && price > 0.99 && price < 1.01 &&
    Number.isFinite(mcap) && mcap > 2e8 &&
    STABLE_NAME_RE.test(String(name ?? ""))
  ) return true;
  return false;
}

// Is this row a receipt for another coin? Static set, then the NAME — these
// things are named descriptively ("Lido Staked Ether"). Deriving it from the
// symbol shape instead would eat WIF, WLD and WEN.
function isWrapper(row) {
  const sym = String((row && row.symbol) ?? "").toUpperCase();
  if (WRAPPER_SYMBOLS.has(sym)) return true;
  if (WRAPPER_NAME_RE.test(String((row && row.name) ?? ""))) return true;
  if (WRAPPER_ID_RE.test(String((row && row.id) ?? ""))) return true;
  return false;
}

// Rows the board must never rank. Breadth in seasonRead counts over the same
// population via this same function, so the two can never drift apart.
function isExcluded(row) {
  return isStablecoin(row) || isWrapper(row);
}

function tierOf(mcap) {
  if (!Number.isFinite(mcap)) return "unknown";
  if (mcap >= 1e10) return "major";
  if (mcap >= 1e9) return "mid";
  if (mcap >= 1e8) return "small";
  return "micro";
}

// Score ladders — first threshold met wins.
const RS7 = [[25, 15], [12, 12], [5, 9], [0, 6], [-10, 3]];
const RS30 = [[40, 10], [15, 8], [0, 5], [-20, 2]];
const A24 = [[8, 18], [4, 14], [2, 10], [0.5, 6], [-1, 3]];
const A7V30 = [[1.5, 12], [0.7, 9], [0.2, 6], [0, 3]];
const TURN = [[0.5, 15], [0.25, 13], [0.12, 11], [0.06, 8], [0.02, 4], [0.005, 1]];
const POS = [[0.9, 10], [0.7, 8], [0.5, 5], [0.3, 2]];
const ROOM = [[80, 10], [50, 8], [25, 5], [10, 3]];

const PARABOLIC_24H = 40;
const PARABOLIC_7D = 100;
const THIN_VOL_USD = 250_000;

function step(value, table) {
  if (!Number.isFinite(value)) return 0;
  for (const [min, points] of table) if (value >= min) return points;
  return 0;
}

/**
 * 7-day structure out of the sparkline. Nominally 168 hourly closes, but
 * CoinGecko truncates for young coins, so "one day" is len/7, not 24.
 *
 * Two pairs of numbers, two jobs, NOT interchangeable:
 *   low/high          the 7d RANGE, today INCLUDED — the only correct
 *                     denominator for pos ("how far up its own week is price").
 *   priorLow/priorHigh the 7d LEVELS, today EXCLUDED — what price has to clear
 *                     or lose to have DONE something. Both ends come from the
 *                     same `prior` slice: a level drawn from a window that
 *                     contains the price it is compared against equals that
 *                     price on every row making its own 7-day low, and
 *                     "invalidation hit" becomes the series testing itself.
 *                     A level that moves with price is not a level.
 */
function structure7d(sparkline) {
  const s = Array.isArray(sparkline) ? sparkline.filter(Number.isFinite) : [];
  const out = { low: null, high: null, last: null, pos: null, freshBreak: false, priorHigh: null, priorLow: null, points: s.length };
  if (s.length < 8) return out;
  const low = Math.min(...s);
  const high = Math.max(...s);
  const last = s[s.length - 1];
  out.low = low;
  out.high = high;
  out.last = last;
  // A dead-flat series is a real input (a pegged row); dividing by the zero
  // range would put NaN into the score, and NaN sorts nowhere.
  out.pos = high > low ? (last - low) / (high - low) : null;

  const day = Math.max(2, Math.round(s.length / 7));
  if (s.length >= day * 2) {
    const prior = s.slice(0, s.length - day);
    const lastDay = s.slice(s.length - day);
    const priorHigh = Math.max(...prior);
    out.priorHigh = priorHigh;
    out.priorLow = Math.min(...prior);
    out.freshBreak = Math.max(...lastDay) > priorHigh;
  }
  return out;
}

function athAgeDays(athDate, now) {
  if (!Number.isFinite(now) || !athDate) return null;
  const t = Date.parse(athDate);
  if (!Number.isFinite(t)) return null;
  const days = Math.round((now - t) / DAY);
  return days >= 0 ? days : null;
}

/**
 * Score one market row. `season` contributes a FACT and never a point —
 * folding the regime into the score would make the same chart rank differently
 * in different markets, and the regime already gates things downstream.
 * Excluded rows get score null and never reach the board.
 */
function screenCoin(row, ctx = {}) {
  const { btcRow = null, season = null, now = null } = ctx;
  const base = { ...(row || {}) };
  const sym = String((row && row.symbol) ?? "").toUpperCase();

  const stablecoin = isStablecoin(row);
  const wrapper = isWrapper(row);
  const tier = tierOf(row && row.mcap);

  const turnover = row && Number.isFinite(row.vol24h) && Number.isFinite(row.mcap) && row.mcap > 0
    ? row.vol24h / row.mcap
    : null;

  if (stablecoin || wrapper) {
    const why = stablecoin ? "a stablecoin" : "a wrapped/staked derivative of another asset";
    return {
      ...base,
      score: null, band: "cold", tier,
      parts: [],
      facts: [`${sym || "this row"} is ${why} — excluded from the board, not ranked`],
      flags: { stablecoin, wrapper, parabolic: false, thinLiquidity: false, freshBreak: false, newListing: false },
      turnover, rsVsBtc7d: null, rsVsBtc30d: null,
      accel: { d24VsWeek: null, weekVsMonth: null, daily7d: null, daily30d: null },
      drawdownFromAthPct: null,
      range7d: { low: null, high: null, last: null, pos: null, freshBreak: false, priorHigh: null, priorLow: null, points: 0 },
    };
  }

  const chg24h = num(row && row.chg24h);
  const chg7d = num(row && row.chg7d);
  const chg30d = num(row && row.chg30d);
  const btc7d = num(btcRow && btcRow.chg7d);
  const btc30d = num(btcRow && btcRow.chg30d);

  const rsVsBtc7d = chg7d != null && btc7d != null ? chg7d - btc7d : null;
  const rsVsBtc30d = chg30d != null && btc30d != null ? chg30d - btc30d : null;

  // Differences, never ratios — a ratio against a 7d return near zero (exactly
  // the coin we hunt) divides by ~0 and sorts an infinity to the top.
  const daily7d = chg7d != null ? chg7d / 7 : null;
  const daily30d = chg30d != null ? chg30d / 30 : null;
  const d24VsWeek = chg24h != null && daily7d != null ? chg24h - daily7d : null;
  const weekVsMonth = daily7d != null && daily30d != null ? daily7d - daily30d : null;
  const accel = { d24VsWeek, weekVsMonth, daily7d, daily30d };

  const range7d = structure7d(row && row.sparkline7d);

  // ath_change_percentage arrives negative (−85 = 85% below the high); the
  // board shows a magnitude, flipped once here at the boundary.
  let drawdownFromAthPct = null;
  if (row && Number.isFinite(row.athChangePct)) drawdownFromAthPct = Math.max(0, -row.athChangePct);
  else if (row && Number.isFinite(row.ath) && Number.isFinite(row.price) && row.ath > 0) {
    drawdownFromAthPct = Math.max(0, (1 - row.price / row.ath) * 100);
  }

  const parts = [];
  const facts = [];

  // MEASURED IS NOT THE SAME AS ZERO. step() returns 0 both for "this coin is
  // genuinely bottom of the table" and for "BTC did not come back on this
  // pass" — identical on the wire, opposite in meaning, and visible the moment
  // anything draws a per-part bar. Same stamp as the equity engine, because
  // the sheets that read it are twins.
  const gauged = (v) => Number.isFinite(v);

  // ── relative strength vs BTC (0–25) ──
  parts.push({
    key: "rs7", max: 15, points: step(rsVsBtc7d, RS7), measured: gauged(rsVsBtc7d),
    label: rsVsBtc7d == null ? "no 7d RS (BTC or coin 7d missing)" : `7d RS vs BTC ${pts(rsVsBtc7d)}`,
  });
  parts.push({
    key: "rs30", max: 10, points: step(rsVsBtc30d, RS30), measured: gauged(rsVsBtc30d),
    label: rsVsBtc30d == null ? "no 30d RS (BTC or coin 30d missing)" : `30d RS vs BTC ${pts(rsVsBtc30d)}`,
  });
  if (rsVsBtc7d != null) facts.push(`7d ${pct(chg7d)} vs BTC ${pct(btc7d)} — ${pts(rsVsBtc7d)} of relative strength`);
  if (rsVsBtc30d != null) facts.push(`30d ${pct(chg30d)} vs BTC ${pct(btc30d)} — ${pts(rsVsBtc30d)}`);

  // ── acceleration (0–30) — the "starting, not started" block ──
  parts.push({
    key: "accel24", max: 18, points: step(d24VsWeek, A24), measured: gauged(d24VsWeek),
    label: d24VsWeek == null ? "no 24h acceleration (24h or 7d missing)" : `24h vs the week's pace ${pts(d24VsWeek)}`,
  });
  parts.push({
    key: "accel7v30", max: 12, points: step(weekVsMonth, A7V30), measured: gauged(weekVsMonth),
    label: weekVsMonth == null ? "no week/month acceleration (7d or 30d missing)" : `week vs month pace ${pts(weekVsMonth)}/day`,
  });
  if (d24VsWeek != null) {
    facts.push(`24h ${pct(chg24h)} against a 7-day pace of ${pct(daily7d, 2)}/day — ${pts(d24VsWeek)} of one-day excess`);
  }
  if (weekVsMonth != null) {
    facts.push(`the week is running ${pct(daily7d, 2)}/day vs the month's ${pct(daily30d, 2)}/day`);
  }

  // ── turnover (0–15) ──
  parts.push({
    key: "turnover", max: 15, points: step(turnover, TURN), measured: gauged(turnover),
    label: turnover == null ? "no turnover (volume or market cap missing)" : `turnover ${(turnover * 100).toFixed(1)}% of cap`,
  });
  if (turnover != null) {
    facts.push(`${usd(row.vol24h)} traded on a ${usd(row.mcap)} cap — ${(turnover * 100).toFixed(1)}% of the float in a day`);
  }

  // ── 7-day structure (0–20) ──
  parts.push({
    key: "range", max: 10, points: step(range7d.pos, POS), measured: gauged(range7d.pos),
    label: range7d.pos == null ? "no 7d range (sparkline missing or flat)" : `${Math.round(range7d.pos * 100)}% up its own 7d range`,
  });
  parts.push({
    key: "break", max: 10, points: range7d.freshBreak ? 10 : 0, measured: range7d.priorHigh != null,
    label: range7d.priorHigh == null ? "no break read (sparkline too short)"
      : range7d.freshBreak ? "last 24h broke the prior 6d high" : "no break of the prior 6d high",
  });
  if (range7d.pos != null) {
    facts.push(`price sits ${Math.round(range7d.pos * 100)}% up its 7-day range (${px(range7d.low)}–${px(range7d.high)})`);
  }
  if (range7d.freshBreak) facts.push(`the last 24h took out the prior 6-day high ${px(range7d.priorHigh)}`);

  // ── room from ATH (0–10) — a coin AT its high scores 0 here, not as a
  // verdict but because it has no overhead supply to sell into you; it earns
  // its points in structure and RS instead. ──
  parts.push({
    key: "room", max: 10, points: step(drawdownFromAthPct, ROOM), measured: gauged(drawdownFromAthPct),
    label: drawdownFromAthPct == null ? "no ATH reference" : `${Math.round(drawdownFromAthPct)}% below the all-time high`,
  });
  if (drawdownFromAthPct != null) {
    const age = athAgeDays(row && row.athDate, now);
    facts.push(`${Math.round(drawdownFromAthPct)}% below the all-time high ${px(row && row.ath)}${age == null ? "" : ` set ${age} days ago`}`);
  }

  // ── penalties — clamped to points earned, so a −25 against a 12-point coin
  // lands as −12, the floor is a true 0, and parts[] keeps summing to score.
  // A coin up 47% today posts the SAME accel/turnover readings as a clean
  // ignition; −25 is what separates "starting" from "already went". ──
  const parabolic = (chg24h != null && chg24h > PARABOLIC_24H) || (chg7d != null && chg7d > PARABOLIC_7D);
  const thinLiquidity = row != null && Number.isFinite(row.vol24h) && row.vol24h < THIN_VOL_USD;

  let budget = parts.reduce((s, p) => s + p.points, 0);

  if (parabolic) {
    const applied = -Math.min(budget, 25);
    budget += applied;
    parts.push({ key: "parabolic", max: 0, points: applied, measured: true, label: "parabolic — already gone" });
    facts.push(chg24h != null && chg24h > PARABOLIC_24H
      ? `PARABOLIC: ${pct(chg24h)} in 24h — this is a chase, not an entry`
      : `PARABOLIC: ${pct(chg7d)} in 7d — this is a chase, not an entry`);
  }
  if (thinLiquidity) {
    const applied = -Math.min(budget, 15);
    budget += applied;
    parts.push({ key: "thin", max: 0, points: applied, measured: true, label: "too thin to trade" });
    facts.push(`only ${usd(row.vol24h)} of 24h volume — you can get in but not out`);
  }

  const score = parts.reduce((s, p) => s + p.points, 0);

  // CoinGecko emits null for windows predating the listing, so a missing 30d
  // return is the only honest "no history" tell a markets row carries.
  const newListing = chg30d == null && chg7d != null;

  const flags = { stablecoin: false, wrapper: false, parabolic, thinLiquidity, freshBreak: range7d.freshBreak, newListing };
  if (newListing) facts.push("no 30-day history — listed recently, treat every longer-window read as absent");

  const band = bandOf({ chg7d, chg30d, rsVsBtc7d, d24VsWeek, turnover, pos: range7d.pos, flags });
  if ((band === "starting" || band === "warming") && season && (season.phase === "risk_off" || season.phase === "btc_only")) {
    facts.push(`this is lifting into a ${season.label} regime (${season.score}/100) — the setup is real, the tape is not helping it`);
  }

  return {
    ...base,
    score, band,
    tier, parts, facts, flags,
    turnover, rsVsBtc7d, rsVsBtc30d, accel, drawdownFromAthPct, range7d,
  };
}

/**
 * The band is a STATE, not a score bucket — first match wins, in the order a
 * move actually happens, so it reads without the number. `chg7d <= 40` is the
 * ceiling on ignition: a coin already up 60% this week breaking to new highs
 * is running, not lighting.
 */
function bandOf({ chg7d, chg30d, rsVsBtc7d, d24VsWeek, turnover, pos, flags }) {
  if (flags.parabolic || (chg30d != null && chg30d > 150 && pos != null && pos >= 0.75)) return "late";
  if (flags.freshBreak && d24VsWeek != null && d24VsWeek >= 2 && rsVsBtc7d != null && rsVsBtc7d > 0 &&
      chg7d != null && chg7d <= 40) return "starting";
  if (chg7d != null && chg7d >= 15 && rsVsBtc7d != null && rsVsBtc7d > 0 && pos != null && pos >= 0.5) return "underway";
  if (d24VsWeek != null && d24VsWeek >= 0.5 && rsVsBtc7d != null && rsVsBtc7d >= 0 && (pos == null || pos >= 0.4)) return "warming";
  if (chg7d != null && Math.abs(chg7d) <= 12 && turnover != null && turnover >= 0.005 && !flags.thinLiquidity) return "quiet";
  return "cold";
}

/**
 * Screen the whole universe. Excluded rows (score null) are DROPPED, not
 * sorted to the bottom. Ties break on turnover, then market cap, then symbol —
 * without a total order the board reshuffles between renders of identical
 * data, which reads as live movement and kills trust in the screen.
 */
function screenUniverse(universe, ctx = {}) {
  if (!Array.isArray(universe)) return [];
  const out = [];
  for (const row of universe) {
    if (!row || typeof row !== "object") continue;
    const s = screenCoin(row, ctx);
    if (s.score == null) continue;
    out.push(s);
  }
  out.sort((a, b) =>
    b.score - a.score ||
    (b.turnover ?? -1) - (a.turnover ?? -1) ||
    (b.mcap ?? -1) - (a.mcap ?? -1) ||
    String(a.symbol).localeCompare(String(b.symbol)));
  return out;
}

/* ═══ step 3b — the capital ladder ══════════════════════════════════════════
 *
 * WHERE ON THE RISK CURVE THE MONEY CURRENTLY IS, as six rungs. The board
 * answers "which coin"; the season score answers "is this a market to be in";
 * neither answers the question that actually precedes both — has capital
 * reached the part of the market I am shopping in yet.
 *
 * Alt season is not an event, it is capital walking DOWN the risk curve in a
 * fixed order: Bitcoin, then Ethereum, then large caps, then mid, then small,
 * then micro. That order is mechanical rather than predictive, which is what
 * makes this the one surface on the tab that can see ahead: when the lit rung
 * is 'major', the next rung to light is 'mid', and that is a week or two of
 * warning no per-coin screener can produce, because it is a fact about the
 * market's structure and not about any chart.
 *
 * THE MEDIAN, NOT THE MEAN, and it is the whole reason this is trustworthy.
 * One micro-cap up 400% drags a bucket mean into positive territory on its own
 * and lights a rung that nothing is actually bidding — which is precisely the
 * lie the Movers card tells six times over. A median needs half the bucket to
 * move before it moves.
 *
 * BTC and ETH get their own rungs rather than sitting inside 'major', because
 * the entire question is whether flow has left them yet. Folding them into the
 * large-cap bucket would hide the transition this exists to show.
 */

// Ordered top-of-curve first — the order flow travels, and the order the rungs
// are drawn in. `tier` is the tierOf() bucket a rung collects, or null for the
// two that are a single named coin.
const LADDER_RUNGS = [
  { key: "btc", label: "Bitcoin", tier: null, symbol: "BTC" },
  { key: "eth", label: "Ethereum", tier: null, symbol: "ETH" },
  { key: "major", label: "Large", tier: "major", symbol: null },
  { key: "mid", label: "Mid", tier: "mid", symbol: null },
  { key: "small", label: "Small", tier: "small", symbol: null },
  { key: "micro", label: "Micro", tier: "micro", symbol: null },
];
// A bucket thinner than this has no median worth publishing. The top 250 gives
// 'micro' only a handful of rows, and a "median" over two coins is those two
// coins wearing a statistic's clothes.
const LADDER_MIN_ROWS = 4;

function median(xs) {
  const a = (Array.isArray(xs) ? xs : []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * @param universe normalized rows (the whole fetched set, not the board)
 * @returns { rungs: [{key,label,chg30d,chg7d,n}], leadKey, leadLabel, nextLabel, read }
 *          — rungs always has all six entries, in curve order, with null
 *          returns where the bucket was too thin to measure.
 */
function capitalLadder(universe) {
  const rows = Array.isArray(universe) ? universe.filter(Boolean) : [];
  const bucket = new Map(LADDER_RUNGS.map((r) => [r.key, { d30: [], d7: [] }]));

  for (const r of rows) {
    const sym = String(r.symbol ?? "").toUpperCase();
    let key = null;
    if (sym === "BTC") key = "btc";
    else if (sym === "ETH") key = "eth";
    // Exclusions apply to the BUCKETS only. A wrapped BTC in the 'major'
    // bucket is Bitcoin's return counted a second time, one rung too low —
    // which is exactly the direction that would fake a rotation.
    else if (!isExcluded(r)) key = tierOf(r.mcap);
    if (!key || !bucket.has(key)) continue;
    const b = bucket.get(key);
    if (Number.isFinite(r.chg30d)) b.d30.push(r.chg30d);
    if (Number.isFinite(r.chg7d)) b.d7.push(r.chg7d);
  }

  const rungs = LADDER_RUNGS.map((r) => {
    const b = bucket.get(r.key);
    // BTC and ETH are one row each, so the thinness floor cannot apply to
    // them — their "median" is that row's return, which is the true number.
    const floor = r.symbol ? 1 : LADDER_MIN_ROWS;
    const n = b.d30.length;
    return {
      key: r.key, label: r.label, n,
      chg30d: n >= floor ? r1(median(b.d30)) : null,
      chg7d: b.d7.length >= floor ? r1(median(b.d7)) : null,
    };
  });

  // The lit rung is the strongest MEASURED one over 30 days. Ties break toward
  // the top of the curve: with two rungs equal, the conservative read is that
  // flow has only reached the higher one.
  let lead = null;
  for (const r of rungs) {
    if (r.chg30d == null) continue;
    if (!lead || r.chg30d > lead.chg30d) lead = r;
  }

  const out = { rungs, leadKey: lead ? lead.key : null, leadLabel: lead ? lead.label : null, nextLabel: null, read: null };
  if (!lead) {
    out.read = "Not enough measured returns to place the flow on the curve.";
    return out;
  }

  const idx = rungs.findIndex((r) => r.key === lead.key);
  const next = rungs.slice(idx + 1).find((r) => r.chg30d != null) || null;
  out.nextLabel = next ? next.label : null;

  // NOTHING LEADING IS NOT THE SAME AS SOMETHING LEADING WEAKLY. When even the
  // best rung is negative over 30 days there is no rotation to describe — risk
  // is being sold across the whole curve, and saying "flow has reached X"
  // about a rung that is down 3% would be the tab's single most misleading
  // sentence.
  if (lead.chg30d <= 0) {
    out.read = `Nothing is bid — even ${lead.label.toLowerCase()} is negative over 30 days. Risk is being sold, not rotated.`;
    return out;
  }
  if (lead.key === "btc") {
    out.read = "Flow stops at Bitcoin. Alts are funding it, not following it.";
  } else if (!next) {
    out.read = `Flow has reached ${lead.label.toLowerCase()} — the far end of the curve. This is late, not early.`;
  } else {
    out.read = `Flow has reached ${lead.label.toLowerCase()}. ${next.label} is next on the curve.`;
  }
  return out;
}

/* ═══ step 4 — the season read (ported from pentagon season.js, adapted) ═════
 *
 * Is capital moving into alts at all? Breadth carries 60 of the 100 points
 * because it is the only rotation measure computable from data we actually
 * have: 100 rows with 7d/30d returns and BTC sitting among them, counted with
 * no estimation step anywhere. Dominance HISTORY is not on CoinGecko's free
 * tier at all — we accumulate our own, one sample a day, from this cron.
 *
 *   BREADTH 7d ..... 0–35   round(0.35 × % of eligible top-100 beating BTC)
 *   BREADTH 30d .... 0–25   round(0.25 × same over 30d)
 *   DOMINANCE ...... 0–20   falling 20 · flat 10 · rising 0 — from domHistory
 *                           ALONE, and only when ≥7 samples land inside the
 *                           last 30 days; else unmeasured
 *   ETH/BTC 7d ..... 0–5    5 when ETH gained on BTC over the window
 *   ETH/BTC 30d .... 0–5    same, a SEPARATE part — fixed maxes must sum to
 *                           exactly 100 or "N points dropped" stops adding up
 *   FEAR & GREED ... 0–10   round(value ÷ 10), clamped — monotone, not
 *                           contrarian: this measures whether risk appetite is
 *                           present, not whether it is well-founded
 *
 * AN UNMEASURED PART IS DROPPED FROM BOTH SIDES and the score renormalised to
 * /100: score = round(100 × earned ÷ of). A midpoint for a missing input is a
 * claim nobody measured; a zero is a verdict in the other direction. And under
 * half the points measured there is no score at all — a renormalised number
 * off 40 of 100 points is more extrapolation than measurement, and the number
 * is the thing a reader sizes off.
 *
 * Phase is a pure function of the score, so label and number can never
 * disagree:  ≥70 alt_season · 55–69 majors_rotating · 40–54 mixed ·
 * 25–39 btc_only · <25 risk_off.
 */

const MIN_DOM_SAMPLES = 7;   // below this the trend is 'unknown', and we mean it
const DOM_FLAT_PTS = 0.5;    // dominance moves ±0.5pp on noise
const DOM_WINDOW_DAYS = 30;
const SEASON_MAX_POINTS = 100;
const SEASON_MIN_POINTS = SEASON_MAX_POINTS / 2;

const SEASON_LADDER = [
  { min: 70, phase: "alt_season", label: "Alts are running" },
  { min: 55, phase: "majors_rotating", label: "Majors first" },
  { min: 40, phase: "mixed", label: "Mixed tape" },
  { min: 25, phase: "btc_only", label: "Bitcoin only" },
  { min: -Infinity, phase: "risk_off", label: "Risk off" },
];

const SEASON_PART_NAMES = {
  breadth7: "7d breadth", breadth30: "30d breadth",
  dominance: "the dominance trend", ethbtc7: "ETH/BTC over 7d",
  ethbtc30: "ETH/BTC over 30d", feargreed: "fear & greed",
};

/**
 * @param universe    normalized rows (top 250; breadth counts the top 100)
 * @param btcRow      the BTC row — the bar every return is measured against
 * @param ethRow      the ETH row (optional)
 * @param fearGreed   { value, label } (optional)
 * @param domHistory  [{ t (ms epoch), dom }] — our own accumulated series,
 *                    the ONLY source of the dominance trend
 * @param now         ms epoch (optional)
 */
function seasonRead({ universe = null, btcRow = null, ethRow = null, fearGreed = null, domHistory = null, now = null } = {}) {
  const facts = [];
  const breadth = computeBreadth(universe, btcRow, facts);
  const dom = domTrendOf(domHistory, facts);
  // THE SPAN THE OVERRIDE READS, which the 30-day trend cannot supply. The
  // regime override in src/lib/altLadder.js asks for dominance "falling for
  // 60+ days" (OVERRIDE_DOM_DAYS), and this used to publish dom.spanDays —
  // first and last sample of a 30-day window, so at most 30, so the leg could
  // not arm on any feed this engine will ever produce and the book's footer
  // promised a switch that was arithmetically welded open. The direction is
  // still the month's; the span is how far back that direction holds. When
  // the full kept history (DOM_KEEP_DAYS, 90) reads the same way, it is the
  // history's span; when the history disagrees, the fall is younger than the
  // history and the month's span is the honest answer. The fact sentence is
  // untouched — it describes the month it measured.
  const domLong = domTrendOf(domHistory, [], DOM_KEEP_DAYS);
  const domSpanDays = dom.trend != null && domLong.trend === dom.trend
    ? domLong.spanDays ?? dom.spanDays ?? null
    : dom.spanDays ?? null;
  const ethBtc = computeEthBtc(ethRow, btcRow, facts);
  const fg = normFearGreed(fearGreed, facts);

  const empty = (label) => ({
    score: null, phase: null, label,
    parts: [], facts,
    breadth7d: breadth.beatBtc7dPct, breadth30d: breadth.beatBtc30dPct,
    fearGreed: fg ? fg.value : null,
    ethBtc7d: ethBtc ? ethBtc.chg7dPct : null,
    domTrend: dom.trend,
    // The SPAN, not just the direction — see domSpanDays above. Seven samples
    // inside six days is a real "falling" and is not what the override is
    // asking about.
    domSpanDays,
    measured: { earned: 0, of: 0 },
  });

  // No breadth means no read: everything else here is a tilt around breadth —
  // on their own they describe the weather, not the rotation.
  if (breadth.beatBtc7dPct == null && breadth.beatBtc30dPct == null) return empty("No read");

  const part = (key, max, points, label) => ({ key, label, points, max, measured: points != null });
  const parts = [];

  parts.push(part("breadth7", 35,
    breadth.beatBtc7dPct == null ? null : Math.round(0.35 * breadth.beatBtc7dPct),
    breadth.beatBtc7dPct == null ? "no 7d breadth — not scored" : `${Math.round(breadth.beatBtc7dPct)}% of the top 100 beat BTC over 7d`));

  parts.push(part("breadth30", 25,
    breadth.beatBtc30dPct == null ? null : Math.round(0.25 * breadth.beatBtc30dPct),
    breadth.beatBtc30dPct == null ? "no 30d breadth — not scored" : `${Math.round(breadth.beatBtc30dPct)}% beat BTC over 30d`));

  parts.push(part("dominance", 20,
    dom.trend == null ? null : dom.trend === "falling" ? 20 : dom.trend === "rising" ? 0 : 10,
    dom.trend == null
      ? `dominance trend unknown (${dom.samples} of ${MIN_DOM_SAMPLES} recent samples needed) — not scored`
      : `BTC dominance ${dom.trend}${dom.changePts == null ? "" : ` (${signed(dom.changePts, 2)} pts across ${dom.samples} samples)`}`));

  const ethLeg = (key, window, chg) => part(key, 5,
    Number.isFinite(chg) ? (chg > 0 ? 5 : 0) : null,
    Number.isFinite(chg) ? `ETH/BTC ${window} ${signed(chg)}%` : `ETH/BTC over ${window} unavailable — not scored`);
  parts.push(ethLeg("ethbtc7", "7d", ethBtc && ethBtc.chg7dPct));
  parts.push(ethLeg("ethbtc30", "30d", ethBtc && ethBtc.chg30dPct));

  parts.push(part("feargreed", 10,
    fg == null ? null : Math.max(0, Math.min(10, Math.round(fg.value / 10))),
    fg == null ? "fear & greed unavailable — not scored" : `fear & greed ${fg.value} (${fg.label})`));

  // `of` is at least 25 here — the early return guarantees a breadth window.
  const scored = parts.filter((p) => p.measured);
  const earned = scored.reduce((s, x) => s + x.points, 0);
  const of = scored.reduce((s, x) => s + x.max, 0);

  const publish = of >= SEASON_MIN_POINTS;
  const score = publish ? Math.max(0, Math.min(100, Math.round((100 * earned) / of))) : null;

  const missing = parts.filter((x) => !x.measured);
  if (missing.length > 0) {
    facts.push(
      `${earned} of the ${of} points on offer were earned${publish ? `, renormalised to ${score} out of 100` : ""}: ` +
      `${listOf(missing.map((x) => SEASON_PART_NAMES[x.key]))} ${missing.length === 1 ? "was" : "were"} not measured, ` +
      "so nothing was scored for " + (missing.length === 1 ? "it" : "them") + " on either side of the fraction");
  }
  if (!publish) {
    facts.push(`only ${of} of ${SEASON_MAX_POINTS} points had an input — under half, so no regime score is published off it`);
  }

  const rung = publish ? SEASON_LADDER.find((x) => score >= x.min) : null;
  const out = publish
    ? { score, phase: rung.phase, label: rung.label }
    : { score: null, phase: null, label: "Not enough measured" };

  return {
    ...out,
    parts, facts,
    breadth7d: breadth.beatBtc7dPct, breadth30d: breadth.beatBtc30dPct,
    fearGreed: fg ? fg.value : null,
    ethBtc7d: ethBtc ? ethBtc.chg7dPct : null,
    domTrend: dom.trend,
    // The SPAN, not just the direction — see domSpanDays above.
    domSpanDays,
    measured: { earned, of },
  };
}

/**
 * Share of the top-100 non-stable, non-BTC rows beating BTC over each window.
 * Each window keeps its OWN denominator: a recent listing has a 7d return and
 * no 30d one, and folding both into one `n` understates 30d breadth by exactly
 * the number of new listings — which spikes in exactly the market where this
 * number matters most.
 */
function computeBreadth(universe, btcRow, facts) {
  const empty = { beatBtc7dPct: null, beatBtc30dPct: null, n: 0, n7: 0, n30: 0, excluded: 0 };
  if (!Array.isArray(universe) || universe.length === 0) {
    facts.push("no universe rows fetched — breadth cannot be counted");
    return empty;
  }
  const btc7 = btcRow && Number.isFinite(btcRow.chg7d) ? btcRow.chg7d : null;
  const btc30 = btcRow && Number.isFinite(btcRow.chg30d) ? btcRow.chg30d : null;
  if (btc7 == null && btc30 == null) {
    facts.push("no BTC row in the universe — there is no bar to measure breadth against");
    return empty;
  }

  // Top 100 by rank when ranks are present, else the first 100 as delivered
  // (the markets URL preserves market_cap_desc order).
  const ranked = universe.filter((r) => r && Number.isFinite(r.rank));
  const top = (ranked.length >= 50 ? ranked.sort((a, b) => a.rank - b.rank) : universe.filter(Boolean)).slice(0, 100);

  let excluded = 0;
  const eligible = [];
  for (const r of top) {
    if (String((r && r.symbol) ?? "").toUpperCase() === "BTC") continue;
    if (isExcluded(r)) { excluded++; continue; }
    eligible.push(r);
  }

  let beat7 = 0, n7 = 0, beat30 = 0, n30 = 0;
  for (const r of eligible) {
    if (btc7 != null && Number.isFinite(r.chg7d)) { n7++; if (r.chg7d > btc7) beat7++; }
    if (btc30 != null && Number.isFinite(r.chg30d)) { n30++; if (r.chg30d > btc30) beat30++; }
  }

  const beatBtc7dPct = n7 > 0 ? (beat7 / n7) * 100 : null;
  const beatBtc30dPct = n30 > 0 ? (beat30 / n30) * 100 : null;

  if (beatBtc7dPct != null) facts.push(`${beat7} of ${n7} top-100 alts beat BTC over 7d (${Math.round(beatBtc7dPct)}%) — BTC did ${signed(btc7)}%`);
  if (beatBtc30dPct != null) facts.push(`${beat30} of ${n30} beat BTC over 30d (${Math.round(beatBtc30dPct)}%) — BTC did ${signed(btc30)}%`);

  return { beatBtc7dPct, beatBtc30dPct, n: eligible.length, n7, n30, excluded };
}

/**
 * Dominance trend from OUR history and nothing else. Empty on day one and thin
 * for a week, and the honest answer during that week is null — inferring the
 * trend from a 24h change would produce a number that looks identical to a
 * measured one and is not. The window is anchored to the NEWEST sample and
 * bounded by dates, not by a sample count: after a cron gap, "the last 30
 * samples" reaches back months and labels the result a 30-day move.
 *
 * `windowDays` defaults to the month the season scores on; seasonRead also
 * runs it over the full kept history for the span the regime override reads.
 * The span it returns is strictly under the window at daily cadence (the
 * sample exactly `windowDays` back is excluded), which is why the override's
 * 60 days can only be met by a window wider than 60.
 */
function domTrendOf(domHistory, facts = [], windowDays = DOM_WINDOW_DAYS) {
  const rows = (Array.isArray(domHistory) ? domHistory : [])
    .filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.dom))
    .sort((a, b) => a.t - b.t);
  if (rows.length === 0) return { trend: null, changePts: null, samples: 0 };
  const newest = rows[rows.length - 1].t;
  const window = rows.filter((s) => s.t > newest - windowDays * DAY);
  if (window.length < MIN_DOM_SAMPLES) {
    facts.push(`${window.length} recent dominance sample${window.length === 1 ? "" : "s"} stored — the trend needs ${MIN_DOM_SAMPLES} and stays unknown until then`);
    return { trend: null, changePts: null, samples: window.length };
  }
  const first = window[0], last = window[window.length - 1];
  const change = last.dom - first.dom;
  const trend = change < -DOM_FLAT_PTS ? "falling" : change > DOM_FLAT_PTS ? "rising" : "flat";
  // THE SPAN IS MEASURED, NOT ASSUMED. DOM_WINDOW_DAYS is the window we are
  // willing to look back over; it is not how far back the samples actually go.
  // Seven of them can sit inside six days — after a deploy, or on the far side
  // of a gap in the history — and this sentence announced them as "over the
  // last 30 days" regardless. That is the whole claim: a dominance move of
  // −0.61 points is a real signal over a month and noise over a week, and the
  // reader has no other way to tell which one they are looking at. Dominance
  // is worth 20 of the season's 100 points, so the sentence is load-bearing.
  const spanDays = Math.max(0, Math.round((last.t - first.t) / DAY));
  const over = spanDays >= 1 ? `${spanDays} day${spanDays === 1 ? "" : "s"}` : "under a day";
  facts.push(`BTC dominance ${trend}: ${signed(change, 2)} pts over the last ${over}${trend === "falling" ? " — capital is leaving BTC" : ""}`);
  return { trend, changePts: change, samples: window.length, spanDays };
}

/* ═══ step 4b — the score's own drift ════════════════════════════════════════
 *
 * WHICH WAY THE REGIME IS MOVING, which turns out to matter more than where it
 * is. A season score of 31 rising is an accumulation window opening; a 31
 * falling is a market still breaking. They are the same number and opposite
 * instructions, and until this existed the tab could not tell them apart.
 *
 * Same storage discipline as domHistory, for the same reason — nobody sells a
 * "what was the alt regime last month" endpoint, so a pass that does not write
 * the number down loses it permanently. One sample per UTC day, last write
 * wins, so the final pass of a day settles it and completed days compare
 * cleanly. UTC deliberately: a local-zone day duplicates or skips a row across
 * a DST shift.
 *
 * Unlike dominance this series has NO durable second copy — alt_snapshots has
 * columns for dominance and fear/greed but not for the composite score, which
 * is derived rather than fetched. It rides in the payload alone, and the
 * payload write is already guarded by prevReadFailed for exactly this class of
 * loss.
 */
function mergeScoreSample(history, t, score) {
  if (!Number.isFinite(t) || !Number.isFinite(score)) return Array.isArray(history) ? history : [];
  const day = new Date(t).toISOString().slice(0, 10);
  const kept = (Array.isArray(history) ? history : []).filter((s) =>
    s && Number.isFinite(s.t) && Number.isFinite(s.v) &&
    new Date(s.t).toISOString().slice(0, 10) !== day &&
    t - s.t <= SCORE_KEEP_DAYS * DAY);
  kept.push({ t, v: score });
  kept.sort((a, b) => a.t - b.t);
  return kept.slice(-SCORE_CAP);
}

const SCORE_DRIFT_WINDOW_DAYS = 30;
const SCORE_DRIFT_MIN_SAMPLES = 5;
const SCORE_FLAT_PTS = 3; // the composite wobbles a couple of points on noise

/**
 * The 30-day change in the regime score, measured the same way domTrendOf
 * measures dominance: anchored to the NEWEST sample and bounded by DATES, not
 * by a sample count — after a cron gap "the last 30 samples" reaches back
 * months and would be labelled a 30-day move.
 *
 * spanDays is reported because a 6-point drift is a real signal over a month
 * and noise over four days, and the reader has no other way to tell which one
 * is on screen.
 */
function scoreDriftOf(history, facts = []) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.v))
    .sort((a, b) => a.t - b.t);
  const empty = { direction: null, changePts: null, samples: rows.length, spanDays: null, from: null };
  if (!rows.length) return empty;
  const newest = rows[rows.length - 1].t;
  const window = rows.filter((s) => s.t > newest - SCORE_DRIFT_WINDOW_DAYS * DAY);
  if (window.length < SCORE_DRIFT_MIN_SAMPLES) {
    facts.push(`${window.length} of ${SCORE_DRIFT_MIN_SAMPLES} daily regime samples stored — which way the tape is drifting stays unknown until then`);
    return { ...empty, samples: window.length };
  }
  const first = window[0], last = window[window.length - 1];
  const change = last.v - first.v;
  const spanDays = Math.max(0, Math.round((last.t - first.t) / DAY));
  const direction = change > SCORE_FLAT_PTS ? "rising" : change < -SCORE_FLAT_PTS ? "falling" : "flat";
  return { direction, changePts: r1(change), samples: window.length, spanDays, from: r1(first.v) };
}

/**
 * ETH/BTC as the PAIR's return, not the difference of two percentages —
 * ETH +120% against BTC +60% is +37.5% on the pair, not +60%. The subtraction
 * is nearly right at small numbers and badly wrong at exactly the numbers that
 * would make someone act on it.
 */
function computeEthBtc(ethRow, btcRow, facts = []) {
  const pair = (e, b) => {
    if (!Number.isFinite(e) || !Number.isFinite(b) || 1 + b / 100 <= 0) return null;
    return ((1 + e / 100) / (1 + b / 100) - 1) * 100;
  };
  const c7 = pair(ethRow && ethRow.chg7d, btcRow && btcRow.chg7d);
  const c30 = pair(ethRow && ethRow.chg30d, btcRow && btcRow.chg30d);
  if (c7 == null && c30 == null) return null;
  if (c7 != null) facts.push(`ETH/BTC ${signed(c7)}% over 7d`);
  // Nulls stay null — a missing leg reported as 0 would read as "ETH tracked
  // BTC exactly", which is a measurement, and this is the absence of one.
  return { chg7dPct: c7, chg30dPct: c30 };
}

// alternative.me sends the index as a STRING ("39") — but Number(null) and
// Number('') are both 0, and 0 here is "Extreme Fear", the most alarming
// reading on the scale. Reject the empty cases before coercing.
function normFearGreed(fearGreed, facts = []) {
  const raw = fearGreed && fearGreed.value;
  if (raw == null || raw === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  const value = Math.max(0, Math.min(100, Math.round(v)));
  const label = (fearGreed && fearGreed.label) ||
    (value >= 75 ? "Extreme Greed" : value >= 55 ? "Greed" : value >= 45 ? "Neutral" : value >= 25 ? "Fear" : "Extreme Fear");
  facts.push(`fear & greed ${value} (${label})`);
  return { value, label };
}

// "a, b and c" — the facts read as sentences, and "a, b, c were not measured"
// reads as a list that was truncated rather than one that ended.
function listOf(xs) {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/* ═══ step 4c — narratives ═══════════════════════════════════════════════════
 *
 * THE ANSWER TO "THERE ARE TOO MANY COINS". There are not fourteen hundred
 * independent assets; there are a dozen or so live narratives, and the names
 * inside one move as a cohort — together, and before any individual chart
 * looks interesting. Ranking cohorts is both a far smaller problem and an
 * earlier signal than ranking coins, and it is the only thing on this tab that
 * a per-coin screener structurally cannot produce.
 *
 * It also supplies the input for the read that fixes the OTHER complaint: a
 * coin up 15% because its whole sector is up 14% is rotation, which persists
 * and can be traded; a coin up 15% alone is a listing, an unlock or a tweet,
 * which does not and cannot. The two are indistinguishable on a board sorted by
 * return, and telling them apart is a subtraction once a cohort return exists.
 * alt-scan does that subtraction against the LIVE price — see cohortExcess
 * there for why it cannot live here.
 *
 * THE LIST IS AUTHORED, and has to be. CoinGecko publishes hundreds of
 * categories, most of them ecosystem tags ("solana-ecosystem") that overlap
 * everything and describe nothing about what is being bid. These are the
 * narratives that actually take flows, in rough priority order — the order also
 * breaks membership ties, since a coin can carry many categories and needs
 * exactly one cohort for its excess to mean anything.
 *
 * SLUGS DRIFT, AND A DRIFTED SLUG MUST NOT ROT SILENTLY. Every id here is
 * validated against /coins/categories before it is fetched: one that no longer
 * resolves is dropped and NAMED in the pass's errors, rather than contributing
 * an empty cohort forever that nobody can tell apart from a quiet sector.
 */
const NARRATIVES = [
  { id: "artificial-intelligence", label: "AI" },
  { id: "ai-agents", label: "AI agents" },
  { id: "real-world-assets-rwa", label: "RWA" },
  { id: "depin", label: "DePIN" },
  { id: "prediction-markets", label: "Prediction mkts" },
  { id: "layer-2", label: "L2s" },
  { id: "layer-1", label: "L1s" },
  { id: "decentralized-finance-defi", label: "DeFi" },
  { id: "liquid-staking-tokens", label: "Liquid staking" },
  { id: "restaking", label: "Restaking" },
  { id: "gaming", label: "Gaming" },
  { id: "meme-token", label: "Memes" },
  { id: "privacy-coins", label: "Privacy" },
  { id: "oracle", label: "Oracles" },
];

// A cohort thinner than this is not a narrative, it is a handful of coins —
// and a median over three rows moves on one of them.
const COHORT_MIN_ROWS = 4;

/**
 * The category index → Map(id → { name, mcap }). Only used to validate the
 * authored slugs and to rank them; the returns published per cohort are ours.
 */
function parseCategoryIndex(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const id = str(r && r.id);
    if (!id) continue;
    out.set(id, { name: str(r.name) || id, mcap: fin(r.market_cap) });
  }
  return out;
}

/**
 * One cohort's numbers, from that category's own /coins/markets page.
 *
 * MEDIAN, and a LIQUIDITY FLOOR on membership — the same two defences the
 * capital ladder uses, for the same reason. Every category has a long tail of
 * dust that has not traded in a week; counted, it drags both the median and the
 * breadth denominator toward whatever the dust did, which is usually nothing.
 * THIN_VOL_USD is the floor the screener already applies to individual coins.
 *
 * `lifting` is the count positive over 7 days, and it is the number that stops
 * a cohort lying: "9 of 11 lifting" is a bid, while "1 of 26" alongside a green
 * headline is one coin dragging an average — the most common way a sector
 * screen misleads, and invisible without the denominator beside it.
 */
function cohortStats(id, label, name, rows, mcap) {
  const members = (Array.isArray(rows) ? rows : [])
    .map(parseMarketsRow)
    .filter((r) => r && !isExcluded(r) && Number.isFinite(r.vol24h) && r.vol24h >= THIN_VOL_USD);
  const d7 = [], d30 = [];
  let lifting = 0, measured = 0;
  for (const r of members) {
    if (Number.isFinite(r.chg7d)) { d7.push(r.chg7d); measured++; if (r.chg7d > 0) lifting++; }
    if (Number.isFinite(r.chg30d)) d30.push(r.chg30d);
  }
  if (measured < COHORT_MIN_ROWS) return null;
  return {
    id, label, name: name || label, mcap: fin(mcap),
    chg7d: r1(median(d7)),
    chg30d: d30.length >= COHORT_MIN_ROWS ? r1(median(d30)) : null,
    lifting, n: measured,
    // Membership rides along so the coin→cohort map can be built without a
    // second pass over the fetched pages.
    memberIds: members.map((r) => r.id).filter(Boolean),
  };
}

/**
 * Assemble the narrative read from already-fetched pages.
 *
 * @param index    Map(id → {name, mcap}) from parseCategoryIndex
 * @param pages    Map(id → raw /coins/markets rows)
 * @returns { cohorts, coinCohort, leadId, read }
 */
function cohortRead(index, pages) {
  const cohorts = [];
  // Authored order is priority order, and it decides the coin→cohort tie —
  // first list wins, so a coin tagged both 'ai-agents' and 'meme-token' is
  // filed under the narrative nearer the top of NARRATIVES. Deterministic, and
  // deterministic is the whole requirement: a coin that changed cohort between
  // passes would change its excess without its price moving.
  for (const n of NARRATIVES) {
    const meta = (index && index.get(n.id)) || null;
    const rows = pages && pages.get(n.id);
    if (!rows) continue;
    const c = cohortStats(n.id, n.label, meta && meta.name, rows, meta && meta.mcap);
    if (c) cohorts.push(c);
  }

  const coinCohort = {};
  for (const c of cohorts) {
    for (const cid of c.memberIds) if (!(cid in coinCohort)) coinCohort[cid] = c.id;
    delete c.memberIds; // the map is the published form; the list was scaffolding
  }

  // Ranked by the 30-day read, which is the rotation horizon — a cohort that
  // led for one day is noise, and 7d is already on the tile for anyone reading
  // more closely.
  cohorts.sort((a, b) =>
    (b.chg30d ?? b.chg7d ?? -Infinity) - (a.chg30d ?? a.chg7d ?? -Infinity) ||
    String(a.label).localeCompare(String(b.label)));

  const lead = cohorts.find((c) => (c.chg30d ?? c.chg7d) != null) || null;
  let read = null;
  if (!lead) read = "No narrative has enough measured names to rank.";
  else if ((lead.chg30d ?? lead.chg7d) <= 0) read = "No narrative is bid — every cohort is negative over 30 days.";
  else read = `${lead.label} leads — ${lead.lifting} of ${lead.n} names lifting.`;

  return { cohorts, coinCohort, leadId: lead ? lead.id : null, read };
}

/* ═══ step 5 — price targets ═════════════════════════════════════════════════
 *
 * Measured moves off the 7-day structure. h = priorHigh − priorLow is the base
 * the move is measured from — both ends drawn from bars that are DONE (see
 * structure7d), so no target or invalidation can move with the price it is
 * later compared against.
 *
 *   Breakout underway (fresh break, or price already above the prior high):
 *     T1/T2/T3 = priorHigh + 0.382h / 0.618h / 1.0h, invalidation the 0.382
 *     retrace back under the level — a breakout that gives back 38% of its
 *     base was not a breakout.
 *   Building (still under the level): T1 IS the prior high — the first target
 *     of a base is the top of the base — then +0.5h / +1.0h, invalidation the
 *     prior low.
 *   ATH snap: an all-time high sitting between price and just past T3 is a
 *     real wall; the nearest target at or above it snaps onto it rather than
 *     pretending the market will pick our number over the market's.
 *   Clamps: T1 under +5% is not a target worth flagging (bumped to +5% — the
 *     same 5% the flag gate asks for, so the two can never disagree); T1<T2
 *     strictly (≥2% step); an invalidation at or above price×0.99 means the
 *     structure is already lost — no targets at all.
 *   T3 IS NEVER CLAMPED. The last rung is the measured move or there is no
 *     ladder: when the structural T3 sits under the clamped T2's +2% step the
 *     move is spent (price through most of h, or a base too tight to measure
 *     one off) and the answer is null. Raising T3 to fit under it manufactured
 *     a +5/+7.1/+9.2% staircase out of nothing — 46 of the first 55 flags
 *     carried T1 = price×1.05 exactly and twenty-odd the full triple, and a
 *     bull hour cleared "T3" on a level no chart ever drew.
 */
function targetsFor(row) {
  const price = row && Number.isFinite(row.price) ? row.price : null;
  const r = row && row.range7d ? row.range7d : null;
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

  // ATH snap — targets still ascend here, so the first one at or above the ATH
  // is the nearest.
  const ath = row && Number.isFinite(row.ath) ? row.ath : null;
  if (ath != null && ath > price && ath <= t3 * 1.05) {
    if (t1 >= ath) t1 = ath;
    else if (t2 >= ath) t2 = ath;
    else if (t3 >= ath) t3 = ath;
  }

  // ≥2% between rungs, not merely ascending. `t2 <= t1` only guaranteed a
  // strict order, so when the T1 clamp below pushed T1 up to price×1.05 it
  // could land a hair under an unmoved T2 and pass: PUMP shipped T1 $0.002553
  // and T2 $0.002555, 0.08% apart, which is one target wearing two labels.
  //
  // The bump threshold IS the flag gate's 5%. It used to bump under +4% and
  // leave [4%, 5%) alone, so a structural T1 3.9% away was lifted to 5% and
  // flagged while one 4.5% away was refused — the gate read backwards across
  // that band. One number, in one place, and the gate is monotone again.
  if (t1 < price * 1.05) t1 = price * 1.05;
  if (t2 < t1 * 1.02) t2 = t1 * 1.02;
  // T3 is the structure's or the ladder does not exist. If the measured move
  // cannot clear the clamped T2 by the same 2% step, the clamps would be
  // supplying every rung, and a ladder of three invented numbers is exactly
  // what the Record then grades itself against.
  if (t3 < t2 * 1.02) return null;
  if (!(invalidation < price * 0.99)) return null;

  const pctVs = (t) => Math.round((t / price - 1) * 1000) / 10;
  return {
    t1, t2, t3, invalidation,
    t1Pct: pctVs(t1), t2Pct: pctVs(t2), t3Pct: pctVs(t3), invPct: pctVs(invalidation),
  };
}

/* ═══ step 6 — flags ═════════════════════════════════════════════════════════
 *
 * Two tiers: 'igniting' (5%+ expected within ~24h) and 'building' (5%+ over
 * 3–7 days). A flag needs a tradeable coin (real volume, not thin), a target
 * structure worth flagging (T1 at least 5% away), and a band+score that says
 * the move is starting rather than started.
 */

// The igniting condition alone, shared by flagTier and the tier-upgrade check
// in transitionFlags — an upgrade is about the move's state, not about whether
// today's (already-run) targets would clear the flag gate again.
function igniteCond(row) {
  if (!row || !Number.isFinite(row.score)) return false;
  if (row.band === "starting" && row.score >= 55) return true;
  const a = row.accel && Number.isFinite(row.accel.d24VsWeek) ? row.accel.d24VsWeek : null;
  return row.band === "underway" && a != null && a >= 4 &&
    Number.isFinite(row.chg24h) && row.chg24h <= 20 && row.score >= 60;
}

/**
 * How many open flags a regime is allowed to carry, and how good a setup has
 * to be to earn one.
 *
 * THE TOOL SHOULD BE QUIET WHEN THE MARKET IS. The first build used one flat
 * bar and produced FIFTY-TWO open flags in a 35/100 "Bitcoin only" tape —
 * most of them already below their own flag price. A list that long is not a
 * signal, it is the absence of one wearing a signal's clothes, and it is
 * exactly the overload this thing exists to prevent.
 *
 * Both dials move with the regime because the regime is what decides whether
 * an alt setup gets paid: the same chart that runs in `alt_season` bleeds in
 * `risk_off`. So a hostile tape does not just score lower, it gets a smaller
 * budget AND a higher bar, and the two compound into a genuinely short list.
 *
 * The cap is enforced by SCORE, not by arrival order — see transitionFlags.
 */
const PHASE_GATE = {
  alt_season: { max: 14, floor: 62 },
  majors_rotating: { max: 10, floor: 66 },
  mixed: { max: 8, floor: 70 },
  btc_only: { max: 5, floor: 74 },
  risk_off: { max: 3, floor: 78 },
};
// No published regime (breadth unmeasured) is not permission to flag freely.
const DEFAULT_GATE = { max: 8, floor: 70 };

function gateFor(season) {
  const phase = season && season.phase;
  return (phase && PHASE_GATE[phase]) || DEFAULT_GATE;
}

function flagTier(row, gate = DEFAULT_GATE) {
  if (!row || !Number.isFinite(row.score)) return null;
  if (isExcluded(row)) return null;
  if (String(row.symbol ?? "").toUpperCase() === "BTC") return null;
  if (!Number.isFinite(row.vol24h) || row.vol24h < 1e6) return null;
  if (row.flags && row.flags.thinLiquidity) return null;
  const t = row.targets;
  if (!t || !Number.isFinite(t.t1Pct) || t.t1Pct < 5) return null;
  // Losing to BTC disqualifies an ALT setup whatever the chart looks like:
  // relative strength is the entire premise of the board, and a coin the
  // majors are beating is a worse version of the trade you already have.
  if (!Number.isFinite(row.rsVsBtc7d) || row.rsVsBtc7d <= 0) return null;
  if (row.score < (gate.floor ?? DEFAULT_GATE.floor)) return null;

  if (igniteCond(row)) return "igniting";
  // 'quiet' no longer earns a flag at all. It was the loosest rung — a coin
  // going nowhere, on the argument that it was coiled — and it supplied most
  // of the fifty-two. A base with nothing lifting it is a watchlist entry,
  // and the board already lists it.
  if (row.band === "warming" || row.band === "starting") return "building";
  return null;
}

const STATUS_RANK = { active: 0, hit_t1: 1, hit_t2: 2, hit_t3: 3 };
const FADE_MIN_AGE_MS = 72 * HOUR;
const FADE_SCORE = 35;
const STALE_MS = 14 * DAY;

/**
 * Transition the flag log. Pure — the DB reads and writes stay in the pass so
 * this whole ladder can be asserted without a network.
 *
 * The episode is the unit: id embeds the UTC day of the FIRST flag, targets
 * are FROZEN at flag time, and a re-scan of a still-open flag never resets
 * first_flagged_at — inserts only happen when no open row exists for the coin.
 * The status ladder is judged by PEAK price against the frozen targets and
 * ratchets up only; "hit T1 then round-tripped" is hit_t1 closed by
 * invalidation, not a hit erased. T3 is the top of the ladder and CLOSES the
 * episode — there is nothing left to grade past the measured move.
 *
 * @param openRows      alt_flags rows with resolved_at null (DB column names)
 * @param screenedById  Map (or plain object) id → screened row with .targets
 * @param asOf          ms epoch
 * @returns { inserts: [row…], updates: [{ id, …changed columns }…] }
 */
function transitionFlags(openRows, screenedById, asOf, gate = DEFAULT_GATE) {
  const now = Number.isFinite(asOf) ? asOf : Date.now();
  const nowIso = new Date(now).toISOString();
  const isMap = screenedById instanceof Map;
  const lookup = (id) => (isMap ? screenedById.get(id) : screenedById ? screenedById[id] : undefined);
  const screenedRows = isMap ? [...screenedById.values()] : Object.values(screenedById || {});

  const inserts = [];
  const updates = [];
  const openCoins = new Set();

  for (const flag of Array.isArray(openRows) ? openRows : []) {
    if (!flag || typeof flag !== "object" || flag.resolved_at) continue;
    openCoins.add(flag.coin_id);
    const s = lookup(flag.coin_id);

    const patch = {};
    const notes = { ...(flag.notes && typeof flag.notes === "object" ? flag.notes : {}) };
    let notesTouched = false;

    // Coerced, not trusted — numerics from the wire may arrive as strings, and
    // a string in a >= comparison silently freezes the ladder.
    const t1 = fin(flag.t1), t2 = fin(flag.t2), t3 = fin(flag.t3);
    const invalidation = fin(flag.invalidation);
    let peakPrice = fin(flag.peak_price) ?? fin(flag.flag_price);
    let peakAt = parseTs(flag.peak_at);
    let status = STATUS_RANK[flag.status] != null ? flag.status : "active";

    if (s && Number.isFinite(s.price)) {
      patch.last_price = s.price;
      patch.last_seen_at = nowIso;

      // Peak ratchet — it only ever rises, and peak_at moves with it.
      if (peakPrice == null || s.price > peakPrice) {
        peakPrice = s.price;
        peakAt = now;
        patch.peak_price = s.price;
        patch.peak_at = nowIso;
      }

      // Status ladder vs the FROZEN flag targets, by peak — ratchet up only.
      const ladder =
        peakPrice != null && t3 != null && peakPrice >= t3 ? "hit_t3"
        : peakPrice != null && t2 != null && peakPrice >= t2 ? "hit_t2"
        : peakPrice != null && t1 != null && peakPrice >= t1 ? "hit_t1"
        : "active";
      if (STATUS_RANK[ladder] > STATUS_RANK[status]) {
        status = ladder;
        patch.status = ladder;
      }

      // Tier upgrade building → igniting. first_flagged_at NEVER changes — the
      // episode is the same episode, moving faster.
      if (flag.tier === "building" && igniteCond(s)) {
        patch.tier = "igniting";
        notes.tierUpgradedAt = nowIso;
        notesTouched = true;
      }

      if (invalidation != null && s.price <= invalidation) {
        // Closed by invalidation. A ladder status ≥ hit_t1 is kept — the hit
        // happened and the record grades it; only a flag that never got there
        // closes as 'invalidated'.
        patch.resolved_at = nowIso;
        if (STATUS_RANK[status] === 0) { status = "invalidated"; patch.status = "invalidated"; }
        notes.closedBy = "invalidation";
        notesTouched = true;
      } else if (status === "active" && Number.isFinite(s.score) && s.score < FADE_SCORE &&
                 parseTs(flag.first_flagged_at) != null && now - parseTs(flag.first_flagged_at) > FADE_MIN_AGE_MS) {
        // Faded: the setup died without hitting anything. The 72h floor keeps
        // one bad scan from writing off a flag the day it was made.
        patch.status = "faded";
        patch.resolved_at = nowIso;
        notes.closedBy = "faded";
        notesTouched = true;
      }
    }

    // T3 close — with or without a screened row this pass, and after the
    // invalidation branch so a T3 winner that has since lost its level is
    // filed as the round-trip it is. This is the close the equity engine has
    // always made and this one never did: a flag at hit_t3 sat open until the
    // 14-day stale timer, and every new peak on a still-running name reset
    // that timer, so twelve month-old winners held twelve of a `mixed` tape's
    // eight slots and no setup found after 5 Aug could open at all. The
    // Flags card froze on its best month and looked like it was working.
    if (!patch.resolved_at && status === "hit_t3") {
      patch.resolved_at = nowIso;
      notes.closedBy = "target";
      notesTouched = true;
    }

    // Stale close — with or without a screened row this pass: 14 days without
    // a new peak means the episode is over; the status it earned stands.
    if (!patch.resolved_at) {
      const ref = peakAt != null ? peakAt : parseTs(flag.first_flagged_at);
      if (ref != null && now - ref > STALE_MS) {
        patch.resolved_at = nowIso;
        notes.closedBy = "stale";
        notesTouched = true;
      }
    }

    if (notesTouched) patch.notes = notes;
    if (Object.keys(patch).length) updates.push({ id: flag.id, ...patch });
  }

  // New episodes: a coin with a tier and NO open row. The id embeds the UTC
  // day of this first flag, so a coin closed and re-flagged on a later day
  // gets a NEW episode with a NEW id. (Closed-and-reflagged inside one UTC day
  // collides with the closed row's id; the pass inserts with duplicates
  // ignored, so that same-day echo is dropped rather than resurrected.)
  //
  // THE REGIME'S BUDGET IS SPENT ON THE BEST SETUPS, NOT THE FIRST ONES. The
  // candidates are ranked by score and only the top `room` are opened, so a
  // pass that finds thirty qualifiers in a `btc_only` tape opens the five it
  // rates highest rather than whichever five `screenedRows` happened to reach
  // first (which is market-cap order — i.e. nothing to do with the setup).
  //
  // A FLAG CLOSED ON THIS PASS IS NOT OPEN. `openCoins` holds every row the
  // pass started with, and the room was measured against that — so on the
  // hour a T3 print or a shakeout closed three episodes, the hour you most
  // want to know what replaces them, the cap read as full and nothing new
  // opened. The set itself still excludes them from becoming candidates: a
  // name that just closed does not get re-flagged in the same breath.
  const cap = Number.isFinite(gate && gate.max) ? gate.max : DEFAULT_GATE.max;
  const closedThisPass = updates.filter((u) => u.resolved_at).length;
  const room = Math.max(0, cap - (openCoins.size - closedThisPass));
  const candidates = [];
  for (const s of screenedRows) {
    if (!s || !s.id || openCoins.has(s.id)) continue;
    const tier = flagTier(s, gate);
    if (!tier || !s.targets) continue;
    candidates.push({ s, tier });
  }
  candidates.sort((a, b) => (b.s.score ?? 0) - (a.s.score ?? 0) || String(a.s.symbol).localeCompare(String(b.s.symbol)));

  for (const { s, tier } of candidates.slice(0, room)) {
    const t = s.targets;
    inserts.push({
      id: `${s.id}:${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}`, // UTC day, deliberately
      coin_id: s.id,
      symbol: s.symbol,
      name: s.name,
      tier,
      status: "active",
      first_flagged_at: nowIso,
      flag_price: s.price,
      score: Math.round(s.score),
      t1: t.t1, t2: t.t2, t3: t.t3, invalidation: t.invalidation,
      peak_price: s.price,
      peak_at: nowIso,
      last_price: s.price,
      last_seen_at: nowIso,
      resolved_at: null,
      notes: {},
    });
  }

  return { inserts, updates };
}

/* ═══ steps 1 + 7 + 8 — fetch, persist, report ═══════════════════════════════ */

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

function settledError(res) {
  return String((res.reason && res.reason.message) || res.reason || "unknown error");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch the category index and one markets page per surviving narrative.
 *
 * SERIALIZED, WITH SPACING, AND THAT IS DELIBERATE. Everything else in this
 * pass fires in parallel because it is three calls; this is up to thirteen
 * against a keyless free tier that answers a burst with 429s. A background
 * invocation has fifteen minutes and this costs about fifteen seconds of it,
 * which is the cheapest possible price for not being rate-limited out of the
 * three calls the rest of the tab depends on.
 *
 * EVERY FAILURE IS PARTIAL. A dead index means no narratives this pass and
 * nothing else changes; a single category that 404s or times out is dropped
 * and named, and the other eleven publish. Nothing here can abort the pass —
 * see this file's header for why that rule is absolute.
 */
async function fetchCohorts(errors) {
  let index = null;
  try {
    index = parseCategoryIndex(await fetchJson(CATEGORIES_URL));
  } catch (e) {
    errors.push(`categories index: ${(e && e.message) || e}`);
    return { index: new Map(), pages: new Map() };
  }

  // Validate the authored slugs against what CoinGecko actually publishes, then
  // take the biggest COHORT_MAX by cap. Ranking by cap rather than by list
  // order means the twelve that get fetched are the twelve that hold real
  // money, and the list can grow past twelve without changing the call budget.
  const resolved = NARRATIVES.filter((n) => index.has(n.id));
  const missing = NARRATIVES.filter((n) => !index.has(n.id)).map((n) => n.id);
  if (missing.length) errors.push(`categories not found upstream (slug drift?): ${missing.join(", ")}`);

  const picked = resolved
    .map((n) => ({ n, mcap: (index.get(n.id) || {}).mcap ?? 0 }))
    .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0))
    .slice(0, COHORT_MAX)
    .map((x) => x.n);

  const pages = new Map();
  for (let i = 0; i < picked.length; i++) {
    if (i > 0) await sleep(COHORT_FETCH_SPACING_MS);
    try {
      pages.set(picked[i].id, await fetchJson(categoryMarketsUrl(picked[i].id)));
    } catch (e) {
      errors.push(`category ${picked[i].id}: ${(e && e.message) || e}`);
    }
  }
  return { index, pages };
}

// One dominance sample per UTC day, last write wins — the cron's last pass of
// a UTC day settles the day, so completed days are comparable hour-to-hour.
// UTC on purpose: a local-zone day duplicates or skips a row on DST shifts,
// and season's "≥7 samples" gate counts exactly those rows.
function mergeDomSample(history, t, dom) {
  const day = new Date(t).toISOString().slice(0, 10);
  const kept = (Array.isArray(history) ? history : []).filter((s) =>
    s && Number.isFinite(s.t) && Number.isFinite(s.dom) &&
    new Date(s.t).toISOString().slice(0, 10) !== day &&
    t - s.t <= DOM_KEEP_DAYS * DAY);
  kept.push({ t, dom });
  kept.sort((a, b) => a.t - b.t);
  return kept.slice(-DOM_CAP);
}

/**
 * The price `hoursAgo` hours back, read off CoinGecko's 7-day hourly
 * sparkline.
 *
 * WHY THIS EXISTS AT ALL, given alt_snapshots. The snapshot series is our own
 * and exact, but it can only price a 4h window after four hours of passes and
 * a 12h window after twelve — so a fresh deploy (or any gap in the cron) shows
 * "—" in those two columns for half a day, and a column that reads "—" the
 * first time you look at it is a column you stop looking at. The sparkline is
 * ~168 hourly closes and arrives on the FIRST pass, so it can seed both
 * windows immediately. Snapshots still win when present (see refFor in
 * alt-scan.js) — this is the floor, not the ceiling.
 *
 * The index is derived from the array's own length rather than assuming 168
 * points: CoinGecko truncates the series for young listings, and stepping a
 * fixed 4 slots back on a 40-point tape would reach ~17 hours, not 4.
 *
 * KNOWN IMPRECISION, and the second reason snapshots outrank this: the series
 * carries no timestamps, so "4 hours back" is 4 hours back from its LAST
 * CLOSE, not from now. The reading is therefore a 4-to-5 hour window depending
 * on how long ago that close printed. Fine for a mover column, which is why
 * this seeds the window rather than owning it.
 */
function priceAgo(spark, hoursAgo) {
  const s = Array.isArray(spark) ? spark.filter(Number.isFinite) : [];
  if (s.length < 8) return null;
  const perHour = (s.length - 1) / (7 * 24);
  const idx = Math.round(s.length - 1 - hoursAgo * perHour);
  // idx must leave a real gap — landing on the last point would compare the
  // price against itself and print a confident 0.0%.
  if (idx < 0 || idx >= s.length - 1) return null;
  const v = s[idx];
  return v > 0 ? v : null;
}

// ~28 evenly-sampled points, first and last always included — the board ships
// a spark, not the 168-point sparkline, because 60 rows × 168 floats is dead
// weight on every client poll.
function sampleSpark(spark, n) {
  if (!Array.isArray(spark) || spark.length === 0) return [];
  if (spark.length <= n) return spark.slice();
  const stepBy = (spark.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(spark[Math.round(i * stepBy)]);
  return out;
}

// The payload row shape (client contract) — WITHOUT flag; alt-scan.js overlays
// the flag from alt_flags at read time.
function boardRow(r) {
  return {
    id: r.id, symbol: r.symbol, name: r.name, rank: r.rank,
    price: r.price, mcap: r.mcap, vol24h: r.vol24h,
    chg1h: r.chg1h, chg24h: r.chg24h, chg7d: r.chg7d, chg30d: r.chg30d,
    score: r.score, band: r.band, parts: r.parts, facts: r.facts,
    // The exclusion flags ride along so the client's entry read can name WHY a
    // coin isn't an entry ("parabolic", "too thin") instead of inferring it
    // back out of the band, which collapses both into 'late'.
    flags: r.flags,
    // The acceleration block, already computed at screen time and previously
    // dropped on the floor. It is the FALLBACK pace reference for the ~12h
    // after a deploy when the 12h baseline doesn't exist yet — shipping the
    // cron's own number is what stops the client re-deriving a screener input.
    accel: r.accel,
    // BOTH RS legs. The 30d one was computed at screen time and dropped here,
    // which was invisible until the sheet started drawing the trend block from
    // published fields and could only show half of it.
    turnover: r.turnover, rsVsBtc7d: r.rsVsBtc7d, rsVsBtc30d: r.rsVsBtc30d,
    drawdownFromAthPct: r.drawdownFromAthPct,
    range7d: {
      low: r.range7d.low, high: r.range7d.high, pos: r.range7d.pos,
      freshBreak: r.range7d.freshBreak, priorHigh: r.range7d.priorHigh, priorLow: r.range7d.priorLow,
      // How many closes the structure was read from. Guards exactly one claim:
      // "breaking out" must not be asserted off a 30-point series, where
      // structure7d's "one day" is really about four hours.
      points: r.range7d.points,
    },
    spark: sampleSpark(r.sparkline7d, SPARK_POINTS),
    targets: r.targets || null,
  };
}

async function runPass() {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const counts = {
    universe: 0, eligible: 0, board: 0, sparkRef4h: 0,
    flagsInserted: 0, flagsUpdated: 0, flagsClosed: 0,
    snapshotWritten: false, stateWritten: false,
  };
  const errors = [];

  // ── fetch (three keyless calls; each failure degrades, none aborts) ──
  const [mktRes, globRes, fngRes] = await Promise.allSettled([
    fetchJson(MARKETS_URL),
    fetchJson(GLOBAL_URL),
    fetchJson(FNG_URL),
  ]);

  let global = null;
  if (globRes.status === "fulfilled") {
    const d = globRes.value && globRes.value.data;
    const dom = fin(d && d.market_cap_percentage && d.market_cap_percentage.btc);
    if (dom != null) {
      global = {
        btcDominance: dom,
        totalMcapUsd: fin(d.total_market_cap && d.total_market_cap.usd),
        mcapChange24hPct: fin(d.market_cap_change_percentage_24h_usd),
      };
    } else errors.push("global: payload carries no BTC dominance");
  } else errors.push(`global: ${settledError(globRes)}`);

  let fng = null;
  if (fngRes.status === "fulfilled") {
    const d = Array.isArray(fngRes.value && fngRes.value.data) ? fngRes.value.data[0] : null;
    fng = normFearGreed(d && { value: d.value, label: d.value_classification });
  } else errors.push(`fear & greed: ${settledError(fngRes)}`);

  let universe = null;
  if (mktRes.status === "fulfilled" && Array.isArray(mktRes.value)) {
    const parsed = mktRes.value.map(parseMarketsRow).filter(Boolean);
    counts.universe = parsed.length;
    // A MINIMUM-UNIVERSE GATE, which the equity engine has always had (it
    // refuses to publish a board under 80% coverage) and this one did not.
    // `universe && universe.length` accepted ANY non-empty page, so a
    // truncated response during a CoinGecko incident — or a burst of rows
    // whose price came back null and got filtered out here — rebuilt the whole
    // board and RE-DERIVED THE SEASON SCORE off whatever survived. The board
    // silently shrank from sixty rows to a handful, coins the reader was
    // tracking vanished, breadth was computed over a biased sample of the very
    // largest caps, and it all stood for an hour until the next pass.
    //
    // Below the floor the pass keeps everything it can that does not depend on
    // the universe — dominance, fear & greed, the flag transitions — and
    // leaves the stored board alone, which is the same trade the equity side
    // makes: a stale complete board beats a fresh partial one.
    if (parsed.length >= MIN_UNIVERSE) {
      universe = parsed;
    } else {
      errors.push(`markets returned ${parsed.length} usable rows (need ${MIN_UNIVERSE}) — board and season left as they were`);
      counts.universeRejected = parsed.length;
    }
  } else {
    errors.push(`markets: ${mktRes.status === "fulfilled" ? "malformed payload" : settledError(mktRes)}`);
  }

  // ── narratives, AFTER the three calls above and never alongside them. The
  // board, the season score and the snapshot all depend on that markets page;
  // this depends on nothing and nothing depends on it. Firing thirteen extra
  // requests into the same rate-limit budget BEFORE the critical path resolves
  // is how a nice-to-have card takes the whole tab down for an hour. ──
  const { index: catIndex, pages: catPages } = await fetchCohorts(errors);
  const narratives = cohortRead(catIndex, catPages);
  counts.cohorts = narratives.cohorts.length;

  const configured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  const db = configured
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        db: { schema: "boardroom" },
        auth: { persistSession: false },
      })
    : null;
  if (!db) errors.push("supabase env not set — nothing persisted this pass");

  // ── prior state: domHistory rides inside the payload between passes, but
  // the DURABLE copy is alt_snapshots.btc_dominance — a transient read failure
  // here must never be able to shorten the series. Two defenses: a failed read
  // is remembered and blocks this pass's alt_state upsert outright (the next
  // pass repairs; one stale hour is cheap, a truncated series is forever), and
  // a missing/thin in-payload history is rebuilt from the snapshots before the
  // day's sample is merged, so even a genuinely lost payload recovers. ──
  let prevPayload = null;
  let prevReadFailed = false;
  if (db) {
    const { data, error } = await db.from("alt_state").select("payload").eq("id", "latest").maybeSingle();
    if (error) { prevReadFailed = true; errors.push(`alt_state read: ${error.message}`); }
    else prevPayload = (data && data.payload) || null;
  }

  let domHistory = Array.isArray(prevPayload && prevPayload.domHistory) ? prevPayload.domHistory : [];
  if (db && domHistory.length < 2) {
    const { data, error } = await db.from("alt_snapshots")
      .select("taken_at, btc_dominance")
      .not("btc_dominance", "is", null)
      .order("taken_at", { ascending: true })
      .limit(2400);
    if (error) errors.push(`domHistory rebuild: ${error.message}`);
    else for (const r of data || []) {
      const t = parseTs(r.taken_at);
      const dom = Number(r.btc_dominance);
      if (t != null && Number.isFinite(dom)) domHistory = mergeDomSample(domHistory, t, dom);
    }
  }
  if (global) domHistory = mergeDomSample(domHistory, now, global.btcDominance);

  // ── the score's own daily series, carried in the payload the way domHistory
  // is. Merged AFTER the season read below (it needs this pass's score), so
  // only the prior series is loaded here. ──
  let scoreHistory = Array.isArray(prevPayload && prevPayload.scoreHistory) ? prevPayload.scoreHistory : [];

  // ── the math (needs the universe; everything else degrades around it) ──
  let season = null;
  let eligible = null;
  let ladder = null;
  if (universe && universe.length) {
    const btcRow = universe.find((r) => r.symbol === "BTC") || null;
    const ethRow = universe.find((r) => r.symbol === "ETH") || null;
    season = seasonRead({ universe, btcRow, ethRow, fearGreed: fng, domHistory, now });
    eligible = screenUniverse(universe, { btcRow, ethRow, season, now });
    for (const row of eligible) row.targets = targetsFor(row);
    counts.eligible = eligible.length;
    // The ladder reads the WHOLE fetched universe, not `eligible` — it is a
    // measurement of the market, and screening it first would compute the
    // median return of the coins that scored well, which is a different and
    // much less honest number.
    ladder = capitalLadder(universe);
    counts.ladderLead = ladder.leadKey || "none";
    if (season && season.score != null) scoreHistory = mergeScoreSample(scoreHistory, now, season.score);
  }
  const scoreDrift = scoreDriftOf(scoreHistory);

  // ── snapshot: written whenever EITHER feed resolved. The two columns serve
  // different consumers — prices feed the 4h/12h baselines, dominance feeds
  // the season trend — and neither may hold the other hostage: a /global 429
  // with 250 priced rows writes prices with null dominance, a dead markets
  // feed with a live /global writes dominance with empty prices (the baseline
  // chooser skips empty rows). This row is the one thing a missed hour never
  // gets back. ──
  if (db && (global || (eligible && eligible.length))) {
    const prices = {};
    if (eligible) for (const r of eligible) if (Number.isFinite(r.price)) prices[r.id] = r.price;
    const ins = await db.from("alt_snapshots").insert({
      taken_at: nowIso,
      btc_dominance: global ? global.btcDominance : null,
      fear_greed: fng ? fng.value : null,
      prices,
    });
    if (ins.error) errors.push(`snapshot insert: ${ins.error.message}`);
    else counts.snapshotWritten = true;

    const del = await db.from("alt_snapshots").delete()
      .lt("taken_at", new Date(now - SNAPSHOT_KEEP_DAYS * DAY).toISOString());
    if (del.error) errors.push(`snapshot prune: ${del.error.message}`);
  }

  // ── flags: read open episodes, transition, apply ──
  if (db && eligible) {
    const { data: openRows, error } = await db.from("alt_flags").select("*").is("resolved_at", null);
    if (error) errors.push(`flags read: ${error.message}`);
    else {
      const byId = new Map(eligible.map((r) => [r.id, r]));
      // The regime sets both the bar and the budget — see PHASE_GATE.
      const gate = gateFor(season);
      counts.gate = `${season && season.phase ? season.phase : "unrated"} max${gate.max}/floor${gate.floor}`;
      const { inserts, updates } = transitionFlags(openRows || [], byId, now, gate);

      if (inserts.length) {
        // ignoreDuplicates: a coin closed and re-flagged inside one UTC day
        // collides with the closed episode's id — dropped, never resurrected.
        // Cross-day double-opens (two overlapping passes that both read before
        // either wrote) are refused by the DB instead: alt_flags_one_open_uidx
        // is a partial unique index on (coin_id) where resolved_at is null, so
        // the stale pass's insert errors and is logged, not applied.
        // .select("id") so flagsInserted counts rows the DB actually kept,
        // not rows the dedupe silently dropped.
        const up = await db.from("alt_flags").upsert(inserts, { onConflict: "id", ignoreDuplicates: true }).select("id");
        if (up.error) errors.push(`flag insert: ${up.error.message}`);
        else counts.flagsInserted = (up.data || []).length;
      }
      if (updates.length) {
        // ONE round trip for every changed flag, not one PER flag — this was
        // the loop that killed the pass (see the header). Each row is spread
        // over its ORIGINAL columns (openById), never the bare patch: a
        // multi-row upsert unions the column set across the whole batch, and
        // a row missing a column another row in the batch supplies would get
        // that column nulled rather than left alone. Full rows in, full rows
        // out, every time.
        //
        // Trade made in exchange for the batch: the old per-row
        // `.is("resolved_at", null)` compare-and-swap is gone, so a second
        // pass overlapping this one could in principle resurrect a row this
        // pass just closed. Netlify does not double-fire one cron slot and
        // this is a single-owner console, not a multi-writer system — that
        // risk is accepted, not overlooked.
        const openById = new Map((openRows || []).map((r) => [r.id, r]));
        const rows = updates.map((u) => ({ ...openById.get(u.id), ...u }));
        const up = await db.from("alt_flags").upsert(rows, { onConflict: "id" }).select("id");
        if (up.error) errors.push(`flag update: ${up.error.message}`);
        else {
          counts.flagsUpdated = (up.data || []).length;
          counts.flagsClosed = updates.filter((u) => u.resolved_at).length;
        }
      }
    }
  }

  // ── baselines for the 4h/12h mover windows: the stored snapshot nearest
  // now−4h / now−12h, tolerance ±45min. readyIn tells the UI how long until a
  // missing window can be measured instead of leaving a silent blank. ──
  const baselines = { "4h": null, "12h": null };
  const baselineMeta = { "4h": null, "12h": null };
  const readyIn = { "4h": null, "12h": null };
  if (db) {
    const windows = [["4h", 4], ["12h", 12]];
    // Two independent lookups — parallel, not sequential (the flags loop above
    // is the one that actually scales with data; this pair is fixed at two
    // round trips regardless, but there's no reason to pay for them in series).
    const results = await Promise.all(windows.map(([key, hours]) => {
      const target = now - hours * HOUR;
      return db.from("alt_snapshots")
        .select("taken_at, prices")
        .gte("taken_at", new Date(target - BASELINE_TOLERANCE_MS).toISOString())
        .lte("taken_at", new Date(target + BASELINE_TOLERANCE_MS).toISOString())
        .then((res) => ({ key, target, ...res }));
    }));
    for (const { key, target, data, error } of results) {
      if (error) { errors.push(`baseline ${key}: ${error.message}`); continue; }
      const best = (data || [])
        .filter((r) => r.prices && typeof r.prices === "object" && Object.keys(r.prices).length > 0)
        .sort((a, b) => Math.abs((parseTs(a.taken_at) ?? 0) - target) - Math.abs((parseTs(b.taken_at) ?? 0) - target))[0];
      if (best) {
        baselines[key] = best.prices;
        baselineMeta[key] = { takenAt: best.taken_at };
      }
    }
    if (!baselines["4h"] || !baselines["12h"]) {
      const { data } = await db.from("alt_snapshots").select("taken_at").order("taken_at", { ascending: true }).limit(1);
      const oldest = data && data[0] ? parseTs(data[0].taken_at) : null;
      const oldestAgeH = oldest != null ? Math.max(0, (now - oldest) / HOUR) : 0;
      for (const [key, hours] of windows) {
        if (baselines[key]) continue;
        // A snapshot qualifies once it is (window − tolerance) old. When the
        // oldest row is already past that and the window is still empty (a gap
        // in the series), the row this pass just wrote is the honest clock.
        const need = hours - BASELINE_TOLERANCE_MS / HOUR;
        readyIn[key] = Math.max(1, Math.ceil(oldestAgeH >= need ? need : need - oldestAgeH));
      }
    }
  }

  // ── alt_state: only a pass that produced a board overwrites the board. A
  // dead markets feed must not refresh updated_at and hide its own staleness
  // behind a re-upserted copy of the old payload — and a pass whose READ of
  // the prior payload failed must not write at all, because it cannot know
  // what its overwrite would destroy (see the domHistory block above). ──
  if (db && season && eligible && !prevReadFailed) {
    const board = eligible.slice(0, BOARD_SIZE).map(boardRow);
    counts.board = board.length;
    // Sparkline-derived reference prices for the 4h/12h windows, for EVERY
    // eligible coin rather than just the 60 on the board — the movers lists
    // rank over the whole eligible set, and a reference map that stopped at
    // the board would silently cap those two windows at the board's coins.
    // Same {id: price} shape as `baselines` so alt-scan can fall back to it
    // with one lookup. See priceAgo() for why this exists next to snapshots.
    const sparkRef = { "4h": {}, "12h": {} };
    for (const r of eligible) {
      const p4 = priceAgo(r.sparkline7d, 4);
      const p12 = priceAgo(r.sparkline7d, 12);
      if (p4 != null) sparkRef["4h"][r.id] = p4;
      if (p12 != null) sparkRef["12h"][r.id] = p12;
    }
    counts.sparkRef4h = Object.keys(sparkRef["4h"]).length;
    const payload = {
      asOf: nowIso,
      // The gate rides with the season because it IS the season's consequence:
      // the page can then say out loud how short the shortlist is allowed to
      // be right now and how good a setup has to be to make it, instead of
      // leaving "why is this list empty / why is it long" to be guessed at.
      season: { ...season, gate: gateFor(season) },
      global: global
        ? { totalMcapUsd: global.totalMcapUsd, mcapChange24hPct: global.mcapChange24hPct, btcDominance: global.btcDominance }
        : null,
      board,
      eligibleIds: eligible.map((r) => r.id),
      baselines,
      baselineMeta,
      sparkRef,
      readyIn,
      domHistory,
      // ── the three interpretive layers, published beside the board rather
      // than derived from it. Each answers a question that sits ABOVE the
      // individual coin, which is the whole reason the tab needed them: the
      // ladder says which part of the risk curve is bid, the narratives say
      // which theme is, and the drift says which way the regime is travelling.
      ladder,
      scoreHistory,
      scoreDrift,
      cohorts: narratives.cohorts,
      cohortRead: { leadId: narratives.leadId, read: narratives.read },
      // coinId → cohortId. alt-scan needs this to compute each row's excess
      // against its own cohort at LIVE prices; publishing the map rather than
      // the excess is what keeps that subtraction on the live side.
      coinCohort: narratives.coinCohort,
    };
    const up = await db.from("alt_state").upsert({ id: "latest", updated_at: nowIso, payload });
    if (up.error) errors.push(`alt_state upsert: ${up.error.message}`);
    else counts.stateWritten = true;
  }

  console.log(
    `[alt-cron-background] universe=${counts.universe} eligible=${counts.eligible} board=${counts.board} ` +
    `sparkRef4h=${counts.sparkRef4h} gate=${counts.gate || "n/a"} ` +
    `ladder=${counts.ladderLead || "n/a"} cohorts=${counts.cohorts ?? 0} ` +
    `flags +${counts.flagsInserted} ~${counts.flagsUpdated} closed=${counts.flagsClosed} ` +
    `snapshot=${counts.snapshotWritten} state=${counts.stateWritten} ` +
    `season=${season && season.score != null ? `${season.score}/${season.phase}` : "none"}` +
    (errors.length ? ` errors=${errors.length} [${errors.join(" | ")}]` : ""),
  );

  return { counts, errors };
}

// Scheduled hourly via netlify.toml, as a background invocation — the caller
// (Netlify's scheduler) gets an immediate ack the moment this starts, and
// runPass() keeps running for up to fifteen minutes regardless of what gets
// returned below. Netlify production does NOT route public HTTP to a
// scheduled function either way; the ping and POST paths here are reachable
// only under `netlify dev`. Do not add alt-cron-background to the Status
// tab's ping list: the row would read "down" forever while the cron runs
// fine. Counts only on every path — the payload never leaves through this
// endpoint, and error DETAIL stays in the function log (an unauthenticated
// dev-mode caller gets a count, not our table names).
exports.handler = async (event) => {
  const configured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  let body = {};
  try { body = JSON.parse((event && event.body) || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "alt-cron-background", configured, scheduled: true });

  try {
    const { counts, errors } = await runPass();
    return json(200, { success: true, service: "alt-cron-background", counts, errorCount: errors.length });
  } catch (e) {
    // The outer net — anything here is a bug, not a market condition, and it
    // still must not surface as a failed scheduled invocation.
    console.error("alt-cron-background failed:", e);
    return json(200, { success: false, service: "alt-cron-background", error: String((e && e.message) || e) });
  }
};

// Pure helpers, exported for scripts/altseason-smoke.mjs (the calendar.js
// precedent — Netlify only reads `handler`).
exports.parseMarketsRow = parseMarketsRow;
exports.priceAgo = priceAgo;
exports.isStablecoin = isStablecoin;
exports.isWrapper = isWrapper;
exports.structure7d = structure7d;
exports.screenCoin = screenCoin;
exports.screenUniverse = screenUniverse;
exports.seasonRead = seasonRead;
exports.targetsFor = targetsFor;
exports.flagTier = flagTier;
exports.transitionFlags = transitionFlags;
exports.gateFor = gateFor;
exports.PHASE_GATE = PHASE_GATE;
exports.domTrendOf = domTrendOf;
exports.DOM_WINDOW_DAYS = DOM_WINDOW_DAYS;
exports.DOM_KEEP_DAYS = DOM_KEEP_DAYS;
exports.capitalLadder = capitalLadder;
exports.mergeScoreSample = mergeScoreSample;
exports.scoreDriftOf = scoreDriftOf;
exports.parseCategoryIndex = parseCategoryIndex;
exports.cohortStats = cohortStats;
exports.cohortRead = cohortRead;
exports.NARRATIVES = NARRATIVES;
