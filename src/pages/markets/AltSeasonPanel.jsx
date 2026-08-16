// ─── Alt Season — the monitor ────────────────────────────────────────────────
// One column, checked one-handed on a phone, and read top-down as four
// questions that each narrow the next:
//
//   1. the cycle       where are we, and which way are we moving
//   2. capital ladder  which rung of the risk curve is being bid
//   3. the book        what I hold, and what my next action is
//   4. narratives      which theme is bidding — and the only route to a ticker
//   5. flags · board · record   the specific setups, then the evidence
//
// THE INVARIANT: no ticker appears on this tab without the layer above it on
// screen. A coin row is always inside a cohort; a cohort is always inside a
// regime. That is what stops this drifting back into five lists of coins, and
// it is checkable in review in a way "make it less overwhelming" is not.
//
// The hourly cron did every piece of math on this page — the panel only formats
// and never re-derives, so the number here and the number the flag log was
// graded by are the same number.
//
// The 60s poll (useAltScan) overlays live prices server-side; `stale` fires
// when EITHER half aged out — the screener pass is >2h old, or the live quote
// fetch failed and the prices shown are the stored pass's (alt-scan sets it
// for both). The footer's two stamps say which half is old.
import { lazy, Suspense, useEffect, useState } from "react";
import { T } from "../../theme.js";
import { calendarDaysBetween } from "../../lib/dates.js";
import { Card, CollapsibleCard, CellGroup, Cell, Button, EmptyState, Dot, Delta } from "../../ui/kit.jsx";
import { IcChevronDown } from "../../ui/icons.jsx";
import { StatusTag, CARD_STATES } from "../../ui/shared.jsx";
import { callFnFull } from "../../lib/functions.js";
import { useAltScan, useAltPositions } from "../../data/altseason.js";
import AltCoinSheet, { TonePill, HIT_LABEL, STAGE_LABEL, MOTION_LABEL } from "./AltCoinSheet.jsx";
import RecordCard from "./RecordCard.jsx";
import { CycleDial, CapitalLadder, Narratives, CohortDrilldown, EXCESS_TONE } from "./AltLayers.jsx";
import AltBookCard from "./AltBookCard.jsx";

// Lazy — lightweight-charts stays in its own chunk until a chart is opened.
const BtcChartModal = lazy(() => import("../../BtcChartModal.jsx"));

/* ── tiny formatters — client-side duplicates of the server's (server math is
      never duplicated; formatting is fine to) ────────────────────────────── */
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

// Rows an open section shows before it asks. Ten is about a phone screen and a
// half; past that a section is a database dump, not a list.
const SECTION_PREVIEW = 10;

/* ── WHERE THE MOVERS CARD WENT, because deleting a working card deserves a
      reason in the file rather than in a commit message.

   It was six windows × twelve coins — seventy-two coin slots with no
   relationship between any of them, and it was the single largest contributor
   to the overload this tab was rebuilt to remove. The appetite it served
   ("what is actually moving") is real, so it was not dropped: it moved one
   layer up, into Narratives → the cohort drill-down, where the same question is
   answered WITH the context that makes an answer interpretable — whether the
   name's whole group is moving too.

   Nothing became unreachable. The Board card still holds every screened row,
   and the cohort list ranks by 7d, which is the window the cohort median is
   measured over and therefore the only window an excess can be read against.
   The 4h/12h baselines the old card depended on are still computed and still
   published; they simply no longer have a card of their own. */

// What the regime means for what you do, in one sentence — the read, not the
// number, because "39/100, Bitcoin only" left the entire "so what" to the
// reader every single time. These are now the LARGEST text on the dial rather
// than the smallest on a strip, which is where they always belonged; the ~50
// character ceiling stays, because two lines here pushes the ladder below the
// fold on a phone and the fold is the whole design target.
const PHASE_READ = {
  alt_season: "Alts are getting paid — setups here work more often than not.",
  majors_rotating: "Money's moving, majors first — alt setups are early.",
  mixed: "No rotation either way — only the cleanest setups pay.",
  btc_only: "Bitcoin is taking the flow — be picky, and be small.",
  risk_off: "Nothing is bid — the best trade here is usually no trade.",
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
    rule: "First target still ahead, stop close, and the move pays 1.5×+ what being wrong costs.",
  },
  watch: {
    label: "Watch", tone: T.amber, head: "Getting ready", open: false,
    rule: "Real structure, nothing lifting it yet — or too thin a payoff from here.",
  },
  late: {
    label: "Late", tone: T.faint, head: "Already ran", open: false,
    rule: "Past its first target, parabolic, or too thin to exit.",
  },
};
const ENTRY_ORDER = ["entry", "watch", "late"];
// An episode from a payload written before the entry read shipped has no
// verdict on it. It is not an entry until something says it is.
const stateOf = (x) => (x && x.entry && ENTRY_META[x.entry.state] ? x.entry.state : "watch");

/* ── the stage vocabulary — where the move actually is ────────────────────────
   alt-scan's moveRead names the stage; these name it in English. The words are
   the whole answer to "where's each one at", so they say something a reader
   already knows the meaning of: no ladder names (T1/T2/T3 are internal
   vocabulary, defensible in the sheet where a price table teaches them, tokens
   to decode on a list), no band names, no jargon.

   The clause after the middot is chosen BY the stage rather than stacked on
   top of it: below the level the question is how close to firing, above it the
   question is whether it is still accelerating, and on the terminal reads
   there is no question left. Same slot, one fact, never two. */
const STAGE_CLAUSE = { base: "level", atLevel: "level", breaking: "motion", extending: "motion" };

/** "In its base · 8.1% under" — the stage, and the one thing worth adding. */
function stageLine(move, short) {
  const stage = (move && STAGE_LABEL[move.stage]) ? move.stage : null;
  if (!stage) return null;
  const head = STAGE_LABEL[stage];
  // Movers rows carry a sparkline, so there is no room for a clause and it
  // would clip mid-word under .cell-sub's overflow rather than shorten.
  if (short) return head;
  const which = STAGE_CLAUSE[stage];
  if (which === "level" && Number.isFinite(move.toLevelPct)) {
    const v = move.toLevelPct;
    return `${head} · ${Math.abs(v).toFixed(1)}% ${v < 0 ? "under" : "over"}`;
  }
  // An ABSENT pace clause means not measured. "holding" means measured and
  // flat. Collapsing those into one word is the thing this codebase refuses to
  // do anywhere — season parts label themselves "not scored", the movers card
  // says "ready in ~Nh" rather than rank a fake zero.
  if (which === "motion" && move.motion) return `${head} · ${MOTION_LABEL[move.motion]}`;
  return head;
}

/* The one number on the row, and WHICH number it is depends on what the row
   is doing. A "+22% room" on a coin whose stop is already gone is not a
   smaller truth than "stop gone", it is a false one. */
function numberSlot(move, entry, tone) {
  const stage = move && move.stage;
  if (stage === "broken") return { text: "stop gone", tone: T.red, caption: null };
  if (stage === "spent") return { text: "done", tone: "var(--faint)", caption: "past T3" };
  // Off its own high by enough to matter — the give-back is the story on a
  // flag that ran and came back, and it outranks room it may never see again.
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
      {/* No label under an em-dash — "— left" reads as a measurement of
          nothing rather than the absence of one. */}
      {slot.caption && <span className="t-cap" style={{ color: "var(--faint)", fontSize: 10.5 }}>{slot.caption}</span>}
    </span>
  );
}

/** How old the flag is, as a word. A malformed stamp renders nothing at all. */
function ageWord(iso) {
  // CALENDAR days, not elapsed 24-hour blocks — see calendarDaysBetween. A flag
  // fired after Thursday's close read "today" all Friday morning.
  const d = calendarDaysBetween(iso);
  if (d == null) return null;
  return d <= 0 ? "today" : `${d}d`;
}

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

// Skeleton mirrors the page it becomes — the dial, the ladder's rungs, then the
// narrative tiles — so nothing jumps when the payload lands.
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
  // Separate query, separate clock — positions change when you change them, not
  // every sixty seconds. See the note over useAltPositions for why they are
  // joined at render instead of server-side.
  const positionsQ = useAltPositions();

  // The board folds by default — it is 60 rows of evidence, one tap away. The
  // RECORD does not, any more: it used to be a grey sentence and a list of
  // tickers, worth hiding; now it is the answer to "should I believe any of
  // this", which is not a question to make someone go looking for. A stored
  // choice still wins over both.
  const [collapsed, setCollapsed] = useState(() => {
    const defaults = { board: true, record: false };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("br_alt_collapsed") || "{}") }; }
    catch { return defaults; }
  });
  const [whyOpen, setWhyOpen] = useState(false);
  // Which narrative is drilled into — the only route from this tab to a ticker.
  // Not persisted: a cohort selection is a question you are asking right now,
  // and restoring last week's filter on open would hide the board behind a
  // choice nobody remembers making.
  const [cohortId, setCohortId] = useState(null);
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

  // ── the three layers above the coin ──
  const ladder = data.ladder || null;
  const cohorts = Array.isArray(data.cohorts) ? data.cohorts : [];
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));
  const selectedCohort = cohortId ? cohortById.get(cohortId) || null : null;
  // A cohort's members ON THE BOARD. The board is the top 60 by setup, so a
  // cohort can be bid and still have nothing here — CohortDrilldown says so
  // rather than rendering an empty list that reads as an error.
  const cohortRows = selectedCohort ? board.filter((r) => r.cohort && r.cohort.id === selectedCohort.id) : [];

  // Live price for a position: the board first (it carries the overlaid price),
  // then any mover row, then nothing. Matching on coin_id and falling back to
  // symbol is what lets a position added from memory — where coin_id is a guess
  // off the symbol — still find its price.
  const bySymbol = new Map(board.map((r) => [String(r.symbol || "").toUpperCase(), r]));
  const priceOf = (p) => {
    const row = boardById.get(p.coin_id) || bySymbol.get(String(p.symbol || "").toUpperCase());
    return row && Number.isFinite(row.price) ? row.price : null;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      {/* A refresh that failed while good data is on screen: keep the page,
          say so. First in the column — Retry must not hide below the fold. */}
      {q.isError && (
        <Card pad="sm">
          <FallbackRow detail={`Refresh failed — showing the last good scan (${q.error?.message || "unreachable"})`} onRetry={() => q.refetch()} />
        </Card>
      )}

      {/* ── LAYER 1 · WHERE ARE WE ────────────────────────────────────────
          The regime was a two-line strip: correct as a piece of information
          design when the regime was context for a page of coin lists, and
          wrong once the regime became the thing the page is organised around.
          `39/100 · Bitcoin only` asks the reader to hold a five-rung ladder in
          their head; the same number on the accumulate/rotate/distribute arc
          reads in one glance. The PHASE_READ sentences did not change — they
          went from being the smallest text on screen to the largest, which was
          always where they belonged. */}
      <CycleDial
        season={season}
        drift={data.scoreDrift || null}
        read={season?.score != null ? (PHASE_READ[season.phase] || "") : null}
        trailing={
          <>
            {staleTag && <StatusTag status={staleTag} />}
            {season?.score != null && (
              <Button kind="plain" size="sm" onClick={() => setWhyOpen((v) => !v)}
                style={{ height: 44, margin: "-11px -10px", padding: "0 10px", color: "var(--sub)", fontWeight: 500 }}>
                {whyOpen ? "Hide" : "Why"}
              </Button>
            )}
          </>
        }>
        {whyOpen && season && (
          <div style={{ paddingTop: 2 }}>
            {season.facts?.[0] && (
              <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.5, paddingBottom: 2 }}>{season.facts[0]}</div>
            )}
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
      </CycleDial>

      {/* ── LAYER 2 · WHAT'S ROTATING ─────────────────────────────────────
          The only surface here that can see ahead: when the lit rung is Large,
          the next rung to light is Mid, because that is the order flow travels
          rather than a prediction about any chart. */}
      <CapitalLadder ladder={ladder} />

      {/* ── LAYER 5 · WHAT DO I DO ABOUT IT ───────────────────────────────
          Third, not last, and the placement is the argument: above the board
          because your own next action outranks the screener's next idea. It
          because your own next action outranks the screener's next idea.

          Rendered even when empty, which is a deliberate trade: a permanently
          empty card is a real cost, and it is smaller than the cost of the Add
          affordance living somewhere you have to go looking for. The book is
          the half of the plan that decides the number, and a tab that hides it
          until it is already in use can never be the thing that gets it
          started. */}
      <AltBookCard
        positions={positionsQ.data}
        priceOf={priceOf}
        season={season}
        fearGreed={season?.fearGreed}
        domTrend={season?.domTrend}
        domSpanDays={data.season?.domSpanDays ?? null}
        error={positionsQ.error}
      />


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
        {/* The gate sentence lives here, not on the regime strip, because
            season.gate literally governs THIS list. One line, not four. */}
        {season?.gate && (
          <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, paddingBottom: 4 }}>
            <span className="t-num">{season.gate.floor}</span>/100 to flag in this tape,
            {" "}<span className="t-num">{season.gate.max}</span> open at a time.
          </div>
        )}
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
                      background: "none", border: "none", padding: "4px 0", font: "inherit", color: "inherit",
                      textAlign: "left", cursor: "pointer",
                    }}>
                    <Dot tone={meta.tone} size={7} />
                    <span className="t-label" style={{ color: "var(--ink)", minWidth: 0 }}>{meta.head}</span>
                    <span className="t-cap t-num" style={{
                      color: "var(--sub)", background: "var(--surface-2)", borderRadius: 999,
                      padding: "1px 7px", flex: "none", lineHeight: 1.6,
                    }}>{rows.length}</span>
                    <IcChevronDown size={12} style={{ marginLeft: "auto", flex: "none", color: "var(--faint)", transform: open ? "none" : "rotate(-90deg)", transition: "transform var(--dur-2) var(--ease-out)" }} />
                  </button>
                  {open && (
                    <>
                      {/* the rule, in the section — a category nobody can
                          state the test for is just a colour to memorise */}
                      <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45, padding: "0 0 7px" }}>{meta.rule}</div>
                      <CellGroup style={inCardGroup}>
                        {/* THE ROW SAYS WHERE THE MOVE IS, THE SECTION SAYS
                            WHETHER TO ACT. Six slots, two numbers, one
                            non-ink colour — and it is a net REDUCTION: the
                            row gave up its price, its tier word, its risk %
                            and its flag date to buy one sentence that
                            actually answers the question. Price is one tap
                            away and it is what freed the width the sentence
                            needs to be legible at 390pt. */}
                        {shown.map((f) => {
                          const age = ageWord(f.firstFlaggedAt);
                          const hit = HIT_LABEL[f.status];
                          // One mark, by priority. `thin` outranks a target
                          // hit because flags.thinLiquidity is the first thing
                          // entryRead checks and the LAST thing bandOf does —
                          // without this a breaking-out coin nobody can exit
                          // renders with no warning at all.
                          const mark = f.move?.thin
                            ? { text: "can't exit", tone: T.red }
                            : hit ? { text: hit, tone: T.green } : null;
                          return (
                            <Cell key={f.id}
                              onClick={() => openCoin(f)}
                              title={
                                <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
                                  <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.04em", color: "var(--ink)" }}>{f.symbol}</span>
                                  {age && <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{age}</span>}
                                  {mark && <span className="t-cap t-num" style={{ color: mark.tone, fontWeight: 600 }}>{mark.text}</span>}
                                  {/* IS THE MOVE SHARED — the one number that
                                      separates rotation from a listing or an
                                      unlock, and the answer to "there are so
                                      many random reasons a coin moves". Only
                                      the two states worth acting on get ink:
                                      'alone' is a warning the row cannot
                                      otherwise carry, and 'lagging' marks the
                                      entry that looks like nothing is
                                      happening. 'leading', 'with' and
                                      'sinking' are already legible from the
                                      move itself and would just be noise
                                      repeated in a second colour. */}
                                  {f.cohort && (f.cohort.state === "alone" || f.cohort.state === "lagging") && (
                                    <span className="t-cap t-num" style={{ color: EXCESS_TONE[f.cohort.state], fontWeight: 600 }}>
                                      {f.cohort.state === "alone" ? "alone" : "laggard"}
                                    </span>
                                  )}
                                </span>
                              }
                              sub={stageLine(f.move) || "—"}
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
          <EmptyState title="Nothing on the radar" sub="The screener runs hourly — flags land here the pass they fire." />
        )}
      </CollapsibleCard>

      {/* ── LAYER 3 · WHICH NARRATIVE ─────────────────────────────────────
          The answer to "there are too many coins to keep track of": twelve
          cohorts, not fourteen hundred names, and the names inside one move
          together before any individual chart looks interesting. Tapping a
          tile is the only route from this tab to a ticker. */}
      <Narratives
        cohorts={cohorts}
        read={data.cohortRead?.read || null}
        selected={cohortId}
        onSelect={setCohortId}
      />

      {/* ── LAYER 4 · WHICH COIN, AND IS THE MOVE REAL ────────────────────
          Only rendered with a cohort selected, which is the invariant made
          structural rather than remembered: there is no code path that puts a
          ticker on this card without its group's number in the header. */}
      <CohortDrilldown cohort={selectedCohort} rows={cohortRows} onOpen={openCoin} />

      {/* ── BOARD — the full ranking, folded ───────────────────────────────── */}
      <CollapsibleCard {...coll("board")} title="Board" tight>
        <div className="t-foot" style={{ color: "var(--sub)", marginBottom: 4, lineHeight: 1.5 }}>
          Ranked by how likely a move is starting, not by how much it already moved —
          a good <em>setup</em> is not a good <em>entry</em>, and the tag says which.
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
                  // The stage, not the name and the band. `|| r.name` is the
                  // fallback for a payload written before moveRead shipped;
                  // name and band both live in the sheet, which already
                  // titles itself "SEI · Sei" and renders band as a pill.
                  sub={stageLine(r.move) || r.name}
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

      {/* ── RECORD — the graded log, base rates first ────────────────────────
          Shared with the Stocks tab so the two screeners cannot grade
          themselves by different arithmetic. */}
      <RecordCard stats={stats} recent={recent} collapseProps={coll("record")} noun="flags" />

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
