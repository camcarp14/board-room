// Proxies CoinGecko so requests come from Netlify's IP instead of the
// visitor's. CoinGecko's free tier rate-limits by IP, and mobile carrier
// NAT IPs are frequently shared across many phones — so mobile visitors get
// throttled far more often than a desktop on home wifi hitting the same
// endpoint. A short in-memory cache (per warm container) smooths bursts;
// a cold start just refetches, which is fine.
let cache = { data: null, ts: 0 };
const TTL_MS = 45 * 1000;

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "btc", configured: true });

  if (cache.data && Date.now() - cache.ts < TTL_MS) {
    return json(200, { ...cache.data, cached: true });
  }

  try {
    const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";
    const CHART_URL = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1";
    const [priceRes, chartRes] = await Promise.all([
      fetch(PRICE_URL, { signal: AbortSignal.timeout(8000), headers: cgHeaders(PRICE_URL) }).catch(() => null),
      fetch(CHART_URL, { signal: AbortSignal.timeout(8000), headers: cgHeaders(CHART_URL) }),
    ]);
    // THE CHART CARRIES THE PRICE TOO. /simple/price started answering keyless
    // callers with a 403 on 2026-09-29 (see cgHeaders) while /market_chart did
    // not, and requiring both took the whole BTC tile down. The chart's last
    // point is at most ~5 minutes old and its first is 24h back, which is price
    // and 24h change; /simple/price is used when it answers, and only then.
    if (!chartRes.ok) throw new Error(`upstream chart ${chartRes.status}`);
    const chartData = await chartRes.json();
    const priceData = priceRes && priceRes.ok ? await priceRes.json().catch(() => null) : null;
    const raw = (chartData.prices || []).map(([, p]) => p);
    const step = Math.max(1, Math.floor(raw.length / 48));
    const points = raw.filter((_, i) => i % step === 0);
    const high24 = raw.length ? Math.max(...raw) : null;
    const low24 = raw.length ? Math.min(...raw) : null;

    const first = raw.length ? raw[0] : null, last = raw.length ? raw[raw.length - 1] : null;
    const payload = {
      success: true,
      price: priceData?.bitcoin?.usd ?? last,
      changePct: priceData?.bitcoin?.usd_24h_change ?? (first && last ? ((last - first) / first) * 100 : null),
      points,
      high24,
      low24,
    };
    cache = { data: payload, ts: Date.now() };
    return json(200, payload);
  } catch (e) {
    // Serve stale cache rather than nothing if the upstream call fails.
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message });
  }
};

// COINGECKO'S KEY, WHEN THERE IS ONE. On 2026-09-29 around 04:00 UTC CoinGecko
// began refusing keyless calls to /coins/markets and /simple/price (a CloudFront
// "Request blocked" 403, from Netlify and from home alike) while /global,
// /categories, /market_chart and /ohlc kept answering. A free Demo key
// (COINGECKO_API_KEY in Netlify) restores them; it is sent only to CoinGecko's
// own host, never to the other feeds that share a fetch helper. Inlined per
// function on purpose — see the note on shared modules in functions-smoke.
function cgHeaders(url) {
  const key = process.env.COINGECKO_API_KEY;
  return key && /(^|\/\/)api\.coingecko\.com\//.test(String(url)) ? { "x-cg-demo-api-key": key } : {};
}
