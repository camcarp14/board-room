import { useState } from "react";
import { callClaude } from "../../lib/claude.js";
import { nextBirthdayOccurrence, MONTH_NAMES } from "../../lib/dates.js";
import { useBirthdays, useSaveBirthday, useDeleteBirthday, useSaveBirthdaysBulk } from "../../data/birthdays.js";
import { Card, SectionHeader, CellGroup, Cell, Button, Field, TextArea, Switch, EmptyState, useConfirm } from "../../ui/kit.jsx";
import { IcGift, IcClose, IcChevronLeft } from "../../ui/icons.jsx";

// ─── Birthdays — sorted by days-until, with Claude-powered bulk paste ─────────
export function BirthdaysPanel({ isMobile }) {
  const { data: rows = null, error, refetch } = useBirthdays();
  const loadErr = error ? (error.message || "Couldn't load birthdays.") : null;
  const saveMut = useSaveBirthday();
  const delMut = useDeleteBirthday();
  const bulkMut = useSaveBirthdaysBulk();
  const [form, setForm] = useState(null); // single add/edit
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkParsing, setBulkParsing] = useState(false);
  const [bulkErr, setBulkErr] = useState(null);
  const [bulkPreview, setBulkPreview] = useState(null); // array of parsed rows awaiting confirmation
  const [bulkSaving, setBulkSaving] = useState(false);

  // ─── Single add/edit ───
  const openNew = () => {
    setSaveErr(null);
    const today = new Date();
    setForm({ id: crypto.randomUUID(), name: "", date: today.toISOString().slice(0, 10), unknownYear: true, notes: "" });
  };
  const openEdit = (b) => {
    setSaveErr(null);
    const y = b.year || new Date().getFullYear();
    const mm = String(b.month).padStart(2, "0"), dd = String(b.day).padStart(2, "0");
    setForm({ id: b.id, name: b.name, date: `${y}-${mm}-${dd}`, unknownYear: !b.year, notes: b.notes || "" });
  };
  const closeForm = () => setForm(null);

  const save = () => {
    if (!form.name.trim()) { setSaveErr("Give them a name."); return; }
    if (!form.date) { setSaveErr("Pick a date."); return; }
    const [y, m, d] = form.date.split("-").map(Number);
    setSaving(true); setSaveErr(null);
    saveMut.mutate({ id: form.id, name: form.name.trim(), month: m, day: d, year: form.unknownYear ? null : y, notes: form.notes }, {
      onSuccess: () => { setSaving(false); closeForm(); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't save."); },
    });
  };
  const removeBirthday = async (id, name) => {
    if (!(await confirm({ title: `Delete ${name || "this birthday"}?`, confirmLabel: "Delete", destructive: true }))) return;
    delMut.mutate(id, { onSuccess: () => { if (form?.id === id) closeForm(); } });
  };

  // ─── Bulk parse via Claude ───
  const parseBulk = async () => {
    if (!bulkText.trim()) return;
    setBulkParsing(true); setBulkErr(null); setBulkPreview(null);
    const system = `Extract birthdays from the text the user pastes. Respond with ONLY a JSON array, no markdown fences, no commentary — just the raw array. Each item: {"name": string, "month": 1-12, "day": 1-31, "year": number or null}. If a birth year isn't given or isn't confidently inferable, use null for year — never guess one. If a line doesn't look like a name+date, skip it rather than inventing data. If you truly cannot find any valid entries, respond with []`;
    const text = await callClaude({ system, messages: [{ role: "user", content: bulkText }], modelKey: "haiku", maxTokens: 2000, fn: "parse_birthdays" });
    setBulkParsing(false);
    if (!text) { setBulkErr("Couldn't reach Claude — try again in a moment."); return; }
    try {
      const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      const valid = parsed.filter(r => r && typeof r.name === "string" && r.name.trim() && Number(r.month) >= 1 && Number(r.month) <= 12 && Number(r.day) >= 1 && Number(r.day) <= 31);
      if (!valid.length) { setBulkErr("Didn't find any birthdays in that text — try a clearer format, e.g. one per line: \"Name — Month Day\"."); return; }
      setBulkPreview(valid.map(r => ({ tempId: crypto.randomUUID(), name: r.name.trim(), month: Number(r.month), day: Number(r.day), year: r.year ? Number(r.year) : null })));
    } catch {
      setBulkErr("Got an unexpected response back — try again, or simplify the text.");
    }
  };
  const removeFromPreview = (tempId) => setBulkPreview(rows => rows.filter(r => r.tempId !== tempId));
  const confirmBulk = () => {
    if (!bulkPreview?.length) return;
    setBulkSaving(true);
    bulkMut.mutate(bulkPreview.map(r => ({ id: crypto.randomUUID(), name: r.name, month: r.month, day: r.day, year: r.year })), {
      onSuccess: () => { setBulkSaving(false); setBulkPreview(null); setBulkText(""); setBulkOpen(false); },
      onError: (e) => { setBulkSaving(false); setBulkErr(e.message || "Couldn't save the batch."); },
    });
  };

  // ─── Form view — replaces the list (page-swap pattern, mobile-friendly) ───
  if (form) {
    const isEdit = rows?.some(b => b.id === form.id);
    return (
      <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Button kind="plain" size="sm" onClick={closeForm} style={{ height: 44, paddingLeft: 6, marginLeft: -6 }}><IcChevronLeft size={13} /> Cancel</Button>
            <span className="t-head">{isEdit ? "Edit birthday" : "New birthday"}</span>
            <span style={{ width: 86, flex: "none" }} />
          </div>
          <Field value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Name" autoFocus={!isEdit} style={{ fontWeight: 600 }} />
          {/* colorScheme: inherit — the native date picker follows the room's theme */}
          <Field type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="t-num" style={{ colorScheme: "inherit" }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 44 }}>
            <span className="t-call">Don't track birth year <span style={{ color: "var(--faint)" }}>(just month + day)</span></span>
            <Switch on={form.unknownYear} onToggle={() => setForm(f => ({ ...f, unknownYear: !f.unknownYear }))} aria-label="Year unknown" />
          </div>
          <TextArea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes (optional)" rows={3} style={{ lineHeight: 1.6, resize: "vertical" }} />
          {saveErr && <div className="t-foot" style={{ color: "var(--red)" }}>{saveErr}</div>}
          <div style={{ display: "flex", gap: 10 }}>
            <Button kind="primary" size="md" disabled={saving} onClick={save} style={{ flex: 1 }}>{saving ? "Saving…" : "Save"}</Button>
            {isEdit && <Button kind="danger" size="md" onClick={() => removeBirthday(form.id, form.name)}>Delete</Button>}
          </div>
        </Card>
        {confirmEl}
      </section>
    );
  }

  // ─── List view — grouped by the month of the next occurrence ───
  const sorted = (rows || []).map(b => ({ ...b, ...nextBirthdayOccurrence(b.month, b.day) })).sort((a, b) => a.daysUntil - b.daysUntil);
  const thisYear = new Date().getFullYear();
  const groups = [];
  for (const b of sorted) {
    const label = b.next.toLocaleDateString("en-US", { month: "long" }) + (b.next.getFullYear() !== thisYear ? ` ${b.next.getFullYear()}` : "");
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(b); else groups.push({ label, items: [b] });
  }
  const untilLabel = (d) => d === 0 ? "Today!" : d === 1 ? "Tomorrow" : `in ${d}d`;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <SectionHeader
        title="Birthdays"
        trailing={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <button className="sec-link" style={{ color: bulkOpen ? "var(--accent)" : "var(--sub)", padding: "10px 8px", margin: "-10px -2px" }}
              onClick={() => setBulkOpen(o => !o)}>
              {bulkOpen ? "Close bulk add" : "Bulk add"}
            </button>
            <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -8px" }} onClick={openNew}>Add</button>
          </span>
        }
      />

      {bulkOpen && (
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {!bulkPreview ? (
            <>
              <span className="t-foot" style={{ lineHeight: 1.6 }}>
                Paste anything — a list, a few sentences, whatever you've got. Claude will pull out names and dates; you'll get a chance to review before anything's saved.
              </span>
              <TextArea value={bulkText} onChange={e => setBulkText(e.target.value)} rows={6} placeholder={"e.g.\nMom - March 3\nJohn Smith 12/25/1990\nSarah's birthday is June 1st"} style={{ lineHeight: 1.6, resize: "vertical" }} />
              {bulkErr && <div className="t-foot" style={{ color: "var(--red)" }}>{bulkErr}</div>}
              <Button kind="primary" size="md" disabled={bulkParsing || !bulkText.trim()} onClick={parseBulk} style={{ alignSelf: "flex-start" }}>
                {bulkParsing ? "Parsing…" : "Parse with Claude"}
              </Button>
            </>
          ) : (
            <>
              <span className="t-foot">Found {bulkPreview.length} — review, then add.</span>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {bulkPreview.map((r, i) => (
                  <div key={r.tempId} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 46, padding: "3px 0", borderTop: i ? "0.5px solid var(--line)" : "none" }}>
                    <span className="t-call" style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    <span className="t-num" style={{ fontSize: 12, color: "var(--sub)", flex: "none" }}>{MONTH_NAMES[r.month - 1]} {r.day}{r.year ? `, ${r.year}` : ""}</span>
                    <button className="icon-btn" aria-label={`Remove ${r.name}`} onClick={() => removeFromPreview(r.tempId)} style={{ marginRight: -8 }}><IcClose size={15} /></button>
                  </div>
                ))}
              </div>
              {bulkErr && <div className="t-foot" style={{ color: "var(--red)" }}>{bulkErr}</div>}
              <div style={{ display: "flex", gap: 10 }}>
                <Button kind="primary" size="md" disabled={bulkSaving || !bulkPreview.length} onClick={confirmBulk}>
                  {bulkSaving ? "Adding…" : `Add all (${bulkPreview.length})`}
                </Button>
                <Button kind="quiet" size="md" onClick={() => { setBulkPreview(null); setBulkErr(null); }}>Start over</Button>
              </div>
            </>
          )}
        </Card>
      )}

      {loadErr && (
        <Card pad="md">
          <EmptyState icon={<IcGift size={24} />} title="Couldn't load birthdays" sub={loadErr}
            action={<Button kind="quiet" size="md" onClick={() => refetch()}>Retry</Button>} />
        </Card>
      )}
      {!loadErr && rows === null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0, 1, 2].map(i => <div key={i} className="sk" style={{ height: 52, borderRadius: 18 }} />)}
        </div>
      )}
      {!loadErr && rows && rows.length === 0 && !bulkOpen && (
        <Card pad="md">
          <EmptyState icon={<IcGift size={24} />} title="No birthdays yet"
            sub="Add one, or bulk-add a whole list at once."
            action={<Button kind="primary" size="md" onClick={openNew}>Add a birthday</Button>} />
        </Card>
      )}
      {!loadErr && groups.map(g => (
        <div key={g.label}>
          <SectionHeader title={g.label} />
          <CellGroup>
            {g.items.map(b => (
              <Cell key={b.id} onClick={() => openEdit(b)} chevron
                title={b.name}
                sub={`${MONTH_NAMES[b.month - 1]} ${b.day}${b.year ? ` · turns ${b.next.getFullYear() - b.year}` : ""}`}
                value={
                  <span className="t-num" style={{ fontSize: 12.5, fontWeight: 600, color: b.daysUntil <= 7 ? "var(--accent)" : "var(--faint)" }}>
                    {untilLabel(b.daysUntil)}
                  </span>
                }
              />
            ))}
          </CellGroup>
        </div>
      ))}
      {confirmEl}
    </section>
  );
}
