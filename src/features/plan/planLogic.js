// ─── Daily Plan — the shape of a day, set once ───────────────────────────────
// Two templates, not a planner. A weekday and a weekend, each an ordered run of
// time blocks plus a few guardrails, written once and then consulted. Nothing
// here is per-date, and that is the whole design: a plan you have to make every
// morning is a plan that doesn't get made on the morning it was needed — the
// one where you feel behind, open the laptop at 7, skip the workout, and are
// still working at 8pm. The template is already there on that morning; the
// only job left is to look at it.
//
// STORED IN app_settings.daily_plan, NOT A TABLE. One small document per
// account, read at sign-in with every other setting and written whole through
// updateSetting — so no migration, no setup card, and it rides the same unsaved
// chip and retry every other setting does. The cost is the one every whole-value
// setting carries (see the note above updateSetting in App.jsx): two devices
// editing the plan in the same sitting would last-write-win. For a document you
// edit a few times a year that is the right trade, and it is why this key is NOT
// in MERGING_SETTINGS, whose allowlist is mirrored inside a SQL function.
//
// A BLOCK HAS A START AND NO END. It runs until the next block begins, and the
// last block of the day runs until the first block of the next — so "Sleep"
// at 10:30pm is still the current block at 2am, and the day has no gaps to
// explain and no overlaps to forbid. That also makes "how long is the work
// day" a question the plan can answer honestly (workWindow below).
//
// Pure — no React, no Date.now() of its own (every clock read takes the date it
// is handed) — so scripts/plan-smoke.mjs runs all of it in bare Node at a
// frozen time.

export const PLAN_SETTING = "daily_plan";

// Mon–Fri and Sat–Sun. Getting this wrong is a whole day of the wrong plan, so
// it is one function (dayTypeOf) and both the tab and the Brief card call it.
export const DAY_TYPES = [
  { key: "weekday", label: "Weekdays", short: "Weekday", days: "Mon–Fri" },
  { key: "weekend", label: "Weekends", short: "Weekend", days: "Sat & Sun" },
];

/** "weekday" | "weekend" for a LOCAL date — getDay(), never getUTCDay(), or a
 *  Friday evening in Chicago reads as Saturday (see lib/dates.js). */
export function dayTypeOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dow = d.getDay();
  return dow === 0 || dow === 6 ? "weekend" : "weekday";
}

/**
 * What a block is FOR. The colour is the only thing a kind adds, and it is what
 * lets a glance down the day read as "work, work, body, life" rather than as a
 * column of times. Four, because past four nobody remembers which colour is
 * which. Tones are the data palette's order (DESIGN.md §3) and are identity,
 * never status — a work block is not "good" because it is blue.
 */
export const KINDS = [
  { key: "work", label: "Work", tone: "var(--blue)" },
  { key: "body", label: "Body", tone: "var(--green)" },
  { key: "life", label: "Life", tone: "var(--purple)" },
  { key: "rest", label: "Rest", tone: "var(--pink)" },
];
// An unknown kind (an older build, a hand edit) lands on Life — the neutral
// bucket — rather than dropping the block or drawing it with no dot.
export const kindMeta = (k) => KINDS.find((x) => x.key === k) || KINDS[2];

export const MAX_TITLE = 80;
export const MAX_NOTE = 240;
export const MAX_RULE = 200;

// ─── time ────────────────────────────────────────────────────────────────────

/** "06:30" → 390. Anything that is not a real HH:MM on a 24-hour clock is null:
 *  a block with no valid start has nowhere to sit in the day, and guessing one
 *  would put it somewhere he never wrote. */
export function parseHM(s) {
  const m = typeof s === "string" ? /^(\d{1,2}):(\d{2})$/.exec(s.trim()) : null;
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 390 → "06:30" — the value an <input type="time"> takes. */
export function toHM(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 390 → "6:30 AM", 1440+360 → "6:00 AM". Written out rather than
 *  toLocaleTimeString'd so the same minute prints the same way on every device
 *  and in the smoke, which runs in a Node that may not carry full ICU. */
export function fmtTime(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** 45 → "45m", 60 → "1h", 90 → "1h 30m". Rounded to the minute; never negative. */
export function fmtDur(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;

// ─── the stored document, read tolerantly ─────────────────────────────────────

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

function normalizeBlock(b, i) {
  if (!isObj(b)) return null;
  const start = parseHM(b.start);
  const title = clip(b.title, MAX_TITLE);
  if (start == null || !title) return null;
  return {
    // A missing id gets one derived from what the block IS, not a random one —
    // normalize runs on every render, and an id that changed each time would
    // remount every row and lose an open editor's target.
    id: typeof b.id === "string" && b.id ? b.id : `b${i}-${toHM(start)}`,
    start: toHM(start),
    title,
    note: clip(b.note, MAX_NOTE),
    kind: kindMeta(b.kind).key,
    protected: b.protected === true,
  };
}

function normalizeRule(r, i) {
  // A bare string is accepted too: it is the obvious thing to type into the
  // SQL editor, and refusing it would make a hand-written guardrail vanish.
  const text = clip(typeof r === "string" ? r : r?.text, MAX_RULE);
  if (!text) return null;
  return { id: isObj(r) && typeof r.id === "string" && r.id ? r.id : `r${i}`, text };
}

const uniqById = (list) => {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
};

/** Blocks in clock order. Ties keep the order they were stored in, so two
 *  blocks at one time don't swap places between renders. */
export function sortBlocks(blocks) {
  return blocks
    .map((b, i) => [b, i])
    .sort((a, b) => parseHM(a[0].start) - parseHM(b[0].start) || a[1] - b[1])
    .map(([b]) => b);
}

function normalizeDay(d) {
  const day = isObj(d) ? d : {};
  const blocks = uniqById((Array.isArray(day.blocks) ? day.blocks : []).map(normalizeBlock).filter(Boolean));
  const rules = uniqById((Array.isArray(day.rules) ? day.rules : []).map(normalizeRule).filter(Boolean));
  return { blocks: sortBlocks(blocks), rules };
}

/**
 * The stored value, made safe to render. Tolerant of anything — null, a string,
 * an array, blocks with no start, a kind from the future — because the failure
 * mode of guessing wrong here is a tab that throws or a Brief card that blanks.
 * Never mutates; always returns both day types.
 */
export function normalizePlan(raw) {
  const src = isObj(raw) ? raw : {};
  const out = { v: 1 };
  for (const { key } of DAY_TYPES) out[key] = normalizeDay(src[key]);
  return out;
}

/** True when neither template has a single block — the "set it up" state. */
export const planIsEmpty = (plan) => DAY_TYPES.every(({ key }) => !normalizePlan(plan)[key].blocks.length);

// ─── where the day is ────────────────────────────────────────────────────────

/**
 * Each block with its minutes: startMin, and endMin = the next block's start.
 * The last block ends at `nextDayFirst` + 1440 (tomorrow's first block) when
 * that is known, else midnight — which is the honest answer for a day with
 * nothing after it.
 */
export function withSpans(blocks, nextDayFirst = null) {
  const list = Array.isArray(blocks) ? blocks : [];
  return list.map((b, i) => {
    const startMin = parseHM(b.start);
    const nxt = list[i + 1];
    const endMin = nxt ? parseHM(nxt.start) : nextDayFirst != null ? 1440 + nextDayFirst : 1440;
    return { ...b, startMin, endMin, minutes: endMin - startMin };
  });
}

const dayShift = (date, n) => {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
};

/**
 * Where the day is right now: the block you should be in, the one after it,
 * and how long until the switch.
 *
 * THE NIGHT BELONGS TO THE DAY BEFORE. Before today's first block, the block
 * that is running is YESTERDAY's last one — at 5:40 on a Monday you are still
 * in Sunday's "Sleep", not in a void before Monday starts. That is also the
 * moment this whole tab exists for: "Now: Sleep · next: Workout at 6:15" is the
 * answer that stops the laptop opening at 7, and "nothing planned yet" is not.
 *
 * Returns { type, current, next, minutesLeft, progress } — current/next carry
 * their spans; `carried` marks a block from the day before, `tomorrow` marks a
 * next block that falls after midnight. Any of them may be null when the plan
 * for the relevant day is empty.
 */
export function whereAmI(plan, date = new Date()) {
  const p = normalizePlan(plan);
  const type = dayTypeOf(date);
  const today = p[type].blocks;
  const yesterday = p[dayTypeOf(dayShift(date, -1))].blocks;
  const tomorrow = p[dayTypeOf(dayShift(date, 1))].blocks;
  const now = minuteOfDay(date);
  const empty = { type, current: null, next: null, minutesLeft: null, progress: null };

  if (!today.length) {
    // Nothing planned for today's kind of day. Yesterday's last block can still
    // be running past midnight, but with no first block today it has no end, so
    // saying "until …" would be invented. The card says the template is empty.
    return empty;
  }

  const firstToday = parseHM(today[0].start);
  const spans = withSpans(today, tomorrow.length ? parseHM(tomorrow[0].start) : null);

  if (now < firstToday) {
    const next = spans[0];
    if (!yesterday.length) return { ...empty, next, minutesLeft: firstToday - now };
    const last = yesterday[yesterday.length - 1];
    const startMin = parseHM(last.start) - 1440; // it began yesterday
    const current = { ...last, startMin, endMin: firstToday, minutes: firstToday - startMin, carried: true };
    return { type, current, next, minutesLeft: firstToday - now, progress: (now - startMin) / (firstToday - startMin) };
  }

  let idx = 0;
  for (let i = 0; i < spans.length; i++) if (spans[i].startMin <= now) idx = i;
  const current = spans[idx];
  let next = spans[idx + 1] || null;
  if (!next && tomorrow.length) {
    const t = withSpans(tomorrow)[0];
    next = { ...t, startMin: t.startMin + 1440, tomorrow: true };
  }
  const span = current.endMin - current.startMin;
  return {
    type, current, next,
    minutesLeft: current.endMin - now,
    progress: span > 0 ? Math.min(1, Math.max(0, (now - current.startMin) / span)) : 1,
  };
}

/**
 * The work day the plan describes: from the first Work block's start to the end
 * of the last one, and how many minutes of Work blocks sit inside it (lunch, if
 * it's a Life block, doesn't count). This is the guardrail in numbers — "8:30 AM
 * – 5:30 PM, 8h" — and the reason it is computed rather than typed: the
 * sentence can't drift from the blocks it summarises.
 *
 * A Work block that is the LAST block of the day has no honest end (it would run
 * until tomorrow's first block), so the window is reported open-ended rather
 * than as a 20-hour shift. That is a plan with no stop in it, and saying so is
 * the useful answer.
 */
export function workWindow(blocks) {
  const spans = withSpans(blocks);
  const work = spans.filter((b) => b.kind === "work");
  if (!work.length) return null;
  const last = work[work.length - 1];
  const open = last === spans[spans.length - 1];
  const minutes = work.reduce((s, b) => s + (b === last && open ? 0 : b.minutes), 0);
  return { start: work[0].startMin, end: open ? null : last.endMin, minutes, open };
}

// ─── edits — each returns a new plan, never mutates ──────────────────────────

const mapDay = (plan, type, fn) => {
  const p = normalizePlan(plan);
  return { ...p, [type]: fn(p[type]) };
};

/** Add a block, or replace the one with the same id. Re-sorted on the way in. */
export const upsertBlock = (plan, type, block) => mapDay(plan, type, (d) => {
  const b = normalizeBlock(block, d.blocks.length);
  if (!b) return d;
  const has = d.blocks.some((x) => x.id === b.id);
  return { ...d, blocks: sortBlocks(has ? d.blocks.map((x) => (x.id === b.id ? b : x)) : [...d.blocks, b]) };
});

export const removeBlock = (plan, type, id) => mapDay(plan, type, (d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) }));

export const upsertRule = (plan, type, rule) => mapDay(plan, type, (d) => {
  const r = normalizeRule(rule, d.rules.length);
  if (!r) return d;
  const has = d.rules.some((x) => x.id === r.id);
  return { ...d, rules: has ? d.rules.map((x) => (x.id === r.id ? r : x)) : [...d.rules, r] };
});

export const removeRule = (plan, type, id) => mapDay(plan, type, (d) => ({ ...d, rules: d.rules.filter((r) => r.id !== id) }));

/** Put a removed rule back where it was — the Undo after a delete. */
export const restoreRule = (plan, type, rule, at) => mapDay(plan, type, (d) => {
  const r = normalizeRule(rule, d.rules.length);
  if (!r || d.rules.some((x) => x.id === r.id)) return d;
  const rules = [...d.rules];
  rules.splice(Math.max(0, Math.min(at ?? rules.length, rules.length)), 0, r);
  return { ...d, rules };
});

/** Replace one template with a copy of the other — "start weekends from my
 *  weekday plan". The ids are kept: they only have to be unique within a day. */
export const copyDay = (plan, from, to) => {
  const p = normalizePlan(plan);
  return { ...p, [to]: { blocks: p[from].blocks.map((b) => ({ ...b })), rules: p[from].rules.map((r) => ({ ...r })) } };
};

/**
 * Why a block can't be saved, or null. Checked in the editor before the write so
 * the message lands next to the field instead of the block silently not saving.
 * Two blocks at the same minute is refused: one of them would last zero
 * minutes, and which one "wins" would come down to storage order.
 */
export function blockProblem(day, draft) {
  if (parseHM(draft?.start) == null) return "Pick a start time.";
  if (!clip(draft?.title, MAX_TITLE)) return "Give it a name.";
  const clash = (day?.blocks || []).find((b) => b.id !== draft.id && b.start === toHM(parseHM(draft.start)));
  if (clash) return `"${clash.title}" already starts at ${fmtTime(parseHM(draft.start))}.`;
  return null;
}

// ─── the starting point ──────────────────────────────────────────────────────
// Offered once, on an empty plan, as something to edit rather than something to
// keep. It is written to the specific failure this tab was built for: the
// workout sits BEFORE work and is protected, the laptop has a start time that
// isn't 7, and the day has a hard stop that is its own block — so "I'll just
// finish this" has a line on screen it is crossing.

const B = (id, start, title, kind, extra = {}) => ({ id, start, title, kind, note: "", protected: false, ...extra });

export const STARTER = {
  v: 1,
  weekday: {
    blocks: [
      B("wd-up", "06:00", "Up — phone stays down", "life"),
      B("wd-workout", "06:15", "Workout", "body", { protected: true, note: "Before anything with a screen. Being behind on work doesn't move this." }),
      B("wd-ready", "07:30", "Shower, breakfast", "life"),
      B("wd-work1", "08:30", "Work — hardest thing first", "work"),
      B("wd-lunch", "12:00", "Lunch, step outside", "life"),
      B("wd-work2", "13:00", "Work", "work"),
      B("wd-stop", "17:30", "Hard stop — laptop closed", "rest", { protected: true, note: "Write tomorrow's first task, then shut it." }),
      B("wd-evening", "18:00", "Evening", "life"),
      B("wd-wind", "21:30", "Wind down — screens off", "rest"),
      B("wd-sleep", "22:30", "Sleep", "rest"),
    ],
    rules: [
      { id: "wd-r1", text: "Laptop stays closed until 8:30. The workout comes first." },
      { id: "wd-r2", text: "Feeling behind is not a reason to skip the workout — it's the reason to do it." },
      { id: "wd-r3", text: "Hard stop at 5:30. One late night costs the rest of the week." },
    ],
  },
  weekend: {
    blocks: [
      B("we-up", "07:30", "Up, slow morning", "life"),
      B("we-move", "08:30", "Workout or a long ride", "body", { protected: true }),
      B("we-free", "10:00", "The day is yours", "life"),
      B("we-dinner", "18:00", "Dinner", "life"),
      B("we-wind", "22:30", "Wind down", "rest"),
      B("we-sleep", "23:30", "Sleep", "rest"),
    ],
    rules: [
      { id: "we-r1", text: "No work email. If it's truly urgent, someone will call." },
      { id: "we-r2", text: "Move first, then the day is yours." },
    ],
  },
};
