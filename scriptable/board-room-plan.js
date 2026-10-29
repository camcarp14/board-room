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
//   large / XL       now, then the day hour by hour
//   Lock Screen      inline / circular / rectangular
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
const fm = FileManager.local();
const CACHE_PATH = fm.joinPath(fm.cacheDirectory(), "board-room-plan.json");

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

async function fetchPlan(token) {
  const req = new Request(`${SITE}/.netlify/functions/trmnl?view=plan&token=${encodeURIComponent(token)}`);
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

// Large: the now panel, then the day hour by hour — past blocks quiet, the
// current one on its own colored wash, and tomorrow's morning once today runs out.
function renderLarge(w, plan, where, rows) {
  const cur = where.current;
  const head = w.addStack();
  head.centerAlignContent();
  label(head, `TODAY · ${where.type === "weekend" ? "WEEKEND" : "WEEKDAY"}`, Font.semiboldSystemFont(10), C.accent);
  head.addSpacer();
  label(head, NOW.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }), Font.mediumSystemFont(10), C.faint);
  w.addSpacer(10);

  if (!cur) {
    if (!where.next) return emptyDay(w, where);
    const panel = w.addStack();
    panel.layoutVertically();
    beforeDay(panel, where, "large");
    w.addSpacer(12);
  } else {
    nowHeader(w, cur, 11);
    w.addSpacer(5);
    label(w, cur.title, Font.boldSystemFont(22), C.ink, 2);
    if (cur.note) {
      w.addSpacer(3);
      label(w, cur.note, Font.systemFont(12), C.sub, 2);
    } else if (cur.protected) {
      w.addSpacer(4);
      protectedLine(w, cur, 10);
    }
    w.addSpacer(10);
    progressBar(w, where.progress, kindColor(cur.kind), 5);
    w.addSpacer(7);
    const t = w.addStack();
    t.centerAlignContent();
    countdown(t, instantAt(NOW, cur.endMin), timerFont(24), C.ink);
    w.addSpacer(12);
  }

  rule(w);
  w.addSpacer(8);

  const run = dayRun(plan, NOW);
  const curAt = cur ? run.findIndex((b) => b.startMin === cur.startMin && b.title === cur.title) : -1;
  const nextAt = !cur && where.next ? run.findIndex((b) => b.startMin === where.next.startMin) : -1;
  const from = Math.max(0, (curAt >= 0 ? curAt : nextAt) - 1);
  let used = 0;
  let saidTomorrow = false;
  for (let i = from; i < run.length && used < rows; i++) {
    const b = run[i];
    if (b.carried && i !== curAt) continue; // last night is only worth a row while it's still running
    if (b.tomorrow && !saidTomorrow) {
      if (used >= rows - 1) break;
      saidTomorrow = true;
      label(w, "TOMORROW", Font.semiboldSystemFont(8), C.faint);
      w.addSpacer(3);
      used += 0.5;
    }
    timelineRow(w, b, i === curAt ? "now" : i < curAt || (curAt < 0 && i < nextAt) ? "past" : "later");
    w.addSpacer(2);
    used++;
  }
  w.addSpacer();
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
    // Six rows of the day, or five when the current block's note takes two
    // lines above them — what fits the smallest phone's large widget.
    case "large":
    case "extraLarge": renderLarge(w, plan, where, where.current && where.current.note ? 5 : 6); break;
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
