// ─── Systems — the technical machine room, now living under Assets ───────────
// Everything technical, split into tabs so mobile isn't a wall of unrelated
// cards: spend/usage, live status of every data pipe, deploy triggers, the
// Supabase console, and the miner. These used to be their own top-level tab;
// they now mount as sub-tabs of the Assets page (the site auditor already lived
// on Assets, next to the properties it audits — this finishes the merge).
// Each tab is exported on its own so the Assets page can compose them beside
// the Properties tab; `useConnections` is hosted by that parent so Status
// results survive sub-tab switches.

import { useState, useEffect } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, StatTile, Button, Pill,
  Segmented, Field, Dot, EmptyState, useConfirm,
} from "../../ui/kit.jsx";
import { IcChevronDown } from "../../ui/icons.jsx";
import { supabase } from "../../lib/supabase.js";
// callFnFull everywhere on this page, never callFn: every control here talks to
// a function that explains its own refusals in the response body, and callFn
// throws that body away. Two panels on this page have already shipped a button
// that reported the wrong reason for failing — see the notes in DeployTab and
// SupabaseTab.
import { callFnFull } from "../../lib/functions.js";
import { PROPERTIES } from "../assets/properties.js";
import { CONN_GROUPS, CONN_META, CONN_STATUS } from "./connections.js";
// Re-exported so the hook keeps ONE public name even though it now lives next
// door — App imports it from ./connections.js directly to stay off this module.
export { useConnections, CONN_GROUPS, CONN_META } from "./connections.js";
export { pingFn } from "../../lib/functions.js";

// Keys are stable (Summon and muscle memory point at them). Consumed by the
// Assets page, which prepends its own "Properties" pill.
// SYSTEMS_SUBTABS lived here and is gone. It was the strip AssetsPage drew, and
// when that page was deleted nothing imported it — which left a second list of
// "the Systems sub-tabs" in the tree, exported, and already DISAGREEING with the
// live one: it had no Account, and for a long while the live SYS_TABS had no
// Supabase. Two lists that differ is not a duplicate, it is a question with two
// answers, and the one a reader finds first is whichever file they opened.
//
// The live list is SYS_TABS in shell/SettingsSheet.jsx, beside the lazy imports
// that mount each panel — which is the right place for it, because adding a
// sub-tab and mounting its panel are the same act. scripts/systems-smoke.mjs
// pins its contents.

// Which build this device is actually running — timestamp AND short commit sha,
// stamped into __BUILD__ at build time by vite.config.js. The timestamp alone
// used to be the whole stamp, and a timestamp only answers "when": staring at a
// bug on the phone that isn't in the working tree, the thing you need is the
// commit to check out. Printed on Status so a screenshot of this tab carries
// it. The typeof guard is not for `vite dev` (vite applies define there too) —
// it is for anything that loads this module without vite in front of it.
const BUILD = typeof __BUILD__ !== "undefined" ? __BUILD__ : "dev";

/* ═══ Usage ════════════════════════════════════════════════════════════════ */

// Usage — durable, cross-device log of every Anthropic call and every
// Netlify function hit, read from usage_log.
//
// Writers, all five of them: callClaude + callFn client-side, and server-side
// mini-worker, audit, auto-fix and the Upstream ledger. Three of those used to
// write nothing — audit and auto-fix showed as kind:"call" rows at $0, and the
// Discord board worker left no row at all — so the cost boxes below, which
// filter kind === "anthropic", understated real spend. There were six writers
// until Discord was retired; that path never logged a single row in production
// (usage_log holds zero fn like 'discord%'), which is why its labels went with
// it rather than being kept for history.
// The schema and the usage_summary aggregate live in supabase-usage-fix.sql.
const USAGE_WINDOWS = [["24h", 1], ["7d", 7], ["30d", 30], ["All", 3650]];
const LOG_STEP = 40; // in-page log cap — "Show more" extends it, no nested scroller

// ── What each row actually IS ────────────────────────────────────────────────
// `usage_log.fn` is a wire identifier — "gsc", "briefing_update", "fn_econ".
// Reading a spend table written in those is guesswork six months later, and
// guessing wrong about which line is costing money is the one failure this
// table exists to prevent. So every fn gets a plain-English name for the PULL
// it performs, and the raw id stays on the row underneath so a line here is
// still greppable against the code.
//
// An fn with no entry falls back to its raw id rather than being hidden — a new
// caller must show up as itself, not vanish from the accounting.
const USAGE_META = {
  // Netlify function hits (kind = 'call')
  btc: { label: "Bitcoin price + sparkline" },
  "btc-candles": { label: "Bitcoin candles · Kraken" },
  markets: { label: "Gold, NVDA, MSTR, STRC quotes" },
  "ticker-candles": { label: "Watchlist ticker charts" },
  "alt-scan": { label: "Alt Season board + movers" },
  "alt-cron-background": { label: "Alt Season hourly screener" },
  "alt-candles": { label: "Alt coin candles · CoinGecko" },
  "stock-scan": { label: "Stocks board + movers" },
  "stock-cron-background": { label: "Stocks screener · hourly trigger" },
  "stock-settle-background": { label: "Stocks session screener" },
  wire: { label: "Crypto headlines · CoinDesk + Cointelegraph" },
  calendar: { label: "US econ calendar" },
  "calendar-events": { label: "Meetings from your iCal" },
  "econ-resolve-background": { label: "Econ prints resolved" },
  gsc: { label: "Search Console · zerotosecure.com", tool: "Zero To Secure" },
  shopify: { label: "Shopify orders + visits", tool: "Zero To Secure" },
  "zts-pipeline": { label: "ZTS creator pipeline", tool: "Zero To Secure" },
  "clarify-pipeline": { label: "Clarify outreach pipeline", tool: "Clarify Paid Search" },
  "site-status": { label: "Property uptime checks" },
  tmdb: { label: "Movie poster + year lookup" },
  "export-data": { label: "Backup export" },
  deploy: { label: "Netlify build trigger" },
  "db-admin": { label: "Supabase maintenance command" },
  health: { label: "Server key/config probe" },
  claude: { label: "Claude proxy" },
  trmnl: { label: "TRMNL e-ink render" },
  "workout-import": { label: "Workout import" },
  "note-capture": { label: "Note dictated from the watch" },
  // Doesn't bill anything — no model behind it — but every function gets a name
  // so that if it ever DOES log, the Usage table reads as English on the first
  // row rather than after someone notices a wire identifier.
  plaid: { label: "Bank sync (Plaid)" },
  "fetch-page": { label: "Page fetched for Learn" },
  "upstream-run-background": { label: "UPSTREAM run" },
  // Model calls (kind = 'anthropic')
  chief: { label: "Chief · chat reply" },
  route: { label: "Chief · intent routing" },
  mind_pulse: { label: "Mind · pulse" },
  mind_chat: { label: "Mind · chat" },
  briefing_update: { label: "Brief · narrative refresh" },
  event_impact: { label: "Watch This Week · one-line take" },
  meal_idea: { label: "Meal suggestion" },
  learn_skill: { label: "Skill learned" },
  oversight: { label: "Oversight review" },
  parse_calendar_image: { label: "Calendar screenshot → events" },
  parse_birthdays: { label: "Birthday list parsed" },
  conn_check: { label: "Status tab · Anthropic ping" },
  "mini-worker": { label: "Mini Me · task run" },
  audit: { label: "AI site audit" },
  "auto-fix": { label: "AI fix proposal" },
  upstream: { label: "UPSTREAM pipeline" },
  "upstream-tell": { label: "UPSTREAM tell" },
  nostradamus: { label: "Nostradamus run" },
};
// Not every writer is in this repo. The usage_log is shared, so ids this
// codebase has never heard of turn up in it (ideafeed/extract, and whatever
// comes next). They must still read as something — but INVENTING a description
// for a call we can't see the source of would be worse than the raw id, so this
// only reformats the id's own words: slashes become separators, underscores
// become spaces, each part gets its capital. Same information, legible.
const humanize = (fn) => String(fn || "").split("/")
  .map(part => part.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()))
  .join(" · ");

// humanize() is the fallback, not blank: an fn nobody labelled reads as its own
// words rather than vanishing. That mattered for the retired Discord path, which
// wrote `discord_<stage>` — a family rather than a fixed key — and had a prefix
// branch here. Both are gone, and nothing is lost by their going: that path never
// wrote a row in production, so there is no history to keep legible. Should any
// `discord_*` row ever turn up from a database restore, humanize() renders it as
// "Discord chief" rather than swallowing it.
const usageLabel = (fn) => USAGE_META[fn]?.label || humanize(fn);

// The raw id rides under every row so a line here is greppable against the code
// that wrote it — but only when it says something the label didn't. Printing
// "ideafeed/extract" under "Ideafeed · Extract" is a row that appears to stutter.
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const showRawId = (fn) => squash(usageLabel(fn)) !== squash(fn);

// ── The Pentagon, by tool ────────────────────────────────────────────────────
// ZTS, Clarify, Runway and Macro were consolidated into one app (see
// assets/properties.js), so "which venture is this call for" is no longer
// answerable from the URL — every one of them is the-pentagon.netlify.app. The
// attribution therefore lives here, on the PULL: `usageLabel`'s `tool` field
// says which venture a given fn fetches for.
//
// Honest about its own scope, which is the only way a roll-up like this is
// worth having: this counts Board Room's pulls FOR each tool. It is not the
// Pentagon app's own spend — that app logs to its own project and Board Room
// has no read on it. Tools that Board Room doesn't pull for show a real zero
// rather than being dropped, so "no line here" can't be mistaken for "no data".
const PENTAGON_TOOLS = ["Zero To Secure", "Clarify Paid Search", "Macro Command Center", "Runway"];

/* One row shape, shared by both halves of the table and by the Pentagon
   roll-up, so a line reads the same wherever it appears.

   Two lines, not one wide row: the NAME earns the full width on a phone, and
   the numbers sit under it where nothing has to truncate. The one figure that
   matters for this kind of row is right-aligned on the first line; the rest are
   dot-separated underneath, and any falsy entry drops out rather than leaving a
   stray separator — which is what lets a row carry two facts or four without
   needing a different layout for each. */
function UsageRows({ title, note, rows, value, meta, failed }) {
  if (!rows.length) return null;
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "16px 2px 4px" }}>
        <span className="t-label">{title}</span>
        <span className="t-cap" style={{ color: "var(--faint)" }}>{note}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {rows.map(([fn, s], i) => {
          const bits = (meta(fn, s) || []).filter(Boolean);
          const nFailed = failed(s);
          return (
            <div key={fn} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 2px", borderTop: i > 0 ? "0.5px solid var(--line)" : "none" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span className="t-call" style={{ color: "var(--ink)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{usageLabel(fn)}</span>
                <span className="t-num" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)", flex: "none" }}>{value(s)}</span>
              </div>
              <div className="t-num" style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1.5 }}>
                {bits.join(" · ")}
                {nFailed > 0 && <span style={{ color: "var(--red)" }}>{bits.length ? " · " : ""}{nFailed} failed</span>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function UsageCard({ isMobile }) {
  const [summary, setSummary] = useState(null); // null = loading; accurate totals via server-side aggregation, not capped by row count
  const [recentRows, setRecentRows] = useState(null); // separate, smaller fetch — only for the raw log detail view below
  const [err, setErr] = useState(null);
  const [windowIdx, setWindowIdx] = useState(1);
  const [retryNonce, setRetryNonce] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [logShown, setLogShown] = useState(LOG_STEP);
  const [fnsOpen, setFnsOpen] = useState(false);

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
  // ── Two tables, because there are two kinds of row ──
  // A model call has a cost and a token count. A function hit has neither — it
  // has a latency and a failure count. Mixing them into one table meant half
  // the rows showed "—" in the money column and none of them showed the number
  // that actually described them, which is a table that looks broken while
  // working correctly. Split by `kind` and every row's headline number is real.
  //
  // Split on fn+kind rather than fn: `audit` and `auto-fix` log BOTH ways (the
  // browser records the function hit, the function records its own model call),
  // and folding those together produced one row whose call count and cost
  // described two different events.
  const bucket = (into, r) => {
    const k = r.fn;
    into[k] = into[k] || { calls: 0, cost: 0, failed: 0, inTok: 0, outTok: 0, msWeighted: 0 };
    const calls = Number(r.calls);
    into[k].calls += calls;
    into[k].cost += Number(r.cost_usd || 0);
    into[k].failed += Number(r.failed);
    into[k].inTok += Number(r.in_tokens || 0);
    into[k].outTok += Number(r.out_tokens || 0);
    // Weighted by call count — a plain mean of per-model averages would let one
    // 3-call row drag the number as hard as a 500-call one.
    into[k].msWeighted += Number(r.ms_avg || 0) * calls;
  };
  const byModel = {}, byPull = {};
  (summary || []).forEach(r => bucket(r.kind === "anthropic" ? byModel : byPull, r));
  const avgMs = (s) => (s.calls ? Math.round(s.msWeighted / s.calls) : 0);

  // Every fn, not a top slice. A spend table that silently truncates is the
  // same failure as one that reads $0.000 — the row you're hunting is exactly
  // the one that fell off the end. Long tails collapse behind a disclosure
  // instead, so the default view stays short without lying about what it holds.
  const modelFns = Object.entries(byModel).sort((a, b) => (b[1].cost - a[1].cost) || (b[1].calls - a[1].calls));
  const pullFns = Object.entries(byPull).sort((a, b) => (b[1].calls - a[1].calls));
  const TOP = 6;
  const hidden = Math.max(0, modelFns.length - TOP) + Math.max(0, pullFns.length - TOP);

  // Pentagon roll-up: fold every fn that serves a tool into that tool's row,
  // across both kinds — a tool's cost to run is its model spend plus its pulls.
  const byTool = Object.fromEntries(PENTAGON_TOOLS.map(t => [t, { calls: 0, cost: 0, failed: 0, fns: [] }]));
  [byModel, byPull].forEach(map => Object.entries(map).forEach(([fn, s]) => {
    const tool = USAGE_META[fn]?.tool;
    if (!tool || !byTool[tool]) return;
    byTool[tool].calls += s.calls;
    byTool[tool].cost += s.cost;
    byTool[tool].failed += s.failed;
    if (!byTool[tool].fns.includes(fn)) byTool[tool].fns.push(fn);
  }));
  const pentagonCalls = Object.values(byTool).reduce((n, t) => n + t.calls, 0);
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

          {summary === null && <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "18px 0" }}>Loading…</div>}
          {summary !== null && !modelFns.length && !pullFns.length && (
            <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "18px 0" }}>No calls logged in this window yet.</div>
          )}

          {/* Model calls — the money. Headline number is the spend. */}
          <UsageRows
            title="Model calls" note="what the AI actually did"
            rows={fnsOpen ? modelFns : modelFns.slice(0, TOP)}
            value={(s) => "$" + s.cost.toFixed(3)}
            meta={(fn, s) => [
              showRawId(fn) && fn,
              `${s.calls} call${s.calls === 1 ? "" : "s"}`,
              (s.inTok > 0 || s.outTok > 0) && `${fmtK(s.inTok)}/${fmtK(s.outTok)} tok`,
            ]}
            failed={(s) => s.failed}
          />

          {/* Data pulls — the plumbing. Headline number is how often it ran;
              cost is structurally zero here, so latency takes the slot where
              a "—" used to sit. */}
          <UsageRows
            title="Data pulls" note="feeds and functions"
            rows={fnsOpen ? pullFns : pullFns.slice(0, TOP)}
            value={(s) => `${s.calls.toLocaleString()} call${s.calls === 1 ? "" : "s"}`}
            meta={(fn, s) => [
              showRawId(fn) && fn,
              avgMs(s) > 0 && `${avgMs(s)}ms avg`,
              s.cost > 0 && "$" + s.cost.toFixed(3),
            ]}
            failed={(s) => s.failed}
          />

          {hidden > 0 && (
            <Button kind="plain" size="sm" onClick={() => setFnsOpen(o => !o)} style={{ alignSelf: "flex-start", paddingLeft: 0, marginTop: 2 }}>
              {fnsOpen ? `Show top ${TOP} of each` : `Show ${hidden} more`}
              <IcChevronDown size={12} style={{ transform: fnsOpen ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />
            </Button>
          )}

          {/* ── The Pentagon, by tool ──
              The four ventures share one app and one URL now, so this is the
              only place left that answers "what is Board Room spending on each
              of them". */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "18px 2px 4px" }}>
            <span className="t-label">The Pentagon</span>
            <span className="t-cap" style={{ color: "var(--faint)" }}>by tool</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {summary === null ? (
              <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "10px 0" }}>Loading…</div>
            ) : PENTAGON_TOOLS.map((tool, i) => {
              const s = byTool[tool];
              const dead = s.calls === 0;
              // Calls, not cost, in the headline slot. Every one of these is a
              // data pull, so the money column was structurally "—" on all four
              // rows — a column that can only ever say nothing. Spend still
              // appears underneath the moment a tool has any.
              const bits = [
                // Raw ids here, not labels: several labels contain a "·" of
                // their own ("Search Console · zerotosecure.com"), and joining
                // those with another one turns the line to mush.
                s.fns.join(", "),
                s.cost > 0 && "$" + s.cost.toFixed(3),
              ].filter(Boolean);
              return (
                <div key={tool} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 2px", borderTop: i > 0 ? "0.5px solid var(--line)" : "none", opacity: dead ? 0.55 : 1 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                    <span className="t-call" style={{ color: "var(--ink)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tool}</span>
                    <span className="t-num" style={{ fontSize: 12.5, fontWeight: 600, color: dead ? "var(--faint)" : "var(--ink)", flex: "none" }}>
                      {dead ? "none" : `${s.calls.toLocaleString()} call${s.calls === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <div className="t-num" style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1.5 }}>
                    {dead ? "no pulls from Board Room" : bits.join(" · ")}
                    {s.failed > 0 && <span style={{ color: "var(--red)" }}> · {s.failed} failed</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="t-foot" style={{ color: "var(--faint)", padding: "8px 2px 0", lineHeight: 1.5 }}>
            {summary === null ? "" : pentagonCalls === 0
              ? "Nothing pulled for a Pentagon tool in this window."
              : "Counts what Board Room fetches for each tool — not the Pentagon app's own spend, which logs to its own project."}
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
                  <span className="t-call" style={{ fontSize: 11.5, color: "var(--ink)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{usageLabel(r.fn)}{r.model ? ` · ${r.model}` : ""}{!r.ok && r.detail ? ` · ${r.detail}` : ""}</span>
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

// Usage sub-tab — the durable usage log, and nothing else.
//
// Model Control lived here: a per-layer model picker (Mind + Mini Me delegate)
// over a cost estimate. It has been removed. Those two layers are the thinking
// surfaces, and the thinking surfaces are gone from the app — the Mind tab was
// retired and Mini Me with it, so the picker was steering runs that no longer
// happen and quoting an estimate for them. What is left on this page is
// monitoring, so it should read as monitoring.
//
// THE MIND RETIREMENT, kept here because this is the last live file that leans on
// it. It used to be told by the header of pages/assets/AssetsPage.jsx, which was
// itself unrouted for a long time before it was deleted — App.jsx sends `assets`
// and `systems` to the Brief, nothing imported the module, and the one named
// import it still made (MinerPanel, from this file) had stopped resolving when
// that re-export was removed, so the page could not have rendered if it had been
// routed. What it recorded: Mind was first unrouted and then deleted outright —
// the canvas, the genome, the seat pages and the Learn editor are all out of the
// tree. The Supabase tables it wrote to are untouched, and the data still does
// work: skills load from the database and still shape prompts (buildSkillsBlock),
// and mini-worker still reads the compiled `mind_prompt` row. What is gone is
// every editor for any of it.
//
// Deliberately NOT deleted from settings: `settings.models` and `settings.mini`
// still hold whatever was last chosen, and the delegate still reads
// settings.mini.model if it is ever run again. Removing the control does not
// reset the account's stored choice, which is what makes this reversible.
//
// The obs/localStorage "Today" line went with it — it was a second, per-browser
// spend number sitting beside the durable cross-device one, and two numbers for
// the same question that disagree by design is worse than one.
export function UsageTab({ isMobile }) {
  return <UsageCard isMobile={isMobile} />;
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

/* One group, folded down to a line you can act on.
   The tally IS the summary — "17 live · 2 down" answers the only question this
   tab is ever opened to answer, and the twenty rows behind it are the follow-up
   you need about twice a year. */
function ConnGroup({ group, checks, open, onToggle }) {
  const rows = group.keys.map(k => ({ k, meta: CONN_META[k], check: checks[k] }));
  const n = (s) => rows.filter(r => r.check?.status === s).length;
  const bad = n("down"), part = n("warn"), live = n("ok"), idle = n("off") + n("local");
  const checking = rows.filter(r => !r.check || r.check.status === "checking").length;

  // Read left to right in severity order, and say nothing about states that
  // aren't happening — "0 down" is noise on a healthy group.
  const bits = [];
  if (checking) bits.push({ t: `${checking} checking`, c: "var(--sub)" });
  if (bad) bits.push({ t: `${bad} down`, c: "var(--red)" });
  if (part) bits.push({ t: `${part} partial`, c: "var(--amber)" });
  if (live) bits.push({ t: `${live} live`, c: "var(--green)" });
  if (idle) bits.push({ t: `${idle} not set`, c: "var(--faint)" });

  return (
    <div>
      <button onClick={onToggle} aria-expanded={open}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, background: "none", border: 0, padding: "12px 4px", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
        <Dot tone={bad ? "var(--red)" : part ? "var(--amber)" : checking ? "var(--sub)" : live ? "var(--green)" : "var(--faint)"} size={7} pulse={checking > 0} />
        <span className="t-label" style={{ flex: "none" }}>{group.title}</span>
        <span style={{ display: "flex", alignItems: "baseline", gap: 7, flex: 1, minWidth: 0, flexWrap: "wrap" }}>
          {bits.map((b, i) => (
            <span key={i} className="t-cap t-num" style={{ color: b.c, fontWeight: b.c === "var(--faint)" ? 400 : 600 }}>{b.t}</span>
          ))}
        </span>
        <IcChevronDown size={13} style={{ flex: "none", color: "var(--faint)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />
      </button>
      <div className={`expand${open ? " open" : ""}`}>
        <div style={{ paddingBottom: 4 }}>
          <CellGroup>
            {rows.map(({ k, meta, check }) => (
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
            ))}
          </CellGroup>
        </div>
      </div>
    </div>
  );
}

/* ── Crashes on this build ────────────────────────────────────────────────────
   The read that makes the crash log worth writing. ErrorBoundary has always
   recorded render crashes into localStorage.br_crashes, and until now nothing in
   src/ ever read that key back — a diary kept for nobody, thrown away the next
   time Safari evicted this origin's storage. Errors thrown outside a render were
   not recorded at all. src/lib/telemetry.js now files both into
   boardroom.client_errors with the build stamped on the row, and this is the
   surface that reads it.

   It belongs on Status beside the build stamp in the footer below, because the
   question it answers is about that exact string: has anything thrown since this
   deploy went out. */

// The local log, exactly as ErrorBoundary writes it. Defensive on both counts —
// localStorage throws in Safari private mode, and the value is whatever a
// previous version of that code left behind — because a malformed crash log must
// not be able to crash the panel that displays it.
const readLocalCrashes = () => {
  try {
    const log = JSON.parse(localStorage.getItem("br_crashes") || "[]");
    return Array.isArray(log) ? log.filter(r => r && typeof r === "object") : [];
  } catch { return []; }
};

// A render loop fills the local log with twenty copies of one line — the boundary
// unshifts an entry on every catch — so identical entries fold into one row with
// a tally. Nothing is lost by that: "×20" says precisely what the twenty lines
// said, and it keeps this list honest against the count above it, which is one
// row per distinct crash by design. The entries arrive newest-first, so the one
// kept carries the most recent timestamp.
const foldLocal = (rows) => {
  const out = [];
  for (const r of rows) {
    const key = `${r.where || "root"}|${r.msg}|${r.build || ""}`;
    const hit = out.find(o => o.key === key);
    if (hit) hit.n++;
    else out.push({ ...r, key, n: 1 });
  }
  return out;
};

// A fourth age formatter in this file, and it earns its place: `ago` in the usage
// card has no " ago" suffix, `agoCheck` in StatusTab clips at minutes because a
// status check always just ran, and `deployAge` is spelled for deploys. A crash
// can be four days old and needs to say so.
const crashAge = (ts) => {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (!isFinite(s) || s < 0) return "";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function CrashRow() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);        // null = reading; { n, rows } | { err }
  const [local, setLocal] = useState(readLocalCrashes);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState(null);
    (async () => {
      if (!supabase) { if (alive) setState({ err: "No Supabase client in this build, so there is no durable crash log to read." }); return; }
      try {
        // count: "exact" is the load-bearing part. The row list is capped at 20
        // because nobody scrolls further, and taking the headline number from a
        // capped list is the bug the usage card already paid for once — it would
        // read "20 crashes" forever no matter how many there really were. The
        // count comes from Postgres and describes every matching row.
        const { data, error, count } = await supabase
          .from("client_errors")
          .select("kind,message,created_at", { count: "exact" })
          .eq("build", BUILD)
          .order("created_at", { ascending: false })
          .limit(20);
        if (!alive) return;
        if (error) {
          // The one refusal worth translating. Until 0034_client_errors.sql is
          // pasted into the SQL editor, PostgREST answers this select with
          // "relation does not exist" — and that is the precise moment when
          // showing a calm zero would be the app lying about the thing it was
          // built to stop lying about.
          const missing = error.code === "42P01" || /client_errors/.test(error.message || "");
          setState({ err: missing
            ? "The client_errors table isn't there yet — paste supabase/migrations/0034_client_errors.sql into the Supabase SQL editor."
            : error.message || "The crash log refused the read." });
          return;
        }
        // A select that comes back without a count is a select whose total is
        // unknown, and an unknown total does not get to be printed as a number.
        if (typeof count !== "number") { setState({ err: "The crash log answered without a count, so the total isn't known." }); return; }
        setState({ n: count, rows: data || [] });
      } catch (e) {
        if (alive) setState({ err: e?.message || "The crash log didn't answer." });
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const retry = () => { setLocal(readLocalCrashes()); setNonce(n => n + 1); };

  const reading = state === null;
  const failed = !!state?.err;
  const n = state?.n ?? 0;
  const latest = state?.rows?.[0];

  // Three states, three tones, in this page's own vocabulary: checking is --sub,
  // a thing that is wrong is --red, a thing we could not determine is --amber
  // (the same "partial" the group headers use), and healthy is --green. Zero
  // crashes gets a sentence rather than an empty line — a blank row here reads
  // as a panel that failed to load, which is the opposite of the news it is
  // carrying.
  const tone = reading ? "var(--sub)" : failed ? "var(--amber)" : n > 0 ? "var(--red)" : "var(--green)";
  const headline = reading ? "reading…" : failed ? "read failed" : n > 0 ? `${n} since this deploy` : "none since this deploy";
  const sub = reading ? "" : failed ? state.err
    : n > 0 ? [latest?.message, crashAge(latest?.created_at)].filter(Boolean).join(" · ")
    : "Nothing has thrown since this build went out.";

  return (
    <div>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, background: "none", border: 0, padding: "12px 4px", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
        <Dot tone={tone} size={7} pulse={reading} />
        <span className="t-label" style={{ flex: "none" }}>Crashes</span>
        <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          <span className="t-cap t-num" style={{ color: tone, fontWeight: 600 }}>{headline}</span>
          {/* A crash message is one long line and must clip; a failure reason is
              a sentence you have to be able to finish reading, so it wraps. */}
          {sub && (
            <span className="t-num" style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1.5, ...(failed ? { wordBreak: "break-word" } : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }}>{sub}</span>
          )}
        </span>
        <IcChevronDown size={13} style={{ flex: "none", color: "var(--faint)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />
      </button>
      <div className={`expand${open ? " open" : ""}`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 4 }}>
          {failed && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 2px" }}>
              <Button kind="tinted" size="sm" onClick={retry}>Retry</Button>
            </div>
          )}
          {!!state?.rows?.length && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {state.rows.map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "6px 2px", borderTop: i > 0 ? "0.5px solid var(--line)" : "none" }}>
                  <span className="t-num" style={{ fontSize: 11, color: "var(--faint)", flex: "none", width: 44 }}>{crashAge(r.created_at)}</span>
                  <span className="t-cap" style={{ color: "var(--faint)", flex: "none", width: 50 }}>{r.kind}</span>
                  <span className="t-num" style={{ fontSize: 11.5, color: "var(--ink)", flex: 1, minWidth: 0, lineHeight: 1.5, wordBreak: "break-word" }}>{r.message}</span>
                </div>
              ))}
              {n > state.rows.length && (
                <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 2px 0" }}>
                  The {state.rows.length} most recent of {n}.
                </div>
              )}
            </div>
          )}

          {/* The local log, finally read. It is a different record, not a copy:
              it needs no network and no session, it holds the last twenty
              whatever build they came from, and it is per-browser — so it is
              labelled as this device rather than folded into the count above. */}
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "0 2px 4px" }}>
              <span className="t-label">This device</span>
              <span className="t-cap" style={{ color: "var(--faint)" }}>written with no network</span>
            </div>
            {local.length === 0 ? (
              <div className="t-foot" style={{ color: "var(--faint)", padding: "0 2px" }}>This browser has no local crash log — nothing has hit a boundary here.</div>
            ) : foldLocal(local).map((r, i) => (
              <div key={r.key} style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "6px 2px", borderTop: i > 0 ? "0.5px solid var(--line)" : "none" }}>
                <span className="t-num" style={{ fontSize: 11, color: "var(--faint)", flex: "none", width: 44 }}>{crashAge(r.at)}</span>
                <span className="t-cap" style={{ color: "var(--faint)", flex: "none", width: 50, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.where || "root"}</span>
                <span className="t-num" style={{ fontSize: 11.5, color: "var(--ink)", flex: 1, minWidth: 0, lineHeight: 1.5, wordBreak: "break-word" }}>
                  {r.msg}
                  {r.n > 1 && <span style={{ color: "var(--sub)", fontWeight: 600 }}> ×{r.n}</span>}
                  {/* Only said when it is known and it differs. Entries written
                      before the build stamp existed carry no build, and guessing
                      one onto them would be the invention this app doesn't do. */}
                  {r.build && r.build !== BUILD && <span style={{ color: "var(--faint)" }}> · another build</span>}
                </span>
              </div>
            ))}
          </div>

          {/* Said out loud because the number above would otherwise imply a
              frequency it does not measure. telemetry.js sends one row per
              distinct message+stack per build — a component in a render loop
              throws hundreds of times a second, and reporting each throw would
              make the crash reporter the outage. So this counts what broke, not
              how often, and that distinction has to be on screen next to the
              count rather than buried in the module that made the choice. */}
          <div className="t-foot" style={{ color: "var(--faint)", padding: "0 2px", lineHeight: 1.5 }}>
            One line per distinct crash: a repeat of the same error is reported once per build, and folded into a ×count on this device. These say what broke, not how often.
          </div>
        </div>
      </div>
    </div>
  );
}

// Status sub-tab — connection roll-up + per-pipe health. The connections hook
// lives in the parent (Assets page) so results persist across sub-tab switches;
// this tab is pure presentation over the passed-in state.
//
// CONSOLIDATED, NOT TRUNCATED. This used to render all twenty-five pipes as
// open cells, which on a phone is a screen and a half of rows that say "Live" —
// the two that don't are the entire point and they were the hardest to find.
//
// So every group is folded to its tally and opens on a tap. Each header carries
// its own counts, so a failure is never silent; the fold only decides whether
// you can see which row it was without tapping.
export function StatusTab({ checks, lastRun, running, runAll, isMobile }) {
  const vals = Object.values(checks);
  const counts = {
    ok: vals.filter(c => c?.status === "ok").length,
    warn: vals.filter(c => c?.status === "warn").length,
    down: vals.filter(c => c?.status === "down").length,
    off: vals.filter(c => c?.status === "off" || c?.status === "local").length,
  };
  const agoCheck = (ts) => { if (!ts) return "—"; const s = Math.floor((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`; };

  // Nothing is open until you open it. A group you toggle holds whatever you
  // set for as long as you're on the tab, so a list can be pinned open while
  // you work in it; leaving and coming back starts folded again.
  const [openMap, setOpenMap] = useState({});
  const isOpen = (g) => openMap[g.title] === true;

  return (
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

      <Card pad="md" style={{ marginTop: 12, display: "flex", flexDirection: "column" }}>
        {CONN_GROUPS.map((g, i) => (
          <div key={g.title} style={{ borderTop: i > 0 ? "0.5px solid var(--line)" : "none" }}>
            <ConnGroup group={g} checks={checks} open={isOpen(g)}
              onToggle={() => setOpenMap(m => ({ ...m, [g.title]: !isOpen(g) }))} />
          </div>
        ))}
        {/* Last in the card and immediately above the build stamp, because it is
            a fact about that stamp: the pipes above answer "is anything down",
            this answers "did this deploy break anything". */}
        <div style={{ borderTop: "0.5px solid var(--line)" }}>
          <CrashRow />
        </div>
        <div className="t-foot" style={{ color: "var(--faint)", paddingTop: 8, lineHeight: 1.5 }}>
          Every group counts its own pipes here. Tap one to see which row is which.
          <br />
          <span className="t-num">Build {BUILD}</span>
        </div>
      </Card>
    </>
  );
}

/* ═══ Deploy — build triggers and rollback ═════════════════════════════════ */

// How long ago a deploy went out, in the same clipped vocabulary the usage log
// uses. The question a rollback list is opened with is "how far back am I
// going", and "3d ago" answers that faster than a formatted date does.
const deployAge = (ts) => {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (!isFinite(s) || s < 0) return "";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const shortSha = (ref) => String(ref || "").slice(0, 7);

export function DeployTab({ isMobile }) {
  const [confirmEl, confirm] = useConfirm();
  const [deploys, setDeploys] = useState({});
  const [histFor, setHistFor] = useState(null); // the property whose deploy list is open
  const [hist, setHist] = useState(null);       // null = loading; { rows } or { err }
  const [restoring, setRestoring] = useState(null); // id of the deploy mid-restore

  // Through the house confirm, like rollBack below, and for the same reason: a
  // tap here starts a production build of a named site, and on a phone the
  // row's title was clipped to "Clarify…" — two rows read identically, so the
  // confirm is where the site's name is finally spelled out before anything
  // happens. Not destructive: a build that fails leaves the live deploy alone.
  const redeploy = async (p) => {
    const go = await confirm({
      title: `Redeploy ${p.name}?`,
      message: `Triggers a fresh Netlify build of ${p.site} from its connected repo. It goes live when the build finishes — minutes, not seconds — and if the build fails the deploy that is live stays live.`,
      confirmLabel: "Redeploy",
    });
    if (!go) return;
    setDeploys(d => ({ ...d, [p.name]: { busy: true } }));
    // callFnFull, not callFn: a build trigger that fails does it for a reason
    // the function already puts in the body (no token, site not on this token,
    // Netlify said no), and callFn throws that body away. See the Replace-a-File
    // note below for what "failed — check the deploy function" cost last time.
    const { ok, data } = await callFnFull("deploy", { site: p.site, action: "build" });
    const good = ok && !!data?.success;
    setDeploys(d => ({ ...d, [p.name]: { busy: false, ok: good, when: "just now", err: good ? null : (data?.error || "the deploy function didn't answer") } }));
  };
  // The "Replace a File" panel lived here and could never work: it POSTed
  // action:"replace-file", and deploy.js answers that with 400 "only
  // action:'build' is supported — zip deploys are disabled by design". callFn
  // discards the error body, so every attempt reported "failed — see Netlify
  // deploy log" and sent you to a log with nothing in it, because no build was
  // ever triggered. Removed rather than reimplemented: the function disables
  // this deliberately, so the UI was the side that was wrong.
  //
  // Rollback is the opposite case, and the reason this tab now has two controls
  // per site. A build takes minutes and can fail again; putting the last good
  // deploy back is instant, because the artifact is already on Netlify's CDN.
  // When a bad deploy is live, that difference is the whole outage.

  const loadHistory = async (p) => {
    setHist(null);
    const { ok, data } = await callFnFull("deploy", { site: p.site, action: "list" });
    if (!ok || !data?.success) { setHist({ err: data?.error || "the deploy function didn't answer" }); return; }
    setHist({ rows: data.deploys || [] });
  };
  const toggleHistory = (p) => {
    if (histFor?.name === p.name) { setHistFor(null); setHist(null); return; }
    setHistFor(p);
    loadHistory(p);
  };

  // Rolling back republishes a build that already exists, which makes it
  // reversible in principle — the deploy you are leaving stays in the list — but
  // it changes what the public sees the moment it lands, and it does it without
  // a build log to read afterwards. So it goes through the house confirm, and
  // the confirm names the commit, because "roll back?" with no sha in it is a
  // question you cannot actually answer.
  const rollBack = async (p, d) => {
    const sha = shortSha(d.commit_ref);
    const age = deployAge(d.created_at);
    const ok = await confirm({
      title: `Roll back to ${sha || "this deploy"}?`,
      message: `${p.name} goes back to "${d.title || "this deploy"}"${age ? `, built ${age}` : ""}. It publishes immediately, with no rebuild. The deploy you're leaving stays in this list, so you can come forward the same way.`,
      confirmLabel: "Roll back",
      destructive: true,
    });
    if (!ok) return;
    setRestoring(d.id);
    const res = await callFnFull("deploy", { site: p.site, action: "restore", deploy_id: d.id });
    setRestoring(null);
    if (!res.ok || !res.data?.success) {
      await confirm({
        title: "Rollback failed",
        message: res.data?.error || "Netlify didn't accept the restore. Nothing changed — the deploy that was live is still live.",
        confirmLabel: "OK", cancelLabel: false,
      });
      return;
    }
    // Re-read the list rather than patching it locally, so the "Live now" mark
    // comes from Netlify's answer to who is published instead of our assumption.
    loadHistory(p);
  };

  // Only ventures with a real Netlify slug on this token. Runway and FFSR never
  // had one; Zero To Secure and Clarify Paid Search named sites that do not
  // exist (see properties.js), so their rows could only 404 — the Pentagon row
  // is the deploy for all of them.
  const deployables = PROPERTIES.filter(p => !p.assetsOnly);

  return (
    <div style={{ maxWidth: 520 }}>
      <div>
        <SectionHeader title="Deployments" trailing="Netlify" />
        <CellGroup>
          {deployables.map((p, i) => {
            const d = deploys[p.name] || {};
            const open = histFor?.name === p.name;
            const line = d.busy ? "Triggering build…" : d.when ? (d.ok ? `Build triggered · ${d.when}` : `Trigger failed — ${d.err}`) : `netlify · ${p.site}`;
            const controls = (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
                <Button kind="plain" size="sm" onClick={() => toggleHistory(p)}>{open ? "Hide" : "Rollback"}</Button>
                <Button kind="quiet" size="md" disabled={d.busy} onClick={() => redeploy(p)} style={{ flex: "none" }}>
                  {d.busy ? "Deploying…" : "Redeploy"}
                </Button>
              </span>
            );
            // On a phone the two buttons are ~190px of a 375px row, which left
            // the title ~100px: "Clarify…" twice, and no way to tell which site
            // a Redeploy belonged to on the one surface this panel is for. So
            // the controls drop under the title there and the title keeps the
            // width. The row below carries the group's own hairline, because
            // the cell divider only draws between adjacent cells.
            return (
              <div key={p.name} style={{ position: "relative" }}>
                <Cell
                  leading={<Dot tone={d.busy ? "var(--amber)" : d.when ? (d.ok ? "var(--green)" : "var(--red)") : "var(--faint)"} size={7} pulse={d.busy} />}
                  title={p.name}
                  sub={<span className="t-num" style={{ fontSize: 11.5, color: d.busy ? "var(--amber)" : d.when && !d.ok ? "var(--red)" : "var(--sub)" }}>{line}</span>}
                  trailing={isMobile ? null : controls}
                />
                {isMobile && (
                  <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 16px 10px 56px" }}>{controls}</div>
                )}
                {i > 0 && <span aria-hidden="true" style={{ position: "absolute", top: 0, left: 56, right: 0, height: 0.5, background: "var(--line)" }} />}
              </div>
            );
          })}
        </CellGroup>
        <div className="t-foot" style={{ color: "var(--faint)", padding: "8px 16px 0" }}>
          Each redeploy triggers a fresh Netlify build from the site's connected repo. Live/down state lives under the Status tab.
        </div>
      </div>

      {histFor && (
        <div style={{ marginTop: 16 }}>
          <SectionHeader title="Recent deploys" trailing={histFor.name} />
          <Card pad="md">
            {hist === null && (
              <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "18px 0" }}>Loading…</div>
            )}
            {hist?.err && (
              <EmptyState
                title="Deploy history unreachable"
                sub={hist.err}
                action={<Button kind="tinted" size="sm" onClick={() => loadHistory(histFor)}>Retry</Button>}
                style={{ padding: "20px 12px" }}
              />
            )}
            {hist?.rows?.length === 0 && (
              <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "18px 0" }}>No finished builds on this site yet.</div>
            )}
            {hist?.rows?.map((d, i) => {
              const sha = shortSha(d.commit_ref);
              const busy = restoring === d.id;
              return (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 2px", borderTop: i > 0 ? "0.5px solid var(--line)" : "none" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                      <span className="t-num" style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", flex: "none" }}>{sha || "no commit"}</span>
                      <span className="t-call" style={{ fontSize: 12, color: "var(--sub)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title || "(no message)"}</span>
                    </div>
                    <div className="t-num" style={{ fontSize: 11, color: "var(--faint)" }}>
                      {[deployAge(d.created_at), d.branch].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  {/* The published deploy gets the status vocabulary, not a
                      button: restoring what is already live is a no-op that
                      Netlify reports as a success, which is the worst possible
                      answer to a tap on a rollback control. */}
                  {d.published ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
                      <Dot tone="var(--green)" size={6} />
                      <span className="t-cap" style={{ color: "var(--green)", fontWeight: 600 }}>Live now</span>
                    </span>
                  ) : (
                    <Button kind="quiet" size="sm" disabled={!!restoring} onClick={() => rollBack(histFor, d)} style={{ flex: "none" }}>
                      {busy ? "Rolling back…" : "Roll back"}
                    </Button>
                  )}
                </div>
              );
            })}
          </Card>
          <div className="t-foot" style={{ color: "var(--faint)", padding: "8px 16px 0", lineHeight: 1.5 }}>
            Only finished builds are listed — a failed one has no artifact to publish. Rolling back republishes an existing build in seconds; it does not rebuild, so the next push still deploys whatever is on the branch.
          </div>
        </div>
      )}

      {confirmEl}
    </div>
  );
}

/* ═══ Supabase console — allowlisted maintenance ops ═══════════════════════ */

export function SupabaseTab() {
  // There was a "Project" pill row here, decorative twice over: db-admin's
  // ping never returns a `projects` array, so the list stayed the hardcoded
  // ["Board Room"], and db-admin ignores body.project entirely — every command
  // runs against the one SUPABASE_URL in the env. The prompt echoed
  // "> [Board Room] …", which read like routing that wasn't happening.
  const [sqlInput, setSqlInput] = useState("");
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlLog, setSqlLog] = useState([{ kind: "ok", text: "ready — allowlisted commands only" }]);
  const runSql = async () => {
    const q = sqlInput.trim();
    if (!q || sqlBusy) return;
    setSqlLog(l => [...l, { kind: "cmd", text: `> ${q}` }]);
    setSqlInput(""); setSqlBusy(true);
    // callFnFull, not callFn: db-admin always says WHY it refused — the
    // allowlist, a missing key, a 502 out of PostgREST — and callFn drops that
    // body on the floor. So every refusal printed "db-admin function not
    // deployed yet" and sent you hunting a deploy problem that wasn't there.
    // The pill that pruned usage_log answered 400 for months and this is the
    // line that hid it. A 404 is the only status that means not deployed.
    const { ok, status, data } = await callFnFull("db-admin", { command: q });
    const good = ok && !!data?.success;
    const why = data?.error
      || (status === 404 ? "db-admin function not deployed yet" : status ? `db-admin returned HTTP ${status}` : "db-admin didn't answer");
    setSqlLog(l => [...l, { kind: good ? "ok" : "err", text: good ? "✓ " + (data.message || "done") : "✗ " + why }]);
    setSqlBusy(false);
  };

  return (
    <div>
      <SectionHeader title="Supabase Console" trailing="Allowlisted ops" />
      <Card pad="md">
        <div className="t-foot" style={{ color: "var(--sub)" }}>Run maintenance against Board Room's shared memory. Allowlisted commands only — anything else is refused.</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "14px 0 12px" }}>
          {["backup chat_messages", "vacuum seat_notes", "clear findings > 30d", "clear usage_log > 30d", "purge deleted > 30d"].map(q => (
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
  );
}

// MinerPanel is NOT re-exported here any more. The Settings sheet lazy-imports
// it straight from ./MinerPanel.jsx, and a re-export through this module would
// chain the two files together again — Rollup then refuses to split either.
