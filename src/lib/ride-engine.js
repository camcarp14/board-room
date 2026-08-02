// ─── Ride engine ─────────────────────────────────────────────────────────────
// Every number in Train → Rides comes from here — pure functions over the same
// workout_sessions rows the rest of the Train tab reads, unit-tested by
// scripts/ride-smoke.mjs (wired into `npm run verify`). Guard, don't throw:
// bad input → null / [] / 0.
//
// Where the data comes from: a ride finished on the Apple Watch is written to
// Apple Health, an iOS Shortcuts automation (or Health Auto Export) POSTs it to
// /.netlify/functions/workout-import, and it lands as a cardio session:
//
//   exercises: [{ cardio: true, activity: "Outdoor Cycle", kcal, avgHr, maxHr,
//                 distanceKm, elevationM, avgWatts, avgCadence, indoor, source }]
//
// Only `activity` and the session's started_at/duration_sec are guaranteed.
// Everything else is optional and frequently absent (an indoor spin with no
// distance, a ride recorded without the HR strap). The rule this file follows
// everywhere: a metric no ride carries reads `null`, never 0 — and every total
// reports how many rides actually fed it, so the UI can say so out loud.
//
// Distances are stored and computed in KILOMETRES, elevation in METRES. The
// display unit ('mi' | 'km') converts at the edge only.

import { isCardio, cardioMeta, localDateStr, dayNum, dateOfDayNum, weekStartOf } from "./workout-engine.js";

export const KM_PER_MI = 1.609344;
export const M_PER_FT = 0.3048;

/** km → the display unit ('mi' | 'km'). null in, null out. */
export const toDistance = (km, unit = "mi") => (Number.isFinite(km) ? (unit === "km" ? km : km / KM_PER_MI) : null);
/** the display unit → km (for hand-entered rides). */
export const fromDistance = (v, unit = "mi") => (Number.isFinite(v) ? (unit === "km" ? v : v * KM_PER_MI) : null);
/** metres → ft or m. */
export const toElevation = (m, unit = "mi") => (Number.isFinite(m) ? (unit === "km" ? m : m / M_PER_FT) : null);
export const fromElevation = (v, unit = "mi") => (Number.isFinite(v) ? (unit === "km" ? v : v * M_PER_FT) : null);
export const distanceLabel = (unit) => (unit === "km" ? "km" : "mi");
export const elevationLabel = (unit) => (unit === "km" ? "m" : "ft");
export const speedLabel = (unit) => (unit === "km" ? "km/h" : "mph");

// ─── what counts as a ride ───────────────────────────────────────────────────
// Word-ish boundaries on purpose: "Stair Stepper" must not match on "ride"
// hiding inside "stride", and "Barbell Row" must never reach this file at all
// (it isn't cardio). Apple writes "Cycling", "Indoor Cycle", "Outdoor Cycle",
// and "Hand Cycling"; Shortcuts and Health Auto Export pass those names
// through, and the hand-logged path uses the same vocabulary.
const RIDE_RE = /(^|[^a-z])(cycling|cycle|cycles|cyclist|bike|bikes|biking|spin|spinning|peloton|ride|rides|riding)([^a-z]|$)/;
export function isRideActivity(name) {
  const n = String(name || "").trim().toLowerCase();
  return !!n && RIDE_RE.test(n);
}
export const isRide = (session) => isCardio(session) && isRideActivity(cardioMeta(session)?.activity);

// Indoor is only asserted when the data says so — the boolean from the import,
// or an unambiguous word in Apple's own activity name. Otherwise: null, which
// the UI reads as "not stated", never as "outdoor".
function readIndoor(meta) {
  if (typeof meta?.indoor === "boolean") return meta.indoor;
  const n = String(meta?.activity || "").toLowerCase();
  if (n.includes("indoor") || n.includes("spin") || n.includes("peloton") || n.includes("trainer") || n.includes("stationary")) return true;
  if (n.includes("outdoor")) return false;
  return null;
}

const num = (x) => (Number.isFinite(x) ? x : null);
const pos = (x) => (Number.isFinite(x) && x > 0 ? x : null);

/** One session row → the flat ride shape the whole tab speaks. null if it
 *  isn't a ride (or the row has no usable timestamp). */
export function normalizeRide(session) {
  if (!isRide(session)) return null;
  const t = Date.parse(session.started_at || "");
  if (Number.isNaN(t)) return null;
  const m = cardioMeta(session) || {};
  const durationSec = pos(session.duration_sec) ? Math.round(session.duration_sec) : null;
  const distanceKm = pos(m.distanceKm);
  return {
    id: session.id,
    t,
    date: localDateStr(t),
    activity: String(m.activity || "Ride"),
    indoor: readIndoor(m),
    durationSec,
    distanceKm,
    kcal: pos(m.kcal),
    avgHr: pos(m.avgHr),
    maxHr: pos(m.maxHr),
    elevationM: num(m.elevationM) != null && m.elevationM >= 0 ? m.elevationM : null,
    avgWatts: pos(m.avgWatts),
    avgCadence: pos(m.avgCadence),
    source: m.source || null,
    notes: session.notes || "",
    // derived, never stored: km ÷ hours. Needs BOTH numbers — a distance
    // without a duration is not a speed, it's a guess.
    speedKph: distanceKm != null && durationSec != null ? (distanceKm / durationSec) * 3600 : null,
  };
}

/** Every ride in `sessions`, newest first. */
export function listRides(sessions) {
  const out = [];
  for (const s of sessions || []) {
    const r = normalizeRide(s);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.t - a.t);
}

// ─── ranges ──────────────────────────────────────────────────────────────────
export const RANGES = [
  { key: "week", label: "This week" },
  { key: "d30", label: "30 days" },
  { key: "ytd", label: "This year" },
  { key: "all", label: "All time" },
];

const startOfLocalDay = (dateStr) => {
  if (typeof dateStr !== "string") return null;
  const [y, mo, d] = dateStr.split("-").map(Number);
  const t = new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
  return Number.isNaN(t) ? null : t;
};

/** [from, to) in local ms for a range key, plus the equal-length window
 *  immediately before it (null for 'all' — there's nothing before all time). */
export function rangeWindow(key, now = Date.now()) {
  const to = now;
  const today = localDateStr(now);
  let from = null;
  if (key === "week") from = startOfLocalDay(weekStartOf(today));
  else if (key === "d30") from = startOfLocalDay(dateOfDayNum(dayNum(today) - 29));
  else if (key === "ytd") from = new Date(new Date(now).getFullYear(), 0, 1).getTime();
  else from = null; // 'all'
  if (from == null) return { key: "all", from: null, to, prev: null, spanDays: null };
  const span = to - from;
  return { key, from, to, prev: { from: from - span, to: from }, spanDays: Math.max(1, Math.round(span / 86400000)) };
}

export function inWindow(rides, w) {
  if (!w || w.from == null) return [...(rides || [])];
  return (rides || []).filter((r) => r.t >= w.from && r.t < w.to);
}

// ─── totals ──────────────────────────────────────────────────────────────────
/** Sum of a set of rides. Every optional metric reports its own coverage —
 *  `distanceRides: 3` means only 3 of the rides carried a distance, so the
 *  screen can say "3 of 5 rides" instead of implying the total is complete.
 *  A metric no ride carries is null, never 0. */
export function summarize(rides) {
  const list = rides || [];
  const acc = {
    count: list.length,
    durationSec: 0,
    distanceKm: null, distanceRides: 0,
    kcal: null, kcalRides: 0,
    elevationM: null, elevationRides: 0,
    avgSpeedKph: null,
    avgHr: null, hrRides: 0,
    maxHr: null,
    avgWatts: null, wattRides: 0,
    longestKm: null, longestSec: null,
    indoorCount: 0, outdoorCount: 0,
    firstAt: null, lastAt: null,
  };
  let movingSec = 0, movingKm = 0, hrSec = 0, hrSum = 0, wattSec = 0, wattSum = 0;
  for (const r of list) {
    if (r.durationSec != null) {
      acc.durationSec += r.durationSec;
      if (acc.longestSec == null || r.durationSec > acc.longestSec) acc.longestSec = r.durationSec;
    }
    if (r.distanceKm != null) {
      acc.distanceKm = (acc.distanceKm || 0) + r.distanceKm;
      acc.distanceRides++;
      if (acc.longestKm == null || r.distanceKm > acc.longestKm) acc.longestKm = r.distanceKm;
      if (r.durationSec != null) { movingSec += r.durationSec; movingKm += r.distanceKm; }
    }
    if (r.kcal != null) { acc.kcal = (acc.kcal || 0) + r.kcal; acc.kcalRides++; }
    if (r.elevationM != null) { acc.elevationM = (acc.elevationM || 0) + r.elevationM; acc.elevationRides++; }
    if (r.avgHr != null) {
      acc.hrRides++;
      const w = r.durationSec || 1; // time-weighted: a 2h ride's HR outweighs a 15m spin
      hrSec += w; hrSum += r.avgHr * w;
    }
    if (r.maxHr != null && (acc.maxHr == null || r.maxHr > acc.maxHr)) acc.maxHr = r.maxHr;
    if (r.avgWatts != null) { acc.wattRides++; const w = r.durationSec || 1; wattSec += w; wattSum += r.avgWatts * w; }
    if (r.indoor === true) acc.indoorCount++;
    else if (r.indoor === false) acc.outdoorCount++;
    if (acc.firstAt == null || r.t < acc.firstAt) acc.firstAt = r.t;
    if (acc.lastAt == null || r.t > acc.lastAt) acc.lastAt = r.t;
  }
  // Average speed is total distance ÷ total time OF THE RIDES THAT HAVE BOTH —
  // dividing a partial distance by the full clock would read slow and lie.
  if (movingSec > 0 && movingKm > 0) acc.avgSpeedKph = (movingKm / movingSec) * 3600;
  if (hrSec > 0) acc.avgHr = hrSum / hrSec;
  if (wattSec > 0) acc.avgWatts = wattSum / wattSec;
  return acc;
}

/** Signed change between two summaries for the fields that compare cleanly.
 *  null on either side → null delta (no "+100%" against nothing). */
export function compareSummaries(now, prev) {
  const d = (a, b) => (a == null || b == null ? null : a - b);
  const pct = (a, b) => (a == null || b == null || b === 0 ? null : ((a - b) / b) * 100);
  return {
    count: now.count - prev.count,
    durationSec: now.durationSec - prev.durationSec,
    distanceKm: d(now.distanceKm, prev.distanceKm),
    distancePct: pct(now.distanceKm, prev.distanceKm),
    elevationM: d(now.elevationM, prev.elevationM),
    kcal: d(now.kcal, prev.kcal),
    avgSpeedKph: d(now.avgSpeedKph, prev.avgSpeedKph),
  };
}

// ─── weekly series — the shape of the last N Monday-weeks ────────────────────
/** Oldest → newest, always exactly `weeks` rows (empty weeks included, which
 *  is the whole point of a consistency chart). */
export function weeklyRideSeries(rides, { now = Date.now(), weeks = 12 } = {}) {
  const thisWeekStart = weekStartOf(localDateStr(now));
  if (!thisWeekStart || !Number.isInteger(weeks) || weeks < 1) return [];
  const startNum = dayNum(thisWeekStart) - 7 * (weeks - 1);
  const rows = Array.from({ length: weeks }, (_, i) => ({
    weekStart: dateOfDayNum(startNum + i * 7),
    count: 0, distanceKm: 0, durationSec: 0, elevationM: 0, kcal: 0,
  }));
  for (const r of rides || []) {
    const n = r.date ? dayNum(r.date) : null;
    if (n == null) continue;
    const idx = Math.floor((n - startNum) / 7);
    if (idx < 0 || idx >= weeks) continue;
    rows[idx].count++;
    rows[idx].distanceKm += r.distanceKm || 0;
    rows[idx].durationSec += r.durationSec || 0;
    rows[idx].elevationM += r.elevationM || 0;
    rows[idx].kcal += r.kcal || 0;
  }
  return rows;
}

/** Consecutive Monday-weeks ending with the most recent COMPLETED week that
 *  had at least `perWeek` rides. The in-progress week can join the streak but
 *  can never break it — you can't fail a week that isn't over. Mirrors the
 *  strength streak in workout-engine on purpose. */
export function ridingStreak(rides, { now = Date.now(), perWeek = 1 } = {}) {
  const thisWeekStart = weekStartOf(localDateStr(now));
  if (!thisWeekStart) return { weeks: 0, thisWeekCount: 0, daysSinceLast: null };
  const counts = new Map();
  let lastAt = null;
  for (const r of rides || []) {
    const ws = weekStartOf(r.date);
    if (ws) counts.set(ws, (counts.get(ws) || 0) + 1);
    if (lastAt == null || r.t > lastAt) lastAt = r.t;
  }
  const thisWeekCount = counts.get(thisWeekStart) || 0;
  let weeks = thisWeekCount >= perWeek ? 1 : 0;
  for (let n = dayNum(thisWeekStart) - 7; (counts.get(dateOfDayNum(n)) || 0) >= perWeek; n -= 7) weeks++;
  const daysSinceLast = lastAt == null ? null : Math.max(0, Math.floor((dayNum(localDateStr(now)) - dayNum(localDateStr(lastAt)))));
  return { weeks, thisWeekCount, daysSinceLast, lastAt };
}

// ─── personal bests ──────────────────────────────────────────────────────────
// Qualifiers exist so a 90-second coast downhill never becomes "fastest ride"
// and a 4-minute warm-up spin never becomes "best power". Every threshold is
// stated in the returned row so the UI can print it.
export const PR_MIN_SPEED_KM = 8;      // ~5 mi
export const PR_MIN_SPEED_SEC = 900;   // 15 min
export const PR_MIN_POWER_SEC = 1200;  // 20 min

/** The best ride for each category, or null where nothing qualifies.
 *  Ties break toward the OLDEST ride — the one that set the mark. */
export function ridePRs(rides) {
  const list = rides || [];
  const best = (pick, qualifies = () => true) => {
    let winner = null, val = null;
    for (const r of list) {
      if (!qualifies(r)) continue;
      const v = pick(r);
      if (!Number.isFinite(v)) continue;
      if (val == null || v > val || (v === val && winner && r.t < winner.t)) { val = v; winner = r; }
    }
    return winner == null ? null : { ride: winner, value: val };
  };
  return {
    distance: best((r) => r.distanceKm),
    duration: best((r) => r.durationSec),
    elevation: best((r) => r.elevationM),
    speed: best((r) => r.speedKph, (r) => (r.distanceKm ?? 0) >= PR_MIN_SPEED_KM && (r.durationSec ?? 0) >= PR_MIN_SPEED_SEC),
    power: best((r) => r.avgWatts, (r) => (r.durationSec ?? 0) >= PR_MIN_POWER_SEC),
    kcal: best((r) => r.kcal),
  };
}

// ─── effort ──────────────────────────────────────────────────────────────────
/** 220 − age. A population average with a ±10–12 bpm standard deviation — a
 *  starting point to be overridden, which is why the UI always says so. */
export const estimateMaxHr = (age) => (Number.isFinite(age) && age >= 10 && age <= 100 ? 220 - Math.round(age) : null);

export const HR_ZONES = [
  { key: "z1", label: "Z1 · easy", lo: 0, hi: 0.6, tone: "var(--blue)" },
  { key: "z2", label: "Z2 · endurance", lo: 0.6, hi: 0.7, tone: "var(--green)" },
  { key: "z3", label: "Z3 · tempo", lo: 0.7, hi: 0.8, tone: "var(--amber)" },
  { key: "z4", label: "Z4 · threshold", lo: 0.8, hi: 0.9, tone: "var(--accent)" },
  { key: "z5", label: "Z5 · max", lo: 0.9, hi: Infinity, tone: "var(--red)" },
];

export function hrZoneOf(hr, maxHr) {
  if (!Number.isFinite(hr) || !Number.isFinite(maxHr) || maxHr <= 0) return null;
  const p = hr / maxHr;
  return HR_ZONES.find((z) => p >= z.lo && p < z.hi) || HR_ZONES[HR_ZONES.length - 1];
}

/** Ride TIME grouped by the zone each ride's AVERAGE heart rate falls in.
 *  This is deliberately not "time in zone" — the import carries one average
 *  per ride, not a beat-by-beat series, and pretending otherwise would be
 *  the most flattering lie on the screen. Returns null without a max HR. */
export function zoneMix(rides, maxHr) {
  if (!Number.isFinite(maxHr) || maxHr <= 0) return null;
  const rows = HR_ZONES.map((z) => ({ ...z, sec: 0, rides: 0 }));
  let coveredSec = 0, coveredRides = 0, uncoveredRides = 0;
  for (const r of rides || []) {
    if (r.avgHr == null) { uncoveredRides++; continue; }
    const z = hrZoneOf(r.avgHr, maxHr);
    const row = rows.find((x) => x.key === z.key);
    const sec = r.durationSec || 0;
    row.sec += sec; row.rides++;
    coveredSec += sec; coveredRides++;
  }
  if (!coveredRides) return null;
  return { rows, totalSec: coveredSec, rides: coveredRides, missing: uncoveredRides };
}

// ─── one ride, read against your own history ─────────────────────────────────
/** Where a ride sits versus the median of every OTHER ride that carries the
 *  same metric. Median, not mean: one 60-mile century must not make every
 *  ordinary Tuesday read "short". null when there's nothing to compare to. */
export function rideContext(ride, rides) {
  if (!ride) return null;
  const others = (rides || []).filter((r) => r.id !== ride.id);
  const median = (pick) => {
    const vs = others.map(pick).filter(Number.isFinite).sort((a, b) => a - b);
    if (!vs.length) return null;
    const mid = Math.floor(vs.length / 2);
    return vs.length % 2 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
  };
  const rank = (pick, v) => {
    if (!Number.isFinite(v)) return null;
    const vs = [...others.map(pick).filter(Number.isFinite), v].sort((a, b) => b - a);
    return { place: vs.indexOf(v) + 1, of: vs.length };
  };
  return {
    medianKm: median((r) => r.distanceKm),
    medianSec: median((r) => r.durationSec),
    medianSpeedKph: median((r) => r.speedKph),
    medianHr: median((r) => r.avgHr),
    distanceRank: rank((r) => r.distanceKm, ride.distanceKm),
    speedRank: rank((r) => r.speedKph, ride.speedKph),
    elevationRank: rank((r) => r.elevationM, ride.elevationM),
  };
}

// ─── formatting (shared by the panel and the smoke test) ─────────────────────
export const fmtDuration = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h && m === 60) return `${h + 1}h 0m`;
  return h ? `${h}h ${m}m` : `${Math.max(1, Math.round(sec / 60))}m`;
};
export const fmtNum = (v, digits = 1) => {
  if (!Number.isFinite(v)) return "—";
  const n = Math.round(v * 10 ** digits) / 10 ** digits;
  return digits === 0 ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits });
};
/** Cycling pace, the way riders read it: minutes per mile/km. */
export const fmtPace = (speedKph, unit = "mi") => {
  if (!Number.isFinite(speedKph) || speedKph <= 0) return "—";
  const perUnitHr = unit === "km" ? 1 / speedKph : KM_PER_MI / speedKph;
  const totalSec = perUnitHr * 3600;
  const m = Math.floor(totalSec / 60), s = Math.round(totalSec % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
};
