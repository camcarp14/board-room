// ─── Board Room · Plan ───────────────────────────────────────────────────────
// A Scriptable widget for iOS/iPadOS that keeps your Daily Plan on the Home
// Screen and Lock Screen: the block you should be in right now, a live countdown
// to the end of it, and the rest of the day hour by hour.
//
// It reads the Daily Plan tab's two templates (weekday and weekend) from
//   /.netlify/functions/trmnl?view=plan&token=…
// — the same endpoint and the same token as the notes and calendar widgets — and
// then works out where the day is ON THE PHONE. The templates hardly ever change;
// the time does. So the widget can redraw at the start of every block without the
// network, and it is right on a plane.
//
// SETUP — if the Notes or Calendar widget is already on this phone, there is
// nothing to type: all three read one keychain entry.
//   1. Scriptable → + (new script) → paste this whole file → name it
//      "Board Room Plan".
//   2. Tap ▶ once inside Scriptable (it asks for the token only if none is stored).
//   3. Home Screen → long-press → Edit → Add Widget → Scriptable → pick a size.
//      Long-press it → Edit Widget → Script: "Board Room Plan".
//
// SIZES
//   small            now, the countdown, and what's next
//   medium           now on the left; next and then on the right
//   large / XL       now, the day hour by hour, and a band beneath: your next
//                    calendar events beside a note of your choosing
//   Lock Screen      inline / circular / rectangular
//
// WIDGET PARAMETER (optional, Edit Widget → Parameter)
//   a note's title    e.g. "Development" — that note's lines sit in the large
//                     widget's band, beside the calendar. Matched the way the
//                     notes widget matches: case doesn't matter, and the start
//                     of a title is enough. Leave it blank for the calendar alone.
//
// THE CALENDAR is the Calendar tab's own events, repeating ones included — they
// are expanded here, on the phone, exactly as the tab expands them in your
// browser (a copy of src/lib/recurrence.js; see "calendar" below).
//
// HOW IT STAYS CURRENT — without asking iOS for the impossible:
//   · The countdown is a live timer. iOS ticks it every second on its own; the
//     widget doesn't have to refresh for it to move.
//   · The widget asks to redraw at the exact minute the next block starts, and
//     every REFRESH_MINUTES in between so the progress bar keeps up.
//   iOS gives each widget a daily budget of redraws (roughly 40–70) and decides
//   when to spend it. Asking for every 5 minutes would spend it by mid-afternoon,
//   and the redraw that went missing would be the one at your hard stop. That is
//   why the block changes are asked for exactly and the rest is spaced out.
//
// Colors are the app's Porcelain palette (src/design/themes.css), and each block
// keeps its kind's color from the Plan tab: Work blue, Body green, Life purple,
// Rest pink. Tapping the widget opens the Plan tab.

// ── config ───────────────────────────────────────────────────────────────────
const SITE = "https://board-room.netlify.app"; // no trailing slash
const TOKEN = ""; // your TRMNL_TOKEN — or leave "" to be prompted once (keychain)

const REFRESH_MINUTES = 15; // between block changes, which are always asked for exactly
const CACHE_TTL_DAYS = 7; // a set-once plan is still the plan a week later
const PREVIEW = "medium"; // size shown when you run the script inside the app

// ── palette ──────────────────────────────────────────────────────────────────
const dyn = (light, dark, alpha) =>
  Color.dynamic(new Color(light, alpha), new Color(dark, alpha));

const C = {
  bg: dyn("#F4F3F0", "#0F0E0B"),
  surface: dyn("#FEFEFE", "#211F19"),
  ink: dyn("#2B2922", "#D9D6CE"),
  sub: dyn("#706B5C", "#9F9989"),
  faint: dyn("#8E897B", "#7F7A6C"),
  accent: dyn("#87671D", "#D7AA42"),
  line: dyn("#2B2922", "#D9D6CE", 0.12),
  track: dyn("#2B2922", "#D9D6CE", 0.08),
};

// KINDS in src/features/plan/planLogic.js, with the theme's --blue, --green,
// --purple and --pink. An unknown kind is Life, as it is in the app.
const KIND_HEX = {
  work: ["#3568D4", "#4C82E8"],
  body: ["#278A4C", "#34A56E"],
  life: ["#6B41C4", "#9673E6"],
  rest: ["#C7447E", "#D95C93"],
};
const KIND_SYMBOL = { work: "briefcase.fill", body: "figure.run", life: "leaf.fill", rest: "moon.fill" };
const kindKey = (k) => (KIND_HEX[k] ? k : "life");

// The Calendar tab's category colors (EVENT_CATEGORIES), and the notes' four
// seals (NOTE_SEALS) — the same values the calendar and notes widgets use.
const CAT_HEX = { personal: ["#3568D4", "#4C82E8"], work: ["#B36514", "#BC7F24"], health: ["#278A4C", "#34A56E"], bills: ["#C93B32", "#E05548"] };
const catColor = (k) => dyn(...(CAT_HEX[k] || CAT_HEX.personal));
const SEAL_HEX = { brass: ["#87671D", "#D7AA42"], green: ["#278A4C", "#34A56E"], blue: ["#3568D4", "#4C82E8"], red: ["#C93B32", "#E05548"] };
const sealDot = (seal) => (SEAL_HEX[seal] ? dyn(...SEAL_HEX[seal]) : null);
const kindColor = (k, alpha) => dyn(KIND_HEX[kindKey(k)][0], KIND_HEX[kindKey(k)][1], alpha);

// ── token ────────────────────────────────────────────────────────────────────
// The calendar and notes widgets' keychain entry, on purpose: one token, once.
const KEYCHAIN_KEY = "boardroom.trmnl.token";

async function resolveToken() {
  if (TOKEN) return TOKEN;
  if (Keychain.contains(KEYCHAIN_KEY)) return Keychain.get(KEYCHAIN_KEY);
  if (!config.runsInApp) return null;

  const a = new Alert();
  a.title = "Board Room token";
  a.message =
    "Paste your TRMNL_TOKEN (Netlify → Site configuration → Environment " +
    "variables). It's stored in this device's keychain, not in the script, " +
    "and the other Board Room widgets use it too.";
  a.addSecureTextField("TRMNL_TOKEN", "");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  if ((await a.present()) === -1) return null;

  const v = (a.textFieldValue(0) || "").trim();
  if (!v) return null;
  Keychain.set(KEYCHAIN_KEY, v);
  return v;
}

// ── data ─────────────────────────────────────────────────────────────────────
// One cache per parameter, so a widget showing one note never falls back to
// another widget's note.
const fm = FileManager.local();
const cacheSlug = String(args.widgetParameter || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const CACHE_PATH = fm.joinPath(fm.cacheDirectory(), `board-room-plan${cacheSlug ? `-${cacheSlug}` : ""}.json`);

function cacheRead() {
  try {
    if (!fm.fileExists(CACHE_PATH)) return null;
    const raw = JSON.parse(fm.readString(CACHE_PATH));
    return raw && raw.data ? raw : null;
  } catch {
    return null;
  }
}

function cacheWrite(data) {
  try {
    fm.writeString(CACHE_PATH, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // A widget that can't write its cache should still render. Ignore.
  }
}

const PARAM = String(args.widgetParameter || "").trim();

async function fetchPlan(token) {
  let url = `${SITE}/.netlify/functions/trmnl?view=plan&token=${encodeURIComponent(token)}`;
  if (PARAM) url += `&note=${encodeURIComponent(PARAM)}`;
  const req = new Request(url);
  req.timeoutInterval = 10;
  const data = await req.loadJSON();
  if (data && data.success === false) {
    const err = new Error(data.error || "feed refused the request");
    err.isAuthError = /missing or incorrect token/i.test(data.error || "");
    throw err;
  }
  // A site still on the previous function ignores view=plan and answers with the
  // calendar brief. Say that, rather than "unexpected response".
  if (data && Array.isArray(data.events) && !("plan" in data)) {
    throw new Error("This site doesn't serve the plan yet — deploy the latest Board Room.");
  }
  if (!data || !("plan" in data)) throw new Error("unexpected response from the feed");
  return data;
}

// Network first, then the cache — which for a plan is nearly as good as live, so
// it is trusted for days rather than hours, and only marked once it's old.
async function load() {
  const token = await resolveToken();
  if (!token) return { data: null, error: "Open Scriptable and run this script once to add your token." };
  try {
    const data = await fetchPlan(token);
    cacheWrite(data);
    return { data, stale: false };
  } catch (e) {
    if (e.isAuthError && config.runsInApp && !TOKEN) {
      Keychain.remove(KEYCHAIN_KEY);
      const retryToken = await resolveToken();
      if (retryToken) {
        try {
          const data = await fetchPlan(retryToken);
          cacheWrite(data);
          return { data, stale: false };
        } catch (e2) {
          e = e2;
        }
      }
    }
    const cached = cacheRead();
    if (cached && Date.now() - cached.at < CACHE_TTL_DAYS * 86400000) {
      return { data: cached.data, stale: true, cachedAt: cached.at };
    }
    return { data: null, error: String(e.message || e) };
  }
}

// ── the plan, worked out here ────────────────────────────────────────────────
// A copy of src/features/plan/planLogic.js — normalizePlan, withSpans and
// whereAmI — because a widget can't import the app, and has to run offline.
// scripts/plan-widget-smoke.mjs runs this file against the original at hundreds
// of instants (weekday into weekend, before the first block, the night the
// clocks change) and fails the build if they disagree about where you are.
// Change one, change both.

const DAY_TYPES = ["weekday", "weekend"];
const dayTypeOf = (d) => (d.getDay() === 0 || d.getDay() === 6 ? "weekend" : "weekday");

function parseHM(s) {
  const m = typeof s === "string" ? /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s.trim()) : null;
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
function toHM(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function fmtTime(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function fmtDur(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
// Local midnight plus `mins`, built by the Date constructor so the night the
// clocks change comes out right.
const instantAt = (date, mins) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, mins).getTime();
const dayShift = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

function normalizeBlock(b, i) {
  if (!isObj(b)) return null;
  const start = parseHM(b.start);
  const title = clip(b.title, 80);
  if (start == null || !title) return null;
  return {
    id: typeof b.id === "string" && b.id ? b.id : `b${i}-${toHM(start)}`,
    start: toHM(start),
    title,
    note: clip(b.note, 240),
    kind: kindKey(b.kind),
    protected: b.protected === true,
  };
}
function normalizePlan(raw) {
  const src = isObj(raw) ? raw : {};
  const out = {};
  for (const key of DAY_TYPES) {
    const day = isObj(src[key]) ? src[key] : {};
    const seen = new Set();
    const blocks = (Array.isArray(day.blocks) ? day.blocks : [])
      .map(normalizeBlock).filter(Boolean)
      .filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)))
      .map((b, i) => [b, i])
      .sort((a, b) => parseHM(a[0].start) - parseHM(b[0].start) || a[1] - b[1])
      .map(([b]) => b);
    // The guardrails (day.rules) stay on the Plan tab and the Brief; a widget
    // this size is for where you are, not for the reasons.
    out[key] = { blocks };
  }
  return out;
}

function withSpans(blocks, nextDayFirst = null) {
  return blocks.map((b, i) => {
    const startMin = parseHM(b.start);
    const nxt = blocks[i + 1];
    const endMin = nxt ? parseHM(nxt.start) : nextDayFirst != null ? 1440 + nextDayFirst : 1440;
    return { ...b, startMin, endMin, minutes: endMin - startMin };
  });
}

// Where the day is: { type, current, next, minutesLeft, progress }. The night
// belongs to the day before — at 5:40 on a Monday you are still in Sunday's
// Sleep — exactly as the Plan tab has it.
function whereAmI(plan, date) {
  const type = dayTypeOf(date);
  const today = plan[type].blocks;
  const yesterday = plan[dayTypeOf(dayShift(date, -1))].blocks;
  const tomorrow = plan[dayTypeOf(dayShift(date, 1))].blocks;
  const now = minuteOfDay(date);
  const empty = { type, current: null, next: null, minutesLeft: null, progress: null };
  if (!today.length) return empty;

  const firstToday = parseHM(today[0].start);
  const spans = withSpans(today, tomorrow.length ? parseHM(tomorrow[0].start) : null);
  const t = date.getTime();
  const left = (endMin) => (instantAt(date, endMin) - t) / 60000;
  const share = (startMin, endMin) => {
    const a = instantAt(date, startMin), b = instantAt(date, endMin);
    return b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 1;
  };

  if (now < firstToday) {
    const next = spans[0];
    if (!yesterday.length) return { ...empty, next, minutesLeft: left(firstToday) };
    const last = yesterday[yesterday.length - 1];
    const startMin = parseHM(last.start) - 1440;
    const current = { ...last, startMin, endMin: firstToday, minutes: firstToday - startMin, carried: true };
    return { type, current, next, minutesLeft: left(firstToday), progress: share(startMin, firstToday) };
  }

  let idx = 0;
  for (let i = 0; i < spans.length; i++) if (spans[i].startMin <= now) idx = i;
  const current = spans[idx];
  let next = spans[idx + 1] || null;
  if (!next && tomorrow.length) {
    const first = withSpans(tomorrow)[0];
    next = { ...first, startMin: first.startMin + 1440, tomorrow: true };
  }
  return { type, current, next, minutesLeft: left(current.endMin), progress: share(current.startMin, current.endMin) };
}

// The day as one run, for "then" and the hour-by-hour list: last night's final
// block, today's, and tomorrow's, each placed in minutes from today's midnight.
function dayRun(plan, date) {
  const today = plan[dayTypeOf(date)].blocks;
  const yesterday = plan[dayTypeOf(dayShift(date, -1))].blocks;
  const tomorrow = plan[dayTypeOf(dayShift(date, 1))].blocks;
  const run = [];
  if (yesterday.length) {
    const last = yesterday[yesterday.length - 1];
    run.push({ ...last, startMin: parseHM(last.start) - 1440, carried: true });
  }
  for (const b of today) run.push({ ...b, startMin: parseHM(b.start) });
  for (const b of tomorrow) run.push({ ...b, startMin: parseHM(b.start) + 1440, tomorrow: true });
  run.forEach((b, i) => { b.endMin = run[i + 1] ? run[i + 1].startMin : b.startMin; });
  return run;
}

// ── calendar ─────────────────────────────────────────────────────────────────
// The Calendar tab's events, repeating ones expanded HERE. A series is one stored
// row with an rrule, and "every Tuesday at 9" is 9 in the zone you live in —
// local-calendar math, done with Date(y, m, d) constructors, which is why the feed
// can't do it (it runs in UTC) and the phone can: it is where the tab does it too.
//
// A copy of normalizeRule, occurrenceDays and expandEvents from
// src/lib/recurrence.js, trimmed to what a read-only list needs.
// scripts/plan-widget-smoke.mjs runs this widget's Upcoming list against the
// original's expansion over every rule shape and fails the build if they part.
// Change one, change both.

const FREQS = ["daily", "weekly", "monthly", "yearly"];
const MAX_OCCURRENCES = 750;
const MAX_SPAN_DAYS = 400;

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
function addMonthsClamped(d, n, anchorDay) {
  const want = anchorDay ?? d.getDate();
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const lastOfTarget = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(want, lastOfTarget));
}

function normalizeRule(rrule) {
  if (!rrule || typeof rrule !== "object") return null;
  const freq = FREQS.includes(rrule.freq) ? rrule.freq : null;
  if (!freq) return null;
  const interval = Math.max(1, Math.min(365, Math.floor(Number(rrule.interval) || 1)));
  const byWeekday = Array.isArray(rrule.byWeekday)
    ? [...new Set(rrule.byWeekday.map((n) => Math.floor(Number(n))).filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b)
    : [];
  const count = Number.isFinite(Number(rrule.count)) && Number(rrule.count) > 0
    ? Math.min(MAX_OCCURRENCES, Math.floor(Number(rrule.count))) : null;
  const until = parseDayKey(rrule.until) ? String(rrule.until) : null;
  return { freq, interval, byWeekday: freq === "weekly" ? byWeekday : [], until, count };
}

function occurrenceDays(master, from, to) {
  const rule = normalizeRule(master && master.rrule);
  const start = master && master.start_time ? new Date(master.start_time) : null;
  if (!start || Number.isNaN(start.getTime())) return [];
  const startDay = startOfDay(start);
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
  let emitted = 0;
  const consider = (d) => {
    if (untilDay && d > untilDay) return false;
    if (rule.count != null && emitted >= rule.count) return false;
    emitted += 1;
    if (d >= lo && d <= hi) {
      const k = dayKey(d);
      if (!exdates.has(k)) out.push(k);
    }
    return true;
  };
  const daysBetween = (a, b) => Math.round((b - a) / 86400000);

  if (rule.freq === "weekly") {
    const days = rule.byWeekday.length ? rule.byWeekday : [startDay.getDay()];
    let weekStart = addDays(startDay, -startDay.getDay());
    const blocks = lo > weekStart ? Math.floor(Math.floor(daysBetween(weekStart, lo) / 7) / rule.interval) : 0;
    if (blocks > 0) {
      const firstBlock = days.filter((wd) => addDays(weekStart, wd) >= startDay).length;
      emitted = firstBlock + (blocks - 1) * days.length;
      weekStart = addDays(weekStart, 7 * rule.interval * blocks);
    }
    while (out.length < MAX_OCCURRENCES && weekStart <= hi) {
      let alive = true;
      for (const wd of days) {
        const d = addDays(weekStart, wd);
        if (d < startDay) continue;
        if (!consider(d)) { alive = false; break; }
      }
      if (!alive) break;
      weekStart = addDays(weekStart, 7 * rule.interval);
    }
    return out;
  }

  const anchorDom = startDay.getDate();
  let d = startDay;
  if (rule.freq === "daily" && lo > startDay) {
    const steps = Math.ceil(daysBetween(startDay, lo) / rule.interval);
    emitted = steps;
    d = addDays(startDay, steps * rule.interval);
  }
  while (out.length < MAX_OCCURRENCES && d <= hi) {
    if (!consider(d)) break;
    if (rule.freq === "daily") d = addDays(d, rule.interval);
    else if (rule.freq === "monthly") d = addMonthsClamped(d, rule.interval, anchorDom);
    else d = addMonthsClamped(d, 12 * rule.interval, anchorDom);
  }
  return out;
}

function expandEvents(rows, from, to) {
  const out = [];
  for (const ev of Array.isArray(rows) ? rows : []) {
    if (!ev || !ev.start_time) continue;
    const start = new Date(ev.start_time);
    if (Number.isNaN(start.getTime())) continue;
    const days = occurrenceDays(ev, from, to);
    if (!days.length) continue;
    const end = ev.end_time ? new Date(ev.end_time) : null;
    const durationMs = end && !Number.isNaN(end.getTime()) ? Math.max(0, end - start) : null;
    for (const day of days) {
      const base = parseDayKey(day);
      if (!base) continue;
      const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), start.getHours(), start.getMinutes(), 0, 0);
      const e = durationMs == null ? null : new Date(s.getTime() + durationMs);
      out.push({ ...ev, occurrenceDay: day, start_time: s.toISOString(), end_time: e ? e.toISOString() : null });
    }
  }
  out.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  return out;
}

// What's still ahead in the next week, soonest first: a timed event until it
// ends (an hour, when it has no end), an all-day one until its last day is over.
// An event already under way is ahead of you in the sense that matters — you're
// meant to be at it.
function upcomingEvents(rows, now, max) {
  const today = startOfDay(now);
  const out = [];
  for (const e of expandEvents(rows || [], today, addDays(today, 7))) {
    const s = new Date(e.start_time);
    if (e.all_day) {
      const last = e.end_time ? startOfDay(new Date(e.end_time)) : startOfDay(s);
      if (last < today) continue;
    } else {
      const end = e.end_time ? new Date(e.end_time) : new Date(s.getTime() + 3600000);
      if (end <= now) continue;
    }
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

// "Today 2:00 PM", "Tomorrow · All day", "Fri 9:30 AM" — a week ahead at most,
// so a weekday is never ambiguous. Something that began before today and is
// still running is today's.
function eventWhen(e, now) {
  const s = new Date(e.start_time);
  const day = startOfDay(s);
  const today = startOfDay(now);
  const label = day <= today ? "Today"
    : day.getTime() === addDays(today, 1).getTime() ? "Tomorrow"
    : s.toLocaleDateString("en-US", { weekday: "short" });
  return e.all_day ? `${label} · All day` : `${label} ${fmtTime(s.getHours() * 60 + s.getMinutes())}`;
}

// ── drawing primitives ───────────────────────────────────────────────────────
function label(container, text, font, color, lines = 1) {
  const t = container.addText(text);
  t.font = font;
  t.textColor = color;
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.8;
  return t;
}

// The Plan tab marks a block's kind with a small diamond; so does this.
function diamond(container, color, size = 7) {
  try {
    const sym = SFSymbol.named("diamond.fill");
    sym.applyFont(Font.systemFont(size));
    const img = container.addImage(sym.image);
    img.imageSize = new Size(size, size);
    img.tintColor = color;
    return img;
  } catch {
    const d = container.addStack();
    d.size = new Size(size - 1, size - 1);
    d.cornerRadius = 1.5;
    d.backgroundColor = color;
    return d;
  }
}

function dot(container, color, size = 6) {
  const d = container.addStack();
  d.size = new Size(size, size);
  d.cornerRadius = size / 2;
  d.backgroundColor = color;
  return d;
}

// A note in the editor's list syntax reads as bullets, the way the notes widget
// draws it; runs of blank lines fold to one.
function displayBody(text) {
  const lines = String(text || "").split("\n").map((l) => l.replace(/^(\s*)[-*]\s+/, "$1• ").trimEnd());
  return lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim())).join("\n").trim();
}

function rule(container) {
  const r = container.addStack();
  r.size = new Size(0, 1);
  r.backgroundColor = C.line;
  r.addSpacer();
  return r;
}

// A progress bar that needs no idea how wide the widget is: SEGMENTS equally
// flexible cells side by side, so iOS divides the width evenly whatever the
// phone, and the filled ones take the block's color. With no gap between them
// and the track's corners rounded, it reads as one continuous bar.
const SEGMENTS = 40;
function progressBar(container, progress, color, height = 5) {
  const filled = Math.round(Math.max(0, Math.min(1, progress || 0)) * SEGMENTS);
  const bar = container.addStack();
  bar.size = new Size(0, height);
  bar.cornerRadius = height / 2;
  bar.backgroundColor = C.track;
  for (let i = 0; i < SEGMENTS; i++) {
    const cell = bar.addStack();
    cell.size = new Size(0, height);
    if (i < filled) cell.backgroundColor = color;
    cell.addSpacer();
  }
  return bar;
}

// A live countdown to `ms`. iOS redraws a timer every second by itself, so this
// is the part of the widget that moves between refreshes.
function countdown(container, ms, font, color, align = "left") {
  const d = container.addDate(new Date(ms));
  d.applyTimerStyle();
  d.font = font;
  d.textColor = color;
  d.lineLimit = 1;
  if (align === "right") d.rightAlignText();
  else if (align === "center") d.centerAlignText();
  else d.leftAlignText();
  return d;
}

const timerFont = (size) => Font.semiboldMonospacedSystemFont(size);

// "Next 7:30 AM", with "tomorrow" when it is.
const whenNext = (b) => `${b.tomorrow ? "Tmrw " : ""}${fmtTime(b.startMin)}`;

// ── pieces ───────────────────────────────────────────────────────────────────
// The header line of the "now" panel: ◆ NOW ……… until 7:30 AM
function nowHeader(container, cur, size = 10) {
  const h = container.addStack();
  h.centerAlignContent();
  diamond(h, kindColor(cur.kind), size - 2);
  h.addSpacer(5);
  label(h, "NOW", Font.semiboldSystemFont(size), kindColor(cur.kind));
  h.addSpacer();
  label(h, `until ${fmtTime(cur.endMin)}`, Font.mediumSystemFont(size - 1), C.faint);
  return h;
}

// The Plan tab's words, not a padlock: nothing here can stop a laptop opening.
// Medium has room for one word of it; large says the whole promise.
function protectedLine(container, cur, size = 10, short = false) {
  const r = container.addStack();
  r.centerAlignContent();
  diamond(r, kindColor(cur.kind), size - 3);
  r.addSpacer(5);
  label(r, short ? "Protected" : "Protected — nothing gets scheduled over this", Font.mediumSystemFont(size), C.sub);
}

// Before the first block, with nothing carried over from last night: say when the
// day starts rather than inventing a block to be in.
function beforeDay(container, where, size) {
  const nxt = where.next;
  const h = container.addStack();
  h.centerAlignContent();
  label(h, "BEFORE YOUR DAY", Font.semiboldSystemFont(10), C.accent);
  h.addSpacer();
  container.addSpacer(size === "small" ? 4 : 6);
  label(container, `Starts ${fmtTime(nxt.startMin)}`, Font.boldSystemFont(size === "small" ? 17 : 20), C.ink);
  container.addSpacer(2);
  const r = container.addStack();
  r.centerAlignContent();
  diamond(r, kindColor(nxt.kind), 7);
  r.addSpacer(5);
  label(r, nxt.title, Font.mediumSystemFont(size === "small" ? 12 : 13), C.sub, 2);
  container.addSpacer();
  const t = container.addStack();
  t.centerAlignContent();
  label(t, "in", Font.mediumSystemFont(11), C.faint);
  t.addSpacer(5);
  countdown(t, instantAt(NOW, nxt.startMin), timerFont(size === "small" ? 18 : 22), C.ink);
}

function emptyDay(container, where) {
  const kind = where.type === "weekend" ? "weekend" : "weekday";
  label(container, "TODAY'S PLAN", Font.semiboldSystemFont(10), C.accent);
  container.addSpacer(6);
  label(container, `No ${kind} plan yet.`, Font.semiboldSystemFont(15), C.ink, 2);
  container.addSpacer(3);
  label(container, "Set the day once on the Plan tab, and this keeps you to it.", Font.systemFont(11), C.faint, 3);
  container.addSpacer();
}

// ── layouts ──────────────────────────────────────────────────────────────────
function renderSmall(w, plan, where) {
  const cur = where.current;
  if (!cur) return where.next ? beforeDay(w, where, "small") : emptyDay(w, where);

  nowHeader(w, cur, 10);
  w.addSpacer(5);
  label(w, cur.title, Font.boldSystemFont(17), C.ink, 2);
  w.addSpacer();
  progressBar(w, where.progress, kindColor(cur.kind), 4);
  w.addSpacer(6);
  countdown(w, instantAt(NOW, cur.endMin), timerFont(18), C.ink);
  if (where.next) {
    w.addSpacer(3);
    const n = w.addStack();
    n.centerAlignContent();
    label(n, whenNext(where.next), Font.semiboldSystemFont(9), C.sub);
    n.addSpacer(4);
    diamond(n, kindColor(where.next.kind), 6);
    n.addSpacer(3);
    label(n, where.next.title, Font.systemFont(9), C.sub);
  }
}

// Medium: now on the left, filling the width it's given; next and then on the
// right, in a column of fixed width so the two sides never trade space.
function renderMedium(w, plan, where) {
  const cur = where.current;
  if (!cur) return where.next ? beforeDay(w, where, "medium") : emptyDay(w, where);

  const body = w.addStack();
  body.topAlignContent();

  const left = body.addStack();
  left.layoutVertically();
  nowHeader(left, cur, 10);
  left.addSpacer(5);
  label(left, cur.title, Font.boldSystemFont(19), C.ink, 2);
  if (cur.protected) {
    left.addSpacer(4);
    protectedLine(left, cur, 10, true);
  }
  left.addSpacer();
  progressBar(left, where.progress, kindColor(cur.kind), 5);
  left.addSpacer(7);
  const t = left.addStack();
  t.centerAlignContent();
  countdown(t, instantAt(NOW, cur.endMin), timerFont(22), C.ink);

  body.addSpacer(14);
  const div = body.addStack();
  div.size = new Size(1, 112);
  div.backgroundColor = C.line;
  body.addSpacer(12);

  const right = body.addStack();
  right.layoutVertically();
  right.size = new Size(104, 0);
  const run = dayRun(plan, NOW);
  const at = run.findIndex((b) => b.startMin === cur.startMin && b.title === cur.title);
  const upcoming = at >= 0 ? run.slice(at + 1, at + 3) : where.next ? [where.next] : [];
  upcoming.forEach((b, i) => {
    if (i) right.addSpacer(9);
    label(right, i === 0 ? "NEXT" : "THEN", Font.semiboldSystemFont(9), C.faint);
    right.addSpacer(2);
    label(right, whenNext(b), Font.semiboldSystemFont(i === 0 ? 14 : 12), i === 0 ? C.ink : C.sub);
    right.addSpacer(2);
    const r = right.addStack();
    r.centerAlignContent();
    diamond(r, kindColor(b.kind), 6);
    r.addSpacer(4);
    label(r, b.title, Font.systemFont(i === 0 ? 12 : 11), i === 0 ? C.sub : C.faint, i === 0 ? 2 : 1);
  });
  right.addSpacer();
}

// Large: a compact "now" — the block and its countdown on one line, the bar under
// them — then the day hour by hour from the current block, then a band: the next
// calendar events beside the note named in the widget's parameter. The panel is
// tighter than it was so the band fits under it on the smallest phone.
// No date line on top: the Lock Screen and the clock already say what day it is,
// and the NOW line is the thing to read first.
function renderLarge(w, plan, where, data) {
  const cur = where.current;
  const hasBand = Array.isArray(data.events) || !!data.events_error || "note" in data;

  if (cur) {
    // The countdown rides on the NOW line, where everything beside it is short,
    // so the block's name gets the full width below — sharing a line with the
    // timer, a long name like "Work — hardest thing first" squeezed it to "1…".
    const h = w.addStack();
    h.centerAlignContent();
    diamond(h, kindColor(cur.kind), 8);
    h.addSpacer(5);
    label(h, "NOW", Font.semiboldSystemFont(10), kindColor(cur.kind));
    h.addSpacer(6);
    label(h, `until ${fmtTime(cur.endMin)}`, Font.mediumSystemFont(9), C.faint);
    h.addSpacer(8);
    countdown(h, instantAt(NOW, cur.endMin), timerFont(17), C.ink, "right");
    w.addSpacer(2);
    label(w, cur.title, Font.boldSystemFont(21), C.ink, 1);
    w.addSpacer(7);
    progressBar(w, where.progress, kindColor(cur.kind), 5);
  } else if (where.next) {
    const h = w.addStack();
    h.centerAlignContent();
    label(h, "BEFORE YOUR DAY", Font.semiboldSystemFont(10), C.accent);
    h.addSpacer();
    label(h, `then ${where.next.title}`, Font.mediumSystemFont(9), C.faint);
    w.addSpacer(3);
    const t = w.addStack();
    t.centerAlignContent();
    label(t, `Starts ${fmtTime(where.next.startMin)}`, Font.boldSystemFont(21), C.ink, 1);
    t.addSpacer(10);
    countdown(t, instantAt(NOW, where.next.startMin), timerFont(21), C.ink, "right");
  } else {
    label(w, `No ${where.type} plan yet.`, Font.semiboldSystemFont(15), C.ink, 1);
    w.addSpacer(2);
    label(w, "Set the day once on the Plan tab, and this keeps you to it.", Font.systemFont(11), C.faint, 2);
  }

  if (cur || where.next) {
    w.addSpacer(10);
    rule(w);
    w.addSpacer(7);
    // The day gets whatever height is left once the now panel and the band have
    // theirs, so the widget is full on every phone and no day overflows it.
    const top = cur ? HT.nowPanel : HT.beforePanel;
    timeline(w, plan, where, largeRoom() - top - (hasBand ? bandHeight(data) : 0) - HT.margin);
  }

  w.addSpacer();
  if (hasBand) band(w, data);
}

// HEIGHTS, IN POINTS, of the large layout's pieces as they draw — measured off the
// rendered widget and checked against a phone's screenshot (the gap a Pro Max
// left above the band was the gap these predict). They let the day fill the
// height that's left instead of a fixed count of rows, which either left a gap
// or overflowed depending on the band: one event or two, a note of two lines or
// four, a "TOMORROW" or not. If the layout above changes, these change with it.
const HT = {
  nowPanel: 77, // NOW line, name, bar, and the rule under them
  beforePanel: 58, // "Starts 6:00 AM" and its countdown, and the rule
  row: 26, // a row of the day and the gap under it
  tomorrow: 13, // the TOMORROW label
  bandTop: 9, // the band's rule and the gap under it
  colHead: 16, // CALENDAR / the note's title, and the gap under it
  eventNarrow: 28, eventNarrowGap: 6, // "when" over "what", beside a note
  eventWide: 15, eventWideGap: 4, // one line each, on its own
  textLine: 14.4, // one line of 12-point text
  message: 27, // a two-line "Nothing in the next week." and its kin
  more: 13, // the "+N more" under a note
  divider: 66, // the rule between the two columns
  margin: 6, // what's kept in hand for a font that sets a little taller
};

// The large widget's height, less its padding. Scriptable can't ask a widget how
// tall it is, but the large size follows the screen's, so the screen picks from
// Apple's sizes. Anything unrecognized — an iPad, a phone not out yet — is given
// the smallest phone's, which only ever costs empty space, never clipped text.
function largeRoom() {
  let large = 324;
  try {
    if (!Device.isPad()) {
      const sz = Device.screenSize();
      const h = Math.max(sz.width, sz.height);
      large = h >= 926 ? 382 : h >= 896 ? 379 : h >= 844 ? 354 : h >= 812 ? 345 : h >= 736 ? 357 : h >= 667 ? 324 : 311;
    }
  } catch {}
  return large - 29; // setPadding(15, 15, 14, 15)
}

// What the band will draw, decided once so band() and bandHeight() can't disagree.
function bandPlan(data) {
  const hasCal = Array.isArray(data.events) || !!data.events_error;
  const hasNote = "note" in data;
  return { hasCal, hasNote, wide: !hasNote, calMax: hasNote ? 2 : 3, noteLines: hasCal ? 4 : 5 };
}

function bandHeight(data) {
  const bp = bandPlan(data);
  let cal = 0, note = 0;
  if (bp.hasCal) {
    const n = Array.isArray(data.events) ? upcomingEvents(data.events, NOW, bp.calMax).length : 0;
    cal = HT.colHead + (!n ? HT.message
      : bp.wide ? n * HT.eventWide + (n - 1) * HT.eventWideGap
      : n * HT.eventNarrow + (n - 1) * HT.eventNarrowGap);
  }
  if (bp.hasNote) {
    const n = data.note;
    if (!n) note = HT.colHead + HT.message;
    else {
      // Lines as they'll wrap: about 20 characters of 12-point text fit half the
      // width on the narrowest phone, 42 the whole of it.
      const per = bp.hasCal ? 20 : 42;
      const body = displayBody(n.body).split("\n");
      const visual = body.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / per)), 0);
      note = HT.colHead + Math.min(visual, bp.noteLines) * HT.textLine + (body.length > bp.noteLines ? HT.more : 0);
    }
  }
  return HT.bandTop + Math.max(cal, note, bp.hasCal && bp.hasNote ? HT.divider : 0);
}

// The day from the current block on (or from the first, before the day starts),
// running into tomorrow's morning once today runs out.
function timeline(w, plan, where, budget) {
  const cur = where.current;
  const run = dayRun(plan, NOW);
  const curAt = cur ? run.findIndex((b) => b.startMin === cur.startMin && b.title === cur.title) : -1;
  const nextAt = !cur && where.next ? run.findIndex((b) => b.startMin === where.next.startMin) : -1;
  const from = Math.max(0, curAt >= 0 ? curAt : nextAt);
  // Which rows fit, first; then draw them.
  const rows = [];
  let left = budget;
  let saidTomorrow = false;
  for (let i = from; i < run.length; i++) {
    const b = run[i];
    if (b.carried && i !== curAt) continue; // last night is only worth a row while it's still running
    // The TOMORROW label only ever arrives with a row under it.
    const withLabel = b.tomorrow && !saidTomorrow;
    const cost = HT.row + (withLabel ? HT.tomorrow : 0);
    if (cost > left) break;
    if (withLabel) saidTomorrow = true;
    rows.push({ b, withLabel, state: i === curAt ? "now" : "later" });
    left -= cost;
  }
  // What's left after the last whole row is less than a row. Spread it between
  // the rows (a few points each at most) so it doesn't sit as a strip of blank
  // space above the band.
  const ease = rows.length ? Math.min(4, Math.max(0, left) / rows.length) : 0;
  for (const r of rows) {
    if (r.withLabel) {
      label(w, "TOMORROW", Font.semiboldSystemFont(8), C.faint);
      w.addSpacer(3);
    }
    timelineRow(w, r.b, r.state);
    w.addSpacer(2 + ease);
  }
}

// The band under the day: Calendar | Note, each taking half the width — both
// columns hold rows with a flexible spacer, so iOS splits the width evenly — or
// the whole width when the widget has no note to show.
function band(w, data) {
  const bp = bandPlan(data);
  rule(w);
  w.addSpacer(8);
  const row = w.addStack();
  row.topAlignContent();
  if (bp.hasCal) calendarColumn(row, data, bp.calMax, bp.wide);
  if (bp.hasCal && bp.hasNote) {
    row.addSpacer(12);
    const div = row.addStack();
    div.size = new Size(1, HT.divider);
    div.backgroundColor = C.line;
    row.addSpacer(12);
  }
  if (bp.hasNote) noteColumn(row, data, bp.noteLines);
}

function columnHead(col, text, dotColor) {
  const h = col.addStack();
  h.centerAlignContent();
  if (dotColor) {
    dot(h, dotColor, 6);
    h.addSpacer(5);
  }
  label(h, text.toUpperCase(), Font.semiboldSystemFont(9), C.faint);
  h.addSpacer();
  col.addSpacer(5);
}

function calendarColumn(container, data, max, wide) {
  const col = container.addStack();
  col.layoutVertically();
  columnHead(col, "Calendar");
  if (!Array.isArray(data.events)) {
    label(col, "Couldn't read the calendar.", Font.systemFont(11), C.faint, 2);
    return;
  }
  const list = upcomingEvents(data.events, NOW, max);
  if (!list.length) label(col, "Nothing in the next week.", Font.systemFont(11), C.faint, 2);
  list.forEach((e, i) => {
    // Half the width: when over what. The whole width: one line each.
    if (wide) {
      if (i) col.addSpacer(4);
      const row = col.addStack();
      row.centerAlignContent();
      dot(row, catColor(e.category), 6);
      row.addSpacer(6);
      label(row, eventWhen(e, NOW), Font.semiboldSystemFont(10), C.sub);
      row.addSpacer(8);
      label(row, e.title || "(untitled)", Font.systemFont(12), C.ink, 1);
      row.addSpacer();
      return;
    }
    if (i) col.addSpacer(6);
    const when = col.addStack();
    when.centerAlignContent();
    dot(when, catColor(e.category), 6);
    when.addSpacer(5);
    label(when, eventWhen(e, NOW), Font.semiboldSystemFont(10), C.sub);
    when.addSpacer();
    col.addSpacer(1);
    label(col, e.title || "(untitled)", Font.systemFont(12), C.ink, 1);
  });
}

function noteColumn(container, data, lines) {
  const col = container.addStack();
  col.layoutVertically();
  const n = data.note;
  if (data.note_error && !n) {
    columnHead(col, PARAM || "Note");
    label(col, "Couldn't read your notes.", Font.systemFont(11), C.faint, 2);
    return;
  }
  if (!n) {
    columnHead(col, data.note_match || PARAM || "Note");
    label(col, "No note by that name yet.", Font.systemFont(11), C.faint, 2);
    return;
  }
  columnHead(col, n.title || "Note", sealDot(n.seal) || C.faint);
  const body = displayBody(n.body).split("\n");
  const shown = body.slice(0, lines);
  if (!shown.join("").trim()) label(col, "Nothing in it yet.", Font.systemFont(11), C.faint);
  else label(col, shown.join("\n"), Font.systemFont(12), C.ink, lines);
  if (body.length > lines) {
    col.addSpacer(2);
    label(col, `+${body.length - lines} more`, Font.mediumSystemFont(9), C.faint);
  }
}

function timelineRow(container, b, state) {
  const row = container.addStack();
  row.centerAlignContent();
  row.setPadding(4, 6, 4, 8);
  row.cornerRadius = 7;
  if (state === "now") row.backgroundColor = kindColor(b.kind, 0.13);

  const time = row.addStack();
  time.size = new Size(58, 0);
  label(time, fmtTime(b.startMin), Font.mediumSystemFont(11), state === "past" ? C.faint : C.sub);
  time.addSpacer();

  diamond(row, state === "past" ? C.faint : kindColor(b.kind), 7);
  row.addSpacer(7);
  label(row, b.title, state === "now" ? Font.semiboldSystemFont(13) : Font.systemFont(13),
    state === "past" ? C.faint : C.ink);
  row.addSpacer();
  if (state === "now") label(row, "now", Font.semiboldSystemFont(10), kindColor(b.kind));
  else if (b.endMin > b.startMin) label(row, fmtDur(b.endMin - b.startMin), Font.mediumSystemFont(10), C.faint);
  return row;
}

// ── Lock Screen ──────────────────────────────────────────────────────────────
function renderAccessoryRectangular(w, plan, where) {
  const cur = where.current;
  if (!cur) {
    label(w, where.next ? `Day starts ${fmtTime(where.next.startMin)}` : "No plan for today", Font.semiboldSystemFont(14), Color.white());
    if (where.next) label(w, where.next.title, Font.systemFont(12), Color.white());
    return;
  }
  label(w, cur.title, Font.semiboldSystemFont(14), Color.white());
  const t = w.addStack();
  t.centerAlignContent();
  label(t, `until ${fmtTime(cur.endMin)}`, Font.systemFont(12), Color.white());
  t.addSpacer(6);
  countdown(t, instantAt(NOW, cur.endMin), Font.mediumMonospacedSystemFont(12), Color.white(), "right");
  if (where.next) label(w, `Next · ${where.next.title}`, Font.systemFont(12), Color.white());
}

function renderAccessoryCircular(w, plan, where) {
  const b = where.current || where.next;
  const s = w.addStack();
  s.layoutVertically();
  s.centerAlignContent();
  const top = s.addStack();
  top.addSpacer();
  try {
    const sym = SFSymbol.named(KIND_SYMBOL[kindKey(b ? b.kind : "life")]);
    sym.applyFont(Font.systemFont(16));
    const img = top.addImage(sym.image);
    img.imageSize = new Size(18, 18);
    img.tintColor = Color.white();
  } catch {
    label(top, "◆", Font.systemFont(14), Color.white());
  }
  top.addSpacer();
  s.addSpacer(2);
  // A timer takes the whole width it's given and aligns inside it, so it is
  // centered by its own alignment — spacers either side would squeeze it.
  const bottom = s.addStack();
  if (b) countdown(bottom, instantAt(NOW, where.current ? where.current.endMin : where.next.startMin), Font.mediumMonospacedSystemFont(11), Color.white(), "center");
  else { bottom.addSpacer(); label(bottom, "—", Font.systemFont(11), Color.white()); bottom.addSpacer(); }
}

function renderAccessoryInline(w, plan, where) {
  const cur = where.current;
  const text = cur ? `${cur.title} · until ${fmtTime(cur.endMin)}`
    : where.next ? `Day starts ${fmtTime(where.next.startMin)}` : "No plan for today";
  label(w, text, Font.systemFont(13), Color.white());
}

function renderError(w, message, family) {
  const small = family === "small" || String(family).startsWith("accessory");
  label(w, "BOARD ROOM", Font.semiboldSystemFont(10), C.accent);
  w.addSpacer(6);
  label(w, "Plan unavailable", Font.semiboldSystemFont(small ? 13 : 15), C.ink);
  w.addSpacer(4);
  label(w, message, Font.systemFont(small ? 10 : 12), C.sub, 4);
  w.addSpacer();
}

// ── assembly ─────────────────────────────────────────────────────────────────
const NOW = new Date();

function buildWidget(result, family) {
  const w = new ListWidget();
  const isAccessory = String(family).startsWith("accessory");
  if (isAccessory) {
    w.setPadding(2, 2, 2, 2);
    if (family === "accessoryCircular") {
      try { w.addAccessoryWidgetBackground = true; } catch {}
    }
  } else {
    w.setPadding(15, 15, 14, 15);
    const g = new LinearGradient();
    g.colors = [C.surface, C.bg];
    g.locations = [0, 1];
    g.startPoint = new Point(0, 0);
    g.endPoint = new Point(0.6, 1);
    w.backgroundGradient = g;
  }
  w.url = `${SITE}/?plan`;

  if (!result.data) {
    if (isAccessory) label(w, "Plan unavailable", Font.systemFont(12), Color.white());
    else renderError(w, result.error, family);
    w.refreshAfterDate = new Date(Date.now() + 10 * 60000);
    return w;
  }

  const plan = normalizePlan(result.data.plan);
  const where = whereAmI(plan, NOW);

  switch (family) {
    case "accessoryInline": renderAccessoryInline(w, plan, where); break;
    case "accessoryCircular": renderAccessoryCircular(w, plan, where); break;
    case "accessoryRectangular": renderAccessoryRectangular(w, plan, where); break;
    case "small": renderSmall(w, plan, where); break;
    case "large":
    case "extraLarge": renderLarge(w, plan, where, result.data); break;
    default: renderMedium(w, plan, where); break;
  }

  // A week-old cache is still the plan, so it's only marked once it's a day old.
  if (result.stale && !isAccessory && Date.now() - result.cachedAt > 86400000) {
    const at = new Date(result.cachedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    label(w, `plan from ${at}`, Font.systemFont(8), C.faint);
  }

  // Redraw the moment the next block starts — a second after, so the clock has
  // definitely crossed it — and every REFRESH_MINUTES before that.
  const boundary = where.current ? instantAt(NOW, where.current.endMin)
    : where.next ? instantAt(NOW, where.next.startMin) : null;
  let at = Date.now() + REFRESH_MINUTES * 60000;
  if (boundary && boundary > Date.now()) at = Math.min(at, boundary + 1000);
  w.refreshAfterDate = new Date(at);
  return w;
}

// ── run ──────────────────────────────────────────────────────────────────────
const result = await load();
const family = config.widgetFamily || PREVIEW;
const widget = buildWidget(result, family);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else if (family === "small") {
  await widget.presentSmall();
} else if (family === "large" || family === "extraLarge") {
  await widget.presentLarge();
} else {
  await widget.presentMedium();
}
Script.complete();
