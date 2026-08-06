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

/* ═══ the entry read ═════════════════════════════════════════════════════════
 *
 * The board answers "is a move starting here". It never answered the question
 * you actually have with a thumb on the screen: is THIS a place to put money
 * right now, and if it works, how far does it go?
 *
 * Everything needed was already published — the band, the score, four levels,
 * the parabolic penalty — but only per coin, one sheet at a time, with the
 * arithmetic left to you. CYS shipped a 68/100 score, three targets 5–9% away,
 * and "PARABOLIC: +160.4% in 7d — this is a chase, not an entry" as the last
 * line of its sheet. Every one of those is true. Glanced at together they say
 * the opposite of each other, and across fifty open flags nobody is reading
 * any of them.
 *
 * So it collapses to one of three words, and the words are ACTIONS, not
 * states — 'late' where the screener says 'late', but also where price has
 * simply walked through its own first target, which no band knows about.
 *
 *   entry — the first target is still ahead, the invalidation is close enough
 *           to define the risk, and T3 pays at least RR_MIN times the stop
 *   watch — a real structure that hasn't earned an entry: nothing lifting it
 *           yet, no levels worth trading, or a payoff too thin to bother
 *   late  — the move already happened. Parabolic, banded 'late', or past T1:
 *           the entry was lower, and taking it here is buying somebody's exit.
 *
 * WHY THIS LIVES IN THE MOUTH AND NOT THE BRAIN. Everything else on this tab
 * is the cron's and is copied through untouched, deliberately. This one is
 * different in kind: it is a question about the CURRENT price. The levels stay
 * frozen — that is what makes the log gradeable — but "how far above the level
 * are you" changes by the minute, and a verdict recomputed hourly would call a
 * coin an entry forty minutes after it stopped being one. Band, flags, score
 * and the target PRICES are consumed verbatim; the only thing derived here is
 * the distance from a live price to a fixed number, which is exactly what this
 * function already does for chg4h and for every episode's target %s.
 */
const RR_MIN = 1.5;

// `ctx` is the screened board row for the coin (band + flags), or null when the
// coin has dropped off the 60-row board — in which case the levels still carry
// the read and the band checks simply never fire.
function entryRead(ctx, targets, price) {
  const flags = (ctx && ctx.flags) || {};
  const band = ctx && ctx.band;
  const p = num(price);
  const t = targets || null;

  // roomPct is the answer to "how much has it got to run" — distance to the
  // last target, not to the first, because T1 is a checkpoint and T3 is the
  // measured move. riskPct is negative while the structure is intact.
  const roomPct = t ? pctOff(t.t3, p) : null;
  const nextPct = t ? pctOff(t.t1, p) : null;
  const riskPct = t ? pctOff(t.invalidation, p) : null;
  const rr = Number.isFinite(roomPct) && Number.isFinite(riskPct) && riskPct < 0
    ? Math.round((roomPct / -riskPct) * 10) / 10
    : null;

  const out = (state, why) => ({ state, why, roomPct, nextPct, riskPct, rr });

  // Ordered the way a trade actually fails: can't get out, already went, no
  // plan, plan already broken, plan already spent, payoff not worth it — and
  // only then the question of whether anything is lifting it.
  if (flags.thinLiquidity) return out("late", "too thin to get back out of");
  if (flags.parabolic) return out("late", "parabolic — this is the chase");
  if (band === "late") return out("late", "the move already happened");
  if (!t) return out("watch", "no level worth trading against");
  if (!Number.isFinite(riskPct) || riskPct >= 0) return out("watch", "structure already lost");
  if (Number.isFinite(nextPct) && nextPct <= 0) return out("late", "already through T1 — the entry was lower");
  if (rr != null && rr < RR_MIN) return out("watch", `pays ${rr}× the risk — too thin`);
  if (band === "starting") return out("entry", "breaking its level with the stop close");
  if (band === "underway") return out("entry", "trend intact and T1 still ahead");
  if (band === "warming") return out("watch", "lifting, hasn't taken its level yet");
  if (!band) return out("watch", "off the board — no current read");
  return out("watch", "nothing lifting it yet");
}

// Target PRICES are the cron's and never move; the % distances are against the
// live price, so "6% away" means six percent away now rather than at :00.
function liveTargets(t, price) {
  // NOT num(price) — Number(null) is 0, which is finite, and a zero base would
  // send every % through pctOff's divide-by-zero guard and null the whole set
  // instead of leaving the stored ones alone.
  if (!t || !Number.isFinite(price) || !(price > 0)) return t || null;
  return {
    ...t,
    t1Pct: pctOff(t.t1, price), t2Pct: pctOff(t.t2, price),
    t3Pct: pctOff(t.t3, price), invPct: pctOff(t.invalidation, price),
  };
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
    // chg4h/chg12h are OURS, not CoinGecko's — it publishes neither window.
    // Two sources, in this order of preference:
    //   1. `baselines` — the cron's own alt_snapshots row from ~4h/~12h ago.
    //      Exact, measured by us, but only exists once the series has been
    //      accumulating that long.
    //   2. `sparkRef` — the same instant read off CoinGecko's 168-point hourly
    //      sparkline, which is available on the cron's very first pass.
    // Snapshots win when present; the sparkline is what stops both columns
    // reading "—" for the first half-day after a deploy or a cron gap.
    const refFor = (w, id) => {
      const base = payload.baselines && payload.baselines[w];
      const fromSnapshot = base ? num(base[id]) : null;
      if (fromSnapshot != null && fromSnapshot > 0) return fromSnapshot;
      const spark = payload.sparkRef && payload.sparkRef[w];
      const fromSpark = spark ? num(spark[id]) : null;
      return fromSpark != null && fromSpark > 0 ? fromSpark : null;
    };
    const chgVsBaseline = (w, id, price) => {
      const ref = refFor(w, id);
      return ref != null && price != null ? r2(((price - ref) / ref) * 100) : null;
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
      const targets = liveTargets(row.targets, price);
      const entry = entryRead(row, targets, price);
      if (!live) return { ...row, flag, chg4h, chg12h, targets, entry };
      return {
        ...row,
        price,
        chg1h: live.chg1h ?? row.chg1h,
        chg4h,
        chg12h,
        chg24h: live.chg24h ?? row.chg24h,
        chg7d: live.chg7d ?? row.chg7d,
        chg30d: live.chg30d ?? row.chg30d,
        targets,
        entry,
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
    // 4h/12h have no CoinGecko field — see refFor above for the two sources.
    // Only when NEITHER exists for any coin does the window go null and the UI
    // fall back to readyIn, rather than ranking a list of fake zeroes.
    const baselineWindow = (w) => {
      const hasAny = (payload.baselines && payload.baselines[w]) || (payload.sparkRef && payload.sparkRef[w]);
      if (!hasAny) return null;
      const list = topBy((r) => {
        const ref = refFor(w, r.id);
        return ref != null ? ((r.price - ref) / ref) * 100 : NaN;
      });
      return list.length ? list : null;
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

    // An episode's entry read is judged against the levels it was FLAGGED on,
    // not against a fresher redraw of the same structure — those frozen levels
    // are the trade you would be taking. The band and the exclusion flags come
    // from the coin's current board row, because whether a move is still
    // starting is a question about today. A coin that has fallen off the board
    // gets no band at all, and entryRead says so rather than guessing.
    const ctxById = new Map(board.map((r) => [r.id, r]));
    const active = (openQ.data || [])
      .map((row) => {
        const v = episodeView(row, liveById.get(row.coin_id)?.price);
        v.entry = entryRead(ctxById.get(row.coin_id) || null, v.targets, v.lastPrice);
        return v;
      })
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

// Pure helpers, exported for scripts/altseason-smoke.mjs (Netlify only reads
// `handler`). The entry read is the one piece of judgment this function owns,
// so it is the one piece that has to be pinned by fixtures.
exports.entryRead = entryRead;
exports.liveTargets = liveTargets;
