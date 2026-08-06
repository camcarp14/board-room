// ─── Record — the screener's own track record ────────────────────────────────
//
// A screener that never grades itself is a horoscope. This card is the only
// thing on either tab that answers "should I believe any of this", and it was
// one grey sentence and a list of tickers — which is a log, not a review.
//
// FOUR THINGS, IN THE ORDER YOU'D ASK THEM:
//
//   1. Does it work?      The hit rate, big, with the sample size beside it —
//                         because 60% of five flags is not 60%.
//   2. How does it fail?  A stacked bar of every outcome. A hit rate alone
//                         cannot tell you whether the misses drift to nothing
//                         or lose money, and those are different tools.
//   3. What do I get?     Median peak and median hold, so the number has a
//                         time attached. "+8% eventually" is not a plan.
//   4. Lately?            A form strip of the last dozen results. A base rate
//                         over a year hides a month of everything failing,
//                         and that month is exactly when you'd want to know.
//
// EVERY NUMBER IS THE SERVER'S. The client only ever holds the last 25 closed
// episodes, so anything counted here would silently be "the last 25" wearing
// the label "all time" — which is the single most misleading thing a
// performance card can do. If a rate is not in `stats`, it does not render.
//
// Shared by AltSeasonPanel and StocksPanel deliberately: the two tabs must not
// grade themselves by different arithmetic, and the only way to guarantee that
// is one component.
import { CollapsibleCard, CellGroup, Cell, EmptyState, Delta } from "../../ui/kit.jsx";
import { T } from "../../theme.js";

// Outcome vocabulary, ordered best → worst. The order IS the bar: a reader
// should be able to see the good end grow without reading a single label.
export const OUTCOME = {
  hit_t3: { label: "Hit T3", short: "T3", tone: T.green },
  hit_t2: { label: "Hit T2", short: "T2", tone: T.green },
  hit_t1: { label: "Hit T1", short: "T1", tone: T.green },
  faded: { label: "Faded", short: "—", tone: T.faint },
  active: { label: "Expired", short: "—", tone: T.faint },
  invalidated: { label: "Stopped", short: "✗", tone: T.red },
};

const signedPct = (n, d = 1) => (n == null || !isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);
const fmtDay = (iso) => { const d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };

/** One statistic, as a tile. Absent is an em-dash, never a zero. */
function Stat({ value, label, tone }) {
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div className="t-num" style={{ fontSize: 15, fontWeight: 600, color: tone || "var(--ink)", lineHeight: 1.2 }}>{value}</div>
      <div className="t-cap" style={{ color: "var(--faint)", fontSize: 10.5, marginTop: 1 }}>{label}</div>
    </div>
  );
}

/**
 * Every outcome as one bar, widths proportional to counts.
 *
 * The three green tiers are drawn separately rather than summed, because "46%
 * reached T1" and "4% reached T3" are the difference between a screener that
 * finds moves and one that finds twitches — and a single green block hides it.
 * Segments under ~3% of the bar still render at 3% so a rare outcome does not
 * vanish into a hairline; the counts underneath carry the exact truth.
 */
function OutcomeBar({ stats }) {
  // Faded and expired are both grey and both mean "drifted to nothing", but
  // they are different closes and get their own counts — merging them under
  // one label would report a number the log does not contain.
  //
  // Each part carries its own opacity rather than the bar deriving one from
  // the key, because the swatch in the legend has to be drawn the same way. A
  // legend whose swatch does not match its segment is worse than no legend: it
  // invites the reader to map the wrong colour onto the wrong number, and the
  // two greys and three greens are exactly where that goes wrong.
  const parts = [
    { key: "hit_t3", n: stats.hitT3 || 0, dim: 1 },
    { key: "hit_t2", n: (stats.hitT2 || 0) - (stats.hitT3 || 0), dim: 0.78 },
    { key: "hit_t1", n: (stats.hitT1 || 0) - (stats.hitT2 || 0), dim: 0.56 },
    { key: "faded", n: stats.faded || 0, dim: 1 },
    { key: "active", n: stats.expired || 0, dim: 0.55 },
    { key: "invalidated", n: stats.invalidated || 0, dim: 1 },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (!total) return null;

  return (
    <>
      <div style={{ display: "flex", height: 8, borderRadius: 999, overflow: "hidden", background: "var(--surface-2)", gap: 1.5 }}>
        {parts.map((p) => (
          <span key={p.key} style={{
            width: `${Math.max(3, (p.n / total) * 100)}%`,
            background: OUTCOME[p.key].tone, opacity: p.dim,
          }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: 8 }}>
        {parts.map((p) => (
          <span key={p.key} className="t-cap" style={{ color: "var(--faint)", display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, flex: "none", background: OUTCOME[p.key].tone, opacity: p.dim }} />
            <span className="t-num" style={{ color: "var(--sub)" }}>{p.n}</span> {OUTCOME[p.key].label}
          </span>
        ))}
      </div>
    </>
  );
}

/**
 * The last dozen results, newest first — the thing a base rate cannot show.
 * A year at 46% hides a month where nothing worked, and that month is exactly
 * when you would want to stop taking the signals.
 */
function FormStrip({ form }) {
  if (!Array.isArray(form) || form.length < 3) return null;
  const recent = form.slice(0, 12);
  return (
    <div style={{ marginTop: 12 }}>
      <div className="t-cap" style={{ color: "var(--faint)", marginBottom: 5 }}>
        Last {recent.length}, newest first
      </div>
      <div style={{ display: "flex", gap: 3 }}>
        {recent.map((f, i) => {
          const o = OUTCOME[f.status] || OUTCOME.active;
          const won = f.status === "hit_t1" || f.status === "hit_t2" || f.status === "hit_t3";
          return (
            <span key={i} title={`${f.symbol} · ${o.label}`} style={{
              flex: 1, height: 22, borderRadius: 4, minWidth: 0,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: `color-mix(in srgb, ${o.tone} ${won ? 18 : 10}%, transparent)`,
              color: o.tone,
            }}>
              <span className="t-cap t-num" style={{ fontSize: 9.5, fontWeight: 600 }}>{o.short}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function RecordCard({ stats, recent, collapseProps, noun = "flags" }) {
  const s = stats || null;
  // Under three resolved episodes there is no rate worth printing — a base
  // rate over two is a lie with a decimal point, and the engines already
  // refuse to compute one. The card refuses to imply one.
  const thin = !s || s.hitT1Rate == null;

  return (
    <CollapsibleCard {...collapseProps} title="Record" tight
      trailing={s && s.total ? (
        <span className="t-cap t-num" style={{ color: "var(--faint)" }}>
          {s.total} {noun}{s.open ? ` · ${s.open} open` : ""}
        </span>
      ) : null}
    >
      {thin ? (
        <EmptyState title="Not enough graded yet"
          sub={`The log needs a few resolved ${noun} before a hit rate means anything.`}
          style={{ padding: "16px 12px" }} />
      ) : (
        <>
          {/* 1 — does it work. The denominator is written out, because a
              percentage whose sample size you have to go looking for is how
              every bad track record gets presented. */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
            <span className="t-title1 t-num" style={{ color: s.hitT1Rate >= 50 ? T.green : "var(--ink)" }}>
              {Math.round(s.hitT1Rate)}%
            </span>
            <span className="t-foot" style={{ color: "var(--sub)", minWidth: 0, lineHeight: 1.4 }}>
              of {s.resolved} closed {noun} reached their first target
            </span>
          </div>

          {/* 2 — how it fails */}
          <OutcomeBar stats={s} />

          {/* 3 — what you get, and how long it takes */}
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <Stat value={signedPct(s.medianPeakPct)} label="median peak"
              tone={s.medianPeakPct >= 0 ? T.green : T.red} />
            <Stat value={s.medianHeldDays != null ? `${Math.round(s.medianHeldDays)}d` : "—"} label="median hold" />
            <Stat value={s.best ? signedPct(s.best.pct, 0) : "—"} label={s.best ? `best · ${s.best.symbol}` : "best"}
              tone={T.green} />
            <Stat value={s.worst ? signedPct(s.worst.pct, 0) : "—"} label={s.worst ? `worst · ${s.worst.symbol}` : "worst"}
              tone={T.red} />
          </div>

          {/* 4 — lately */}
          <FormStrip form={s.form} />
        </>
      )}

      {recent && recent.length > 0 && (
        <CellGroup style={{ boxShadow: "none", background: "transparent", borderRadius: 0, margin: "12px -16px -8px" }}>
          {recent.map((f) => {
            const o = OUTCOME[f.status] || OUTCOME.active;
            const fa = fmtDay(f.firstFlaggedAt), fb = fmtDay(f.resolvedAt);
            return (
              <Cell key={f.id}
                title={<span className="t-label" style={{ color: "var(--ink)", letterSpacing: "0.04em" }}>{f.symbol}</span>}
                sub={fa === fb ? fa : `${fa} → ${fb}`}
                trailing={
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
                    <span className="t-cap" style={{
                      color: o.tone, background: `color-mix(in srgb, ${o.tone} 14%, transparent)`,
                      borderRadius: 999, padding: "3px 9px", fontWeight: 600, whiteSpace: "nowrap",
                    }}>{o.label}</span>
                    {/* The PEAK, not the close — what the flag was worth at its
                        best is the thing the targets were graded against. */}
                    <Delta pct={f.peakPct} digits={1} />
                  </span>
                }
              />
            );
          })}
        </CellGroup>
      )}
    </CollapsibleCard>
  );
}
