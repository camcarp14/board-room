import { useMemo, useState } from "react";

/**
 * GscLineChart â€” Board Room GSC card chart
 *
 * Props:
 *   rows:   [{ date: "2026-06-21", impressions: 807, clicks: 2, position: 18.7 }, ...]
 *   metric: "impressions" | "clicks" | "position"  (controlled by the parent â€”
 *           the card's StatBoxes act as the selector)
 *
 * Behavior:
 *   - Hover a point -> callout with value + date (one at a time)
 *   - Tap works too on touch devices (tap same point again to dismiss)
 */

const METRICS = {
  impressions: { format: (v) => v.toLocaleString() },
  clicks: { format: (v) => v.toLocaleString() },
  position: { format: (v) => v.toFixed(1), invert: true },
};

const W = 640;
const H = 180;
const PAD = { top: 28, right: 16, bottom: 24, left: 16 };

function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function GscLineChart({ rows = [], metric = "impressions" }) {
  const [activeIdx, setActiveIdx] = useState(null);

  const m = METRICS[metric] || METRICS.impressions;

  const points = useMemo(() => {
    if (!rows.length) return [];
    const vals = rows.map((r) => Number(r[metric]) || 0);
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; } // flat-line guard

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const stepX = rows.length > 1 ? innerW / (rows.length - 1) : 0;

    return rows.map((r, i) => {
      const raw = (vals[i] - min) / (max - min);
      // For Avg Position, lower is better -> plot inverted so "up" = improving
      const norm = m.invert ? 1 - raw : raw;
      return {
        x: PAD.left + i * stepX,
        y: PAD.top + innerH - norm * innerH,
        value: vals[i],
        date: r.date,
      };
    });
  }, [rows, metric, m.invert]);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaPath = points.length
    ? `${linePath} L${points[points.length - 1].x},${H - PAD.bottom} L${points[0].x},${H - PAD.bottom} Z`
    : "";

  const active = activeIdx != null ? points[activeIdx] : null;

  // Keep callout inside the viewBox
  const calloutW = 118;
  const calloutX = active
    ? Math.min(Math.max(active.x - calloutW / 2, 4), W - calloutW - 4)
    : 0;
  const calloutAbove = active && active.y > 60;
  const calloutY = active ? (calloutAbove ? active.y - 54 : active.y + 14) : 0;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block", touchAction: "manipulation" }}
      onMouseLeave={() => setActiveIdx(null)}
      onClick={() => setActiveIdx(null)} // background tap dismisses (touch)
    >
      <defs>
        <linearGradient id="gscArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--green)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Baseline */}
      <line
        x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom}
        stroke="var(--line-strong)" strokeWidth="1"
      />

      {points.length > 1 && (
        <>
          <path d={areaPath} fill="url(#gscArea)" />
          <path d={linePath} fill="none" stroke="var(--green)" strokeWidth="2.25"
            strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}

      {/* Data points â€” hover to show callout; generous invisible hit area
          also makes taps easy on mobile */}
      {points.map((p, i) => (
        <g
          key={i}
          onMouseEnter={() => setActiveIdx(i)}
          onClick={(e) => {
            e.stopPropagation();
            setActiveIdx(activeIdx === i ? null : i);
          }}
          style={{ cursor: "pointer" }}
        >
          <circle cx={p.x} cy={p.y} r={14} fill="transparent" />
          <circle
            cx={p.x} cy={p.y}
            r={activeIdx === i ? 5 : 3.25}
            fill={activeIdx === i ? "var(--brass)" : "var(--green)"}
            stroke="var(--surface)"
            strokeWidth="1.5"
          />
        </g>
      ))}

      {/* First/last date labels */}
      {points.length > 1 && (
        <>
          <text x={PAD.left} y={H - 6} fontSize="10" fill="var(--faint)"
            fontFamily="'IBM Plex Mono', monospace">{fmtDate(points[0].date)}</text>
          <text x={W - PAD.right} y={H - 6} fontSize="10" fill="var(--faint)" textAnchor="end"
            fontFamily="'IBM Plex Mono', monospace">{fmtDate(points[points.length - 1].date)}</text>
        </>
      )}

      {/* Single callout */}
      {active && (
        <g pointerEvents="none">
          <line x1={active.x} y1={active.y} x2={active.x} y2={H - PAD.bottom}
            stroke="var(--brass)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
          <rect
            x={calloutX} y={calloutY} width={calloutW} height={40} rx={6}
            fill="var(--surface-2)" stroke="var(--brass)" strokeWidth="1"
          />
          <text x={calloutX + calloutW / 2} y={calloutY + 17} textAnchor="middle"
            fontSize="13" fontWeight="700" fill="var(--ink)"
            fontFamily="'IBM Plex Mono', monospace">
            {m.format(active.value)}
          </text>
          <text x={calloutX + calloutW / 2} y={calloutY + 32} textAnchor="middle"
            fontSize="10" fill="var(--faint)"
            fontFamily="'IBM Plex Mono', monospace">
            {fmtDate(active.date)}
          </text>
        </g>
      )}
    </svg>
  );
}
