import { T } from "../theme.js";
import { useTween } from "../hooks/index.js";
import { MODEL_META } from "../lib/claude.js";
import { Switch, Segmented as KitSegmented, StatTile, Pill } from "./kit.jsx";

// ─── Legacy primitives, re-voiced ─────────────────────────────────────────────
// Same export surface as before the redesign (call sites untouched); each now
// renders through the SESSION kit or follows its mark specs. New code should
// import from ui/kit.jsx directly.

export function NumTween({ v, f = (x) => x.toLocaleString() }) {
  const shown = useTween(typeof v === "number" ? v : null);
  return shown == null ? <>—</> : <>{f(shown)}</>;
}

// Mark spec: 2px line, rounded joins, 9% area wash, no grid.
export function Sparkline({ points, color, height = 44 }) {
  if (!points || points.length < 2) return <div style={{ height }} />;
  const min = Math.min(...points), max = Math.max(...points);
  const range = max - min || 1;
  const w = 260;
  const step = w / (points.length - 1);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(height - 3 - ((p - min) / range) * (height - 6)).toFixed(1)}`).join(" ");
  const areaPath = `${path} L ${w} ${height} L 0 ${height} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      <path d={areaPath} fill={color} opacity="0.09" />
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Tick marks: one 1px vertical dash per period, centred on that period's value.
// A tick chart, not a line — the series it was built for (exchange reserve)
// only has one honest reading a day, and a line would draw an intraday path
// that doesn't exist. Deliberately NOT columns from a baseline: the scale is
// zoomed to the series (a 2.4M-BTC number never moves enough for a zero
// baseline to show anything), and columns off a false zero would exaggerate
// every wiggle into a cliff. Ticks sit at the value and imply no origin — so
// call sites print the change beside them instead of leaving the eye to
// estimate it. Baseline hairline only, per the chart spec (no grid).
export function TickChart({ points, color, height = 30, tickLen = 7 }) {
  const vals = (points || []).map(p => (typeof p === "number" ? p : p?.v)).filter(v => typeof v === "number" && isFinite(v));
  if (vals.length < 2) return <div style={{ height }} />;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const w = 260;
  const padY = tickLen / 2 + 1;         // keeps the extreme ticks fully inside the box
  const step = (w - 1) / (vals.length - 1);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={height - 0.5} x2={w} y2={height - 0.5} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {vals.map((v, i) => {
        const y = height - padY - ((v - min) / range) * (height - padY * 2);
        const x = 0.5 + i * step;
        return (
          <line
            key={i}
            x1={x} y1={y - tickLen / 2} x2={x} y2={y + tickLen / 2}
            stroke={color} strokeWidth="1" strokeLinecap="butt"
            opacity={i === vals.length - 1 ? 1 : 0.55}  // today at full strength, history quieter
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

// Bars: flat single-tone marks (identity does no work here — magnitude does),
// 2px top radius, current period at full strength, history quieter.
export function Bars({ data, from, to, height = 54 }) {
  const max = Math.max(...data, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height, padding: "0 2px" }}>
      {data.map((v, i) => (
        <div key={i} style={{ flex: 1, height: `${Math.max(4, (v / max) * 100)}%`, background: from, borderRadius: "3px 3px 0 0", opacity: i >= data.length - 2 ? 1 : 0.45 }} />
      ))}
    </div>
  );
}

// ─── Control shims — old names, new anatomy ───────────────────────────────────
export function Toggle({ on, onToggle, size }) {
  return <Switch on={on} onToggle={onToggle} small={size != null && size < 20} />;
}

export function ToggleRow({ title, sub, on, onToggle, size }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "11px 2px", minHeight: 44 }}>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 500, color: T.ink, letterSpacing: "-0.008em" }}>{title}</span>
        {sub && <span style={{ fontSize: 12.5, color: T.sub }}>{sub}</span>}
      </span>
      <Switch on={on} onToggle={onToggle} small={size != null && size < 20} aria-label={typeof title === "string" ? title : undefined} />
    </div>
  );
}

// Model picker — the one Segmented old code reaches for.
export function Segmented({ value, onChange }) {
  return (
    <KitSegmented
      value={value}
      onChange={onChange}
      options={MODEL_META.map(m => ({ key: m.key, label: m.label, sub: m.price }))}
    />
  );
}

export function Chips({ options, value, onChange, fmt = (v) => v }) {
  // "pick one of N": ≤4 fixed options take the Segmented grammar; larger sets
  // stay pills (true-filter grammar).
  if (options.length <= 4) {
    return (
      <KitSegmented
        options={options.map(o => ({ key: o, label: fmt(o) }))}
        value={value}
        onChange={onChange}
      />
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map(o => (
        <Pill key={o} active={value === o} onClick={() => onChange(o)} style={{ flex: 1, justifyContent: "center" }}>{fmt(o)}</Pill>
      ))}
    </div>
  );
}

export function CardHeader({ title, tag, tagColor = T.faint }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
      <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", color: T.ink }}>{title}</span>
      {tag != null && <span style={{ fontSize: 11.5, fontWeight: 500, color: tagColor }}>{tag}</span>}
    </div>
  );
}

export function StatBox({ value, label, delta, deltaColor = T.green, valueColor, onClick, selected }) {
  return (
    <StatTile
      value={value} label={label} delta={delta} deltaTone={deltaColor}
      valueTone={valueColor} onClick={onClick} selected={selected}
    />
  );
}
