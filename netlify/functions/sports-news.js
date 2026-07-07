// Sports News tile — pulls ESPN's news feed for whichever leagues you're
// actually following (same league list the Sports tile uses), not a fixed
// hardcoded set. Mirrors wire.js's shape/pattern on purpose for consistency.

const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let cache = { data: null, ts: 0, key: "" };
const TTL_MS = 15 * 60 * 1000;

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "sports-news", configured: true });

  const leagues = body.leagues || []; // [{sport, league, displayName}]
  if (!leagues.length) return json(200, { success: true, news: [] });

  const cacheKey = JSON.stringify(leagues.map(l => `${l.sport}/${l.league}`).sort());
  if (cache.data && cache.key === cacheKey && Date.now() - cache.ts < TTL_MS) {
    return json(200, { ...cache.data, cached: true });
  }

  try {
    const results = await Promise.allSettled(leagues.map(async (l) => {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${l.sport}/${l.league}/news`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" },
      });
      if (!res.ok) throw new Error(`${l.league} news ${res.status}`);
      const data = await res.json();
      return (data?.articles || []).slice(0, 8).map(a => ({
        headline: a.headline, link: a.links?.web?.href || null,
        published: a.published, league: l.displayName || l.league.toUpperCase(),
      }));
    }));
    const items = results.filter(r => r.status === "fulfilled").flatMap(r => r.value);
    if (!items.length) throw new Error("no news returned");

    const news = items
      .sort((a, b) => new Date(b.published) - new Date(a.published))
      .slice(0, 20)
      .map(a => ({
        time: a.published ? new Date(a.published).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false }) : "—",
        league: a.league, text: a.headline, link: a.link,
      }));

    const payload = { success: true, news };
    cache = { data: payload, ts: Date.now(), key: cacheKey };
    return json(200, payload);
  } catch (e) {
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message });
  }
};
