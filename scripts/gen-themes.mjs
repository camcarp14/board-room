// ─── Palette generator — the single source of truth for the 20 themes ────────
// Emits BOTH src/design/themes.css (what the browser reads) and
// src/design/palettes.js (labels + swatches for the picker). Generating both from
// one table is the point: hand-maintaining 400 hex values in CSS and another 120
// in JS guarantees they drift, and a drifted swatch means the picker lies about
// what you are choosing.
//
// Why only TEN authored tokens per palette per mode: every other colour in the
// app already derives from these through color-mix in tokens.css — the whole
// --ink-a* / --accent-a* ladder, --line, --glass, --focus-ring. Override --ink
// and the eighteen ink-alpha steps follow for free. That design is what makes 20
// themes a data table instead of a rewrite.
//
// SEVENTEEN NOW, BECAUSE THE SEMANTIC COLOURS WERE NEVER ACTUALLY VALIDATED HERE.
// green/red/amber/blue/purple/pink/btc used to be the exception to all of the
// above: authored once in tokens.css, never overridden, on the grounds that they
// mean something fixed (good / bad / warning) and re-tinting them per theme would
// spend meaning on decoration. That argument holds for HUE and only for hue. It
// was quietly also holding lightness fixed, against two surfaces those colours
// never meet in nineteen of twenty palettes — see the survey above
// deriveSemantic() for what that measured. So each one is now solved per palette:
// same hue, same or greater chroma, lightness moved as little as the palette's own
// surfaces allow. Porcelain and Graphite are pinned to the authored values, since
// those two ARE the designed rooms and must not shift by a digit. Shadows stay
// mode-level in tokens.css; they are opacity over the ground, not colour.
//
// Every generated value is contrast-checked against WCAG AA before it's written.
// Run: node scripts/gen-themes.mjs   (verify asserts the output is in sync)

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ─── colour maths ────────────────────────────────────────────────────────────
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return seg.map(v => Math.round((v + m) * 255));
}
const hex = ([r, g, b]) => "#" + [r, g, b].map(v => clamp(v, 0, 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const hsl = (h, s, l) => hex(hslToRgb(h, s, l));

const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
};
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// The inverse of hsl(), needed because the semantic colours are authored as hex
// in tokens.css (where DESIGN.md §3 documents them) and have to be taken apart
// before they can be re-solved. Standard HSL extraction; s is undefined for a
// grey and reported as 0, which is what the chroma maths below wants anyway.
function hexToHsl(x) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: s * 100, l: l * 100 };
}

/** Walk lightness from `start` in `dir` until `color(L)` clears `target` against
 *  `against`. Returns the first passing value — the closest to the intended tone
 *  that still meets AA, rather than a blanket dark/light that flattens the theme. */
function tune(make, against, target, start, dir) {
  let best = make(start);
  for (let L = start; L >= 0 && L <= 100; L += dir) {
    const c = make(L);
    best = c;
    if (contrast(c, against) >= target) return c;
  }
  return best; // ran out of range — the validator below will flag it
}

// ─── the table ───────────────────────────────────────────────────────────────
// nH/nS  = neutral (background + text) hue and saturation — the "paper"
// aH/aS  = accent hue and saturation — the one metal/colour the theme spends
// dL/nL  = how LIGHT the ground is in each mode. This is the axis that was
//          missing: every theme sat at ~95% light / ~5% dark, so all twenty read
//          as the same brightness wearing different hues. Now light grounds run
//          87→97 (dim muted paper → near-white) and dark grounds 3→18 (true-black
//          OLED → soft charcoal), so picking a theme changes the VALUE of the room
//          and not just its temperature.
// Tuned so no two adjacent entries in the picker read as the same idea.
const THEMES = [
  { key: "porcelain", label: "Porcelain",  blurb: "Warm paper and bronze — the house default",  nH: 45,  nS: 14, aH: 42,  aS: 65 , dL: 95, nL: 5 },
  { key: "graphite",  label: "Graphite",   blurb: "Neutral grey under cool steel",              nH: 40,  nS: 3,  aH: 215, aS: 30 , dL: 95, nL: 8 },
  { key: "lapis",     label: "Lapis",      blurb: "Deep imperial blue under roman gold",        nH: 226, nS: 30, aH: 43,  aS: 62 , dL: 93, nL: 4 },
  { key: "slate",     label: "Slate",      blurb: "Cool grey and steel",                        nH: 213, nS: 14, aH: 211, aS: 62 , dL: 96, nL: 14 },
  { key: "forest",    label: "Forest",     blurb: "Deep green, sage highlight",                 nH: 152, nS: 18, aH: 148, aS: 48 , dL: 94, nL: 6 },
  { key: "claret",    label: "Claret",     blurb: "Oxblood and old rose",                       nH: 350, nS: 16, aH: 348, aS: 55 , dL: 91, nL: 10 },
  { key: "ink",       label: "Ink",        blurb: "Near-black paper, cold cyan",                nH: 200, nS: 8,  aH: 189, aS: 70 , dL: 97, nL: 3 },
  { key: "navy",      label: "Navy",       blurb: "Naval blue with brass fittings",             nH: 218, nS: 26, aH: 30,  aS: 72 , dL: 92, nL: 5 },
  { key: "plum",      label: "Plum",       blurb: "Aubergine and lilac",                        nH: 288, nS: 18, aH: 280, aS: 52 , dL: 93, nL: 11 },
  { key: "moss",      label: "Moss",       blurb: "Olive and cream, field-notes green",         nH: 78,  nS: 16, aH: 96,  aS: 55 , dL: 90, nL: 7 },
  { key: "copper",    label: "Copper",     blurb: "Oxidised metal, warm and worked",            nH: 24,  nS: 20, aH: 22,  aS: 62 , dL: 89, nL: 9 },
  { key: "teal",      label: "Teal",       blurb: "Deep teal cut with coral",                   nH: 186, nS: 20, aH: 12,  aS: 62 , dL: 95, nL: 12 },
  { key: "iris",      label: "Iris",       blurb: "Indigo and periwinkle",                      nH: 250, nS: 22, aH: 252, aS: 58 , dL: 94, nL: 6 },
  { key: "arctic",    label: "Arctic",     blurb: "Ice white over deep polar blue",             nH: 200, nS: 22, aH: 205, aS: 68 , dL: 97, nL: 16 },
  { key: "ember",     label: "Ember",      blurb: "Charcoal with a live coal in it",            nH: 20,  nS: 10, aH: 14,  aS: 72 , dL: 88, nL: 4 },
  { key: "mono",      label: "Mono",       blurb: "Pure greyscale — the accent is the ink",      nH: 0,   nS: 0,  aH: 0,   aS: 0  , dL: 96, nL: 3 },
  { key: "sand",      label: "Sand",       blurb: "Desert paper, dusty blue accent",            nH: 38,  nS: 22, aH: 208, aS: 42 , dL: 91, nL: 13 },
  { key: "rose",      label: "Rose",       blurb: "Grey with dusty pink",                       nH: 340, nS: 8,  aH: 342, aS: 48 , dL: 94, nL: 18 },
  { key: "pine",      label: "Pine",       blurb: "Black-green and pale gold",                  nH: 165, nS: 24, aH: 55,  aS: 70 , dL: 90, nL: 4 },
  { key: "oxide",     label: "Oxide",      blurb: "Iron grey and rust",                         nH: 15,  nS: 6,  aH: 18,  aS: 58 , dL: 87, nL: 15 },
];

// ─── derivation ──────────────────────────────────────────────────────────────
// Contrast floors. `ink` is body copy; `sub` is secondary copy that must still
// read comfortably; `faint` is captions and timestamps — the app leans on it more
// than a typical "disabled" grey, so it gets a real floor rather than 1.5:1.
const FLOOR = { ink: 8, sub: 4.6, faint: 3.05, accent: 4.6, onAccent: 4.6 };

// ─── the seven semantic colours, solved per palette ──────────────────────────
// WHAT THIS FIXES, MEASURED FIRST. The seven were authored once against #FFFFFF
// and #1C1C1E — the Porcelain card and the Graphite card — and then inherited
// unchanged by twenty palettes whose own surfaces run from #EBE9E8 (oxide, day)
// to #4D4435 (sand night's well). Measured across all 280 palette×colour pairs
// before a line of this was written:
//
//     against --surface-2 : 220 pairs under 4.5:1, 52 under 3:1
//     against --surface   : 147 under 4.5:1, 24 under 3:1
//     against --bg        : 131 under 4.5:1
//
// The worst of them were arctic/night and rose/night --red at 2.94:1 on their own
// card, which is the Docket's "Overdue" tag at 11.5px, and every light palette's
// --btc at 1.7–2.3:1, which is the ₿ disc on the Brief.
//
// THE FLOORS ARE TWO REAL WCAG NUMBERS, NOT ONE COMFORTABLE ONE.
// 4.5:1 is AA for normal text, and the six status/series colours are worn by text
// on the page and on cards — Status labels and Docket tags at 11.5px, destructive
// cell titles at 15.5px — so --bg and --surface get 4.5. --surface-2 is the well
// and the inner stat tile, where these colours dress .stattile-value at 19px/600
// — AA large text, which is 3:1 — so that ground gets 3.0. That split is not a
// convenience but arithmetic: contrast is luminance only, and on sand's well (#4D4435)
// a FULLY saturated #FF0000 measures 2.39:1. No red of any chroma clears 4.5:1
// there. The colours that do are the ones with green and blue mixed back in —
// #FF9E9E gets 4.85:1 — and a red that pale is a pink, which is the one thing the
// chroma clamp below exists to prevent. Taste is not what sets this boundary.
// The one 11.5px item that lands in a well is .stattile-delta, and it stays below
// AA — as it does today in both designed rooms (Graphite --red measures 3.25:1 on
// --surface-2). This change does not introduce that; it stops it getting worse.
//
// --btc IS A BRAND FILL, NOT A STATUS. It means "Bitcoin", not good or bad, and it
// is never text: both call sites (BriefPage, SidebarShell) are a filled 16–20px
// disc carrying its own dark glyph. A filled shape is a non-text object, so it is
// held to 1.4.11's 3:1 and no more — which keeps it recognisably Bitcoin orange
// instead of solving it into a brown that happens to pass a text floor.
const SEM_TEXT = { bg: 4.5, surface: 4.5, "surface-2": 3.0 };
const SEM_MARK = { bg: 3.0, surface: 3.0, "surface-2": 3.0 };
// Deliberately not exported. theme-smoke.mjs keeps its own copy of this list and
// of the floors below, for the reason spelled out where PALETTES is built: a test
// that imports the thing it is checking only proves self-consistency, and this
// module's exports are the door that mistake came through last time.
const SEMANTIC = ["green", "red", "amber", "blue", "purple", "pink", "btc"];
const SEM_FLOOR = Object.fromEntries(SEMANTIC.map(k => [k, k === "btc" ? SEM_MARK : SEM_TEXT]));

// PORCELAIN AND GRAPHITE ARE PINNED. They are the two designed rooms — DESIGN.md
// §3 prints their hexes — and Cameron reads one of them every day. A generator
// that "improved" the default palette's red would restyle the app out from under
// the only user it has. So those two keep the authored values verbatim, which also
// means the pins are the one place the floors above are not met (Porcelain's
// --green measures 3.92:1 on its own ground, --btc 2.07:1). That is a design
// decision to make deliberately, in tokens.css, not a number for this file to
// quietly move.
const PINNED = new Set(["porcelain", "graphite"]);

// tokens.css stays the source of truth for what each colour MEANS: it is where
// DESIGN.md documents them, where the day/night fallbacks live for a document with
// no [data-palette] yet, and where the alpha ladders (--red-a32, --green-a06 …)
// color-mix off them. Parsed rather than duplicated here — two lists of fourteen
// hexes would drift, and a drifted --red is a Docket tag that changes colour when
// you switch palettes for an unrelated reason.
const TOKENS_CSS = readFileSync(new URL("../src/design/tokens.css", import.meta.url), "utf8");
function authoredSemantics(selector) {
  const at = TOKENS_CSS.indexOf(selector);
  if (at < 0) throw new Error(`gen-themes: tokens.css has no "${selector}" block to read the semantic colours from`);
  const body = TOKENS_CSS.slice(at, TOKENS_CSS.indexOf("\n}", at));
  const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2].toUpperCase();
  const missing = SEMANTIC.filter(k => !out[k]);
  if (missing.length) throw new Error(`gen-themes: tokens.css ${selector} is missing --${missing.join(", --")}`);
  return Object.fromEntries(SEMANTIC.map(k => [k, out[k]]));
}
const AUTHORED = {
  day: authoredSemantics(':root, [data-theme="day"] {'),
  night: authoredSemantics('[data-theme="night"] {'),
};

// HSL chroma — the (1-|2L-1|)·S term hslToRgb multiplies out. Holding it is the
// whole reason a lightened red stays a red: pink is not a hue, it is a light red
// with the chroma taken out of it, and naïvely raising L does exactly that (at
// L=50 a saturation of 71 carries full chroma; at L=72 the same 71 carries little
// over half of it). So as lightness moves, saturation is solved to hold the
// authored chroma — CLAMPED so this can only ever hold or raise chroma, never
// drop it, and capped a bounded distance above the authored saturation so nothing
// solves its way into neon.
const S_HEADROOM = 30;
const chromaOf = (s, l) => (1 - Math.abs(2 * (l / 100) - 1)) * s;
function satAt(chroma, l, s0) {
  const k = 1 - Math.abs(2 * (l / 100) - 1);
  return k <= 0.001 ? 100 : clamp(chroma / k, Math.min(s0, 100), Math.min(100, s0 + S_HEADROOM));
}

/** Solve one semantic colour against one palette's three surfaces.
 *  Hue is held exactly; chroma is held or raised; only lightness searches, and it
 *  searches in ONE direction — darker on a light ground, lighter on a dark one —
 *  which is what makes a single walk able to satisfy all three surfaces at once:
 *  contrast against every one of them moves the same way as L leaves the middle.
 *  The walk starts at the authored lightness and stops at the first passing step,
 *  so a colour moves as little as its palette demands, and one that already clears
 *  its floors is returned as the authored hex itself — not a round-trip through
 *  HSL that could shift it a digit for nothing. */
function deriveSemantic(name, mode, grounds, pinned) {
  const authored = AUTHORED[mode][name];
  if (pinned) return authored;
  const floor = SEM_FLOOR[name];
  const clears = (c) => Object.keys(floor).every(g => contrast(c, grounds[g]) >= floor[g]);
  if (clears(authored)) return authored;
  const { h, s: s0, l: l0 } = hexToHsl(authored);
  const chroma = chromaOf(s0, l0);
  const dir = mode === "night" ? +1 : -1;
  let best = authored;
  for (let L = l0; L >= 0 && L <= 100; L += dir * 0.5) {
    best = hsl(h, satAt(chroma, L, s0), L);
    if (clears(best)) return best;
  }
  return best; // ran out of range — the validator below will flag it
}

function build(t, mode) {
  const dark = mode === "night";
  const { nH, nS, aH, aS, dL, nL } = t;
  // Backgrounds and surfaces: authored, not tuned — these ARE the theme's look.
  // Light: tinted paper with a near-white card above it. Dark: deep ground, card
  // lifted off it. surface-2 is the well *inside* a card, so it moves toward the
  // background in light mode and away from it in dark.
  // Ground lightness leans a hair on the neutral saturation so no two dark
  // backgrounds resolve to the same hex — two themes that look identical on the
  // phone would make four of the twenty picks pointless.
  // Grounds are per-theme now, and the surfaces derive FROM the ground rather than
  // sitting at fixed lightness — a card pinned to 99.5% is invisible on a 97% page
  // and a well pinned to 17% is invisible on a 18% one. Deltas keep the card
  // lifted and the well recessed at every point in the range.
  const gL = dark ? nL : dL;
  const bg       = hsl(nH, Math.min(nS, dark ? 30 : 22), gL);
  const surfL = dark ? gL + 6.5 : Math.min(99.6, gL + 4.6);
  const surface  = hsl(nH, Math.min(nS, dark ? 22 : 10), surfL);
  // The well is defined relative to the CARD, not the page: on the brightest
  // themes the card clamps near white, and a well pinned to the ground ended up
  // fractions of a point from it — an invisible inner surface on 2 of 20 themes.
  const surface2 = dark ? hsl(nH, Math.min(nS, 18), gL + 12.5) : hsl(nH, Math.min(nS, 16), surfL - 3.2);

  // Text: tuned against bg until each floor is met, starting from the intended
  // tone and moving only as far as it has to.
  // Text lands on the page, on cards, AND in wells. Light-mode text is dark, so its
  // hardest ground is the DARKEST of the three (the page); dark-mode text is light,
  // so its hardest ground is the LIGHTEST (the well). Tuning against the page alone
  // is what made faint unreadable inside cards on all twenty dark themes.
  const textGround = dark ? surface2 : bg;
  const ink   = tune(L => hsl(nH, Math.min(nS, 12), L), textGround, FLOOR.ink,   dark ? gL + 78 : gL - 80, dark ? +1 : -1);
  const sub   = tune(L => hsl(nH, Math.min(nS, 10), L), textGround, FLOOR.sub,   dark ? gL + 52 : gL - 48, dark ? +1 : -1);
  const faint = tune(L => hsl(nH, Math.min(nS, 8),  L), textGround, FLOOR.faint, dark ? gL + 32 : gL - 30, dark ? +1 : -1);

  // The accent has to clear AA against BOTH the page and a card, since it lands
  // on each (active nav item on the canvas, primary button label on a card).
  const accentBase = dark ? Math.max(52, gL + 50) : Math.min(46, gL - 56);
  const accentDir = dark ? +1 : -1;
  let accent = tune(L => hsl(aH, aS, L), bg, FLOOR.accent, accentBase, accentDir);
  for (const ground of [surface, surface2]) {
    if (contrast(accent, ground) < FLOOR.accent) accent = tune(L => hsl(aH, aS, L), ground, FLOOR.accent, accentBase, accentDir);
  }
  // hi/deep are the hover and pressed steps — same hue, one notch either side.
  const accentL = accentLightness(accent, aH, aS);
  const accentHi   = hsl(aH, aS, clamp(accentL + (dark ? 10 : 8), 0, 100));
  const accentDeep = hsl(aH, aS, clamp(accentL - (dark ? 14 : 9), 0, 100));
  // Text sitting ON the accent (primary button label). Tuned against the accent.
  const onAccent = tune(
    L => hsl(aH, Math.min(aS, 35), L),
    accent, FLOOR.onAccent,
    contrast(accent, "#FFFFFF") >= FLOOR.onAccent ? 99 : 10,
    contrast(accent, "#FFFFFF") >= FLOOR.onAccent ? -1 : +1,
  );
  // The semantic seven, against this palette's own three surfaces rather than
  // against the two they were authored on.
  const grounds = { bg, surface, "surface-2": surface2 };
  const pinned = PINNED.has(t.key);
  const semantic = Object.fromEntries(SEMANTIC.map(k => [k, deriveSemantic(k, mode, grounds, pinned)]));
  return { bg, surface, "surface-2": surface2, ink, sub, faint, accent, "accent-hi": accentHi, "accent-deep": accentDeep, "on-accent": onAccent, ...semantic };
}
// Recover the lightness we landed on, so hi/deep step from the tuned value.
function accentLightness(target, h, s) {
  let best = 50, bestD = Infinity;
  for (let L = 0; L <= 100; L += 0.5) {
    const d = Math.abs(lum(hsl(h, s, L)) - lum(target));
    if (d < bestD) { bestD = d; best = L; }
  }
  return best;
}

const PALETTES = THEMES.map(t => ({ ...t, day: build(t, "day"), night: build(t, "night") }));

// Everything below only runs when this file is EXECUTED, never on import.
// theme-smoke.mjs used to import `contrast` from here, which ran the generator as
// a side effect of the import — so the smoke test regenerated index.html and
// themes.css before asserting anything about them, and could not fail. An
// assertion that cannot fail is worse than no assertion: it reads as coverage.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  // ─── validate before writing ─────────────────────────────────────────────────
  const problems = [];
  for (const p of PALETTES) {
    for (const mode of ["day", "night"]) {
      const v = p[mode];
      const chk = (name, fg, bgc, floor) => {
        const c = contrast(fg, bgc);
        if (c < floor) problems.push(`${p.key}/${mode}: ${name} ${fg} on ${bgc} = ${c.toFixed(2)}:1 (need ${floor})`);
      };
      chk("ink",   v.ink,   v.bg, FLOOR.ink);
      chk("sub",   v.sub,   v.bg, FLOOR.sub);
      chk("faint", v.faint, v.bg, FLOOR.faint);
      chk("ink-on-surface", v.ink, v.surface, FLOOR.ink);
      chk("sub-on-surface", v.sub, v.surface, FLOOR.sub);
      chk("faint-on-surface", v.faint, v.surface, FLOOR.faint);
      chk("accent-on-bg", v.accent, v.bg, FLOOR.accent);
      chk("accent-on-surface", v.accent, v.surface, FLOOR.accent);
      chk("on-accent", v["on-accent"], v.accent, FLOOR.onAccent);
      // surfaces must actually be distinguishable, or cards vanish into the page
      if (contrast(v.surface, v.bg) < 1.04) problems.push(`${p.key}/${mode}: surface is indistinguishable from bg`);
      if (contrast(v["surface-2"], v.surface) < 1.03) problems.push(`${p.key}/${mode}: surface-2 is indistinguishable from surface`);
      // The semantic seven, on all three grounds. The pinned palettes are checked
      // for IDENTITY instead of contrast: their floors are knowingly unmet (see
      // PINNED), and asserting a number nobody intends to meet only teaches the
      // next person to loosen it.
      for (const s of SEMANTIC) {
        if (PINNED.has(p.key)) {
          if (v[s] !== AUTHORED[mode][s]) problems.push(`${p.key}/${mode}: --${s} is ${v[s]}, but the pin says ${AUTHORED[mode][s]}`);
          continue;
        }
        for (const g of ["bg", "surface", "surface-2"]) chk(`${s}-on-${g}`, v[s], v[g], SEM_FLOOR[s][g]);
        // Holding the hue is the promise that keeps these colours MEANING what
        // they mean; a solver allowed to rotate red toward orange would clear
        // every contrast floor above and quietly turn "overdue" into "warning".
        // 0.5° is round-trip slop through 8-bit RGB, nothing more.
        const drift = Math.abs(hexToHsl(v[s]).h - hexToHsl(AUTHORED[mode][s]).h);
        if (Math.min(drift, 360 - drift) > 0.5) problems.push(`${p.key}/${mode}: --${s} drifted ${drift.toFixed(1)}° off its authored hue`);
      }
    }
  }
  if (problems.length) {
    console.error(`✗ ${problems.length} contrast problem(s):`);
    for (const p of problems) console.error("  " + p);
    process.exit(1);
  }

  // ─── emit ────────────────────────────────────────────────────────────────────
  const ORDER = ["bg", "surface", "surface-2", "ink", "sub", "faint", "accent", "accent-hi", "accent-deep", "on-accent", ...SEMANTIC];
  const banner = `/* GENERATED by scripts/gen-themes.mjs — do not edit by hand.
     Run \`node scripts/gen-themes.mjs\` after changing the table in that file;
     \`npm run verify\` fails if this file and palettes.js drift out of sync.

     ${PALETTES.length} palettes × light/dark. Each authors only the ${ORDER.length} tokens the
     rest of the system derives from — the --ink-a* / --accent-a* ladders, --line,
     --glass, --focus-ring and the --red-a* / --amber-a* / --green-a* steps in
     tokens.css are all color-mix over these, so they follow automatically.

     The last seven are the semantic colours, solved against THIS palette's own
     --bg / --surface / --surface-2: same hue and no less chroma than the values
     tokens.css authors, lightness moved only as far as the palette's surfaces
     demand. Porcelain and Graphite carry the authored values exactly — they are
     the two designed rooms. Shadows stay in tokens.css; they are opacity over the
     ground rather than colour. */\n`;

  let css = banner + `
  /* Derived from the ten authored tokens, so every palette gets these free. Sits
     after tokens.css (styles.css import order) and matches its specificity, so it
     wins; a [data-palette][data-theme] block below is more specific still. */
  [data-palette] {
    --line: color-mix(in srgb, var(--ink) 10%, transparent);
    --line-strong: color-mix(in srgb, var(--ink) 20%, transparent);
    --seg-bg: color-mix(in srgb, var(--ink) 6%, transparent);
    --glass: color-mix(in srgb, var(--bg) 82%, transparent);
    --glass-raised: color-mix(in srgb, var(--surface) 90%, transparent);
  }
  [data-palette][data-theme="day"] {
    --seg-thumb: var(--surface);
    --chip-ink: #FFFFFF;
    --scrim: color-mix(in srgb, var(--ink) 42%, transparent);
  }
  [data-palette][data-theme="night"] {
    --seg-thumb: color-mix(in srgb, var(--ink) 14%, transparent);
    --chip-ink: var(--bg);
    --scrim: color-mix(in srgb, #000000 62%, transparent);
  }
  `;
  for (const p of PALETTES) {
    for (const mode of ["day", "night"]) {
      css += `\n/* ${p.label} · ${mode === "day" ? "light" : "dark"} — ${p.blurb} */\n`;
      css += `[data-palette="${p.key}"][data-theme="${mode}"] {\n`;
      for (const k of ORDER) css += `  --${k}: ${p[mode][k]};\n`;
      css += `}\n`;
    }
  }
  writeFileSync("src/design/themes.css", css);

  const js = `// GENERATED by scripts/gen-themes.mjs — do not edit by hand.
  // The picker's list, and the status-bar colour per palette. Full palettes live in
  // design/themes.css; only what the UI needs to render a swatch is duplicated
  // here, and theme-smoke asserts the two never drift.

  export const PALETTES = [
  ${PALETTES.map(p => `  { key: "${p.key}", label: "${p.label}", blurb: "${p.blurb}",
      day: { bg: "${p.day.bg}", surface: "${p.day.surface}", accent: "${p.day.accent}", ink: "${p.day.ink}" },
      night: { bg: "${p.night.bg}", surface: "${p.night.surface}", accent: "${p.night.accent}", ink: "${p.night.ink}" } },`).join("\n")}
  ];

  export const DEFAULT_PALETTE = "porcelain";
  export const paletteByKey = (key) => PALETTES.find(p => p.key === key) || PALETTES[0];
  `;
  writeFileSync("src/design/palettes.js", js);

  // The pre-paint script in index.html needs the grounds BEFORE any CSS exists (the
  // stylesheet link is emitted after it), so they're inlined there rather than read
  // from the cascade. Generated here so there is still exactly one source of truth.
  const grounds = "        var G = " + JSON.stringify(
    Object.fromEntries(PALETTES.map(p => [p.key, [p.day.bg, p.night.bg]]))
  ) + ";";
  const htmlPath = "index.html";
  let html = readFileSync(htmlPath, "utf8");
  const START = "/* THEME-GROUNDS:GENERATED — scripts/gen-themes.mjs */";
  const END = "/* /THEME-GROUNDS */";
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a === -1 || b === -1) {
    console.error("✗ index.html is missing the THEME-GROUNDS markers — cannot emit the pre-paint map");
    process.exit(1);
  }
  // index.html is CRLF in this repo; preserve whatever it already uses so the
  // generated line doesn't show up as a whole-file diff.
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  html = html.slice(0, a + START.length) + eol + grounds + eol + "        " + html.slice(b);
  writeFileSync(htmlPath, html);

  console.log(`✓ ${PALETTES.length} palettes × 2 modes — all contrast floors met`);
  console.log(`  wrote index.html pre-paint grounds`);
  console.log(`  wrote src/design/themes.css (${css.split("\n").length} lines)`);
  console.log(`  wrote src/design/palettes.js`);

}
