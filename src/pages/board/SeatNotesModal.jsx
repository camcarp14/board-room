// ─── Seat context editor ──────────────────────────────────────────────────────
// Edits the free-text "ground truth" for one board seat. The text is injected
// verbatim into that seat's system prompt by consultSeat (lib/claude.js) as
// "Current context from Cameron (treat as ground truth)" — content here is
// live prompt material, not decoration. Saving awaits onSave THEN closes
// (the parent persists to the synced settings store — that's the "synced
// everywhere" claim). Dismissing with unsaved edits asks before discarding.
import { useState } from "react";
import { Sheet, Button, Dot, TextArea, useConfirm } from "../../ui/kit.jsx";
import { BOARD } from "../../lib/claude.js";
import { tint } from "../../ui/styles.js";

export function SeatNotesModal({ seatKey, initial, onSave, onClose, isMobile }) { // eslint-disable-line no-unused-vars -- isMobile: contract prop; the Sheet self-adapts by viewport
  const seat = BOARD.find(b => b.key === seatKey);
  const [notes, setNotes] = useState(initial || "");
  const [saving, setSaving] = useState(false);
  const [confirmEl, confirm] = useConfirm();
  if (!seat) return null;

  const dirty = notes !== (initial || "");
  const requestClose = async () => {
    if (saving) return;
    if (dirty && !(await confirm({ title: "Discard changes?", message: "Your edits to this seat's context haven't been saved.", confirmLabel: "Discard", destructive: true }))) return;
    onClose();
  };
  const save = async () => { setSaving(true); await onSave(seatKey, notes); setSaving(false); onClose(); };

  return (
    <>
      <Sheet
        onClose={requestClose}
        title={seat.name}
        dismissible={!saving}
        footer={
          <>
            <Button kind="quiet" size="lg" style={{ flex: 1 }} disabled={saving} onClick={requestClose}>Cancel</Button>
            <Button kind="primary" size="lg" style={{ flex: 2 }} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save context"}</Button>
          </>
        }>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, paddingBottom: 12 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: tint(seat.color, 14), display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
            <Dot tone={seat.color} size={9} />
          </span>
          {/* charter preview — the seat's standing brief, for orientation only */}
          <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.55, minWidth: 0 }}>{seat.charter.slice(0, 160)}…</div>
        </div>
        <div className="t-label" style={{ paddingBottom: 8 }}>Current context · treated as ground truth · synced everywhere</div>
        <TextArea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Paste what's current — pipeline numbers, open questions, this week's state. The fresher this is, the sharper the seat's takes."
          style={{ minHeight: 170, resize: "vertical", lineHeight: 1.6 }}
        />
      </Sheet>
      {confirmEl}
    </>
  );
}
