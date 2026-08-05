// ─── Ponder — the resurfacing inbox ──────────────────────────────────────────
// Thoughts and links you're not ready to act on. Lives under Personal, after
// Notes & Calendar — it's a capture surface like Notes, not a daily-glance
// card, so it doesn't belong on the Brief. THE SCHEMA IS INHERITED, NOT
// DESIGNED: rows in app_settings.ponder_items predate this file, so every
// field — kind, status, createdAt/updatedAt/lastSeenAt, dismissedAt,
// snoozeUntil — is read and written as already stored. Items never delete;
// Done marks dismissedAt and keeps the row, because an idea you dismissed in
// July is still yours to grep for in October.
//
// Editing follows the house pattern (see UpkeepPanel): tap a row, an inline
// Card opens above the list with an editable TextArea, Save/Cancel below it.
// Quick-add stays a one-line Field + Enter, for capture with zero friction —
// editing is the deliberate, slower path for fixing or expanding a thought
// after the fact.
import { useState } from "react";
import { T } from "../../theme.js";
import { Card, SectionHeader, CellGroup, Button, Field, TextArea, Pill, EmptyState } from "../../ui/kit.jsx";

const now = () => Date.now();
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s).trim());
const ageOf = (t) => {
  if (!Number.isFinite(t)) return "";
  const d = Math.floor((now() - t) / 864e5);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
};

export function PonderPanel({ isMobile, settings, updateSetting }) {
  const [quick, setQuick] = useState("");
  const [form, setForm] = useState(null); // { id, content } while an item is open for editing
  const items = Array.isArray(settings?.ponder_items) ? settings.ponder_items : [];
  const open = items.filter((it) => it && it.status === "open" && !(Number.isFinite(it.snoozeUntil) && it.snoozeUntil > now()));

  const write = (next) => updateSetting?.("ponder_items", next);
  const patch = (id, fields) => write(items.map((it) => (it && it.id === id ? { ...it, ...fields, updatedAt: now() } : it)));

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

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div>
        <SectionHeader title="Ponder" />
        <div className="t-foot" style={{ padding: "0 4px" }}>
          Park a thought or a link you're not ready to act on. It resurfaces here
          until you snooze it or mark it done — nothing you write gets deleted.
        </div>
      </div>

      <Card pad="md" style={{ display: "flex", gap: 8 }}>
        <Field value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Park a thought or a link…"
          onKeyDown={(e) => { if (e.key === "Enter") add(); }} style={{ flex: 1, minWidth: 0 }} />
        <Button kind="tinted" size="md" onClick={add} disabled={!quick.trim()} style={{ flex: "none" }}>Add</Button>
      </Card>

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

      {open.length === 0 ? (
        <Card pad="md">
          <EmptyState title="Nothing parked" sub="Ideas and links land here and resurface until you're done with them." />
        </Card>
      ) : (
        <CellGroup>
          {/* A plain div, not a button: when the content is a link it's a real
              <a> so tapping it opens the URL, same as before. Editing is its
              own explicit button rather than "tap the row" — the two actions
              (visit a link, edit its text) can't share one tap target without
              one of them becoming a trap for the other. */}
          {open.map((it) => (
            <div key={it.id} className="cell" style={{ flexDirection: "column", alignItems: "stretch", gap: 8, paddingTop: 10, paddingBottom: 10 }}>
              <div>
                <span style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                  <Pill active={false} style={{ pointerEvents: "none" }}>{it.kind === "Link" ? "Link" : "Thought"}</Pill>
                  <span className="t-cap" style={{ color: "var(--faint)" }}>{ageOf(it.createdAt)}</span>
                </span>
                {it.kind === "Link" && isUrl(it.content) ? (
                  <a href={it.content} target="_blank" rel="noreferrer" className="t-foot"
                    style={{ color: "var(--accent)", wordBreak: "break-all", display: "block" }}>{it.content}</a>
                ) : (
                  <span className="t-foot" style={{ lineHeight: 1.5, whiteSpace: "normal", display: "block" }}>{it.content}</span>
                )}
              </div>
              <span style={{ display: "flex", gap: 8 }}>
                <Button kind="quiet" size="sm" style={{ height: 44 }} onClick={() => openEdit(it)}>Edit</Button>
                <Button kind="quiet" size="sm" style={{ height: 44 }}
                  onClick={() => patch(it.id, { snoozeUntil: now() + 3 * 864e5 })}>Snooze 3d</Button>
                <Button kind="quiet" size="sm" style={{ height: 44, color: T.green }}
                  onClick={() => patch(it.id, { status: "dismissed", dismissedAt: now() })}>Done</Button>
              </span>
            </div>
          ))}
        </CellGroup>
      )}
    </section>
  );
}
