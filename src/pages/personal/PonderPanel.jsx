// ─── Ponder — the resurfacing inbox ──────────────────────────────────────────
// Thoughts and links you're not ready to act on. Lives under Personal, after
// Notes & Calendar — it's a capture surface like Notes, not a daily-glance
// card, so it doesn't belong on the Brief. THE SCHEMA IS INHERITED, NOT
// DESIGNED: rows in app_settings.ponder_items predate this file, so every
// field — kind, status, createdAt/updatedAt/lastSeenAt, dismissedAt,
// snoozeUntil — is read and written as already stored.
//
// Two sub-views, a PillRow under the header: Open (the active inbox) and
// Archive (status "dismissed" — items you're done tending but kept). Archive
// is a real destination, not a trash can: restore brings a row back to Open,
// nothing in it is one tap from gone. Delete is the only irreversible action
// here, gated behind a confirm like every other destructive control in this
// app (never window.confirm).
//
// Editing follows the house pattern (see UpkeepPanel): tap Edit, an inline
// Card opens above the list with an editable TextArea, Save/Cancel below it.
// Quick-add stays a one-line Field + Enter for zero-friction capture. Row
// actions are icon buttons (.icon-btn — 38px visual box, 44pt touch target,
// same class NotesPanel uses for Pin/Delete) rather than labelled buttons:
// four actions in text would have wrapped or crowded on a narrow phone: icons
// read as a toolbar instead of a wall of pills.
import { useState } from "react";
import { Card, SectionHeader, CellGroup, PillRow, Button, Field, TextArea, EmptyState, useConfirm } from "../../ui/kit.jsx";
import { IcPencil, IcClock, IcArchive, IcUnarchive, IcTrash } from "../../ui/icons.jsx";

const now = () => Date.now();
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s).trim());
const ageOf = (t) => {
  if (!Number.isFinite(t)) return "";
  const d = Math.floor((now() - t) / 864e5);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
};

const VIEWS = [{ key: "open", label: "Open" }, { key: "archive", label: "Archive" }];

function IconAction({ icon, label, tone, onClick }) {
  return (
    <button className="icon-btn" onClick={onClick} title={label} aria-label={label}
      style={{ width: 32, height: 32, borderRadius: 9, color: tone || "var(--faint)" }}>
      {icon}
    </button>
  );
}

export function PonderPanel({ isMobile, settings, updateSetting }) {
  const [view, setView] = useState("open");
  const [quick, setQuick] = useState("");
  const [form, setForm] = useState(null); // { id, content } while an item is open for editing
  const [confirmEl, confirm] = useConfirm();

  const items = Array.isArray(settings?.ponder_items) ? settings.ponder_items : [];
  const open = items.filter((it) => it && it.status === "open" && !(Number.isFinite(it.snoozeUntil) && it.snoozeUntil > now()));
  const archived = items.filter((it) => it && it.status === "dismissed")
    .sort((a, b) => (b.dismissedAt ?? 0) - (a.dismissedAt ?? 0));
  const rows = view === "open" ? open : archived;

  const write = (next) => updateSetting?.("ponder_items", next);
  const patch = (id, fields) => write(items.map((it) => (it && it.id === id ? { ...it, ...fields, updatedAt: now() } : it)));
  const remove = (id) => write(items.filter((it) => it && it.id !== id));

  const add = () => {
    const content = quick.trim();
    if (!content) return;
    const item = {
      id: `ponder-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      kind: isUrl(content) ? "Link" : "Thought",
      status: "open",
      content,
      createdAt: now(), updatedAt: now(),
      lastSeenAt: null, dismissedAt: null, snoozeUntil: null,
    };
    write([item, ...items]);
    setQuick("");
  };

  const openEdit = (it) => setForm({ id: it.id, content: it.content });
  const save = () => {
    const content = form.content.trim();
    if (!content) return;
    patch(form.id, { content, kind: isUrl(content) ? "Link" : "Thought" });
    setForm(null);
  };
  const del = async (it) => {
    const label = it.content.length > 60 ? `${it.content.slice(0, 60)}…` : it.content;
    if (!(await confirm({ title: "Delete this?", message: label, confirmLabel: "Delete", destructive: true }))) return;
    remove(it.id);
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div>
        <SectionHeader title="Ponder" />
        <div className="t-foot" style={{ padding: "0 4px" }}>
          Park a thought or a link you're not ready to act on. Archive when
          you're done with it, snooze it a few days, or delete it outright.
        </div>
      </div>

      <PillRow options={VIEWS} value={view} onChange={setView} style={isMobile ? { margin: "0 -16px" } : undefined} />

      {view === "open" && (
        <Card pad="md" style={{ display: "flex", gap: 8 }}>
          <Field value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Park a thought or a link…"
            onKeyDown={(e) => { if (e.key === "Enter") add(); }} style={{ flex: 1, minWidth: 0 }} />
          <Button kind="tinted" size="md" onClick={add} disabled={!quick.trim()} style={{ flex: "none" }}>Add</Button>
        </Card>
      )}

      {form && (
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span className="t-head">Edit</span>
          <TextArea value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            autoFocus style={{ minHeight: 100, resize: "vertical", lineHeight: 1.55 }} />
          <div style={{ display: "flex", gap: 10 }}>
            <Button kind="primary" size="md" disabled={!form.content.trim()} onClick={save} style={{ flex: 1 }}>Save</Button>
            <Button kind="quiet" size="md" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card pad="md">
          <EmptyState
            title={view === "open" ? "Nothing parked" : "Nothing archived"}
            sub={view === "open"
              ? "Ideas and links land here and resurface until you archive or delete them."
              : "Items you archive from Open show up here — restore or delete anytime."}
          />
        </Card>
      ) : (
        <CellGroup>
          {/* A plain div, not a button: when the content is a link it's a real
              <a> so tapping it opens the URL. The icon row is the row's only
              other interactive surface, so a link tap and an action tap can
              never fight over the same target. */}
          {rows.map((it) => (
            <div key={it.id} className="cell" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, paddingTop: 9, paddingBottom: 9 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="t-cap" style={{ color: "var(--faint)", flex: 1, minWidth: 0 }}>
                  {it.kind === "Link" ? "Link" : "Thought"} · {view === "open" ? ageOf(it.createdAt) : `archived ${ageOf(it.dismissedAt)}`}
                </span>
                <span style={{ display: "flex", gap: 2, flex: "none" }}>
                  {view === "open" ? (
                    <>
                      <IconAction icon={<IcPencil size={15} />} label="Edit" onClick={() => openEdit(it)} />
                      <IconAction icon={<IcClock size={15} />} label="Snooze 3 days" onClick={() => patch(it.id, { snoozeUntil: now() + 3 * 864e5 })} />
                      <IconAction icon={<IcArchive size={15} />} label="Archive" tone="var(--green)" onClick={() => patch(it.id, { status: "dismissed", dismissedAt: now() })} />
                    </>
                  ) : (
                    <IconAction icon={<IcUnarchive size={15} />} label="Restore" tone="var(--accent)" onClick={() => patch(it.id, { status: "open", dismissedAt: null })} />
                  )}
                  <IconAction icon={<IcTrash size={15} />} label="Delete" tone="var(--red)" onClick={() => del(it)} />
                </span>
              </div>
              {it.kind === "Link" && isUrl(it.content) ? (
                <a href={it.content} target="_blank" rel="noreferrer" className="t-foot"
                  style={{ color: "var(--accent)", wordBreak: "break-all", display: "block" }}>{it.content}</a>
              ) : (
                <span className="t-foot" style={{ lineHeight: 1.5, whiteSpace: "normal", display: "block" }}>{it.content}</span>
              )}
            </div>
          ))}
        </CellGroup>
      )}
      {confirmEl}
    </section>
  );
}
