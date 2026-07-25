// ─── tint ─────────────────────────────────────────────────────────────────────
// The legacy `S` inline-style object lived here through the Porcelain/Graphite
// migration. Every importer now takes only `tint`, so S is gone; use the kit
// (ui/kit.jsx) and the classes in design/components.css.

// Tint any color — literal or var() — without string math on hex codes.
export const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
