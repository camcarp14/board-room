// BTC/USD candles for the chart modal, via Kraken's public OHLC endpoint.
// No API key needed. Switched from Binance after discovering Binance
// geo-blocks requests from US server infrastructure (HTTP 451) — which is
// exactly where Netlify Functions run, regardless of where the person
// viewing the dashboard actually is. Kraken has no such restriction and
// its interval options map directly onto the five this UI offers.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// UI interval -> Kraken interval in minutes
const INTERVAL_MAP = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1d": 1440,
  "1w": 10080,
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  if (body.ping) return json(200, { success: true, service: "btc-candles", configured: true });

  const uiInterval = body.interval || "1d";
  const krakenInterval = INTERVAL_MAP[uiInterval];
  if (!krakenInterval) return json(400, { error: `Unsupported interval "${uiInterval}". Use one of: ${Object.keys(INTERVAL_MAP).join(", ")}` });

  try {
    const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${krakenInterval}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kraken responded ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const data = await res.json();
    if (data.error && data.error.length) throw new Error(data.error.join("; "));

    // Kraken nests the candle array under a dynamic pair-name key
    // (e.g. "XXBTZUSD") alongside a "last" cursor field — grab the
    // one key that isn't "last".
    const pairKey = Object.keys(data.result || {}).find(k => k !== "last");
    const rows = pairKey ? data.result[pairKey] : [];

    // Each row: [time, open, high, low, close, vwap, volume, count]
    const candles = rows.map(r => ({
      time: r[0], // already unix seconds
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[6]),
    }));
    return json(200, { success: true, interval: uiInterval, candles });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
