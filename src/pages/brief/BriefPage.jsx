// ─── Page: the morning brief ──────────────────────────────────────────────────
// Everything on this page is fetched live on load through Netlify functions.
// No fabricated fallback numbers anywhere on this page. Each card is either
// live (real data), not connected (with exact setup instructions), or error
// (with the actual failure). Empty dashes beat plausible-looking fake data.
import { useState, useEffect, useRef, useCallback } from "react";
import { T } from "../../theme.js";
import { Card, SectionHeader, StatTile, Button, Dot, Delta, EmptyState, Grid } from "../../ui/kit.jsx";
import { IcChevronRight, IcClose, IcWrench, SPORT_ICONS } from "../../ui/icons.jsx";
import { StancePill, StatusTag, CARD_STATES } from "../../ui/shared.jsx";
import { NumTween, Sparkline } from "../../ui/primitives.jsx";
import GscLineChart from "../../GscLineChart.jsx";
import BtcChartModal from "../../BtcChartModal.jsx";
import { callFnFull } from "../../lib/functions.js";
import { callClaude } from "../../lib/claude.js";
import { updateSnapshot, formatSnapshotForChat } from "../../lib/snapshot.js";
import { db } from "../../data/db.js";
import { nextBirthdayOccurrence, MONTH_NAMES } from "../../lib/dates.js";
import { DocketCard } from "./DocketCard.jsx";
import { NotesTile } from "./NotesTile.jsx";
import { SportsSettingsModal } from "../board/SportsSettingsModal.jsx";
import { EVENT_CATEGORIES } from "../personal/CalendarPanel.jsx"; // canonical category → color map (mini-calendar pills)

const GSC_EMPTY = { impressions: "—", impressionsD: "", clicks: "—", clicksD: "", pos: "—", posD: "", series: Array(14).fill(0), daily: [], note: "" };
const STOCKS_EMPTY = { spx: { value: "—", price: "—", up: true }, ndq: { value: "—", price: "—", up: true }, tnx: { value: "—", price: "—", up: true }, dxy: { value: "—", price: "—", up: true } };

const ROW_CAP = 5; // list cards show the first N in-page; the rest behind "Show all"

/* Card header: .t-head title + status cluster at right — one grammar for every
   Brief card. */
function CardHead({ title, leading, trailing, tight }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: tight ? 8 : 12 }}>
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
  return <div className="t-cap t-num" style={{ marginTop: 10, color: "var(--faint)" }}>{children}</div>;
}

/* In-page list expander — replaces the old capped nested-scroll regions. */
function ShowMore({ open, count, onToggle }) {
  return (
    <Button kind="plain" full onClick={onToggle} style={{ marginTop: 2 }}>
      {open ? "Show fewer" : `Show all ${count}`}
    </Button>
  );
}

export function MorningBriefPage({ btc, isMobile, settings, updateSetting, onOpenCalendar, onOpenNotes, refreshSignal }) {
  const sportsCfg = settings?.sports || { followedTeams: [], watchLeagues: [], watchGames: [], excludedGames: [] };
  const [sportsGames, setSportsGames] = useState([]);
  const [sportsStatus, setSportsStatus] = useState({ state: "loading" });
  const [sportsDetail, setSportsDetail] = useState({}); // eventId -> detail | "loading" | "error"
  const [openGameId, setOpenGameId] = useState(null);
  const [sportsSettingsOpen, setSportsSettingsOpen] = useState(false);

  const toggleGame = async (g) => {
    if (openGameId === g.id) { setOpenGameId(null); return; }
    setOpenGameId(g.id);
    if (sportsDetail[g.id]) return; // already fetched — no need to hit the network again
    setSportsDetail(prev => ({ ...prev, [g.id]: "loading" }));
    const res = await callFnFull("sports-detail", { sport: g.sport, league: g.league, eventId: g.id });
    if (res.ok && res.data?.success) setSportsDetail(prev => ({ ...prev, [g.id]: res.data }));
    else setSportsDetail(prev => ({ ...prev, [g.id]: "error" }));
  };
  const excludeGame = (id) => {
    const next = { ...sportsCfg, excludedGames: [...(sportsCfg.excludedGames || []), id] };
    updateSetting("sports", next);
    setSportsGames(prev => prev.filter(g => g.id !== id)); // instant — don't wait on the next poll
  };
  const [gsc, setGsc] = useState(GSC_EMPTY);
  const [gscStatus, setGscStatus] = useState({ state: "loading" });
  const [gscMetric, setGscMetric] = useState("impressions");
  const [stocks, setStocks] = useState(STOCKS_EMPTY);
  const [stocksStatus, setStocksStatus] = useState({ state: "loading" });
  const [events, setEvents] = useState([]);
  const [eventsStatus, setEventsStatus] = useState({ state: "loading" });
  const [clarify, setClarify] = useState(null);
  const [clarifyStatus, setClarifyStatus] = useState({ state: "loading" });
  const [ztsPipe, setZtsPipe] = useState(null);
  const [ztsPipeStatus, setZtsPipeStatus] = useState({ state: "loading" });
  const [wire, setWire] = useState([]);
  const [wireStatus, setWireStatus] = useState({ state: "loading" });
  const [shopify, setShopify] = useState(null);
  const [shopifyStatus, setShopifyStatus] = useState({ state: "loading" });
  const [meetings, setMeetings] = useState([]);
  const [meetingsStatus, setMeetingsStatus] = useState({ state: "loading" });
  const [birthdays, setBirthdays] = useState(null); // null = loading
  const [birthdaysErr, setBirthdaysErr] = useState(null);
  const [miniEvents, setMiniEvents] = useState([]); // for the mini calendar card — same personal_events table CalendarPanel uses
  const [eventAnalysis, setEventAnalysis] = useState({}); // idx -> one-sentence take | "loading" | "error"
  const [btcChartOpen, setBtcChartOpen] = useState(false);
  const [aiBtcNarrative, setAiBtcNarrative] = useState(null);
  const [btcNarrativeExpanded, setBtcNarrativeExpanded] = useState(false);
  const aiBtcNarrativeKey = useRef(null); // dedupe so a re-render doesn't refire the same call
  const [wireAll, setWireAll] = useState(false);
  const [meetingsAll, setMeetingsAll] = useState(false);
  const [birthdaysAll, setBirthdaysAll] = useState(false);
  const [sportsAll, setSportsAll] = useState(false);

  // Auto-generates a single, tidy one-sentence take (Bitcoin + stocks
  // together, not separate lines) for every Watch This Week event as soon
  // as the events load — no click needed, and each is cached by index so
  // it only ever generates once per event per session.
  const fetchEventTake = async (i, e) => {
    if (eventAnalysis[i]) return; // already have a read on this one
    setEventAnalysis(prev => ({ ...prev, [i]: "loading" }));
    const system = e.isPast
      ? `You give a single, tidy, opinionated read on how a US economic event ACTUALLY moved Bitcoin and equities together — ONE sentence covering both, not two. The event has already released; you're told the actual result vs. forecast/prior. Describe the real reaction, not a prediction — if you don't have enough to know the actual market reaction, say what the result itself implies instead of guessing at price action. No labels, no "BTC:"/"Stocks:" prefixes, no preamble, no markdown.`
      : `You give a single, tidy, opinionated read on how a US economic event will likely move Bitcoin and equities together — ONE sentence covering both, not two. Given a US economic calendar event (with forecast/prior if given), respond with ONLY that one sentence — no labels, no "BTC:"/"Stocks:" prefixes, no preamble, no markdown. Be directional where the data supports it — don't hedge into uselessness — but don't overstate certainty on an event that hasn't happened yet.`;
    const raw = await callClaude({ system, messages: [{ role: "user", content: e.text }], modelKey: "haiku", maxTokens: 100, fn: "event_impact" });
    if (raw && raw.trim()) setEventAnalysis(prev => ({ ...prev, [i]: raw.trim() }));
    else setEventAnalysis(prev => ({ ...prev, [i]: "error" }));
  };
  useEffect(() => {
    if (eventsStatus.state !== "live" || !events.length) return;
    events.forEach((e, i) => { if (!eventAnalysis[i]) fetchEventTake(i, e); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsStatus.state, events]);

  const [briefRefreshedAt, setBriefRefreshedAt] = useState(null); // shared freshness stamp for every card fetched in the batch below
  const freshnessLabel = (ts) => ts ? `Updated ${new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} CT` : "Updating…";

  // This used to be a fire-once effect — gsc/clarify/zts/wire/shopify/
  // calendar never refreshed again after the initial page load, and the
  // header's manual refresh button didn't touch any of them either. Real
  // bug: leave this tab open a while and 6 of 9 Brief cards were quietly
  // stale with no way to fix it short of a full page reload. Now a named,
  // reusable function — called on mount, on a shared interval below, and
  // when you switch back to this tab after it's been hidden a while.
  const refreshBrief = useCallback(async () => {
    let alive = true;
    const loadCredentialed = async (fn, payload, setData, setStatus, hint) => {
      const ping = await callFnFull(fn, { ping: true });
      if (!alive) return;
      if (ping.status === 404) return setStatus({ state: "nofn", detail: `push netlify/functions/${fn}.js and redeploy` });
      if (ping.data?.configured === false) return setStatus({ state: "notconfigured", detail: hint(ping.data.missing) });
      const res = await callFnFull(fn, payload);
      if (!alive) return;
      if (res.ok && res.data?.success) { setData(res.data); setStatus({ state: "live" }); }
      else setStatus({ state: "error", detail: res.data?.error || (res.status ? `HTTP ${res.status}` : "unreachable") });
    };
    const loadOpen = async (fn, apply, setStatus) => {
      const res = await callFnFull(fn, {});
      if (!alive) return;
      if (res.status === 404) return setStatus({ state: "nofn", detail: `push netlify/functions/${fn}.js and redeploy` });
      if (res.ok && res.data?.success) { apply(res.data); setStatus({ state: "live" }); }
      else setStatus({ state: "error", detail: res.data?.error || (res.status ? `HTTP ${res.status}` : "unreachable") });
    };
    await Promise.all([
      loadCredentialed("gsc", { site: "zerotosecure.com", days: 14 }, setGsc, setGscStatus,
        (m) => `Add ${m || "GSC_CLIENT_EMAIL + GSC_PRIVATE_KEY"} in Netlify env vars, share the Search Console property with the service account, then redeploy.`),
      loadCredentialed("clarify-pipeline", {}, (d) => setClarify(d), setClarifyStatus,
        (m) => `Add ${m || "CLARIFY_SUPABASE_URL + CLARIFY_SUPABASE_ANON_KEY"} in Netlify env vars, then redeploy.`),
      loadCredentialed("zts-pipeline", {}, (d) => setZtsPipe(d), setZtsPipeStatus,
        (m) => `Add ${m || "ZTS_SUPABASE_URL + ZTS_SUPABASE_ANON_KEY"} in Netlify env vars, then redeploy.`),
      loadOpen("markets", (d) => { setStocks(d); updateSnapshot({ stocks: d }); }, setStocksStatus),
      loadOpen("wire", (d) => { setWire(d.wire || []); updateSnapshot({ wire: d.wire || [] }); }, setWireStatus),
      loadCredentialed("shopify", { days: 14 }, (d) => setShopify(d), setShopifyStatus,
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
        const res = await callFnFull("sports", { followedTeams: sportsCfg.followedTeams, watchLeagues: sportsCfg.watchLeagues, watchGames: sportsCfg.watchGames, excludedGames: sportsCfg.excludedGames });
        if (!alive) return;
        if (res.ok && res.data?.success) { setSportsGames(res.data.games || []); setSportsStatus({ state: "live" }); }
        else setSportsStatus({ state: "error", detail: res.data?.error || "unreachable" });
      })(),
      (async () => {
        if (!settings?.calendar_url) { if (alive) setMeetingsStatus({ state: "notconfigured", detail: "Link a calendar (iCal / .ics URL) in the sidebar to see meetings here." }); return; }
        const res = await callFnFull("calendar-events", { url: settings.calendar_url });
        if (!alive) return;
        if (res.ok && res.data?.success) { setMeetings(res.data.events || []); setMeetingsStatus({ state: "live" }); }
        else setMeetingsStatus({ state: "error", detail: res.data?.error || "unreachable" });
      })(),
    ]);
    if (alive) setBriefRefreshedAt(Date.now());
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.calendar_url, JSON.stringify(settings?.sports)]);

  useEffect(() => { refreshBrief(); }, [refreshBrief]);

  useEffect(() => {
    if (refreshSignal) refreshBrief();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // One shared interval for everything above (was 3 separate mechanisms:
  // this one-time effect, plus bespoke stocks-only and sports-only
  // intervals — consolidated since they were all polling the same way for
  // no real reason). Also refetches when you switch back to this tab after
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

  const price = btc.loading ? "…" : btc.error || btc.price == null ? "—" : "$" + btc.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const hasChange = !btc.loading && !btc.error && btc.changePct !== null && btc.changePct !== undefined;
  const up = (btc.changePct || 0) >= 0;
  const hasRange = !btc.loading && !btc.error && btc.high24 != null && btc.low24 != null;
  const fmtK = (n) => "$" + (n / 1000).toFixed(1) + "K";
  let dayTarget = "—", support = "—", invalidation = "—", stance = "Neutral", stanceColor = T.sub, narrative = "Waiting on live price data to compute today's range and levels.";
  if (hasRange) {
    const range = Math.max(btc.high24 - btc.low24, btc.high24 * 0.001);
    const target = Math.max(btc.high24, btc.price + range * 0.5);
    const invalid = btc.low24 - range * 0.15;
    dayTarget = fmtK(target); support = fmtK(btc.low24); invalidation = fmtK(invalid);
    const posInRange = (btc.price - btc.low24) / range;
    stance = up ? "Constructive" : "Cautious"; stanceColor = up ? T.green : T.amber;
    const pos = posInRange > 0.7 ? "near the top of" : posInRange < 0.3 ? "near the bottom of" : "mid";
    narrative = `24h range ${fmtK(btc.low24)}–${fmtK(btc.high24)}, currently trading ${pos === "mid" ? "in the middle of" : pos} that range and ${up ? "up" : "down"} ${Math.abs(btc.changePct || 0).toFixed(1)}% on the day. Support sits at the 24h low (${fmtK(btc.low24)}); a break below ${invalidation} would put price outside the recent range.`;
  }
  // AI take on the setup — cached in app_settings (cross-device) with a 4h
  // TTL: it regenerates at most every ~4 hours, lazily, while the app is
  // open — not on every open, and never on the poll cadence. Strictly market
  // analysis: no references to personal positions or holdings.
  const OUTLOOK_TTL = 4 * 60 * 60 * 1000;
  const outlookAt = settings?.btc_outlook?.at || 0;
  useEffect(() => {
    if (!hasRange || settings == null) return;
    const cached = settings.btc_outlook;
    if (cached?.text && Date.now() - (cached.at || 0) < OUTLOOK_TTL) {
      setAiBtcNarrative(cached.text);
      return;
    }
    // stale or absent — generate once; the ref throttles retries so a failed
    // call doesn't re-fire on every price poll
    if (Date.now() - (aiBtcNarrativeKey.current || 0) < 10 * 60 * 1000) return;
    aiBtcNarrativeKey.current = Date.now();
    (async () => {
      const system = `You write one tight, genuinely informative take (2-3 sentences, no more) on Bitcoin's current setup for a sharp market watcher. Don't just restate the numbers you're given — say what they actually mean, and weave in today's broader market tape only if it's genuinely relevant (correlated risk-on/risk-off moves, a notable macro headline) — cut it if it doesn't add something real. Market analysis only: never reference the reader's personal positions, holdings, or leverage. No preamble, no markdown, no hedging filler.`;
      const context = `Price: $${Math.round(btc.price).toLocaleString()}, ${up ? "+" : ""}${(btc.changePct || 0).toFixed(1)}% 24h. 24h range: ${fmtK(btc.low24)}–${fmtK(btc.high24)}. Day target: ${dayTarget}. Support: ${support}. Invalidation: ${invalidation}.${formatSnapshotForChat()}`;
      const raw = await callClaude({ system, messages: [{ role: "user", content: context }], modelKey: "haiku", maxTokens: 130, fn: "btc_narrative" });
      if (raw && raw.trim()) {
        setAiBtcNarrative(raw.trim());
        updateSetting("btc_outlook", { text: raw.trim(), at: Date.now() });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRange, settings == null, btc.fetchedAt]);

  const pad = isMobile ? "md" : "lg";

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

  /* ── Bitcoin · day outlook ─────────────────────────────────────────────── */
  const fullNarrative = aiBtcNarrative || narrative;
  const firstSentenceEnd = fullNarrative.indexOf(". ");
  const shortNarrative = firstSentenceEnd > 0 ? fullNarrative.slice(0, firstSentenceEnd + 1) : fullNarrative;
  const hasMore = shortNarrative.length < fullNarrative.length;
  const btcStamp = `${freshnessLabel(btc.fetchedAt)}${aiBtcNarrative && outlookAt && Date.now() - outlookAt > 45 * 60 * 1000 ? ` · take ${Math.round((Date.now() - outlookAt) / 3600000)}h ago` : ""}`;
  const card_bitcoin = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead
        leading={<span aria-hidden style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--btc)", color: "#1A0F00", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flex: "none" }}>₿</span>}
        title="Bitcoin · day outlook"
        trailing={<StancePill text={stance} color={stanceColor} />}
      />
      <div onClick={() => setBtcChartOpen(true)} style={{ cursor: "pointer" }} title="Tap for the full chart">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <span className="t-title1 t-num">{btc.price != null && !btc.error ? <NumTween v={btc.price} f={n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 })} /> : price}</span>
          {hasChange && <Delta pct={btc.changePct} />}
        </div>
        {!btc.loading && !btc.error && (
          <div style={{ marginBottom: 12 }}>
            <Sparkline points={btc.points} color={up ? T.green : T.red} height={36} />
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          <StatTile value={dayTarget} label="Day target" />
          <StatTile value={support} label="Support (24h low)" valueTone={T.green} />
          <StatTile value={invalidation} label="Invalidation" valueTone={T.red} />
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.55 }}>{btcNarrativeExpanded ? fullNarrative : shortNarrative}</div>
        {hasMore && (
          <button onClick={() => setBtcNarrativeExpanded(e => !e)} aria-expanded={btcNarrativeExpanded}
            style={{ display: "inline-flex", alignItems: "center", minHeight: 40, margin: "-6px 0 -8px", padding: 0, background: "none", border: "none", cursor: "pointer" }}>
            <span className="t-cap" style={{ fontWeight: 600 }}>{btcNarrativeExpanded ? "Show less" : "Tap for more"}</span>
          </button>
        )}
      </div>
      <div style={{ marginTop: 4, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="t-cap t-num" style={{ color: "var(--faint)", minWidth: 0 }}>{btcStamp}</span>
        <Button kind="plain" size="sm" onClick={() => setBtcChartOpen(true)}
          style={{ height: 44, margin: "-6px -10px -8px 0", padding: "0 10px", flex: "none" }}>
          Chart <IcChevronRight size={12} />
        </Button>
      </div>
    </Card>
  );

  /* ── Stocks · day outlook ──────────────────────────────────────────────── */
  const spxUp = stocks.spx.up, ndqUp = stocks.ndq.up, tnxUp = stocks.tnx.up, dxyUp = stocks.dxy.up;
  const eqTone = spxUp && ndqUp ? "risk-on, with S&P and Nasdaq futures both pushing higher"
    : !spxUp && !ndqUp ? "risk-off, with S&P and Nasdaq futures both pulling back"
    : "mixed, with S&P and Nasdaq futures pointed in different directions";
  const stocksOutlook = stocksStatus.state === "live"
    ? `Futures are ${eqTone}, alongside ${tnxUp ? "rising" : "falling"} yields and a ${dxyUp ? "firmer" : "softer"} dollar.`
    : stocksStatus.state === "loading" ? "Loading live data…" : stocksStatus.detail;
  const card_stocks = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Stocks · day outlook" trailing={<StatusTag status={stocksStatus} />} />
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 12 }}>
        {[["S&P fut", stocks.spx], ["Nasdaq fut", stocks.ndq], ["10Y yield", stocks.tnx], ["DXY", stocks.dxy]].map(([l, s], i) => {
          // level + day move; a stale payload without `delta` falls back to the old single-value row
          const lvl = s.price && s.price !== "—" ? s.price : s.value;
          return <StatTile key={i} value={lvl} label={l} delta={s.delta} deltaTone={s.up ? T.green : T.red} valueTone={lvl === "—" ? T.faint : undefined} />;
        })}
      </div>
      <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.55 }}>{stocksOutlook}</div>
      <Fresh>{freshnessLabel(briefRefreshedAt)}</Fresh>
    </Card>
  );

  /* ── Watch this week — US econ calendar with one-line AI takes ─────────── */
  const card_watch = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Watch this week" tight
        trailing={<><span className="t-cap" style={{ color: "var(--faint)" }}>CT time</span><StatusTag status={eventsStatus} /></>} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {eventsStatus.state === "live" ? (
          events.length ? events.map((e, i) => {
            const analysis = eventAnalysis[i];
            return (
              <div key={i} style={{ background: e.isPast ? "var(--green-a06)" : "var(--surface-2)", borderRadius: 12, padding: "10px 13px", display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Dot tone={e.color} />
                  <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none", whiteSpace: "nowrap" }}>{e.time}</span>
                  <span className="t-call" style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>{e.text}</span>
                  {e.isPast && <span className="t-cap" style={{ color: "var(--green)", fontWeight: 600, flex: "none" }}>Result</span>}
                </div>
                <div className="t-foot" style={{ color: "var(--faint)", paddingLeft: 17, lineHeight: 1.45 }}>
                  {analysis === "loading" || !analysis ? <span style={{ animation: "pulse 1.4s infinite" }}>{e.isPast ? "Reading the actual impact…" : "Reading the likely impact…"}</span>
                    : analysis === "error" ? "Couldn't get a read on this one."
                    : analysis}
                </div>
              </div>
            );
          }) : <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 0" }}>No high/medium-impact US events in the last 12 hours or next 7 days.</div>
        ) : <FeedFallbackRow status={eventsStatus} />}
      </div>
      {eventsStatus.state === "live" && <Fresh>{freshnessLabel(briefRefreshedAt)}</Fresh>}
    </Card>
  );

  /* ── Search Console — stat tiles double as the chart's metric tabs ─────── */
  const card_gsc = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Zero To Secure · Search Console" trailing={<StatusTag status={gscStatus} />} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 12 }}>
        <StatTile value={gsc.impressions} label="Impressions" delta={gsc.impressionsD} onClick={() => setGscMetric("impressions")} selected={gscMetric === "impressions"} />
        <StatTile value={gsc.clicks} label="Clicks" delta={gsc.clicksD} onClick={() => setGscMetric("clicks")} selected={gscMetric === "clicks"} />
        <StatTile value={gsc.pos} label="Avg position" delta={gsc.posD} onClick={() => setGscMetric("position")} selected={gscMetric === "position"} />
      </div>
      <GscLineChart rows={gsc.daily} metric={gscMetric} />
      <div className="t-foot" style={{ marginTop: 8, color: gscStatus.state === "live" ? "var(--sub)" : "var(--faint)", lineHeight: 1.5 }}>
        {gscStatus.state === "live" ? gsc.note : gscStatus.state === "loading" ? "Loading…" : gscStatus.detail}
      </div>
      {gscStatus.state === "live" && <Fresh>{freshnessLabel(briefRefreshedAt)}</Fresh>}
    </Card>
  );

  /* ── Clarify pipeline ──────────────────────────────────────────────────── */
  const card_clarify = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Clarify · outreach pipeline" trailing={<StatusTag status={clarifyStatus} />} />
      {clarifyStatus.state === "live" ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 11 }}>
            <StatTile value={String(clarify.prospected)} label="Prospected" />
            <StatTile value={String(clarify.drafts)} label="Drafts" />
            <StatTile value={String(clarify.sent)} label="Sent" />
            <StatTile value={String(clarify.replied)} label="Replied" />
          </div>
          <div className="t-call" style={{ color: "var(--sub)" }}><span className="t-num" style={{ fontWeight: 600, color: "var(--ink)" }}>{clarify.replyRate}%</span> reply rate</div>
          <Fresh>{freshnessLabel(briefRefreshedAt)}</Fresh>
        </>
      ) : <FeedFallbackRow status={clarifyStatus} />}
    </Card>
  );

  /* ── ZTS creator pipeline ──────────────────────────────────────────────── */
  const card_zts = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Zero To Secure · creator pipeline" trailing={<StatusTag status={ztsPipeStatus} />} />
      {ztsPipeStatus.state === "live" ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 11 }}>
            <StatTile value={String(ztsPipe.prospected)} label="Prospected" />
            <StatTile value={String(ztsPipe.sent)} label="Sent" />
            <StatTile value={String(ztsPipe.replied)} label="Replied" />
            <StatTile value={String(ztsPipe.collab)} label="Collab" />
          </div>
          <div className="t-call" style={{ color: "var(--sub)" }}><span className="t-num" style={{ fontWeight: 600, color: "var(--ink)" }}>{ztsPipe.weightedReach.toLocaleString()}</span> weighted reach in pipeline</div>
          <Fresh>{freshnessLabel(briefRefreshedAt)}</Fresh>
        </>
      ) : <FeedFallbackRow status={ztsPipeStatus} />}
    </Card>
  );

  /* ── Shopify store ─────────────────────────────────────────────────────── */
  const card_shopify = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead title="Zero To Secure · store" trailing={<StatusTag status={shopifyStatus} />} />
      {shopifyStatus.state === "live" ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 11 }}>
            <StatTile value={String(shopify.orders)} label="Orders" delta={shopify.ordersD} />
            <StatTile value={shopify.visits} label="Visits" delta={shopify.visitsD} />
            <StatTile value={shopify.conv} label="Conv." />
            <StatTile value={shopify.convD || "—"} label="Conv. Δ" />
          </div>
          {shopify.series && <Sparkline points={shopify.series} color={T.green} height={40} />}
          <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.55, marginTop: 8 }}>{shopify.note}</div>
          <Fresh>{freshnessLabel(briefRefreshedAt)}</Fresh>
        </>
      ) : <FeedFallbackRow status={shopifyStatus} />}
    </Card>
  );

  /* ── Mini calendar — whole card taps through to the Calendar tab ───────── */
  const miniCatColor = (key) => (EVENT_CATEGORIES.find(c => c.key === key) || EVENT_CATEGORIES[0]).color;
  const miniNow = new Date();
  const miniYear = miniNow.getFullYear(), miniMonth = miniNow.getMonth();
  const miniDaysInMonth = new Date(miniYear, miniMonth + 1, 0).getDate();
  const miniLeading = new Date(miniYear, miniMonth, 1).getDay();
  const miniCells = [...Array(miniLeading).fill(null), ...Array.from({ length: miniDaysInMonth }, (_, i) => i + 1)];
  const miniEventsByDay = {};
  (miniEvents || []).forEach(ev => { const k = ev.start_time.slice(0, 10); (miniEventsByDay[k] = miniEventsByDay[k] || []).push(ev); });
  const miniDateKey = (day) => `${miniYear}-${String(miniMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const todayDate = miniNow.getDate();
  const card_minicalendar = (
    <Card pad={pad} pressable onClick={onOpenCalendar} title="Open the full calendar" style={{ minWidth: 0 }}>
      <CardHead tight title={miniNow.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        trailing={<span className="t-cap" style={{ color: "var(--faint)" }}>This month</span>} />
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
            <div key={day} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2, textAlign: "left", minWidth: 0, height: 44, overflow: "hidden", padding: 3, borderRadius: 8, background: isToday ? "var(--accent-a10)" : "transparent" }}>
              <span className="t-num" style={{ fontSize: 11, fontWeight: isToday ? 700 : 500, color: isToday ? "var(--accent)" : "var(--ink)", paddingLeft: 1 }}>{day}</span>
              {dayEvents.length > 0 && (
                // a real (truncated) title pill, not a dot — minWidth:0 + overflow
                // let it clip inside the narrow cell instead of stretching it
                <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--chip-ink)", background: miniCatColor(dayEvents[0].category), borderRadius: 4, padding: "1px 4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.5, minWidth: 0, maxWidth: "100%", display: "block" }}>{dayEvents.length > 1 ? `${dayEvents[0].title} +${dayEvents.length - 1}` : dayEvents[0].title}</span>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );

  /* ── Birthdays (next 30 days) ──────────────────────────────────────────── */
  const upcomingBirthdays = (birthdays || [])
    .map(b => ({ ...b, ...nextBirthdayOccurrence(b.month, b.day) }))
    .filter(b => b.daysUntil <= 30)
    .sort((a, b) => a.daysUntil - b.daysUntil);
  const visibleBirthdays = birthdaysAll ? upcomingBirthdays : upcomingBirthdays.slice(0, ROW_CAP);
  const card_birthdays = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead tight title="Upcoming birthdays" trailing={<span className="t-cap" style={{ color: "var(--faint)" }}>Next 30d</span>} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        {birthdaysErr ? (
          <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 0" }}>{birthdaysErr}</div>
        ) : birthdays === null ? (
          <div style={{ padding: "6px 0" }}><div className="sk sk-line w80" style={{ margin: 0 }} /></div>
        ) : upcomingBirthdays.length ? (
          <>
            {visibleBirthdays.map((b, i) => (
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "5px 0", borderTop: i === 0 ? "none" : "0.5px solid var(--line)" }}>
                <Dot tone={T.purple} />
                <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                  <span className="t-call" style={{ lineHeight: 1.4 }}>{b.name}{b.year ? ` — turns ${b.next.getFullYear() - b.year}` : ""}</span>
                  <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{MONTH_NAMES[b.month - 1]} {b.day} · {b.daysUntil === 0 ? "Today!" : b.daysUntil === 1 ? "Tomorrow" : `in ${b.daysUntil}d`}</span>
                </span>
              </div>
            ))}
            {upcomingBirthdays.length > ROW_CAP && <ShowMore open={birthdaysAll} count={upcomingBirthdays.length} onToggle={() => setBirthdaysAll(v => !v)} />}
          </>
        ) : <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 0" }}>Nothing in the next 30 days.</div>}
      </div>
    </Card>
  );

  /* ── Business meetings (external iCal) ─────────────────────────────────── */
  const visibleMeetings = meetingsAll ? meetings : meetings.slice(0, ROW_CAP);
  const card_meetings = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead tight title="Business meetings" trailing={<StatusTag status={meetingsStatus} />} />
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
      <CardHead tight title="The wire" trailing={<StatusTag status={wireStatus} />} />
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
      {wireStatus.state === "live" && <Fresh>{freshnessLabel(briefRefreshedAt)}</Fresh>}
    </Card>
  );

  /* ── Sports — followed teams, watch list, live scores ──────────────────── */
  const visibleGames = sportsAll ? sportsGames : sportsGames.slice(0, ROW_CAP);
  const card_sports = (
    <Card pad={pad} style={{ minWidth: 0 }}>
      <CardHead tight title="Sports"
        trailing={<>
          <Button kind="plain" size="sm" title="Manage teams & leagues" aria-label="Manage teams & leagues"
            onClick={() => setSportsSettingsOpen(true)}
            style={{ width: 44, height: 44, padding: 0, margin: "-10px -4px -10px 0", color: "var(--sub)" }}>
            <IcWrench size={17} />
          </Button>
          <StatusTag status={sportsStatus} />
        </>} />
      {sportsStatus.state === "live" ? (
        !sportsCfg.followedTeams.length && !sportsCfg.watchLeagues.length && !sportsCfg.watchGames.length ? (
          <EmptyState style={{ padding: "18px 12px" }} title="No teams or leagues yet"
            sub="Follow teams, leagues, or single games and they'll show up here with live scores."
            action={<Button kind="tinted" size="sm" style={{ height: 44 }} onClick={() => setSportsSettingsOpen(true)}>Set up sports</Button>} />
        ) : sportsGames.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {visibleGames.map((g) => {
              const open = openGameId === g.id;
              const detail = sportsDetail[g.id];
              const Icon = SPORT_ICONS[g.sport] || SPORT_ICONS.baseball;
              const iconColor = g.state === "in" ? T.red : g.isPast ? T.green : T.faint;
              return (
                <div key={g.id} style={{ background: "var(--surface-2)", borderRadius: 12, padding: "0 4px 0 12px" }}>
                  <div onClick={() => toggleGame(g)} role="button" tabIndex={0} aria-expanded={!!expandedGames[g.id]}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGame(g); } }}
                    style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", minHeight: 46 }}>
                    <Icon width={16} height={16} style={{ flex: "none", color: iconColor, animation: g.state === "in" ? "pulse 1.4s infinite" : "none" }} />
                    <span className="t-call" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.away?.abbr} {g.away?.score ?? ""} @ {g.home?.abbr} {g.home?.score ?? ""}
                    </span>
                    {g.significance && <span className="t-cap" style={{ color: "var(--sub)", fontWeight: 600, flex: "none" }}>{g.significance}</span>}
                    <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{g.statusDetail}</span>
                    <button onClick={(e) => { e.stopPropagation(); excludeGame(g.id); }} title="Hide this game" aria-label="Hide this game"
                      style={{ width: 40, height: 46, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: "var(--faint)", cursor: "pointer", flex: "none", padding: 0 }}>
                      <IcClose size={14} />
                    </button>
                  </div>
                  {open && (
                    <div className="t-foot" style={{ margin: "0 8px 0 0", padding: "8px 0 10px", borderTop: "0.5px solid var(--line)", color: "var(--sub)", lineHeight: 1.6 }}>
                      {detail === "loading" || !detail ? <span style={{ animation: "pulse 1.4s infinite" }}>Loading…</span>
                        : detail === "error" ? "Couldn't load details for this one."
                        : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            {detail.venue && <div>{detail.venue}{detail.broadcast ? ` · ${detail.broadcast}` : ""}</div>}
                            {detail.home?.record && <div>{detail.away?.name} ({detail.away?.record}) at {detail.home?.name} ({detail.home?.record})</div>}
                            {detail.linescores?.some(l => l.periods?.length) && (
                              <div className="t-num" style={{ fontSize: 11.5 }}>
                                {detail.linescores.map((l, i) => <div key={i}>{l.abbr}: {l.periods.join(" · ")}</div>)}
                              </div>
                            )}
                            {detail.leaders?.map((l, i) => <div key={i}>{l.team} — {l.category}: {l.athlete} ({l.value})</div>)}
                            {detail.preview && <div>{detail.preview}</div>}
                          </div>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
            {sportsGames.length > ROW_CAP && <ShowMore open={sportsAll} count={sportsGames.length} onToggle={() => setSportsAll(v => !v)} />}
          </div>
        ) : <div className="t-foot" style={{ color: "var(--faint)", padding: "6px 0", lineHeight: 1.5 }}>Nothing on right now — followed teams, significant games, or your watch list will show up here.</div>
      ) : <FeedFallbackRow status={sportsStatus} />}
      {sportsSettingsOpen && <SportsSettingsModal cfg={sportsCfg} onSave={(next) => { updateSetting("sports", next); setSportsSettingsOpen(false); }} onClose={() => setSportsSettingsOpen(false)} isMobile={isMobile} />}
    </Card>
  );

  const card_docket = <DocketCard isMobile={isMobile} birthdays={birthdays} macroEvents={eventsStatus.state === "live" ? events : []} settings={settings} onOpenCalendar={onOpenCalendar} />;
  const card_notes = <NotesTile isMobile={isMobile} refreshSignal={refreshSignal} onOpenNotes={onOpenNotes} />;

  // One flow for both platforms: a single calm column on the phone (min=9999
  // collapses every Grid to one track), the same order flowing 2-up on tablet
  // (min=320 + maxWidth 960 caps the Grids at two columns — never three).
  // minmax(min(...,100%),1fr) tracks + minWidth:0 cards keep an unbreakable
  // line (a URL in a note) from stretching the page sideways on mobile — the
  // same guard the old grid carried. The shell (#page-scroll) owns scrolling
  // and the desktop gutters — this page never nests its own scroll region.
  const gmin = isMobile ? 9999 : 320;
  return (
    <div style={{ flex: 1, padding: isMobile ? "4px 16px 24px" : "8px 0 0", minWidth: 0 }}>
      <div className="stagger" style={{ maxWidth: 960, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <Grid min={gmin} style={{ alignItems: "stretch" }}>
          {card_docket}
          {card_notes}
        </Grid>
        <SectionHeader title="Market" style={{ marginTop: 14 }} />
        <Grid min={gmin}>
          {card_bitcoin}{card_stocks}{card_watch}
        </Grid>
        <SectionHeader title="Signals" style={{ marginTop: 14 }} />
        <Grid min={gmin}>
          {card_gsc}{card_clarify}{card_zts}{card_sports}{card_wire}{card_shopify}{card_meetings}{card_minicalendar}{card_birthdays}
        </Grid>
      </div>
      {btcChartOpen && <BtcChartModal isMobile={isMobile} onClose={() => setBtcChartOpen(false)} callFnFull={callFnFull} />}
    </div>
  );
}

export default MorningBriefPage;
