// ─── Stocks — the Alt Season tab, clocked in sessions ────────────────────────
// The same anatomy, because it is the one he reads without thinking: a regime
// strip, a Flags card sectioned by whether it is time, movers, the board, the
// record. The vocabulary is identical on purpose — a move that is "Breaking
// out" on one tab must not be called something else on the other.
//
// WHAT IS DIFFERENT IS THE CLOCK, AND IT SHOWS EVERYWHERE. Equities trade about
// a fifth of wall-clock time, so:
//   · every window is a SESSION count, never a number of hours. There is no
//     "4h ago" on a Sunday.
//   · headings that say "now" say "at Friday's close" when nothing can move.
//   · the poll turns OFF when the market is shut. Re-fetching a closed tape on
//     a timer is theatre.
//   · nothing counts up in seconds, and the tab never predicts the next open —
//     that needs a market calendar we deliberately refuse to hardcode.
//
// The watchlist tiles stay at the top: they are the four things he checks
// fastest, one of them (gold) is not an equity and is not screenable, and the
// screener does not replace a glance at a price.
import { lazy, Suspense, useEffect, useState } from "react";
import { T } from "../../theme.js";
import { Card, CollapsibleCard, CellGroup, Cell, StatTile, Button, PillRow, EmptyState, Dot, Delta } from "../../ui/kit.jsx";
import { IcChevronDown } from "../../ui/icons.jsx";
import { StatusTag, CARD_STATES } from "../../ui/shared.jsx";
import { NumTween, Sparkline } from "../../ui/primitives.jsx";
import { callFnFull } from "../../lib/functions.js";
import { useStockQuotes, useStockScan, useRunStockScreener } from "../../data/altseason.js";
import StockSheet, { TonePill, STAGE_LABEL, MOTION_LABEL, HIT_LABEL } from "./StockSheet.jsx";
import RecordCard from "./RecordCard.jsx";

const BtcChartModal = lazy(() => import("../../BtcChartModal.jsx"));

const TICKERS = [["Gold", "gold"], ["NVDA", "nvda"], ["MSTR", "mstr"], ["STRC", "strc"]];

// FOUR PILLS, ALL SESSION-SHAPED, ALL FINAL, ALL DEFINED AT 3AM ON A SUNDAY.
// Crypto's row of six is the most visible place its 24/7 assumption reaches the
// user; here every one of these describes the last COMPLETED session, so none
// is ever a claim about a tape that is not printing. "Overnight" is the window
// crypto has no version of and is where equities actually move.
const MOVER_WINDOWS = [
  { key: "1s", label: "1 session" },
  { key: "overnight", label: "Overnight" },
  { key: "5s", label: "1 week" },
  { key: "21s", label: "1 month" },
];
const SECTION_PREVIEW = 10;
// A full sweep is ~50 paced requests plus headlines — about two minutes. Five
// gives it real headroom and still admits failure while you are looking at it.
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

const PHASE_TONE = { risk_on: T.green, broadening: T.green, mixed: T.amber, narrow: T.red, risk_off: T.red };
const PHASE_READ = {
  risk_on: "Breakouts are getting paid — setups here work more often than not.",
  broadening: "The move is widening past the index leaders — setups are earlier.",
  mixed: "No clear leadership — only the cleanest setups pay.",
  narrow: "A handful of names carry the tape — be picky, and be small.",
  risk_off: "Nothing is bid — the best trade here is usually no trade.",
};

// THE SETTLE RUNS AFTER THE CLOSE, SO THIS WHOLE CARD IS A PLAN FOR THE NEXT
// OPEN. It used to say "worth an entry at Wednesday's close" — a fact about a
// session that is over, when the only thing you can act on is the bell. The
// headings are written for the morning now, and the two lists are the two
// questions you actually have: what do I take at the open, and what am I
// getting ready for.
const ENTRY_META = {
  entry: {
    label: "Entry", tone: T.green,
    head: "Take at the open", headOpen: "Worth an entry now",
    rule: "Triggered and still worth it: the first target is ahead, the stop is close, and the move pays 1.5×+ what being wrong costs.",
  },
  watch: {
    label: "Watch", tone: T.amber,
    head: "Getting ready", headOpen: "Getting ready",
    rule: "Not triggered yet. Each row says the price it has to reach — and why it might get there.",
  },
  late: {
    label: "Late", tone: T.faint,
    head: "Already ran", headOpen: "Already ran",
    rule: "Past its first target, parabolic, or too thin to exit — you'd be buying the exit.",
  },
};
const CATALYST_LABEL = {
  accumulation: "volume, no price",
  squeeze: "coiled",
  gap: "gapped",
  volume: "heavy volume",
};
const ENTRY_ORDER = ["entry", "watch", "late"];
const stateOf = (x) => (x && x.entry && ENTRY_META[x.entry.state] ? x.entry.state : "watch");

const STAGE_CLAUSE = { base: "level", atLevel: "level", breaking: "motion", extending: "motion" };

const inCardGroup = { boxShadow: "none", background: "transparent", borderRadius: 0, margin: "0 -16px -8px" };

function px(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1000) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`;
  if (a === 0) return "$0";
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}

/** "Breaking out · pace picking up" — the stage, and the one thing worth adding. */
function stageLine(move, short) {
  const stage = move && STAGE_LABEL[move.stage] ? move.stage : null;
  if (!stage) return null;
  const head = STAGE_LABEL[stage];
  if (short) return head;
  const which = STAGE_CLAUSE[stage];
  if (which === "level") {
    // `probing` is the equity-only fact: the session's HIGH cleared the level
    // and the close did not. A close-only series literally cannot produce it.
    if (stage === "atLevel" && move.probing) return `${head} · poked through, closed under`;
    if (Number.isFinite(move.toLevelPct)) {
      const v = move.toLevelPct;
      return `${head} · ${Math.abs(v).toFixed(1)}% ${v < 0 ? "under" : "over"}`;
    }
    return head;
  }
  // An ABSENT pace clause means not measured. "holding" means measured and flat.
  if (which === "motion" && move.motion) return `${head} · ${MOTION_LABEL[move.motion]}`;
  return head;
}

/**
 * What this row needs you to do in the morning.
 *
 * The entry list is already triggered, so it says where the move is and gets
 * out of the way. The "getting ready" list is the one that was useless before:
 * it said a name was not ready and never said what ready would look like. Now
 * it names the price and the distance.
 */
function planLine(row, state) {
  const t = row.trigger;
  if (state === "watch" && t && Number.isFinite(t.price)) {
    const away = Number.isFinite(t.pct) ? ` · ${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(1)}%` : "";
    if (t.kind === "level") return `needs a close over ${px(t.price)}${away}`;
    if (t.kind === "target") return `through its level · next ${px(t.price)}${away}`;
  }
  return null;
}

function numberSlot(move, entry, tone) {
  const stage = move && move.stage;
  if (stage === "broken") return { text: "stop gone", tone: T.red, caption: null };
  if (stage === "spent") return { text: "done", tone: "var(--faint)", caption: "past T3" };
  if (move && Number.isFinite(move.offPeakPct)) {
    return { text: `${move.offPeakPct.toFixed(0)}%`, tone: T.red, caption: "off high" };
  }
  const room = entry ? entry.roomPct : null;
  if (Number.isFinite(room) && room > 0) return { text: `+${Math.round(room)}%`, tone, caption: "left" };
  return { text: "—", tone: "var(--faint)", caption: null };
}

function NumberCell({ move, entry, tone }) {
  const slot = numberSlot(move, entry, tone);
  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, minWidth: 54, flex: "none" }}>
      <span className="t-num" style={{ fontSize: 13.5, fontWeight: 600, color: slot.tone }}>{slot.text}</span>
      {slot.caption && <span className="t-cap" style={{ color: "var(--faint)", fontSize: 10.5 }}>{slot.caption}</span>}
    </span>
  );
}

/** How many SESSIONS ago the flag fired — never "3 days", which counts weekends. */
function ageWord(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((Date.now() - t) / 86400000);
  return d <= 0 ? "today" : `${d}d`;
}

function FallbackRow({ detail, onRetry }) {
  return (
    <div style={{ background: "var(--surface-2)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 13px", minHeight: 52 }}>
      <Dot tone={CARD_STATES.error.color} />
      <span className="t-foot" style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>{detail || "Screener unavailable."}</span>
      <Button kind="quiet" size="sm" style={{ height: 44, flex: "none" }} onClick={onRetry}>Retry</Button>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <Card pad="md"><div className="sk sk-line w40" /><div className="sk sk-line" /><div className="sk sk-line w60" /></Card>
      <Card pad="md">
        <div className="sk sk-line w40" style={{ marginBottom: 14 }} />
        <div className="sk-row" style={{ marginBottom: 12 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 30, borderRadius: 999 }} />)}</div>
        <div className="sk sk-line" /><div className="sk sk-line" /><div className="sk sk-line w80" />
      </Card>
    </div>
  );
}

export function StocksPanel({ isMobile }) {
  const quotes = useStockQuotes();
  const q = useStockScan();
  const run = useRunStockScreener();
  const data = q.data;

  // A MANUAL PASS IS BOUNDED, AND IT KNOWS WHEN IT IS DONE.
  //
  // The first version inferred "running" from `isSuccess && !data?.settledSession`,
  // which has two ways to hang forever and hit both: isSuccess never goes back
  // to false, and `data` is null the whole time the read is erroring — so a
  // pass that failed, or one whose board simply had not propagated, left the
  // card polling every fifteen seconds with no way out and a fake "running"
  // message sitting where the real error should have been.
  //
  // Done is now a FACT rather than an absence: we remember the payload stamp we
  // started from and stop when a different one comes back. And it is bounded,
  // because a screen that spins forever is worse than one that admits it
  // failed.
  const [runState, setRunState] = useState(null); // null | {startedAt, priorAsOf} | "timeout"
  const running = !!runState && runState !== "timeout";
  const timedOut = runState === "timeout";

  useEffect(() => {
    if (!running) return undefined;
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      if (Date.now() - runState.startedAt > RUN_TIMEOUT_MS) { setRunState("timeout"); return; }
      const r = await q.refetch();
      // A NEW stamp, not merely a present one — re-running an already-settled
      // session would otherwise look finished the instant it started.
      if (alive && r.data?.asOf && r.data.asOf !== runState.priorAsOf) setRunState(null);
    };
    // Immediately, then on a cadence. Waiting the full interval before the
    // first look is how a pass that finished in forty seconds still reads as
    // running two minutes later.
    poll();
    const iv = setInterval(poll, 12_000);
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState]);

  const startRun = () => {
    setRunState({ startedAt: Date.now(), priorAsOf: data?.asOf || null });
    run.mutate();
  };

  const runNow = (
    <Button kind="quiet" size="sm" disabled={running} onClick={startRun} style={{ height: 44, flex: "none" }}>
      {running ? "Running…" : "Run now"}
    </Button>
  );

  const [tickerChart, setTickerChart] = useState(null);
  const [collapsed, setCollapsed] = useState(() => {
    // Same call as the Alt Season tab: the board hides, the record does not.
    const defaults = { board: true, record: false, watchlist: false };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("br_stock_collapsed") || "{}") }; }
    catch { return defaults; }
  });
  const [openSec, setOpenSec] = useState(() => {
    const defaults = { entry: true, watch: false, late: false };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("br_stock_sections") || "{}") }; }
    catch { return defaults; }
  });
  const [showAll, setShowAll] = useState({});
  const [whyOpen, setWhyOpen] = useState(false);
  const [win, setWin] = useState("1s");
  const [sel, setSel] = useState(null);
  const [chart, setChart] = useState(null);

  const coll = (id) => ({
    id,
    collapsed: !!collapsed[id],
    onToggle: () => setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem("br_stock_collapsed", JSON.stringify(next)); } catch { /* storage full */ }
      return next;
    }),
  });
  const toggleSec = (key) => setOpenSec((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    try { localStorage.setItem("br_stock_sections", JSON.stringify(next)); } catch { /* storage full */ }
    return next;
  });

  const tileGrid = { display: "grid", gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 };

  const watchlist = (
    <CollapsibleCard {...coll("watchlist")} title="Watchlist">
      {quotes.data ? (
        <div style={tileGrid}>
          {TICKERS.map(([label, key]) => {
            const s = quotes.data[key];
            const lvl = s?.price && s.price !== "—" ? s.price : (s?.value || "—");
            const live = lvl !== "—";
            return <StatTile key={key} value={lvl} label={label} delta={s?.delta || null} deltaTone={s?.up ? T.green : T.red}
              valueTone={live ? undefined : T.faint} onClick={live ? () => setTickerChart({ key, label }) : undefined} />;
          })}
        </div>
      ) : quotes.isError ? (
        <FallbackRow detail={quotes.error?.message} onRetry={() => quotes.refetch()} />
      ) : (
        <div style={tileGrid}>{[0, 1, 2, 3].map((i) => <div key={i} className="sk sk-tile" />)}</div>
      )}
    </CollapsibleCard>
  );

  if (data == null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {watchlist}
        {q.isError ? (
          <Card pad="md">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
              <span className="t-head">Screener</span>
              <span style={{ marginLeft: "auto" }}>{runNow}</span>
            </div>
            {/* The real error is never hidden behind a fake progress message —
                that is how a broken pass reads as a slow one forever. */}
            <FallbackRow
              detail={
                running ? "Running the screener — a full pass takes a couple of minutes."
                  : timedOut ? `The pass didn't finish inside ${Math.round(RUN_TIMEOUT_MS / 60000)} minutes. ${run.error?.message || q.error?.message || "Check the function log."}`
                  : (run.error?.message || q.error?.message)
              }
              onRetry={() => { setRunState(null); q.refetch(); }} />
          </Card>
        ) : <PanelSkeleton />}
      </div>
    );
  }

  const regime = data.regime || null;
  const board = Array.isArray(data.board) ? data.board : [];
  const movers = data.movers || null;
  const session = data.session || null;
  const open = session?.state === "open";
  const active = [...(data.flags?.active || [])].sort((a, b) =>
    (a.tier === b.tier ? (b.score || 0) - (a.score || 0) : a.tier === "igniting" ? -1 : 1));
  const grouped = { entry: [], watch: [], late: [] };
  for (const f of active) grouped[stateOf(f)].push(f);
  const recent = data.flags?.recent || [];
  const stats = data.flags?.stats || null;

  const boardById = new Map(board.map((r) => [r.id, r]));
  const openStock = (c) => setSel({ id: c.tickerId || c.id, symbol: c.symbol, name: c.name });
  const openMover = (m) => (boardById.has(m.id) ? openStock(m) : setChart({ id: m.symbol, symbol: m.symbol }));

  const list = movers ? movers[win] : null;
  // What a name would have needed, and the few that came closest. The board is
  // already sorted by score, so "closest" is just the top of it.
  const gateFloor = regime?.gate ? (regime.gate.effectiveFloor ?? regime.gate.floor ?? null) : null;
  const nearMisses = active.length === 0 ? board.slice(0, 4) : [];
  // THE HEADINGS SAY WHEN. "Worth an entry now" is a claim about a tape that is
  // printing; on a Saturday the honest version names the session it came from.
  const asOfWord = open ? "now" : session?.lastSessionLabel ? `at ${session.lastSessionLabel}'s close` : "at the last close";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      {q.isError && (
        <Card pad="sm">
          <FallbackRow detail={`Refresh failed — showing the last good pass (${q.error?.message || "unreachable"})`} onRetry={() => q.refetch()} />
        </Card>
      )}

      {watchlist}

      {/* ── REGIME — a strip, not a card ─────────────────────────────────── */}
      <div style={{ padding: "0 2px 2px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 30, minWidth: 0 }}>
          <Dot tone={PHASE_TONE[regime?.phase] || T.faint} size={7} />
          <span className="t-label" style={{ color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {regime?.label || "No read"}
          </span>
          {regime?.score != null && (
            <span className="t-num" style={{ fontSize: 13, color: "var(--faint)", flex: "none" }}>
              <NumTween v={regime.score} f={(n) => String(Math.round(n))} />
            </span>
          )}
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
            {data.stale && <StatusTag status={{ state: "live", stale: true, at: data.asOf }} />}
            {regime?.score != null && (
              <Button kind="plain" size="sm" onClick={() => setWhyOpen((v) => !v)}
                style={{ height: 44, margin: "-11px -10px", padding: "0 10px" }}>{whyOpen ? "Hide" : "Why"}</Button>
            )}
          </span>
        </div>
        <div className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.5 }}>
          {regime?.score != null
            ? (PHASE_READ[regime.phase] || "")
            : "The score publishes once the screener has breadth to measure — unmeasured parts are dropped, never guessed."}
        </div>
        {whyOpen && (
          <div style={{ marginTop: 6 }}>
            {regime.facts?.[0] && <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.5, paddingBottom: 2 }}>{regime.facts[0]}</div>}
            {(regime.parts || []).map((p) => (
              <div key={p.key} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, padding: "4px 0" }}>
                <span className="t-foot" style={{ color: "var(--sub)", minWidth: 0, lineHeight: 1.45 }}>{p.label}</span>
                <span className="t-cap t-num" style={{ color: p.points == null ? "var(--faint)" : "var(--ink)", flex: "none" }}>
                  {p.points == null ? "—" : p.points}/{p.max}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── FLAGS ────────────────────────────────────────────────────────── */}
      <CollapsibleCard {...coll("flags")} title="Flags"
        trailing={active.length > 0 ? (
          <span className="t-cap t-num" style={{ color: "var(--faint)" }}>
            <span style={{ color: grouped.entry.length ? T.green : "var(--faint)", fontWeight: 600 }}>{grouped.entry.length} to enter</span>
            {" · "}{active.length} tracked
          </span>
        ) : null}
      >
        {/* THE WHOLE CARD IS A PLAN FOR THE NEXT OPEN, and it should say so
            rather than leaving it to be inferred from a heading. */}
        {!open && session?.lastSessionLabel && (
          <div className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.5, paddingBottom: 4 }}>
            Settled after {session.lastSessionLabel}'s close — this is the plan for the next open.
          </div>
        )}
        {regime?.gate && (
          <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, paddingBottom: 4 }}>
            <span className="t-num">{regime.gate.effectiveFloor ?? regime.gate.floor}</span>/100 to flag in this tape,
            {" "}<span className="t-num">{regime.gate.max}</span> open at a time
            {regime.gate.bindingLeg === "percentile" ? " — the bar is the day's own top decile" : ""}.
          </div>
        )}
        {active.length ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {ENTRY_ORDER.map((state) => {
              const rows = grouped[state];
              if (!rows.length) return null;
              const meta = ENTRY_META[state];
              const isOpen = !!openSec[state];
              const all = !!showAll[state];
              const shown = isOpen ? (all ? rows : rows.slice(0, SECTION_PREVIEW)) : [];
              return (
                <div key={state}>
                  <button type="button" onClick={() => toggleSec(state)} aria-expanded={isOpen}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 44, background: "none", border: "none", padding: "6px 0", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
                    <Dot tone={meta.tone} size={7} />
                    <span className="t-label" style={{ color: "var(--ink)", minWidth: 0 }}>
                      {/* "now" is a claim about a printing tape; with the
                          market shut the only actionable moment is the bell,
                          and it is deliberately "the next open" rather than
                          "tomorrow" — a Friday evening is not tomorrow, and
                          naming the day needs a holiday calendar this
                          refuses to hardcode. */}
                      {open ? meta.headOpen : meta.head}
                    </span>
                    <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{rows.length}</span>
                    <IcChevronDown size={12} style={{ marginLeft: "auto", flex: "none", color: "var(--faint)", transform: isOpen ? "none" : "rotate(-90deg)", transition: "transform var(--dur-2) var(--ease-out)" }} />
                  </button>
                  {isOpen && (
                    <>
                      <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, paddingBottom: 6 }}>{meta.rule}</div>
                      <CellGroup style={inCardGroup}>
                        {shown.map((f) => {
                          const age = ageWord(f.firstFlaggedAt);
                          const hit = HIT_LABEL[f.status];
                          const mark = f.move?.thin ? { text: "can't exit", tone: T.red }
                            : hit ? { text: hit, tone: T.green } : null;
                          return (
                            <Cell key={f.id}
                              onClick={() => openStock(f)}
                              title={
                                <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
                                  <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.04em", color: "var(--ink)" }}>{f.symbol}</span>
                                  {age && <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{age}</span>}
                                  {mark && <span className="t-cap t-num" style={{ color: mark.tone, fontWeight: 600 }}>{mark.text}</span>}
                                </span>
                              }
                              sub={
                                <span style={{ display: "inline-flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                                  <span>{planLine(f, state) || stageLine(f.move) || "—"}</span>
                                  {f.catalyst && (
                                    <span style={{ color: "var(--faint)" }}>
                                      {CATALYST_LABEL[f.catalyst.kind] || "worth a look"}
                                      {f.news?.[0] ? ` · ${f.news[0].title}` : ""}
                                    </span>
                                  )}
                                </span>
                              }
                              trailing={
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 12, flex: "none" }}>
                                  <NumberCell move={f.move} entry={f.entry} tone={meta.tone} />
                                  <span style={{ minWidth: 62, display: "flex", justifyContent: "flex-end" }}>
                                    <Delta pct={f.sinceFlagPct} digits={1} />
                                  </span>
                                </span>
                              }
                            />
                          );
                        })}
                      </CellGroup>
                      {rows.length > SECTION_PREVIEW && (
                        <Button kind="plain" size="sm" style={{ height: 44 }}
                          onClick={() => setShowAll((p) => ({ ...p, [state]: !p[state] }))}>
                          {all ? `Show top ${SECTION_PREVIEW}` : `Show all ${rows.length}`}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          // AN EMPTY LIST IS NOT AN EMPTY SCREEN. "Nothing to take at the
          // open" over a blank card reads as a broken tool, when what is
          // actually true is that a full board exists and none of it cleared
          // the bar — which is itself information, and useless without the
          // near misses beside it. So the strongest few come with it, with the
          // number they would have needed.
          <div>
            <EmptyState title="Nothing to take at the open"
              sub={`Nothing cleared ${gateFloor != null ? `${gateFloor}/100` : "the bar"} off ${session?.lastSessionLabel || "the last session"}. Not a fault — a short list is the point.`}
              style={{ padding: "18px 16px 10px" }} />
            {nearMisses.length > 0 && (
              <>
                <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, padding: "0 0 4px" }}>
                  Closest to it — watch these for a close over their level.
                </div>
                <CellGroup style={inCardGroup}>
                  {nearMisses.map((r) => (
                    <Cell key={r.id}
                      onClick={() => openStock(r)}
                      title={r.symbol} titleStyle={{ fontSize: 14, fontWeight: 600 }}
                      sub={planLine(r, "watch") || stageLine(r.move) || r.name}
                      trailing={
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
                          <span className="t-num" style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{r.score}</span>
                          {gateFloor != null && (
                            <span className="t-cap t-num" style={{ color: "var(--faint)", minWidth: 42, textAlign: "right" }}>
                              {r.score >= gateFloor ? "over" : `−${gateFloor - r.score}`}
                            </span>
                          )}
                          <Delta pct={r.chgSession} digits={1} />
                        </span>
                      }
                    />
                  ))}
                </CellGroup>
              </>
            )}
          </div>
        )}
      </CollapsibleCard>

      {/* ── MOVERS ───────────────────────────────────────────────────────── */}
      <Card pad="md">
        <span className="t-head" style={{ display: "block", marginBottom: 3 }}>Movers</span>
        <div className="t-cap" style={{ color: "var(--faint)", marginBottom: 6, lineHeight: 1.5 }}>
          Biggest movers last session — where the tape was hot, not entries.
        </div>
        <PillRow options={MOVER_WINDOWS} value={win} onChange={setWin} style={{ margin: "0 -16px 2px" }} />
        {win === "overnight" && session?.overnightSpan && (
          // A Monday overnight is a whole weekend and a post-holiday one is
          // four nights. A pill that means one thing on Tuesday and three on
          // Monday has to say which.
          <div className="t-cap t-num" style={{ color: "var(--faint)", padding: "2px 2px 0" }}>{session.overnightSpan}</div>
        )}
        {!list || !list.length ? (
          <div className="t-foot" style={{ color: "var(--sub)", padding: "10px 2px 4px", lineHeight: 1.5 }}>
            Nothing eligible moved in this window.
          </div>
        ) : (
          <CellGroup style={inCardGroup}>
            {list.map((m, i) => (
              <Cell key={m.id}
                onClick={() => openMover(m)}
                leading={<span className="t-cap t-num" style={{ color: "var(--faint)" }}>{i + 1}</span>}
                title={m.symbol} titleStyle={{ fontSize: 14, fontWeight: 600 }}
                sub={boardById.has(m.id) ? (stageLine(boardById.get(m.id).move, true) || m.name) : m.name}
                trailing={
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
                    {m.spark?.length > 1 && (
                      <span style={{ width: 52, flex: "none", display: "inline-flex" }} aria-hidden>
                        <Sparkline points={m.spark} height={24} color={(m.pct ?? 0) >= 0 ? T.green : T.red} />
                      </span>
                    )}
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                      <span className="t-num" style={{ fontSize: 13.5, color: "var(--ink)" }}>{px(m.price)}</span>
                      <Delta pct={m.pct} digits={1} />
                    </span>
                  </span>
                }
              />
            ))}
          </CellGroup>
        )}
      </Card>

      {/* ── BOARD ────────────────────────────────────────────────────────── */}
      <CollapsibleCard {...coll("board")} title="Board" tight>
        <div className="t-foot" style={{ color: "var(--sub)", marginBottom: 4, lineHeight: 1.5 }}>
          Ranked by how likely a move is starting, not by how much it already moved —
          a good <em>setup</em> is not a good <em>entry</em>, and the tag says which.
        </div>
        {board.length ? (
          <CellGroup style={inCardGroup}>
            {board.slice(0, 15).map((r) => {
              const em = ENTRY_META[stateOf(r)];
              return (
                <Cell key={r.id}
                  onClick={() => openStock(r)}
                  title={r.symbol} titleStyle={{ fontSize: 14, fontWeight: 600 }}
                  sub={stageLine(r.move) || r.name}
                  trailing={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
                      <span className="t-num" style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{r.score}</span>
                      <TonePill tone={em.tone} style={{ minWidth: 52, justifyContent: "center", display: "inline-flex" }}>{em.label}</TonePill>
                      <Delta pct={r.chgSession} digits={1} />
                    </span>
                  }
                />
              );
            })}
          </CellGroup>
        ) : (
          <EmptyState title="No board yet" sub="The screener hasn't settled a session." />
        )}
      </CollapsibleCard>

      {/* ── RECORD — shared with the Alt Season tab, so both screeners are
          graded by the same arithmetic ───────────────────────────────────── */}
      <RecordCard stats={stats} recent={recent} collapseProps={coll("record")} noun="flags" />

      {/* NOTHING COUNTS UP IN SECONDS. A market that is shut is not stale — it
          is finished, and the footer says which session it finished. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "2px 0 6px" }}>
        <span className="t-cap t-num" style={{ color: "var(--faint)", lineHeight: 1.6 }}>
          {open ? "Market open · " : ""}
          settled {session?.lastSessionLabel || "—"}
          {data.coverage != null && data.coverage < 1 ? ` · ${Math.round(data.coverage * 100)}% reached` : ""}
          {open && data.liveAsOf ? " · flags refreshed hourly" : ""}
        </span>
        {runNow}
      </div>

      {/* A PASS CAME BACK TOO THIN AND WAS THROWN AWAY. The board above is the
          previous session's and is whole — the engine declines to publish off a
          partial sample rather than quietly serving one. Worth saying out loud
          because the alternative reading of an unchanged board is that nothing
          has been trying, and this says something IS trying and failing. */}
      {data.lastPass && data.lastPass.rejected && (
        <div className="t-cap t-num" style={{ color: "var(--faint)", textAlign: "center", padding: "0 0 6px", lineHeight: 1.5 }}>
          Last attempt reached {Math.round((data.lastPass.coverage || 0) * 100)}% of the universe and was discarded — the board above is the last complete one.
        </div>
      )}

      {sel && (
        <StockSheet
          sel={sel}
          row={boardById.get(sel.id) || null}
          episode={active.find((f) => f.tickerId === sel.id) || null}
          session={session}
          onClose={() => setSel(null)}
          onChart={() => setChart({ id: sel.symbol, symbol: sel.symbol })}
        />
      )}
      {(chart || tickerChart) && (
        <Suspense fallback={null}>
          <BtcChartModal
            key={(chart || tickerChart).symbol || tickerChart.key}
            isMobile={isMobile}
            onClose={() => { setChart(null); setTickerChart(null); }}
            callFnFull={callFnFull}
            title={(chart || tickerChart).symbol || tickerChart.label}
            fn="ticker-candles"
            fnArgs={{ symbol: (chart ? chart.symbol : tickerChart.key) }}
            defaultInterval="1d"
            z={480}
          />
        </Suspense>
      )}
    </div>
  );
}

export default StocksPanel;
