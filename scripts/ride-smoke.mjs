// Ride engine smoke — PLANTED PROBLEMS with known answers, zero deps.
// Every assertion prints ok:/FAIL; any FAIL exits 1. Runs in `npm run verify`.
//
// The traps this file exists to catch, all of them things a cycling recap
// screen gets wrong by default:
//   · a metric NO ride carries reading 0 instead of "—"
//   · average speed computed as (all distance ÷ all time) when half the rides
//     have no distance — a number that always reads slow
//   · "fastest ride" won by a 90-second coast down a hill
//   · "Stair Stepper" counted as a ride because "stride" contains "ride"
//   · an unfinished week breaking a riding streak
import {
  isRideActivity, isRide, normalizeRide, listRides, summarize, compareSummaries,
  weeklyRideSeries, ridingStreak, ridePRs, hrZoneOf, zoneMix, rideContext,
  rangeWindow, inWindow, toDistance, fromDistance, toElevation, estimateMaxHr,
  fmtDuration, fmtPace, fmtNum, KM_PER_MI,
} from "../src/lib/ride-engine.js";
import { readFileSync } from "fs";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Math.abs(a - b) < eps;

// Local-time anchor: Wednesday 2026-07-22 → Monday of that week is 2026-07-20.
const NOW = new Date("2026-07-22T12:00:00").getTime();
const iso = (d, h = 8) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).toISOString();

const ride = (date, meta = {}, durationSec = 3600, extra = {}) => ({
  id: `${date}-${meta.activity || "ride"}`,
  unit: "lb", started_at: iso(date), duration_sec: durationSec, notes: "",
  exercises: [{ cardio: true, activity: "Outdoor Cycle", source: "watch", ...meta }],
  ...extra,
});

// 1 — what is a ride (the "stride" trap is the whole reason this is a regex)
check("activity: Apple's cycling names all read as rides",
  ["Cycling", "Indoor Cycle", "Outdoor Cycle", "Hand Cycling", "Bike Ride", "Peloton", "Spin class", "Mountain biking"]
    .every(isRideActivity));
check("activity: 'Stair Stepper' is NOT a ride ('stride' hides 'ride')", !isRideActivity("Stair Stepper") && !isRideActivity("Striding"));
check("activity: runs, rows and lifts are not rides",
  !isRideActivity("Outdoor Run") && !isRideActivity("Rowing (Erg)") && !isRideActivity("Barbell Row") && !isRideActivity(""));
check("isRide: a two-exercise strength session is never a ride",
  !isRide({ started_at: iso("2026-07-20"), exercises: [{ name: "Bike Ride", sets: [] }, { name: "Squat", sets: [] }] }));

// 2 — normalize: speed is derived only when BOTH numbers exist
const r30 = normalizeRide(ride("2026-07-20", { distanceKm: 30 }, 3600));
check("normalize: 30 km in 1h → 30.0 km/h", near(r30.speedKph, 30));
check("normalize: no distance → no speed, never 0", normalizeRide(ride("2026-07-20", {}, 3600)).speedKph === null);
check("normalize: 'Indoor Cycle' reads indoor without an explicit flag", normalizeRide(ride("2026-07-20", { activity: "Indoor Cycle" })).indoor === true);
check("normalize: 'Outdoor Cycle' reads outdoor", r30.indoor === false);
check("normalize: an unstated venue stays null, not 'outdoor'", normalizeRide(ride("2026-07-20", { activity: "Cycling" })).indoor === null);
check("normalize: an explicit indoor:false beats the name", normalizeRide(ride("2026-07-20", { activity: "Indoor Cycle", indoor: false })).indoor === false);

// 3 — totals: coverage is reported, absent metrics stay null
// Planted: 40km/2h + (no distance)/1h + 10km/0.5h. Average speed must be
// 50 km ÷ 2.5 h = 20.0 exactly — NOT 50 ÷ 3.5 (14.3), the classic bug.
const mixed = listRides([
  ride("2026-07-20", { distanceKm: 40, avgHr: 140, kcal: 900 }, 7200),
  ride("2026-07-21", { avgHr: null, activity: "Indoor Cycle" }, 3600),
  ride("2026-07-22", { distanceKm: 10, avgHr: 160, kcal: 300 }, 1800),
]);
const sum = summarize(mixed);
check("summarize: 3 rides counted", sum.count === 3);
check("summarize: distance sums only the rides that have one (50 km, 2 of 3)", near(sum.distanceKm, 50) && sum.distanceRides === 2);
check("summarize: avg speed = 50km ÷ 2.5h = 20.0 km/h (not 3.5h)", near(sum.avgSpeedKph, 20));
check("summarize: avg HR is time-weighted → 144 bpm", near(sum.avgHr, 144), String(sum.avgHr));
check("summarize: elevation nobody recorded is null, NOT 0", sum.elevationM === null && sum.elevationRides === 0);
check("summarize: total time is every ride's clock (3.5h)", sum.durationSec === 12600);
check("summarize: longest ride 40 km / 2h", near(sum.longestKm, 40) && sum.longestSec === 7200);
check("summarize: indoor/outdoor tallied from the data", sum.indoorCount === 1 && sum.outdoorCount === 2);

// a distance with no clock must not enter the average-speed math at all
const noClock = summarize(listRides([ride("2026-07-20", { distanceKm: 20 }, null), ride("2026-07-21", { distanceKm: 20 }, 3600)]));
check("summarize: a distance without a duration never drags avg speed", near(noClock.avgSpeedKph, 20), String(noClock.avgSpeedKph));

// 4 — comparisons refuse to invent a baseline
const cmp = compareSummaries(sum, summarize([]));
check("compare: no previous distance → null delta, never +100%", cmp.distancePct === null && cmp.distanceKm === null);
check("compare: counts still subtract", cmp.count === 3);

// 5 — weekly series: 12 rows, empty weeks included, newest last
const series = weeklyRideSeries(mixed, { now: NOW, weeks: 12 });
check("series: exactly 12 Monday-weeks, oldest first", series.length === 12 && series[0].weekStart < series[11].weekStart);
check("series: the current week is the last row (2026-07-20)", series[11].weekStart === "2026-07-20");
check("series: this week holds all 3 rides and 50 km", series[11].count === 3 && near(series[11].distanceKm, 50));
check("series: an empty week is a real row of zeros", series[10].count === 0 && series[10].distanceKm === 0);

// 6 — streak: an unfinished week can join it, never break it
const weeklyRides = listRides([
  ride("2026-07-13"), ride("2026-07-06"), ride("2026-06-29"),
]);
const st = ridingStreak(weeklyRides, { now: NOW });
check("streak: 3 completed weeks with a ride, this week still empty → 3", st.weeks === 3, String(st.weeks));
check("streak: this week's count is reported honestly (0)", st.thisWeekCount === 0);
check("streak: days since the last ride = 9", st.daysSinceLast === 9, String(st.daysSinceLast));
const st2 = ridingStreak(listRides([ride("2026-07-22"), ...[ride("2026-07-13"), ride("2026-07-06")]]), { now: NOW });
check("streak: a ride this week extends it to 3", st2.weeks === 3 && st2.thisWeekCount === 1);
check("streak: no rides at all → 0 weeks, null days-since", ridingStreak([], { now: NOW }).weeks === 0 && ridingStreak([], { now: NOW }).daysSinceLast === null);

// 7 — PRs: the coast-down-a-hill trap
const prRides = listRides([
  ride("2026-07-01", { distanceKm: 3, activity: "Outdoor Cycle" }, 360),        // 30 km/h for 6 min — must NOT win
  ride("2026-07-08", { distanceKm: 20, elevationM: 400, kcal: 600 }, 3000),     // 24 km/h for 50 min — the real best
  ride("2026-07-15", { distanceKm: 60, elevationM: 900, avgWatts: 180 }, 10800),
  ride("2026-07-16", { avgWatts: 300 }, 600),                                    // 10 min — under the power qualifier
]);
const prs = ridePRs(prRides);
check("PR: fastest ride ignores the 6-minute 30 km/h blast", near(prs.speed.value, 24), String(prs.speed?.value));
check("PR: longest distance = 60 km", near(prs.distance.value, 60));
check("PR: longest time = 3h", prs.duration.value === 10800);
check("PR: biggest climb = 900 m", prs.elevation.value === 900);
check("PR: best power ignores the 10-minute 300 W effort → 180 W", near(prs.power.value, 180));
check("PR: a category nobody qualified for is null", ridePRs([ride("2026-07-02")].map(normalizeRide)).speed === null);

// 8 — effort zones, and the honesty about what they are
check("zones: 150 bpm against a 190 max → Z3 tempo", hrZoneOf(150, 190).key === "z3");
check("zones: the boundary belongs to the higher zone (0.7 → Z3)", hrZoneOf(133, 190).key === "z3");
check("zones: no max HR → no zone, never a guess", hrZoneOf(150, null) === null);
check("zones: without a max HR the whole mix is null", zoneMix(mixed, null) === null);
const mix = zoneMix(mixed, 190);
check("zones: only the rides carrying HR are placed (2 of 3)", mix.rides === 2 && mix.missing === 1);
check("zones: 140 bpm/2h lands in Z3 (73.7% of 190), 160 bpm/0.5h in Z4 (84.2%)",
  mix.rows.find((z) => z.key === "z3").sec === 7200 && mix.rows.find((z) => z.key === "z4").sec === 1800);
check("zones: the covered clock is 2.5h, not the full 3.5h", mix.totalSec === 9000);
check("maxHr: 220 − age, and nothing for a nonsense age", estimateMaxHr(34) === 186 && estimateMaxHr(0) === null);

// 9 — one ride against your own history (median, so one century can't skew it)
const ctx = rideContext(prRides.find((r) => r.distanceKm === 60), prRides);
check("context: the 60 km ride ranks 1st of the 3 rides that have a distance", ctx.distanceRank.place === 1 && ctx.distanceRank.of === 3);
check("context: median distance of the OTHER rides = 11.5 km (3 and 20)", near(ctx.medianKm, 11.5), String(ctx.medianKm));

// 10 — ranges
const w = rangeWindow("week", NOW);
check("range: this week starts Monday 00:00 local", new Date(w.from).getDay() === 1 && new Date(w.from).getHours() === 0);
check("range: the comparison window is the equal span before it", w.prev.to === w.from && w.from - w.prev.from === w.to - w.from);
check("range: 'all' has no window and nothing to compare against", rangeWindow("all", NOW).from === null && rangeWindow("all", NOW).prev === null);
check("range: 30 days keeps all 3 of this week's rides", inWindow(mixed, rangeWindow("d30", NOW)).length === 3);
check("range: this week excludes a ride from three weeks ago", inWindow(listRides([ride("2026-07-01")]), rangeWindow("week", NOW)).length === 0);

// 11 — units and formatting
check("units: 1 mile is 1.609344 km, both ways", near(toDistance(KM_PER_MI, "mi"), 1) && near(fromDistance(1, "mi"), KM_PER_MI));
check("units: km display is a pass-through", toDistance(42.2, "km") === 42.2);
check("units: 1000 m of climb is 3280.8 ft", near(toElevation(1000, "mi"), 3280.8399, 1e-3));
check("format: 5400s → 1h 30m, 1800s → 30m, 40s → 1m", fmtDuration(5400) === "1h 30m" && fmtDuration(1800) === "30m" && fmtDuration(40) === "1m");
check("format: nothing to show is an em dash, not 0", fmtDuration(null) === "—" && fmtNum(null) === "—");
check("format: 24 km/h is 4:01 per mile and 2:30 per km", fmtPace(24, "mi") === "4:01" && fmtPace(24, "km") === "2:30");
check("format: a zero speed has no pace", fmtPace(0, "mi") === "—");

// 12 — garbage in, guarded out (this file must never throw)
check("guards: null/garbage input returns empty, never throws",
  listRides(null).length === 0 && summarize(null).count === 0 && weeklyRideSeries(null, { now: NOW }).length === 12 &&
  normalizeRide(null) === null && normalizeRide({ exercises: [] }) === null && rideContext(null, []) === null);
check("guards: a ride with an unparseable timestamp is dropped, not dated 1970",
  normalizeRide({ id: "x", started_at: "not a date", duration_sec: 60, exercises: [{ cardio: true, activity: "Cycling" }] }) === null);
check("guards: negative/zero metrics are treated as absent",
  normalizeRide(ride("2026-07-20", { distanceKm: 0, kcal: -5, avgHr: 0 })).distanceKm === null);

// 13 — the seam Apple's data actually crosses ────────────────────────────────
// netlify/functions/workout-import.js is deliberately self-contained CommonJS
// (a required helper's module.exports clobbers the esbuild bundle and the
// function deploys with NO handler — the note at the top of that file). So it
// can't be imported from an .mjs; instead the REAL source is read and
// evaluated here, which tests the shipped code rather than a copy of it.
{
  const src = readFileSync("netlify/functions/workout-import.js", "utf8");
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("exports", "module", "process", `${src}\nexports.__normalize = normalizeWorkouts;`)(mod.exports, mod, { env: {} });
  const normalize = mod.exports.__normalize;
  const base = { type: "Outdoor Cycle", start: "2026-07-20T08:00:00Z", durationMin: 90 };
  const one = (extra) => normalize([{ ...base, ...extra }]);

  check("import: the function still exports a handler at all", typeof mod.exports.handler === "function");
  check("import: type + start + duration is enough", one({}).workouts?.[0].durationSec === 5400);
  check("import: a metric that wasn't sent is null, never 0",
    one({}).workouts[0].maxHr === null && one({}).workouts[0].elevationM === null && one({}).workouts[0].indoor === null);
  check("import: 25 miles arrives as 40.2336 km", near(one({ distanceMi: 25 }).workouts[0].distanceKm, 40.2336, 1e-4));
  check("import: 1000 ft of climbing arrives as 304.8 m", near(one({ elevationFt: 1000 }).workouts[0].elevationM, 304.8));
  check("import: an explicit km beats a stray miles field", one({ distanceKm: 12, distanceMi: 99 }).workouts[0].distanceKm === 12);
  check("import: Shortcuts' strings parse ('171', '90')",
    one({ maxHeartRate: "171" }).workouts[0].maxHr === 171 && normalize([{ ...base, durationMin: "90" }]).workouts[0].durationSec === 5400);
  check("import: Health Auto Export's { qty } shape parses", near(one({ distanceKm: { qty: 40.2 } }).workouts[0].distanceKm, 40.2));
  check("import: power and cadence survive the trip",
    one({ avgWatts: 168, cadence: 84 }).workouts[0].avgWatts === 168 && one({ avgWatts: 168, cadence: 84 }).workouts[0].avgCadence === 84);
  check("import: indoor:'false' is false, not truthy-string true", one({ indoor: "false" }).workouts[0].indoor === false);
  check("import: 'N/A' and out-of-range values read as absent, not as data",
    one({ maxHeartRate: "N/A" }).workouts[0].maxHr === null && one({ avgWatts: 9999 }).workouts[0].avgWatts === null);
  check("import: a missing duration is still rejected loudly, by index",
    /workout 0/.test(normalize([{ type: "Cycling", start: base.start }]).error || ""));
  check("import: an unparseable start is still rejected", !!normalize([{ type: "Cycling", start: "banana", durationMin: 90 }]).error);
  check("import: the 1–50 batch cap still holds", !!normalize(Array(51).fill(base)).error);
  // The Rides tab only ever sees what this writes, so the two must agree on
  // the field NAMES. A rename here and nothing else would empty the tab.
  check("import: the stored row uses the names the ride engine reads",
    ["elevationM", "avgWatts", "avgCadence", "maxHr", "indoor", "distanceKm"].every((k) => new RegExp(`${k}:`).test(src)));
}

console.log(failed ? `\n${failed} FAILED` : "\nall ride-engine checks passed");
process.exit(failed ? 1 : 0);
