// ─── Summon (⌘K) ──────────────────────────────────────────────────────────────
// One keystroke — or one thumb — to anywhere: pages, notes, and jotting a note
// without leaving what you're doing. Keyboard grammar: "n:" files a note; ↑↓ + ↵
// navigate. Touch gets the same power as visible controls: a quick-action button
// up top, 44pt rows below.
//
// Everything that pointed at Mind is gone with it — the Mini Me / Learn / Board
// chat / Seats destinations, the "Teach a skill" and "Ask the Mind" actions, the
// skill search rows, and the "t:" and "a:" commands. A palette that offers to
// take you somewhere that no longer exists is worse than a smaller palette.
import { useState, useEffect, useRef, useMemo } from "react";
import { db } from "../data/db.js";
import { Button, Dot } from "../ui/kit.jsx";
import { IcSearch, IcNote, IcChevronRight } from "../ui/icons.jsx";

const SUMMON_PLACES = [
  { label: "Brief", page: "brief", hint: "markets · wires · stores" },
  { label: "Notes", page: "personal", sub: "notes", hint: "personal" },
  { label: "Calendar", page: "personal", sub: "calendar", hint: "personal" },
  { label: "Train", page: "train", hint: "log a workout · routines · progress" },
  { label: "Upkeep", page: "personal", sub: "upkeep", hint: "oil · filters · renewals" },
  { label: "Creed", page: "personal", sub: "creed", hint: "ground yourself" },
  { label: "Birthdays", page: "personal", sub: "birthdays", hint: "personal" },
  { label: "Movies", page: "personal", sub: "movies", hint: "watchlist" },
  { label: "Food", page: "personal", sub: "food", hint: "meals" },
  { label: "Grocery", page: "grocery", hint: "the list · aisles · cart" },
  { label: "Assets", page: "assets", hint: "usage · properties · auditor" },
  // Systems folded into Assets — jump straight onto its Status sub-tab.
  { label: "Systems", page: "assets", sub: "status", hint: "usage · status · deploy" },
];

export function Summon({ onClose, onGo, onJot, isMobile }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState(null); // null | "jot" — the note sheet; "task" went with Mind
  const [modeText, setModeText] = useState("");
  const [flash, setFlash] = useState(null); // confirmation line before close
  const [notes, setNotes] = useState([]);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const closeTimer = useRef(null);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    db.loadNotes().then(({ rows }) => setNotes(rows || [])).catch(() => {});
  }, []);
  // Focus the field on open/mode change — but not on touch devices, where the
  // keyboard would cover the list the user came here to tap.
  useEffect(() => { if (!isMobile || mode) inputRef.current?.focus(); }, [mode, isMobile]);

  const needle = q.trim().toLowerCase();
  const hit = (s) => (s || "").toLowerCase().includes(needle);
  const noteTitle = (n) => n.title?.trim() || (n.body || "").split("\n").map(l => l.trim()).find(Boolean)?.slice(0, 60) || "Untitled note";

  // Quick-file grammar: "n: milk" files a note on Enter — thought to filed in
  // one line, no menu hop.
  const fileCmd = async (kind, text) => {
    try {
      await onJot(text);
      setFlash("Filed to Notes");
      setQ("");
      closeTimer.current = setTimeout(onClose, 650);
    } catch (e) { setFlash(e.message || "Couldn't save — try again."); }
  };

  const rows = useMemo(() => {
    const noteCmd = q.match(/^(?:n|note|jot)\s*:\s*(\S[\s\S]*)$/i);
    if (noteCmd) {
      return [{ kind: "cmd", label: `Jot to Notes — “${noteCmd[1].trim()}”`, hint: "↵ files it", run: () => fileCmd("jot", noteCmd[1].trim()) }];
    }
    const places = SUMMON_PLACES.filter(p => !needle || hit(p.label) || hit(p.hint))
      .map(p => ({ kind: "go", label: p.label, hint: p.hint, go: p }));
    const noteRows = (needle ? notes.filter(n => hit(n.title) || hit(n.body)) : notes.slice(0, 3))
      .slice(0, 5).map(n => ({ kind: "note", label: noteTitle(n), hint: "note", go: { page: "personal", sub: "notes", noteId: n.id } }));
    return [...places, ...noteRows];
  }, [q, needle, notes]); // eslint-disable-line react-hooks/exhaustive-deps

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
      await onJot(t);
      setFlash("Saved to Notes");
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

  const sectionOf = (r) => r.kind === "go" ? "Go to" : r.kind === "note" ? "Notes" : "Quick file";
  const ok = flash && !/couldn|try again/i.test(flash);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--scrim)", zIndex: 600, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: isMobile ? "calc(env(safe-area-inset-top) + 54px) 12px 0" : "14vh 20px 0", animation: "fadein 0.14s ease" }}>
      <div onClick={e => e.stopPropagation()} onKeyDown={onKey}
        style={{ width: "100%", maxWidth: 580, background: "var(--surface)", border: "none", borderRadius: 18, boxShadow: "var(--shadow-deep)", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: isMobile ? "72dvh" : "62vh" }}>

        {mode ? (
          <div style={{ padding: 16 }}>
            <div className="t-head" style={{ padding: "2px 2px 12px" }}>Jot a Note</div>
            <textarea ref={inputRef} value={modeText} onChange={e => setModeText(e.target.value)} rows={3} className="field"
              placeholder="The thought, as it comes."
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitMode(); } }}
              style={{ resize: "none", lineHeight: 1.55 }} />
            {flash && <div className="t-foot" style={{ marginTop: 10, color: ok ? "var(--green)" : "var(--red)" }}>{flash}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button kind="quiet" size="md" style={{ flex: 1 }} onClick={() => { setMode(null); setFlash(null); }}>Back</Button>
              <Button kind="primary" size="md" style={{ flex: 2 }} disabled={!modeText.trim()} onClick={commitMode}>Save note</Button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 16px 0", flex: "none" }}>
              <IcSearch size={18} style={{ color: "var(--faint)", flex: "none" }} />
              <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} enterKeyHint="go"
                placeholder={isMobile ? "Jump or search…" : "Jump, jot, search…"}
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
