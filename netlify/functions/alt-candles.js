// Altcoin candles for the chart modal, via CoinGecko's keyless OHLC endpoint.
// btc-candles.js uses Kraken, but Kraken lists a fraction of the top 250 —
// CoinGecko is the only free source that covers every coin the screener can
// flag, and the scan already keys coins by CoinGecko id. The trade-off:
// CoinGecko picks the candle width from the day span (30m under 2 days, 4h
// under 31, daily beyond), so the UI's interval names map to LOOKBACK windows
// here, not candle widths. Output field names must stay in lockstep with
// btc-candles.js — BtcChartModal feeds candles straight to lightweight-charts.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// UI interval -> CoinGecko day span
const INTERVAL_DAYS = {
  "1d": 1,
  "1w": 7,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
};

// Per (id, interval) because the modal refetches on every interval tap and
// people flip back and forth. Bounded: a warm container can outlive one
// browsing session, and every flagged coin × six intervals adds up.
const cache = new Map();
const TTL_MS = 120 * 1000;
const CACHE_MAX = 128;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  if (body.ping) return json(200, { success: true, service: "alt-candles", configured: true });

  const uiInterval = body.interval || "1m";
  const days = INTERVAL_DAYS[uiInterval];
  if (!days) return json(400, { error: `Unsupported interval "${uiInterval}". Use one of: ${Object.keys(INTERVAL_DAYS).join(", ")}` });

  // The id lands in a URL path — accept only CoinGecko's slug alphabet.
  const id = String(body.id || "");
  if (!/^[a-z0-9-]{1,60}$/.test(id)) return json(400, { error: "Bad or missing coin id." });

  const key = `${id}:${uiInterval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return json(200, { ...hit.data, cached: true });

  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=${days}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`CoinGecko responded ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("CoinGecko: unexpected shape");

    // Each row: [ms, open, high, low, close] — numbers already, but a row
    // with a hole would crash the chart, so drop any that don't parse clean.
    const candles = rows
      .map((r) => ({
        time: Math.floor(r[0] / 1000), // unix seconds
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
      }))
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));

    const data = { success: true, id, interval: uiInterval, candles };
    cache.set(key, { data, ts: Date.now() });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return json(200, data);
  } catch (e) {
    // Serve stale candles rather than nothing if CoinGecko balks.
    if (hit) return json(200, { ...hit.data, cached: true, stale: true });
    return json(502, { error: e.message });
  }
};
