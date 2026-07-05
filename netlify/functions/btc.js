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
    const [priceRes, chartRes] = await Promise.all([
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true"),
      fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1"),
    ]);
    if (!priceRes.ok || !chartRes.ok) throw new Error(`upstream ${priceRes.status}/${chartRes.status}`);
    const priceData = await priceRes.json();
    const chartData = await chartRes.json();
    const raw = (chartData.prices || []).map(([, p]) => p);
    const step = Math.max(1, Math.floor(raw.length / 48));
    const points = raw.filter((_, i) => i % step === 0);

    const payload = {
      success: true,
      price: priceData.bitcoin?.usd ?? null,
      changePct: priceData.bitcoin?.usd_24h_change ?? null,
      points,
    };
    cache = { data: payload, ts: Date.now() };
    return json(200, payload);
  } catch (e) {
    // Serve stale cache rather than nothing if the upstream call fails.
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message });
  }
};
