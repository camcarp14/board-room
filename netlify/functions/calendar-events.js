// Upcoming meetings — fetches the calendar_url the user already linked in
// the sidebar and parses it as an iCal (.ics) feed. This is the standard
// way to get a read-only, programmatically-fetchable feed of a calendar —
// e.g. Google Calendar's Settings → "Secret address in iCal format". A
// public HTML calendar page (not an .ics link) won't parse here.
// Dependency-free regex-based parsing, consistent with the rest of this
// codebase (see wire.js for the same approach with RSS).
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
  if (h === undefined) return { date: zoned(y, mo, d, 0, 0, 0, TZ), allDay: true };
  if (z) return { date: new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`), allDay: false };
  return { date: zoned(y, mo, d, h, mi, s, tzid || TZ), allDay: false };
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

function parseIcs(ics) {
  const text = unfold(ics);
  const events = [];
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  for (const block of blocks) {
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
    events.push({
      title: get("SUMMARY") || "(untitled)",
      location: get("LOCATION"),
      start: parsed.date.toISOString(),
      allDay: parsed.allDay,
    });
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
    const events = parseIcs(text)
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
