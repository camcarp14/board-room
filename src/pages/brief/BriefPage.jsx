// ─── Page: the morning brief ──────────────────────────────────────────────────
// Everything on this page is fetched live on load through Netlify functions.
// No fabricated fallback numbers anywhere on this page. Each card is either
// live (real data), not connected (with exact setup instructions), or error
// (with the actual failure). Empty dashes beat plausible-looking fake data.
import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from "react";
import { T } from "../../theme.js";
import { CollapsibleCard, StatTile, Button, Dot, Delta } from "../../ui/kit.jsx";
import { IcChevronRight, IcExternal } from "../../ui/icons.jsx";
import { StancePill, StatusTag, CARD_STATES } from "../../ui/shared.jsx";
import { NumTween, Sparkline } from "../../ui/primitives.jsx";
import { SortableList } from "../../ui/SortableList.jsx";
import { applyBriefOrder, orderOf, packColumns } from "../../lib/brief-order.js";
import { activeLayout, layoutColumnCount, defaultColumnCount, dealExplicit } from "../../lib/brief-layouts.js";
import { BriefLayoutSheet } from "./BriefLayoutSheet.jsx";
import GscLineChart from "../../GscLineChart.jsx";
// Lazy — pulls lightweight-charts (~a quarter of the old bundle) into its own
// chunk that loads only when you actually open a price chart.
const BtcChartModal = lazy(() => import("../../BtcChartModal.jsx"));
import { callFnFull } from "../../lib/functions.js";
import { callClaude } from "../../lib/claude.js";
import { updateSnapshot, getSnapshot } from "../../lib/snapshot.js";
import { db } from "../../data/db.js";
import { nextBirthdayOccurrence, localDayKey } from "../../lib/dates.js";
import { NotesTile } from "./NotesTile.jsx";
import { eventId, takeKey, hasPassed, isSettled, watchRowState, POLL_EVERY_MS, POLL_MAX, CLAIM_STALE_MS } from "./watchState.js";
import { useEconResults, useResolveEconEvents } from "../../data/econ.js";
import { EVENT_CATEGORIES } from "../personal/CalendarPanel.jsx"; // canonical category → color map (mini-calendar pills)

const GSC_EMPTY = { impressions: "—", impressionsD: "", clicks: "—", clicksD: "", pos: "—", posD: "", series: Array(14).fill(0), daily: [], note: "" };
const STOCKS_EMPTY = { gold: { value: "—", price: "—", up: true }, nvda: { value: "—", price: "—", up: true }, mstr: { value: "—", price: "—", up: true }, strc: { value: "—", price: "—", up: true } };

const ROW_CAP = 5; // Business Meetings shows the first N in-page; the rest behind "Show all"
// AI takes are keyed by a STABLE event identity (see watchState.js), not list
// position — the econ feed re-sorts and drops old events on refresh, so an
// index key would leave a cached take displayed under a different event. They
// also persist to localStorage so returning to the Brief doesn't re-spend the
// calls (or re-flash "Reading the likely impact…") for takes that haven't changed.
const TAKES_LS = "br_event_takes";
// Post-event verdicts are NOT cached here. They live in app_settings, written by
// econ-resolve-background, so one lookup serves every device — see data/econ.js.
// A take that fails is allowed to retry — but the effect below re-runs on every
// 5-minute refresh with a freshly-allocated `events` array, so without a ceiling
// one event the model reliably chokes on becomes a permanent ~288-call-a-day
// loop with a zero success rate. Two more tries, then leave it alone.
const TAKE_MAX_TRIES = 3;
const takeTries = new Map(); // takeKey -> attempts, this page load only

// The { ping: true } probe answers one question — is the env var set — and that
// can only change on deploy. Asking it before every call meant two function
// invocations per credentialed card per refresh: ~1,150 extra invocations a day
// for GSC/Clarify/ZTS/Shopify alone, each one also writing a usage_log row.
// Memoized per page load; a failed probe isn't cached, so a cold start that
// 404s can still recover on the next cycle.
const pingCache = new Map(); // fn name -> resolved ping result
async function pingOnce(fn) {
  if (pingCache.has(fn)) return pingCache.get(fn);
  const res = await callFnFull(fn, { ping: true });
  if (res.ok || res.status === 404) pingCache.set(fn, res); // 404 = not deployed, also stable until deploy
  return res;
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
  // Seeded-from-snapshot cards are stale and dated to when the snapshot was last
  // saved (updatedAt) — that timestamp is what the card shows in place of a tag.
  const cachedStatus = (v) => v ? { state: "live", stale: true, at: boot.updatedAt } : { state: "loading" };
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
  const { data: econ } = useEconResults();   // eventId -> verdict, shared across devices
  const resolveEcon = useResolveEconEvents();
  const [btcChartOpen, setBtcChartOpen] = useState(false);
  const [tickerChart, setTickerChart] = useState(null); // {key,label} of the watchlist ticker whose chart is open
  const [layoutOpen, setLayoutOpen] = useState(false);  // the Brief layout sheet (desktop-only affordance)
  const [meetingsAll, setMeetingsAll] = useState(false);
  // Per-card collapse state, persisted per-device so a collapsed card stays
  // collapsed across reloads. Keyed by a stable card id (see coll() below).
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem("br_brief_collapsed") || "{}") || {}; } catch { return {}; }
  });

  // FORWARD-looking lean, for events that haven't happened yet: one tidy clause
  // (Bitcoin + stocks together, not separate lines), generated as soon as the
  // events load and cached per event so it only ever costs one Haiku call.
  //
  // Nothing that has already happened comes through here. A past event's take
  // has to be written against the number that actually printed, and the number
  // isn't in the calendar feed — that's resolveEventResult's job below. Asking
  // Haiku for a "how it landed" take with only a forecast in hand is precisely
  // the old bug where a pre-event guess got rendered as if it were the result.
  const fetchEventTake = async (e) => {
    if (hasPassed(e)) return;
    const k = takeKey(e);
    if (eventAnalysis[k] && eventAnalysis[k] !== "error") return; // have a take (or one in flight)
    // Errors may retry, but only up to TAKE_MAX_TRIES per page load — see the
    // note on takeTries. Past the ceiling the "couldn't get a read" line stands.
    const tries = takeTries.get(k) || 0;
    if (tries >= TAKE_MAX_TRIES) return;
    takeTries.set(k, tries + 1);
    setEventAnalysis(prev => ({ ...prev, [k]: "loading" }));
    // The reader already understands markets — give a terse directional read,
    // not an explainer. One short clause, ~12 words, no preamble, no hedging.
    const system = `Given an upcoming US econ event (with forecast/prior if shown), reply with ONE terse clause (≈12 words max) on the likely directional lean for Bitcoin and equities — shorthand for someone who already knows markets. e.g. "Hot print risks risk-off; both lower." No preamble, no explanation, no hedging, no disclaimers, no labels, no markdown — just the lean.`;
    const raw = await callClaude({ system, messages: [{ role: "user", content: e.text }], modelKey: "haiku", maxTokens: 48, fn: "event_impact" });
    if (raw && raw.trim()) setEventAnalysis(prev => ({ ...prev, [k]: raw.trim() }));
    else setEventAnalysis(prev => ({ ...prev, [k]: "error" }));
  };

  // POST-EVENT: what actually printed, and how it landed.
  //
  // The calendar feed carries forecast and prior and nothing else — no released
  // number, ever (see netlify/functions/calendar.js) — so a past event's result
  // has to be looked up. That lookup used to happen HERE, synchronously, once per
  // event per device per page load with retries. It never once succeeded: a web
  // search plus an answer takes 10-20 seconds and the function had seconds, so
  // every call died on its own timeout, and an aborted call is still a billed
  // call. The card pulsed "checking" forever while quietly spending.
  //
  // Now the work is off the request path entirely and the answers are shared:
  // econ-resolve-background resolves whatever is unresolved and writes verdicts
  // to app_settings, which useEconResults reads. This component's whole job is
  // to fire ONE trigger per page load and then wait.
  //
  // That is the spend fix, and it is structural rather than a promise: the
  // trigger carries the whole list, the resolver caps how many it will price out
  // per invocation, it claims rows before calling anything so two devices can't
  // both pay, and a verdict it could not establish is recorded so it is never
  // asked again. Nothing on this page can spend by re-rendering.
  const econTriggered = useRef(false);
  const [pollTicks, setPollTicks] = useState(0);

  // Past events with no verdict yet — the trigger's payload, and the poll's
  // stop condition. A stale claim counts as unresolved: the invocation that
  // claimed it crashed, so somebody has to ask again.
  const unresolvedPast = useMemo(() => {
    if (eventsStatus.state !== "live") return [];
    const now = Date.now();
    return events.filter((e) => {
      if (!hasPassed(e, now) || !isSettled(e, now)) return false;
      const r = econ?.[eventId(e)];
      if (!r) return true;
      if (r.status === "claimed") return now - (r.at || 0) >= CLAIM_STALE_MS;
      return false; // released, no_number and unresolved are all final
    });
  }, [events, eventsStatus.state, econ]);

  useEffect(() => {
    if (econTriggered.current || !unresolvedPast.length) return;
    econTriggered.current = true; // once per page load, for the whole card
    resolveEcon.trigger(unresolvedPast.map((e) => ({
      id: eventId(e), title: e.title, at: e.at,
      forecast: e.forecast, previous: e.previous, numeric: e.numeric,
    })));
    setPollTicks(1);
  }, [unresolvedPast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for the verdicts the background invocation is writing. Reads only — the
  // cost was paid by the single trigger above — and it gives up after POLL_MAX so
  // a row settles on "Unconfirmed" instead of animating indefinitely.
  useEffect(() => {
    if (!pollTicks || pollTicks > POLL_MAX || !unresolvedPast.length) return;
    const t = setTimeout(() => { resolveEcon.refetch(); setPollTicks((n) => n + 1); }, POLL_EVERY_MS);
    return () => clearTimeout(t);
  }, [pollTicks, unresolvedPast.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const stillLooking = pollTicks > 0 && pollTicks <= POLL_MAX;

  /**
   * What a past row should render from. A missing verdict is only "loading"
   * while the poll is actually alive; once it lapses the row is told plainly
   * that we don't know, which is what stops the forever-pulse.
   */
  const resultFor = (e) => {
    const r = econ?.[eventId(e)];
    if (r) return r;
    return stillLooking ? "loading" : { status: "unresolved" };
  };

  useEffect(() => {
    if (eventsStatus.state !== "live" || !events.length) return;
    // Upcoming events get the cheap forward take (one Haiku call each, ~$0.0002,
    // cached in localStorage). Past events are handled by the trigger above.
    const now = Date.now();
    events.forEach((e) => { if (!hasPassed(e, now)) fetchEventTake(e); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsStatus.state, events]);
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
  //
  // Cancellation is a generation counter in a ref, NOT a local `alive` flag.
  // The previous version declared `let alive = true` and ended with
  // `return () => { alive = false; }` — but this is an async function, so that
  // closure was just the promise's resolved value and the caller
  // (`refreshBrief()`, result discarded) never received it. `alive` was never
  // set to false and every guard below was unreachable. Two overlapping passes
  // — a calendar_url change landing on the interval, or the visibility refetch
  // racing it — could therefore let the slower, staler pass write last and
  // clobber good numbers. Bumping the ref on entry makes the newest pass the
  // only one allowed to write.
  const refreshGen = useRef(0);
  // Unmounting counts as a new generation, so nothing writes into a dead tree.
  useEffect(() => () => { refreshGen.current += 1; }, []);
  const refreshBrief = useCallback(async () => {
    const gen = refreshGen.current + 1;
    refreshGen.current = gen;
    const alive = () => refreshGen.current === gen;
    // On a failed refresh, if the card is already showing good data (seeded from
    // the snapshot or from a prior successful load), keep it and just flag it
    // stale — don't yank real numbers for an "unreachable" row. Only show the
    // error when there was nothing good on screen to begin with.
    const keepIfLive = (res) => (prev) => {
      const detail = res.data?.error || (res.status ? `HTTP ${res.status}` : "unreachable");
      return prev?.state === "live"
        ? { state: "live", stale: true, at: prev?.at ?? boot.updatedAt, detail }
        : { state: "error", detail };
    };
    // Stamp a live status with its data's timestamp: fresh data is "now"; stale/
    // cached data keeps the last known-good time (the card shows that instead of
    // a "Stale" tag), falling back to the persisted snapshot's time.
    const liveStatus = (stale) => (prev) => ({ state: "live", stale, at: stale ? (prev?.at ?? boot.updatedAt ?? Date.now()) : Date.now() });
    const loadCredentialed = async (fn, payload, setData, setStatus, hint) => {
      const ping = await pingOnce(fn);
      if (!alive()) return;
      if (ping.status === 404) return setStatus({ state: "nofn", detail: `push netlify/functions/${fn}.js and redeploy` });
      if (ping.data?.configured === false) return setStatus({ state: "notconfigured", detail: hint(ping.data.missing) });
      const res = await callFnFull(fn, payload);
      if (!alive()) return;
      // A backend can answer 200 with its last-good value when the upstream
      // failed (stale/cached flags) — surface that instead of stamping it fresh.
      if (res.ok && res.data?.success) { setData(res.data); setStatus(liveStatus(!!(res.data.stale || res.data.cached))); }
      else setStatus(keepIfLive(res));
    };
    const loadOpen = async (fn, apply, setStatus) => {
      const res = await callFnFull(fn, {});
      if (!alive()) return;
      if (res.status === 404) return setStatus({ state: "nofn", detail: `push netlify/functions/${fn}.js and redeploy` });
      if (res.ok && res.data?.success) { apply(res.data); setStatus(liveStatus(!!(res.data.stale || res.data.cached))); }
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
        (m) => `Add ${m || "CLARIFY_SUPABASE_URL + CLARIFY_SUPABASE_ANON_KEY"} in Netlify env vars (ZTS now shares the Pentagon Supabase project), then redeploy.`),
      loadOpen("markets", (d) => { setStocks(d); updateSnapshot({ stocks: d }); }, setStocksStatus),
      loadOpen("wire", (d) => { setWire(d.wire || []); updateSnapshot({ wire: d.wire || [] }); }, setWireStatus),
      loadCredentialed("shopify", { days: 14 }, (d) => { setShopify(d); updateSnapshot({ shopify: d }); }, setShopifyStatus,
        (m) => `Add ${m || "SHOPIFY_SHOP + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET"} in Netlify env vars, then redeploy.`),
      db.loadBirthdays().then(rows => {
        if (!alive()) return;
        setBirthdays(rows);
        const soon = (rows || []).map(b => ({ name: b.name, ...nextBirthdayOccurrence(b.month, b.day) })).filter(b => b.daysUntil <= 14).sort((a, b) => a.daysUntil - b.daysUntil);
        updateSnapshot({ todayBirthdays: soon });
      }).catch(e => { if (alive()) setBirthdaysErr(/fetch/i.test(e?.message || "") ? "Couldn't reach Supabase — check the connection and refresh." : e?.message || "Couldn't load birthdays."); }),
      db.loadEvents().then(rows => {
        if (!alive()) return;
        setMiniEvents(rows);
        const soon = (rows || []).filter(ev => { const days = (new Date(ev.start_time) - new Date()) / 86400000; return days >= -0.5 && days <= 3; }).map(ev => ({ title: ev.title }));
        updateSnapshot({ todayEvents: soon });
      }).catch(() => { if (alive()) setMiniEvents([]); }),
      loadOpen("calendar", (d) => setEvents(d.events || []), setEventsStatus),
      (async () => {
        if (!settings?.calendar_url) { if (alive()) setMeetingsStatus({ state: "notconfigured", detail: "Add your calendar's iCal (.ics) link in Settings to see meetings here." }); return; }
        const res = await callFnFull("calendar-events", { url: settings.calendar_url });
        if (!alive()) return;
        if (res.ok && res.data?.success) { setMeetings(res.data.events || []); setMeetingsStatus(liveStatus(!!(res.data.stale || res.data.cached))); }
        else setMeetingsStatus(keepIfLive(res));
      })(),
    ]);
    if (alive()) setBriefRefreshedAt(Date.now());
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
    : { state: "live", stale: marketsStale, at: marketsStale ? (stocksStatus.at ?? btc.fetchedAt ?? boot.updatedAt) : null, detail: marketsStale ? "Showing the last good prices" : undefined };

  const pad = isMobile ? "sm" : "md";

  // Collapse controller — spread {...coll("id")} into any CollapsibleCard.
  const coll = (cardId) => ({
    id: cardId,
    collapsed: !!collapsed[cardId],
    onToggle: () => setCollapsed(prev => {
      const next = { ...prev, [cardId]: !prev[cardId] };
      try { localStorage.setItem("br_brief_collapsed", JSON.stringify(next)); } catch { /* storage full — collapse just won't persist */ }
      return next;
    }),
  });

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
    <CollapsibleCard {...coll("markets")} pad={pad}
      leading={<span aria-hidden style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--btc)", color: "#1A0F00", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flex: "none" }}>₿</span>}
      title="Markets"
      trailing={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <StancePill text={stance} color={stanceColor} />
          {(marketsStatus.state !== "live" || marketsStatus.stale) && <StatusTag status={marketsStatus} />}
        </span>
      }
    >
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
    </CollapsibleCard>
  );

  /* ── Watch this week — US econ calendar with one-line AI takes ─────────── */
  const card_watch = (
    <CollapsibleCard {...coll("watch")} pad={pad} title="Watch This Week" tight
      trailing={<><span className="t-cap" style={{ color: "var(--faint)" }}>CT time</span><StatusTag status={eventsStatus} /></>}>
      {/* .feed-rails gives the phone a strip down each side of the feed that
          isn't part of the scroller, so a thumb there scrolls the PAGE. See
          components.css — the feed bleeds into the card padding to pay for it. */}
      <div className="feed-rails">
        <div className="brief-scroll" style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 340, overflowY: "auto" }}>
          {eventsStatus.state === "live" ? (
            events.length ? <>{events.map((e) => {
              // Every phrase, badge and tone on the row comes from one pure
              // function — see watchState.js for why the "check back after the
              // print lands" state could never resolve, and what replaced it.
              const row = watchRowState(e, resultFor(e), eventAnalysis[takeKey(e)]);
              return (
                // Stacked, not squeezed: the time + Result badge share the top
                // line; the event title gets the full width below it (aligned
                // under the time), then the one-line take. Reads cleanly on a
                // phone instead of wrapping the title into a narrow middle column.
                // Stable identity, not list position: this feed re-sorts and drops
                // old events every refresh, so an index key hands React a reused
                // node for a different event.
                <div key={eventId(e)} style={{ background: row.bg, borderRadius: 12, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 5, flexShrink: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Dot tone={e.color} />
                    <span className="t-cap t-num" style={{ color: "var(--faint)", whiteSpace: "nowrap" }}>{e.time}</span>
                    <span style={{ flex: 1 }} />
                    {row.badge && <span className="t-cap" style={{ color: row.badgeColor, fontWeight: 600, flex: "none" }}>{row.badge}</span>}
                  </div>
                  <div className="t-call" style={{ lineHeight: 1.4, paddingLeft: 17 }}>{row.line}</div>
                  <div className="t-foot" style={{ color: "var(--faint)", paddingLeft: 17, lineHeight: 1.5 }}>
                    {row.pulse ? <span style={{ animation: "pulse 1.4s infinite" }}>{row.note}</span> : row.note}
                  </div>
                </div>
              );
            })}
            </> : <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 0" }}>No high/medium-impact US events in the last 18 hours or next 7 days.</div>
          ) : <FeedFallbackRow status={eventsStatus} />}
        </div>
      </div>
      {freshOrStale(eventsStatus)}
    </CollapsibleCard>
  );

  /* ── Search Console — stat tiles double as the chart's metric tabs ─────── */
  const card_gsc = (
    <CollapsibleCard {...coll("gsc")} pad={pad} title="Zero To Secure · Search Console" trailing={<StatusTag status={gscStatus} />}>
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
    </CollapsibleCard>
  );

  /* ── Clarify pipeline ──────────────────────────────────────────────────── */
  const card_clarify = (
    <CollapsibleCard {...coll("clarify")} pad={pad} title="Clarify · Outreach Pipeline" trailing={<StatusTag status={clarifyStatus} />}>
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
    </CollapsibleCard>
  );

  /* ── ZTS creator pipeline ──────────────────────────────────────────────── */
  const card_zts = (
    <CollapsibleCard {...coll("zts")} pad={pad} title="Zero To Secure · Creator Pipeline" trailing={<StatusTag status={ztsPipeStatus} />}>
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
    </CollapsibleCard>
  );

  /* ── Shopify store ─────────────────────────────────────────────────────── */
  const card_shopify = (
    <CollapsibleCard {...coll("shopify")} pad={pad} title="Zero To Secure · Store" trailing={<StatusTag status={shopifyStatus} />}>
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
    </CollapsibleCard>
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
    <CollapsibleCard {...coll("calendar")} pad={pad} tight
      title={miniNow.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
      trailing={<button className="sec-link" onClick={onOpenCalendar} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>Open<IcChevronRight size={12} /></button>}>
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
    </CollapsibleCard>
  );

  /* ── Upcoming birthdays — the next two weeks, rolling ──────────────────── */
  const upcomingBdays = (birthdays || [])
    .map(b => ({ ...b, ...nextBirthdayOccurrence(b.month, b.day) }))
    .filter(b => b.daysUntil <= 14)
    .sort((a, b) => a.daysUntil - b.daysUntil);
  const bdayUntil = (d) => d === 0 ? "Today" : d === 1 ? "Tomorrow" : `in ${d}d`;
  const card_birthdays = (
    <CollapsibleCard {...coll("birthdays")} pad={pad} tight title="Birthdays"
      trailing={<button className="sec-link" onClick={onOpenBirthdays} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>All<IcChevronRight size={12} /></button>}>
      {birthdays === null ? (
        birthdaysErr ? (
          <div className="t-foot" style={{ color: "var(--faint)", padding: "4px 0" }}>{birthdaysErr}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 2 }}>
            <div className="sk sk-line w80" style={{ margin: 0 }} />
            <div className="sk sk-line w60" style={{ margin: 0 }} />
          </div>
        )
      ) : upcomingBdays.length === 0 ? (
        <div className="t-foot" style={{ color: "var(--faint)", padding: "4px 0" }}>No birthdays in the next two weeks.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {upcomingBdays.map((b, i) => {
            const soon = b.daysUntil <= 7;
            return (
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 34, padding: "3px 0", borderTop: i === 0 ? "none" : "0.5px solid var(--line)" }}>
                <Dot tone={T.pink} size={6} />
                <span className="t-call" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {b.name}
                  {b.year ? <span className="t-cap" style={{ color: "var(--faint)", fontWeight: 400 }}> · turns {b.next.getFullYear() - b.year}</span> : null}
                </span>
                <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{b.next.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                <span className="t-num" style={{ fontSize: 12, fontWeight: 600, color: soon ? "var(--accent)" : "var(--faint)", flex: "none", minWidth: 56, textAlign: "right" }}>{bdayUntil(b.daysUntil)}</span>
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleCard>
  );

  /* ── Business meetings (external iCal) ─────────────────────────────────── */
  const visibleMeetings = meetingsAll ? meetings : meetings.slice(0, ROW_CAP);
  const card_meetings = (
    <CollapsibleCard {...coll("meetings")} pad={pad} tight title="Business Meetings" trailing={<StatusTag status={meetingsStatus} />}>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {meetingsStatus.state === "live" ? (
          meetings.length ? (
            <>
              {visibleMeetings.map((m, i) => (
                <div key={`${m.when}|${m.title}`} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "5px 0", borderTop: i === 0 ? "none" : "0.5px solid var(--line)" }}>
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
    </CollapsibleCard>
  );

  /* ── The wire — headline ticker ────────────────────────────────────────── */
  const card_wire = (
    <CollapsibleCard {...coll("wire")} pad={pad} tight title="The Wire" trailing={<StatusTag status={wireStatus} />}>
      {wireStatus.state === "live" ? (
        wire.length ? (
          // .feed-rails keeps a thumb-width strip down each side OUTSIDE this
          // scroller, so on a phone there's always somewhere to swipe the page
          // itself. See components.css.
          <div className="feed-rails">
            <div className="brief-scroll" style={{ display: "flex", flexDirection: "column", maxHeight: 480, overflowY: "auto" }}>
              {wire.map((w, i) => (
                // The whole ROW used to be the <a>, so on a phone any scroll-nudge or
                // mis-tap while reading launched an article. Only the timestamp opens
                // it now; the headline is inert (and selectable, so a headline can be
                // copied). Still a real <a>, not an onClick — long-press, open-in-new-
                // tab and copy-link all keep working.
                <div key={w.link || `${w.time}|${w.text}`}
                  title={w.tag ? `${w.tag} · ${w.text}` : w.text}
                  style={{ display: "flex", alignItems: "baseline", gap: 8, minHeight: 34, flexShrink: 0, padding: "6px 0", borderTop: i === 0 ? "none" : "0.5px solid var(--line)" }}>
                  {/* Category is just the colored dot next to the time — the text
                      label (WIRE/REGULATORY/…) is dropped so each headline gets the
                      full remaining width and wraps to fewer lines. */}
                  {w.link ? (
                    <a className="wire-open" href={w.link} target="_blank" rel="noreferrer"
                      title="Open article" aria-label={`Open article: ${w.text}`}>
                      <Dot tone={w.tagColor} size={6} />
                      <span className="t-cap t-num">{w.time}</span>
                      <IcExternal size={9} aria-hidden />
                    </a>
                  ) : (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
                      <Dot tone={w.tagColor} size={6} />
                      <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{w.time}</span>
                    </span>
                  )}
                  <span className="t-call" style={{ minWidth: 0, flex: 1, lineHeight: 1.4 }}>{w.text}</span>
                </div>
              ))}
            </div>
          </div>
        ) : <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 0" }}>No headlines returned this cycle.</div>
      ) : <FeedFallbackRow status={wireStatus} />}
      {freshOrStale(wireStatus)}
    </CollapsibleCard>
  );

  // The Docket card was retired — its greeting/date/summary duplicated the
  // "Brief" large-title header at the top of the page. (birthdays/events are
  // still loaded above; they feed the snapshot the board seats read.)
  const card_notes = <NotesTile {...coll("notes")} isMobile={isMobile} refreshSignal={refreshSignal} onOpenNotes={onOpenNotes} settings={settings} updateSetting={updateSetting} />;

  // Column count + container width scale with the viewport so a wide desktop
  // fills the space instead of stranding two narrow columns in a sea of black:
  // 1 col (phone/tablet portrait), 2 (≥1024), 3 (≥1440).
  const nCols = xwide ? 3 : wide ? 2 : 1;
  const maxW = xwide ? 1480 : 960;
  // ONE masonry over every card — no fixed rows, no full-width section dividers
  // that would strand a short card above a gap. Cards are dealt in GLANCE ORDER
  // into whichever column is currently shortest, so tall and short widgets nestle
  // together while the order still reflects what you actually read first. `w` is a
  // rough relative height, eyeballed not measured: it only needs to be ordinally
  // right, and being wrong costs a slightly uneven column, never a bug.
  //
  // On the phone (nCols 1) this array IS the scroll order, which is what the order
  // below is tuned for. Birthdays sits directly under the calendar on purpose —
  // it's a calendar concern ("who's coming up"), so that's where you look for it.
  // Side effect worth knowing: at three columns that makes Birthdays a column-top
  // and pushes Markets to second in its column. Markets is still above the fold,
  // and the phone is the surface that matters here.
  //
  // `id` is the persistence key for the manual order (app_settings.brief_order),
  // so these strings are permanent: renaming one silently resets that card to its
  // default slot for everyone who had moved it.
  // `label` feeds the layout sheet's arrangement grid — the card's own title,
  // not a second name for it.
  const DEFAULT_CARDS = [
    { id: "notes", c: card_notes, w: 3, label: "Notes" }, { id: "minicalendar", c: card_minicalendar, w: 2.5, label: "Calendar" }, { id: "birthdays", c: card_birthdays, w: 1.5, label: "Birthdays" },
    { id: "markets", c: card_markets, w: 2.5, label: "Markets" }, { id: "watch", c: card_watch, w: 3, label: "Watch This Week" },
    // 4.5, not 3: the feed is 480px tall now (50% up from 320), and the weight is
    // what stops the packer from stacking it under another tall card.
    { id: "wire", c: card_wire, w: 4.5, label: "The Wire" },
    { id: "gsc", c: card_gsc, w: 2.5, label: "Search Console" }, { id: "meetings", c: card_meetings, w: 2, label: "Meetings" }, { id: "clarify", c: card_clarify, w: 1.5, label: "Clarify" },
    { id: "zts", c: card_zts, w: 1.5, label: "ZTS" }, { id: "shopify", c: card_shopify, w: 1.5, label: "Shopify" },
  ];
  // Your arrangement, if you have one. See lib/brief-order.js for why a card the
  // saved order has never seen keeps its default slot instead of jumping to top.
  const cards = applyBriefOrder(DEFAULT_CARDS, settings?.brief_order);
  // Layout profiles are a DESKTOP concern (they're named after screens — "Mac",
  // "iPad"); the phone always renders the one-column glance order. The default
  // arrangement honors the stored column-count override; a named profile deals
  // cards into its authored columns and turns the drag off — its arrangement is
  // edited in the sheet, and a drag that silently rewrote an authored column
  // would be data loss wearing a gesture.
  const layoutProfile = !isMobile ? activeLayout(settings) : null;
  const briefCols = isMobile ? 1 : layoutProfile ? layoutColumnCount(layoutProfile) : defaultColumnCount(settings, nCols);
  return (
    <div style={{ flex: 1, padding: isMobile ? "2px 12px 20px" : "6px 0 0", minWidth: 0 }}>
      {!isMobile && (
        <div style={{ maxWidth: maxW, margin: "0 auto 6px", display: "flex", justifyContent: "flex-end" }}>
          <Button kind="plain" size="sm" style={{ height: 44 }} onClick={() => setLayoutOpen(true)}>
            Layout{layoutProfile ? ` · ${layoutProfile.name}` : ""}
          </Button>
        </div>
      )}
      {/* Hold a card for a moment, then drag it anywhere — including into another
          column. Deliberately no edit toggle, no drag handles, no reorder mode:
          the affordance IS the hold, so at rest the Brief looks exactly as it
          always did. The same gesture already moves notes, so there's one thing
          to learn. Alt+↑/↓ on a focused card does it from the keyboard.
          ignoreWithin keeps the inner feeds scrollable — a hold inside The Wire
          or Watch This Week is a scroll, not a grab — and the nested Notes list
          claims its own holds through the [data-sortable] ownership rule. */}
      {layoutProfile ? (
        // A named profile renders its authored columns statically — no drag.
        // The arrangement is edited in the layout sheet (arrow moves); a drag
        // that re-dealt an authored column would rewrite the profile silently.
        <div className="stagger" style={{ maxWidth: maxW, width: "100%", margin: "0 auto", minWidth: 0, display: "flex", flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
          {dealExplicit(cards, layoutProfile, briefCols).map((col, i) => (
            <div key={i} style={{ flex: 1, minWidth: 0 }}>
              {col.map((card) => <div key={card.id} style={{ marginBottom: 8 }}>{card.c}</div>)}
            </div>
          ))}
        </div>
      ) : (
      <SortableList
        className="stagger"
        items={cards}
        onReorder={(ids) => updateSetting?.("brief_order", ids)}
        ignoreWithin=".brief-scroll, .pillrow"
        style={{ maxWidth: maxW, width: "100%", margin: "0 auto", minWidth: 0, display: "flex", flexDirection: "row", gap: 8, alignItems: "flex-start" }}
        layout={(itemNodes, ordered) => {
          // Pack the NODES, not the cards: packColumns takes the weights off the
          // ordered cards and we deal the matching rendered node into the same
          // slot, so the sequence the drag produced is the sequence dealt out.
          const withNodes = ordered.map((card, i) => ({ ...card, node: itemNodes[i] }));
          return packColumns(withNodes, briefCols).map((col, i) => (
            <div key={i} style={{ flex: 1, minWidth: 0 }}>
              {col.map((card) => <div key={card.id} style={{ marginBottom: 8 }}>{card.node}</div>)}
            </div>
          ));
        }}
      >
        {(card) => card.c}
      </SortableList>
      )}
      {layoutOpen && (
        <BriefLayoutSheet
          settings={settings}
          updateSetting={updateSetting}
          cards={cards}
          screenColumns={layoutProfile ? dealExplicit(cards, layoutProfile, briefCols) : packColumns(cards, briefCols)}
          autoCols={nCols}
          onClose={() => setLayoutOpen(false)}
        />
      )}
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
