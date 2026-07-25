// ─── Fat Melter smoke — PLANTED problems, known answers, zero deps ───────────
// buildFatMelter is pure by contract so it can be tested here, like
// workout-engine and workout-library. The assertions that matter are the ones a
// generator gets quietly wrong: an answer that doesn't change the output, a move
// the user can't physically do, a session that ignores the time you gave it, or
// an exercise name that breaks the integration downstream.
//
// Two of these cover bugs found during the build:
//   · the time answer only ever TRIMMED, so a 60-minute ask produced a 39-minute
//     session — the question looked decorative.
//   · Sled Push was in the pool with reps:1, which the shared convention renders
//     as "hold" — wrong for a distance move.
//
// Run by `npm run verify`.

import { buildFatMelter, MELT_QUIZ, capsOf } from "../src/lib/fat-melter.js";
import { muscleGroupOf } from "../src/lib/workout-engine.js";
import { WORKOUT_LIBRARY } from "../src/lib/workout-library.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const TIMES = [20, 30, 45, 60];
const GEARS = ["bodyweight", "dumbbell", "gym"];
const INTENSITIES = ["steady", "hard", "brutal"];
const IMPACTS = ["low", "full"];
const every = [];
for (const time of TIMES) for (const gear of GEARS) for (const intensity of INTENSITIES) for (const impact of IMPACTS) {
  every.push({ answers: { time, gear, impact, intensity }, w: buildFatMelter({ time, gear, impact, intensity }) });
}

// 0 — the quiz is four single-select taps, nothing to type
check("quiz is 4 questions, all with options", MELT_QUIZ.length === 4 && MELT_QUIZ.every(q => q.options.length >= 2));
check("quiz keys are the ones the builder reads",
  ["time", "gear", "impact", "intensity"].every(k => MELT_QUIZ.some(q => q.key === k)));

// 1 — never returns nothing, even with no answers at all
const bare = buildFatMelter();
check("no answers still yields a startable session", bare.exercises.length >= 3 && !!bare.name, `${bare.exercises.length} moves`);
check("empty sessions history is fine", buildFatMelter({ time: 30 }, { sessions: [] }).exercises.length >= 3);
check("null-ish opts are fine", buildFatMelter({ time: 30 }, {}).exercises.length >= 3);

// 2 — INTEGRATION: the shape WorkoutPanel's onStart / onSaveRoutine consume.
// A missing field here doesn't crash, it silently logs a broken session.
for (const { answers, w } of every) {
  const tag = `${answers.time}/${answers.gear}/${answers.intensity}/${answers.impact}`;
  if (w.id !== null) { check(`${tag}: id is null (ad-hoc, not a template)`, false); break; }
  const bad = w.exercises.find(e =>
    typeof e.name !== "string" || !e.name ||
    !Number.isInteger(e.targetSets) || e.targetSets < 1 ||
    !Number.isInteger(e.targetReps) || e.targetReps < 1 ||
    !Number.isFinite(e.restSec) || e.restSec < 0);
  if (bad) { check(`${tag}: every exercise is well-formed`, false, JSON.stringify(bad)); break; }
}
check("every combination produces a well-formed exercise list", true);

// 3 — every move name must be one the app already knows, or weight prefill and the
// muscle-group heatmap both break for that row.
const known = new Set(WORKOUT_LIBRARY.flatMap(w => w.exercises.map(e => e.name)));
const NEW_TO_MELTER = new Set(["Thruster", "Bear Crawl", "Skater Hop", "Jumping Jack", "High Knees", "Step-Up", "Rowing (Erg)", "Air Squat", "Bike Ride"]);
const allNames = [...new Set(every.flatMap(({ w }) => w.exercises.map(e => e.name)))];
const unknown = allNames.filter(n => !known.has(n) && !NEW_TO_MELTER.has(n));
check("no move is unknown to the app's exercise vocabulary", unknown.length === 0, unknown.join(", "));
const unclassified = allNames.filter(n => muscleGroupOf(n) === "Other");
check("every move classifies into a muscle group (heatmap + recovery clock)", unclassified.length === 0, unclassified.join(", "));

// 4 — the "hold" convention: reps===1 renders as "hold", so only genuine holds
// may use it. This is what Sled Push violated.
const HOLD_OK = new Set(["Plank", "Side Plank", "Wall Sit", "Bear Crawl", "Farmer's Carry"]);
const wrongHolds = [...new Set(every.flatMap(({ w }) => w.exercises.filter(e => e.targetReps === 1).map(e => e.name)))]
  .filter(n => !HOLD_OK.has(n));
check("only genuine holds use reps=1 (which the UI renders as 'hold')", wrongHolds.length === 0, wrongHolds.join(", "));

// 5 — the answers have to MATTER. An option that changes nothing is a lie.
const at = (o) => buildFatMelter({ time: 45, gear: "gym", impact: "full", intensity: "hard", ...o });
check("time changes the session", at({ time: 20 }).exercises.length !== at({ time: 60 }).exercises.length);
check("intensity changes the density (rest shrinks as it rises)",
  Math.min(...at({ intensity: "brutal" }).exercises.map(e => e.restSec)) < Math.min(...at({ intensity: "steady" }).exercises.map(e => e.restSec)));
check("intensity changes the round count", at({ intensity: "brutal" }).rounds > at({ intensity: "steady" }).rounds);
const bwNames = at({ gear: "bodyweight" }).exercises.map(e => e.name);
const gymNames = at({ gear: "gym" }).exercises.map(e => e.name);
check("gear changes the moves", bwNames.join() !== gymNames.join());

// 6 — EQUIPMENT is a hard constraint: a bodyweight answer must never surface a
// barbell, and dumbbells must never surface a machine.
const BARBELL_OR_MACHINE = ["Back Squat", "Deadlift", "Barbell Row", "Barbell Bench Press", "Lat Pulldown", "Box Jump", "Rowing (Erg)", "Seated Cable Row", "Leg Press", "Leg Curl"];
const NEEDS_LOAD = ["Kettlebell Swing", "Thruster", "Goblet Squat", "Dumbbell Row", "Dumbbell Bench Press", "Seated Dumbbell Press", "Romanian Deadlift", "Farmer's Carry", ...BARBELL_OR_MACHINE];
for (const { answers, w } of every) {
  const names = w.exercises.map(e => e.name);
  if (answers.gear === "bodyweight") {
    const cheat = names.filter(n => NEEDS_LOAD.includes(n));
    if (cheat.length) { check(`bodyweight never needs equipment (${answers.time}/${answers.intensity})`, false, cheat.join(", ")); break; }
  }
  if (answers.gear === "dumbbell") {
    const cheat = names.filter(n => BARBELL_OR_MACHINE.includes(n));
    if (cheat.length) { check(`dumbbells never need a barbell or machine (${answers.time}/${answers.intensity})`, false, cheat.join(", ")); break; }
  }
}
check("equipment answer is a hard constraint, not a preference", true);

// 7 — IMPACT is the other hard constraint. "Low impact" exists for knees and for
// downstairs neighbours; surfacing a burpee there makes the answer worthless.
const JUMPING = ["Burpee", "Box Jump", "Jump Rope", "Jumping Jack", "High Knees", "Skater Hop"];
for (const { answers, w } of every) {
  if (answers.impact !== "low") continue;
  const jumps = w.exercises.map(e => e.name).filter(n => JUMPING.includes(n));
  if (jumps.length) { check(`low impact has no jumping (${answers.time}/${answers.gear}/${answers.intensity})`, false, jumps.join(", ")); break; }
}
check("low impact never includes a jumping move", true);

// 8 — the STRENGTH block must survive. It's the reason this beats pure cardio for
// fat loss: cutting it would make the session worse at its actual job.
const noStrength = every.filter(({ w }) => !w.blocks.some(b => b.key === "strength" && b.moves.length));
check("every session keeps a strength block (muscle retention)", noStrength.length === 0,
  noStrength.map(({ answers }) => `${answers.time}/${answers.gear}`).join(", "));

// 9 — the time answer has to be honoured, in BOTH directions.
const dev = every.map(({ answers, w }) => ({ tag: `${answers.time}/${answers.gear}/${answers.intensity}/${answers.impact}`, d: Math.abs(w.estMinutes - answers.time), est: w.estMinutes }));
const worst = dev.reduce((a, b) => (b.d > a.d ? b : a));
// 10 min is the honest ceiling: 60 min of bodyweight at 12s rests can't be filled
// without inventing moves the pool doesn't have. Everything else lands inside 8.
check("estimate tracks the requested time (≤10 min anywhere)", worst.d <= 10, `worst ${worst.tag} → ${worst.est} min`);
check("all but the tightest combination land within 8 min", dev.filter(x => x.d > 8).length <= 1,
  dev.filter(x => x.d > 8).map(x => x.tag).join(", "));

// 10 — coverage: a "full body" claim needs the groups to back it up.
const thin = every.filter(({ answers, w }) => answers.time >= 30 && w.groups.length < 3);
check("30 min+ sessions hit 3+ muscle groups", thin.length === 0, thin.map(({ answers }) => `${answers.time}/${answers.gear}`).join(", "));

// 11 — no move appears twice in one session; a repeat reads as padding.
const dupes = every.filter(({ w }) => new Set(w.exercises.map(e => e.name)).size !== w.exercises.length);
check("no move is repeated inside a session", dupes.length === 0,
  dupes.slice(0, 3).map(({ answers, w }) => `${answers.time}/${answers.gear}: ${w.exercises.map(e => e.name).join("/")}`).join(" · "));

// 12 — deterministic. Same answers must give the same session, or "Save as
// routine" saves something different from what the preview showed.
const a1 = buildFatMelter({ time: 45, gear: "gym", impact: "full", intensity: "hard" });
const a2 = buildFatMelter({ time: 45, gear: "gym", impact: "full", intensity: "hard" });
check("same answers ⇒ identical session", JSON.stringify(a1) === JSON.stringify(a2));

// 13 — recovery awareness: training legs today should push the generator away from
// legs, using the same groupFreshness clock the rest of Train reads.
const legDay = {
  id: "s", unit: "lb", started_at: new Date(Date.now() - 3 * 3600e3).toISOString(), duration_sec: 3600,
  exercises: [{ name: "Back Squat", sets: [{ weight: 225, reps: 5 }, { weight: 225, reps: 5 }] }],
};
const rested = buildFatMelter({ time: 45, gear: "gym", impact: "full", intensity: "hard" }, { sessions: [] });
const sore = buildFatMelter({ time: 45, gear: "gym", impact: "full", intensity: "hard" }, { sessions: [legDay] });
const legCount = (w) => w.exercises.filter(e => muscleGroupOf(e.name) === "Legs").length;
check("a fresh leg day biases the session away from legs", legCount(sore) <= legCount(rested),
  `rested ${legCount(rested)} leg moves vs sore ${legCount(sore)}`);


// 14 — gear is a SET, not a ladder (multi-select + bike)
check("gear question is multi-select", MELT_QUIZ.find(q => q.key === "gear")?.multi === true);
check("bike is an option", MELT_QUIZ.find(q => q.key === "gear").options.some(o => o.key === "bike"));
check("a gym implies dumbbells and bodyweight", ["gym", "dumbbell", "bodyweight"].every(c => capsOf(["gym"]).has(c)));
check("a bike implies only itself", capsOf(["bike"]).has("bike") && !capsOf(["bike"]).has("dumbbell"));
check("combos union", ["dumbbell", "bike", "bodyweight"].every(c => capsOf(["dumbbell", "bike"]).has(c)));
check("a bare string still resolves (the shape before gear went multi)", capsOf("dumbbell").has("dumbbell"));
check("no answer falls back to a home setup", capsOf().has("dumbbell") && capsOf([]).has("bodyweight"));

// A bike-only answer must produce a BIKE session. Bodyweight was briefly added
// implicitly so the strength block would always survive — which silently overrode
// the selection and answered "Bike" with Bulgarian split squats and push-ups. The
// pills mean what they say now, and the missing half is STATED, not patched over.
check("bodyweight is not implied by other gear — Just me is a real choice",
  !capsOf(["bike"]).has("bodyweight"));
const bikeOnly = buildFatMelter({ time: 30, gear: ["bike"], impact: "low", intensity: "hard" });
// "Bike" is a real bicycle on a path, not a gym air bike — so the plan is a RIDE,
// measured in minutes, and it can never be a circuit move (you can't ride the
// lakefront between sets of push-ups).
check("bike alone is a ride, not an air-bike interval",
  bikeOnly.exercises.length === 1 && bikeOnly.exercises[0].name === "Bike Ride",
  bikeOnly.exercises.map(e => e.name).join(", "));
check("the ride is a TIMED effort, not a rep count", bikeOnly.exercises[0].targetReps === 1, `reps=${bikeOnly.exercises[0].targetReps}`);
check("the block note spells out the protocol in minutes", /min/.test(bikeOnly.blocks[0].note));
check("a hard ride is intervals, not one long cruise", bikeOnly.exercises[0].targetSets >= 3, bikeOnly.exercises[0].targetSets + " efforts");
check("bike alone honours the clock", Math.abs(bikeOnly.estMinutes - 30) <= 6, bikeOnly.estMinutes + " min");
check("bike alone surfaces nothing it wasn't given",
  !bikeOnly.exercises.some(e => /Dumbbell|Barbell|Kettlebell|Goblet|Thruster|Farmer|Squat|Push-Up|Row|Plank|Twist|Lunge|Crawl/.test(e.name)),
  bikeOnly.exercises.map(e => e.name).join(", "));
// Assert the CONTRACT, not the wording: the caveat has to name what's missing
// (muscle / lean mass) and point at the fix (add bodyweight or dumbbells). The
// previous version matched the literal word "resistance" and broke the moment the
// copy was rewritten, which tests nothing useful.
check("bike alone states the missing half rather than hiding it", (() => {
  const c = bikeOnly.caveat || "";
  return /muscle|lean mass/i.test(c) && /just me|dumbbell/i.test(c) && /strength/i.test(c);
})(), bikeOnly.caveat);

const bikeBw = buildFatMelter({ time: 30, gear: ["bike", "bodyweight"], impact: "low", intensity: "hard" });
check("bike + bodyweight gets BOTH the strength block and the ride",
  bikeBw.blocks.some(b => b.key === "strength" && b.moves.length) && bikeBw.exercises.some(e => e.name === "Bike Ride"));
check("a session with resistance carries no caveat", !bikeBw.caveat);

const dbBike = buildFatMelter({ time: 45, gear: ["dumbbell", "bike"], impact: "low", intensity: "hard" });
check("a dumbbell+bike combo draws on both",
  dbBike.exercises.some(e => e.name === "Bike Ride") && dbBike.exercises.some(e => /Dumbbell|Kettlebell|Goblet|Thruster|Romanian/.test(e.name)),
  dbBike.exercises.map(e => e.name).join(", "));
// A ride closes a session; it is never a warm-up for one, and never inside a circuit.
check("a ride is only ever the closing block", (() => {
  const b = dbBike.blocks.find(x => x.moves.some(m => m.name === "Bike Ride"));
  return b?.key === "finisher";
})(), dbBike.blocks.find(x => x.moves.some(m => m.name === "Bike Ride"))?.key);
check("a ride never appears in a circuit or as a primer",
  !dbBike.blocks.some(b => (b.key === "circuit" || b.key === "prime") && b.moves.some(m => m.name === "Bike Ride")));
check("a combo never surfaces gear you didn't pick",
  !dbBike.exercises.some(e => /Back Squat|Barbell Row|Barbell Bench|Lat Pulldown|Box Jump|Rowing \(Erg\)/.test(e.name)),
  dbBike.exercises.map(e => e.name).join(", "));

console.log(`\n${failed ? `${failed} FAILURE(S)` : "FAT MELTER SMOKE: ALL CLEAN"}`);
if (failed) { console.error("FAT MELTER SMOKE FAILED"); process.exit(1); }
