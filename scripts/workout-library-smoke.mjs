// Workout LIBRARY smoke — PLANTED problems, known answers, zero deps.
// Covers the "perfect workout" recommender + adapters. Runs in `npm run verify`.
import {
  QUIZ, WORKOUT_LIBRARY, EQUIP_RANK, primaryGroups, totalSets,
  fitToTime, scaleForEnergy, buildPerfectWorkout, recommendWorkouts,
} from "../src/lib/workout-library.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const byId = (id) => WORKOUT_LIBRARY.find((w) => w.id === id);
const iso = (d, h = 9) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).toISOString();
const session = (date, exercises) => ({
  id: date, unit: "lb", started_at: iso(date), duration_sec: 3600,
  exercises: exercises.map(([name, sets]) => ({ name, sets: sets.map(([weight, reps]) => ({ weight, reps })) })),
});

// 0 — data integrity: every workout is well-formed and startable
check("library: non-empty, every workout has id/focus/equipment/exercises",
  WORKOUT_LIBRARY.length >= 10 && WORKOUT_LIBRARY.every((w) =>
    w.id && w.name && w.focus && EQUIP_RANK[w.equipment] != null && Array.isArray(w.exercises) && w.exercises.length >= 3 &&
    w.exercises.every((e) => e.name && e.targetSets > 0 && e.targetReps > 0 && e.restSec >= 0)));
check("library: ids are unique", new Set(WORKOUT_LIBRARY.map((w) => w.id)).size === WORKOUT_LIBRARY.length);
check("library: every focus has at least one bodyweight option (so 'just me' always has a pick)",
  ["full", "push", "pull", "legs", "core", "cardio"].every((f) =>
    WORKOUT_LIBRARY.some((w) => w.focus === f && w.equipment === "bodyweight")));
check("quiz: four tap-only questions, focus first", QUIZ.length === 4 && QUIZ[0].key === "focus" && QUIZ.every((q) => q.options.length >= 3));

// 1 — focus routing: ask for legs, get a legs workout on top
const legs = recommendWorkouts({ focus: "legs", equipment: "gym" });
check("recommend: focus=legs → a legs workout ranks first", legs[0].workout.focus === "legs", legs[0].workout.id);

// 2 — equipment feasibility: bodyweight can't surface a gym/dumbbell workout
const bw = recommendWorkouts({ focus: "legs", equipment: "bodyweight" });
check("recommend: equipment=bodyweight → top pick is feasible bodyweight",
  bw[0].feasible && bw[0].workout.equipment === "bodyweight", bw[0].workout.id);
check("recommend: a gym-only workout is marked NOT feasible for bodyweight",
  bw.find((r) => r.workout.equipment === "gym")?.feasible === false);

// 3 — time proximity: 20 minutes prefers a short workout
const quick = recommendWorkouts({ focus: "full", time: 20, equipment: "gym" });
check("recommend: focus=full,time=20 → top pick is short (≤30 min baseline)", quick[0].workout.time <= 30, String(quick[0].workout.time));

// 4 — recovery: legs trained TODAY sink below fresh muscle when focus is open
const legDayToday = session("2026-07-22", [["Back Squat", [[225, 5], [225, 5]]]]);
const openRanked = recommendWorkouts({ focus: "any", equipment: "gym" }, { sessions: [legDayToday] });
const idxLeg = openRanked.findIndex((r) => r.workout.id === "legs-gym");
const idxPush = openRanked.findIndex((r) => r.workout.id === "push-gym");
check("recommend: legs trained today ranks BELOW a fresh push day (recovery-aware)",
  idxLeg > idxPush, `leg#${idxLeg} vs push#${idxPush}`);
check("recommend: legs-gym carries a 'still recovering' reason after a leg day today",
  openRanked[idxLeg].reasons.some((r) => /recovering/.test(r)), JSON.stringify(openRanked[idxLeg].reasons));

// 5 — fitToTime: trims accessories, keeps compounds, never below 3, never invents
const full = byId("full-strength"); // 5 exercises, 45 min baseline
check("fitToTime: 20 min of a 45-min/5-move workout → 3 moves, compounds first",
  fitToTime(full, 20).length === 3 && fitToTime(full, 20)[0].name === "Back Squat");
check("fitToTime: enough time → nothing trimmed", fitToTime(full, 60).length === full.exercises.length);
check("fitToTime: never returns more moves than exist", fitToTime(full, 5).length <= full.exercises.length && fitToTime(full, 5).length >= 3);

// 6 — scaleForEnergy: low trims a set (floor 2), high adds to the first two
const push = byId("push-gym");
const low = scaleForEnergy(push.exercises, "low");
check("scaleForEnergy: low → every set count drops by one, floor 2",
  low.every((e, i) => e.targetSets === Math.max(2, push.exercises[i].targetSets - 1)));
const high = scaleForEnergy(push.exercises, "high");
check("scaleForEnergy: high → first two compounds gain a set, rest unchanged",
  high[0].targetSets === push.exercises[0].targetSets + 1 && high[2].targetSets === push.exercises[2].targetSets);
check("scaleForEnergy: normal/undefined → untouched",
  scaleForEnergy(push.exercises, "normal").every((e, i) => e.targetSets === push.exercises[i].targetSets));

// 7 — buildPerfectWorkout: composes time+energy, stays start-ready (id:null)
const built = buildPerfectWorkout(full, { time: 20, energy: "low" });
check("buildPerfectWorkout: adapts to 20min/low → 3 moves, ad-hoc (id null), keeps name",
  built.exercises.length === 3 && built.id === null && built.sourceId === "full-strength" && built.name === full.name);
check("buildPerfectWorkout: low energy actually lowered the top set count",
  built.exercises[0].targetSets === Math.max(2, full.exercises[0].targetSets - 1));

// 8 — helpers
check("primaryGroups: leg day reads Legs first", primaryGroups(byId("legs-gym"))[0] === "Legs");
check("totalSets: sums working sets", totalSets(byId("full-strength").exercises) === 15);

// 9 — defaults: no answers at all still yields a feasible top pick
const empty = recommendWorkouts({});
check("recommend: zero answers → still returns a feasible ranked list", empty.length === WORKOUT_LIBRARY.length && empty[0].feasible);

if (failed > 0) { console.error(`\nWORKOUT LIBRARY SMOKE: ${failed} FAILURE(S)`); process.exit(1); }
console.log("\nWORKOUT LIBRARY SMOKE: ALL CLEAN");
