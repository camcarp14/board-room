// Client-facing read for the Alt Season tab. The hourly alt-cron-background
// does all the heavy math (screening, season score, flag transitions) and
// persists its verdict to boardroom.alt_state; this function just composes
// that stored verdict with the open/recent episodes in boardroom.alt_flags
// and one live CoinGecko quote pass, so prices on screen are seconds old even
// though the screener only runs hourly. The live fetch failing is NOT an
// error — the stored board prices are served with stale:true and the UI says
// so. Scores, bands, targets, and season parts are never recomputed here: one
// brain (alt-cron-background), one mouth (this).
//
// Self-contained by house rule — see the scripts/functions-smoke.mjs header
// for the outage that rule paid for.
const { createClient } = require("@supabase/supabase-js");

let cache = { data: null, ts: 0 };
const TTL_MS = 60 * 1000;
// The screener runs hourly; if alt_state hasn't been touched in 2h something
// upstream is wrong and the tab should say "stale" rather than look current.
const STATE_STALE_MS = 2 * 60 * 60 * 1000;

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
// % change of `value` off `base`, and % distance of `target` from `price` —
// both 1dp, both null when the denominator can't carry the division.
const pctOff = (value, base) => (Number.isFinite(value) && Number.isFinite(base) && base > 0 ? r1(((value - base) / base) * 100) : null);

// Same universe call the cron makes, minus sparklines — this runs on every
// cache miss, so keep the response as small as CoinGecko allows.
const MARKETS_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=1h%2C24h%2C7d%2C30d";

async function fetchLiveRows() {
  const res = await fetch(MARKETS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("CoinGecko: unexpected shape");
  return rows.map((r) => ({
    id: r.id,
    symbol: String(r.symbol || "").toUpperCase(),
    name: r.name,
    price: num(r.current_price),
    vol24h: num(r.total_volume),
    chg1h: num(r.price_change_percentage_1h_in_currency),
    chg24h: num(r.price_change_percentage_24h_in_currency),
    chg7d: num(r.price_change_percentage_7d_in_currency),
    chg30d: num(r.price_change_percentage_30d_in_currency),
  }));
}

// One alt_flags row → the client episode shape. Open episodes get the live
// price overlaid (peak may ratchet past what the last cron pass recorded);
// closed episodes are history and stay exactly as graded. Target PRICES are
// frozen from flag time — that's the whole point of grading — but the % fields
// are recomputed against the current price so the sheet can show "% away".
function episodeView(row, livePrice) {
  const open = row.resolved_at == null;
  const flagPrice = num(row.flag_price);
  const last = open && Number.isFinite(livePrice) ? livePrice : num(row.last_price);
  const peakStored = num(row.peak_price);
  const peak = open && last != null && (peakStored == null || last > peakStored) ? last : peakStored;

  const t1 = num(row.t1);
  const targets = t1 == null ? null : {
    t1,
    t2: num(row.t2),
    t3: num(row.t3),
    invalidation: num(row.invalidation),
    t1Pct: pctOff(t1, last),
    t2Pct: pctOff(num(row.t2), last),
    t3Pct: pctOff(num(row.t3), last),
    invPct: pctOff(num(row.invalidation), last),
  };

  const view = {
    id: row.id,
    coinId: row.coin_id,
    symbol: row.symbol,
    name: row.name,
    tier: row.tier,
    status: row.status,
    firstFlaggedAt: row.first_flagged_at,
    flagPrice,
    lastPrice: last,
    sinceFlagPct: pctOff(last, flagPrice),
    peakPct: pctOff(peak, flagPrice),
    score: row.score ?? null,
    targets,
  };
  if (!open) view.resolvedAt = row.resolved_at;
  return view;
}

// Base rates over the WHOLE log, open episodes included — an open flag that
// already tagged T2 counts. "Hit T1" is cumulative: reaching T3 implies T1.
function flagStats(rows) {
  const rank = { hit_t1: 1, hit_t2: 2, hit_t3: 3 };
  let hitT1 = 0, hitT2 = 0, hitT3 = 0, invalidated = 0, faded = 0;
  const peaks = [];
  for (const r of rows) {
    const lvl = rank[r.status] || 0;
    if (lvl >= 1) hitT1++;
    if (lvl >= 2) hitT2++;
    if (lvl >= 3) hitT3++;
    if (r.status === "invalidated") invalidated++;
    if (r.status === "faded") faded++;
    const p = pctOff(num(r.peak_price), num(r.flag_price));
    if (p != null) peaks.push(p);
  }
  peaks.sort((a, b) => a - b);
  const mid = peaks.length >> 1;
  const median = !peaks.length ? null : peaks.length % 2 ? peaks[mid] : (peaks[mid - 1] + peaks[mid]) / 2;
  const total = rows.length;
  return {
    total, hitT1, hitT2, hitT3, invalidated, faded,
    // A base rate over two episodes is a lie with a decimal point — hold off.
    hitT1Rate: total >= 3 ? r1((hitT1 / total) * 100) : null,
    medianPeakPct: total >= 3 && median != null ? r1(median) : null,
  };
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (body.ping) return json(200, { success: true, service: "alt-scan", configured });

  if (cache.data && Date.now() - cache.ts < TTL_MS) {
    return json(200, { ...cache.data, cached: true });
  }
  if (!configured) {
    return json(500, { success: false, error: "SUPABASE_SERVICE_ROLE_KEY isn't set in Netlify yet." });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "boardroom" }, auth: { persistSession: false },
    });

    // The stats query re-reads columns the open/closed queries already have,
    // but it's the only one that must span EVERY episode ever logged, and
    // three skinny columns across the whole table is cheaper than shipping
    // full rows for a log that only grows.
    const [stateQ, openQ, closedQ, allQ, liveQ] = await Promise.all([
      supabase.from("alt_state").select("updated_at, payload").eq("id", "latest").maybeSingle(),
      supabase.from("alt_flags").select("*").is("resolved_at", null),
      supabase.from("alt_flags").select("*").not("resolved_at", "is", null).order("resolved_at", { ascending: false }).limit(25),
      supabase.from("alt_flags").select("status, flag_price, peak_price"),
      fetchLiveRows().catch((e) => ({ liveError: e.message || String(e) })),
    ]);

    if (stateQ.error) throw new Error(`alt_state: ${stateQ.error.message}`);
    if (openQ.error) throw new Error(`alt_flags: ${openQ.error.message}`);
    if (closedQ.error) throw new Error(`alt_flags: ${closedQ.error.message}`);
    if (allQ.error) throw new Error(`alt_flags: ${allQ.error.message}`);
    // Two distinct failures, two distinct messages — collapsing them into one
    // generic "hasn't run yet" is exactly what hid the real bug (a growing
    // per-row update loop timing the pass out every hour after the first)
    // behind a message that looked like ordinary first-deploy timing.
    if (!stateQ.data) {
      throw new Error("The screener has never completed a pass — check back once alt-cron-background finishes its first hourly run.");
    }
    if (!stateQ.data.payload) {
      throw new Error(`The screener's last write (${stateQ.data.updated_at || "unknown time"}) has no usable data — that's a bug, not a timing issue.`);
    }
    const payload = stateQ.data.payload;

    const liveRows = Array.isArray(liveQ) ? liveQ : null;
    const liveById = new Map((liveRows || []).map((r) => [r.id, r]));
    const openByCoin = new Map((openQ.data || []).map((r) => [r.coin_id, r]));
    const storedBoard = Array.isArray(payload.board) ? payload.board : [];

    // Board: stored screener rows with live price/chg overlaid. Scores and
    // targets stay as the cron computed them — a fresher price does not make
    // the hourly read fresher, it just stops the tape looking frozen.
    // chg4h/chg12h are OURS, not CoinGecko's: current price against the cron's
    // stored snapshot baselines, per row, so the Crypto board can show every
    // window on every coin. Null until the snapshot series is old enough.
    const chgVsBaseline = (w, id, price) => {
      const base = payload.baselines && payload.baselines[w];
      const b = base ? num(base[id]) : null;
      return b != null && b > 0 && price != null ? r2(((price - b) / b) * 100) : null;
    };
    const board = storedBoard.map((row) => {
      const live = liveById.get(row.id);
      const price = live && live.price != null ? live.price : row.price;
      const openFlag = openByCoin.get(row.id);
      let flag = null;
      if (openFlag) {
        const v = episodeView(openFlag, price);
        flag = {
          tier: v.tier, status: v.status, firstFlaggedAt: v.firstFlaggedAt,
          flagPrice: v.flagPrice, sinceFlagPct: v.sinceFlagPct, peakPct: v.peakPct,
        };
      }
      const chg4h = chgVsBaseline("4h", row.id, price);
      const chg12h = chgVsBaseline("12h", row.id, price);
      if (!live) return { ...row, flag, chg4h, chg12h };
      return {
        ...row,
        price,
        chg1h: live.chg1h ?? row.chg1h,
        chg4h,
        chg12h,
        chg24h: live.chg24h ?? row.chg24h,
        chg7d: live.chg7d ?? row.chg7d,
        chg30d: live.chg30d ?? row.chg30d,
        flag,
      };
    });

    // Movers: live rows when we have them, else the stored board (60 coins
    // beats an empty tab). Always filtered to the cron's eligible set so a
    // stablecoin de-peg or a wrapper can't top the list.
    const eligible = new Set(Array.isArray(payload.eligibleIds) ? payload.eligibleIds : []);
    const universe = liveRows || board;
    const pool = universe.filter((r) => eligible.has(r.id) && r.price != null && (r.vol24h ?? 0) >= 5e5);
    const sparkById = new Map(storedBoard.filter((r) => Array.isArray(r.spark) && r.spark.length).map((r) => [r.id, r.spark]));

    const topBy = (pctOf) => {
      const scored = [];
      for (const r of pool) {
        const pct = pctOf(r);
        if (Number.isFinite(pct)) scored.push({ r, pct });
      }
      scored.sort((a, b) => b.pct - a.pct);
      return scored.slice(0, 12).map(({ r, pct }) => {
        const m = { id: r.id, symbol: r.symbol, name: r.name, price: r.price, pct: r2(pct) };
        const spark = sparkById.get(r.id);
        if (spark) m.spark = spark;
        return m;
      });
    };
    // 4h/12h have no CoinGecko field — they come from our own hourly
    // snapshots. No baseline yet (fresh deploy, snapshot gap) → null, and the
    // UI shows readyIn instead of a fake zero.
    const baselineWindow = (w) => {
      const base = payload.baselines && payload.baselines[w];
      if (!base) return null;
      return topBy((r) => {
        const b = num(base[r.id]);
        return b != null && b > 0 ? ((r.price - b) / b) * 100 : NaN;
      });
    };

    const movers = {
      "1h": topBy((r) => r.chg1h),
      "4h": baselineWindow("4h"),
      "12h": baselineWindow("12h"),
      "24h": topBy((r) => r.chg24h),
      "7d": topBy((r) => r.chg7d),
      "30d": topBy((r) => r.chg30d),
      readyIn: {
        "4h": (payload.readyIn && payload.readyIn["4h"]) ?? null,
        "12h": (payload.readyIn && payload.readyIn["12h"]) ?? null,
      },
    };

    const active = (openQ.data || [])
      .map((row) => episodeView(row, liveById.get(row.coin_id)?.price))
      .sort((a, b) => (a.tier === b.tier ? (b.score || 0) - (a.score || 0) : a.tier === "igniting" ? -1 : 1));
    const recent = (closedQ.data || []).map((row) => episodeView(row));

    const updatedAt = stateQ.data.updated_at || null;
    const stateAgeMs = updatedAt ? Date.now() - Date.parse(updatedAt) : Infinity;

    const out = {
      success: true,
      asOf: payload.asOf || updatedAt,
      liveAsOf: liveRows ? new Date().toISOString() : null,
      cached: false,
      stale: !liveRows || !(stateAgeMs < STATE_STALE_MS),
      season: payload.season || null,
      global: payload.global || null,
      board,
      movers,
      flags: { active, recent, stats: flagStats(allQ.data || []) },
      meta: {
        fetchedAt: new Date().toISOString(),
        sourceDetail: liveRows
          ? "hourly screener + live CoinGecko quotes"
          : `hourly screener; live quotes failed (${liveQ.liveError}) — stored prices`,
      },
    };
    cache = { data: out, ts: Date.now() };
    return json(200, out);
  } catch (e) {
    // Serve stale cache rather than nothing if composition fails.
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message });
  }
};
