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

// ─── The Morning Word — the Chief reads the room so Cameron doesn't have to ──
// One tap synthesizes the day (calendar, upkeep, birthdays, markets, wire) into
// a few grounded sentences and a single "First move". Cached per-day in
// app_settings so it costs one haiku call a day and follows him across devices.
// Spends a model call ONLY on tap, or each morning when Auto is switched on.
export function ChiefsWord({ isMobile, settings, updateSetting }) {
  const card = isMobile ? S.cardM : S.card;
  const todayKey = new Date().toISOString().slice(0, 10);
  const saved = settings?.chiefs_word;
  const word = saved?.date === todayKey ? saved : null;
  const auto = !!settings?.chiefs_word_auto;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { data: events, isLoading: evLoading } = useEvents();
  const { data: upkeep, isLoading: upLoading } = useUpkeep();
  const { data: birthdays, isLoading: bdLoading } = useBirthdays();

  const generate = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    const now = new Date();
    const sameDay = (iso) => { const x = new Date(iso); return x.getFullYear() === now.getFullYear() && x.getMonth() === now.getMonth() && x.getDate() === now.getDate(); };
    const fmtT = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const lines = [`Now: ${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}, ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`];
    const todays = (events || []).filter(e => e.start_time && sameDay(e.start_time)).slice(0, 6);
    if (todays.length) lines.push(`On today's calendar: ${todays.map(e => `${e.title}${e.all_day ? " (all day)" : ` at ${fmtT(e.start_time)}`}`).join("; ")}.`);
    const due = (upkeep || []).map(it => ({ ...it, meta: upkeepDue(it) })).filter(x => x.meta.never || x.meta.dueIn <= 3);
    if (due.length) lines.push(`Upkeep due: ${due.map(x => `${x.name} (${x.meta.never ? "never logged" : x.meta.dueIn <= 0 ? "overdue" : `due in ${x.meta.dueIn}d`})`).join("; ")}.`);
    const bdays = (birthdays || []).map(b => ({ ...b, ...nextBirthdayOccurrence(b.month, b.day) })).filter(b => b.daysUntil <= 7).sort((a, b) => a.daysUntil - b.daysUntil).slice(0, 5);
    if (bdays.length) lines.push(`Birthdays: ${bdays.map(b => `${b.name} ${b.daysUntil === 0 ? "TODAY" : `in ${b.daysUntil}d`}`).join("; ")}.`);
    const system = `You are the Chief of Staff writing Cameron's morning word — the first thing he reads today. Use ONLY the data below; never invent events, numbers, or names, and if a section is absent simply don't mention it. Voice: composed, direct, a touch of warmth — a chief, not a cheerleader. Format: 3-5 short sentences reading the day (what matters, what's moving, what can slip), then a final line starting exactly with "First move:" naming the single best next action. No headers, no bullets, no preamble.\n\n${lines.join("\n")}${formatSnapshotForChat()}`;
    const text = await callClaude({ system, messages: [{ role: "user", content: "Convene the morning word." }], modelKey: "haiku", maxTokens: 350, fn: "chiefs_word" });
    setBusy(false);
    if (text && text.trim()) updateSetting("chiefs_word", { date: todayKey, text: text.trim(), at: Date.now() });
    else setErr("Couldn't reach the Chief — try again in a moment.");
  };

  // Auto at dawn (opt-in): first Brief visit of the day convenes it once the
  // cached queries have settled, one attempt per mount so a failure never loops.
  const attempted = useRef(false);
  const queriesSettled = !evLoading && !upLoading && !bdLoading;
  useEffect(() => {
    if (!auto || word || busy || attempted.current || !settings || !queriesSettled) return;
    attempted.current = true;
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, word, settings, queriesSettled]);

  const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  const fmtAt = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  // Set the "First move:" line apart from the reading — the day's one action.
  const splitWord = (text) => {
    const m = text.match(/first move:/i);
    if (!m) return { body: text, move: null };
    return { body: text.slice(0, m.index).trim(), move: text.slice(m.index + m[0].length).trim() };
  };
  const parts = word ? splitWord(word.text) : null;

  return (
    <div style={{ ...card, background: "var(--brass-a06)", border: "1px solid var(--brass-a20)", boxShadow: "inset 0 1px 0 var(--white-edge)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ width: 7, height: 7, transform: "rotate(45deg)", background: T.brass, borderRadius: 1.5, boxShadow: "0 0 10px var(--brass-a40)", flex: "none" }} />
        <span style={S.title}>The Morning Word</span>
        <span style={S.microLabel}>{dateLabel}</span>
        <span style={{ flex: 1 }} />
        {word && <span style={S.microLabel}>convened {fmtAt(word.at)}</span>}
      </div>

      {busy ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 9, padding: "2px 0 4px" }}>
          <div className="sk sk-line w80" style={{ margin: 0 }} />
          <div className="sk sk-line w60" style={{ margin: 0 }} />
          <div className="sk sk-line w40" style={{ margin: 0 }} />
        </div>
      ) : word ? (
        <>
          <div style={{ fontSize: isMobile ? 13 : 13.5, lineHeight: 1.78, color: T.ink, whiteSpace: "pre-wrap", overflowWrap: "break-word" }}>{parts.body}</div>
          {parts.move && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--brass-a20)" }}>
              <span style={{ fontSize: 9, fontWeight: 700, fontFamily: mono, letterSpacing: "0.14em", color: T.brass, flex: "none" }}>FIRST MOVE</span>
              <span style={{ fontSize: isMobile ? 12.5 : 13, fontWeight: 600, fontFamily: syne, color: T.ink, lineHeight: 1.6 }}>{parts.move}</span>
            </div>
          )}
        </>
      ) : err ? (
        <div style={{ fontSize: 11.5, color: T.faint, lineHeight: 1.6 }}>{err}</div>
      ) : (
        <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.65 }}>
          One tap and the Chief reads the room — calendar, upkeep, birthdays, markets — and hands you the day in a few sentences, with one clear first move.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        <button onClick={generate} disabled={busy}
          style={{ ...(word || err ? { ...S.ghostBtn, color: T.brass, borderColor: "var(--brass-a32)" } : S.brassBtn), padding: "8px 16px", fontSize: 11, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Convening…" : word ? "Convene again" : err ? "Try again" : "Convene the brief"}
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <Toggle on={auto} onToggle={() => updateSetting("chiefs_word_auto", !auto)} size={16} />
          <span style={{ ...S.microLabel, cursor: "pointer" }} onClick={() => updateSetting("chiefs_word_auto", !auto)}>Auto at dawn</span>
        </span>
      </div>
    </div>
  );
}
