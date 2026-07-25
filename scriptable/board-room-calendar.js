// ─── Board Room · Calendar ───────────────────────────────────────────────────
// A Scriptable widget for iOS/iPadOS that renders your Board Room calendar —
// events, birthdays, and upkeep — on the Home Screen and Lock Screen.
//
// It reads the endpoint this repo already ships for TRMNL:
//   /.netlify/functions/trmnl?view=json&token=…
// so there is NOTHING to deploy. Same token, same payload, same Supabase data.
// See TRMNL.md for how that endpoint is set up and secured.
//
// SETUP (two minutes) — SITE and the Netlify env vars are already correct;
// the only thing you supply is the token.
//   1. Install Scriptable from the App Store.
//   2. Scriptable → + (new script) → paste this whole file → name it
//      "Board Room Calendar".
//   3. Tap ▶ to run it once inside Scriptable. It will prompt for your
//      TRMNL_TOKEN and store it in the iOS keychain, so the secret never sits
//      in this (iCloud-synced) file. You should then see a live preview.
//   4. Home Screen → long-press → + → Scriptable → pick a size → place it.
//      Long-press the placed widget → Edit Widget → Script: "Board Room
//      Calendar". Leave "When Interacting" as Run Script.
//
// SIZES — every family is laid out on purpose:
//   small            big date + the next two things
//   medium           date rail + four-row agenda
//   large / XL       date, a 7-day dot strip, agenda, then birthdays + upkeep
//   Lock Screen      inline / circular / rectangular all supported
//
// WIDGET PARAMETER (optional, in Edit Widget → Parameter)
//   "events"    only calendar events — hide birthdays and upkeep
//   "all"       default; everything
//
// Colors follow the app's Porcelain palette (src/design/themes.css) and the
// category colors in src/pages/personal/CalendarPanel.jsx, light and dark.

// ── config ───────────────────────────────────────────────────────────────────
const SITE = "https://board-room.netlify.app"; // no trailing slash
const TOKEN = ""; // your TRMNL_TOKEN — or leave "" to be prompted once (keychain)

const CACHE_TTL_HOURS = 24; // how long a cached payload is still worth showing
const PREVIEW = "large"; // size shown when you run the script inside the app

// ── palette ──────────────────────────────────────────────────────────────────
// Porcelain (the house default), day and night, via Color.dynamic so iOS
// swaps them itself rather than us guessing the appearance at render time.
const dyn = (light, dark, alpha) =>
  Color.dynamic(new Color(light, alpha), new Color(dark, alpha));

const C = {
  bg: dyn("#F4F3F0", "#0F0E0B"),
  surface: dyn("#FEFEFE", "#211F19"),
  ink: dyn("#2B2922", "#D9D6CE"),
  sub: dyn("#706B5C", "#9F9989"),
  faint: dyn("#8E897B", "#7F7A6C"),
  accent: dyn("#87671D", "#D7AA42"),
  line: dyn("#2B2922", "#D9D6CE", 0.14),
  wash: dyn("#87671D", "#D7AA42", 0.13),
};

// Category keys are the stored values in personal_events.category.
const CAT = {
  personal: dyn("#3568D4", "#4C82E8"),
  work: dyn("#B36514", "#BC7F24"),
  health: dyn("#278A4C", "#34A56E"),
  bills: dyn("#C93B32", "#E05548"),
  birthday: dyn("#C7447E", "#D95C93"),
  upkeep: dyn("#6B41C4", "#9673E6"),
};
const catColor = (key) => CAT[key] || CAT.personal;

// ── token ────────────────────────────────────────────────────────────────────
const KEYCHAIN_KEY = "boardroom.trmnl.token";

async function resolveToken() {
  if (TOKEN) return TOKEN;
  if (Keychain.contains(KEYCHAIN_KEY)) return Keychain.get(KEYCHAIN_KEY);
  // A widget can't show a prompt, so first-run setup has to happen in the app.
  if (!config.runsInApp) return null;

  const a = new Alert();
  a.title = "Board Room token";
  a.message =
    "Paste your TRMNL_TOKEN (Netlify → Site configuration → Environment " +
    "variables). It's stored in this device's keychain, not in the script.";
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
const CACHE_PATH = fm.joinPath(fm.cacheDirectory(), "board-room-calendar.json");

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

async function fetchFeed(token) {
  const url = `${SITE}/.netlify/functions/trmnl?view=json&token=${encodeURIComponent(token)}`;
  const req = new Request(url);
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  // The endpoint answers a bad token with 401 + {success:false,error}. Surface
  // that message rather than a generic failure — it's the one that's actionable.
  if (data && data.success === false) {
    const err = new Error(data.error || "feed refused the request");
    // The endpoint's exact wording for a bad/missing token — used below to
    // clear the stored value and reprompt instead of getting stuck forever
    // reusing whatever was typed wrong the first time.
    err.isAuthError = /missing or incorrect token/i.test(data.error || "");
    throw err;
  }
  if (!data || !Array.isArray(data.events)) throw new Error("unexpected response from the feed");
  return data;
}

// Returns { data, stale, cachedAt, error } — always tries the network first,
// falls back to a recent cache so a dropped connection doesn't blank the widget.
async function load() {
  const token = await resolveToken();
  if (!token) {
    return { data: null, error: "Open Scriptable and run this script once to add your token." };
  }
  try {
    const data = await fetchFeed(token);
    cacheWrite(data);
    return { data, stale: false };
  } catch (e) {
    // Wrong token and we're in a position to fix it right now — Scriptable has
    // no keychain-management UI, so clear the bad value and reprompt rather
    // than leaving the widget stuck on the same wrong token forever.
    if (e.isAuthError && config.runsInApp) {
      Keychain.remove(KEYCHAIN_KEY);
      const retryToken = await resolveToken();
      if (retryToken) {
        try {
          const data = await fetchFeed(retryToken);
          cacheWrite(data);
          return { data, stale: false };
        } catch (e2) {
          e = e2;
        }
      }
    }
    const cached = cacheRead();
    const fresh = cached && Date.now() - cached.at < CACHE_TTL_HOURS * 3600000;
    if (fresh) return { data: cached.data, stale: true, cachedAt: cached.at };
    return { data: null, error: String(e.message || e) };
  }
}

// ── dates ────────────────────────────────────────────────────────────────────
// The feed pre-formats every date as "Jul 25" in America/Chicago, so we build
// local keys in exactly that shape and compare strings — no re-parsing, and no
// timezone drift between all-day (stored UTC) and timed events.
const now = new Date();
const keyOf = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const dayShift = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
const TODAY = keyOf(now);
const TOMORROW = keyOf(dayShift(1));

// `when` reads "Wed, Jul 22, 6:00 PM" (timed) or "Wed, Jul 22" (all-day), so
// the weekday is already in the payload — no need to re-derive it from a string.
function weekdayOf(item) {
  const wd = String(item.when || "").split(",")[0].trim();
  return /^[A-Za-z]{3}$/.test(wd) ? wd : "";
}

function dayLabel(ev) {
  if (ev.date === TODAY) return "Today";
  if (ev.date === TOMORROW) return "Tomorrow";
  const wd = weekdayOf(ev);
  return wd ? `${wd} · ${ev.date}` : ev.date;
}

// Compact right-hand label: today needs no weekday, later days do.
function whenLabel(ev) {
  const time = ev.all_day ? "All day" : ev.time;
  if (ev.date === TODAY) return time;
  const wd = weekdayOf(ev);
  return wd ? `${wd} · ${time}` : `${ev.date} · ${time}`;
}

// The feed returns events already sorted, so a linear pass groups them by day.
function groupByDay(events) {
  const out = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (last && last.key === ev.date) last.items.push(ev);
    else out.push({ key: ev.date, label: dayLabel(ev), items: [ev] });
  }
  return out;
}

const todayCount = (data) => (data.events || []).filter((e) => e.date === TODAY).length;

// ── drawing primitives ───────────────────────────────────────────────────────
// Dots are sized empty stacks rather than DrawContext images: a rasterized
// image would bake in one appearance, while a stack keeps Color.dynamic live.
function dot(row, color, size = 7) {
  const d = row.addStack();
  d.size = new Size(size, size);
  d.cornerRadius = size / 2;
  d.backgroundColor = color;
  return d;
}

// Height-1 stack with a spacer inside so it stretches to the container width
// without us having to know the widget's point size on this device.
function rule(container) {
  const r = container.addStack();
  r.size = new Size(0, 1);
  r.backgroundColor = C.line;
  r.addSpacer();
  return r;
}

function label(container, text, font, color, lines = 1) {
  const t = container.addText(text);
  t.font = font;
  t.textColor = color;
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.85;
  return t;
}

function chip(row, text) {
  const s = row.addStack();
  s.backgroundColor = C.wash;
  s.cornerRadius = 5;
  s.setPadding(2, 6, 2, 6);
  label(s, text, Font.semiboldSystemFont(9), C.accent);
  return s;
}

// ── widget pieces ────────────────────────────────────────────────────────────
// `timeOnly` is for the day-grouped layouts, where the group header already
// says which day it is and repeating the weekday on every row reads as noise.
function eventRow(container, ev, opts = {}) {
  const size = opts.size || 13;
  const row = container.addStack();
  row.centerAlignContent();
  dot(row, catColor(ev.category), opts.dotSize || 7);
  row.addSpacer(7);
  label(row, ev.title || "(untitled)", Font.systemFont(size), C.ink);
  row.addSpacer();
  const right = opts.timeOnly ? (ev.all_day ? "All day" : ev.time) : whenLabel(ev);
  label(row, right, Font.mediumSystemFont(size - 2), C.sub);
  return row;
}

function sideNote(container, text, color) {
  const row = container.addStack();
  row.centerAlignContent();
  dot(row, color, 6);
  row.addSpacer(7);
  label(row, text, Font.systemFont(11), C.sub);
  row.addSpacer();
}

// Left rail: weekday, big day number, month — the "it's a calendar" cue.
function dateRail(container, width) {
  const rail = container.addStack();
  rail.layoutVertically();
  rail.size = new Size(width, 0);

  label(rail, now.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(),
    Font.semiboldSystemFont(10), C.accent);
  rail.addSpacer(1);
  label(rail, String(now.getDate()), Font.boldSystemFont(34), C.ink);
  rail.addSpacer(1);
  label(rail, now.toLocaleDateString("en-US", { month: "long" }).toUpperCase(),
    Font.mediumSystemFont(9), C.faint);
  return rail;
}

// Seven columns of the coming week; a day with anything on it gets up to three
// category dots, and today gets the accent wash behind it.
function weekStrip(container, data, include) {
  const strip = container.addStack();
  strip.spacing = 0;

  for (let i = 0; i < 7; i++) {
    const d = dayShift(i);
    const key = keyOf(d);

    const marks = [];
    for (const ev of data.events || []) if (ev.date === key) marks.push(catColor(ev.category));
    if (include.extras) {
      for (const b of data.birthdays || []) if (b.when === key) marks.push(CAT.birthday);
      for (const u of data.upkeep || []) if (u.when === key) marks.push(CAT.upkeep);
    }

    const col = strip.addStack();
    col.layoutVertically();
    col.centerAlignContent();
    col.setPadding(5, 4, 5, 4); // on every column so today's wash doesn't resize it
    if (i === 0) {
      col.backgroundColor = C.wash;
      col.cornerRadius = 8;
    }

    const wd = col.addStack();
    wd.addSpacer();
    label(wd, d.toLocaleDateString("en-US", { weekday: "narrow" }),
      Font.mediumSystemFont(9), i === 0 ? C.accent : C.faint);
    wd.addSpacer();

    col.addSpacer(2);
    const num = col.addStack();
    num.addSpacer();
    label(num, String(d.getDate()), i === 0 ? Font.boldSystemFont(14) : Font.systemFont(14),
      i === 0 ? C.accent : C.ink);
    num.addSpacer();

    col.addSpacer(4);
    const dots = col.addStack();
    dots.spacing = 3;
    dots.addSpacer();
    if (marks.length === 0) dot(dots, new Color("#808080", 0.16), 4);
    else for (const m of marks.slice(0, 3)) dot(dots, m, 4);
    dots.addSpacer();

    if (i < 6) strip.addSpacer(); // between columns only — keeps the strip even
  }
  return strip;
}

function emptyState(container, text) {
  const s = container.addStack();
  s.layoutVertically();
  s.addSpacer(4);
  label(s, text, Font.systemFont(12), C.faint, 2);
}

// ── layouts ──────────────────────────────────────────────────────────────────
function renderSmall(w, data, include) {
  const head = w.addStack();
  head.centerAlignContent();
  label(head, now.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(),
    Font.semiboldSystemFont(10), C.accent);
  head.addSpacer();
  const n = todayCount(data);
  label(head, n ? `${n} today` : "clear", Font.mediumSystemFont(9), C.faint);

  label(w, String(now.getDate()), Font.boldSystemFont(32), C.ink);
  w.addSpacer(5);
  rule(w);
  w.addSpacer(6);

  const events = data.events || [];
  if (!events.length) {
    emptyState(w, "Nothing on the books.");
    w.addSpacer();
    return;
  }

  for (const ev of events.slice(0, 2)) {
    const line = w.addStack();
    line.centerAlignContent();
    dot(line, catColor(ev.category), 6);
    line.addSpacer(6);
    label(line, ev.title || "(untitled)", Font.semiboldSystemFont(12), C.ink);

    const sub = w.addStack();
    sub.setPadding(0, 12, 0, 0);
    label(sub, whenLabel(ev), Font.systemFont(10), C.sub);
    w.addSpacer(6);
  }

  w.addSpacer();
  if (events.length > 2) label(w, `+${events.length - 2} more`, Font.mediumSystemFont(9), C.faint);
}

function renderMedium(w, data, include) {
  const body = w.addStack();
  body.centerAlignContent();

  dateRail(body, 58);
  body.addSpacer(12);

  const divider = body.addStack();
  divider.size = new Size(1, 62);
  divider.backgroundColor = C.line;
  body.addSpacer(12);

  const list = body.addStack();
  list.layoutVertically();
  list.spacing = 6;

  const events = data.events || [];
  if (!events.length) {
    emptyState(list, "Nothing on the books for the next two weeks.");
  } else {
    for (const ev of events.slice(0, 4)) eventRow(list, ev, { size: 13 });
    if (events.length > 4) {
      list.addSpacer(1);
      label(list, `+${events.length - 4} more`, Font.mediumSystemFont(9), C.faint);
    }
  }
  list.addSpacer();
}

function renderLarge(w, data, include, rows) {
  const head = w.addStack();
  head.centerAlignContent();
  label(head, "BOARD ROOM", Font.semiboldSystemFont(10), C.accent);
  head.addSpacer();
  const n = todayCount(data);
  chip(head, n ? `${n} today` : "clear today");

  w.addSpacer(8);
  label(w, now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
    Font.boldSystemFont(20), C.ink);
  w.addSpacer(10);

  weekStrip(w, data, include);
  w.addSpacer(10);
  rule(w);
  w.addSpacer(10);

  const events = data.events || [];
  if (!events.length) {
    emptyState(w, "Nothing on the books for the next two weeks.");
  } else {
    let used = 0;
    for (const group of groupByDay(events)) {
      if (used >= rows) break;
      label(w, group.label.toUpperCase(), Font.semiboldSystemFont(9), C.faint);
      w.addSpacer(4);
      for (const ev of group.items) {
        if (used >= rows) break;
        eventRow(w, ev, { size: 13, timeOnly: true });
        w.addSpacer(5);
        used++;
      }
      w.addSpacer(3);
    }
    if (events.length > used) label(w, `+${events.length - used} more`, Font.mediumSystemFont(9), C.faint);
  }

  w.addSpacer();

  // Birthdays and upkeep are what Board Room's calendar has that a plain
  // calendar app doesn't — worth the footer on the sizes that can hold it.
  const extras = [];
  if (include.extras) {
    for (const b of (data.birthdays || []).slice(0, 2)) {
      extras.push({
        color: CAT.birthday,
        text: `${b.name}${b.turning ? ` turns ${b.turning}` : ""} · ${b.rel}`,
      });
    }
    for (const u of (data.upkeep || []).slice(0, 2)) {
      extras.push({ color: CAT.upkeep, text: `${u.name} · ${u.overdue ? "overdue" : u.rel}` });
    }
  }
  if (extras.length) {
    rule(w);
    w.addSpacer(7);
    for (const e of extras.slice(0, 3)) {
      sideNote(w, e.text, e.color);
      w.addSpacer(4);
    }
  }
}

// Lock Screen families are monochrome — iOS tints them — so these use plain
// text weight and hierarchy instead of color to separate the lines.
function renderAccessoryRectangular(w, data) {
  const events = data.events || [];
  label(w, events.length ? dayLabel(events[0]).toUpperCase() : "BOARD ROOM",
    Font.semiboldSystemFont(11), Color.white());
  if (!events.length) {
    label(w, "Nothing on the books", Font.systemFont(13), Color.white());
    return;
  }
  label(w, events[0].title || "(untitled)", Font.semiboldSystemFont(14), Color.white());
  const rest = events[1];
  label(w, rest ? `${events[0].time} · then ${rest.title}` : events[0].time,
    Font.systemFont(12), Color.white());
}

function renderAccessoryCircular(w, data) {
  const s = w.addStack();
  s.layoutVertically();
  s.centerAlignContent();

  const top = s.addStack();
  top.addSpacer();
  label(top, String(now.getDate()), Font.boldSystemFont(22), Color.white());
  top.addSpacer();

  const bottom = s.addStack();
  bottom.addSpacer();
  const n = todayCount(data);
  label(bottom, n ? `${n} today` : "clear", Font.systemFont(9), Color.white());
  bottom.addSpacer();
}

function renderAccessoryInline(w, data) {
  const ev = (data.events || [])[0];
  label(w, ev ? `${ev.title} · ${whenLabel(ev)}` : "Nothing on the books",
    Font.systemFont(13), Color.white());
}

function renderError(w, message, family) {
  const small = family === "small" || String(family).startsWith("accessory");
  label(w, "BOARD ROOM", Font.semiboldSystemFont(10), C.accent);
  w.addSpacer(6);
  label(w, "Calendar unavailable", Font.semiboldSystemFont(small ? 13 : 15), C.ink);
  w.addSpacer(4);
  label(w, message, Font.systemFont(small ? 10 : 12), C.sub, small ? 3 : 4);
  w.addSpacer();
}

// ── assembly ─────────────────────────────────────────────────────────────────
function buildWidget(result, family) {
  const w = new ListWidget();
  const isAccessory = String(family).startsWith("accessory");

  if (isAccessory) {
    w.setPadding(2, 2, 2, 2);
    // Lock Screen widgets get the system's frosted plate where supported.
    try { w.addAccessoryWidgetBackground = true; } catch {}
  } else {
    w.setPadding(14, 15, 13, 15);
    const g = new LinearGradient();
    g.colors = [C.surface, C.bg];
    g.locations = [0, 1];
    g.startPoint = new Point(0, 0);
    g.endPoint = new Point(0.6, 1);
    w.backgroundGradient = g;
  }

  w.url = SITE;

  if (!result.data) {
    if (isAccessory) label(w, "Board Room unavailable", Font.systemFont(12), Color.white());
    else renderError(w, result.error, family);
    // Something's wrong — come back sooner than the happy path would.
    w.refreshAfterDate = new Date(Date.now() + 10 * 60000);
    return w;
  }

  const param = (args.widgetParameter || "").trim().toLowerCase();
  const include = { extras: param !== "events" };
  const data = result.data;

  switch (family) {
    case "accessoryInline": renderAccessoryInline(w, data); break;
    case "accessoryCircular": renderAccessoryCircular(w, data); break;
    case "accessoryRectangular": renderAccessoryRectangular(w, data); break;
    case "small": renderSmall(w, data, include); break;
    case "large": renderLarge(w, data, include, 5); break;
    case "extraLarge": renderLarge(w, data, include, 9); break;
    default: renderMedium(w, data, include); break;
  }

  // A quiet marker so stale data never passes itself off as live.
  if (result.stale && !isAccessory) {
    const at = new Date(result.cachedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    label(w, `cached ${at}`, Font.systemFont(8), C.faint);
  }

  w.refreshAfterDate = new Date(Date.now() + (result.stale ? 10 : 30) * 60000);
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
} else if (String(family).startsWith("accessory")) {
  await widget.presentMedium();
} else {
  await widget.presentMedium();
}
Script.complete();
