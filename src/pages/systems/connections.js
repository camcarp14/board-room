// ─── Connection health — the checks behind Settings → Systems → Status ───────
// Its own module because App hosts the hook (so a run survives closing the
// Settings sheet) while the sheet lazy-loads the panels. Importing the hook
// from SystemsPage pulled that whole file — the usage table included — into the
// first-load bundle and silently cancelled the lazy split, which Rollup says
// out loud: "dynamic import will not move module into another chunk".
//
// The metadata lives here too, next to the runner that fills it in: a key in
// CONN_GROUPS with no CONN_META entry renders a blank row, and a key the runner
// never sets pulses "Checking" forever.

import { useState } from "react";
import { supabase, ANTHROPIC_API_KEY } from "../../lib/supabase.js";
import { pingFn } from "../../lib/functions.js";
import { callClaude } from "../../lib/claude.js";

const IS_DEPLOYED = typeof window !== "undefined" && window.location.hostname !== "localhost";

// Every group starts folded. The tab's job is to answer "is anything broken",
// and four tally lines answer that in one screen — the twenty-five individual
// rows are the follow-up question, not the question.
//
// Nothing is hidden by folding: each header spells out its own counts, "1 down"
// in red included, so a break is visible at a glance. You tap to see WHICH.
export const CONN_GROUPS = [
  { title: "Core", keys: ["supabase_env", "supabase_auth", "supabase_db"] },
  { title: "AI", keys: ["anthropic"] },
  { title: "Market data", keys: ["coingecko"] },
  { title: "Netlify functions", keys: ["fn_health", "fn_mini", "fn_btc", "fn_btc_candles", "fn_markets", "fn_ticker_candles", "fn_wire", "fn_tmdb", "fn_export_data", "fn_calendar", "fn_calendar_events", "fn_site_status", "fn_gsc", "fn_shopify", "fn_clarify_pipeline", "fn_zts_pipeline", "fn_deploy", "fn_dbadmin", "fn_audit", "fn_autofix"] },
];
export const CONN_META = {
  supabase_env: { name: "Supabase · config", desc: "VITE_SUPABASE_URL + anon key present at build time" },
  supabase_auth: { name: "Supabase · auth", desc: "active session for this device" },
  supabase_db: { name: "Supabase · database", desc: "read against chat_messages (tables + RLS)" },
  anthropic: { name: "Anthropic API", desc: IS_DEPLOYED ? "via /.netlify/functions/claude proxy" : "direct from localhost with VITE_ANTHROPIC_API_KEY" },
  coingecko: { name: "CoinGecko", desc: "upstream BTC source — reached via the btc proxy, not directly from the browser" },
  fn_health: { name: "health", desc: "reports which server-side keys are configured" },
  // On-demand only. This claimed "nightly at ~3 AM CT", which netlify.toml
  // explicitly contradicts ("runs on demand only … no schedule here").
  fn_mini: { name: "mini-worker", desc: "Mini Me engine — runs when you hit Run queue now, Approve, or Reject" },
  fn_btc: { name: "btc", desc: "proxies BTC price + sparkline — avoids mobile-carrier IP rate limiting" },
  fn_btc_candles: { name: "btc-candles", desc: "BTC/USD candles via Kraken public API (5m/15m/30m/1d/1w) — no key needed" },
  fn_markets: { name: "markets", desc: "Gold, NVDA, MSTR, STRC quotes via Yahoo's public endpoint (unofficial)" },
  fn_calendar: { name: "calendar", desc: "US econ calendar, last 18h through +7 days (unofficial free feed — forecast/prior only, no actuals)" },
  fn_econ_result: { name: "econ-resolve-background", desc: "resolves what released econ events printed — off the request path, capped per run, written once per event for every device" },
  fn_calendar_events: { name: "calendar-events", desc: "upcoming meetings — parses the linked iCal URL" },
  fn_clarify_pipeline: { name: "clarify-pipeline", desc: "Clarify outreach pipeline stats (the shared Pentagon Supabase project)" },
  fn_zts_pipeline: { name: "zts-pipeline", desc: "ZTS creator pipeline stats (the shared Pentagon Supabase project, zts schema)" },
  fn_site_status: { name: "site-status", desc: "uptime check behind the Properties page's live/down pill" },
  fn_gsc: { name: "gsc", desc: "Search Console · zerotosecure.com last 14d" },
  fn_shopify: { name: "shopify", desc: "Shopify Admin API · orders last 14d" },
  fn_wire: { name: "wire", desc: "CoinDesk + Cointelegraph RSS · tagged headlines" },
  fn_ticker_candles: { name: "ticker-candles", desc: "Yahoo OHLC history for the watchlist tickers · Brief chart taps" },
  fn_tmdb: { name: "tmdb", desc: "movie search for poster/year lookup — optional, not required for Movies tab" },
  fn_export_data: { name: "export-data", desc: "local backup export — service-role read of all personal tables" },
  fn_deploy: { name: "deploy", desc: "Netlify API · trigger builds per property" },
  fn_dbadmin: { name: "db-admin", desc: "service-role maintenance, allowlisted commands" },
  fn_audit: { name: "audit", desc: "AI site auditor across all five properties" },
  fn_autofix: { name: "auto-fix", desc: "proposes fixes to a site's static template files, commits only on approval" },
};
export const CONN_STATUS = {
  ok: { label: "Live", tone: "var(--green)" },
  warn: { label: "Partial", tone: "var(--amber)" },
  down: { label: "Down", tone: "var(--red)" },
  off: { label: "Not configured", tone: "var(--faint)" },
  local: { label: "Deploy to test", tone: "var(--blue)" },
  checking: { label: "Checking", tone: "var(--sub)" },
};

// Ping protocol lives in lib/functions.js — one copy for every health pill.
export { pingFn } from "../../lib/functions.js";

export function useConnections({ session, btc }) {
  const [checks, setChecks] = useState({});
  const [lastRun, setLastRun] = useState(null);
  const [running, setRunning] = useState(false);

  const set = (key, val) => setChecks(prev => ({ ...prev, [key]: val }));

  const runAll = async () => {
    if (running) return;
    setRunning(true);
    // Seed every key to "checking" first so all rows pulse immediately.
    const all = Object.keys(CONN_META);
    setChecks(Object.fromEntries(all.map(k => [k, { status: "checking" }])));

    // Supabase — config
    set("supabase_env", supabase ? { status: "ok", detail: "url + anon key baked into build" } : { status: "off", detail: "env vars missing — see setup notice" });
    // Supabase — auth
    set("supabase_auth", session?.user ? { status: "ok", detail: session.user.email } : { status: "down", detail: "no session" });
    // Supabase — db round trip (head-only count read exercises tables + RLS)
    if (supabase) {
      const t0 = Date.now();
      try {
        const { error, count } = await supabase.from("chat_messages").select("*", { count: "exact", head: true });
        set("supabase_db", error
          ? { status: "down", detail: error.message, ms: Date.now() - t0 }
          : { status: "ok", detail: `${count ?? 0} messages readable`, ms: Date.now() - t0 });
      } catch { set("supabase_db", { status: "down", detail: "query failed", ms: Date.now() - t0 }); }
    } else set("supabase_db", { status: "off", detail: "supabase not configured" });

    // Anthropic — tiny live call through whichever path this build uses.
    // maxTokens:1 + fn:'conn_check' keeps it nearly free and identifiable
    // in usage_log.
    {
      const t0 = Date.now();
      if (!IS_DEPLOYED && !ANTHROPIC_API_KEY) {
        set("anthropic", { status: "off", detail: "VITE_ANTHROPIC_API_KEY not set for local dev" });
      } else {
        const text = await callClaude({ messages: [{ role: "user", content: "ping" }], modelKey: "haiku", maxTokens: 1, fn: "conn_check" });
        set("anthropic", text !== null
          ? { status: "ok", detail: IS_DEPLOYED ? "proxy → Claude responding" : "direct → Claude responding", ms: Date.now() - t0 }
          : { status: "down", detail: IS_DEPLOYED ? "proxy failed — check claude function + ANTHROPIC_API_KEY" : "call failed — check key", ms: Date.now() - t0 });
      }
    }

    // CoinGecko — reuse the hook's state, verify with a light ping. Price is
    // deliberately NOT fetched directly from the browser (mobile-carrier IP
    // rate limiting — see fn_btc desc); only the /ping endpoint as fallback.
    if (btc?.error) set("coingecko", { status: "down", detail: btc.error });
    else if (btc?.price) set("coingecko", { status: "ok", detail: `BTC $${btc.price.toLocaleString(undefined, { maximumFractionDigits: 0 })} · ${btc.points?.length || 0} chart points` });
    else {
      const t0 = Date.now();
      try {
        const r = await fetch("https://api.coingecko.com/api/v3/ping");
        set("coingecko", r.ok ? { status: "ok", detail: "API reachable", ms: Date.now() - t0 } : { status: "down", detail: `HTTP ${r.status}`, ms: Date.now() - t0 });
      } catch { set("coingecko", { status: "down", detail: "unreachable", ms: Date.now() - t0 }); }
    }

    // Netlify functions — this key→name mapping must stay in sync with
    // CONN_GROUPS keys and CONN_META. (fn_btc_candles used to be missing
    // here, leaving its row stuck on "checking" forever — fixed.)
    const fns = [["fn_health", "health"], ["fn_mini", "mini-worker"], ["fn_btc", "btc"], ["fn_btc_candles", "btc-candles"], ["fn_markets", "markets"], ["fn_ticker_candles", "ticker-candles"], ["fn_wire", "wire"], ["fn_tmdb", "tmdb"], ["fn_export_data", "export-data"], ["fn_calendar", "calendar"], ["fn_econ_result", "econ-resolve-background"], ["fn_calendar_events", "calendar-events"], ["fn_site_status", "site-status"], ["fn_gsc", "gsc"], ["fn_shopify", "shopify"], ["fn_clarify_pipeline", "clarify-pipeline"], ["fn_zts_pipeline", "zts-pipeline"], ["fn_deploy", "deploy"], ["fn_dbadmin", "db-admin"], ["fn_audit", "audit"], ["fn_autofix", "auto-fix"]];
    if (!IS_DEPLOYED) {
      // netlify dev serves functions locally; try health first to decide —
      // if it's dead, mark ALL fns "local" instead of hammering 20 dead
      // endpoints.
      const probe = await pingFn("health");
      if (probe.status === "down" || probe.status === "off") {
        fns.forEach(([k]) => set(k, { status: "local", detail: "run `netlify dev` or deploy to test functions" }));
      } else {
        await Promise.all(fns.map(async ([k, n]) => set(k, await pingFn(n))));
      }
    } else {
      await Promise.all(fns.map(async ([k, n]) => set(k, await pingFn(n))));
    }

    setLastRun(Date.now());
    setRunning(false);
  };

  return { checks, lastRun, running, runAll };
}
