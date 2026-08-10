// ─── The Docket — the day, assembled ─────────────────────────────────────────
// A zero-token overview at the top of the Brief: today's calendar, birthdays
// on approach, upkeep that's come due, the next macro event, and what's queued
// for Mini Me. Pure aggregation of data the app already owns — nothing here
// ever spends a model call.
import { Card, Dot } from "../../ui/kit.jsx";
import { IcChevronRight, IcCheck } from "../../ui/icons.jsx";
import { T } from "../../theme.js";
import { useEvents } from "../../data/calendar.js";
import { expandEvents } from "../../lib/recurrence.js";
import { spanDayKeys, spanPosition } from "../../lib/calendar-overlays.js";
import { useUpkeep, useMarkUpkeepDone } from "../../data/upkeep.js";
import { upkeepDue } from "../../lib/upkeep.js";
import { nextBirthdayOccurrence, todayISO } from "../../lib/dates.js";

export function DocketCard({ isMobile, birthdays, macroEvents, settings, onOpenCalendar, onOpenQueue, onOpenBirthdays }) {
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
  // TODAY'S CALENDAR, FROM OCCURRENCES — not from stored rows.
  //
  // This filtered `allEvents` on start_time matching today, which got two
  // whole classes of event wrong. A repeating event is ONE row whose
  // start_time is the day the series began, so the weekly standup appeared in
  // the Docket exactly once, in whatever week it was created, and never again.
  // And a multi-day event only ever showed on its first day — day two of a
  // four-day trip read as a clear calendar.
  //
  // expandEvents gives the occurrences; spanDayKeys says which days each one
  // covers. Same two functions the month grid uses, so the Brief and the
  // Calendar cannot disagree about what today holds.
  const todayKey = todayISO();
  const todayEvents = allEvents
    ? expandEvents(allEvents, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 92), now)
      .filter((o) => spanDayKeys(o).includes(todayKey))
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    : (eventsErr ? [] : null);
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

  // A trip says which day of it today is; everything else says its time.
  const fmtEvTime = (e) => {
    const span = spanPosition(e, todayKey);
    if (span.total > 1) return `Day ${span.index + 1}/${span.total}`;
    return e.all_day ? "All day" : new Date(e.start_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };
  const bdayTag = (b) => b.daysUntil === 0 ? "Today" : b.daysUntil === 1 ? "Tmrw" : b.next.toLocaleDateString("en-US", { weekday: "short" });

  // one flat, prioritized list: birthdays today → calendar → macro → upkeep → queue
  const rows = [];
  if (!loading) {
    bdays.filter(b => b.daysUntil === 0).forEach(b => rows.push({ c: T.pink, tag: "Today", text: `${b.name}'s birthday`, onClick: onOpenBirthdays }));
    (todayEvents || []).forEach(e => rows.push({ c: T.blue, tag: fmtEvTime(e), text: e.title + (e.location ? ` · ${e.location}` : ""), onClick: onOpenCalendar }));
    if (nextMacro) rows.push({ c: T.blue, tag: nextMacro.time, text: nextMacro.text });
    (upkeepDueItems || []).forEach(it => rows.push({
      c: it.meta.never || it.meta.dueIn <= 0 ? T.red : T.amber,
      tag: it.meta.never ? "Start" : it.meta.dueIn <= 0 ? "Overdue" : "Due soon",
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
  // A FAILED READ IS NOT A CLEAR DAY. With both reads in error this card said
  // "Clear slate — nothing on the books", which is the one substitution the house
  // rule forbids: an empty state standing in for a read that never landed. On the
  // Brief that is the worst place for it, because "nothing on the books" is a
  // sentence you act on — you go and do something else, having been told the
  // calendar is empty by a card that never saw the calendar.
  //
  // Named per slice, so a working calendar and a broken upkeep read say exactly
  // that instead of collapsing into one vague apology.
  const failedReads = [eventsErr && "the calendar", upkeepErr && "upkeep"].filter(Boolean);
  const summary = loading ? "Pulling the day together…"
    : failedReads.length && !summaryBits.length ? `Couldn't reach ${failedReads.join(" or ")} — this is not a clear day, it's an unread one.`
    : summaryBits.length ? `${summaryBits.join(" · ")}${failedReads.length ? ` · couldn't reach ${failedReads.join(" or ")}` : "."}`
    : "Clear slate — nothing on the books. Set the agenda yourself.";

  return (
    <Card pad={isMobile ? "md" : "lg"} style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-head">The Docket</span>
        <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{dateLabel}</span>
      </div>
      <div className="t-title2" style={{ marginTop: 6 }}>{greeting}, Cameron.</div>
      <div className="t-foot" style={{ marginTop: 2, marginBottom: rows.length || loading ? 6 : 0, color: failedReads.length ? "var(--amber)" : undefined }}>{summary}</div>
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
              <Tag key={`${r.tag}|${r.text}`} onClick={action} className={action ? "hoverable" : undefined}
                aria-label={r.onDone ? `Log done — ${r.text}` : undefined}
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: action ? 40 : 34,
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
