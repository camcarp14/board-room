// ─── Summon (⌘K) ──────────────────────────────────────────────────────────────
// One keystroke — or one thumb — to anywhere: pages, notes, skills, and quick
// actions (jot a note, queue a Mini Me task) without leaving what you're doing.
// Keyboard grammar preserved exactly: "n:" files a note, "t:" queues a task,
// "a:" convenes the board; ↑↓ + ↵ navigate. Touch gets the same power as
// visible controls: quick-action buttons up top, 44pt rows below.
import { useState, useEffect, useRef, useMemo } from "react";
import { db } from "../data/db.js";
import { supabase } from "../lib/supabase.js";
import { makeSdb as makeSkillsDb } from "../LearnPanel.jsx";
import { Button, Dot } from "../ui/kit.jsx";
import { IcSearch, IcNote, IcSpark, IcChevronRight } from "../ui/icons.jsx";

const SUMMON_PLACES = [
  { label: "Brief", page: "brief", hint: "markets · wires · stores" },
  { label: "Notes", page: "personal", sub: "notes", hint: "personal" },
  { label: "Calendar", page: "personal", sub: "calendar", hint: "personal" },
  { label: "Workout", page: "personal", sub: "workout", hint: "training" },
  { label: "Upkeep", page: "personal", sub: "upkeep", hint: "oil · filters · renewals" },
  { label: "Creed", page: "personal", sub: "creed", hint: "ground yourself" },
  { label: "Birthdays", page: "personal", sub: "birthdays", hint: "personal" },
  { label: "Movies", page: "personal", sub: "movies", hint: "watchlist" },
  { label: "Food", page: "personal", sub: "food", hint: "meals" },
  { label: "Mini Me", page: "boardroom", sub: "mini", hint: "queue · run" },
  { label: "Learn", page: "boardroom", sub: "learn", hint: "skills" },
  { label: "Board chat", page: "boardroom", sub: "chat", hint: "ask the seats" },
  { label: "Seats", page: "boardroom", sub: "seats", hint: "the five" },
  { label: "Assets", page: "assets", hint: "properties · auditor" },
  { label: "Systems", page: "systems", hint: "usage · status · deploy" },
];

export function Summon({ onClose, onGo, onJot, onQueueTask, onAsk, isMobile }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState(null); // null | "jot" | "task"
  const [modeText, setModeText] = useState("");
  const [flash, setFlash] = useState(null); // confirmation line before close
  const [notes, setNotes] = useState([]);
  const [skills, setSkills] = useState([]);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const closeTimer = useRef(null);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    db.loadNotes().then(({ rows }) => setNotes(rows || [])).catch(() => {});
    makeSkillsDb(supabase).load().then(setSkills).catch(() => {});
  }, []);
  // Focus the field on open/mode change — but not on touch devices, where the
  // keyboard would cover the list the user came here to tap.
  useEffect(() => { if (!isMobile || mode) inputRef.current?.focus(); }, [mode, isMobile]);

  const needle = q.trim().toLowerCase();
  const hit = (s) => (s || "").toLowerCase().includes(needle);
  const noteTitle = (n) => n.title?.trim() || (n.body || "").split("\n").map(l => l.trim()).find(Boolean)?.slice(0, 60) || "Untitled note";

  // Quick-file grammar: "n: milk" files a note on Enter, "t:" queues Mini Me,
  // "a:" convenes the board — thought to filed in one line, no menu hop.
  const fileCmd = async (kind, text) => {
    try {
      if (kind === "jot") { await onJot(text); setFlash("Filed to Notes"); }
      else { await onQueueTask(text); setFlash("Queued for Mini Me"); }
      setQ("");
      closeTimer.current = setTimeout(onClose, 650);
    } catch (e) { setFlash(e.message || "Couldn't save — try again."); }
  };

  const rows = useMemo(() => {
    const noteCmd = q.match(/^(?:n|note|jot)\s*:\s*(\S[\s\S]*)$/i);
    const taskCmd = q.match(/^(?:t|task|mini)\s*:\s*(\S[\s\S]*)$/i);
    const askCmd = q.match(/^(?:a|ask)\s*:\s*(\S[\s\S]*)$/i);
    if (noteCmd || taskCmd || askCmd) {
      const cmds = [];
      if (noteCmd) cmds.push({ kind: "cmd", label: `Jot to Notes — “${noteCmd[1].trim()}”`, hint: "↵ files it", run: () => fileCmd("jot", noteCmd[1].trim()) });
      if (taskCmd) cmds.push({ kind: "cmd", label: `Queue for Mini Me — “${taskCmd[1].trim()}”`, hint: "↵ queues it", run: () => fileCmd("task", taskCmd[1].trim()) });
      if (askCmd) cmds.push({ kind: "cmd", label: `Ask the board — “${askCmd[1].trim()}”`, hint: "convene ↵", run: () => onAsk?.(askCmd[1].trim()) });
      return cmds;
    }
    const actions = [
      { kind: "act", label: "Teach a skill", hint: "/learn", go: { page: "boardroom", sub: "learn" } },
      { kind: "act", label: "Ask the board", hint: "open the chat", go: { page: "boardroom", sub: "chat" } },
    ].filter(a => !needle || hit(a.label) || hit(a.hint));
    const places = SUMMON_PLACES.filter(p => !needle || hit(p.label) || hit(p.hint))
      .map(p => ({ kind: "go", label: p.label, hint: p.hint, go: p }));
    const noteRows = (needle ? notes.filter(n => hit(n.title) || hit(n.body)) : notes.slice(0, 3))
      .slice(0, 5).map(n => ({ kind: "note", label: noteTitle(n), hint: "note", go: { page: "personal", sub: "notes", noteId: n.id } }));
    const skillRows = (needle ? skills.filter(s => hit(s.title) || hit(s.description) || hit(s.content)) : [])
      .slice(0, 5).map(s => ({ kind: "skill", label: s.title, hint: "skill", go: { page: "boardroom", sub: "learn", skillId: s.id } }));
    // Anything typed can simply be asked — the question lands in the Room
    // already sent. Kept last so jump-to muscle memory ("cal" ↵) still wins;
    // when nothing else matches, asking IS the Enter action.
    const askRows = needle.length >= 3 && onAsk
      ? [{ kind: "ask", label: `Ask the board — “${q.trim()}”`, hint: "convene ↵", run: () => onAsk(q.trim()) }]
      : [];
    return [...actions, ...places, ...noteRows, ...skillRows, ...askRows];
  }, [q, needle, notes, skills]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setIdx(0); }, [needle]);
  useEffect(() => {
    listRef.current?.querySelectorAll("[data-row]")[idx]?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const choose = (r) => {
    if (!r) return;
    if (r.run) return r.run();
    if (r.go) onGo(r.go);
  };

  const commitMode = async () => {
    const t = modeText.trim();
    if (!t) return;
    try {
      if (mode === "jot") { await onJot(t); setFlash("Saved to Notes"); }
      else { await onQueueTask(t); setFlash("Queued for Mini Me"); }
      setModeText("");
      closeTimer.current = setTimeout(onClose, 650);
    } catch (e) { setFlash(e.message || "Couldn't save — try again."); }
  };

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); mode ? (setMode(null), setFlash(null)) : onClose(); return; }
    if (mode) { if (e.key === "Enter") { e.preventDefault(); commitMode(); } return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(rows[idx]); }
  };

  const sectionOf = (r) => r.kind === "act" ? "Actions" : r.kind === "go" ? "Go to" : r.kind === "note" ? "Notes" : r.kind === "ask" ? "Or just ask" : r.kind === "cmd" ? "Quick file" : "Skills";
  const ok = flash && !/couldn|try again/i.test(flash);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--scrim)", zIndex: 600, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: isMobile ? "calc(env(safe-area-inset-top) + 54px) 12px 0" : "14vh 20px 0", animation: "fadein 0.14s ease" }}>
      <div onClick={e => e.stopPropagation()} onKeyDown={onKey}
        style={{ width: "100%", maxWidth: 580, background: "var(--surface)", border: "none", borderRadius: 18, boxShadow: "var(--shadow-deep)", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: isMobile ? "72dvh" : "62vh" }}>

        {mode ? (
          <div style={{ padding: 16 }}>
            <div className="t-head" style={{ padding: "2px 2px 12px" }}>{mode === "jot" ? "Jot a Note" : "Queue a Task"}</div>
            <textarea ref={inputRef} value={modeText} onChange={e => setModeText(e.target.value)} rows={3} className="field"
              placeholder={mode === "jot" ? "The thought, as it comes." : "What should Mini Me take on?"}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitMode(); } }}
              style={{ resize: "none", lineHeight: 1.55 }} />
            {flash && <div className="t-foot" style={{ marginTop: 10, color: ok ? "var(--green)" : "var(--red)" }}>{flash}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button kind="quiet" size="md" style={{ flex: 1 }} onClick={() => { setMode(null); setFlash(null); }}>Back</Button>
              <Button kind="primary" size="md" style={{ flex: 2 }} disabled={!modeText.trim()} onClick={commitMode}>{mode === "jot" ? "Save note" : "Queue it"}</Button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 16px 0", flex: "none" }}>
              <IcSearch size={18} style={{ color: "var(--faint)", flex: "none" }} />
              <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} enterKeyHint="go"
                placeholder={isMobile ? "Jump, search, or ask…" : "Jump, jot, search — or just ask the board…"}
                style={{ border: "none", outline: "none", background: "transparent", padding: "15px 0", fontSize: 16, color: "var(--ink)", fontFamily: "inherit", flex: 1, minWidth: 0 }} />
              {!isMobile && <kbd style={{ flex: "none" }}>esc</kbd>}
            </div>
            <div style={{ height: 0.5, background: "var(--line)", flex: "none" }} />
            {flash && <div className="t-foot" style={{ padding: "10px 18px 0", color: ok ? "var(--green)" : "var(--red)", flex: "none" }}>{flash}</div>}

            {!needle && (
              <div style={{ display: "flex", gap: 8, padding: "12px 12px 2px", flex: "none" }}>
                <Button kind="quiet" size="md" style={{ flex: 1, justifyContent: "flex-start", gap: 9 }} onClick={() => { setMode("jot"); setQ(""); setFlash(null); }}>
                  <IcNote size={17} style={{ color: "var(--accent)" }} /> Jot a note
                </Button>
                <Button kind="quiet" size="md" style={{ flex: 1, justifyContent: "flex-start", gap: 9 }} onClick={() => { setMode("task"); setQ(""); setFlash(null); }}>
                  <IcSpark size={17} style={{ color: "var(--accent)" }} /> Queue a task
                </Button>
              </div>
            )}

            <div ref={listRef} style={{ overflowY: "auto", padding: "0 8px 10px", overscrollBehavior: "contain" }}>
              {rows.length === 0 && <div className="t-foot" style={{ padding: "24px 12px", textAlign: "center", color: "var(--faint)" }}>Nothing matches “{q}”.</div>}
              {rows.map((r, i) => {
                const showSection = i === 0 || sectionOf(rows[i - 1]) !== sectionOf(r);
                const active = i === idx;
                return (
                  <div key={`${r.kind}-${r.label}-${i}`}>
                    {showSection && <div className="t-label" style={{ padding: "14px 12px 6px" }}>{sectionOf(r)}</div>}
                    <div data-row onClick={() => choose(r)} onMouseEnter={() => setIdx(i)}
                      style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "6px 12px", borderRadius: 11, cursor: "pointer", background: active ? "var(--ink-a05)" : "transparent" }}>
                      <Dot tone={active ? "var(--accent)" : "var(--line-strong)"} size={5} />
                      <span style={{ fontSize: 14.5, fontWeight: 500, letterSpacing: "-0.008em", color: "var(--ink)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
                      {r.hint && <span className="t-cap" style={{ color: "var(--faint)", flex: "none" }}>{r.hint}</span>}
                      {r.go && <IcChevronRight size={13} style={{ color: "var(--faint)", flex: "none" }} />}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
