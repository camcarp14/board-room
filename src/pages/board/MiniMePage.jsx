// ─── Page: Mini Me ───────────────────────────────────────────────────────────
// Mini Me is now real: on-demand only — you queue work and hit Run, nothing
// fires on a schedule. The worker (mini-worker) runs Claude against the
// queue, writes deliverables onto tasks, and logs to mini_feed.
import { useState, useEffect, useRef } from "react";
import { T } from "../../theme.js";
import { Card, Button, Dot, Switch, Field, Grid, useConfirm } from "../../ui/kit.jsx";
import { IcClose, IcChevronDown, IcChevronRight } from "../../ui/icons.jsx";
import { ToggleRow, Segmented, Chips } from "../../ui/primitives.jsx";
import { pingFn } from "../../lib/functions.js";
import { supabase } from "../../lib/supabase.js";
import { callClaude } from "../../lib/claude.js";

export const MINI_DEFAULTS = {
  model: "haiku", enabled: true, budget: "$3", oversight: true,
  directive: "", briefingLog: [], role: "",
  reflectOn: true, loopOn: true, loopMax: "5", approvalOn: true,
};
export const TASK_COLORS = { delivered: T.green, review: T.brass, queued: T.faint, failed: T.red };
export const EFFORT_LEVELS = [
  { key: "quick", label: "Quick", desc: "One shot, no self-review — fastest and cheapest." },
  { key: "careful", label: "Careful", desc: "Reviews its own draft once before delivering." },
  { key: "thorough", label: "Thorough", desc: "Keeps refining until satisfied, up to the pass limit — this is how you make it think longer on something." },
];
// Display casing only — the underlying status strings (queued/review/
// delivered/failed) are shared with the worker and must never be renamed.
const STATUS_LABELS = { queued: "Queued", review: "Review", delivered: "Delivered", failed: "Failed" };

/* Hairline between sections inside a settings card. */
function Rule() {
  return <div style={{ height: 0.5, background: "var(--line)", margin: "14px 0" }} />;
}

const LOG_PREVIEW = 4; // briefing lines shown before the in-page expander

export function MiniMePage({ settings, updateSetting, session, onWorkerRun, onOpenLearn, isMobile }) {
  const mini = { ...MINI_DEFAULTS, ...(settings?.mini || {}) };
  const setMini = (patch) => updateSetting("mini", { ...mini, ...patch });
  const tasks = settings?.mini_tasks || [];
  const setTasks = (list) => updateSetting("mini_tasks", list);

  const [taskInput, setTaskInput] = useState("");
  const [feed, setFeed] = useState(null); // null = loading
  const [worker, setWorker] = useState({ state: "checking" });
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showFullLog, setShowFullLog] = useState(false);
  const [directiveInput, setDirectiveInput] = useState("");
  const [directiveSending, setDirectiveSending] = useState(false);
  const [skillCount, setSkillCount] = useState(null); // null loading · number · "teach" when table missing
  const directiveEndRef = useRef(null);
  const [confirmEl, confirm] = useConfirm();

  const loadFeed = async () => {
    try {
      const { data, error } = await supabase.from("mini_feed").select("text,created_at").order("created_at", { ascending: false }).limit(8);
      if (error) { setFeed({ error: error.message.includes("mini_feed") ? "run supabase-mini-me.sql to create the feed table" : error.message }); return; }
      setFeed((data || []).map(r => ({ when: new Date(r.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }), text: r.text })));
    } catch { setFeed({ error: "feed unavailable" }); }
  };

  useEffect(() => {
    let alive = true;
    loadFeed();
    // enabled-skill count for the hero chip — silent on any failure
    supabase.from("mini_skills").select("id", { count: "exact", head: true }).eq("enabled", true)
      .then(({ count, error }) => { if (alive) setSkillCount(error ? "teach" : (count || 0)); })
      .catch(() => { if (alive) setSkillCount("teach"); });
    pingFn("mini-worker").then(p => {
      if (!alive) return;
      setWorker(p.status === "ok" ? { state: "ok" } : p.status === "warn" ? { state: "noenv", detail: p.detail } : { state: "off", detail: p.detail });
    });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { directiveEndRef.current?.scrollIntoView({ block: "nearest" }); }, [mini.briefingLog?.length]);

  const delivered = tasks.filter(t => t.status === "delivered");
  const active = tasks.filter(t => t.status !== "delivered");

  const addTask = () => { const t = taskInput.trim(); if (!t) return; setTasks([{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: t, status: "queued", queued_at: Date.now() }, ...tasks]); setTaskInput(""); };
  const removeTask = (id) => setTasks(tasks.filter(t => t.id !== id));
  const requestRemove = async (t) => {
    if (await confirm({ title: "Remove this task?", message: t.text, confirmLabel: "Remove", destructive: true })) removeTask(t.id);
  };

  const callWorker = async (payload) => {
    try {
      const res = await fetch("/.netlify/functions/mini-worker", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
        body: JSON.stringify(payload),
      });
      return { ok: res.ok, data: await res.json().catch(() => null), status: res.status };
    } catch { return { ok: false, data: null, status: 0 }; }
  };

  const runNow = async () => {
    if (running) return;
    setRunning(true); setRunMsg(null);
    const { ok, data, status } = await callWorker({ run: true });
    if (!ok || !data?.success) setRunMsg({ ok: false, text: data?.error || `worker failed (${status || "network"})` });
    else setRunMsg({ ok: true, text: data.message || `processed ${data.processed} task(s)` });
    await loadFeed();
    await onWorkerRun?.();
    setRunning(false);
  };

  const approveTask = async (id) => {
    setRunning(true);
    await callWorker({ approve: id });
    await loadFeed();
    await onWorkerRun?.();
    setRunning(false);
  };
  const rejectTask = async (id) => {
    setRunning(true);
    await callWorker({ reject: id });
    await loadFeed();
    await onWorkerRun?.();
    setRunning(false);
  };

  // Neither field is typed directly — you talk to it, and Claude decides
  // whether your message is about the mission (directive), the identity
  // (role), or both, updating only what you actually addressed.
  const sendDirectiveUpdate = async () => {
    const msg = directiveInput.trim();
    if (!msg || directiveSending) return;
    setDirectiveInput("");
    setDirectiveSending(true);
    const log = mini.briefingLog || [];
    const recent = log.slice(-6).map(l => `${l.role === "user" ? "Cameron" : l.field === "role" ? "Role" : "Directive"}: ${l.text}`).join("\n");
    const system = `You maintain two things for Cameron's autonomous assistant, Mini Me, from an ongoing conversation:
1. "directive" — a one-sentence overall mission that shapes every task.
2. "role" — the identity/expertise it should adopt when doing work.

Current directive: "${mini.directive || "none set"}"
Current role: "${mini.role || "none set"}"${recent ? `\n\nRecent conversation:\n${recent}` : ""}

Cameron just said: "${msg}"

Decide which of the two his message actually addresses — often just one. Output ONLY a JSON object with both fields, updating whichever he addressed and copying the other UNCHANGED if he didn't mention it: {"directive": "...", "role": "..."}. No markdown, no prose, no preamble — just the JSON object.`;
    const raw = await callClaude({ system, messages: [{ role: "user", content: msg }], modelKey: mini.model || "haiku", maxTokens: 150, fn: "briefing_update" });
    let parsed = null;
    try { parsed = JSON.parse((raw || "").replace(/```json|```/g, "").trim()); } catch {}
    const newDirective = (parsed?.directive || mini.directive || "").trim();
    const newRole = (parsed?.role || mini.role || "").trim();
    const entries = [{ role: "user", text: msg, ts: Date.now() }];
    if (newDirective && newDirective !== mini.directive) entries.push({ role: "system", field: "directive", text: newDirective, ts: Date.now() });
    if (newRole && newRole !== mini.role) entries.push({ role: "system", field: "role", text: newRole, ts: Date.now() });
    if (entries.length === 1) entries.push({ role: "system", field: "directive", text: "Couldn't parse an update — try rephrasing.", ts: Date.now() });
    setMini({ directive: newDirective, role: newRole, briefingLog: [...log, ...entries].slice(-24) });
    setDirectiveSending(false);
  };

  const queuedCount = tasks.filter(t => t.status === "queued").length;
  const [statusLabel, statusTone, statusPulse] =
    mini.enabled === false ? ["Off", "var(--faint)", false]
    : worker.state === "ok" ? ["Worker online", "var(--green)", true]
    : worker.state === "noenv" ? ["Keys missing", "var(--amber)", false]
    : worker.state === "off" ? ["Worker not deployed", "var(--red)", false]
    : ["Checking…", "var(--faint)", false];

  // Effort is a single dial derived from the underlying reflectOn/loopOn
  // fields the worker already reads — no worker changes needed.
  const effort = mini.reflectOn === false ? "quick" : mini.loopOn === false ? "careful" : "thorough";
  const setEffort = (e) => {
    if (e === "quick") setMini({ reflectOn: false, loopOn: false });
    else if (e === "careful") setMini({ reflectOn: true, loopOn: false });
    else setMini({ reflectOn: true, loopOn: true, loopMax: mini.loopMax || "5" });
  };

  const log = mini.briefingLog || [];
  const shownLog = showFullLog ? log : log.slice(-LOG_PREVIEW);

  const TaskCell = ({ t, first }) => {
    const c = TASK_COLORS[t.status] || T.faint;
    const open = openTask === t.id;
    const expandable = !!t.output;
    return (
      <div>
        {!first && <div style={{ height: 0.5, background: "var(--line)", marginLeft: 16 }} />}
        {/* header row is tappable only when there's output to read; the remove
            button stops propagation so removal never toggles the panel */}
        <div onClick={() => expandable && setOpenTask(open ? null : t.id)}
          {...(expandable ? { role: "button", tabIndex: 0, "aria-expanded": open, onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenTask(open ? null : t.id); } } } : {})}
          style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 46, padding: "5px 8px 5px 16px", cursor: expandable ? "pointer" : "default" }}>
          <Dot tone={c} size={7} />
          <span className="t-call" style={{ flex: 1, minWidth: 0, lineHeight: 1.45, overflowWrap: "break-word" }}>{t.text}</span>
          <span className="t-cap" style={{ color: c, fontWeight: 600, flex: "none", display: "inline-flex", alignItems: "center", gap: 3 }}>
            {STATUS_LABELS[t.status] || t.status}
            {expandable && <IcChevronDown size={12} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />}
          </span>
          <button className="icon-btn" onClick={(e) => { e.stopPropagation(); requestRemove(t); }} aria-label="Remove task" title="Remove" style={{ width: 40, height: 40 }}>
            <IcClose size={15} />
          </button>
        </div>
        {open && t.output && (
          <div className="t-foot" style={{ margin: "0 16px 10px", background: "var(--surface-2)", borderRadius: 12, padding: "11px 13px", lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "break-word" }}>{t.output}</div>
        )}
        {t.status === "review" && (
          <div style={{ display: "flex", gap: 8, margin: "2px 16px 12px" }}>
            <Button kind="tinted" size="md" style={{ flex: 1 }} disabled={running} onClick={() => approveTask(t.id)}>Approve</Button>
            <Button kind="quiet" size="md" style={{ flex: 1 }} disabled={running} onClick={() => rejectTask(t.id)}>Reject &amp; redo</Button>
          </div>
        )}
      </div>
    );
  };

  const col = { display: "flex", flexDirection: "column", gap: isMobile ? 12 : 14, minWidth: 0 };

  return (
    <div style={{ width: "100%", maxWidth: 1020, margin: "0 auto", padding: isMobile ? "8px 16px 0" : "4px 0 0" }}>
      <Grid min={340} gap={isMobile ? 12 : 14}>

        {/* Left column: identity, then the actual work surface */}
        <div style={col}>

          {/* Hero — identity, directive, role. No XP/level — just what it is and what it's doing. */}
          <Card pad="md">
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 12 }}>
              <span style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span className="t-head">Mini Me</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
                    <Dot tone={statusTone} pulse={statusPulse} size={6} />
                    <span className="t-cap" style={{ color: statusTone, fontWeight: 600 }}>{statusLabel}</span>
                  </span>
                </span>
                <span className="t-foot" style={{ lineHeight: 1.5 }}>Queue work below, set the dial, hit Run — nothing happens until you say so.</span>
                {onOpenLearn && skillCount !== null && (
                  <Button kind="plain" size="sm" onClick={onOpenLearn}
                    style={{ alignSelf: "flex-start", height: "auto", minHeight: 40, paddingLeft: 0, paddingRight: 0, gap: 4 }}>
                    {typeof skillCount === "number" && skillCount > 0 ? `${skillCount} skill${skillCount > 1 ? "s" : ""} loaded` : "Teach it skills"}
                    <IcChevronRight size={11} />
                  </Button>
                )}
                {worker.state !== "ok" && worker.state !== "checking" && mini.enabled !== false && (
                  <span className="t-cap" style={{ color: "var(--amber)", fontWeight: 500, lineHeight: 1.5 }}>{worker.detail}</span>
                )}
              </span>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: "none" }}>
                <Switch on={mini.enabled !== false} onToggle={() => setMini({ enabled: mini.enabled === false })} aria-label="Mini Me enabled" />
                <span className="t-cap" style={{ fontWeight: 600, color: mini.enabled === false ? "var(--faint)" : "var(--green)" }}>{mini.enabled === false ? "Off" : "On"}</span>
              </div>
            </div>
            {mini.enabled === false && (
              <div className="t-foot" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "10px 13px", marginBottom: 12, color: "var(--faint)", lineHeight: 1.5 }}>
                Mini Me is off — Run now won't do anything until you flip it back on above.
              </div>
            )}

            {/* Prime Directive + Role — one conversation shapes both. Stacks
                to a single column on the phone so neither field gets cramped. */}
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div>
                <div className="t-label" style={{ marginBottom: 6 }}>Prime directive</div>
                {mini.directive ? (
                  <div className="t-call" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "11px 13px", lineHeight: 1.5, fontStyle: "italic" }}>"{mini.directive}"</div>
                ) : (
                  <div className="t-foot" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "11px 13px", color: "var(--faint)", lineHeight: 1.45 }}>No directive yet — the mission that shapes every task.</div>
                )}
              </div>
              <div>
                <div className="t-label" style={{ marginBottom: 6 }}>Role</div>
                {mini.role ? (
                  <div className="t-call" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "11px 13px", lineHeight: 1.5 }}>{mini.role}</div>
                ) : (
                  <div className="t-foot" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "11px 13px", color: "var(--faint)", lineHeight: 1.45 }}>No role yet — the identity it works from.</div>
                )}
              </div>
            </div>

            {log.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, padding: "2px 1px" }}>
                {log.length > LOG_PREVIEW && (
                  <Button kind="plain" size="sm" onClick={() => setShowFullLog(v => !v)}
                    style={{ alignSelf: "flex-start", color: "var(--sub)", height: "auto", minHeight: 34, paddingLeft: 0, paddingRight: 0 }}>
                    {showFullLog ? "Show recent only" : `Show all ${log.length} lines`}
                  </Button>
                )}
                {shownLog.map((l, i) => (
                  <div key={i} className="t-foot" style={{ lineHeight: 1.5, fontStyle: l.role === "user" ? "normal" : "italic" }}>
                    {l.role === "user"
                      ? l.text
                      : <><span style={{ fontWeight: 600, fontStyle: "normal", color: "var(--ink)" }}>→ {l.field === "role" ? "Role" : "Directive"}:</span> {l.text}</>}
                  </div>
                ))}
                <div ref={directiveEndRef} />
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <Field value={directiveInput} onChange={e => setDirectiveInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); sendDirectiveUpdate(); } }}
                placeholder="Tell it who it is and what matters right now…" disabled={directiveSending} style={{ flex: 1 }} />
              <Button kind="quiet" size="md" onClick={sendDirectiveUpdate} disabled={directiveSending || !directiveInput.trim()} style={{ flex: "none" }}>
                {directiveSending ? "…" : "Send"}
              </Button>
            </div>
            {log.length > 0 && (
              <Button kind="plain" size="sm" onClick={() => setMini({ briefingLog: [] })}
                style={{ color: "var(--sub)", marginTop: 4, height: "auto", minHeight: 40, paddingLeft: 0, paddingRight: 0, fontWeight: 500 }}>
                Clear conversation (keeps the current directive &amp; role)
              </Button>
            )}
          </Card>

          {/* Task Queue — its own run controls, so you never have to leave this card to work the queue */}
          <Card pad="md">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 2 }}>
              <span className="t-head">Task Queue</span>
              <span className="t-cap" style={{ color: "var(--faint)", textAlign: "right" }}>Runs only when you hit Run</span>
            </div>
            <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.5, marginBottom: 12 }}>Hand it work. Tap a task with output to read it.</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <Field value={taskInput} onChange={e => setTaskInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTask(); } }}
                placeholder="e.g. Draft 5 outreach angles for the med-spa vertical" style={{ flex: 1 }} />
              <Button kind="quiet" size="md" onClick={addTask} style={{ flex: "none" }}>Queue</Button>
            </div>

            <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "12px 13px", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                <span className="t-call" style={{ fontWeight: 600 }}>Daily budget</span>
                <span className="t-cap" style={{ color: "var(--faint)", fontWeight: 400 }}>caps tasks per run: $1→1 · $3→3 · $10→8</span>
              </div>
              <Chips options={["$1", "$3", "$10"]} value={mini.budget} onChange={b => setMini({ budget: b })} fmt={v => v + "/day"} />
              <Button kind="primary" size="lg" full disabled={running || worker.state === "off" || mini.enabled === false} onClick={runNow} style={{ marginTop: 11 }}>
                {running ? "Working the queue…" : mini.enabled === false ? "Mini Me is off" : `Run queue now${queuedCount ? ` (${queuedCount} queued)` : ""}`}
              </Button>
              {runMsg && (
                <div style={{ marginTop: 9, display: "flex", alignItems: "flex-start", gap: 7 }}>
                  <span style={{ paddingTop: 5, display: "inline-flex" }}><Dot tone={runMsg.ok ? "var(--green)" : "var(--red)"} size={6} /></span>
                  <span className="t-foot" style={{ color: runMsg.ok ? "var(--green)" : "var(--red)", lineHeight: 1.5 }}>{runMsg.text}</span>
                </div>
              )}
            </div>

            {active.length === 0 && delivered.length === 0 && (
              <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "10px 0" }}>Nothing queued yet — give it something to work on.</div>
            )}
            {active.length === 0 && delivered.length > 0 && (
              <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "10px 0" }}>Queue's clear — everything's been delivered. See Completed below.</div>
            )}
            {active.length > 0 && (
              <div style={{ margin: "0 -16px" }}>
                {active.map((t, i) => <TaskCell key={t.id} t={t} first={i === 0} />)}
              </div>
            )}

            {delivered.length > 0 && (
              <div style={{ marginTop: 10, borderTop: "0.5px solid var(--line)" }}>
                <button onClick={() => setShowCompleted(!showCompleted)}
                  style={{ width: "100%", minHeight: 44, display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", cursor: "pointer", padding: "2px 0" }}>
                  <span className="t-cap" style={{ fontWeight: 600, color: "var(--sub)" }}>Completed ({delivered.length})</span>
                  <IcChevronDown size={13} style={{ color: "var(--faint)", transform: showCompleted ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />
                </button>
                {showCompleted && (
                  <div style={{ margin: "0 -16px" }}>
                    {delivered.map((t, i) => <TaskCell key={t.id} t={t} first={i === 0} />)}
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Activity feed — real */}
          <Card pad="md">
            <div className="t-head" style={{ marginBottom: 2 }}>Activity Feed</div>
            <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.5, marginBottom: 10 }}>Real worker runs, oversight findings, and your approvals — most recent first.</div>
            {feed === null && <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "8px 0" }}>Loading…</div>}
            {feed?.error && <div className="t-foot" style={{ color: "var(--amber)", lineHeight: 1.5 }}>{feed.error}</div>}
            {Array.isArray(feed) && feed.length === 0 && (
              <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "8px 0" }}>No runs yet — queue a task and hit Run now.</div>
            )}
            {Array.isArray(feed) && feed.map((f, i) => (
              <div key={i} style={{ display: "flex", gap: 11, padding: "9px 0", borderTop: i === 0 ? "none" : "0.5px solid var(--line)" }}>
                <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none", width: 92, paddingTop: 1 }}>{f.when}</span>
                <span className="t-foot" style={{ lineHeight: 1.55, flex: 1, minWidth: 0 }}>{f.text}</span>
              </div>
            ))}
          </Card>
        </div>

        {/* Right column: ambient behavior settings — not tied to any one run */}
        <div style={col}>
          <Card pad="md">
            <div className="t-head" style={{ marginBottom: 2 }}>Control Panel</div>
            <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.5, marginBottom: 14 }}>How it behaves in general — separate from what happens on any one run.</div>

            <div className="t-label" style={{ marginBottom: 8 }}>Brain</div>
            <div className="t-cap" style={{ color: "var(--faint)", fontWeight: 400, marginBottom: 8 }}>Model used for queued tasks</div>
            <Segmented value={mini.model} onChange={k => setMini({ model: k })} />

            <Rule />

            <div className="t-label" style={{ marginBottom: 2 }}>Oversight</div>
            <ToggleRow title="Full Oversight" sub="Audits Chief chat answers for smoothed-over board dissent" on={mini.oversight} onToggle={() => setMini({ oversight: !mini.oversight })} />

            <Rule />

            <div className="t-label" style={{ marginBottom: 10 }}>Quality &amp; review</div>
            <Chips options={["quick", "careful", "thorough"]} value={effort} onChange={setEffort} fmt={k => EFFORT_LEVELS.find(e => e.key === k)?.label || k} />
            <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.5, margin: "8px 0 4px" }}>{EFFORT_LEVELS.find(e => e.key === effort)?.desc}</div>
            {effort === "thorough" && (
              <div style={{ margin: "10px 0 4px" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 7 }}>
                  <span className="t-call" style={{ fontWeight: 600 }}>Max passes</span>
                  <span className="t-cap" style={{ color: "var(--faint)", fontWeight: 400 }}>Auto-stops early if nothing's changing</span>
                </div>
                <Chips options={["5", "15", "50"]} value={mini.loopMax} onChange={n => setMini({ loopMax: n })} fmt={v => v + "×"} />
              </div>
            )}
            <div style={{ height: 6 }} />
            <ToggleRow title="Approval Gate" sub="Finished drafts wait for your tap before counting as delivered" on={mini.approvalOn} onToggle={() => setMini({ approvalOn: !mini.approvalOn })} />
          </Card>
        </div>
      </Grid>
      {confirmEl}
    </div>
  );
}
