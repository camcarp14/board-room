import { useState } from "react";
import { T, syne, mono } from "../../theme.js";
import { S, tint } from "../../ui/styles.js";
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
  meta.never ? "NEVER LOGGED"
  : meta.dueIn < 0 ? `OVERDUE ${Math.abs(meta.dueIn)}D`
  : meta.dueIn === 0 ? "DUE TODAY"
  : `DUE IN ${meta.dueIn}D`;
const upkeepDueColor = (meta) =>
  meta.never || meta.dueIn <= 0 ? T.red : meta.dueIn <= 14 ? T.amber : T.green;

export function UpkeepPanel({ isMobile }) {
  const card = isMobile ? S.cardM : S.card;
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
  const remove = () => {
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
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={S.title}>Upkeep · One-Time Setup</span>
      </div>
      <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.65, marginBottom: 12 }}>
        The upkeep table doesn't exist yet. Paste this into the Supabase SQL editor (safe to re-run), then come back — everything else is already wired.
      </div>
      <pre style={{ ...S.inner, margin: 0, padding: "12px 14px", fontSize: 10, fontFamily: mono, color: T.sub, lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre" }}>{UPKEEP_SETUP_SQL}</pre>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => { navigator.clipboard?.writeText(UPKEEP_SETUP_SQL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {}); }} style={{ ...S.brassBtn, padding: "9px 16px", fontSize: 11 }}>{copied ? "Copied ✓" : "Copy SQL"}</button>
        <button onClick={() => refetch()} style={{ ...S.ghostBtn, padding: "9px 16px", fontSize: 11 }}>I ran it — retry</button>
      </div>
    </div>
  );

  const sorted = (rows || []).map(it => ({ ...it, meta: upkeepDue(it) }))
    .sort((a, b) => (a.meta.never ? -9999 : a.meta.dueIn) - (b.meta.never ? -9999 : b.meta.dueIn));

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={S.title}>Upkeep</span>
        {!form && <button onClick={openNew} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 10.5 }}>+ Add</button>}
      </div>
      <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, marginBottom: 12 }}>
        The stuff that keeps life running — oil changes, filters, renewals. Log it once, the clock does the rest. Due items surface on your Brief.
      </div>

      {form && (
        <div style={{ ...S.inner, padding: "14px 15px", marginBottom: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="What needs doing? (oil change, AC filter…)" autoFocus
            style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 13 }} />
          <div>
            <div style={{ ...S.microLabel, marginBottom: 6 }}>How often</div>
            <Chips options={UPKEEP_INTERVALS.map(i => i.key)} value={form.interval} onChange={(v) => setForm(f => ({ ...f, interval: v }))} fmt={(v) => UPKEEP_INTERVALS.find(i => i.key === v)?.label || v} />
            {form.interval === "custom" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <input value={form.customDays} onChange={e => setForm(f => ({ ...f, customDays: e.target.value.replace(/\D/g, "") }))} placeholder="days" inputMode="numeric"
                  style={{ ...S.input, width: 90, padding: "8px 10px", fontSize: 13, fontFamily: mono }} />
                <span style={{ fontSize: 10.5, color: T.faint }}>days between passes</span>
              </div>
            )}
          </div>
          <div>
            <div style={{ ...S.microLabel, marginBottom: 6 }}>Last done <span style={{ textTransform: "none", letterSpacing: 0 }}>(leave empty if never)</span></div>
            <input type="date" value={form.last_done} onChange={e => setForm(f => ({ ...f, last_done: e.target.value }))}
              style={{ ...S.input, padding: "8px 10px", fontSize: 13, fontFamily: mono, colorScheme: "inherit" }} />
          </div>
          <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes — filter size, oil type, who to call…"
            style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 12.5 }} />
          {saveErr && <div style={{ fontSize: 11, color: T.red }}>{saveErr}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} disabled={saving} style={{ ...S.brassBtn, flex: 1, padding: 10, fontSize: 11.5, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : form.isNew ? "Add to the rotation" : "Save changes"}</button>
            {!form.isNew && <button onClick={remove} disabled={saving} style={{ ...S.ghostBtn, padding: "10px 14px", fontSize: 11, color: T.red, borderColor: "var(--red-a32)" }}>Delete</button>}
            <button onClick={() => setForm(null)} style={{ ...S.ghostBtn, padding: "10px 14px", fontSize: 11 }}>Cancel</button>
          </div>
        </div>
      )}

      {rows === null && !loadErr ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="sk" style={{ height: 52, borderRadius: 10 }} />
          <div className="sk" style={{ height: 52, borderRadius: 10 }} />
        </div>
      ) : loadErr ? (
        <div style={{ ...S.inner, display: "flex", alignItems: "center", gap: 11, padding: "11px 13px" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: T.red, flex: "none" }} />
          <span style={{ fontSize: 10.5, color: T.faint, flex: 1 }}>{loadErr}</span>
          <button onClick={() => refetch()} style={{ ...S.ghostBtn, flex: "none", padding: "5px 10px", fontSize: 9.5, borderRadius: 7 }}>Retry</button>
        </div>
      ) : sorted.length === 0 && !form ? (
        <div style={{ ...S.inner, padding: "22px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, marginBottom: 5 }}>Nothing in the rotation yet</div>
          <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.6, marginBottom: 12 }}>Oil change, apartment AC filter, toothbrush heads — add the things you always remember two weeks late.</div>
          <button onClick={openNew} style={{ ...S.brassBtn, padding: "9px 18px", fontSize: 11 }}>Add the first one</button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {sorted.map(it => {
            const c = upkeepDueColor(it.meta);
            const lastLabel = it.last_done ? new Date(it.last_done + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "never";
            return (
              <div key={it.id} style={{ ...S.inner, padding: "11px 13px", display: "flex", alignItems: "center", gap: 11 }}>
                <span style={{ width: 7, height: 7, flex: "none", transform: "rotate(45deg)", borderRadius: 1.5, background: c, boxShadow: `0 0 8px ${tint(c, 45)}` }} />
                <span onClick={() => openEdit(it)} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
                  <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
                  <span style={{ display: "block", fontSize: 9.5, color: T.faint, marginTop: 2 }}>{upkeepIntervalLabel(it.interval_days)} · last {lastLabel}{it.notes ? ` · ${it.notes}` : ""}</span>
                </span>
                <span style={{ fontSize: 9, fontWeight: 700, color: c, fontFamily: mono, letterSpacing: "0.05em", flex: "none" }}>{upkeepDueText(it.meta)}</span>
                <button onClick={() => markDone(it)} title="Log it done today"
                  style={{ ...(doneFlash === it.id ? { background: T.green, color: "var(--chip-ink)", border: "none" } : S.ghostBtn), flex: "none", padding: "7px 11px", fontSize: 10, borderRadius: 8, fontWeight: 700 }}>
                  {doneFlash === it.id ? "Logged ✓" : "Done"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

