// ─── Anniversaries — the days that already happened ──────────────────────────
// The list beside Birthdays, for the other direction in time: the day somebody
// died, and any other date worth being reminded of on its anniversary — a start
// date, a move, a day that mattered. Every row lands on the Personal calendar
// the same way a birthday does (lib/calendar-overlays.js), so nothing here has
// to be entered twice.
//
// ONE TOGGLE, TWO JOBS, and they're deliberately the same control at two
// scales: the segmented row at the top filters the list, and the one in the
// form sets what a row IS. Learning "passing vs milestone" once should be
// enough to both file a date and find it again.
//
// The shape of this panel — page-swap form, month groups, days-until on the
// right — is BirthdaysPanel's, on purpose. They are two answers to the same
// question and sit one pill apart; making the second one look clever would
// just make it look unfamiliar.
import { useState } from "react";
import { MONTH_NAMES } from "../../lib/dates.js";
import {
  ANNIVERSARY_KINDS, DEFAULT_KIND, anniversaryLine, kindMeta,
  sortByNextOccurrence, filterByKind,
} from "../../lib/anniversaries.js";
import { useAnniversaries, useSaveAnniversary, useDeleteAnniversary } from "../../data/anniversaries.js";
import { Card, SectionHeader, CellGroup, Cell, Button, Field, TextArea, Segmented, Switch, EmptyState, useConfirm } from "../../ui/kit.jsx";
import { IcHeart, IcChevronLeft } from "../../ui/icons.jsx";

const FILTERS = [{ key: "all", label: "All" }, ...ANNIVERSARY_KINDS.map((k) => ({ key: k.key, label: k.plural }))];
const KIND_OPTIONS = ANNIVERSARY_KINDS.map((k) => ({ key: k.key, label: k.label }));

const untilLabel = (d) => (d === 0 ? "Today" : d === 1 ? "Tomorrow" : `in ${d}d`);

export function AnniversariesPanel({ isMobile }) {
  const { data: rows = null, error, refetch } = useAnniversaries();
  const loadErr = error ? (error.message || "Couldn't load anniversaries.") : null;
  const saveMut = useSaveAnniversary();
  const delMut = useDeleteAnniversary();
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const openNew = () => {
    setSaveErr(null);
    const today = new Date();
    const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    // A new row starts as whatever you're currently looking at: adding three
    // passings in a row shouldn't mean setting the same toggle three times.
    setForm({ id: crypto.randomUUID(), name: "", kind: filter === "all" ? DEFAULT_KIND : filter, date: local, unknownYear: false, notes: "" });
  };
  const openEdit = (a) => {
    setSaveErr(null);
    const y = a.year || new Date().getFullYear();
    const mm = String(a.month).padStart(2, "0"), dd = String(a.day).padStart(2, "0");
    setForm({ id: a.id, name: a.name, kind: a.kind, date: `${y}-${mm}-${dd}`, unknownYear: !a.year, notes: a.notes || "" });
  };
  const closeForm = () => setForm(null);

  const save = () => {
    if (!form.name.trim()) { setSaveErr("Give it a name."); return; }
    if (!form.date) { setSaveErr("Pick a date."); return; }
    const [y, m, d] = form.date.split("-").map(Number);
    setSaving(true); setSaveErr(null);
    saveMut.mutate(
      { id: form.id, name: form.name.trim(), kind: form.kind, month: m, day: d, year: form.unknownYear ? null : y, notes: form.notes },
      {
        onSuccess: () => { setSaving(false); closeForm(); },
        onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't save."); },
      },
    );
  };
  const remove = async (id, name) => {
    if (!(await confirm({ title: `Delete ${name || "this date"}?`, body: "It stops appearing on the calendar.", confirmLabel: "Delete", destructive: true }))) return;
    delMut.mutate(id, { onSuccess: () => { if (form?.id === id) closeForm(); } });
  };

  // ─── Form view — replaces the list, same page-swap as Birthdays ───
  if (form) {
    const isEdit = (rows || []).some((a) => a.id === form.id);
    const passing = form.kind === "passing";
    return (
      <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Button kind="plain" size="sm" onClick={closeForm} style={{ height: 44, paddingLeft: 6, marginLeft: -6 }}><IcChevronLeft size={13} /> Cancel</Button>
            <span className="t-head">{isEdit ? "Edit date" : "New date"}</span>
            <span style={{ width: 86, flex: "none" }} />
          </div>
          {/* The toggle. It changes the words the app uses about this date —
              on the calendar, in the list, in the empty states — and nothing
              else: both kinds repeat annually and both draw the same way. */}
          <Segmented options={KIND_OPTIONS} value={form.kind} onChange={(k) => setForm((f) => ({ ...f, kind: k }))} />
          <Field value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={passing ? "Who" : "What happened"} autoFocus={!isEdit} style={{ fontWeight: 600 }} />
          {/* colorScheme: inherit — the native date picker follows the room's theme */}
          <Field type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className="t-num" style={{ colorScheme: "inherit" }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 44 }}>
            <span className="t-call">Don't track the year <span style={{ color: "var(--faint)" }}>(just month + day)</span></span>
            <Switch on={form.unknownYear} onToggle={() => setForm((f) => ({ ...f, unknownYear: !f.unknownYear }))} aria-label="Year unknown" />
          </div>
          <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, marginTop: -4 }}>
            {form.unknownYear
              ? "The date comes back every year with no count attached."
              : passing
                ? "The year is what lets the calendar say “five years today”."
                : "The year is what lets the calendar count the anniversaries."}
          </div>
          <TextArea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Notes (optional)" rows={3} style={{ lineHeight: 1.6, resize: "vertical" }} />
          {saveErr && <div className="t-foot" style={{ color: "var(--red)" }}>{saveErr}</div>}
          <div style={{ display: "flex", gap: 10 }}>
            <Button kind="primary" size="md" disabled={saving} onClick={save} style={{ flex: 1 }}>{saving ? "Saving…" : "Save"}</Button>
            {isEdit && <Button kind="danger" size="md" onClick={() => remove(form.id, form.name)}>Delete</Button>}
          </div>
        </Card>
        {confirmEl}
      </section>
    );
  }

  // ─── List view — soonest first, grouped by the month it next falls in ───
  const sorted = sortByNextOccurrence(filterByKind(rows || [], filter));
  const thisYear = new Date().getFullYear();
  const groups = [];
  for (const a of sorted) {
    const label = a.next.toLocaleDateString("en-US", { month: "long" }) + (a.next.getFullYear() !== thisYear ? ` ${a.next.getFullYear()}` : "");
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(a); else groups.push({ label, items: [a] });
  }
  const emptyCopy = filter === "passing"
    ? { title: "No one recorded yet", sub: "Add the day someone passed and it comes back every year, on your calendar." }
    : filter === "milestone"
      ? { title: "No milestones yet", sub: "A start date, a move, a day that mattered — anything you want to see come around again." }
      : { title: "Nothing here yet", sub: "Dates that already happened — a passing, a start date, a day that mattered — and come back every year." };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <SectionHeader
        title="Anniversaries"
        trailing={<button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -8px" }} onClick={openNew}>Add</button>}
      />
      {/* The filter is shown even when the list is empty: it is also the
          fastest way to say what KIND the next thing you add should be. */}
      <Segmented options={FILTERS} value={filter} onChange={setFilter} />

      {loadErr && (
        <Card pad="md">
          <EmptyState icon={<IcHeart size={24} />} title="Couldn't load anniversaries" sub={loadErr}
            action={<Button kind="quiet" size="md" onClick={() => refetch()}>Retry</Button>} />
        </Card>
      )}
      {!loadErr && rows === null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0, 1, 2].map((i) => <div key={i} className="sk" style={{ height: 52, borderRadius: 18 }} />)}
        </div>
      )}
      {!loadErr && rows && sorted.length === 0 && (
        <Card pad="md">
          <EmptyState icon={<IcHeart size={24} />} title={emptyCopy.title} sub={emptyCopy.sub}
            action={<Button kind="primary" size="md" onClick={openNew}>Add a date</Button>} />
        </Card>
      )}
      {!loadErr && groups.map((g) => (
        <div key={g.label}>
          <SectionHeader title={g.label} />
          <CellGroup>
            {g.items.map((a) => (
              <Cell key={a.id} onClick={() => openEdit(a)} chevron
                title={a.name}
                // The same sentence the calendar draws for this occurrence,
                // from the same function — see anniversaryLine.
                sub={`${MONTH_NAMES[a.month - 1]} ${a.day} · ${anniversaryLine(a, a.next.getFullYear())}`}
                value={
                  <span className="t-num" style={{ fontSize: 12.5, fontWeight: 600, color: a.daysUntil <= 7 ? "var(--accent)" : "var(--faint)" }}>
                    {untilLabel(a.daysUntil)}
                  </span>
                }
              />
            ))}
          </CellGroup>
        </div>
      ))}
      {!loadErr && sorted.length > 0 && (
        <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, padding: "0 4px" }}>
          Every one of these shows up on the Personal calendar on its day, the way
          birthdays do — {kindMeta("passing").line.toLowerCase()} for a passing, dated for the rest.
        </div>
      )}
      {confirmEl}
    </section>
  );
}

export default AnniversariesPanel;
