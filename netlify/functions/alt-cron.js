// ─── alt-cron — the hourly alt-season brain ──────────────────────────────────
// Scheduled hourly (netlify.toml). Does ALL the heavy math for the Markets →
// Alt Season tab so the client-facing alt-scan.js stays light: three keyless
// HTTP calls, screen the top 250, read the rotation regime, compute targets,
// tier flags, transition the flag log, and persist everything to Supabase
// (schema "boardroom"). Zero LLM calls, by design.
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
const GLOBAL_URL = "https://api.coingecko.com/api/v3/global";
const FNG_URL = "https://api.alternative.me/fng/?limit=1";

const FETCH_TIMEOUT_MS = 8000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const SNAPSHOT_KEEP_DAYS = 100; // baselines need 12h; 100d gives the record depth
const DOM_KEEP_DAYS = 90;
const DOM_CAP = 2000;
const BOARD_SIZE = 60;
const SPARK_POINTS = 28;
const BASELINE_TOLERANCE_MS = 45 * 60 * 1000; // a snapshot within ±45min "is" the window

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

  // ── relative strength vs BTC (0–25) ──
  parts.push({
    key: "rs7", max: 15, points: step(rsVsBtc7d, RS7),
    label: rsVsBtc7d == null ? "no 7d RS (BTC or coin 7d missing)" : `7d RS vs BTC ${pts(rsVsBtc7d)}`,
  });
  parts.push({
    key: "rs30", max: 10, points: step(rsVsBtc30d, RS30),
    label: rsVsBtc30d == null ? "no 30d RS (BTC or coin 30d missing)" : `30d RS vs BTC ${pts(rsVsBtc30d)}`,
  });
  if (rsVsBtc7d != null) facts.push(`7d ${pct(chg7d)} vs BTC ${pct(btc7d)} — ${pts(rsVsBtc7d)} of relative strength`);
  if (rsVsBtc30d != null) facts.push(`30d ${pct(chg30d)} vs BTC ${pct(btc30d)} — ${pts(rsVsBtc30d)}`);

  // ── acceleration (0–30) — the "starting, not started" block ──
  parts.push({
    key: "accel24", max: 18, points: step(d24VsWeek, A24),
    label: d24VsWeek == null ? "no 24h acceleration (24h or 7d missing)" : `24h vs the week's pace ${pts(d24VsWeek)}`,
  });
  parts.push({
    key: "accel7v30", max: 12, points: step(weekVsMonth, A7V30),
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
    key: "turnover", max: 15, points: step(turnover, TURN),
    label: turnover == null ? "no turnover (volume or market cap missing)" : `turnover ${(turnover * 100).toFixed(1)}% of cap`,
  });
  if (turnover != null) {
    facts.push(`${usd(row.vol24h)} traded on a ${usd(row.mcap)} cap — ${(turnover * 100).toFixed(1)}% of the float in a day`);
  }

  // ── 7-day structure (0–20) ──
  parts.push({
    key: "range", max: 10, points: step(range7d.pos, POS),
    label: range7d.pos == null ? "no 7d range (sparkline missing or flat)" : `${Math.round(range7d.pos * 100)}% up its own 7d range`,
  });
  parts.push({
    key: "break", max: 10, points: range7d.freshBreak ? 10 : 0,
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
    key: "room", max: 10, points: step(drawdownFromAthPct, ROOM),
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
    parts.push({ key: "parabolic", max: 0, points: applied, label: "parabolic — already gone" });
    facts.push(chg24h != null && chg24h > PARABOLIC_24H
      ? `PARABOLIC: ${pct(chg24h)} in 24h — this is a chase, not an entry`
      : `PARABOLIC: ${pct(chg7d)} in 7d — this is a chase, not an entry`);
  }
  if (thinLiquidity) {
    const applied = -Math.min(budget, 15);
    budget += applied;
    parts.push({ key: "thin", max: 0, points: applied, label: "too thin to trade" });
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
  const ethBtc = computeEthBtc(ethRow, btcRow, facts);
  const fg = normFearGreed(fearGreed, facts);

  const empty = (label) => ({
    score: null, phase: null, label,
    parts: [], facts,
    breadth7d: breadth.beatBtc7dPct, breadth30d: breadth.beatBtc30dPct,
    fearGreed: fg ? fg.value : null,
    ethBtc7d: ethBtc ? ethBtc.chg7dPct : null,
    domTrend: dom.trend,
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
 */
function domTrendOf(domHistory, facts = []) {
  const rows = (Array.isArray(domHistory) ? domHistory : [])
    .filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.dom))
    .sort((a, b) => a.t - b.t);
  if (rows.length === 0) return { trend: null, changePts: null, samples: 0 };
  const newest = rows[rows.length - 1].t;
  const window = rows.filter((s) => s.t > newest - DOM_WINDOW_DAYS * DAY);
  if (window.length < MIN_DOM_SAMPLES) {
    facts.push(`${window.length} recent dominance sample${window.length === 1 ? "" : "s"} stored — the trend needs ${MIN_DOM_SAMPLES} and stays unknown until then`);
    return { trend: null, changePts: null, samples: window.length };
  }
  const change = window[window.length - 1].dom - window[0].dom;
  const trend = change < -DOM_FLAT_PTS ? "falling" : change > DOM_FLAT_PTS ? "rising" : "flat";
  facts.push(`BTC dominance ${trend}: ${signed(change, 2)} pts over the last ${DOM_WINDOW_DAYS} days${trend === "falling" ? " — capital is leaving BTC" : ""}`);
  return { trend, changePts: change, samples: window.length };
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
 *   Clamps: T1 under +4% is not a target worth flagging (bumped to +5%);
 *     T1<T2<T3 strictly (≥2% steps); an invalidation at or above price×0.99
 *     means the structure is already lost — no targets at all.
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

  if (t1 < price * 1.04) t1 = price * 1.05;
  if (t2 <= t1) t2 = t1 * 1.02;
  if (t3 <= t2) t3 = t2 * 1.02;
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

function flagTier(row) {
  if (!row || !Number.isFinite(row.score)) return null;
  if (isExcluded(row)) return null;
  if (String(row.symbol ?? "").toUpperCase() === "BTC") return null;
  if (!Number.isFinite(row.vol24h) || row.vol24h < 1e6) return null;
  if (row.flags && row.flags.thinLiquidity) return null;
  const t = row.targets;
  if (!t || !Number.isFinite(t.t1Pct) || t.t1Pct < 5) return null;

  if (igniteCond(row)) return "igniting";
  if (row.band === "warming" && row.score >= 50) return "building";
  const pos = row.range7d && Number.isFinite(row.range7d.pos) ? row.range7d.pos : null;
  if (row.band === "quiet" && row.score >= 45 && pos != null && pos >= 0.55 &&
      Number.isFinite(row.rsVsBtc7d) && row.rsVsBtc7d > 0) return "building";
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
 * invalidation, not a hit erased.
 *
 * @param openRows      alt_flags rows with resolved_at null (DB column names)
 * @param screenedById  Map (or plain object) id → screened row with .targets
 * @param asOf          ms epoch
 * @returns { inserts: [row…], updates: [{ id, …changed columns }…] }
 */
function transitionFlags(openRows, screenedById, asOf) {
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
  for (const s of screenedRows) {
    if (!s || !s.id || openCoins.has(s.id)) continue;
    const tier = flagTier(s);
    if (!tier) continue;
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
    turnover: r.turnover, rsVsBtc7d: r.rsVsBtc7d,
    drawdownFromAthPct: r.drawdownFromAthPct,
    range7d: {
      low: r.range7d.low, high: r.range7d.high, pos: r.range7d.pos,
      freshBreak: r.range7d.freshBreak, priorHigh: r.range7d.priorHigh, priorLow: r.range7d.priorLow,
    },
    spark: sampleSpark(r.sparkline7d, SPARK_POINTS),
    targets: r.targets || null,
  };
}

async function runPass() {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const counts = {
    universe: 0, eligible: 0, board: 0,
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
    universe = mktRes.value.map(parseMarketsRow).filter(Boolean);
    counts.universe = universe.length;
  } else {
    errors.push(`markets: ${mktRes.status === "fulfilled" ? "malformed payload" : settledError(mktRes)}`);
  }

  const configured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  const db = configured
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        db: { schema: "boardroom" },
        auth: { persistSession: false },
      })
    : null;
  if (!db) errors.push("supabase env not set — nothing persisted this pass");

  // ── prior state: domHistory lives inside the payload and survives passes ──
  let prevPayload = null;
  if (db) {
    const { data, error } = await db.from("alt_state").select("payload").eq("id", "latest").maybeSingle();
    if (error) errors.push(`alt_state read: ${error.message}`);
    else prevPayload = (data && data.payload) || null;
  }

  let domHistory = Array.isArray(prevPayload && prevPayload.domHistory) ? prevPayload.domHistory : [];
  if (global) domHistory = mergeDomSample(domHistory, now, global.btcDominance);

  // ── the math (needs the universe; everything else degrades around it) ──
  let season = null;
  let eligible = null;
  if (universe && universe.length) {
    const btcRow = universe.find((r) => r.symbol === "BTC") || null;
    const ethRow = universe.find((r) => r.symbol === "ETH") || null;
    season = seasonRead({ universe, btcRow, ethRow, fearGreed: fng, domHistory, now });
    eligible = screenUniverse(universe, { btcRow, ethRow, season, now });
    for (const row of eligible) row.targets = targetsFor(row);
    counts.eligible = eligible.length;
  }

  // ── snapshot: written whenever dominance resolved, even with a dead markets
  // feed (prices then empty — a baseline chooser skips empty rows). This row
  // is the one thing a missed hour never gets back. ──
  if (db && global) {
    const prices = {};
    if (eligible) for (const r of eligible) if (Number.isFinite(r.price)) prices[r.id] = r.price;
    const ins = await db.from("alt_snapshots").insert({
      taken_at: nowIso,
      btc_dominance: global.btcDominance,
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
      const { inserts, updates } = transitionFlags(openRows || [], byId, now);

      if (inserts.length) {
        // ignoreDuplicates: a coin closed and re-flagged inside one UTC day
        // collides with the closed episode's id — dropped, never resurrected.
        const up = await db.from("alt_flags").upsert(inserts, { onConflict: "id", ignoreDuplicates: true });
        if (up.error) errors.push(`flag insert: ${up.error.message}`);
        else counts.flagsInserted = inserts.length;
      }
      for (const u of updates) {
        const { id, ...patch } = u;
        const res = await db.from("alt_flags").update(patch).eq("id", id);
        if (res.error) errors.push(`flag update ${id}: ${res.error.message}`);
        else {
          counts.flagsUpdated++;
          if (patch.resolved_at) counts.flagsClosed++;
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
    for (const [key, hours] of windows) {
      const target = now - hours * HOUR;
      const { data, error } = await db.from("alt_snapshots")
        .select("taken_at, prices")
        .gte("taken_at", new Date(target - BASELINE_TOLERANCE_MS).toISOString())
        .lte("taken_at", new Date(target + BASELINE_TOLERANCE_MS).toISOString());
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
  // behind a re-upserted copy of the old payload. ──
  if (db && season && eligible) {
    const board = eligible.slice(0, BOARD_SIZE).map(boardRow);
    counts.board = board.length;
    const payload = {
      asOf: nowIso,
      season,
      global: global
        ? { totalMcapUsd: global.totalMcapUsd, mcapChange24hPct: global.mcapChange24hPct, btcDominance: global.btcDominance }
        : null,
      board,
      eligibleIds: eligible.map((r) => r.id),
      baselines,
      baselineMeta,
      readyIn,
      domHistory,
    };
    const up = await db.from("alt_state").upsert({ id: "latest", updated_at: nowIso, payload });
    if (up.error) errors.push(`alt_state upsert: ${up.error.message}`);
    else counts.stateWritten = true;
  }

  console.log(
    `[alt-cron] universe=${counts.universe} eligible=${counts.eligible} board=${counts.board} ` +
    `flags +${counts.flagsInserted} ~${counts.flagsUpdated} closed=${counts.flagsClosed} ` +
    `snapshot=${counts.snapshotWritten} state=${counts.stateWritten} ` +
    `season=${season && season.score != null ? `${season.score}/${season.phase}` : "none"}` +
    (errors.length ? ` errors=${errors.length} [${errors.join(" | ")}]` : ""),
  );

  return { counts, errors };
}

// Scheduled hourly via netlify.toml. Counts only on every path — the payload
// itself never leaves through this endpoint, so an unscheduled POST costs the
// caller nothing but our upstream quota, and a ping costs nothing at all.
exports.handler = async (event) => {
  const configured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  let body = {};
  try { body = JSON.parse((event && event.body) || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "alt-cron", configured, scheduled: true });

  try {
    const { counts, errors } = await runPass();
    return json(200, { success: true, service: "alt-cron", counts, errors });
  } catch (e) {
    // The outer net — anything here is a bug, not a market condition, and it
    // still must not surface as a failed scheduled invocation.
    console.error("alt-cron failed:", e);
    return json(200, { success: false, service: "alt-cron", error: String((e && e.message) || e) });
  }
};

// Pure helpers, exported for scripts/altseason-smoke.mjs (the calendar.js
// precedent — Netlify only reads `handler`).
exports.parseMarketsRow = parseMarketsRow;
exports.isStablecoin = isStablecoin;
exports.isWrapper = isWrapper;
exports.structure7d = structure7d;
exports.screenCoin = screenCoin;
exports.screenUniverse = screenUniverse;
exports.seasonRead = seasonRead;
exports.targetsFor = targetsFor;
exports.flagTier = flagTier;
exports.transitionFlags = transitionFlags;
