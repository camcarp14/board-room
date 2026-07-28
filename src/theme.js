import { DEFAULT_PALETTE, paletteByKey } from "./design/palettes.js";

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
const PALETTE_KEY = "br_palette";
const AMBIENT_KEY = "br_ambient";

// Two INDEPENDENT axes, deliberately:
//   mode    — auto | day | night  (auto follows the device, as it always has)
//   palette — which of the 20 colour schemes
// Folding them into one list of 20 flat themes would have cost the auto
// light/dark behaviour, which is load-bearing here: the iOS status bar follows
// system appearance on an installed PWA, so a pinned-light app under a dark
// system clashes at the very top of the screen. 20 palettes × 2 modes keeps that
// and is strictly more capable.
export function getPalettePref() {
  try { return localStorage.getItem(PALETTE_KEY) || DEFAULT_PALETTE; } catch { return DEFAULT_PALETTE; }
}
export function setPalettePref(key) {
  try { localStorage.setItem(PALETTE_KEY, key); } catch {}
}
/** The browser-chrome colour for a mode under the CURRENT palette. This drives
 *  <meta name="theme-color">, which on an installed iOS app paints the strip
 *  behind the status bar — get it wrong and there's a visible seam above the
 *  app. Falls back to the default palette if the stored key is unknown. */
export function themeColor(resolved, paletteKey = getPalettePref()) {
  const p = paletteByKey(paletteKey);
  return (resolved === "night" ? p.night.bg : p.day.bg);
}

// ─── The third axis: ambience ────────────────────────────────────────────────
// Whether the drifting light behind the room is drawn at all (design/ambient.css
// + shell/Ambient.jsx). Default ON — it is the house look — and stored as an
// explicit "off" so an unset key, a cleared browser, and a new device all agree.
// Users on prefers-reduced-motion keep the light and lose the drift; that is a
// CSS decision, not this one, so the two settings compose instead of fighting.
export function getAmbientPref() {
  try { return localStorage.getItem(AMBIENT_KEY) !== "off"; } catch { return true; }
}
export function setAmbientPref(on) {
  try { localStorage.setItem(AMBIENT_KEY, on ? "on" : "off"); } catch {}
}

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

export function applyTheme(resolved, { animate = false, palette } = {}) {
  const root = document.documentElement;
  const nextPalette = palette || getPalettePref();
  // Either axis changing is a repaint. Checking both matters: switching palette
  // while the mode is unchanged used to early-return and do nothing.
  if (root.dataset.theme === resolved && root.dataset.palette === nextPalette) return;
  root.dataset.theme = resolved;
  root.dataset.palette = nextPalette;
  const bg = themeColor(resolved, nextPalette);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = bg;
  // Cross-fade with a one-shot veil, never per-element color transitions —
  // an always-on color transition with a var() endpoint wedges Chromium's
  // transition engine on theme flips and freezes elements at the old palette.
  if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const veil = document.createElement("div");
    veil.style.cssText = `position:fixed;inset:0;z-index:3000;pointer-events:none;background:${bg};opacity:0.9;transition:opacity 460ms cubic-bezier(0.22,1,0.36,1)`;
    document.body.appendChild(veil);
    requestAnimationFrame(() => requestAnimationFrame(() => { veil.style.opacity = "0"; }));
    window.setTimeout(() => veil.remove(), 540);
  }
}
