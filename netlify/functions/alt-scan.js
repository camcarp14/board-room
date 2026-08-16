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

// NULL IS NOT ZERO. Number(null) is 0 and Number("") is 0, both finite, so the
// obvious version of this function turned every absent value into a confident
// zero: a CoinGecko row with no price became price 0 and survived the
// `price != null` filters downstream, and a coin with no 12h baseline read as
// a 12h return of exactly zero — which the move read then differenced against
// its 24h return and reported as a coin decelerating hard. Absent has to stay
// absent all the way to the render, which is the whole contract of this file.
const num = (v) => {
  if (v == null || v === "") return null;
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
  // WHY it closed, which the status cannot say. A flag that tagged T2 and then
  // lost its level keeps status 'hit_t2' — correctly, the target printed — and
  // only `closedBy` distinguishes that from one that held. The cron has been
  // writing this since it shipped and nothing ever read it out.
  if (row.notes && row.notes.closedBy) view.closedBy = row.notes.closedBy;
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
  // 'underway' IS NOT AN ENTRY ON THIS TAB, and the divergence from the equity
  // version of this function is deliberate: the two engines mean different
  // things by the word. bandOf here is `chg7d >= 15` and better than halfway up
  // its range — a coin already fifteen percent into its week. The equity one is
  // `chg5 >= 5`, an ordinary healthy trend.
  //
  // alt-cron's flagTier has always refused to flag underway for exactly that
  // reason, while this called it "trend intact and T1 still ahead" — so the
  // board painted a green Entry pill and the sheet led with a green Entry
  // banner on coins the Flags card could never contain, and no amount of
  // scrolling the flag list would explain why. This is the same contradiction
  // the equity side had in the opposite direction, where the answer was to
  // widen the ladder because there the band really is a buyable trend. Here the
  // answer is the other one: agree with the engine.
  if (band === "underway") return out("watch", "already well into the move — a base is a better entry");
  if (band === "warming") return out("watch", "lifting, hasn't taken its level yet");
  if (!band) return out("watch", "off the board — no current read");
  return out("watch", "nothing lifting it yet");
}

/* ═══ the move read ══════════════════════════════════════════════════════════
 *
 * entryRead answers SHOULD I ACT. This answers WHERE IS IT, which turns out to
 * be a different question and the one that was missing: a coin can be a
 * perfectly good "watch" because it is coiled under its level, or a perfectly
 * good "watch" because it already ran and gave half of it back, and the tab
 * said the same word for both.
 *
 * Six stages, first match wins, ordered so every gate is guaranteed its inputs
 * by the gates above it:
 *
 *   broken     price is at or through the invalidation — the plan is over
 *   spent      parabolic, or price is past T3 — the measured move is done
 *   extending  past its own first target: working, but the entry was lower
 *   breaking   through the level that triggers it, or breaking it today
 *   atLevel    within 3% of the level, coiled right under it
 *   base       inside its range with nothing at the level yet
 *
 * plus three honest non-answers — 'none' (no levels drawn), 'offboard' (the
 * coin fell out of the screened 60 and there is no structure to read), and the
 * separate `thin` flag, which is not a stage at all: it rides alongside so a
 * coin that is genuinely breaking out AND impossible to exit says both.
 *
 * WHAT IS AND IS NOT CLAIMED. Three of the stages are provably consistent with
 * entryRead because they are the same arithmetic: invPct IS entry.riskPct,
 * t3Pct IS entry.roomPct, t1Pct IS entry.nextPct — so 'broken', 'spent' and
 * 'extending' can never appear under "Worth an entry now". The three forward
 * stages carry any verdict, and that is the point: the stage says where the
 * move is, the section says whether to act, and neither is asked to do the
 * other's job.
 *
 * Same reasoning as entryRead for living here rather than in the cron: it is a
 * question about the CURRENT price against FROZEN levels. It is called at the
 * same two sites with the same arguments, so it inherits that contract rather
 * than reimplementing it.
 */
const AT_LEVEL_PCT = -3;      // within 3% under the level is "at" it
const BREAK_MIN_POINTS = 48;  // a fresh break needs a real series behind it
const MOTION_PP = 1;          // pace changed by a point or more to be worth a word
const OFF_PEAK_NOISE = -5;    // a give-back smaller than this is not news

function moveRead(ctx, targets, price, episode) {
  const flags = (ctx && ctx.flags) || {};
  const range = (ctx && ctx.range7d) || null;
  const t = targets || null;
  const p = Number.isFinite(price) && price > 0 ? price : null;

  // Distance to the LEVEL — priorHigh, drawn from finished bars with today
  // excluded (see structure7d's docstring in the cron). range7d.high is a
  // range denominator and would make the level move with the price it is
  // compared against. Guarded on > 0 because price/null is Infinity, not null,
  // which is exactly how a number like this ships broken.
  const priorHigh = range && Number.isFinite(range.priorHigh) && range.priorHigh > 0 ? range.priorHigh : null;
  const toLevelPct = priorHigh != null && p != null ? r1((p / priorHigh - 1) * 100) : null;

  // Is it accelerating RIGHT NOW: this 12h leg against the previous one. Both
  // windows are ratios against the same live price, so the price divides out
  // and this is exact rather than an estimate.
  const c12 = num(ctx && ctx.chg12h);
  const c24 = num(ctx && ctx.chg24h);
  let turn = null;
  if (c12 != null && c24 != null && 1 + c12 / 100 > 0.01 && 1 + c24 / 100 > 0.01) {
    const prior12 = ((1 + c24 / 100) / (1 + c12 / 100) - 1) * 100;
    turn = r1(c12 - prior12);
  } else {
    // No 12h baseline yet (the first half-day after a deploy). The cron's own
    // day-versus-week excess is the honest stand-in; a wider band, because it
    // is a coarser measure.
    const a = ctx && ctx.accel && num(ctx.accel.d24VsWeek);
    if (a != null) return finish(a >= 2 ? "up" : a <= -1 ? "down" : "flat");
  }
  const motion = turn == null ? null : turn >= MOTION_PP ? "up" : turn <= -MOTION_PP ? "down" : "flat";
  return finish(motion);

  function finish(motionToken) {
    // True % off the episode's own high. NOT peakPct − sinceFlagPct: both are
    // percentages off the same flagPrice base, so their difference is
    // percentage points of flagPrice, not percent off the peak — at peak +100
    // and since +50 that prints −50% for a coin 25% off its high, an
    // overstatement that grows with the size of the move.
    const since = num(episode && episode.sinceFlagPct);
    const peak = num(episode && episode.peakPct);
    const offPeakPct = since != null && peak != null && 1 + peak / 100 > 0.01
      ? r1(((1 + since / 100) / (1 + peak / 100) - 1) * 100)
      : null;

    const out = (stage) => ({
      stage,
      thin: !!flags.thinLiquidity,
      motion: motionToken,
      toLevelPct,
      offPeakPct: offPeakPct != null && offPeakPct <= OFF_PEAK_NOISE ? offPeakPct : null,
    });

    if (!t) return out("none");
    if (Number.isFinite(t.invPct) && t.invPct >= 0) return out("broken");
    if (flags.parabolic || (Number.isFinite(t.t3Pct) && t.t3Pct <= 0)) return out("spent");
    if (Number.isFinite(t.t1Pct) && t.t1Pct <= 0) return out("extending");
    if (!range) return out("offboard");
    if ((flags.freshBreak && (range.points ?? 0) >= BREAK_MIN_POINTS) || (toLevelPct != null && toLevelPct > 0)) return out("breaking");
    if (toLevelPct != null && toLevelPct >= AT_LEVEL_PCT) return out("atLevel");
    if (range.pos != null) return out("base");
    return out("offboard");
  }
}

/* ═══ the cohort read ════════════════════════════════════════════════════════
 *
 * IS THIS MOVE SHARED? — which is the only tractable version of "why is this
 * coin up". You cannot enumerate the reasons a token moves; there are too many
 * and most are unobservable. But you can measure whether the reason was shared
 * with the rest of its narrative, and shared is the only kind that lasts long
 * enough to be worth trading.
 *
 * The whole read is one subtraction — the coin's 7-day return minus its
 * cohort's median 7-day return, in percentage POINTS — resolved against two
 * facts: is the cohort itself bid, and is the coin ahead of it or behind it.
 * That gives five states, and the two that matter most are the two the board
 * could never show before:
 *
 *   lagging — the cohort is bid and this name has not moved yet. Frequently the
 *             better entry of the two, and completely invisible on a board
 *             sorted by return, where it looks like nothing is happening.
 *   alone   — the cohort is going nowhere and this name is well ahead of it. A
 *             listing, an unlock, a tweet. Loud, untradeable, and the row that
 *             looks MOST attractive on a returns-sorted board.
 *
 * WHY THIS LIVES HERE AND NOT IN THE CRON, same as entryRead and moveRead: the
 * cohort's median is the cron's and is consumed verbatim, but the coin's own
 * 7-day return is live-overlaid on every read, so an excess computed hourly
 * would drift from the number printed beside it on the same row. The cron
 * publishes the map and the medians; the subtraction is the live half.
 */
// Within this many points of its cohort is "moving with the group" — a
// percentage-point gap smaller than this is not a distinction anyone can act on.
const EXCESS_NOISE_PP = 3;
// How far ahead of a cohort that ISN'T bid a coin has to be before the move is
// called idiosyncratic. Deliberately much wider than the noise band: calling a
// move "alone" is an accusation, and a coin 4 points ahead of a flat sector is
// just a coin.
const ALONE_MIN_PP = 10;
// WHAT COUNTS AS A BID COHORT, and `> 0` is not it. A cohort median of +0.5%
// over seven days is a flat sector, and treating it as bid inverts the whole
// read: a coin ripping 45% against it lands in the branch that says "leading
// its group — this is rotation", which is the exact misdiagnosis this function
// exists to prevent. The bug shipped in the first version and was caught by
// scripts/altseason-smoke.mjs; the fixture pins it.
const COHORT_BID_MIN_PCT = 2;
// Below this the cohort isn't merely flat, it is being sold — same wording
// distinction the ladder makes between "nothing is bid" and "risk is leaving".
const COHORT_FALLING_PCT = -2;

function cohortExcess(cohort, chg7d) {
  if (!cohort) return null;
  const base = num(cohort.chg7d);
  const own = num(chg7d);
  const view = {
    id: cohort.id, label: cohort.label,
    cohortChg7d: base, lifting: cohort.lifting ?? null, n: cohort.n ?? null,
    excessPp: null, state: null, read: null,
  };
  // A cohort with no measured median still names the coin's narrative, which is
  // worth showing on its own — it just cannot carry a verdict.
  if (base == null || own == null) {
    view.read = "No cohort read yet";
    view.state = "unknown";
    return view;
  }

  // POINTS, not percent: the difference of two percentages is not a percentage,
  // and this file already keeps that distinction everywhere else.
  const excess = r1(own - base);
  view.excessPp = excess;

  if (base >= COHORT_BID_MIN_PCT) {
    if (excess >= EXCESS_NOISE_PP) { view.state = "leading"; view.read = "Leading its group — this is rotation"; }
    else if (excess <= -EXCESS_NOISE_PP) { view.state = "lagging"; view.read = "Lagging a bidding group — often the better entry"; }
    else { view.state = "with"; view.read = "Moving with its group"; }
    return view;
  }
  if (excess >= ALONE_MIN_PP) {
    view.state = "alone";
    view.read = "Alone — news, listing or unlock. Won't persist";
    return view;
  }
  // The group is flat or falling and this name is not meaningfully ahead of it.
  // One state, two readings — "falling with its group" is a fact about the
  // sector, "flat with its group" is the absence of one, and a row that said
  // the first when the second was true would invent a downtrend.
  view.state = "quiet";
  view.read = base <= COHORT_FALLING_PCT ? "Falling with its group" : "Flat with its group";
  return view;
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

/**
 * The track record, graded over CLOSED episodes only.
 *
 * The denominator is what makes a hit rate honest. An open flag is not a miss
 * — it has not finished — so counting it below the line prints a rate that
 * drops every time the screener flags something new. And the outcome bar only
 * adds up if wins and losses are drawn from the same population: folding an
 * open T1-tagger into the green side while its still-running twin has yet to
 * fail makes every width on that bar a lie. So everything graded here is
 * resolved-only, and `open` is reported beside it rather than inside it.
 *
 * Everything a performance view needs comes from here rather than from the
 * client counting rows: the client only ever holds the last 25 closed
 * episodes, so any rate it computed itself would silently be "the last 25"
 * wearing the label "all time".
 */
function flagStats(rows) {
  const rank = { hit_t1: 1, hit_t2: 2, hit_t3: 3 };
  let hitT1 = 0, hitT2 = 0, hitT3 = 0, invalidated = 0, faded = 0, open = 0, expired = 0, roundTrip = 0;
  const peaks = [];
  const held = [];
  let best = null, worst = null;
  const form = [];   // newest first: what each resolved episode did

  for (const r of rows) {
    if (!r.resolved_at) { open++; continue; }   // still running — not a result yet

    const lvl = rank[r.status] || 0;
    if (lvl >= 1) hitT1++;
    if (lvl >= 2) hitT2++;
    if (lvl >= 3) hitT3++;
    // A WIN THAT GAVE IT ALL BACK. The rung is kept when a flag that already
    // printed a target later loses its level — correctly, the target printed —
    // so the hit rate cannot tell "reached T2 and held" from "reached T2 and
    // round-tripped through the stop". `closedBy` is the only thing that can,
    // and on a tool whose whole job is deciding what to buy, the difference is
    // the difference between a signal and a tease.
    if (lvl >= 1 && (r.notes || {}).closedBy === "invalidation") roundTrip++;
    if (r.status === "invalidated") invalidated++;
    else if (r.status === "faded") faded++;
    // A 14-day timeout keeps whatever ladder status the episode earned, so a
    // closed row can still read 'active' — the went-nowhere close, counted as
    // expired. Every resolved row lands in exactly one of these buckets, which
    // is what lets the stacked bar sum to `resolved`.
    else if (r.status === "active") expired++;

    const p = pctOff(num(r.peak_price), num(r.flag_price));
    if (p != null) {
      peaks.push(p);
      if (!best || p > best.pct) best = { symbol: r.symbol, pct: p };
    }
    // The OUTCOME, which is not the peak: what it did by the time it closed.
    const outcome = pctOff(num(r.last_price), num(r.flag_price));
    if (outcome != null && (!worst || outcome < worst.pct)) worst = { symbol: r.symbol, pct: outcome };

    if (r.first_flagged_at) {
      const d = (Date.parse(r.resolved_at) - Date.parse(r.first_flagged_at)) / 86400000;
      if (Number.isFinite(d) && d >= 0) held.push(d);
    }
    if (form.length < 20) form.push({ symbol: r.symbol, status: r.status, pct: outcome });
  }

  const mid = (xs) => {
    if (!xs.length) return null;
    const a = xs.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const total = rows.length;
  const resolved = total - open;
  return {
    total, resolved, open, hitT1, hitT2, hitT3, invalidated, faded, expired, roundTrip,
    // A base rate over two episodes is a lie with a decimal point.
    hitT1Rate: resolved >= 3 ? r1((hitT1 / resolved) * 100) : null,
    medianPeakPct: resolved >= 3 && peaks.length ? r1(mid(peaks)) : null,
    medianHeldDays: held.length >= 3 ? r1(mid(held)) : null,
    best, worst, form,
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
      supabase.from("alt_flags").select("symbol, status, flag_price, peak_price, last_price, first_flagged_at, resolved_at, notes").order("resolved_at", { ascending: false, nullsFirst: false }),
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
      // The merged row is built BEFORE the reads, not after: moveRead's pace
      // leg needs chg12h and chg24h, and those are exactly the two fields the
      // live overlay supplies. Reading them off the stored row would price the
      // turn off the hourly pass.
      const merged = live
        ? {
          ...row,
          price,
          chg1h: live.chg1h ?? row.chg1h,
          chg4h,
          chg12h,
          chg24h: live.chg24h ?? row.chg24h,
          chg7d: live.chg7d ?? row.chg7d,
          chg30d: live.chg30d ?? row.chg30d,
          targets,
        }
        : { ...row, chg4h, chg12h, targets };
      merged.entry = entryRead(merged, targets, price);
      merged.move = moveRead(merged, targets, price, flag);
      merged.flag = flag;
      return merged;
    });

    // Movers: live rows when we have them, else the stored board (60 coins
    // beats an empty tab). Always filtered to the cron's eligible set so a
    // stablecoin de-peg or a wrapper can't top the list.
    // The cohort each board row belongs to, and the medians it is measured
    // against. Both are the cron's; only the subtraction happens here.
    const cohortById = new Map((Array.isArray(payload.cohorts) ? payload.cohorts : []).map((c) => [c.id, c]));
    const coinCohort = (payload.coinCohort && typeof payload.coinCohort === "object") ? payload.coinCohort : {};
    for (const row of board) {
      const c = cohortById.get(coinCohort[row.id]) || null;
      row.cohort = cohortExcess(c, row.chg7d);
    }

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
        const ctx = ctxById.get(row.coin_id) || null;
        v.entry = entryRead(ctx, v.targets, v.lastPrice);
        // The episode itself is the peak reference — an open flag knows how
        // far off its own high it has come back, which a board row alone
        // cannot say.
        v.move = moveRead(ctx, v.targets, v.lastPrice, v);
        // Copied off the board row rather than recomputed: the episode and the
        // board row are the same coin at the same live price, so a second
        // computation could only ever disagree with the first.
        v.cohort = ctx ? ctx.cohort || null : null;
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
      // The three layers that sit above the individual coin. Copied through
      // untouched — they are the cron's readings of the market, not of a price,
      // so unlike the entry/move/cohort reads there is nothing live about them.
      // A payload written before they shipped has none of these, and every one
      // of them is null-guarded on the client for exactly that hour.
      ladder: payload.ladder || null,
      scoreDrift: payload.scoreDrift || null,
      cohorts: Array.isArray(payload.cohorts) ? payload.cohorts : [],
      cohortRead: payload.cohortRead || null,
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
exports.moveRead = moveRead;
exports.cohortExcess = cohortExcess;
exports.liveTargets = liveTargets;
exports.flagStats = flagStats;
