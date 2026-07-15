import { useState } from "react";
import { tint } from "../../ui/styles.js";
import { Card, SectionHeader, CellGroup, Button, Field, Dot, EmptyState, useConfirm, IcCheck } from "../../ui/kit.jsx";
import { IcWrench } from "../../ui/icons.jsx";
import { Chips } from "../../ui/primitives.jsx";
import { isMissingTable } from "../../data/db.js";
import { upkeepDue } from "../../lib/upkeep.js";
import { useUpkeep, useSaveUpkeepItem, useDeleteUpkeepItem, useMarkUpkeepDone } from "../../data/upkeep.js";

// ─── Upkeep — recurring maintenance with a memory ─────────────────────────────
// Oil change, AC filter, anything on a cadence. One tap logs a completion and
// the clock restarts. Due/overdue items also surface on the Brief's Docket.
const UPKEEP_SETUP_SQL = `-- Board Room · Upkeep — one-time setup
create table if not exists public.upkeep_items (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  interval_days integer not null default 90,
  last_done date,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.upkeep_items enable row level security;
drop policy if exists "upkeep own rows" on public.upkeep_items;
create policy "upkeep own rows" on public.upkeep_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`;

const UPKEEP_INTERVALS = [
  { key: 30, label: "Monthly" }, { key: 91, label: "3 months" },
  { key: 182, label: "6 months" }, { key: 365, label: "Yearly" },
  { key: "custom", label: "Custom" },
];
const upkeepIntervalLabel = (days) => {
  const hit = UPKEEP_INTERVALS.find(i => i.key === days);
  if (hit) return hit.label.toLowerCase() === "monthly" || hit.label.toLowerCase() === "yearly" ? hit.label.toLowerCase() : `every ${hit.label.toLowerCase()}`;
  if (days % 365 === 0) return `every ${days / 365} years`;
  if (days % 30 === 0) return `every ${days / 30} months`;
  if (days % 7 === 0) return `every ${days / 7} weeks`;
  return `every ${days} days`;
};
const upkeepDueText = (meta) =>
  meta.never ? "Never logged"
  : meta.dueIn < 0 ? `Overdue ${Math.abs(meta.dueIn)}d`
  : meta.dueIn === 0 ? "Due today"
  : `Due in ${meta.dueIn}d`;
const upkeepDueColor = (meta) =>
  meta.never || meta.dueIn <= 0 ? "var(--red)" : meta.dueIn <= 14 ? "var(--amber)" : "var(--green)";

// Reset that lets a <button> wear the kit's .cell-body anatomy (rows keep a
// separate Done button, so the whole cell can't be one <button> itself).
const rowBtn = { background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", alignSelf: "stretch", justifyContent: "center" };
const sqlPre = { background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", fontSize: 11, fontFamily: "var(--font-mono)", lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre", color: "var(--sub)", margin: 0 };

export function UpkeepPanel({ isMobile }) {
  const { data: rows = null, error, refetch } = useUpkeep();
  const needsSetup = !!error && isMissingTable(error, "upkeep_items");
  const loadErr = error && !needsSetup ? (error.message || "Couldn't load upkeep items.") : null;
  const saveMut = useSaveUpkeepItem();
  const delMut = useDeleteUpkeepItem();
  const markDoneMut = useMarkUpkeepDone();
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [doneFlash, setDoneFlash] = useState(null); // id that just got logged
  const [confirmEl, confirm] = useConfirm();

  const openNew = () => {
    setSaveErr(null);
    setForm({ id: crypto.randomUUID(), name: "", interval: 182, customDays: "", last_done: new Date().toISOString().slice(0, 10), notes: "", isNew: true });
  };
  const openEdit = (it) => {
    setSaveErr(null);
    const preset = UPKEEP_INTERVALS.some(x => x.key === it.interval_days);
    setForm({ id: it.id, name: it.name, interval: preset ? it.interval_days : "custom", customDays: preset ? "" : String(it.interval_days), last_done: it.last_done ? String(it.last_done).slice(0, 10) : "", notes: it.notes || "", isNew: false });
  };
  const save = () => {
    const days = form.interval === "custom" ? parseInt(form.customDays, 10) : form.interval;
    if (!form.name.trim()) { setSaveErr("Name the task."); return; }
    if (!days || days < 1) { setSaveErr("Give it a real cadence."); return; }
    setSaving(true); setSaveErr(null);
    saveMut.mutate({ id: form.id, name: form.name.trim(), interval_days: days, last_done: form.last_done || null, notes: form.notes.trim() }, {
      onSuccess: () => { setSaving(false); setForm(null); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't save."); },
    });
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete "${form.name.trim() || "this item"}"?`, message: "It comes off the rotation and the Brief.", confirmLabel: "Delete", destructive: true }))) return;
    setSaving(true);
    delMut.mutate(form.id, {
      onSuccess: () => { setSaving(false); setForm(null); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't delete."); },
    });
  };
  const markDone = (it) => {
    const today = new Date().toISOString().slice(0, 10);
    setDoneFlash(it.id);
    setTimeout(() => setDoneFlash(null), 1600);
    markDoneMut.mutate({ item: it, today }); // optimistic cache update lives in the hook
  };

  if (needsSetup) return (
    <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="t-head">One-time setup</span>
      <span className="t-foot" style={{ lineHeight: 1.6 }}>
        The upkeep table doesn't exist yet. Paste this into the Supabase SQL editor (safe to re-run), then come back — everything else is already wired.
      </span>
      <pre style={sqlPre}>{UPKEEP_SETUP_SQL}</pre>
      <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
        <Button kind="primary" size="md" onClick={() => { navigator.clipboard?.writeText(UPKEEP_SETUP_SQL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {}); }}>
          {copied ? <><IcCheck size={15} /> Copied</> : "Copy SQL"}
        </Button>
        <Button kind="quiet" size="md" onClick={() => refetch()}>I ran it — retry</Button>
      </div>
    </Card>
  );

  const sorted = (rows || []).map(it => ({ ...it, meta: upkeepDue(it) }))
    .sort((a, b) => (a.meta.never ? -9999 : a.meta.dueIn) - (b.meta.never ? -9999 : b.meta.dueIn));

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div>
        <SectionHeader
          title="Upkeep"
          trailing={!form
            ? <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -8px" }} onClick={openNew}>Add</button>
            : undefined}
        />
        <div className="t-foot" style={{ padding: "0 4px" }}>
          The stuff that keeps life running — oil changes, filters, renewals. Log it once, the clock does the rest. Due items surface on your Brief.
        </div>
      </div>

      {form && (
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span className="t-head">{form.isNew ? "New item" : "Edit item"}</span>
          <Field value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="What needs doing? (oil change, AC filter…)" autoFocus />
          <div>
            <div className="t-cap" style={{ color: "var(--sub)", marginBottom: 8 }}>How often</div>
            <Chips options={UPKEEP_INTERVALS.map(i => i.key)} value={form.interval} onChange={(v) => setForm(f => ({ ...f, interval: v }))} fmt={(v) => UPKEEP_INTERVALS.find(i => i.key === v)?.label || v} />
            {form.interval === "custom" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                <Field value={form.customDays} onChange={e => setForm(f => ({ ...f, customDays: e.target.value.replace(/\D/g, "") }))} placeholder="days" inputMode="numeric" className="t-num" style={{ width: 96, flex: "none" }} />
                <span className="t-foot">days between passes</span>
              </div>
            )}
          </div>
          <div>
            <div className="t-cap" style={{ color: "var(--sub)", marginBottom: 8 }}>Last done <span style={{ color: "var(--faint)" }}>(leave empty if never)</span></div>
            {/* colorScheme: inherit — the native date picker follows the room's theme */}
            <Field type="date" value={form.last_done} onChange={e => setForm(f => ({ ...f, last_done: e.target.value }))} className="t-num" style={{ colorScheme: "inherit" }} />
          </div>
          <Field value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes — filter size, oil type, who to call…" />
          {saveErr && <div className="t-foot" style={{ color: "var(--red)" }}>{saveErr}</div>}
          <div style={{ display: "flex", gap: 10 }}>
            <Button kind="primary" size="md" disabled={saving} onClick={save} style={{ flex: 1 }}>{saving ? "Saving…" : form.isNew ? "Add to the rotation" : "Save changes"}</Button>
            {!form.isNew && <Button kind="danger" size="md" disabled={saving} onClick={remove}>Delete</Button>}
            <Button kind="quiet" size="md" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </Card>
      )}

      {rows === null && !loadErr ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="sk" style={{ height: 56, borderRadius: 18 }} />
          <div className="sk" style={{ height: 56, borderRadius: 18 }} />
        </div>
      ) : loadErr ? (
        <Card pad="md">
          <EmptyState icon={<IcWrench size={24} />} title="Couldn't load upkeep" sub={loadErr}
            action={<Button kind="quiet" size="md" onClick={() => refetch()}>Retry</Button>} />
        </Card>
      ) : sorted.length === 0 && !form ? (
        <Card pad="md">
          <EmptyState icon={<IcWrench size={24} />} title="Nothing in the rotation yet"
            sub="Oil change, apartment AC filter, toothbrush heads — add the things you always remember two weeks late."
            action={<Button kind="primary" size="md" onClick={openNew}>Add the first one</Button>} />
        </Card>
      ) : (
        <CellGroup>
          {sorted.map(it => {
            const c = upkeepDueColor(it.meta);
            // parse as local midnight — new Date("YYYY-MM-DD") alone is UTC and shifts a day
            const lastLabel = it.last_done ? new Date(it.last_done + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "never";
            const flashed = doneFlash === it.id;
            return (
              <div key={it.id} className="cell" style={{ paddingRight: 10 }}>
                <button className="cell-body" onClick={() => openEdit(it)} style={rowBtn}>
                  <span className="cell-title">{it.name}</span>
                  <span className="cell-sub">{upkeepIntervalLabel(it.interval_days)} · last {lastLabel}{it.notes ? ` · ${it.notes}` : ""}</span>
                </button>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
                  <Dot tone={c} size={6} />
                  <span className="t-num" style={{ fontSize: 11, fontWeight: 600, color: c, whiteSpace: "nowrap" }}>{upkeepDueText(it.meta)}</span>
                </span>
                <Button kind="tinted" size="sm" onClick={() => markDone(it)} title="Log it done today"
                  style={{ height: 44, minWidth: 76, flex: "none", ...(flashed ? { background: tint("var(--green)", 14), color: "var(--green)" } : null) }}>
                  {flashed ? <><IcCheck size={14} /> Logged</> : "Done"}
                </Button>
              </div>
            );
          })}
        </CellGroup>
      )}
      {confirmEl}
    </section>
  );
}
