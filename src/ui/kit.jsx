// ─── SESSION kit — the only components anyone reaches for ────────────────────
// One material (Card), one list grammar (CellGroup/Cell), one number voice
// (StatTile), one set of controls. Styles live in design/components.css;
// these components own structure and behavior only.
// House rules: no borders on cards; accent only on active/primary/live/selected;
// touch targets ≥44pt; text ≥10.5px; destructive flows use confirmSheet, never
// window.confirm.

import { useState, useRef, useEffect, useCallback, forwardRef } from "react";
import { createPortal } from "react-dom";
import { IcChevronRight, IcClose, IcCheck } from "./icons.jsx";

/* ── surfaces ──────────────────────────────────────────────────────────────── */
export function Card({ pad = "md", pressable, onClick, className = "", style, children, ...rest }) {
  const cls = `card pad-${pad}${pressable || onClick ? " pressable" : ""}${className ? " " + className : ""}`;
  return (
    <div className={cls} style={style} onClick={onClick}
      {...(onClick ? { role: "button", tabIndex: 0, onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(e); } } } : {})}
      {...rest}>
      {children}
    </div>
  );
}

export function SectionHeader({ title, trailing, onTrailing, style }) {
  return (
    <div className="sec-head" style={style}>
      <span className="t-label">{title}</span>
      {trailing != null && (
        onTrailing
          ? <button className="sec-link" onClick={onTrailing}>{trailing}</button>
          : <span className="t-cap" style={{ color: "var(--faint)" }}>{trailing}</span>
      )}
    </div>
  );
}

/* ── lists — inset-grouped grammar ─────────────────────────────────────────── */
export function CellGroup({ children, style, className = "" }) {
  return <div className={`cellgroup${className ? " " + className : ""}`} style={style}>{children}</div>;
}

export function Cell({ leading, leadingTone, title, sub, value, trailing, chevron, onClick, destructive, style, titleStyle }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={`cell${onClick ? " tappable" : ""}${leading ? " has-leading" : ""}${destructive ? " destructive" : ""}`}
      onClick={onClick} style={style}>
      {leading && (
        <span className="cell-leading" style={leadingTone ? { background: `color-mix(in srgb, ${leadingTone} 14%, transparent)`, color: leadingTone } : { color: "var(--sub)" }}>
          {leading}
        </span>
      )}
      <span className="cell-body">
        <span className="cell-title" style={titleStyle}>{title}</span>
        {sub != null && <span className="cell-sub">{sub}</span>}
      </span>
      {value != null && <span className="cell-value">{value}</span>}
      {trailing}
      {chevron && <span className="cell-chevron"><IcChevronRight /></span>}
    </Tag>
  );
}

/* ── numbers ───────────────────────────────────────────────────────────────── */
export function StatTile({ value, label, delta, deltaTone = "var(--green)", valueTone, onClick, selected, onCanvas, style }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={`stattile${onClick ? " tappable" : ""}${selected ? " selected" : ""}${onCanvas ? " on-canvas" : ""}`} onClick={onClick} style={style}>
      <span className="stattile-value" style={valueTone ? { color: valueTone } : undefined}>{value}</span>
      <span className="stattile-label" style={selected ? { color: "var(--accent)" } : undefined}>{label}</span>
      {delta != null && <span className="stattile-delta" style={{ color: deltaTone }}>{delta}</span>}
    </Tag>
  );
}

export function Delta({ pct, digits = 2, suffix = "%" }) {
  if (pct == null || isNaN(pct)) return null;
  const up = pct >= 0;
  return (
    <span className="t-num" style={{ color: up ? "var(--green)" : "var(--red)", fontSize: 12 }}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(digits)}{suffix}
    </span>
  );
}

/* ── status vocabulary — dot + quiet text, replaces filled badges ──────────── */
const STATE_META = {
  loading: { tone: "var(--faint)", label: "Loading" },
  live: { tone: "var(--green)", label: "Live", pulse: true },
  notconfigured: { tone: "var(--amber)", label: "Not connected" },
  error: { tone: "var(--red)", label: "Error" },
  nofn: { tone: "var(--red)", label: "Not deployed" },
};
export function Dot({ tone = "var(--faint)", pulse, size = 7 }) {
  return <span className={`dotstatus${pulse ? " pulse" : ""}`} style={{ background: tone, width: size, height: size }} />;
}
export function Status({ state = "loading", label, title }) {
  const m = STATE_META[state] || STATE_META.loading;
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
      <Dot tone={m.tone} pulse={m.pulse} size={6} />
      <span className="t-cap" style={{ color: m.tone, fontWeight: 600 }}>{label || m.label}</span>
    </span>
  );
}

/* ── controls ──────────────────────────────────────────────────────────────── */
export function Button({ kind = "quiet", size = "md", full, disabled, onClick, children, style, type = "button", title, "aria-label": ariaLabel }) {
  return (
    <button type={type} className={`btn ${kind} ${size}${full ? " full" : ""}`} disabled={disabled} onClick={onClick} style={style} title={title} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

export function Pill({ active, onClick, children, style, ...rest }) {
  return <button className={`pill${active ? " active" : ""}`} onClick={onClick} style={style} {...rest}>{children}</button>;
}

export function PillRow({ options, value, onChange, fmt = (o) => o.label ?? String(o), keyOf = (o) => o.key ?? String(o), style }) {
  const rowRef = useRef(null);
  // keep the active pill in view when it changes (thumb-driven navigation)
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const el = row.querySelector(".pill.active");
    if (el) el.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [value]);
  return (
    <div className="pillrow" ref={rowRef} style={style} role="tablist">
      {options.map((o) => {
        const k = keyOf(o);
        return <Pill key={k} active={value === k} onClick={() => onChange(k)}>{fmt(o)}</Pill>;
      })}
    </div>
  );
}

export function Segmented({ options, value, onChange, style }) {
  // options: [{ key, label, sub? }] — ≤4, equal width; thumb glides, no measuring
  const idx = Math.max(0, options.findIndex((o) => (o.key ?? o) === value));
  const w = 100 / options.length;
  return (
    <div className="seg" style={style}>
      <span className="seg-thumb" style={{ left: `calc(${idx * w}% + 2px)`, width: `calc(${w}% - 4px)` }} />
      {options.map((o) => {
        const k = o.key ?? o;
        const active = k === value;
        return (
          <button key={k} className={`seg-opt${active ? " active" : ""}`} onClick={() => onChange(k)} aria-pressed={active}>
            <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{o.label ?? k}</span>
              {o.sub && <span className="t-num" style={{ fontSize: 10.5, color: "var(--sub)" }}>{o.sub}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ on, onToggle, small, disabled, "aria-label": ariaLabel }) {
  return (
    <button className={`switch${on ? " on" : ""}${small ? " small" : ""}`} onClick={onToggle} disabled={disabled}
      role="switch" aria-checked={!!on} aria-label={ariaLabel} style={disabled ? { opacity: 0.5 } : undefined}>
      <span className="switch-knob" />
    </button>
  );
}

export function SwitchRow({ title, sub, on, onToggle, small }) {
  return (
    <Cell title={title} sub={sub} trailing={<Switch on={on} onToggle={onToggle} small={small} aria-label={typeof title === "string" ? title : undefined} />} />
  );
}

export const Field = forwardRef(function Field(props, ref) {
  return <input {...props} ref={ref} className={`field${props.className ? " " + props.className : ""}`} />;
});
export const TextArea = forwardRef(function TextArea(props, ref) {
  return <textarea {...props} ref={ref} className={`field${props.className ? " " + props.className : ""}`} />;
});

export function Spinner({ size = 18 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

/* ── empty / error states — designed, never defaulted ──────────────────────── */
export function EmptyState({ icon, title, sub, action, style }) {
  return (
    <div className="empty" style={style}>
      {icon && <span className="empty-icon">{icon}</span>}
      {title && <span className="empty-title">{title}</span>}
      {sub && <span className="empty-sub">{sub}</span>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/* ── sheets ────────────────────────────────────────────────────────────────── */
// Phone: bottom sheet with grabber. ≥761px: centered modal. Scrim closes it.
export function Sheet({ onClose, title, headTrailing, footer, children, z = 300, bodyStyle, dismissible = true }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && dismissible) onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dismissible]);
  // Portaled to <body>: page wrappers animate with transform, which makes
  // them the containing block for position:fixed — a sheet rendered in place
  // could sit above a live tab bar with a clipped scrim. At body level no
  // ancestor can interfere.
  return createPortal(
    <>
      <div className="sheet-scrim" style={{ zIndex: z }} onClick={dismissible ? onClose : undefined} />
      <div className="sheet" style={{ zIndex: z + 1 }} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="sheet-grab" />
        {(title != null || headTrailing != null) && (
          <div className="sheet-head">
            <span className="t-title2" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
              {headTrailing}
              <button className="icon-btn" onClick={onClose} aria-label="Close"><IcClose size={19} /></button>
            </span>
          </div>
        )}
        <div className="sheet-body" style={bodyStyle}>{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>,
    document.body
  );
}

// Promise-based confirm — the house replacement for window.confirm.
// const [confirmEl, confirm] = useConfirm();
// if (await confirm({ title: "Delete note?", message: "…", confirmLabel: "Delete", destructive: true })) …
export function useConfirm() {
  const [req, setReq] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setReq({ ...opts, resolve })), []);
  const done = (v) => { req?.resolve(v); setReq(null); };
  const el = req ? (
    <Sheet onClose={() => done(false)} title={req.title} z={480}
      footer={
        <>
          {req.cancelLabel !== false && (
            <Button kind="quiet" size="lg" style={{ flex: 1 }} onClick={() => done(false)}>{req.cancelLabel || "Cancel"}</Button>
          )}
          <Button kind={req.destructive ? "danger-solid" : "primary"} size="lg" style={{ flex: 1 }} onClick={() => done(true)}>
            {req.confirmLabel || "Confirm"}
          </Button>
        </>
      }>
      {req.message && <div className="t-body" style={{ color: "var(--sub)", paddingBottom: 6 }}>{req.message}</div>}
    </Sheet>
  ) : null;
  return [el, confirm];
}

/* ── large-title page block ────────────────────────────────────────────────── */
export function LargeTitle({ title, sub, trailing, onTitleTap }) {
  return (
    <div className="lt-block" style={{ alignItems: "flex-start" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <h1 className="t-ltitle" style={{ margin: 0, cursor: onTitleTap ? "default" : undefined, WebkitUserSelect: "none", userSelect: "none" }} data-lt-sentinel onClick={onTitleTap}>{title}</h1>
        {sub && <div className="lt-sub">{sub}</div>}
      </div>
      {trailing && <div style={{ flex: "none", display: "flex", alignItems: "center", marginTop: -2 }}>{trailing}</div>}
    </div>
  );
}

/* ── layout helper — responsive card grid for tablet ───────────────────────── */
export function Grid({ min = 320, gap = 12, children, style }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(min(${min}px, 100%), 1fr))`, gap, alignItems: "start", ...style }}>
      {children}
    </div>
  );
}

export { IcCheck, IcClose, IcChevronRight };
