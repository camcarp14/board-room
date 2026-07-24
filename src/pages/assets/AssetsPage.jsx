// ─── Assets — the ventures, and the machine room that runs them ──────────────
// One page, six tabs. "Properties" is the venture roll-up (live-checked sites,
// command-center links, and the AI site auditor). The rest — Usage, Status,
// Deploy, Supabase, Miner — used to be a separate Systems tab; they were folded
// in here so everything you own and everything that runs it live in one place.
// The connections hook is hosted at the page level so Status results survive a
// hop to another tab and back.

import { useState, useEffect, useRef } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, Button, Pill, Field, Dot, Switch,
  EmptyState, Grid, PillRow,
} from "../../ui/kit.jsx";
import { IcExternal, IcChevronDown, IcSearch } from "../../ui/icons.jsx";
import { callFn } from "../../lib/functions.js";
import { db } from "../../data/db.js";
import { PROPERTIES } from "./properties.js";
import {
  SYSTEMS_SUBTABS, useConnections, UsageTab, StatusTab, DeployTab, SupabaseTab, MinerPanel,
} from "../systems/SystemsPage.jsx";
import { BoardRoomPage } from "../board/BoardPage.jsx";

// Re-exported for any older importers — PROPERTIES now lives in ./properties.js.
export { PROPERTIES } from "./properties.js";

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u || ""; } };
// window.open with the "noopener" feature is the programmatic twin of the old
// <a target="_blank" rel="noopener"> links — keep the noopener.
const openExternal = (u) => window.open(u, "_blank", "noopener");

// Assets is now a tabbed page: Mind first (the folded-in Mind tab, with its own
// Mind/Neurons/Learn sub-sub-tabs), then Properties, then the folded-in systems
// tabs. Keys are stable — Summon and muscle memory point at them.
const ASSETS_SUBTABS = [{ key: "mind", label: "Mind" }, { key: "properties", label: "Properties" }, ...SYSTEMS_SUBTABS];

/* Trailing status for a property row: response code in mono + a semantic dot.
   States: checking (pulse) → live/down once site-status answers, or an honest
   amber "check failed" when the fn itself errors (the old UI said CHECKING…
   forever in that case — fixed). */
function SiteStatus({ s, failed }) {
  if (s) {
    const tone = s.up ? "var(--green)" : "var(--red)";
    const text = s.up ? (s.status || "Live") : (s.status || "unreachable");
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
        <Dot tone={tone} size={6} />
        <span className="t-cap" style={{ color: tone, fontWeight: 600 }}>{text}</span>
      </span>
    );
  }
  if (failed) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
        <Dot tone="var(--amber)" size={6} />
        <span className="t-cap" style={{ color: "var(--amber)", fontWeight: 600 }}>Check failed</span>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flex: "none" }}>
      <span className="t-cap" style={{ color: "var(--faint)" }}>Checking</span>
      <Dot tone="var(--faint)" size={7} pulse />
    </span>
  );
}

// ─── Properties tab — the ventures + the auditor ─────────────────────────────
function PropertiesTab({ isMobile, settings, updateSetting, session }) {
  const [status, setStatus] = useState({});
  const [checkFailed, setCheckFailed] = useState(false);
  useEffect(() => {
    let alive = true; // cleanup flag prevents setState after unmount
    const urls = PROPERTIES.map(p => p.url || p.appUrl).filter(Boolean);
    callFn("site-status", { urls }).then(d => {
      if (!alive) return;
      // callFn returns null on any failure — surface it instead of an
      // eternal "Checking" (the pre-SESSION bug).
      if (!d?.success) { setCheckFailed(true); return; }
      const map = {};
      (d.results || []).forEach(r => { map[r.url] = r; }); // tolerate a success payload with no results array
      setStatus(map);
    });
    return () => { alive = false; };
  }, []);

  const ctaLabel = (p) => {
    const raw = (p.cta || "Command Center ›").replace(/\s*›\s*$/, "").trim();
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase(); // sentence case
  };

  // Command centers, deduped by destination. ZTS, Clarify, Runway and Macro were
  // consolidated into one app — The Pentagon — so the four now share a SINGLE
  // command center; it shows once (as "The Pentagon") instead of once per venture
  // all pointing at the same URL. Genuinely separate centers (e.g. FFSR's team
  // view) keep their own row. Only ventures that had their own command center
  // (a public site AND an appUrl — the old two-button cards) are listed.
  const PENTAGON_APP = "https://the-pentagon.netlify.app";
  const commandCenters = (() => {
    const seen = new Set();
    const out = [];
    for (const p of PROPERTIES) {
      if (!p.url || !p.appUrl || seen.has(p.appUrl)) continue;
      seen.add(p.appUrl);
      out.push(
        p.appUrl === PENTAGON_APP
          ? { key: "pentagon", name: "The Pentagon", appUrl: p.appUrl, color: "var(--purple)", sub: `Unified command center · ${hostOf(p.appUrl)}` }
          : { key: p.name, name: p.name, appUrl: p.appUrl, color: p.color, sub: `${ctaLabel(p)} · ${hostOf(p.appUrl)}` }
      );
    }
    return out;
  })();

  return (
    <div className="stagger" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <Grid min={340} gap={12}>
        <div>
          <SectionHeader title="Properties" />
          <CellGroup>
            {PROPERTIES.map(p => {
              // Status is keyed by p.url || p.appUrl — the fetch list above
              // and this lookup must use the same expression.
              const key = p.url || p.appUrl;
              const s = status[key];
              return (
                <Cell
                  key={p.name}
                  leading={<span style={{ fontSize: 13.5, fontWeight: 700 }}>{p.name.charAt(0)}</span>}
                  leadingTone={p.color}
                  title={p.name}
                  sub={`${hostOf(key)} · ${p.desc}`}
                  trailing={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 9, flex: "none" }}>
                      <SiteStatus s={s} failed={checkFailed} />
                      <IcExternal size={15} style={{ color: "var(--faint)" }} />
                    </span>
                  }
                  onClick={() => openExternal(key)}
                />
              );
            })}
          </CellGroup>
        </div>

        <div>
          <SectionHeader title="Command Centers" />
          <CellGroup>
            {commandCenters.map(c => (
              <Cell
                key={c.key}
                leading={<span style={{ fontSize: 13.5, fontWeight: 700 }}>{c.name.charAt(0)}</span>}
                leadingTone={c.color}
                title={c.name}
                sub={c.sub}
                chevron
                onClick={() => openExternal(c.appUrl)}
              />
            ))}
          </CellGroup>
        </div>
      </Grid>

      <div style={{ marginTop: 16 }}>
        <SectionHeader title="Auditor" />
        <AuditorCard settings={settings} updateSetting={updateSetting} session={session} isMobile={isMobile} />
      </div>
    </div>
  );
}

// ─── The page ─────────────────────────────────────────────────────────────────
// Named PropertiesPage for the App.jsx route it has always answered to.
export function PropertiesPage({ isMobile, settings, updateSetting, session, btc, jump, onWorkerRun, onSkillsChanged, skills }) {
  const [sub, setSub] = useState("mind"); // Mind is the first sub-tab and the default landing
  // Summon / deep links can open straight onto a sub-tab (systems or Mind).
  useEffect(() => {
    if (jump?.sub && ASSETS_SUBTABS.some(t => t.key === jump.sub)) setSub(jump.sub);
  }, [jump]);

  // Mind deep links (Summon "Mini Me"/"Learn", the Brief's queue chip, Ask the
  // Mind) arrive transformed to { sub: "mind", boardSub }. Re-hydrate a
  // boardroom-shaped jump so the embedded BoardRoomPage — unchanged — still
  // consumes them. Null when the current jump isn't aimed at Mind.
  const boardJump = jump?.sub === "mind"
    ? { page: "boardroom", sub: jump.boardSub || "mini", skillId: jump.skillId, ask: jump.ask, t: jump.t }
    : null;

  // Connections hook hosted here (not inside StatusTab) so results survive a
  // hop to another sub-tab and back. Lazy-started the first time Status shows —
  // it fires ~25 network calls incl. a paid Anthropic ping, so it must not run
  // just because the page mounted on another tab.
  const conn = useConnections({ session, btc });
  const statusStarted = useRef(false);
  useEffect(() => {
    if (sub !== "status" || statusStarted.current) return;
    statusStarted.current = true;
    conn.runAll();
  }, [sub]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: isMobile ? "4px 16px 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 1020, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        {/* PillRow, not Segmented: seven sub-tabs is well past Segmented's ≤4
            equal-width ceiling (DESIGN.md §6). PillRow scrolls and keeps the
            active pill centered. */}
        <PillRow options={ASSETS_SUBTABS} value={sub} onChange={setSub} style={{ marginBottom: 14, flex: "none" }} />

        {/* key={sub} re-mounts and animates the content on every tab switch.
            flex:1 lets a full-height sub-tab (Mind's canvas) fill; the others
            top-align inside it as before. */}
        <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, minHeight: 0 }}>
          {/* Mind — the folded-in tab, with its own Mind/Neurons/Learn sub-sub-tabs.
              Negative horizontal margin on mobile cancels the Assets 16px inset so
              the Mind page keeps its own edge-to-edge padding, exactly as it read
              when it was a top-level tab. */}
          {sub === "mind" && (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, margin: isMobile ? "0 -16px" : 0 }}>
              <BoardRoomPage
                settings={settings} updateSetting={updateSetting} session={session}
                onWorkerRun={onWorkerRun} onSkillsChanged={onSkillsChanged} skills={skills}
                jump={boardJump} isMobile={isMobile}
              />
            </div>
          )}
          {sub === "properties" && <PropertiesTab isMobile={isMobile} settings={settings} updateSetting={updateSetting} session={session} />}
          {sub === "usage" && <UsageTab settings={settings} updateSetting={updateSetting} isMobile={isMobile} />}
          {sub === "status" && <StatusTab checks={conn.checks} lastRun={conn.lastRun} running={conn.running} runAll={conn.runAll} isMobile={isMobile} />}
          {sub === "deploy" && <DeployTab isMobile={isMobile} />}
          {sub === "supabase" && <SupabaseTab />}
          {/* `active` gates the 5s poll — it stops the moment you leave the sub-tab. */}
          {sub === "miner" && <MinerPanel active={sub === "miner"} isMobile={isMobile} />}
        </div>
      </div>
    </div>
  );
}

// ─── The auditor ──────────────────────────────────────────────────────────────
async function auditProperty(p, token, ask) {
  const data = await callFn("audit", { name: p.name, url: p.url || p.appUrl, repo: p.repo, ask }, token ? { Authorization: `Bearer ${token}` } : undefined);
  return (data?.success && Array.isArray(data.findings)) ? data.findings : [];
}

const SEV_TONE = { high: "var(--red)", medium: "var(--amber)", low: "var(--sub)" };

function AuditorCard({ settings, updateSetting, session, isMobile }) {
  const [findings, setFindings] = useState([]);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState("");
  const enabled = !!settings?.auditor_enabled;
  const lastRun = settings?.auditor_last_run || null;

  // Fix proposals — read-only until Approve & Commit is clicked explicitly.
  const [fixProp, setFixProp] = useState(PROPERTIES[0]?.name || "");
  const [fixInstruction, setFixInstruction] = useState("");
  const [fixBusy, setFixBusy] = useState(false);
  const [fixProposal, setFixProposal] = useState(null);
  const [fixExpanded, setFixExpanded] = useState(false);
  const [fixError, setFixError] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(null);

  useEffect(() => {
    let alive = true;
    db.loadFindings().then(f => { if (alive) setFindings(f); });
    return () => { alive = false; };
  }, []);

  // Sequential on purpose (for..of, not parallel) — one audit at a time.
  const runAll = async (customAsk) => {
    setRunning(true);
    const results = [];
    for (const p of PROPERTIES) {
      const fs = await auditProperty(p, session?.access_token, customAsk);
      fs.forEach(f => results.push({ ...f, property: p.name, ts: Date.now() }));
    }
    await db.saveFindings(results);
    setFindings(prev => [...results, ...prev].slice(0, 40));
    updateSetting("auditor_last_run", Date.now());
    setRunning(false);
    setOpen(true);
  };

  // Auto-run scheduler: while enabled, a 5-minute interval checks whether the
  // last run is older than 6h; torn down on disable/unmount and re-created
  // when auditor_last_run changes.
  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(() => {
      const last = settings?.auditor_last_run || 0;
      if (Date.now() - last > 6 * 3600 * 1000) runAll();
    }, 5 * 60 * 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, settings?.auditor_last_run]);

  const proposeFix = async () => {
    const instruction = fixInstruction.trim();
    const p = PROPERTIES.find(x => x.name === fixProp);
    if (!instruction || !p?.repo || fixBusy) return;
    setFixBusy(true); setFixError(null); setFixProposal(null); setCommitted(null);
    const data = await callFn("auto-fix", { action: "propose", repo: p.repo, instruction });
    if (data?.success) setFixProposal({ ...data, repo: p.repo, site: p.name });
    else setFixError(data?.error || "couldn't propose a fix");
    setFixBusy(false);
  };
  const commitFix = async () => {
    if (!fixProposal || committing) return;
    setCommitting(true); setFixError(null);
    const data = await callFn("auto-fix", { action: "commit", repo: fixProposal.repo, path: fixProposal.path, content: fixProposal.after, message: `Fix via Board Room auditor: ${fixInstruction.trim().slice(0, 60)}` });
    if (data?.success) { setCommitted(data); setFixProposal(null); setFixInstruction(""); setFixExpanded(false); }
    else setFixError(data?.error || "commit failed");
    setCommitting(false);
  };
  const discardFix = () => { setFixProposal(null); setFixExpanded(false); };

  const propColor = (name) => (PROPERTIES.find(p => p.name === name) || {}).color || "var(--sub)";
  const ago = (ts) => { if (!ts) return "never"; const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`; };
  const sevLabel = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
  const shown = findings.slice(0, 12); // state holds up to 40; display stays at 12

  return (
    <Grid min={340} gap={12}>
      {/* ── Audit ── */}
      <Card pad="md">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <span className="t-head">Site Auditor</span>
          <Switch on={enabled} onToggle={() => updateSetting("auditor_enabled", !enabled)} aria-label="Auditor enabled" />
        </div>
        <div className="t-foot" style={{ color: "var(--faint)", marginBottom: 12 }}>Auto-audits every 6 hours while enabled.</div>

        <Button kind="tinted" size="md" full disabled={running} onClick={() => runAll()}>
          {running ? "Auditing all properties…" : "Run audit now"}
        </Button>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <Field
            value={ask}
            onChange={e => setAsk(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (ask.trim() && !running) runAll(ask.trim()); } }}
            placeholder="Ask something specific (optional) — e.g. check for broken nav links"
            disabled={running}
            style={{ flex: 1 }}
          />
          <Button kind="quiet" size="md" disabled={running || !ask.trim()} onClick={() => ask.trim() && runAll(ask.trim())}>Ask</Button>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 8 }}>
          <span className="t-cap" style={{ color: "var(--faint)" }}>Last run {ago(lastRun)}</span>
          <Button kind="plain" size="sm" onClick={() => setOpen(!open)} style={{ color: "var(--sub)", height: 44, paddingRight: 4 }}>
            {findings.length} findings
            <IcChevronDown size={13} style={{ color: "var(--faint)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />
          </Button>
        </div>

        {/* Findings render in-page (no inner scroller) behind the disclosure. */}
        <div className={`expand${open ? " open" : ""}`}>
          <div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
              {shown.length === 0 && (
                <EmptyState icon={<IcSearch size={22} />} title="No findings yet" sub="Run an audit to check every property." style={{ padding: "20px 16px" }} />
              )}
              {shown.map((f, i) => (
                <div key={i} style={{ background: "var(--surface-2)", borderRadius: 12, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                    <Dot tone={propColor(f.property)} size={6} />
                    <span className="t-cap" style={{ color: "var(--ink)", fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.property}</span>
                    <span className="t-cap" style={{ color: SEV_TONE[f.severity] || "var(--sub)", fontWeight: 600, flex: "none" }}>{sevLabel(f.severity)}</span>
                  </div>
                  <div className="t-call" style={{ color: "var(--ink)" }}>{f.finding}</div>
                  <div className="t-foot" style={{ color: "var(--sub)", fontStyle: "italic", marginTop: 3 }}>→ {f.suggestion}</div>
                  <Button
                    kind="tinted" size="md"
                    onClick={() => { setFixProp(f.property); setFixInstruction(`${f.finding} ${f.suggestion}`); setFixProposal(null); setFixError(null); setCommitted(null); }}
                    style={{ marginTop: 8 }}
                  >
                    Propose fix
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* ── Propose a fix — read-only until Approve & Commit ── */}
      <Card pad="md">
        <div className="t-head" style={{ marginBottom: 4 }}>Propose a Fix</div>
        <div className="t-foot" style={{ color: "var(--faint)", marginBottom: 12 }}>
          Commits straight to the site's repo — nothing goes live until you approve. Works for the static template (meta tags, title, robots.txt, sitemap) — not page content rendered by app code yet.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          {PROPERTIES.filter(p => p.repo).map(p => (
            <Pill key={p.name} active={fixProp === p.name} onClick={() => setFixProp(p.name)}>{p.name}</Pill>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Field
            value={fixInstruction}
            onChange={e => setFixInstruction(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); proposeFix(); } }}
            placeholder="e.g. add a meta description mentioning steel seed phrase backup"
            disabled={fixBusy}
            style={{ flex: 1 }}
          />
          <Button kind="tinted" size="md" disabled={fixBusy || !fixInstruction.trim()} onClick={proposeFix}>
            {fixBusy ? "…" : "Propose"}
          </Button>
        </div>

        {fixError && <div className="t-foot" style={{ color: "var(--red)", marginTop: 10 }}>{fixError}</div>}
        {committed && <div className="t-foot" style={{ color: "var(--green)", marginTop: 10 }}>✓ {committed.message}</div>}

        {fixProposal && (
          <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 5 }}>
              <span className="t-num" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fixProposal.path}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
                <Dot tone={propColor(fixProposal.site)} size={6} />
                <span className="t-cap" style={{ color: "var(--sub)", fontWeight: 600 }}>{fixProposal.site}</span>
              </span>
            </div>
            <div className="t-foot" style={{ color: "var(--sub)", marginBottom: 4 }}>{fixProposal.note}</div>
            <Button kind="plain" size="sm" onClick={() => setFixExpanded(!fixExpanded)} style={{ height: 44, paddingLeft: 0 }}>
              {fixExpanded ? "Hide full file" : "Show full file"}
              <IcChevronDown size={12} style={{ transform: fixExpanded ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />
            </Button>
            {/* Full file renders in-page (pre-wrap, no fixed-height inner scroll). */}
            <div className={`expand${fixExpanded ? " open" : ""}`}>
              <div>
                <pre className="t-num" style={{ margin: "0 0 8px", background: "var(--surface)", borderRadius: 10, padding: "10px 12px", fontSize: 11, color: "var(--sub)", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "break-word" }}>{fixProposal.after}</pre>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Button kind="primary" size="md" disabled={committing} onClick={commitFix} style={{ flex: 1 }}>
                {committing ? "Committing…" : "Approve & commit"}
              </Button>
              <Button kind="quiet" size="md" disabled={committing} onClick={discardFix}>Discard</Button>
            </div>
          </div>
        )}
      </Card>
    </Grid>
  );
}

export default PropertiesPage;
