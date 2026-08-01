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
  Segmented, Field, Dot, EmptyState,
} from "../../ui/kit.jsx";
import { IcChevronDown } from "../../ui/icons.jsx";
import { supabase, ANTHROPIC_API_KEY } from "../../lib/supabase.js";
import { pingFn, callFn } from "../../lib/functions.js";
import { callClaude } from "../../lib/claude.js";
import { PROPERTIES } from "../assets/properties.js";
import { MinerPanel } from "./MinerPanel.jsx";

// Keys are stable (Summon and muscle memory point at them). Consumed by the
// Assets page, which prepends its own "Properties" pill.
export const SYSTEMS_SUBTABS = [
  { key: "usage", label: "Usage" },
  { key: "status", label: "Status" },
  { key: "deploy", label: "Deploy" },
  { key: "supabase", label: "Supabase" },
  { key: "miner", label: "Miner" },
];

/* ═══ Usage ════════════════════════════════════════════════════════════════ */

// Usage — durable, cross-device log of every Anthropic call and every
// Netlify function hit, read from usage_log.
//
// Writers, all six of them: callClaude + callFn client-side, and server-side
// mini-worker, audit, auto-fix, board-work-background (the Discord path, which
// attributes to BOARD_USER_ID since Discord carries no session) and the
// Upstream ledger. The last three used to write nothing — audit and auto-fix
// showed as kind:"call" rows at $0, and Discord left no row at all — so the
// cost boxes below, which filter kind === "anthropic", understated real spend.
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
  "fetch-page": { label: "Page fetched for Learn" },
  "discord-board": { label: "Discord command" },
  "board-work-background": { label: "Discord board work" },
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

// Discord writes fn as `discord_<stage>`, so the stage is data, not a fixed key.
const usageLabel = (fn) => USAGE_META[fn]?.label
  || (/^discord_/.test(fn || "") ? `Discord · ${String(fn).slice(8).replace(/_/g, " ")}` : humanize(fn));

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
// retired (see the AssetsPage header) and Mini Me with it, so the picker was
// steering runs that no longer happen and quoting an estimate for them. What is
// left on this page is monitoring, so it should read as monitoring.
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

/* ═══ Status — connection health machinery ═════════════════════════════════ */

const IS_DEPLOYED = typeof window !== "undefined" && window.location.hostname !== "localhost";

// `bulk` marks a group that stays folded no matter what. Core, AI and Market
// data are five rows between them — cheap to show, and they're the pipes that
// actually break in ways you can do something about. Netlify functions is
// twenty-one rows that are almost always all Live, and it dwarfed the three
// groups worth reading; it now stays shut and you open it when you want it.
//
// Nothing is hidden by that: the group's own tally still spells out "1 down" in
// red on the collapsed header, so a broken function is visible at a glance —
// you just have to tap to see WHICH. That's the trade, and it's the right way
// round for a list this size.
const CONN_GROUPS = [
  { title: "Core", keys: ["supabase_env", "supabase_auth", "supabase_db"] },
  { title: "AI", keys: ["anthropic"] },
  { title: "Market data", keys: ["coingecko"] },
  { title: "Netlify functions", bulk: true, keys: ["fn_health", "fn_mini", "fn_btc", "fn_btc_candles", "fn_markets", "fn_ticker_candles", "fn_wire", "fn_tmdb", "fn_export_data", "fn_calendar", "fn_calendar_events", "fn_site_status", "fn_gsc", "fn_shopify", "fn_clarify_pipeline", "fn_zts_pipeline", "fn_deploy", "fn_dbadmin", "fn_audit", "fn_autofix"] },
];
const CONN_META = {
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

// Status sub-tab — connection roll-up + per-pipe health. The connections hook
// lives in the parent (Assets page) so results persist across sub-tab switches;
// this tab is pure presentation over the passed-in state.
//
// CONSOLIDATED, NOT TRUNCATED. This used to render all twenty-five pipes as
// open cells, which on a phone is a screen and a half of rows that say "Live" —
// the two that don't are the entire point and they were the hardest to find.
//
// So the three small groups (Core, AI, Market data — five rows total) are open,
// and the twenty-one Netlify functions are folded behind their tally. Every
// group's header carries its own counts either way, so a failure is never
// silent; the fold only decides whether you can see which row it was without
// tapping. For five rows that's worth showing; for twenty-one it isn't.
export function StatusTab({ checks, lastRun, running, runAll, isMobile }) {
  const vals = Object.values(checks);
  const counts = {
    ok: vals.filter(c => c?.status === "ok").length,
    warn: vals.filter(c => c?.status === "warn").length,
    down: vals.filter(c => c?.status === "down").length,
    off: vals.filter(c => c?.status === "off" || c?.status === "local").length,
  };
  const agoCheck = (ts) => { if (!ts) return "—"; const s = Math.floor((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`; };

  // null = "nobody has chosen yet", so the default below governs: small groups
  // open, the bulk group shut. Once you toggle a group it holds whatever you
  // set — an explicit choice outranks the default in both directions, so the
  // function list can be pinned open for as long as you're working in it.
  const [openMap, setOpenMap] = useState({});
  const isOpen = (g) => (openMap[g.title] != null ? openMap[g.title] : !g.bulk);

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
        <div className="t-foot" style={{ color: "var(--faint)", paddingTop: 8, lineHeight: 1.5 }}>
          Every group counts its own pipes here. Tap one to see which row is which.
        </div>
      </Card>
    </>
  );
}

/* ═══ Deploy — build triggers ══════════════════════════════════════════════ */

export function DeployTab({ isMobile }) {
  const [deploys, setDeploys] = useState({});
  const redeploy = async (p) => {
    setDeploys(d => ({ ...d, [p.name]: { busy: true } }));
    const res = await callFn("deploy", { site: p.site, action: "build" });
    setDeploys(d => ({ ...d, [p.name]: { busy: false, ok: !!res?.success, when: "just now" } }));
  };
  // The "Replace a File" panel lived here and could never work: it POSTed
  // action:"replace-file", and deploy.js answers that with 400 "only
  // action:'build' is supported — zip deploys are disabled by design". callFn
  // discards the error body, so every attempt reported "failed — see Netlify
  // deploy log" and sent you to a log with nothing in it, because no build was
  // ever triggered. Removed rather than reimplemented: the function disables
  // this deliberately, so the UI was the side that was wrong.

  const deployables = PROPERTIES.filter(p => !p.assetsOnly); // Runway/FFSR excluded on purpose

  return (
    <div style={{ maxWidth: 520 }}>
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
    const data = await callFn("db-admin", { command: q });
    setSqlLog(l => [...l, { kind: data?.success ? "ok" : "err", text: data?.success ? "✓ " + (data.message || "done") : "✗ " + (data?.error || "db-admin function not deployed yet") }]);
    setSqlBusy(false);
  };

  return (
    <div>
      <SectionHeader title="Supabase Console" trailing="Allowlisted ops" />
      <Card pad="md">
        <div className="t-foot" style={{ color: "var(--sub)" }}>Run maintenance against Board Room's shared memory. Allowlisted commands only — anything else is refused.</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "14px 0 12px" }}>
          {["backup chat_messages", "vacuum seat_notes", "clear findings > 30d", "clear usage_log > 30d"].map(q => (
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

// Miner sub-tab re-exported so the Assets page composes every systems tab from
// one import. `active` gates the 5s poll — see MinerPanel.
export { MinerPanel } from "./MinerPanel.jsx";
