// ─── Calendar — month grid, day agenda, event sheet, AI bulk import ──────────
// Month grid with category-colored event dots; tapping a day with events opens
// its agenda (a CellGroup), tapping an empty day starts a new event pre-dated
// to it. The add/edit form lives in a Sheet. Bulk import reads calendar
// screenshots via Claude vision and cross-checks Birthdays before saving.

import { useState, useRef, useEffect } from "react";
import { T } from "../../theme.js";
import { db } from "../../data/db.js";
import { queryClient } from "../../lib/queryClient.js";
import { useEvents, useSaveEvent, useDeleteEvent, useApplyEventPlan } from "../../data/calendar.js";
import {
  expandEvents, describeRule, normalizeRule, WEEKDAY_LABELS,
  deleteOccurrence, deleteFuture, deleteSeries, editOccurrence, editFuture,
} from "../../lib/recurrence.js";
import { EVENT_CATEGORIES } from "../../lib/eventCategories.js";
import { spanDayKeys, spanPosition, withOverlays } from "../../lib/calendar-overlays.js";
import { weeksOfMonth, layoutWeek, segmentShowsTitle } from "../../lib/calendar-layout.js";
import { softWrapTitle } from "../../lib/wrap-title.js";
import { useBirthdays } from "../../data/birthdays.js";
import { useAnniversaries } from "../../data/anniversaries.js";
import { callClaude } from "../../lib/claude.js";
import { localDayKey, todayISO, calendarDaysBetween } from "../../lib/dates.js";
import { tint } from "../../ui/styles.js";
import { Card, SectionHeader, Button, Cell, CellGroup, Sheet, useConfirm, EmptyState, Dot, Pill, Switch } from "../../ui/kit.jsx";
import { IcChevronLeft, IcChevronRight, IcCalendar, IcClose, IcTrash } from "../../ui/icons.jsx";

// The four categories moved to lib/eventCategories.js — a leaf with no imports
// but the token bridge. The Brief's mini-calendar needs the colours and used to
// take them from here, which meant this whole panel (and recurrence, overlays,
// layout, holidays, birthdays behind it) was evaluated in the landing page's
// first-paint chunk for the sake of a four-entry array. See the note in that file.
//
// Re-exported rather than moved outright: this is where every caller has always
// found them, and a named re-export costs nothing — it is the leaf's binding, so
// there is still exactly one array and one place to edit it.
export { EVENT_CATEGORIES } from "../../lib/eventCategories.js";

// Bar geometry. A day column is a seventh of 390pt — about 50px — and at one
// line "Standup" truncates to "Stan…". LANE_H 26 buys a second line, so short
// titles read whole and only genuinely long ones clip. A week is only as tall
// as the lanes it actually uses (layoutWeek reports laneCount), so a quiet
// week stays one lane and a busy one grows to three.
const LANE_H = 26;
const LANE_GAP = 3;
const DATE_H = 26;

// Timestamp of the last Brief-deep-link new-event signal we've acted on, kept
// at module scope so it survives this panel remounting on tab navigation.
let lastHandledNewEvent = null;

const shortDay = (key) => {
  const d = key ? new Date(`${key}T00:00:00`) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
};
const clock = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return null;
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
};

/** The draft's dates and times, said back as one sentence. */
function draftReadback(f) {
  const timed = !f.allDay && !!f.time;
  const multi = f.endDate && f.endDate > f.date;
  const days = multi
    ? Math.round((new Date(`${f.endDate}T00:00:00`) - new Date(`${f.date}T00:00:00`)) / 86400000) + 1
    : 1;
  if (!timed) {
    const span = multi
      ? `All day · ${shortDay(f.date)} – ${shortDay(f.endDate)} (${days} days)`
      : `All day · ${shortDay(f.date)}`;
    // The switch is off but no time was typed. That saves as all-day, which is
    // right — but it has to SAY so, or the switch reads as a promise the save
    // then quietly breaks.
    return f.allDay ? span : `${span} — add a start time to give it one`;
  }
  const from = clock(f.time);
  const to = clock(f.endTime);
  if (multi) return `${shortDay(f.date)} ${from} → ${shortDay(f.endDate)} ${to || from} (${days} days)`;
  return to ? `${shortDay(f.date)} · ${from} – ${to}` : `${shortDay(f.date)} · ${from}`;
}

export function CalendarPanel({ isMobile, newEventSignal }) {
  const { data: events = null, error } = useEvents();
  // Birthdays ride along as an overlay — they are their own table, they repeat
  // by construction, and nothing here writes to them. A failed birthdays load
  // must not take the calendar with it, so this reads the data and ignores the
  // error state: no birthdays is a quieter grid, not a broken one.
  const { data: birthdays = null } = useBirthdays();
  // Anniversaries ride along on exactly the same terms — their own table, their
  // own panel (Personal → Anniversaries), read-only here, and a failed load
  // costs the grid nothing but those rows.
  const { data: anniversaries = null } = useAnniversaries();
  const loadErr = error ? (error.message || "Couldn't load your calendar.") : null;
  const saveMut = useSaveEvent();
  const delMut = useDeleteEvent();
  const planMut = useApplyEventPlan();
  const [confirmEl, confirm] = useConfirm();
  const [form, setForm] = useState(null); // null = closed; object = open (new or editing)
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const [viewMonth, setViewMonth] = useState(() => new Date(today0.getFullYear(), today0.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(null); // "YYYY-MM-DD" or null — grid shows when null
  const [scopeAsk, setScopeAsk] = useState(null); // {mode, master, day, fields?, rrule?} — the this/future/all sheet
  const [showUpcoming, setShowUpcoming] = useState(false);

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
          // Sonnet 5 thinks adaptively unless told not to, and a month of events
          // can fill 2500 tokens on its own — thinking would eat the budget and
          // truncate the JSON mid-array, which parses as "couldn't extract
          // anything". This is extraction, not reasoning; turn it off.
          thinking: { type: "disabled" },
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
    const reviewed = merged.map(item => {
      const [, m, d] = item.date.split("-").map(Number);
      if (item.kind === "possible_birthday") {
        const match = birthdaysList.find(b => normName(b.name) === normName(item.title) && b.month === m && b.day === d);
        // NO BIRTH YEAR. item.date is the day the screenshot shows the cake on —
        // last year's calendar says 2025 — and that year used to be written into
        // personal_birthdays.year, so every imported adult "turns 1" on the
        // agenda and in the Birthdays list. The screenshot never knows the birth
        // year; the row goes in with month/day only and the year can be added
        // by hand in Birthdays.
        return {
          tempId: crypto.randomUUID(), title: item.title, date: item.date, time: item.time, allDay: !!item.all_day,
          kind: match ? "duplicate_birthday" : "new_birthday",
          matchedName: match?.name,
          action: match ? "skip" : "birthday",
          month: m, day: d, year: null,
        };
      }
      const dupEvent = eventsList.find(e => normName(e.title) === normName(item.title) && e.start_time.slice(0, 10) === item.date);
      return {
        tempId: crypto.randomUUID(), title: item.title, date: item.date, time: item.time, allDay: !!item.all_day,
        kind: dupEvent ? "duplicate_event" : "event",
        action: dupEvent ? "skip" : "calendar",
      };
    });

    if (errors.length) setBulkErr(`Imported what I could. Skipped: ${errors.join("; ")}`);
    setBulkPreview(reviewed);
  };

  const updateRowAction = (tempId, action) => setBulkPreview(rows => rows.map(r => r.tempId === tempId ? { ...r, action } : r));

  const confirmBulkImport = () => {
    if (!bulkPreview?.length) return;
    setBulkSaving(true);
    const toCalendar = bulkPreview.filter(r => r.action === "calendar").map(r => ({
      id: crypto.randomUUID(), title: r.title, notes: "Imported from calendar screenshot",
      start_time: r.allDay || !r.time ? new Date(`${r.date}T00:00:00`).toISOString() : new Date(`${r.date}T${r.time}:00`).toISOString(),
      all_day: r.allDay || !r.time,
    }));
    const toBirthdays = bulkPreview.filter(r => r.action === "birthday").map(r => ({
      id: crypto.randomUUID(), name: r.title.replace(/'s birthday|birthday|bday/gi, "").trim() || r.title, month: r.month, day: r.day, year: null,
    }));
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

  // ALL-DAY IS THE DEFAULT, AND THE TIME FIELDS START EMPTY. Most of what goes
  // on a personal calendar is a day, not an appointment, and the form used to
  // open pre-set to 9:00 AM — which is not a blank field, it is a wrong answer
  // you have to notice and correct. `endDate` empty means "same day"; filling
  // it is the whole multi-day story.
  const blankDraft = (presetDate) => ({
    id: crypto.randomUUID(), title: "", notes: "", location: "", category: "personal",
    date: presetDate || todayStr, endDate: "", time: "", endTime: "", allDay: true,
    // Repeat, held flat in the draft and assembled into an rrule on save.
    // freq "" is "Does not repeat" — the default, so nothing repeats by
    // accident.
    freq: "", interval: 1, byWeekday: [], endMode: "never", until: "", count: 12,
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
    const rule = normalizeRule(ev.rrule);
    setForm({
      // An occurrence's `id` is synthetic (`master@day`) — the draft carries
      // the MASTER's id so a save can never try to upsert a row that has no
      // database identity, plus the occurrence day so the scope helpers know
      // which one of the series the user was actually looking at.
      id: ev.masterId || ev.id,
      occurrenceDay: ev.occurrenceDay || null,
      wasRecurring: !!rule,
      title: ev.title, notes: ev.notes || "", allDay: ev.all_day,
      location: ev.location || "", category: ev.category || "personal",
      // Local parts, not toISOString() — otherwise opening an 8pm event for
      // edit shows tomorrow's date, and saving it unchanged shifts it +1 day.
      date: localDayKey(d),
      // The end DATE is only carried when it differs from the start — an
      // ordinary same-day event must not open with its own date echoed into a
      // second field the user then has to reason about.
      endDate: (() => {
        const keys = spanDayKeys(ev);
        return keys.length > 1 ? keys[keys.length - 1] : "";
      })(),
      time: ev.all_day ? "" : d.toTimeString().slice(0, 5),
      endTime: ev.all_day || !ev.end_time ? "" : new Date(ev.end_time).toTimeString().slice(0, 5),
      freq: rule ? rule.freq : "",
      interval: rule ? rule.interval : 1,
      byWeekday: rule ? rule.byWeekday : [],
      endMode: rule ? (rule.until ? "on" : rule.count ? "after" : "never") : "never",
      until: rule && rule.until ? rule.until : "",
      count: rule && rule.count ? rule.count : 12,
    });
  };
  const closeForm = () => setForm(null);

  // The draft's repeat fields → a stored rrule, or null for a one-off.
  const draftRule = (f) => {
    if (!f.freq) return null;
    const rule = { freq: f.freq, interval: Math.max(1, Number(f.interval) || 1) };
    if (f.freq === "weekly" && f.byWeekday.length) rule.byWeekday = [...f.byWeekday].sort((a, b) => a - b);
    if (f.endMode === "on" && f.until) rule.until = f.until;
    if (f.endMode === "after") rule.count = Math.max(1, Number(f.count) || 1);
    return rule;
  };

  /**
   * Draft → the stored row. Three things this now gets right that it didn't:
   *
   *   A BLANK TIME IS ALL-DAY, not midnight. The switch and the empty field are
   *   two ways of saying the same thing, and treating an empty `time` as
   *   00:00 silently filed a lunch as a 12am appointment.
   *
   *   THE END CAN BE ON A DIFFERENT DAY. `end_time` used to be built from
   *   `f.date` no matter what, which made a multi-day event unrepresentable —
   *   not hard, unrepresentable — and an end date earlier than the start is
   *   clamped away rather than stored as a negative duration that expandEvents
   *   would carry into every occurrence.
   *
   *   AN ALL-DAY SPAN ENDS AT MIDNIGHT ON ITS LAST DAY, inclusive: the grid
   *   keys all-day rows off the stored date string (see calendar-overlays.js),
   *   so `${endDate}T00:00:00` is exactly the last cell it should paint.
   */
  const draftFields = (f) => {
    const timed = !f.allDay && !!f.time;
    const endDate = f.endDate && f.endDate > f.date ? f.endDate : null;
    const start_time = timed
      ? new Date(`${f.date}T${f.time}:00`).toISOString()
      : new Date(`${f.date}T00:00:00`).toISOString();

    let end_time = null;
    if (timed) {
      // A timed event's end takes the end date when there is one, and the end
      // time when there is one; either alone is still an end.
      if (f.endTime || endDate) {
        end_time = new Date(`${endDate || f.date}T${f.endTime || f.time}:00`).toISOString();
        if (new Date(end_time) < new Date(start_time)) end_time = null;
      }
    } else if (endDate) {
      end_time = new Date(`${endDate}T00:00:00`).toISOString();
    }

    return {
      title: f.title.trim(), notes: f.notes, start_time, end_time,
      all_day: !timed, location: f.location, category: f.category,
    };
  };

  /**
   * The fields for a scope-"all" edit — a SHIFT of the master, never a
   * replacement of its start.
   *
   * THIS OPTION USED TO DELETE HISTORY. The form is seeded from the occurrence
   * you tapped (openEdit takes `date` from that occurrence's own day), and
   * draftFields rebuilds start_time out of that date. Writing the result
   * straight onto the master therefore moved the SERIES START to whichever
   * occurrence happened to be on screen — and occurrenceDays walks the series
   * forward from master.start_time, so every occurrence before it stopped
   * existing. Editing a weekly "Team sync" from an August occurrence, purely to
   * fix a typo in its title, took the series from 35 occurrences to 5. The
   * scope sheet's own words for this option are "All events in the series —
   * including the ones already past"; it removed them instead.
   *
   * So the day the user moved the event BY is what carries over, not the day
   * they moved it TO: take the delta between the occurrence they opened and the
   * date they left in the form, and apply that same delta to the master's own
   * start. A title-only edit produces a zero delta and the start is untouched.
   * Moving the occurrence forward two days moves the whole series forward two
   * days, which is what "all events" has to mean. The time of day is taken
   * verbatim, because changing the time of a series is not a shift of anything.
   */
  const seriesFields = (master, day, fields) => {
    const out = { ...fields };
    const formStart = new Date(fields.start_time);
    const masterStart = new Date(master.start_time);
    if (!day || isNaN(formStart) || isNaN(masterStart)) return out;

    const deltaDays = calendarDaysBetween(`${day}T12:00:00`, formStart);
    if (deltaDays == null) return out;

    // Rebuild off the MASTER's calendar day plus the delta, keeping the clock
    // time the form is carrying. Local parts throughout — the whole file's rule.
    const shift = (iso, refIso) => {
      if (!iso) return iso;
      const t = new Date(iso), ref = new Date(refIso);
      if (isNaN(t) || isNaN(ref)) return iso;
      // How many days past the master's start this stamp sits, so a multi-day
      // span keeps its length instead of collapsing onto one day.
      const span = calendarDaysBetween(refIso, t) || 0;
      const d = new Date(masterStart.getFullYear(), masterStart.getMonth(),
        masterStart.getDate() + deltaDays + span, t.getHours(), t.getMinutes(), 0, 0);
      return d.toISOString();
    };
    out.start_time = shift(fields.start_time, fields.start_time);
    if (fields.end_time) out.end_time = shift(fields.end_time, fields.start_time);
    return out;
  };

  const runPlan = (plan) => {
    setSaving(true);
    setSaveErr(null);
    planMut.mutate(plan, {
      onSuccess: () => { setSaving(false); setScopeAsk(null); closeForm(); },
      onError: (e) => { setSaving(false); setScopeAsk(null); setSaveErr(e.message || "Couldn't save."); },
    });
  };

  const save = () => {
    if (!form.title.trim()) { setSaveErr("Give it a title."); return; }
    const fields = draftFields(form);
    const rrule = draftRule(form);
    const master = (events || []).find((e) => e.id === form.id) || null;

    // Editing one occurrence of a series that ALREADY repeated is the only
    // ambiguous case — "did you mean this one, or all of them?" — so it is the
    // only one that asks. Everything else (a new event, a one-off, or turning
    // repetition on for the first time) has exactly one meaning.
    if (master && form.wasRecurring && form.occurrenceDay) {
      setScopeAsk({ mode: "edit", master, day: form.occurrenceDay, fields, rrule });
      return;
    }
    setSaving(true);
    setSaveErr(null);
    saveMut.mutate({
      id: form.id, ...fields, rrule,
      exdates: master ? master.exdates : [],
      series_id: rrule ? (master && master.series_id) || form.id : null,
    }, {
      onSuccess: () => { setSaving(false); closeForm(); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't save."); },
    });
  };

  // `occ` is an expanded occurrence, so it knows both its master and its day.
  const removeEvent = async (occ, e) => {
    e?.stopPropagation();
    const master = (events || []).find((x) => x.id === (occ.masterId || occ.id));
    if (master && normalizeRule(master.rrule) && occ.occurrenceDay) {
      setScopeAsk({ mode: "delete", master, day: occ.occurrenceDay });
      return;
    }
    if (!(await confirm({ title: "Delete this event?", confirmLabel: "Delete", destructive: true }))) return;
    delMut.mutate(occ.masterId || occ.id, { onSuccess: () => { if (form?.id === (occ.masterId || occ.id)) closeForm(); } });
  };

  // One of "one" | "future" | "all", answered in the scope sheet.
  const applyScope = (scope) => {
    const { mode, master, day, fields, rrule } = scopeAsk;
    if (mode === "delete") {
      if (scope === "one") return runPlan(deleteOccurrence(master, day));
      if (scope === "future") return runPlan(deleteFuture(master, day));
      return runPlan(deleteSeries(master, events || []));
    }
    if (scope === "one") return runPlan(editOccurrence(master, day, fields, crypto.randomUUID()));
    if (scope === "future") return runPlan(editFuture(master, day, { ...fields, rrule }, crypto.randomUUID()));
    // All: the master keeps its identity, its exdates, its series — AND ITS
    // START. See seriesFields for why that last one had to be spelled out.
    return runPlan({ update: [{ id: master.id, ...seriesFields(master, day, fields), rrule }], insert: [], delete: [] });
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
  // Whole weeks, Sunday-first, INCLUDING the neighbouring months' days. The
  // grid used to render blanks there, which meant a bar starting Jan 31 and
  // running to Feb 2 had nowhere to be drawn on either side of the boundary.
  const weeks = weeksOfMonth(gridYear, gridMonth);
  // Occurrences, not rows: a repeating event is ONE stored row, and the grid
  // wants every day it lands on. Expanded across the visible month with a
  // week of slack on each side so the leading/trailing cells of the grid (which
  // belong to the neighbouring months) are populated too.
  const gridFrom = new Date(gridYear, gridMonth, -7);
  const gridTo = new Date(gridYear, gridMonth + 1, 7);
  const monthOccurrences = withOverlays(
    expandEvents(events || [], gridFrom, gridTo),
    { birthdays: birthdays || [], anniversaries: anniversaries || [], from: gridFrom, to: gridTo },
  );
  const eventsByDay = {}; // "YYYY-MM-DD" -> [occurrences]
  monthOccurrences.forEach(ev => {
    // EVERY day the occurrence covers, not just the one it starts on — a trip
    // from the 6th to the 9th used to appear on the 6th and nowhere else,
    // which looks exactly like never having entered it. spanDayKeys also owns
    // the local-day convention (an evening event lands on the day the clock
    // says, and an all-day row is keyed off its stored date string).
    for (const key of spanDayKeys(ev)) (eventsByDay[key] = eventsByDay[key] || []).push(ev);
  });

  // The next 90 days, flat — the view a month grid genuinely cannot give you:
  // "what is actually coming up", across month boundaries, in order.
  const upcoming = (() => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 90);
    const now = Date.now();
    const real = expandEvents(events || [], from, to)
      .filter((o) => o.all_day || new Date(o.end_time || o.start_time).getTime() >= now);
    return withOverlays(real, { birthdays: birthdays || [], anniversaries: anniversaries || [], from, to }).slice(0, 60);
  })();
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

  // Your own events first, in clock order; birthdays and holidays after them.
  // Sorting the merged list by start_time alone would float every overlay to
  // the top, because an all-day row is stored at midnight.
  const selectedDayEvents = selectedDay
    ? [...(eventsByDay[selectedDay] || [])].sort((a, b) =>
      (a.overlay ? 1 : 0) - (b.overlay ? 1 : 0) ||
      new Date(a.start_time) - new Date(b.start_time))
    : [];
  const selectedDayLabel = selectedDay ? new Date(`${selectedDay}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "";

  const isEdit = !!form && (events || []).some(e => e.id === form.id);
  const nonSkip = (bulkPreview || []).filter(r => r.action !== "skip").length;
  const previewRows = bulkPreview ? (bulkShowAll ? bulkPreview : bulkPreview.slice(0, 8)) : [];

  // ─── Agenda row (day view) ───
  // `day` is the cell this row is being drawn under, so a multi-day event can
  // say which of its days this is. Absent (Upcoming), it reads as the span.
  const renderEvent = (ev, day) => {
    // OVERLAYS ARE NOT ROWS. A birthday lives in personal_birthdays and a
    // holiday is computed from the year — neither has a database identity, so
    // neither gets an edit tap or a delete button. Giving them one would open
    // a form that can only fail on save.
    if (ev.overlay) {
      // An anniversary already carries its own sentence — "In memory · 5
      // years" — assembled in lib/anniversaries.js so this row and the panel's
      // list can never word the same day two different ways.
      const sub = ev.overlay === "birthday"
        ? (ev.turns != null ? `Birthday · turns ${ev.turns}` : "Birthday")
        : ev.overlay === "anniversary"
          ? (ev.line || "Anniversary")
          : (ev.federal ? "Holiday" : "Observance");
      return (
        <Cell key={ev.id}
          leading={<Dot tone="var(--faint)" size={8} />}
          title={<span style={{ color: "var(--sub)" }}>{ev.title}</span>}
          sub={[dayLabel(ev.start_time), sub].filter(Boolean).join(" · ")}
          value={<span className="t-num" style={{ fontSize: 12, color: "var(--faint)" }}>All day</span>}
        />
      );
    }
    const span = spanPosition(ev, day || null);
    const multi = span.total > 1;
    const spanLabel = multi
      ? (day ? `Day ${span.index + 1} of ${span.total}` : `${dayLabel(ev.start_time)} → ${span.total} days`)
      : dayLabel(ev.start_time);
    return (
      <Cell
        key={`${ev.id}${day ? `#${day}` : ""}`}
        onClick={() => openEdit(ev)}
        leading={<Dot tone={catColor(ev.category)} size={8} />}
        title={ev.title}
        sub={[spanLabel, ev.isRecurring ? "Repeats" : null, ev.location, ev.notes].filter(Boolean).join(" · ")}
        value={
          <span className="t-num" style={{ fontSize: 12 }}>
            {timeLabel(ev.start_time, ev.all_day)}
            {ev.end_time && !ev.all_day ? `–${new Date(ev.end_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
          </span>
        }
        trailing={
          <span role="button" tabIndex={0} aria-label="Delete event" className="icon-btn"
            onClick={(e) => removeEvent(ev, e)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); removeEvent(ev, e); } }}
            style={{ width: 38, height: 38, marginRight: -8, color: "var(--faint)" }}>
            <IcTrash size={16} />
          </span>
        }
      />
    );
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <SectionHeader
        title="Calendar"
        trailing={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <button className="sec-link" style={{ color: showUpcoming ? "var(--accent)" : "var(--sub)", padding: "10px 8px", margin: "-10px -2px" }}
              onClick={() => { setShowUpcoming(v => !v); setSelectedDay(null); }}>
              {showUpcoming ? "Month" : "Upcoming"}
            </button>
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
        <Card pad="md"><EmptyState icon={<IcCalendar size={26} />} title="Couldn't load your calendar" sub={loadErr} /></Card>
      )}
      {!loadErr && events === null && (
        <Card pad="md">
          <div style={{ display: "flex", flexDirection: "column", gap: 9, padding: "4px 0" }}>
            {[0, 1, 2, 3].map(i => <div key={i} className="sk sk-line" style={{ margin: 0, height: 34, borderRadius: 9, width: `${88 - i * 9}%` }} />)}
          </div>
        </Card>
      )}

      {/* ── upcoming ──────────────────────────────────────────────────────
          The next 90 days as one ordered list. A month grid answers "what is
          on the 14th"; it cannot answer "what is next", which is the question
          you actually open a calendar with — and it silently hides anything
          that falls a few days into the following month. */}
      {!loadErr && events !== null && !bulkOpen && showUpcoming && (
        <Card pad="md">
          {upcoming.length === 0 ? (
            <EmptyState icon={<IcCalendar size={24} />} title="Nothing coming up"
              sub="The next 90 days are clear."
              action={<Button kind="tinted" size="sm" onClick={() => openNew(null)}>Add event</Button>} />
          ) : (
            // (ev) => renderEvent(ev), NOT the bare reference: map's second
            // argument is the index, and renderEvent's is the day a row is
            // drawn under — passing 3 there makes a four-day trip claim to be
            // "Day 1 of 4" on a list that shows it exactly once.
            <CellGroup>{upcoming.map((ev) => renderEvent(ev))}</CellGroup>
          )}
        </Card>
      )}

      {/* ── month grid ── */}
      {!loadErr && events !== null && !bulkOpen && !showUpcoming && selectedDay === null && (
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
          {/* ── WEEK ROWS, NOT DAY CELLS ────────────────────────────────
              A multi-day event is ONE THING, and the grid used to draw it as
              a separate chip in every day it touched — which is not a smaller
              version of a bar, it is a different claim. Four chips reading
              "Austin trip" look like four events that share a name, and
              nothing on screen said the 6th and the 9th were the same trip.

              So each week is a positioning context: the date numbers sit in a
              7-column grid, and the bars are absolutely positioned over them
              by column and span. That is the part a per-cell render cannot
              do — a bar covering Wed→Sat has to sit at the SAME height in all
              four columns, and a day cell has no way to know what height that
              is. lib/calendar-layout.js packs them into lanes for exactly
              that reason. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {weeks.map((week, wi) => {
              const { segments, overflow, laneCount } = layoutWeek(monthOccurrences, week);
              const lanes = Math.max(laneCount, 1);
              const bodyH = lanes * (LANE_H + LANE_GAP) + 4;
              return (
                <div key={week[0]} style={{ position: "relative", minWidth: 0 }}>
                  {/* the tap targets and the date numbers */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 2 }}>
                    {week.map((key) => {
                      const inMonth = Number(key.slice(5, 7)) === gridMonth + 1;
                      const dayNum = Number(key.slice(8, 10));
                      const dayEvents = eventsByDay[key] || [];
                      const todayFlag = key === todayStr;
                      const more = overflow[key] || 0;
                      return (
                        <button key={key} onClick={() => setSelectedDay(key)}
                          aria-label={`${new Date(`${key}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric" })}${dayEvents.length ? `, ${dayEvents.length} event${dayEvents.length > 1 ? "s" : ""}: ${dayEvents.map(e => e.title).join(", ")}` : ", nothing scheduled"}`}
                          style={{
                            display: "flex", flexDirection: "column", alignItems: "center",
                            padding: "3px 0 0", minWidth: 0, minHeight: DATE_H + bodyH,
                            background: "none", border: "none", borderRadius: 8, cursor: "pointer",
                          }}>
                          <span className="t-num" style={{
                            width: 22, height: 22, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none",
                            fontSize: 12.5, fontWeight: todayFlag ? 700 : 500,
                            background: todayFlag ? "var(--accent)" : "transparent",
                            // Neighbouring-month days stay visible but recede —
                            // they exist so bars can cross the boundary, not to
                            // compete with the month you are looking at.
                            color: todayFlag ? "var(--on-accent)" : inMonth ? "var(--ink)" : "var(--faint)",
                          }}>{dayNum}</span>
                          {more > 0 && (
                            <span className="t-num" style={{ fontSize: 9.5, color: "var(--faint)", marginTop: "auto", paddingBottom: 2 }}>+{more}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {/* the bars, over the top */}
                  <div style={{ position: "absolute", left: 0, right: 0, top: DATE_H, height: bodyH, pointerEvents: "none" }}>
                    {segments.map((seg) => {
                      const { ev } = seg;
                      const tone = ev.overlay ? null : catColor(ev.category);
                      const w = `calc(${(seg.span / 7) * 100}% - 3px)`;
                      const l = `calc(${(seg.col / 7) * 100}% + 1.5px)`;
                      // A cut end is the WEEK boundary, not the event's own —
                      // squaring that corner is the only thing on screen that
                      // says the trip keeps going on the row below.
                      const radius = `${seg.continuesLeft ? 0 : 5}px ${seg.continuesRight ? 0 : 5}px ${seg.continuesRight ? 0 : 5}px ${seg.continuesLeft ? 0 : 5}px`;
                      return (
                        <div key={seg.key} title={ev.title}
                          style={{
                            position: "absolute", left: l, width: w, top: seg.lane * (LANE_H + LANE_GAP),
                            height: LANE_H, borderRadius: radius, overflow: "hidden",
                            display: "flex", alignItems: "center",
                            // 1px, not 4. The bar is 41.4px wide on a 375pt
                            // phone, so every pixel of padding is a pixel of
                            // name. Measured in the app with its own Inter:
                            // "Monkey" is 37.3px at the size below, which fits
                            // in the 39.4px this leaves and does not fit in the
                            // 37.4px that 2px a side leaves with any margin
                            // worth trusting. A six-letter word gets no break
                            // opportunities (see wrap-title.js), so if it does
                            // not fit there is nothing to catch it — the "y"
                            // ends up alone on line two.
                            padding: "0 1px", minWidth: 0,
                            // Overlays stay flat and quiet; your own events get
                            // the solid category colour and white text.
                            // --on-accent is defined per palette AND per
                            // theme to sit legibly on a saturated fill, which
                            // is exactly this job. Hard-coded white fails in
                            // the dark themes, where the data palette lightens
                            // to around 3:1 against it.
                            background: tone || "var(--surface-2)",
                            color: tone ? "var(--on-accent)" : "var(--sub)",
                          }}>
                          <span style={{
                            // 9.5, down from 10.5 — the same size the Brief's
                            // mini calendar already uses, so the two calendars
                            // finally agree. Half a point buys a whole
                            // character a line here: measured over twenty real
                            // titles, 15 of 20 fit inside two lines at 10px
                            // and 19 of 20 at 9.5. "Brewers Game" and "Grandpa
                            // Dittmer" are the difference, and they are names
                            // you need to read, not recognise.
                            fontSize: 9.5, lineHeight: 1.15, fontWeight: 600, minWidth: 0,
                            // A touch tighter than default. At this size it is
                            // invisible as texture and worth roughly a
                            // character a line, which is the difference
                            // between "Jordan" and "Jorda" over a lone "n".
                            letterSpacing: "-0.012em",
                            overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                            // break-word is the FLOOR, not the plan: softWrapTitle
                            // supplies the break points (see lib/wrap-title.js),
                            // and this only catches a word so wide that even
                            // those overrun. The old value here was the legacy
                            // `word-break: break-word`, which is the one that
                            // breaks anywhere it likes and strands single
                            // letters; it must not come back.
                            wordBreak: "normal", overflowWrap: "break-word",
                          }}>
                            {segmentShowsTitle(seg) ? softWrapTitle(ev.title) : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── day agenda ── */}
      {!loadErr && events !== null && !bulkOpen && !showUpcoming && selectedDay !== null && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 40 }}>
            <Button kind="plain" size="sm" onClick={() => setSelectedDay(null)} style={{ paddingLeft: 2, marginLeft: -8, height: 40 }}>
              <IcChevronLeft size={15} /> {monthLabel}
            </Button>
            {/* Always reachable. Holidays and birthdays mean a day can be
                "occupied" without you having put anything on it, and the tap
                that used to start a new event now opens this view instead —
                so the add has to live here rather than only in the empty
                state it would otherwise hide behind. */}
            <Button kind="plain" size="sm" onClick={() => openNew(selectedDay)} style={{ marginLeft: "auto", height: 40 }}>Add event</Button>
          </div>
          <div className="t-head" style={{ padding: "0 4px" }}>{selectedDayLabel}</div>
          {selectedDayEvents.length === 0 ? (
            <Card pad="md">
              <EmptyState icon={<IcCalendar size={26} />} title="Nothing yet"
                sub="This day is clear."
                action={<Button kind="tinted" size="sm" onClick={() => openNew(selectedDay)}>Add event</Button>} />
            </Card>
          ) : (
            <CellGroup>{selectedDayEvents.map((ev) => renderEvent(ev, selectedDay))}</CellGroup>
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
                <Button kind="danger" size="lg" onClick={(e) => removeEvent({ masterId: form.id, id: form.id, occurrenceDay: form.occurrenceDay }, e)} style={{ flex: "none" }}>Delete</Button>
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
            {/* Two DATES, always — the end one is what makes a multi-day event
                expressible at all. Leave it blank for a single day; the
                readback under the row says which you have. Times appear only
                when the all-day switch is off, and they start EMPTY. */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label style={{ flex: "1 1 130px", display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="t-cap" style={{ color: "var(--faint)" }}>Starts</span>
                <input type="date" className="field" value={form.date}
                  onChange={e => setForm(f => ({
                    ...f,
                    date: e.target.value,
                    // Dragging the start past the end would otherwise store a
                    // backwards span that renders as a single day with no
                    // explanation. The end follows instead.
                    endDate: f.endDate && f.endDate < e.target.value ? "" : f.endDate,
                  }))}
                  style={{ fontFamily: "var(--font-mono)" }} />
              </label>
              <label style={{ flex: "1 1 130px", display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="t-cap" style={{ color: "var(--faint)" }}>Ends</span>
                <input type="date" className="field" value={form.endDate} min={form.date}
                  onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))}
                  title="End date — leave blank for a single day" style={{ fontFamily: "var(--font-mono)" }} />
              </label>
              {!form.allDay && (
                <>
                  <label style={{ flex: "1 1 96px", display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="t-cap" style={{ color: "var(--faint)" }}>From</span>
                    <input type="time" className="field" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))}
                      title="Start time (optional — blank stays all-day)" style={{ fontFamily: "var(--font-mono)" }} />
                  </label>
                  <label style={{ flex: "1 1 96px", display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="t-cap" style={{ color: "var(--faint)" }}>To</span>
                    <input type="time" className="field" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                      title="End time (optional)" style={{ fontFamily: "var(--font-mono)" }} />
                  </label>
                </>
              )}
            </div>
            {/* What those four fields actually add up to, in English. The
                all-day switch, an empty time and a second date interact, and
                a form where you have to simulate the save to know what you
                get is a form that gets it wrong. */}
            <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, marginTop: -4 }}>{draftReadback(form)}</div>
            {/* ── Repeat ──────────────────────────────────────────────────
                Progressive: one row of pills until something other than
                "Once" is chosen, and only then do the interval, the weekday
                picker and the end condition appear. A repeat block that shows
                all six controls to someone adding a dentist appointment is
                the reason most calendar forms feel heavy. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="t-cap" style={{ color: "var(--faint)" }}>Repeat</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[["", "Once"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["yearly", "Yearly"]].map(([k, label]) => (
                  <Pill key={k || "once"} active={form.freq === k}
                    onClick={() => setForm(f => ({ ...f, freq: k, interval: 1, byWeekday: [] }))}>{label}</Pill>
                ))}
              </div>

              {form.freq && (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="t-foot" style={{ color: "var(--sub)" }}>Every</span>
                    <input type="number" min="1" max="52" className="field t-num" value={form.interval}
                      onChange={e => setForm(f => ({ ...f, interval: e.target.value.replace(/\D/g, "") || 1 }))}
                      style={{ width: 64, flex: "none", textAlign: "center" }} aria-label="Repeat interval" />
                    <span className="t-foot" style={{ color: "var(--sub)" }}>
                      {form.freq === "daily" ? "day(s)" : form.freq === "weekly" ? "week(s)" : form.freq === "monthly" ? "month(s)" : "year(s)"}
                    </span>
                  </div>

                  {form.freq === "weekly" && (
                    <div style={{ display: "flex", gap: 4 }}>
                      {WEEKDAY_LABELS.map((lbl, i) => {
                        const on = form.byWeekday.includes(i);
                        return (
                          <button key={i} aria-label={`Repeat on weekday ${i}`} aria-pressed={on}
                            onClick={() => setForm(f => ({
                              ...f,
                              byWeekday: f.byWeekday.includes(i) ? f.byWeekday.filter(d => d !== i) : [...f.byWeekday, i],
                            }))}
                            style={{
                              flex: 1, height: 40, borderRadius: 10, border: "none", cursor: "pointer",
                              fontSize: 12.5, fontWeight: 600,
                              background: on ? tint(T.accent, 16) : "var(--surface-2)",
                              color: on ? "var(--accent)" : "var(--sub)",
                            }}>{lbl}</button>
                        );
                      })}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {[["never", "Forever"], ["on", "Until"], ["after", "For N"]].map(([k, label]) => (
                      <Pill key={k} active={form.endMode === k} onClick={() => setForm(f => ({ ...f, endMode: k }))}>{label}</Pill>
                    ))}
                    {form.endMode === "on" && (
                      <input type="date" className="field" value={form.until} min={form.date}
                        onChange={e => setForm(f => ({ ...f, until: e.target.value }))}
                        style={{ flex: "1 1 150px", fontFamily: "var(--font-mono)" }} aria-label="Repeat until" />
                    )}
                    {form.endMode === "after" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <input type="number" min="1" max="750" className="field t-num" value={form.count}
                          onChange={e => setForm(f => ({ ...f, count: e.target.value.replace(/\D/g, "") || 1 }))}
                          style={{ width: 72, flex: "none", textAlign: "center" }} aria-label="Number of occurrences" />
                        <span className="t-foot" style={{ color: "var(--sub)" }}>times</span>
                      </span>
                    )}
                  </div>

                  {/* The rule read back in English — the only way to be sure
                      the pills above say what you meant. */}
                  <div className="t-foot" style={{ color: "var(--sub)" }}>
                    {describeRule(draftRule(form), new Date(`${form.date}T12:00:00`))}
                  </div>
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

      {/* ── Which ones did you mean? ────────────────────────────────────────
          The question every calendar has to ask, asked only when it is
          genuinely ambiguous: editing or deleting ONE occurrence of something
          that repeats. A one-off never sees this sheet. "This event" is
          listed first and styled plainest because it is the safe answer —
          the destructive one should never be the easy mis-tap. */}
      {scopeAsk && (
        <Sheet
          onClose={() => setScopeAsk(null)}
          title={scopeAsk.mode === "delete" ? "Delete repeating event" : "Save repeating event"}
        >
          <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.55, paddingBottom: 12 }}>
            {/* Only the first letter drops case — lowercasing the whole
                sentence turned "Mon, Wed, Fri" into "mon, wed, fri". */}
            “{scopeAsk.master.title}” repeats — {(() => {
              const s = describeRule(scopeAsk.master.rrule, scopeAsk.master.start_time);
              return s.charAt(0).toLowerCase() + s.slice(1);
            })()}.
            {scopeAsk.mode === "delete" ? " Which occurrences should go?" : " Which occurrences should change?"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              ["one", "This event only", "Leaves the rest of the series exactly as it is."],
              ["future", "This and all future", "Earlier occurrences keep what they already had."],
              ["all", "All events in the series", "Including the ones already past."],
            ].map(([scope, label, sub]) => (
              <button key={scope} onClick={() => applyScope(scope)} disabled={saving}
                style={{
                  textAlign: "left", background: "var(--surface-2)", border: "none", borderRadius: 12,
                  padding: "12px 14px", cursor: "pointer", color: "inherit", font: "inherit",
                  opacity: saving ? 0.6 : 1,
                }}>
                <div className="t-body" style={{ fontWeight: 500, color: scope === "all" && scopeAsk.mode === "delete" ? "var(--red)" : "var(--ink)" }}>{label}</div>
                <div className="t-cap" style={{ color: "var(--faint)", marginTop: 2 }}>{sub}</div>
              </button>
            ))}
            <Button kind="quiet" size="md" onClick={() => setScopeAsk(null)} disabled={saving}>Cancel</Button>
          </div>
        </Sheet>
      )}

      {confirmEl}
    </section>
  );
}

export default CalendarPanel;
