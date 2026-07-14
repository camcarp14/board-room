import { useState, useEffect } from "react";
import { T, syne, mono } from "../../theme.js";
import { S } from "../../ui/styles.js";
import { db } from "../../data/db.js";
import { callClaude } from "../../lib/claude.js";
import { nextBirthdayOccurrence, MONTH_NAMES } from "../../lib/dates.js";

export function BirthdaysPanel({ isMobile }) {
  const card = isMobile ? S.cardM : S.card;
  const [rows, setRows] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState(null);
  const [form, setForm] = useState(null); // single add/edit
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkParsing, setBulkParsing] = useState(false);
  const [bulkErr, setBulkErr] = useState(null);
  const [bulkPreview, setBulkPreview] = useState(null); // array of parsed rows awaiting confirmation
  const [bulkSaving, setBulkSaving] = useState(false);

  const refresh = () => {
    db.loadBirthdays().then(setRows).catch(e => setLoadErr(e.message || "Couldn't load birthdays."));
  };
  useEffect(() => { refresh(); }, []);

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
    db.saveBirthday({ id: form.id, name: form.name.trim(), month: m, day: d, year: form.unknownYear ? null : y, notes: form.notes })
      .then(() => { setSaving(false); closeForm(); refresh(); })
      .catch(e => { setSaving(false); setSaveErr(e.message || "Couldn't save."); });
  };
  const removeBirthday = (id, e) => {
    e.stopPropagation();
    if (!window.confirm("Delete this birthday?")) return;
    db.deleteBirthday(id).then(() => { if (form?.id === id) closeForm(); refresh(); });
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
    db.saveBirthdaysBulk(bulkPreview.map(r => ({ id: crypto.randomUUID(), name: r.name, month: r.month, day: r.day, year: r.year })))
      .then(() => { setBulkSaving(false); setBulkPreview(null); setBulkText(""); setBulkOpen(false); refresh(); })
      .catch(e => { setBulkSaving(false); setBulkErr(e.message || "Couldn't save the batch."); });
  };

  // ─── Form view ───
  if (form) {
    return (
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <button onClick={closeForm} style={{ background: "none", border: "none", color: T.brass, fontFamily: syne, fontWeight: 700, fontSize: 12, cursor: "pointer", padding: 0 }}>‹ Cancel</button>
          <span style={S.title}>{rows?.some(b => b.id === form.id) ? "Edit birthday" : "New birthday"}</span>
          <span style={{ width: 50 }} />
        </div>

        <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Name"
          style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 14, fontWeight: 700, fontFamily: syne, marginBottom: 10 }} />

        <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
          style={{ ...S.input, width: "100%", padding: "9px 10px", fontSize: 13, fontFamily: mono, marginBottom: 10 }} />

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 11.5, color: T.sub, cursor: "pointer" }}>
          <input type="checkbox" checked={form.unknownYear} onChange={e => setForm(f => ({ ...f, unknownYear: e.target.checked }))} />
          Don't track birth year (just month + day)
        </label>

        <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes (optional)" rows={3}
          style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 13, lineHeight: 1.6, resize: "vertical", marginBottom: 10 }} />

        {saveErr && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 8 }}>{saveErr}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...S.brassBtn, padding: "9px 18px", fontSize: 12, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save"}</button>
          {rows?.some(b => b.id === form.id) && (
            <button onClick={(e) => removeBirthday(form.id, e)} style={{ ...S.ghostBtn, padding: "9px 14px", fontSize: 12 }}>Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ─── List view ───
  const sorted = (rows || []).map(b => ({ ...b, ...nextBirthdayOccurrence(b.month, b.day) })).sort((a, b) => a.daysUntil - b.daysUntil);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <span style={S.title}>Birthdays</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setBulkOpen(o => !o)} style={{ ...S.ghostBtn, padding: "7px 14px", fontSize: 11.5 }}>{bulkOpen ? "Close bulk add" : "Bulk add"}</button>
            <button onClick={openNew} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11.5 }}>+ Add birthday</button>
          </div>
        </div>

        {bulkOpen && (
          <div style={{ ...S.inner, padding: 12, marginBottom: 12 }}>
            {!bulkPreview ? (
              <>
                <div style={{ fontSize: 10.5, color: T.sub, lineHeight: 1.6, marginBottom: 8 }}>
                  Paste anything — a list, a few sentences, whatever you've got. Claude will pull out names and dates; you'll get a chance to review before anything's saved.
                </div>
                <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} rows={6} placeholder={"e.g.\nMom - March 3\nJohn Smith 12/25/1990\nSarah's birthday is June 1st"}
                  style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 13, lineHeight: 1.6, resize: "vertical", marginBottom: 8 }} />
                {bulkErr && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 8 }}>{bulkErr}</div>}
                <button onClick={parseBulk} disabled={bulkParsing || !bulkText.trim()} style={{ ...S.brassBtn, padding: "8px 16px", fontSize: 11.5, opacity: (bulkParsing || !bulkText.trim()) ? 0.55 : 1 }}>
                  {bulkParsing ? "Parsing…" : "Parse with Claude"}
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 10.5, color: T.sub, marginBottom: 8 }}>Found {bulkPreview.length} — review, then add.</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10, maxHeight: 240, overflowY: "auto" }}>
                  {bulkPreview.map(r => (
                    <div key={r.tempId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: "7px 10px" }}>
                      <span style={{ fontSize: 12, fontFamily: syne, fontWeight: 700, color: T.ink }}>{r.name}</span>
                      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 11, color: T.sub, fontFamily: mono }}>{MONTH_NAMES[r.month - 1]} {r.day}{r.year ? `, ${r.year}` : ""}</span>
                        <button onClick={() => removeFromPreview(r.tempId)} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
                      </span>
                    </div>
                  ))}
                </div>
                {bulkErr && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 8 }}>{bulkErr}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={confirmBulk} disabled={bulkSaving || !bulkPreview.length} style={{ ...S.brassBtn, padding: "8px 16px", fontSize: 11.5, opacity: bulkSaving ? 0.6 : 1 }}>
                    {bulkSaving ? "Adding…" : `Add all (${bulkPreview.length})`}
                  </button>
                  <button onClick={() => { setBulkPreview(null); setBulkErr(null); }} style={{ ...S.ghostBtn, padding: "8px 14px", fontSize: 11.5 }}>Start over</button>
                </div>
              </>
            )}
          </div>
        )}

        {loadErr && <div style={{ fontSize: 11.5, color: T.faint, padding: "20px 0", textAlign: "center" }}>{loadErr}</div>}
        {!loadErr && rows === null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9, padding: "4px 0" }}>
            {[0, 1, 2].map(i => <div key={i} className="sk sk-line w60" style={{ margin: 0, height: 30, borderRadius: 9 }} />)}
          </div>
        )}
        {!loadErr && rows && rows.length === 0 && !bulkOpen && (
          <div style={{ fontSize: 11.5, color: T.faint, padding: "24px 0", textAlign: "center" }}>No birthdays yet — add one, or bulk-add a whole list at once.</div>
        )}
        {!loadErr && sorted.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {sorted.map(b => (
              <div key={b.id} onClick={() => openEdit(b)}
                style={{ ...S.inner, padding: "10px 12px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, color: T.ink }}>{b.name}</div>
                  <div style={{ fontSize: 11, color: T.sub }}>
                    {MONTH_NAMES[b.month - 1]} {b.day}{b.year ? ` · turns ${b.next.getFullYear() - b.year}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                  <span style={{ ...S.microLabel, color: b.daysUntil <= 7 ? T.brass : T.faint }}>
                    {b.daysUntil === 0 ? "Today!" : b.daysUntil === 1 ? "Tomorrow" : `in ${b.daysUntil}d`}
                  </span>
                  <button onClick={(e) => removeBirthday(b.id, e)} aria-label="Delete" style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 14, padding: 2, lineHeight: 1 }}>×</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

