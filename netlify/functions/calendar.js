// "Watch This Week" events — pulls US-impact economic calendar events from
// today through the next 7 days, from a free unofficial public feed (no
// key, no signup). Only "ff_calendar_thisweek.json" is confirmed to exist;
// there's no documented "nextweek" endpoint, so if today is late in the
// current week, a second speculative fetch is attempted but never required —
// on any failure it silently falls back to whatever "thisweek" already
// covers, rather than risk an unconfirmed URL against a strict shared rate
// limit (as few as 2 requests/5min, shared across everyone hitting it —
// including other sites on Netlify's shared IP pool). A 20-minute in-memory
// cache keeps us well under that limit; on failure we serve stale cache
// rather than nothing. Times are converted to America/Chicago.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const SEV_COLOR = { High: "#F87171", Medium: "#F59E0B", Low: "#D9B15E" };

let cache = { data: null, ts: 0 };
const TTL_MS = 20 * 60 * 1000;

async function fetchWeek(name) {
  const res = await fetch(`https://nfs.faireconomy.media/ff_calendar_${name}.json`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" } });
  const raw = await res.text();
  const rows = JSON.parse(raw); // throws on "Request Denied" HTML or any non-JSON — caller decides what to do
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return Array.isArray(rows) ? rows : [];
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "calendar", configured: true });

  if (cache.data && Date.now() - cache.ts < TTL_MS) {
    return json(200, { ...cache.data, cached: true });
  }

  try {
    let rows = await fetchWeek("thisweek"); // required — if this fails, the whole call fails
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 7 * 86400000);
    // If the confirmed feed doesn't reach the end of our 7-day window (i.e.
    // today is late in the current week), try to extend it. Never required.
    const latestCovered = rows.reduce((max, r) => { const d = new Date(r.date); return !isNaN(d) && d > max ? d : max; }, new Date(0));
    if (latestCovered < windowEnd) {
      try { rows = rows.concat(await fetchWeek("nextweek")); } catch { /* unconfirmed endpoint — fine if it doesn't exist */ }
    }

    const events = rows
      .filter(r => r.country === "USD" && (r.impact === "High" || r.impact === "Medium"))
      .filter(r => { const d = new Date(r.date); return !isNaN(d) && d >= now && d <= windowEnd; })
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 12)
      .map(r => {
        const d = new Date(r.date);
        const day = d.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" });
        const time = d.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
        const bits = [r.title];
        if (r.forecast) bits.push(`forecast ${r.forecast}`);
        if (r.previous) bits.push(`prior ${r.previous}`);
        return { color: SEV_COLOR[r.impact] || "#9AA6BC", time: `${day} · ${time}`, text: bits.join(" — ") };
      });

    const payload = { success: true, events }; // events can legitimately be [] on a quiet week — that's still a live, correct result
    cache = { data: payload, ts: Date.now() };
    return json(200, payload);
  } catch (e) {
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message.includes("Unexpected") ? "rate-limited by upstream (shared endpoint) — will retry from cache" : e.message });
  }
};
