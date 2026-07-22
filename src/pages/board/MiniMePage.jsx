// ─── Page: Mind — the delegate (component export stays MiniMePage) ────────────
// The "Mind" delegate: on-demand only — you queue work and hit Run, nothing
// fires on a schedule. It thinks with the compiled Neurons (doctrine + learned
// skills) — see getCompiledMind below — which lead both the task-execution and
// briefing prompts. The worker (mini-worker) runs Claude against the queue,
// writes deliverables onto tasks, and logs to mini_feed.
import { useState, useEffect, useRef } from "react";
import { T } from "../../theme.js";
import { Card, Button, Dot, Switch, Field, useConfirm } from "../../ui/kit.jsx";
import { IcClose, IcChevronDown, IcChevronRight } from "../../ui/icons.jsx";
import { ToggleRow, Segmented, Chips } from "../../ui/primitives.jsx";
import { pingFn } from "../../lib/functions.js";
import { supabase } from "../../lib/supabase.js";
import { callClaude, BOARD } from "../../lib/claude.js";
import { getCompiledMind } from "./mind/mindGenome.js";
import { db } from "../../data/db.js";
import { SeatNotesModal } from "./SeatNotesModal.jsx";

export const MINI_DEFAULTS = {
  model: "haiku", enabled: true, budget: "$3", oversight: true,
  directive: "", briefingLog: [], role: "",
  reflectOn: true, loopOn: true, loopMax: "5", approvalOn: true,
};
export const TASK_COLORS = { delivered: T.green, review: T.brass, queued: T.faint, working: T.blue, failed: T.red };
export const EFFORT_LEVELS = [
  { key: "quick", label: "Quick", desc: "One shot, no self-review — fastest and cheapest." },
  { key: "careful", label: "Careful", desc: "Reviews its own draft once before delivering." },
  { key: "thorough", label: "Thorough", desc: "Keeps refining until satisfied, up to the pass limit — this is how you make it think longer on something." },
];
// Display casing only — the underlying status strings (queued/review/
// delivered/failed) are shared with the worker and must never be renamed.
const STATUS_LABELS = { queued: "Queued", review: "Review", delivered: "Delivered", working: "Working…", failed: "Failed" };

// Tap-to-configure starting points — the plug-and-play path. Each fills both
// the role and the directive in one tap (no typing, no model call), tuned to
// the ventures this app already tracks. Refine anytime in the box below.
const MINI_PRESETS = [
  { label: "Clarify outreach",
    role: "a B2B outreach copywriter for Clarify Paid Search, a boutique Google Ads agency serving local service verticals (legal, med spa, dental, home services)",
    directive: "Move prospects toward booked discovery calls — sharp, specific, and never generic." },
  { label: "Zero To Secure content",
    role: "a security-fluent content strategist growing Zero To Secure's audience and creator pipeline",
    directive: "Turn security topics into content that ranks, teaches, and converts." },
  { label: "Research analyst",
    role: "a rigorous research analyst who turns open questions into decision-ready briefs",
    directive: "Answer the real question — concise, sourced, and honest about what's uncertain." },
  { label: "Right hand",
    role: "a sharp chief of staff who clears queued work without hand-holding",
    directive: "Knock out what's queued cleanly and fast; flag only what truly needs my call." },
];

/* Hairline between sections inside a settings card. */
function Rule() {
  return <div style={{ height: 0.5, background: "var(--line)", margin: "14px 0" }} />;
}


export function MiniMePage({ settings, updateSetting, session, onWorkerRun, onJump, skills = [], isMobile }) {
  const mini = { ...MINI_DEFAULTS, ...(settings?.mini || {}) };
  const setMini = (patch) => updateSetting("mini", { ...mini, ...patch });
  const tasks = settings?.mini_tasks || [];
  const setTasks = (list) => updateSetting("mini_tasks", list);
  // Latest settings through a ref — async completions (sendChat) must read
  // the state as it is NOW, not as it was when the request started.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Cross-nav to the Neurons canvas — the wiring behind this delegate. Agent E
  // supplies onJump; guarded so the affordance only shows when a jump exists.
  const goNeurons = onJump ? () => onJump({ page: "boardroom", sub: "neural" }) : null;

  const [taskInput, setTaskInput] = useState("");
  const [feed, setFeed] = useState(null); // null = loading
  const [worker, setWorker] = useState({ state: "checking" });
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showSettings, setShowSettings] = useState(false); // advanced knobs stay tucked away by default
  const [directiveInput, setDirectiveInput] = useState("");
  const [directiveSending, setDirectiveSending] = useState(false);
  const [skillCount, setSkillCount] = useState(null); // null loading · number · "teach" when table missing
  const [confirmEl, confirm] = useConfirm();

  // ── Seat context ────────────────────────────────────────────────────────────
  // The editor for the five seats' "ground truth" notes lost its only entry
  // point when the board chat was retired — but the notes are still live
  // prompt material for the Discord /board flow, so it lives here now.
  const [editSeat, setEditSeat] = useState(null);
  const [seatNotes, setSeatNotes] = useState(null); // null until loaded
  useEffect(() => {
    if (!showSettings || seatNotes !== null) return;
    let alive = true;
    db.loadSeatNotes().then(n => { if (alive) setSeatNotes(n || {}); }).catch(() => { if (alive) setSeatNotes({}); });
    return () => { alive = false; };
  }, [showSettings, seatNotes]);
  const saveSeatNote = async (key, notes) => {
    await db.saveSeatNote(key, notes);
    setSeatNotes(prev => ({ ...(prev || {}), [key]: notes }));
  };

  // ── Chat with the mind ──────────────────────────────────────────────────────
  // The low-friction front door: no setup, just talk to it. Every turn runs
  // against the compiled Neurons (doctrine + everything taught in Learn), so the
  // reply is the same mind the delegate executes with. Persisted in settings so
  // it survives reloads; capped so it can't grow unbounded; Reset wipes it.
  const chat = settings?.mini_chat || [];
  const setChat = (list) => updateSetting("mini_chat", list.slice(-40));
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const chatScrollRef = useRef(null);
  useEffect(() => {
    // Pin to newest ONLY when already near the bottom — an async reply must
    // not yank the view while the user is scrolled up re-reading history.
    const el = chatScrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [chat.length, chatBusy]);

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    const next = [...chat, { role: "user", text, ts: Date.now() }];
    setChat(next);
    setChatInput("");
    setChatBusy(true);
    // Lead with the compiled Neurons, then a light chat frame — MIND_CHARTER
    // already establishes the identity, so this only sets the register (talking,
    // not running a task). Send a short rolling window to keep tokens in check.
    const system = `${getCompiledMind(skills).systemPrompt}

You're talking with Cameron directly, in a chat — not running a queued task. Answer as this mind: think with the doctrine and learned skills above, be concrete and concise, pressure-test rather than flatter, and name conflicts instead of smoothing them. Only produce a full deliverable if he explicitly asks; otherwise just talk it through.`;
    const reply = await callClaude({
      system,
      messages: next.slice(-12).map(m => ({ role: m.role, content: m.text })),
      modelKey: mini.model || "haiku", maxTokens: 1000, fn: "mind_chat",
    });
    // Append against the LATEST stored list, not the send-time capture — a
    // Reset landing while the model was thinking used to be resurrected
    // wholesale by `[...next, reply]`. If our user turn is gone (reset/
    // rewritten elsewhere), drop the reply and respect the newer state.
    const latest = settingsRef.current?.mini_chat || [];
    const userTs = next[next.length - 1].ts;
    if (latest.some(m => m.ts === userTs)) {
      setChat([...latest, { role: "assistant", text: reply || "Couldn't reach the model just now — check the API key in Systems, then try again.", ts: Date.now() }]);
    }
    setChatBusy(false);
  };
  const resetChat = () => { setChat([]); setChatInput(""); };

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
    // The compiled Neurons (doctrine + everything taught in Learn) are the
    // operating context the delegate runs under. The genome lives in client
    // storage, so the client hands the compiled mind to the worker to lead the
    // task-execution prompt, ahead of role/directive/task — tune a Neuron or
    // teach a skill and what the delegate produces shifts with it.
    const { ok, data, status } = await callWorker({ run: true, mind: getCompiledMind(skills).systemPrompt });
    if (!ok || !data?.success) setRunMsg({ ok: false, text: data?.error || `worker failed (${status || "network"})` });
    else setRunMsg({ ok: true, text: data.message || `processed ${data.processed} task(s)` });
    await loadFeed();
    await onWorkerRun?.();
    setRunning(false);
  };

  const approveTask = async (id) => {
    setRunning(true); setRunMsg(null);
    const { ok, data, status } = await callWorker({ approve: id });
    if (!ok || !data?.success) setRunMsg({ ok: false, text: data?.error || `couldn't approve (${status || "network"})` });
    await loadFeed();
    await onWorkerRun?.();
    setRunning(false);
  };
  const rejectTask = async (id) => {
    setRunning(true); setRunMsg(null);
    const { ok, data, status } = await callWorker({ reject: id });
    if (!ok || !data?.success) setRunMsg({ ok: false, text: data?.error || `couldn't reject (${status || "network"})` });
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
    // Lead with the compiled Neurons (doctrine + learned skills) so the briefing
    // reads Cameron's message through the same mind the delegate executes with.
    const system = `${getCompiledMind(skills).systemPrompt}

You maintain two things for Cameron's autonomous assistant, Mind, from an ongoing conversation:
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

  // One-tap setup: drop in a preset's role + directive directly (no model
  // round-trip) and note both in the briefing log so the change is visible.
  const applyPreset = (p) => {
    const ts = Date.now();
    const entries = [
      { role: "system", field: "role", text: p.role, ts },
      { role: "system", field: "directive", text: p.directive, ts },
    ];
    setMini({ role: p.role, directive: p.directive, briefingLog: [...(mini.briefingLog || []), ...entries].slice(-24) });
  };
  // "Change" — wipe the identity so the starting-point picker comes back.
  const resetIdentity = () => setMini({ role: "", directive: "", briefingLog: [] });

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
  const effortLabel = EFFORT_LEVELS.find(e => e.key === effort)?.label || effort;
  const setEffort = (e) => {
    if (e === "quick") setMini({ reflectOn: false, loopOn: false });
    else if (e === "careful") setMini({ reflectOn: true, loopOn: false });
    else setMini({ reflectOn: true, loopOn: true, loopMax: mini.loopMax || "5" });
  };

  const configured = !!(mini.directive || mini.role); // once set up, show identity; before that, offer quick-start presets

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
    <div style={{ width: "100%", maxWidth: 640, margin: "0 auto", padding: isMobile ? "8px 16px 0" : "4px 0 0" }}>
      {/* One column everywhere: identity → queue → activity → settings. The old
          two-column split left the small collapsed Settings card stranded in an
          empty right column. */}
      <div style={col}>

          {/* Hero — identity, directive, role. No XP/level — just what it is and what it's doing. */}
          <Card pad="md">
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 12 }}>
              <span style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span className="t-head">Mind</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
                    <Dot tone={statusTone} pulse={statusPulse} size={6} />
                    <span className="t-cap" style={{ color: statusTone, fontWeight: 600 }}>{statusLabel}</span>
                  </span>
                </span>
                <span className="t-foot" style={{ lineHeight: 1.5 }}>Talk to your mind — it thinks with your Neurons and everything you've taught it. Queue background work in the Task Queue below.</span>
                {goNeurons && skillCount !== null && (
                  <Button kind="plain" size="sm" onClick={goNeurons}
                    style={{ alignSelf: "flex-start", height: "auto", minHeight: 40, paddingLeft: 0, paddingRight: 0, gap: 4 }}>
                    {typeof skillCount === "number" && skillCount > 0 ? `${skillCount} neuron${skillCount > 1 ? "s" : ""} taught · view` : "View your Neurons"}
                    <IcChevronRight size={11} />
                  </Button>
                )}
                {worker.state !== "ok" && worker.state !== "checking" && mini.enabled !== false && (
                  <span className="t-cap" style={{ color: "var(--amber)", fontWeight: 500, lineHeight: 1.5 }}>{worker.detail}</span>
                )}
              </span>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: "none" }}>
                <Switch on={mini.enabled !== false} onToggle={() => setMini({ enabled: mini.enabled === false })} aria-label="Mind enabled" />
                <span className="t-cap" style={{ fontWeight: 600, color: mini.enabled === false ? "var(--faint)" : "var(--green)" }}>{mini.enabled === false ? "Off" : "On"}</span>
              </div>
            </div>
            {/* Chat — the low-friction front door. No setup to wade through: just
                talk to it, and every turn answers from the compiled Neurons. History
                persists across reloads; Reset clears it so old threads don't linger. */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
              <span className="t-label">Chat</span>
              {chat.length > 0 && (
                <button onClick={resetChat} className="hoverable" aria-label="Reset chat" disabled={chatBusy}
                  style={{ background: "none", border: "none", cursor: chatBusy ? "default" : "pointer", color: "var(--sub)", fontSize: 12.5, fontWeight: 600, padding: "2px 2px", minHeight: 44, opacity: chatBusy ? 0.5 : 1 }}>
                  Reset
                </button>
              )}
            </div>
            <div ref={chatScrollRef}
              style={{ maxHeight: isMobile ? 320 : 380, minHeight: 92, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
              {chat.length === 0 && !chatBusy && (
                <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.55, textAlign: "center", padding: "20px 10px" }}>
                  Ask your mind anything. It thinks with your Neurons — doctrine plus everything you've taught it.
                </div>
              )}
              {/* user bubbles: accent-TINTED per the design language (§8) — a
                  solid gold fill per message blew the accent budget on every
                  populated chat. ts keys, not index: the 40-cap slice shifts
                  positions. */}
              {chat.map((m, i) => (
                <div key={m.ts || i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div className="t-call" style={{
                    maxWidth: "86%", padding: "9px 12px", borderRadius: 14, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "break-word",
                    background: m.role === "user" ? "var(--accent-a10)" : "var(--surface-2)",
                    color: "var(--ink)",
                    borderBottomRightRadius: m.role === "user" ? 4 : 14,
                    borderBottomLeftRadius: m.role === "user" ? 14 : 4,
                  }}>{m.text}</div>
                </div>
              ))}
              {chatBusy && (
                <div style={{ display: "flex", justifyContent: "flex-start" }}>
                  <div className="t-foot" style={{ background: "var(--surface-2)", color: "var(--sub)", padding: "9px 12px", borderRadius: 14, borderBottomLeftRadius: 4 }}>thinking…</div>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Field value={chatInput} onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                placeholder="Talk to your mind…" aria-label="Talk to your mind" disabled={chatBusy} style={{ flex: 1 }} />
              {/* tinted, not primary — "Run queue now" below is this screen's one primary action */}
              <Button kind="tinted" size="md" onClick={sendChat} disabled={chatBusy || !chatInput.trim()} style={{ flex: "none" }}>
                {chatBusy ? "…" : "Send"}
              </Button>
            </div>
          </Card>

          {/* Task Queue — its own run controls, so you never have to leave this card to work the queue */}
          <Card pad="md">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 2 }}>
              <span className="t-head">Task Queue</span>
              <span className="t-cap" style={{ color: "var(--faint)", textAlign: "right" }}>Runs only when you hit Run</span>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <Field value={taskInput} onChange={e => setTaskInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTask(); } }}
                placeholder="e.g. Draft 5 outreach angles for the med-spa vertical" aria-label="Queue a task" style={{ flex: 1 }} />
              <Button kind="quiet" size="md" onClick={addTask} style={{ flex: "none" }}>Queue</Button>
            </div>
            <Button kind="primary" size="lg" full disabled={running || worker.state === "off" || mini.enabled === false} onClick={runNow} style={{ marginBottom: 12 }}>
              {running ? "Working the queue…" : mini.enabled === false ? "Mind is off" : `Run queue now${queuedCount ? ` (${queuedCount} queued)` : ""}`}
            </Button>
            {runMsg && (
              <div style={{ marginTop: -2, marginBottom: 12, display: "flex", alignItems: "flex-start", gap: 7 }}>
                <span style={{ paddingTop: 5, display: "inline-flex" }}><Dot tone={runMsg.ok ? "var(--green)" : "var(--red)"} size={6} /></span>
                <span className="t-foot" style={{ color: runMsg.ok ? "var(--green)" : "var(--red)", lineHeight: 1.5 }}>{runMsg.text}</span>
              </div>
            )}

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
            <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.5, marginBottom: 10 }}>Runs, findings, and approvals — newest first.</div>
            {feed === null && <div className="t-foot" style={{ color: "var(--faint)", textAlign: "center", padding: "8px 0" }}>Loading…</div>}
            {feed?.error && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="t-foot" style={{ color: "var(--amber)", lineHeight: 1.5, flex: 1 }}>{feed.error}</span>
                <Button kind="quiet" size="sm" onClick={loadFeed} style={{ flex: "none" }}>Retry</Button>
              </div>
            )}
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

          {/* Everything advanced, collapsed behind one disclosure so the default
              view stays set-up → queue → run → results. */}
          <Card pad="md">
            <button onClick={() => setShowSettings(s => !s)} aria-expanded={showSettings}
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "none", border: "none", cursor: "pointer", padding: 0, minHeight: 32, textAlign: "left" }}>
              <span className="t-head">Settings</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
                <span className="t-cap" style={{ color: "var(--faint)" }}>{mini.budget}/day · {effortLabel}</span>
                <IcChevronDown size={14} style={{ color: "var(--faint)", transform: showSettings ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />
              </span>
            </button>
            {showSettings && (
              <div style={{ marginTop: 14 }}>
                {/* Role & directive — the persona the worker adopts on queued task
                    runs. Moved out of the top so chat stays friction-free; still
                    fully editable here, and the delegate reads it server-side. */}
                <div className="t-label" style={{ marginBottom: 8 }}>Role &amp; directive</div>
                <div className="t-cap" style={{ color: "var(--faint)", fontWeight: 400, marginBottom: 10 }}>Who the delegate becomes when it works the queue — chat always uses your full Neurons regardless.</div>
                {configured ? (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                      <span className="t-cap" style={{ fontWeight: 600, color: "var(--sub)" }}>Set up as</span>
                      <button onClick={resetIdentity} className="hoverable" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 12.5, fontWeight: 600, padding: "2px 2px" }}>Change</button>
                    </div>
                    <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "11px 13px" }}>
                      {mini.role && <div className="t-call" style={{ lineHeight: 1.5 }}>{mini.role}</div>}
                      {mini.directive && <div className="t-foot" style={{ lineHeight: 1.5, marginTop: mini.role ? 5 : 0, fontStyle: "italic", color: "var(--sub)" }}>"{mini.directive}"</div>}
                    </div>
                  </div>
                ) : (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {MINI_PRESETS.map(p => (
                        <button key={p.label} onClick={() => applyPreset(p)} className="hoverable"
                          style={{ padding: "9px 14px", minHeight: 40, borderRadius: 999, border: "0.5px solid var(--line-strong)", background: "var(--surface-2)", color: "var(--ink)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <div className="t-cap" style={{ color: "var(--faint)", marginTop: 12 }}>or describe it in your own words below</div>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <Field value={directiveInput} onChange={e => setDirectiveInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); sendDirectiveUpdate(); } }}
                    placeholder={configured ? "Refine it — e.g. focus on the dental vertical this week" : "Describe it — e.g. you're my SEO strategist for Zero To Secure"} disabled={directiveSending} style={{ flex: 1 }} />
                  <Button kind="quiet" size="md" onClick={sendDirectiveUpdate} disabled={directiveSending || !directiveInput.trim()} style={{ flex: "none" }}>
                    {directiveSending ? "…" : "Send"}
                  </Button>
                </div>

                <Rule />

                <div className="t-label" style={{ marginBottom: 8 }}>Daily budget</div>
                <div className="t-cap" style={{ color: "var(--faint)", fontWeight: 400, marginBottom: 8 }}>Caps how many tasks run each time: $1→1 · $3→3 · $10→8</div>
                <Chips options={["$1", "$3", "$10"]} value={mini.budget} onChange={b => setMini({ budget: b })} fmt={v => v + "/day"} />

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

                <Rule />

                <ToggleRow title="Approval Gate" sub="Finished drafts wait for your tap before they count as delivered" on={mini.approvalOn} onToggle={() => setMini({ approvalOn: !mini.approvalOn })} />
                {/* ("Full Oversight" is gone: it audited the retired board
                    chat's multi-seat syntheses — with that pipeline removed
                    the toggle controlled nothing.) */}

                <Rule />

                <div className="t-label" style={{ marginBottom: 8 }}>Seat context</div>
                <div className="t-cap" style={{ color: "var(--faint)", fontWeight: 400, marginBottom: 8 }}>Ground truth each board seat reads — the Discord /board command consults these.</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {BOARD.map(s => (
                    <button key={s.key} onClick={() => setEditSeat(s.key)} className="hoverable"
                      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 14px", minHeight: 40, borderRadius: 999, border: "0.5px solid var(--line-strong)", background: "var(--surface-2)", color: "var(--ink)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                      <Dot tone={seatNotes?.[s.key] ? s.color : "var(--line-strong)"} size={7} />
                      {s.name}
                    </button>
                  ))}
                </div>

                <Rule />

                <div className="t-label" style={{ marginBottom: 8 }}>Brain</div>
                <div className="t-cap" style={{ color: "var(--faint)", fontWeight: 400, marginBottom: 8 }}>Model used for chat and queued tasks</div>
                <Segmented value={mini.model} onChange={k => setMini({ model: k })} />
              </div>
            )}
          </Card>
        </div>
      {editSeat && <SeatNotesModal seatKey={editSeat} initial={seatNotes?.[editSeat]} onSave={saveSeatNote} onClose={() => setEditSeat(null)} isMobile={isMobile} />}
      {confirmEl}
    </div>
  );
}
