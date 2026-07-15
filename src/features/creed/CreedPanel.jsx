import { useState } from "react";
import { isMissingTable } from "../../data/db.js";
import { useAffirmations, useSaveAffirmation, useDeleteAffirmation } from "../../data/creed.js";
import { Card, SectionHeader, CellGroup, Button, TextArea, Segmented, Sheet, EmptyState, useConfirm, IcCheck } from "../../ui/kit.jsx";

// ─── Creed — the room where Cameron grounds himself ──────────────────────────
// One statement at a time, engraved large, a breathing seal above it. Two
// kinds of entries: creeds (what he holds true) and proofs (receipts — real
// things he built and did), because worth grounded in evidence holds better
// than worth asserted. Tap the plate to turn to the next.
const CREED_SETUP_SQL = `-- Board Room · Creed — one-time setup
create table if not exists public.affirmations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null,
  kind text not null default 'creed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.affirmations enable row level security;
drop policy if exists "affirmations own rows" on public.affirmations;
create policy "affirmations own rows" on public.affirmations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`;

const CREED_STARTERS = [
  { text: "My worth is not this week's output.", kind: "creed" },
  { text: "I build things that outlive the hours I put into them.", kind: "creed" },
  { text: "Pressure means I'm playing a real game, with real stakes, by choice.", kind: "creed" },
  { text: "Built Zero To Secure from an idea into a real product with real customers.", kind: "proof" },
];

const roman = (n) => {
  const map = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out || "—";
};

// (The old needs-setup branch referenced `mono` without importing it and
// white-screened; the SQL block now resolves the token via var() directly.)
const sqlPre = { background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", fontSize: 11, fontFamily: "var(--font-mono)", lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre", color: "var(--sub)", margin: 0 };
// Reset that lets a <button> wear the kit's .cell-body anatomy (rows keep a
// separate View button, so the whole cell can't be one <button> itself).
const rowBtn = { background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", alignSelf: "stretch", justifyContent: "center" };
const diamond = (size, color, extra) => ({ width: size, height: size, flex: "none", transform: "rotate(45deg)", borderRadius: size > 8 ? 2.5 : 1.5, background: color, ...extra });

export function CreedPanel({ isMobile }) {
  const { data: rows = null, error, refetch } = useAffirmations();
  const needsSetup = !!error && isMissingTable(error, "affirmations");
  const loadErr = error && !needsSetup ? (error.message || "Couldn't load the creed.") : null;
  const saveMut = useSaveAffirmation();
  const delMut = useDeleteAffirmation();
  const [copied, setCopied] = useState(false);
  const [idx, setIdx] = useState(0);
  const [form, setForm] = useState(null); // { id, text, kind, isNew }
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const list = rows || [];
  const current = list.length ? list[idx % list.length] : null;
  const turn = () => { if (list.length > 1) setIdx(i => (i + 1) % list.length); };

  const openNew = (seed) => { setSaveErr(null); setForm({ id: crypto.randomUUID(), text: seed?.text || "", kind: seed?.kind || "creed", isNew: true }); };
  const openEdit = (a) => { setSaveErr(null); setForm({ id: a.id, text: a.text, kind: a.kind || "creed", isNew: false }); };
  const save = () => {
    if (!form.text.trim()) { setSaveErr("Say it first."); return; }
    setSaving(true); setSaveErr(null);
    saveMut.mutate({ id: form.id, text: form.text.trim(), kind: form.kind }, {
      onSuccess: () => { setSaving(false); setForm(null); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't save."); },
    });
  };
  const remove = async () => {
    if (!(await confirm({ title: "Delete this entry?", message: "It comes off the plate for good.", confirmLabel: "Delete", destructive: true }))) return;
    setSaving(true);
    delMut.mutate(form.id, {
      onSuccess: () => { setSaving(false); setForm(null); setIdx(0); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't delete."); },
    });
  };
  const addStarter = (seed) => {
    saveMut.mutate({ id: crypto.randomUUID(), text: seed.text, kind: seed.kind }, { onError: (e) => setSaveErr(e.message || "Couldn't save.") });
  };
  // Jump the plate to entry i — both scrolls are needed: window for mobile,
  // #page-scroll for the app shell's scroll container.
  const view = (i) => {
    setIdx(i);
    window.scrollTo?.(0, 0);
    document.getElementById("page-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (needsSetup) return (
    <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="t-head">One-time setup</span>
      <span className="t-foot" style={{ lineHeight: 1.6 }}>
        The creed table doesn't exist yet. Paste this into the Supabase SQL editor (safe to re-run), then come back — everything else is already wired.
      </span>
      <pre style={sqlPre}>{CREED_SETUP_SQL}</pre>
      <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
        <Button kind="primary" size="md" onClick={() => { navigator.clipboard?.writeText(CREED_SETUP_SQL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {}); }}>
          {copied ? <><IcCheck size={15} /> Copied</> : "Copy SQL"}
        </Button>
        <Button kind="quiet" size="md" onClick={() => refetch()}>I ran it — retry</Button>
      </div>
    </Card>
  );

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      {/* ── the sanctum: one statement, engraved ── */}
      <Card pad="lg" onClick={current ? turn : undefined}
        style={{
          position: "relative", minHeight: isMobile ? 340 : 400,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          textAlign: "center", padding: isMobile ? "40px 26px" : "52px 56px",
          cursor: list.length > 1 ? "pointer" : "default",
          userSelect: "none", WebkitUserSelect: "none", // prevents iOS text-selection on tap-to-turn
          overflow: "hidden",
        }}>
        {rows === null && !loadErr ? (
          <div style={{ width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <div className="sk" style={{ width: 14, height: 14, borderRadius: 3 }} />
            <div className="sk sk-line w80" style={{ width: "80%" }} />
            <div className="sk sk-line w60" style={{ width: "60%" }} />
          </div>
        ) : loadErr ? (
          <EmptyState title="Couldn't load the creed" sub={loadErr}
            action={<Button kind="quiet" size="md" onClick={(e) => { e.stopPropagation(); refetch(); }}>Retry</Button>} />
        ) : !current ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, maxWidth: 420, width: "100%" }}>
            <span aria-hidden style={diamond(13, "var(--accent)", { marginBottom: 10, animation: "breathe 4s ease-in-out infinite" })} />
            <span className="t-head">Nothing engraved yet.</span>
            <span className="t-foot" style={{ lineHeight: 1.65, marginBottom: 8 }}>
              This room holds what's true about you when the week says otherwise — things you hold, and things you've done. Start with one of these, or carve your own.
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
              {CREED_STARTERS.map((s, i) => (
                <Button key={i} kind="quiet" size="md" onClick={(e) => { e.stopPropagation(); addStarter(s); }}
                  style={{ height: "auto", minHeight: 44, padding: "11px 16px", justifyContent: "flex-start", textAlign: "left", fontWeight: 500 }}>
                  <span className="t-call" style={{ lineHeight: 1.5 }}>
                    {s.text}
                    {s.kind === "proof" && <span className="t-cap" style={{ color: "var(--accent)", fontWeight: 600, marginLeft: 8 }}>Proof</span>}
                  </span>
                </Button>
              ))}
              <Button kind="primary" size="md" onClick={(e) => { e.stopPropagation(); openNew(); }}>Carve your own</Button>
            </div>
          </div>
        ) : (
          /* keyed + pagefade so every turn re-runs the entrance */
          <div key={current.id} className="pagefade" style={{ display: "flex", flexDirection: "column", alignItems: "center", maxWidth: 560 }}>
            <span aria-hidden style={diamond(13, "var(--accent)", { marginBottom: 22, animation: "breathe 4s ease-in-out infinite" })} />
            <span className="t-label" style={{ marginBottom: 16 }}>
              {current.kind === "proof" ? "Proof" : "Creed"} · {roman((idx % list.length) + 1)} / {roman(list.length)}
            </span>
            <div style={{
              fontWeight: 600, letterSpacing: "-0.015em", color: "var(--ink)", textWrap: "balance",
              lineHeight: current.text.length > 140 ? 1.6 : 1.45,
              fontSize: current.text.length > 140 ? (isMobile ? 16.5 : 20) : current.text.length > 70 ? (isMobile ? 19 : 24) : (isMobile ? 22 : 28),
            }}>
              {current.text}
            </div>
            {current.kind === "proof" && current.created_at && (
              <span className="t-cap" style={{ color: "var(--faint)", marginTop: 14 }}>Entered {new Date(current.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" })}</span>
            )}
            {list.length > 1 && <span className="t-cap" style={{ position: "absolute", bottom: 14, left: 0, right: 0, textAlign: "center", color: "var(--faint)" }}>Tap to turn</span>}
          </div>
        )}
      </Card>

      {/* ── the entries ── */}
      {rows !== null && !loadErr && (
        <div>
          <SectionHeader
            title="The entries"
            trailing={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {list.length > 0 && <span className="t-num" style={{ fontSize: 11, color: "var(--faint)" }}>{list.length}</span>}
                <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -8px" }} onClick={() => openNew()}>Add</button>
              </span>
            }
          />
          {list.length ? (
            <CellGroup>
              {list.map((a, i) => (
                <div key={a.id} className="cell has-leading" style={{ paddingRight: 10 }}>
                  <span className="cell-leading" aria-hidden>
                    <span style={diamond(7, a.kind === "proof" ? "var(--green)" : "var(--accent)")} />
                  </span>
                  <button className="cell-body" onClick={() => openEdit(a)} style={rowBtn}>
                    <span className="t-call" style={{ lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{a.text}</span>
                    <span className="cell-sub">
                      {a.kind === "proof"
                        ? `Proof${a.created_at ? ` · entered ${new Date(a.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" })}` : ""}`
                        : "Creed"}
                    </span>
                  </button>
                  <Button kind="quiet" size="sm" onClick={() => view(i)} style={{ height: 38, flex: "none" }}>View</Button>
                </div>
              ))}
            </CellGroup>
          ) : (
            <Card pad="md">
              <span className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.6 }}>Entries you add appear here — tap one to edit it.</span>
            </Card>
          )}
        </div>
      )}

      {/* ── engrave / edit — a sheet, not an inline box ── */}
      {form && (
        <Sheet onClose={() => setForm(null)} title={form.isNew ? "Engrave an entry" : "Edit entry"}
          footer={
            <>
              {!form.isNew && <Button kind="danger" size="lg" disabled={saving} onClick={remove}>Delete</Button>}
              <Button kind="primary" size="lg" disabled={saving} onClick={save} style={{ flex: 1 }}>{saving ? "Saving…" : form.isNew ? "Engrave it" : "Save"}</Button>
            </>
          }>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
            <Segmented value={form.kind} onChange={(k) => setForm(f => ({ ...f, kind: k }))}
              options={[{ key: "creed", label: "Creed — what I hold" }, { key: "proof", label: "Proof — what I've done" }]} />
            <TextArea value={form.text} onChange={e => setForm(f => ({ ...f, text: e.target.value }))} autoFocus rows={4}
              placeholder={form.kind === "proof" ? "Something real you built or did — a receipt." : "Something you hold true — present tense, yours."}
              style={{ lineHeight: 1.6, resize: "vertical" }} />
            {saveErr && <div className="t-foot" style={{ color: "var(--red)" }}>{saveErr}</div>}
          </div>
        </Sheet>
      )}
      {confirmEl}
    </section>
  );
}
