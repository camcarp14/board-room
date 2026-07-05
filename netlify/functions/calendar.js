// "Watch Today" events — pulls today's US-impact economic calendar from a
// free, unofficial public feed (no key, no signup). This endpoint is
// undocumented and could change; the client falls back to labeled sample
// events if it fails. Times are converted to America/Chicago to match the
// "CT TIME" label already in the UI.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const SEV_COLOR = { High: "#F87171", Medium: "#F59E0B", Low: "#D9B15E" };

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "calendar", configured: true });

  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" } });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const rows = await res.json();
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

    return json(200, { success: true, events });
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
