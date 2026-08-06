// ─── Alt Season — the monitor ────────────────────────────────────────────────
// One column, checked one-handed on a phone: the regime score answers "is this
// a market to be in", the flag radar answers "which coins, right now", the
// movers answer "what's already going", and the board and record sit folded
// underneath as the evidence and the receipts. The hourly cron did every piece
// of math on this page — the panel only formats and never re-derives, so the
// number here and the number the flag log was graded by are the same number.
//
// The 60s poll (useAltScan) overlays live prices server-side; `stale` fires
// when EITHER half aged out — the screener pass is >2h old, or the live quote
// fetch failed and the prices shown are the stored pass's (alt-scan sets it
// for both). The footer's two stamps say which half is old.
import { lazy, Suspense, useEffect, useState } from "react";
import { T } from "../../theme.js";
import { Card, CollapsibleCard, CellGroup, Cell, Button, PillRow, EmptyState, Dot, Delta } from "../../ui/kit.jsx";
import { IcChevronDown } from "../../ui/icons.jsx";
import { StancePill, StatusTag, CARD_STATES } from "../../ui/shared.jsx";
import { NumTween, Sparkline } from "../../ui/primitives.jsx";
import { callFnFull } from "../../lib/functions.js";
import { useAltScan } from "../../data/altseason.js";
import AltCoinSheet, { TonePill, TIER_META, HIT_LABEL } from "./AltCoinSheet.jsx";

// Lazy — lightweight-charts stays in its own chunk until a chart is opened.
const BtcChartModal = lazy(() => import("../../BtcChartModal.jsx"));

/* ── tiny formatters — client-side duplicates of the server's (server math is
      never duplicated; formatting is fine to) ────────────────────────────── */
// Sub-dollar prices get significant digits, not two decimals — "$0.00" is not
// a price, and the levels on this tab are read straight off these strings.
function px(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1000) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`;
  if (a === 0) return "$0";
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}
const signedPct = (n, d = 1) => (n == null || !isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);
const fmtDay = (iso) => { const d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };
// Accepts both stamp shapes: alt-scan ships ISO strings throughout, but a
// number is legal input too (fixtures and future callers) — and the number
// path matters because Date.parse(number) is NaN, not an epoch.
const rel = (stamp, now) => {
  const t = typeof stamp === "number" ? stamp : Date.parse(stamp);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
};

const MOVER_WINDOWS = ["1h", "4h", "12h", "24h", "7d", "30d"];
// Rows an open section shows before it asks. Ten is about a phone screen and a
// half; past that a section is a database dump, not a list.
const SECTION_PREVIEW = 10;

// StancePill tone by regime phase. majors_rotating rides with green — it's the
// "get ready" reading, not a warning; mixed is the genuine coin-flip.
const PHASE_TONE = { alt_season: T.green, majors_rotating: T.green, mixed: T.amber, btc_only: T.red, risk_off: T.red };

// What the regime means for what you do, in one sentence. The score and the
// breadth count are the evidence; this is the read, and it goes first — a
// number out of a hundred is not an instruction, and "39/100, Bitcoin only"
// left the entire "so what" to the reader every single time.
const PHASE_READ = {
  alt_season: "Alts are getting paid. Setups here work more often than they don't.",
  majors_rotating: "Money is moving, but into the majors first. Alt setups are early rather than wrong.",
  mixed: "No rotation in either direction. Only the cleanest setups are worth the risk.",
  btc_only: "Bitcoin is taking the flow. Most alt setups will chop here — be picky, and be small.",
  risk_off: "Nothing is being bid. The best trade in this tape is usually no trade.",
};

/* ── the entry read, as the page's spine ──────────────────────────────────────
   THE FLAGS CARD IS NOW SORTED BY WHETHER IT IS TIME, not by tier and score.
   Tier says how fast a move is expected; score says how good the setup graded.
   Neither answers the only question you have while scrolling — do I buy this
   one now — and the old card made you open every row to find out, which with
   fifty-two open flags means you open none of them.

   So the categories ARE the verdict: a coin's section is its answer, and the
   row only has to carry how far it goes and what it costs to be wrong. The
   sections state their own rule in a line, so the categorization explains
   itself instead of being a colour you have to learn. alt-scan computes the
   state (see entryRead there for the ordering and why it lives server-side). */
const ENTRY_META = {
  entry: {
    label: "Entry", tone: T.green, head: "Worth an entry now", open: true,
    rule: "The first target is still ahead, the invalidation is close enough to define the risk, and the full move pays at least 1.5× what the stop costs.",
  },
  watch: {
    label: "Watch", tone: T.amber, head: "Setting up — not yet", open: false,
    rule: "A real structure with nothing lifting it yet, or a payoff too thin from here to be worth the stop.",
  },
  late: {
    label: "Late", tone: T.faint, head: "Already ran", open: false,
    rule: "Past its own first target, parabolic, or too thin to exit. Starting here is buying somebody else's exit.",
  },
};
const ENTRY_ORDER = ["entry", "watch", "late"];
// An episode from a payload written before the entry read shipped has no
// verdict on it. It is not an entry until something says it is.
const stateOf = (x) => (x && x.entry && ENTRY_META[x.entry.state] ? x.entry.state : "watch");

/* How much it has left, as the one number the row leads with. Distance to T3 —
   the measured move — not to T1, because T1 is a checkpoint and the question
   is how far this goes. Past T3 the honest answer is that the plan is spent. */
function RoomCell({ entry, tone }) {
  const room = entry ? entry.roomPct : null;
  const has = Number.isFinite(room);
  const spent = has && room <= 0;
  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, minWidth: 50, flex: "none" }}>
      <span className="t-num" style={{ fontSize: 13.5, fontWeight: 600, color: has && !spent ? tone : "var(--faint)" }}>
        {!has ? "—" : spent ? "done" : `+${Math.round(room)}%`}
      </span>
      {/* No label under an em-dash — "— room" reads as a measurement of
          nothing rather than the absence of one. */}
      {has && <span className="t-cap" style={{ color: "var(--faint)", fontSize: 10 }}>{spent ? "past T3" : "room"}</span>}
    </span>
  );
}

// Terminal outcome tags for the record. A 14-day timeout keeps the ladder
// status it earned, so a closed row can still read 'active' — that's the
// went-nowhere close, labeled as what it was.
const OUTCOME = {
  hit_t3: { label: "Hit T3", tone: T.green },
  hit_t2: { label: "Hit T2", tone: T.green },
  hit_t1: { label: "Hit T1", tone: T.green },
  invalidated: { label: "Invalidated", tone: T.red },
  faded: { label: "Faded", tone: T.faint },
  active: { label: "Expired", tone: T.faint },
};

// CellGroup inside a Card: drop the group's own surface and bleed into the
// pad-md padding so separators run edge to edge (FoodPanel's idiom).
const inCardGroup = { boxShadow: "none", background: "transparent", borderRadius: 0, margin: "0 -16px -8px" };

/* Same anatomy as the Brief's FeedFallbackRow — the alt-scan function ships
   with the tab, so the only states left are "loading" and "it broke". */
function FallbackRow({ detail, onRetry }) {
  return (
    <div style={{ background: "var(--surface-2)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 13px", minHeight: 52 }}>
      <Dot tone={CARD_STATES.error.color} />
      <span className="t-foot" style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>{detail || "Feed unavailable."}</span>
      <Button kind="quiet" size="sm" style={{ height: 44, flex: "none" }} onClick={onRetry}>Retry</Button>
    </div>
  );
}

// Skeleton mirrors the page it becomes — score card, radar rows, movers with
// its pill strip — so nothing jumps when the payload lands.
function PanelSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <Card pad="md">
        <div className="sk sk-line w40" />
        <div className="sk sk-big" />
        <div className="sk sk-line w80" />
      </Card>
      <Card pad="md">
        <div className="sk sk-line w40" style={{ marginBottom: 14 }} />
        <div className="sk sk-line" />
        <div className="sk sk-line" />
        <div className="sk sk-line w60" />
      </Card>
      <Card pad="md">
        <div className="sk sk-line w40" style={{ marginBottom: 14 }} />
        <div className="sk-row" style={{ marginBottom: 12 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 30, borderRadius: 999 }} />)}
        </div>
        <div className="sk sk-line" />
        <div className="sk sk-line" />
        <div className="sk sk-line w80" />
      </Card>
    </div>
  );
}

export default function AltSeasonPanel({ isMobile }) {
  const q = useAltScan();
  const data = q.data;

  // Board and Record fold by default — the daily glance is score, radar,
  // movers; the deep lists are one tap away. User choices persist over that.
  const [collapsed, setCollapsed] = useState(() => {
    const defaults = { board: true, record: true };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("br_alt_collapsed") || "{}") }; }
    catch { return defaults; }
  });
  const [whyOpen, setWhyOpen] = useState(false);
  const [win, setWin] = useState("24h");
  // Which entry sections are open, and which have been asked to show their
  // whole tail. "Worth an entry now" opens itself; the other two are counts
  // until you want them.
  const [openSec, setOpenSec] = useState(() => {
    const defaults = { entry: true, watch: false, late: false };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("br_alt_sections") || "{}") }; }
    catch { return defaults; }
  });
  const [showAll, setShowAll] = useState({});
  const [sel, setSel] = useState(null);     // {id, symbol, name} → coin sheet
  const [chart, setChart] = useState(null); // {id, symbol} → candles modal

  // A slow tick so "prices 12s ago" doesn't sit frozen between the 60s polls.
  // 15s keeps the label honest without re-rendering the lists every second.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(iv);
  }, []);

  const coll = (cardId) => ({
    id: cardId,
    collapsed: !!collapsed[cardId],
    onToggle: () => setCollapsed((prev) => {
      const next = { ...prev, [cardId]: !prev[cardId] };
      try { localStorage.setItem("br_alt_collapsed", JSON.stringify(next)); } catch { /* storage full — collapse just won't persist */ }
      return next;
    }),
  });
  const toggleSec = (key) => setOpenSec((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    try { localStorage.setItem("br_alt_sections", JSON.stringify(next)); } catch { /* storage full — the section just won't remember */ }
    return next;
  });

  if (data == null) {
    if (!q.isError) return <PanelSkeleton />;
    return (
      <Card pad="md">
        <span className="t-head" style={{ display: "block", marginBottom: 9 }}>Alt Season</span>
        <FallbackRow detail={q.error?.message} onRetry={() => q.refetch()} />
      </Card>
    );
  }

  const season = data.season || null;
  const board = Array.isArray(data.board) ? data.board : [];
  const movers = data.movers || null;
  // Igniting first, then score — the server sorts this way too, but the order
  // is a promise the radar makes, so it's kept here rather than assumed. The
  // entry sections below preserve it inside each bucket, so the best setup in
  // "Worth an entry now" is still the top row.
  const active = [...(data.flags?.active || [])].sort((a, b) =>
    (a.tier === b.tier ? (b.score || 0) - (a.score || 0) : a.tier === "igniting" ? -1 : 1));
  const grouped = { entry: [], watch: [], late: [] };
  for (const f of active) grouped[stateOf(f)].push(f);
  const recent = data.flags?.recent || [];
  const stats = data.flags?.stats || null;
  const staleTag = data.stale ? { state: "live", stale: true, at: data.asOf } : null;

  const boardById = new Map(board.map((r) => [r.id, r]));
  const activeByCoin = new Map(active.map((f) => [f.coinId, f]));
  // Flag episodes carry coinId (their own id embeds the flag day); board and
  // mover rows carry the coingecko id directly.
  const openCoin = (c) => setSel({ id: c.coinId || c.id, symbol: c.symbol, name: c.name });
  // A mover outside the top-60 board has no screened row to show — the chart
  // is the only depth we honestly have for it, so skip the sheet.
  const openMover = (m) => (boardById.has(m.id) ? openCoin(m) : setChart({ id: m.id, symbol: m.symbol }));

  const list = movers ? movers[win] : null;
  const readyHours = movers?.readyIn?.[win] ?? null;

  const statsLine = (() => {
    if (!stats || stats.total < 3 || stats.hitT1Rate == null) return "The log needs a few resolved flags before rates mean anything.";
    let s = `${stats.total} flags · ${stats.hitT1Rate}% reached T1`;
    if (stats.medianPeakPct != null) s += ` · median peak ${signedPct(stats.medianPeakPct)}`;
    return s;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      {/* A refresh that failed while good data is on screen: keep the page,
          say so. First in the column — Retry must not hide below the fold. */}
      {q.isError && (
        <Card pad="sm">
          <FallbackRow detail={`Refresh failed — showing the last good scan (${q.error?.message || "unreachable"})`} onRetry={() => q.refetch()} />
        </Card>
      )}

      {/* ── SEASON — the one-number answer ─────────────────────────────────── */}
      <CollapsibleCard {...coll("season")} title="Alt Season"
        trailing={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {season?.label && <StancePill text={season.label} color={PHASE_TONE[season.phase] || T.sub} />}
            {staleTag && <StatusTag status={staleTag} />}
          </span>
        }
      >
        {season?.score != null ? (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5, minWidth: 0 }}>
                <span className="t-title1 t-num"><NumTween v={season.score} f={(n) => String(Math.round(n))} /></span>
                <span className="t-cap" style={{ color: "var(--faint)" }}>/100</span>
              </span>
              <Button kind="plain" size="sm" onClick={() => setWhyOpen((v) => !v)}
                style={{ height: 44, margin: "-8px -10px", padding: "0 10px", flex: "none" }}>
                {whyOpen ? "Hide" : "Why"}
              </Button>
            </div>
            {/* the read, then the evidence for it, then what it costs you —
                in that order, because the instruction is the part you came
                for and the breadth count is what backs it up */}
            {PHASE_READ[season.phase] && (
              <div className="t-foot" style={{ color: "var(--ink)", marginTop: 5, lineHeight: 1.5 }}>{PHASE_READ[season.phase]}</div>
            )}
            {season.facts?.[0] && (
              <div className="t-cap" style={{ color: "var(--faint)", marginTop: 4, lineHeight: 1.5 }}>{season.facts[0]}</div>
            )}
            {season.gate && (
              <div className="t-cap" style={{ color: "var(--faint)", marginTop: 2, lineHeight: 1.5 }}>
                In this tape the screener carries at most <span className="t-num">{season.gate.max}</span> flags,
                and only setups over <span className="t-num">{season.gate.floor}</span>/100.
              </div>
            )}
            {whyOpen && (
              <div style={{ marginTop: 8 }}>
                {(season.parts || []).map((p) => (
                  <div key={p.key} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, padding: "4px 0" }}>
                    <span className="t-foot" style={{ color: "var(--sub)", minWidth: 0, lineHeight: 1.45 }}>{p.label}</span>
                    <span className="t-cap t-num" style={{ color: p.points == null ? "var(--faint)" : "var(--ink)", flex: "none" }}>
                      {p.points == null ? "—" : p.points}/{p.max}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <EmptyState title="Not enough measured inputs yet"
            sub="The score publishes once the hourly screener has breadth to measure — unmeasured parts are dropped, never guessed."
            style={{ padding: "20px 16px" }} />
        )}
      </CollapsibleCard>

      {/* ── FLAGS — sorted by whether it is time, not by tier ──────────────── */}
      {/* THE CARD IS A SHORTLIST, NOT A LEDGER. The screener's regime gate
          caps how many episodes can be open at once, but a log written under
          the old flat bar can still hold dozens, and those age out over days
          rather than vanishing. The categories are what make fifty-two rows
          readable: the answer is the heading you find a coin under, and only
          the section that means "yes" opens itself. */}
      <CollapsibleCard {...coll("flags")} title="Flags"
        trailing={active.length > 0 ? (
          <span className="t-cap t-num" style={{ color: "var(--faint)" }}>
            <span style={{ color: grouped.entry.length ? T.green : "var(--faint)", fontWeight: 600 }}>{grouped.entry.length} to enter</span>
            {" · "}{active.length} tracked
          </span>
        ) : null}
      >
        {active.length ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {ENTRY_ORDER.map((state) => {
              const rows = grouped[state];
              if (!rows.length) return null;
              const meta = ENTRY_META[state];
              const open = !!openSec[state];
              const all = !!showAll[state];
              const shown = open ? (all ? rows : rows.slice(0, SECTION_PREVIEW)) : [];
              return (
                <div key={state}>
                  <button type="button" onClick={() => toggleSec(state)} aria-expanded={open}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 44,
                      background: "none", border: "none", padding: "6px 0", font: "inherit", color: "inherit",
                      textAlign: "left", cursor: "pointer",
                    }}>
                    <Dot tone={meta.tone} size={7} />
                    <span className="t-label" style={{ color: "var(--ink)", minWidth: 0 }}>{meta.head}</span>
                    <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{rows.length}</span>
                    <IcChevronDown size={12} style={{ marginLeft: "auto", flex: "none", color: "var(--faint)", transform: open ? "none" : "rotate(-90deg)", transition: "transform var(--dur-2) var(--ease-out)" }} />
                  </button>
                  {open && (
                    <>
                      {/* the rule, in the section — a category nobody can
                          state the test for is just a colour to memorise */}
                      <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, paddingBottom: 6 }}>{meta.rule}</div>
                      <CellGroup style={inCardGroup}>
                        {shown.map((f) => {
                          const tier = TIER_META[f.tier] || TIER_META.building;
                          const hit = HIT_LABEL[f.status];
                          const risk = f.entry && Number.isFinite(f.entry.riskPct) ? `${signedPct(f.entry.riskPct)} risk` : null;
                          return (
                            <Cell key={f.id}
                              onClick={() => openCoin(f)}
                              title={
                                <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
                                  <span className="t-label" style={{ color: "var(--ink)", letterSpacing: "0.04em" }}>{f.symbol}</span>
                                  {hit && <span className="t-cap t-num" style={{ color: T.green, fontWeight: 600 }}>{hit}</span>}
                                </span>
                              }
                              // Tier is the move's expected PACE, which is only
                              // information while the move can still happen —
                              // "Igniting" over a coin filed under Already ran
                              // is the same mixed signal this card exists to
                              // kill. Dropped there, kept everywhere else.
                              sub={[state === "late" ? null : tier.label, risk, fmtDay(f.firstFlaggedAt)].filter(Boolean).join(" · ")}
                              trailing={
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 12, flex: "none" }}>
                                  <RoomCell entry={f.entry} tone={meta.tone} />
                                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, minWidth: 62 }}>
                                    <span className="t-num" style={{ fontSize: 13.5, color: "var(--ink)" }}>{px(f.lastPrice)}</span>
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
          <EmptyState title="Nothing on the radar" sub="The screener runs hourly — flags land here the pass they fire." />
        )}
      </CollapsibleCard>

      {/* ── MOVERS — what's already going, by window ───────────────────────── */}
      <Card pad="md">
        <span className="t-head" style={{ display: "block", marginBottom: 3 }}>Movers</span>
        {/* Says what this list is FOR, because it is the one card here that is
            not a recommendation and reads exactly like one. */}
        <div className="t-cap" style={{ color: "var(--faint)", marginBottom: 6, lineHeight: 1.5 }}>
          Biggest gainers in the window — where the tape is hot, not a list of entries.
        </div>
        <PillRow options={MOVER_WINDOWS} value={win} onChange={setWin} style={{ margin: "0 -16px 2px" }} />
        {list == null ? (
          // 4h/12h come from our own hourly snapshots, not CoinGecko — a fresh
          // deploy has no baseline yet, and an honest wait beats a fake zero.
          <div className="t-foot" style={{ color: "var(--sub)", padding: "10px 2px 4px", lineHeight: 1.5 }}>
            Needs price history — {readyHours != null ? `ready in ~${Math.max(1, Math.ceil(readyHours))}h` : "the hourly snapshots are still building it"}.
          </div>
        ) : list.length === 0 ? (
          <div className="t-foot" style={{ color: "var(--sub)", padding: "10px 2px 4px" }}>
            Nothing eligible moved in this window.
          </div>
        ) : (
          <CellGroup style={inCardGroup}>
            {list.map((m, i) => (
              <Cell key={m.id}
                onClick={() => openMover(m)}
                leading={<span className="t-cap t-num" style={{ color: "var(--faint)" }}>{i + 1}</span>}
                title={m.symbol} titleStyle={{ fontSize: 14, fontWeight: 600 }}
                sub={m.name}
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

      {/* ── BOARD — the full ranking, folded ───────────────────────────────── */}
      <CollapsibleCard {...coll("board")} title="Board" tight>
        <div className="t-foot" style={{ color: "var(--sub)", marginBottom: 4, lineHeight: 1.5 }}>
          Every screened coin, ranked by how likely a move is starting — not by how much it already moved.
          A high score is a good <em>setup</em>, which is not the same as a good <em>entry</em>: the tag says which.
        </div>
        {board.length ? (
          <CellGroup style={inCardGroup}>
            {board.slice(0, 15).map((r) => {
              // The tag is the entry verdict, not the band — a 68/100 'late'
              // coin reads as a strong row until something says "chase".
              const em = ENTRY_META[stateOf(r)];
              return (
                <Cell key={r.id}
                  onClick={() => openCoin(r)}
                  title={r.symbol} titleStyle={{ fontSize: 14, fontWeight: 600 }}
                  sub={r.band ? `${r.name} · ${r.band}` : r.name}
                  trailing={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
                      <span className="t-num" style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{r.score}</span>
                      <TonePill tone={em.tone} style={{ minWidth: 52, justifyContent: "center", display: "inline-flex" }}>{em.label}</TonePill>
                      <Delta pct={r.chg24h} digits={1} />
                    </span>
                  }
                />
              );
            })}
          </CellGroup>
        ) : (
          <EmptyState title="No board yet" sub="The hourly screener hasn't completed a pass." />
        )}
      </CollapsibleCard>

      {/* ── RECORD — the graded log, base rates first ──────────────────────── */}
      <CollapsibleCard {...coll("record")} title="Record" tight>
        <div className="t-foot" style={{ color: "var(--sub)", marginBottom: recent.length ? 4 : 0, lineHeight: 1.5 }}>
          {statsLine}
        </div>
        {recent.length > 0 && (
          <CellGroup style={inCardGroup}>
            {recent.map((f) => {
              const o = OUTCOME[f.status] || OUTCOME.active;
              const fa = fmtDay(f.firstFlaggedAt), fb = fmtDay(f.resolvedAt);
              return (
                <Cell key={f.id}
                  title={<span className="t-label" style={{ color: "var(--ink)", letterSpacing: "0.04em" }}>{f.symbol}</span>}
                  sub={fa === fb ? fa : `${fa} → ${fb}`}
                  trailing={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
                      <TonePill tone={o.tone}>{o.label}</TonePill>
                      <Delta pct={f.peakPct} digits={1} />
                    </span>
                  }
                />
              );
            })}
          </CellGroup>
        )}
      </CollapsibleCard>

      {/* Freshness, split honestly: the screener pass and the price overlay
          age independently, so they're stamped independently. */}
      <div className="t-cap t-num" style={{ color: "var(--faint)", textAlign: "center", padding: "2px 0 6px" }}>
        screener {fmtTime(data.asOf)} · prices {data.liveAsOf ? rel(data.liveAsOf, now) : "stored"}
      </div>

      {sel && (
        <AltCoinSheet
          sel={sel}
          row={boardById.get(sel.id) || null}
          episode={activeByCoin.get(sel.id) || null}
          onClose={() => setSel(null)}
          onChart={() => setChart({ id: sel.id, symbol: sel.symbol })}
        />
      )}
      {chart && (
        <Suspense fallback={null}>
          <BtcChartModal isMobile={isMobile} onClose={() => setChart(null)} callFnFull={callFnFull}
            title={chart.symbol} fn="alt-candles" fnArgs={{ id: chart.id }} defaultInterval="1m" z={480}
            // Day-scale pills only: alt-candles is CoinGecko OHLC, which has no
            // intraday lookbacks — the modal's default minute pills would all
            // land on "Chart unavailable" here. "1m" is a MONTH in this row.
            intervals={[
              { key: "1d", label: "1D" }, { key: "1w", label: "1W" }, { key: "1m", label: "1M" },
              { key: "3m", label: "3M" }, { key: "6m", label: "6M" }, { key: "1y", label: "1Y" },
            ]} />
        </Suspense>
      )}
    </div>
  );
}
