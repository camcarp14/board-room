// Stocks · Day Outlook data — S&P/Nasdaq futures, 10Y yield, DXY.
// Uses Yahoo Finance's public chart endpoint. This is unofficial and
// undocumented (no API key exists for it) — Yahoo could change or rate-limit
// it without notice. No paid alternative is wired in; if this starts
// failing, the client falls back to labeled sample data automatically.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let cache = { data: null, ts: 0 };
const TTL_MS = 5 * 60 * 1000;

const SYMBOLS = { spx: "ES=F", ndq: "NQ=F", tnx: "^TNX", dxy: "DX-Y.NYB" };

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

  try {
    const [spx, ndq, tnx, dxy] = await Promise.all(Object.values(SYMBOLS).map(quote));
    const pct = (q) => ((q.price - q.prevClose) / q.prevClose) * 100;
    const payload = {
      success: true,
      spx: { value: `${pct(spx) >= 0 ? "+" : ""}${pct(spx).toFixed(2)}%`, price: spx.price.toLocaleString(undefined, { maximumFractionDigits: 1 }), up: pct(spx) >= 0 },
      ndq: { value: `${pct(ndq) >= 0 ? "+" : ""}${pct(ndq).toFixed(2)}%`, price: ndq.price.toLocaleString(undefined, { maximumFractionDigits: 1 }), up: pct(ndq) >= 0 },
      // ^TNX quotes the 10-year yield ×10 (a legacy CBOE convention) — divide to get the real yield.
      tnx: { value: `${(tnx.price / 10).toFixed(2)}%`, price: `${(tnx.price / 10).toFixed(2)}%`, up: tnx.price >= tnx.prevClose },
      dxy: { value: dxy.price.toFixed(1), price: dxy.price.toFixed(1), up: pct(dxy) >= 0 },
    };
    cache = { data: payload, ts: Date.now() };
    return json(200, payload);
  } catch (e) {
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message });
  }
};
