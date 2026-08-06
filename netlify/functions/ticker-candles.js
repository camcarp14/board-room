// OHLC candles for any ticker the app can name, so a Brief tile, a Stocks
// board row or a flagged setup can all open the same chart modal the BTC price
// uses. Same unofficial Yahoo Finance chart endpoint as markets.js; it returns
// timestamp + open/high/low/close arrays, which we reshape into the candle
// format lightweight-charts wants: { time, open, high, low, close }.
//
// IT USED TO ACCEPT FOUR SYMBOLS AND NOTHING ELSE, which was fine while the
// only caller was four tiles. The Stocks screener then shipped a 49-name board
// whose every row offers "Open chart", and every one of them answered
// `unknown symbol "BA" — use one of: gold, nvda, mstr, strc`. A dead button on
// forty-nine rows.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Aliases for things whose ticker is not what the UI calls them. "gold" has to
// map to the COMEX front-month contract; a plain equity needs no entry here.
const ALIASES = { gold: "GC=F", nvda: "NVDA", mstr: "MSTR", strc: "STRC" };

// Anything else is accepted if it LOOKS like a ticker, rather than by being on
// a list. A second copy of the screener's universe would have to be kept in
// sync with a file this one is forbidden to import (self-contained functions,
// house rule), and it would go stale the first time that list changed.
//
// The shape is the guard, and it is a real one: this handler builds exactly one
// URL, on a fixed host, with the symbol in the PATH — so the only thing an
// attacker-supplied string can do is ask Yahoo about a different ticker. No
// credentials ride along and nothing internal is reachable. Uppercase letters,
// dots and hyphens cover US listings including BRK.B and RDS-A; ten characters
// is longer than any of them.
const TICKER_RE = /^[A-Z][A-Z.\-]{0,9}$/;

function resolveSymbol(raw) {
  const key = String(raw || "").trim();
  if (!key) return null;
  if (ALIASES[key.toLowerCase()]) return ALIASES[key.toLowerCase()];
  const up = key.toUpperCase();
  return TICKER_RE.test(up) ? up : null;
}

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

exports.resolveSymbol = resolveSymbol;

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "ticker-candles", configured: true });

  const key = body.symbol;
  const sym = resolveSymbol(key);
  if (!sym) return json(400, { error: `"${key || ""}" doesn't look like a ticker.` });

  const ui = body.interval || "1d";
  const m = MAP[ui] || MAP["1d"];

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${m.range}&interval=${m.interval}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
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
    // An equity has no minute bars outside its session — say which, rather
    // than "no candles", which reads as a broken chart at 1am.
    if (!candles.length) {
      const intraday = m.interval.endsWith("m");
      throw new Error(intraday
        ? `No ${ui} bars for ${sym} — intraday only exists while the market is trading. Try 1D.`
        : `${sym} returned no candles for ${ui}`);
    }
    return json(200, { success: true, symbol: key, interval: ui, candles });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
