// ─── Notes tile — the Docket's quiet companion on the Brief ──────────────────
// Same personal_notes table the Notes tab owns: recent notes at a glance,
// one-line capture, tap any note to edit it in place, or jump to the full tab.
import { useState, useRef } from "react";
import { CollapsibleCard, Button, Field, Spinner, EmptyState, Dot } from "../../ui/kit.jsx";
import { IcNote, IcPin, IcPlus, IcChevronRight } from "../../ui/icons.jsx";
import { NoteCardPreview, sealColor, continueListOnEnter, toggleBulletAtCaret } from "../../ui/shared.jsx";
import { queryClient } from "../../lib/queryClient.js";
import { useNotes } from "../../data/notes.js";
import { db } from "../../data/db.js";

const LIST_CAP = 5; // first N notes in-page; the rest behind "Show all" (no nested scroll)

export function NotesTile({ isMobile, refreshSignal, onOpenNotes, collapsed, onToggle }) {
  // refreshSignal is accepted but unused here — freshness comes from the
  // useNotes query cache; the prop stays wired for parity with the other cards.
  const { data: notesData, error: notesErr } = useNotes();
  const notes = notesData?.rows ?? null; // null = loading
  const setNotes = (u) => queryClient.setQueryData(["notes"], (old) => ({ rows: (typeof u === "function" ? u(old?.rows ?? null) : u) ?? [], legacy: old?.legacy ?? false }));
  const [err, setErr] = useState(null); // save errors; load errors come from the query
  const loadErr = notesErr ? (notesErr.message || "Couldn't load notes.") : null;
  const [quick, setQuick] = useState("");
  const [savingQuick, setSavingQuick] = useState(false);
  const [editing, setEditing] = useState(null); // { id, title, body }
  const [savingEdit, setSavingEdit] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const editBodyRef = useRef(null);
  const applyEditBody = (next, caret) => {
    setEditing(ed => ({ ...ed, body: next }));
    requestAnimationFrame(() => { try { editBodyRef.current?.setSelectionRange(caret, caret); } catch {} });
  };

  const sorted = (notes || []).slice().sort((a, b) =>
    (b.pinned === true) - (a.pinned === true) || new Date(b.updated_at) - new Date(a.updated_at));
  // Keep the note being edited on screen even if a cache refresh reshuffles it
  // below the cap — the open editor must never vanish mid-thought.
  let visible = showAll ? sorted : sorted.slice(0, LIST_CAP);
  if (editing && !visible.some(n => n.id === editing.id)) {
    const edited = sorted.find(n => n.id === editing.id);
    if (edited) visible = [...visible, edited];
  }

  const addQuick = async () => {
    const text = quick.trim();
    if (!text || savingQuick) return;
    setSavingQuick(true);
    try {
      const saved = await db.saveNote({ id: crypto.randomUUID(), title: "", body: text });
      setQuick("");
      setNotes(prev => [saved, ...(prev || [])]);
    } catch (e) { setErr(e.message || "Couldn't save that."); }
    setSavingQuick(false);
  };
  const saveEdit = async () => {
    if (savingEdit || !editing) return;
    setSavingEdit(true);
    try {
      const saved = await db.saveNote({ id: editing.id, title: editing.title, body: editing.body });
      setNotes(prev => (prev || []).map(n => (n.id === saved.id ? saved : n)));
      setEditing(null);
    } catch (e) { setErr(e.message || "Couldn't save that."); }
    setSavingEdit(false);
  };

  const relTime = (iso) => {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    if (m < 60 * 24) return `${Math.round(m / 60)}h`;
    if (m < 60 * 24 * 7) return `${Math.round(m / 1440)}d`;
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const headline = (n) => (n.title || "").trim() || (n.body || "").trim().split("\n")[0] || "Untitled";
  const snippet = (n) => {
    const body = n.body || "";
    if ((n.title || "").trim()) return body.trim();
    // No title → the first non-empty line is the headline; keep the rest with newlines intact.
    const lines = body.split("\n");
    const firstIdx = lines.findIndex(l => l.trim());
    return firstIdx === -1 ? "" : lines.slice(firstIdx + 1).join("\n").trim();
  };

  return (
    <CollapsibleCard collapsed={collapsed} onToggle={onToggle} pad={isMobile ? "md" : "lg"} title="Notes"
      trailing={
        <Button kind="plain" size="sm" onClick={() => onOpenNotes?.()} aria-label="Open all notes"
          style={{ height: 44, margin: "-10px -10px -10px 0", padding: "0 10px", flex: "none" }}>
          All <IcChevronRight size={12} />
        </Button>
      }>

      {/* quick capture — one line, Enter files it */}
      <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
        <Field value={quick} onChange={e => setQuick(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addQuick(); }}
          placeholder="Capture a thought…" style={{ flex: 1, minWidth: 0 }} />
        <Button kind={quick.trim() ? "primary" : "quiet"} disabled={!quick.trim() || savingQuick} onClick={addQuick}
          aria-label="Save note" style={{ width: 48, padding: 0, flex: "none" }}>
          {savingQuick ? <Spinner size={16} /> : <IcPlus size={19} />}
        </Button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        {notes === null && !err && !loadErr ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
            <div className="sk" style={{ height: 44, borderRadius: 12 }} />
            <div className="sk" style={{ height: 44, borderRadius: 12 }} />
            <div className="sk" style={{ height: 44, borderRadius: 12 }} />
          </div>
        ) : (err || loadErr) ? (
          <div style={{ background: "var(--surface-2)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", minHeight: 52, marginTop: 4 }}>
            <Dot tone="var(--red)" />
            <span className="t-foot" style={{ flex: 1, minWidth: 0 }}>{err || loadErr}</span>
            <Button kind="quiet" size="sm" style={{ height: 44, flex: "none" }}
              onClick={() => { setErr(null); queryClient.invalidateQueries({ queryKey: ["notes"] }); }}>Retry</Button>
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState icon={<IcNote size={26} />} title="A blank ledger"
            sub="Whatever's circling your head — file it above and clear the desk."
            style={{ padding: "22px 12px" }} />
        ) : (
          <>
            {visible.map((n, i) => editing?.id === n.id ? (
              <div key={n.id} style={{ background: "var(--surface-2)", borderRadius: 12, padding: 12, margin: "6px 0", display: "flex", flexDirection: "column", gap: 8 }}>
                <Field className="on-well" value={editing.title} onChange={e => setEditing(ed => ({ ...ed, title: e.target.value }))}
                  placeholder="Title (optional)" style={{ fontWeight: 600 }} />
                {/* raw textarea (kit class): React 18 function components don't
                    forward refs, and the caret restore + bullet toggle need one */}
                <textarea ref={editBodyRef} className="field on-well" value={editing.body} autoFocus rows={4}
                  onChange={e => setEditing(ed => ({ ...ed, body: e.target.value }))}
                  onKeyDown={e => continueListOnEnter(e, editing.body, applyEditBody)}
                  style={{ resize: "vertical", lineHeight: 1.55 }} />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button kind="quiet" title="Bullet list" style={{ padding: "0 12px", flex: "none" }}
                    onClick={() => { toggleBulletAtCaret(editBodyRef.current, editing.body, applyEditBody); editBodyRef.current?.focus(); }}>• List</Button>
                  <Button kind="tinted" disabled={savingEdit} onClick={saveEdit} style={{ flex: 1, minWidth: 88 }}>{savingEdit ? "Saving…" : "Save"}</Button>
                  <Button kind="quiet" onClick={() => setEditing(null)} style={{ padding: "0 13px", flex: "none" }}>Cancel</Button>
                  <Button kind="plain" onClick={() => onOpenNotes?.(n.id)} style={{ padding: "0 10px", flex: "none" }}>Open <IcChevronRight size={12} /></Button>
                </div>
              </div>
            ) : (
              <div key={n.id} onClick={() => setEditing({ id: n.id, title: n.title || "", body: n.body || "" })}
                className="press hoverable" role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing({ id: n.id, title: n.title || "", body: n.body || "" }); } }}
                style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 2px", minHeight: 44, borderTop: i === 0 ? "none" : "0.5px solid var(--line)", cursor: "pointer", borderRadius: 6 }}>
                <span style={{ flex: "none", display: "inline-flex", paddingTop: 6 }}>
                  <Dot tone={sealColor(n.color) || "var(--ink-a18)"} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="t-call" style={{ display: "block", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{headline(n)}</span>
                  {snippet(n) && <NoteCardPreview text={snippet(n)} maxHeight={60} fadePx={16} style={{ marginTop: 1 }} />}
                </div>
                {n.pinned && <span title="Pinned" style={{ color: "var(--faint)", flex: "none", display: "inline-flex", paddingTop: 3 }}><IcPin size={13} /></span>}
                <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none", paddingTop: 3 }}>{relTime(n.updated_at)}</span>
              </div>
            ))}
            {sorted.length > LIST_CAP && (
              <Button kind="plain" full onClick={() => setShowAll(v => !v)} style={{ marginTop: 2 }}>
                {showAll ? "Show fewer" : `Show all ${sorted.length}`}
              </Button>
            )}
          </>
        )}
      </div>
    </CollapsibleCard>
  );
}
