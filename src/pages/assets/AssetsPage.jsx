// ─── Assets — the properties, and the auditor that watches them ──────────────
// One CellGroup of live-checked properties, one group of command-center links,
// and the site auditor (audit + propose-a-fix) below. Data/behavior unchanged
// from the pre-SESSION PropertiesPage/AuditorCard; anatomy re-voiced.

import { useState, useEffect } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, Button, Pill, Field, Dot, Switch,
  EmptyState, Grid,
} from "../../ui/kit.jsx";
import { IcExternal, IcChevronDown, IcSearch } from "../../ui/icons.jsx";
import { callFn } from "../../lib/functions.js";
import { db } from "../../data/db.js";

// The ventures — shared by the auditor below and by SystemsPage's Deploy and
// Replace-a-File controls (which import PROPERTIES from here). The array shape
// (name/desc/url/appUrl/color/repo/site/assetsOnly/cta) is load-bearing.
export const PROPERTIES = [
  { name: "Zero To Secure", desc: "Premium seed phrase backup", url: "https://zerotosecure.com", appUrl: "https://zts-command-center.netlify.app", color: "var(--green)", repo: "camcarp14/zts-command-center", site: "zero-to-secure" },
  { name: "Clarify Paid Search", desc: "Boutique Google Ads agency", url: "https://clarifypaidsearch.com", appUrl: "https://clarify-outreach.netlify.app/", color: "var(--brass)", repo: "camcarp14/clarify-outreach", site: "clarify-paid-search" },
  { name: "Clarify SaaS", desc: "Google Ads auditing tool", url: null, appUrl: "https://clarify-saas.netlify.app/", color: "var(--brass)", repo: "camcarp14/clarify-saas", site: "clarify-saas" },
  { name: "Macro Command Center", desc: "Markets, portfolio, thesis", url: null, appUrl: "https://macro-command-center.netlify.app/", color: "var(--blue)", repo: "camcarp14/macro-command-center", site: "macro-command-center" },
  // assetsOnly: shown as reference cards on Assets (link + live status) but kept
  // out of the Systems deploy/replace controls, since their Netlify slugs and
  // repos aren't wired up here and FFSR's two views share one site.
  { name: "Runway", desc: "Runway command center", url: null, appUrl: "https://runway-command-center.netlify.app/", color: "var(--purple)", repo: null, site: null, assetsOnly: true },
  // FFSR: one card, two links — main site + the /team management view, the same
  // Site ›/Command Center › two-button layout Zero To Secure uses.
  { name: "FFSR", desc: "Main site & team management", url: "https://ffsr.netlify.app/#/", appUrl: "https://ffsr.netlify.app/#/team", color: "var(--pink)", repo: null, site: null, assetsOnly: true, cta: "Management Center ›" },
];

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u || ""; } };
// window.open with the "noopener" feature is the programmatic twin of the old
// <a target="_blank" rel="noopener"> links — keep the noopener.
const openExternal = (u) => window.open(u, "_blank", "noopener");

/* Trailing status for a property row: response code in mono + a semantic dot.
   States: checking (pulse) → live/down once site-status answers, or an honest
   amber "check failed" when the fn itself errors (the old UI said CHECKING…
   forever in that case — fixed). */
function SiteStatus({ s, failed }) {
  if (s) {
    const tone = s.up ? "var(--green)" : "var(--red)";
    const text = s.up ? (s.status || "Live") : (s.status || "unreachable");
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flex: "none" }}>
        <span className="t-num" style={{ fontSize: 11.5, color: s.up ? "var(--faint)" : "var(--red)" }}>{text}</span>
        <Dot tone={tone} size={7} />
      </span>
    );
  }
  if (failed) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flex: "none" }}>
        <span className="t-cap" style={{ color: "var(--amber)" }}>Check failed</span>
        <Dot tone="var(--amber)" size={7} />
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

export function PropertiesPage({ isMobile, settings, updateSetting, session }) {
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
      d.results.forEach(r => { map[r.url] = r; });
      setStatus(map);
    });
    return () => { alive = false; };
  }, []);

  // Properties with a public site AND a separate command center get a second
  // link row below — every URL from the old two-button cards survives.
  const managed = PROPERTIES.filter(p => p.url && p.appUrl);
  const ctaLabel = (p) => {
    const raw = (p.cta || "Command Center ›").replace(/\s*›\s*$/, "").trim();
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase(); // sentence case
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: isMobile ? "4px 16px 24px" : "6px 24px 40px" }}>
      <div className="stagger" style={{ width: "100%", maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
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
            <SectionHeader title="Command centers" />
            <CellGroup>
              {managed.map(p => (
                <Cell
                  key={p.name}
                  leading={<span style={{ fontSize: 13.5, fontWeight: 700 }}>{p.name.charAt(0)}</span>}
                  leadingTone={p.color}
                  title={p.name}
                  sub={`${ctaLabel(p)} · ${hostOf(p.appUrl)}`}
                  chevron
                  onClick={() => openExternal(p.appUrl)}
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
    </div>
  );
}

// ─── The auditor ──────────────────────────────────────────────────────────────
async function auditProperty(p, token, ask) {
  const data = await callFn("audit", { name: p.name, url: p.url || p.appUrl, repo: p.repo, ask }, token ? { Authorization: `Bearer ${token}` } : undefined);
  return data?.success ? data.findings : [];
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
          <span className="t-head">Site auditor</span>
          <Switch on={enabled} onToggle={() => updateSetting("auditor_enabled", !enabled)} />
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
        <div className="t-head" style={{ marginBottom: 4 }}>Propose a fix</div>
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
