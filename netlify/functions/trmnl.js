// ─── TRMNL bridge — publish Board Room data OUT to a TRMNL e-ink device ──────
// The rest of the codebase pulls data IN (calendar-events.js parses an external
// .ics; markets.js reads Yahoo). This does the opposite: it exposes Board
// Room's own Supabase data so a TRMNL dashboard can display it. Two views, one
// endpoint, both GET (TRMNL polls with GET, no body):
//
//   ?view=ics   → a text/calendar (.ics) feed of your calendar events, plus
//                 birthdays and anniversaries (both yearly-recurring) and upkeep
//                 due-dates as all-day events. Point TRMNL's native "Calendar"
//                 plugin at this URL and you get the exact month-grid render
//                 shown on the device today, but sourced from Board Room instead
//                 of Google Calendar.
//
//   ?view=json  → a compact JSON brief (upcoming events + birthdays +
//                 anniversaries + upkeep due) for a TRMNL "Private Plugin" set to
//                 Polling. You write the Liquid layout once (see
//                 trmnl/board-brief.liquid) and TRMNL renders a custom
//                 multi-widget Board Room screen. Default view.
//
//   ?view=notes → your notes, for the Scriptable Home Screen widget
//                 (scriptable/board-room-notes.js). Exactly the notes the
//                 Brief's Notes tile shows, in the order it shows them — or,
//                 with &note=<title>, that one note by name (see renderNotes).
//                 Not part of the default JSON brief: TRMNL polls that shape
//                 and has no use for note bodies.
//
//   ?view=plan  → the Daily Plan tab's two templates, for the Scriptable plan
//                 widget (scriptable/board-room-plan.js), with the calendar rows
//                 for its Upcoming band and, with &note=<title>, one note. All
//                 sent as stored; the widget works out where the day is, and
//                 expands repeating events, on the phone (renderPlan).
//
// SECURITY: like export-data.js, this uses the Supabase SERVICE ROLE key, which
// bypasses RLS — necessary because TRMNL polls with no logged-in session. So the
// endpoint MUST be gated: it requires a shared secret (TRMNL_TOKEN) passed as
// ?token=… in the URL (or an X-Board-Token header). TRMNL stores the polling URL
// server-side and only the device/servers fetch it, so a token in the URL is the
// same "secret address" model Google Calendar itself uses for private .ics feeds.
//
// One-time setup (see TRMNL.md for the full walkthrough):
//   1. Netlify → Environment variables → add TRMNL_TOKEN (any long random string).
//   2. Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (already used by
//      export-data.js). Optionally TRMNL_USER_ID to scope to one account — falls
//      back to MINER_USER_ID, then to "no filter" (fine for a single-user site).

const { createClient } = require("@supabase/supabase-js");
const { timingSafeEqual } = require("node:crypto");

const TZ = "America/Chicago"; // matches calendar.js / the rest of the app
const jsonRes = (code, body, extraHeaders) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  body: JSON.stringify(body),
});

// ── iCal helpers ─────────────────────────────────────────────────────────────
// Escape per RFC 5545: backslash, comma, semicolon, and newlines are special in
// TEXT values. Order matters — escape the backslash first.
function icsEscape(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
// Fold long lines to <=75 octets (approximated as chars, safe for our ASCII-ish
// content) with a leading space on continuations, as many strict parsers require.
function icsFold(line) {
  if (line.length <= 73) return line;
  const out = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) { out.push(" " + rest.slice(0, 72)); rest = rest.slice(72); }
  out.push(" " + rest);
  return out.join("\r\n");
}
const pad = (n) => String(n).padStart(2, "0");
// UTC timestamp form YYYYMMDDTHHMMSSZ for timed events (our timed events are
// stored as UTC "…Z" ISO strings).
function icsUtc(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
// DATE form YYYYMMDD for all-day events. We take the date portion the app itself
// shows (the date slice of the stored string — see startDayKey in
// calendar-overlays.js), so the feed lands events on the same day the app does.
//
// WHAT THAT SLICE IS. All-day rows are NOT stored at UTC midnight, whatever an
// earlier version of this comment said: CalendarPanel writes them as
// `${date}T00:00:00` in the browser's own clock, so a Chicago row lands at
// 05:00Z (CDT) or 06:00Z (CST) on the SAME calendar date. The first ten
// characters are therefore the day the user picked, and that — not the instant
// — is what every all-day computation below starts from. Treating the instant
// as the event's time is how today's all-day events vanished from the brief by
// mid-morning (see renderJson).
const icsDate = (y, m, d) => `${y}${pad(m)}${pad(d)}`;
const ymdOfSlice = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return { y, m, d }; };
function addDaysYMD(y, m, d, delta) {
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
// The Chicago calendar date of an instant. Every "how many days away" answer in
// the JSON view is a difference of two of these, never of two instants: the
// device asks "is it today", and today is a Chicago date, not a 24-hour radius
// around now. Math.round over instants put a Sep 2 birthday on "Today" from 7pm
// on Sep 1, and marked an upkeep item due today as overdue from 7am.
function ymdIn(ms) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), m: get("month"), d: get("day") };
}
// An annual (month, day) in year `y`, as a UTC-midnight stamp, with a day the
// month lacks that year CLAMPED to its last day: Feb 29 is Feb 28 in a common
// year. The inline twin of annualDate in src/lib/dates.js (this file cannot
// import it — see "DUPLICATED, NOT IMPORTED" below), and it must agree with
// it: Date.UTC(y, 1, 29) rolls to Mar 1 on its own, which put a leap-day
// birthday on Mar 1 here while the Brief and the calendar said Feb 28.
// scripts/anniversaries-smoke.mjs runs both over the same rows.
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const annualUTC = (y, m, d) => Date.UTC(y, m - 1, Math.min(d, lastDayOf(y, m)));
// A calendar date as a comparable stamp (UTC midnight of that Y-M-D). Only ever
// compared with another stamp, so the zone it is nominally in does not matter.
const dayStamp = ({ y, m, d }) => Date.UTC(y, m - 1, d);

function buildIcs(sections) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Board Room//TRMNL Bridge//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Board Room",
    "X-WR-TIMEZONE:" + TZ, "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];
  const stamp = icsUtc(new Date().toISOString());
  for (const ev of sections) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${ev.start}`);
      if (ev.end) lines.push(`DTEND;VALUE=DATE:${ev.end}`);
    } else {
      lines.push(`DTSTART:${ev.start}`);
      if (ev.end) lines.push(`DTEND:${ev.end}`);
    }
    if (ev.rrule) lines.push(`RRULE:${ev.rrule}`);
    lines.push(`SUMMARY:${icsEscape(ev.summary)}`);
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
    if (ev.categories) lines.push(`CATEGORIES:${icsEscape(ev.categories)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

// ── Anniversary wording (mirrors src/lib/anniversaries.js) ───────────────────
// DUPLICATED, NOT IMPORTED, for the reason written at length in audit.js: under
// this repo's "type":"module" + esbuild bundling, requiring a shared helper
// clobbers the function bundle's exports and deploys a handler-less function.
// scripts/anniversaries-smoke.mjs asserts this copy and the app's agree on the
// three sentences they can both produce.
//
// The rules are the app's rules: an unknown kind reads as a milestone and never
// as a passing, and a year count is omitted rather than guessed.
const anniversaryKindOf = (kind) => (kind === "passing" ? "passing" : "milestone");
function anniversaryYears(row, occurrenceYear) {
  const from = Number(row && row.year);
  if (!Number.isFinite(from) || from < 1900 || from > occurrenceYear) return null;
  const n = occurrenceYear - from;
  return n >= 1 ? n : null;
}
function anniversaryNote(row, occurrenceYear) {
  const n = anniversaryYears(row, occurrenceYear);
  const base = anniversaryKindOf(row && row.kind) === "passing" ? "In memory" : "Anniversary";
  return n == null ? base : `${base} · ${n} year${n === 1 ? "" : "s"}`;
}

// ── Upkeep next-due math (mirrors src/lib/upkeep.js intent) ───────────────────
function upkeepDue(item) {
  if (!item.last_done || !item.interval_days) return null;
  const last = new Date(item.last_done + "T00:00:00Z");
  const due = new Date(last.getTime() + item.interval_days * 86400000);
  return { y: due.getUTCFullYear(), m: due.getUTCMonth() + 1, d: due.getUTCDate(), ts: due.getTime() };
}

// ── data fetch ───────────────────────────────────────────────────────────────
async function loadAll(supabase, userId) {
  const scope = (q) => (userId ? q.eq("user_id", userId) : q);
  // `r.data || []` USED TO SWALLOW EVERY FAILURE. A Supabase error returns
  // data:null with the reason in r.error, so an RLS blip, a dropped connection
  // or a schema slip all became an empty array — and the device, which has no
  // screen furniture for an error, rendered a confident "Nothing scheduled".
  // An e-ink brief that says your day is empty when it could not read your
  // calendar is worse than one that says it could not read your calendar.
  const errors = [];
  const read = (table, cols) => scope(supabase.from(table).select(cols)).then((r) => {
    if (r.error) { errors.push(`${table}: ${r.error.message}`); return null; }
    return r.data || [];
  });
  const [events, birthdays, anniversaries, upkeep] = await Promise.all([
    read("personal_events", "id,title,notes,start_time,end_time,all_day,location,category"),
    read("personal_birthdays", "id,name,month,day,year"),
    read("personal_anniversaries", "id,name,kind,month,day,year"),
    read("upkeep_items", "id,name,interval_days,last_done"),
  ]);
  return { events, birthdays, anniversaries, upkeep, errors };
}

// ── ICS view ─────────────────────────────────────────────────────────────────
// One yearly all-day row for an annual (month, day). The plain case is
// FREQ=YEARLY from this year's date. Feb 29 is not: in a common year
// icsDate(2026, 2, 29) is "20260229", a DTSTART that does not exist, and a
// strict RFC 5545 client skips a YEARLY instance on a date the year lacks, so
// the day appeared at best once every four years. BYMONTHDAY=-1 in February is
// "the last day of February" — the 29th in a leap year, the 28th otherwise —
// which is exactly the app's clamp, expressed in the rule itself.
function yearlyIcs(year, month, day) {
  if (Number(month) === 2 && Number(day) === 29) {
    const last = lastDayOf(year, 2);
    const nx = addDaysYMD(year, 2, last, 1);
    return { start: icsDate(year, 2, last), end: icsDate(nx.y, nx.m, nx.d), rrule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1" };
  }
  const nx = addDaysYMD(year, month, day, 1);
  return { start: icsDate(year, month, day), end: icsDate(nx.y, nx.m, nx.d), rrule: "FREQ=YEARLY" };
}

function renderIcs({ events = [], birthdays = [], anniversaries = [], upkeep = [] }, include) {
  const out = [];

  if (include.has("events")) {
    for (const ev of events) {
      const allDay = !!ev.all_day;
      let start, end;
      if (allDay) {
        const { y, m, d } = ymdOfSlice(ev.start_time);
        start = icsDate(y, m, d);
        // A multi-day all-day span stores its LAST day, inclusive, in end_time
        // (CalendarPanel's draftFields: `${endDate}T00:00:00`). DTEND for DATE
        // values is exclusive, so the feed ends the day after that — and, with
        // no end_time, the day after the start. This used to ignore end_time
        // entirely, and a four-day trip that painted four cells in the app
        // painted one on the device. An end before the start is a row the app
        // would not have written; it falls back to a single day rather than to
        // a negative span the parser would drop.
        const last = ev.end_time ? ymdOfSlice(ev.end_time) : null;
        const lastDay = last && dayStamp(last) >= dayStamp({ y, m, d }) ? last : { y, m, d };
        const nx = addDaysYMD(lastDay.y, lastDay.m, lastDay.d, 1);
        end = icsDate(nx.y, nx.m, nx.d);
      } else {
        start = icsUtc(ev.start_time);
        end = ev.end_time ? icsUtc(ev.end_time) : icsUtc(new Date(new Date(ev.start_time).getTime() + 3600000).toISOString());
      }
      out.push({
        uid: `event-${ev.id}@boardroom`, allDay, start, end,
        summary: ev.title || "(untitled)", location: ev.location || "",
        description: ev.notes || "", categories: ev.category || "personal",
      });
    }
  }

  if (include.has("birthdays")) {
    const thisYear = new Date().getUTCFullYear();
    for (const b of birthdays) {
      if (!b.month || !b.day) continue;
      const { start, end, rrule } = yearlyIcs(thisYear, b.month, b.day);
      out.push({
        uid: `birthday-${b.id}@boardroom`, allDay: true, start, end,
        rrule,
        summary: `${b.name}${/birthday/i.test(b.name || "") ? "" : "'s Birthday"}`,
        categories: "birthday",
      });
    }
  }

  if (include.has("anniversaries")) {
    const thisYear = new Date().getUTCFullYear();
    for (const a of anniversaries) {
      if (!a.month || !a.day) continue;
      const { start, end, rrule } = yearlyIcs(thisYear, a.month, a.day);
      // NO YEAR COUNT IN THE SUMMARY, deliberately, and this is the one place
      // the app's wording is NOT reused. These are FREQ=YEARLY events: the
      // summary is written once and redrawn every year by the device, so a
      // baked-in "· 5 years" is correct for one year and a lie for every year
      // after it. Birthdays have always said "X's Birthday" rather than an age
      // for exactly this reason. The JSON view below, which is regenerated on
      // every poll, does carry the count.
      out.push({
        uid: `anniversary-${a.id}@boardroom`, allDay: true, start, end,
        rrule,
        summary: anniversaryKindOf(a.kind) === "passing" ? `In memory: ${a.name}` : a.name || "Anniversary",
        categories: "anniversary",
      });
    }
  }

  if (include.has("upkeep")) {
    for (const it of upkeep) {
      const due = upkeepDue(it);
      if (!due) continue;
      const nx = addDaysYMD(due.y, due.m, due.d, 1);
      out.push({
        uid: `upkeep-${it.id}@boardroom`, allDay: true, start: icsDate(due.y, due.m, due.d),
        end: icsDate(nx.y, nx.m, nx.d), summary: `Upkeep: ${it.name}`, categories: "upkeep",
      });
    }
  }

  return buildIcs(out);
}

// ── JSON view (for a TRMNL Private Plugin, Polling) ──────────────────────────
// `now` is a parameter so scripts/anniversaries-smoke.mjs can pin the day math at
// chosen Chicago evenings and mornings; the handler passes nothing.
function renderJson({ events = [], birthdays = [], anniversaries = [], upkeep = [] }, now = Date.now()) {
  const fmtDateTime = (d) => d.toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  // Whole Chicago calendar days from today to a date stamp (see ymdIn/dayStamp
  // above). 0 is today until Chicago midnight, whatever the hour in UTC.
  const today = dayStamp(ymdIn(now));
  const relDays = (stamp) => Math.round((stamp - today) / 86400000);
  const rel = (n) => (n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 0 ? `${-n}d ago` : `in ${n}d`);

  // Upcoming events — next 14 days, up to 12. Two different notions of "still
  // upcoming", because the two kinds of row store two different things:
  //   · a TIMED event is an instant, kept from an hour before it starts until
  //     the window closes;
  //   · an ALL-DAY event is a date (or a span of dates — end_time holds the
  //     last day, inclusive), kept while its last day is today or later. It
  //     used to be filtered as an instant at its stored midnight, so by ~1am
  //     Chicago on the day itself it was already "an hour ago" and gone: the
  //     device said nothing was scheduled on exactly the day something was.
  const upEvents = (events || [])
    .map(ev => {
      if (ev.all_day) {
        const start = dayStamp(ymdOfSlice(ev.start_time));
        const last = ev.end_time ? Math.max(start, dayStamp(ymdOfSlice(ev.end_time))) : start;
        return { ev, t: start, startDay: relDays(start), lastDay: relDays(last) };
      }
      const t = new Date(ev.start_time).getTime();
      const day = relDays(dayStamp(ymdIn(t)));
      return { ev, t, startDay: day, lastDay: day, keep: t >= now - 3600000 };
    })
    .filter(({ ev, keep, lastDay, startDay }) => (ev.all_day ? lastDay >= 0 : keep) && startDay <= 14)
    .sort((a, b) => a.t - b.t)
    .slice(0, 12)
    .map(({ ev, startDay }) => {
      const d = new Date(ev.start_time);
      // All-day labels come from the date slice, not from TZ-converting the
      // instant (see the note above ymdOfSlice); timed events convert as normal.
      const allDayDate = ev.all_day ? new Date(String(ev.start_time).slice(0, 10) + "T12:00:00Z") : null;
      const dayOpts = { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" };
      return {
        title: ev.title || "(untitled)",
        when: ev.all_day ? allDayDate.toLocaleDateString("en-US", dayOpts) : fmtDateTime(d),
        date: (ev.all_day ? allDayDate : d).toLocaleDateString("en-US", { timeZone: ev.all_day ? "UTC" : TZ, month: "short", day: "numeric" }),
        time: ev.all_day ? "All day" : d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }),
        all_day: !!ev.all_day, category: ev.category || "personal",
        // A span that began before today is happening today, not "2d ago".
        location: ev.location || "", rel: rel(Math.max(startDay, 0)),
      };
    });

  // Birthdays — next 60 days (this year's or next year's occurrence). The year
  // is Chicago's, and "already passed" is a calendar comparison: a birthday
  // today is today, not "an occurrence more than a day ago".
  const yearNow = ymdIn(now).y;
  const upBirthdays = (birthdays || [])
    .filter(b => b.month && b.day)
    .map(b => {
      let occ = annualUTC(yearNow, b.month, b.day);
      if (relDays(occ) < 0) occ = annualUTC(yearNow + 1, b.month, b.day);
      return { b, occ };
    })
    .filter(({ occ }) => relDays(occ) <= 60)
    .sort((a, b) => a.occ - b.occ)
    .slice(0, 8)
    .map(({ b, occ }) => {
      const n = relDays(occ);
      const turning = b.year ? new Date(occ).getUTCFullYear() - b.year : null;
      return {
        name: (b.name || "").replace(/'s birthday|birthday/gi, "").trim() || b.name,
        when: new Date(occ).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }),
        days_until: n, rel: rel(n), turning,
      };
    });

  // Anniversaries — same 60-day window and shape as birthdays above, so a
  // Liquid layout can render either list with the same block. `note` is the
  // finished sentence ("In memory · 5 years"); `kind` is there so a layout can
  // tell a passing from a milestone without parsing English.
  const upAnniversaries = (anniversaries || [])
    .filter(a => a.month && a.day)
    .map(a => {
      let occ = annualUTC(yearNow, a.month, a.day);
      if (relDays(occ) < 0) occ = annualUTC(yearNow + 1, a.month, a.day);
      return { a, occ };
    })
    .filter(({ occ }) => relDays(occ) <= 60)
    .sort((x, y) => x.occ - y.occ)
    .slice(0, 8)
    .map(({ a, occ }) => {
      const n = relDays(occ);
      const occYear = new Date(occ).getUTCFullYear();
      return {
        name: a.name || "Anniversary",
        kind: anniversaryKindOf(a.kind),
        note: anniversaryNote(a, occYear),
        years: anniversaryYears(a, occYear),
        when: new Date(occ).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }),
        days_until: n, rel: rel(n),
      };
    });

  // Upkeep due — anything due within 30 days or already overdue, up to 8. `due`
  // is a date, so an item due today is 0 — not overdue — until Chicago midnight.
  const upUpkeep = (upkeep || [])
    .map(it => ({ it, due: upkeepDue(it) }))
    .filter(({ due }) => due && relDays(due.ts) <= 30)
    .sort((a, b) => a.due.ts - b.due.ts)
    .slice(0, 8)
    .map(({ it, due }) => {
      const n = relDays(due.ts);
      return {
        name: it.name,
        when: new Date(due.ts).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }),
        days_until: n, rel: rel(n), overdue: n < 0,
      };
    });

  return {
    generated_at: new Date().toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    tz: TZ,
    counts: { events: upEvents.length, birthdays: upBirthdays.length, anniversaries: upAnniversaries.length, upkeep: upUpkeep.length },
    events: upEvents,
    birthdays: upBirthdays,
    anniversaries: upAnniversaries,
    upkeep: upUpkeep,
  };
}

// ── Notes view (for the Scriptable notes widget) ─────────────────────────────
// The Home Screen widget is a second homescreen, so by default it shows what the
// first one does: the Brief's Notes tile. Same set — the active shelf, minus
// anything taken Off the Brief — in the same manual order, from
// app_settings.notes_order. A note hidden from the Brief for being too long for a
// landing page is too long for a widget for the same reason, and a widget that
// disagreed with the Brief about which notes are on top would be two answers to
// one question.
//
// DUPLICATED, NOT IMPORTED, for the esbuild reason given above the anniversary
// wording: orderNotes is applyNotesOrder (src/lib/notes-order.js), onBriefNote is
// onBrief (src/lib/notes-shelf.js), and resolveNoteTitle is resolveTitle
// (note-capture.js). scripts/notes-widget-smoke.mjs runs each copy beside its
// original over the same rows and fails the build if they part ways.
const NOTES_CAP = 12; // more than the largest widget can draw
const NOTE_BODY_CAP = 600; // per note in the list — a widget row shows a few lines
const NOTE_ONE_BODY_CAP = 4000; // the single-note widget shows as much as fits
const NOTE_SEALS = ["brass", "green", "blue", "red"]; // NOTE_SEALS in src/ui/shared.jsx

function orderNotes(notes, orderIds) {
  const list = Array.isArray(notes) ? notes.filter(Boolean) : [];
  const order = Array.isArray(orderIds) ? orderIds : [];
  const rank = new Map();
  order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  const known = [], unknown = [];
  for (const n of list) (rank.has(n.id) ? known : unknown).push(n);
  known.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  unknown.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  return [...unknown, ...known];
}
const onBriefNote = (n) => !!n && !n.deleted_at && !n.archived && !n.brief_hidden;

// `&note=` takes the same templates as a watch capture's `into`, so a widget can
// follow the list the watch is filling today: note=Captured — {date}.
function resolveNoteTitle(template, now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", weekday: "short" })
    .formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  const label = `${get("month")} ${get("day")}`;
  return String(template || "")
    .replace(/\{date\}/gi, label).replace(/\{today\}/gi, label)
    .replace(/\{weekday\}/gi, get("weekday")).replace(/\{month\}/gi, get("month"))
    .replace(/\{day\}/gi, get("day")).replace(/\{year\}/gi, get("year"))
    .trim();
}

// Cut on code points, not UTF-16 units, so an emoji at the boundary is dropped
// whole rather than halved into a character the widget draws as a box.
function clipText(s, max) {
  const cps = Array.from(String(s || "").trim());
  return cps.length <= max ? { text: cps.join(""), clipped: false } : { text: cps.slice(0, max).join("").trimEnd(), clipped: true };
}

function noteOut(n, cap) {
  const body = clipText(n.body, cap);
  return {
    id: n.id,
    title: String(n.title || "").trim(),
    body: body.text,
    clipped: body.clipped,
    seal: NOTE_SEALS.includes(n.color) ? n.color : null,
    pinned: !!n.pinned,
    updated_at: n.updated_at || null,
  };
}

// Two modes, one shape — { mode, total, notes: [...] } — so the widget has one
// parser:
//   brief  no `note` asked for: the Brief tile's notes, the first NOTES_CAP of
//          them. `total` counts every note the Brief would show, for "+N more".
//   note   `note` asked for: the one note with that title, case-insensitively.
//          An exact title beats one that merely STARTS with it, so note=Captured
//          follows the newest daily capture list with no template at all. Ties go
//          to an active note over an archived one, then to the newest. Searched
//          across every note not in the bin, Off-the-Brief ones included: the
//          running list hidden from the Brief for being long is the note most
//          worth a widget of its own.
// `now` is a parameter for the same reason renderJson's is.
function renderNotes({ notes = [], order = null } = {}, { note: wanted = "", now = Date.now() } = {}) {
  const live = (notes || []).filter((n) => n && !n.deleted_at);
  const base = {
    generated_at: new Date(now).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    tz: TZ,
  };
  const ask = String(wanted || "").trim();
  if (ask) {
    const match = resolveNoteTitle(ask, now);
    const key = match.toLowerCase();
    const titleOf = (n) => String(n.title || "").trim().toLowerCase();
    const hit = live
      .filter((n) => key && titleOf(n).startsWith(key))
      .sort((a, b) =>
        (titleOf(a) === key ? 0 : 1) - (titleOf(b) === key ? 0 : 1)
        || (a.archived ? 1 : 0) - (b.archived ? 1 : 0)
        || new Date(b.updated_at || 0) - new Date(a.updated_at || 0))[0] || null;
    return { ...base, mode: "note", match, total: hit ? 1 : 0, notes: hit ? [noteOut(hit, NOTE_ONE_BODY_CAP)] : [] };
  }
  const brief = orderNotes(live, order).filter(onBriefNote);
  return { ...base, mode: "brief", total: brief.length, notes: brief.slice(0, NOTES_CAP).map((n) => noteOut(n, NOTE_BODY_CAP)) };
}

// The column ladder db.loadNotes climbs down (0042 → 0036 → 0008 → base), for its
// reason: a migration arrives in the SQL editor by hand and this code arrives on a
// deploy, in either order. A database without brief_hidden shows every active
// note, which is what its Brief shows too; one without deleted_at has no bin.
// Only a MISSING COLUMN steps down a rung. Anything else is a failed read, and
// stepping past it to a narrower select would quietly put hidden notes back.
const NOTE_RUNGS = [
  { cols: "id,title,body,pinned,color,archived,brief_hidden,deleted_at,updated_at", live: true },
  { cols: "id,title,body,pinned,color,archived,deleted_at,updated_at", live: true },
  { cols: "id,title,body,pinned,color,updated_at", live: false },
  { cols: "id,title,body,updated_at", live: false },
];
const isMissingColumn = (e) =>
  /42703|PGRST204/.test(e?.code || "")
  || /column .* does not exist/i.test(e?.message || "")
  || /could not find the .*column/i.test(e?.message || "");

async function loadNotes(supabase, userId) {
  const scope = (q) => (userId ? q.eq("user_id", userId) : q);
  const errors = [];
  const readNotes = async () => {
    for (const rung of NOTE_RUNGS) {
      let q = scope(supabase.from("personal_notes").select(rung.cols));
      if (rung.live) q = q.is("deleted_at", null);
      const r = await q.order("updated_at", { ascending: false });
      if (!r.error) return r.data || [];
      if (!isMissingColumn(r.error)) { errors.push(`personal_notes: ${r.error.message}`); return null; }
    }
    errors.push("personal_notes: none of the known column sets could be read");
    return null;
  };
  // The order is a failed read too when it fails, not "no order": the widget would
  // put different notes on top than the Brief, and say nothing.
  const readOrder = scope(supabase.from("app_settings").select("setting_value").eq("setting_key", "notes_order"))
    .limit(1).maybeSingle().then((r) => {
      if (r.error) { errors.push(`app_settings: ${r.error.message}`); return null; }
      return Array.isArray(r.data?.setting_value) ? r.data.setting_value : null;
    });
  const [notes, order] = await Promise.all([readNotes(), readOrder]);
  return { notes: notes || [], order, errors };
}

// ── Plan view (for the Scriptable plan widget) ───────────────────────────────
// The Daily Plan tab's templates, as stored in app_settings.daily_plan, and
// nothing worked out from them. That is deliberate. A plan is set once and edited
// a few times a year; "now" changes every minute. So the widget keeps the
// templates and decides where the day is on the phone, from the phone's clock —
// which is what lets it redraw at 6:15 sharp with no network at all, and still be
// right on a plane. Worked out here, every redraw would need a fetch, and the
// one at the hard stop is exactly the one a weak signal would lose.
//
// Sent raw rather than normalized because the widget has to carry its own copy
// of normalizePlan/whereAmI anyway (src/features/plan/planLogic.js — it runs
// offline), and one copy is easier to hold to the original than two:
// scripts/plan-widget-smoke.mjs runs the widget against whereAmI at hundreds of
// instants. A missing row is `plan: null`, which the widget draws as "no plan
// yet" — the same thing the Plan tab says about the same row.
async function loadPlan(supabase, userId) {
  const scope = (q) => (userId ? q.eq("user_id", userId) : q);
  const r = await scope(supabase.from("app_settings").select("setting_value,updated_at").eq("setting_key", "daily_plan"))
    .limit(1).maybeSingle();
  if (r.error) return { plan: null, updated_at: null, errors: [`app_settings: ${r.error.message}`] };
  return { plan: r.data?.setting_value ?? null, updated_at: r.data?.updated_at ?? null, errors: [] };
}

// The calendar rows the plan widget's Upcoming list is drawn from — RAW, for the
// same reason the plan is. A repeating event is one stored row with an rrule, and
// expanding it is local-calendar math (src/lib/recurrence.js: "EVERYTHING HERE IS
// LOCAL-CALENDAR MATH"): "every Tuesday at 9" lands at 9 in the zone the person
// lives in, through the night the clocks change. This function runs in UTC; the
// phone runs where the Calendar tab does. So the widget expands, with its own copy
// of recurrence.js held to the original by scripts/plan-widget-smoke.mjs, and this
// only narrows what it is sent: every series (a weekly meeting begun in 2024 is
// still this week's), and each one-off that touches the next two weeks, with two
// days' slack either side for wherever the phone places it.
const PLAN_EVENT_COLS = "id,title,start_time,end_time,all_day,category,rrule,exdates";
function planEventsWindow(rows, now = Date.now()) {
  const lo = now - 2 * 86400000, hi = now + 16 * 86400000;
  return (rows || [])
    .filter((e) => {
      if (!e || !e.start_time) return false;
      if (e.rrule) return true;
      const s = Date.parse(e.start_time);
      if (Number.isNaN(s) || s > hi) return false;
      const end = Date.parse(e.end_time || "");
      return (Number.isNaN(end) ? s : end) >= lo;
    })
    .map((e) => ({
      id: e.id, title: e.title || "(untitled)", start_time: e.start_time, end_time: e.end_time || null,
      all_day: !!e.all_day, category: e.category || "personal", rrule: e.rrule || null,
      exdates: Array.isArray(e.exdates) ? e.exdates : [],
    }));
}
async function loadPlanEvents(supabase, userId, now = Date.now()) {
  const scope = (q) => (userId ? q.eq("user_id", userId) : q);
  const r = await scope(supabase.from("personal_events").select(PLAN_EVENT_COLS));
  if (r.error) return { events: null, error: `personal_events: ${r.error.message}` };
  return { events: planEventsWindow(r.data, now), error: null };
}

// THE PLAN IS THE WIDGET; THE CALENDAR AND THE NOTE ARE ITS COMPANY. A failure
// reading either of them is reported inside the payload (events_error,
// note_error) and the widget says so in that band, rather than the whole answer
// becoming a 502 — a calendar blip is no reason for the day's plan to go blank.
// Only the plan's own read failing is a 502, which is the case the widget's
// cache exists for.
function renderPlan({ plan = null, updated_at = null, events, eventsError, note, noteMatch, noteError } = {}, now = Date.now()) {
  const out = {
    generated_at: new Date(now).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    tz: TZ,
    updated_at,
    plan,
  };
  if (events !== undefined) out.events = events;
  if (eventsError) out.events_error = eventsError;
  // `note` is only in the answer when one was asked for (&note=), so "asked and
  // not found" (null) and "never asked" (absent) stay different things.
  if (note !== undefined) { out.note = note; out.note_match = noteMatch || ""; }
  if (noteError) out.note_error = noteError;
  return out;
}

// ── handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};

  // Health-pill ping (POST {ping:true}), matching the rest of the functions.
  if (event.httpMethod === "POST") {
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    if (body.ping) {
      const missing = [
        !process.env.TRMNL_TOKEN && "TRMNL_TOKEN",
        !process.env.SUPABASE_URL && "SUPABASE_URL",
        !process.env.SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
      ].filter(Boolean).join(" / ");
      return jsonRes(200, { success: true, service: "trmnl", configured: !missing, missing: missing || undefined });
    }
  }

  const token = q.token || event.headers?.["x-board-token"] || event.headers?.["X-Board-Token"];
  // Constant time, the same shape as export-data's secretOk: timingSafeEqual
  // throws on unequal lengths, so those are compared first (a length is not the
  // secret). This was the one shared-secret check in the repo using `!==`.
  const tokenOk = (got, want) => {
    const a = Buffer.from(String(got || ""), "utf8"), b = Buffer.from(String(want), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (!process.env.TRMNL_TOKEN || !tokenOk(token, process.env.TRMNL_TOKEN)) {
    return jsonRes(401, { success: false, error: "Missing or incorrect token." });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonRes(500, { success: false, error: "SUPABASE_SERVICE_ROLE_KEY isn't set in Netlify yet — see the comment at the top of this file." });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "boardroom" } });
  // BOARD_USER_ID last, never null: a null here read EVERY user's rows with the
  // service key, which is harmless only for as long as the shared project has
  // exactly one account.
  const userId = process.env.TRMNL_USER_ID || process.env.MINER_USER_ID || String(process.env.BOARD_USER_ID || "").trim() || null;

  const view = (q.view || "json").toLowerCase();
  // A read that failed is not a day with nothing in it. Refuse to render
  // rather than publish a confident blank to a device that cannot ask again
  // until its next hourly refresh; the 15-minute cache header below would
  // otherwise pin that blank in place long after the blip passed.
  const readFailed = (errors) => ({
    statusCode: 502,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ success: false, error: `couldn't read your data — ${errors.join("; ")}` }),
  });

  try {
    // The notes view reads only the notes. A calendar table that cannot be read
    // is no reason for the notes widget to go blank, and neither is the reverse.
    if (view === "notes") {
      const notes = await loadNotes(supabase, userId);
      if (notes.errors.length) return readFailed(notes.errors);
      // no-store, unlike the views below: a note edited a minute ago still showing
      // its old words on the Home Screen is the one staleness a notes widget can't
      // afford, and iOS already spaces the widget's refreshes out on its own.
      return jsonRes(200, renderNotes(notes, { note: q.note }), { "Cache-Control": "private, no-store" });
    }
    // The plan view, likewise, reads one settings row and nothing else.
    if (view === "plan") {
      // &note=<title> adds one note (the same match the notes widget makes);
      // without it, personal_notes is never read.
      const wantNote = String(q.note || "").trim();
      const [plan, cal, notes] = await Promise.all([
        loadPlan(supabase, userId),
        loadPlanEvents(supabase, userId),
        wantNote ? loadNotes(supabase, userId) : null,
      ]);
      if (plan.errors.length) return readFailed(plan.errors);
      const picked = notes && !notes.errors.length ? renderNotes(notes, { note: wantNote }) : null;
      return jsonRes(200, renderPlan({
        ...plan,
        events: cal.events, eventsError: cal.error,
        ...(wantNote ? {
          note: picked ? picked.notes[0] || null : null,
          noteMatch: picked ? picked.match : wantNote,
          noteError: notes.errors.length ? notes.errors.join("; ") : null,
        } : {}),
      }), { "Cache-Control": "private, no-store" });
    }

    const data = await loadAll(supabase, userId);
    if (data.errors && data.errors.length) return readFailed(data.errors);

    if (view === "ics" || view === "ical" || view === "calendar") {
      const include = new Set((q.include ? q.include.split(",") : ["events", "birthdays", "anniversaries", "upkeep"]).map(s => s.trim()).filter(Boolean));
      const ics = renderIcs(data, include);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'inline; filename="board-room.ics"',
          // PRIVATE, NOT PUBLIC. This is the owner's calendar, birthdays and
          // anniversaries, and the token can arrive in a header the cache does
          // not vary on — `public` let a shared cache hand one token's answer to
          // a request with no token at all. The device only needs its own copy.
          "Cache-Control": "private, max-age=900", // 15 min — TRMNL refreshes hourly anyway
        },
        body: ics,
      };
    }

    return jsonRes(200, renderJson(data), { "Cache-Control": "private, max-age=300" });
  } catch (e) {
    return jsonRes(500, { success: false, error: e.message });
  }
};

// Netlify only reads `handler`. The renderers are exported so
// scripts/anniversaries-smoke.mjs can run them against fixture rows at a chosen
// instant — the day math above was wrong for a year without a smoke to say so —
// and so scripts/notes-widget-smoke.mjs can hold the notes copies to the app's,
// and scripts/plan-widget-smoke.mjs can feed the plan widget the real payload.
exports.renderJson = renderJson;
exports.renderIcs = renderIcs;
exports.renderNotes = renderNotes;
exports.orderNotes = orderNotes;
exports.onBriefNote = onBriefNote;
exports.resolveNoteTitle = resolveNoteTitle;
exports.loadNotes = loadNotes;
exports.renderPlan = renderPlan;
exports.loadPlan = loadPlan;
exports.planEventsWindow = planEventsWindow;
