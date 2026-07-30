// "Watch This Week" events — US-impact economic calendar rows from the last 18
// hours through the next 7 days, from a free unofficial public feed (no key, no
// signup). Only "ff_calendar_thisweek.json" is confirmed to exist; there's no
// documented "nextweek" endpoint, so if today is late in the current week, a
// second speculative fetch is attempted but never required — on any failure it
// silently falls back to whatever "thisweek" already covers, rather than risk an
// unconfirmed URL against a strict shared rate limit (as few as 2 requests/5min,
// shared across everyone hitting it — including other sites on Netlify's shared
// IP pool). A 20-minute in-memory cache keeps us well under that limit; on
// failure we serve stale cache rather than nothing. Times are America/Chicago.
//
// WHAT THIS FEED DOES NOT HAVE: the released number.
//
// ff_calendar_*.json (and its .xml twin) carry title / country / date / impact /
// forecast / previous — and nothing else. There is no `actual` field, on any
// row, however long ago the event printed; the released figure only exists on
// ForexFactory's own calendar page. This function used to read `r.actual`,
// therefore always got undefined, and published every already-happened event as
// "past, and still no number" — which the Brief renders as "check back after the
// print lands", forever, until the row ages out of the window. The post-event
// state was unreachable by construction.
//
// So this function no longer pretends. It says honestly what each row IS, and
// econ-result.js resolves what actually happened (one web-searched lookup per
// released event, cached):
//
//   numeric: true  → a figure is coming; the feed quoted a forecast or a prior
//   numeric: false → there is no figure, ever — a statement, a press conference,
//                    a speech, minutes, an auction, a holiday. "Awaiting a
//                    number" is the wrong state for one of these, and it was the
//                    state two of the three FOMC rows sat in all evening.
//
// `at` (ISO) ships alongside the display string so the client decides what has
// passed against ITS clock — with a 20-minute cache, a server-computed isPast
// can be a third of an hour behind the truth.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const SEV_COLOR = { High: "#F87171", Medium: "#F59E0B", Low: "#D9B15E" };

let cache = { data: null, ts: 0 };
const TTL_MS = 20 * 60 * 1000;

// 18h back, not 12: the point of keeping released events on the card is reading
// them in the evening, and an 8:30am print was dropping off before the day was.
const PAST_MS = 18 * 3600 * 1000;
const AHEAD_MS = 7 * 86400 * 1000;
const MAX_ROWS = 20;
const MAX_PAST = 8; // released rows get their own budget — see windowRows

// Titles that never carry a figure, even when the feed quotes a "previous"
// (FOMC Meeting Minutes being the one that does). Everything else falls back to
// the feed's own signal: no forecast and no prior means no number is coming.
const NON_NUMERIC = /\b(speaks?|speech|remarks|address|testimony|testifies|statement|press conference|minutes|holiday|auction|symposium|panel|vote)\b/i;

/** Does a figure exist for this row, ever? Drives the Awaiting vs Landed split. */
function isNumericRow(row) {
  const has = !!(String(row?.forecast ?? "").trim() || String(row?.previous ?? "").trim());
  return has && !NON_NUMERIC.test(String(row?.title ?? ""));
}

/**
 * US high/medium rows inside the window, sorted, capped.
 *
 * Past rows get their own cap. A single shared cap over an ascending sort meant
 * a busy morning of releases could spend the whole budget on events that had
 * already happened and push the rest of the week off the card entirely.
 */
function windowRows(rows, nowMs) {
  const start = nowMs - PAST_MS;
  const end = nowMs + AHEAD_MS;
  const inWindow = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.country === "USD" && (r.impact === "High" || r.impact === "Medium"))
    .map((r) => ({ r, t: Date.parse(r.date) }))
    .filter((x) => Number.isFinite(x.t) && x.t >= start && x.t <= end)
    .sort((a, b) => a.t - b.t);
  const past = inWindow.filter((x) => x.t <= nowMs).slice(-MAX_PAST);
  const ahead = inWindow.filter((x) => x.t > nowMs).slice(0, Math.max(0, MAX_ROWS - past.length));
  return [...past, ...ahead];
}

/** One feed row → the shape the Brief renders. Pure, so the smoke can assert it. */
function toEvent({ r, t }, nowMs) {
  const d = new Date(t);
  const day = d.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  const forecast = String(r.forecast ?? "").trim() || null;
  const previous = String(r.previous ?? "").trim() || null;
  const bits = [r.title];
  if (forecast) bits.push(`forecast ${forecast}`);
  if (previous) bits.push(`prior ${previous}`);
  return {
    // Stable identity for the client's result cache: the instant plus the title.
    // Deliberately NOT the forecast — a forecast revision must not orphan a
    // number we already resolved for this event.
    id: `${d.toISOString()}|${r.title}`,
    at: d.toISOString(),
    title: r.title,
    forecast,
    previous,
    numeric: isNumericRow(r),
    impact: r.impact,
    color: SEV_COLOR[r.impact] || "#9AA6BC",
    time: `${day} · ${time}`,
    text: bits.join(" — "),
    isPast: t <= nowMs, // advisory only — the client re-derives this from `at`
  };
}

async function fetchWeek(name) {
  const res = await fetch(`https://nfs.faireconomy.media/ff_calendar_${name}.json`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" } });
  const raw = await res.text();
  // Check status BEFORE parsing — a 429/500 returns an HTML "Request Denied"
  // page, and parsing it first threw a JSON SyntaxError that masked the real
  // upstream status (the throw below was unreachable).
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const rows = JSON.parse(raw);
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
    const nowMs = Date.now();
    // If the confirmed feed doesn't reach the end of our 7-day window (i.e.
    // today is late in the current week), try to extend it. Never required.
    const latestCovered = rows.reduce((max, r) => { const t = Date.parse(r.date); return Number.isFinite(t) && t > max ? t : max; }, 0);
    if (latestCovered < nowMs + AHEAD_MS) {
      try { rows = rows.concat(await fetchWeek("nextweek")); } catch { /* unconfirmed endpoint — fine if it doesn't exist */ }
    }

    const events = windowRows(rows, nowMs).map((x) => toEvent(x, nowMs));

    const payload = { success: true, events }; // events can legitimately be [] on a quiet week — that's still a live, correct result
    cache = { data: payload, ts: Date.now() };
    return json(200, payload);
  } catch (e) {
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message.includes("Unexpected") ? "rate-limited by upstream (shared endpoint) — will retry from cache" : e.message });
  }
};

// Exported for scripts/functions-smoke.mjs only — Netlify reads `handler`.
exports.isNumericRow = isNumericRow;
exports.windowRows = windowRows;
exports.toEvent = toEvent;
