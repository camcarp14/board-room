// ─── Notes — quick capture, search, pins, color seals, select mode ────────────
// Bulk pin/seal/merge/delete live behind a select mode whose actions open a
// bottom sheet. Deletes and merges are undoable for a few seconds (the toast
// re-upserts the cached rows). Works on the pre-upgrade schema too: pins/seals
// hide behind a one-line SQL banner until the columns are added.

import { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { db } from "../../data/db.js";
import { SortableList } from "../../ui/SortableList.jsx";
import { applyNotesOrder, orderOf, bumpToFront } from "../../lib/notes-order.js";
import { queryClient } from "../../lib/queryClient.js";
import { useNotes } from "../../data/notes.js";
import { NOTE_SEALS, sealColor, NoteCardPreview, continueListOnEnter, toggleBulletAtCaret } from "../../ui/shared.jsx";
import { Card, SectionHeader, Button, Cell, Sheet, useConfirm, EmptyState, Dot, Pill } from "../../ui/kit.jsx";
import { IcPin, IcTrash, IcCheck, IcNote, IcChevronLeft, IcSend, IcSeal, IcPlus, IcArchive, IcUnarchive, IcRefresh, IcUndo, IcRedo, IcEye, IcEyeOff } from "../../ui/icons.jsx";
import { createTextHistory } from "../../lib/text-history.js";
import { panelNotes, noteTint, deletedNotes, briefHiddenNotes, isBriefHidden, daysLeft, PURGE_AFTER_DAYS, TINT_PCT_STRONG } from "../../lib/notes-shelf.js";

// The watch/Siri setup sheet is read once and then never again, and NotesPanel
// deliberately rides in the first-paint chunk (see PersonalPage's import
// comment) — so it splits out rather than riding along.
const CaptureSheet = lazy(() => import("./CaptureSheet.jsx"));

// Copy-pasted by the user into Supabase → SQL Editor — exact text matters.
// FIVE COLUMNS, THREE UPGRADES, ONE PASTE. pinned/color are 0008's pair; archived
// and deleted_at are 0036's; brief_hidden is 0042's. They are offered together
// because the banner that
// shows this can only ever say one thing, and a reader who has run half of it
// should be able to run the whole thing again without thinking — every statement
// is `if not exists`, so a second paste is a no-op rather than an error.
export const NOTES_UPGRADE_SQL = `-- Notes upgrade — seals, the shelf, the bin and the Brief switch (safe to re-run)
alter table boardroom.personal_notes add column if not exists pinned boolean not null default false;
alter table boardroom.personal_notes add column if not exists color text;
alter table boardroom.personal_notes add column if not exists archived boolean not null default false;
alter table boardroom.personal_notes add column if not exists deleted_at timestamptz;
alter table boardroom.personal_notes add column if not exists brief_hidden boolean not null default false;`;
// It said `alter table public.personal_notes` — a table the app does not read.
// So the upgrade appeared to succeed, nothing changed, and this banner stayed on
// screen for good. Authoritative shape: supabase/migrations/0008_personal_notes.sql.

/**
 * The reordered ids, followed by everything the drag could not see.
 *
 * SortableList only ever knows about the rows on screen, and both note surfaces
 * hand it a SLICE — the Brief shows the newest few, the Notes panel filters by
 * search and by seal. Persisting that slice as the whole order meant a single
 * drag on the Brief wrote a five-id notes_order, and applyNotesOrder puts
 * anything unlisted AFTER the listed ids — so the five newest notes were
 * buried at the bottom of both surfaces by one drag on a card. With a search
 * active in the panel it was worse: every note not matching the query went to
 * the end.
 *
 * The reorder is authoritative for the rows it covers; the rest keep the
 * sequence they already had.
 */
// The panel cannot import db.js's isMissingShelf (it is module-private there),
// and it only needs the answer for one sentence of copy — so it asks the same
// question in the one place it matters rather than exporting machinery.
const isMissingShelfError = (e) =>
  /42703|PGRST204/.test(e?.code || "") || /archived|deleted_at|brief_hidden/i.test(e?.message || "");

function mergeOrder(ids, full) {
  const seen = new Set(ids);
  return [...ids, ...orderOf(full || []).filter((id) => !seen.has(id))];
}

export function NotesPanel({ isMobile, openSignal, settings, updateSetting }) {
  const { data: notesData, error: notesErr } = useNotes();
  const notes = notesData?.rows ?? null; // null = loading
  const legacy = notesData?.legacy ?? false; // true until pinned/color columns exist
  // Whether 0042's brief_hidden is in the database. Its own flag rather than a
  // third `legacy` value, because legacy gates pins, seals, archiving and the
  // bin — and a database on 0036 has all four. Only the Brief switch is missing.
  const canHide = notesData?.briefHidden ?? false;
  // …and the whole cache entry is carried forward on every optimistic write, or
  // the first local edit would drop `briefHidden` and the toggle would vanish
  // mid-session with nothing having changed in the database.
  const setNotes = (u) => queryClient.setQueryData(["notes"], (old) => ({ ...(old || {}), rows: (typeof u === "function" ? u(old?.rows ?? null) : u) ?? [], legacy: old?.legacy ?? false }));
  const loadErr = notesErr ? (notesErr.message || "Couldn't load notes.") : null;
  const [activeId, setActiveId] = useState(null);
  const [draft, setDraft] = useState({ title: "", body: "", pinned: false, color: null });
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [quick, setQuick] = useState("");
  const [query, setQuery] = useState("");
  const [sealFilter, setSealFilter] = useState(null); // null = all, "none" = unsealed, or a seal key
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [actionsOpen, setActionsOpen] = useState(false); // select-mode action sheet
  const [undo, setUndo] = useState(null); // { label, rows, extraDeleteId?, soft?, rewrite? }
  const [shelf, setShelf] = useState("active"); // active | archived — which shelf the list shows
  // A filter over the active shelf, NOT a third shelf: hidden notes live on the
  // active shelf with everything else and this only narrows the view to them.
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const [binOpen, setBinOpen] = useState(false); // the Recently deleted sheet
  const [bin, setBin] = useState(null);          // null = not loaded / loading
  const [binBusy, setBinBusy] = useState(false);
  const [oops, setOops] = useState(null); // transient error toast (replaces alert())
  const [copied, setCopied] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [confirmEl, confirm] = useConfirm();
  const saveTimer = useRef(null);
  const undoTimer = useRef(null);
  const oopsTimer = useRef(null);
  const skipNextAutosave = useRef(false);
  const editorBodyRef = useRef(null);
  // ─── the editor's own undo ─────────────────────────────────────────────────
  // The browser's is not available here — the field is controlled, and the bullet
  // helpers rewrite the value and move the caret, which clears the native stack in
  // every engine. On the phone there is no ⌘Z to fall back to either. The long
  // version is at the top of src/lib/text-history.js.
  //
  // ONE FUNNEL. Every edit to the draft's TEXT goes through editText, so there is
  // no route that changes the words without the history seeing it — a keystroke, a
  // bullet toggle, a list continuation, the title field. The two non-text fields
  // (pinned, color) deliberately do NOT: undoing a seal is not what ⌘Z means, and
  // mixing them in would make an undo after typing silently change the colour.
  const historyRef = useRef(null);
  if (!historyRef.current) historyRef.current = createTextHistory({ title: "", body: "" });
  const [histAt, setHistAt] = useState(0); // bumped so the buttons re-render enabled/disabled
  //
  // The push happens OUTSIDE the setDraft updater, reading `draft` from this
  // render's closure. Inside, it would be a side effect in a reducer — React
  // calls updaters twice under StrictMode, so every keystroke would push two
  // entries in development and one in production, and the coalescing rules would
  // be tuned against behaviour that only happens on the owner's machine. Every
  // caller here is an event handler, so `draft` is the value on screen.
  const editText = (next, field, caret) => {
    const merged = { ...draft, ...next };
    historyRef.current.push({ title: merged.title, body: merged.body }, { field, caret });
    setDraft(merged);
    setHistAt(n => n + 1);
  };
  // Put a history entry back on screen, caret included. `skipNextAutosave` is NOT
  // set: an undo changes the words, and the words are what autosave exists to
  // persist — leaving the restored text unsaved would make undo look like it
  // worked until the next reload took it away again.
  const applyHistory = (entry) => {
    if (!entry) return;
    setDraft(d => ({ ...d, title: entry.title, body: entry.body }));
    setHistAt(n => n + 1);
    if (entry.field === "body") {
      requestAnimationFrame(() => {
        const el = editorBodyRef.current;
        if (!el) return;
        el.focus();
        try { el.setSelectionRange(entry.caret, entry.caret); } catch {}
      });
    }
  };
  const undoText = () => applyHistory(historyRef.current.undo());
  const redoText = () => applyHistory(historyRef.current.redo());
  const applyEditorBody = (next, caret) => {
    editText({ body: next }, "body", caret);
    // restore the caret after React re-renders (needed after programmatic mutation)
    requestAnimationFrame(() => { try { editorBodyRef.current?.setSelectionRange(caret, caret); } catch {} });
  };
  const quickRef = useRef(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["notes"] });

  // ─── what the editor knows about the server, and the one road to it ────────
  // baseRef is the note as the server last held it, as far as this editor knows:
  // { id, title, body, pinned, color, updated_at }. Every save is conditional on
  // it (db.saveNote's `base`), which is what stops an old draft landing on top of
  // words that arrived from the Watch or another device while it sat open.
  //
  // saveChain puts every write from this editor in single file. The autosave, a
  // flush on close, a flush on hide and a flush on unmount can all be in flight
  // at once on a slow link, and two conditional writes racing from one editor
  // would each see the other's stamp and call it a conflict. In a line, each one
  // reads the base the previous one left behind.
  //
  // redirectRef follows a note to its conflicted copy: a save already queued for
  // the original, when the copy was made, must land on the copy, never go back
  // and overwrite the version somebody else wrote.
  const baseRef = useRef(null);
  // Bumped on every edit. A save that finishes may only paint "Saved" if nothing
  // was typed after it started — otherwise a slow earlier save would stamp
  // "Saved" over newer, unsent words, and closing the editor (which trusts that
  // state) would skip them.
  const editSeq = useRef(0);
  const settle = (seq, state) => { if (editSeq.current === seq) setSaveState(state); };
  const saveChain = useRef(Promise.resolve());
  const redirectRef = useRef(new Map());
  const noteBase = (n) => (n ? { id: n.id, title: n.title || "", body: n.body || "", pinned: !!n.pinned, color: n.color || null, updated_at: n.updated_at || null } : null);
  const persist = (row) => {
    const run = async () => {
      const target = redirectRef.current.get(row.id) || row.id;
      const r = { ...row, id: target };
      const base = baseRef.current?.id === target ? baseRef.current : null;
      const saved = await db.saveNote(r, { base });
      if (saved.conflict) {
        redirectRef.current.set(saved.conflict.originalId, saved.id);
        baseRef.current = noteBase(saved);
        // The editor moves onto the copy; the effect must not read the id change
        // as a fresh edit and fire a save of its own.
        skipNextAutosave.current = true;
        setActiveId((cur) => (cur === saved.conflict.originalId ? saved.id : cur));
        complain(saved.conflict.reason === "deleted"
          ? "That note was deleted on another device — your text was saved as a new note."
          : "That note changed on another device (a Watch dictation?) — your version was saved as a separate copy, so neither is lost.");
      } else {
        baseRef.current = noteBase(saved);
      }
      clearRescue(row);
      return saved;
    };
    const p = saveChain.current.then(run, run);
    saveChain.current = p.catch(() => {});
    return p;
  };

  // ─── the rescue copy ─────────────────────────────────────────────────────
  // Every unsaved draft is also written to this device the moment it changes,
  // and cleared once the server has it. It is what survives the cases no flush
  // can: the PWA killed mid-save, a tab switch inside the 800 ms autosave window
  // on a dead link, a reload from a new service worker. The next time this panel
  // mounts it reopens the draft and saves it — conditionally, so a rescue can
  // never overwrite newer words either.
  const RESCUE_KEY = "br_note_rescue";
  const writeRescue = (row) => {
    try { localStorage.setItem(RESCUE_KEY, JSON.stringify({ row, base: baseRef.current, at: Date.now() })); } catch {}
  };
  const clearRescue = (row) => {
    try {
      const r = JSON.parse(localStorage.getItem(RESCUE_KEY) || "null");
      if (r && r.row?.id === row.id && r.row?.body === row.body && r.row?.title === row.title) localStorage.removeItem(RESCUE_KEY);
    } catch {}
  };

  // The latest editor state, for the two exits that happen outside a render:
  // unmount (tab switch, pill switch) and the page being hidden.
  const latestRef = useRef(null);
  const dirtyRow = () => {
    const l = latestRef.current;
    if (!l?.activeId || (l.saveState !== "saving" && l.saveState !== "error")) return null;
    if (!l.draft.title.trim() && !l.draft.body.trim()) return null;
    return { id: l.activeId, title: l.draft.title, body: l.draft.body, ...(l.legacy ? {} : { pinned: l.draft.pinned, color: l.draft.color }) };
  };
  useEffect(() => {
    // Hidden = the app is being switched away from, locked, or reloaded. Send
    // the draft now instead of trusting the 800 ms timer to still exist.
    const onHide = () => {
      if (!document.hidden) return;
      const row = dirtyRow();
      if (!row) return;
      clearTimeout(saveTimer.current);
      const seq = editSeq.current;
      persist(row).then(() => settle(seq, "saved"), () => settle(seq, "error"));
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      clearTimeout(saveTimer.current); clearTimeout(undoTimer.current); clearTimeout(oopsTimer.current);
      // UNMOUNT USED TO CLEAR THE TIMER AND NOTHING ELSE, so a line typed less
      // than 800 ms before switching tab was simply never sent. Send it; the
      // rescue copy already holds it if this fails too.
      const row = dirtyRow();
      if (row) persist(row).catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reopen a draft that never reached the server (see the rescue copy above).
  useEffect(() => {
    let r = null;
    try { r = JSON.parse(localStorage.getItem(RESCUE_KEY) || "null"); } catch {}
    if (!r?.row?.id || !(r.row.title || r.row.body)) return;
    if (Date.now() - (r.at || 0) > 14 * 86400000) { try { localStorage.removeItem(RESCUE_KEY); } catch {} return; }
    baseRef.current = r.base && r.base.id === r.row.id ? r.base : null;
    setActiveId(r.row.id);
    setDraft({ title: r.row.title || "", body: r.row.body || "", pinned: !!r.row.pinned, color: r.row.color || null });
    historyRef.current.reset({ title: r.row.title || "", body: r.row.body || "" });
    setHistAt(0);
    complain("Recovered a note that hadn't finished saving — saving it now.");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const complain = (msg) => {
    clearTimeout(oopsTimer.current);
    setOops(msg);
    oopsTimer.current = setTimeout(() => setOops(null), 4000);
  };

  // Summon jump → open the named note as soon as it's in hand (consume once)
  const consumedSignal = useRef(null);
  useEffect(() => {
    if (!openSignal || !notes || consumedSignal.current === openSignal.t) return;
    const n = notes.find(x => x.id === openSignal.id);
    if (!n) return;
    consumedSignal.current = openSignal.t;
    openNote(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal?.t, notes]);

  // ─── derived ───
  const firstLine = (body) => (body || "").split("\n").map(l => l.trim()).find(Boolean) || "";
  const displayTitle = (n) => n.title?.trim() || firstLine(n.body).slice(0, 64) || "Untitled note";
  const snippet = (n) => {
    const body = n.body || "";
    if (n.title?.trim()) return body.trim();
    // No explicit title → the first non-empty line becomes the title; drop just that line
    // so it isn't repeated, and keep every other newline intact for the preview.
    const lines = body.split("\n");
    const firstIdx = lines.findIndex(l => l.trim());
    return firstIdx === -1 ? "" : lines.slice(firstIdx + 1).join("\n").trim();
  };
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  // Manual order lives in app_settings.notes_order (see lib/notes-order.js) — no
  // migration, and it syncs across devices. Hold a note and drag to set it.
  const noteOrder = settings?.notes_order || null;
  const saveOrder = (ids) => updateSetting?.("notes_order", ids);
  const sorted = useMemo(() => (notes ? applyNotesOrder(notes, noteOrder) : null), [notes, noteOrder]);
  // THE SHELF FILTER COMES FIRST, and search/seal compose on top of it — so
  // searching while on Archived searches the archived notes rather than quietly
  // pulling active ones back into view. `sorted` stays the WHOLE list because
  // mergeOrder below needs it (see that function's note): narrowing it here
  // would drop every archived note to the bottom of the order on the next drag.
  const visible = useMemo(() => {
    if (!sorted) return null;
    const q = query.trim().toLowerCase();
    return panelNotes(sorted, shelf).filter(n =>
      (!q || `${n.title || ""} ${n.body || ""}`.toLowerCase().includes(q)) &&
      (!hiddenOnly || shelf !== "active" || isBriefHidden(n)) &&
      (sealFilter === null || (sealFilter === "none" ? !n.color : n.color === sealFilter)));
  }, [sorted, query, sealFilter, shelf, hiddenOnly]);
  const archivedCount = useMemo(() => panelNotes(notes || [], "archived").length, [notes]);
  const hiddenCount = useMemo(() => briefHiddenNotes(notes || []).length, [notes]);
  const activeCount = useMemo(() => panelNotes(notes || [], "active").length, [notes]);
  const usedSeals = useMemo(() => NOTE_SEALS.filter(s => (notes || []).some(n => n.color === s.key)), [notes]);
  const selectedNotes = (notes || []).filter(n => selected.has(n.id));

  // ─── the bin ───────────────────────────────────────────────────────────────
  // Read on demand rather than with the notes: an ordinary launch never pays for
  // rows nobody is looking at, and the sheet is the only thing that asks. Kept in
  // component state rather than the query cache because nothing else reads it and
  // a second cache key would be a second thing to invalidate correctly.
  const loadBin = async () => {
    setBinBusy(true);
    try { setBin(await db.loadDeletedNotes()); }
    catch (e) { setBin([]); complain(e.message || "Couldn't read recently deleted."); }
    finally { setBinBusy(false); }
  };
  const openBin = () => { setBinOpen(true); loadBin(); };

  // Restore, from the bin sheet or from the header's Undo. Clearing deleted_at is
  // the whole act — `archived` was never touched by the delete, so a note that was
  // archived when it went in comes back archived.
  const restoreFromBin = async (ids) => {
    if (!ids.length) return;
    setBinBusy(true);
    try {
      await db.undeleteNotes(ids);
      setBin((b) => (b || []).filter((n) => !ids.includes(n.id)));
      refresh();
    } catch (e) { complain(e.message || "Couldn't restore."); }
    finally { setBinBusy(false); }
  };
  const purgeFromBin = async (ids, label) => {
    if (!ids.length) return;
    if (!(await confirm({
      title: label, destructive: true, confirmLabel: "Delete forever",
      message: "This cannot be undone — it is the one action in Notes that has no way back.",
    }))) return;
    setBinBusy(true);
    try { await db.purgeNotes(ids); setBin((b) => (b || []).filter((n) => !ids.includes(n.id))); }
    catch (e) { complain(e.message || "Couldn't delete."); }
    finally { setBinBusy(false); }
  };

  // ─── undo plumbing ───
  // THE TOAST IS NO LONGER THE ONLY UNDO, which changes what it is for. It used
  // to be the whole safety net: a hard DELETE had already removed the rows, and
  // this held the last copy of them in memory for six seconds. Miss it, or
  // reload, and the note was gone from every device with no copy anywhere.
  //
  // With 0036 the delete is a stamp, so the note is still in the table and the
  // header's Undo and the Recently deleted sheet can both reach it for thirty
  // days. The toast stays because immediate feedback is worth having — it just no
  // longer carries the only rope. `soft` records which regime the delete actually
  // ran under, because the fallback path (0036 not pasted in yet) is still the
  // old one and its undo still has to re-upsert from memory.
  //
  // `rewrite` is for rows that were OVERWRITTEN rather than deleted — the target
  // of a merge. There is no stamp to clear on it, and the only copy of its old
  // body is the one this tab kept, so it is re-upserted whichever regime the
  // delete ran under.
  const armUndo = (label, rows, { extraDeleteId = null, soft = true, rewrite = [] } = {}) => {
    clearTimeout(undoTimer.current);
    setUndo({ label, rows, extraDeleteId, soft, rewrite });
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  };
  const runUndo = async () => {
    const u = undo; setUndo(null); clearTimeout(undoTimer.current);
    if (!u) return;
    try {
      if (u.extraDeleteId) await db.deleteNotes([u.extraDeleteId]);
      // A soft delete is undone by clearing the stamp on rows that never left,
      // which also means the undo works from a device that never held them.
      // Re-upserting would work too and is strictly worse: it writes the whole
      // row back from this tab's copy, so anything another device changed in
      // between is overwritten.
      if (u.soft) await db.undeleteNotes(u.rows.map((n) => n.id));
      else await db.restoreNotes(u.rows);
      if (u.rewrite?.length) await db.restoreNotes(u.rewrite);
      setBin(null); // whatever it held is stale now; the sheet re-reads on open
      refresh();
    } catch (e) { complain(e.message || "Couldn't undo."); }
  };

  // ─── quick capture — Enter saves and keeps focus for the next one; ⇧Enter
  // opens the full editor pre-filled with the text ───
  const quickAdd = async (openEditor = false) => {
    const t = quick.trim();
    if (!t) return;
    const id = crypto.randomUUID();
    if (openEditor) {
      setQuick("");
      // NO SUPPRESSOR HERE. This branch is the ⇧Enter path: it hands real typed
      // text straight into the editor. Both setState calls batch into one
      // render, so the autosave effect fires exactly once — and arming the
      // suppressor ate that one firing, leaving the text alive only in React
      // state. Close the editor without typing another character and it was
      // gone, with the quick-add box already cleared.
      //
      // The other two suppressor sites keep it and should: openNote loads a
      // note that is already saved, and newNote opens an empty draft that the
      // effect's own empty check skips anyway. This one carries content, which
      // is exactly the case that must not be skipped.
      baseRef.current = null;
      setActiveId(id);
      setDraft({ title: "", body: t, pinned: false, color: null });
      // Seed the undo stack here too. This path opens the editor with content
      // already in it, and without a reset the history would still be holding
      // whichever note was open last — so the first ⌘Z would paint a DIFFERENT
      // note's words over this one. Seeded with the captured text, so undo starts
      // from where this editing session started, the same rule openNote follows.
      historyRef.current.reset({ title: "", body: t });
      setHistAt(0);
      return;
    }
    setQuick("");
    // optimistic: fake row at the top, rolled back on failure
    const optimistic = { id, title: "", body: t, pinned: false, color: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    setNotes(list => [optimistic, ...(list || [])]);
    try { await db.saveNote({ id, title: "", body: t }); refresh(); }
    catch (e) {
      setNotes(list => (list || []).filter(n => n.id !== id));
      // THE WORDS GO BACK IN THE BOX. The box was cleared before the save so the
      // next capture could start at once, which left a failed save nowhere to
      // put what you typed but a four-second toast. Only if the box is still
      // empty — anything typed since is newer and must not be replaced.
      setQuick(q => (q ? q : t));
      complain(`${e.message || "Couldn't save."} Your text is back in the box.`);
    }
    quickRef.current?.focus();
  };

  // ─── editor open/close ───
  const openNote = (n) => {
    skipNextAutosave.current = true;
    editSeq.current++;
    baseRef.current = noteBase(n);
    setActiveId(n.id);
    setDraft({ title: n.title || "", body: n.body || "", pinned: !!n.pinned, color: n.color || null });
    // Seeded with what is SAVED, so the earliest thing undo can reach is the note
    // as it was when you opened it — never a previous note's words, which is what
    // a stack carried across opens would eventually paint.
    historyRef.current.reset({ title: n.title || "", body: n.body || "" });
    setHistAt(0);
    setSaveState("idle");
  };
  const newNote = () => {
    skipNextAutosave.current = true;
    editSeq.current++;
    baseRef.current = null;
    setActiveId(crypto.randomUUID());
    setDraft({ title: "", body: "", pinned: false, color: null });
    historyRef.current.reset({ title: "", body: "" });
    setHistAt(0);
    setSaveState("idle");
  };
  // UNSAVED MEANS "saving" OR "error". This used to flush only on "saving", so
  // after an autosave had failed and the header said "Not saved", closing the
  // editor sent nothing at all and reset the draft — a new note vanished and an
  // edited one reverted, with the warning on screen the moment before.
  // Resolves true when there is nothing left to save.
  const flushSave = async () => {
    if (!activeId) return true;
    clearTimeout(saveTimer.current);
    if (saveState !== "saving" && saveState !== "error") return true;
    if (!draft.title.trim() && !draft.body.trim()) return true;
    setSaveState("saving");
    const seq = editSeq.current;
    try { await persist(noteRow()); settle(seq, "saved"); refresh(); return true; }
    catch { settle(seq, "error"); return false; }
  };
  // The editor stays open when the last save cannot be made: closing it is the
  // one action that would take the words off the screen. They are also in the
  // rescue copy, so leaving the tab instead does not lose them either.
  const closeEditor = async () => {
    const ok = await flushSave();
    if (!ok) { complain("Couldn't save this note — it's still here. Check your connection and try again."); return; }
    setActiveId(null);
    setDraft({ title: "", body: "", pinned: false, color: null });
  };
  // pinned/color are spread ONLY when the schema has them — sending those fields
  // to a pre-upgrade table would error
  const noteRow = () => ({ id: activeId, title: draft.title, body: draft.body, ...(legacy ? {} : { pinned: draft.pinned, color: draft.color }) });
  latestRef.current = { activeId, draft, saveState, legacy };

  // autosave — 800ms after typing stops, only once there's something to save
  useEffect(() => {
    if (!activeId) return;
    if (skipNextAutosave.current) { skipNextAutosave.current = false; return; }
    if (!draft.title.trim() && !draft.body.trim()) return;
    setSaveState("saving");
    const seq = ++editSeq.current;
    const row = noteRow();
    writeRescue(row);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      persist(row)
        .then(() => { settle(seq, "saved"); refresh(); })
        .catch(() => settle(seq, "error"));
    }, 800);
    return () => clearTimeout(saveTimer.current);
  }, [draft, activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeId) return;
    const onKey = (e) => {
      // a confirm/action sheet is up — Escape belongs to it, not the editor
      if (document.querySelector(".sheet-scrim")) return;
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) { closeEditor(); return; }
      // ⌘Z / ⌃Z, and ⇧⌘Z or ⌃Y to redo. preventDefault is not optional: without
      // it the browser ALSO runs its own undo against whatever is left of the
      // native stack, and the two disagree — you get our step plus a stray
      // character the engine still remembered, which is worse than either alone.
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undoText(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redoText(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, draft, saveState, histAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── single + bulk operations ───
  // The message tells the truth about which undo you are getting, and it can
  // differ per database: before 0036 it really is a few seconds, after it is
  // thirty days. Reading it off `legacy` rather than hard-coding the optimistic
  // sentence is the difference between a promise and a guess.
  const undoPromise = () => (legacy === true || legacy === "shelf"
    ? "You can undo for a few seconds."
    : `Deleted notes are kept for ${PURGE_AFTER_DAYS} days — Undo, or find it under Recently deleted.`);
  const deleteOne = async (n) => {
    if (!(await confirm({ title: "Delete this note?", message: undoPromise(), confirmLabel: "Delete", destructive: true }))) return;
    try {
      const { soft } = await db.deleteNotes([n.id]);
      if (activeId === n.id) { setActiveId(null); setDraft({ title: "", body: "", pinned: false, color: null }); }
      armUndo("Note deleted", [n], { soft });
      setBin(null);
      refresh();
    } catch (e) { complain(e.message || "Couldn't delete."); }
  };
  const clearSelection = () => { setSelected(new Set()); setSelectMode(false); setActionsOpen(false); };
  const toggleSelected = (id) => setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const bulkDelete = async () => {
    if (!selected.size || !(await confirm({ title: `Delete ${selected.size} note${selected.size > 1 ? "s" : ""}?`, message: undoPromise(), confirmLabel: "Delete", destructive: true }))) return;
    const rows = selectedNotes;
    try {
      const { soft } = await db.deleteNotes([...selected]);
      armUndo(`${rows.length} deleted`, rows, { soft });
      setBin(null);
      clearSelection(); refresh();
    } catch (e) { complain(e.message || "Couldn't delete."); }
  };
  // "PIN TO TOP" HAS TO MOVE THE NOTE. Manual order is absolute (see
  // applyNotesOrder), so the flag alone draws a hairline and changes nothing
  // about position — the button said "to top" and the note stayed put. Pinning
  // writes the order: the note goes first, the rest keep their sequence.
  // Unpinning leaves the order alone; where it sits is now the user's call.
  const pinToTop = (ids) => {
    if (!ids.length) return;
    let order = orderOf(sorted || []);
    for (const id of [...ids].reverse()) order = bumpToFront(order, id); // keep their relative order
    saveOrder(order);
  };
  const bulkPin = async () => {
    const pin = !selectedNotes.every(n => n.pinned);
    try {
      await db.bulkUpdateNotes([...selected], { pinned: pin });
      if (pin) pinToTop((sorted || []).filter(n => selected.has(n.id)).map(n => n.id));
      clearSelection(); refresh();
    }
    catch (e) { complain(e.message || "Couldn't update."); }
  };
  // ARCHIVE IS NOT A DELETE AND IS NOT UNDONE BY ONE. It takes the note off the
  // Brief and out of the default list and changes nothing else — the words, the
  // seal, the pin and the manual order all survive, and un-archiving puts it back
  // exactly where it was. That is why it needs no confirm and no toast: nothing
  // is at risk, and the note is one tap away under Archived.
  // This device just moved these notes' updated_at. If one of them is open, its
  // editor's next conditional save must start from the new stamp, not collide
  // with a write it made itself.
  const rebaseStamps = (rows) => {
    const b = baseRef.current;
    const hit = b && (rows || []).find((r) => r.id === b.id);
    if (hit) baseRef.current = { ...b, updated_at: hit.updated_at };
  };
  const setArchived = async (ids, archived) => {
    if (!ids.length) return;
    try { rebaseStamps(await db.bulkUpdateNotes(ids, { archived })); refresh(); }
    catch (e) {
      complain(isMissingShelfError(e)
        ? "Archiving needs one more column — copy the SQL from the banner on the Notes list."
        : (e.message || "Couldn't update."));
    }
  };
  // OFF THE BRIEF, STILL IN THE LIST — the other exit from the homescreen, and
  // the one that changes nothing else. Archive puts a note away; this leaves it
  // exactly where it is in the Notes tab and only stops the Brief drawing it.
  // Like archiving it needs no confirm and no toast: nothing is at risk and the
  // switch flips back in one tap.
  const setBriefHidden = async (ids, hidden) => {
    if (!ids.length) return;
    try { rebaseStamps(await db.bulkUpdateNotes(ids, { brief_hidden: hidden })); refresh(); }
    catch (e) {
      complain(isMissingShelfError(e)
        ? "Hiding a note from the Brief needs one more column — copy the SQL from the banner on the Notes list."
        : (e.message || "Couldn't update."));
    }
  };
  const bulkHide = async () => {
    // Same rule as bulkArchive: a mixed selection HIDES rather than toggling
    // each row, because "get these off the Brief" is what the button is for.
    const next = !selectedNotes.every((n) => isBriefHidden(n));
    await setBriefHidden([...selected], next);
    clearSelection();
  };
  const bulkArchive = async () => {
    // Mixed selections archive rather than toggling each row: "make these go
    // away" is what the button is for, and a toggle over a mixed set would
    // un-archive half of what you just picked.
    const next = !selectedNotes.every((n) => n.archived);
    await setArchived([...selected], next);
    clearSelection();
  };
  const bulkSeal = async (colorKey) => {
    try { await db.bulkUpdateNotes([...selected], { color: colorKey }); clearSelection(); refresh(); }
    catch (e) { complain(e.message || "Couldn't update."); }
  };
  const bulkMerge = async () => {
    if (selected.size < 2) return;
    const picks = sorted.filter(n => selected.has(n.id)); // pinned/newest first — target is the top one
    if (!(await confirm({
      title: `Merge ${picks.length} notes?`,
      message: `They'll fold into "${displayTitle(picks[0])}". The other ${picks.length - 1} will be removed (undoable for a few seconds).`,
      confirmLabel: "Merge",
    }))) return;
    const target = picks[0];
    const rest = picks.slice(1).sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at)); // read oldest→newest
    const mergedBody = [target.body, ...rest.map(n => (n.title?.trim() ? `${n.title.trim()}\n${n.body || ""}` : n.body || ""))]
      .map(s => (s || "").trim()).filter(Boolean).join("\n\n⸻\n\n");
    try {
      // Two different undos in one toast: the folded notes were DELETED (a
      // stamp to clear, or rows to re-upsert on a pre-0036 table — whichever
      // bulkDeleteNotes says it did), but the target was OVERWRITTEN and only
      // this copy of its old body exists. Undo used to clear stamps on all of
      // them: the folded notes came back and the target kept the merged text,
      // so the words were there three times and the original never returned.
      const restOriginals = rest.map(n => ({ ...n }));
      const targetOriginal = { ...target };
      await db.saveNote({ id: target.id, title: target.title, body: mergedBody, ...(legacy ? {} : { pinned: target.pinned, color: target.color }) });
      const { soft } = await db.bulkDeleteNotes(rest.map(n => n.id));
      armUndo(`Merged ${picks.length} notes`, restOriginals, { soft, rewrite: [targetOriginal] });
      clearSelection(); refresh();
    } catch (e) { complain(e.message || "Couldn't merge."); }
  };

  const words = draft.body.trim() ? draft.body.trim().split(/\s+/).length : 0;
  const activeNote = (notes || []).find(n => n.id === activeId);

  // Seal picker — a row of color dots on ≥38pt targets; tapping the active
  // color again clears it (onPick(null)).
  const sealDots = (value, onPick, dotSize = 14, btn = 38) => (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      {NOTE_SEALS.map(s => (
        <button key={s.key} onClick={() => onPick(value === s.key ? null : s.key)} aria-label={`Seal ${s.key}`}
          style={{ width: btn, height: btn, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
          <span style={{
            width: dotSize, height: dotSize, borderRadius: "50%", background: s.c,
            boxShadow: value === s.key ? `0 0 0 2px var(--surface), 0 0 0 3.5px ${s.c}` : "none",
            opacity: value && value !== s.key ? 0.4 : 1,
            transition: "opacity var(--dur-1) ease",
          }} />
        </button>
      ))}
    </span>
  );

  // Toasts: undo (kept at 6s exactly) + transient errors. The .toasts class
  // clears the phone tab bar via safe-area math instead of magic offsets.
  const toastsEl = (undo || oops) ? (
    <div className="toasts">
      {oops && (
        <div className="toast err"><span className="tdot" /><span>{oops}</span></div>
      )}
      {undo && (
        <div className="toast">
          <span>{undo.label}</span>
          <button onClick={runUndo} style={{ background: "none", border: "none", color: "var(--accent)", fontWeight: 600, fontSize: 13.5, cursor: "pointer", padding: "6px 4px", margin: "-6px 0" }}>Undo</button>
        </div>
      )}
    </div>
  ) : null;

  // ─── editor view — full-card focus ───
  if (activeId) {
    return (
      <section style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        {/* A stronger mix than the list card: here the note IS the screen, so the
            same 9% that reads as a tint among other cards reads as nothing at all
            against a full-bleed surface. The editor is also the one place the
            colour is being chosen, and it should be possible to see what you
            picked. */}
        <Card pad="md" style={{ background: noteTint(draft.color, sealColor, TINT_PCT_STRONG) || undefined }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button kind="plain" size="sm" onClick={closeEditor} style={{ paddingLeft: 2, marginLeft: -6, height: 40 }}>
              <IcChevronLeft size={15} /> All notes
            </Button>
            <span style={{ flex: 1 }} />
            <span className="t-cap" style={{ minWidth: 52, textAlign: "right", color: saveState === "error" ? "var(--red)" : "var(--faint)" }}>
              {saveState === "saving" && "Saving…"}
              {saveState === "saved" && "Saved"}
              {saveState === "error" && "Not saved"}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 2, margin: "2px 0 10px", flexWrap: "wrap" }}>
            {!legacy && (
              <>
                <button className="icon-btn" onClick={() => { if (!draft.pinned) pinToTop([activeId]); setDraft(d => ({ ...d, pinned: !d.pinned })); }}
                  title={draft.pinned ? "Unpin" : "Pin to top"} aria-pressed={draft.pinned}
                  style={{ width: 38, height: 38, color: draft.pinned ? "var(--accent)" : "var(--faint)" }}>
                  <IcPin size={18} />
                </button>
                {sealDots(draft.color, (c) => setDraft(d => ({ ...d, color: c })), 14, 38)}
                <span style={{ width: 1, height: 16, background: "var(--line-strong)", margin: "0 6px", flex: "none" }} />
              </>
            )}
            <Button kind="quiet" size="sm" title="Bullet list — or just start a line with “- ”"
              onClick={() => { toggleBulletAtCaret(editorBodyRef.current, draft.body, applyEditorBody); editorBodyRef.current?.focus(); }}>
              • List
            </Button>
            <Button kind="quiet" size="sm" style={copied ? { color: "var(--green)" } : undefined}
              onClick={() => { navigator.clipboard?.writeText(draft.title.trim() ? `${draft.title.trim()}\n\n${draft.body}` : draft.body); setCopied(true); setTimeout(() => setCopied(false), 1800); }}>
              {copied ? <>Copied <IcCheck size={13} /></> : "Copy"}
            </Button>
            {/* Archive sits BEFORE Delete and is not destructive — the pair reads
                as "put this away" then "throw this away", which is the order you
                want them considered in. It acts on the saved note, so it is only
                offered once there is one to act on. */}
            {/* THE UNDO BUTTON, and on a phone it is the only one there is — iOS's
                shake-to-undo and the keyboard's undo key both read the native
                stack, which a controlled field and the bullet helpers have
                already emptied. Disabled rather than hidden when there is
                nothing to undo, so its place in the row does not move as you
                type. Redo only appears once there is something to redo: a
                permanently-dead second button teaches you not to trust the
                first one. */}
            <button className="icon-btn" onClick={undoText} disabled={!historyRef.current.canUndo()}
              aria-label="Undo" title="Undo (⌘Z)"
              style={{ width: 36, height: 36, opacity: historyRef.current.canUndo() ? 1 : 0.35 }}>
              <IcUndo size={17} />
            </button>
            {historyRef.current.canRedo() && (
              <button className="icon-btn" onClick={redoText}
                aria-label="Redo" title="Redo (⇧⌘Z)"
                style={{ width: 36, height: 36 }}>
                <IcRedo size={17} />
              </button>
            )}
            {/* The lighter of the two exits, and it sits before Archive for the
                same reason Archive sits before Delete: the row reads as "keep it
                here but off the Brief", then "put it away", then "throw it
                away". Hidden while the note is archived — archiving already took
                it off the Brief, so the switch would be a no-op with an opinion. */}
            {canHide && activeNote && !activeNote.archived && (
              <Button kind="quiet" size="sm" onClick={() => setBriefHidden([activeNote.id], !isBriefHidden(activeNote))}
                title={isBriefHidden(activeNote) ? "Show this note on the Brief again" : "Keep it here, off the Brief"}
                aria-pressed={isBriefHidden(activeNote)}>
                {isBriefHidden(activeNote) ? <><IcEye size={14} /> On the Brief</> : <><IcEyeOff size={14} /> Off the Brief</>}
              </Button>
            )}
            {!legacy && activeNote && (
              <Button kind="quiet" size="sm" onClick={() => setArchived([activeNote.id], !activeNote.archived)}
                title={activeNote.archived ? "Put back on the Brief" : "Keep the note, take it off the Brief"}>
                {activeNote.archived ? <><IcUnarchive size={14} /> Unarchive</> : <><IcArchive size={14} /> Archive</>}
              </Button>
            )}
            <span style={{ width: 6 }} />
            <Button kind="quiet" size="sm" style={{ color: "var(--red)" }}
              onClick={() => deleteOne(activeNote || { id: activeId, title: draft.title, body: draft.body })}>
              Delete
            </Button>
          </div>
          <input
            className="field"
            value={draft.title}
            onChange={e => editText({ title: e.target.value }, "title", e.target.selectionStart)}
            placeholder="Untitled note"
            style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, ...(draft.color ? { boxShadow: `inset 3px 0 0 ${sealColor(draft.color)}` } : {}) }}
          />
          <textarea
            className="field"
            ref={editorBodyRef}
            value={draft.body}
            onChange={e => editText({ body: e.target.value }, "body", e.target.selectionStart)}
            onKeyDown={e => continueListOnEnter(e, draft.body, applyEditorBody)}
            placeholder="Start typing — this saves automatically. Start a line with “- ” for a list."
            rows={isMobile ? 14 : 18}
            autoFocus
            style={{ fontSize: 16, lineHeight: 1.6, resize: "vertical" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, flexWrap: "wrap", gap: 6 }}>
            <span className="t-cap" style={{ color: "var(--faint)" }}>{words} words · {draft.body.length} chars</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {activeNote?.archived ? (
                <span className="t-cap" style={{ color: "var(--sub)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <IcArchive size={12} /> Archived — not on the Brief
                </span>
              ) : isBriefHidden(activeNote) ? (
                <span className="t-cap" style={{ color: "var(--sub)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <IcEyeOff size={12} /> Off the Brief — still in Notes
                </span>
              ) : null}
              {activeNote && <span className="t-cap" style={{ color: "var(--faint)" }}>edited {fmtWhen(activeNote.updated_at)}</span>}
            </span>
          </div>
        </Card>
        {toastsEl}
        {confirmEl}
      </section>
    );
  }

  // ─── list view ───
  const allPinned = selectedNotes.length > 0 && selectedNotes.every(n => n.pinned);
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <SectionHeader
        title={`Notes${activeCount ? ` · ${activeCount}` : ""}`}
        trailing={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {/* THE UNDO BUTTON, and the reason it is here rather than only in the
                toast: the toast is a six-second window you have to already be
                looking at. This is reachable whenever there is something to
                bring back, from any device, for thirty days. It restores the
                most recent deletion as one act — a bulk delete of nine notes
                undoes as nine, because undoing one row of an act you performed
                once would look like the button half-worked. */}
            {!legacy && (
              <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -2px" }} onClick={openBin}>
                Undo
              </button>
            )}
            {notes?.length > 1 && (
              <button className="sec-link" style={{ color: selectMode ? "var(--accent)" : "var(--sub)", padding: "10px 8px", margin: "-10px -2px" }}
                onClick={() => (selectMode ? clearSelection() : setSelectMode(true))}>
                {selectMode ? "Done" : "Select"}
              </button>
            )}
            <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -2px" }} onClick={() => setCaptureOpen(true)}>Watch</button>
            <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -4px" }} onClick={newNote}>New note</button>
          </span>
        }
      />

      {captureOpen && (
        <Suspense fallback={null}>
          <CaptureSheet
            token={settings?.notes_capture?.captureToken || ""}
            onToken={(t) => updateSetting?.("notes_capture", { ...(settings?.notes_capture || {}), captureToken: t })}
            onClose={() => setCaptureOpen(false)}
          />
        </Suspense>
      )}

      {(legacy || !canHide) && notes !== null && (
        <Card pad="sm" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Dot tone="var(--amber)" size={7} />
          <span className="t-foot" style={{ flex: 1, minWidth: 180 }}>
            {!legacy
              ? <>Taking a note off the Brief without archiving it needs one more column — one paste in Supabase → SQL editor unlocks it. Everything else here already works.</>
              : legacy === "shelf"
              ? <>Archiving, the Brief switch and the 30-day undo need three more columns — one paste in Supabase → SQL editor unlocks them. Until then a delete is permanent after the six-second toast.</>
              : <>Pins, seals, archiving, the Brief switch and the 30-day undo need five columns — one paste in Supabase → SQL editor unlocks them.</>}
          </span>
          <Button kind="quiet" size="sm" style={sqlCopied ? { color: "var(--green)" } : undefined}
            onClick={() => { navigator.clipboard?.writeText(NOTES_UPGRADE_SQL); setSqlCopied(true); }}>
            {sqlCopied ? <>Copied <IcCheck size={13} /></> : "Copy SQL"}
          </Button>
        </Card>
      )}

      {/* capture deck: quick jot + search + seal filters */}
      <Card pad="sm" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="field"
            ref={quickRef}
            value={quick}
            onChange={e => setQuick(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); quickAdd(e.shiftKey); } }}
            placeholder={isMobile ? "Jot something — Enter saves it" : "Jot something — Enter saves it, ⇧Enter opens the editor"}
            style={{ flex: 1, minWidth: 0, fontSize: 16 }}
          />
          <Button kind={quick.trim() ? "primary" : "quiet"} size="md" disabled={!quick.trim()} onClick={() => quickAdd(false)}
            aria-label="Save note" style={{ padding: "0 14px", flex: "none" }}>
            <IcPlus size={19} />
          </Button>
        </div>
        {notes?.length > 4 && (
          <input className="field" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search notes" />
        )}
        {/* The shelf. Only drawn once there IS an archive — a two-chip switch
            where one chip is always empty is chrome that never earns itself, and
            the Archived chip appears the moment the first note goes on the shelf.
            Counted, because "Archived" with no number gives you no reason to look. */}
        {!legacy && (archivedCount > 0 || hiddenCount > 0 || shelf === "archived") && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <Pill active={shelf === "active" && !hiddenOnly} aria-pressed={shelf === "active" && !hiddenOnly}
              onClick={() => { setShelf("active"); setHiddenOnly(false); }}>
              Notes{activeCount ? ` · ${activeCount}` : ""}
            </Pill>
            {/* A FILTER, NOT A SHELF — these notes are in the list beside it, and
                this only narrows the view to them. It appears the moment the
                first note goes off the Brief and counts them, for the same
                reason the Archived chip does: an uncounted chip gives you no
                reason to tap it. */}
            {hiddenCount > 0 && (
              <Pill active={shelf === "active" && hiddenOnly} aria-pressed={shelf === "active" && hiddenOnly}
                onClick={() => { setShelf("active"); setHiddenOnly(v => !(shelf === "active" && v)); }}>
                <IcEyeOff size={13} /> Off the Brief · {hiddenCount}
              </Pill>
            )}
            {(archivedCount > 0 || shelf === "archived") && (
              <Pill active={shelf === "archived"} aria-pressed={shelf === "archived"} onClick={() => setShelf("archived")}>
                <IcArchive size={13} /> Archived · {archivedCount}
              </Pill>
            )}
          </div>
        )}
        {usedSeals.length > 0 && !legacy && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <button className={`pill${sealFilter === null ? " active" : ""}`} onClick={() => setSealFilter(null)}>All</button>
            {usedSeals.map(s => (
              <button key={s.key} className={`pill${sealFilter === s.key ? " active" : ""}`} aria-label={`Filter ${s.key}`}
                onClick={() => setSealFilter(f => f === s.key ? null : s.key)}>
                <Dot tone={s.c} size={10} />
                {s.key.charAt(0).toUpperCase() + s.key.slice(1)}
              </button>
            ))}
            <button className={`pill${sealFilter === "none" ? " active" : ""}`} onClick={() => setSealFilter(f => f === "none" ? null : "none")}>Unsealed</button>
          </div>
        )}
      </Card>

      {loadErr && (
        <Card pad="md"><EmptyState icon={<IcNote size={26} />} title="Couldn't load notes" sub={loadErr} /></Card>
      )}
      {!loadErr && notes === null && (
        // mirror the loaded layout: 2-col masonry on tablet, single column on phone
        <div style={isMobile ? { display: "flex", flexDirection: "column", gap: 10 } : { columns: 2, columnGap: 12 }}>
          {[0, 1, 2, 3].map(i => (
            <Card pad="md" key={i} style={isMobile ? undefined : { breakInside: "avoid", marginBottom: 12 }}>
              <div className="sk sk-line w40" style={{ margin: "0 0 9px" }} />
              <div className="sk sk-line w80" style={{ margin: 0 }} />
            </Card>
          ))}
        </div>
      )}
      {!loadErr && notes && notes.length === 0 && (
        <Card pad="md"><EmptyState icon={<IcNote size={26} />} title="No notes yet" sub="Jot the first one above — Enter saves it." /></Card>
      )}
      {!loadErr && visible && notes?.length > 0 && visible.length === 0 && (
        <div className="t-foot" style={{ color: "var(--faint)", padding: "14px 0", textAlign: "center" }}>Nothing matches{query ? ` "${query}"` : ""}.</div>
      )}

      {/* note cards — 2-col masonry on wide screens, single column on phones */}
      {!loadErr && visible && visible.length > 0 && (
        <SortableList
          items={visible}
          disabled={selectMode || !!activeId}
          onReorder={(ids) => saveOrder(mergeOrder(ids, sorted))}
          style={isMobile ? { gap: 10 } : { display: "block", columns: 2, columnGap: 12 }}
        >{(n, { dragging }) => {
            const isSel = selected.has(n.id);
            const shadows = [
              isSel ? "inset 0 0 0 1.5px var(--accent)" : null,
              // pinned = subtle accent hairline along the top edge
              n.pinned && !isSel ? "inset 0 2px 0 var(--accent-a55)" : null,
              "var(--shadow-card)",
            ].filter(Boolean).join(", ");
            return (
              <Card key={n.id} pad="md" pressable onClick={() => (selectMode ? toggleSelected(n.id) : openNote(n))}
                style={{
                  boxShadow: shadows,
                  // SELECTION BEATS THE SEAL. Both want the card's background, and
                  // "which of these am I about to act on" has to win over "what
                  // colour did I mark this" — a select-mode tick over a tinted card
                  // that never changed would make bulk actions feel unaimed.
                  background: isSel ? "var(--accent-a06)" : (noteTint(n.color, sealColor) || undefined),
                  ...(isMobile ? {} : { breakInside: "avoid", marginBottom: 12 }),
                }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  {selectMode && (
                    <span aria-hidden style={{
                      width: 22, height: 22, borderRadius: "50%", flex: "none", marginTop: 1,
                      background: isSel ? "var(--accent)" : "transparent",
                      boxShadow: isSel ? "none" : "inset 0 0 0 1.5px var(--ink-a25)",
                      color: "var(--on-accent)", display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}>{isSel ? <IcCheck size={13} /> : null}</span>
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      {n.pinned && <IcPin size={13} style={{ color: "var(--accent)", flex: "none" }} />}
                      {/* Quiet, and only on the shelf where it means something —
                          under Archived every row is off the Brief already. */}
                      {shelf === "active" && isBriefHidden(n) && (
                        <IcEyeOff size={13} style={{ color: "var(--faint)", flex: "none" }} />
                      )}
                      {n.color && <Dot tone={sealColor(n.color)} size={8} />}
                      <span className="t-head" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayTitle(n)}</span>
                    </div>
                    <NoteCardPreview text={snippet(n) || "No additional text"} style={{ marginTop: 3 }} />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
                      <span className="t-cap" style={{ color: "var(--faint)" }}>{fmtWhen(n.updated_at)}</span>
                      {!selectMode && (
                        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); deleteOne(n); }} aria-label="Delete note"
                          onKeyDown={(e) => e.stopPropagation()}
                          style={{ width: 34, height: 34, margin: "-8px -10px -8px 0", color: "var(--faint)" }}>
                          <IcTrash size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          }}</SortableList>
      )}

      {/* select-mode bar — count + scope controls, actions live in a sheet */}
      {selectMode && (
        <div style={{ position: "sticky", bottom: isMobile ? 8 : 12, zIndex: 5 }}>
          <Card pad="sm" style={{ display: "flex", alignItems: "center", gap: 8, boxShadow: "var(--shadow-float)" }}>
            <span className="t-num" style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, flex: "none" }}>{selected.size} selected</span>
            <Button kind="quiet" size="sm" onClick={() => setSelected(new Set((visible || []).map(n => n.id)))}>All</Button>
            <Button kind="quiet" size="sm" onClick={() => setSelected(new Set())}>None</Button>
            <span style={{ flex: 1 }} />
            {selected.size > 0 && <Button kind="tinted" size="sm" onClick={() => setActionsOpen(true)}>Actions</Button>}
          </Card>
        </div>
      )}

      {/* select-mode actions — bottom sheet on phone, centered modal on tablet */}
      {/* ─── Recently deleted ────────────────────────────────────────────────
          What the header's Undo opens, and the reason the six-second toast is no
          longer the whole safety net. Everything here is still in the table with
          a deletion stamp on it; nothing is destroyed until you say so or the
          thirty-day purge (`purge deleted > 30d`, Settings → Systems → Supabase)
          collects it. The day count is printed per row because "recently" is not
          a promise anyone can act on. */}
      {binOpen && (
        <Sheet onClose={() => setBinOpen(false)} title="Recently deleted" detent="medium"
          headTrailing={bin?.length ? (
            <Button kind="plain" size="sm" disabled={binBusy}
              onClick={() => restoreFromBin(bin.map((n) => n.id))}>Restore all</Button>
          ) : null}>
          {bin === null || binBusy ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
              <div className="sk" style={{ height: 52, borderRadius: 12 }} />
              <div className="sk" style={{ height: 52, borderRadius: 12, opacity: 0.6 }} />
            </div>
          ) : !bin.length ? (
            <EmptyState
              icon={<IcTrash size={22} />}
              title="Nothing deleted"
              sub={legacy
                ? "This database can't hold deleted notes yet — run the SQL from the banner and deletes become undoable for 30 days."
                : `Notes you delete wait here for ${PURGE_AFTER_DAYS} days before they're gone for good.`}
              style={{ padding: "26px 12px" }}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", paddingBottom: 8 }}>
              {deletedNotes(bin).map((n) => {
                const left = daysLeft(n);
                return (
                  <div key={n.id} className="cell" style={{ alignItems: "flex-start", gap: 10 }}>
                    <span className="cell-body">
                      <span className="cell-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {n.color && <Dot tone={sealColor(n.color)} size={8} />}
                        {displayTitle(n)}
                      </span>
                      <span className="cell-sub">
                        {left === null ? "deleted" : left === 0 ? "goes today" : `${left} day${left === 1 ? "" : "s"} left`}
                        {n.archived ? " · was archived" : isBriefHidden(n) ? " · was off the Brief" : ""}
                      </span>
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flex: "none" }}>
                      <Button kind="plain" size="sm" disabled={binBusy} onClick={() => restoreFromBin([n.id])}>
                        <IcRefresh size={13} /> Restore
                      </Button>
                      <button className="icon-btn" disabled={binBusy} aria-label={`Delete ${displayTitle(n)} forever`}
                        title="Delete forever"
                        onClick={() => purgeFromBin([n.id], `Delete "${displayTitle(n)}" forever?`)}
                        style={{ width: 34, height: 34, color: "var(--faint)" }}>
                        <IcTrash size={15} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Sheet>
      )}

      {actionsOpen && selectMode && (
        <Sheet onClose={() => setActionsOpen(false)} title={`${selected.size} selected`}>
          <div style={{ display: "flex", flexDirection: "column", paddingBottom: 8 }}>
            {!legacy && (
              <Cell
                leading={<IcPin size={18} />}
                title={allPinned ? "Unpin" : "Pin to top"}
                onClick={() => { setActionsOpen(false); bulkPin(); }}
              />
            )}
            {!legacy && (
              <div className="cell has-leading">
                <span className="cell-leading" style={{ color: "var(--sub)" }}><IcSeal size={18} /></span>
                <span className="cell-body"><span className="cell-title">Seal</span></span>
                {sealDots(null, (c) => { setActionsOpen(false); bulkSeal(c); }, 16, 44)}
                <Button kind="plain" size="sm" onClick={() => { setActionsOpen(false); bulkSeal(null); }}>Clear</Button>
              </div>
            )}
            {canHide && (
              <Cell
                leading={selectedNotes.every((n) => isBriefHidden(n)) ? <IcEye size={18} /> : <IcEyeOff size={18} />}
                title={selectedNotes.every((n) => isBriefHidden(n)) ? "Show on the Brief" : "Take off the Brief"}
                sub={selectedNotes.every((n) => isBriefHidden(n)) ? "Back on the homescreen" : "Stays in this list — just not on the Brief"}
                onClick={() => { setActionsOpen(false); bulkHide(); }}
              />
            )}
            {!legacy && (
              <Cell
                leading={selectedNotes.every((n) => n.archived) ? <IcUnarchive size={18} /> : <IcArchive size={18} />}
                title={selectedNotes.every((n) => n.archived) ? "Unarchive" : "Archive"}
                sub={selectedNotes.every((n) => n.archived) ? "Back on the Brief and in the list" : "Keeps the note, takes it off the Brief"}
                onClick={() => { setActionsOpen(false); bulkArchive(); }}
              />
            )}
            {selected.size > 1 && (
              <Cell
                leading={<IcNote size={18} />}
                title={`Merge ${selected.size} notes`}
                sub="Folds into the top pick — undoable"
                onClick={() => { setActionsOpen(false); bulkMerge(); }}
              />
            )}
            <Cell
              leading={<IcTrash size={18} />}
              title={`Delete ${selected.size} note${selected.size > 1 ? "s" : ""}`}
              destructive
              onClick={() => { setActionsOpen(false); bulkDelete(); }}
            />
          </div>
        </Sheet>
      )}

      {toastsEl}
      {confirmEl}
    </section>
  );
}

export default NotesPanel;
