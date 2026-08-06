// ─── Score — where the number came from ──────────────────────────────────────
//
// The sheet printed "70/100" and a bar, and then eight grey prose bullets that
// half-restated the same facts in a form you have to READ rather than scan. The
// bullets were the complaint; the score being unexplained was the actual bug.
//
// parts[] has been in the payload the whole time. It is eight scored rows that
// sum to the headline exactly, and both engines group them into the same five
// blocks worth the same amounts — 25 trend, 30 pace, 15 volume, 20 structure,
// 10 headroom, offering exactly 100. So the score is a COMPOSITION, and the
// only honest way to draw a composition is to let the parts keep their weight.
//
// THE ONE IDEA: a block's bar LENGTH is what it is worth out of 100. Its FILL
// is what this name earned. FCX at 70 draws a long half-empty Pace bar and a
// short nearly-empty Volume bar, and "the missing 30 is pace and volume" stops
// being arithmetic you perform and becomes two holes you see. That read —
// strong trend, clean breakout, nothing behind it yet — is the whole reason to
// open the sheet, and no arrangement of the prose ever said it.
//
// A block's max is SUMMED FROM ITS MEMBERS, never written down here. Reweight
// rs5 in the screener and this picture moves with it. A part whose key nothing
// claims gets its own row instead of vanishing, so an eighth block added
// upstream shows up as a row rather than as a silently wrong denominator.
//
// PENALTIES ARE NOT METERS. parabolic and thin carry max: 0 and negative
// points — there is no denominator, so a bar would be a lie. They render above
// the blocks as deductions, which is both what they are and where the sheet's
// own doctrine puts judgment: before the evidence it is drawn from.
//
// NOT MEASURED IS NOT ZERO. `measured` comes from the engines for exactly this
// drawing: an empty bar that means "SPY did not come back" is a claim about the
// stock that nobody made.
import { useState } from "react";
import { IcChevronDown } from "../../ui/icons.jsx";
import { T } from "../../theme.js";

const PENALTY_KEYS = new Set(["parabolic", "thin"]);

/**
 * Fold parts[] into the caller's blocks.
 *
 * Everything here is a reduce over numbers the server published. The client
 * does not score, rank, or rescale anything — the house rule is that server
 * math is never re-derived, and adding up a column is not deriving it.
 */
export function groupParts(parts, blocks) {
  const list = Array.isArray(parts) ? parts : [];
  const claimed = new Set();
  const grouped = blocks.map((b) => {
    const mine = list.filter((p) => b.keys.includes(p.key) && p.max > 0);
    mine.forEach((p) => claimed.add(p.key));
    return {
      key: b.key,
      label: b.label,
      sub: b.sub,
      max: mine.reduce((s, p) => s + p.max, 0),
      points: mine.reduce((s, p) => s + (Number.isFinite(p.points) ? p.points : 0), 0),
      // A block is measured when ANY member was. A half-measured block still
      // has a real denominator and a real fill; a fully unmeasured one has
      // neither, and says so instead of drawing an empty bar.
      measured: mine.some((p) => p.measured !== false),
    };
  }).filter((b) => b.max > 0);

  // A part nobody claimed still earned points toward the headline. It gets a
  // row of its own with the server's own label, so the columns keep summing.
  const orphans = list
    .filter((p) => p.max > 0 && !claimed.has(p.key))
    .map((p) => ({ key: p.key, label: p.label, max: p.max, points: p.points || 0, measured: p.measured !== false, sub: null }));

  const penalties = list.filter((p) => p.max === 0 && Number.isFinite(p.points) && p.points < 0);
  return { blocks: [...grouped, ...orphans], penalties };
}

/**
 * One block: label and earned/max on a line, the weighted meter under it.
 *
 * THE WIDTH IS A STRAIGHT PERCENTAGE OF max, with no floor and no padding. The
 * tempting version gives small blocks a minimum width so they do not look like
 * smears — and it destroys the only thing the drawing claims, because a 30 and
 * a 10 stop being 3:1. At 354pt of card, the smallest block (10) still draws
 * 35pt of track. It does not need help.
 *
 * WHAT THE FILL ENCODES IS POINTS, NOT PERFORMANCE. The engine scores on an
 * ordinal ladder — RS5 is [[8,15],[4,12],[1.5,9],[0,6],[-4,3]] — so a name
 * exactly level with SPY earns 6 of 15 and draws 40% full, when the honest
 * English is "no advantage at all". The bar is not lying: it says this block
 * contributed 6 of the 15 points it could have, which is literally true and is
 * the currency the gate spends. But it is not linear in the underlying
 * quantity, and a reader who took the fill for performance would be wrong.
 *
 * The defence is that the ladder is never the only thing on screen: every
 * block's sub-line carries the raw number it was scored from — "5 sess +0.0"
 * under a 6/15 trend bar. Rescaling the fill so neutral read as empty was the
 * alternative, and it would have broken the property that makes the whole card
 * trustworthy: that the fills add up to the score in the header.
 */
function Meter({ b, sub }) {
  const pctOfMax = b.max > 0 ? Math.max(0, Math.min(1, b.points / b.max)) : 0;
  // A block carrying most of its points reads green, one carrying almost none
  // reads faint. Nothing in between gets a colour — a five-colour stack is a
  // legend to learn rather than a picture to see.
  const tone = pctOfMax >= 0.7 ? T.green : pctOfMax >= 0.35 ? "var(--sub)" : "var(--faint)";

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <span className="t-foot" style={{ color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {b.label}
        </span>
        <span className="t-cap t-num" style={{ marginLeft: "auto", flex: "none", color: b.measured ? "var(--sub)" : "var(--faint)" }}>
          {b.measured ? <><span style={{ color: "var(--ink)", fontWeight: 600 }}>{b.points}</span>/{b.max}</> : "not measured"}
        </span>
      </div>
      {/* The track is the block's weight and the fill is what it earned, so the
          UNFILLED remainder is the points this name lost — drawn against ink
          rather than a surface tint so the hole is an object you can see and
          not merely an absence you have to infer. */}
      <div style={{ height: 5, marginTop: 5, display: "flex" }}>
        <div style={{
          width: `${b.max}%`, height: "100%", borderRadius: 999, overflow: "hidden",
          background: b.measured ? "color-mix(in srgb, var(--ink) 13%, transparent)" : "color-mix(in srgb, var(--ink) 6%, transparent)",
        }}>
          {b.measured && <div style={{ width: `${pctOfMax * 100}%`, height: "100%", background: tone, borderRadius: 999 }} />}
        </div>
      </div>
      {sub && (
        <div className="t-cap t-num" style={{ color: "var(--faint)", marginTop: 4, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * @param row      the board row — passed to each block's sub() for its detail line
 * @param parts    parts[] straight off the payload
 * @param score    the headline, server-computed
 * @param band     for the trailing pill
 * @param bandTone tone map, per tab
 * @param blocks   [{ key, label, keys: [...partKeys], sub(row) }]
 * @param facts    the server's prose, kept verbatim behind a disclosure
 */
export default function ScoreCard({ row, parts, score, band, bandTone, blocks, facts }) {
  const [open, setOpen] = useState(false);
  if (score == null) return null;

  const { blocks: rows, penalties } = groupParts(parts, blocks);
  const offered = rows.reduce((s, b) => s + b.max, 0);
  const earned = rows.reduce((s, b) => s + b.points, 0);
  const docked = penalties.reduce((s, p) => s + p.points, 0);
  const prose = Array.isArray(facts) ? facts : [];

  return (
    <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "11px 13px 3px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span className="t-foot" style={{ color: "var(--sub)" }}>
          Score <span className="t-num" style={{ color: "var(--ink)", fontWeight: 600, fontSize: 15 }}>{score}</span>
          <span style={{ color: "var(--faint)" }}>/100</span>
        </span>
        {band && (
          <span className="t-cap" style={{
            marginLeft: "auto", flex: "none", whiteSpace: "nowrap", fontWeight: 600,
            borderRadius: 999, padding: "3px 9px",
            background: `color-mix(in srgb, ${bandTone} 14%, transparent)`, color: bandTone,
          }}>{band}</span>
        )}
      </div>

      {/* THE DEDUCTIONS, FIRST. A −25 applies to the whole thing, and reading
          the blocks before knowing one was applied means reading them wrong. */}
      {penalties.map((p) => (
        <div key={p.key} style={{
          display: "flex", alignItems: "center", gap: 9, marginBottom: 8,
          background: `color-mix(in srgb, ${T.red} 10%, transparent)`, borderRadius: 8, padding: "7px 10px",
        }}>
          <span className="t-cap t-num" style={{ color: T.red, fontWeight: 700, flex: "none" }}>{p.points}</span>
          <span className="t-cap" style={{ color: T.red, minWidth: 0, lineHeight: 1.4 }}>{p.label}</span>
        </div>
      ))}
      {/* Only when a deduction fired does the gap between the blocks and the
          headline need explaining — otherwise this is noise stating an
          identity the columns already show. */}
      {penalties.length > 0 && (
        <div className="t-cap t-num" style={{ color: "var(--faint)", marginBottom: 9 }}>
          earned {earned} of {offered} · docked {Math.abs(docked)}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {rows.map((b) => <Meter key={b.key} b={b} sub={typeof b.sub === "function" ? b.sub(row) : null} />)}
      </div>

      {/* THE SCREENER'S OWN WORDS, one tap away and never deleted. The blocks
          say more than the sentences for anything that scored, but a few facts
          are prose-only — the sector-peer comparison, the risk-off-tape
          warning — and those have no part to hide behind. */}
      {prose.length > 0 && (
        <>
          <button
            type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
            style={{
              display: "flex", alignItems: "center", gap: 6, width: "100%", minHeight: 44,
              background: "none", border: "none", padding: 0, margin: "2px 0 0", font: "inherit",
              color: "var(--sub)", textAlign: "left", cursor: "pointer",
            }}
          >
            <span className="t-cap">{open ? "Hide" : "In the screener's words"}</span>
            <IcChevronDown size={12} style={{ flex: "none", color: "var(--faint)", transform: open ? "none" : "rotate(-90deg)", transition: "transform var(--dur-2) var(--ease-out)" }} />
          </button>
          {/* The inner div carries NO padding, exactly as CollapsibleCard's
              does not. `grid-template-rows: 0fr` is `minmax(auto, 0fr)`, whose
              automatic minimum is the item's min-content — and padding is not
              clipped by overflow:hidden, so 13px of it kept the first bullet
              on screen with the disclosure shut. The padding lives one level
              in, where the collapse can eat it. */}
          <div className={`expand${open ? " open" : ""}`}>
            <div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "2px 0 11px" }}>
                {prose.map((f, i) => (
                  <div key={i} className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.5, display: "flex", gap: 7 }}>
                    <span style={{ color: "var(--faint)", flex: "none" }}>·</span>
                    <span style={{ minWidth: 0 }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
      {prose.length === 0 && <div style={{ height: 8 }} />}
    </div>
  );
}
