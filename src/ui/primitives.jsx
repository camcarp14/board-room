import { T } from "../theme.js";
import { MODEL_META } from "../lib/claude.js";
import { Switch, Segmented as KitSegmented, StatTile, Pill, useNumberTween } from "./kit.jsx";

// ─── Legacy primitives, re-voiced ─────────────────────────────────────────────
// Same export surface as before the redesign (call sites untouched); each now
// renders through the SESSION kit or follows its mark specs. New code should
// import from ui/kit.jsx directly.

// The hand-rolled tween the kit now does for every number (see the long note in
// kit.jsx). Kept, because a dozen call sites pass a formatter this component has
// no other way to learn — a hero price prints through px(), not through a
// scaffolding the parser could infer — but routed through the kit's reconciled
// tween, which changes two things for the better.
//
// FIRST, IT NO LONGER LIES AT REST. useTween rounds to the value's own scale, so
// for any target at or above 1 the value this printed once the animation had
// finished was f(Math.round(target)) — and StockSheet and AltCoinSheet both hand
// it px(), which prints two decimals for anything between $1 and $1000. A stock
// at 174.32 counted up and then simply *stayed* at "$174.00", for as long as the
// sheet was open: the cents silently zeroed on the one screen you opened to read
// the price. The kit's hook hands back the exact target once the tween is within
// its own rounding of it, so the resting frame is now f(v) — the truth.
//
// SECOND, reduced motion is honoured, and honoured without ever showing an
// em-dash in place of a real reading. The old guard here was `shown == null ?
// "—"`, and the cheap way to disable a tween is to feed it null — which would
// have printed "—" over a perfectly good price. The hook returns the target
// instead, so those users get the number immediately and never the placeholder.
export function NumTween({ v, f = (x) => x.toLocaleString() }) {
  const [shown] = useNumberTween(typeof v === "number" ? v : null);
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
