import { T, syne, mono } from "../theme.js";
import { S } from "./styles.js";
import { useTween } from "../hooks/index.js";
import { MODEL_META } from "../lib/claude.js";

export function NumTween({ v, f = (x) => x.toLocaleString() }) {
  const shown = useTween(typeof v === "number" ? v : null);
  return shown == null ? <>—</> : <>{f(shown)}</>;
}

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
      <path d={areaPath} fill={color} opacity="0.12" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Bars({ data, from, to, height = 54 }) {
  const max = Math.max(...data, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height, padding: "0 2px" }}>
      {data.map((v, i) => (
        <div key={i} style={{ flex: 1, height: `${Math.max(4, (v / max) * 100)}%`, background: `linear-gradient(180deg, ${from}, ${to})`, borderRadius: "2px 2px 0 0", opacity: i >= data.length - 2 ? 1 : 0.72 }} />
      ))}
    </div>
  );
}

// ─── Reusable premium controls ────────────────────────────────────────────────
export function Toggle({ on, onToggle, size = 20 }) {
  const w = size * 1.7, knob = size - 4;
  return (
    <span onClick={onToggle} style={{ width: w, height: size, borderRadius: size / 2 + 1, background: on ? T.green : "var(--line-strong)", position: "relative", cursor: "pointer", display: "inline-block", flex: "none", boxShadow: "inset 0 1px 2px rgba(0,0,0,0.14)" }}>
      <span style={{ position: "absolute", top: 2, left: on ? w - knob - 2 : 2, width: knob, height: knob, borderRadius: "50%", background: "#FFFFFF", transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.22)" }} />
    </span>
  );
}

export function ToggleRow({ title, sub, on, onToggle, size }) {
  return (
    <div style={{ ...S.inner, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 13px" }}>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: syne, color: T.ink }}>{title}</span>
        <span style={{ fontSize: 9, color: T.faint }}>{sub}</span>
      </span>
      <Toggle on={on} onToggle={onToggle} size={size} />
    </div>
  );
}

export function Segmented({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, background: "var(--ink-a05)", border: "1px solid var(--ink-a06)", borderRadius: 11, padding: 3 }}>
      {MODEL_META.map(m => {
        const active = value === m.key;
        return (
          <button key={m.key} onClick={() => onChange(m.key)} style={{ flex: 1, padding: "7px 0 6px", background: active ? T.brass : "transparent", border: "none", borderRadius: 8, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 1, boxShadow: active ? "inset 0 1px 0 var(--white-inset), 0 2px 8px var(--brass-a32)" : "none" }}>
            <span style={{ fontSize: 10, fontWeight: 700, fontFamily: syne, color: active ? T.bg : T.sub }}>{m.label}</span>
            <span style={{ fontSize: 7.5, fontFamily: mono, color: active ? "var(--on-brass)" : T.faint }}>{m.price}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Chips({ options, value, onChange, fmt = (v) => v }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {options.map(o => {
        const active = value === o;
        return (
          <button key={o} onClick={() => onChange(o)} style={{ flex: 1, padding: "9px 0", background: active ? "var(--brass-a16)" : "var(--ink-a04)", border: `1px solid ${active ? "var(--brass-a40)" : "var(--ink-a06)"}`, borderRadius: 10, color: active ? T.brass : T.sub, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>{fmt(o)}</button>
        );
      })}
    </div>
  );
}

export function CardHeader({ title, tag, tagColor = T.faint }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
      <span style={S.title}>{title}</span>
      <span style={{ ...S.microLabel, color: tagColor }}>{tag}</span>
    </div>
  );
}

export function StatBox({ value, label, delta, deltaColor = T.green, valueColor = T.ink, onClick, selected }) {
  return (
    <div
      onClick={onClick}
      className={onClick ? "press" : undefined}
      style={{
        ...S.inner, padding: "10px 8px", textAlign: "center", borderRadius: 10,
        ...(onClick ? { cursor: "pointer", transition: "transform var(--dur-1) var(--ease-out)" } : {}),
        ...(selected ? { border: "1px solid var(--brass)", boxShadow: "0 0 0 1px var(--brass-a25)" } : {}),
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: mono, color: valueColor, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 8, color: selected ? "var(--brass)" : T.faint, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 }}>{label}</div>
      {delta && <div style={{ fontSize: 9, color: deltaColor, fontFamily: mono, marginTop: 2 }}>{delta}</div>}
    </div>
  );
}
