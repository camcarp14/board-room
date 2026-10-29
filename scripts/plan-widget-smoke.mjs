// ─── Plan widget smoke — the Home Screen agrees with the Plan tab ────────────
//
// scriptable/board-room-plan.js keeps the Daily Plan on the Home Screen. It gets
// the templates from trmnl.js?view=plan and then works out where the day is on
// the phone, with its own copy of planLogic.js — it has to, to redraw at a
// block's start without the network. So the failure that matters is quiet: the
// widget and the Plan tab disagreeing about which block you're in, or when it
// ends, or what comes next. Each would look fine on its own.
//
// So the widget is RUN, under scripts/scriptable-mock.mjs with its clock frozen,
// every ten minutes from a Friday morning to the Monday after — weekday into
// weekend and back, the hours before the first block, and the night the clocks
// go back — and at each instant what it draws is held to whereAmI() from the
// app's own planLogic.js: the block, its end, the countdown's target, what's
// next, and when it asks iOS to redraw.
//
// TZ is pinned to America/Chicago, the zone the plan is lived in, so "the night
// the clocks change" is a real one: Sunday Nov 1 2026, 2am.
//
// Bare Node plus esbuild. Run by `npm run verify`.

process.env.TZ = "America/Chicago";

import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import esbuild from "esbuild";
import { whereAmI, normalizePlan, fmtTime, STARTER } from "../src/features/plan/planLogic.js";
import { expandEvents } from "../src/lib/recurrence.js";
import { runWidget, texts, dates, urls } from "./scriptable-mock.mjs";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const read = (p) => readFileSync(p, "utf8");
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check("the clock is Chicago's (the DST checks below depend on it)",
  new Date(2026, 6, 1).getTimezoneOffset() === 300 && new Date(2026, 11, 1).getTimezoneOffset() === 360);

// ─── bundle trmnl.js with Supabase replaced by a recorder ────────────────────
const DIR = ".plan-widget-smoke";
const FAKE_SUPABASE = `
const st = () => globalThis.__fakeSupabase;
exports.createClient = () => ({
  from(table) {
    const q = { table, ops: [] };
    const b = {};
    for (const op of ["select", "eq", "is", "not", "in", "order", "limit", "maybeSingle"]) {
      b[op] = (...a) => { q.ops.push([op, ...a]); return b; };
    }
    b.then = (ok, bad) => { st().queries.push(q); return Promise.resolve(st().answer(q)).then(ok, bad); };
    return b;
  },
});
`;
let fn = null;
try {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/fake-supabase.cjs`, FAKE_SUPABASE);
  esbuild.buildSync({
    entryPoints: ["netlify/functions/trmnl.js"], bundle: true, platform: "node", format: "cjs",
    outfile: `${DIR}/trmnl.cjs`, alias: { "@supabase/supabase-js": `./${DIR}/fake-supabase.cjs` }, logLevel: "silent",
  });
  fn = createRequire(import.meta.url)(resolve(`${DIR}/trmnl.cjs`));
} catch (e) {
  check("trmnl.js bundles for execution", false, (e.message || String(e)).split("\n")[0]);
} finally {
  rmSync(DIR, { recursive: true, force: true });
}
check("trmnl.js exports the plan pieces for this smoke", ["renderPlan", "loadPlan", "planEventsWindow", "handler"].every((k) => typeof fn?.[k] === "function"));
if (!fn) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}

// ─── 1. the feed ─────────────────────────────────────────────────────────────
const UID = "00000000-0000-4000-8000-000000000001";
const ROW = { setting_value: STARTER, updated_at: "2026-10-20T12:00:00Z" };
const ENV = { TRMNL_TOKEN: "smoke-trmnl-token-0123456789", SUPABASE_URL: "https://smoke.invalid", SUPABASE_SERVICE_ROLE_KEY: "smoke-service", BOARD_USER_ID: UID };
const ENV_KEYS = [...Object.keys(ENV), "TRMNL_USER_ID", "MINER_USER_ID"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of ENV_KEYS) delete process.env[k];
Object.assign(process.env, ENV);
const has = (q, ...op) => q.ops.some((o) => same(o, op));
const call = async (qs, answer) => {
  globalThis.__fakeSupabase = { queries: [], answer };
  const res = await fn.handler({ httpMethod: "GET", queryStringParameters: qs, headers: {} });
  let body = null;
  try { body = JSON.parse(res.body); } catch {}
  return { res, body, queries: globalThis.__fakeSupabase.queries };
};
// Each table answers for itself: the plan row, two calendar rows (one a series
// begun long ago, one a one-off a year back that the window must drop), and
// the note rows the notes widget's matcher picks from.
const EV_SERIES = { id: "s", title: "Standup", start_time: "2025-01-06T15:00:00Z", end_time: "2025-01-06T15:15:00Z", all_day: false, category: "work", rrule: { freq: "weekly", byWeekday: [1, 3, 5] }, exdates: [], notes: "private", location: "Room 4" };
const EV_OLD = { id: "o", title: "Long gone", start_time: "2025-10-01T15:00:00Z", end_time: null, all_day: false, category: "personal", rrule: null, exdates: null };
const NOTE_ROWS = [{ id: "n1", title: "Development", body: "- Gym/Body/Nutrition\n- Career/Experience", color: "red", pinned: false, updated_at: "2026-10-28T12:00:00Z" }];
const tables = (over = {}) => (q) => {
  if (q.table in over) return over[q.table](q);
  if (q.table === "app_settings") return has(q, "eq", "setting_key", "notes_order") ? { data: null, error: null } : { data: ROW, error: null };
  if (q.table === "personal_events") return { data: [EV_SERIES, EV_OLD], error: null };
  if (q.table === "personal_notes") return { data: NOTE_ROWS, error: null };
  return { data: null, error: { message: `unexpected table ${q.table}` } };
};
try {
  {
    const { res, queries } = await call({ view: "plan" }, tables());
    check("the plan view refuses a caller with no token, before any read", res.statusCode === 401 && queries.length === 0);
  }
  {
    const { res, body, queries } = await call({ view: "plan", token: ENV.TRMNL_TOKEN }, tables());
    check("with the token it answers the stored templates, as stored", res.statusCode === 200 && same(body?.plan, STARTER) && body?.updated_at === ROW.updated_at);
    const settings = queries.find((q) => q.table === "app_settings");
    const events = queries.find((q) => q.table === "personal_events");
    check("…reading the owner's daily_plan setting and calendar, and no notes when none is asked for",
      queries.length === 2 && has(settings, "eq", "setting_key", "daily_plan") && has(settings, "eq", "user_id", UID)
      && !!events && has(events, "eq", "user_id", UID) && !queries.some((q) => q.table === "personal_notes"));
    check("…sending every series however old, and dropping the one-off a year back",
      same(body?.events?.map((e) => e.id), ["s"]) && !("note" in (body || {})));
    check("…with the fields the widget draws and nothing else (no event notes, no locations)",
      same(Object.keys(body?.events?.[0] || {}).sort(), ["all_day", "category", "end_time", "exdates", "id", "rrule", "start_time", "title"]));
    check("…never cached", /no-store/.test(res.headers?.["Cache-Control"] || ""));
  }
  {
    const { body, queries } = await call({ view: "plan", token: ENV.TRMNL_TOKEN, note: "development" }, tables());
    check("&note= adds that note, matched the way the notes widget matches",
      body?.note?.id === "n1" && body?.note_match === "development" && queries.some((q) => q.table === "personal_notes"));
    const none = await call({ view: "plan", token: ENV.TRMNL_TOKEN, note: "Nope" }, tables());
    check("…and a name with no note is note: null — asked for, not found", "note" in (none.body || {}) && none.body.note === null && none.body.note_match === "Nope");
  }
  {
    const { res, body } = await call({ view: "plan", token: ENV.TRMNL_TOKEN, note: "Development" },
      tables({ personal_events: () => ({ data: null, error: { message: "calendar down" } }), personal_notes: () => ({ data: null, error: { code: "XX000", message: "notes down" } }) }));
    check("a calendar or notes failure is reported in the answer, and the plan still arrives",
      res.statusCode === 200 && same(body?.plan, STARTER) && body?.events === null && /calendar down/.test(body?.events_error || "")
      && body?.note === null && /notes down/.test(body?.note_error || ""));
  }
  {
    const { res, body } = await call({ view: "plan", token: ENV.TRMNL_TOKEN }, tables({ app_settings: () => ({ data: null, error: null }) }));
    check("no plan saved is plan: null, not an error", res.statusCode === 200 && body?.plan === null);
  }
  {
    const { res, body } = await call({ view: "plan", token: ENV.TRMNL_TOKEN }, tables({ app_settings: () => ({ data: null, error: { message: "db down" } }) }));
    check("a failed PLAN read is a 502 saying why — not 'no plan yet'", res.statusCode === 502 && /db down/.test(body?.error || ""));
  }
  {
    const NOW = Date.parse("2026-10-28T15:00:00Z");
    const day = 86400000;
    const rows = [
      { id: "series", start_time: "2020-01-01T15:00:00Z", rrule: { freq: "yearly" } },
      { id: "today", start_time: new Date(NOW + 3600000).toISOString() },
      { id: "endsInWindow", start_time: new Date(NOW - 10 * day).toISOString(), end_time: new Date(NOW - day).toISOString() },
      { id: "endedBefore", start_time: new Date(NOW - 10 * day).toISOString(), end_time: new Date(NOW - 3 * day).toISOString() },
      { id: "twoWeeks", start_time: new Date(NOW + 15 * day).toISOString() },
      { id: "tooFar", start_time: new Date(NOW + 17 * day).toISOString() },
      { id: "noStart" },
    ];
    check("the window: every series, and one-offs touching two days back to sixteen ahead",
      same(fn.planEventsWindow(rows, NOW).map((e) => e.id), ["series", "today", "endsInWindow", "twoWeeks"]));
  }
} finally {
  for (const k of ENV_KEYS) { if (savedEnv[k] == null) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  delete globalThis.__fakeSupabase;
}

// ─── 2. the widget, against the Plan tab, all weekend long ───────────────────
const WIDGET = "scriptable/board-room-plan.js";
const SITE = "https://board-room.netlify.app";
const KEY = "boardroom.trmnl.token";
const TOKEN = "phone-token-0123456789";
const feed = (plan, extra = {}) => (url) => {
  const u = new URL(url);
  if (u.searchParams.get("token") !== TOKEN) return { success: false, error: "Missing or incorrect token." };
  return fn.renderPlan({ plan, updated_at: null, ...extra });
};
const run = (plan, now, extra = {}) => runWidget(WIDGET, { family: "small", now, keychain: { [KEY]: TOKEN }, respond: feed(plan), ...extra });
// The instant a minute-of-day lands on from `t`'s local midnight — planLogic's
// own construction, so a mismatch here is the widget's, not the smoke's.
const instantAt = (t, mins) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, mins).getTime(); };

async function sweep(name, plan, from, to, stepMin = 10) {
  let bad = "", n = 0;
  for (let t = from; t <= to && !bad; t += stepMin * 60000) {
    n++;
    const where = whereAmI(plan, new Date(t));
    const r = await run(plan, t);
    const txt = texts(r.widget);
    const timer = dates(r.widget)[0];
    const at = new Date(t).toString().slice(0, 21);
    const refresh = r.widget.refreshAfterDate?.getTime();
    if (where.current) {
      const end = instantAt(t, where.current.endMin);
      if (!txt.includes(where.current.title)) bad = `${at}: expected now = "${where.current.title}", drew ${JSON.stringify(txt)}`;
      else if (!txt.includes(`until ${fmtTime(where.current.endMin)}`)) bad = `${at}: expected "until ${fmtTime(where.current.endMin)}"`;
      else if (!timer || timer.style !== "timer" || timer.date.getTime() !== end) bad = `${at}: countdown aims at ${timer && new Date(timer.date).toString().slice(0, 21)}, not the block's end`;
      else if (!(refresh > t && refresh <= Math.min(t + 15 * 60000, end + 1000))) bad = `${at}: asks to redraw at ${new Date(refresh).toString().slice(0, 24)}, not by the block's end (${new Date(end).toString().slice(0, 21)})`;
      else if (where.next && !txt.includes(where.next.title)) bad = `${at}: next should be "${where.next.title}"`;
    } else if (where.next) {
      if (!txt.includes(`Starts ${fmtTime(where.next.startMin)}`)) bad = `${at}: expected "Starts ${fmtTime(where.next.startMin)}", drew ${JSON.stringify(txt)}`;
    } else if (!txt.some((s) => /^No (weekday|weekend) plan yet\.$/.test(s))) {
      bad = `${at}: expected the empty state, drew ${JSON.stringify(txt)}`;
    }
  }
  check(`${name} (${n} instants)`, !bad, bad);
}

// Fri Oct 30 2026 00:00 → Mon Nov 2 2026 09:00, local. Sunday Nov 1 is the night
// the clocks go back, so Saturday's Sleep runs nine and a half wall-hours, not
// eight and a half, and its countdown has to say so.
const FROM = new Date(2026, 9, 30, 0, 0).getTime();
const TO = new Date(2026, 10, 2, 9, 0).getTime();
await sweep("the widget is in the block the Plan tab says, ends it when the tab says, and counts down to it — Friday to Monday", STARTER, FROM, TO);

// A plan as a hand edit in the SQL editor might leave it: blocks with no start or
// no title, a kind from the future, a duplicated id, out of order, a start with
// seconds. normalizePlan decides what survives; the widget's copy has to agree.
const JUNK = {
  weekday: {
    blocks: [
      { id: "z", start: "21:00", title: "Late", kind: "rest" },
      { id: "a", start: "07:00:00", title: "Up", kind: "telepathy" },
      { id: "bad", start: "25:00", title: "Never" },
      { id: "untitled", start: "09:00", title: "   " },
      { id: "a", start: "08:00", title: "Duplicate id — dropped" },
      { start: "12:00", title: "No id" },
      "a string",
      null,
    ],
  },
  weekend: "not an object",
};
await sweep("…and agrees on a hand-edited plan, about what survives normalizing", JUNK, new Date(2026, 9, 30, 0, 0).getTime(), new Date(2026, 10, 2, 9, 0).getTime(), 30);
// Late, Up (its seconds dropped) and the block with no id survive; the 25:00
// start, the blank title, the duplicated id, the string and the null do not.
check("…which is not nothing (the sweep above saw real blocks)",
  same(normalizePlan(JUNK).weekday.blocks.map((b) => b.title), ["Up", "No id", "Late"]));

// Only a weekday plan: Monday before the first block has no Sunday night to carry.
await sweep("with no weekend plan, the weekend is the empty state and Monday starts fresh",
  { weekday: STARTER.weekday }, new Date(2026, 9, 31, 12, 0).getTime(), new Date(2026, 10, 2, 7, 0).getTime(), 30);
await sweep("no plan saved at all is the empty state, all day", null, new Date(2026, 9, 29, 0, 0).getTime(), new Date(2026, 9, 29, 23, 50).getTime(), 60);

// ─── 3. what it draws ────────────────────────────────────────────────────────
{
  // 6:52:30 is halfway through Workout (6:15–7:30).
  const t = new Date(2026, 9, 29, 6, 52, 30).getTime();
  const r = await run(STARTER, t);
  const nodes = (n) => (n ? [n, ...(n.children || []).flatMap(nodes)] : []);
  const bar = nodes(r.widget).find((x) => x.kind === "stack" && x.children.length === 40 && x.children.every((c) => c.kind === "stack"));
  const filled = bar ? bar.children.filter((c) => c.backgroundColor).length : -1;
  check("the progress bar is half full halfway through the block", filled === 20, String(filled));
  check("…and its cells are equally flexible, so it spans any phone's width",
    !!bar && bar.children.every((c) => c.children.some((s) => s.kind === "spacer" && s.length == null)));
}
{
  const t = new Date(2026, 9, 29, 10, 0).getTime(); // Thursday, first work block
  const m = await runWidget(WIDGET, { family: "medium", now: t, keychain: { [KEY]: TOKEN }, respond: feed(STARTER) });
  const txt = texts(m.widget);
  check("medium shows now, then NEXT and THEN in order",
    txt.includes("Work — hardest thing first") && txt.includes("NEXT") && txt.includes("12:00 PM") && txt.includes("Lunch, step outside")
    && txt.includes("THEN") && txt.includes("1:00 PM") && txt.indexOf("NEXT") < txt.indexOf("THEN"));
  const l = await runWidget(WIDGET, { family: "large", now: t, keychain: { [KEY]: TOKEN }, respond: feed(STARTER) });
  const lt = texts(l.widget);
  check("large lists the day hour by hour from the current block, which it marks",
    ["8:30 AM", "12:00 PM", "1:00 PM", "5:30 PM"].every((s) => lt.includes(s)) && !lt.includes("7:30 AM") && lt.includes("now"));
  const eve = await runWidget(WIDGET, { family: "large", now: new Date(2026, 9, 29, 21, 0).getTime(), keychain: { [KEY]: TOKEN }, respond: feed(STARTER) });
  check("…and once today runs out, carries on into tomorrow's morning",
    texts(eve.widget).includes("TOMORROW") && texts(eve.widget).includes("Up — phone stays down"));
}
{
  const t = new Date(2026, 9, 29, 6, 30).getTime();
  const rect = await runWidget(WIDGET, { family: "accessoryRectangular", now: t, keychain: { [KEY]: TOKEN }, respond: feed(STARTER) });
  check("the Lock Screen rectangle says the block, its end, a live countdown, and what's next",
    texts(rect.widget).includes("Workout") && texts(rect.widget).includes("until 7:30 AM") && dates(rect.widget)[0]?.style === "timer"
    && texts(rect.widget).includes("Next · Shower, breakfast"));
  const inline = await runWidget(WIDGET, { family: "accessoryInline", now: t, keychain: { [KEY]: TOKEN }, respond: feed(STARTER) });
  check("…and the inline one in a line", texts(inline.widget).includes("Workout · until 7:30 AM"));
}
{
  let crashed = "";
  const FAMILIES = ["small", "medium", "large", "extraLarge", "accessoryRectangular", "accessoryInline", "accessoryCircular"];
  const CASES = [
    ["mid-block", STARTER, new Date(2026, 9, 29, 14, 0).getTime()],
    ["carried night", STARTER, new Date(2026, 9, 29, 3, 0).getTime()],
    ["before the day", { weekday: STARTER.weekday }, new Date(2026, 10, 2, 5, 0).getTime()],
    ["empty", null, new Date(2026, 9, 29, 14, 0).getTime()],
    ["late evening", STARTER, new Date(2026, 9, 29, 23, 59).getTime()],
  ];
  for (const family of FAMILIES) for (const [name, plan, t] of CASES) {
    try {
      const r = await runWidget(WIDGET, { family, now: t, keychain: { [KEY]: TOKEN }, respond: feed(plan) });
      if (!r.widget || !r.completed || !(texts(r.widget).length + dates(r.widget).length)) crashed ||= `${family}/${name}: drew nothing`;
      if (r.widget?.url !== `${SITE}/?plan`) crashed ||= `${family}/${name}: tap goes to ${r.widget?.url}`;
    } catch (e) {
      crashed ||= `${family}/${name}: ${e.message}`;
    }
  }
  check(`it builds at every size (${FAMILIES.length}) in every state of the day (${CASES.length}), and a tap opens the Plan tab`, !crashed, crashed);
}

// ─── 3b. the band: the calendar, held to recurrence.js; and the note ─────────
// The rows below cover every rule shape the Calendar tab writes, placed around
// the night the clocks go back. The widget expands them itself; what it lists
// is held to expandEvents() from src/lib/recurrence.js, the Calendar tab's own
// expansion, every four hours for two weeks.
const L = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString(); // local wall time → stored ISO
const CAL = [
  { id: "c1", title: "Standup", start_time: L(2025, 1, 6, 9), end_time: L(2025, 1, 6, 9, 15), all_day: false, category: "work",
    rrule: { freq: "weekly", byWeekday: [1, 3, 5] }, exdates: ["2026-10-30", "2026-11-04"] },
  { id: "c2", title: "Rent", start_time: L(2026, 1, 31), end_time: null, all_day: true, category: "bills", rrule: { freq: "monthly" }, exdates: [] },
  { id: "c3", title: "Pills", start_time: L(2026, 10, 27, 8), end_time: null, all_day: false, category: "health", rrule: { freq: "daily", count: 5 }, exdates: [] },
  { id: "c4", title: "Book club", start_time: L(2026, 10, 1, 19), end_time: L(2026, 10, 1, 20, 30), all_day: false, category: "personal",
    rrule: { freq: "weekly", interval: 2, until: "2026-11-20" }, exdates: [] },
  { id: "c5", title: "Trip", start_time: L(2026, 10, 29), end_time: L(2026, 11, 1), all_day: true, category: "personal", rrule: null, exdates: [] },
  { id: "c6", title: "Dentist", start_time: L(2026, 10, 30, 14), end_time: L(2026, 10, 30, 15), all_day: false, category: "health", rrule: null, exdates: [] },
  { id: "c7", title: "Old thing", start_time: L(2026, 10, 1, 10), end_time: null, all_day: false, category: "personal", rrule: null, exdates: [] },
  { id: "c8", title: "Late call", start_time: L(2026, 11, 2, 20), end_time: null, all_day: false, category: "work", rrule: null, exdates: [] },
  { id: "c9", title: "Anniversary dinner", start_time: L(2020, 11, 3, 18), end_time: L(2020, 11, 3, 20), all_day: false, category: "personal", rrule: { freq: "yearly" }, exdates: [] },
];
const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// What the band should list: recurrence.js's occurrences for the next week, less
// what's over — a timed event once it ends (an hour if it has no end), an
// all-day one once its last day has passed.
function wantUpcoming(rows, now, max) {
  const today = sod(now);
  return expandEvents(rows, today, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)).filter((e) => {
    const s = new Date(e.start_time);
    if (e.all_day) return (e.end_time ? sod(new Date(e.end_time)) : sod(s)) >= today;
    return (e.end_time ? new Date(e.end_time) : new Date(s.getTime() + 3600000)) > now;
  }).slice(0, max);
}
function wantWhen(e, now) {
  const s = new Date(e.start_time), today = sod(now), day = sod(s);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const label = day <= today ? "Today" : day.getTime() === tomorrow.getTime() ? "Tomorrow" : s.toLocaleDateString("en-US", { weekday: "short" });
  return e.all_day ? `${label} · All day` : `${label} ${fmtTime(s.getHours() * 60 + s.getMinutes())}`;
}
{
  let bad = "", n = 0;
  for (let t = new Date(2026, 9, 26, 6, 0).getTime(); t <= new Date(2026, 10, 25, 6, 0).getTime() && !bad; t += 4 * 3600000) {
    n++;
    const r = await runWidget(WIDGET, { family: "large", now: t, keychain: { [KEY]: TOKEN }, respond: feed(STARTER, { events: CAL }) });
    const txt = texts(r.widget);
    const at = txt.indexOf("CALENDAR");
    const want = wantUpcoming(CAL, new Date(t), 3).flatMap((e) => [wantWhen(e, new Date(t)), e.title]);
    const got = at < 0 ? null : txt.slice(at + 1, at + 1 + Math.max(want.length, 1));
    if (!want.length ? !(got && got[0] === "Nothing in the next week.") : !same(got, want)) {
      bad = `${new Date(t).toString().slice(0, 21)}: listed ${JSON.stringify(got)}, recurrence.js says ${JSON.stringify(want)}`;
    }
  }
  check(`the band lists the calendar's next three exactly as recurrence.js expands it — every rule shape, a month of instants, through the clock change and a 30-day month (${n} instants)`, !bad, bad);
}
{
  const t = new Date(2026, 9, 28, 20, 20).getTime(); // Wed evening, as in the screenshot
  const r = await runWidget(WIDGET, { family: "large", now: t, param: "Development", keychain: { [KEY]: TOKEN },
    respond: feed(STARTER, { events: CAL, note: { id: "n1", title: "Development", body: "- Gym/Body/Nutrition\n- Career/Experience", seal: "red" }, noteMatch: "Development" }) });
  const txt = texts(r.widget);
  check("with a note named in the parameter, it asks for it and draws it beside the calendar",
    new URL(r.requests[0] || "about:blank").searchParams.get("note") === "Development"
    && txt.includes("DEVELOPMENT") && txt.includes("• Gym/Body/Nutrition\n• Career/Experience")
    && txt.includes("CALENDAR") && txt.indexOf("CALENDAR") < txt.indexOf("DEVELOPMENT"));
  check("…with two events beside a note (three without one — the sweep above)",
    txt.slice(txt.indexOf("CALENDAR") + 1, txt.indexOf("DEVELOPMENT")).length === 4);
  check("…and the countdown on the NOW line, clear of the block's name", (() => {
    const nodes = (n) => (n ? [n, ...(n.children || []).flatMap(nodes)] : []);
    const nowLine = nodes(r.widget).find((x) => x.kind === "stack" && x.children.some((c) => c.kind === "text" && c.text === "NOW"));
    return !!nowLine && nowLine.children.some((c) => c.kind === "date" && c.style === "timer");
  })());
  check("…and the hour-by-hour list keeps the current block and what follows",
    txt.includes("Evening") && txt.includes("Wind down — screens off") && txt.includes("now"));
  const missing = await runWidget(WIDGET, { family: "large", now: t, param: "Nope", keychain: { [KEY]: TOKEN }, respond: feed(STARTER, { events: CAL, note: null, noteMatch: "Nope" }) });
  check("a name with no note says so in the band", texts(missing.widget).includes("No note by that name yet."));
  const broken = await runWidget(WIDGET, { family: "large", now: t, param: "Development", keychain: { [KEY]: TOKEN },
    respond: feed(STARTER, { events: null, eventsError: "x", note: null, noteMatch: "Development", noteError: "y" }) });
  check("a calendar or notes failure says so in its own column, under a plan that still draws",
    texts(broken.widget).includes("Couldn't read the calendar.") && texts(broken.widget).includes("Couldn't read your notes.") && texts(broken.widget).includes("Evening"));
  const older = await runWidget(WIDGET, { family: "large", now: t, keychain: { [KEY]: TOKEN }, respond: feed(STARTER) });
  check("a payload from before the band (an older cache) draws the day without one",
    !texts(older.widget).includes("CALENDAR") && texts(older.widget).includes("Evening"));
  const pin = await runWidget(WIDGET, { family: "large", now: t, param: "Development", keychain: { [KEY]: TOKEN }, respond: feed(STARTER, { events: CAL }) });
  const files = [...pin.files.keys()];
  check("a widget with a parameter keeps its own cache", files.length === 1 && /board-room-plan-development\.json$/.test(files[0]));
}

// ─── 4. token, network, cache ────────────────────────────────────────────────
{
  const t = new Date(2026, 9, 29, 10, 0).getTime();
  const r = await runWidget(WIDGET, { family: "small", now: t, respond: feed(STARTER) });
  check("with no token, it says how to add one", texts(r.widget).some((s) => /run this script once to add your token/.test(s)) && r.requests.length === 0);
  const u = new URL((await run(STARTER, t)).requests[0] || "about:blank");
  check("it asks for the plan view with the stored token", u.searchParams.get("view") === "plan" && u.searchParams.get("token") === TOKEN);
  const wrong = await runWidget(WIDGET, { family: "small", now: t, keychain: { [KEY]: "wrong" }, respond: feed(STARTER) });
  check("a wrong token shows the function's own words", texts(wrong.widget).includes("Missing or incorrect token."));
  const app = await runWidget(WIDGET, { family: "small", now: t, inApp: true, respond: feed(STARTER), alertAnswers: [{ action: 0, value: TOKEN }] });
  check("in the app it asks once and keeps the token where the other widgets read it",
    app.alerts.length === 1 && app.keychain.get(KEY) === TOKEN && texts(app.widget).includes("Work — hardest thing first")
    && read("scriptable/board-room-notes.js").includes(`const KEYCHAIN_KEY = "${KEY}";`));
  const old = await runWidget(WIDGET, { family: "small", now: t, keychain: { [KEY]: TOKEN }, respond: () => ({ generated_at: "x", events: [] }) });
  check("a site still on the previous function is named as that", texts(old.widget).some((s) => /doesn't serve the plan yet/.test(s)));
}
{
  // The cache is written with the real clock (FileManager isn't frozen), so its
  // age is set by hand: three days, then eight.
  const t = Date.now();
  const first = await runWidget(WIDGET, { family: "small", now: t, keychain: { [KEY]: TOKEN }, respond: feed(STARTER) });
  const age = (days) => Object.fromEntries([...first.files].map(([p, s]) => [p, JSON.stringify({ ...JSON.parse(s), at: Date.now() - days * 86400000 })]));
  const offline = () => { throw new Error("The Internet connection appears to be offline."); };
  const where = whereAmI(STARTER, new Date(t));
  const want = where.current?.title || where.next?.title;
  const three = await runWidget(WIDGET, { family: "small", now: t, keychain: { [KEY]: TOKEN }, files: age(3), respond: offline });
  check("offline, a plan cached days ago still draws the day — it's the same plan", texts(three.widget).includes(want), want);
  check("…marked with when it was fetched, once it's over a day old", texts(three.widget).some((s) => /^plan from /.test(s)));
  const eight = await runWidget(WIDGET, { family: "small", now: t, keychain: { [KEY]: TOKEN }, files: age(8), respond: offline });
  check("…but not past a week", texts(eight.widget).includes("Plan unavailable"));
}
{
  const src = read(WIDGET);
  check("the committed widget carries no token", /^const TOKEN = "";/m.test(src));
  check("…and talks to the production site", src.includes(`const SITE = "${SITE}";`));
  check("…and doesn't ask iOS for more than it will give between block changes", /^const REFRESH_MINUTES = (1[5-9]|[2-9]\d);/m.test(src));
}

// ─── 5. the tap lands ────────────────────────────────────────────────────────
{
  const app = code(read("src/App.jsx"));
  check("App reads ?plan beside ?note, once there are settings",
    /const toNote = url\.searchParams\.has\("note"\), toPlan = url\.searchParams\.has\("plan"\);\s*if \(!toNote && !toPlan\) return;/.test(app));
  check("…takes it back out of the URL", /url\.searchParams\.delete\("plan"\);/.test(app));
  check("…and opens the Plan tab", /else goToPage\("plan"\);/.test(app) && /case "plan": return <PlanPage/.test(app));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nPLAN WIDGET SMOKE: ALL CLEAN");
process.exit(failed ? 1 : 0);
