// ─── Cross-panel pieces ───────────────────────────────────────────────────────
// Small things more than one page depends on, moved out of App.jsx during the
// SESSION restructure. Names and contracts unchanged; anatomy re-voiced.

import { useState, useRef, useLayoutEffect } from "react";
import { T } from "../theme.js";
import { Status } from "./kit.jsx";

/* Stance pill (BTC outlook): quiet tinted capsule, readable size. */
export function StancePill({ text, color }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, color, background: `color-mix(in srgb, ${color} 10%, transparent)`,
      padding: "5px 11px", borderRadius: 999, letterSpacing: "0.02em", whiteSpace: "nowrap", flex: "none",
    }}>{text}</span>
  );
}

/* Card health vocabulary — the five states every Brief card reports.
   Kept as data (label/color) for call sites that read it; the visual is now
   the kit's <Status> (dot + quiet text), not a filled badge. */
export const CARD_STATES = {
  loading: { label: "…", color: T.faint },
  live: { label: "Live", color: T.green },
  notconfigured: { label: "Not connected", color: T.amber },
  error: { label: "Error", color: T.red },
  nofn: { label: "Not deployed", color: T.red },
};
export function StatusTag({ status }) {
  return <Status state={status?.state || "loading"} title={status?.detail} />;
}

/* Note color seals. */
export const NOTE_SEALS = [
  { key: "brass", c: T.accent }, { key: "green", c: T.green },
  { key: "blue", c: T.blue }, { key: "red", c: T.red },
];
export const sealColor = (key) => NOTE_SEALS.find(s => s.key === key)?.c || null;

/* A note card's body preview: stored newlines render as real lines and the card
   grows to fit the note, up to `maxHeight`. Past that it caps with a soft
   gradient fade (not a hard ellipsis) — and the fade only appears when the text
   truly overflows, so short notes render crisp with no dimmed last line. */
export function NoteCardPreview({ text, fontSize = 13, color = T.sub, lineHeight = 1.5, maxHeight = 140, fadePx = 30, style }) {
  const ref = useRef(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollHeight > maxHeight + 1);
    measure();
    let ro;
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(measure); ro.observe(el); }
    return () => ro?.disconnect();
  }, [text, maxHeight]);
  const fade = `linear-gradient(to bottom, #000 calc(100% - ${fadePx}px), transparent)`;
  return (
    <div
      ref={ref}
      style={{
        fontSize, color, lineHeight,
        whiteSpace: "pre-wrap", overflowWrap: "break-word",
        transition: "max-height 220ms ease",
        ...style,
        ...(clipped ? { maxHeight, overflow: "hidden", WebkitMaskImage: fade, maskImage: fade } : null),
      }}
    >
      {text}
    </div>
  );
}

/* ── Plain-text list ergonomics for note bodies ───────────────────────────────
   Enter continues a "- " bullet (Enter on an empty bullet ends the list);
   toggleBulletAtCaret flips the caret's line. apply(next, caret) contract:
   set state, then restore the caret after React re-renders. */
export function continueListOnEnter(e, value, apply) {
  if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey) return false;
  const ta = e.target;
  const s = ta.selectionStart, en = ta.selectionEnd;
  if (s == null || s !== en) return false;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const m = value.slice(lineStart, s).match(/^(\s*)- (.*)$/);
  if (!m) return false;
  e.preventDefault();
  if (!m[2].trim()) {
    apply(value.slice(0, lineStart) + value.slice(s), lineStart);
  } else {
    const ins = "\n" + m[1] + "- ";
    apply(value.slice(0, s) + ins + value.slice(en), s + ins.length);
  }
  return true;
}

export function toggleBulletAtCaret(ta, value, apply) {
  const s = ta && ta.selectionStart != null ? ta.selectionStart : value.length;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const rest = value.slice(lineStart);
  if (/^\s*- /.test(rest)) {
    apply(value.slice(0, lineStart) + rest.replace(/^(\s*)- /, "$1"), Math.max(lineStart, s - 2));
  } else {
    apply(value.slice(0, lineStart) + "- " + value.slice(lineStart), s + 2);
  }
}
