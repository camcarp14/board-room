// ─── The Docket — the day, assembled ─────────────────────────────────────────
// A zero-token overview at the top of the Brief: today's calendar, birthdays
// on approach, upkeep that's come due, the next macro event, and what's queued
// for Mini Me. Pure aggregation of data the app already owns — nothing here
// ever spends a model call.
import { Card, Dot } from "../../ui/kit.jsx";
import { IcChevronRight, IcCheck } from "../../ui/icons.jsx";
import { T } from "../../theme.js";
import { useEvents } from "../../data/calendar.js";
import { useUpkeep, useMarkUpkeepDone } from "../../data/upkeep.js";
import { upkeepDue } from "../../lib/upkeep.js";
import { nextBirthdayOccurrence, todayISO } from "../../lib/dates.js";

export function DocketCard({ isMobile, birthdays, birthdaysErr, macroEvents, settings, onOpenCalendar, onOpenQueue, onOpenBirthdays }) {
  // Shares the same cached events/upkeep the Calendar and Upkeep tabs read, so
  // the Docket refetches with the header Refresh and never double-fetches. On
  // error each section just stays quiet (empty), as before.
  const { data: allEvents, error: eventsErr } = useEvents();
  const { data: allUpkeep, error: upkeepErr } = useUpkeep();
  const markUpkeepDone = useMarkUpkeepDone();
  // Tap an upkeep row to log it done — same optimistic mutation the Upkeep tab
  // uses (strip the derived `meta` before it hits the DB). It vanishes from the
  // due list on the next render.
  const logUpkeepDone = (it) => { const { meta, ...item } = it; markUpkeepDone.mutate({ item, today: todayISO() }); };
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
  const bdayTag = (b) => b.daysUntil === 0 ? "Today" : b.daysUntil === 1 ? "Tmrw" : b.next.toLocaleDateString("en-US", { weekday: "short" });

  // one flat, prioritized list: birthdays today → calendar → macro → upkeep → queue
  const rows = [];
  if (!loading) {
    bdays.filter(b => b.daysUntil === 0).forEach(b => rows.push({ c: T.pink, tag: "Today", text: `${b.name}'s birthday`, onClick: onOpenBirthdays }));
    (todayEvents || []).forEach(e => rows.push({ c: T.blue, tag: fmtEvTime(e), text: e.title + (e.location ? ` · ${e.location}` : ""), onClick: onOpenCalendar }));
    if (nextMacro) rows.push({ c: T.blue, tag: nextMacro.time, text: nextMacro.text });
    (upkeepDueItems || []).forEach(it => rows.push({
      c: it.meta.never || it.meta.dueIn <= 0 ? T.red : T.amber,
      // dueIn === 0 is due TODAY, not overdue — the tag and the row text agree now
      tag: it.meta.never ? "Start" : it.meta.dueIn < 0 ? "Overdue" : it.meta.dueIn === 0 ? "Due today" : "Due soon",
      text: it.name + (it.meta.dueIn < 0 ? ` — ${Math.abs(it.meta.dueIn)} days past due` : it.meta.dueIn > 0 ? ` — due in ${it.meta.dueIn}d` : " — due today"),
      onDone: () => logUpkeepDone(it),
    }));
    bdays.filter(b => b.daysUntil > 0).forEach(b => rows.push({ c: T.pink, tag: bdayTag(b), text: `${b.name}'s birthday in ${b.daysUntil}d`, onClick: onOpenBirthdays }));
    if (queued > 0) rows.push({ c: T.purple, tag: "Queue", text: `${queued} task${queued === 1 ? "" : "s"} waiting on Mini Me`, onClick: onOpenQueue });
  }

  const summaryBits = [];
  if (!loading) {
    if ((todayEvents || []).length) summaryBits.push(`${todayEvents.length} on the calendar`);
    const od = (upkeepDueItems || []).filter(x => x.meta.never || x.meta.dueIn <= 0).length;
    if (od) summaryBits.push(`${od} upkeep item${od === 1 ? "" : "s"} due`);
    if (bdays.length) summaryBits.push(`${bdays.length} birthday${bdays.length === 1 ? "" : "s"} this week`);
  }
  // A failed fetch must not read as an authoritative "clear slate" — say we
  // couldn't check rather than confidently asserting an empty day.
  const anyErr = eventsErr || upkeepErr || birthdaysErr;
  const summary = loading ? "Pulling the day together…"
    : summaryBits.length ? `${summaryBits.join(" · ")}.`
    : anyErr ? "Couldn't check part of the day — refresh to retry."
    : "Clear slate — nothing on the books. Set the agenda yourself.";

  return (
    <Card pad={isMobile ? "md" : "lg"} style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-head">The Docket</span>
        <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{dateLabel}</span>
      </div>
      <div className="t-title2" style={{ marginTop: 6 }}>{greeting}, Cameron.</div>
      <div className="t-foot" style={{ marginTop: 2, marginBottom: rows.length || loading ? 6 : 0 }}>{summary}</div>
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 2 }}>
          <div className="sk sk-line w80" style={{ margin: 0 }} />
          <div className="sk sk-line w60" style={{ margin: 0 }} />
        </div>
      ) : rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((r, i) => {
            const action = r.onClick || r.onDone; // upkeep rows log done; the rest deep-link
            const Tag = action ? "button" : "div";
            return (
              <Tag key={i} onClick={action} className={action ? "hoverable" : undefined}
                aria-label={r.onDone ? `Log done — ${r.text}` : undefined}
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: action ? 44 : 34,
                  padding: "3px 0", background: "none", border: "none",
                  borderTop: i === 0 ? "none" : "0.5px solid var(--line)",
                  textAlign: "left", color: "inherit", font: "inherit", borderRadius: 0,
                  cursor: action ? "pointer" : undefined,
                }}>
                <Dot tone={r.c} />
                <span className="t-num" style={{ fontSize: 11.5, color: r.c, flex: "none", minWidth: 50, whiteSpace: "nowrap" }}>{r.tag}</span>
                <span className="t-call" style={{ flex: 1, minWidth: 0, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{r.text}</span>
                {r.onDone
                  ? <span title="Log done" style={{ color: "var(--green)", display: "inline-flex", flex: "none" }}><IcCheck /></span>
                  : r.onClick ? <span style={{ color: "var(--faint)", display: "inline-flex", flex: "none" }}><IcChevronRight /></span> : null}
              </Tag>
            );
          })}
        </div>
      )}
    </Card>
  );
}
