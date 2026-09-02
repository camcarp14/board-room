import { useState, useMemo, useRef, useEffect } from "react";
import { isMissingTable } from "../../data/db.js";
import { useAffirmations, useSaveAffirmation, useDeleteAffirmation, useRestoreAffirmation } from "../../data/creed.js";
import { Card, SectionHeader, CellGroup, Button, TextArea, PillRow, Pill, Sheet, EmptyState, useConfirm, IcCheck, closeSheet } from "../../ui/kit.jsx";
import { KINDS, kindMeta, splitQuote, dailyIndex, dayKey, countsByKind, filterByKind, STARTERS } from "./creedLogic.js";

// ─── Creed — the room where Cameron grounds himself ──────────────────────────
// One statement at a time, engraved large, a breathing seal above it. Tap the
// plate to turn to the next.
//
// It holds FIVE kinds now, not two — creed, proof, goal, quote, why — because
// they answer different questions and motivate differently. `kind` was already
// a free-text column with a default, so all five are values the table can hold
// today: no migration, no backfill, and a row with a kind this build has never
// heard of falls back to Creed rather than disappearing. creedLogic.js owns the
// list and everything derived from it.
//
// THE DAY'S LINE. The plate opens on an entry chosen from the date, so it holds
// still all day and is the same on every device without storing anything. A
// room you open for grounding that reshuffles on every glance isn't grounding;
// it's a slot machine. Tapping still turns the page — the daily pick is where
// you START, not a cage.
// `boardroom`, not `public`: supabase.js pins the client to that schema, so a
// table created in public is one this app can never see. This block said public
// for as long as it has existed — harmless only because the live table predates
// the schema move and already sits in boardroom, so nobody ever ran it. The
// Dream board copied the mistake and it cost a round trip; both are corrected,
// and scripts/dreams-smoke.mjs now checks every setup block against the schema
// the client is actually configured with.
const CREED_SETUP_SQL = `-- Board Room · Creed — one-time setup
-- Safe to run as many times as you like.
create schema if not exists boardroom;

create table if not exists boardroom.affirmations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null,
  kind text not null default 'creed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Nullable, no default: a default of now() would mark every row deleted the
  -- moment this ran. Deleting a line writes this column instead of removing the
  -- row, and db.js's readers filter on it — so a table built without it reads
  -- fine but refuses every delete. See supabase/migrations/0013_affirmations.sql.
  deleted_at timestamptz
);
alter table boardroom.affirmations enable row level security;
drop policy if exists "affirmations own rows" on boardroom.affirmations;
create policy "affirmations own rows" on boardroom.affirmations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- RLS filters; it does not grant.
grant usage on schema boardroom to anon, authenticated;
grant select, insert, update, delete on boardroom.affirmations to authenticated;`;

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

const entered = (ts) => ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "";

export function CreedPanel({ isMobile }) {
  const { data: rows = null, error, refetch } = useAffirmations();
  const needsSetup = !!error && isMissingTable(error, "affirmations");
  const loadErr = error && !needsSetup ? (error.message || "Couldn't load the creed.") : null;
  const saveMut = useSaveAffirmation();
  const delMut = useDeleteAffirmation();
  const restoreMut = useRestoreAffirmation();
  const [copied, setCopied] = useState(false);
  const [kind, setKind] = useState("");        // filter — "" is everything
  const [turned, setTurned] = useState(0);     // how many times you've tapped the plate
  const [form, setForm] = useState(null);      // { id, text, kind, isNew }
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  // Starters save from the room itself, with no sheet open — so their failure
  // cannot share `saveErr`, which only the sheet draws. This one is drawn under
  // "Add to the room", where the tap happened.
  const [starterErr, setStarterErr] = useState(null);
  // ─── undo ───
  // The delete is a soft one (deleted_at, see db.deleteAffirmation), so the id
  // is the whole undo: useRestoreAffirmation clears the stamp and the line comes
  // back with its number, because created_at never moved. This toast is the only
  // way back the panel offers — the row is kept in the table for thirty days
  // after, but nothing on screen reaches it, so the confirm does not promise it.
  // { kind: "undo", label, id } | { kind: "err", text }
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (t, ms) => { clearTimeout(toastTimer.current); setToast(t); toastTimer.current = setTimeout(() => setToast(null), ms); };
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const runUndo = () => {
    const t = toast; setToast(null); clearTimeout(toastTimer.current);
    if (t?.kind !== "undo") return;
    restoreMut.mutate(t.id, { onError: (e) => showToast({ kind: "err", text: e.message || "Couldn't undo." }, 5000) });
  };
  const [confirmEl, confirm] = useConfirm();

  const all = rows || [];
  const counts = useMemo(() => countsByKind(all), [all]);
  // The plate follows the filter: pick Goal and it becomes a goal you're
  // looking at, not a goal you have to hunt for in the list underneath.
  const list = useMemo(() => filterByKind(all, kind), [all, kind]);
  // The day decides where you start; your taps move from there. Recomputed per
  // render is fine and correct — it only changes at midnight.
  const start = dailyIndex(list.length, dayKey(new Date()));
  const pos = list.length ? (start + turned) % list.length : 0;
  const current = list.length ? list[pos] : null;
  const meta = current ? kindMeta(current.kind) : null;
  const quote = current && meta?.key === "quote" ? splitQuote(current.text) : null;
  const body = quote ? quote.body : current?.text || "";

  const turn = () => { if (list.length > 1) setTurned((t) => t + 1); };
  const pick = (k) => { setKind(k); setTurned(0); };

  const openNew = (seedKind, seedText) => {
    setSaveErr(null);
    setForm({ id: crypto.randomUUID(), text: seedText || "", kind: seedKind || kind || "creed", isNew: true });
  };
  // Populated by the Sheet below while it is mounted. See closeSheet in ui/kit.jsx.
  const sheetClose = useRef(null);
  const openEdit = (a) => { setSaveErr(null); setForm({ id: a.id, text: a.text, kind: kindMeta(a.kind).key, isNew: false }); };
  const save = () => {
    if (!form.text.trim()) { setSaveErr("Say it first."); return; }
    setSaving(true); setSaveErr(null);
    saveMut.mutate({ id: form.id, text: form.text.trim(), kind: form.kind }, {
      // closeSheet, not setForm(null): the write lands in the PARENT's scope, so
      // flipping `form` here unmounts the sheet that frame and it vanishes with a
      // cut, no matter what exit animation the kit owns. The handle plays the exit
      // first and clears the form after it — and falls back to clearing directly if
      // the sheet is somehow already gone, so Save can never read as dead.
      onSuccess: () => { setSaving(false); closeSheet(sheetClose, () => setForm(null)); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't save."); },
    });
  };
  const remove = async () => {
    // "for good" stopped being true when the delete became a soft one, and
    // "Recoverable for 30 days" was the other kind of untrue: the row does stay
    // that long, but the only recovery this screen offers is the Undo toast that
    // follows. The sentence promises exactly what the panel can do. The Roman
    // numerals do not renumber on the way back because created_at is untouched.
    if (!(await confirm({ title: "Delete this entry?", message: "It comes off the plate. You get a few seconds to undo.", confirmLabel: "Delete", destructive: true }))) return;
    setSaving(true);
    const id = form.id;
    delMut.mutate(id, {
      onSuccess: () => { setSaving(false); closeSheet(sheetClose, () => { setForm(null); setTurned(0); }); showToast({ kind: "undo", label: "Entry removed", id }, 6000); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't delete."); },
    });
  };
  // The pills are disabled while a save is in flight (below): each tap minted a
  // fresh id, so a second tap on a slow connection engraved the same line twice.
  const addStarter = (k, text) => {
    setStarterErr(null);
    saveMut.mutate({ id: crypto.randomUUID(), text, kind: k }, { onError: (e) => setStarterErr(e.message || "Couldn't save.") });
  };
  // Jump the plate to a specific entry — both scrolls are needed: window for
  // mobile, #page-scroll for the app shell's scroll container.
  const view = (i) => {
    setTurned(((i - start) % list.length + list.length) % list.length);
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
      {/* SIZED TO ITS CONTENT, not to a fixed 340px. It used to reserve most of a
          phone screen to centre nine words in it, which pushed the filters and
          every entry below the fold — the room's own contents were the thing you
          had to scroll to reach. Generous padding still gives the statement air;
          it just no longer buys emptiness by the inch. */}
      <Card pad="lg" onClick={current ? turn : undefined}
        style={{
          position: "relative",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          textAlign: "center", padding: isMobile ? "22px 22px 26px" : "30px 44px 34px",
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
          <EmptyRoom kind={kind} total={counts[""]} onAdd={(e) => { e.stopPropagation(); openNew(kind || "creed"); }}
            onClear={(e) => { e.stopPropagation(); pick(""); }} />
        ) : (
          /* keyed + pagefade so every turn re-runs the entrance */
          <div key={`${current.id}-${turned}`} className="pagefade" style={{ display: "flex", flexDirection: "column", alignItems: "center", maxWidth: 560, width: "100%" }}>
            {/* Seal and label share a line now. Stacked, they cost ~35px of pure
                chrome above a sentence that is the entire point of the card. */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
              <span aria-hidden style={diamond(10, meta.tone, { animation: "breathe 4s ease-in-out infinite" })} />
              <span className="t-label" style={{ color: meta.tone }}>
                {meta.plate} · {roman(pos + 1)} / {roman(list.length)}
              </span>
            </span>
            <div style={{
              fontWeight: 600, letterSpacing: "-0.015em", color: "var(--ink)", textWrap: "balance",
              lineHeight: body.length > 140 ? 1.55 : 1.4, whiteSpace: "pre-line",
              fontSize: body.length > 140 ? (isMobile ? 16 : 19) : body.length > 70 ? (isMobile ? 18.5 : 22) : (isMobile ? 21 : 26),
              ...(quote ? { fontStyle: "italic" } : null),
            }}>
              {quote ? `“${body}”` : body}
            </div>
            {/* An attribution is the one thing on the plate that isn't yours,
                so it gets its own line and steps back a weight. */}
            {quote?.author && (
              <span className="t-call" style={{ color: "var(--sub)", marginTop: 16 }}>— {quote.author}</span>
            )}
            {meta.key === "proof" && current.created_at && (
              <span className="t-cap" style={{ color: "var(--faint)", marginTop: 14 }}>Entered {entered(current.created_at)}</span>
            )}
          </div>
        )}
        {/* In normal flow, not absolutely positioned. The card is content-sized
            now, so there is no reserved floor to pin a hint to — and the old
            absolute version was resolving against the .pagefade block's
            transform anyway, which printed it through the statement. */}
        {current && list.length > 1 && (
          <span className="t-cap" style={{ color: "var(--faint)", marginTop: 16 }}>Tap to turn</span>
        )}
      </Card>

      {rows !== null && !loadErr && (
        <>
          {/* ── what you're looking at. Counts, because a filter that can only
                say "nothing here" can't say "and there are six goals". ── */}
          {counts[""] > 0 && (
            <PillRow
              options={[
                { key: "", label: `All ${counts[""]}` },
                ...KINDS.filter((k) => counts[k.key] > 0).map((k) => ({ key: k.key, label: `${k.label} ${counts[k.key]}` })),
              ]}
              value={kind}
              onChange={pick}
            />
          )}

          {/* ── the entries ── */}
          <div>
            <SectionHeader
              title={kind ? kindMeta(kind).label : "The entries"}
              trailing={
                <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -8px" }} onClick={() => openNew()}>Add</button>
              }
            />
            {list.length ? (
              <CellGroup>
                {list.map((a, i) => {
                  const m = kindMeta(a.kind);
                  const q = m.key === "quote" ? splitQuote(a.text) : null;
                  return (
                    <div key={a.id} className="cell has-leading" style={{ paddingRight: 10 }}>
                      <span className="cell-leading" aria-hidden><span style={diamond(7, m.tone)} /></span>
                      <button className="cell-body" onClick={() => openEdit(a)} style={rowBtn}>
                        <span className="t-call" style={{ lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                          {q ? q.body : a.text}
                        </span>
                        <span className="cell-sub">
                          {m.label}
                          {q?.author ? ` · ${q.author}` : ""}
                          {m.key === "proof" && a.created_at ? ` · entered ${entered(a.created_at)}` : ""}
                        </span>
                      </button>
                      <Button kind="quiet" size="sm" onClick={() => view(i)} style={{ height: 38, flex: "none" }}>View</Button>
                    </div>
                  );
                })}
              </CellGroup>
            ) : (
              <Card pad="md">
                <span className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.6 }}>Entries you add appear here — tap one to edit it.</span>
              </Card>
            )}
          </div>

          {/* ── what else this room can hold. Not a help text: every line is a
                one-tap add, because "options for what I can include" is only
                useful if choosing one is the same gesture as reading it. ── */}
          <div>
            <SectionHeader title="Add to the room" />
            {starterErr && <div className="t-foot" style={{ color: "var(--red)", padding: "0 4px 8px" }}>{starterErr}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {KINDS.map((k) => (
                <Card key={k.key} pad="md" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span aria-hidden style={diamond(8, k.tone)} />
                    <span className="t-call" style={{ fontWeight: 650 }}>{k.label}</span>
                    <span className="t-cap" style={{ color: "var(--faint)", flex: 1, minWidth: 0 }}>{k.blurb}</span>
                    <Button kind="tinted" size="sm" onClick={() => openNew(k.key)} style={{ flex: "none" }}>Add</Button>
                  </div>
                  <span className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.55 }}>{k.hint}</span>
                  {/* Starters are only offered for kinds you haven't started —
                      once you have your own, suggestions are clutter. They may
                      shrink (the kit's .pill is flex: none) or a sentence-long
                      proof runs past the card edge instead of wrapping. */}
                  {counts[k.key] === 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {(STARTERS[k.key] || []).map((text, i) => (
                        <Pill key={i} onClick={() => addStarter(k.key, text)} disabled={saveMut.isPending}
                          style={{ textAlign: "left", height: "auto", minHeight: 34, padding: "7px 12px", whiteSpace: "normal", lineHeight: 1.45, flex: "0 1 auto", ...(saveMut.isPending ? { opacity: 0.45, cursor: "default" } : null) }}>
                          {splitQuote(text).body}
                        </Pill>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── engrave / edit — a sheet, not an inline box ── */}
      {form && (
        <Sheet closeRef={sheetClose} onClose={() => setForm(null)} title={form.isNew ? "Engrave an entry" : "Edit entry"}
          footer={
            <>
              {!form.isNew && <Button kind="danger" size="lg" disabled={saving} onClick={remove}>Delete</Button>}
              <Button kind="primary" size="lg" disabled={saving} onClick={save} style={{ flex: 1 }}>{saving ? "Saving…" : form.isNew ? "Engrave it" : "Save"}</Button>
            </>
          }>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
            {/* PillRow, not Segmented: five kinds is past Segmented's ≤4
                equal-width ceiling (DESIGN.md §6). */}
            <PillRow options={KINDS.map((k) => ({ key: k.key, label: k.label }))}
              value={form.kind} onChange={(k) => setForm((f) => ({ ...f, kind: k }))} />
            <span className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.55 }}>{kindMeta(form.kind).hint}</span>
            <TextArea value={form.text} onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))} autoFocus rows={4}
              placeholder={kindMeta(form.kind).prompt}
              style={{ lineHeight: 1.6, resize: "vertical" }} />
            {saveErr && <div className="t-foot" style={{ color: "var(--red)" }}>{saveErr}</div>}
          </div>
        </Sheet>
      )}
      {toast && (
        <div className="toasts">
          {toast.kind === "err" ? (
            <div className="toast err"><span className="tdot" /><span>{toast.text}</span></div>
          ) : (
            <div className="toast">
              <span>{toast.label}</span>
              <button onClick={runUndo} style={{ background: "none", border: "none", color: "var(--accent)", fontWeight: 600, fontSize: 13.5, cursor: "pointer", padding: "6px 4px", margin: "-6px 0" }}>Undo</button>
            </div>
          )}
        </div>
      )}
      {confirmEl}
    </section>
  );
}

/* Empty is two different states and they need different answers: a room with
   nothing in it at all, and a filter you've narrowed to nothing. Showing the
   "start here" copy for the second one would be telling you the room is empty
   while eleven entries sit one tap away. */
function EmptyRoom({ kind, total, onAdd, onClear }) {
  const m = kind ? kindMeta(kind) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, maxWidth: 420, width: "100%" }}>
      <span aria-hidden style={diamond(13, m?.tone || "var(--accent)", { marginBottom: 10, animation: "breathe 4s ease-in-out infinite" })} />
      <span className="t-head">{m ? `No ${m.label.toLowerCase()} yet.` : "Nothing engraved yet."}</span>
      <span className="t-foot" style={{ lineHeight: 1.65, marginBottom: 8 }}>
        {m
          ? `${m.blurb[0].toUpperCase()}${m.blurb.slice(1)}. ${m.hint}`
          : "This room holds what's true about you when the week says otherwise — what you hold, what you've done, where you're going, and who it's for. Pick a kind below to start."}
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="primary" size="md" onClick={onAdd}>{m ? `Add a ${m.label.toLowerCase()}` : "Add your first"}</Button>
        {total > 0 && <Button kind="quiet" size="md" onClick={onClear}>Show all {total}</Button>}
      </div>
    </div>
  );
}
