// ─── The neck ────────────────────────────────────────────────────────────────
// A whole fretboard, drawn the way you see your own: low E along the BOTTOM,
// nut on the left, frets running away to the right. Which means the string
// arrays — stored low-first everywhere else in this tab — are drawn in reverse
// here, and this is the one file allowed to do that. Storing them reversed
// instead would put the app permanently out of step with every chord chart and
// every tab in the world.
//
// One component serves the scale explorer, the CAGED map, the chord-tone
// overlay and the note-finder drill, because they are all the same picture with
// different dots on it. `dots` is whatever should be lit; everything else — the
// wood, the inlays, the string gauges, the fret numbers — is the same neck.
//
// It scrolls sideways inside its own container rather than shrinking, because a
// fifteen-fret neck squeezed onto a phone is a neck you cannot read. The page
// itself must never scroll horizontally (DESIGN.md §7), so the overflow lives
// here, on the diagram.

import { useRef, useEffect } from "react";
import { pcName, intervalName, mod12 } from "../../lib/guitar/theory.js";
import { STANDARD, midiAt } from "../../lib/guitar/fretboard.js";

// Where the dots go on a real guitar. 12 gets two.
const INLAYS = new Set([3, 5, 7, 9, 15, 17, 19, 21]);
const DOUBLE = new Set([12, 24]);

export function Fretboard({
  tuning = STANDARD, fromFret = 0, toFret = 15, dots = [], capo = 0,
  label = "degree",                 // "degree" | "note" | "finger" | "none"
  height = 168, onDot = null, onFret = null, highlight = null,
  showFretNumbers = true, style, ariaLabel = "Fretboard",
}) {
  const strings = tuning.length;
  const frets = Math.max(1, toFret - fromFret);
  // A fret is not a fixed width on a real neck, and pretending otherwise makes
  // the low frets look cramped and the high ones absurd. 34px at the nut easing
  // to 22 at the fifteenth is close enough to a scale length to read right and
  // simple enough to invert for a tap.
  const wFor = (i) => 34 - Math.min(12, (i / Math.max(1, frets)) * 12);
  const widths = Array.from({ length: frets }, (_, i) => wFor(fromFret + i));
  // OPEN STRINGS NEED A COLUMN OF THEIR OWN. A fret-0 dot is not "just left of
  // the nut" — there is nothing there but the string names, and drawing the dots
  // eight pixels off the nut put a solid circle on top of every one of them, so
  // the neck lost its labels exactly when a beginner needed them most. The nut
  // starts far enough in for a real column: names at the far left, open dots
  // between them and the nut, nothing overlapping anything.
  const NAME_X = 9;
  const OPEN_X = 27;
  const nutX = fromFret === 0 ? 42 : 26;
  const xs = widths.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [nutX]);
  const W = xs[xs.length - 1] + 10;
  const padTop = 14, padBottom = showFretNumbers ? 20 : 8;
  const H = height;
  const gridH = H - padTop - padBottom;
  const stepY = gridH / (strings - 1);
  // Low string at the BOTTOM — index 0 is the low E, so it draws last.
  const y = (s) => padTop + (strings - 1 - s) * stepY;
  const xMid = (f) => (f <= fromFret ? OPEN_X : (xs[f - fromFret - 1] + xs[f - fromFret]) / 2);

  const scroller = useRef(null);
  // Bring the lit region into view when the dots move up the neck — without
  // scrollIntoView, which drags every scrollable ancestor with it (the note at
  // the top of MarketsPage.jsx is what that cost last time).
  useEffect(() => {
    const el = scroller.current;
    if (!el || !dots.length) return;
    const lowest = Math.min(...dots.map((d) => d.fret));
    const target = Math.max(0, xMid(lowest) - 60);
    if (Math.abs(el.scrollLeft - target) > 40) el.scrollLeft = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dots.length && dots[0]?.fret, toFret, fromFret]);

  const dotAt = new Map();
  for (const d of dots) dotAt.set(`${d.string}:${d.fret}`, d);

  const toneOf = (d) => {
    if (d.tone) return d.tone;
    if (d.root) return "var(--accent)";
    if (d.degree === 4 || d.degree === 3) return "var(--blue)";      // the third
    if (d.degree === 10 || d.degree === 11) return "var(--purple)";  // the seventh
    if (d.degree === 7) return "var(--green)";                       // the fifth
    return "var(--sub)";
  };
  const textOf = (d) => {
    if (label === "none") return null;
    if (label === "finger") return d.finger ?? null;
    if (label === "note") return pcName(d.pc);
    return d.degree == null ? null : intervalName(d.degree);
  };

  return (
    <div ref={scroller} style={{ overflowX: "auto", overflowY: "hidden", WebkitOverflowScrolling: "touch", ...style }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={ariaLabel} style={{ display: "block" }}>
        {/* the board */}
        <rect x={xs[0]} y={padTop - 5} width={W - xs[0] - 10} height={gridH + 10} rx={3} fill="var(--surface-2)" />
        {/* frets */}
        {xs.map((px, i) => (
          <line key={`fr${i}`} x1={px} y1={padTop - 5} x2={px} y2={padTop + gridH + 5}
            stroke={i === 0 && fromFret === 0 ? "var(--ink)" : "var(--line-strong)"}
            strokeWidth={i === 0 && fromFret === 0 ? 4 : 1.2} strokeLinecap="round" />
        ))}
        {/* inlays */}
        {Array.from({ length: frets }, (_, i) => {
          const f = fromFret + i + 1;
          const cx = (xs[i] + xs[i + 1]) / 2;
          if (DOUBLE.has(f)) return (
            <g key={`in${f}`} fill="var(--line-strong)">
              <circle cx={cx} cy={padTop + gridH * 0.28} r={3.2} />
              <circle cx={cx} cy={padTop + gridH * 0.72} r={3.2} />
            </g>
          );
          if (INLAYS.has(f)) return <circle key={`in${f}`} cx={cx} cy={padTop + gridH / 2} r={3.2} fill="var(--line-strong)" />;
          return null;
        })}
        {/* strings — thicker toward the low E, which is how you find your place */}
        {Array.from({ length: strings }, (_, s) => (
          <line key={`st${s}`} x1={xs[0]} y1={y(s)} x2={W - 10} y2={y(s)}
            stroke="var(--line-strong)" strokeWidth={0.8 + (strings - 1 - s) * 0.28} />
        ))}
        {/* capo */}
        {capo > fromFret && capo <= toFret && (
          <rect x={xMid(capo) - 4} y={padTop - 7} width={8} height={gridH + 14} rx={4}
            fill="var(--amber)" opacity={0.85} />
        )}
        {/* tap targets — one per cell, invisible, so a finger hits a fret and not a dot */}
        {onFret && Array.from({ length: frets + 1 }, (_, i) => fromFret + i).map((f) =>
          Array.from({ length: strings }, (_, s) => (
            <rect key={`t${s}:${f}`} x={f === fromFret ? OPEN_X - 11 : xs[f - fromFret - 1]}
              y={y(s) - stepY / 2} width={f === fromFret ? 22 : widths[f - fromFret - 1]} height={stepY}
              fill="transparent" style={{ cursor: "pointer" }}
              onClick={() => onFret({ string: s, fret: f, midi: midiAt(s, f, tuning, capo) })} />
          )))}
        {/* the dots */}
        {dots.map((d) => {
          const cx = xMid(d.fret);
          const cy = y(d.string);
          const isHi = highlight && highlight.string === d.string && highlight.fret === d.fret;
          const r = d.root ? 11 : 9.5;
          const txt = textOf(d);
          return (
            <g key={`${d.string}:${d.fret}`} onClick={onDot ? () => onDot(d) : undefined}
              style={{ cursor: onDot ? "pointer" : undefined }}>
              {isHi && <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke="var(--accent)" strokeWidth={2} opacity={0.7} />}
              <circle cx={cx} cy={cy} r={r} fill={toneOf(d)} opacity={d.dim ? 0.32 : 1} />
              {txt != null && (
                <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
                  fontSize={String(txt).length > 2 ? 7.4 : 8.6} fontWeight={700}
                  fill="var(--surface)" style={{ pointerEvents: "none", fontFamily: "var(--font-mono)" }}>{txt}</text>
              )}
            </g>
          );
        })}
        {/* fret numbers */}
        {showFretNumbers && Array.from({ length: frets }, (_, i) => fromFret + i + 1).map((f, i) => (
          (f % 12 === 0 || INLAYS.has(f) || f === 1) ? (
            <text key={`n${f}`} x={(xs[i] + xs[i + 1]) / 2} y={H - 6} textAnchor="middle"
              fontSize={9.5} fontWeight={600} fill="var(--faint)"
              style={{ fontFamily: "var(--font-mono)" }}>{f}</text>
          ) : null
        ))}
        {/* string names at the nut */}
        {fromFret === 0 && Array.from({ length: strings }, (_, s) => (
          <text key={`sn${s}`} x={NAME_X} y={y(s)} textAnchor="middle" dominantBaseline="central"
            fontSize={9} fontWeight={600} fill="var(--faint)"
            style={{ fontFamily: "var(--font-mono)" }}>{pcName(mod12(tuning[s] + capo))}</text>
        ))}
      </svg>
    </div>
  );
}

export default Fretboard;
