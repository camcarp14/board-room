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
// All three values of apple-mobile-web-app-status-bar-style have now been tried
// on a real phone. These checks pin the survivor, because the two that lost both
// look right in code and fail only on the device:
//
//   · "black-translucent" lets the app paint the strip — the only way to remove
//     the seam — and STILL letterboxes on current iOS: the window is sized as if
//     the status bar were opaque but anchored at y=0, so the app pays for it
//     twice and a dead ~59pt chin sits under the tab bar. Not fixable from
//     inside; you cannot render outside your own window.
//   · "default" is a white cap with dark glyphs — fine over a light palette,
//     indefensible over a dark one.
//   · "black" costs a seam over any ground that isn't near-black, and that seam
//     is unreachable from CSS. It is the only one with no dead space.
//
// A fourth attempt should start by reading index.html, not by changing this.
const chrome = readFileSync("src/design/components.css", "utf8");
const shell = readFileSync("src/shell/MobileShell.jsx", "utf8");

check("the status bar style is the one that doesn't letterbox",
  /apple-mobile-web-app-status-bar-style"\s+content="black"/.test(html),
  html.match(/apple-mobile-web-app-status-bar-style"[^>]*/)?.[0]);
// Without viewport-fit=cover every env(safe-area-inset-*) reads 0, including the
// bottom one — the tab bar would sit on top of the home indicator.
check("the viewport opts into the safe areas", /viewport-fit=cover/.test(html));

// The strip reservation stays: inert under "black" (the inset is 0), correct the
// moment the inset is real. What it must NOT have is a background.
check("the shell reserves the strip", /className="statuscap"/.test(shell));
check("the strip is exactly the inset tall",
  /\.statuscap \{[^}]*height: env\(safe-area-inset-top\)/.test(chrome));

// THE ONE THIS FILE EXISTS FOR NOW. A scrim here was shipped to keep white
// status-bar glyphs legible over a light palette, and it was wrong twice over:
// the glyphs are not white (this iOS follows the page's `color-scheme` and drew
// them dark), and the gradient smeared the top of every light screen. It looked
// completely fine in a headless screenshot and only failed on a phone.
//
// Slice the rule by brace, not by regex. Two regexes have now silently asserted
// nothing in this file: one whose lazy match walked through a closing brace into
// a rule thirty lines later, and one whose {0,400} cap found no match at all and
// so passed an empty string to a `!test`. A negative check against a pattern
// that failed to match is the most comfortable kind of green there is.
{
  const at = chrome.indexOf(".statuscap {");
  check("the .statuscap rule is findable", at >= 0);
  const rule = at < 0 ? "MISSING" : chrome.slice(at, chrome.indexOf("}", at) + 1);
  check("nothing paints the strip — no scrim, no fill",
    at >= 0 && !/background|linear-gradient/.test(rule), rule.trim());
  check("…and no palette adds one back",
    !/\[data-theme="(day|night)"\] \.statuscap/.test(chrome),
    "a per-theme statuscap rule is the smear returning");
}

// Kept even though "black" never triggers it: it is the detection that made the
// black-translucent failure legible rather than mysterious, and the next attempt
// will need it.
check("the letterbox detection is still wired", /letterboxed/.test(shell) && /\.lbx \.dock-tab/.test(chrome));

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
