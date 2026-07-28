// Bitcoin exchange reserve — the total BTC sitting in known exchange wallets,
// one point per day. This is the series behind CryptoQuant's "Exchange Reserve
// · All Exchanges" chart; the Brief plots it as daily tick marks directly under
// the Bitcoin price.
//
// Honest note on sourcing, because it's the whole design of this file: there is
// NO free keyless feed for this number. Price has half a dozen (CoinGecko,
// Kraken — see btc.js / btc-candles.js), but exchange reserve requires
// address-cluster labelling that only paid providers do. CryptoQuant's own
// /v1/btc/exchange-flows/reserve endpoint needs a Professional or Premium plan.
// So this function is key-gated on purpose, and when no key is set it says so
// with the exact env var name instead of inventing a plausible number:
//
//   CRYPTOQUANT_API_KEY   the source this chart is modelled on (all_exchange, day)
//   COINGLASS_API_KEY     CoinGlass v4 exchange balance — the equivalent series
//   BTC_RESERVE_URL       escape hatch: any JSON URL returning a dated series.
//                         normalizeSeries() below reads the shapes these feeds
//                         actually ship, so a feed you already pay for can be
//                         wired in without touching this file. Optional
//                         BTC_RESERVE_URL_HEADERS is a JSON object of headers.
//
// First source that answers with a usable series wins; the rest are skipped.
// Self-contained (no shared helper import) — see scripts/functions-smoke.mjs
// for why that's the house pattern here.

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  body: JSON.stringify(body),
});

const DAY_MS = 86400000;
const DEFAULT_DAYS = 90;
const MAX_DAYS = 730;

// Daily data that updates once a day — a 30 minute cache is generous and still
// means a warm container answers instantly. Only successes are cached; a
// failure falls through to the last good payload (flagged stale) if there is one.
let cache = { data: null, ts: 0 };
const TTL_MS = 30 * 60 * 1000;

// ─── Parsing ─────────────────────────────────────────────────────────────────
// Three providers, three payload shapes, and none of them is stable across
// versions. Rather than three brittle parsers, one tolerant reader that knows
// the vocabulary these feeds use. Exported for scripts/functions-smoke.mjs.

const TIME_KEYS = ["date", "datetime", "time", "timestamp", "ts", "day", "t", "x"];
const VALUE_KEYS = ["reserve", "balance", "exchange_reserve", "exchangeBalance", "totalBalance", "total", "value", "v", "y"];
const TIME_LIST_KEYS = ["timeList", "times", "dates", "dateList", "timestampList", "x"];
const VALUE_LIST_KEYS = ["valueList", "values", "balanceList", "dataList", "data", "y"];
const ENVELOPE_KEYS = ["result", "data", "rows", "series", "items", "chart"];

// Unix seconds and milliseconds are both in the wild, as are ISO strings and
// bare "2026-07-27" dates. 1e11 ms is 1973 — anything below it that claims to
// be a timestamp is seconds, and anything below 1e8 isn't a date at all.
function toMs(raw) {
  if (raw == null) return null;
  let n = null;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && raw.trim() !== "" && !isNaN(Number(raw))) n = Number(raw);
  if (n != null) {
    if (!isFinite(n) || n < 1e8) return null;
    return n >= 1e11 ? n : n * 1000;
  }
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw); // "2026-07-27" parses as UTC midnight — what we want
  return isNaN(parsed) ? null : parsed;
}

function toNum(raw) {
  if (typeof raw === "number") return isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const n = Number(raw.replace(/,/g, "").trim());
    return raw.trim() !== "" && isFinite(n) ? n : null;
  }
  return null;
}

// Collapse to one point per UTC day, ascending. Providers disagree on ordering
// (CryptoQuant answers newest-first) and some emit intraday rows even on a
// daily window — the chart is one tick per day, so the data must be too.
function toDailyPoints(raw) {
  const byDay = new Map();
  for (const p of raw) {
    const day = Math.floor(p.t / DAY_MS) * DAY_MS;
    byDay.set(day, { t: day, v: p.v }); // later row for a day wins
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

function normalizeSeries(input) {
  const out = [];
  const push = (t, v) => {
    const ms = toMs(t), num = toNum(v);
    if (ms != null && num != null) out.push({ t: ms, v: num });
  };

  // Walk down through envelopes ({result:{data:[…]}}, {data:{…}}, …) until we
  // reach either an array of rows or an object holding parallel arrays.
  let node = input;
  for (let depth = 0; depth < 6 && node && typeof node === "object" && !Array.isArray(node); depth++) {
    const timeKey = TIME_LIST_KEYS.find(k => Array.isArray(node[k]));
    if (timeKey) {
      const times = node[timeKey];
      // CoinGlass shape: one array per exchange under dataMap. "All exchanges"
      // is their sum — a missing exchange on a given day is a hole in that
      // exchange's history, not a zero, so it's skipped rather than added.
      const map = node.dataMap && typeof node.dataMap === "object" && !Array.isArray(node.dataMap) ? node.dataMap : null;
      if (map) {
        const series = Object.values(map).filter(Array.isArray);
        times.forEach((t, i) => {
          let sum = 0, any = false;
          for (const s of series) { const n = toNum(s[i]); if (n != null) { sum += n; any = true; } }
          if (any) push(t, sum);
        });
        return toDailyPoints(out);
      }
      const valueKey = VALUE_LIST_KEYS.find(k => Array.isArray(node[k]) && k !== timeKey);
      if (valueKey) {
        times.forEach((t, i) => push(t, node[valueKey][i]));
        return toDailyPoints(out);
      }
    }
    const next = ENVELOPE_KEYS.map(k => node[k]).find(v => v && typeof v === "object");
    if (!next) return toDailyPoints(out);
    node = next;
  }
  if (!Array.isArray(node)) return toDailyPoints(out);

  for (const row of node) {
    if (Array.isArray(row)) { push(row[0], row[1]); continue; }
    if (!row || typeof row !== "object") continue;
    const tk = TIME_KEYS.find(k => row[k] != null);
    const vk = VALUE_KEYS.find(k => k !== tk && row[k] != null);
    if (tk && vk) push(row[tk], row[vk]);
  }
  return toDailyPoints(out);
}

// ─── Sources ─────────────────────────────────────────────────────────────────

async function fromCryptoQuant(key, days) {
  const url = `https://api.cryptoquant.com/v1/btc/exchange-flows/reserve?exchange=all_exchange&window=day&limit=${days}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, accept: "application/json" } });
  if (!res.ok) {
    // 401/403 here means the key exists but the plan doesn't cover the endpoint
    // — worth saying out loud, it's the single likeliest failure.
    const hint = res.status === 401 || res.status === 403 ? " (key rejected — this endpoint needs a Professional or Premium plan)" : "";
    throw new Error(`CryptoQuant ${res.status}${hint}`);
  }
  return normalizeSeries(await res.json());
}

async function fromCoinGlass(key) {
  const res = await fetch("https://open-api-v4.coinglass.com/api/exchange/balance/chart?symbol=BTC", {
    headers: { "CG-API-KEY": key, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CoinGlass ${res.status}`);
  const data = await res.json();
  // CoinGlass answers 200 with a non-zero code on logical errors.
  if (data && data.code != null && String(data.code) !== "0" && data.success !== true) {
    throw new Error(`CoinGlass ${data.msg || `code ${data.code}`}`);
  }
  return normalizeSeries(data);
}

async function fromCustomUrl(url, headersJson) {
  const headers = { accept: "application/json" };
  if (headersJson) {
    try { Object.assign(headers, JSON.parse(headersJson)); }
    catch { throw new Error("BTC_RESERVE_URL_HEADERS is not valid JSON"); }
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`BTC_RESERVE_URL ${res.status}`);
  return normalizeSeries(await res.json());
}

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse((event && event.body) || "{}"); } catch { /* GET, or no body */ }

  const cqKey = process.env.CRYPTOQUANT_API_KEY;
  const cgKey = process.env.COINGLASS_API_KEY;
  const customUrl = process.env.BTC_RESERVE_URL;
  const configured = !!(cqKey || cgKey || customUrl);

  if (body.ping) {
    return json(200, {
      success: true,
      service: "btc-reserve",
      configured,
      missing: configured ? undefined : "CRYPTOQUANT_API_KEY (or COINGLASS_API_KEY / BTC_RESERVE_URL)",
    });
  }

  const days = Math.min(MAX_DAYS, Math.max(7, Number(body.days) || DEFAULT_DAYS));

  // 200, not 4xx: "no key set" is a configuration state the card renders as a
  // one-line setup instruction, not a transport failure worth a red error.
  if (!configured) {
    return json(200, {
      success: false,
      configured: false,
      error: "No exchange-reserve source configured. Set CRYPTOQUANT_API_KEY (Professional or Premium plan), COINGLASS_API_KEY, or BTC_RESERVE_URL in Netlify.",
    });
  }

  if (cache.data && Date.now() - cache.ts < TTL_MS && cache.data.days >= days) {
    return json(200, { ...cache.data, points: cache.data.points.slice(-days), days, cached: true });
  }

  const sources = [
    cqKey && ["CryptoQuant", () => fromCryptoQuant(cqKey, days)],
    cgKey && ["CoinGlass", () => fromCoinGlass(cgKey)],
    customUrl && ["Custom feed", () => fromCustomUrl(customUrl, process.env.BTC_RESERVE_URL_HEADERS)],
  ].filter(Boolean);

  const errors = [];
  for (const [name, run] of sources) {
    try {
      const points = await run();
      // One point can't be charted and can't be differenced — treat a
      // near-empty answer as a failure so the next source still gets a turn.
      if (points.length < 2) { errors.push(`${name}: no usable series`); continue; }
      const trimmed = points.slice(-days);
      const payload = {
        success: true,
        source: name,
        unit: "BTC",
        points: trimmed,
        days,
        latest: trimmed[trimmed.length - 1].v,
        asOf: trimmed[trimmed.length - 1].t,
      };
      cache = { data: { ...payload, points, days: points.length }, ts: Date.now() };
      return json(200, payload);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  // Every source failed. A day-old reserve number is still a true one — serve
  // the last good series flagged stale rather than blanking the strip.
  if (cache.data) return json(200, { ...cache.data, points: cache.data.points.slice(-days), days, cached: true, stale: true });
  return json(502, { success: false, configured: true, error: errors.join("; ") || "no source answered" });
};

// Exported purely so scripts/functions-smoke.mjs can assert the parser against
// each provider's shape — Netlify only ever reads `handler`.
exports.normalizeSeries = normalizeSeries;
