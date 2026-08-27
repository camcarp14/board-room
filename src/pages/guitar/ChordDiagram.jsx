// ─── The chord box ───────────────────────────────────────────────────────────
// Six strings left to right, low E first — the way every chord chart ever
// printed reads, and the same order the fret arrays are stored in (see the
// header of lib/guitar/fretboard.js). Frets run down the page with the nut at
// the top; a shape above the nut prints its starting fret beside it instead.
//
// SVG rather than divs, and every colour is a token: the diagram has to survive
// twenty palettes and both rooms without a second copy. currentColor carries the
// ink so a parent can tint the whole box by setting `color`, which is what the
// "this chord is sounding now" highlight does.
//
// WHAT IT DRAWS THAT MOST CHORD BOXES DO NOT:
//  · finger numbers inside the dots, because "which finger" is most of the
//    instruction and a black circle is none of it;
//  · a barre as one rounded bar rather than four separate dots, because that is
//    what the hand does;
//  · the muted and open markers ABOVE the nut where they belong, not as a
//    seventh row of dots;
//  · optionally, the interval each string sounds — the thing that turns a
//    memorised shape into a shape you understand.

import { degreeOf, intervalName, mod12 } from "../../lib/guitar/theory.js";
import { voicingMidi, STANDARD } from "../../lib/guitar/fretboard.js";

const STRINGS = 6;

export function ChordDiagram({
  frets, fingers = null, barre = null, rootPc = null,
  size = 132, showIntervals = false, tuning = STANDARD,
  label = null, sub = null, tone = null, muted = false, onClick = null, style,
}) {
  if (!Array.isArray(frets) || frets.length !== STRINGS) return null;
  const played = frets.filter((f) => Number.isFinite(f) && f > 0);
  // How many frets the box shows, and where it starts. Four is the usual window;
  // a shape that needs five gets five rather than being cropped, which would draw
  // a chord nobody could play from the picture.
  const lowest = played.length ? Math.min(...played) : 1;
  const highest = played.length ? Math.max(...played) : 4;
  const span = Math.max(4, highest - lowest + 1);
  const baseFret = highest <= 4 ? 1 : lowest;
  const rows = span;

  // THE NAME AND THE MARKERS EACH NEED THEIR OWN BAND. They were both measured
  // from the top of the box, so a labelled diagram drew "Cadd9" straight through
  // the row of ○ and × above the nut — legible in neither direction. The label
  // band is reserved first and the marker row hangs off the nut, so adding a name
  // moves the whole diagram down rather than colliding with it.
  const labelH = label ? size * 0.19 : 0;
  const W = size, padX = size * 0.14;
  const padTop = labelH + size * 0.135;
  const padBottom = size * 0.06;
  const H = padTop + size * 0.87 + padBottom;
  const gridW = W - padX * 2;
  const gridH = size * 0.87;
  const stepX = gridW / (STRINGS - 1);
  const stepY = gridH / rows;
  const x = (s) => padX + s * stepX;
  const yFret = (f) => padTop + f * stepY;            // f = 0 is the nut line
  const yDot = (f) => padTop + (f - 0.5) * stepY;     // centre of fret f's cell

  const nutOpen = baseFret === 1;
  const midis = voicingMidi(frets, tuning);
  let midiIdx = 0;
  const dotR = Math.max(5, stepX * 0.34);

  const ink = tone || "currentColor";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label ? `${label} chord diagram` : "chord diagram"}
      onClick={onClick}
      style={{ display: "block", overflow: "visible", color: "var(--ink)", cursor: onClick ? "pointer" : undefined, opacity: muted ? 0.45 : 1, ...style }}>
      {/* strings */}
      {Array.from({ length: STRINGS }, (_, s) => (
        <line key={`s${s}`} x1={x(s)} y1={yFret(0)} x2={x(s)} y2={yFret(rows)}
          stroke="var(--line-strong)" strokeWidth={0.9} />
      ))}
      {/* frets */}
      {Array.from({ length: rows + 1 }, (_, f) => (
        <line key={`f${f}`} x1={padX} y1={yFret(f)} x2={padX + gridW} y2={yFret(f)}
          stroke={f === 0 && nutOpen ? "var(--ink)" : "var(--line-strong)"}
          strokeWidth={f === 0 && nutOpen ? Math.max(3, size * 0.026) : 0.9}
          strokeLinecap="round" />
      ))}
      {/* the starting fret, when the shape is up the neck */}
      {!nutOpen && (
        <text x={padX - size * 0.045} y={yDot(1)} textAnchor="end" dominantBaseline="middle"
          fontSize={size * 0.105} fontWeight={600} fill="var(--sub)"
          style={{ fontFamily: "var(--font-mono)" }}>{baseFret}</text>
      )}
      {/* open / muted markers, above the nut */}
      {frets.map((f, s) => {
        if (f == null) {
          const r = size * 0.036;
          const cy = padTop - size * 0.062;
          return (
            <g key={`x${s}`} stroke="var(--faint)" strokeWidth={1.6} strokeLinecap="round">
              <line x1={x(s) - r} y1={cy - r} x2={x(s) + r} y2={cy + r} />
              <line x1={x(s) + r} y1={cy - r} x2={x(s) - r} y2={cy + r} />
            </g>
          );
        }
        if (f === 0) {
          return <circle key={`o${s}`} cx={x(s)} cy={padTop - size * 0.062} r={size * 0.036}
            fill="none" stroke="var(--sub)" strokeWidth={1.5} />;
        }
        return null;
      })}
      {/* the barre, as one bar */}
      {barre && barre.fret - baseFret >= 0 && barre.fret - baseFret < rows && (
        <rect
          x={x(barre.from) - dotR} y={yDot(barre.fret - baseFret + 1) - dotR}
          width={(barre.to - barre.from) * stepX + dotR * 2} height={dotR * 2}
          rx={dotR} fill={ink} opacity={0.92} />
      )}
      {/* the dots */}
      {frets.map((f, s) => {
        if (!Number.isFinite(f) || f <= 0) return null;
        const row = f - baseFret + 1;
        if (row < 1 || row > rows) return null;
        const finger = fingers?.[s];
        const inBarre = barre && barre.fret === f && s >= barre.from && s <= barre.to;
        return (
          <g key={`d${s}`}>
            {!inBarre && <circle cx={x(s)} cy={yDot(row)} r={dotR} fill={ink} />}
            {finger > 0 && (
              <text x={x(s)} y={yDot(row)} textAnchor="middle" dominantBaseline="central"
                fontSize={dotR * 1.25} fontWeight={700} fill="var(--surface)"
                style={{ pointerEvents: "none" }}>{finger}</text>
            )}
          </g>
        );
      })}
      {/* what each string sounds, as a degree against the root */}
      {showIntervals && rootPc != null && frets.map((f, s) => {
        if (f == null) return null;
        const m = midis[midiIdx++];
        if (m == null) return null;
        const d = degreeOf(mod12(m), rootPc);
        return (
          <text key={`i${s}`} x={x(s)} y={yFret(rows) + size * 0.105} textAnchor="middle"
            fontSize={size * 0.085} fontWeight={600}
            fill={d === 0 ? "var(--accent)" : "var(--faint)"}
            style={{ fontFamily: "var(--font-mono)" }}>{intervalName(d)}</text>
        );
      })}
      {label && (
        <text x={W / 2} y={labelH * 0.72} textAnchor="middle" fontSize={size * 0.145} fontWeight={700} fill="var(--ink)">
          {label}
        </text>
      )}
      {sub && (
        <text x={W / 2} y={yFret(rows) + size * (showIntervals ? 0.2 : 0.11)} textAnchor="middle"
          fontSize={size * 0.082} fontWeight={500} fill="var(--faint)">{sub}</text>
      )}
    </svg>
  );
}

export default ChordDiagram;
