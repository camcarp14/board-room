// BTC/USDT candles for the chart modal. Binance's public REST klines
// endpoint needs no API key and covers every interval the UI offers
// (5m, 15m, 30m, 1d, 1w) natively — no client-side aggregation needed.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// UI interval -> [Binance interval string, how many candles to pull]
const INTERVAL_MAP = {
  "5m": ["5m", 288],   // ~24h
  "15m": ["15m", 288], // ~3d
  "30m": ["30m", 288], // ~6d
  "1d": ["1d", 180],   // ~6mo
  "1w": ["1w", 156],   // ~3yr
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  if (body.ping) return json(200, { success: true, service: "btc-candles", configured: true });

  const uiInterval = body.interval || "1d";
  const mapped = INTERVAL_MAP[uiInterval];
  if (!mapped) return json(400, { error: `Unsupported interval "${uiInterval}". Use one of: ${Object.keys(INTERVAL_MAP).join(", ")}` });
  const [binanceInterval, limit] = mapped;

  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${binanceInterval}&limit=${limit}`
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Binance responded ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const rows = await res.json();
    // Each row: [openTime, open, high, low, close, volume, closeTime, ...]
    const candles = rows.map(r => ({
      time: Math.floor(r[0] / 1000), // lightweight-charts wants unix seconds
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
    }));
    return json(200, { success: true, interval: uiInterval, candles });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
