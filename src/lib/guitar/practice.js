// ─── The practice engine — what to do today, and whether it worked ───────────
// PURE. Every number the Today tab prints is computed here, so
// scripts/guitar-smoke.mjs can simulate six months of practice against it and
// assert the schedule never starves an item, never serves the same three things
// every day, and never lets a streak lie.
//
// WHY THIS FILE IS THE PRODUCT. A guitar app is not short of things to show you.
// It is short of an answer to "what should I do for the next twenty-five
// minutes" — and that answer is the only thing standing between a self-taught
// adult and the well-documented failure mode of practising what they can already
// do. Ericsson's definition of deliberate practice presupposes a coach supplying
// the diagnosis; a self-taught player fails on exactly that clause. So the
// session is PRESCRIBED. You can override it, once, deliberately — but the
// default is never "free practice", because free practice is how a year goes by
// with the same four chords in it.
//
// THIS IS NOT A FLASHCARD SCHEDULER, AND THAT IS DELIBERATE. Building literal
// SM-2 over "chords" is the classic mistake that makes a guitar app feel like
// homework: a motor skill is a continuous, multi-dimensional performance (tempo ×
// cleanliness × consistency) that decays GRADUALLY, not a fact that is either
// recalled or not. So an item carries a `strength` from 0 to 100 that decays with
// time and moves with results, and the review interval is chosen so the next
// contact happens while strength is still around 70 — the point where a rep is
// worth something and the skill has not gone.

// ─── time ────────────────────────────────────────────────────────────────────
// EVERY DATE IN THIS FILE IS A LOCAL "YYYY-MM-DD" DAY STRING, never a timestamp,
// and that is a decision about honesty rather than convenience. A practice
// session that starts at 23:50 and is saved at 00:10 belongs to the day it
// started — it was one sitting with a guitar, and filing it under two days would
// award a streak nobody earned. Comparing UTC instants would also break the
// streak of anyone who practises in the evening, once, when the clocks change.
export const dayOf = (t) => {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// Whole days between two day strings. Parsed as LOCAL midnights and differenced
// on the calendar, not in milliseconds: a DST boundary makes one of those days
// 23 or 25 hours long, and dividing by 86 400 000 rounds a real day away.
export const daysBetween = (fromDay, toDay) => {
  if (!fromDay || !toDay) return null;
  const a = new Date(`${fromDay}T00:00:00`), b = new Date(`${toDay}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
};
export const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + n);
  return dayOf(d);
};

// ─── strength ────────────────────────────────────────────────────────────────
// Decay is faster when the skill is weak and slower when it is strong, which is
// what "consolidated" means in practice: something you have played for six months
// does not leave in a week, and something you met on Tuesday does.
//
//     decayPerDay = 3.5 · √(1 − strength/100)
//
// At strength 20 that is ~3.1 points a day (gone inside a week); at 95 it is 0.8
// (a month before it needs looking at). The exponent is a shape, not a
// measurement — the literature supports the direction, not this constant — and it
// is written here rather than buried so it can be argued with.
export const DECAY_RATE = 3.5;
// A FLOOR, BECAUSE THE CURVE HAS A FIXED POINT AT 100 AND NOTHING IS PERMANENT.
// √(1 − s/100) is zero at s = 100, so a skill that ever reached full strength
// would decay by exactly nothing, for ever: it would never come due, never be
// scheduled again, and disappear from the app while reading as mastered. Nobody
// plays anything so well that a year away costs nothing. A third of a point a day
// is the slowest this model will admit to, which puts an untouched perfect skill
// back in the queue inside a month.
export const DECAY_FLOOR = 0.35;
export const dailyDecay = (s) => Math.max(DECAY_FLOOR, DECAY_RATE * Math.sqrt(Math.max(0, 1 - s / 100)));
export function decayStrength(strength, days) {
  const s = Math.max(0, Math.min(100, Number(strength) || 0));
  const n = Math.max(0, Math.round(Number(days) || 0));
  if (!n) return s;
  // Integrated day by day rather than in one step, because the rate depends on
  // the strength it is eating: one 30-day step at the strength of day zero
  // deletes a skill that would really have flattened out on the way down.
  let cur = s;
  for (let i = 0; i < Math.min(n, 400); i++) {
    cur = Math.max(0, cur - dailyDecay(cur));
    if (cur <= 0) return 0;
  }
  return Math.round(cur * 10) / 10;
}

// The strength an item is at NOW, given when it was last touched.
export const currentStrength = (skill, today) =>
  decayStrength(skill?.strength ?? 0, daysBetween(skill?.lastPracticed, today) ?? 0);

// The bands are LABELS ONLY. What each one is called is a judgement about how it
// feels to play; how long until it comes back is arithmetic, and the two are kept
// apart on purpose — a hand-typed interval table drifts away from the decay curve
// the first time anyone touches either, and then the app says "solid, back in two
// weeks" about something the model has decaying to nothing in nine days.
export const REVIEW_BANDS = [
  { max: 40, label: "fragile" },
  { max: 65, label: "shaky" },
  { max: 80, label: "holding" },
  { max: 92, label: "solid" },
  { max: 100, label: "automatic" },
];
export const bandFor = (strength) => REVIEW_BANDS.find((b) => strength <= b.max) || REVIEW_BANDS[REVIEW_BANDS.length - 1];
// Come back while it is still worth a rep. 65 is the level this schedules for —
// below it the thing has to be rebuilt rather than maintained, and above about 80
// a rep is a victory lap. Capped at 30 days because a practice tool that says
// "see you in three months" is one you have already stopped using.
export const REVIEW_TARGET = 65;
export function nextReviewDays(strength) {
  let cur = Math.max(0, Math.min(100, Number(strength) || 0));
  if (cur <= REVIEW_TARGET) return 1;
  let d = 0;
  while (cur > REVIEW_TARGET && d < 30) { cur -= dailyDecay(cur); d++; }
  return Math.max(1, d);
}
export const dueDay = (skill) => (skill?.lastPracticed ? addDays(skill.lastPracticed, nextReviewDays(skill.strength ?? 0)) : null);

// What a session does to an item. Three outcomes, and the negative one is not
// "you failed" — it is the specific case of playing BELOW a tempo you had already
// reached, which is the signature of something that was crammed rather than
// learned, and the schedule should notice.
export const RATING_DELTA = { clean: 8, shaky: 3, rough: -2 };
export function applyResult(skill, { rating = "shaky", bpm = null, day, seconds = 0 } = {}) {
  const base = { id: skill?.id, strength: 0, sessions: 0, minutes: 0, bestBpm: null, ceilingBpm: null, history: [], ...skill };
  const decayed = currentStrength(base, day);
  let delta = RATING_DELTA[rating] ?? 0;
  // The regression case: clean, but slower than this item has already been
  // played. Worth less than a clean rep at tempo and worth more than nothing.
  if (rating === "clean" && bpm != null && base.bestBpm != null && bpm < base.bestBpm * 0.9) delta = 3;
  if (rating === "rough" && base.bestBpm != null && bpm != null && bpm < base.bestBpm * 0.8) delta = -5;
  const history = [...(base.history || []), { day, rating, bpm: bpm ?? null }].slice(-20);
  return {
    ...base,
    strength: Math.max(0, Math.min(100, Math.round((decayed + delta) * 10) / 10)),
    lastPracticed: day,
    sessions: (base.sessions || 0) + 1,
    minutes: Math.round(((base.minutes || 0) + (seconds || 0) / 60) * 10) / 10,
    bestBpm: bpm != null && rating === "clean" ? Math.max(base.bestBpm ?? 0, bpm) : base.bestBpm,
    history,
  };
}

// The rolling accuracy the 80–92% band is judged on. Counts clean reps against
// all reps over the last n, and returns null under five attempts rather than
// printing 100% off a single lucky Tuesday.
export function rollingAccuracy(history, n = 20) {
  const xs = (history || []).slice(-n);
  if (xs.length < 5) return null;
  const clean = xs.filter((h) => h.rating === "clean").length;
  return Math.round((clean / xs.length) * 1000) / 10;
}
// > 92% is too easy, < 80% is too hard, and in between is where learning happens.
// The 85% figure comes from Wilson et al. 2019, derived for gradient-descent
// learners and validated on perceptual decisions — treating it as a constant for
// guitar would be over-claiming, and what survives the caveat is the shape: both
// "always clean" and "always failing" are wasted time.
export function difficultyVerdict(acc) {
  if (acc == null) return { key: "unknown", label: "Not enough reps yet", tone: "faint" };
  if (acc > 92) return { key: "easy", label: "Too easy — push the tempo", tone: "blue" };
  if (acc >= 80) return { key: "zone", label: "In the zone", tone: "green" };
  return { key: "hard", label: "Too hard — drop the tempo or shrink it", tone: "amber" };
}

// An item in its first three sessions is being ACQUIRED, not maintained, and the
// two want opposite schedules: acquisition wants blocked repetition (do this
// thing, now, repeatedly), maintenance wants interleaving (three things rotated,
// which measurably depresses in-session performance and improves retention).
// Mixing them is why so many practice plans feel either scattered or pointless.
export const isAcquisition = (skill) => (skill?.sessions ?? 0) < 3 || (skill?.minutes ?? 0) < 15;

// ─── the tempo ladder ────────────────────────────────────────────────────────
// "Three clean reps, then raise it." The spiral is the part worth knowing about:
// rather than 60 → 65 → 70 → 75, the plan steps back after each gain —
// 60, 70, 65, 75, 70, 80 — so every tempo is met twice from different directions.
// A straight climb produces something that is clean at exactly one tempo, which
// is a thing that cannot be played with other people.
export function ladderPlan({ target = 100, start = null, ceiling = null, rungs = 8 } = {}) {
  const t = Math.max(20, Math.round(target));
  // A start at or above the target has no ladder in it. Clamping rather than
  // returning nothing: a ceiling memory from a good session, or a hand-typed
  // start, must still produce a plan you can run — one rung, at the target.
  let bpm = Math.min(t, Math.max(30, Math.round(start ?? (ceiling ? ceiling - 10 : t * 0.6))));
  const out = [];
  let up = true;
  while (out.length < rungs && bpm <= t) {
    out.push(bpm);
    const step = bpm >= t * 0.9 ? 2 : bpm >= t * 0.75 ? 3 : 5;
    // Up two, back one — the spiral. The back-step is never below where the
    // ladder started, so it cannot walk downhill forever.
    bpm = up ? bpm + step * 2 : Math.max(out[0], bpm - step);
    up = !up;
  }
  return out;
}

// One rep's effect on a ladder in progress. `ceiling` is the memory: after two
// failures at a tempo the session ends the item and next time starts 5 BPM below
// wherever it first broke, which is the difference between a ladder and a wall.
export const LADDER_GATE = 3;
export function ladderStep(state, outcome) {
  const s = { bpm: 60, target: 100, clean: 0, fails: 0, ceiling: null, done: false, ...state };
  if (s.done) return s;
  if (outcome === "clean") {
    const clean = s.clean + 1;
    if (clean < LADDER_GATE) return { ...s, clean, fails: 0 };
    const step = s.bpm >= s.target * 0.9 ? 2 : s.bpm >= s.target * 0.75 ? 3 : 5;
    const next = s.bpm + step;
    return next > s.target
      ? { ...s, clean: 0, fails: 0, bpm: s.target, done: true, ceiling: Math.max(s.ceiling ?? 0, s.target) }
      : { ...s, clean: 0, fails: 0, bpm: next, ceiling: Math.max(s.ceiling ?? 0, s.bpm) };
  }
  const fails = s.fails + 1;
  if (fails < 2) return { ...s, clean: 0, fails };
  // Two failures at one tempo. Remember where it broke and stop, rather than
  // grinding a motion that is not working — a hard wall at the same BPM for
  // three sessions is a mechanics problem, and more reps make it worse.
  return { ...s, clean: 0, fails: 0, bpm: Math.max(40, s.bpm - 10), ceiling: Math.max(30, s.bpm - 5), done: true };
}

// ─── streaks ─────────────────────────────────────────────────────────────────
// NON-PUNITIVE BY CONSTRUCTION, and it is worth saying why. A streak that breaks
// at midnight is a device for making someone feel bad about a Tuesday, and the
// documented consequence is that they stop opening the app rather than that they
// practise more. So: today counts if you practise today, and TODAY IS NEVER A
// BREAK — a streak you have not lost yet is still a streak until the day ends.
// The same rule the Train tab's weekly streak uses, one grain finer.
export function streak(days, today) {
  const set = new Set((days || []).filter(Boolean));
  if (!set.size || !today) return { current: 0, longest: 0, lastDay: null, practicedToday: false };
  const sorted = [...set].sort();
  // Current run: walk back from today, or from yesterday if today is still open.
  const practicedToday = set.has(today);
  let cursor = practicedToday ? today : addDays(today, -1);
  let current = 0;
  while (set.has(cursor)) { current++; cursor = addDays(cursor, -1); }
  let longest = 0, run = 0, prev = null;
  for (const d of sorted) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    prev = d;
    if (run > longest) longest = run;
  }
  return { current, longest, lastDay: sorted[sorted.length - 1], practicedToday };
}

// Minutes per week, newest week first, Monday-anchored — the same week grammar
// as the Train tab so two tabs never disagree about which week it is.
export function weekStartOf(day) {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return dayOf(d);
}
export function weeklyMinutes(sessions, { today, weeks = 12 } = {}) {
  const thisWeek = weekStartOf(today);
  if (!thisWeek) return [];
  const out = [];
  for (let i = 0; i < weeks; i++) {
    const start = addDays(thisWeek, -7 * i);
    const end = addDays(start, 6);
    const rows = (sessions || []).filter((s) => s.day >= start && s.day <= end);
    out.push({
      week: start, minutes: Math.round(rows.reduce((a, s) => a + (Number(s.minutes) || 0), 0)),
      sessions: rows.length,
      days: new Set(rows.map((s) => s.day)).size,
    });
  }
  return out;
}

// ─── the session ─────────────────────────────────────────────────────────────
// The 25-minute template this is a generalisation of:
//
//   0–3    warm-up          two of the twenty-four chromatic permutations
//   3–8    ear + fretboard  alternating days
//   8–16   skill block      2–3 items, interleaved, three cycles
//   16–17  break            hands off, non-negotiable
//   17–24  song work        one active song: chunk, seam, full run
//   24–25  log              what worked, what didn't
//
// Shares, not minutes, so the same shape survives a ten-minute session and a
// fifty-minute one. Drills are capped: past about 60% drill the documented churn
// gets worse, and a session with no music in it is a session that stops happening.
export const BLOCK_SHARES = [
  { kind: "warmup", share: 0.12, min: 120, title: "Warm-up" },
  { kind: "sharpen", share: 0.20, min: 180, title: "Ear & fretboard" },
  { kind: "skill", share: 0.32, min: 240, title: "Skill block" },
  { kind: "break", share: 0.04, min: 45, title: "Break", fixed: 60 },
  { kind: "song", share: 0.28, min: 240, title: "Song work" },
  { kind: "log", share: 0.04, min: 45, title: "Log it", fixed: 60 },
];

// Which items are due, worst first. `overdue` is what the ordering actually turns
// on — an item three days past its band matters more than one that is merely
// weak, because the weak one is being worked on and the overdue one is leaving.
export function dueItems(skills, today) {
  return (skills || [])
    .map((s) => {
      const strength = currentStrength(s, today);
      const due = dueDay(s);
      const overdue = due ? Math.max(0, daysBetween(due, today) ?? 0) : 999; // never practised = maximally due
      return { ...s, strengthNow: strength, due, overdue, band: bandFor(strength) };
    })
    .sort((a, b) => b.overdue - a.overdue || a.strengthNow - b.strengthNow);
}

// THE ONE THAT DECIDES WHAT TODAY LOOKS LIKE.
//
// Invariants the smoke asserts, each one a way this could quietly go wrong:
//   · at most two acquisition items — three new things in one sitting is how
//     nothing gets consolidated;
//   · at least one item that is NOT fragile, so the session contains something
//     that goes well;
//   · the same item never opens two consecutive sessions (`lastSession`), which
//     is the anti-rut rule;
//   · a song block whenever there is a song to play — the headline metric of this
//     whole tab is repertoire, not accuracy;
//   · every block has a positive duration, and they add up to the time asked for.
export function buildSession(skills, { minutes = 25, today, lastSession = null, songs = [], seed = 0 } = {}) {
  const total = Math.max(5, Math.min(120, Math.round(minutes))) * 60;
  const pool = dueItems(skills, today);
  const lastIds = new Set((lastSession?.items || []).map((i) => i.id));

  // Skill picks: the most overdue first, but never repeating what opened the last
  // session, and capped at two items still in acquisition.
  const picks = [];
  let acquisitions = 0;
  for (const s of pool) {
    if (picks.length >= 3) break;
    if (picks.length === 0 && lastIds.has(s.id) && pool.length > 1) continue;
    if (isAcquisition(s)) { if (acquisitions >= 2) continue; acquisitions++; }
    picks.push(s);
  }
  // Nothing overdue is a real state and it is not "nothing to do": take the
  // weakest three anyway, which is what maintenance looks like.
  if (!picks.length && pool.length) picks.push(...pool.slice(0, 3));

  // Blocked while acquiring, interleaved once maintaining — see isAcquisition.
  const schedule = picks.length > 1 && picks.every((p) => !isAcquisition(p)) ? "interleaved" : "blocked";

  const blocks = [];
  let allotted = 0;
  for (const b of BLOCK_SHARES) {
    if (b.kind === "song" && !songs.length) continue;
    if (b.kind === "skill" && !picks.length) continue;
    const seconds = b.fixed ?? Math.max(b.min, Math.round((total * b.share) / 15) * 15);
    allotted += seconds;
    blocks.push({ ...b, seconds, items: b.kind === "skill" ? picks : [], schedule: b.kind === "skill" ? schedule : null });
  }
  // Rescale the flexible blocks so the session is the length that was asked for.
  // The break and the log are fixed — a break that shrinks with the session is
  // not a break, and one minute to write down what happened is one minute.
  const fixed = blocks.filter((b) => b.fixed).reduce((a, b) => a + b.seconds, 0);
  const flexible = allotted - fixed;
  const room = Math.max(60, total - fixed);
  if (flexible > 0) {
    for (const b of blocks) if (!b.fixed) b.seconds = Math.max(30, Math.round((b.seconds * room) / flexible / 15) * 15);
  }

  // Which song. Whatever is being learned, oldest-touched first, so a repertoire
  // does not quietly become one song played forever.
  const learning = songs.filter((s) => s.status === "learning");
  const song = (learning.length ? learning : songs).slice().sort((a, b) => String(a.lastPlayed || "").localeCompare(String(b.lastPlayed || "")))[0] || null;
  for (const b of blocks) if (b.kind === "song") b.song = song;

  // Ear on even days, fretboard on odd — alternating rather than both, because
  // five minutes split two ways is two things done badly. `seed` lets the caller
  // pin it for a test.
  //
  // EXCEPT WHERE THE FRETBOARD IS NOT UNLOCKED YET, and that was a real bug on
  // screen: the Note Finder is level-4 material, the alternation did not know
  // that, and a brand-new account's second block was "find every C♯ on the neck"
  // for somebody who had met two chords. Ear training has no such floor — the
  // first tier is 1, 3 and 5 against a drone, which is a day-one exercise — so
  // when the pool holds no fretboard skill, the block is always ear.
  const hasFretboard = (skills || []).some((s) => s.kind === "fretboard");
  const dayNum = today ? Math.abs(daysBetween("2000-01-01", today) ?? 0) + seed : seed;
  for (const b of blocks) if (b.kind === "sharpen") b.focus = !hasFretboard || dayNum % 2 === 0 ? "ear" : "fretboard";

  return {
    day: today,
    minutes: Math.round(blocks.reduce((a, b) => a + b.seconds, 0) / 60),
    seconds: blocks.reduce((a, b) => a + b.seconds, 0),
    blocks,
    picks,
    schedule,
    // What the session is FOR, in one line, at the top of the card. A plan you
    // cannot summarise is a plan nobody follows.
    focus: picks.length
      ? `${picks[0].name}${picks.length > 1 ? ` + ${picks.length - 1} more` : ""}`
      : songs.length ? "Repertoire" : "Getting started",
  };
}

// ─── the log ─────────────────────────────────────────────────────────────────
// A finished session, folded back into every item it touched. Returns BOTH the
// session row and the updated skills, because writing one without the other is
// how a practice log and a progress screen start disagreeing.
export function completeSession(session, results, skills) {
  const byId = new Map((skills || []).map((s) => [s.id, s]));
  const day = session?.day || dayOf(Date.now());
  const updated = [];
  for (const r of results || []) {
    const prev = byId.get(r.id) || { id: r.id, name: r.name, strength: 0, sessions: 0, minutes: 0, history: [] };
    updated.push(applyResult(prev, { rating: r.rating, bpm: r.bpm ?? null, day, seconds: r.seconds ?? 0 }));
  }
  const seconds = (results || []).reduce((a, r) => a + (r.seconds || 0), 0);
  return {
    session: {
      day,
      minutes: Math.max(1, Math.round(seconds / 60)),
      items: (results || []).map((r) => ({ id: r.id, name: r.name, rating: r.rating, bpm: r.bpm ?? null, seconds: r.seconds ?? 0 })),
      focus: session?.focus || null,
    },
    skills: [...(skills || []).filter((s) => !updated.some((u) => u.id === s.id)), ...updated],
  };
}

// ─── timing measurement ──────────────────────────────────────────────────────
// The Drop-the-Click drill's whole point: the metronome goes silent for four
// bars and comes back, and the question is where you were when it did. Reported
// in milliseconds with a direction, because "you rush" is a diagnosis and "you
// are 34 ms early on average" is something you can practise against.
export function measureDrift(clickTimes, hitTimes) {
  const clicks = (clickTimes || []).filter((t) => Number.isFinite(t));
  const hits = (hitTimes || []).filter((t) => Number.isFinite(t));
  if (!clicks.length || !hits.length) return null;
  const errors = [];
  for (const h of hits) {
    // Nearest click, signed: negative is early (rushing), positive is late.
    let best = null;
    for (const c of clicks) { const e = h - c; if (best == null || Math.abs(e) < Math.abs(best)) best = e; }
    if (best != null) errors.push(best * 1000);
  }
  if (!errors.length) return null;
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const sd = Math.sqrt(errors.reduce((a, b) => a + (b - mean) ** 2, 0) / errors.length);
  const worst = errors.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  return {
    meanMs: Math.round(mean * 10) / 10,
    sdMs: Math.round(sd * 10) / 10,
    worstMs: Math.round(worst * 10) / 10,
    n: errors.length,
    // A tendency, only when there is one: under 8 ms of mean error is not a
    // direction, it is measurement noise, and calling it "rushing" would be the
    // app inventing a fault.
    tendency: Math.abs(mean) < 8 ? "even" : mean < 0 ? "rushing" : "dragging",
  };
}
