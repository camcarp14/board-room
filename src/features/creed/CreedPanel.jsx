import { useState } from "react";
import { T, syne } from "../../theme.js";
import { S } from "../../ui/styles.js";
import { isMissingTable } from "../../data/db.js";
import { useAffirmations, useSaveAffirmation, useDeleteAffirmation } from "../../data/creed.js";

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

export function CreedPanel({ isMobile }) {
  const card = isMobile ? S.cardM : S.card;
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
  const remove = () => {
    setSaving(true);
    delMut.mutate(form.id, {
      onSuccess: () => { setSaving(false); setForm(null); setIdx(0); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't delete."); },
    });
  };
  const addStarter = (seed) => {
    saveMut.mutate({ id: crypto.randomUUID(), text: seed.text, kind: seed.kind }, { onError: (e) => setSaveErr(e.message || "Couldn't save.") });
  };

  if (needsSetup) return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={S.title}>Creed · One-Time Setup</span>
      </div>
      <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.65, marginBottom: 12 }}>
        The creed table doesn't exist yet. Paste this into the Supabase SQL editor (safe to re-run), then come back — everything else is already wired.
      </div>
      <pre style={{ ...S.inner, margin: 0, padding: "12px 14px", fontSize: 10, fontFamily: mono, color: T.sub, lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre" }}>{CREED_SETUP_SQL}</pre>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => { navigator.clipboard?.writeText(CREED_SETUP_SQL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {}); }} style={{ ...S.brassBtn, padding: "9px 16px", fontSize: 11 }}>{copied ? "Copied ✓" : "Copy SQL"}</button>
        <button onClick={() => refetch()} style={{ ...S.ghostBtn, padding: "9px 16px", fontSize: 11 }}>I ran it — retry</button>
      </div>
    </div>
  );

  return (
    <>
      {/* ── the sanctum: one statement, engraved ── */}
      <div onClick={current ? turn : undefined}
        style={{
          ...card, position: "relative", minHeight: isMobile ? 340 : 400,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          textAlign: "center", padding: isMobile ? "36px 26px" : "48px 56px",
          background: "linear-gradient(180deg, var(--brass-a06), transparent 60%)",
          border: "1px solid var(--brass-a20)",
          cursor: list.length > 1 ? "pointer" : "default", userSelect: "none", WebkitUserSelect: "none",
          overflow: "hidden",
        }}>
        {rows === null && !loadErr ? (
          <div style={{ width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <div className="sk" style={{ width: 14, height: 14, borderRadius: 3 }} />
            <div className="sk sk-line w80" style={{ width: "80%" }} />
            <div className="sk sk-line w60" style={{ width: "60%" }} />
          </div>
        ) : loadErr ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: T.faint }}>{loadErr}</span>
            <button onClick={(e) => { e.stopPropagation(); refetch(); }} style={{ ...S.ghostBtn, padding: "7px 14px", fontSize: 10.5 }}>Retry</button>
          </div>
        ) : !current ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, maxWidth: 420 }}>
            <span style={{ width: 13, height: 13, transform: "rotate(45deg)", borderRadius: 2.5, background: T.brass, marginBottom: 8, animation: "breathe 4s ease-in-out infinite" }} />
            <div style={{ fontSize: 17, fontWeight: 700, fontFamily: syne, color: T.ink }}>Nothing engraved yet.</div>
            <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.7, marginBottom: 6 }}>
              This room holds what's true about you when the week says otherwise — things you hold, and things you've done. Start with one of these, or carve your own.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, width: "100%" }}>
              {CREED_STARTERS.map((s, i) => (
                <button key={i} onClick={(e) => { e.stopPropagation(); addStarter(s); }}
                  style={{ ...S.ghostBtn, padding: "10px 14px", fontSize: 11.5, textAlign: "left", lineHeight: 1.5, fontFamily: "inherit" }}>
                  {s.text} {s.kind === "proof" && <span style={{ ...S.microLabel, color: T.brass, marginLeft: 6 }}>PROOF</span>}
                </button>
              ))}
              <button onClick={(e) => { e.stopPropagation(); openNew(); }} style={{ ...S.brassBtn, padding: "11px 14px", fontSize: 11.5 }}>Carve your own</button>
            </div>
          </div>
        ) : (
          <div key={current.id} className="pagefade" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0, maxWidth: 560 }}>
            <span style={{ width: 13, height: 13, transform: "rotate(45deg)", borderRadius: 2.5, background: T.brass, animation: "breathe 4s ease-in-out infinite", marginBottom: 22 }} />
            <span style={{ ...S.microLabel, letterSpacing: "0.22em", marginBottom: 16 }}>
              {current.kind === "proof" ? "PROOF" : "CREED"} · {roman((idx % list.length) + 1)} / {roman(list.length)}
            </span>
            <div style={{
              fontFamily: syne, fontWeight: 700, color: T.ink, textWrap: "balance", lineHeight: 1.45,
              fontSize: current.text.length > 140 ? (isMobile ? 16.5 : 20) : current.text.length > 70 ? (isMobile ? 19 : 24) : (isMobile ? 22 : 28),
            }}>
              {current.text}
            </div>
            {current.kind === "proof" && current.created_at && (
              <span style={{ ...S.microLabel, marginTop: 14 }}>ENTERED {new Date(current.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" }).toUpperCase()}</span>
            )}
            {list.length > 1 && <span style={{ ...S.microLabel, position: "absolute", bottom: 14, left: 0, right: 0, textAlign: "center", color: T.faint, letterSpacing: "0.14em" }}>TAP TO TURN</span>}
          </div>
        )}
      </div>

      {/* ── the entries ── */}
      {rows !== null && !loadErr && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: list.length || form ? 12 : 0 }}>
            <span style={S.title}>The Entries{list.length ? <span style={{ ...S.microLabel, marginLeft: 8 }}>{list.length}</span> : null}</span>
            {!form && <button onClick={() => openNew()} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11.5 }}>+ Add</button>}
          </div>

          {form && (
            <div style={{ ...S.inner, padding: "14px 15px", marginBottom: list.length ? 12 : 0, display: "flex", flexDirection: "column", gap: 10 }}>
              <textarea value={form.text} onChange={e => setForm(f => ({ ...f, text: e.target.value }))} autoFocus rows={3}
                placeholder={form.kind === "proof" ? "Something real you built or did — a receipt." : "Something you hold true — present tense, yours."}
                style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 13, lineHeight: 1.6, resize: "vertical", fontFamily: "inherit" }} />
              <div style={{ display: "flex", gap: 7 }}>
                {[["creed", "Creed — what I hold"], ["proof", "Proof — what I've done"]].map(([k, label]) => (
                  <button key={k} onClick={() => setForm(f => ({ ...f, kind: k }))}
                    style={{ flex: 1, padding: "8px 10px", background: form.kind === k ? "var(--brass-a12)" : "var(--ink-a03)", border: `1px solid ${form.kind === k ? "var(--brass-a40)" : "var(--ink-a08)"}`, borderRadius: 9, color: form.kind === k ? T.brass : T.sub, fontSize: 10.5, fontWeight: 700, fontFamily: syne, cursor: "pointer" }}>
                    {label}
                  </button>
                ))}
              </div>
              {saveErr && <div style={{ fontSize: 11, color: T.red }}>{saveErr}</div>}
              <div style={{ display: "flex", gap: 7 }}>
                <button onClick={save} disabled={saving} style={{ ...S.brassBtn, flex: 1, padding: "10px 0", fontSize: 11.5, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : form.isNew ? "Engrave it" : "Save"}</button>
                <button onClick={() => setForm(null)} style={{ ...S.ghostBtn, padding: "10px 14px", fontSize: 11 }}>Cancel</button>
                {!form.isNew && <button onClick={remove} disabled={saving} style={{ ...S.ghostBtn, padding: "10px 14px", fontSize: 11, color: T.red, borderColor: "var(--red-a32)" }}>Delete</button>}
              </div>
            </div>
          )}

          {list.map((a, i) => (
            <div key={a.id} onClick={() => openEdit(a)} className="press"
              style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "10px 2px", borderTop: i === 0 ? "none" : "1px solid var(--ink-a04)", cursor: "pointer" }}>
              <span style={{ width: 6, height: 6, flex: "none", transform: "rotate(45deg) translateY(-1px)", borderRadius: 1.5, background: a.kind === "proof" ? T.green : T.brass }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: T.ink, lineHeight: 1.55, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{a.text}</span>
              <span onClick={(e) => { e.stopPropagation(); setIdx(i); window.scrollTo?.(0, 0); document.getElementById("page-scroll")?.scrollTo({ top: 0, behavior: "smooth" }); }}
                style={{ ...S.microLabel, color: T.brass, flex: "none", cursor: "pointer" }}>VIEW ›</span>
            </div>
          ))}
          {!form && !list.length && (
            <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.6 }}>Entries you add appear here — tap one to edit it.</div>
          )}
        </div>
      )}
    </>
  );
}
