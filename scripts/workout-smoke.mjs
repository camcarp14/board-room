// Workout engine smoke — PLANTED PROBLEMS with known answers, zero deps.
// Every assertion prints ok:/FAIL; any FAIL exits 1. Runs in `npm run verify`.
import {
  epley1RM, e1RM, convW, sessionVolume, countedSets, isCardio,
  weekStartOf, consistency, muscleGroupOf, weeklySetsByGroup, groupFreshness,
  warmupRamp, suggestNext, weeklyRecap, lifetimeVolume, recentPRs,
} from "../src/lib/workout-engine.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const iso = (d, h = 9) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).toISOString();
const session = (date, exercises, extra = {}) => ({
  id: date, unit: "lb", started_at: iso(date), duration_sec: 3600,
  exercises: exercises.map(([name, sets]) => ({ name, sets: sets.map(([weight, reps, kind]) => ({ weight, reps, ...(kind ? { kind } : {}) })) })),
  ...extra,
});
const cardio = (date) => ({ id: `c${date}`, unit: "lb", started_at: iso(date, 7), duration_sec: 1800, exercises: [{ cardio: true, activity: "Outdoor Run", kcal: 300, source: "watch" }] });

// A fixed Wednesday anchors all week math: 2026-07-22 → Monday 2026-07-20.
const NOW = new Date("2026-07-22T12:00:00").getTime();

// 1 — e1RM known answers + the >12-rep honesty cap
check("e1RM: Epley 100×10 → 133.33", Math.abs(epley1RM(100, 10) - 133.333) < 0.01);
check("e1RM: reps=1 → the weight itself", epley1RM(315, 1) === 315);
check("e1RM: 13+ reps → null, never a flattering estimate", e1RM(100, 13) === null && e1RM(100, 12) !== null);
check("e1RM: garbage in → null out", epley1RM(0, 5) === null && epley1RM(100, 0) === null);

// 2 — warmups never count (planted: the volume-inflation trap)
const s1 = session("2026-07-20", [["Barbell Bench Press", [[135, 10, "warmup"], [185, 8], [185, 8]]]]);
check("volume: warmup sets excluded (2×185×8 = 2960)", sessionVolume(s1) === 2960, String(sessionVolume(s1)));
check("countedSets: warmup filtered, malformed filtered",
  countedSets([{ weight: 100, reps: 5 }, { weight: 100, reps: 5, kind: "warmup" }, { weight: null, reps: 5 }, { weight: 100, reps: 0 }]).length === 1);

// 3 — calendar math: Monday weeks
check("weekStartOf: Wed 2026-07-22 → Mon 2026-07-20", weekStartOf("2026-07-22") === "2026-07-20");
check("weekStartOf: Sunday belongs to the SAME week (2026-07-26 → 07-20)", weekStartOf("2026-07-26") === "2026-07-20");

// 4 — streak semantics (planted: gap week must break it; in-progress week must not)
const met = (mon) => {
  const n = new Date(`${mon}T00:00:00Z`);
  const d2 = new Date(n.getTime() + 2 * 86400000).toISOString().slice(0, 10);
  return [session(mon, [["Plank", [[0, 1]]]]), session(d2, [["Plank", [[0, 1]]]])];
};
const streak3 = consistency([...met("2026-06-29"), ...met("2026-07-06"), ...met("2026-07-13")], { now: NOW, goalPerWeek: 2, weeks: 8 });
check("streak: three met weeks, empty current week → 3 (in-progress week can't break it)", streak3.streakWeeks === 3, String(streak3.streakWeeks));
const gap = consistency([session("2026-06-29", [["Plank", [[0, 1]]]]), session("2026-07-13", [["Plank", [[0, 1]]]])], { now: NOW, goalPerWeek: 1, weeks: 8 });
check("streak: a gap week breaks it", gap.streakWeeks === 1, String(gap.streakWeeks));
check("heatmap: exactly weeks×7 Monday-aligned days", streak3.days.length === 56 && streak3.days[0].date === "2026-06-01");
check("consistency: cardio counts toward the week", consistency([cardio("2026-07-21")], { now: NOW, goalPerWeek: 1, weeks: 2 }).thisWeekCount === 1);
// planted: a streak LONGER than the heatmap window must still count in full
const longStreak = consistency(
  [...met("2026-06-22"), ...met("2026-06-29"), ...met("2026-07-06"), ...met("2026-07-13")],
  { now: NOW, goalPerWeek: 2, weeks: 2 } // window shows 2 weeks; streak spans 4
);
check("streak: not capped by the display window (4 met weeks, 2-week window → 4)", longStreak.streakWeeks === 4, String(longStreak.streakWeeks));

// 5 — muscle grouping heuristic
check("groups: bench→Chest, squat→Legs, curl→Arms, row→Back, unknown→Other",
  muscleGroupOf("Incline Barbell Bench") === "Chest" && muscleGroupOf("Back Squat") === "Legs" &&
  muscleGroupOf("Hammer Curl") === "Arms" && muscleGroupOf("Seated Cable Row") === "Back" &&
  muscleGroupOf("Mystery Machine") === "Other");
const wk = weeklySetsByGroup([s1, session("2026-07-21", [["Back Squat", [[225, 5], [225, 5]]]])], { now: NOW, weeks: 1 })[0];
check("weekly sets: chest 2 (warmup excluded), legs 2", wk.byGroup.Chest === 2 && wk.byGroup.Legs === 2, JSON.stringify(wk.byGroup));

// 6 — freshness heuristic bounds
const fresh = groupFreshness([{ ...s1, started_at: new Date(NOW - 12 * 3600e3).toISOString() }], NOW);
check("freshness: chest 12h after benching reads worked; never-trained reads fresh",
  fresh.find((f) => f.group === "Chest").state === "worked" && fresh.find((f) => f.group === "Legs").pct === 100);

// 7 — warm-up ramp (planted: rounding + bounds)
check("ramp: 225 on 45 bar → 45×10, 125×5, 160×3, 190×2",
  JSON.stringify(warmupRamp(225, { barWeight: 45, step: 5 })) ===
  JSON.stringify([{ weight: 45, reps: 10 }, { weight: 125, reps: 5 }, { weight: 160, reps: 3 }, { weight: 190, reps: 2 }]));
check("ramp: work weight at the bar → no ramp", warmupRamp(45, { barWeight: 45 }).length === 0);

// 8 — double progression suggestion
const sugAll = suggestNext([{ weight: 185, reps: 8 }, { weight: 185, reps: 8 }], { targetReps: 8, increment: 5 });
check("suggest: all sets at target → +5", sugAll.weight === 190 && sugAll.reason.includes("190"));
const sugShy = suggestNext([{ weight: 185, reps: 8 }, { weight: 185, reps: 6 }], { targetReps: 8, increment: 5 });
check("suggest: a set shy of target → same load, chase reps", sugShy.weight === 185);
check("suggest: warmup-only history → null", suggestNext([{ weight: 135, reps: 10, kind: "warmup" }]) === null);

// 9 — recap converts mixed units honestly
const kgSession = session("2026-07-21", [["Back Squat", [[100, 5]]]], { unit: "kg" });
const recap = weeklyRecap([kgSession], { now: NOW, unit: "lb" });
check("recap: 100kg×5 sums as ~1102 lb, never 500", Math.abs(recap.thisWeek.volume - 500 * 2.20462) < 0.5, String(recap.thisWeek.volume));
check("recap: cardio adds minutes, not volume", weeklyRecap([cardio("2026-07-21")], { now: NOW }).thisWeek.cardioMin === 30);
check("lifetime tonnage converts too", Math.abs(lifetimeVolume([kgSession], "lb") - 500 * 2.20462) < 0.5);

// 10 — cardio detection + PR wall
check("cardio rows detected; strength rows aren't", isCardio(cardio("2026-07-20")) && !isCardio(s1));
const prs = recentPRs([session("2026-07-20", [["Deadlift", [[315, 5], [335, 3]]]], {
  exercises: [{ name: "Deadlift", sets: [{ weight: 315, reps: 5 }, { weight: 335, reps: 3, pr: true }] }],
})]);
check("PR wall: only pr-flagged sets surface", prs.length === 1 && prs[0].weight === 335);

// 11 — unit conversion round trip
check("convW: lb↔kg round trip lossless", Math.abs(convW(convW(137.5, "lb", "kg"), "kg", "lb") - 137.5) < 1e-9);

if (failed > 0) { console.error(`\nWORKOUT SMOKE: ${failed} FAILURE(S)`); process.exit(1); }
console.log("\nWORKOUT SMOKE: ALL CLEAN");
