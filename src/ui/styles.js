import { T } from "../theme.js";

// ─── Legacy style object ──────────────────────────────────────────────────────
// SESSION note: new and migrated code uses the kit (ui/kit.jsx) and the CSS
// classes in design/components.css — NOT this object. S remains only so any
// surface awaiting migration renders coherently on the new tokens: cards lose
// their outlines and pick up the house shadow, titles drop the engraved-caps
// voice, buttons take the new radii. Do not add new entries.
export const S = {
  card: { padding: 20, background: T.surface, border: "none", borderRadius: 18, boxShadow: "var(--shadow-card)" },
  cardM: { padding: 16, background: T.surface, border: "none", borderRadius: 18, boxShadow: "var(--shadow-card)" },
  inner: { background: "var(--surface-2)", border: "none", borderRadius: 12 },
  title: { fontSize: 17, fontWeight: 600, fontFamily: "var(--font-body)", color: T.ink, letterSpacing: "-0.01em", textTransform: "none" },
  microLabel: { fontSize: 11, color: T.faint, fontFamily: "var(--font-mono)", letterSpacing: "0.05em", textTransform: "uppercase" },
  brassBtn: { background: T.accent, border: "none", borderRadius: 12, color: T.onAccent, fontWeight: 600, fontFamily: "var(--font-body)", letterSpacing: "-0.008em", cursor: "pointer", boxShadow: "none" },
  ghostBtn: { background: "var(--ink-a06)", border: "none", borderRadius: 12, color: T.ink, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" },
  input: { background: T.surface2, border: "none", borderRadius: 12, color: T.ink },
};

// Tint any color — literal or var() — without string math on hex codes.
export const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
