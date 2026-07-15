import { useState, useEffect, useRef } from "react";
import { T, syne, mono } from "../../theme.js";
import { S } from "../../ui/styles.js";
import { Toggle } from "../../ui/primitives.jsx";
import { callClaude } from "../../lib/claude.js";
import { formatSnapshotForChat } from "../../lib/snapshot.js";
import { nextBirthdayOccurrence } from "../../lib/dates.js";
import { upkeepDue } from "../../lib/upkeep.js";
import { useEvents } from "../../data/calendar.js";
import { useUpkeep } from "../../data/upkeep.js";
import { useBirthdays } from "../../data/birthdays.js";
import { useNotes } from "../../data/notes.js";

// ─── The Chief's word — the room's read on the day, morning and evening ──────
// Before 17:00 it's The Morning Word: the Chief reads what's ahead (calendar,
// upkeep, birthdays, markets) and names the first move. From 17:00 it becomes
// The Evening Ledger: an honest close of the books — what actually moved, what
// slipped, and tomorrow's opening action. Each edition is one haiku call,
// cached per-day/per-mode in app_settings so it follows Cameron across devices.
// Spends a model call ONLY on tap, or once per edition when Auto is on.
// The context chips underneath are deterministic — pure reads of the query
// cache, tappable straight into the owning tab, live even before convening.

const sameDay = (iso, now) => {
  const x = new Date(iso);
  return x.getFullYear() === now.getFullYear() && x.getMonth() === now.getMonth() && x.getDate() === now.getDate();
};
const fmtT = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export function ChiefsWord({ isMobile, settings, updateSetting, onJump }) {
  const card = isMobile ? S.cardM : S.card;
  const todayKey = new Date().toISOString().slice(0, 10);
  const mode = new Date().getHours() >= 17 ? "evening" : "morning";
  const saved = settings?.chiefs_word;
  const savedToday = saved?.date === todayKey ? saved : null;
  const savedMode = savedToday ? (savedToday.mode || "morning") : null;
  const wordForMode = savedToday && savedMode === mode ? savedToday : null;
  const shown = wordForMode || savedToday; // evening still shows the morning word until the ledger is convened
  const auto = !!settings?.chiefs_word_auto;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { data: events, isLoading: evLoading } = useEvents();
  const { data: upkeep, isLoading: upLoading } = useUpkeep();
  const { data: birthdays, isLoading: bdLoading } = useBirthdays();
  const { data: notesData } = useNotes();

  const generate = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    const now = new Date();
    const lines = [`Now: ${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}, ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`];
    const todays = (events || []).filter(e => e.start_time && sameDay(e.start_time, now));
    const due = (upkeep || []).map(it => ({ ...it, meta: upkeepDue(it) })).filter(x => x.meta.never || x.meta.dueIn <= 3);
    const bdays = (birthdays || []).map(b => ({ ...b, ...nextBirthdayOccurrence(b.month, b.day) })).filter(b => b.daysUntil <= 7).sort((a, b) => a.daysUntil - b.daysUntil).slice(0, 5);
    let system;
    if (mode === "morning") {
      if (todays.length) lines.push(`On today's calendar: ${todays.slice(0, 6).map(e => `${e.title}${e.all_day ? " (all day)" : ` at ${fmtT(e.start_time)}`}`).join("; ")}.`);
      if (due.length) lines.push(`Upkeep due: ${due.map(x => `${x.name} (${x.meta.never ? "never logged" : x.meta.dueIn <= 0 ? "overdue" : `due in ${x.meta.dueIn}d`})`).join("; ")}.`);
      if (bdays.length) lines.push(`Birthdays: ${bdays.map(b => `${b.name} ${b.daysUntil === 0 ? "TODAY" : `in ${b.daysUntil}d`}`).join("; ")}.`);
      system = `You are the Chief of Staff writing Cameron's morning word — the first thing he reads today. Use ONLY the data below; never invent events, numbers, or names, and if a section is absent simply don't mention it. Voice: composed, direct, a touch of warmth — a chief, not a cheerleader. Format: 3-5 short sentences reading the day (what matters, what's moving, what can slip), then a final line starting exactly with "First move:" naming the single best next action. No headers, no bullets, no preamble.\n\n${lines.join("\n")}${formatSnapshotForChat()}`;
    } else {
      const past = todays.filter(e => !e.all_day && new Date(e.start_time) <= now);
      const ahead = todays.filter(e => e.all_day || new Date(e.start_time) > now);
      if (past.length) lines.push(`Happened today: ${past.slice(0, 6).map(e => `${e.title} at ${fmtT(e.start_time)}`).join("; ")}.`);
      if (ahead.length) lines.push(`Still on today's calendar: ${ahead.slice(0, 4).map(e => `${e.title}${e.all_day ? " (all day)" : ` at ${fmtT(e.start_time)}`}`).join("; ")}.`);
      const loggedToday = (upkeep || []).filter(it => String(it.last_done || "").slice(0, 10) === todayKey);
      if (loggedToday.length) lines.push(`Upkeep logged today: ${loggedToday.map(x => x.name).join("; ")}.`);
      if (due.length) lines.push(`Upkeep still open: ${due.map(x => `${x.name} (${x.meta.never ? "never logged" : x.meta.dueIn <= 0 ? "overdue" : `due in ${x.meta.dueIn}d`})`).join("; ")}.`);
      const notesToday = (notesData?.rows || []).filter(n => String(n.created_at || "").slice(0, 10) === todayKey);
      if (notesToday.length) lines.push(`Notes captured today: ${notesToday.length}${notesToday.length ? ` (${notesToday.slice(0, 3).map(n => (n.title || n.body || "").split("\n")[0].slice(0, 40)).filter(Boolean).join("; ")})` : ""}.`);
      const bdTomorrow = bdays.filter(b => b.daysUntil <= 1);
      if (bdTomorrow.length) lines.push(`Birthdays now/tomorrow: ${bdTomorrow.map(b => `${b.name} ${b.daysUntil === 0 ? "TODAY" : "tomorrow"}`).join("; ")}.`);
      system = `You are the Chief of Staff writing Cameron's evening ledger — the honest close of today's books. Use ONLY the data below; never invent events, numbers, or names, and if a section is absent simply don't mention it. Voice: composed and candid — credit what moved, name what slipped, no cheerleading. Format: 3-5 short sentences closing the day, then a final line starting exactly with "First move:" naming tomorrow's single best opening action. No headers, no bullets, no preamble.\n\n${lines.join("\n")}${formatSnapshotForChat()}`;
    }
    const text = await callClaude({ system, messages: [{ role: "user", content: mode === "morning" ? "Convene the morning word." : "Close the day." }], modelKey: "haiku", maxTokens: 350, fn: `chiefs_${mode}` });
    setBusy(false);
    if (text && text.trim()) updateSetting("chiefs_word", { date: todayKey, mode, text: text.trim(), at: Date.now() });
    else setErr("Couldn't reach the Chief — try again in a moment.");
  };

  // Auto (opt-in): each edition convenes itself once its data has settled —
  // at most one attempt per edition per mount, so a failure never loops.
  const attempted = useRef({});
  const queriesSettled = !evLoading && !upLoading && !bdLoading;
  useEffect(() => {
    if (!auto || wordForMode || busy || attempted.current[mode] || !settings || !queriesSettled) return;
    attempted.current[mode] = true;
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, wordForMode, settings, queriesSettled, mode]);

  // ─── deterministic context chips — the day at a glance, tappable ───
  const now = new Date();
  const todayCount = (events || []).filter(e => e.start_time && sameDay(e.start_time, now)).length;
  const dueCount = (upkeep || []).map(it => upkeepDue(it)).filter(m => m.never || m.dueIn <= 3).length;
  const bdayCount = (birthdays || []).map(b => nextBirthdayOccurrence(b.month, b.day)).filter(b => b.daysUntil <= 7).length;
  const chips = [
    todayCount > 0 && { label: `${todayCount} on the calendar`, go: { page: "personal", sub: "calendar" } },
    dueCount > 0 && { label: `${dueCount} upkeep due`, go: { page: "personal", sub: "upkeep" } },
    bdayCount > 0 && { label: `${bdayCount} birthday${bdayCount > 1 ? "s" : ""} soon`, go: { page: "personal", sub: "birthdays" } },
  ].filter(Boolean);

  const title = mode === "evening" ? "The Evening Ledger" : "The Morning Word";
  const dateLabel = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  const fmtAt = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const conveneLabel = busy ? "Convening…"
    : !shown && !err ? (mode === "morning" ? "Convene the brief" : "Close the day")
    : shown && savedMode !== mode ? "Close the day"
    : err ? "Try again" : "Convene again";
  const primary = !shown || (shown && savedMode !== mode); // brass while an edition is waiting to be convened

  const splitWord = (text) => {
    const m = text.match(/first move:/i);
    if (!m) return { body: text, move: null };
    return { body: text.slice(0, m.index).trim(), move: text.slice(m.index + m[0].length).trim() };
  };
  const parts = shown ? splitWord(shown.text) : null;

  return (
    <div style={{ ...card, background: "var(--brass-a06)", border: "1px solid var(--brass-a20)", boxShadow: "inset 0 1px 0 var(--white-edge)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10, flexWrap: "wrap" }}>
        {/* solid diamond at dawn, hollow at dusk */}
        <span style={{ width: 7, height: 7, transform: "rotate(45deg)", borderRadius: 1.5, flex: "none", ...(mode === "evening" ? { background: "transparent", border: `1.5px solid ${T.brass}` } : { background: T.brass, boxShadow: "0 0 10px var(--brass-a40)" }) }} />
        <span style={S.title}>{title}</span>
        <span style={S.microLabel}>{dateLabel}</span>
        <span style={{ flex: 1 }} />
        {shown && <span style={S.microLabel}>{savedMode === "evening" ? "ledger" : "word"} convened {fmtAt(shown.at)}</span>}
      </div>

      {busy ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 9, padding: "2px 0 4px" }}>
          <div className="sk sk-line w80" style={{ margin: 0 }} />
          <div className="sk sk-line w60" style={{ margin: 0 }} />
          <div className="sk sk-line w40" style={{ margin: 0 }} />
        </div>
      ) : shown ? (
        <>
          <div style={{ fontSize: isMobile ? 13 : 13.5, lineHeight: 1.78, color: T.ink, whiteSpace: "pre-wrap", overflowWrap: "break-word" }}>{parts.body}</div>
          {parts.move && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--brass-a20)" }}>
              <span style={{ fontSize: 9, fontWeight: 700, fontFamily: mono, letterSpacing: "0.14em", color: T.brass, flex: "none" }}>{savedMode === "evening" ? "TOMORROW'S FIRST MOVE" : "FIRST MOVE"}</span>
              <span style={{ fontSize: isMobile ? 12.5 : 13, fontWeight: 600, fontFamily: syne, color: T.ink, lineHeight: 1.6 }}>{parts.move}</span>
            </div>
          )}
        </>
      ) : err ? (
        <div style={{ fontSize: 11.5, color: T.faint, lineHeight: 1.6 }}>{err}</div>
      ) : (
        <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.65 }}>
          {mode === "morning"
            ? "One tap and the Chief reads the room — calendar, upkeep, birthdays, markets — and hands you the day in a few sentences, with one clear first move."
            : "One tap and the Chief closes the books — what moved today, what's still open — and sets tomorrow's opening action."}
        </div>
      )}

      {chips.length > 0 && (
        <div style={{ display: "flex", gap: 7, marginTop: 12, flexWrap: "wrap" }}>
          {chips.map(c => (
            <button key={c.label} onClick={() => onJump?.(c.go)}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 12px", background: "transparent", border: "1px solid var(--brass-a20)", borderRadius: 999, color: T.sub, fontSize: 9.5, fontFamily: mono, letterSpacing: "0.06em", cursor: "pointer" }}>
              <span style={{ width: 4, height: 4, transform: "rotate(45deg)", background: T.brass, borderRadius: 1, flex: "none" }} />
              {c.label.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        <button onClick={generate} disabled={busy}
          style={{ ...(primary ? S.brassBtn : { ...S.ghostBtn, color: T.brass, borderColor: "var(--brass-a32)" }), padding: "8px 16px", fontSize: 11, opacity: busy ? 0.6 : 1 }}>
          {conveneLabel}
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <Toggle on={auto} onToggle={() => updateSetting("chiefs_word_auto", !auto)} size={16} />
          <span style={{ ...S.microLabel, cursor: "pointer" }} onClick={() => updateSetting("chiefs_word_auto", !auto)}>Auto at dawn &amp; dusk</span>
        </span>
      </div>
    </div>
  );
}
