// "The Wire" headlines — pulls real RSS from CoinDesk + Cointelegraph (both
// free, public, no key) and tags each headline by keyword matching. No AI
// summarization — keeps this free and fast. Regex-based XML parsing to avoid
// adding a dependency, consistent with the rest of this codebase.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const FEEDS = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
];

function stripCdata(s) {
  return (s || "").replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

function parseRss(xml, source) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 8) {
    const block = m[1];
    const title = stripCdata((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
    if (title) items.push({ title, pubDate, source });
  }
  return items;
}

function tag(title) {
  const t = title.toLowerCase();
  if (/hack|exploit|breach|drain/.test(t)) return { tag: "SECURITY", color: "#F87171" };
  if (/sec\b|regulat|lawsuit|court|etf approv/.test(t)) return { tag: "REGULATORY", color: "#F59E0B" };
  if (/fed\b|rate cut|inflation|jobs report|cpi|treasury/.test(t)) return { tag: "MACRO", color: "#3B82F6" };
  if (/breaking/.test(t)) return { tag: "BREAKING", color: "#F87171" };
  return { tag: "WIRE", color: "#9AA6BC" };
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "wire", configured: true });

  try {
    const results = await Promise.allSettled(FEEDS.map(async (f) => {
      const res = await fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" } });
      if (!res.ok) throw new Error(`${f.source} ${res.status}`);
      return parseRss(await res.text(), f.source);
    }));
    const items = results.filter(r => r.status === "fulfilled").flatMap(r => r.value);
    if (!items.length) throw new Error("no feeds returned items");

    const wire = items
      .map(it => ({ ...it, ts: new Date(it.pubDate).getTime() || 0 }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 6)
      .map(it => {
        const { tag: t, color } = tag(it.title);
        const time = it.ts ? new Date(it.ts).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
        return { time, tag: t, tagColor: color, text: `${it.title} (${it.source})` };
      });

    return json(200, { success: true, wire });
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
