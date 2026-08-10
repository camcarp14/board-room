// ─── SESSION kit — the only components anyone reaches for ────────────────────
// One material (Card), one list grammar (CellGroup/Cell), one number voice
// (StatTile), one set of controls. Styles live in design/components.css;
// these components own structure and behavior only.
// House rules: no borders on cards; accent only on active/primary/live/selected;
// touch targets ≥44pt; text ≥10.5px; destructive flows use confirmSheet, never
// window.confirm.

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useContext, createContext, forwardRef } from "react";
import { createPortal } from "react-dom";
import { useTween } from "../hooks/index.js";
import { IcChevronRight, IcChevronDown, IcClose, IcCheck } from "./icons.jsx";

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

// A card that collapses to just its title. The toggle is a *tap on the title
// row* (a plain click — a scroll drag never fires it), with a small chevron as
// the only added chrome; the trailing status/links hide when collapsed so the
// card shrinks to a clean one-line header. Body animates via the .expand
// grammar. Controlled: pass `collapsed` + `onToggle` (persist them where you
// like). Everything else mirrors the Card + CardHead pattern.
export function CollapsibleCard({ id, title, leading, trailing, tight, pad = "md", collapsed, onToggle, children, style, className }) {
  return (
    <Card pad={pad} className={className} style={{ minWidth: 0, ...style }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: collapsed ? 0 : (tight ? 5 : 9) }}>
        <button
          type="button" onClick={onToggle} aria-expanded={!collapsed}
          aria-label={typeof title === "string" ? `${collapsed ? "Expand" : "Collapse"} ${title}` : undefined}
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1, background: "none", border: "none", padding: "4px 0", margin: "-4px 0", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
          {leading}
          <span className="t-head" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          <IcChevronDown size={13} style={{ flex: "none", color: "var(--faint)", transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />
        </button>
        {!collapsed && trailing != null && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>{trailing}</span>
        )}
      </div>
      <div className={`expand${collapsed ? "" : " open"}`}>
        <div>{children}</div>
      </div>
    </Card>
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
      {/* A cell's value slot is the app's other number surface — weights, counts,
          spends, percentages — so it goes through the same instrument as a stat
          tile. Prose in a value slot ("On", "Every day", "Aug 10") is not a shape
          the parser accepts and passes straight through. */}
      {value != null && <span className="cell-value">{instrument(value)}</span>}
      {trailing}
      {chevron && <span className="cell-chevron"><IcChevronRight /></span>}
    </Tag>
  );
}

/* ── numbers ───────────────────────────────────────────────────────────────── */
// EVERY NUMBER TWEENS NOW, AND NOT ONE OF THEM COUNTS UP FROM ZERO.
//
// DESIGN.md §1.5 says numbers are instruments: tabular, monospaced, tweened. Two
// of those three came for free — .stattile-value and .cell-value already carry
// --font-mono and tabular-nums — and the third was reaching almost nothing,
// because `value` is an opaque node and a node cannot be interpolated. Of the
// seventy-nine stat call sites, the seventeen that animated were the ones that
// had wrapped their own figure in <NumTween> by hand. Workout volume, the finance
// totals, the Systems spend, every ride stat: hard cuts. A hard cut reads as the
// screen being replaced rather than as the figure changing, which is precisely
// backwards — the screen is the instrument and the figure is the reading.
//
// So the detection moved here, where the number is printed, instead of staying at
// seventy-nine call sites. A value that is a number, or a STRING that is one
// number wearing a formatter's clothes ("$1,234.56", "12.4 km/h", "◆ 4", "−$40"),
// is taken apart into the number and the scaffolding around it, tweened, and
// reprinted inside that same scaffolding. Everything else falls through
// untouched: "3/5", "Aug 10", "7:30", "—", "…", a React element, and every line
// of settings prose that happens to sit in a value slot.
//
// FOUR RULES. Each one is a bug this would otherwise have shipped:
//
//   1. NULL PASSES THROUGH COMPLETELY UNTOUCHED. useTween returns null for a null
//      target and that is preserved end to end: a tween that renders 0 on its way
//      to null is the app inventing a number, which is the one thing it may never
//      do. Nothing here can manufacture a digit out of an absent reading.
//   2. THE FIRST PAINT IS THE FINAL VALUE. useTween seeds its state from its own
//      target, so a mount is already at rest and nothing counts up on page open;
//      only a CHANGE animates. Counting from zero every time a page opens is
//      decoration, and DESIGN.md §1.6 is explicit that motion here is physics.
//   3. THE SCAFFOLDING IS THE KEY, so a formatter that changes its mind cuts
//      instead of lying. 990 → "1.2k" must not tween the old digits inside the new
//      suffix ("990.0k" is not a number anyone measured), and "$40" → "−$320" must
//      not print "−$40" on the way there, which is the new sign wrapped around a
//      reading that was positive. A changed prefix, suffix, sign or decimal count
//      remounts, and by rule 2 a mount paints the truth.
//   4. THE RESTING FRAME IS THE CALL SITE'S OWN NODE, never our reconstruction.
//      useTween rounds its output to the value's own scale, so the tween cannot be
//      assumed ever to LAND on the reading — Math.round of 1234.56 is 1235, and a
//      component that kept printing its own reconstruction would leave
//      "$1,235.00" on screen for as long as the card was open. The moment the
//      tween is within its own rounding of the target, the exact node we were
//      handed goes back up. That is what the hook's second return value is for,
//      and it is not hypothetical: it is a bug NumTween has been shipping for
//      every price between $1 and $1000 (see the note in primitives.jsx).
//
// And the parser refuses to guess: a shape is only accepted if reprinting the
// target through it reproduces the original string byte for byte. If we cannot
// regenerate what the call site handed us, we have not understood its formatter,
// and the number does not animate. That check is what makes this safe to apply
// to every value slot in the app rather than to a list of blessed ones.

// prefers-reduced-motion, held rather than re-queried: `.matches` on a kept
// MediaQueryList is a property read, and these components re-render once per
// frame while a tween runs. Held rather than *cached* for the same reason the
// sheet re-reads it per gesture — the accessibility switch flips under a running
// app, and a boolean captured at import time would ignore it until reload.
let stillMql;
function numbersStill() {
  if (stillMql === undefined) {
    try { stillMql = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { stillMql = null; }
  }
  return !!stillMql?.matches;
}

// The tween, reconciled with the truth. Returns [what to print this frame, is
// that the real target]. A null target and reduced motion take the same path:
// useTween's effect bails on null, so no rAF is ever scheduled for either — the
// users who asked for no motion get no animation frames, not a cancelled one.
export function useNumberTween(n) {
  const target = typeof n === "number" && Number.isFinite(n) ? n : null;
  const shown = useTween(numbersStill() ? null : target);
  if (target == null) return [null, true];
  // "Has it arrived" is a question about useTween's rounding, not about equality:
  // it rounds to whole numbers at or above 1 and to four significant figures
  // below, so 1235 is as close to 1234.56 as the tween will ever get. The bound
  // is inclusive because Math.round(2.5) is 3, exactly 0.5 away.
  const near = Math.abs(target) >= 1 ? 0.5 : Math.abs(target) * 1e-3;
  return shown == null || Math.abs(shown - target) <= near ? [target, true] : [shown, false];
}

// One number, and scaffolding that carries no digits of its own. The leading run
// may hold symbols and spaces but NOT letters — a word in front makes it prose,
// which is how "Aug 10" and "Set 3" stay out of this — and the trailing run is
// where units live. Grouping is commas only: a locale that groups with thin
// spaces produces a string this cannot rebuild, so it correctly declines.
const NUM_RE = /^([^0-9A-Za-z]*)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([^0-9]*)$/;
// useTween keeps at most 12 decimal places of its own; past that we are looking
// at float noise ("0.30000000000000004"), not at a formatter's intent.
const MAX_DEC = 12;
// The house grouping idiom, lifted from money() so the two agree exactly. Locale
// formatting is deliberately not used: toLocaleString would follow the device
// while money() and every other formatter in the app builds its commas by hand,
// and the two disagreeing is the round-trip check below failing on a German
// phone rather than a number coming out wrong.
function magnitude(v, dec, grouped) {
  const s = Math.abs(v).toFixed(dec);
  if (!grouped) return s;
  const [i, f] = s.split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
}
const printShape = (s, v) => (v < 0 ? s.sign || "-" : s.sign) + s.pre + magnitude(v, s.dec, s.grouped) + s.suf;

function numberShape(value) {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : null)
    : typeof value === "string" ? value : null;
  if (text == null) return null;
  const m = NUM_RE.exec(text);
  if (!m) return null;
  const [, lead, int, frac, suf] = m;
  const dec = frac ? frac.length : 0;
  if (dec > MAX_DEC) return null;
  // The sign is lifted out of the prefix so that it can go into the key: with the
  // sign fixed for the life of a tween, the magnitude interpolates monotonically
  // between two readings that share it, and a crossing of zero — the one case
  // where reusing a prefix would print a value nobody measured — cuts instead.
  const sign = /^[-+−]/.test(lead) ? lead[0] : "";
  const shape = {
    n: (sign === "-" || sign === "−" ? -1 : 1) * parseFloat(int.replace(/,/g, "") + (frac ? "." + frac : "")),
    sign, pre: sign ? lead.slice(1) : lead, suf, dec, grouped: int.includes(","),
    node: value,
  };
  // The refusal to guess. If the shape cannot reproduce the string it came from,
  // the formatter is doing something we have not modelled (leading zeros, a
  // locale's separators, a compression we would print as literal digits) and the
  // number is left alone.
  if (printShape(shape, shape.n) !== text) return null;
  // Serialised rather than joined with a delimiter: prefix and suffix are
  // arbitrary symbol runs, so any character picked as a separator is a character
  // one of them may contain, and two different scaffoldings sharing one key is the
  // exact failure this key exists to prevent.
  shape.key = JSON.stringify([sign, shape.pre, suf, dec]);
  return shape;
}

function Tweened({ shape }) {
  // THE TWEEN RUNS ON THE VALUE'S LAST DIGIT, NOT ON ITS UNITS. useTween rounds
  // its output to whole numbers at or above 1, so a money total handed over raw
  // would count in dollars and leave the cents frozen at ".00" for the whole
  // flight — the two digits the reader is watching would be the only two that
  // never moved. Scaling by the formatter's own decimal count gives the
  // interpolation exactly the resolution the call site is printing at, and hands
  // the "have we arrived" bound the same scale for free: half a unit of a hundred
  // is half a cent.
  const pow = shape.dec ? Math.pow(10, shape.dec) : 1;
  const [shown, atRest] = useNumberTween(shape.n * pow);
  return atRest || shown == null ? shape.node : printShape(shape, shown / pow);
}

// The one call every number slot in the kit makes. Returns the value untouched,
// or a tween wrapped around it — keyed by the scaffolding, for rule 3 above.
function instrument(value) {
  const shape = numberShape(value);
  return shape ? <Tweened key={shape.key} shape={shape} /> : value;
}

export function StatTile({ value, label, delta, deltaTone = "var(--green)", valueTone, onClick, selected, onCanvas, style }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={`stattile${onClick ? " tappable" : ""}${selected ? " selected" : ""}${onCanvas ? " on-canvas" : ""}`} onClick={onClick} style={style}>
      <span className="stattile-value" style={valueTone ? { color: valueTone } : undefined}>{instrument(value)}</span>
      <span className="stattile-label" style={selected ? { color: "var(--accent)" } : undefined}>{label}</span>
      {delta != null && <span className="stattile-delta" style={{ color: deltaTone }}>{instrument(delta)}</span>}
    </Tag>
  );
}

export function Delta({ pct, digits = 2, suffix = "%" }) {
  if (pct == null || isNaN(pct)) return null;
  const up = pct >= 0;
  // The glyph and the tone come from the TARGET, never from the frame in flight.
  // A delta crossing zero would otherwise flip its arrow and its colour mid-count
  // — and DESIGN.md §5 forbids animating colour at all — so direction is decided
  // once and only the magnitude moves. Formatting the value first and handing the
  // string to `instrument` is deliberate: the resting frame is then this
  // component's own output, character for character, as it has always been.
  return (
    <span className="t-num" style={{ color: up ? "var(--green)" : "var(--red)", fontSize: 12 }}>
      {up ? "▲" : "▼"} {instrument(Math.abs(pct).toFixed(digits) + suffix)}
    </span>
  );
}

/* ── status vocabulary — dot + quiet text, replaces filled badges ──────────── */
const STATE_META = {
  loading: { tone: "var(--faint)", label: "Loading" },
  live: { tone: "var(--green)", label: "Live", pulse: true },
  stale: { tone: "var(--amber)", label: "Stale" }, // served, but the source didn't refresh — no pulse
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
  const mounted = useRef(false);
  // Keep the active pill centred in ITS OWN STRIP when the selection changes.
  //
  // This used to be one scrollIntoView({ inline: "center" }) call, and that
  // was the bug behind "the Alt Season tab opens halfway down the page".
  // scrollIntoView scrolls *every scrollable ancestor* to reveal the element,
  // so a pill row that mounts below the fold — Movers, four cards down —
  // dragged the whole page down to itself the moment the panel rendered, and
  // did it with behavior:"smooth" so it landed AFTER the page's own
  // scroll-to-top had already run and finished. Nothing about centring a pill
  // inside a 44px strip needs the page to move.
  //
  // scrollBy on the row itself cannot touch an ancestor, which makes the fix
  // structural rather than a guard someone can forget. The mount pass stays
  // (a restored selection should start centred) but goes instant — a strip
  // animating itself on arrival is noise.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const el = row.querySelector(".pill.active");
    const first = !mounted.current;
    mounted.current = true;
    if (!el) return;
    const rowBox = row.getBoundingClientRect();
    const pillBox = el.getBoundingClientRect();
    const delta = (pillBox.left + pillBox.width / 2) - (rowBox.left + rowBox.width / 2);
    if (Math.abs(delta) < 1) return;
    row.scrollBy({ left: delta, behavior: first ? "auto" : "smooth" });
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
  // options: [{ key, label, sub? }] — equal width; thumb glides, no measuring.
  // Four is the comfortable ceiling; a fifth (Train's Rides tab) tightens the
  // type a notch rather than truncating "Routines" on a 390px phone.
  const idx = Math.max(0, options.findIndex((o) => (o.key ?? o) === value));
  const w = 100 / options.length;
  return (
    <div className={`seg${options.length > 4 ? " seg-tight" : ""}`} style={style}>
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
// Open sheets, oldest→newest. Only the top-most handles Escape, so a confirm
// layered over a form sheet doesn't dismiss both on one keypress.
const sheetStack = [];

// THE EXIT, AND WHY IT HAD TO BECOME THE SHEET'S OWN BUSINESS.
//
// Every one of the two dozen sheets in this app is conditionally rendered by its
// parent — `{open && <Sheet …/>}`, `{tile && <Sheet …/>}` — so for as long as
// they have existed an exit animation was not merely missing, it was
// structurally impossible: the frame the parent's flag flipped, the portal's DOM
// node was already gone, and no CSS can animate an element that isn't there. The
// only fix that doesn't touch twenty-four call sites is for the sheet to swallow
// the onClose it was handed, spend --dur-2 leaving, and tell the parent
// afterwards. (`.toast.out` has been doing exactly this since the toasts
// shipped. The grammar was understood; sheets never asked for it.)
//
// The price of holding that frame is that the sheet briefly outlives the truth,
// so the payload is FROZEN for the closing window. Title, header, footer, body
// style and children are cached on every open render, and the closing renders
// replay the cache. This is not belt-and-braces: most of these sheets read the
// very state the close clears — `{catFor && <Sheet>{catFor.merchant}</Sheet>}` is
// the common shape, and WorkoutPanel's "Finish workout" sheet, whose footer saves
// and then clears the workout it is printing, is the crashing one. Because the
// cached children are the *same element objects*, React's reference bailout means
// the subtree isn't re-rendered with stale props — it isn't re-rendered at all.
// The sheet that leaves is the sheet you were looking at.

/* THE PULL — the numbers that are the feel.
   Exported (with the two functions below) because they ARE the gesture: a smoke
   that cannot run them can only grep for them, and a threshold that has silently
   become 1200px still greps fine. See scripts/ambient-smoke.mjs. */
export const SHEET_DISMISS_PX = 120;   // travel past which a release lets go
export const SHEET_FLICK_VY = 0.55;    // px/ms — a throw beats the distance test
const SHEET_FLICK_MIN_PX = 20;         // …but a throw from nowhere is just a tap
const SHEET_AXIS_PX = 8;               // slop before a gesture has an axis at all
const SHEET_UP_GIVE = 64;              // asymptote when pulled where it can't go
const SHEET_LOCKED_GIVE = 28;          // asymptote for a sheet that cannot leave
const SHEET_STALE_VY_MS = 90;          // a pause before release is not a flick
// THE MARKS THAT MEAN "ANOTHER GESTURE ALREADY OWNS THIS FINGER", in one place,
// because there is more than one drag in this app now: the sheet's pull-to-dismiss
// and MobileShell's pull-to-refresh both begin with a finger travelling downward,
// and a region that only ONE of them declined is exactly the bug this constant
// exists to make impossible. A hold-and-drag to reorder starting at scrollTop 0
// armed the refresh as well as the reorder — the Brief's card order, the grocery
// list, both notes surfaces, every one of them a list whose first row is where
// scrollTop is 0 — because the sheet guarded `[data-sortable]` and the shell's
// gauge had never heard of it.
//
// SortableList's convention, borrowed rather than reinvented (it marks its
// containers `[data-sortable]` and its opt-outs `[data-no-drag]`), and its rule
// too: whichever gesture owner is nearest the thing you are actually pointing at
// wins.
export const DRAG_OPT_OUT = '[data-sortable], [data-no-drag], [contenteditable], [draggable="true"]';
// The sheet's own list is that plus everything that answers a tap or holds a
// caret, because a drag beginning on a button eats the tap and a slider's gesture
// is its own. Pull-to-refresh deliberately does NOT inherit the tap half — on a
// phone almost every row is a button or a pressable card, and a pull that declined
// them would have nowhere left to start. It refuses the fields by tag instead, in
// the ancestor walk it performs anyway (see MobileShell's onStart).
const SHEET_NO_DRAG = `button, a, input, textarea, select, label, [role="button"], ${DRAG_OPT_OUT}`;

// x·max/(x+max): 1:1 for small x, asymptotic to max, and no cap to hit. A cap
// has a corner in it, and you can feel the corner.
const band = (x, max) => (x * max) / (x + max);

// Resistance is spent only on directions the sheet refuses. Downward a
// dismissible sheet tracks the finger exactly — it is leaving, and anything less
// than 1:1 feels like the sheet is arguing with you. Upward there is nothing
// above the top edge to reveal, and a locked sheet (dismissible={false}) has
// nowhere to go at all: both get the band, so the honest answer to the pull is
// "it moves, it does not leave" rather than a handle that ignores you.
export function sheetPull(dy, dismissible = true) {
  if (dy <= 0) return -band(-dy, SHEET_UP_GIVE);
  return dismissible ? dy : band(dy, SHEET_LOCKED_GIVE);
}

// Distance OR speed, and a locked sheet answers neither.
export function sheetShouldDismiss(offset, vy, dismissible = true) {
  if (!dismissible || offset <= 0) return false;
  if (vy >= SHEET_FLICK_VY && offset >= SHEET_FLICK_MIN_PX) return true;
  return offset >= SHEET_DISMISS_PX;
}

// The closing window must be exactly as long as the CSS says the exit is, and the
// only way to guarantee that is to ask the CSS instead of restating it here.
// Cached after the first read: a getComputedStyle per sheet-open is a layout
// flush nobody needs, and this token cannot change under us (a theme flip swaps
// colours, never durations).
let sheetExitCache = null;
function sheetExitMs() {
  if (sheetExitCache != null) return sheetExitCache;
  let ms = 240; // --dur-2's authored value, for when there is no document to ask
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--dur-2").trim();
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) ms = /ms\s*$/.test(raw) ? n : n * 1000;
  } catch { /* keep the authored default */ }
  return (sheetExitCache = ms);
}

const mq = (q) => { try { return !!window.matchMedia?.(q).matches; } catch { return false; } };
// Both of these are read at gesture/close time rather than cached: the
// accessibility switch flips under a running app, and an iPad crosses the
// breakpoint by rotating.
const prefersStill = () => mq("(prefers-reduced-motion: reduce)");
// The same query string useIsMobile() uses in hooks/index.js — the bottom
// sheet's geometry and this gesture have to agree about what a phone is. Above
// it the sheet is a centred modal: no bottom edge to leave by, and its
// translate(-50%,-50%) is load-bearing, so a drag would fight the centring.
const phoneSheet = () => mq("(max-width: 760px)");

// What a sheet is ALLOWED to do, in one pure function of the two media queries,
// so the rule lives in a single place and can be executed rather than trusted.
// Reduced motion takes the exit window away entirely rather than shortening it: a
// held frame is the slide's whole cost with none of its benefit, and dragging a
// sheet around by hand is animation performed by hand. The drag additionally
// needs the bottom-sheet geometry — see phoneSheet above.
export function sheetPolicy({ still, phone }) {
  return { animateExit: !still, drag: !still && !!phone };
}
const allow = () => sheetPolicy({ still: prefersStill(), phone: phoneSheet() });

// Where a revived sheet goes back on the stack (see `revive` below), as
// arithmetic rather than as a splice buried in a component, because the tempting
// version is wrong in the direction that hurts. A parent that declines a close
// ASYNCHRONOUSLY has put another sheet above us by the time we come back —
// SeatNotesModal's onClose awaits a confirm — so pushing onto the end would claim
// we are on top and hand Escape to the sheet the user cannot see. Going back where
// we left from keeps the order that mounting created. Mutates in place: the stack
// is module state that a live keydown listener is already reading.
export function sheetRevive(stack, id, at) {
  if (stack.indexOf(id) >= 0) return stack; // already there; never twice
  stack.splice(Math.max(0, Math.min(at, stack.length)), 0, id);
  return stack;
}
// How long after telling the parent we wait before concluding it declined. React
// flushes a setState made from a timer in a later task, so this has to be more
// than zero; two frames is several tasks and is invisible either way, because the
// sheet is already off the bottom edge for the whole window.
const SHEET_REVIVE_MS = 32;

// A sheet's own controls — `footer` buttons especially — are created at the call
// site but MOUNT inside the sheet, and context is resolved by tree position, so
// they can reach this. It is how a "Done" button asks for the same exit the scrim
// gets instead of yanking the node out. Returns null outside a sheet so a caller
// can tell rather than silently no-op. A programmatic close ignores
// `dismissible`: that flag guards the gestures (scrim, Escape, the X), not the
// sheet's own logic. Pass a function to run once the sheet has finished leaving.
const SheetCloseCtx = createContext(null);
export function useSheetClose() { return useContext(SheetCloseCtx); }

// THE HOOK ONLY REACHES HALF THE CLOSES, AND IT IS THE SMALLER HALF.
// useSheetClose is useContext, and the provider is opened inside Sheet's own
// return — so it resolves only for a component whose render happens BELOW that
// provider. Authoring a <Button onClick={...}> at the call site does not qualify:
// the element mounts inside the sheet, but the closure is written in the render
// of the component ABOVE it, where the context is still null.
//
// That excludes essentially every real close in this app. Creed's Save and
// Delete, Dreams' Save and Remove, Notes' five bulk actions, Workout's
// addExercise, Finances' import onDone — all of them fire from a mutation
// callback in the PARENT's scope, after the write lands. No amount of moving
// buttons down the tree reaches a close that a promise upstairs initiates.
//
// So the parent gets a handle: pass `closeRef` to Sheet and it is populated with
// the same requestClose the scrim and the X use. Call it through closeSheet()
// below, which falls back to running the after-work directly when the ref is
// empty — a sheet that is already gone must still let its state be cleared, or
// the button reads as dead, which is a worse bug than a hard cut.
export function closeSheet(ref, after) {
  const close = ref && ref.current;
  if (close) close(after);
  else after?.();
}

// Phone: bottom sheet with grabber, drag to dismiss. ≥761px: centered modal.
// Scrim closes it. `detent` sets the resting height — see components.css.
export function Sheet({ onClose, title, headTrailing, footer, children, z = 300, bodyStyle, dismissible = true, detent = "auto", closeRef }) {
  const idRef = useRef(null);
  const dialogRef = useRef(null);
  const scrimRef = useRef(null);
  const bodyRef = useRef(null);
  const restoreFocusRef = useRef(null);
  if (!idRef.current) idRef.current = {};
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  // Set the frame a finger commits to a vertical drag, and never cleared (see
  // .sheet.grabbed). It is READ DURING RENDER on purpose: the class is added
  // imperatively so a gesture costs no re-render, and React's next className
  // write — the one that adds `out` — would otherwise strip it, handing the
  // transform back to the stylesheet in the middle of an exit.
  const grabbedRef = useRef(false);
  const dragRef = useRef(null);
  // Latest onClose/dismissible read through a ref so the keydown listener can be
  // registered once (stable stack order) without re-pushing on every rerender.
  const cbRef = useRef();
  cbRef.current = { onClose, dismissible };

  // The frozen payload. Written on every open render; replayed while closing.
  const lastRef = useRef(null);
  if (!closing) lastRef.current = { title, headTrailing, footer, children, bodyStyle, dismissible };
  const view = lastRef.current;

  // ── the transform, while JS owns it ────────────────────────────────────────
  const paint = (off) => {
    const el = dialogRef.current;
    if (el) el.style.transform = off ? `translateY(${off.toFixed(2)}px)` : "";
    // The scrim dims with the pull — the only cue that tells you the gesture is
    // going to work before you have committed to it. It never goes fully clear:
    // the sheet is still modal until it is actually gone.
    const s = scrimRef.current;
    if (s) s.style.opacity = off > 0 ? String(Math.max(0.4, 1 - off / (SHEET_DISMISS_PX * 2.5))) : "";
  };
  // Handing the transform back: the sheet springs home and the scrim comes back.
  // `transform: ""` transitions to whatever the stylesheet gives it, which on a
  // phone is no transform at all — so this one line is also correct if the
  // geometry ever changes.
  const snapBack = () => {
    const el = dialogRef.current;
    if (el) { el.style.transition = "transform var(--dur-3) var(--ease-spring)"; el.style.transform = ""; }
    const s = scrimRef.current;
    if (s) { s.style.transition = "opacity var(--dur-2) var(--ease-out)"; s.style.opacity = ""; }
  };
  // Continuing the throw. The CSS exit starts from where the stylesheet left the
  // sheet — the top of the screen — so using it on a dragged sheet would yank it
  // back up before dropping it. A thrown sheet leaves from where the finger let
  // go, in the same --dur-2 the class would have taken.
  const flyOut = () => {
    const el = dialogRef.current;
    if (el) { el.style.transition = "transform var(--dur-2) var(--ease-out)"; el.style.transform = "translateY(100%)"; }
    const s = scrimRef.current;
    if (s) { s.style.transition = "opacity var(--dur-2) ease"; s.style.opacity = "0"; }
  };

  // ── the close a parent is allowed to REFUSE ────────────────────────────────
  // Every sheet here is `{open && <Sheet/>}`, so "closed" means the parent
  // unmounted us — and a parent may decline. SeatNotesModal's onClose is
  // `if (dirty && !(await confirm(…))) return;`, and that shape used to brick the
  // whole app: the sheet had already taken itself off the stack, put on .out
  // (translateY(100%), pointer-events:none) and left the scrim up, whose .out rule
  // deliberately KEEPS its pointer-events so a tap during the exit can't land on a
  // card that isn't back yet. Nothing ever reset closingRef, so the sheet sat
  // off-screen and inert, Escape was dead, and a transparent fixed inset:0 scrim
  // ate every tap in the app until a reload.
  //
  // Making the contract safe beats documenting it. Two frames after the parent has
  // been told, a sheet that is STILL MOUNTED was not closed — so it comes back:
  // visible, dismissible again, on the stack at the index it left from, with the
  // scrim guarding a sheet you can see. An async decline reads exactly right on the
  // way through — the sheet stays open behind the question it asked, which is what
  // iOS does with a discard prompt — and the worst case if we conclude "declined"
  // a beat early is one frame of a sheet that then unmounts without its slide.
  const revive = (stackAt) => {
    // React nulls a ref on unmount, so the node IS the liveness test. It has to be
    // asked: reviving a dead id into sheetStack would take Escape away from every
    // sheet under it — the same bug wearing a different face.
    if (!dialogRef.current || !closingRef.current) return;
    closingRef.current = false;
    setClosing(false);
    sheetRevive(sheetStack, idRef.current, stackAt);
    // A thrown sheet was left at translateY(100%) by JS, and an inline transform
    // beats the stylesheet — so dropping .out and .grabbed changes nothing on
    // screen until these go too. With .grabbed off, `sheetin` becomes the element's
    // animation again and the sheet re-enters exactly the way it first arrived.
    grabbedRef.current = false;
    const el = dialogRef.current;
    el.classList.remove("grabbed");
    el.style.transition = "";
    el.style.transform = "";
    const s = scrimRef.current;
    if (s) { s.classList.remove("grabbed"); s.style.transition = ""; s.style.opacity = ""; }
    // requestClose blurred whatever was focused, so focus is on <body> and the trap
    // has nothing to hold. Take it back only if we are the top sheet again: the
    // thing that declined for us is usually a confirm sitting ON us with its own
    // trap, and pulling focus out of the dialog the user is answering is worse than
    // waiting for it to close.
    if (sheetStack[sheetStack.length - 1] === idRef.current) el.focus();
  };

  // ── the close the call sites never see ─────────────────────────────────────
  const requestClose = useCallback((after) => {
    if (closingRef.current) return;
    closingRef.current = true;
    // Any pointer still down loses the sheet here. Escape (or a footer button)
    // during a drag would otherwise leave two things writing the same transform:
    // the exit, and a finger that still thinks it owns the sheet. Dropping the
    // gesture makes every later pointermove/up a no-op instead of a fight.
    dragRef.current = null;
    // Focus and the iOS keyboard leave WITH the sheet rather than after it: a
    // caret still blinking in a sheet that is halfway off screen holds the
    // keyboard up for the whole exit, and then the unmount fights it on the way
    // down. The opener gets focus back from the unmount cleanup, as before.
    const active = document.activeElement;
    if (active instanceof HTMLElement && dialogRef.current?.contains(active)) active.blur();
    // Off the stack immediately. For --dur-2 this sheet is scenery, and the one
    // underneath should own Escape from the keypress that started this, not from
    // whenever an animation happens to finish.
    const i = sheetStack.indexOf(idRef.current);
    if (i >= 0) sheetStack.splice(i, 1);
    // …and back at that same index if the parent turns out to have declined — see
    // `revive` above. Scheduled from inside deliver so the two can never drift
    // apart: there is no route that tells the parent without also checking whether
    // the parent did anything about it.
    const deliver = () => {
      after?.();
      cbRef.current.onClose?.();
      window.setTimeout(() => revive(Math.max(0, i)), SHEET_REVIVE_MS);
    };
    // Reduced motion gets no window at all — see sheetPolicy. The check has to
    // come before the closing state, or these users pay 240ms for nothing.
    if (!allow().animateExit) { deliver(); return; }
    setClosing(true);
    if (grabbedRef.current) flyOut();
    // Deliberately not cleared on unmount. If something else tears this sheet
    // down mid-exit, the parent still has an `open` flag that has to come false;
    // a setState into an unmounted tree is a no-op in React 18, but a flag left
    // true is a screen that will not reopen. A 240ms timer nobody is waiting on
    // is the cheaper of the two failures by a wide margin.
    window.setTimeout(deliver, sheetExitMs());
  }, []);

  // Hand the parent the same close the scrim uses. A layout effect, so the ref is
  // populated before any child effect or event handler could reach for it, and
  // nulled on unmount so closeSheet() takes its direct-run fallback instead of
  // calling into a sheet that is no longer on screen.
  useLayoutEffect(() => {
    if (!closeRef) return;
    closeRef.current = requestClose;
    return () => { closeRef.current = null; };
  }, [closeRef, requestClose]);

  // ── the gesture ───────────────────────────────────────────────────────────
  const capture = (id) => { try { dialogRef.current?.setPointerCapture(id); } catch { /* capture is a nicety, not the mechanism */ } };
  const release = (id) => { try { if (dialogRef.current?.hasPointerCapture?.(id)) dialogRef.current.releasePointerCapture(id); } catch { /* already gone */ } };

  const beginDrag = (e, fromBody) => {
    if (closingRef.current) return;
    // Left button only, and first finger only — a second finger is a pinch or a
    // two-finger scroll, and neither of those is a request to close anything.
    if ((e.pointerType === "mouse" && e.button !== 0) || !e.isPrimary) return;
    // A gesture that never committed to an axis also never took pointer capture,
    // so it can be released off the sheet and never reach endDrag. Left in place
    // it would wedge every future drag out of existence. Uncommitted, it is
    // garbage; committed, this is a second finger and the first one keeps the
    // sheet.
    if (dragRef.current) { if (dragRef.current.axis) return; dragRef.current = null; }
    if (!allow().drag) return;
    if (fromBody) {
      // A body drag is only ever the top of the scroll; anywhere else the
      // gesture belongs to the scroller, and stealing it would make a long sheet
      // unreadable.
      if ((bodyRef.current?.scrollTop || 0) > 0) return;
      if (e.target?.closest?.(SHEET_NO_DRAG)) return;
    }
    dragRef.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, y: e.clientY, t: performance.now(), vy: 0, off: 0, axis: false, slop: 0, fromBody };
    // The handle is 17px tall and the finger is off it within a few pixels, so
    // capture at once. A body drag waits for the axis instead: capturing a
    // gesture the browser may still turn into a scroll is how you lose scrolling.
    if (!fromBody) capture(e.pointerId);
  };

  const onMove = (e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.axis) {
      if (Math.abs(dx) < SHEET_AXIS_PX && Math.abs(dy) < SHEET_AXIS_PX) return;
      // Horizontal wins → this was a swipe, a carousel or a text selection, and
      // never ours. Bail for good rather than waiting to see whether it turns
      // vertical: a gesture that changes its mind mid-flight and takes the sheet
      // with it is exactly how sheets earn a reputation for closing themselves.
      if (Math.abs(dx) > Math.abs(dy)) { dragRef.current = null; return; }
      // Upward from the top of a scroller is a scroll (and iOS may already have
      // claimed it). Only the handle may be pulled up, and only to resist.
      if (d.fromBody && dy < 0) { dragRef.current = null; return; }
      d.axis = true;
      d.slop = dy; // the sheet starts moving from HERE, so there is no 8px jump
      if (d.fromBody) capture(e.pointerId);
      grabbedRef.current = true;
      dialogRef.current?.classList.add("grabbed");
      scrimRef.current?.classList.add("grabbed");
      if (dialogRef.current) dialogRef.current.style.transition = "none";
      if (scrimRef.current) scrimRef.current.style.transition = "none";
    }
    const t = performance.now(), dt = t - d.t;
    if (dt > 0) d.vy = dt <= SHEET_STALE_VY_MS ? (e.clientY - d.y) / dt : 0;
    d.y = e.clientY; d.t = t;
    d.off = sheetPull(dy - d.slop, cbRef.current.dismissible);
    paint(d.off);
  };

  const endDrag = (e, released) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    dragRef.current = null;
    release(e.pointerId);
    if (!d.axis) return; // never committed; nothing moved, nothing to undo
    // pointercancel lands here too, and lands on snapBack: whatever the browser
    // decided, the sheet must never be left sitting mid-pull.
    if (released && sheetShouldDismiss(d.off, d.vy, cbRef.current.dismissible)) requestClose();
    else snapBack();
  };

  useEffect(() => {
    const id = idRef.current;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetStack.push(id);
    const focusable = () => [...(dialogRef.current?.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) || [])].filter((el) => !el.hasAttribute("hidden"));
    const focusInitial = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const preferred = dialog.querySelector("[autofocus]");
      (preferred || focusable()[0] || dialog).focus();
    };
    const focusTimer = window.setTimeout(focusInitial, 0);
    const onKey = (e) => {
      const { dismissible } = cbRef.current;
      // A closing sheet has already taken itself off the stack, so this reads
      // false for it and the sheet underneath owns the keyboard again.
      if (sheetStack[sheetStack.length - 1] !== id) return;
      if (e.key === "Escape") {
        if (dismissible) requestClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { e.preventDefault(); dialogRef.current?.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
      const i = sheetStack.indexOf(id);
      if (i >= 0) sheetStack.splice(i, 1);
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, []);
  // Portaled to <body>: page wrappers animate with transform, which makes
  // them the containing block for position:fixed — a sheet rendered in place
  // could sit above a live tab bar with a clipped scrim. At body level no
  // ancestor can interfere.
  // Every handler below goes through requestClose() wrapped in an arrow, never
  // passed by reference: requestClose takes an optional "run this after the exit"
  // callback, and handing it straight to onClick would pass it the click event to
  // call as a function.
  const grabbed = grabbedRef.current ? " grabbed" : "";
  const out = closing ? " out" : "";
  const held = detent === "medium" || detent === "large" ? ` detent-${detent}` : "";
  return createPortal(
    <SheetCloseCtx.Provider value={requestClose}>
      <div ref={scrimRef} className={`sheet-scrim${grabbed}${out}`} style={{ zIndex: z }}
        onClick={view.dismissible && !closing ? () => requestClose() : undefined} />
      <div className={`sheet${held}${grabbed}${out}`} ref={dialogRef} style={{ zIndex: z + 1 }} role="dialog" aria-modal="true"
        aria-label={typeof view.title === "string" ? view.title : undefined} tabIndex={-1}
        onPointerMove={onMove} onPointerUp={(e) => endDrag(e, true)} onPointerCancel={(e) => endDrag(e, false)}
        onLostPointerCapture={(e) => endDrag(e, false)}>
        {/* The grabber is now the thing it always looked like. It draws a handle,
            so it has to answer a drag — an affordance that does nothing is a lie
            the whole app pays for, because it teaches the user not to trust the
            other ones. */}
        <div className="sheet-grab" onPointerDown={(e) => beginDrag(e, false)} />
        {(view.title != null || view.headTrailing != null) && (
          <div className="sheet-head">
            <span className="t-title2" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{view.title}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
              {view.headTrailing}
              {/* Gate the X on dismissible like the scrim/Escape, so a locked
                  sheet (e.g. mid-import) can't be closed out from under the work. */}
              <button className="icon-btn" onClick={view.dismissible ? () => requestClose() : undefined} disabled={!view.dismissible} aria-label="Close"><IcClose size={19} /></button>
            </span>
          </div>
        )}
        <div className="sheet-body" ref={bodyRef} style={view.bodyStyle} onPointerDown={(e) => beginDrag(e, true)}>{view.children}</div>
        {view.footer && <div className="sheet-foot">{view.footer}</div>}
      </div>
    </SheetCloseCtx.Provider>,
    document.body
  );
}

// Promise-based confirm — the house replacement for window.confirm.
// const [confirmEl, confirm] = useConfirm();
// if (await confirm({ title: "Delete note?", message: "…", confirmLabel: "Delete", destructive: true })) …
export function useConfirm() {
  // The counter is the Sheet's key, and it is load-bearing now that closing takes
  // time. Two confirms back to back — the second awaited immediately after the
  // first resolves — set req to null and then to the new request inside one React
  // batch, so React never sees the null and reconciles ONE Sheet across both
  // questions. The second would inherit the first's finished `closing` state and
  // sit there frozen mid-exit, still showing the first question. A new key makes
  // it a new sheet, which is what it actually is.
  const seq = useRef(0);
  const [req, setReq] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setReq({ ...opts, resolve, seq: ++seq.current })), []);
  // The answer is RECORDED when a button is pressed and DELIVERED once the sheet
  // has finished leaving — which is why it lives in a ref instead of riding the
  // click. Every route out (button, scrim, Escape, the X) now goes through the
  // sheet's exit, and the sheet's onClose is the ONE place the promise settles, so
  // it cannot resolve twice or resolve while the sheet is still on screen. The
  // routes that record nothing are the routes that mean "no".
  const answer = useRef(false);
  const settle = () => { const v = answer.current; answer.current = false; req?.resolve(v); setReq(null); };
  const el = req ? (
    <Sheet key={req.seq} onClose={settle} title={req.title} z={480}
      footer={<ConfirmActions req={req} pick={(v) => { answer.current = v; }} fallback={settle} />}>
      {req.message && <div className="t-body" style={{ color: "var(--sub)", paddingBottom: 6 }}>{req.message}</div>}
    </Sheet>
  ) : null;
  return [el, confirm];
}

// Its own component only so it can be INSIDE the sheet: a `footer` element is
// created at the call site but mounts in the sheet's tree, and context is
// resolved by position, so from here the buttons can ask the sheet to leave the
// way the scrim does instead of yanking the node out from under themselves.
// `fallback` is what settles the promise if that context is ever missing — an
// await that never returns would strand a destructive flow in silence, and this
// hook is what the app uses instead of window.confirm.
function ConfirmActions({ req, pick, fallback }) {
  const close = useSheetClose();
  const answer = (v) => { pick(v); (close || fallback)(); };
  return (
    <>
      {req.cancelLabel !== false && (
        <Button kind="quiet" size="lg" style={{ flex: 1 }} onClick={() => answer(false)}>{req.cancelLabel || "Cancel"}</Button>
      )}
      <Button kind={req.destructive ? "danger-solid" : "primary"} size="lg" style={{ flex: 1 }} onClick={() => answer(true)}>
        {req.confirmLabel || "Confirm"}
      </Button>
    </>
  );
}

/* ── large-title page block ────────────────────────────────────────────────── */
// `leading` hangs a mark to the LEFT of the title. Only the TITLE shares that
// row — the sub stays on the block's own left edge, flush under the mark rather
// than indented to the title's first letter. The mark is the header's left
// margin; a sub that started inboard of it would give the block two competing
// left edges.
// The 5px nudge is optical: flex would centre the mark on the full 36.8px line
// box, which sits it visibly low against a cap-height-dominated title.
export function LargeTitle({ title, sub, trailing, leading, onTitleTap }) {
  return (
    <div className="lt-block" style={{ alignItems: "flex-start" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
          {leading && <span style={{ flex: "none", display: "inline-flex", marginTop: 5 }}>{leading}</span>}
          <h1 className="t-ltitle" style={{ margin: 0, minWidth: 0, cursor: onTitleTap ? "default" : undefined, WebkitUserSelect: "none", userSelect: "none" }} data-lt-sentinel onClick={onTitleTap}>{title}</h1>
        </div>
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
