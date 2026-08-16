// ─── The exit ladder — the half of the plan that decides the number ─────────
//
// Everyone catches some of a bull market. Almost nobody sells one. The gap
// between a position that printed 10× and a position that BANKED 10× is a set
// of rules written down before there was anything to feel about them, and this
// file is that set of rules.
//
// PURE ON PURPOSE. It imports nothing, so the panel, src/data/db.js and
// scripts/altseason-smoke.mjs can all read the same ladder — the same rule the
// screener follows, where the number a flag was graded by and the number on
// screen are the same number. A ladder that the row draws and the data layer
// re-derives is two ladders, and they disagree the first time either is edited.
//
// WHY THESE RUNGS. The shape is front-loaded because the distribution of alt
// outcomes is: far more positions reach 3× than reach 15×, so the early rungs
// are where the realistic money is, and the late rungs exist to stop a genuine
// winner being sold whole at 3×.
//
//   3×   20%  — takes 60% of original cost off the table. The psychological
//               unlock: everything left is playing with the market's money.
//   5×   20%  — original cost fully recovered twice over. Nothing from here can
//               turn the position into a loss.
//   8×   25%  — most alts that reach 8× do not reach 15×. This is the rung that
//               banks the realistic case, which is why it is the biggest slice.
//   15×  20%  — now in the outcome that carries the whole book. Bank most of it.
//   —    15%  — trails behind a stop. This is the piece that catches a 50×, and
//               it can only ever cost 15% of one position.
//
// The percentages sum to 100 and that is asserted in the smoke: a ladder that
// sells 105% of a position is a rule that cannot be followed, and it would be
// invisible on screen because every rung renders fine on its own.

export const ALT_LADDER = [
  { mult: 3, sell: 20, why: "Takes 60% of your cost off the table" },
  { mult: 5, sell: 20, why: "Cost fully recovered — this can't be a loss now" },
  { mult: 8, sell: 25, why: "Most alts that reach 8× don't reach 15×" },
  { mult: 15, sell: 20, why: "Bank most of the outcome that carries the book" },
];

// The slice that never gets a rung — it rides behind a trailing stop instead.
export const ALT_TRAIL_PCT = 15;
export const ALT_TRAIL_STOP_PCT = 35;

// Drawn as pips on the row: one per rung, plus one for the trailing slice, so
// the widget shows the whole plan rather than the part that has a price.
export const ALT_LADDER_PIPS = ALT_LADDER.length + 1;

export const ALT_SLEEVES = [
  { key: "core", label: "Core", sub: "ETH / SOL — the floor, not the upside" },
  { key: "survivor", label: "Survivor", sub: "Top-150, down 75–90%, still liquid" },
  { key: "tail", label: "Tail", sub: "Sub-$300M — assume most go to zero" },
];

const fin = (v) => (Number.isFinite(v) ? v : null);

/**
 * Where a position sits on its ladder.
 *
 * TWO DIFFERENT COUNTS, AND CONFLATING THEM IS THE BUG THIS SHAPE PREVENTS.
 * `rungsHit` is what you have actually SOLD — it lives in the database and only
 * a deliberate act moves it. What the PRICE has reached is a separate question,
 * and the interesting state is precisely when they disagree: price is through a
 * rung you have not sold. That is `due`, and it is the only thing on this tab
 * that is genuinely urgent, because it is the moment the plan is being ignored.
 *
 * Deriving rungsHit from price instead — the obvious simplification — would
 * make that state unrepresentable: the row would mark rungs as done the instant
 * price touched them, congratulate you on a ladder you never executed, and then
 * quietly un-mark them on the retrace.
 *
 * @param position { cost_basis, rungs_hit }
 * @param price    current price, live
 * @returns { mult, rungsHit, next, targetPrice, awayPct, due, trailing }
 */
export function ladderState(position, price) {
  const basis = fin(Number(position && position.cost_basis));
  const p = fin(Number(price));
  const rungsHit = Math.max(0, Math.min(ALT_LADDER.length, Math.round(Number(position && position.rungs_hit) || 0)));
  const out = { mult: null, rungsHit, next: null, targetPrice: null, awayPct: null, due: false, trailing: false };
  // A basis of zero is not a free position, it is a missing one — dividing by
  // it would report an Infinity multiple on a row nobody can act on.
  if (basis == null || !(basis > 0)) return out;

  if (p != null && p > 0) out.mult = Math.round((p / basis) * 100) / 100;

  const next = ALT_LADDER[rungsHit] || null;
  if (!next) {
    // Every rung sold. What is left is the trailing slice, which has no target
    // price by design — it is exited by a stop, not by a number.
    out.trailing = true;
    return out;
  }

  out.next = next;
  out.targetPrice = basis * next.mult;
  if (p != null && p > 0) {
    out.awayPct = Math.round((out.targetPrice / p - 1) * 1000) / 10;
    out.due = out.mult != null && out.mult >= next.mult;
  }
  return out;
}

/**
 * Adding to a position averages the basis. Weighted by UNITS, not by a mean of
 * the two prices — buying $400 at $10 and $100 at $20 is a basis of $11.11, and
 * the arithmetic mean says $15, which would move every rung on the row about
 * 35% out of place.
 *
 * Returns the merged { cost_basis, units }. A tranche with no unit count cannot
 * be weighted, so it is refused rather than guessed: silently treating it as
 * one unit would corrupt the basis of the position it was added to.
 */
export function averageIn(position, addPrice, addUnits) {
  const basis = fin(Number(position && position.cost_basis));
  const units = fin(Number(position && position.units));
  const p = fin(Number(addPrice));
  const u = fin(Number(addUnits));
  if (p == null || u == null || !(u > 0) || !(p > 0)) return null;
  if (basis == null || units == null || !(units > 0)) return { cost_basis: p, units: u };
  const totalUnits = units + u;
  return {
    cost_basis: (basis * units + p * u) / totalUnits,
    units: totalUnits,
  };
}

/**
 * The regime override from the strategy note — sell half of everything
 * regardless of where any individual position sits on its ladder.
 *
 * ALL THREE, NOT ANY. Each of these fires on its own several times a cycle and
 * means very little alone; together they have marked the distribution zone in
 * every prior cycle. An `any` version would cry wolf through the whole
 * expansion and be ignored by the time it mattered.
 *
 * Every input is a field the engine already publishes, which is the point —
 * this is not new measurement, it is a conclusion nobody was drawing.
 */
export const OVERRIDE_SCORE = 70;
export const OVERRIDE_GREED = 80;
export const OVERRIDE_DOM_DAYS = 60;

export function regimeOverride({ score, fearGreed, domTrend, domSpanDays } = {}) {
  const s = fin(Number(score));
  const g = fin(Number(fearGreed));
  const legs = {
    score: s != null && s >= OVERRIDE_SCORE,
    greed: g != null && g >= OVERRIDE_GREED,
    dominance: domTrend === "falling" && fin(Number(domSpanDays)) != null && Number(domSpanDays) >= OVERRIDE_DOM_DAYS,
  };
  const armed = legs.score && legs.greed && legs.dominance;
  return {
    armed,
    legs,
    // How close it is, so the footer can say "1 of 3" rather than staying
    // silent until the day it fires — a switch nobody has ever seen move is a
    // switch nobody believes.
    met: Object.values(legs).filter(Boolean).length,
    of: 3,
  };
}
