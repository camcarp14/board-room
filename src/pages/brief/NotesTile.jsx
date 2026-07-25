// ─── Notes tile — the Docket's quiet companion on the Brief ──────────────────
// Same personal_notes table the Notes tab owns: recent notes at a glance,
// one-line capture, tap any note to edit it in place, or jump to the full tab.
import { useState, useRef } from "react";
import { CollapsibleCard, Button, Field, Spinner, EmptyState, Dot, useConfirm } from "../../ui/kit.jsx";
import { IcNote, IcPin, IcPlus, IcChevronRight, IcTrash } from "../../ui/icons.jsx";
import { NoteCardPreview, sealColor, continueListOnEnter, toggleBulletAtCaret } from "../../ui/shared.jsx";
import { queryClient } from "../../lib/queryClient.js";
import { useNotes } from "../../data/notes.js";
import { db } from "../../data/db.js";

const LIST_CAP = 5; // first N notes in-page; the rest behind "Show all" (no nested scroll)
// Preview depth: NoteCardPreview renders at 13px / 1.5 line-height ≈ 19.5px a
// line, so five rows of text is ~98px before the fade takes over. Most quick
// captures are a few lines — three rows cut them off just as they got going.
const PREVIEW_ROWS = 5;
const PREVIEW_MAX_H = Math.round(PREVIEW_ROWS * 13 * 1.5);

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
  const [confirmEl, confirm] = useConfirm();
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
    } catch (e) { setErr(humanErr(e, "Couldn't save that.")); }
    setSavingQuick(false);
  };
  const saveEdit = async () => {
    if (savingEdit || !editing) return;
    setSavingEdit(true);
    try {
      const saved = await db.saveNote({ id: editing.id, title: editing.title, body: editing.body });
      setNotes(prev => (prev || []).map(n => (n.id === saved.id ? saved : n)));
      setEditing(null);
    } catch (e) { setErr(humanErr(e, "Couldn't save that.")); }
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
  // A headline ONLY when the note actually has a title. Promoting the first body
  // line into a bold nowrap headline was wrong for the way notes get made here:
  // quick capture files everything title-less, so every jotted thought had its
  // opening line shouted and truncated with an ellipsis while the rest sat below
  // it in small grey text. Untitled notes are now just their text.
  const headline = (n) => (n.title || "").trim() || null;
  // Which means the preview shows the WHOLE body for untitled notes — no line
  // skipped, because no line was stolen for a headline.
  const snippet = (n) => (n.body || "").trim();

  // "TypeError: Failed to fetch" is what a dead connection looks like coming out
  // of supabase-js, and it's not a sentence anyone should have to read.
  const humanErr = (e, fallback) =>
    /failed to fetch|networkerror|load failed|network request failed/i.test(e?.message || "")
      ? "You're offline — that didn't save."
      : (e?.message || fallback);

  const requestDelete = async (n) => {
    const label = (n.title || "").trim() || (n.body || "").trim().split("\n")[0].slice(0, 80) || "this note";
    const ok = await confirm({ title: "Delete this note?", message: label, confirmLabel: "Delete", destructive: true });
    if (!ok) return;
    const prev = notes;
    // Optimistic: the row goes now, and comes back if the delete actually fails.
    setNotes(p => (p || []).filter(x => x.id !== n.id));
    setEditing(null);
    try { await db.deleteNote(n.id); }
    catch (e) { setNotes(prev); setErr(humanErr(e, "Couldn't delete that.")); }
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
        {/* A failed save or delete is a BANNER, not a replacement. It used to take
            over the whole card — so a delete that didn't reach Supabase left you
            staring at "TypeError: Failed to fetch" where all your notes had been,
            which reads like they're gone. They never were: the optimistic row is
            rolled back and the list below is intact. Only a failure to LOAD
            replaces the list, because then there's genuinely nothing to show. */}
        {err && (
          <div style={{ background: "var(--surface-2)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", minHeight: 48, margin: "4px 0 2px" }}>
            <Dot tone="var(--red)" />
            <span className="t-foot" style={{ flex: 1, minWidth: 0 }}>{err}</span>
            <Button kind="quiet" size="sm" style={{ height: 40, flex: "none" }}
              onClick={() => { setErr(null); queryClient.invalidateQueries({ queryKey: ["notes"] }); }}>Dismiss</Button>
          </div>
        )}
        {notes === null && !loadErr ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
            <div className="sk" style={{ height: 44, borderRadius: 12 }} />
            <div className="sk" style={{ height: 44, borderRadius: 12 }} />
            <div className="sk" style={{ height: 44, borderRadius: 12 }} />
          </div>
        ) : loadErr ? (
          <div style={{ background: "var(--surface-2)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", minHeight: 52, marginTop: 4 }}>
            <Dot tone="var(--red)" />
            <span className="t-foot" style={{ flex: 1, minWidth: 0 }}>{loadErr}</span>
            <Button kind="quiet" size="sm" style={{ height: 44, flex: "none" }}
              onClick={() => queryClient.invalidateQueries({ queryKey: ["notes"] })}>Retry</Button>
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
                  {/* Destructive, so it sits last and asks first. Deleting from the
                      Brief used to mean a trip to the Notes tab. */}
                  <Button kind="danger" onClick={() => requestDelete(n)} aria-label="Delete note" title="Delete note"
                    style={{ padding: "0 13px", flex: "none" }}>
                    <IcTrash size={15} />
                  </Button>
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
                  {headline(n) && (
                    <span className="t-call" style={{ display: "block", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{headline(n)}</span>
                  )}
                  {/* Untitled notes carry the row on their own, so their text reads
                      in ink; under a title the body is supporting detail and stays
                      quiet. Either way it gets PREVIEW_ROWS lines before the fade. */}
                  {snippet(n) && (
                    <NoteCardPreview
                      text={snippet(n)}
                      maxHeight={PREVIEW_MAX_H}
                      fadePx={20}
                      color={headline(n) ? "var(--sub)" : "var(--ink)"}
                      style={{ marginTop: headline(n) ? 1 : 0 }}
                    />
                  )}
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
      {confirmEl}
    </CollapsibleCard>
  );
}
