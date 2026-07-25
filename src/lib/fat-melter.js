// ─── Fat Melter — a generated fat-loss session ────────────────────────────────
// Four taps → a session built for maximum energy cost per minute WITHOUT throwing
// away muscle. Pure (no React, no I/O) so scripts/fat-melter-smoke.mjs can test
// it, same contract as workout-engine and workout-library.
//
// ── What actually drives fat loss, and what this can honestly claim ───────────
// The deficit does the fat loss. Training's job is to (a) spend energy and
// (b) protect lean mass while you're in that deficit — losing muscle drops your
// BMR and makes the weight easier to regain. So this is NOT a cardio generator.
// Every session is:
//
//   1. PRIME     one easy conditioning move, ~2 min, to get warm.
//   2. STRENGTH  two compound lifts, paired as a superset. This is the part that
//                keeps muscle. Heaviest, most muscle mass, longest rest.
//   3. CIRCUIT   4 moves × N rounds, short rest. Density is the lever here: more
//                work in the same minutes = more energy spent.
//   4. FINISHER  one conditioning move in intervals, to empty the tank.
//
// EPOC ("afterburn") is real but small — single-digit percent of session burn.
// It's a bonus, not the mechanism, and the UI says so rather than selling it.
//
// ── Integration ──────────────────────────────────────────────────────────────
// Returns the same shape buildPerfectWorkout does, so onStart / onSaveRoutine in
// WorkoutPanel take it with no changes. Exercise NAMES are drawn from the names
// WorkoutPanel's own library uses, so a started session prefills weights from
// your history and every move classifies into the muscle-group heatmap.
// `blocks` rides along for the preview UI and is dropped on the way to the DB.

import { muscleGroupOf, groupFreshness } from "./workout-engine.js";

// ─── the quiz — four taps, all single-select ──────────────────────────────────
export const MELT_QUIZ = [
  {
    key: "time",
    q: "How long have you got?",
    options: [
      { key: 20, label: "20 min" },
      { key: 30, label: "30 min" },
      { key: 45, label: "45 min" },
      { key: 60, label: "60 min" },
    ],
  },
  {
    key: "gear",
    q: "What have you got?",
    options: [
      { key: "gym", label: "Full gym" },
      { key: "dumbbell", label: "Dumbbells" },
      { key: "bodyweight", label: "Just me" },
    ],
  },
  {
    key: "impact",
    q: "Jumping and impact OK?",
    help: "Low impact keeps both feet down — knees, or a downstairs neighbour.",
    options: [
      { key: "full", label: "Jumping's fine" },
      { key: "low", label: "Low impact" },
    ],
  },
  {
    key: "intensity",
    q: "How hard do you want it?",
    options: [
      { key: "steady", label: "Steady" },
      { key: "hard", label: "Hard" },
      { key: "brutal", label: "Brutal" },
    ],
  },
];

const GEAR_RANK = { bodyweight: 0, dumbbell: 1, gym: 2 };

// Intensity sets DENSITY, not just effort — shorter rest is the actual lever on
// energy cost per minute. rounds/rest are what change; the moves don't get
// "harder", the clock does.
const INTENSITY = {
  steady: { rounds: 3, circuitRest: 30, strengthRest: 90,  strengthSets: 3, finisherSets: 4, label: "Steady",  note: "Room to breathe between moves." },
  hard:   { rounds: 4, circuitRest: 20, strengthRest: 75,  strengthSets: 3, finisherSets: 5, label: "Hard",    note: "Short rest — you'll feel the density." },
  brutal: { rounds: 5, circuitRest: 12, strengthRest: 60,  strengthSets: 4, finisherSets: 6, label: "Brutal",  note: "Barely any rest. Scale the load, not the clock." },
};

// ─── the move pool ───────────────────────────────────────────────────────────
// gear   = minimum equipment tier needed
// impact = "low" is safe for low-impact; "full" needs jumping/landing allowed
// cost   = relative energy cost, used to prefer big spenders when picking
// Names match WorkoutPanel's library so weights prefill and groups classify.
const ex = (name, gear, impact, cost) => ({ name, gear, impact, cost, group: muscleGroupOf(name) });

const PRIMERS = [
  ex("Jump Rope", "bodyweight", "full", 2),
  ex("Mountain Climber", "bodyweight", "low", 2),
  ex("Rowing (Erg)", "gym", "low", 2),
  ex("High Knees", "bodyweight", "full", 2),
];

// Compound, multi-joint, big muscle mass. This block is the muscle insurance.
const STRENGTH = [
  ex("Back Squat", "gym", "low", 5),
  ex("Deadlift", "gym", "low", 5),
  ex("Romanian Deadlift", "dumbbell", "low", 4),
  ex("Barbell Row", "gym", "low", 4),
  ex("Barbell Bench Press", "gym", "low", 4),
  ex("Lat Pulldown", "gym", "low", 3),
  ex("Goblet Squat", "dumbbell", "low", 4),
  ex("Dumbbell Bench Press", "dumbbell", "low", 3),
  ex("Dumbbell Row", "dumbbell", "low", 3),
  ex("Seated Dumbbell Press", "dumbbell", "low", 3),
  ex("Bulgarian Split Squat", "bodyweight", "low", 4),
  ex("Push-Up", "bodyweight", "low", 3),
  ex("Inverted Row", "bodyweight", "low", 3),
  ex("Walking Lunge", "bodyweight", "low", 3),
];

// Fast, repeatable, minimal setup — a move that needs plate changes kills a circuit.
const CIRCUIT = [
  ex("Kettlebell Swing", "dumbbell", "low", 5),
  ex("Thruster", "dumbbell", "low", 5),
  ex("Goblet Squat", "dumbbell", "low", 4),
  ex("Burpee", "bodyweight", "full", 5),
  ex("Box Jump", "gym", "full", 4),
  ex("Skater Hop", "bodyweight", "full", 3),
  ex("Jumping Jack", "bodyweight", "full", 2),
  ex("Mountain Climber", "bodyweight", "low", 3),
  ex("Bear Crawl", "bodyweight", "low", 3),
  ex("Air Squat", "bodyweight", "low", 3),
  ex("Walking Lunge", "bodyweight", "low", 3),
  ex("Push-Up", "bodyweight", "low", 3),
  ex("Inverted Row", "bodyweight", "low", 3),
  ex("Dumbbell Row", "dumbbell", "low", 3),
  ex("Russian Twist", "bodyweight", "low", 2),
  ex("Plank", "bodyweight", "low", 2),
  ex("Farmer's Carry", "dumbbell", "low", 3),
  ex("Step-Up", "bodyweight", "low", 3),
];

const FINISHERS = [
  ex("Kettlebell Swing", "dumbbell", "low", 5),
  ex("Burpee", "bodyweight", "full", 5),
  ex("Rowing (Erg)", "gym", "low", 4),
  ex("Jump Rope", "bodyweight", "full", 3),
  ex("Mountain Climber", "bodyweight", "low", 3),
];

const usable = (pool, gear, impact) => {
  const have = GEAR_RANK[gear] ?? 2;
  return pool.filter((m) => (GEAR_RANK[m.gear] ?? 0) <= have && (impact === "full" || m.impact === "low"));
};

// Hold-for-time moves are logged as one "rep" (a hold), matching the library's
// convention — Plank is targetReps 1 there too.
const HOLDS = new Set(["Plank", "Side Plank", "Wall Sit", "Bear Crawl", "Farmer's Carry"]);
const REPS = {
  "Jump Rope": 60, "High Knees": 40, "Jumping Jack": 40, "Mountain Climber": 30,
  "Russian Twist": 24, "Air Squat": 20, "Skater Hop": 20, "Step-Up": 16,
  "Kettlebell Swing": 15, "Burpee": 12, "Box Jump": 12, "Walking Lunge": 14,
  "Thruster": 12, "Goblet Squat": 15, "Push-Up": 15, "Inverted Row": 12,
  "Dumbbell Row": 12, "Rowing (Erg)": 60,
};
const repsFor = (m) => (HOLDS.has(m.name) ? 1 : REPS[m.name] ?? 12);
// Strength block chases 8–12: enough load to hold muscle, enough reps to spend energy.
const strengthReps = (m) => (m.cost >= 5 ? 8 : 10);

/** Pick `n` moves, preferring high energy cost and FRESH muscle groups, and never
 *  two moves from the same group back to back — a circuit that hits legs four
 *  times in a row stops being a circuit and becomes a leg workout you can't
 *  finish. `fresh` is a group→pct map from groupFreshness. */
function pick(pool, n, fresh, { spreadGroups = true } = {}) {
  const scored = pool
    .map((m) => ({ m, s: m.cost * 10 + ((fresh.get(m.group)?.pct ?? 100) / 10) }))
    .sort((a, b) => b.s - a.s);
  const out = [];
  const usedGroups = new Set();
  for (const { m } of scored) {
    if (out.length >= n) break;
    if (out.some((o) => o.name === m.name)) continue;
    if (spreadGroups && usedGroups.has(m.group) && out.length < n) continue;
    out.push(m);
    usedGroups.add(m.group);
  }
  // Not enough distinct groups in the filtered pool (bodyweight + low impact is
  // the tight case) — fill the rest allowing repeats rather than returning short.
  for (const { m } of scored) {
    if (out.length >= n) break;
    if (!out.some((o) => o.name === m.name)) out.push(m);
  }
  return out;
}

/** Rough minute estimate for a block, so the time answer actually constrains the
 *  session instead of decorating it. ~40s of work per set is the assumption. */
const blockMinutes = (moves, sets, restSec) =>
  (moves.length * sets * (40 + restSec)) / 60;

/**
 * Build a fat-loss session from the four answers.
 * @param answers  { time, gear, impact, intensity } — every field optional
 * @param opts     { sessions } logged sessions, used to bias away from muscle
 *                 you haven't recovered from yet
 * @returns the buildPerfectWorkout shape + `blocks` for the preview
 */
export function buildFatMelter(answers = {}, { sessions = [] } = {}) {
  const gear = GEAR_RANK[answers.gear] != null ? answers.gear : "dumbbell";
  const impact = answers.impact === "low" ? "low" : "full";
  const cfg = INTENSITY[answers.intensity] || INTENSITY.hard;
  const minutes = Number(answers.time) || 30;
  const fresh = new Map(groupFreshness(sessions || []).map((f) => [f.group, f]));

  // Short sessions drop the strength block LAST, not first. It's the part that
  // protects muscle in a deficit — cutting it would make the session worse at the
  // actual job while looking busier.
  const strengthCount = minutes <= 20 ? 1 : 2;
  // An hour needs more than extra rounds: 6 rounds of a 5-move circuit still only
  // fills ~49 min, which read as the time answer being ignored. A 60-minute ask
  // gets a wider circuit and a fourth strength set — more work, not a longer
  // grind through the same four moves.
  const circuitCount = minutes <= 20 ? 3 : minutes >= 60 ? 6 : minutes >= 45 ? 5 : 4;
  let strengthSets = cfg.strengthSets + (minutes >= 60 ? 1 : 0);
  const wantFinisher = minutes >= 30;
  const wantPrimer = minutes >= 30;

  const primerPool = usable(PRIMERS, gear, impact);
  const strengthPool = usable(STRENGTH, gear, impact);
  const circuitPool = usable(CIRCUIT, gear, impact);
  const finisherPool = usable(FINISHERS, gear, impact);

  // Blocks are picked in order of how much they matter, and each one excludes
  // everything already chosen. A repeated move reads as padding, and the pools
  // genuinely overlap — Mountain Climber and Jump Rope are both a primer AND a
  // finisher, so without a shared exclusion set a bodyweight session opened and
  // closed on the same move.
  //
  // The PRIMER goes last on purpose. Bodyweight + low impact leaves exactly one
  // legal conditioning move, and if the primer claimed it first the finisher —
  // the block that actually empties the tank — got dropped instead. Two minutes
  // of warm-up is the cheapest thing to lose.
  const used = new Set();
  const take = (pool, n, opts) => {
    const got = pick(pool.filter((m) => !used.has(m.name)), n, fresh, opts);
    got.forEach((m) => used.add(m.name));
    return got;
  };
  const strength = take(strengthPool, strengthCount);
  const circuit = take(circuitPool, circuitCount);
  const finisher = wantFinisher ? take(finisherPool, 1, { spreadGroups: false }) : [];
  const primer = wantPrimer ? take(primerPool, 1, { spreadGroups: false }) : [];

  // Fit the clock by trimming ROUNDS before moves: fewer rounds of a full circuit
  // beats a half circuit, because the group coverage is the point.
  let rounds = cfg.rounds;
  const fixed = () =>
    (primer.length ? 2 : 0) +
    blockMinutes(strength, strengthSets, cfg.strengthRest) +
    (finisher.length ? blockMinutes(finisher, cfg.finisherSets, 30) : 0);
  const total = (r) => fixed() + blockMinutes(circuit, r, cfg.circuitRest);
  while (rounds > 2 && total(rounds) > minutes + 3) rounds--;
  // …and GROW to fill the time you said you had. Trimming alone meant a 60-minute
  // answer produced a 39-minute session — it read as the time question being
  // decorative. Capped at 6 rounds: past that it's a different workout, not a
  // longer one, and set quality falls off a cliff.
  while (rounds < 6 && total(rounds + 1) <= minutes + 2) rounds++;
  // Still short after the rounds cap? That's the tight pools — low-impact
  // bodyweight has nine legal circuit moves and no jumping, so an hour can't be
  // filled with laps. Put the remaining time into STRENGTH sets rather than a
  // seventh identical round: it's the block that protects muscle, so extra volume
  // there makes the session better at its job instead of just longer.
  while (strengthSets < 6 && total(rounds) + blockMinutes(strength, 1, cfg.strengthRest) <= minutes + 2) strengthSets++;

  const blocks = [
    primer.length && {
      key: "prime", label: "Prime", note: "Easy pace — just get warm.",
      moves: primer.map((m) => ({ name: m.name, sets: 1, reps: repsFor(m), restSec: 30, group: m.group })),
    },
    strength.length && {
      key: "strength", label: "Strength", note: `Superset. ${cfg.strengthRest}s rest — this block is your muscle insurance, so load it honestly.`,
      moves: strength.map((m) => ({ name: m.name, sets: strengthSets, reps: strengthReps(m), restSec: cfg.strengthRest, group: m.group })),
    },
    circuit.length && {
      key: "circuit", label: `Circuit · ${rounds} rounds`, note: `${cfg.circuitRest}s between moves, 60s between rounds. Density is the point.`,
      moves: circuit.map((m) => ({ name: m.name, sets: rounds, reps: repsFor(m), restSec: cfg.circuitRest, group: m.group })),
    },
    finisher.length && {
      key: "finisher", label: "Finisher", note: `${cfg.finisherSets} hard intervals, 30s rest. Empty the tank.`,
      moves: finisher.map((m) => ({ name: m.name, sets: cfg.finisherSets, reps: repsFor(m), restSec: 30, group: m.group })),
    },
  ].filter(Boolean);

  const exercises = blocks.flatMap((b) =>
    b.moves.map((m) => ({ name: m.name, targetSets: m.sets, targetReps: m.reps, restSec: m.restSec })),
  );
  const estMinutes = Math.round(
    (primer.length ? 2 : 0) +
    blockMinutes(strength, strengthSets, cfg.strengthRest) +
    blockMinutes(circuit, rounds, cfg.circuitRest) +
    (finisher.length ? blockMinutes(finisher, cfg.finisherSets, 30) : 0),
  );
  const groups = [...new Set(exercises.map((e) => muscleGroupOf(e.name)).filter((g) => g !== "Other"))];

  return {
    id: null,
    sourceId: `melt-${gear}-${impact}-${cfg.label.toLowerCase()}-${minutes}`,
    name: `Fat Melter · ${minutes} min`,
    blurb: `${cfg.label} density, ${groups.length} muscle groups, strength kept in so the deficit takes fat and not muscle.`,
    focus: "full",
    time: minutes,
    estMinutes,
    intensity: cfg.label,
    intensityNote: cfg.note,
    rounds,
    groups,
    blocks,
    exercises,
  };
}
