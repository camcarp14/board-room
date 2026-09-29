// Upcoming meetings — fetches the calendar_url the user already linked in
// the sidebar and parses it as an iCal (.ics) feed. This is the standard
// way to get a read-only, programmatically-fetchable feed of a calendar —
// e.g. Google Calendar's Settings → "Secret address in iCal format". A
// public HTML calendar page (not an .ics link) won't parse here.
// Dependency-free regex-based parsing, consistent with the rest of this
// codebase (see wire.js for the same approach with RSS).
//
// Recurring meetings are expanded into the window (expandRrule below): a
// weekly standup is ONE VEVENT dated the first week it ever ran, and reading
// only its DTSTART meant every standing meeting older than the 14-day window
// never reached the card at all.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// The viewer's zone. Netlify runs this in UTC and netlify.toml sets no TZ, so
// every wall-clock decision here — what day an all-day event is, when a
// floating time is, what the label says — names the zone explicitly rather than
// trusting the box. Same constant, same reason, as calendar.js and trmnl.js.
const TZ = "America/Chicago";

// Calendar URLs are user-provided secrets, so this function has to fetch them
// server-side. Restrict that fetch to public HTTP(S) hosts and re-check every
// redirect; otherwise a signed-in browser can turn this endpoint into a probe
// for the function network.
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;
function badUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return "that's not a valid calendar URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) calendar URLs are supported";
  if (u.username || u.password) return "calendar URLs cannot include credentials";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    PRIVATE_HOST.test(host) || host === "::" || host === "::1" ||
    host.startsWith("::ffff:") || host.startsWith("fe80:") ||
    host.startsWith("fc") || host.startsWith("fd") ||
    host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")
  ) return "that calendar host isn't reachable from here";
  return null;
}

async function fetchPublicUrl(raw, init) {
  let url = raw;
  for (let hop = 0; hop <= 3; hop++) {
    const problem = badUrl(url);
    if (problem) throw new Error(problem);
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    if (hop === 3) throw new Error("calendar redirected too many times");
    url = new URL(location, url).toString();
  }
}

async function readTextLimited(res, maxBytes = 1000000) {
  if (!res.body?.getReader) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("calendar feed is too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error("calendar feed is too large");
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already consumed */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

// Session gate, inlined ON PURPOSE. Under this repo's "type":"module" + esbuild
// bundling, `module.exports` inside a required helper clobbers the bundle's
// exports before `exports.handler` is assigned and the function deploys with NO
// handler — a 502 on every call. See the same note in tmdb.js and
// workout-import.js; btc.js / mini-worker.js work precisely because they are
// self-contained. Do NOT refactor these back into a shared module.
async function denyUnlessSignedIn(event) {
  const url = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const owner = String(process.env.BOARD_USER_ID || "").trim();
  if (!url || !service || !owner) return json(503, { success: false, error: "server owner is not configured" });
  const h = event.headers || {};
  const token = String(h.authorization || h.Authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { success: false, error: "sign in first" });
  try {
    const who = await fetch(`${url}/auth/v1/user`, { signal: AbortSignal.timeout(15000), headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!who.ok) return json(401, { success: false, error: "session expired — refresh and try again" });
    const u = await who.json();
    if (u?.id !== owner) return json(403, { success: false, error: "this account is not allowed to use Board Room" });
    if (mfaShort(u, token)) return json(403, { success: false, error: "two-factor code needed — sign in again and enter your code" });
  } catch {
    return json(503, { success: false, error: "couldn't verify your session — try again in a moment" });
  }
  return null;
}

// Unfold iCal's line-continuation format (a leading space/tab means "this
// line continues the previous one") before parsing individual properties.
function unfold(ics) {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

/**
 * How far `tz` is from UTC at a given instant, in ms. Intl is the only tz
 * database available here and it is a complete one, so no library is needed:
 * format the instant IN the zone, read the wall-clock parts back, and the
 * difference between those parts read as UTC and the instant itself IS the
 * offset. Returns 0 for a zone Intl does not recognise, which degrades to the
 * old behaviour rather than throwing on a malformed feed.
 */
function tzOffsetMs(utcMs, tz) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = {};
    for (const x of dtf.formatToParts(new Date(utcMs))) if (x.type !== "literal") p[x.type] = x.value;
    const hour = p.hour === "24" ? 0 : Number(p.hour);
    const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
    return asUTC - utcMs;
  } catch { return 0; }
}

/**
 * The instant at which wall time y-mo-d h:mi:s occurs IN `tz`. Treat the wall
 * time as UTC, then correct by the zone's offset. Measured twice: the first
 * offset is read at the wrong instant, and on the two DST nights a year that is
 * exactly the hour that would come out wrong.
 */
function zoned(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const once = guess - tzOffsetMs(guess, tz);
  return new Date(guess - tzOffsetMs(once, tz));
}

/**
 * An iCal date, honouring its TZID.
 *
 * THE ZONE USED TO BE THROWN AWAY. The property regex captured the value and
 * discarded the `;TZID=America/Chicago` parameter, so `20260806T140000` was
 * handed to `new Date("2026-08-06T14:00:00")` — parsed in the SERVER's local
 * zone, which in a Netlify function is UTC. A 2pm Chicago meeting was published
 * as 2pm UTC and read back as 9am. Every timed event on a linked calendar was
 * wrong by the UTC offset, in one direction or the other, all year.
 *
 * Four cases:
 *   · trailing Z      — already UTC, unchanged
 *   · TZID=<zone>     — wall time IN that zone, converted here
 *   · neither         — "floating" local time; iCal says interpret it in the
 *                       viewer's zone, and the viewer lives in TZ. This used to
 *                       fall through to `new Date("…T14:00:00")` — the server's
 *                       zone again, the very bug above, for any feed that
 *                       writes times without a TZID.
 *   · date only       — all-day; midnight in TZ, NOT the server's midnight.
 *                       As UTC midnight it fell out of the handler's window at
 *                       8pm Chicago the evening before, so an all-day event was
 *                       gone from the card on its own day.
 */
function parseIcsDate(raw, tzid) {
  if (!raw) return null;
  // All-day events: YYYYMMDD. Timed events: YYYYMMDDTHHMMSS[Z].
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  // `wall` and `zone` ride along for expandRrule: a recurrence repeats the WALL
  // time in the event's own zone ("9am Chicago, every Monday"), not a fixed
  // number of milliseconds, which would slide an hour at each DST change.
  const wall = { y: Number(y), mo: Number(mo), d: Number(d), h: Number(h || 0), mi: Number(mi || 0), s: Number(s || 0) };
  if (h === undefined) return { date: zoned(y, mo, d, 0, 0, 0, TZ), allDay: true, wall, zone: TZ };
  if (z) return { date: new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`), allDay: false, wall, zone: "UTC" };
  return { date: zoned(y, mo, d, h, mi, s, tzid || TZ), allDay: false, wall, zone: tzid || TZ };
}

/**
 * The card's label. `timeZone` on BOTH branches: the instant is right after
 * parseIcsDate, and toLocaleString without a zone formatted it in the server's
 * — UTC — so a 2pm meeting read "7:00 PM" and a 9pm one landed on tomorrow's
 * date. BriefPage prints this string verbatim and never sees `start`.
 */
function formatWhen(e) {
  return e.allDay
    ? new Date(e.start).toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" })
    : new Date(e.start).toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Is this event still worth a row? A timed event stays for an hour past its
 * start (it may be running); an all-day one stays until its Chicago day is
 * over, because it is happening all of that day — measured from start it
 * dropped off the card the morning it happened.
 */
function inWindow(e, now, windowEnd) {
  const t = new Date(e.start).getTime();
  const end = t + (e.allDay ? 86400000 : 3600000);
  return end > now && t <= windowEnd;
}

/* ══ recurrence ═════════════════════════════════════════════════════════════
 * Ported from the expansion on claude/board-room-audit-sxzy38 (86241f5 +
 * 09e3a6a) — the expansion only; that branch's handler had no sign-in check
 * and followed redirects unchecked, and this file's handler is unchanged. What
 * changed in the port: every instant goes through zoned()/TZ above, the walk
 * SEEKS to the window instead of stepping from DTSTART (the branch's
 * 1,500-step cap from DTSTART silently dropped a daily meeting after four
 * years, the same bug recurrence.js once had), and a date-only EXDATE or
 * RECURRENCE-ID matches by day.
 *
 * Supported: FREQ=DAILY and FREQ=WEEKLY, with INTERVAL, BYDAY (a filter on
 * DAILY — "every weekday" — and the days of the week on WEEKLY), WKST, COUNT,
 * UNTIL, EXDATE, and RECURRENCE-ID overrides. MONTHLY and YEARLY are rare for
 * meetings and fall back to their literal DTSTART, exactly as before, rather
 * than being half-supported.
 *
 * Days are counted as whole UTC day numbers (the date arithmetic only — never
 * an instant), so stepping is immune to DST; each day is then turned into an
 * instant with the event's own wall time in its own zone.
 */
const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 86400000;
// A hostile or broken feed must not be able to spin this function. PERIODS
// bounds the walk (a period is one day for DAILY, one INTERVAL of weeks for
// WEEKLY) and OUT bounds what one VEVENT can emit; the card shows ten.
const MAX_RRULE_PERIODS = 3000;
const MAX_RRULE_OUT = 400;

const dayNumOf = (w) => Math.floor(Date.UTC(w.y, w.mo - 1, w.d) / DAY_MS);
const wallOfDayNum = (n) => { const t = new Date(n * DAY_MS); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const dowOfDayNum = (n) => (((n + 4) % 7) + 7) % 7; // day 0 (1970-01-01) was a Thursday

/** RRULE text → { freq, interval, count, until, byday, wkst }, or null when it can't be expanded. */
function parseRrule(raw) {
  const parts = {};
  for (const kv of String(raw || "").split(";")) {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim().toUpperCase()] = kv.slice(i + 1).trim();
  }
  const freq = String(parts.FREQ || "").toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY") return null;
  const interval = Math.min(1000, Math.max(1, parseInt(parts.INTERVAL || "1", 10) || 1));
  const count = parts.COUNT ? Math.max(1, parseInt(parts.COUNT, 10) || 1) : null;
  // "MO", "1MO" and "-1MO" all name Monday; the ordinal only means anything
  // for MONTHLY/YEARLY, which are not expanded here.
  const byday = parts.BYDAY
    ? [...new Set(parts.BYDAY.split(",").map((t) => DOW[t.trim().slice(-2).toUpperCase()]).filter((n) => n !== undefined))]
    : [];
  const wkst = DOW[String(parts.WKST || "MO").toUpperCase()] ?? 1;
  return { freq, interval, count, until: parts.UNTIL || null, byday, wkst };
}

/**
 * The instants of one recurring VEVENT inside [winStart, winEnd] (ms).
 *
 * `start` is its parsed DTSTART. `exMs` holds excluded instants (EXDATE, and
 * occurrences replaced by a RECURRENCE-ID override); `exDays` holds day
 * numbers excluded by a date-only value. Returns null for a rule this cannot
 * expand, so the caller can fall back to the literal DTSTART.
 *
 * COUNT is counted from DTSTART, not from the window — the seek below credits
 * every occurrence it skips, so a window late in a COUNT=10 series still ends
 * on the tenth.
 */
function expandRrule(start, rruleRaw, winStart, winEnd, exMs, exDays) {
  const rule = parseRrule(rruleRaw);
  if (!rule || !start || !start.wall) return null;
  const { wall, zone } = start;
  const startDay = dayNumOf(wall);
  const startMs = start.date.getTime();
  const at = (dayNum) => {
    const w = wallOfDayNum(dayNum);
    if (start.allDay) return zoned(w.y, w.mo, w.d, 0, 0, 0, TZ).getTime();
    if (zone === "UTC") return Date.UTC(w.y, w.mo - 1, w.d, wall.h, wall.mi, wall.s);
    return zoned(w.y, w.mo, w.d, wall.h, wall.mi, wall.s, zone).getTime();
  };

  // UNTIL is inclusive. A date-only UNTIL ends on that DAY; a date-time one at
  // that instant (Z, or wall time in the event's zone when it has none).
  let untilDay = null, untilMs = null;
  if (rule.until) {
    const u = parseIcsDate(rule.until, zone === "UTC" ? null : zone);
    if (u && u.allDay) untilDay = dayNumOf(u.wall);
    else if (u) untilMs = u.date.getTime();
  }

  let base0, offsets, periodDays, filter = null;
  if (rule.freq === "WEEKLY") {
    // Periods start on WKST (Monday by default, RFC 5545) — not on DTSTART's
    // own weekday: striding 14 days from a Wednesday start put a bi-weekly
    // Mon/Wed meeting's Mondays in the off weeks (09e3a6a's fix, kept).
    const startDow = dowOfDayNum(startDay);
    base0 = startDay - ((startDow - rule.wkst + 7) % 7);
    offsets = (rule.byday.length ? rule.byday : [startDow]).map((dw) => (dw - rule.wkst + 7) % 7).sort((a, b) => a - b);
    periodDays = 7 * rule.interval;
  } else {
    base0 = startDay;
    offsets = [0];
    periodDays = rule.interval;
    if (rule.byday.length) filter = new Set(rule.byday);
  }

  // Seek to the period just before the window. With a DAILY+BYDAY filter the
  // number of occurrences skipped is not a closed form, so a COUNT-limited one
  // walks from DTSTART instead (COUNT then bounds the walk).
  const firstPeriod = offsets.filter((o) => base0 + o >= startDay).length;
  const winStartDay = Math.floor(winStart / DAY_MS) - 2; // slack for any zone's offset
  let p = Math.max(0, Math.floor((winStartDay - base0) / periodDays));
  if (filter && rule.count != null) p = 0;
  let produced = p === 0 ? 0 : firstPeriod + (p - 1) * offsets.length;

  const out = [];
  for (let walked = 0; walked < MAX_RRULE_PERIODS; walked++, p++) {
    for (const off of offsets) {
      const day = base0 + p * periodDays + off;
      if (day < startDay) continue;                          // before the series began
      if (filter && !filter.has(dowOfDayNum(day))) continue;
      const ms = at(day);
      if (!Number.isFinite(ms) || ms < startMs) continue;
      produced += 1;
      if (rule.count != null && produced > rule.count) return out;
      if (untilDay != null && day > untilDay) return out;
      if (untilMs != null && ms > untilMs) return out;
      if (ms > winEnd) return out;
      if (ms >= winStart && !exMs.has(ms) && !exDays.has(day)) {
        out.push(ms);
        if (out.length >= MAX_RRULE_OUT) return out;
      }
    }
  }
  return out;
}

/**
 * Every EXDATE (or RECURRENCE-ID) value in a VEVENT body, split into exact
 * instants and whole days. A property may repeat and may carry several
 * comma-separated values, each read with that line's own TZID.
 */
function icsInstants(body, prop) {
  const ms = new Set(), days = new Set();
  for (const m of body.matchAll(new RegExp(`^${prop}((?:;[^:\\n]*)?):(.*)$`, "gm"))) {
    const tzid = ((m[1] || "").match(/;TZID=([^;:]+)/) || [])[1] || null;
    for (const v of m[2].split(",")) {
      const d = parseIcsDate(v.trim(), tzid);
      if (!d) continue;
      if (d.allDay) days.add(dayNumOf(d.wall));
      else ms.add(d.date.getTime());
    }
  }
  return { ms, days };
}

/**
 * Feed text → [{ title, location, start, allDay }].
 *
 * A one-off VEVENT comes back as it always did, wherever it falls — the
 * handler's inWindow decides. A recurring one comes back as its occurrences
 * inside [winStart, winEnd] (default: the day before now to two weeks out, the
 * handler's own window with its all-day grace); there is no finite answer
 * without a window. An override (a VEVENT with RECURRENCE-ID) replaces the
 * occurrence it names and is emitted through its own DTSTART like a one-off —
 * unless it is STATUS:CANCELLED, which is how some feeds delete one instance.
 */
function parseIcs(ics, winStart = Date.now() - DAY_MS, winEnd = Date.now() + 14 * DAY_MS) {
  const text = unfold(ics);
  const blocks = [];
  const replaced = new Map(); // UID → { ms, days } of occurrences an override replaces
  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const get = (prop) => {
      const m = body.match(new RegExp(`^${prop}(?:;[^:\\n]*)?:(.*)$`, "m"));
      return m ? m[1].trim().replace(/\\,/g, ",").replace(/\\n/gi, " ") : null;
    };
    const dtstartLine = (body.match(/^DTSTART((?:;[^:\n]*)?):(.*)$/m) || []);
    const dtstartRaw = dtstartLine[2];
    // TZID=America/Chicago, possibly alongside other parameters.
    const tzid = ((dtstartLine[1] || "").match(/;TZID=([^;:]+)/) || [])[1] || null;
    const parsed = parseIcsDate(dtstartRaw?.trim(), tzid);
    if (!parsed) continue;
    const uid = get("UID");
    const rid = icsInstants(body, "RECURRENCE-ID");
    const isOverride = rid.ms.size + rid.days.size > 0;
    if (isOverride && uid) {
      const r = replaced.get(uid) || { ms: new Set(), days: new Set() };
      rid.ms.forEach((x) => r.ms.add(x));
      rid.days.forEach((x) => r.days.add(x));
      replaced.set(uid, r);
    }
    blocks.push({
      uid, parsed, isOverride,
      cancelled: /^CANCELLED$/i.test(get("STATUS") || ""),
      rrule: isOverride ? null : get("RRULE"),
      ex: icsInstants(body, "EXDATE"),
      title: get("SUMMARY") || "(untitled)",
      location: get("LOCATION"),
    });
  }

  const events = [];
  for (const b of blocks) {
    const push = (ms) => events.push({ title: b.title, location: b.location, start: new Date(ms).toISOString(), allDay: b.parsed.allDay });
    if (b.isOverride && b.cancelled) continue;               // a deleted instance
    if (b.rrule) {
      const r = (b.uid && replaced.get(b.uid)) || { ms: new Set(), days: new Set() };
      const occ = expandRrule(b.parsed, b.rrule, winStart, winEnd,
        new Set([...b.ex.ms, ...r.ms]), new Set([...b.ex.days, ...r.days]));
      if (occ) { occ.forEach(push); continue; }
      // An unsupported FREQ falls through to its literal DTSTART.
    }
    push(b.parsed.date.getTime());
  }
  return events;
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "calendar-events", configured: true });

  // Session required: the caller names the URL we fetch, and the response is
  // somebody's actual calendar.
  const denied = await denyUnlessSignedIn(event);
  if (denied) return denied;
  if (!body.url) return json(200, { success: false, error: "no calendar linked yet — add one in the sidebar" });

  const url = String(body.url).trim();
  const problem = badUrl(url);
  if (problem) return json(400, { success: false, error: problem });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchPublicUrl(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)", Accept: "text/calendar,text/plain;q=0.9,*/*;q=0.1" },
    });
    if (!res.ok) return json(200, { success: false, error: `calendar returned HTTP ${res.status} — check the link is still valid` });
    const text = await readTextLimited(res);
    if (!text.includes("BEGIN:VCALENDAR")) return json(200, { success: false, error: "that URL didn't return an iCal feed — use a .ics link (e.g. Google Calendar's \"Secret address in iCal format\"), not the calendar's web page" });

    const now = Date.now();
    const windowEnd = now + 14 * 86400000;
    // Recurrences are expanded from a day back — inWindow's all-day grace —
    // to the window's end; inWindow then trims exactly as it always has.
    const events = parseIcs(text, now - 86400000, windowEnd)
      .filter(e => inWindow(e, now, windowEnd))
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(0, 10)
      .map(e => ({ title: e.title, location: e.location, when: formatWhen(e) }));

    return json(200, { success: true, events });
  } catch (e) {
    return json(200, { success: false, error: e.name === "AbortError" ? "calendar took too long to respond" : e.message });
  } finally {
    clearTimeout(timer);
  }
};

// Exported only for functions-smoke.mjs. Netlify reads `handler`.
exports.badUrl = badUrl;

// Exported for scripts — Netlify only reads `handler`.
exports.parseIcs = parseIcs;
exports.parseIcsDate = parseIcsDate;
exports.formatWhen = formatWhen;
exports.inWindow = inWindow;
exports.expandRrule = expandRrule;


// TWO-FACTOR, WHEN THE ACCOUNT HAS IT. /auth/v1/user proves the token is real
// and who it belongs to; it does not say whether the code step was passed. Once
// the account has a verified factor, a token still at aal1 (password only — or
// a session minted by one of the other apps on this shared project) is refused.
// With no factor enrolled this never refuses anything. Inlined per function on
// purpose — see the note on shared modules in functions-smoke.
function mfaShort(user, token) {
  const enrolled = Array.isArray(user?.factors) && user.factors.some((f) => f?.status === "verified");
  if (!enrolled) return false;
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")).aal !== "aal2"; }
  catch { return true; }
}
