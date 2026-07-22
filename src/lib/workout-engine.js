// ─── Workout engine ───────────────────────────────────────────────────────────
// Every derived training number in the Train tab comes from here — pure
// functions over the Supabase rows, unit-tested by scripts/workout-smoke.mjs
// (wired into `npm run verify`). Guard, don't throw: bad input → null/[]/0.
//
// Data model (unchanged from the original Workout panel — no migration):
//   session row: { id, template_name, unit:'lb'|'kg', started_at ISO,
//     duration_sec, notes, exercises:[{ name, sets:[{ weight, reps, pr?, kind? }] }
//                                     | { cardio:true, activity, kcal, avgHr, distanceKm, source }],
//     total_volume, total_sets, pr_count }
//   set.kind: undefined/'working' | 'warmup' | 'failure' | 'drop'.
//   WARM-UPS NEVER COUNT toward volume, PRs, or weekly sets.
//
// e1RM is Epley (w × (1 + r/30)); reps=1 → the weight itself; sets over
// 12 reps return null — the formula drifts badly there, and a fake PR is
// worse than a gap in the chart.

export const E1RM_MAX_REPS = 12;

export const epley1RM = (w, r) =>
  !Number.isFinite(w) || w <= 0 || !Number.isFinite(r) || r < 1 ? null
    : r === 1 ? w : w * (1 + r / 30);

export const e1RM = (w, r) => (r > E1RM_MAX_REPS ? null : epley1RM(w, r));

export const convW = (w, from, to) => (w == null || from === to ? w : from === "lb" ? w / 2.20462 : w * 2.20462);

// ─── set / session accounting ────────────────────────────────────────────────
export const isWarmup = (s) => s?.kind === "warmup";
export const countedSets = (sets) =>
  (sets || []).filter((s) => s && !isWarmup(s) && Number.isFinite(s.weight) && Number.isFinite(s.reps) && s.reps >= 1);

export const isCardio = (session) =>
  !!(session?.exercises?.length === 1 && session.exercises[0]?.cardio);
export const cardioMeta = (session) => (isCardio(session) ? session.exercises[0] : null);

/** Volume of a session in ITS OWN unit, warmups excluded. */
export function sessionVolume(session) {
  if (!session || isCardio(session)) return 0;
  let v = 0;
  for (const ex of session.exercises || []) for (const s of countedSets(ex.sets)) v += s.weight * s.reps;
  return v;
}

// ─── calendar math — integer day numbers, Monday weeks, DST-proof ────────────
const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, "0");
export function localDateStr(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function dayNum(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  return Number.isNaN(t) ? null : Math.round(t / DAY_MS);
}
export const dateOfDayNum = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** Monday of the week containing dateStr (1970-01-01 was a Thursday). */
export function weekStartOf(dateStr) {
  const n = dayNum(dateStr);
  return n == null ? null : dateOfDayNum(n - ((n + 3) % 7));
}
const sessionDate = (s) => {
  const t = Date.parse(s?.started_at || "");
  return Number.isNaN(t) ? null : localDateStr(t);
};

// ─── consistency: heatmap + weekly streak ────────────────────────────────────
/** Heatmap days (weeks×7, Monday-aligned, `future` flagged) + weekly streak.
 *  Streak = consecutive weeks meeting `goalPerWeek` sessions, walking back
 *  from LAST week; the in-progress week joins once met but can never break
 *  the streak (you can't fail a week that isn't over). Cardio counts. */
export function consistency(sessions, { now = Date.now(), goalPerWeek = 3, weeks = 20 } = {}) {
  const today = localDateStr(now);
  const thisWeekStart = weekStartOf(today);
  const empty = { days: [], weekRows: [], streakWeeks: 0, thisWeekCount: 0, totalSessions: 0 };
  if (!thisWeekStart || !Number.isInteger(weeks) || weeks < 1) return empty;

  const counts = new Map();
  let total = 0;
  for (const s of sessions || []) {
    const d = sessionDate(s);
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
    total++;
  }

  const firstDay = dayNum(thisWeekStart) - 7 * (weeks - 1);
  const todayNum = dayNum(today);
  const days = [];
  for (let n = firstDay; n <= dayNum(thisWeekStart) + 6; n++) {
    days.push({ date: dateOfDayNum(n), count: counts.get(dateOfDayNum(n)) || 0, future: n > todayNum });
  }
  const weekRows = [];
  for (let w = 0; w < weeks; w++) {
    let c = 0;
    for (let d = 0; d < 7; d++) c += counts.get(dateOfDayNum(firstDay + w * 7 + d)) || 0;
    weekRows.push({ start: dateOfDayNum(firstDay + w * 7), count: c, met: c >= goalPerWeek });
  }
  const thisWeekCount = weekRows[weekRows.length - 1]?.count ?? 0;
  let streak = thisWeekCount >= goalPerWeek ? 1 : 0;
  for (let w = weekRows.length - 2; w >= 0; w--) {
    if (weekRows[w].met) streak++;
    else break;
  }
  return { days, weekRows, streakWeeks: streak, thisWeekCount, totalSessions: total };
}

// ─── muscle groups — name-keyed mapping ──────────────────────────────────────
// The data model stores exercise NAMES, so grouping is a keyword heuristic
// seeded by the library groups. Unknown names land in "Other" — an honest
// bucket, never a guess presented as fact.
export const GROUPS = ["Chest", "Back", "Shoulders", "Arms", "Legs", "Core", "Conditioning", "Other"];

// Rule-of-thumb hours back to "fresh" after training — a labeled heuristic
// (big movers ~72h, small ~48h), NOT a physiological measurement.
export const RECOVERY_HOURS = { Chest: 72, Back: 72, Legs: 72, Shoulders: 48, Arms: 48, Core: 36, Conditioning: 24, Other: 48 };

const norm = (x) => (x || "").trim().toLowerCase();
// FIRST match wins, so order is load-bearing:
//   Legs before Conditioning ("Walking Lunge" is legs, not a walk)
//   Conditioning before Back ("Rowing (Erg)" is cardio, "Barbell Row" isn't)
//   Arms before Chest ("Close-Grip Bench", "Incline Dumbbell Curl" are arms)
//   Chest before Shoulders ("Incline Dumbbell Press" chest, "Seated Dumbbell Press" shoulders)
//   Shoulders before Back ("Upright Row", "Face Pull" beat the bare "row"/"pull")
// Deadlifts read Legs/posterior chain by design — this is weekly-sets
// granularity, not an anatomy class.
// Key syntax: plain string = substring match on the normalized name;
// "=x" = exact match (guards short words like "run" against "cRUNch").
const GROUP_RULES = [
  ["Shoulders", ["rear delt", "upright row", "face pull"]], // disambiguators — beat Chest's "fly" and Back's "row"/"pull"
  ["Legs", ["squat", "leg press", "leg extension", "leg curl", "lunge", "deadlift", "rdl", "hip thrust", "glute", "calf", "hamstring", "step-up", "step up", "adduct", "abduct", "nordic"]],
  ["Conditioning", ["running", " run", "=run", "rowing", "row (erg", "bike", "erg", "sled", "carry", "swing", "burpee", "box jump", "jump rope", "ski", "stair", "elliptical", "swim", "incline walk", "treadmill", "sprint", "hiit"]],
  ["Arms", ["curl", "tricep", "skullcrusher", "skull crusher", "pushdown", "close-grip", "close grip", "preacher", "dip (tricep", "wrist", "forearm"]],
  ["Chest", ["bench", "chest", "fly", "push-up", "pushup", "crossover", "pec", "dip (chest", "incline"]],
  ["Shoulders", ["overhead press", "shoulder", "ohp", "military", "lateral raise", "front raise", "arnold", "delt", "dumbbell press", "db press", "shrug"]],
  ["Back", ["row", "pull-up", "pullup", "chin-up", "chinup", "pulldown", "pullover", "lat ", "rack pull", "back extension", "dead hang"]],
  ["Core", ["plank", "crunch", "ab ", "abs", "sit-up", "situp", "leg raise", "russian twist", "dead bug", "rollout", "hollow", "l-sit"]],
];
export function muscleGroupOf(name) {
  const n = norm(name);
  if (!n) return "Other";
  for (const [group, keys] of GROUP_RULES) {
    if (keys.some((k) => (k[0] === "=" ? n === k.slice(1) : n.includes(k)))) return group;
  }
  return "Other";
}

/** Working sets per muscle group for the last `weeks` weeks (oldest→newest;
 *  last row = the week containing `now`). Warmups excluded, cardio ignored. */
export function weeklySetsByGroup(sessions, { now = Date.now(), weeks = 1 } = {}) {
  const thisWeekStart = weekStartOf(localDateStr(now));
  if (!thisWeekStart || !Number.isInteger(weeks) || weeks < 1) return [];
  const startNum = dayNum(thisWeekStart) - 7 * (weeks - 1);
  const rows = Array.from({ length: weeks }, (_, i) => ({
    weekStart: dateOfDayNum(startNum + i * 7),
    byGroup: Object.fromEntries(GROUPS.map((g) => [g, 0])),
    totalSets: 0,
  }));
  for (const s of sessions || []) {
    if (isCardio(s)) continue;
    const d = sessionDate(s);
    const n = d ? dayNum(d) : null;
    if (n == null) continue;
    const idx = Math.floor((n - startNum) / 7);
    if (idx < 0 || idx >= weeks) continue;
    for (const ex of s.exercises || []) {
      const count = countedSets(ex.sets).length;
      if (!count) continue;
      rows[idx].byGroup[muscleGroupOf(ex.name)] += count;
      rows[idx].totalSets += count;
    }
  }
  return rows;
}

/** Hours-since-trained per group vs the RECOVERY_HOURS rule of thumb.
 *  pct 0–100 (100 = fresh); never-trained groups read fresh. */
export function groupFreshness(sessions, nowMs = Date.now()) {
  const lastAt = new Map();
  for (const s of sessions || []) {
    const t = Date.parse(s?.started_at || "");
    if (Number.isNaN(t)) continue;
    if (isCardio(s)) {
      if (!lastAt.has("Conditioning") || t > lastAt.get("Conditioning")) lastAt.set("Conditioning", t);
      continue;
    }
    for (const ex of s.exercises || []) {
      if (!countedSets(ex.sets).length) continue;
      const g = muscleGroupOf(ex.name);
      if (!lastAt.has(g) || t > lastAt.get(g)) lastAt.set(g, t);
    }
  }
  return GROUPS.map((g) => {
    const at = lastAt.get(g) ?? null;
    const hoursAgo = at == null ? null : Math.max(0, (nowMs - at) / 3600000);
    const pct = at == null ? 100 : Math.min(100, Math.round((hoursAgo / RECOVERY_HOURS[g]) * 100));
    return { group: g, lastAt: at, hoursAgo: hoursAgo == null ? null : Math.round(hoursAgo), pct, state: pct >= 100 ? "fresh" : pct >= 50 ? "recovering" : "worked" };
  });
}

// ─── warm-up ramp ────────────────────────────────────────────────────────────
/** Bar×10 then 55%×5, 70%×3, 85%×2 toward the work weight, rounded to the
 *  smallest plate step; steps at/above the work weight or at/below the bar
 *  are dropped. Work weight at/under the bar → no ramp. */
export function warmupRamp(workWeight, { barWeight = 45, step = 5 } = {}) {
  if (!Number.isFinite(workWeight) || workWeight <= 0 || !Number.isFinite(barWeight) || barWeight <= 0) return [];
  if (workWeight <= barWeight + 1e-9) return [];
  const inc = Number.isFinite(step) && step > 0 ? step : 5;
  const ramp = [{ weight: barWeight, reps: 10 }];
  for (const [pct, reps] of [[0.55, 5], [0.7, 3], [0.85, 2]]) {
    const w = Math.round((workWeight * pct) / inc) * inc;
    if (w > barWeight + 1e-9 && w < workWeight - 1e-9 && !ramp.some((r) => r.weight === w)) ramp.push({ weight: w, reps });
  }
  return ramp;
}

// ─── progression suggestion (double progression, numbers stated) ─────────────
/** From the last performance of a lift: if every working set reached
 *  targetReps, suggest +increment; otherwise chase reps at the same load.
 *  prevSets are sets from the most recent session of this lift, already in
 *  the display unit. Returns null without usable history. */
export function suggestNext(prevSets, { targetReps = 8, increment = 5 } = {}) {
  const sets = countedSets(prevSets);
  if (!sets.length) return null;
  const goal = Number.isFinite(targetReps) && targetReps >= 1 ? Math.round(targetReps) : 8;
  const inc = Number.isFinite(increment) && increment > 0 ? increment : 5;
  const top = Math.max(...sets.map((s) => s.weight));
  const fmt = (w) => (Math.round(w * 10) / 10).toString().replace(/\.0$/, "");
  if (sets.every((s) => s.reps >= goal)) {
    return { weight: top + inc, reps: goal, reason: `every set hit ${goal}+ last time — try ${fmt(top + inc)}` };
  }
  const short = sets.filter((s) => s.reps < goal).length;
  return { weight: top, reps: goal, reason: `${short} set${short > 1 ? "s" : ""} shy of ${goal} reps — same load, chase the reps` };
}

// ─── weekly recap ────────────────────────────────────────────────────────────
/** This week vs last week (Mon–Sun). Volume converts every session into
 *  `unit` so mixed-unit history sums honestly. Cardio counts sessions +
 *  minutes, never volume. */
export function weeklyRecap(sessions, { now = Date.now(), unit = "lb" } = {}) {
  const thisStart = weekStartOf(localDateStr(now));
  if (!thisStart) return null;
  const thisNum = dayNum(thisStart);
  const bucket = (fromNum) => {
    const acc = { sessions: 0, volume: 0, sets: 0, cardioMin: 0 };
    for (const s of sessions || []) {
      const d = sessionDate(s);
      const n = d ? dayNum(d) : null;
      if (n == null || n < fromNum || n >= fromNum + 7) continue;
      acc.sessions++;
      if (isCardio(s)) { acc.cardioMin += Math.round((s.duration_sec || 0) / 60); continue; }
      acc.volume += convW(sessionVolume(s), s.unit || "lb", unit) || 0;
      for (const ex of s.exercises || []) acc.sets += countedSets(ex.sets).length;
    }
    return acc;
  };
  return { thisWeek: bucket(thisNum), lastWeek: bucket(thisNum - 7) };
}

/** Lifetime tonnage in `unit` — the fun number. Mixed units convert. */
export function lifetimeVolume(sessions, unit = "lb") {
  let v = 0;
  for (const s of sessions || []) v += convW(sessionVolume(s), s.unit || "lb", unit) || 0;
  return v;
}

/** Recent PR sets across history, newest first: [{ name, weight, reps, unit, date, e1: number|null }]. */
export function recentPRs(sessions, limit = 8) {
  const out = [];
  for (const s of sessions || []) {
    if (isCardio(s)) continue;
    const t = Date.parse(s?.started_at || "");
    for (const ex of s.exercises || []) {
      for (const set of ex.sets || []) {
        if (set?.pr && !isWarmup(set)) out.push({ name: ex.name, weight: set.weight, reps: set.reps, unit: s.unit || "lb", t: Number.isNaN(t) ? 0 : t, e1: e1RM(set.weight, set.reps) });
      }
    }
  }
  return out.sort((a, b) => b.t - a.t).slice(0, limit);
}
