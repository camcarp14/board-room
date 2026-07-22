// ─── Calendar — month grid, day agenda, event sheet, AI bulk import ──────────
// Month grid with category-colored event dots; tapping a day with events opens
// its agenda (a CellGroup), tapping an empty day starts a new event pre-dated
// to it. The add/edit form lives in a Sheet. Bulk import reads calendar
// screenshots via Claude vision and cross-checks Birthdays before saving.

import { useState, useRef, useEffect } from "react";
import { T } from "../../theme.js";
import { db } from "../../data/db.js";
import { queryClient } from "../../lib/queryClient.js";
import { useEvents, useSaveEvent, useDeleteEvent } from "../../data/calendar.js";
import { callClaude } from "../../lib/claude.js";
import { localDayKey, todayISO } from "../../lib/dates.js";
import { tint } from "../../ui/styles.js";
import { Card, SectionHeader, Button, Cell, CellGroup, Sheet, useConfirm, EmptyState, Dot, Pill, Switch } from "../../ui/kit.jsx";
import { IcChevronLeft, IcChevronRight, IcCalendar, IcClose, IcTrash } from "../../ui/icons.jsx";

// Keys personal/work/health/bills are stored values in the events.category
// column — do not rename. Colors ride the validated data palette.
export const EVENT_CATEGORIES = [
  { key: "personal", label: "Personal", color: T.blue },
  { key: "work", label: "Work", color: T.amber },
  { key: "health", label: "Health", color: T.green },
  { key: "bills", label: "Bills / Finance", color: T.red },
];

// Timestamp of the last Brief-deep-link new-event signal we've acted on, kept
// at module scope so it survives this panel remounting on tab navigation.
let lastHandledNewEvent = null;

export function CalendarPanel({ isMobile, newEventSignal }) {
  const { data: events = null, error } = useEvents();
  const loadErr = error ? (error.message || "Couldn't load your calendar.") : null;
  const saveMut = useSaveEvent();
  const delMut = useDeleteEvent();
  const [confirmEl, confirm] = useConfirm();
  const [form, setForm] = useState(null); // null = closed; object = open (new or editing)
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const [viewMonth, setViewMonth] = useState(() => new Date(today0.getFullYear(), today0.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(null); // "YYYY-MM-DD" or null — grid shows when null

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkImages, setBulkImages] = useState([]); // {id, name, dataUrl, base64, mediaType}
  const [bulkParsing, setBulkParsing] = useState(false);
  const [bulkErr, setBulkErr] = useState(null);
  const [bulkPreview, setBulkPreview] = useState(null); // parsed rows awaiting review
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkShowAll, setBulkShowAll] = useState(false); // review list starts capped in-page

  // ─── Bulk import from calendar screenshots ───
  const normName = (s) => (s || "").toLowerCase().replace(/'s birthday|birthday|bday|born/gi, "").replace(/[^a-z0-9]/g, "").trim();

  const addImages = (fileList) => {
    Array.from(fileList).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(",")[1];
        setBulkImages(prev => [...prev, { id: crypto.randomUUID(), name: file.name, dataUrl, base64, mediaType: file.type || "image/png" }]);
      };
      reader.readAsDataURL(file);
    });
  };
  const removeImage = (id) => setBulkImages(prev => prev.filter(i => i.id !== id));

  const parseBulkImages = async () => {
    if (!bulkImages.length) return;
    setBulkParsing(true); setBulkErr(null); setBulkPreview(null); setBulkShowAll(false);

    const [birthdaysList, eventsList] = await Promise.all([
      db.loadBirthdays().catch(() => []),
      db.loadEvents().catch(() => []),
    ]);

    const system = `You are extracting events from a screenshot of a calendar app's month view. Look at the month/year shown in the screenshot's header to anchor the dates. Respond with ONLY a JSON array, no markdown fences, no commentary.
Each item: {"title": string, "date": "YYYY-MM-DD", "time": "HH:MM" or null, "all_day": boolean, "kind": "event" or "possible_birthday"}.
Use kind "possible_birthday" if the title clearly reads as someone's birthday (contains "birthday", "bday", a cake emoji, or is just a name in a way that strongly implies it). Otherwise use "event".
Only extract entries you can read with real confidence — skip anything blurry, cut off, or ambiguous rather than guessing. If you find nothing legible, respond with []`;

    const merged = [];
    const errors = [];
    for (const img of bulkImages) {
      try {
        const text = await callClaude({
          system,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
            { type: "text", text: "Extract every event from this calendar screenshot as instructed." },
          ] }],
          modelKey: "sonnet", maxTokens: 2500, fn: "parse_calendar_image",
        });
        if (!text) { errors.push(`${img.name}: no response`); continue; }
        const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) { errors.push(`${img.name}: unexpected response shape`); continue; }
        parsed.forEach(item => {
          if (item && typeof item.title === "string" && item.date) merged.push(item);
        });
      } catch (e) {
        errors.push(`${img.name}: ${e.message || "couldn't parse"}`);
      }
    }

    setBulkParsing(false);
    if (!merged.length) {
      setBulkErr(errors.length ? `Couldn't extract anything. ${errors.join("; ")}` : "No events found in those screenshots.");
      return;
    }

    // Cross-reference against what's already tracked, so re-importing your
    // old calendar doesn't create duplicate birthdays or duplicate events.
    // Model output is untrusted: validate date/time shapes HERE, before they
    // can reach `new Date(...).toISOString()` in confirmBulkImport — one
    // malformed "24:00" used to throw there and wedge the sheet in "Saving…".
    const badRows = [];
    const reviewed = merged.filter(item => {
      const okDate = /^\d{4}-\d{2}-\d{2}$/.test(String(item.date)) && !isNaN(new Date(`${item.date}T00:00:00`).getTime());
      const okTime = item.time == null || item.time === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(item.time));
      if (!okDate || !okTime) { badRows.push(item.title || "(untitled)"); return false; }
      return true;
    }).map(item => {
      const [y, m, d] = item.date.split("-").map(Number);
      if (item.kind === "possible_birthday") {
        const match = birthdaysList.find(b => normName(b.name) === normName(item.title) && b.month === m && b.day === d);
        return {
          tempId: crypto.randomUUID(), title: item.title, date: item.date, time: item.time, allDay: !!item.all_day,
          kind: match ? "duplicate_birthday" : "new_birthday",
          matchedName: match?.name,
          action: match ? "skip" : "birthday",
          month: m, day: d, year: y,
        };
      }
      // Compare the LOCAL day of the stored event to the screenshot's literal
      // date — slice(0,10) is the UTC day and never matched evening events,
      // so re-imports duplicated every 8pm event (the lib/dates.js bug class).
      const dupEvent = eventsList.find(e => normName(e.title) === normName(item.title) && localDayKey(e.start_time) === item.date);
      return {
        tempId: crypto.randomUUID(), title: item.title, date: item.date, time: item.time, allDay: !!item.all_day,
        kind: dupEvent ? "duplicate_event" : "event",
        action: dupEvent ? "skip" : "calendar",
      };
    });
    if (badRows.length) errors.push(`unusable date/time on: ${badRows.join(", ")}`);
    if (!reviewed.length) { setBulkErr(`Couldn't extract anything usable. ${errors.join("; ")}`); return; }

    if (errors.length) setBulkErr(`Imported what I could. Skipped: ${errors.join("; ")}`);
    setBulkPreview(reviewed);
  };

  const updateRowAction = (tempId, action) => setBulkPreview(rows => rows.map(r => r.tempId === tempId ? { ...r, action } : r));

  const confirmBulkImport = () => {
    if (!bulkPreview?.length) return;
    setBulkSaving(true);
    // Rows are pre-validated at preview time, but belt-and-braces: a throw
    // here must land in bulkErr, never escape after setBulkSaving(true) and
    // freeze the Confirm button at "Saving…" forever.
    let toCalendar, toBirthdays;
    try {
      toCalendar = bulkPreview.filter(r => r.action === "calendar").map(r => ({
        id: crypto.randomUUID(), title: r.title, notes: "Imported from calendar screenshot",
        start_time: r.allDay || !r.time ? new Date(`${r.date}T00:00:00`).toISOString() : new Date(`${r.date}T${r.time}:00`).toISOString(),
        all_day: r.allDay || !r.time,
      }));
      toBirthdays = bulkPreview.filter(r => r.action === "birthday").map(r => ({
        id: crypto.randomUUID(), name: r.title.replace(/'s birthday|birthday|bday/gi, "").trim() || r.title, month: r.month, day: r.day, year: r.year || null,
      }));
    } catch (e) {
      setBulkSaving(false); setBulkErr(e.message || "A row has an unusable date — deselect it and try again.");
      return;
    }
    Promise.all([
      toCalendar.length ? db.saveEventsBulk(toCalendar) : Promise.resolve(),
      toBirthdays.length ? db.saveBirthdaysBulk(toBirthdays) : Promise.resolve(),
    ]).then(() => {
      setBulkSaving(false); setBulkPreview(null); setBulkImages([]); setBulkOpen(false);
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["birthdays"] });
    }).catch(e => { setBulkSaving(false); setBulkErr(e.message || "Couldn't save the batch."); });
  };

  // Local calendar day — must match the local day-keys the grid renders with,
  // or the "today" ring lands on tomorrow and new events pre-date to tomorrow
  // every evening (UTC rolls over hours before local midnight in the Americas).
  const todayStr = todayISO();

  const catColor = (key) => (EVENT_CATEGORIES.find(c => c.key === key) || EVENT_CATEGORIES[0]).color;

  const blankDraft = (presetDate) => ({
    id: crypto.randomUUID(), title: "", notes: "", location: "", category: "personal",
    date: presetDate || todayStr, time: "09:00", endTime: "", allDay: false,
  });

  const openNew = (presetDate) => { setSaveErr(null); setForm(blankDraft(presetDate)); };
  // Deep-link from the Brief mini-calendar: open a new event pre-dated to the
  // tapped day. Each jump carries a unique timestamp; handle each one exactly
  // once (tracked at module scope so a plain remount on later navigation, which
  // still carries the old jump, doesn't re-pop the form).
  useEffect(() => {
    const t = newEventSignal?.t;
    if (newEventSignal?.date && t && t !== lastHandledNewEvent) {
      lastHandledNewEvent = t;
      openNew(newEventSignal.date);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEventSignal?.t]);
  const openEdit = (ev) => {
    setSaveErr(null);
    const d = new Date(ev.start_time);
    setForm({
      id: ev.id, title: ev.title, notes: ev.notes || "", allDay: ev.all_day,
      location: ev.location || "", category: ev.category || "personal",
      // Local parts, not toISOString() — otherwise opening an 8pm event for
      // edit shows tomorrow's date, and saving it unchanged shifts it +1 day.
      date: localDayKey(d),
      time: ev.all_day ? "09:00" : d.toTimeString().slice(0, 5),
      endTime: ev.end_time ? new Date(ev.end_time).toTimeString().slice(0, 5) : "",
    });
  };
  const closeForm = () => setForm(null);

  const save = () => {
    if (!form.title.trim()) { setSaveErr("Give it a title."); return; }
    // Date/time inputs can legitimately be cleared to "" — without these
    // guards `new Date("T09:00:00").toISOString()` throws BEFORE the mutation
    // and Save just silently does nothing.
    if (!form.date) { setSaveErr("Pick a date."); return; }
    if (!form.allDay && !form.time) { setSaveErr("Pick a time (or make it all-day)."); return; }
    if (!form.allDay && form.endTime && form.endTime <= form.time) { setSaveErr("End time has to be after the start."); return; }
    const start_time = form.allDay
      ? new Date(`${form.date}T00:00:00`).toISOString()
      : new Date(`${form.date}T${form.time}:00`).toISOString();
    const end_time = (!form.allDay && form.endTime) ? new Date(`${form.date}T${form.endTime}:00`).toISOString() : null;
    setSaving(true);
    setSaveErr(null);
    saveMut.mutate({ id: form.id, title: form.title.trim(), notes: form.notes, start_time, end_time, all_day: form.allDay, location: form.location, category: form.category }, {
      onSuccess: () => { setSaving(false); closeForm(); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't save."); },
    });
  };

  const removeEvent = async (id, e) => {
    e?.stopPropagation();
    if (!(await confirm({ title: "Delete this event?", confirmLabel: "Delete", destructive: true }))) return;
    delMut.mutate(id, {
      onSuccess: () => { if (form?.id === id) closeForm(); },
      // A silently failed delete just reappears on the next refetch — say why.
      onError: (err) => confirm({ title: "Couldn't delete", message: err.message || "Try again in a moment.", confirmLabel: "OK", cancelLabel: false }),
    });
  };

  const dayLabel = (iso) => {
    const d = new Date(iso);
    const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dayStart - today) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays === -1) return "Yesterday";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };
  const timeLabel = (iso, allDay) => allDay ? "All day" : new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  // ─── Month grid math ───
  const gridYear = viewMonth.getFullYear(), gridMonth = viewMonth.getMonth();
  const firstOfMonth = new Date(gridYear, gridMonth, 1);
  const daysInMonth = new Date(gridYear, gridMonth + 1, 0).getDate();
  const leadingBlanks = firstOfMonth.getDay(); // 0 = Sunday
  const cells = [...Array(leadingBlanks).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const eventsByDay = {}; // "YYYY-MM-DD" -> [events]
  (events || []).forEach(ev => {
    // Local day-key so an evening event lands on the day the user sees on the
    // clock, matching dateKey()/isToday() below (start_time is stored UTC).
    // All-day too: they're saved as LOCAL midnight → UTC ISO, so the UTC
    // slice only matched the intended date in UTC-negative timezones —
    // localDayKey round-trips correctly (and matches DocketCard's keying).
    const key = localDayKey(ev.start_time);
    (eventsByDay[key] = eventsByDay[key] || []).push(ev);
  });
  const dateKey = (day) => `${gridYear}-${String(gridMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const isToday = (day) => dateKey(day) === todayStr;
  const monthLabel = viewMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const changeMonth = (delta) => setViewMonth(new Date(gridYear, gridMonth + delta, 1));

  // Swipe between months on the grid — mirrors the app shell's tab-swipe
  // physics (touch only, ≤600ms, ≥64px, mostly horizontal 2.2:1) and its
  // guards: never from a form control, never from the screen edges (those
  // belong to iOS's history gesture). stopPropagation on pointerdown keeps
  // the shell's document-level tab swipe from also firing for gestures that
  // begin on the grid.
  const swipeStart = useRef(null);
  const onGridPointerDown = (e) => {
    swipeStart.current = null;
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.clientX < 24 || e.clientX > window.innerWidth - 24) return;
    e.stopPropagation();
    swipeStart.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onGridPointerUp = (e) => {
    const s = swipeStart.current;
    swipeStart.current = null;
    if (!s || e.pointerType !== "touch") return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Date.now() - s.t > 600 || Math.abs(dx) < 64 || Math.abs(dx) < 2.2 * Math.abs(dy)) return;
    changeMonth(dx < 0 ? 1 : -1);
  };

  const selectedDayEvents = selectedDay ? (eventsByDay[selectedDay] || []).sort((a, b) => new Date(a.start_time) - new Date(b.start_time)) : [];
  const selectedDayLabel = selectedDay ? new Date(`${selectedDay}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "";

  const isEdit = !!form && (events || []).some(e => e.id === form.id);
  const nonSkip = (bulkPreview || []).filter(r => r.action !== "skip").length;
  const previewRows = bulkPreview ? (bulkShowAll ? bulkPreview : bulkPreview.slice(0, 8)) : [];

  // ─── Agenda row (day view) ───
  // Not a <Cell onClick> — that renders a <button>, and nesting the delete
  // control inside it is invalid HTML/ARIA (screen readers collapse it to one
  // control). A plain .cell wrapper with two SIBLING buttons instead, same
  // pattern MoviesPanel uses.
  const renderEvent = (ev) => (
    <div key={ev.id} className="cell has-leading" style={{ padding: 0 }}>
      <button onClick={() => openEdit(ev)} className="hoverable"
        style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12, background: "none", border: "none", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", padding: "10px 0 10px 16px", minHeight: 46, borderRadius: 0 }}>
        <span className="cell-leading" style={{ color: "var(--sub)" }}><Dot tone={catColor(ev.category)} size={8} /></span>
        <span className="cell-body">
          <span className="cell-title">{ev.title}</span>
          <span className="cell-sub">{[dayLabel(ev.start_time), ev.location, ev.notes].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="cell-value">
          <span className="t-num" style={{ fontSize: 12 }}>
            {timeLabel(ev.start_time, ev.all_day)}
            {ev.end_time && !ev.all_day ? `–${new Date(ev.end_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
          </span>
        </span>
      </button>
      <button className="icon-btn" aria-label="Delete event" onClick={(e) => removeEvent(ev.id, e)} style={{ marginRight: 8, color: "var(--faint)" }}>
        <IcTrash size={16} />
      </button>
    </div>
  );

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <SectionHeader
        title="Calendar"
        trailing={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <button className="sec-link" style={{ color: bulkOpen ? "var(--accent)" : "var(--sub)", padding: "10px 8px", margin: "-10px -2px" }}
              onClick={() => setBulkOpen(o => !o)}>
              {bulkOpen ? "Close import" : "Import"}
            </button>
            <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -4px" }} onClick={() => openNew(selectedDay)}>Add event</button>
          </span>
        }
      />

      {/* ── bulk import ── */}
      {bulkOpen && (
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {!bulkPreview ? (
            <>
              <span className="t-foot" style={{ lineHeight: 1.6 }}>
                Upload screenshots of your old calendar — one per month works well. Claude reads each one, and anything
                that looks like a birthday gets checked against your Birthdays list automatically so you don't end up
                with duplicates. You'll review everything before it's saved.
              </span>
              <label className="btn quiet md" style={{ alignSelf: "flex-start", cursor: "pointer" }}>
                Choose images
                {/* value reset after pick so re-selecting the same file works */}
                <input type="file" accept="image/*" multiple onChange={e => { addImages(e.target.files); e.target.value = ""; }} style={{ display: "none" }} />
              </label>
              {bulkImages.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {bulkImages.map(img => (
                    <div key={img.id} style={{ position: "relative", width: 72, height: 72, borderRadius: 12, overflow: "hidden", background: "var(--surface-2)" }}>
                      <img src={img.dataUrl} alt={img.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      <button onClick={() => removeImage(img.id)} aria-label="Remove"
                        style={{ position: "absolute", top: 3, right: 3, width: 26, height: 26, borderRadius: "50%", border: "none", background: "var(--scrim)", color: "#FFFFFF", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}>
                        <IcClose size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {bulkErr && <div className="t-foot" style={{ color: "var(--red)" }}>{bulkErr}</div>}
              <Button kind="primary" size="md" disabled={bulkParsing || !bulkImages.length} onClick={parseBulkImages} style={{ alignSelf: "flex-start" }}>
                {bulkParsing ? `Reading ${bulkImages.length} image${bulkImages.length === 1 ? "" : "s"}…` : `Parse ${bulkImages.length || ""} image${bulkImages.length === 1 ? "" : "s"}`}
              </Button>
            </>
          ) : (
            <>
              <span className="t-foot">Found {bulkPreview.length} — review the action for each, then confirm.</span>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {previewRows.map((r, i) => (
                  <div key={r.tempId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: i ? "0.5px solid var(--line)" : "none" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="t-call" style={{ fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                      <div className="t-cap" style={{ color: "var(--faint)", fontFamily: "var(--font-mono)" }}>
                        {r.date}{r.time ? ` · ${r.time}` : ""}
                        {r.kind === "duplicate_birthday" && ` · already in Birthdays as "${r.matchedName}"`}
                        {r.kind === "new_birthday" && " · looks like a new birthday"}
                        {r.kind === "duplicate_event" && " · looks like it's already on your calendar"}
                      </div>
                    </div>
                    <select className="field" value={r.action} onChange={e => updateRowAction(r.tempId, e.target.value)}
                      style={{ width: "auto", flex: "none", fontSize: 13, minHeight: 44, padding: "6px 10px" }}>
                      <option value="calendar">Add to Calendar</option>
                      <option value="birthday">Add to Birthdays</option>
                      <option value="skip">Skip</option>
                    </select>
                  </div>
                ))}
              </div>
              {!bulkShowAll && bulkPreview.length > 8 && (
                <Button kind="plain" size="sm" onClick={() => setBulkShowAll(true)} style={{ alignSelf: "flex-start" }}>
                  Show all {bulkPreview.length}
                </Button>
              )}
              {bulkErr && <div className="t-foot" style={{ color: "var(--red)" }}>{bulkErr}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <Button kind="primary" size="md" disabled={bulkSaving} onClick={confirmBulkImport}>
                  {bulkSaving ? "Saving…" : `Confirm (${nonSkip})`}
                </Button>
                <Button kind="quiet" size="md" onClick={() => { setBulkPreview(null); setBulkErr(null); setBulkShowAll(false); }}>Start over</Button>
              </div>
            </>
          )}
        </Card>
      )}

      {loadErr && (
        <Card pad="md"><EmptyState icon={<IcCalendar size={26} />} title="Couldn't load your calendar" sub={loadErr}
          action={<Button kind="tinted" size="md" onClick={() => queryClient.invalidateQueries({ queryKey: ["events"] })}>Retry</Button>} /></Card>
      )}
      {!loadErr && events === null && (
        <Card pad="md">
          <div style={{ display: "flex", flexDirection: "column", gap: 9, padding: "4px 0" }}>
            {[0, 1, 2, 3].map(i => <div key={i} className="sk sk-line" style={{ margin: 0, height: 34, borderRadius: 9, width: `${88 - i * 9}%` }} />)}
          </div>
        </Card>
      )}

      {/* ── month grid ── */}
      {!loadErr && events !== null && !bulkOpen && selectedDay === null && (
        <Card pad="md" style={{ touchAction: "pan-y" }}
          onPointerDown={onGridPointerDown} onPointerUp={onGridPointerUp} onPointerCancel={() => { swipeStart.current = null; }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <button className="icon-btn" style={{ width: 44, height: 44 }} onClick={() => changeMonth(-1)} aria-label="Previous month"><IcChevronLeft size={18} /></button>
            <span className="t-head">{monthLabel}</span>
            <button className="icon-btn" style={{ width: 44, height: 44 }} onClick={() => changeMonth(1)} aria-label="Next month"><IcChevronRight size={18} /></button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4, marginBottom: 2 }}>
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <div key={i} className="t-num" style={{ textAlign: "center", fontSize: 10.5, color: "var(--faint)", padding: "2px 0" }}>{d}</div>
            ))}
          </div>
          {/* minmax(0,1fr) + minWidth:0/overflow:hidden on each cell: nothing in a
              day cell (dot rows, "+N" counts) can force its column wider than
              1/7th — content truncates instead of the whole month grid pushing
              past the card's right edge on a phone. (Kept from the old pill
              grid, where a nowrap event pill did exactly that.) */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
            {cells.map((day, i) => {
              if (day === null) return <div key={`b${i}`} />;
              const key = dateKey(day);
              const dayEvents = eventsByDay[key] || [];
              const todayFlag = isToday(day);
              return (
                // a day with events opens its agenda; an empty day starts a new
                // event pre-dated to it
                <button key={key} onClick={() => (dayEvents.length ? setSelectedDay(key) : openNew(key))}
                  aria-label={`${monthLabel} ${day}${dayEvents.length ? `, ${dayEvents.length} event${dayEvents.length > 1 ? "s" : ""}: ${dayEvents.map(e => e.title).join(", ")}` : ""}`}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                    padding: "4px 2px 5px", minHeight: 70, minWidth: 0, overflow: "hidden",
                    background: "none", border: "none", borderRadius: 10, cursor: "pointer",
                  }}>
                  <span className="t-num" style={{
                    width: 24, height: 24, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none",
                    fontSize: 13, fontWeight: todayFlag ? 600 : 500,
                    background: todayFlag ? "var(--accent)" : "transparent",
                    color: todayFlag ? "var(--on-accent)" : "var(--ink)",
                  }}>{day}</span>
                  {/* Event titles, truncated to the column: a low-tint chip in the
                      category color with the title (or its start). Up to two, then
                      a +N overflow. Tap the day for the full agenda. */}
                  {dayEvents.length > 0 && (
                    <span style={{ display: "flex", flexDirection: "column", gap: 2, width: "100%", minWidth: 0 }}>
                      {dayEvents.slice(0, 2).map((ev, j) => (
                        <span key={j} title={ev.title} style={{
                          width: "100%", minWidth: 0, textAlign: "left",
                          fontSize: 10.5, lineHeight: 1.25, fontWeight: 600,
                          padding: "1px 3px", borderRadius: 4,
                          background: `color-mix(in srgb, ${catColor(ev.category)} 14%, transparent)`,
                          color: catColor(ev.category),
                          overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", wordBreak: "break-word",
                        }}>{ev.title}</span>
                      ))}
                      {dayEvents.length > 2 && (
                        <span className="t-num" style={{ fontSize: 10.5, lineHeight: 1.2, color: "var(--faint)", textAlign: "left", paddingLeft: 3 }}>+{dayEvents.length - 2}</span>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── day agenda ── */}
      {!loadErr && events !== null && !bulkOpen && selectedDay !== null && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 40 }}>
            <Button kind="plain" size="sm" onClick={() => setSelectedDay(null)} style={{ paddingLeft: 2, marginLeft: -8, height: 40 }}>
              <IcChevronLeft size={15} /> {monthLabel}
            </Button>
          </div>
          <div className="t-head" style={{ padding: "0 4px" }}>{selectedDayLabel}</div>
          {selectedDayEvents.length === 0 ? (
            <Card pad="md">
              <EmptyState icon={<IcCalendar size={26} />} title="Nothing yet"
                sub="This day is clear."
                action={<Button kind="tinted" size="sm" onClick={() => openNew(selectedDay)}>Add event</Button>} />
            </Card>
          ) : (
            <CellGroup>{selectedDayEvents.map(renderEvent)}</CellGroup>
          )}
        </>
      )}

      {/* ── add / edit sheet ── */}
      {form && (
        <Sheet
          onClose={closeForm}
          title={isEdit ? "Edit event" : "New event"}
          footer={
            <>
              {isEdit && (
                <Button kind="danger" size="lg" onClick={(e) => removeEvent(form.id, e)} style={{ flex: "none" }}>Delete</Button>
              )}
              <Button kind="primary" size="lg" disabled={saving} onClick={save} style={{ flex: 1 }}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          }>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
            <input
              className="field"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Event title"
              style={{ fontSize: 16, fontWeight: 600 }}
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {EVENT_CATEGORIES.map(c => {
                const active = form.category === c.key;
                return (
                  <Pill key={c.key} active={active} onClick={() => setForm(f => ({ ...f, category: c.key }))}
                    style={active ? { background: tint(c.color, 14), color: c.color } : undefined}>
                    <Dot tone={c.color} size={7} />
                    {c.label}
                  </Pill>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}>
              <span className="t-body">All-day</span>
              <Switch on={form.allDay} onToggle={() => setForm(f => ({ ...f, allDay: !f.allDay }))} aria-label="All-day event" />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label style={{ flex: "1 1 130px", display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="t-cap" style={{ color: "var(--faint)" }}>Date</span>
                <input type="date" className="field" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                  style={{ fontFamily: "var(--font-mono)" }} />
              </label>
              {!form.allDay && (
                <>
                  <label style={{ flex: "1 1 96px", display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="t-cap" style={{ color: "var(--faint)" }}>Starts</span>
                    <input type="time" className="field" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))}
                      style={{ fontFamily: "var(--font-mono)" }} />
                  </label>
                  <label style={{ flex: "1 1 96px", display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="t-cap" style={{ color: "var(--faint)" }}>Ends</span>
                    <input type="time" className="field" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                      title="End time (optional)" style={{ fontFamily: "var(--font-mono)" }} />
                  </label>
                </>
              )}
            </div>
            <input
              className="field"
              value={form.location}
              onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
              placeholder="Location (optional)"
            />
            <textarea
              className="field"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Notes (optional)"
              rows={4}
              style={{ lineHeight: 1.5, resize: "vertical" }}
            />
            {saveErr && <div className="t-foot" style={{ color: "var(--red)" }}>{saveErr}</div>}
          </div>
        </Sheet>
      )}

      {confirmEl}
    </section>
  );
}

export default CalendarPanel;
