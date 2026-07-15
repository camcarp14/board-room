// Markets card data — spot gold plus the names worth watching: NVDA, MSTR,
// and Strategy's STRC preferred. Uses Yahoo Finance's public chart endpoint.
// This is unofficial and undocumented (no API key exists for it) — Yahoo could
// change or rate-limit it without notice. Each symbol is fetched independently
// (Promise.allSettled), so one bad ticker leaves an em-dash in its tile
// instead of blanking the whole card.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let cache = { data: null, ts: 0 };
const TTL_MS = 5 * 60 * 1000;

// gold = COMEX front-month future; the three tickers trade on their own tape.
const SYMBOLS = { gold: "GC=F", nvda: "NVDA", mstr: "MSTR", strc: "STRC" };

async function quote(symbol) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" },
  });
  if (!res.ok) throw new Error(`${symbol} ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error(`${symbol} no data`);
  return { price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice };
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "markets", configured: true });

  if (cache.data && Date.now() - cache.ts < TTL_MS) {
    return json(200, { ...cache.data, cached: true });
  }

  const pct = (q) => ((q.price - q.prevClose) / q.prevClose) * 100;
  const pctStr = (q) => `${pct(q) >= 0 ? "+" : ""}${pct(q).toFixed(2)}%`;
  // four-figure prices (gold, MSTR) read best whole; per-share names keep cents.
  const money = (n) => (n >= 1000 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "$" + n.toFixed(2));

  const entries = Object.entries(SYMBOLS);
  const settled = await Promise.allSettled(entries.map(([, sym]) => quote(sym)));
  const payload = { success: true };
  let anyOk = false;
  settled.forEach((r, i) => {
    const key = entries[i][0];
    if (r.status === "fulfilled") {
      anyOk = true;
      const q = r.value, p = pct(q);
      payload[key] = { price: money(q.price), delta: pctStr(q), value: money(q.price), up: p >= 0 };
    } else {
      payload[key] = { price: "—", delta: "", value: "—", up: true };
    }
  });

  if (!anyOk) {
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: "all quotes failed" });
  }
  cache = { data: payload, ts: Date.now() };
  return json(200, payload);
};
