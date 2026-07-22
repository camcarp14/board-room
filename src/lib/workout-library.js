// ─── Workout library + the "perfect workout" recommender ─────────────────────
// The Train tab's zero-friction path: tap a few answers, get a workout you can
// start in one tap. Everything here is PURE (no React, no I/O) so it can be
// unit-tested by scripts/workout-library-smoke.mjs (wired into `npm run
// verify`). Guard, don't throw: bad input → a sensible default, never a crash.
//
// Exercise NAMES deliberately match the WorkoutPanel exercise library so a
// started session prefills weights from your own history and the muscle-group
// heatmap classifies every move — no special-casing needed downstream.

import { muscleGroupOf, groupFreshness } from "./workout-engine.js";

// ─── the quiz — every question is tap-only, single-select ────────────────────
// `key` is what the answer object stores; option `key` is the stored value.
export const QUIZ = [
  {
    key: "focus",
    q: "What do you feel like training?",
    help: "Pick a split, or let it choose.",
    options: [
      { key: "full", label: "Full body" },
      { key: "push", label: "Push" },
      { key: "pull", label: "Pull" },
      { key: "legs", label: "Legs" },
      { key: "upper", label: "Upper body" },
      { key: "core", label: "Core & abs" },
      { key: "cardio", label: "Cardio" },
      { key: "any", label: "Surprise me" },
    ],
  },
  {
    key: "time",
    q: "How much time have you got?",
    options: [
      { key: 20, label: "20 min" },
      { key: 30, label: "30 min" },
      { key: 45, label: "45 min" },
      { key: 60, label: "60+ min" },
    ],
  },
  {
    key: "energy",
    q: "How's your energy?",
    options: [
      { key: "high", label: "Fresh — bring it" },
      { key: "normal", label: "Normal" },
      { key: "low", label: "Low / sore" },
    ],
  },
  {
    key: "equipment",
    q: "What do you have?",
    options: [
      { key: "gym", label: "Full gym" },
      { key: "dumbbell", label: "Dumbbells" },
      { key: "bodyweight", label: "Just me" },
    ],
  },
];

// Equipment is a ladder: a full gym can do everything, dumbbells can do
// bodyweight moves, and so on. A workout is doable when the gear it needs
// ranks at or below what you've got.
export const EQUIP_RANK = { bodyweight: 0, dumbbell: 1, gym: 2 };

const FOCUS_REASON = {
  full: "hits the whole body",
  push: "chest, shoulders & triceps",
  pull: "back & biceps",
  legs: "legs & posterior chain",
  upper: "everything above the waist",
  core: "core & abs",
  cardio: "heart-rate work",
};
const EQUIP_REASON = { gym: "uses your full gym", dumbbell: "dumbbells only", bodyweight: "no equipment needed" };
// A focus can partially satisfy a neighbor (an Upper day covers Push cravings).
const RELATED = {
  full: ["upper", "legs", "push", "pull"],
  upper: ["push", "pull", "full"],
  push: ["upper", "full"],
  pull: ["upper", "full"],
  legs: ["full"],
  core: ["full"],
  cardio: ["full"],
};

// ─── the curated workouts ────────────────────────────────────────────────────
// Ordered compounds-first so trimming for a short session drops accessories,
// never the money lifts. `time` is the baseline length in minutes.
const ex = (name, targetSets, targetReps, restSec) => ({ name, targetSets, targetReps, restSec });

export const WORKOUT_LIBRARY = [
  // ── Full body ──
  {
    id: "full-strength", name: "Full Body Strength", focus: "full", equipment: "gym", level: "all", time: 45,
    blurb: "The big lifts in one session — squat, press, hinge, pull.",
    exercises: [ex("Back Squat", 3, 5, 150), ex("Barbell Bench Press", 3, 5, 150), ex("Barbell Row", 3, 8, 120), ex("Overhead Press (Barbell)", 3, 8, 120), ex("Plank", 3, 1, 60)],
  },
  {
    id: "full-express-db", name: "Full Body Express", focus: "full", equipment: "dumbbell", level: "all", time: 30,
    blurb: "Five moves, dumbbells only — in and out in half an hour.",
    exercises: [ex("Goblet Squat", 3, 10, 90), ex("Dumbbell Bench Press", 3, 10, 90), ex("Dumbbell Row", 3, 10, 90), ex("Seated Dumbbell Press", 3, 10, 75), ex("Plank", 3, 1, 45)],
  },
  {
    id: "bodyweight-burner", name: "Bodyweight Burner", focus: "full", equipment: "bodyweight", level: "all", time: 20,
    blurb: "No gear, no excuses — a full-body circuit anywhere.",
    exercises: [ex("Push-Up", 3, 12, 60), ex("Walking Lunge", 3, 12, 60), ex("Plank", 3, 1, 45), ex("Burpee", 3, 10, 60), ex("Side Plank", 3, 1, 30)],
  },
  // ── Push ──
  {
    id: "push-gym", name: "Push Day", focus: "push", equipment: "gym", level: "all", time: 50,
    blurb: "Chest, shoulders, triceps — press heavy, finish with a pump.",
    exercises: [ex("Barbell Bench Press", 4, 6, 150), ex("Incline Dumbbell Press", 3, 10, 120), ex("Overhead Press (Barbell)", 3, 8, 120), ex("Lateral Raise", 3, 15, 60), ex("Triceps Pushdown", 3, 12, 60), ex("Dip (Triceps)", 2, 10, 60)],
  },
  {
    id: "push-db", name: "Dumbbell Push", focus: "push", equipment: "dumbbell", level: "all", time: 35,
    blurb: "Chest and shoulders with just a pair of dumbbells.",
    exercises: [ex("Dumbbell Bench Press", 4, 10, 120), ex("Incline Dumbbell Press", 3, 10, 90), ex("Seated Dumbbell Press", 3, 10, 90), ex("Lateral Raise", 3, 15, 60), ex("Overhead Triceps Extension", 3, 12, 60)],
  },
  {
    id: "push-bw", name: "Bodyweight Push", focus: "push", equipment: "bodyweight", level: "all", time: 20,
    blurb: "Push volume with zero equipment.",
    exercises: [ex("Push-Up", 4, 15, 60), ex("Dip (Chest)", 3, 10, 75), ex("Pike Push-Up", 3, 10, 60), ex("Plank", 3, 1, 45)],
  },
  // ── Pull ──
  {
    id: "pull-gym", name: "Pull Day", focus: "pull", equipment: "gym", level: "all", time: 50,
    blurb: "Back and biceps — pull from the floor and the bar.",
    exercises: [ex("Deadlift", 3, 5, 180), ex("Pull-Up", 4, 8, 120), ex("Seated Cable Row", 3, 10, 90), ex("Lat Pulldown", 3, 12, 90), ex("Face Pull", 3, 15, 60), ex("Barbell Curl", 3, 10, 60)],
  },
  {
    id: "pull-db", name: "Dumbbell Pull", focus: "pull", equipment: "dumbbell", level: "all", time: 35,
    blurb: "Back and biceps, dumbbells only.",
    exercises: [ex("Dumbbell Row", 4, 10, 90), ex("Rear Delt Fly", 3, 15, 60), ex("Hammer Curl", 3, 12, 60), ex("Dumbbell Curl", 3, 12, 60), ex("Shrug", 3, 15, 60)],
  },
  {
    id: "pull-bw", name: "Bodyweight Pull", focus: "pull", equipment: "bodyweight", level: "all", time: 20,
    blurb: "Grab a bar — back and biceps, nothing else needed.",
    exercises: [ex("Pull-Up", 4, 8, 120), ex("Chin-Up", 3, 8, 90), ex("Inverted Row", 3, 12, 75), ex("Superman", 3, 12, 45)],
  },
  // ── Legs ──
  {
    id: "legs-gym", name: "Leg Day", focus: "legs", equipment: "gym", level: "all", time: 50,
    blurb: "Quads, hamstrings, calves — squat and hinge.",
    exercises: [ex("Back Squat", 4, 6, 180), ex("Romanian Deadlift", 3, 8, 150), ex("Leg Press", 3, 12, 120), ex("Leg Curl", 3, 12, 90), ex("Calf Raise", 4, 15, 60)],
  },
  {
    id: "legs-db", name: "Dumbbell Legs", focus: "legs", equipment: "dumbbell", level: "all", time: 35,
    blurb: "Leg day with a pair of dumbbells.",
    exercises: [ex("Goblet Squat", 4, 12, 120), ex("Bulgarian Split Squat", 3, 10, 90), ex("Romanian Deadlift", 3, 10, 90), ex("Walking Lunge", 3, 12, 75), ex("Calf Raise", 4, 15, 45)],
  },
  {
    id: "legs-bw", name: "Bodyweight Legs", focus: "legs", equipment: "bodyweight", level: "all", time: 20,
    blurb: "Burn out your legs anywhere.",
    exercises: [ex("Bulgarian Split Squat", 4, 12, 60), ex("Walking Lunge", 3, 15, 60), ex("Air Squat", 3, 20, 45), ex("Calf Raise", 4, 20, 30), ex("Wall Sit", 3, 1, 45)],
  },
  // ── Upper ──
  {
    id: "upper-gym", name: "Upper Body", focus: "upper", equipment: "gym", level: "all", time: 45,
    blurb: "Everything above the waist — push and pull balanced.",
    exercises: [ex("Barbell Bench Press", 4, 8, 120), ex("Barbell Row", 4, 8, 120), ex("Overhead Press (Barbell)", 3, 10, 90), ex("Lat Pulldown", 3, 12, 90), ex("Barbell Curl", 3, 12, 60), ex("Triceps Pushdown", 3, 12, 60)],
  },
  {
    id: "upper-db", name: "Dumbbell Upper", focus: "upper", equipment: "dumbbell", level: "all", time: 35,
    blurb: "A full upper body with dumbbells.",
    exercises: [ex("Dumbbell Bench Press", 4, 10, 90), ex("Dumbbell Row", 4, 10, 90), ex("Seated Dumbbell Press", 3, 10, 75), ex("Hammer Curl", 3, 12, 60), ex("Overhead Triceps Extension", 3, 12, 60)],
  },
  // ── Core ──
  {
    id: "core-circuit", name: "Core Circuit", focus: "core", equipment: "bodyweight", level: "all", time: 15,
    blurb: "Focused minutes on the middle.",
    exercises: [ex("Plank", 3, 1, 45), ex("Hanging Leg Raise", 3, 12, 60), ex("Russian Twist", 3, 20, 45), ex("Dead Bug", 3, 12, 45), ex("Side Plank", 3, 1, 30)],
  },
  // ── Cardio / conditioning ──
  {
    id: "conditioning", name: "Conditioning Blast", focus: "cardio", equipment: "bodyweight", level: "all", time: 20,
    blurb: "Heart-rate intervals — no machine required.",
    exercises: [ex("Burpee", 4, 15, 60), ex("Box Jump", 4, 12, 60), ex("Jump Rope", 4, 50, 45), ex("Mountain Climber", 4, 30, 45)],
  },
  {
    id: "conditioning-db", name: "Kettlebell Conditioning", focus: "cardio", equipment: "dumbbell", level: "all", time: 25,
    blurb: "Swings and carries — power plus a pump.",
    exercises: [ex("Kettlebell Swing", 5, 15, 60), ex("Farmer's Carry", 4, 1, 60), ex("Goblet Squat", 4, 15, 60), ex("Burpee", 3, 12, 45)],
  },
];

// ─── derived helpers ─────────────────────────────────────────────────────────
/** The muscle groups a workout hits, most-worked first, "Other" dropped. */
export function primaryGroups(workout) {
  const counts = {};
  for (const e of workout?.exercises || []) {
    const g = muscleGroupOf(e.name);
    if (g === "Other") continue;
    counts[g] = (counts[g] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

/** Total working sets across a workout's exercises. */
export function totalSets(exercises) {
  return (exercises || []).reduce((n, e) => n + (Number(e.targetSets) || 0), 0);
}

/** Trim a workout's exercises to roughly fit `minutes`. Keeps compounds
 *  (they're listed first), never drops below 3 moves, never invents any. */
export function fitToTime(workout, minutes) {
  const all = (workout?.exercises || []).map((e) => ({ ...e }));
  const base = Number(workout?.time) || 0;
  const m = Number(minutes);
  if (!m || !base || m >= base) return all;
  const keep = Math.max(3, Math.round(all.length * (m / base)));
  return all.slice(0, Math.min(all.length, keep));
}

/** Dial set counts to today's energy: low trims a set (floor 2), high adds a
 *  set to the first two compounds (ceiling 6), normal leaves it be. */
export function scaleForEnergy(exercises, energy) {
  const list = (exercises || []).map((e) => ({ ...e }));
  if (!energy || energy === "normal") return list;
  return list.map((e, i) => {
    const sets = Number(e.targetSets) || 3;
    if (energy === "low") return { ...e, targetSets: Math.max(2, sets - 1) };
    if (energy === "high") return { ...e, targetSets: i < 2 ? Math.min(6, sets + 1) : sets };
    return e;
  });
}

/** Adapt a chosen library workout to the answers — trim to time, scale to
 *  energy — and return a start-ready shape (id:null → ad-hoc, no template
 *  write-back). */
export function buildPerfectWorkout(workout, answers = {}) {
  const minutes = Number(answers.time) || null;
  const trimmed = fitToTime(workout, minutes);
  const scaled = scaleForEnergy(trimmed, answers.energy);
  return {
    id: null,
    sourceId: workout.id,
    name: workout.name,
    blurb: workout.blurb,
    focus: workout.focus,
    time: minutes || workout.time,
    exercises: scaled.map((e) => ({ name: e.name, targetSets: e.targetSets, targetReps: e.targetReps, restSec: e.restSec })),
  };
}

// ─── the recommender ─────────────────────────────────────────────────────────
/** Score every library workout against the tapped answers and (optionally)
 *  recovery from recent sessions. Returns every workout ranked best-first with
 *  a `feasible` flag and up-to-three human `reasons`. Nothing is filtered here —
 *  the caller decides whether to hide the infeasible ones. */
export function recommendWorkouts(answers = {}, { sessions = [] } = {}) {
  const focus = answers.focus || null;
  const time = Number(answers.time) || null;
  const energy = answers.energy || null;
  const equipment = answers.equipment || null;
  const availRank = equipment != null ? (EQUIP_RANK[equipment] ?? 2) : 2; // no answer → assume full gym
  const fresh = new Map(groupFreshness(sessions || []).map((f) => [f.group, f]));

  const scored = WORKOUT_LIBRARY.map((w) => {
    const reasons = [];
    let score = 0;
    const need = EQUIP_RANK[w.equipment] ?? 0;
    const feasible = need <= availRank;
    if (!feasible) score -= 1000; // never surface something you can't actually do
    else if (equipment && need === availRank) { score += 5; if (EQUIP_REASON[equipment]) reasons.push(EQUIP_REASON[equipment]); }

    if (focus && focus !== "any") {
      if (w.focus === focus) { score += 40; if (FOCUS_REASON[w.focus]) reasons.push(FOCUS_REASON[w.focus]); }
      else if ((RELATED[focus] || []).includes(w.focus)) score += 10;
      else score -= 25;
    }

    if (time) {
      const diff = Math.abs((w.time || 0) - time);
      score += Math.max(0, 15 - diff / 2);
      if (diff <= 8) reasons.push(`fits your ${time} min`);
      else if ((w.time || 0) > time) reasons.push(`trims to ~${time} min`);
    }

    // Recovery: reward hitting fresh muscle, gently penalize what you just
    // trained. Cardio has no meaningful group here, so it opts out.
    const groups = primaryGroups(w);
    if (groups.length && w.focus !== "cardio") {
      const pcts = groups.slice(0, 2).map((g) => fresh.get(g)?.pct ?? 100);
      const avgPct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
      score += (avgPct - 60) / 8;
      if (avgPct >= 90) reasons.push(`${groups[0].toLowerCase()} is fresh`);
      else if (avgPct <= 40) reasons.push(`${groups[0].toLowerCase()} still recovering`);
    }

    return { workout: w, score, feasible, reasons: reasons.slice(0, 3) };
  });

  return scored.sort((a, b) => b.score - a.score);
}
