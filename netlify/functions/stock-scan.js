// ─── stock-scan — the Stocks tab's read ──────────────────────────────────────
// stock-cron-background does all the judgment (screening, the regime, targets,
// flag transitions) and persists it to boardroom.stock_state; this composes
// that verdict with the open/recent episodes in boardroom.stock_flags and
// serves it. Scores, bands, targets and regime parts are NEVER recomputed
// here: one brain, one mouth.
//
// THIS FUNCTION MAKES ZERO YAHOO CALLS, and that is a load-bearing decision
// rather than an omission. alt-scan overlays a live CoinGecko quote pass on
// every cache miss, which is ONE request for 250 coins. The equity equivalent
// is one request PER SYMBOL — ~50 of them on a 60-second TTL is ~0.8 req/s
// sustained forever, from a SYNCHRONOUS function with a seconds-long budget,
// against an undocumented endpoint that markets.js deliberately caches for five
// minutes over four symbols. It is how this tab 502s and how the identity gets
// blocked. The live overlay lives in the cron's tick pass instead, which
// touches only the names with an open plan on them — and the cost of that
// choice (flagged names up to an hour old, everything else as of the last
// close) is stated in the UI rather than discovered.
//
// Self-contained by house rule — see the scripts/functions-smoke.mjs header.
const { createClient } = require("@supabase/supabase-js");

let cache = { data: null, ts: 0 };
const TTL_MS = 60 * 1000;

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// NULL IS NOT ZERO — Number(null) is 0 and finite. See alt-scan for the bugs
// the obvious version of this shipped.
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const pctOff = (value, base) => (Number.isFinite(value) && Number.isFinite(base) && base > 0 ? r1(((value - base) / base) * 100) : null);

/* ═══ the entry read ═════════════════════════════════════════════════════════
 * Ported from alt-scan verbatim in structure and in ordering — the same three
 * words, the same first-match chain, the same reasons. It is deliberately NOT
 * shared: the house rule is self-contained functions, and the crypto and equity
 * engines must be able to diverge without one silently changing the other.
 *
 *   entry — the first target is still ahead, the invalidation is close enough
 *           to define the risk, and T3 pays at least RR_MIN times the stop
 *   watch — a real structure that hasn't earned an entry yet
 *   late  — parabolic, banded 'late', or past T1: the entry was lower
 */
const RR_MIN = 1.5;

function entryRead(ctx, targets, price) {
  const flags = (ctx && ctx.flags) || {};
  const band = ctx && ctx.band;
  const p = Number.isFinite(price) && price > 0 ? price : null;
  const t = targets || null;

  const roomPct = t ? pctOff(t.t3, p) : null;
  const nextPct = t ? pctOff(t.t1, p) : null;
  const riskPct = t ? pctOff(t.invalidation, p) : null;
  const rr = Number.isFinite(roomPct) && Number.isFinite(riskPct) && riskPct < 0
    ? Math.round((roomPct / -riskPct) * 10) / 10
    : null;

  const out = (state, why) => ({ state, why, roomPct, nextPct, riskPct, rr });

  if (flags.thinLiquidity) return out("late", "too thin to get back out of");
  if (flags.parabolic) return out("late", "parabolic — this is the chase");
  if (band === "late") return out("late", "the move already happened");
  if (!t) return out("watch", "no level worth trading against");
  if (!Number.isFinite(riskPct) || riskPct >= 0) return out("watch", "structure already lost");
  if (Number.isFinite(nextPct) && nextPct <= 0) return out("late", "already through T1 — the entry was lower");
  if (rr != null && rr < RR_MIN) return out("watch", `pays ${rr}× the risk — too thin`);
  if (band === "starting") return out("entry", "closed above its level with the stop close");
  if (band === "underway") return out("entry", "trend intact and T1 still ahead");
  if (band === "warming") return out("watch", "lifting, hasn't taken its level yet");
  if (!band) return out("watch", "off the board — no current read");
  return out("watch", "nothing lifting it yet");
}

/* ═══ the move read ══════════════════════════════════════════════════════════
 * Where the move is, in six stages. Same contract as the crypto side, with two
 * equity-specific differences, both of which come from having true OHLC:
 *
 *   · `probing` — the session's HIGH cleared the level but the CLOSE did not.
 *     Crypto's sparkline is closes only and literally cannot produce this. It
 *     rides as the clause under "At its level", which is exactly the state it
 *     describes: pressing on the level and not through it yet.
 *   · the pace leg compares SESSIONS, not clock windows. There is no 12h
 *     return on a market that shuts at 4pm.
 */
const AT_LEVEL_PCT = -3;
const BREAK_MIN_SESSIONS = 12;    // a break claimed off fewer bars than this is noise
const MOTION_PP = 0.5;            // one session's excess pace, in points
const OFF_PEAK_NOISE = -5;

function moveRead(ctx, targets, price, episode) {
  const flags = (ctx && ctx.flags) || {};
  const range = (ctx && ctx.range20) || null;
  const t = targets || null;
  const p = Number.isFinite(price) && price > 0 ? price : null;

  // Distance to the LEVEL — priorHigh, drawn from sessions that are DONE.
  // range20.high is a range denominator and would make the level move with the
  // price it is compared against. Guarded on > 0 because price/null is
  // Infinity, not null, which is exactly how a number like this ships broken.
  const priorHigh = range && Number.isFinite(range.priorHigh) && range.priorHigh > 0 ? range.priorHigh : null;
  const toLevelPct = priorHigh != null && p != null ? r1((p / priorHigh - 1) * 100) : null;

  // Is it accelerating: the last session against the week's own pace. The cron
  // already computed this as a screener input, so the client never re-derives
  // one — it is read, not recalculated.
  const a = ctx && ctx.accel ? num(ctx.accel.dSessionVsWeek) : null;
  const motion = a == null ? null : a >= MOTION_PP ? "up" : a <= -MOTION_PP ? "down" : "flat";

  const since = num(episode && episode.sinceFlagPct);
  const peak = num(episode && episode.peakPct);
  // NOT peakPct − sinceFlagPct: both are percentages off the same flagPrice
  // base, so their difference is percentage points of flagPrice rather than
  // percent off the peak — an overstatement that grows with the size of the
  // move, i.e. worst on the winners.
  const offPeakRaw = since != null && peak != null && 1 + peak / 100 > 0.01
    ? r1(((1 + since / 100) / (1 + peak / 100) - 1) * 100)
    : null;

  const out = (stage) => ({
    stage,
    thin: !!flags.thinLiquidity,
    motion,
    toLevelPct,
    probing: !!(range && range.probing),
    offPeakPct: offPeakRaw != null && offPeakRaw <= OFF_PEAK_NOISE ? offPeakRaw : null,
  });

  if (!t) return out("none");
  if (Number.isFinite(t.invPct) && t.invPct >= 0) return out("broken");
  if (flags.parabolic || (Number.isFinite(t.t3Pct) && t.t3Pct <= 0)) return out("spent");
  if (Number.isFinite(t.t1Pct) && t.t1Pct <= 0) return out("extending");
  if (!range) return out("offboard");
  if ((flags.freshBreak && (range.sessions ?? 0) >= BREAK_MIN_SESSIONS) || (toLevelPct != null && toLevelPct > 0)) return out("breaking");
  if (toLevelPct != null && toLevelPct >= AT_LEVEL_PCT) return out("atLevel");
  if (range.pos != null) return out("base");
  return out("offboard");
}

/** Target PRICES are the cron's and never move; the % distances are live. */
function liveTargets(t, price) {
  if (!t || !Number.isFinite(price) || !(price > 0)) return t || null;
  return {
    ...t,
    t1Pct: pctOff(t.t1, price), t2Pct: pctOff(t.t2, price),
    t3Pct: pctOff(t.t3, price), invPct: pctOff(t.invalidation, price),
  };
}

/** One stock_flags row → the client episode shape. */
function episodeView(row, livePrice) {
  const open = row.resolved_at == null;
  const flagPrice = num(row.flag_price);
  const last = open && Number.isFinite(livePrice) ? livePrice : num(row.last_price);
  const peakStored = num(row.peak_price);
  const peak = open && last != null && (peakStored == null || last > peakStored) ? last : peakStored;

  const t1 = num(row.t1);
  const targets = t1 == null ? null : liveTargets({
    t1, t2: num(row.t2), t3: num(row.t3), invalidation: num(row.invalidation),
  }, last);

  const view = {
    id: row.id,
    tickerId: row.ticker_id,
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
  if (row.notes && row.notes.closedBy) view.closedBy = row.notes.closedBy;
  return view;
}

/** Base rates over the WHOLE log, open episodes included. */
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
  const med = !peaks.length ? null : peaks.length % 2 ? peaks[mid] : (peaks[mid - 1] + peaks[mid]) / 2;
  const total = rows.length;
  return {
    total, hitT1, hitT2, hitT3, invalidated, faded,
    // A base rate over two episodes is a lie with a decimal point.
    hitT1Rate: total >= 3 ? r1((hitT1 / total) * 100) : null,
    medianPeakPct: total >= 3 && med != null ? r1(med) : null,
  };
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (body.ping) return json(200, { success: true, service: "stock-scan", configured });

  if (cache.data && Date.now() - cache.ts < TTL_MS) return json(200, { ...cache.data, cached: true });
  if (!configured) return json(500, { success: false, error: "SUPABASE_SERVICE_ROLE_KEY isn't set in Netlify yet." });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "boardroom" }, auth: { persistSession: false },
    });

    const [stateQ, openQ, closedQ, allQ] = await Promise.all([
      supabase.from("stock_state").select("updated_at, payload").eq("id", "latest").maybeSingle(),
      supabase.from("stock_flags").select("*").is("resolved_at", null),
      supabase.from("stock_flags").select("*").not("resolved_at", "is", null).order("resolved_at", { ascending: false }).limit(25),
      supabase.from("stock_flags").select("status, flag_price, peak_price"),
    ]);
    if (stateQ.error) throw new Error(`stock_state: ${stateQ.error.message}`);
    if (openQ.error) throw new Error(`stock_flags: ${openQ.error.message}`);
    if (closedQ.error) throw new Error(`stock_flags: ${closedQ.error.message}`);
    if (allQ.error) throw new Error(`stock_flags: ${allQ.error.message}`);

    // Two distinct failures, two distinct messages — collapsing them into one
    // generic "hasn't run yet" is what hid a real bug behind a message that
    // looked like ordinary first-deploy timing on the crypto side.
    if (!stateQ.data) {
      throw new Error("The screener has never completed a pass — it settles after the close, so check back after 4:45pm ET on a trading day.");
    }
    if (!stateQ.data.payload) {
      throw new Error(`The screener's last write (${stateQ.data.updated_at || "unknown time"}) has no usable data — that's a bug, not a timing issue.`);
    }
    const p = stateQ.data.payload;

    if (p.feed && p.feed.blocked) {
      throw new Error(`The quote feed refused us at ${p.feed.since || "an unknown time"} (${p.feed.reason || "no reason given"}) — the screener is backing off rather than hammering it.`);
    }
    if (!Array.isArray(p.board) || !p.board.length) {
      throw new Error(p.coverage != null
        ? `The last pass only reached ${Math.round(p.coverage * 100)}% of the universe, so it declined to publish a board off a partial sample.`
        : "The screener has run but has not published a board yet.");
    }

    // The tick's prices, for the names that have an open plan on them. Everything
    // else is as of the last close — which is the honest state of a market that
    // is shut most of the time, and the footer says so.
    const live = (p.live && p.live.prices) || {};
    const board = p.board.map((row) => {
      const price = num(live[row.symbol]) ?? row.price;
      const targets = liveTargets(row.targets, price);
      const merged = { ...row, price, targets };
      merged.entry = entryRead(merged, targets, price);
      merged.move = moveRead(merged, targets, price, null);
      return merged;
    });
    const ctxById = new Map(board.map((r) => [r.id, r]));

    const active = (openQ.data || [])
      .map((row) => {
        const v = episodeView(row, num(live[row.symbol]));
        const ctx = ctxById.get(row.ticker_id) || null;
        v.entry = entryRead(ctx, v.targets, v.lastPrice);
        v.move = moveRead(ctx, v.targets, v.lastPrice, v);
        return v;
      })
      .sort((a, b) => (a.tier === b.tier ? (b.score || 0) - (a.score || 0) : a.tier === "igniting" ? -1 : 1));
    const recent = (closedQ.data || []).map((row) => episodeView(row));

    const out = {
      success: true,
      asOf: p.asOf || stateQ.data.updated_at,
      settledSession: p.settledSession || null,
      session: p.session || null,
      liveAsOf: p.live ? p.live.asOf : null,
      cached: false,
      // `stale` means THE TAPE IS AHEAD OF US, never that the clock moved. A
      // Saturday is not stale — nothing has happened since we last looked.
      stale: !!(p.session && p.session.state === "open" && p.live && Date.now() - Date.parse(p.live.asOf) > 90 * 60 * 1000),
      regime: p.regime || null,
      board,
      movers: p.movers || null,
      coverage: p.coverage ?? null,
      missing: p.missing || [],
      universeHealth: p.universeHealth || null,
      flags: { active, recent, stats: flagStats(allQ.data || []) },
      meta: {
        fetchedAt: new Date().toISOString(),
        sourceDetail: p.live
          ? "settled at the close; flagged names refreshed during the session"
          : "settled at the close",
      },
    };
    cache = { data: out, ts: Date.now() };
    return json(200, out);
  } catch (e) {
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message });
  }
};

// Pure helpers, exported for scripts/stocks-smoke.mjs.
exports.entryRead = entryRead;
exports.moveRead = moveRead;
exports.liveTargets = liveTargets;
exports.episodeView = episodeView;
exports.flagStats = flagStats;
