// Upcoming meetings — fetches the calendar_url the user already linked in
// the sidebar and parses it as an iCal (.ics) feed. This is the standard
// way to get a read-only, programmatically-fetchable feed of a calendar —
// e.g. Google Calendar's Settings → "Secret address in iCal format". A
// public HTML calendar page (not an .ics link) won't parse here.
// Dependency-free regex-based parsing, consistent with the rest of this
// codebase (see wire.js for the same approach with RSS).
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Unfold iCal's line-continuation format (a leading space/tab means "this
// line continues the previous one") before parsing individual properties.
function unfold(ics) {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function parseIcsDate(raw) {
  if (!raw) return null;
  // All-day events: YYYYMMDD. Timed events: YYYYMMDDTHHMMSS[Z].
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { date: new Date(`${y}-${mo}-${d}T00:00:00`), allDay: true };
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? "Z" : ""}`;
  return { date: new Date(iso), allDay: false };
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
    const dtstartRaw = (body.match(/^DTSTART(?:;[^:\n]*)?:(.*)$/m) || [])[1];
    const parsed = parseIcsDate(dtstartRaw?.trim());
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
  if (!body.url) return json(200, { success: false, error: "no calendar linked yet — add one in the sidebar" });

  try {
    const res = await fetch(body.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" } });
    if (!res.ok) return json(200, { success: false, error: `calendar returned HTTP ${res.status} — check the link is still valid` });
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) return json(200, { success: false, error: "that URL didn't return an iCal feed — use a .ics link (e.g. Google Calendar's \"Secret address in iCal format\"), not the calendar's web page" });

    const now = Date.now();
    const windowEnd = now + 14 * 86400000;
    const events = parseIcs(text)
      .filter(e => { const t = new Date(e.start).getTime(); return t >= now - 3600000 && t <= windowEnd; }) // small grace window for events just starting
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(0, 10)
      .map(e => ({
        title: e.title,
        location: e.location,
        when: e.allDay
          ? new Date(e.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
          : new Date(e.start).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      }));

    return json(200, { success: true, events });
  } catch (e) {
    return json(200, { success: false, error: e.message });
  }
};
