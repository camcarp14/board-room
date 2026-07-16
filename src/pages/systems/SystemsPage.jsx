// ─── Systems — everything technical in one place ──────────────────────────────
// Behind sub-tabs so mobile isn't a wall of unrelated cards: spend/usage, live
// status of every data pipe, deploy triggers, and the Supabase console. The
// site auditor lives on Assets, next to the properties it actually audits.

import { useState, useEffect, useRef } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, StatTile, Button, Pill, PillRow,
  Segmented, Field, Dot, Grid, EmptyState,
} from "../../ui/kit.jsx";
import { Segmented as ModelPicker } from "../../ui/primitives.jsx"; // the MODEL_META picker
import { IcCheck } from "../../ui/icons.jsx";
import { supabase, ANTHROPIC_API_KEY } from "../../lib/supabase.js";
import { pingFn, callFn } from "../../lib/functions.js";
import { callClaude, DEFAULT_MODELS, MODEL_META } from "../../lib/claude.js";
import { obs } from "../../lib/storage.js";
import { PROPERTIES } from "../assets/AssetsPage.jsx";

/* ═══ Usage ════════════════════════════════════════════════════════════════ */

// Usage — durable, cross-device log of every Anthropic call and every
// Netlify function hit, read from usage_log (populated by callClaude/callFn
// client-side, plus mini-worker and audit server-side for scheduled/
// cost-bearing calls those make outside a browser session).
const USAGE_WINDOWS = [["24h", 1], ["7d", 7], ["30d", 30], ["All", 3650]];
const LOG_STEP = 40; // in-page log cap — "Show more" extends it, no nested scroller

function UsageCard({ isMobile }) {
  const [summary, setSummary] = useState(null); // null = loading; accurate totals via server-side aggregation, not capped by row count
  const [recentRows, setRecentRows] = useState(null); // separate, smaller fetch — only for the raw log detail view below
  const [err, setErr] = useState(null);
  const [windowIdx, setWindowIdx] = useState(1);
  const [retryNonce, setRetryNonce] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [logShown, setLogShown] = useState(LOG_STEP);

  const load = async () => {
    setSummary(null); setRecentRows(null); setErr(null); setLogShown(LOG_STEP);
    const since = new Date(Date.now() - USAGE_WINDOWS[windowIdx][1] * 86400000).toISOString();
    try {
      // Real fix: this used to be one row-capped select that both summed
      // totals AND fed the log view. At this app's actual call volume, the
      // cap meant 7d/30d/All silently showed the same few hours of data as
      // 24h. Aggregating in Postgres removes the row-count ceiling from the
      // numbers that matter (spend, calls, tokens); the raw log below is
      // still capped, but that's fine — nobody needs to scroll thousands of
      // individual lines, only the totals needed to be exact.
      const { data, error } = await supabase.rpc("usage_summary", { since_ts: since });
      if (error) { setErr(error.message.includes("usage_summary") ? "Run supabase-usage-fix.sql in the Supabase SQL editor to enable accurate totals." : error.message); setSummary([]); return; }
      setSummary(data || []);
    } catch { setErr("usage log unavailable"); setSummary([]); }
    supabase.from("usage_log").select("fn,kind,model,in_tokens,out_tokens,cost_usd,ms,ok,detail,created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(300)
      .then(({ data }) => setRecentRows(data || []));
  };
  useEffect(() => { load(); }, [windowIdx, retryNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Postgres aggregates come back as strings — coerce before summing.
  const totalCalls = summary?.reduce((s, r) => s + Number(r.calls), 0) || 0;
  const failed = summary?.reduce((s, r) => s + Number(r.failed), 0) || 0;
  // Cost/token boxes are Anthropic-only; total/failed calls count ALL kinds.
  const anthropicRows = summary?.filter(r => r.kind === "anthropic") || [];
  const totalCost = anthropicRows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  const totalIn = anthropicRows.reduce((s, r) => s + Number(r.in_tokens || 0), 0);
  const totalOut = anthropicRows.reduce((s, r) => s + Number(r.out_tokens || 0), 0);
  const byFn = {};
  (summary || []).forEach(r => {
    byFn[r.fn] = byFn[r.fn] || { calls: 0, cost: 0, failed: 0 };
    byFn[r.fn].calls += Number(r.calls);
    byFn[r.fn].cost += Number(r.cost_usd || 0);
    byFn[r.fn].failed += Number(r.failed);
  });
  const topFns = Object.entries(byFn).sort((a, b) => (b[1].cost - a[1].cost) || (b[1].calls - a[1].calls)).slice(0, 8);
  const fmtK = (n) => n > 999 ? (n / 1000).toFixed(1) + "K" : String(n);
  const ago = (ts) => { const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000); if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`; };

  const rows = recentRows || [];
  const shownRows = rows.slice(0, logShown);

  return (
    <Card pad="md">
      <div className="t-head" style={{ marginBottom: 8 }}>Usage</div>
      <Segmented
        options={USAGE_WINDOWS.map(([label]) => ({ key: label, label }))}
        value={USAGE_WINDOWS[windowIdx][0]}
        onChange={k => setWindowIdx(Math.max(0, USAGE_WINDOWS.findIndex(([l]) => l === k)))}
        style={{ marginBottom: 12 }}
      />

      {err && (
        <EmptyState
          title="Usage log unreachable"
          sub={/failed to fetch/i.test(err) ? "The usage_log table didn't answer — check the connection and try again." : err}
          action={<Button kind="tinted" size="sm" onClick={() => setRetryNonce(n => n + 1)}>Retry</Button>}
          style={{ padding: "20px 12px" }}
        />
      )}

      {!err && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8 }}>
            <StatTile value={summary === null ? "…" : "$" + totalCost.toFixed(3)} label="Anthropic spend" />
            <StatTile value={summary === null ? "…" : String(totalCalls)} label="Total calls" />
            <StatTile value={summary === null ? "…" : `${fmtK(totalIn)}/${fmtK(totalOut)}`} label="Tokens in/out" />
            <StatTile value={summary === null ? "…" : String(failed)} label="Failed calls" valueTone={failed ? "var(--red)" : "var(--green)"} />
          </div>

          <div className="t-label" style={{ padding: "16px 2px 6px" }}>By feature</div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {summary === null && <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "10px 0" }}>Loading…</div>}
            {summary !== null && topFns.length === 0 && <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "10px 0" }}>No calls logged in this window yet.</div>}
            {topFns.map(([fn, s], i) => (
              <div key={fn} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 40, padding: "6px 2px", borderTop: i > 0 ? "0.5px solid var(--line)" : "none" }}>
                <span className="t-num" style={{ fontSize: 12.5, color: "var(--ink)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fn}</span>
                {s.failed > 0 && <span className="t-num" style={{ fontSize: 11, color: "var(--red)", flex: "none" }}>{s.failed} failed</span>}
                <span className="t-num" style={{ fontSize: 11, color: "var(--faint)", flex: "none" }}>{s.calls} calls</span>
                <span className="t-num" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)", flex: "none", width: 56, textAlign: "right" }}>{s.cost > 0 ? "$" + s.cost.toFixed(3) : "—"}</span>
              </div>
            ))}
          </div>

          <Button kind="quiet" size="md" full onClick={() => setShowLog(!showLog)} style={{ marginTop: 12 }}>
            {showLog ? "Hide recent log" : "Show recent log (up to 300)"}
          </Button>
          {showLog && (
            <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
              {recentRows === null && <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "14px 0" }}>Loading…</div>}
              {shownRows.map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, minHeight: 32, padding: "5px 2px", borderTop: i > 0 ? "0.5px solid var(--line)" : "none" }}>
                  <Dot tone={r.ok ? "var(--green)" : "var(--red)"} size={6} />
                  <span className="t-num" style={{ fontSize: 11, color: "var(--faint)", flex: "none", width: 32 }}>{ago(r.created_at)}</span>
                  <span className="t-num" style={{ fontSize: 11.5, color: "var(--ink)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.fn}{r.model ? ` · ${r.model}` : ""}{!r.ok && r.detail ? ` · ${r.detail}` : ""}</span>
                  <span className="t-num" style={{ fontSize: 11, color: "var(--faint)", flex: "none" }}>{r.ms ? `${r.ms}ms` : ""}</span>
                  <span className="t-num" style={{ fontSize: 11, color: "var(--sub)", flex: "none", width: 52, textAlign: "right" }}>{r.cost_usd ? "$" + r.cost_usd.toFixed(4) : ""}</span>
                </div>
              ))}
              {recentRows?.length === 0 && <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "14px 0" }}>Nothing logged yet.</div>}
              {rows.length > logShown && (
                <Button kind="plain" size="md" full onClick={() => setLogShown(n => n + 80)} style={{ marginTop: 4 }}>
                  Show more ({rows.length - logShown} more)
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ═══ Status — connection health machinery ═════════════════════════════════ */

const IS_DEPLOYED = typeof window !== "undefined" && window.location.hostname !== "localhost";

const CONN_GROUPS = [
  { title: "Core", keys: ["supabase_env", "supabase_auth", "supabase_db"] },
  { title: "AI", keys: ["anthropic"] },
  { title: "Market data", keys: ["coingecko"] },
  { title: "Netlify functions", keys: ["fn_health", "fn_mini", "fn_btc", "fn_btc_candles", "fn_markets", "fn_ticker_candles", "fn_wire", "fn_tmdb", "fn_export_data", "fn_calendar", "fn_calendar_events", "fn_site_status", "fn_gsc", "fn_shopify", "fn_clarify_pipeline", "fn_zts_pipeline", "fn_deploy", "fn_dbadmin", "fn_audit", "fn_autofix"] },
];
const CONN_META = {
  supabase_env: { name: "Supabase · config", desc: "VITE_SUPABASE_URL + anon key present at build time" },
  supabase_auth: { name: "Supabase · auth", desc: "active session for this device" },
  supabase_db: { name: "Supabase · database", desc: "read against chat_messages (tables + RLS)" },
  anthropic: { name: "Anthropic API", desc: IS_DEPLOYED ? "via /.netlify/functions/claude proxy" : "direct from localhost with VITE_ANTHROPIC_API_KEY" },
  coingecko: { name: "CoinGecko", desc: "upstream BTC source — reached via the btc proxy, not directly from the browser" },
  fn_health: { name: "health", desc: "reports which server-side keys are configured" },
  fn_mini: { name: "mini-worker", desc: "Mini Me engine — nightly at ~3 AM CT + on-demand runs" },
  fn_btc: { name: "btc", desc: "proxies BTC price + sparkline — avoids mobile-carrier IP rate limiting" },
  fn_btc_candles: { name: "btc-candles", desc: "BTC/USD candles via Kraken public API (5m/15m/30m/1d/1w) — no key needed" },
  fn_markets: { name: "markets", desc: "S&P/Nasdaq futures, 10Y yield, DXY via Yahoo's public endpoint (unofficial)" },
  fn_calendar: { name: "calendar", desc: "US econ calendar, today through +7 days (unofficial free feed)" },
  fn_calendar_events: { name: "calendar-events", desc: "upcoming meetings — parses the linked iCal URL" },
  fn_clarify_pipeline: { name: "clarify-pipeline", desc: "Clarify Outreach pipeline stats (own Supabase project)" },
  fn_zts_pipeline: { name: "zts-pipeline", desc: "ZTS creator pipeline stats (own Supabase project)" },
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
const CONN_STATUS = {
  ok: { label: "Live", tone: "var(--green)" },
  warn: { label: "Partial", tone: "var(--amber)" },
  down: { label: "Down", tone: "var(--red)" },
  off: { label: "Not configured", tone: "var(--faint)" },
  local: { label: "Deploy to test", tone: "var(--blue)" },
  checking: { label: "Checking", tone: "var(--sub)" },
};

// Ping protocol lives in lib/functions.js — one copy for every health pill.
export { pingFn } from "../../lib/functions.js";

function useConnections({ session, btc }) {
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
    const fns = [["fn_health", "health"], ["fn_mini", "mini-worker"], ["fn_btc", "btc"], ["fn_btc_candles", "btc-candles"], ["fn_markets", "markets"], ["fn_ticker_candles", "ticker-candles"], ["fn_wire", "wire"], ["fn_tmdb", "tmdb"], ["fn_export_data", "export-data"], ["fn_calendar", "calendar"], ["fn_calendar_events", "calendar-events"], ["fn_site_status", "site-status"], ["fn_gsc", "gsc"], ["fn_shopify", "shopify"], ["fn_clarify_pipeline", "clarify-pipeline"], ["fn_zts_pipeline", "zts-pipeline"], ["fn_deploy", "deploy"], ["fn_dbadmin", "db-admin"], ["fn_audit", "audit"], ["fn_autofix", "auto-fix"]];
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

function ConnStatus({ check }) {
  const key = check?.status || "checking";
  const st = CONN_STATUS[key] || CONN_STATUS.checking;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
      <Dot tone={st.tone} size={6} pulse={key === "checking"} />
      <span className="t-cap" style={{ color: st.tone, fontWeight: 600 }}>{st.label}</span>
    </span>
  );
}

/* ═══ The page ═════════════════════════════════════════════════════════════ */

// Keys are stable (Summon and muscle memory point at them).
const SYSTEMS_SUBTABS = [
  { key: "usage", label: "Usage" },
  { key: "status", label: "Status" },
  { key: "deploy", label: "Deploy" },
  { key: "supabase", label: "Supabase" },
];

const REPLACE_ACCEPT = ".html,.htm,.js,.mjs,.css,.svg,.txt,.xml,.json,.webmanifest,image/*"; // matches the hint: HTML, JS, CSS, images

export function SystemsPage({ settings, updateSetting, session, btc, isMobile }) {
  // Sub-tab state is deliberately local — not persisted, not deep-linked
  // (unlike Personal/Boardroom jumps); every visit starts on Usage.
  const [sub, setSub] = useState("usage");

  // ── Status (formerly the standalone Connections page) ──
  const { checks, lastRun, running, runAll } = useConnections({ session, btc });
  // Lazy per-sub-tab: checks used to fire on page mount even while the Usage
  // tab was showing — ~25 network calls (including a paid Anthropic ping) the
  // user might never look at. They now start the first time Status is shown;
  // results persist across sub-tab switches, and "Run checks" re-runs on
  // demand as before.
  const statusStarted = useRef(false);
  useEffect(() => {
    if (sub !== "status" || statusStarted.current) return;
    statusStarted.current = true;
    runAll();
  }, [sub]); // eslint-disable-line react-hooks/exhaustive-deps
  const vals = Object.values(checks);
  const counts = {
    ok: vals.filter(c => c?.status === "ok").length,
    warn: vals.filter(c => c?.status === "warn").length,
    down: vals.filter(c => c?.status === "down").length,
    off: vals.filter(c => c?.status === "off" || c?.status === "local").length,
  };
  const agoCheck = (ts) => { if (!ts) return "—"; const s = Math.floor((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`; };

  // ── Deploy — build triggers, plus a safe single-file replace ──
  const [deploys, setDeploys] = useState({});
  const redeploy = async (p) => {
    setDeploys(d => ({ ...d, [p.name]: { busy: true } }));
    const res = await callFn("deploy", { site: p.site, action: "build" });
    setDeploys(d => ({ ...d, [p.name]: { busy: false, ok: !!res?.success, when: "just now" } }));
  };
  const fileRef = useRef(null);
  const [replaceFile, setReplaceFile] = useState(null);
  const [replacePath, setReplacePath] = useState("");
  const [replaceTargets, setReplaceTargets] = useState([]);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [replaceResults, setReplaceResults] = useState({});
  const toggleTarget = (name) => setReplaceTargets(t => t.includes(name) ? t.filter(x => x !== name) : [...t, name]);
  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    // strip the data: URL prefix — the fn wants raw base64
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const runReplace = async () => {
    if (!replaceFile || !replacePath.trim() || !replaceTargets.length || replaceBusy) return;
    setReplaceBusy(true);
    setReplaceResults({});
    const contentBase64 = await fileToBase64(replaceFile);
    const results = {};
    // Targets are processed SEQUENTIALLY, streaming each result into state.
    for (const name of replaceTargets) {
      const p = PROPERTIES.find(x => x.name === name);
      const res = await callFn("deploy", { site: p.site, action: "replace-file", path: replacePath.trim(), contentBase64 });
      results[name] = { ok: !!res?.success, detail: res?.success ? res.message : (res?.error || "failed — see Netlify deploy log") };
      setReplaceResults({ ...results });
    }
    setReplaceBusy(false);
  };

  // ── Supabase — which project the console commands target ──
  const [projects, setProjects] = useState(["Board Room"]);
  const [project, setProject] = useState("Board Room");
  useEffect(() => {
    let alive = true;
    callFn("db-admin", { ping: true }).then(d => {
      if (!alive || !d?.projects?.length) return;
      setProjects(d.projects);
      // keep the current selection if the fn still lists it, else first
      setProject(p => d.projects.includes(p) ? p : d.projects[0]);
    });
    return () => { alive = false; };
  }, []);
  const [sqlInput, setSqlInput] = useState("");
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlLog, setSqlLog] = useState([{ kind: "ok", text: "ready — allowlisted commands only" }]);
  const runSql = async () => {
    const q = sqlInput.trim();
    if (!q || sqlBusy) return;
    setSqlLog(l => [...l, { kind: "cmd", text: `> [${project}] ${q}` }]);
    setSqlInput(""); setSqlBusy(true);
    const data = await callFn("db-admin", { command: q, project });
    setSqlLog(l => [...l, { kind: data?.success ? "ok" : "err", text: data?.success ? "✓ " + (data.message || "done") : "✗ " + (data?.error || "db-admin function not deployed yet") }]);
    setSqlBusy(false);
  };

  // ── Usage / Models ──
  const models = { ...DEFAULT_MODELS, ...(settings?.models || {}) };
  const setModel = (layer, key) => updateSetting("models", { ...models, [layer]: key });
  // Estimate: base cost per layer (router 0.006 / seats 0.018 / chief 0.012)
  // times the model's MODEL_META mult; unknown keys fall back to mult 1.
  const mult = k => (MODEL_META.find(m => m.key === k) || {}).mult || 1;
  const est = 0.006 * mult(models.router) + 0.018 * mult(models.seats) + 0.012 * mult(models.chief);
  // "Today" line reads obs — the per-browser localStorage tracker (see the
  // comment in telemetry.js). Distinct from the durable usage_log; never
  // merge the two.
  const spendToday = obs.all().filter(l => new Date(l.ts).toDateString() === new Date().toDateString());
  const inTok = spendToday.reduce((s, l) => s + (l.inTok || 0), 0), outTok = spendToday.reduce((s, l) => s + (l.outTok || 0), 0);
  const cost = spendToday.reduce((s, l) => s + (l.cost || 0), 0);
  const fmtK = n => n > 999 ? Math.round(n / 1000) + "K" : String(n);
  const layers = [
    { key: "router", name: "Router", desc: "picks which seats to wake" },
    { key: "seats", name: "Board seats", desc: "the five specialist takes" },
    { key: "chief", name: "Chief of staff", desc: "final synthesis" },
  ];

  const deployables = PROPERTIES.filter(p => !p.assetsOnly); // Runway/FFSR excluded on purpose

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: isMobile ? "4px 16px 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 1020, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Segmented options={SYSTEMS_SUBTABS} value={sub} onChange={setSub} style={{ marginBottom: 14, maxWidth: isMobile ? undefined : 480 }} />

        {/* key={sub} re-mounts and animates the content on every tab switch. */}
        <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>

          {sub === "usage" && (
            <Grid min={isMobile ? 320 : 380} gap={12}>
              <div>
                <SectionHeader title="Model Control" trailing="Tokens" />
                <Card pad="md">
                  <div className="t-foot" style={{ color: "var(--sub)" }}>Start cheap. Escalate a layer only when the answers need it.</div>
                  {layers.map(r => (
                    <div key={r.key} style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
                      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                        <span className="t-call" style={{ fontWeight: 600 }}>{r.name}</span>
                        <span className="t-cap" style={{ color: "var(--faint)", textAlign: "right" }}>{r.desc}</span>
                      </div>
                      <ModelPicker value={models[r.key]} onChange={k => setModel(r.key, k)} />
                    </div>
                  ))}
                  <div style={{ marginTop: 14, background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <span className="t-foot" style={{ color: "var(--sub)" }}>Est. per convened question</span>
                    <span className="t-num" style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>${est.toFixed(3)}</span>
                  </div>
                  <div className="t-cap t-num" style={{ marginTop: 10, color: "var(--faint)" }}>Today · {fmtK(inTok)} in · {fmtK(outTok)} out · ${cost.toFixed(2)}</div>
                </Card>
              </div>
              <UsageCard isMobile={isMobile} />
            </Grid>
          )}

          {sub === "status" && (
            <>
              <Card pad="md">
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8 }}>
                  <StatTile value={counts.ok} label="Live" valueTone="var(--green)" />
                  <StatTile value={counts.warn} label="Partial" valueTone="var(--amber)" />
                  <StatTile value={counts.down} label="Down" valueTone="var(--red)" />
                  <StatTile value={counts.off} label="Not set" valueTone="var(--faint)" />
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12 }}>
                  <span className="t-cap t-num" style={{ color: "var(--faint)" }}>Last check {agoCheck(lastRun)}</span>
                  <Button kind="tinted" size="md" onClick={runAll} disabled={running}>{running ? "Checking…" : "Run checks"}</Button>
                </div>
              </Card>

              <Grid min={320} gap={12} style={{ marginTop: 12 }}>
                {CONN_GROUPS.map(g => (
                  // The long functions group spans the full row on tablet;
                  // the small groups sit side by side.
                  <div key={g.title} style={g.keys.length > 6 ? { gridColumn: "1 / -1" } : undefined}>
                    <SectionHeader title={g.title} />
                    <CellGroup>
                      {g.keys.map(k => {
                        const meta = CONN_META[k];
                        const check = checks[k];
                        return (
                          <Cell
                            key={k}
                            title={meta.name}
                            sub={check?.detail || meta.desc}
                            trailing={
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
                                {typeof check?.ms === "number" && <span className="t-num" style={{ fontSize: 11, color: "var(--faint)" }}>{check.ms}ms</span>}
                                <ConnStatus check={check} />
                              </span>
                            }
                          />
                        );
                      })}
                    </CellGroup>
                  </div>
                ))}
              </Grid>
            </>
          )}

          {sub === "deploy" && (
            <Grid min={isMobile ? 320 : 380} gap={12}>
              <div>
                <SectionHeader title="Deployments" trailing="Netlify" />
                <CellGroup>
                  {deployables.map(p => {
                    const d = deploys[p.name] || {};
                    const line = d.busy ? "Triggering build…" : d.when ? (d.ok ? `Build triggered · ${d.when}` : "Trigger failed — check deploy function") : `netlify · ${p.site}`;
                    return (
                      <Cell
                        key={p.name}
                        leading={<Dot tone={d.busy ? "var(--amber)" : d.when ? (d.ok ? "var(--green)" : "var(--red)") : "var(--faint)"} size={7} pulse={d.busy} />}
                        title={p.name}
                        sub={<span className="t-num" style={{ fontSize: 11.5, color: d.busy ? "var(--amber)" : "var(--sub)" }}>{line}</span>}
                        trailing={
                          <Button kind="quiet" size="md" disabled={d.busy} onClick={() => redeploy(p)} style={{ flex: "none" }}>
                            {d.busy ? "Deploying…" : "Redeploy"}
                          </Button>
                        }
                      />
                    );
                  })}
                </CellGroup>
                <div className="t-foot" style={{ color: "var(--faint)", padding: "8px 16px 0" }}>
                  Each redeploy triggers a fresh Netlify build from the site's connected repo. Live/down state lives under the Status tab.
                </div>
              </div>

              <div>
                <SectionHeader title="Replace a File" trailing="Single-file swap" />
                <Card pad="md">
                  <div className="t-foot" style={{ color: "var(--sub)" }}>
                    Swaps one file on the sites you pick — every other file on the live site is left exactly as it is. For a full rebuild, use Deployments instead.
                  </div>
                  <input
                    ref={fileRef} type="file" accept={REPLACE_ACCEPT} style={{ display: "none" }}
                    onChange={e => { const f = e.target.files?.[0] || null; setReplaceFile(f); setReplaceResults({}); if (f && !replacePath) setReplacePath("/" + f.name); }}
                  />
                  <Cell
                    title={replaceFile ? replaceFile.name : "No file chosen"}
                    sub={replaceFile ? "set the path below, pick sites, then replace" : "HTML, JS, CSS, images — keep it under 4MB"}
                    trailing={<Button kind="quiet" size="md" onClick={() => fileRef.current?.click()}>{replaceFile ? "Change" : "Choose a file"}</Button>}
                    style={{ padding: "10px 0", minHeight: 56 }}
                  />
                  {replaceFile && (
                    <>
                      <div className="t-foot" style={{ color: "var(--sub)", margin: "4px 0 6px" }}>Path on the site (exact, case-sensitive)</div>
                      <Field
                        value={replacePath} onChange={e => setReplacePath(e.target.value)} placeholder="/index.html"
                        style={{ fontFamily: "var(--font-mono)" }}
                      />
                      <div className="t-foot" style={{ color: "var(--sub)", margin: "12px 0 8px" }}>Replace on</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {deployables.map(p => {
                          const sel = replaceTargets.includes(p.name);
                          return (
                            <Pill key={p.name} active={sel} onClick={() => toggleTarget(p.name)}>
                              {sel && <IcCheck size={11} />}{p.name}
                            </Pill>
                          );
                        })}
                      </div>
                      <Button kind="tinted" size="md" full disabled={replaceBusy || !replacePath.trim() || !replaceTargets.length} onClick={runReplace} style={{ marginTop: 12 }}>
                        {replaceBusy ? "Replacing…" : `Replace on ${replaceTargets.length || 0} site${replaceTargets.length === 1 ? "" : "s"}`}
                      </Button>
                      {Object.keys(replaceResults).length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 10 }}>
                          {Object.entries(replaceResults).map(([name, r]) => (
                            <div key={name} className="t-foot" style={{ color: r.ok ? "var(--green)" : "var(--red)" }}>{r.ok ? "✓" : "✗"} {name}: {r.detail}</div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </Card>
              </div>
            </Grid>
          )}

          {sub === "supabase" && (
            <div>
              <SectionHeader title="Supabase Console" trailing="Allowlisted ops" />
              <Card pad="md">
                <div className="t-foot" style={{ color: "var(--sub)" }}>Run maintenance against a project's shared memory. Guardrails on — destructive ops ask twice.</div>
                <div className="t-foot" style={{ color: "var(--sub)", margin: "12px 0 8px" }}>Project</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {projects.map(p => (
                    <Pill key={p} active={project === p} onClick={() => setProject(p)}>{p}</Pill>
                  ))}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0 12px" }}>
                  {["backup chat_messages", "vacuum seat_notes", "clear findings > 30d"].map(q => (
                    <Pill key={q} onClick={() => setSqlInput(q)} style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{q}</Pill>
                  ))}
                </div>
                {/* The console log renders in-page and grows with the session —
                    no fixed-height inner scroller. */}
                <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", minHeight: 96, display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {sqlLog.map((l, i) => (
                    <div key={i} className="t-num" style={{ fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "break-word", color: l.kind === "cmd" ? "var(--sub)" : l.kind === "err" ? "var(--red)" : "var(--green)" }}>{l.text}</div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Field
                    value={sqlInput} onChange={e => setSqlInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); runSql(); } }}
                    placeholder="update seat_notes set …"
                    style={{ flex: 1, fontFamily: "var(--font-mono)" }}
                  />
                  <Button kind="quiet" size="md" onClick={runSql} disabled={sqlBusy}>Run</Button>
                </div>
              </Card>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

export default SystemsPage;
