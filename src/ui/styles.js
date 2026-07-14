import { T, syne, mono } from "../theme.js";

// ─── Design system ────────────────────────────────────────────────────────────
// Tokens live in theme.js as CSS variables; styles.css defines their Daylight
// and Nocturne values, so every inline style below follows the room's theme.
// The plate system: every card is a quiet plate with a hairline edge —
// no stripes, no glow. Titles are engraved (Cinzel small caps, wide tracking).
// Brass is spent in exactly three places: the active mark, the primary
// action, and live data. Shadows exist only on things that float.
export const S = {
  card: { padding: "20px 22px", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 14, boxShadow: "none" },
  cardM: { padding: "17px 16px", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 13, boxShadow: "none" },
  inner: { background: "transparent", border: `1px solid ${T.line}`, borderRadius: 10 },
  title: { fontSize: 11, fontWeight: 600, fontFamily: syne, color: T.ink, letterSpacing: "0.18em", textTransform: "uppercase" },
  microLabel: { fontSize: 9, color: T.faint, fontFamily: mono, letterSpacing: "0.14em", textTransform: "uppercase" },
  brassBtn: { background: T.brass, border: "none", borderRadius: 9, color: T.onBrass, fontWeight: 700, fontFamily: syne, letterSpacing: "0.04em", cursor: "pointer", boxShadow: "none" },
  ghostBtn: { background: "transparent", border: `1px solid ${T.lineStrong}`, borderRadius: 9, color: T.sub, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" },
  input: { background: T.surface2, border: `1px solid ${T.lineStrong}`, borderRadius: 9, color: T.ink },
};

// Tint any color — literal or var() — without string math on hex codes.
export const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
