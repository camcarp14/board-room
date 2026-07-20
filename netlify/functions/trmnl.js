// ─── TRMNL bridge — publish Board Room data OUT to a TRMNL e-ink device ──────
// The rest of the codebase pulls data IN (calendar-events.js parses an external
// .ics; markets.js reads Yahoo). This does the opposite: it exposes Board
// Room's own Supabase data so a TRMNL dashboard can display it. Two views, one
// endpoint, both GET (TRMNL polls with GET, no body):
//
//   ?view=ics   → a text/calendar (.ics) feed of your calendar events, plus
//                 birthdays (yearly-recurring) and upkeep due-dates as all-day
//                 events. Point TRMNL's native "Calendar" plugin at this URL and
//                 you get the exact month-grid render shown on the device today,
//                 but sourced from Board Room instead of Google Calendar.
//
//   ?view=json  → a compact JSON brief (upcoming events + birthdays + upkeep
//                 due) for a TRMNL "Private Plugin" set to Polling. You write the
//                 Liquid layout once (see trmnl/board-brief.liquid) and TRMNL
//                 renders a custom multi-widget Board Room screen. Default view.
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
// shows (the UTC date slice — see CalendarPanel's all-day day-key), so the feed
// lands events on the same day the app does.
const icsDate = (y, m, d) => `${y}${pad(m)}${pad(d)}`;
function addDaysYMD(y, m, d, delta) {
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

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
  const [events, birthdays, upkeep] = await Promise.all([
    scope(supabase.from("personal_events").select("id,title,notes,start_time,end_time,all_day,location,category")).then(r => r.data || []),
    scope(supabase.from("personal_birthdays").select("id,name,month,day,year")).then(r => r.data || []),
    scope(supabase.from("upkeep_items").select("id,name,interval_days,last_done")).then(r => r.data || []),
  ]);
  return { events, birthdays, upkeep };
}

// ── ICS view ─────────────────────────────────────────────────────────────────
function renderIcs({ events, birthdays, upkeep }, include) {
  const out = [];

  if (include.has("events")) {
    for (const ev of events) {
      const allDay = !!ev.all_day;
      let start, end;
      if (allDay) {
        const [y, m, d] = String(ev.start_time).slice(0, 10).split("-").map(Number);
        start = icsDate(y, m, d);
        const nx = addDaysYMD(y, m, d, 1); // DTEND is exclusive for DATE values
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
      const start = icsDate(thisYear, b.month, b.day);
      const nx = addDaysYMD(thisYear, b.month, b.day, 1);
      out.push({
        uid: `birthday-${b.id}@boardroom`, allDay: true, start, end: icsDate(nx.y, nx.m, nx.d),
        rrule: "FREQ=YEARLY",
        summary: `${b.name}${/birthday/i.test(b.name || "") ? "" : "'s Birthday"}`,
        categories: "birthday",
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
function renderJson({ events, birthdays, upkeep }) {
  const now = Date.now();
  const fmtDay = (d, opts) => d.toLocaleDateString("en-US", { timeZone: TZ, ...opts });
  const fmtDateTime = (d) => d.toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const relDays = (ms) => Math.round((ms - now) / 86400000);
  const rel = (n) => (n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 0 ? `${-n}d ago` : `in ${n}d`);

  // Upcoming events — next 14 days, up to 12.
  const windowEnd = now + 14 * 86400000;
  const upEvents = (events || [])
    .map(ev => ({ ev, t: new Date(ev.start_time).getTime() }))
    .filter(({ t }) => t >= now - 3600000 && t <= windowEnd)
    .sort((a, b) => a.t - b.t)
    .slice(0, 12)
    .map(({ ev, t }) => {
      const d = new Date(ev.start_time);
      // All-day events are stored at UTC midnight; the app keys them by the UTC
      // date slice (see CalendarPanel), so format all-day labels from that slice
      // rather than TZ-converting — otherwise a UTC-midnight event reads as the
      // previous day in America/Chicago. Timed events convert to TZ as normal.
      const allDayDate = ev.all_day ? new Date(String(ev.start_time).slice(0, 10) + "T12:00:00Z") : null;
      const dayOpts = { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" };
      return {
        title: ev.title || "(untitled)",
        when: ev.all_day ? allDayDate.toLocaleDateString("en-US", dayOpts) : fmtDateTime(d),
        date: (ev.all_day ? allDayDate : d).toLocaleDateString("en-US", { timeZone: ev.all_day ? "UTC" : TZ, month: "short", day: "numeric" }),
        time: ev.all_day ? "All day" : d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }),
        all_day: !!ev.all_day, category: ev.category || "personal",
        location: ev.location || "", rel: rel(relDays(t)),
      };
    });

  // Birthdays — next 60 days (this year's or next year's occurrence).
  const yearNow = new Date().getUTCFullYear();
  const upBirthdays = (birthdays || [])
    .filter(b => b.month && b.day)
    .map(b => {
      let occ = Date.UTC(yearNow, b.month - 1, b.day);
      if (occ < now - 86400000) occ = Date.UTC(yearNow + 1, b.month - 1, b.day);
      return { b, occ };
    })
    .filter(({ occ }) => occ - now <= 60 * 86400000)
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

  // Upkeep due — anything due within 30 days or already overdue, up to 8.
  const upUpkeep = (upkeep || [])
    .map(it => ({ it, due: upkeepDue(it) }))
    .filter(({ due }) => due && (due.ts - now) <= 30 * 86400000)
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
    counts: { events: upEvents.length, birthdays: upBirthdays.length, upkeep: upUpkeep.length },
    events: upEvents,
    birthdays: upBirthdays,
    upkeep: upUpkeep,
  };
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
  if (!process.env.TRMNL_TOKEN || token !== process.env.TRMNL_TOKEN) {
    return jsonRes(401, { success: false, error: "Missing or incorrect token." });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonRes(500, { success: false, error: "SUPABASE_SERVICE_ROLE_KEY isn't set in Netlify yet — see the comment at the top of this file." });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const userId = process.env.TRMNL_USER_ID || process.env.MINER_USER_ID || null;

  try {
    const data = await loadAll(supabase, userId);
    const view = (q.view || "json").toLowerCase();

    if (view === "ics" || view === "ical" || view === "calendar") {
      const include = new Set((q.include ? q.include.split(",") : ["events", "birthdays", "upkeep"]).map(s => s.trim()).filter(Boolean));
      const ics = renderIcs(data, include);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'inline; filename="board-room.ics"',
          "Cache-Control": "public, max-age=900", // 15 min — TRMNL refreshes hourly anyway
        },
        body: ics,
      };
    }

    return jsonRes(200, renderJson(data), { "Cache-Control": "public, max-age=300" });
  } catch (e) {
    return jsonRes(500, { success: false, error: e.message });
  }
};
