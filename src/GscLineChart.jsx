import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dot } from "./ui/kit.jsx";

/**
 * GscLineChart — Board Room GSC card chart (SESSION)
 *
 * Props (contract unchanged):
 *   rows:   [{ date: "2026-06-21", impressions: 807, clicks: 2, position: 18.7 }, ...]
 *   metric: "impressions" | "clicks" | "position"  (controlled by the parent —
 *           the card's stat tiles act as the selector)
 *
 * Behavior:
 *   - Hover or tap a column -> one callout with every plotted value + the date
 *     (tap the same column again to dismiss; background tap and mouse-leave
 *     also dismiss)
 *   - impressions & clicks draw together — two series, each normalized to its
 *     own range so the shapes compare; the selected metric is primary and
 *     carries the area fill. position draws alone (its scale is a rank, not a
 *     volume).
 *   - The SVG renders at the measured pixel width (ResizeObserver), so labels
 *     are true ≥10.5px on phones instead of shrinking with a fixed viewBox.
 */

const METRICS = {
  impressions: { format: (v) => v.toLocaleString() },
  clicks: { format: (v) => v.toLocaleString() },
  position: { format: (v) => v.toFixed(1), invert: true },
};

// Fixed series identity — matches the validated data-palette adjacency
// (green, blue, …) and any legend the Brief shows: impressions = blue,
// clicks = green. Position is purple so the status pair (green/red) never
// does rank-identity work.
const SERIES = {
  impressions: { color: "var(--blue)", label: "Impressions" },
  clicks: { color: "var(--green)", label: "Clicks" },
  position: { color: "var(--purple)", label: "Avg position" },
};

const H = 124;
const PAD = { top: 10, right: 8, bottom: 22, left: 8 };
// SVG text can consume var() live (unlike canvas) — keep references, not literals.
const MONO = "var(--font-mono)";

function fmtDate(iso) {
  // parse as local midnight to avoid UTC off-by-one-day shifts
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Stable approximation of mono text width (px) — sizes the callout pill.
const monoW = (str, fontSize) => String(str).length * fontSize * 0.62;

const linePath = (pts) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

export default function GscLineChart({ rows = [], metric = "impressions" }) {
  const [activeIdx, setActiveIdx] = useState(null);
  const wrapRef = useRef(null);
  const [w, setW] = useState(0);
  // Gradient ids are global DOM ids — keep them unique per instance so two
  // charts on one page never collide.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  // Measure the rendered width so geometry and text draw at true pixel sizes.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setW(Math.round(el.clientWidth));
    measure();
    let ro;
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(measure); ro.observe(el); }
    else window.addEventListener("resize", measure);
    return () => { ro ? ro.disconnect() : window.removeEventListener("resize", measure); };
  }, []);

  const primaryKey = METRICS[metric] ? metric : "impressions";
  const legendKeys = primaryKey === "position" ? ["position"] : ["impressions", "clicks"];

  const series = useMemo(() => {
    if (!rows.length || w < 40) return [];
    const keys = primaryKey === "position" ? ["position"] : ["impressions", "clicks"];
    const innerW = w - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const stepX = rows.length > 1 ? innerW / (rows.length - 1) : 0;
    return keys.map((key) => {
      const vals = rows.map((r) => Number(r[key]) || 0);
      let min = Math.min(...vals);
      let max = Math.max(...vals);
      if (min === max) { min -= 1; max += 1; } // flat-line guard
      const pts = rows.map((r, i) => {
        const raw = (vals[i] - min) / (max - min);
        // For Avg Position, lower is better -> plot inverted so "up" = improving
        const norm = METRICS[key]?.invert ? 1 - raw : raw;
        return {
          x: PAD.left + i * stepX,
          y: PAD.top + innerH - norm * innerH,
          value: vals[i],
          date: r.date,
        };
      });
      return { key, pts, color: SERIES[key].color };
    });
  }, [rows, w, primaryKey]);

  const primary = series.find((s) => s.key === primaryKey) || null;
  const secondaries = series.filter((s) => s.key !== primaryKey);
  const pts = primary ? primary.pts : [];
  const stepX = pts.length > 1 ? (w - PAD.left - PAD.right) / (pts.length - 1) : 0;
  // Dots are the tap affordance — but past ~1 every 8px they'd fuse into the
  // line, so dense windows keep only the active marker.
  const showDots = pts.length === 1 || stepX >= 8;

  const baseY = H - PAD.bottom;
  const active = activeIdx != null && primary ? pts[activeIdx] : null;

  // Callout pill — sized to its text, clamped inside the chart, flipped below
  // the point when it would clip at the top.
  let callout = null;
  if (active) {
    const vFS = 12.5, dFS = 10.5, padX = 10, ch = 42;
    const entries = series.map((s) => ({
      color: s.color,
      text: (METRICS[s.key] || METRICS.impressions).format(s.pts[activeIdx].value),
    }));
    const dateStr = fmtDate(active.date);
    let acc = padX; // x cursor inside the pill: dot(6) + gap(5) + value, 12 between entries
    const xs = entries.map((e) => {
      const x = acc;
      acc += 6 + 5 + monoW(e.text, vFS) + 12;
      return x;
    });
    const rowW = acc - 12 + padX;
    const cw = Math.ceil(Math.max(rowW, padX * 2 + monoW(dateStr, dFS), 72));
    const cx = Math.min(Math.max(active.x - cw / 2, 4), w - cw - 4);
    const calloutAbove = active.y > ch + 18;
    const cy = calloutAbove ? active.y - ch - 12 : active.y + 14;
    callout = { entries, xs, dateStr, cw, ch, cx, cy, vFS, dFS, padX };
  }

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      {/* series identity — 6px dots, text in ink tokens, never in series color */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 14, padding: "0 8px 4px", minHeight: 12 }}>
        {legendKeys.map((k) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Dot tone={SERIES[k].color} size={6} />
            <span style={{ fontSize: 10.5, fontFamily: MONO, color: k === primaryKey ? "var(--sub)" : "var(--faint)" }}>
              {SERIES[k].label}
            </span>
          </span>
        ))}
      </div>

      <div style={{ height: H }}>
        {w >= 40 && (
          <svg
            width={w}
            height={H}
            style={{ display: "block", touchAction: "manipulation" /* kills iOS double-tap zoom delay */ }}
            onMouseLeave={() => setActiveIdx(null)}
            onClick={() => setActiveIdx(null)} // background tap dismisses (touch)
          >
            <defs>
              <linearGradient id={`gsc-area-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={primary ? primary.color : "var(--blue)"} stopOpacity="0.1" />
                <stop offset="100%" stopColor={primary ? primary.color : "var(--blue)"} stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Baseline — the only grid ink */}
            <line x1={PAD.left} y1={baseY} x2={w - PAD.right} y2={baseY} stroke="var(--line)" strokeWidth="1" />

            {/* Area on the primary series only */}
            {pts.length > 1 && (
              <path
                d={`${linePath(pts)} L${pts[pts.length - 1].x},${baseY} L${pts[0].x},${baseY} Z`}
                fill={`url(#gsc-area-${uid})`}
              />
            )}

            {/* Secondary series — 2px line, no fill */}
            {secondaries.map((s) => s.pts.length > 1 && (
              <path key={s.key} d={linePath(s.pts)} fill="none" stroke={s.color} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" />
            ))}

            {/* Primary line */}
            {pts.length > 1 && (
              <path d={linePath(pts)} fill="none" stroke={primary.color} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" />
            )}

            {/* Data-point dots (primary) — visible tap affordance, surface ring */}
            {showDots && pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={3} fill={primary.color} stroke="var(--surface)" strokeWidth="1.5" />
            ))}

            {/* Column hit targets — full-height slices are far easier to tap
                than the old per-point circles; hover works the same way */}
            {pts.map((p, i) => {
              const x0 = i === 0 ? 0 : p.x - stepX / 2;
              const x1 = i === pts.length - 1 ? w : p.x + stepX / 2;
              return (
                <rect
                  key={i}
                  x={x0} y={10} width={Math.max(x1 - x0, 1)} height={baseY - 10 + 12}
                  fill="transparent"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveIdx(activeIdx === i ? null : i);
                  }}
                />
              );
            })}

            {/* First/last date labels — true-pixel mono, never under 10.5px */}
            {pts.length > 1 && (
              <>
                <text x={PAD.left} y={H - 8} fontSize="10.5" fill="var(--faint)"
                  style={{ fontFamily: MONO }}>{fmtDate(pts[0].date)}</text>
                <text x={w - PAD.right} y={H - 8} fontSize="10.5" fill="var(--faint)" textAnchor="end"
                  style={{ fontFamily: MONO }}>{fmtDate(pts[pts.length - 1].date)}</text>
              </>
            )}

            {/* Single callout — one at a time, every series at that date */}
            {active && callout && (
              <g pointerEvents="none">
                <line x1={active.x} y1={active.y} x2={active.x} y2={baseY}
                  stroke="var(--line-strong)" strokeWidth="1" />
                {series.map((s) => {
                  const p = s.pts[activeIdx];
                  return (
                    <g key={s.key}>
                      {s.key === primaryKey && (
                        <circle cx={p.x} cy={p.y} r={7.5} fill="none" stroke={s.color} strokeWidth="1.5" opacity="0.4" />
                      )}
                      <circle cx={p.x} cy={p.y} r={3.5} fill={s.color} stroke="var(--surface)" strokeWidth="2" />
                    </g>
                  );
                })}
                <rect x={callout.cx} y={callout.cy} width={callout.cw} height={callout.ch} rx={12}
                  fill="var(--surface-2)" stroke="var(--line-strong)" strokeWidth="1" />
                {callout.entries.map((e, i) => (
                  <g key={i}>
                    <circle cx={callout.cx + callout.xs[i] + 3} cy={callout.cy + 12.5} r={3} fill={e.color} />
                    <text x={callout.cx + callout.xs[i] + 11} y={callout.cy + 17}
                      fontSize={callout.vFS} fontWeight="600" fill="var(--ink)"
                      style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>
                      {e.text}
                    </text>
                  </g>
                ))}
                <text x={callout.cx + callout.padX} y={callout.cy + 33}
                  fontSize={callout.dFS} fill="var(--faint)" style={{ fontFamily: MONO }}>
                  {callout.dateStr}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
