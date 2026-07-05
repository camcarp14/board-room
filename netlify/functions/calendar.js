// "Watch Today" events — pulls today's US-impact economic calendar from a
// free, unofficial public feed (no key, no signup). This endpoint enforces a
// documented rate limit (as few as 2 requests/5min, shared across everyone
// hitting it — including other sites on Netlify's shared IP pool) and
// returns an HTML "Request Denied" page instead of JSON when exceeded. A
// 20-minute in-memory cache keeps us well under that limit; on failure we
// serve stale cache rather than nothing. The client falls back to labeled
// sample events only if this function has never successfully returned data.
// Times are converted to America/Chicago to match the "CT TIME" label.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const SEV_COLOR = { High: "#F87171", Medium: "#F59E0B", Low: "#D9B15E" };

let cache = { data: null, ts: 0 };
const TTL_MS = 20 * 60 * 1000;

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "calendar", configured: true });

  if (cache.data && Date.now() - cache.ts < TTL_MS) {
    return json(200, { ...cache.data, cached: true });
  }

  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" } });
    const raw = await res.text();
    let rows;
    try { rows = JSON.parse(raw); }
    catch { throw new Error(raw.includes("Request Denied") ? "rate-limited by upstream (shared endpoint) — will retry from cache" : "upstream returned non-JSON"); }
    if (!res.ok) throw new Error(`upstream ${res.status}`);

    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD
    const events = (Array.isArray(rows) ? rows : [])
      .filter(r => r.country === "USD" && (r.impact === "High" || r.impact === "Medium"))
      .filter(r => {
        const d = new Date(r.date);
        return !isNaN(d) && d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" }) === todayStr;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 6)
      .map(r => {
        const d = new Date(r.date);
        const time = isNaN(d) ? "—" : d.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
        const bits = [r.title];
        if (r.forecast) bits.push(`forecast ${r.forecast}`);
        if (r.previous) bits.push(`prior ${r.previous}`);
        return { color: SEV_COLOR[r.impact] || "#9AA6BC", time, text: bits.join(" — ") };
      });

    const payload = { success: true, events }; // events can legitimately be [] on market holidays — that's still a live, correct result
    cache = { data: payload, ts: Date.now() };
    return json(200, payload);
  } catch (e) {
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message });
  }
};
