// Upcoming meetings — fetches the calendar_url the user already linked in
// the sidebar and parses it as an iCal (.ics) feed. This is the standard
// way to get a read-only, programmatically-fetchable feed of a calendar —
// e.g. Google Calendar's Settings → "Secret address in iCal format". A
// public HTML calendar page (not an .ics link) won't parse here.
// Dependency-free regex-based parsing, consistent with the rest of this
// codebase (see wire.js for the same approach with RSS).
//
// Correctness notes (each of these was a real bug):
// · DTSTART;TZID=America/Chicago:…T180000 is a WALL time in that zone — the
//   TZID must be honored, not discarded (discarding it treated 6pm Chicago
//   as 6pm UTC and showed every timed event five/six hours early).
// · Display times are formatted in HOME_TZ, not the server's TZ (UTC).
// · Recurring events (RRULE DAILY/WEEKLY — the shapes real meetings use) are
//   expanded into the window; a weekly standup whose DTSTART is in the past
//   used to never appear at all. EXDATE and RECURRENCE-ID overrides respected.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const HOME_TZ = process.env.HOME_TZ || "America/Chicago";

// Keep in sync with fetch-page.js — inlined, not shared (see tmdb.js's
// esbuild/exports landmine comment).
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|0x[0-9a-f]+$|0\d+\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.|::ffff:169\.254\.)/i;
function badUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return "that's not a valid URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) calendar URLs work here";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOST.test(host) || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") || /^\d+$/.test(host)) return "that host isn't reachable from here";
  return null;
}

// Unfold iCal's line-continuation format (a leading space/tab means "this
// line continues the previous one") before parsing individual properties.
function unfold(ics) {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

// Wall-clock time in an IANA zone → UTC epoch ms. Two-pass Intl offset
// technique — exact except within the DST jump hour itself, which is fine
// for a meetings feed.
function zonedUtcMs(y, mo, d, h, mi, s, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const wallOf = (ms) => {
    const p = {};
    for (const part of dtf.formatToParts(ms)) p[part.type] = part.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  const target = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = target - (wallOf(target) - target);
  ms -= wallOf(ms) - target;
  return ms;
}

// Parses one iCal date-time value with its parameter string. Returns
// { ms, allDay, wall: {y,mo,d,h,mi,s}, tz } or null.
// · …Z            → UTC instant
// · TZID=<zone>   → wall time in that zone
// · floating      → wall time in HOME_TZ (better than the server's UTC)
// · YYYYMMDD      → all-day; ms is UTC midnight of the literal date and MUST
//                   be formatted with timeZone:"UTC" so the date never shifts.
function parseIcsDate(raw, params = "") {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const Y = +y, MO = +mo, D = +d;
  if (h === undefined) return { ms: Date.UTC(Y, MO - 1, D), allDay: true, wall: { y: Y, mo: MO, d: D, h: 0, mi: 0, s: 0 }, tz: "UTC" };
  const H = +h, MI = +mi, S = +s;
  if (z) return { ms: Date.UTC(Y, MO - 1, D, H, MI, S), allDay: false, wall: { y: Y, mo: MO, d: D, h: H, mi: MI, s: S }, tz: "UTC" };
  const tzm = params.match(/TZID=([^;:]+)/i);
  const tz = tzm ? tzm[1].trim() : HOME_TZ;
  let ms;
  try { ms = zonedUtcMs(Y, MO, D, H, MI, S, tz); }
  catch { ms = Date.UTC(Y, MO - 1, D, H, MI, S); } // unknown TZID — degrade to UTC rather than dropping the event
  return { ms, allDay: false, wall: { y: Y, mo: MO, d: D, h: H, mi: MI, s: S }, tz };
}

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Expands an RRULE within [winStart, winEnd]. Supports FREQ=DAILY/WEEKLY with
// INTERVAL, BYDAY, UNTIL, COUNT — the shapes real meeting feeds emit. MONTHLY/
// YEARLY (rare for meetings) are skipped rather than half-supported. Returns
// UTC-ms starts. Occurrences are generated from DTSTART in order so COUNT is
// exact; iteration is capped so a pathological rule can't spin.
function expandRrule(start, rrule, winStart, winEnd, excluded) {
  const parts = {};
  for (const kv of rrule.split(";")) { const [k, v] = kv.split("="); if (k && v) parts[k.toUpperCase()] = v; }
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY") return null; // unsupported — caller falls back to the literal DTSTART
  const interval = Math.max(1, parseInt(parts.INTERVAL || "1", 10) || 1);
  const count = parts.COUNT ? Math.max(1, parseInt(parts.COUNT, 10) || 1) : null;
  let untilMs = null;
  if (parts.UNTIL) { const u = parseIcsDate(parts.UNTIL); untilMs = u ? (u.allDay ? u.ms + 86399000 : u.ms) : null; }

  const { wall, tz } = start;
  const anchor = Date.UTC(wall.y, wall.mo - 1, wall.d); // date-only cursor, DST-proof
  const dayAt = (offsetDays) => {
    const d = new Date(anchor + offsetDays * 86400000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
  };
  const startDow = new Date(anchor).getUTCDay();
  // WEEKLY: BYDAY days sorted by distance from DTSTART's weekday so the
  // sequence is chronological (COUNT depends on that). Default: DTSTART's day.
  const bydays = (freq === "WEEKLY")
    ? (parts.BYDAY ? parts.BYDAY.split(",").map(t => DOW[t.trim().slice(-2).toUpperCase()]).filter(n => n !== undefined) : [startDow])
        .map(dw => (dw - startDow + 7) % 7).sort((a, b) => a - b)
    : [0];

  const out = [];
  let produced = 0;
  for (let iter = 0; iter < 1500; iter++) {
    const base = freq === "DAILY" ? iter * interval : iter * interval * 7;
    let pastWindow = false;
    for (const off of bydays) {
      const day = dayAt(base + off);
      let ms;
      try { ms = start.allDay ? Date.UTC(day.y, day.mo - 1, day.d) : zonedUtcMs(day.y, day.mo, day.d, wall.h, wall.mi, wall.s, tz); }
      catch { ms = Date.UTC(day.y, day.mo - 1, day.d, wall.h, wall.mi, wall.s); }
      if (ms < start.ms) continue; // BYDAY earlier in DTSTART's own week
      produced++;
      if (count && produced > count) return out;
      if (untilMs && ms > untilMs) return out;
      if (ms > winEnd) { pastWindow = true; break; }
      if (ms >= winStart && !excluded.has(ms)) out.push(ms);
    }
    if (pastWindow) break;
  }
  return out;
}

function parseIcs(ics, winStart, winEnd) {
  const text = unfold(ics);
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  const parsedBlocks = [];
  const overriddenByUid = new Map(); // uid → Set of original-occurrence ms replaced by RECURRENCE-ID overrides

  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0];
    const propRaw = (prop) => body.match(new RegExp(`^${prop}((?:;[^:\\n]*)?):(.*)$`, "m"));
    const get = (prop) => {
      const m = propRaw(prop);
      return m ? m[2].trim().replace(/\\,/g, ",").replace(/\\n/gi, " ") : null;
    };
    const dtstartM = propRaw("DTSTART");
    const start = dtstartM ? parseIcsDate(dtstartM[2].trim(), dtstartM[1] || "") : null;
    if (!start) continue;

    const uid = get("UID");
    const recurM = propRaw("RECURRENCE-ID");
    const recurrenceId = recurM ? parseIcsDate(recurM[2].trim(), recurM[1] || "") : null;
    if (uid && recurrenceId) {
      if (!overriddenByUid.has(uid)) overriddenByUid.set(uid, new Set());
      overriddenByUid.get(uid).add(recurrenceId.ms);
    }

    // EXDATE lines (possibly several, each possibly comma-separated)
    const excluded = new Set();
    for (const m of body.matchAll(/^EXDATE((?:;[^:\n]*)?):(.*)$/gm)) {
      for (const v of m[2].split(",")) {
        const ex = parseIcsDate(v.trim(), m[1] || "");
        if (ex) excluded.add(ex.ms);
      }
    }

    parsedBlocks.push({ uid, start, isOverride: !!recurrenceId, rrule: get("RRULE"), excluded, title: get("SUMMARY") || "(untitled)", location: get("LOCATION") });
  }

  const events = [];
  for (const b of parsedBlocks) {
    const push = (ms) => events.push({ title: b.title, location: b.location, ms, allDay: b.start.allDay });
    if (b.rrule && !b.isOverride) {
      // Occurrences replaced by an override VEVENT are excluded here; the
      // override itself lands through its own DTSTART below.
      const replaced = (b.uid && overriddenByUid.get(b.uid)) || new Set();
      const all = new Set([...b.excluded, ...replaced]);
      const occ = expandRrule(b.start, b.rrule, winStart, winEnd, all);
      if (occ) { occ.forEach(push); continue; }
      // unsupported FREQ — fall through to the literal DTSTART
    }
    if (b.start.ms >= winStart && b.start.ms <= winEnd) push(b.start.ms);
  }
  return events;
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "calendar-events", configured: true });
  if (!body.url) return json(200, { success: false, error: "no calendar linked yet — add one in the sidebar" });

  const problem = badUrl(String(body.url).trim());
  if (problem) return json(200, { success: false, error: problem });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(body.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" }, signal: controller.signal });
    if (!res.ok) return json(200, { success: false, error: `calendar returned HTTP ${res.status} — check the link is still valid` });
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) return json(200, { success: false, error: "that URL didn't return an iCal feed — use a .ics link (e.g. Google Calendar's \"Secret address in iCal format\"), not the calendar's web page" });

    const now = Date.now();
    const winStart = now - 3600000; // small grace window for events just starting
    const winEnd = now + 14 * 86400000;
    const events = parseIcs(text, winStart, winEnd)
      .sort((a, b) => a.ms - b.ms)
      .slice(0, 10)
      .map(e => ({
        title: e.title,
        location: e.location,
        when: e.allDay
          ? new Date(e.ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
          : new Date(e.ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: HOME_TZ }),
      }));

    return json(200, { success: true, events });
  } catch (e) {
    return json(200, { success: false, error: e.name === "AbortError" ? "the calendar feed took too long to respond" : e.message });
  } finally {
    clearTimeout(timer);
  }
};
