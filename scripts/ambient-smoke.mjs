// ─── Ambient smoke — the wash, asserted ──────────────────────────────────────
// The ambient layer is the one part of the design system whose failure mode is
// SILENT: it is decoration, nothing depends on it, no test renders it, and if it
// stops painting the app still looks fine — just flat. That is exactly how it
// shipped broken the first time.
//
// Four classes of failure this catches:
//
//  1. THE STACKING BUG. .ambient sits at z-index -1, which in the root stacking
//     context paints AFTER html's background but BEFORE any in-flow block's
//     background. So the moment anything upstream of it in the tree paints an
//     opaque ground — body, #root — the wash disappears completely and in total
//     silence. It cost a measured pixel-diff to find. It gets a test.
//  2. HARD-CODED COLOUR. Every ambient colour must be color-mix over the palette
//     tokens; one literal hex and nineteen of the twenty colour schemes get a
//     wash belonging to the twentieth.
//  3. AN UNGATED ANIMATION. Three full-screen composited layers drifting forever
//     is precisely what prefers-reduced-motion exists to stop.
//  4. A HALF-DEFINED RECIPE. Light and dark author the tints separately (day
//     lifts the accent toward --surface, night uses it raw). Miss a token in one
//     mode and it inherits the other's, which is either invisible or garish.
//
// Run by `npm run verify`.

import { readFileSync } from "node:fs";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const ambient = readFileSync("src/design/ambient.css", "utf8");
const styles = readFileSync("src/styles.css", "utf8");
const component = readFileSync("src/shell/Ambient.jsx", "utf8");
const app = readFileSync("src/App.jsx", "utf8");
const theme = readFileSync("src/theme.js", "utf8");

/** Strip /* … *​/ comments so prose about a rule never satisfies a test for it. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const aCode = code(ambient);
const sCode = code(styles);

// ── 1. nothing opaque may paint over the layer ───────────────────────────────
// body and #root are the two elements between html's ground and .ambient. A
// `background` shorthand counts too — `background: var(--bg)` is just as fatal
// as `background-color`.
for (const sel of ["body", "#root"]) {
  const re = new RegExp(`(^|[,{}\\s])${sel.replace("#", "#")}\\s*(,[^{]*)?\\{([^}]*)\\}`, "gm");
  let opaque = null;
  for (const m of sCode.matchAll(re)) {
    const body = m[3];
    const bg = body.match(/background(-color)?\s*:\s*([^;]+)/);
    if (bg && !/transparent|none/.test(bg[2])) opaque = bg[0].trim();
  }
  check(`${sel} paints no opaque ground (it would hide .ambient)`, !opaque, opaque ? `— found "${opaque}"` : "");
}
// html, by contrast, MUST keep its ground: it is the canvas colour, and the
// wash is drawn on top of it rather than instead of it.
check("html still paints the ground", /html\s*\{[^}]*background\s*:\s*var\(--bg\)/.test(sCode));

// ── 2. wiring ────────────────────────────────────────────────────────────────
check("ambient.css is imported by styles.css", /@import\s+["'].\/design\/ambient\.css["']/.test(styles));
check("ambient.css is imported after themes.css (palette must win first)",
  styles.indexOf("themes.css") < styles.indexOf("ambient.css"));
check("App renders <Ambient>", /<Ambient\s+on=\{theme\.ambient\}/.test(app));
check("App renders it above the auth gate", app.indexOf("const ambient =") < app.indexOf("const gate ="));
check("the layer is inert", /aria-hidden="true"/.test(component));

// ── 3. geometry that makes it a background and not an obstacle ───────────────
const layer = aCode.match(/\.ambient\s*\{([^}]*)\}/)?.[1] || "";
check(".ambient is fixed", /position:\s*fixed/.test(layer));
check(".ambient sits behind content (z-index: -1)", /z-index:\s*-1/.test(layer));
check(".ambient swallows no input", /pointer-events:\s*none/.test(layer));
check(".ambient clips its pools", /overflow:\s*hidden/.test(layer));
// `contain: strict` includes size containment, which this inset-sized box
// cannot survive — it collapses to nothing. Guard the distinction explicitly.
check(".ambient does not use size containment", !/contain:[^;]*\bstrict\b/.test(layer) && !/contain:[^;]*\bsize\b/.test(layer));

// ── 4. every colour comes from the palette ───────────────────────────────────
const hexes = aCode.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
check("no hard-coded hex colours", hexes.length === 0, hexes.join(" "));
const rgbs = aCode.match(/\brgba?\(/g) || [];
check("no hard-coded rgb() colours", rgbs.length === 0, `${rgbs.length} found`);

// ── 5. both modes author the whole recipe ────────────────────────────────────
const modeBlock = (sel) => aCode.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`))?.[1] || "";
const day = modeBlock('\\[data-theme="day"\\]');
const night = modeBlock('\\[data-theme="night"\\]');
check("day mode block exists", day.length > 0);
check("night mode block exists", night.length > 0);
for (const tok of ["--amb-1", "--amb-2", "--amb-3", "--amb-grain"]) {
  check(`day defines ${tok}`, new RegExp(`${tok}\\s*:`).test(day));
  check(`night defines ${tok}`, new RegExp(`${tok}\\s*:`).test(night));
}
// Day must lift the accent toward --surface first. Without it the wash is a
// stain rather than light, because every day-mode accent is dark by
// construction (it has to clear 4.6:1 on white — see theme-smoke).
check("day lifts the accent toward --surface", /--amb-lift-1:\s*color-mix\([^;]*var\(--surface\)/.test(day));
check("night uses the accent unlifted", !/--amb-lift/.test(night));

// ── 6. the mandate ───────────────────────────────────────────────────────────
const rm = ambient.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}/)?.[1] || "";
check("ambient.css gates its motion on prefers-reduced-motion", rm.length > 0);
check("reduced motion stops the pools", /\.amb-pool\s*\{[^}]*animation:\s*none/.test(rm));
// The light stays — killing the layer outright would hand these users a
// visibly different, flatter app instead of the same room standing still.
check("reduced motion keeps the wash (pools are still positioned)",
  /\.amb-1\s*\{[^}]*transform:/.test(rm) && /\.amb-3\s*\{[^}]*transform:/.test(rm));

// ── 7. it can be turned off, and off survives a reload ───────────────────────
check("the preference is device-local under the br_ prefix", /const AMBIENT_KEY = "br_ambient"/.test(theme));
check("the preference defaults ON", /localStorage\.getItem\(AMBIENT_KEY\) !== "off"/.test(theme));
check("reading the preference cannot throw", /getAmbientPref[\s\S]{0,220}catch \{ return true; \}/.test(theme));

// ── 8. motion stays on the compositor ────────────────────────────────────────
// Everything in this section was measured, not assumed: rAF frame times with
// the layer on vs off, at phone / tablet / desktop viewports. Each rule below
// is worth between 2× and 3.5× of the frame budget, and every one of them is
// the kind of thing a later edit would undo without noticing.

// filter: blur() on a full-screen layer is a per-frame repaint iOS charges
// dearly for; the soft edge has to come from the gradient's own falloff.
check("no filter: blur() (the soft edge is the gradient's job)", !/filter:\s*blur/.test(aCode));

// The grain must ride on .ambient itself. As a fourth child element it pushed
// the stack past the point where the pools stayed composited: 16.7ms → 33.3ms
// at 1440x900, for a layer that never moves.
check("grain is .ambient::after, not a fourth element", /\.ambient::after\s*\{[^}]*background-image:/.test(aCode));
check("no .amb-grain element class survives", !/\.amb-grain\s*\{/.test(aCode) && !/amb-grain"/.test(component));

// Sizing off the clamped unit rather than raw vmax. Uncapped, a 2560-wide
// display asks for 2458px pools and doubles the raster cost.
check("the composition is drawn in a clamped unit", /--amb-u:\s*min\(1vmax,\s*\d+px\)/.test(aCode));
const rawVmax = [...aCode.matchAll(/:\s*-?[\d.]+vmax\b/g)].map(m => m[0]);
check("no pool geometry bypasses the unit with raw vmax", rawVmax.length === 0, rawVmax.join(" "));

const driftBodies = [...aCode.matchAll(/@keyframes\s+amb-drift-\d[\s\S]*?\n\}/g)].map(m => m[0]);
check("three drift keyframes exist", driftBodies.length === 3, `${driftBodies.length} found`);
for (const kf of driftBodies) {
  const name = kf.match(/@keyframes\s+(\S+)/)[1];
  // Only transform may animate — an animated colour or opacity would repaint.
  const props = [...kf.matchAll(/^\s*([a-z-]+)\s*:/gm)].map(m => m[1]);
  check(`${name} animates transform only`, props.every(p => p === "transform"), props.filter(p => p !== "transform").join(" "));
  // Translate only. Animating scale re-rasterises the layer every frame: the
  // first version did, and cost 16.7ms → 116ms at 1440x900.
  check(`${name} translates without scaling`, !/scale\s*\(/.test(kf));
}
// Durations long enough that no frame is ever perceptible as movement.
const durs = [...aCode.matchAll(/animation:\s*amb-drift-\d\s+(\d+)s/g)].map(m => Number(m[1]));
check("three drift cycles are declared", durs.length === 3, durs.join(" "));
check("every cycle is at least 45s", durs.every(d => d >= 45), durs.join(" "));
check("no two cycles share a period (they must not re-align)", new Set(durs).size === durs.length, durs.join(" "));

console.log(failed ? `\n${failed} ambient check(s) failed` : "\nambient: all checks passed");
process.exit(failed ? 1 : 0);
