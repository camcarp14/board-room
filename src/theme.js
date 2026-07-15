// ─── SESSION design tokens — the bridge between design/tokens.css and JSX ────
// Every value here is a CSS custom property defined (twice) in tokens.css:
// once for Porcelain, once for Graphite. Inline styles that reference T.*
// re-resolve automatically when [data-theme] flips — no re-render needed.
// Anything that draws to a real canvas (lightweight-charts) can't use var()
// and should resolve literals through cssVar() at draw time instead.

export const syne = "var(--font-display)"; // historical name — now the system stack
export const mono = "var(--font-mono)";

export const T = {
  bg: "var(--bg)",
  surface: "var(--surface)",
  surface2: "var(--surface-2)",
  ink: "var(--ink)",
  sub: "var(--sub)",
  faint: "var(--faint)",
  accent: "var(--accent)",
  accentHi: "var(--accent-hi)",
  accentDeep: "var(--accent-deep)",
  onAccent: "var(--on-accent)",
  brass: "var(--accent)",
  brassHi: "var(--accent-hi)",
  brassDeep: "var(--accent-deep)",
  onBrass: "var(--on-accent)",
  line: "var(--line)",
  lineStrong: "var(--line-strong)",
  green: "var(--green)",
  red: "var(--red)",
  amber: "var(--amber)",
  blue: "var(--blue)",
  purple: "var(--purple)",
  pink: "var(--pink)",
  btc: "var(--btc)",
};

// One severity vocabulary across the app.
export const SEV = {
  critical: T.red,
  warning: T.amber,
  info: T.sub,
  pass: T.green,
};

// Resolve a CSS variable to its literal value (canvas renderers need this).
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ─── Theme controller — the room follows the sun ─────────────────────────────
// Preference lives in localStorage (must apply before auth/data, no flash):
//   "auto" (default) — Nocturne from 19:00 to 07:00, Daylight otherwise
//   "day" / "night"  — pinned
// index.html runs the same logic inline pre-paint; these keep it live after.

const THEME_KEY = "br_theme";
export const THEME_COLORS = { day: "#F2F1EB", night: "#000000" };

export function getThemePref() {
  try { return localStorage.getItem(THEME_KEY) || "auto"; } catch { return "auto"; }
}

export function setThemePref(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch {}
}

export function resolveTheme(pref = getThemePref(), d = new Date()) {
  if (pref === "day" || pref === "night") return pref;
  // auto → match the device's own light/dark setting. This also keeps the
  // iOS status bar (which follows system appearance on an installed web app)
  // in agreement with the app instead of clashing. Fall back to the sun
  // (Graphite 19:00–07:00) only if the media query isn't available.
  try {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day";
    }
  } catch {}
  const h = d.getHours();
  return h >= 19 || h < 7 ? "night" : "day";
}

export function applyTheme(resolved, { animate = false } = {}) {
  const root = document.documentElement;
  if (root.dataset.theme === resolved) return;
  root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[resolved] || THEME_COLORS.day;
  // Cross-fade with a one-shot veil, never per-element color transitions —
  // an always-on color transition with a var() endpoint wedges Chromium's
  // transition engine on theme flips and freezes elements at the old palette.
  if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const veil = document.createElement("div");
    veil.style.cssText = `position:fixed;inset:0;z-index:3000;pointer-events:none;background:${THEME_COLORS[resolved] || THEME_COLORS.day};opacity:0.9;transition:opacity 460ms cubic-bezier(0.22,1,0.36,1)`;
    document.body.appendChild(veil);
    requestAnimationFrame(() => requestAnimationFrame(() => { veil.style.opacity = "0"; }));
    window.setTimeout(() => veil.remove(), 540);
  }
}
