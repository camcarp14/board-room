// ─── Recurring events — expansion, editing scopes, plain English ─────────────
// One stored row per series (the master) carrying an `rrule`; the occurrences
// you see are expanded from it at render time. The alternative — writing N
// rows — has no N for "every Monday, forever", and makes editing a series a
// thousand-row rewrite that a half-finished write leaves half-edited.
//
// THE RULE SHAPE, stored as jsonb on personal_events.rrule:
//   { freq: 'daily'|'weekly'|'monthly'|'yearly',
//     interval: 1..N,                 every N days/weeks/months/years
//     byWeekday: [0..6],              weekly only; 0=Sun. Empty ⇒ the start's
//                                     own weekday.
//     until: 'YYYY-MM-DD',            inclusive last day, or absent
//     count: N }                      total occurrences, or absent
// `until` and `count` are alternatives; if both appear, whichever ends the
// series first wins, because either one alone is a promise the user made.
//
// EVERYTHING HERE IS LOCAL-CALENDAR MATH, NOT MILLISECOND MATH. Adding
// 7*86400000 to a timestamp is wrong twice a year: across a DST boundary it
// lands an hour off, and "the 5th of every month" is not a fixed number of ms
// at all. So each step is taken with Date(y, m, d) constructors, which the
// runtime resolves against the local zone the user actually lives in.
//
// Pure — no DOM, no clock unless passed one. scripts/recurrence-smoke.mjs
// exercises every branch.

export const FREQS = ["daily", "weekly", "monthly", "yearly"];
export const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th"];

// A hard ceiling on how many occurrences one expansion may produce. A corrupt
// or hand-edited rule (interval 0, a far-future `until`) must not be able to
// hang the render loop — it fails as a short list, never as a frozen tab.
const MAX_OCCURRENCES = 750;

/* ── local day keys — "YYYY-MM-DD" in the USER'S zone ──────────────────────
 * Deliberately not toISOString().slice(0,10): that is the UTC day, and for
 * anyone west of Greenwich an evening event reports as tomorrow. src/lib/
 * dates.js opens with the same warning for the same reason. */
export function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * Add months while keeping the day-of-month intact where the target month has
 * one. "The 31st, monthly" has no 31st in February; it CLAMPS to the 28th
 * rather than rolling into March, which is what a native Date(y, m+1, 31)
 * would silently do — and a bill that jumps to the 3rd every other month is
 * a bug the user only notices after missing it.
 */
function addMonthsClamped(d, n, anchorDay) {
  const want = anchorDay ?? d.getDate();
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const lastOfTarget = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(want, lastOfTarget));
}

/** Normalize a stored rule, rejecting shapes that cannot terminate. */
export function normalizeRule(rrule) {
  if (!rrule || typeof rrule !== "object") return null;
  const freq = FREQS.includes(rrule.freq) ? rrule.freq : null;
  if (!freq) return null;
  // interval 0 would step nowhere and spin the loop against MAX_OCCURRENCES.
  const interval = Math.max(1, Math.min(365, Math.floor(Number(rrule.interval) || 1)));
  const byWeekday = Array.isArray(rrule.byWeekday)
    ? [...new Set(rrule.byWeekday.map((n) => Math.floor(Number(n))).filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b)
    : [];
  const count = Number.isFinite(Number(rrule.count)) && Number(rrule.count) > 0
    ? Math.min(MAX_OCCURRENCES, Math.floor(Number(rrule.count))) : null;
  const until = parseDayKey(rrule.until) ? String(rrule.until) : null;
  return { freq, interval, byWeekday: freq === "weekly" ? byWeekday : [], until, count };
}

/**
 * Every occurrence DAY of one master between `from` and `to` (inclusive),
 * as local day keys.
 *
 * Walks the series from its own start rather than jumping into the middle of
 * it: a monthly rule's clamping (see addMonthsClamped) makes the nth date a
 * function of the sequence, not an offset, so seeking would drift. The walk
 * is bounded by MAX_OCCURRENCES and short-circuits once past `to`.
 */
// A span wider than this is a corrupt end_time rather than a real event, and
// widening the search window by it would make every expansion walk years.
const MAX_SPAN_DAYS = 400;

export function occurrenceDays(master, from, to) {
  const rule = normalizeRule(master && master.rrule);
  const start = master && master.start_time ? new Date(master.start_time) : null;
  if (!start || Number.isNaN(start.getTime())) return [];
  const startDay = startOfDay(start);

  // A MULTI-DAY EVENT IS IN THE WINDOW IF ANY OF ITS DAYS IS, not only its
  // first. This tested membership on the START day alone, and the callers hand
  // it a window barely wider than what is on screen — so a conference that
  // began the Thursday before the visible month disappeared from every cell it
  // covered, and a five-day trip that started yesterday was missing from
  // Upcoming entirely. spanDayKeys runs AFTER expansion, so it never got the
  // chance to paint days for an occurrence expansion had already dropped.
  //
  // The span is whole local days between start and end, so widening the low
  // bound by it lets an occurrence that starts before the window but reaches
  // into it still be emitted; the day keys it covers are worked out downstream
  // exactly as before.
  const spanDays = (() => {
    const end = master && master.end_time ? new Date(master.end_time) : null;
    if (!end || Number.isNaN(end.getTime())) return 0;
    const d = Math.round((startOfDay(end) - startDay) / 86400000);
    return Number.isFinite(d) && d > 0 ? Math.min(d, MAX_SPAN_DAYS) : 0;
  })();
  const widen = (d) => (spanDays ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - spanDays) : d);

  if (!rule) {
    const k = dayKey(startDay);
    return startDay >= widen(startOfDay(from)) && startDay <= startOfDay(to) ? [k] : [];
  }

  const exdates = new Set(Array.isArray(master.exdates) ? master.exdates.map(String) : []);
  const untilDay = rule.until ? parseDayKey(rule.until) : null;
  const lo = widen(startOfDay(from));
  const hi = startOfDay(to);
  const out = [];

  // `emitted` counts occurrences from the SERIES start, not from `from` —
  // `count: 10` means ten in total, so a window late in the series must know
  // how many came before it or it would keep emitting past the tenth.
  let emitted = 0;
  let guard = 0;

  const consider = (d) => {
    if (untilDay && d > untilDay) return false;           // series over
    if (rule.count != null && emitted >= rule.count) return false;
    emitted += 1;
    if (d >= lo && d <= hi) {
      const k = dayKey(d);
      if (!exdates.has(k)) out.push(k);
    }
    return true;
  };

  if (rule.freq === "weekly") {
    // The days of the week this rule lands on; empty means "the same weekday
    // the series started on".
    const days = rule.byWeekday.length ? rule.byWeekday : [startDay.getDay()];
    // Anchor to the start of the series' own week so `interval` counts WEEKS
    // rather than counting from an arbitrary weekday inside one.
    let weekStart = addDays(startDay, -startDay.getDay());
    while (guard++ < MAX_OCCURRENCES) {
      let alive = false;
      for (const wd of days) {
        const d = addDays(weekStart, wd);
        if (d < startDay) { alive = true; continue; }      // before the series began
        if (!consider(d)) { alive = false; break; }
        alive = true;
      }
      if (!alive) break;
      weekStart = addDays(weekStart, 7 * rule.interval);
      if (weekStart > hi && out.length) break;
      if (weekStart > hi && (!rule.count || emitted >= rule.count)) break;
      if (weekStart.getFullYear() > hi.getFullYear() + 5) break;
    }
    return out;
  }

  const anchorDom = startDay.getDate();
  let d = startDay;
  while (guard++ < MAX_OCCURRENCES) {
    if (!consider(d)) break;
    if (rule.freq === "daily") d = addDays(d, rule.interval);
    else if (rule.freq === "monthly") d = addMonthsClamped(d, rule.interval, anchorDom);
    else d = addMonthsClamped(d, 12 * rule.interval, anchorDom);
    if (d > hi) break;
  }
  return out;
}

/**
 * Expand a list of stored rows into the concrete occurrences inside a window.
 *
 * Each occurrence keeps the master's fields but carries its OWN date, plus
 * `masterId` and `occurrenceDay` so an edit can say which one it meant. The
 * synthetic `id` is `${masterId}@${day}` — unique per occurrence, and
 * recognisably not a database id, so nothing can mistake one for a row to
 * delete. Time-of-day and duration ride along from the master.
 */
export function expandEvents(rows, from, to) {
  const out = [];
  for (const ev of Array.isArray(rows) ? rows : []) {
    if (!ev || !ev.start_time) continue;
    const start = new Date(ev.start_time);
    if (Number.isNaN(start.getTime())) continue;
    const days = occurrenceDays(ev, from, to);
    if (!days.length) continue;
    const rule = normalizeRule(ev.rrule);
    const end = ev.end_time ? new Date(ev.end_time) : null;
    const durationMs = end && !Number.isNaN(end.getTime()) ? Math.max(0, end - start) : null;

    for (const day of days) {
      const base = parseDayKey(day);
      if (!base) continue;
      const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
        start.getHours(), start.getMinutes(), 0, 0);
      const e = durationMs == null ? null : new Date(s.getTime() + durationMs);
      out.push({
        ...ev,
        id: rule ? `${ev.id}@${day}` : ev.id,
        masterId: ev.id,
        occurrenceDay: day,
        isRecurring: !!rule,
        rrule: ev.rrule || null,
        start_time: s.toISOString(),
        end_time: e ? e.toISOString() : null,
      });
    }
  }
  out.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  return out;
}

/* ══ editing scopes ═════════════════════════════════════════════════════════
 *
 * Three answers to "which ones did you mean", and they are the three every
 * real calendar offers because each is genuinely different:
 *
 *   one    — this occurrence only. The day is added to the master's exdates
 *            and (for an edit) a standalone row takes its place. The series
 *            keeps running around the hole.
 *   future — this one and everything after. The master is capped the day
 *            BEFORE, and a fresh master starts here carrying the edit. History
 *            before the split is never rewritten, which is the point.
 *   all    — the whole series, edited in place on the master.
 *
 * These return plain descriptions of the writes to perform, so the data layer
 * stays dumb and this stays testable without a database.
 */

/** Occurrence → the writes that delete just it. */
export function deleteOccurrence(master, day) {
  const exdates = [...new Set([...(Array.isArray(master.exdates) ? master.exdates : []), day])];
  return { update: [{ id: master.id, exdates }], delete: [] };
}

/** Occurrence → the writes that end the series the day before it. */
export function deleteFuture(master, day) {
  const d = parseDayKey(day);
  const startDay = startOfDay(new Date(master.start_time));
  // Cutting at or before the first occurrence removes the series outright —
  // an "until" earlier than the start would otherwise leave a row that can
  // never render, which reads to the user as a delete that silently failed.
  if (!d || d <= startDay) return { update: [], delete: [master.id] };
  const until = dayKey(addDays(d, -1));
  return {
    update: [{ id: master.id, rrule: { ...normalizeRule(master.rrule), until, count: null } }],
    delete: [],
  };
}

/** The whole series, including masters split off by earlier "future" edits. */
export function deleteSeries(master, allRows) {
  const sid = master.series_id || master.id;
  const ids = (Array.isArray(allRows) ? allRows : [])
    .filter((r) => r && (r.series_id || r.id) === sid)
    .map((r) => r.id);
  return { update: [], delete: ids.length ? ids : [master.id] };
}

/**
 * Editing one occurrence: punch it out of the series and write a standalone
 * row in its place. A separate row rather than an overrides blob keyed by
 * date — the blob has to be merged on every read, and every consumer that
 * forgets is a place the edit silently doesn't apply.
 */
export function editOccurrence(master, day, patch, newId) {
  const exdates = [...new Set([...(Array.isArray(master.exdates) ? master.exdates : []), day])];
  return {
    update: [{ id: master.id, exdates }],
    insert: [{ ...master, ...patch, id: newId, rrule: null, exdates: [], series_id: null }],
  };
}

/** Editing this and every later one: cap the old master, start a new series. */
export function editFuture(master, day, patch, newId) {
  const d = parseDayKey(day);
  const startDay = startOfDay(new Date(master.start_time));
  const next = { ...master, ...patch, id: newId, exdates: [], series_id: master.series_id || master.id };
  if (!d || d <= startDay) {
    // The split lands on the first occurrence — there is no "before" to keep,
    // so this is just an edit of the whole series.
    return { update: [{ ...master, ...patch }], insert: [], delete: [] };
  }
  return {
    update: [{ id: master.id, rrule: { ...normalizeRule(master.rrule), until: dayKey(addDays(d, -1)), count: null } }],
    insert: [next],
    delete: [],
  };
}

/* ══ plain English ══════════════════════════════════════════════════════════ */

/** "Every 2 weeks on Mon, Wed · until Dec 1" — the label under the repeat row. */
export function describeRule(rrule, startDate) {
  const rule = normalizeRule(rrule);
  if (!rule) return "Does not repeat";
  const n = rule.interval;
  let base;
  if (rule.freq === "daily") base = n === 1 ? "Every day" : `Every ${n} days`;
  else if (rule.freq === "weekly") {
    const days = rule.byWeekday.length
      ? rule.byWeekday
      : (startDate ? [new Date(startDate).getDay()] : []);
    const names = days.map((w) => WEEKDAY_NAMES[w].slice(0, 3)).join(", ");
    base = n === 1 ? "Every week" : n === 2 ? "Every 2 weeks" : `Every ${n} weeks`;
    if (names) base += ` on ${names}`;
  } else if (rule.freq === "monthly") {
    const dom = startDate ? new Date(startDate).getDate() : null;
    base = n === 1 ? "Every month" : `Every ${n} months`;
    if (dom) base += ` on the ${ORDINALS[Math.ceil(dom / 7)] && dom <= 31 ? ordinal(dom) : dom}`;
  } else {
    base = n === 1 ? "Every year" : `Every ${n} years`;
  }
  if (rule.count) base += ` · ${rule.count} times`;
  else if (rule.until) {
    const u = parseDayKey(rule.until);
    if (u) base += ` · until ${u.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return base;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
