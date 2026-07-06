// ─── Board Room design tokens ──────────────────────────────────────────────
// Same token SHAPE as clarify-outreach/theme.js and zts-command-center/theme.js
// (gold/ink/canvas/signals/type/radii/shadows) so the three apps stay easy to
// maintain side by side — but different VALUES on purpose. Board Room is your
// personal command center, not a business-facing tool, and keeps its own
// bronze/Roman identity (Cinzel display face, warmer cream canvas) rather than
// matching Clarify/ZTS's cooler gold-on-slate look.
//
// Extracted from the hex values already in use across App.jsx — nothing here
// changes how anything currently looks, it just gives those values one home.
// Note: the `syne` variable name still used at ~100 call sites in App.jsx
// actually holds the Cinzel font stack now (left over from the reskin) —
// this file uses honest names; renaming the call sites is separate work.

export const T = {
  // brand (bronze/gold range — Board Room uses more of this range than
  // Clarify/ZTS, which lean on a single gold)
  gold: "#B68A2E",       // shared value with Clarify/ZTS — same gold, coincidentally
  goldHi: "#C77416",
  goldDeep: "#A2700E",
  bronze: "#8F6B1E",
  bronzeDeep: "#6A4D12",
  bronzeWarm: "#9a7b4f",
  goldSoft: "rgba(143,107,30,0.06)",

  // ink & text
  ink: "#221D14",
  inkDeep: "#1A0F00",
  inkBrand: "#3A3323",
  muted: "#6C6455",
  faint: "#9A9280",

  // canvas
  bg: "#F3F1EC",
  surface: "#FFFFFF",
  subtle: "#FCFBF9",
  subtleAlt: "#F5F3EE",
  line: "rgba(58,51,35,0.08)",
  lineSoft: "rgba(58,51,35,0.06)",

  // signals
  red: "#B23A2E",
  blue: "#31589C",
  pink: "#EC4899",
  purple: "#7C3AED",
  purpleHi: "#8B5CF6",
  green: "#0E9F6E",
  greenDeep: "#1F7A55",
  greenDeep2: "#166042",
  btcOrange: "#F7931A", // Bitcoin's own brand orange — used for BTC-specific UI only, not a general signal color

  // type
  fontDisplay: "'Cinzel', 'Times New Roman', serif",
  fontBody: "'Inter', system-ui, sans-serif",
  fontMono: "'DM Mono', monospace",

  // radii
  rSm: "8px",
  rMd: "10px",
  rLg: "14px",
  rPill: "999px",

  // shadows
  shadowCard: "0 1px 2px rgba(58,51,35,0.05), 0 4px 16px rgba(58,51,35,0.05), 0 0 0 1px rgba(58,51,35,0.03)",
  shadowTab: "0 1px 2px rgba(58,51,35,0.08), 0 2px 6px rgba(58,51,35,0.06)",
  focusRing: "0 0 0 3px rgba(182,138,46,0.32)",
};

// One severity vocabulary — same meanings, same shape as the other two apps.
export const SEV = {
  critical: T.red,
  warning: T.goldHi,
  info: T.muted,
  pass: T.green,
};
