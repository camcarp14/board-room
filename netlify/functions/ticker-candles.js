// OHLC candles for the four watchlist tickers (gold future, NVDA, MSTR, STRC),
// so each tile on the Brief can open its own price chart — same modal the BTC
// price uses. Same unofficial Yahoo Finance chart endpoint as markets.js; it
// returns timestamp + open/high/low/close arrays, which we reshape into the
// candle format lightweight-charts wants: { time, open, high, low, close }.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Only these four are chartable — same keys the Markets tiles use.
const SYMBOLS = { gold: "GC=F", nvda: "NVDA", mstr: "MSTR", strc: "STRC" };

// UI interval -> Yahoo (interval, range). Intraday granularities only reach
// back a few days on Yahoo; daily/weekly get a real history window.
const MAP = {
  "1m": { interval: "1m", range: "1d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "5d" },
  "30m": { interval: "30m", range: "1mo" },
  "1d": { interval: "1d", range: "6mo" },
  "1w": { interval: "1wk", range: "2y" },
};

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "ticker-candles", configured: true });

  const key = body.symbol;
  const sym = SYMBOLS[key];
  if (!sym) return json(400, { error: `unknown symbol "${key || ""}" — use one of: ${Object.keys(SYMBOLS).join(", ")}` });

  const ui = body.interval || "1d";
  const m = MAP[ui] || MAP["1d"];

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${m.range}&interval=${m.interval}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" } });
    if (!res.ok) throw new Error(`${sym} ${res.status}`);
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    // Yahoo pads gaps (holidays, halts) with nulls — skip any incomplete bar.
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
    }
    if (!candles.length) throw new Error(`${sym} returned no candles for ${ui}`);
    return json(200, { success: true, symbol: key, interval: ui, candles });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
