// ─── Motion smoke — the wash and the sheets, asserted ────────────────────────
// (Still `ambient-smoke.mjs`, and still `npm run smoke:ambient`: renaming it
// means editing package.json's verify chain, and the charter is the same one it
// always had — MOTION WHOSE FAILURE IS SILENT. Section 9 extends it from the
// canvas wash to the sheet exit and the drag, which fail the same way: nothing
// throws, no number is wrong, the app just quietly stops answering the hand.
// The sheets could not be tested where components are tested — kit.jsx's Sheet
// is createPortal(…, document.body) and renderToString has no document, which
// page-render-smoke.mjs prints in its own skip list every run — so the gesture's
// arithmetic is imported and executed here instead of being grepped for.)
//
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
import { rm as rmFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";

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

/* ═════════════════════════════════════════════════════════════════════════════
   9. SHEETS — the exit that was structurally impossible, and the handle that
      promised a drag it never had.

   Twenty-four sheets, every one of them conditionally rendered by its parent
   ({open && <Sheet/>}), so the exit could not exist: the frame the parent's flag
   flipped, the portal's node was gone. kit.jsx's Sheet now swallows the onClose
   it is handed, wears .out for exactly --dur-2, and tells the parent afterwards.
   Nothing at any call site knows this, which is the point — and also the risk,
   because a single edit in one component silently un-animates all twenty-four
   screens and no other test in this repo renders a sheet at all.

   Four things below can each break in complete silence:
     A. the CSS classes the closing window paints with (no error, hard cut back).
     B. the timer and the CSS duration drifting apart — 240ms of frozen sheet, or
        a sheet cut off halfway out. This is why the JS READS the token.
     C. the reduced-motion path, which must not merely shorten the slide but skip
        the window entirely: for these users a held frame is the slide's whole
        cost with none of its benefit.
     D. the gesture's numbers. A dismiss threshold that has quietly become
        1200px still greps fine, so §11 imports the functions and runs them.
   ═════════════════════════════════════════════════════════════════════════════ */
const kit = readFileSync("src/ui/kit.jsx", "utf8");
const comp = readFileSync("src/design/components.css", "utf8");
const tokens = readFileSync("src/design/tokens.css", "utf8");
const hooks = readFileSync("src/hooks/index.js", "utf8");

// Slice rules by BRACE, never by lazy regex. theme-smoke.mjs has the scar tissue
// on this: a lazy match walks straight through a closing brace into a rule thirty
// lines later, and a negative assertion against a pattern that never matched is
// the most comfortable kind of green there is.
const braced = (src, at) => {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at + 1, i);
  }
  return "";
};
const ruleOf = (src, selector) => {
  const at = src.indexOf(selector + " {");
  return at < 0 ? null : braced(src, src.indexOf("{", at));
};

// The whole sheets section, banner to banner — everything §9 asserts lives here.
const sheetsFrom = comp.indexOf("/* ── sheets");
const sheetsTo = comp.indexOf("/* ── toasts");
check("the sheets section is findable", sheetsFrom > 0 && sheetsTo > sheetsFrom);
const sheetsCss = comp.slice(sheetsFrom, sheetsTo);
const modalAt = sheetsCss.indexOf("@media (min-width: 761px)");
check("the ≥761px modal block is inside it", modalAt > 0);
const modalCss = braced(sheetsCss, sheetsCss.indexOf("{", modalAt));

// ── 9A. the classes that paint the closing window ────────────────────────────
const out = ruleOf(sheetsCss, ".sheet.out");
const scrimOut = ruleOf(sheetsCss, ".sheet-scrim.out");
check(".sheet.out exists", !!out);
check(".sheet-scrim.out exists", !!scrimOut, "the sheet cannot leave while the scrim stays");
// The duration must be a token. A literal ms here is the drift in B waiting to
// happen, and --dur-2 is the exit's one source of truth.
for (const [name, rule] of [[".sheet.out", out], [".sheet-scrim.out", scrimOut]]) {
  check(`${name} times its exit with a --dur token`, /animation:[^;]*var\(--dur-\d\)/.test(rule || ""),
    (rule || "").match(/animation:[^;]*/)?.[0]);
}
// For --dur-2 the sheet looks gone. A button on a sheet that looks gone must not
// still fire — that is the house rule about lying, expressed in CSS.
check(".sheet.out stops answering touch", /pointer-events:\s*none/.test(out || ""));
// The scrim is the opposite case and the asymmetry is deliberate: it is the modal
// barrier, and it has to hold until the sheet is really unmounted, or a second tap
// lands on a card the user cannot see yet.
check(".sheet-scrim.out keeps the barrier up", !/pointer-events/.test(scrimOut || ""), scrimOut || "");
check("@keyframes sheetout exists", /@keyframes sheetout\s*\{/.test(sheetsCss));
check("@keyframes scrimout exists", /@keyframes scrimout\s*\{/.test(sheetsCss));
// It leaves through the bottom edge by its OWN height, so a 200px confirm and a
// full-height form both clear exactly and no further.
check("the sheet leaves by translating its own height",
  /@keyframes sheetout \{[^}]*translateY\(100%\)/.test(sheetsCss));
// Never animate a colour (the Chromium wedge — see styles.css).
check("no colour is animated on the way out",
  !/@keyframes (sheet|scrim)out \{[^}]*(background|color)\s*:/.test(sheetsCss));

// ── 9B. the tablet exit is its own animation ─────────────────────────────────
// Above 760px the sheet is a centred modal whose translate(-50%,-50%) is
// load-bearing. sheetout's translateY would knock it off centre before it faded.
const modalOut = ruleOf(modalCss, ".sheet.out");
check("the modal has its own exit", !!modalOut && /animation:\s*modalout/.test(modalOut));
check("…and it keeps the centring translate",
  /@keyframes modalout \{[^}]*translate\(-50%,\s*-50%\)/.test(modalCss));

// ── 9C. who owns the transform ───────────────────────────────────────────────
// While a finger drags, kit.jsx writes transform inline — and inline transform
// LOSES to a filled animation, so .grabbed revokes it. That rule has to come
// after .sheet.out at equal specificity or a dragged sheet's exit gets both.
const grabbed = ruleOf(sheetsCss, ".sheet.grabbed");
check(".sheet.grabbed hands the transform to JS", !!grabbed && /animation:\s*none/.test(grabbed));
check(".sheet-scrim.grabbed does the same", /\.sheet-scrim\.grabbed\s*\{[^}]*animation:\s*none/.test(sheetsCss));
check(".sheet.grabbed is declared AFTER .sheet.out (order is the mechanism)",
  sheetsCss.indexOf(".sheet.grabbed {") > sheetsCss.indexOf(".sheet.out {"));

// ── 9D. the handle can actually be grabbed ───────────────────────────────────
const grab = ruleOf(sheetsCss, ".sheet-grab");
check("the grabber refuses the browser's scroll gesture (touch-action: none)",
  /touch-action:\s*none/.test(grab || ""), "without it Safari cancels the drag before the first pointermove");
check("the grabber's hit area is bigger than the 5px bar",
  /\.sheet-grab::before\s*\{[^}]*position:\s*absolute/.test(sheetsCss));
check("…and it is positioned so that band has something to hang off",
  /position:\s*relative/.test(grab || ""));
const sheetBody = ruleOf(sheetsCss, ".sheet-body");
check("the scroller contains its own overscroll",
  /overscroll-behavior(-y)?:\s*none/.test(sheetBody || ""),
  "on the SCROLLER, not on .sheet — the elastic bounce at scrollTop 0 is the gesture's only rival");

// ── 9E. detents ──────────────────────────────────────────────────────────────
// One resting height chosen at open — not a drag-between. Both named heights are
// expressed against the same envelope as max-height, so the safe-area geometry
// stays in one place and no detent can exceed it.
for (const d of ["medium", "large"]) {
  const r = ruleOf(sheetsCss, `.sheet.detent-${d}`);
  check(`.sheet.detent-${d} sets a resting height`, !!r && /height:/.test(r));
  check(`…derived from the same safe-area envelope as max-height`,
    /env\(safe-area-inset-top\)/.test(r || ""), r || "");
}
check("a detent is a bottom-sheet idea — the modal drops it",
  /\.sheet\.detent-medium,\s*\.sheet\.detent-large\s*\{[^}]*height:\s*auto/.test(modalCss));

// ── 9F. no hex anywhere in the sheets section ────────────────────────────────
// Nine literal hexes exist outside src/design/ in this whole app. It is an
// achievement, and this section is new code — the likeliest place to lose it.
const sheetHex = code(sheetsCss).match(/#[0-9a-fA-F]{3,8}\b/g) || [];
check("the sheets section adds no literal hex", sheetHex.length === 0, sheetHex.join(" "));

/* ── 10. the JS half of the same contract ─────────────────────────────────── */
// The number in the timer and the number in the stylesheet must be one number.
check("the closing window reads --dur-2 out of the CSS",
  /getPropertyValue\("--dur-2"\)/.test(kit), "a restated literal is a drift waiting to happen");
const tokenDur = Number(tokens.match(/--dur-2:\s*(\d+)ms/)?.[1]);
const jsFallback = Number(kit.match(/let ms = (\d+);/)?.[1]);
check("--dur-2 is readable from tokens.css", Number.isFinite(tokenDur), String(tokenDur));
check("the JS fallback equals the authored token", jsFallback === tokenDur, `${jsFallback} vs ${tokenDur}`);

// One window, one duration, three places that have to agree on it: the class, the
// inline fly-out a thrown sheet finishes with, and the timer. All three name
// --dur-2, so there is nothing to keep in sync by hand.
check("the class's exit is --dur-2", /animation:\s*sheetout\s+var\(--dur-2\)/.test(sheetsCss));
const fly = kit.slice(kit.indexOf("const flyOut ="), kit.indexOf("// ── the close"));
check("a thrown sheet finishes on the same clock", /transition = "transform var\(--dur-2\)/.test(fly), fly.trim());
// A snap-back is the one motion here that springs: it is the sheet refusing.
check("a snap-back springs instead", /transition = "transform var\(--dur-3\) var\(--ease-spring\)"/.test(kit));

// The three gesture routes out must go through the wrapper, or they unmount the
// sheet before it can animate — which is the bug this whole file is about.
check("the scrim no longer calls the parent's onClose directly",
  !/onClick=\{dismissible \? onClose/.test(kit) && /className=\{`sheet-scrim[^`]*`\}[\s\S]{0,200}requestClose\(\)/.test(kit));
check("the close button goes through the wrapper too", /disabled=\{!view\.dismissible\}/.test(kit) &&
  /onClick=\{view\.dismissible \? \(\) => requestClose\(\)/.test(kit));
check("Escape goes through the wrapper too", /if \(dismissible\) requestClose\(\);/.test(kit));

// The freeze. During the closing window the parent's state has usually already
// moved on, and half these sheets print the state the close clears.
check("the payload is cached on every open render", /if \(!closing\) lastRef\.current = \{/.test(kit));
// Read the line, don't pattern-match across it: the body's own handler contains
// an arrow (`(e) => beginDrag(…)`), so any [^>]* here stops in the middle of the
// tag and asserts nothing.
const bodyLine = kit.split("\n").find((l) => l.includes('className="sheet-body"')) || "";
check("the body renders the frozen children, not the live prop",
  bodyLine.includes(">{view.children}</div>"), bodyLine.trim());
check("the frozen payload covers the footer and the title too",
  /\{view\.footer\}/.test(kit) && /\{view\.title\}/.test(kit));

// Reduced motion: not a shorter slide — no window at all.
const rq = kit.slice(kit.indexOf("const requestClose = useCallback"), kit.indexOf("// ── the gesture"));
check("requestClose is findable", rq.length > 100);
check("reduced motion delivers the close immediately",
  rq.indexOf("allow().animateExit") > 0 && rq.indexOf("allow().animateExit") < rq.indexOf("setClosing(true)"),
  "the check has to come BEFORE the closing state, or these users wait 240ms for nothing");
const bd = kit.slice(kit.indexOf("const beginDrag ="), kit.indexOf("const onMove ="));
check("beginDrag is findable", bd.length > 100);
check("…and the drag consults the same policy", bd.includes("allow().drag"),
  "dragging a sheet around by hand is animation performed by hand");
const rmBlock = comp.slice(comp.indexOf("@media (prefers-reduced-motion: reduce)"));
check("the stylesheet also holds the .out classes still",
  /\.sheet-scrim,\s*\.sheet\.out,\s*\.sheet-scrim\.out\s*\{[^}]*animation:\s*none\s*!important/.test(rmBlock));

// The affordance is bound at both ends: the handle, and the body at scrollTop 0.
check("the grabber has a pointerdown", /className="sheet-grab" onPointerDown=/.test(kit));
check("the body has one too", /className="sheet-body" ref=\{bodyRef\}[^>]*onPointerDown=/.test(kit));
check("a body drag starts only at the top of the scroll", /bodyRef\.current\?\.scrollTop \|\| 0\) > 0\) return/.test(kit));
check("a sideways gesture is never ours", /Math\.abs\(dx\) > Math\.abs\(dy\)/.test(kit));
// The nearest gesture owner wins — SortableList's rule, and its selectors, reused
// rather than reinvented, so a reorder list inside a sheet keeps its hold-drag.
// That list is DRAG_OPT_OUT now, shared with the shell's pull-to-refresh (which had
// its own, shorter idea of it — see §12) and executed there. What is pinned here is
// that the sheet still COMPOSES from it instead of drifting back to its own copy.
check("the sheet's no-drag list is built from the shared one",
  /SHEET_NO_DRAG = `[^`]*\$\{DRAG_OPT_OUT\}`/.test(kit), kit.match(/SHEET_NO_DRAG = [^\n]*/)?.[0]);
check("…and adds the tap targets and fields only a SHEET drag has to refuse",
  /SHEET_NO_DRAG = `button, a, input, textarea, select, label, \[role="button"\], /.test(kit));
check("a second finger is a pinch, not a dismiss", /!e\.isPrimary/.test(kit));
check("the sheet is never left stuck mid-pull", /onPointerCancel=\{\(e\) => endDrag\(e, false\)\}/.test(kit));
// Escape (or a footer button) mid-drag must not leave the finger and the exit
// writing the same transform at each other.
check("a drag in flight loses the sheet the moment it closes", /dragRef\.current = null;/.test(rq));
// The gesture and the geometry must agree about what a phone is.
check("the drag uses the same breakpoint query as useIsMobile()",
  /matchMedia/.test(hooks) && hooks.includes("(max-width: 760px)") && kit.includes("(max-width: 760px)"));

// useConfirm is the house's window.confirm, so a confirm sheet that got stuck
// mid-exit would take a destructive flow down with it. Its buttons leave through
// the same exit as the scrim, the promise settles in exactly ONE place (the
// sheet's own onClose, after the animation), and each request is keyed so two
// confirms in a row cannot share one Sheet instance — and with it one finished
// `closing` state.
check("the confirm's buttons ask the sheet to leave", /function ConfirmActions[\s\S]{0,400}useSheetClose\(\)/.test(kit));
check("the promise settles in exactly one place", (kit.match(/req\?\.resolve\(/g) || []).length === 1);
check("each confirm is its own sheet", /<Sheet key=\{req\.seq\}/.test(kit),
  "without the key, React reconciles one Sheet across two questions");

// detent, as documented in DESIGN.md §6 — and only for the two named values, so
// every existing call site keeps today's content-sized sheet exactly.
check("Sheet takes a detent, defaulting to auto", /detent = "auto"/.test(kit));
check("only medium and large get a class",
  /detent === "medium" \|\| detent === "large" \? ` detent-\$\{detent\}`/.test(kit));

/* ── 11. THE GESTURE, EXECUTED ─────────────────────────────────────────────── */
// Everything above is text. These are the numbers that ARE the feel, so they get
// run rather than read: import kit.jsx through esbuild (bare Node cannot load
// JSX), call the two pure functions, and assert the physics. Module scope in
// kit.jsx touches no DOM, which is what makes this importable at all.
// Bundle → import → delete. The temp module has to land in the REPO ROOT: react
// stays external, so node resolves it from node_modules relative to the file, and
// a bundle written anywhere else cannot find it. Shared with §15, which does the
// same thing to src/hooks/index.js.
const runnable = async (entry, tmp) => {
  const out = path.resolve(tmp);
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm",
    outfile: out, loader: { ".jsx": "jsx" }, jsx: "automatic",
    external: ["react", "react-dom"], logLevel: "error",
  });
  try { return await import(pathToFileURL(out).href); }
  finally { await rmFile(out, { force: true }); }
};
const kitMod = await runnable("src/ui/kit.jsx", ".ambient-smoke-kit.tmp.mjs");
const { sheetPull, sheetShouldDismiss, sheetPolicy, SHEET_DISMISS_PX, SHEET_FLICK_VY } = kitMod;
check("the gesture's math is importable",
  [sheetPull, sheetShouldDismiss, sheetPolicy].every((f) => typeof f === "function"));

// THE MANDATE, RUN RATHER THAN GREPPED. All four combinations, because the two
// queries are independent and only one of the four is the interesting one: a
// reduced-motion user on a phone must get no exit animation AND no drag.
const P = (still, phone) => sheetPolicy({ still, phone });
check("phone, motion allowed: it animates and it drags", P(false, true).animateExit && P(false, true).drag);
check("phone, reduced motion: neither", !P(true, true).animateExit && !P(true, true).drag);
check("tablet, motion allowed: it animates, it does not drag", P(false, false).animateExit && !P(false, false).drag);
check("tablet, reduced motion: neither", !P(true, false).animateExit && !P(true, false).drag);

// The thresholds live in the range a thumb lives in. This is the check that
// catches a decimal point: 1200px and 12px both read fine in a diff.
check("the dismiss threshold is a thumb's distance", SHEET_DISMISS_PX >= 100 && SHEET_DISMISS_PX <= 140, String(SHEET_DISMISS_PX));
check("the flick threshold is a flick", SHEET_FLICK_VY > 0.2 && SHEET_FLICK_VY < 1.5, String(SHEET_FLICK_VY));

// A dismissible sheet tracks the finger exactly downward. Anything less than 1:1
// in the direction it is leaving feels like the sheet is arguing with you.
check("down is 1:1 for a dismissible sheet", sheetPull(80) === 80 && sheetPull(4) === 4);
// Upward it resists and never runs away: there is nothing above the top edge.
const up = [8, 40, 200, 5000].map((v) => sheetPull(-v));
check("up resists", up[0] > -8 && up[0] < 0, String(up[0]));
check("up never exceeds its give", up.every((v) => v > -65), up.join(" "));
check("up is monotonic", up[0] > up[1] && up[1] > up[2] && up[2] > up[3], up.join(" "));

// dismissible={false} — a locked sheet must MOVE (a handle that ignores you is
// the lie this change exists to remove) and must never leave.
const locked = Array.from({ length: 400 }, (_, i) => sheetPull(i, false));
check("a locked sheet gives a little", locked[20] > 0 && locked[20] < 20, String(locked[20]));
check("a locked sheet never travels far", Math.max(...locked) < 29, String(Math.max(...locked)));
check("a locked pull is monotonic", locked.every((v, i) => i === 0 || v > locked[i - 1]));
// No cap, no corner: a Math.min() would flatten the curve, and you can feel the
// flat spot. Strictly decreasing first differences is what "smooth" means here.
const diffs = locked.slice(1, 200).map((v, i) => v - locked[i]);
check("the resistance curve has no corner in it", diffs.every((d, i) => i === 0 || d < diffs[i - 1]));

// The release decision.
check("119px snaps back", sheetShouldDismiss(119, 0) === false);
check("121px lets go", sheetShouldDismiss(121, 0) === true);
check("a fast flick lets go early", sheetShouldDismiss(30, 0.9) === true);
check("a flick from nowhere is a tap, not a dismiss", sheetShouldDismiss(6, 9) === false);
check("a slow long pull still lets go", sheetShouldDismiss(200, 0.01) === true);
check("no travel, no dismiss", sheetShouldDismiss(0, 0) === false && sheetShouldDismiss(-40, 3) === false);
check("a locked sheet answers neither test",
  sheetShouldDismiss(900, 0, false) === false && sheetShouldDismiss(30, 9, false) === false);

// ── the parent's handle on the exit ─────────────────────────────────────────
// useSheetClose reads context, so it only resolves BELOW the provider Sheet opens
// in its own return — which excludes every close in this app, because they all
// fire from a mutation callback in the scope that renders the Sheet. Those closes
// go through closeRef instead, and the ones already converted are pinned here: a
// panel that goes back to flipping its own state gets the hard cut back, and
// nothing on screen would say so.
const kitSrc = readFileSync("src/ui/kit.jsx", "utf8");
check("Sheet takes a closeRef", /function Sheet\(\{[^)]*closeRef/s.test(kitSrc));
check("…populated in a layout effect, so it is ready before any child handler",
  /useLayoutEffect\(\(\) => \{\s*if \(!closeRef\) return;\s*closeRef\.current = requestClose;/.test(kitSrc));
check("…and nulled on unmount, so closeSheet can fall back",
  /return \(\) => \{ closeRef\.current = null; \};/.test(kitSrc));
// The fallback is the whole reason closeSheet exists rather than callers doing
// `ref.current?.(fn)`: optional-call on an empty ref silently drops the after-work,
// which turns Save into a button that saves and then does nothing visible.
check("closeSheet runs the after-work even with no sheet mounted",
  /export function closeSheet\(ref, after\) \{[\s\S]*?else after\?\.\(\);/.test(kitSrc));
for (const [label, file] of [
  ["Creed", "src/features/creed/CreedPanel.jsx"],
  ["Dreams", "src/features/dreams/DreamBoardPanel.jsx"],
]) {
  const src = readFileSync(file, "utf8");
  check(`${label} hands its sheet a closeRef`, /<Sheet closeRef=\{sheetClose\}/.test(src));
  check(`${label} closes through the exit, not a bare state flip`,
    /closeSheet\(sheetClose,/.test(src) && !/onSuccess: \(\) => \{ setSaving\(false\); set(Form|Tile)\(null\)/.test(src));
}

/* ═════════════════════════════════════════════════════════════════════════════
   12. PULL TO REFRESH vs EVERY OTHER DRAG ON THE PAGE

   Two gestures in this app now begin with a finger travelling downward, and for
   one deploy only ONE of them declined the regions that already own a finger. A
   hold-and-drag to reorder that started at scrollTop 0 — the Brief's card order,
   the grocery list, both notes surfaces, every one of them a list whose first row
   is exactly where scrollTop is 0 — armed the refresh as well as the reorder,
   because the sheet guarded [data-sortable] and the shell's gauge checked three
   tag names. There is one list now; this runs it.
   ═════════════════════════════════════════════════════════════════════════════ */
const shell = readFileSync("src/shell/MobileShell.jsx", "utf8");
const { DRAG_OPT_OUT } = kitMod;
check("the shared no-drag list is importable", typeof DRAG_OPT_OUT === "string" && DRAG_OPT_OUT.length > 10);
for (const sel of ["[data-sortable]", "[data-no-drag]", "[contenteditable]", '[draggable="true"]']) {
  check(`every drag declines ${sel}`, (DRAG_OPT_OUT || "").includes(sel), DRAG_OPT_OUT);
}
// The half that must NOT be shared. On a phone almost every row is a button or a
// pressable card, so a pull-to-refresh that refused tap targets would have nowhere
// left to start — which is why this is two constants and not one.
check("the shared list refuses no tap target",
  !/\bbutton\b/.test(DRAG_OPT_OUT || "") && !/role="button"/.test(DRAG_OPT_OUT || ""),
  "a pull that declines buttons cannot start anywhere on a phone");
check("the shell imports that list rather than restating it",
  /import \{[^}]*\bDRAG_OPT_OUT\b[^}]*\} from "\.\.\/ui\/kit\.jsx"/.test(shell));
check("pull-to-refresh consults it", /t\.target\?\.closest\?\.\(DRAG_OPT_OUT\)\) return;/.test(shell));
// At touchstart, and BEFORE the candidate gesture is recorded — a guard that ran
// after `start` was set would have armed the pull it was meant to refuse.
const ptrStart = shell.slice(shell.indexOf("const onStart ="), shell.indexOf("const onMove ="));
check("…at touchstart, not on the first move", ptrStart.includes("DRAG_OPT_OUT"));
check("…before the gesture is armed",
  ptrStart.indexOf("DRAG_OPT_OUT") < ptrStart.indexOf("start = { x:"));
check("…and it still declines an inner scroller of its own",
  /overflowY[\s\S]{0,80}"auto" \|\| oy === "scroll"\) return;/.test(ptrStart),
  "the Wire and Watch This Week are 340–480px scrollers that fill the screen");
// The fields, in the ancestor walk it performs anyway — which is why they are not
// in the shared list. Both halves have to survive together or the pull starts
// stealing a caret drag again.
check("…and a field, by tag, in that same walk",
  /tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/.test(ptrStart));

/* ── 13. THE HAND-OFF IS AN EXCHANGE, NOT A COPY ───────────────────────────── */
// One controls node, rendered in the large title and again in .cbar. .cbar's
// visibility:hidden made the bar's copy honest; the title's copy was only ever
// SCROLLED out of the scrollport, which hides nothing — so with the bar on, both
// pairs were focusable and in the accessibility tree, VoiceOver read two Settings
// and two Refresh per page, and tabbing to the offscreen pair scrolled the page
// back to the top.
const cbar = ruleOf(comp, ".cbar");
check(".cbar leaves the tab order, not just the screen", /visibility:\s*hidden/.test(cbar || ""), cbar || "");
check("the large title's copy can be hidden too",
  /className=\{`lt-actions\$\{compactOn \? " handed-off" : ""\}`\}/.test(shell));
const ltActions = ruleOf(comp, ".lt-actions");
const handedOff = ruleOf(comp, ".lt-actions.handed-off");
check(".lt-actions.handed-off hides the same way the bar does",
  /visibility:\s*hidden/.test(handedOff || ""), handedOff || "");
// The hand-off is instant in both directions, and that is the deliberate half of
// the trade: both copies live in the same 48px band, so hiding this one on the
// BAR's clock (a 0s change delayed by --dur-2 is how) would close the tab-order
// overlap and make the icons fade to nothing and snap back on every scroll to the
// top. A delay creeping in here is a visible flaw in the control row.
check("the hand-off carries no delay of its own",
  !/transition/.test(ltActions || "") && !/transition/.test(handedOff || ""),
  `${ltActions || ""} | ${handedOff || ""}`);
// And the comment in MobileShell has to keep saying so — an overlap that is a
// choice must read as a choice, or the next person "fixes" it into the blink.
check("the shell's comment states the overlap it chose",
  /both copies are momentarily in the tab order/.test(shell));

/* ═════════════════════════════════════════════════════════════════════════════
   14. A CLOSE THE PARENT DECLINED

   Sheet swallows the onClose it was handed and tells the parent --dur-2 later. A
   parent is allowed to say no — SeatNotesModal's onClose is
   `if (dirty && !(await confirm(…))) return;` — and that used to brick the whole
   app: closingRef was set and never reset, the sheet was off the stack and wearing
   .out (translateY(100%), pointer-events:none), and the scrim, whose .out rule
   deliberately KEEPS its pointer-events, sat there transparent and inset:0 eating
   every tap until a reload. Escape was dead too. The contract is safe now instead
   of documented: still mounted a beat after the parent was told means the parent
   declined, and the sheet comes back.
   ═════════════════════════════════════════════════════════════════════════════ */
const { sheetRevive } = kitMod;
check("the revival's stack arithmetic is importable", typeof sheetRevive === "function");
// THE ONE THAT MATTERS. An async decline has another sheet above us by the time we
// return, so a revived sheet pushed onto the END of the stack would claim to be on
// top and take Escape away from the confirm the user is answering.
{
  const us = { sheet: "seat notes" }, confirmSheet = { sheet: "discard changes?" };
  const stack = [confirmSheet];
  sheetRevive(stack, us, 0);
  check("a revived sheet goes back UNDER the sheet that declined for it",
    stack.length === 2 && stack[0] === us && stack[stack.length - 1] === confirmSheet,
    JSON.stringify(stack));
  const twice = [us]; sheetRevive(twice, us, 0);
  check("…and never lands on the stack twice", twice.length === 1);
  const shrunk = []; sheetRevive(shrunk, us, 7);
  check("…and an index past the end is clamped, not thrown", shrunk.length === 1 && shrunk[0] === us);
}
const revive = kit.slice(kit.indexOf("const revive = (stackAt)"), kit.indexOf("// ── the close the call sites never see"));
check("revive is findable", revive.length > 200);
check("a declined close is recoverable at all", /closingRef\.current = false;/.test(revive),
  "the flag that was set and never reset is the whole bug");
check("…the sheet comes back on screen with it", /setClosing\(false\);/.test(revive));
check("…and back onto the stack, so Escape works again", /sheetRevive\(sheetStack, idRef\.current, stackAt\)/.test(revive));
// A thrown sheet was left at translateY(100%) by JS, and inline transform beats the
// stylesheet: dropping .out would change nothing on screen without this.
check("…and a thrown sheet's inline transform is cleared",
  /el\.style\.transform = "";/.test(revive) && /classList\.remove\("grabbed"\)/.test(revive));
// Reviving an id whose component is gone would take Escape away from every sheet
// under it — the same bug wearing a different face.
check("an unmounted sheet is never resurrected into the stack",
  /if \(!dialogRef\.current \|\| !closingRef\.current\) return;/.test(revive));
// Wired from inside deliver, so there is no route that tells the parent without
// also checking whether the parent did anything about it.
const deliver = kit.slice(kit.indexOf("const deliver = () => {"), kit.indexOf("// Reduced motion gets no window"));
check("every close checks back", /onClose\?\.\(\);[\s\S]*revive\(/.test(deliver), deliver.trim());
check("…on a delay long enough for React to have committed the unmount",
  /const SHEET_REVIVE_MS = (\d+);/.test(kit) && Number(kit.match(/const SHEET_REVIVE_MS = (\d+);/)[1]) > 0);
// The scrim's asymmetry is the reason the bug was fatal rather than cosmetic, so
// the rule it depends on is asserted in 9A — and stays asserted: a scrim that
// dropped pointer-events on the way out would hide this class of bug, not fix it.

/* ═════════════════════════════════════════════════════════════════════════════
   15. THE NUMBER THAT COUNTED BACKWARDS

   useTween kept its origin in a ref that only advanced when a flight ran to
   COMPLETION, and a target changing mid-flight cancels the frame loop — so the
   next flight interpolated from the reading two updates ago. Settings → Systems →
   Status → Run all checks is the reproduction: two checks go green in one tick and
   a third ~200ms later, and the "Live" tile dropped back to 0 and re-counted to 3
   while two rows were already green. It printed "0 live" as a fact.

   Nothing throws when this is wrong and no final number is wrong, which is why the
   bookkeeping is a plain object in hooks/index.js and why this drives it rather
   than reading it: an interrupted tween must continue from the pixels.
   ═════════════════════════════════════════════════════════════════════════════ */
const hooksMod = await runnable("src/hooks/index.js", ".ambient-smoke-hooks.tmp.mjs");
const { createTween } = hooksMod;
check("the tween's bookkeeping is importable", typeof createTween === "function");
{
  const tw = createTween(0);
  const seen = [];
  const dur = 700;
  check("a mount is already at rest (nothing counts up on page open)", createTween(12).retarget(12, 0) === false);
  check("a real change animates", tw.retarget(2, 0) === true);
  for (const t of [0, 100, 200]) seen.push(tw.frame(t, dur).value);
  // The interruption: a third check lands while the first flight is still running.
  const atInterrupt = tw.painted();
  check("the origin of the next flight is what is painted", tw.retarget(3, 200) === true && atInterrupt > 0 && atInterrupt < 2);
  for (const t of [200, 300, 500, 900]) seen.push(tw.frame(t, dur).value);
  check("no frame ever goes backwards", seen.every((v, i) => i === 0 || v >= seen[i - 1]), seen.map(v => v.toFixed(2)).join(" "));
  check("…and none of them re-prints a superseded reading",
    seen.slice(3).every((v) => v >= atInterrupt), `interrupted at ${atInterrupt.toFixed(2)}: ${seen.map(v => v.toFixed(2)).join(" ")}`);
  check("the flight still lands exactly on the target", seen[seen.length - 1] === 3 && tw.painted() === 3);
  check("…and says so, so the frame loop stops", tw.frame(2000, dur).done === true);
}
// Three interruptions in a row is the shape that made this a lie rather than a
// wobble: every stat tile in the app goes through this now, and Run all checks
// updates the same tile four times inside one 700ms duration.
{
  const tw = createTween(0);
  let low = 0, ok = true;
  for (const [target, at] of [[2, 0], [3, 120], [5, 260], [4, 410]]) {
    tw.retarget(target, at);
    for (const t of [at + 16, at + 60]) {
      const v = tw.frame(t, 700).value;
      // Only the last retarget is downward, and a figure that is genuinely falling
      // is allowed to fall — what must never happen is a rise that starts BELOW
      // where the last frame left it.
      if (target > low && v < low - 1e-9) ok = false;
      low = v;
    }
  }
  check("four readings inside one duration never re-count from behind", ok, String(low));
}

console.log(failed ? `\n${failed} motion check(s) failed` : "\nmotion (the wash + the sheets): all checks passed");
process.exit(failed ? 1 : 0);
