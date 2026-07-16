// ─── Page: the morning brief ──────────────────────────────────────────────────
// Everything on this page is fetched live on load through Netlify functions.
// No fabricated fallback numbers anywhere on this page. Each card is either
// live (real data), not connected (with exact setup instructions), or error
// (with the actual failure). Empty dashes beat plausible-looking fake data.
import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { T } from "../../theme.js";
import { Card, SectionHeader, StatTile, Button, Dot, Delta, Grid } from "../../ui/kit.jsx";
import { IcChevronRight } from "../../ui/icons.jsx";
import { StancePill, StatusTag, CARD_STATES } from "../../ui/shared.jsx";
import { NumTween, Sparkline } from "../../ui/primitives.jsx";
import GscLineChart from "../../GscLineChart.jsx";
// Lazy — pulls lightweight-charts (~a quarter of the old bundle) into its own
// chunk that loads only when you actually open a price chart.
const BtcChartModal = lazy(() => import("../../BtcChartModal.jsx"));
import { callFnFull } from "../../lib/functions.js";
import { callClaude } from "../../lib/claude.js";
import { updateSnapshot, getSnapshot } from "../../lib/snapshot.js";
import { db } from "../../data/db.js";
import { nextBirthdayOccurrence, localDayKey } from "../../lib/dates.js";
import { DocketCard } from "./DocketCard.jsx";
import { NotesTile } from "./NotesTile.jsx";
import { EVENT_CATEGORIES } from "../personal/CalendarPanel.jsx"; // canonical category → color map (mini-calendar pills)

const GSC_EMPTY = { impressions: "—", impressionsD: "", clicks: "—", clicksD: "", pos: "—", posD: "", series: Array(14).fill(0), daily: [], note: "" };
const STOCKS_EMPTY = { gold: { value: "—", price: "—", up: true }, nvda: { value: "—", price: "—", up: true }, mstr: { value: "—", price: "—", up: true }, strc: { value: "—", price: "—", up: true } };

const ROW_CAP = 5; // list cards show the first N in-page; the rest behind "Show all"
const WATCH_CAP = 3; // Watch this week: taller rows, so show fewer before "Show all"
// AI takes are keyed by a STABLE event identity (its time + text), not list
// position — the econ feed re-sorts and drops old events on refresh, so an
// index key would leave a cached take displayed under a different event. They
// also persist to localStorage so returning to the Brief doesn't re-spend the
// calls (or re-flash "Reading the likely impact…") for takes that haven't changed.
const TAKES_LS = "br_event_takes";
// Include isPast: when an event flips from upcoming to a posted result the feed
// often keeps the same time+text, so without this the forward-looking take
// stays cached and never regenerates against the actual print.
const takeKey = (e) => `${e.isPast ? "p" : "f"}|${e.time || ""}|${(e.text || "").trim()}`;

/* Card header: .t-head title + status cluster at right — one grammar for every
   Brief card. */
function CardHead({ title, leading, trailing, tight }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: tight ? 5 : 9 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {leading}
        <span className="t-head" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>{trailing}</span>
    </div>
  );
}

/* Freshness stamp — same voice and position on every card that has one. */
function Fresh({ children }) {
  return <div className="t-cap t-num" style={{ marginTop: 6, color: "var(--faint)" }}>{children}</div>;
}

/* In-page list expander — replaces the old capped nested-scroll regions. */
function ShowMore({ open, count, onToggle }) {
  return (
    <Button kind="plain" full onClick={onToggle} style={{ marginTop: 2 }}>
      {open ? "Show fewer" : `Show all ${count}`}
    </Button>
  );
}

export function MorningBriefPage({ btc, isMobile, settings, updateSetting, onOpenCalendar, onAddEvent, onOpenNotes, onOpenQueue, onOpenBirthdays, refreshSignal }) {
  // Column count follows the width: 1 (phone / tablet portrait), 2 (desktop &
  // tablet landscape ≥1024 — below this the market tiles truncated to "$…"),
  // 3 (wide desktop ≥1440, where a 2-column layout left big empty gutters).
  const useMq = (query) => {
    const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
    useEffect(() => {
      const mq = window.matchMedia(query);
      const fn = (e) => setM(e.matches);
      mq.addEventListener("change", fn);
      setM(mq.matches);
      return () => mq.removeEventListener("change", fn);
    }, [query]);
    return m;
  };
  const wide = useMq("(min-width: 1024px)");
  const xwide = useMq("(min-width: 1440px)");
  // Hydrate the market/pipeline cards from the last persisted snapshot so a
  // reopen paints real numbers instantly (flagged stale amber), then the
  // refresh below overwrites them with fresh data a beat later.
  const boot = useState(() => getSnapshot())[0];
  const cachedStatus = (v) => v ? { state: "live", stale: true } : { state: "loading" };
  const [gsc, setGsc] = useState(boot.gsc || GSC_EMPTY);
  const [gscStatus, setGscStatus] = useState(cachedStatus(boot.gsc));
  const [gscMetric, setGscMetric] = useState("impressions");
  const [stocks, setStocks] = useState(boot.stocks || STOCKS_EMPTY);
  const [stocksStatus, setStocksStatus] = useState(cachedStatus(boot.stocks));
  const [events, setEvents] = useState([]);
  const [eventsStatus, setEventsStatus] = useState({ state: "loading" });
  const [clarify, setClarify] = useState(boot.clarify || null);
  const [clarifyStatus, setClarifyStatus] = useState(cachedStatus(boot.clarify));
  const [ztsPipe, setZtsPipe] = useState(boot.zts || null);
  const [ztsPipeStatus, setZtsPipeStatus] = useState(cachedStatus(boot.zts));
  const [wire, setWire] = useState(boot.wire || []);
  const [wireStatus, setWireStatus] = useState(cachedStatus(boot.wire && boot.wire.length ? boot.wire : null));
  const [shopify, setShopify] = useState(boot.shopify || null);
  const [shopifyStatus, setShopifyStatus] = useState(cachedStatus(boot.shopify));
  const [meetings, setMeetings] = useState([]);
  const [meetingsStatus, setMeetingsStatus] = useState({ state: "loading" });
  const [birthdays, setBirthdays] = useState(null); // null = loading
  const [birthdaysErr, setBirthdaysErr] = useState(null);
  const [miniEvents, setMiniEvents] = useState([]); // for the mini calendar card — same personal_events table CalendarPanel uses
  const [eventAnalysis, setEventAnalysis] = useState(() => { // takeKey(e) -> take | "loading" | "error"; hydrated from localStorage
    try { return JSON.parse(localStorage.getItem(TAKES_LS) || "{}") || {}; } catch { return {}; }
  });
  const [btcChartOpen, setBtcChartOpen] = useState(false);
  const [tickerChart, setTickerChart] = useState(null); // {key,label} of the watchlist ticker whose chart is open
  const [wireAll, setWireAll] = useState(false);
  const [meetingsAll, setMeetingsAll] = useState(false);
  const [watchAll, setWatchAll] = useState(false);

  // Auto-generates a single, tidy one-sentence take (Bitcoin + stocks
  // together, not separate lines) for every Watch This Week event as soon
  // as the events load — no click needed, and each is cached by index so
  // it only ever generates once per event per session.
  const fetchEventTake = async (e) => {
    const k = takeKey(e);
    if (eventAnalysis[k] && eventAnalysis[k] !== "error") return; // have a take (or one in flight); errors may retry
    setEventAnalysis(prev => ({ ...prev, [k]: "loading" }));
    // The reader already understands markets — give a terse directional read,
    // not an explainer. One short clause, ~12 words, no preamble, no hedging,
    // and NEVER a disclaimer about lacking real-time data (just give the bias
    // the number itself implies).
    const system = e.isPast
      ? `Given a US econ result vs forecast/prior, reply with ONE terse clause (≈12 words max) on the directional read for Bitcoin and equities — shorthand for someone who already knows markets. e.g. "Cooler core PPI — risk-on, both bid." No preamble, no full explanation, no hedging, no disclaimers about missing market data, no "BTC:"/"Stocks:" labels, no markdown. If the reaction is genuinely unknowable, give the bias the result itself implies.`
      : `Given an upcoming US econ event (with forecast/prior if shown), reply with ONE terse clause (≈12 words max) on the likely directional lean for Bitcoin and equities — shorthand for someone who already knows markets. e.g. "Hot print risks risk-off; both lower." No preamble, no explanation, no hedging, no disclaimers, no labels, no markdown — just the lean.`;
    const raw = await callClaude({ system, messages: [{ role: "user", content: e.text }], modelKey: "haiku", maxTokens: 48, fn: "event_impact" });
    if (raw && raw.trim()) setEventAnalysis(prev => ({ ...prev, [k]: raw.trim() }));
    else setEventAnalysis(prev => ({ ...prev, [k]: "error" }));
  };
  useEffect(() => {
    if (eventsStatus.state !== "live" || !events.length) return;
    // only spend a call on the takes actually on screen — the rest generate
    // when the card is expanded. fetchEventTake no-ops if we already have one.
    const shown = watchAll ? events : events.slice(0, WATCH_CAP);
    shown.forEach((e) => fetchEventTake(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsStatus.state, events, watchAll]);
  // Persist resolved takes (not transient loading/error) so a return to the
  // Brief reuses them instead of re-spending Haiku; cap growth at the newest ~60.
  useEffect(() => {
    try {
      const keep = Object.entries(eventAnalysis).filter(([, v]) => v && v !== "loading" && v !== "error").slice(-60);
      localStorage.setItem(TAKES_LS, JSON.stringify(Object.fromEntries(keep)));
    } catch { /* storage full / unavailable — takes just won't persist */ }
  }, [eventAnalysis]);

  const [briefRefreshedAt, setBriefRefreshedAt] = useState(null); // shared freshness stamp for every card fetched in the batch below
  const freshnessLabel = (ts) => ts ? `Updated ${new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} CT` : "Updating…";
  // The footer stamp: a quiet "Updated …" only when the source actually
  // refreshed. When stale the small header "Stale" tag already says so — no
  // wordy footer callout, keep the card clean.
  const freshOrStale = (status) =>
    status?.state === "live" && !status.stale ? <Fresh>{freshnessLabel(briefRefreshedAt)}</Fresh> : null;

  // This used to be a fire-once effect — gsc/clarify/zts/wire/shopify/
  // calendar never refreshed again after the initial page load, and the
  // header's manual refresh button didn't touch any of them either. Real
  // bug: leave this tab open a while and 6 of 9 Brief cards were quietly
  // stale with no way to fix it short of a full page reload. Now a named,
  // reusable function — called on mount, on a shared interval below, and
  // when you switch back to this tab after it's been hidden a while.
  const refreshBrief = useCallback(async () => {
    let alive = true;
    // On a failed refresh, if the card is already showing good data (seeded from
    // the snapshot or from a prior successful load), keep it and just flag it
    // stale — don't yank real numbers for an "unreachable" row. Only show the
    // error when there was nothing good on screen to begin with.
    const keepIfLive = (res) => (prev) => {
      const detail = res.data?.error || (res.status ? `HTTP ${res.status}` : "unreachable");
      return prev?.state === "live"
        ? { state: "live", stale: true, detail }
        : { state: "error", detail };
    };
    const loadCredentialed = async (fn, payload, setData, setStatus, hint) => {
      const ping = await callFnFull(fn, { ping: true });
      if (!alive) return;
      if (ping.status === 404) return setStatus({ state: "nofn", detail: `push netlify/functions/${fn}.js and redeploy` });
      if (ping.data?.configured === false) return setStatus({ state: "notconfigured", detail: hint(ping.data.missing) });
      const res = await callFnFull(fn, payload);
      if (!alive) return;
      // A backend can answer 200 with its last-good value when the upstream
      // failed (stale/cached flags) — surface that instead of stamping it fresh.
      if (res.ok && res.data?.success) { setData(res.data); setStatus({ state: "live", stale: !!(res.data.stale || res.data.cached) }); }
      else setStatus(keepIfLive(res));
    };
    const loadOpen = async (fn, apply, setStatus) => {
      const res = await callFnFull(fn, {});
      if (!alive) return;
      if (res.status === 404) return setStatus({ state: "nofn", detail: `push netlify/functions/${fn}.js and redeploy` });
      if (res.ok && res.data?.success) { apply(res.data); setStatus({ state: "live", stale: !!(res.data.stale || res.data.cached) }); }
      else setStatus(keepIfLive(res));
    };
    await Promise.all([
      // Each of these also writes into the live snapshot the board seats read,
      // so an advisor sees the current pipeline/store/search numbers automatically.
      loadCredentialed("gsc", { site: "zerotosecure.com", days: 14 }, (d) => { setGsc(d); updateSnapshot({ gsc: d }); }, setGscStatus,
        (m) => `Add ${m || "GSC_CLIENT_EMAIL + GSC_PRIVATE_KEY"} in Netlify env vars, share the Search Console property with the service account, then redeploy.`),
      loadCredentialed("clarify-pipeline", {}, (d) => { setClarify(d); updateSnapshot({ clarify: d }); }, setClarifyStatus,
        (m) => `Add ${m || "CLARIFY_SUPABASE_URL + CLARIFY_SUPABASE_ANON_KEY"} in Netlify env vars, then redeploy.`),
      loadCredentialed("zts-pipeline", {}, (d) => { setZtsPipe(d); updateSnapshot({ zts: d }); }, setZtsPipeStatus,
        (m) => `Add ${m || "ZTS_SUPABASE_URL + ZTS_SUPABASE_ANON_KEY"} in Netlify env vars, then redeploy.`),
      loadOpen("markets", (d) => { setStocks(d); updateSnapshot({ stocks: d }); }, setStocksStatus),
      loadOpen("wire", (d) => { setWire(d.wire || []); updateSnapshot({ wire: d.wire || [] }); }, setWireStatus),
      loadCredentialed("shopify", { days: 14 }, (d) => { setShopify(d); updateSnapshot({ shopify: d }); }, setShopifyStatus,
        (m) => `Add ${m || "SHOPIFY_SHOP + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET"} in Netlify env vars, then redeploy.`),
      db.loadBirthdays().then(rows => {
        if (!alive) return;
        setBirthdays(rows);
        const soon = (rows || []).map(b => ({ name: b.name, ...nextBirthdayOccurrence(b.month, b.day) })).filter(b => b.daysUntil <= 14).sort((a, b) => a.daysUntil - b.daysUntil);
        updateSnapshot({ todayBirthdays: soon });
      }).catch(e => { if (alive) setBirthdaysErr(/fetch/i.test(e?.message || "") ? "Couldn't reach Supabase — check the connection and refresh." : e?.message || "Couldn't load birthdays."); }),
      db.loadEvents().then(rows => {
        if (!alive) return;
        setMiniEvents(rows);
        const soon = (rows || []).filter(ev => { const days = (new Date(ev.start_time) - new Date()) / 86400000; return days >= -0.5 && days <= 3; }).map(ev => ({ title: ev.title }));
        updateSnapshot({ todayEvents: soon });
      }).catch(() => { if (alive) setMiniEvents([]); }),
      loadOpen("calendar", (d) => setEvents(d.events || []), setEventsStatus),
      (async () => {
        if (!settings?.calendar_url) { if (alive) setMeetingsStatus({ state: "notconfigured", detail: "Link a calendar (iCal / .ics URL) in the sidebar to see meetings here." }); return; }
        const res = await callFnFull("calendar-events", { url: settings.calendar_url });
        if (!alive) return;
        if (res.ok && res.data?.success) { setMeetings(res.data.events || []); setMeetingsStatus({ state: "live", stale: !!(res.data.stale || res.data.cached) }); }
        else setMeetingsStatus(keepIfLive(res));
      })(),
    ]);
    if (alive) setBriefRefreshedAt(Date.now());
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.calendar_url]);

  useEffect(() => { refreshBrief(); }, [refreshBrief]);

  useEffect(() => {
    if (refreshSignal) refreshBrief();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // One shared interval for everything above (was several separate mechanisms
  // — this one-time effect plus bespoke per-feed intervals — consolidated
  // since they were all polling the same way for no real reason). Also
  // refetches when you switch back to this tab after
  // it's been hidden a while, so alt-tabbing away for hours doesn't leave
  // you staring at a stale page until the next 5-min tick happens to land.
  useEffect(() => {
    const iv = setInterval(refreshBrief, 5 * 60 * 1000);
    let lastVisibleRefresh = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastVisibleRefresh < 60 * 1000) return; // just refreshed — don't refire on rapid tab-switching
      lastVisibleRefresh = Date.now();
      refreshBrief();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVisible); };
  }, [refreshBrief]);

  // Show the last-known price even on error (it's seeded/kept stale) — the whole
  // point of persisting the snapshot is not to blank the hero to "—" on a blip.
  const price = btc.loading && btc.price == null ? "…" : btc.price == null ? "—" : "$" + btc.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const hasChange = !btc.loading && btc.changePct !== null && btc.changePct !== undefined;
  const up = (btc.changePct || 0) >= 0;
  const hasRange = !btc.loading && !btc.error && btc.high24 != null && btc.low24 != null;
  // A one-word read on the day's tape — the only interpretive thing the card
  // still shows now that the levels + AI explanation are gone.
  let stance = "Neutral", stanceColor = T.sub;
  if (hasRange) { stance = up ? "Constructive" : "Cautious"; stanceColor = up ? T.green : T.amber; }

  // Markets card was the one card with no status indicator and an always-fresh
  // stamp — so a failed/stale price refresh was invisible. Give it an honest one.
  const marketsStale = !!(btc.stale || btc.error || stocksStatus.stale);
  const marketsStatus = (stocksStatus.state === "error" || stocksStatus.state === "nofn")
    ? stocksStatus
    : { state: "live", stale: marketsStale, detail: marketsStale ? "Showing the last good prices" : undefined };

  const pad = isMobile ? "sm" : "md";

  const FeedFallbackRow = ({ status }) => status.state === "loading" ? (
    // skeleton matches the row it resolves into — pages develop, not arrive
    <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "12px 13px" }}>
      <div className="sk sk-line w60" style={{ margin: "0 0 8px" }} />
      <div className="sk sk-line w40" style={{ margin: 0 }} />
    </div>
  ) : (
    <div style={{ background: "var(--surface-2)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 13px", minHeight: 52 }}>
      <Dot tone={CARD_STATES[status.state]?.color || T.faint} />
      <span className="t-foot" style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>{status.detail || "Feed unavailable."}</span>
      {status.state === "error" && (
        <Button kind="quiet" size="sm" style={{ height: 44, flex: "none" }} onClick={() => refreshBrief()}>Retry</Button>
      )}
    </div>
  );

  /* ── Markets — Bitcoin (tap for the chart) + gold and the watchlist ────── */
  const card_markets = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead
        leading={<span aria-hidden style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--btc)", color: "#1A0F00", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flex: "none" }}>₿</span>}
        title="Markets"
        trailing={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <StancePill text={stance} color={stanceColor} />
            {(marketsStatus.state !== "live" || marketsStatus.stale) && <StatusTag status={marketsStatus} />}
          </span>
        }
      />
      {/* Bitcoin hero — price, day move, and a sparkline that taps to the chart */}
      <div onClick={() => setBtcChartOpen(true)} style={{ cursor: "pointer" }} title="Tap for the full chart">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: btc.price != null ? 10 : 4 }}>
          <span className="t-cap" style={{ color: "var(--faint)", flex: "none" }}>Bitcoin</span>
          <span className="t-title1 t-num">{btc.price != null ? <NumTween v={btc.price} f={n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 })} /> : price}</span>
          {hasChange && <Delta pct={btc.changePct} />}
        </div>
        {btc.points?.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <Sparkline points={btc.points} color={up ? T.green : T.red} height={34} />
          </div>
        )}
      </div>
      {/* the watchlist: gold + the names worth watching. auto-fit so the tiles
          wrap to 2-up instead of crushing the price to "$…" on a narrow card. */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(auto-fit, minmax(96px, 1fr))", gap: 8 }}>
        {[["Gold", "gold", stocks.gold], ["NVDA", "nvda", stocks.nvda], ["MSTR", "mstr", stocks.mstr], ["STRC", "strc", stocks.strc]].map(([l, key, s]) => {
          const lvl = s?.price && s.price !== "—" ? s.price : (s?.value || "—");
          const live = lvl !== "—";
          // Tap a ticker to open its own price chart (same modal as BTC). Dead
          // tiles (no quote) aren't tappable.
          return <StatTile key={key} value={lvl} label={l} delta={s?.delta} deltaTone={s?.up ? T.green : T.red}
            valueTone={live ? undefined : T.faint} onClick={live ? () => setTickerChart({ key, label: l }) : undefined} />;
        })}
      </div>
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="t-cap t-num" style={{ color: "var(--faint)", minWidth: 0 }}>{marketsStale ? "" : freshnessLabel(briefRefreshedAt)}</span>
        <Button kind="plain" size="sm" onClick={() => setBtcChartOpen(true)}
          style={{ height: 44, margin: "-6px -10px -8px 0", padding: "0 10px", flex: "none" }}>
          Chart <IcChevronRight size={12} />
        </Button>
      </div>
    </Card>
  );

  /* ── Watch this week — US econ calendar with one-line AI takes ─────────── */
  const card_watch = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Watch This Week" tight
        trailing={<><span className="t-cap" style={{ color: "var(--faint)" }}>CT time</span><StatusTag status={eventsStatus} /></>} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {eventsStatus.state === "live" ? (
          events.length ? <>{(watchAll ? events : events.slice(0, WATCH_CAP)).map((e, i) => {
            const analysis = eventAnalysis[takeKey(e)];
            return (
              // Stacked, not squeezed: the time + Result badge share the top
              // line; the event title gets the full width below it (aligned
              // under the time), then the one-line take. Reads cleanly on a
              // phone instead of wrapping the title into a narrow middle column.
              <div key={i} style={{ background: e.isPast ? "var(--green-a06)" : "var(--surface-2)", borderRadius: 12, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Dot tone={e.color} />
                  <span className="t-cap t-num" style={{ color: "var(--faint)", whiteSpace: "nowrap" }}>{e.time}</span>
                  <span style={{ flex: 1 }} />
                  {e.isPast && <span className="t-cap" style={{ color: "var(--green)", fontWeight: 600, flex: "none" }}>Result</span>}
                </div>
                <div className="t-call" style={{ lineHeight: 1.4, paddingLeft: 17 }}>{e.text}</div>
                <div className="t-foot" style={{ color: "var(--faint)", paddingLeft: 17, lineHeight: 1.5 }}>
                  {analysis === "loading" || !analysis ? <span style={{ animation: "pulse 1.4s infinite" }}>{e.isPast ? "Reading the actual impact…" : "Reading the likely impact…"}</span>
                    : analysis === "error" ? "Couldn't get a read on this one."
                    : analysis}
                </div>
              </div>
            );
          })}
          {events.length > WATCH_CAP && <ShowMore open={watchAll} count={events.length} onToggle={() => setWatchAll(v => !v)} />}
          </> : <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 0" }}>No high/medium-impact US events in the last 12 hours or next 7 days.</div>
        ) : <FeedFallbackRow status={eventsStatus} />}
      </div>
      {freshOrStale(eventsStatus)}
    </Card>
  );

  /* ── Search Console — stat tiles double as the chart's metric tabs ─────── */
  const card_gsc = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Zero To Secure · Search Console" trailing={<StatusTag status={gscStatus} />} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 8 }}>
        <StatTile value={gsc.impressions} label="Impressions" onClick={() => setGscMetric("impressions")} selected={gscMetric === "impressions"} />
        <StatTile value={gsc.clicks} label="Clicks" onClick={() => setGscMetric("clicks")} selected={gscMetric === "clicks"} />
        <StatTile value={gsc.pos} label="Avg position" onClick={() => setGscMetric("position")} selected={gscMetric === "position"} />
      </div>
      <GscLineChart rows={gsc.daily} metric={gscMetric} />
      <div className="t-foot" style={{ marginTop: 6, color: gscStatus.state === "live" ? "var(--sub)" : "var(--faint)", lineHeight: 1.5 }}>
        {gscStatus.state === "live" ? gsc.note : gscStatus.state === "loading" ? "Loading…" : gscStatus.detail}
      </div>
      {freshOrStale(gscStatus)}
    </Card>
  );

  /* ── Clarify pipeline ──────────────────────────────────────────────────── */
  const card_clarify = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Clarify · Outreach Pipeline" trailing={<StatusTag status={clarifyStatus} />} />
      {clarifyStatus.state === "live" ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6, marginBottom: 6 }}>
            <StatTile value={String(clarify.prospected)} label="Prospected" />
            <StatTile value={String(clarify.drafts)} label="Drafts" />
            <StatTile value={String(clarify.sent)} label="Sent" />
            <StatTile value={String(clarify.replied)} label="Replied" />
          </div>
          {freshOrStale(clarifyStatus)}
        </>
      ) : <FeedFallbackRow status={clarifyStatus} />}
    </Card>
  );

  /* ── ZTS creator pipeline ──────────────────────────────────────────────── */
  const card_zts = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Zero To Secure · Creator Pipeline" trailing={<StatusTag status={ztsPipeStatus} />} />
      {ztsPipeStatus.state === "live" ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6, marginBottom: 6 }}>
            <StatTile value={String(ztsPipe.prospected)} label="Prospected" />
            <StatTile value={String(ztsPipe.sent)} label="Sent" />
            <StatTile value={String(ztsPipe.replied)} label="Replied" />
            <StatTile value={String(ztsPipe.collab)} label="Collab" />
          </div>
          {freshOrStale(ztsPipeStatus)}
        </>
      ) : <FeedFallbackRow status={ztsPipeStatus} />}
    </Card>
  );

  /* ── Shopify store ─────────────────────────────────────────────────────── */
  const card_shopify = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Zero To Secure · Store" trailing={<StatusTag status={shopifyStatus} />} />
      {shopifyStatus.state === "live" ? (
        <>
          {/* No delta line here — it added a third row to each tile and made
              this card taller than the pipeline cards above it; value + label
              keeps it the same height. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginBottom: 6 }}>
            <StatTile value={String(shopify.orders)} label="Orders" />
            <StatTile value={shopify.visits} label="Visits" />
          </div>
          {freshOrStale(shopifyStatus)}
        </>
      ) : <FeedFallbackRow status={shopifyStatus} />}
    </Card>
  );

  /* ── Mini calendar — tap a day to add an event on it; "Open" for the full tab ── */
  const miniCatColor = (key) => (EVENT_CATEGORIES.find(c => c.key === key) || EVENT_CATEGORIES[0]).color;
  const miniNow = new Date();
  const miniYear = miniNow.getFullYear(), miniMonth = miniNow.getMonth();
  const miniDaysInMonth = new Date(miniYear, miniMonth + 1, 0).getDate();
  const miniLeading = new Date(miniYear, miniMonth, 1).getDay();
  const miniCells = [...Array(miniLeading).fill(null), ...Array.from({ length: miniDaysInMonth }, (_, i) => i + 1)];
  const miniEventsByDay = {};
  // Local day-key (all-day events keep their literal date) so an evening event
  // lands on the same cell the Personal calendar and the Docket show it on —
  // start_time is stored UTC, and slice(0,10) put evening events a day early.
  (miniEvents || []).forEach(ev => { const k = ev.all_day ? String(ev.start_time).slice(0, 10) : localDayKey(ev.start_time); (miniEventsByDay[k] = miniEventsByDay[k] || []).push(ev); });
  const miniDateKey = (day) => `${miniYear}-${String(miniMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const todayDate = miniNow.getDate();
  const card_minicalendar = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      {/* Title stays informative; the "Open" link goes to the full calendar.
          Each day is a button that starts a new event pre-dated to it. */}
      <CardHead tight title={miniNow.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        trailing={<button className="sec-link" onClick={onOpenCalendar} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>Open<IcChevronRight size={12} /></button>} />
      {/* minmax(0,1fr) columns + minWidth 0 cells: a long event title can never
          widen its column — the pill truncates inside a fixed, even grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 2, marginBottom: 4 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="t-cap t-num" style={{ textAlign: "center", color: "var(--faint)", fontSize: 10.5 }}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 2 }}>
        {miniCells.map((day, i) => {
          if (day === null) return <div key={`b${i}`} />;
          const dayEvents = miniEventsByDay[miniDateKey(day)] || [];
          const isToday = day === todayDate;
          return (
            <button key={day} type="button" className="hoverable"
              onClick={() => onAddEvent?.(miniDateKey(day))}
              aria-label={`Add an event on ${miniNow.toLocaleDateString("en-US", { month: "long" })} ${day}`}
              title="Add an event on this day"
              style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2, textAlign: "left", minWidth: 0, height: 56, overflow: "hidden", padding: 3, borderRadius: 8, background: "none", border: "none", font: "inherit", color: "inherit", cursor: "pointer" }}>
              {/* today = filled accent circle on the number, same as the Personal calendar */}
              <span className="t-num" style={{ width: 20, height: 20, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", alignSelf: "flex-start", flex: "none", fontSize: 11, fontWeight: isToday ? 600 : 500, background: isToday ? "var(--accent)" : "transparent", color: isToday ? "var(--on-accent)" : "var(--ink)" }}>{day}</span>
              {dayEvents.length > 0 && (
                // title pill — wraps to two lines so the name is readable, not a
                // 4-character stub; minWidth:0 keeps it from widening the column
                <span style={{ fontSize: 9.5, fontWeight: 600, color: "var(--chip-ink)", background: miniCatColor(dayEvents[0].category), borderRadius: 4, padding: "1px 3px", lineHeight: 1.2, minWidth: 0, maxWidth: "100%", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-word" }}>{dayEvents.length > 1 ? `${dayEvents[0].title} +${dayEvents.length - 1}` : dayEvents[0].title}</span>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );

  // Birthdays live on the Docket (and Personal) now — no separate Brief card.
  // The `birthdays` state is still loaded above so the Docket can read it.

  /* ── Business meetings (external iCal) ─────────────────────────────────── */
  const visibleMeetings = meetingsAll ? meetings : meetings.slice(0, ROW_CAP);
  const card_meetings = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead tight title="Business Meetings" trailing={<StatusTag status={meetingsStatus} />} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        {meetingsStatus.state === "live" ? (
          meetings.length ? (
            <>
              {visibleMeetings.map((m, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "5px 0", borderTop: i === 0 ? "none" : "0.5px solid var(--line)" }}>
                  <Dot tone={T.blue} />
                  <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                    <span className="t-call" style={{ lineHeight: 1.4 }}>{m.title}</span>
                    <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{m.when}{m.location ? " · " + m.location : ""}</span>
                  </span>
                </div>
              ))}
              {meetings.length > ROW_CAP && <ShowMore open={meetingsAll} count={meetings.length} onToggle={() => setMeetingsAll(v => !v)} />}
            </>
          ) : <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 0" }}>Nothing on the calendar in the next two weeks.</div>
        ) : <FeedFallbackRow status={meetingsStatus} />}
      </div>
    </Card>
  );

  /* ── The wire — headline ticker ────────────────────────────────────────── */
  const visibleWire = wireAll ? wire : wire.slice(0, ROW_CAP);
  const card_wire = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead tight title="The Wire" trailing={<StatusTag status={wireStatus} />} />
      {wireStatus.state === "live" ? (
        wire.length ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {visibleWire.map((w, i) => {
              const Row = w.link ? "a" : "div";
              return (
                <Row key={i} {...(w.link ? { href: w.link, target: "_blank", rel: "noreferrer" } : {})}
                  className={w.link ? "hoverable" : undefined}
                  style={{ display: "flex", alignItems: "baseline", gap: 9, textDecoration: "none", color: "inherit", minHeight: 44, padding: "8px 0", borderTop: i === 0 ? "none" : "0.5px solid var(--line)" }}>
                  <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{w.time}</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none" }}>
                    <Dot tone={w.tagColor} size={6} />
                    <span className="t-cap" style={{ color: "var(--sub)", fontWeight: 600 }}>{w.tag}</span>
                  </span>
                  <span className="t-call" style={{ minWidth: 0, flex: 1, lineHeight: 1.45 }}>{w.text}</span>
                </Row>
              );
            })}
            {wire.length > ROW_CAP && <ShowMore open={wireAll} count={wire.length} onToggle={() => setWireAll(v => !v)} />}
          </div>
        ) : <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 0" }}>No headlines returned this cycle.</div>
      ) : <FeedFallbackRow status={wireStatus} />}
      {freshOrStale(wireStatus)}
    </Card>
  );

  const card_docket =<DocketCard isMobile={isMobile} birthdays={birthdays} macroEvents={eventsStatus.state === "live" ? events : []} settings={settings} onOpenCalendar={onOpenCalendar} onOpenQueue={onOpenQueue} onOpenBirthdays={onOpenBirthdays} />;
  const card_notes = <NotesTile isMobile={isMobile} refreshSignal={refreshSignal} onOpenNotes={onOpenNotes} />;

  // One flow for both platforms: a single calm column on the phone (min=9999
  // collapses every Grid to one track), the same order flowing 2-up on tablet
  // (min=320 + maxWidth 960 caps the Grids at two columns — never three).
  // minmax(min(...,100%),1fr) tracks + minWidth:0 cards keep an unbreakable
  // line (a URL in a note) from stretching the page sideways on mobile — the
  // same guard the old grid carried. The shell (#page-scroll) owns scrolling
  // and the desktop gutters — this page never nests its own scroll region.
  // Column count + container width scale with the viewport so a wide desktop
  // fills the space instead of stranding two narrow columns in a sea of black:
  // 1 col (phone/tablet portrait), 2 (≥1024), 3 (≥1440). The container cap grows
  // with the columns so each stays a comfortable ~460px, never stretched thin.
  const nCols = xwide ? 3 : wide ? 2 : 1;
  const maxW = xwide ? 1480 : 960;
  // Cards vary a lot in height (a tall Watch beside a short Markets), so a
  // row-based grid stranded a big empty cell next to the tall one on desktop.
  // Masonry columns, cards dealt round-robin, pack vertically instead — no
  // orphan gaps, and the columns stay close in height. Narrow = one stack.
  const masonry = (cards) => {
    if (nCols === 1) return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{cards.map((c, i) => <div key={i}>{c}</div>)}</div>;
    const cols = Array.from({ length: nCols }, () => []);
    cards.forEach((c, i) => cols[i % nCols].push(<div key={i} style={{ marginBottom: 8 }}>{c}</div>));
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        {cols.map((col, i) => <div key={i} style={{ flex: 1, minWidth: 0 }}>{col}</div>)}
      </div>
    );
  };
  return (
    <div style={{ flex: 1, padding: isMobile ? "2px 12px 20px" : "6px 0 0", minWidth: 0 }}>
      <div className="stagger" style={{ maxWidth: maxW, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        {xwide ? (
          // Wide desktop: the daily-glance trio sits in one row across the top.
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, alignItems: "start" }}>
            {card_docket}
            {card_notes}
            {card_minicalendar}
          </div>
        ) : (
          <>
            <Grid min={wide ? 320 : 9999} gap={8} style={{ alignItems: "stretch" }}>
              {card_docket}
              {card_notes}
            </Grid>
            {card_minicalendar}
          </>
        )}
        <SectionHeader title="Market" style={{ marginTop: 4 }} />
        {masonry([card_markets, card_wire, card_watch])}
        <SectionHeader title="Signals" style={{ marginTop: 4 }} />
        {masonry([card_gsc, card_clarify, card_zts, card_shopify, card_meetings])}
      </div>
      {(btcChartOpen || tickerChart) && (
        <Suspense fallback={null}>
          {btcChartOpen && <BtcChartModal isMobile={isMobile} onClose={() => setBtcChartOpen(false)} callFnFull={callFnFull} />}
          {tickerChart && (
            <BtcChartModal
              key={tickerChart.key}
              isMobile={isMobile}
              onClose={() => setTickerChart(null)}
              callFnFull={callFnFull}
              title={tickerChart.label}
              fn="ticker-candles"
              fnArgs={{ symbol: tickerChart.key }}
              defaultInterval="1d"
            />
          )}
        </Suspense>
      )}
    </div>
  );
}

export default MorningBriefPage;
