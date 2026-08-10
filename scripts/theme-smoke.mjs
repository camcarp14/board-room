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
//     wrong colour in exactly one of twenty themes. It is also the exact shape of
//     the bug the semantic seven were in for their whole life, minus the symptom
//     that makes it findable: --red was never "missing". It resolved perfectly, to
//     a value validated against #FFFFFF and #1C1C1E — two surfaces that, after the
//     grounds became per-theme, not one of the twenty palettes actually has — and
//     it read 2.94:1 on arctic night's card.
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
// Hue, for the same reason and by the same rule: written out here rather than
// borrowed, so that "the generator held the hue" is checked by something that has
// never met the generator's own hexToHsl.
const hue = (h) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const deg = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return (deg + 360) % 360;
};
const hueGap = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const css = readFileSync("src/design/themes.css", "utf8");
const SEMANTIC = ["green", "red", "amber", "blue", "purple", "pink", "btc"];
// SEVENTEEN, not ten. The seven semantic colours used to be authored once in
// tokens.css and inherited by every palette — so a palette "defining" all of its
// tokens still shipped a --red validated against #FFFFFF and #1C1C1E and against
// nothing else. They are per-palette now, which means their absence from a block
// is once again a silent inheritance bug, and belongs in this list.
const REQUIRED = ["bg", "surface", "surface-2", "ink", "sub", "faint", "accent", "accent-hi", "accent-deep", "on-accent", ...SEMANTIC];
// Floors must match FLOOR in gen-themes.mjs. Duplicated on purpose: if someone
// loosens the generator to make a colour they like pass, this still fails.
const FLOOR = { ink: 8, sub: 4.6, faint: 3.05, accent: 4.6, onAccent: 4.6 };
// And the semantic tiers, likewise restated rather than imported. 4.5:1 on the
// page and on cards because these colours are worn by 11.5px text there; 3:1 in
// wells, where they dress .stattile-value at 19px/600 (AA large text) and where
// 4.5:1 is arithmetically out of reach for a red that is still red — see the
// survey in gen-themes.mjs. --btc is the one exception: a brand FILL, never text,
// so it answers 1.4.11's 3:1 for non-text objects and keeps its hue.
const SEM_FLOOR = Object.fromEntries(SEMANTIC.map(k => [k,
  k === "btc" ? { bg: 3.0, surface: 3.0, "surface-2": 3.0 } : { bg: 4.5, surface: 4.5, "surface-2": 3.0 }]));
// Porcelain and Graphite ship the authored values verbatim (they are the two
// designed rooms), so for them the assertion is identity, not contrast. Read
// straight out of tokens.css: that is where DESIGN.md §3's hexes live, and reading
// them here is what makes this a check on the pin rather than a copy of it.
const PINNED = ["porcelain", "graphite"];
const tokens = readFileSync("src/design/tokens.css", "utf8");
const authoredSemantics = (selector) => {
  const at = tokens.indexOf(selector);
  const body = at < 0 ? "" : tokens.slice(at, tokens.indexOf("\n}", at));
  const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2].toUpperCase();
  return Object.fromEntries(SEMANTIC.map(k => [k, out[k]]));
};
const AUTHORED = {
  day: authoredSemantics(':root, [data-theme="day"] {'),
  night: authoredSemantics('[data-theme="night"] {'),
};
check("tokens.css still authors all seven semantic colours in both rooms",
  ["day", "night"].every(m => SEMANTIC.every(k => /^#[0-9A-F]{6}$/.test(AUTHORED[m][k] || ""))),
  JSON.stringify(AUTHORED));

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

    // CONTRAST, against ALL THREE grounds. It used to be two, and the third is
    // where the app actually leans hardest: --surface-2 is every inner stat tile,
    // every well, every input on a card, and in dark mode it is the LIGHTEST of
    // the three — so it is the hard case for light-on-dark text, not the easy one.
    // A token tuned against the page and the card can still be the wrong colour in
    // a well, which is exactly what happened to --faint before the generator
    // started tuning dark-mode text against surface-2.
    for (const ground of ["bg", "surface", "surface-2"]) {
      check(`${p.key}/${mode} ink on ${ground} ≥ ${FLOOR.ink}:1`, contrast(b.ink, b[ground]) >= FLOOR.ink, contrast(b.ink, b[ground]).toFixed(2));
      check(`${p.key}/${mode} sub on ${ground} ≥ ${FLOOR.sub}:1`, contrast(b.sub, b[ground]) >= FLOOR.sub, contrast(b.sub, b[ground]).toFixed(2));
      check(`${p.key}/${mode} faint on ${ground} ≥ ${FLOOR.faint}:1`, contrast(b.faint, b[ground]) >= FLOOR.faint, contrast(b.faint, b[ground]).toFixed(2));
      check(`${p.key}/${mode} accent on ${ground} ≥ ${FLOOR.accent}:1`, contrast(b.accent, b[ground]) >= FLOOR.accent, contrast(b.accent, b[ground]).toFixed(2));
    }
    check(`${p.key}/${mode} on-accent over accent ≥ ${FLOOR.onAccent}:1`, contrast(b["on-accent"], b.accent) >= FLOOR.onAccent, contrast(b["on-accent"], b.accent).toFixed(2));

    // THE SEMANTIC SEVEN, on all three grounds as well. Two assertions, because
    // there are two different promises: the eighteen derived palettes owe their
    // floors, and Porcelain and Graphite owe the designer's exact hexes. Neither
    // promise is checkable by asserting the other, and a single floor low enough to
    // let the pins through would be a floor that permits 2.07:1.
    for (const s of SEMANTIC) {
      if (PINNED.includes(p.key)) {
        check(`${p.key}/${mode} --${s} is pinned to the room tokens.css designed`,
          b[s] === AUTHORED[mode][s], `css=${b[s]} tokens=${AUTHORED[mode][s]}`);
        continue;
      }
      for (const ground of ["bg", "surface", "surface-2"]) {
        const c = contrast(b[s], b[ground]);
        check(`${p.key}/${mode} ${s} on ${ground} ≥ ${SEM_FLOOR[s][ground]}:1`, c >= SEM_FLOOR[s][ground], `${b[s]} → ${c.toFixed(2)}`);
      }
      // A solver free to rotate the hue could clear every floor above and still be
      // wrong: "overdue" red drifting into amber passes contrast and fails meaning.
      check(`${p.key}/${mode} --${s} still holds its authored hue`,
        hueGap(b[s], AUTHORED[mode][s]) <= 1, `${AUTHORED[mode][s]} → ${b[s]}, ${hueGap(b[s], AUTHORED[mode][s]).toFixed(1)}° off`);
    }

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
// Read for the compact-header section at the bottom of this file: the sentinel it
// observes is declared in the kit, and the swipe gesture it has to stay mutually
// exclusive with lives in App.
const kit = readFileSync("src/ui/kit.jsx", "utf8");
const app = readFileSync("src/App.jsx", "utf8");

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

// ─── The compact scrolled header, and pull-to-refresh ────────────────────────
// These live here rather than in systems-smoke.mjs because this is already the
// file that owns THE TOP OF THE PHONE SCREEN: it holds both `chrome`
// (components.css) and `shell` (MobileShell.jsx), and the section above it is
// the status-bar strip that the compact header sits directly beneath. Nothing
// about either feature is a Systems or Settings invariant. Text-based, because
// page-render-smoke.mjs cannot reach MobileShell at all — useVisualViewport
// touches window.screen during render (see the skip note in that file).
//
// The bar itself is checkable in a diff; four things about it are not, and all
// four are how it would silently stop working:
//
//   1. IT WAS SPECIFIED AND NEVER BUILT. `data-lt-sentinel` sat on the large
//      title in kit.jsx with ZERO observers anywhere in src/ for the whole life
//      of the SESSION rewrite, so DESIGN.md §7's nav bar simply did not exist and
//      Settings and Refresh scrolled off the primary surface for good. The
//      sentinel is a contract between two files that neither one enforces.
//
//   2. STICKY, NOT FIXED. Every other piece of this shell's vertical geometry was
//      won by getting out of the fixed-position coordinate systems iOS standalone
//      misreports. A future "just make it fixed" is a one-line diff that looks
//      identical in a browser and re-opens all of it on device.
//
//   3. THE PHANTOM CONTROL ROW. The bar carries a second Settings and a second
//      Refresh. Hiding it with opacity alone leaves both in the tab order and the
//      accessibility tree on every page — invisible, focusable, announced.
//
//   4. TWO GESTURES, ONE FINGER. The pull refuses on the exact complement of
//      App.jsx's horizontal swipe test, which is the only reason a diagonal drag
//      cannot both change tabs and fire a refresh. Retune the swipe ratio in one
//      file and that guarantee is gone with no visible symptom until you do it.
{
  // Slice CSS rules by brace, for the reason spelled out in the .statuscap block
  // above: a lazy regex walks straight through a closing brace and asserts
  // against a rule thirty lines away.
  const rule = (sel) => {
    const at = chrome.indexOf(`${sel} {`);
    return at < 0 ? "" : chrome.slice(at, chrome.indexOf("}", at) + 1);
  };

  // ── 1. the bar exists, and it is sticky inside the scroller ────────────────
  const perch = rule(".cbar-perch");
  check("the compact header has a perch rule", !!perch);
  check("the compact header is STICKY, not fixed", /position: sticky/.test(perch) && !/position: fixed/.test(perch), perch.trim());
  check("the perch is pinned to the top of the scroller", /top: 0/.test(perch), perch.trim());
  // Zero-height is what keeps the bar out of the page's layout — a bar that took
  // 48px of flow would push every page down by a bar's worth of nothing for the
  // whole time it is invisible, which is most of the time.
  check("the perch costs the page no layout", /height: 0/.test(perch), perch.trim());
  check("no part of the new chrome is position:fixed",
    !/position: fixed/.test(rule(".cbar")) && !/position: fixed/.test(rule(".ptr-perch")) && !/position: fixed/.test(rule(".ptr-gauge")));

  // FIRST CHILD, and the order is load-bearing twice over: sticky measures its
  // range from its flow parent, and the bar has to paint over the content it
  // covers rather than under it.
  const after = shell.slice(shell.indexOf('id="page-scroll"'));
  const firstChild = after.slice(after.indexOf(">") + 1).replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").trim();
  check("the perch is the FIRST child inside #page-scroll",
    firstChild.startsWith('<div className="cbar-perch"'), firstChild.slice(0, 70));

  // ── 2. it is driven by the sentinel, through an observer, not a scroll handler
  check("kit.jsx still emits the sentinel the observer needs", /data-lt-sentinel/.test(kit));
  check("the shell observes that sentinel", /querySelector\("\[data-lt-sentinel\]"\)/.test(shell));
  check("an IntersectionObserver drives the fade", /new IntersectionObserver\(/.test(shell));
  // Rooted on the scroller: #page-scroll is the only thing that scrolls in this
  // shell, so a viewport-relative observation would never fire at all.
  check("…rooted on the scroller, not the viewport", /new IntersectionObserver\([\s\S]{0,200}?\{\s*root\s*[,}]/.test(shell));
  check("no scroll listener anywhere in the shell",
    !/addEventListener\(\s*"scroll"/.test(shell) && !/onScroll/.test(shell));
  // The large title lives inside the keyed page wrapper, so every navigation
  // destroys the sentinel and builds a new one. An observer that doesn't
  // re-attach is holding a node that left the document.
  check("the observer re-attaches when the page changes", /io\.observe\(sentinel\)[\s\S]{0,200}?\}, \[page\]\)/.test(shell));

  // ── 3. the same two controls, and no phantom row ───────────────────────────
  // ONE definition rendered in two places. "The same two buttons as the top of
  // the page" has to stay true as this cluster changes, and it only does if
  // there is nothing to keep in sync.
  check("the bar reuses the large title's control cluster rather than rebuilding it",
    (shell.match(/\{controls\}/g) || []).length === 2, `${(shell.match(/\{controls\}/g) || []).length} uses`);
  const cbar = rule(".cbar");
  check("the hidden bar is taken out of the tab order and the a11y tree",
    /visibility: hidden/.test(cbar) && /pointer-events: none/.test(cbar), cbar.trim());
  check("…and put back when it appears", /visibility: visible/.test(rule(".cbar.on")));
  check("the bar is glass with the one hairline glass chrome gets",
    /backdrop-filter: blur/.test(cbar) && /var\(--glass\)/.test(cbar) && /border-bottom: 0\.5px solid var\(--line\)/.test(cbar), cbar.trim());
  // DESIGN.md §7: centred page title 16/600. The floor is 10.5px, hard.
  const title = rule(".cbar-title");
  check("the compact title is 16/600 and centred",
    /font-size: 16px/.test(title) && /font-weight: 600/.test(title) && /text-align: center/.test(title), title.trim());

  // THE MIRROR IS ARITHMETIC, so let it be arithmetic. An empty cell the exact
  // width of the control cluster opposite is the only thing centring that title;
  // resize the icon buttons and the title drifts off-centre on every page with
  // nothing in the diff to suggest it.
  const px = (sel, prop) => Number(rule(sel).match(new RegExp(`${prop}: (\\d+(?:\\.\\d+)?)px`))?.[1]);
  const mirror = px(".cbar-mirror", "width"), btn = px(".icon-btn", "width"), gap = px(".nav-actions", "gap");
  check("the title's mirror still matches the control cluster it mirrors",
    mirror === btn * 2 + gap, `mirror ${mirror} vs ${btn}×2 + ${gap} = ${btn * 2 + gap}`);

  // ── 4. pull to refresh ─────────────────────────────────────────────────────
  check("the pull is wired to the shell's own onRefresh, not a second data path",
    /ptrProps\.current\.onRefresh\?\.\(\)/.test(shell));
  // preventDefault on a passive listener is a silent no-op, and without it iOS's
  // rubber band and this pull are both moving the page at the same time.
  check("the touchmove listener is non-passive so the overscroll can be cancelled",
    /addEventListener\("touchmove", onMove, \{ passive: false \}\)/.test(shell) && /e\.preventDefault\(\)/.test(shell));
  // THE ONE WITH TEETH. App.jsx switches tabs when |dx| ≥ 64 AND |dx| ≥ 2.2·|dy|;
  // the pull refuses on precisely that second inequality, so the two conditions
  // are complements and no gesture can satisfy both. If the swipe's ratio is ever
  // retuned, this fails here rather than shipping a drag that does two things.
  const swipeRatio = app.match(/Math\.abs\(dx\) < ([\d.]+) \* Math\.abs\(dy\)/)?.[1];
  const pullRatio = shell.match(/Math\.abs\(dx\) >= ([\d.]+) \* Math\.abs\(dy\)/)?.[1];
  check("App.jsx's swipe still states its ratio where this can read it", !!swipeRatio, String(swipeRatio));
  check("the pull refuses on the exact complement of the swipe's test",
    !!pullRatio && pullRatio === swipeRatio, `pull ${pullRatio} vs swipe ${swipeRatio}`);
  // Checked on every move AND on the final delta — the drag lets go of the page
  // as it turns horizontal instead of snapping back after the tab has changed.
  check("…on every move and again at the release",
    (shell.match(/Math\.abs\(dx\) >= [\d.]+ \* Math\.abs\(dy\)/g) || []).length >= 2);
  // A pull that starts inside a control or inside a scroller of its own would
  // make The Wire and Watch This Week (340–480px of internal scroller, most of a
  // phone screen) unscrollable from their own top.
  check("the pull declines gestures that belong to an inner scroller or a field",
    /tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/.test(shell) && /overflowY/.test(shell));
  check("the pull only arms from the very top of the page", /root\.scrollTop > 0\) return/.test(shell));

  // THE CURVE HAS TO REACH ITS OWN THRESHOLD. Damping is the entire feel of this
  // gesture and it is three numbers in a one-line function — retune the
  // coefficient and the pull becomes either impossible to arm (a threshold the
  // curve asymptotes below, which reads as "pull-to-refresh is broken" with
  // nothing in the code looking wrong) or so eager it fires on a scroll. Read the
  // numbers out and check the arithmetic they imply, in px of actual finger.
  const num = (name) => Number(shell.match(new RegExp(`const ${name} = ([\\d.]+);`))?.[1]);
  const arm = num("PTR_ARM"), max = num("PTR_MAX");
  const coeff = Number(shell.match(/const raw = dy \* ([\d.]+);/)?.[1]);
  const travel = arm / coeff; // finger px needed to arm
  check("the damping curve reaches the arming threshold at all", travel > 0 && travel < 200, `${travel.toFixed(0)}px of travel`);
  // Deliberately MORE travel than the 64px App.jsx wants for a tab swipe, so the
  // two gestures don't feel like they are competing for the same small movement.
  check("arming takes more travel than a tab swipe does", travel > 64, `${travel.toFixed(0)}px vs 64px`);
  check("the rubber band stops before it runs out of screen", max > arm && max < 120, `arm ${arm}, max ${max}`);

  // THE HOUSE RULE. The gauge shows progress, then that a refresh is in flight
  // for exactly as long as onRefresh's promise is unsettled. It never says the
  // data landed — App's freshness pill is the only thing that knows, because
  // refreshData stamps per-slice and deliberately does not stamp a total failure.
  check("the gauge never reports success", !/\b(Updated|Refreshed|Up to date|Success)\b/.test(shell));
  check("…and draws no tick", !/IcCheck/.test(shell));
  // No timer: a minimum spinner duration is the specific lie available here —
  // it would keep saying "refreshing" after the refresh had finished or failed.
  check("the spinner's life is the promise's life, not a timer's", !/setTimeout|setInterval/.test(shell));
  check("the spinner is the kit's, not a hand-rolled one", /<Spinner size=/.test(shell) && /Spinner/.test(shell.match(/import \{([^}]*)\} from "\.\.\/ui\/kit\.jsx"/)?.[1] || ""));

  // ── 5. reduced motion, on both of them ─────────────────────────────────────
  const rm = chrome.slice(chrome.indexOf("@media (prefers-reduced-motion: reduce)"));
  check("the header appears without a fade under reduced motion", /\.cbar \{ transition: none/.test(rm));
  // !important because the transitions being cancelled are written inline, frame
  // by frame, by the code that tracks the finger.
  check("the pull loses its transitions under reduced motion",
    /\.ptr-gap, \.ptr-wrap, \.ptr-arc \{ transition: none !important/.test(rm));
  // The rubber band is the page travelling, and that is written from JS — so the
  // query has to be read there too or the CSS above cancels nothing that matters.
  check("…and the page itself never travels, which only JS can decide",
    /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)/.test(shell) && /!reduced\?\.matches/.test(shell));

  // NINE LITERAL HEXES EXIST OUTSIDE src/design/ AND THAT IS AN ACHIEVEMENT.
  // The shell resolves every colour through a token; a hex here is a colour that
  // will be wrong in nineteen of the twenty palettes. (components.css is inside
  // src/design/ and keeps exactly four — the danger button's label and the three
  // white knobs/thumbs, all of which are white in both rooms by design — so it is
  // not held to this.)
  const hexes = shell.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  check("the shell hard-codes no colour", hexes.length === 0, hexes.join(" "));
}

console.log(`\n${failed ? `${failed} FAILURE(S)` : "THEME SMOKE: ALL CLEAN"}`);
if (failed) { console.error("THEME SMOKE FAILED"); process.exit(1); }
