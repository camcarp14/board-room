// ─── Ponder — the resurfacing inbox ──────────────────────────────────────────
// Thoughts and links you're not ready to act on, parked where the morning
// glance will offer them back. THE SCHEMA IS INHERITED, NOT DESIGNED: rows in
// app_settings.ponder_items predate this file (the restored build wrote them),
// so every field — kind, status, createdAt/updatedAt/lastSeenAt, dismissedAt,
// snoozeUntil — is read as stored. Items never delete; Done marks dismissedAt
// and keeps the row, because an idea you dismissed in July is still yours to
// grep for in October.
import { useState } from "react";
import { T } from "../../theme.js";
import { CollapsibleCard, Button, Field, Pill, EmptyState } from "../../ui/kit.jsx";

const now = () => Date.now();
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s).trim());
const ageOf = (t) => {
  if (!Number.isFinite(t)) return "";
  const d = Math.floor((now() - t) / 864e5);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
};

export function PonderCard({ settings, updateSetting, coll, pad }) {
  const [draft, setDraft] = useState("");
  const items = Array.isArray(settings?.ponder_items) ? settings.ponder_items : [];
  // Open = status open AND not snoozed into the future. A snooze that lapsed
  // simply reappears — that's the entire point of the field.
  const open = items.filter((it) => it && it.status === "open" && !(Number.isFinite(it.snoozeUntil) && it.snoozeUntil > now()));

  const write = (next) => updateSetting?.("ponder_items", next);
  const patch = (id, fields) => write(items.map((it) => (it && it.id === id ? { ...it, ...fields, updatedAt: now() } : it)));

  const add = () => {
    const content = draft.trim();
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
    setDraft("");
  };

  return (
    <CollapsibleCard {...coll("ponder")} pad={pad} title="Ponder"
      trailing={open.length > 0 ? <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{open.length}</span> : null}>
      <div style={{ display: "flex", gap: 8, marginBottom: open.length ? 10 : 0 }}>
        <Field value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Park a thought or a link…"
          onKeyDown={(e) => { if (e.key === "Enter") add(); }} style={{ flex: 1, minWidth: 0 }} />
        <Button kind="tinted" size="md" onClick={add} disabled={!draft.trim()} style={{ flex: "none" }}>Add</Button>
      </div>
      {open.length ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {open.map((it, i) => (
            <div key={it.id} style={{ padding: "10px 0", borderTop: i === 0 ? "none" : "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                <Pill active={false} style={{ pointerEvents: "none" }}>{it.kind === "Link" ? "Link" : "Thought"}</Pill>
                <span className="t-cap" style={{ color: "var(--faint)" }}>{ageOf(it.createdAt)}</span>
              </div>
              {it.kind === "Link" && isUrl(it.content) ? (
                <a href={it.content} target="_blank" rel="noreferrer" className="t-foot"
                  style={{ color: "var(--accent)", wordBreak: "break-all", display: "block", marginBottom: 8 }}>
                  {it.content}
                </a>
              ) : (
                <div className="t-foot" style={{ lineHeight: 1.55, marginBottom: 8 }}>{it.content}</div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <Button kind="quiet" size="sm" style={{ height: 44 }}
                  onClick={() => patch(it.id, { snoozeUntil: now() + 3 * 864e5 })}>Snooze 3d</Button>
                <Button kind="quiet" size="sm" style={{ height: 44, color: T.green }}
                  onClick={() => patch(it.id, { status: "dismissed", dismissedAt: now() })}>Done</Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="Nothing parked" sub="Ideas and links land here and resurface until you're done with them." />
      )}
    </CollapsibleCard>
  );
}
