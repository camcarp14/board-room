// ─── The Docket — the day, assembled ─────────────────────────────────────────
// A zero-token overview at the top of the Brief: today's calendar, birthdays
// on approach, upkeep that's come due, the next macro event, and what's queued
// for Mini Me. Pure aggregation of data the app already owns — nothing here
// ever spends a model call.
import { Card, Dot } from "../../ui/kit.jsx";
import { IcChevronRight } from "../../ui/icons.jsx";
import { T } from "../../theme.js";
import { useEvents } from "../../data/calendar.js";
import { useUpkeep } from "../../data/upkeep.js";
import { upkeepDue } from "../../lib/upkeep.js";
import { nextBirthdayOccurrence } from "../../lib/dates.js";

export function DocketCard({ isMobile, birthdays, macroEvents, settings, onOpenCalendar }) {
  // Shares the same cached events/upkeep the Calendar and Upkeep tabs read, so
  // the Docket refetches with the header Refresh and never double-fetches. On
  // error each section just stays quiet (empty), as before.
  const { data: allEvents, error: eventsErr } = useEvents();
  const { data: allUpkeep, error: upkeepErr } = useUpkeep();
  const now = new Date();
  const sameDay = (iso) => {
    const x = new Date(iso);
    return x.getFullYear() === now.getFullYear() && x.getMonth() === now.getMonth() && x.getDate() === now.getDate();
  };
  const todayEvents = allEvents ? allEvents.filter(e => e.start_time && sameDay(e.start_time)) : (eventsErr ? [] : null);
  const upkeepDueItems = allUpkeep
    ? allUpkeep.map(it => ({ ...it, meta: upkeepDue(it) }))
        .filter(x => x.meta.never || x.meta.dueIn <= 3)
        .sort((a, b) => (a.meta.never ? -9999 : a.meta.dueIn) - (b.meta.never ? -9999 : b.meta.dueIn))
    : (upkeepErr ? [] : null);

  const h = new Date().getHours();
  const greeting = h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : h >= 17 && h < 22 ? "Good evening" : "Burning the midnight oil";
  const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

  const bdays = (birthdays || []).map(b => ({ ...b, ...nextBirthdayOccurrence(b.month, b.day) }))
    .filter(b => b.daysUntil <= 7).sort((a, b) => a.daysUntil - b.daysUntil);
  const nextMacro = (macroEvents || []).find(e => !e.isPast);
  const queued = (settings?.mini_tasks || []).filter(t => t.status === "queued").length;
  const loading = todayEvents === null || upkeepDueItems === null;

  const fmtEvTime = (e) => e.all_day ? "All day" : new Date(e.start_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const bdayTag = (b) => b.daysUntil === 0 ? "Today" : b.daysUntil === 1 ? "Tmrw" : new Date(Date.now() + b.daysUntil * 86400000).toLocaleDateString("en-US", { weekday: "short" });

  // one flat, prioritized list: birthdays today → calendar → macro → upkeep → queue
  const rows = [];
  if (!loading) {
    bdays.filter(b => b.daysUntil === 0).forEach(b => rows.push({ c: T.pink, tag: "Today", text: `${b.name}'s birthday — don't let it slide` }));
    (todayEvents || []).forEach(e => rows.push({ c: T.brass, tag: fmtEvTime(e), text: e.title + (e.location ? ` · ${e.location}` : ""), onClick: onOpenCalendar }));
    if (nextMacro) rows.push({ c: T.blue, tag: nextMacro.time, text: nextMacro.text });
    (upkeepDueItems || []).forEach(it => rows.push({
      c: it.meta.never || it.meta.dueIn <= 0 ? T.red : T.amber,
      tag: it.meta.never ? "Start" : it.meta.dueIn <= 0 ? "Overdue" : "Due soon",
      text: it.name + (it.meta.dueIn < 0 ? ` — ${Math.abs(it.meta.dueIn)} days past due` : it.meta.dueIn > 0 ? ` — due in ${it.meta.dueIn}d` : " — due today"),
    }));
    bdays.filter(b => b.daysUntil > 0).forEach(b => rows.push({ c: T.pink, tag: bdayTag(b), text: `${b.name}'s birthday in ${b.daysUntil}d` }));
    if (queued > 0) rows.push({ c: T.purple, tag: "Queue", text: `${queued} task${queued === 1 ? "" : "s"} waiting on Mini Me` });
  }

  const summaryBits = [];
  if (!loading) {
    if ((todayEvents || []).length) summaryBits.push(`${todayEvents.length} on the calendar`);
    const od = (upkeepDueItems || []).filter(x => x.meta.never || x.meta.dueIn <= 0).length;
    if (od) summaryBits.push(`${od} upkeep item${od === 1 ? "" : "s"} due`);
    if (bdays.length) summaryBits.push(`${bdays.length} birthday${bdays.length === 1 ? "" : "s"} this week`);
  }
  const summary = loading ? "Pulling the day together…"
    : summaryBits.length ? `${summaryBits.join(" · ")}.`
    : "Clear slate — nothing on the books. Set the agenda yourself.";

  return (
    <Card pad={isMobile ? "md" : "lg"} style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-cap" style={{ fontWeight: 600 }}>The docket</span>
        <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{dateLabel}</span>
      </div>
      <div className="t-title2" style={{ marginTop: 8 }}>{greeting}, Cameron.</div>
      <div className="t-foot" style={{ marginTop: 3, marginBottom: rows.length || loading ? 10 : 0 }}>{summary}</div>
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 2 }}>
          <div className="sk sk-line w80" style={{ margin: 0 }} />
          <div className="sk sk-line w60" style={{ margin: 0 }} />
        </div>
      ) : rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((r, i) => {
            const Tag = r.onClick ? "button" : "div";
            return (
              <Tag key={i} onClick={r.onClick} className={r.onClick ? "hoverable" : undefined}
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 44,
                  padding: "5px 0", background: "none", border: "none",
                  borderTop: i === 0 ? "none" : "0.5px solid var(--line)",
                  textAlign: "left", color: "inherit", font: "inherit", borderRadius: 0,
                  cursor: r.onClick ? "pointer" : undefined,
                }}>
                <Dot tone={r.c} />
                <span className="t-num" style={{ fontSize: 12, color: r.c, flex: "none", minWidth: 58, whiteSpace: "nowrap" }}>{r.tag}</span>
                <span className="t-call" style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>{r.text}</span>
                {r.onClick && <span style={{ color: "var(--faint)", display: "inline-flex", flex: "none" }}><IcChevronRight /></span>}
              </Tag>
            );
          })}
        </div>
      )}
    </Card>
  );
}
