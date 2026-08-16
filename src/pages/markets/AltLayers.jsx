// ─── The three layers that sit above the individual coin ────────────────────
//
// The tab used to have five surfaces and four of them were lists of coins.
// Every interpretive idea in AltSeasonPanel — the phase sentences, the entry
// sections, the stage clauses — operated per-coin, so there was nothing on
// screen that answered a question ABOVE a ticker. That is what produced both of
// the complaints this file exists to fix: too many coins to track, and no way
// to tell a real move from a random one.
//
// So: three cards, each answering exactly one question, each narrowing the next.
//
//   CycleDial      where are we, and which way are we moving
//   CapitalLadder  which rung of the risk curve is being bid
//   Narratives     which theme is bidding — and the only route to a ticker
//
// THE INVARIANT THE WHOLE DESIGN RESTS ON: no ticker appears on this tab
// without the layer above it on screen. A coin row is always inside a cohort,
// and a cohort is always inside a regime. It is a rule that can actually be
// checked in review, unlike "make it less overwhelming".
//
// All three are presentational and take their numbers as props — the cron
// computes every one of them (capitalLadder, scoreDriftOf, cohortRead in
// alt-cron-background.js), and nothing here re-derives a number the engine
// already published. Same contract the rest of the panel follows.
import { T } from "../../theme.js";
import { Card, CellGroup, Cell, Dot, Delta } from "../../ui/kit.jsx";
import { NumTween } from "../../ui/primitives.jsx";

/* ── layer 1 · the cycle ─────────────────────────────────────────────────────
   A 0–100 score requires the reader to hold a five-rung ladder in their head
   before it means anything, and nobody does that at a glance. The same number
   placed on the three-phase arc is legible immediately, because the arc IS the
   story: accumulate, rotate, distribute.

   THE SEGMENTS ARE THE SCORE BANDS, not equal thirds. Equal thirds read more
   cleanly and would put the marker in the wrong place — a 39 would sit at the
   end of a segment that actually runs to 40 — so the widths carry the ladder
   and the marker is simply the score. The picture cannot disagree with the
   number because the picture is drawn from the number. */
const CYCLE = [
  { key: "accumulate", label: "Accumulate", to: 40, phases: ["risk_off", "btc_only"] },
  { key: "rotate", label: "Rotate", to: 70, phases: ["mixed", "majors_rotating"] },
  { key: "distribute", label: "Distribute", to: 100, phases: ["alt_season"] },
];

export function cycleOf(phase) {
  return CYCLE.find((c) => c.phases.includes(phase)) || null;
}

/** "Up 6 pts in 30 days" — or an honest count of how far off the read is. */
function driftLine(drift) {
  if (!drift) return null;
  if (!drift.direction) {
    const n = drift.samples ?? 0;
    return { tone: "var(--faint)", arrow: null, text: `Measuring which way — ${n} of 5 daily samples stored` };
  }
  const span = drift.spanDays;
  // THE SPAN IS MEASURED, NOT ASSUMED — the same correction domTrendOf carries.
  // Five samples can sit inside four days after a cron gap, and a 6-point drift
  // is a signal over a month and noise over four days.
  const over = span == null ? "" : span >= 1 ? ` in ${span} day${span === 1 ? "" : "s"}` : " today";
  if (drift.direction === "flat") {
    return { tone: "var(--faint)", arrow: "→", text: `Holding — ${drift.changePts >= 0 ? "+" : ""}${drift.changePts} pts${over}` };
  }
  const up = drift.direction === "rising";
  return {
    tone: up ? T.green : T.red,
    arrow: up ? "↗" : "↘",
    text: `${up ? "Up" : "Down"} ${Math.abs(drift.changePts)} pts${over}${up ? "" : " — still breaking"}`,
  };
}

export function CycleDial({ season, drift, read, trailing, children }) {
  const score = season && season.score != null ? season.score : null;
  const here = cycleOf(season && season.phase);
  const line = driftLine(drift);
  // Clamped so a score of 0 or 100 keeps its marker inside the track rather
  // than half off the edge of the card.
  const markLeft = score == null ? null : Math.max(4, Math.min(96, score));

  return (
    <Card pad="md">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-label">The cycle</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
          {score != null && (
            <span className="t-num" style={{ fontSize: 12, color: "var(--faint)" }}>
              <NumTween v={score} f={(n) => String(Math.round(n))} /><span style={{ opacity: 0.55 }}>/100</span>
            </span>
          )}
          {trailing}
        </span>
      </div>

      {score == null ? (
        <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.5, paddingTop: 4 }}>
          The regime publishes once the screener has breadth to measure — unmeasured parts are dropped, never guessed.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 2, height: 34, borderRadius: 9, overflow: "hidden", marginTop: 2 }}>
            {CYCLE.map((c) => {
              const on = here && here.key === c.key;
              const prev = CYCLE[CYCLE.indexOf(c) - 1];
              return (
                <div key={c.key} style={{
                  flex: c.to - (prev ? prev.to : 0),
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: on ? "color-mix(in srgb, var(--accent) 16%, var(--surface-2))" : "var(--surface-2)",
                  color: on ? "var(--accent)" : "var(--faint)",
                  fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase",
                  minWidth: 0, overflow: "hidden", whiteSpace: "nowrap",
                }}>{c.label}</div>
              );
            })}
          </div>
          <div style={{ position: "relative", height: 14, marginTop: -2 }}>
            <span style={{
              position: "absolute", left: `${markLeft}%`, top: 0, transform: "translateX(-50%)",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            }}>
              <span style={{ width: 2, height: 7, background: "var(--accent)", borderRadius: 1 }} />
              <span className="t-cap t-num" style={{ color: "var(--accent)", fontWeight: 600, whiteSpace: "nowrap" }}>you are here</span>
            </span>
          </div>
          {/* The instruction, as the largest text on the card. These sentences
              already existed — they were just the smallest thing on screen. */}
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4, letterSpacing: "-0.01em", paddingTop: 4 }}>
            {read}
          </div>
          {line && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {line.arrow && <span style={{ color: line.tone, fontWeight: 700, fontSize: 12, flex: "none" }}>{line.arrow}</span>}
              <span className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.45 }}>{line.text}</span>
            </div>
          )}
        </>
      )}
      {/* The score's own breakdown, one tap behind Why — unchanged in content,
          it just hangs off the dial now instead of off a strip. */}
      {children}
    </Card>
  );
}

/* ── layer 2 · the capital ladder ────────────────────────────────────────────
   Rotation drawn as a shape rather than stated as a percentage. Bars run out
   from a centre line so negative rungs read as negative without needing their
   sign parsed, and the lit rung is the one the accent is spent on — the house
   rule allows exactly one accent per screen area, and this is where it buys
   something: the whole card is one question, and the gold answers it. */
export function CapitalLadder({ ladder }) {
  if (!ladder || !Array.isArray(ladder.rungs) || !ladder.rungs.length) return null;
  const rungs = ladder.rungs;
  // One scale across every rung, so bar lengths are comparable down the card.
  // Floored at 5 so a dead-flat market doesn't render six full-width bars off a
  // 0.4% spread.
  const scale = Math.max(5, ...rungs.map((r) => Math.abs(r.chg30d ?? 0)));

  return (
    <Card pad="md">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-label">Capital ladder</span>
        <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>30d median</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, paddingTop: 2 }}>
        {rungs.map((r) => {
          const lit = ladder.leadKey === r.key && (r.chg30d ?? 0) > 0;
          const v = r.chg30d;
          const pctW = v == null ? 0 : Math.min(50, (Math.abs(v) / scale) * 50);
          return (
            <div key={r.key} style={{ display: "grid", gridTemplateColumns: "62px 1fr 54px", alignItems: "center", gap: 10 }}>
              <span className="t-cap" style={{ color: lit ? "var(--ink)" : "var(--sub)", fontWeight: 600 }}>{r.label}</span>
              <span style={{ position: "relative", height: 20, background: "var(--surface-2)", borderRadius: 5, overflow: "hidden" }}>
                <span style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--line-strong)" }} />
                {v != null && v !== 0 && (
                  <span style={{
                    position: "absolute", top: 0, bottom: 0, borderRadius: 5, width: `${pctW}%`,
                    ...(v > 0 ? { left: "50%" } : { right: "50%" }),
                    background: lit ? "var(--accent)"
                      : v > 0 ? "color-mix(in srgb, var(--green) 55%, transparent)"
                        : "color-mix(in srgb, var(--red) 45%, transparent)",
                  }} />
                )}
              </span>
              {/* An unmeasured rung says so. A bucket too thin for a median is
                  not a bucket that returned zero — the distinction this whole
                  codebase refuses to collapse anywhere else. */}
              <span className="t-cap t-num" style={{ textAlign: "right", color: v == null ? "var(--faint)" : v >= 0 ? T.green : T.red, fontWeight: 600 }}>
                {v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
              </span>
            </div>
          );
        })}
      </div>
      {ladder.read && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 7, paddingTop: 2 }}>
          <span style={{ paddingTop: 5, flex: "none" }}><Dot tone={ladder.leadKey ? T.accent : "var(--faint)"} size={6} /></span>
          <span className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.45 }}>{ladder.read}</span>
        </div>
      )}
    </Card>
  );
}

/* ── layer 3 · narratives ────────────────────────────────────────────────────
   Twelve cohorts instead of fourteen hundred coins, and the breadth line under
   each is what stops a tile lying: "9 of 11 lifting" is a bid; "1 of 26" beside
   a green headline is one coin dragging a median, which is the most common way
   a sector screen misleads.

   Tapping a tile is the ONLY route to a ticker on this tab — see the invariant
   in this file's header. The selected cohort filters the list below it, so a
   coin is never on screen without the cohort context that explains it. */
export function Narratives({ cohorts, read, selected, onSelect }) {
  const rows = Array.isArray(cohorts) ? cohorts : [];
  if (!rows.length) {
    return (
      <Card pad="md">
        <span className="t-label">Narratives</span>
        <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.5, paddingTop: 4 }}>
          The screener reads category cohorts hourly — they land here on the next pass.
        </div>
      </Card>
    );
  }
  return (
    <Card pad="md">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-label">Narratives</span>
        <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{rows.length} tracked</span>
      </div>
      {read && <div className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.45, paddingBottom: 2 }}>{read}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {rows.map((c) => {
          const on = selected === c.id;
          const v = c.chg30d ?? c.chg7d;
          // "Bid" is the tile's own tone rule and it is about the COHORT, not
          // about the leader: a green tile means this group is being bought,
          // which is the only thing the tile is claiming.
          const bid = (v ?? 0) > 0;
          return (
            <button key={c.id} type="button" onClick={() => onSelect(on ? null : c.id)} aria-pressed={on}
              style={{
                background: on ? "color-mix(in srgb, var(--accent) 12%, var(--surface-2))" : "var(--surface-2)",
                border: "none", borderRadius: 11, padding: "11px 12px", textAlign: "left",
                display: "flex", flexDirection: "column", gap: 4, minWidth: 0, cursor: "pointer",
                font: "inherit", color: "inherit",
                boxShadow: on ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 34%, transparent)" : "none",
              }}>
              <span className="t-cap" style={{
                fontWeight: 600, color: "var(--ink)", minWidth: 0,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{c.label}</span>
              <span className="t-num" style={{ fontSize: 16, fontWeight: 600, color: v == null ? "var(--faint)" : bid ? T.green : T.red }}>
                {v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
              </span>
              <span className="t-cap" style={{ color: "var(--faint)", fontSize: 10.5 }}>
                {c.lifting} of {c.n} lifting
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/* ── layer 4 · the cohort drill-down ─────────────────────────────────────────
   What replaced Movers, and the replacement is the point rather than a
   consolation. Movers was six windows of twelve coins — seventy-two slots with
   no relationship between any of them, which is the overload this redesign
   exists to remove. The same appetite ("what's actually moving") is served here
   with the one piece of context that makes a mover interpretable: whether its
   whole group is moving too.

   Ranked by 7d, because that is the window the cohort median is measured over
   and the excess beside each row is only meaningful against the same window. */
export const EXCESS_TONE = {
  leading: T.green,
  lagging: T.blue,
  alone: T.amber,
  with: "var(--faint)",
  quiet: "var(--faint)",
  unknown: "var(--faint)",
};

export function CohortDrilldown({ cohort, rows, onOpen }) {
  if (!cohort) return null;
  const list = [...rows].sort((a, b) => (b.chg7d ?? -Infinity) - (a.chg7d ?? -Infinity));
  return (
    <Card pad="md">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="t-label">{cohort.label}</span>
        <span className="t-cap t-num" style={{ color: "var(--sub)", flex: "none" }}>
          cohort {cohort.chg7d == null ? "—" : `${cohort.chg7d >= 0 ? "+" : ""}${cohort.chg7d.toFixed(1)}%`} · 7d
        </span>
      </div>
      {list.length === 0 ? (
        <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.5, paddingTop: 2 }}>
          None of this cohort's names are on the screened board right now — the board holds the
          top 60 by setup, and nothing from here made it.
        </div>
      ) : (
        <CellGroup style={{ boxShadow: "none", background: "transparent", borderRadius: 0, margin: "0 -16px -8px" }}>
          {list.map((r) => {
            const ex = r.cohort || null;
            return (
              <Cell key={r.id}
                onClick={() => onOpen(r)}
                title={r.symbol} titleStyle={{ fontSize: 14, fontWeight: 600 }}
                sub={ex ? ex.read : "No cohort read"}
                trailing={
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
                    {ex && ex.excessPp != null && (
                      <span className="t-cap t-num" style={{
                        color: EXCESS_TONE[ex.state] || "var(--faint)", fontWeight: 600,
                        background: "var(--surface-2)", borderRadius: 999, padding: "2px 7px", lineHeight: 1.5,
                      }}>
                        {ex.excessPp >= 0 ? "+" : ""}{ex.excessPp} vs grp
                      </span>
                    )}
                    <Delta pct={r.chg7d} digits={1} />
                  </span>
                }
              />
            );
          })}
        </CellGroup>
      )}
    </Card>
  );
}
