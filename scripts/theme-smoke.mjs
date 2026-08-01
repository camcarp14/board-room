// ─── Theme smoke — the 20 palettes, asserted ─────────────────────────────────
// Three classes of failure this catches, all of which ship silently otherwise:
//
//  1. DRIFT. themes.css (what the browser paints) and palettes.js (what the
//     picker draws swatches from) are both generated from the table in
//     scripts/gen-themes.mjs. Hand-edit either and the picker starts showing
//     colours the theme doesn't use — a UI that lies about what it does.
//  2. CONTRAST. 400 generated hex values; one bad lightness and a theme has
//     unreadable captions. Nothing else in the pipeline checks this.
//  3. MISSING TOKENS. A palette that forgets --surface-2 inherits it from the
//     base day/night definitions, so a card's inner well silently comes out the
//     wrong colour in exactly one of twenty themes.
//
// Run by `npm run verify`.

import { readFileSync } from "node:fs";
import { PALETTES, DEFAULT_PALETTE, paletteByKey } from "../src/design/palettes.js";

// WCAG relative luminance, implemented HERE rather than imported from the
// generator. Two reasons, both learned the hard way: importing that module ran it
// (it wrote its output files at import time, so this test regenerated the very
// files it was about to assert on, and passed unconditionally); and a test that
// borrows the implementation it is checking only proves self-consistency, not
// correctness. This is an independent second opinion on the same numbers.
const chan = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const css = readFileSync("src/design/themes.css", "utf8");
const REQUIRED = ["bg", "surface", "surface-2", "ink", "sub", "faint", "accent", "accent-hi", "accent-deep", "on-accent"];
// Floors must match FLOOR in gen-themes.mjs. Duplicated on purpose: if someone
// loosens the generator to make a colour they like pass, this still fails.
const FLOOR = { ink: 8, sub: 4.6, faint: 3.05, accent: 4.6, onAccent: 4.6 };

/** Pull one palette/mode block out of themes.css. */
function block(key, mode) {
  const re = new RegExp(`\\[data-palette="${key}"\\]\\[data-theme="${mode}"\\]\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/);
    if (kv) out[kv[1]] = kv[2].toUpperCase();
  }
  return out;
}

check("20 palettes are defined", PALETTES.length === 20, `got ${PALETTES.length}`);
check("palette keys are unique", new Set(PALETTES.map(p => p.key)).size === PALETTES.length);
check("the default palette exists", PALETTES.some(p => p.key === DEFAULT_PALETTE), DEFAULT_PALETTE);
check("paletteByKey falls back rather than returning undefined", !!paletteByKey("does-not-exist"));
// Porcelain is the app's original look; a regenerate must not quietly restyle the
// default out from under everyone who never opens the picker.
const porcelain = paletteByKey("porcelain");
check("the default palette is still warm paper + bronze",
  porcelain.day.bg.startsWith("#F") && contrast(porcelain.day.accent, porcelain.day.bg) >= FLOOR.accent);

// The derived layer must exist, or every palette loses --line/--glass/--scrim.
check("themes.css carries the derived [data-palette] layer", /\[data-palette\]\s*\{[^}]*--line:/.test(css));
check("derived layer covers both modes",
  /\[data-palette\]\[data-theme="day"\]/.test(css) && /\[data-palette\]\[data-theme="night"\]/.test(css));

for (const p of PALETTES) {
  for (const mode of ["day", "night"]) {
    const b = block(p.key, mode);
    if (!b) { check(`${p.key}/${mode} block exists in themes.css`, false); continue; }

    const missing = REQUIRED.filter(k => !b[k]);
    check(`${p.key}/${mode} defines all ${REQUIRED.length} tokens`, missing.length === 0, missing.join(", "));

    // DRIFT: the four values the picker renders must be byte-identical to the CSS.
    const swatch = p[mode];
    const drift = ["bg", "surface", "accent", "ink"].filter(k => swatch[k]?.toUpperCase() !== b[k]);
    check(`${p.key}/${mode} swatch matches themes.css`, drift.length === 0,
      drift.map(k => `${k}: js=${swatch[k]} css=${b[k]}`).join("; "));

    // CONTRAST, against the page ground AND a card — the accent lands on both.
    for (const ground of ["bg", "surface"]) {
      check(`${p.key}/${mode} ink on ${ground} ≥ ${FLOOR.ink}:1`, contrast(b.ink, b[ground]) >= FLOOR.ink, contrast(b.ink, b[ground]).toFixed(2));
      check(`${p.key}/${mode} sub on ${ground} ≥ ${FLOOR.sub}:1`, contrast(b.sub, b[ground]) >= FLOOR.sub, contrast(b.sub, b[ground]).toFixed(2));
      check(`${p.key}/${mode} faint on ${ground} ≥ ${FLOOR.faint}:1`, contrast(b.faint, b[ground]) >= FLOOR.faint, contrast(b.faint, b[ground]).toFixed(2));
      check(`${p.key}/${mode} accent on ${ground} ≥ ${FLOOR.accent}:1`, contrast(b.accent, b[ground]) >= FLOOR.accent, contrast(b.accent, b[ground]).toFixed(2));
    }
    check(`${p.key}/${mode} on-accent over accent ≥ ${FLOOR.onAccent}:1`, contrast(b["on-accent"], b.accent) >= FLOOR.onAccent, contrast(b["on-accent"], b.accent).toFixed(2));

    // Surfaces have to be separable or cards dissolve into the page.
    check(`${p.key}/${mode} surface reads as lifted off bg`, contrast(b.surface, b.bg) >= 1.04, contrast(b.surface, b.bg).toFixed(3));
    check(`${p.key}/${mode} surface-2 reads as a well inside surface`, contrast(b["surface-2"], b.surface) >= 1.03, contrast(b["surface-2"], b.surface).toFixed(3));
  }
}

// Two themes that resolve to the same ground are the same theme wearing two names.
for (const field of ["bg", "accent"]) {
  for (const mode of ["day", "night"]) {
    const vals = PALETTES.map(p => p[mode][field]);
    const dupes = vals.filter((v, i) => vals.indexOf(v) !== i);
    check(`${mode} ${field}s are all distinct`, dupes.length === 0, [...new Set(dupes)].join(", "));
  }
}

// VARIANCE. The first cut of these palettes pinned every light ground to ~95% and
// every dark ground to ~5%, so all twenty read as the same brightness in different
// hues — twenty picks that felt like three. Distinct hexes alone don't catch that
// (95% vs 95.4% are "distinct"), so assert the actual spread: light grounds must
// range from dim paper to near-white, dark from true-black to soft charcoal.
const hslL = (h) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) * 100;
};
const spread = (mode) => {
  const ls = PALETTES.map(p => hslL(p[mode].bg));
  return { lo: Math.min(...ls), hi: Math.max(...ls), range: Math.max(...ls) - Math.min(...ls) };
};
const day = spread("day"), night = spread("night");
check("light grounds span ≥ 8 lightness points", day.range >= 8, `${day.lo.toFixed(0)}%–${day.hi.toFixed(0)}% (${day.range.toFixed(1)} pts)`);
check("dark grounds span ≥ 10 lightness points", night.range >= 10, `${night.lo.toFixed(0)}%–${night.hi.toFixed(0)}% (${night.range.toFixed(1)} pts)`);
check("at least one genuinely dim light theme (≤ 90%)", day.lo <= 90, `dimmest is ${day.lo.toFixed(0)}%`);
check("at least one near-white light theme (≥ 96%)", day.hi >= 96, `brightest is ${day.hi.toFixed(0)}%`);
check("at least one true-black dark theme (≤ 5%)", night.lo <= 5, `darkest is ${night.lo.toFixed(0)}%`);
check("at least one soft-charcoal dark theme (≥ 13%)", night.hi >= 13, `lightest is ${night.hi.toFixed(0)}%`);

// The pre-paint script sets data-palette from this exact key, and reads the
// fallback ground from CSS. If the localStorage key ever changes here without
// changing index.html, every relaunch flashes the default palette.
const html = readFileSync("index.html", "utf8");
check("index.html pre-paint reads br_palette", /localStorage\.getItem\("br_palette"\)/.test(html));
check("index.html pre-paint stamps data-palette", /setAttribute\("data-palette"/.test(html));
check("index.html pre-paint still stamps data-theme", /setAttribute\("data-theme"/.test(html));

// The grounds are INLINED in index.html because the stylesheet link is emitted
// after that script — getComputedStyle returns empty there, in dev and in prod.
// So this is a third copy of the same data, and the one with teeth: it paints the
// strip behind the iOS status bar on the very first frame, and a wrong value is a
// visible seam above the app until React boots. Assert it byte-for-byte.
const gm = html.match(/var G = (\{.*?\});/s);
check("index.html carries the generated grounds map", !!gm);
if (gm) {
  let G = null;
  try { G = JSON.parse(gm[1]); } catch { /* reported below */ }
  check("the grounds map is valid JSON", !!G);
  if (G) {
    check("grounds map covers every palette", Object.keys(G).length === PALETTES.length, `${Object.keys(G).length} vs ${PALETTES.length}`);
    const bad = PALETTES.filter(p => {
      const g = G[p.key];
      return !g || g[0]?.toUpperCase() !== p.day.bg.toUpperCase() || g[1]?.toUpperCase() !== p.night.bg.toUpperCase();
    }).map(p => p.key);
    check("every ground matches palettes.js (iOS status-bar seam)", bad.length === 0, bad.join(", "));
    check("the default palette is present as the fallback", !!G[DEFAULT_PALETTE]);
  }
}

// ─── The status-bar strip, and the top of the screen ─────────────────────────
// The bar at the top used to be a different colour from the app: with
// "black" iOS sizes the window BELOW the status bar and paints that strip flat
// black itself, which matches a near-black palette and clashes with every other
// one. Nothing in CSS could reach it — env(safe-area-inset-top) is 0 in that
// mode and the strip is outside the web view entirely.
//
// Under "black-translucent" the window runs under the status bar, so the app's
// own ground paints it and there is no seam by construction. Every piece of that
// has to stay true together, and each one fails silently on its own:
const chrome = readFileSync("src/design/components.css", "utf8");
const shell = readFileSync("src/shell/MobileShell.jsx", "utf8");

check("the window extends under the status bar",
  /apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/.test(html),
  html.match(/apple-mobile-web-app-status-bar-style"[^>]*/)?.[0]);
// Without viewport-fit=cover every env(safe-area-inset-*) reads 0 and the app
// draws UNDER the notch with no reservation — the title lands beneath the clock.
check("the viewport opts into the safe areas", /viewport-fit=cover/.test(html));
check("the shell reserves the strip", /className="statuscap"/.test(shell));
// The point of the whole change. An opaque fill here just swaps iOS's grey cap
// for one of ours: same hard edge, one shade closer. It must stay transparent so
// the ambient wash — which is a gradient — carries through it.
check("…and paints nothing there, so the room shows through",
  !/statuscap[^}]*background/.test(chrome.replace(/\[data-theme="day"\][^}]*\}/g, "")),
  "an opaque statuscap re-creates the bar it replaced");
check("the strip is exactly the inset tall",
  /\.statuscap \{[^}]*height: env\(safe-area-inset-top\)/.test(chrome));

// iOS draws status-bar glyphs WHITE under black-translucent, with no way to ask
// for dark ones. On a light palette that is invisible unless something darkens
// the strip — and the first attempt faded out ABOVE the clock, measuring 2.2:1
// at the glyph line while looking perfectly fine in a screenshot.
{
  const day = chrome.match(/\[data-theme="day"\] \.statuscap \{([\s\S]*?)\}/)?.[1] || "";
  check("light palettes scrim the strip so the clock stays readable", /linear-gradient/.test(day));
  const stops = [...day.matchAll(/rgba\(0, 0, 0, ([\d.]+)\)(?:\s+(\d+)%)?/g)]
    .map((m) => ({ a: parseFloat(m[1]), at: m[2] === undefined ? null : parseInt(m[2], 10) }));
  check("…at full strength where the glyphs actually are, not just at the top",
    stops.some((s) => s.a >= 0.5 && s.at !== null && s.at >= 50),
    "the scrim fades out before ~22px down a 59px inset — measured 6:1 at the glyph line when correct");
  check("…and fading to nothing by the bottom, so it has no edge",
    stops.some((s) => s.a === 0), day.trim());
}
// Dark palettes must get NO scrim: white on a dark room is already right, and a
// scrim there would be the grey bar this replaced.
check("dark palettes are left alone", !/\[data-theme="night"\] \.statuscap/.test(chrome));

// The recorded risk of black-translucent: an older iOS anchored the window at
// the top while sizing it short, leaving dead space at the BOTTOM. This is the
// detection and the collapse that make the failure mode survivable.
check("the letterbox fallback is still wired", /letterboxed/.test(shell) && /\.lbx \.dock-tab/.test(chrome));

// The tab bar's safe-area padding stays INSIDE the button, which is what makes
// the band above the home indicator live tap area instead of dead chrome.
//
// Read the RULE BODY first rather than pattern-matching across the file. The
// obvious one-liner (/\.dock-tab \{[\s\S]*?padding:[^;]*env\(…\)/) passes even
// after the inset is moved off the tab, because the lazy match walks straight
// through the closing brace and finds .sheet-foot's padding thirty rules later.
// It looked like a check and asserted nothing.
{
  const rule = chrome.match(/\n\.dock-tab \{([\s\S]*?)\n\}/)?.[1] || "";
  check("the .dock-tab rule is readable", !!rule.trim());
  check("the home-indicator band is part of the tab's tap target",
    /padding:[^;]*env\(safe-area-inset-bottom\)/.test(rule), rule.match(/padding:[^;]*/)?.[0]);
}

console.log(`\n${failed ? `${failed} FAILURE(S)` : "THEME SMOKE: ALL CLEAN"}`);
if (failed) { console.error("THEME SMOKE FAILED"); process.exit(1); }
