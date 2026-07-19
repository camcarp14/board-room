import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { REGIONS, dnaBus } from "./mindGenome.js";

// ════════════════════════════════════════════════════════════════════════════
// MIND CANVAS — the living picture of Cameron's Mind. One <svg>, one rAF loop,
// zero per-frame React. The force sim (link springs + pairwise repulsion +
// region anchors + mild centering) lives entirely in refs and writes transforms
// imperatively to element refs kept in Maps — React re-renders only on coarse
// events (selection, genome edit, filter, toast). Activation pulses ride the
// same loop: dnaBus events stage node flares and particles that travel each
// synapse's bezier by manual quadratic interpolation — no getPointAtLength in
// the hot path, no allocation storms (fixed particle pool, reused arrays).
// prefers-reduced-motion drops to a fully static render: synchronous settle,
// highlight-only pulses, no ambient dust, no rAF at all.
//
// ── THEME-AWARE (the difference from the clarify original) ───────────────────
// Board Room runs TWO themes on <html data-theme=day|night>: Porcelain (warm
// paper, #F2F1EB) and Graphite (true-black OLED, #000). Every color the app
// draws is a CSS custom property (--accent/--ink/--bg/--green/…). This canvas
// NEVER hardcodes a hex. Two mechanisms keep it honest in both rooms:
//   1. Auto-flip via element.style — SVG fills/strokes set to a var() string
//      (e.g. el.style.fill = "var(--blue)") are resolved live by the browser,
//      so they follow a theme flip with no work from us. Node fills, synapse
//      strokes, labels, specks, particles, the HUD and the injected stylesheet
//      all use var() and flip for free.
//   2. Resolve + repaint for the few things that need a LITERAL — a radial
//      gradient's specular stop is a *lightened* region color, which cannot be
//      expressed as a var(). Those are resolved through cssVar() into a color
//      cache at build time and REBUILT on a MutationObserver watching
//      data-theme, which then rewrites the gradient stops. The observer is
//      disconnected in cleanup alongside everything else.
// Verified in both rooms: on #F2F1EB nothing is a white-on-white ghost; on #000
// nothing is a black-on-black one — every value descends from a token that has
// a legible pair in each theme.
// ════════════════════════════════════════════════════════════════════════════

// ── Tuning — every number here is a feel decision, grouped so the whole
//    character of the mind can be adjusted from one block. ───────────────────
const ZOOM_MIN = 0.35, ZOOM_MAX = 2.6;   // wheel/HUD zoom clamp
const LABEL_ZOOM = 0.55;                 // labels hide below this zoom (they'd be soup)
const RING_R = 320;                      // region anchor ring — matches the seed layout
const ALPHA_SLEEP = 0.005;               // below this the sim is asleep (no writes)
const ALPHA_DECAY = 0.985;               // cooling per tick
const REHEAT = 0.5;                      // wake energy on genome change / drag / add
const SPRING = 0.015;                    // link spring gain
const REPULSE = 3400;                    // pairwise push ∝ 1/d², capped below (hub clusters keep labels clear)
const ANCHOR = 0.0045;                   // pull toward the node's region anchor
const CENTER = 0.0009;                   // mild global centering so the mind never drifts off
const FRICTION = 0.86;
const BOW = 0.18;                        // bezier control offset ⟂ from midpoint, ∝ edge length
const STEP_MS = 350;                     // activation wavefront: ms between propagate steps
const PARTICLES = 28;                    // particle pool size (head+trail pairs), reused forever
const SPECK_N = 40;                      // ambient drifting dust behind the mind
const SPECK_BOUND = RING_R + 340;        // dust wraps inside this world-space box

const POOL_IDX = Array.from({ length: PARTICLES }, (_, i) => i);
const EMPTY_GENOME = { nodes: [], edges: [] };
const REGION_KEYS = Object.keys(REGIONS);

const reduceMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const r1 = (v) => Math.round(v * 10) / 10;                 // short attr strings, cheap
const nodeR = (w) => 9 + 16 * (typeof w === "number" ? w : 0.5);

// ── Token resolution — the ONE sanctioned bridge from a CSS variable to a
//    literal color, for the places a literal is unavoidable (gradient stops).
//    getComputedStyle reads the value currently in force on <html>, so calling
//    this after a data-theme flip returns the NEW palette. Everything else in
//    the file stays as a var() string and never needs this. ───────────────────
function cssVar(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

// REGIONS[k].color is a var() string ("var(--blue)"); pull the token name out
// and resolve it to whatever hex the active theme has assigned. Anything that
// isn't a var() (defensive — shouldn't happen) is passed through untouched.
function resolveColor(c) {
  if (typeof c !== "string") return "";
  const m = /var\(\s*(--[a-zA-Z0-9-]+)\s*\)/.exec(c);
  if (m) return cssVar(m[1]);
  return c;
}

// Split a #RGB / #RRGGBB literal into channels; a resolve miss falls back to a
// neutral grey (numbers only — never a hardcoded hex string in the source).
function chan(hex) {
  let h = String(hex).trim().replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length < 6) return [136, 136, 136];
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return [136, 136, 136];
  return [r, g, b];
}

// The specular highlight on a node orb is its region color pushed toward light.
// Because it's derived from the RESOLVED token, it recomputes correctly for each
// theme when the observer rebuilds the cache — a lit sphere with no fixed hex.
function lighten(hex, amt) {
  const [r, g, b] = chan(hex);
  const L = (v) => Math.round(v + (255 - v) * amt);
  return `rgb(${L(r)},${L(g)},${L(b)})`;
}

// Region anchors — identity holds the center; the other five sit on a hex ring
// (center + 5 = the hexagonal arrangement), mirroring the seed genome's layout
// so physics and persisted positions agree on where each region "lives".
const ANCHORS = (() => {
  const out = { identity: { x: 0, y: 0 } };
  const ring = REGION_KEYS.filter((k) => k !== "identity");
  ring.forEach((k, i) => {
    const th = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
    out[k] = { x: Math.round(Math.cos(th) * RING_R), y: Math.round(Math.sin(th) * RING_R) };
  });
  return out;
})();

// ── Sim construction — carries positions/velocities over from the previous sim
//    so a genome save never snaps the layout; brand-new nodes seed from their
//    persisted x/y or, failing that, jitter around their region anchor. ───────
function buildSim(genome, prev) {
  const byId = new Map();
  const src = Array.isArray(genome.nodes) ? genome.nodes : [];
  // The previous genome's STORED positions, to tell layout drift from intent:
  // carry-over is right for incremental edits (the sim's live position is the
  // truth), but a node whose persisted x/y CHANGED between genomes was placed
  // by something outside this sim — an Import JSON, a reset — and must land
  // where the incoming genome says, not where the old mind happened to drift.
  // (Drag-end persists the live position, so its "change" re-seeds to within
  // half a pixel of where the node already is — no snap.)
  const prevStored = prev && prev.genome && Array.isArray(prev.genome.nodes)
    ? new Map(prev.genome.nodes.map((n) => [n.id, n])) : null;
  const nodes = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const n = src[i];
    const old = prev ? prev.byId.get(n.id) : null;
    const anchor = ANCHORS[n.region] || ANCHORS.identity;
    // (0,0) outside identity means "never placed" — those get anchor + jitter.
    const seeded = Number.isFinite(n.x) && Number.isFinite(n.y) && (n.x !== 0 || n.y !== 0 || n.region === "identity");
    const ps = prevStored ? prevStored.get(n.id) : null;
    const placed = seeded && (!old || (ps && (ps.x !== n.x || ps.y !== n.y)));
    const sn = {
      id: n.id, region: n.region, r: nodeR(n.weight),
      x: placed ? n.x : old ? old.x : seeded ? n.x : anchor.x + (Math.random() - 0.5) * 110,
      y: placed ? n.y : old ? old.y : seeded ? n.y : anchor.y + (Math.random() - 0.5) * 110,
      vx: old ? old.vx : 0, vy: old ? old.vy : 0,
      fixed: old ? old.fixed : false,          // pinned to the pointer while dragged
      ax: anchor.x, ay: anchor.y,
    };
    nodes[i] = sn;
    byId.set(n.id, sn);
  }
  const edgeById = new Map();
  const edges = [];
  const esrc = Array.isArray(genome.edges) ? genome.edges : [];
  for (let i = 0; i < esrc.length; i++) {
    const e = esrc[i];
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;                    // dangling edges never reach the sim
    const w = typeof e.weight === "number" ? e.weight : 0.5;
    const se = { id: e.id, a, b, w, rest: 120 * (1.6 - w) };  // heavy synapses pull tight
    edges.push(se);
    edgeById.set(e.id, se);
  }
  return { nodes, byId, edges, edgeById, alpha: prev ? Math.max(prev.alpha, REHEAT) : 1, genome };
}

// One physics tick. Allocation-free: indexed loops, scalars only. O(n²) on the
// repulsion pass is the worst case and stays cheap at the ≤80-node contract.
function tick(sim) {
  const ns = sim.nodes, es = sim.edges, a = sim.alpha;
  // Link springs — rest length shrinks as weight rises.
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - e.rest) * SPRING * a;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    if (!e.a.fixed) { e.a.vx += fx; e.a.vy += fy; }
    if (!e.b.fixed) { e.b.vx -= fx; e.b.vy -= fy; }
  }
  // Pairwise repulsion — capped so overlaps don't explode, range-limited so
  // distant pairs cost one compare and no sqrt.
  for (let i = 0; i < ns.length; i++) {
    const p = ns[i];
    for (let j = i + 1; j < ns.length; j++) {
      const q = ns[j];
      let dx = q.x - p.x, dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > 96100) continue;                          // >310px apart — negligible
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }  // unstick perfect overlaps
      const d = Math.sqrt(d2);
      let f = (REPULSE / d2) * a;
      if (f > 6) f = 6;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      if (!p.fixed) { p.vx -= fx; p.vy -= fy; }
      if (!q.fixed) { q.vx += fx; q.vy += fy; }
    }
  }
  // Region anchor + mild centering, then integrate.
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }       // dragged node obeys the pointer only
    n.vx += (n.ax - n.x) * ANCHOR * a - n.x * CENTER * a;
    n.vy += (n.ay - n.y) * ANCHOR * a - n.y * CENTER * a;
    n.vx *= FRICTION; n.vy *= FRICTION;
    n.x += n.vx; n.y += n.vy;
  }
  sim.alpha *= ALPHA_DECAY;
}

// Synapse path — quadratic bezier bowed ⟂ from the midpoint. The SAME control
// point feeds the particle interpolation below, so pulses ride the drawn curve.
function edgeD(e) {
  const x1 = e.a.x, y1 = e.a.y, x2 = e.b.x, y2 = e.b.y;
  const cx = (x1 + x2) / 2 - (y2 - y1) * BOW;
  const cy = (y1 + y2) / 2 + (x2 - x1) * BOW;
  return "M" + r1(x1) + " " + r1(y1) + " Q" + r1(cx) + " " + r1(cy) + " " + r1(x2) + " " + r1(y2);
}

// Class-keyed behavior CSS — hover dimming is ONE class toggle on the world
// group ("dna-dim") + a marked subset ("dna-hov"), never per-element React.
// Every color here is a var() so the stylesheet, injected once, follows the
// theme flip with no rewrite of its own.
const CSS = `
.dna-canvas { display: block; touch-action: none; cursor: grab; }
.dna-canvas.dna-grabbing { cursor: grabbing; }
.dna-canvas text { user-select: none; -webkit-user-select: none; }
.dna-canvas g[data-dna-node] { cursor: pointer; transition: opacity 0.18s ease; }
.dna-canvas g[data-dna-edge] { transition: opacity 0.18s ease; }
.dna-canvas .dna-label { transition: opacity 0.22s ease; }
.dna-canvas .dna-zoomout .dna-label { opacity: 0; }
.dna-canvas .dna-dim g[data-dna-node]:not(.dna-hov) { opacity: 0.35 !important; }
.dna-canvas .dna-dim g[data-dna-edge]:not(.dna-hov) { opacity: 0.35; }
/* The "+" link port is hover-revealed AND hover-armed: while invisible it must
   not hit-test, or a touch near a node's 3-o'clock edge (no hover on touch)
   silently hijacks the tap into a phantom link-drag. Touch wiring lives in the
   inspector's "wire a synapse" control instead. */
.dna-canvas .dna-port { opacity: 0; pointer-events: none; transition: opacity 0.15s ease; cursor: crosshair; }
.dna-canvas g[data-dna-node]:hover .dna-port { opacity: 1; pointer-events: auto; }
.dna-canvas .dna-droptar .dna-core { stroke: var(--accent-hi) !important; stroke-width: 2.5px !important; }
.dna-canvas g[data-dna-node].dna-fire .dna-core { stroke: var(--accent-hi) !important; }
.dna-canvas g[data-dna-edge].dna-fire .dna-evis { stroke: var(--accent-hi) !important; opacity: 0.95 !important; }
/* Keyboard path — nodes are tabbable; the accent ring only shows for keyboard
   focus (focus-visible), pointer selection keeps its own halo. */
.dna-canvas g[data-dna-node]:focus { outline: none; }
.dna-canvas g[data-dna-node]:focus-visible .dna-core { stroke: var(--accent) !important; stroke-width: 2.2px !important; }
.dna-hudbtn { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: 999px; color: var(--sub); cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }
.dna-hudbtn:hover { background: var(--ink-a08); color: var(--ink); }
@keyframes dnaFadeIn { from { opacity: 0; transform: translate(-50%, -4px); } to { opacity: 1; transform: translate(-50%, 0); } }
@media (max-width: 860px) {
  /* App's mobile touch-target floor — a miss on a 26px HUD button falls
     through to the svg and pans the viewport. */
  .dna-hudbtn { min-width: 40px; min-height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .dna-canvas g[data-dna-node], .dna-canvas g[data-dna-edge], .dna-canvas .dna-label, .dna-canvas .dna-port { transition: none !important; }
}
`;

export function MindCanvas({
  genome,                    // current genome object
  selection,                 // {type:"node"|"edge", id} | null
  onSelect,                  // (selection|null) => void
  onNodeMove,                // (id, x, y) => void        — fired on drag END (persist positions)
  onAddNode,                 // ({x, y}) => void          — double-click empty canvas
  onAddEdge,                 // ({from, to}) => void      — completed link-drag gesture
  regionFilter,              // Set<regionKey> | null     — null = all visible
  height = "calc(100vh - 150px)",
}) {
  const g = genome && Array.isArray(genome.nodes) ? genome : EMPTY_GENOME;
  const RM = useRef(reduceMotion()).current;
  const toastTop = 62;       // px offset for the activation toast — clears the host view's header band

  // ── The mutable world — everything the rAF loop touches lives on one ref so
  //    stale closures are impossible (handlers registered once only read S). ──
  const st = useRef(null);
  if (!st.current) {
    const specks = [];
    for (let i = 0; i < SPECK_N; i++) {
      specks.push({
        x: (Math.random() * 2 - 1) * SPECK_BOUND, y: (Math.random() * 2 - 1) * SPECK_BOUND,
        vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
        r: 0.5 + Math.random(), o: 0.04 + Math.random() * 0.05,   // ~0.06 ink dust, resolved live via style
      });
    }
    const S0 = {
      sim: null,
      view: { x: 0, y: 0, k: 1 },
      rect: null,                                        // cached svg bbox — measured on mount + ResizeObserver, so fit() never forces layout per frame
      col: null,                                         // resolved color cache — rebuilt on the data-theme observer
      nodeEls: new Map(), flareEls: new Map(), edgeEls: new Map(),
      gradEls: new Map(), centerEls: [],                 // gradient <stop> refs, repainted from the color cache on theme flip
      selEdge: null,                                     // {el, id} for the selected-edge halo path
      specks, speckEls: [],
      pool: POOL_IDX.map(() => ({ active: false, e: null, born: 0, dur: 0 })),
      poolH: [], poolT: [],
      pulses: [],                                        // staged activations, pruned by swap-pop
      glows: new Map(),                                  // nodeId → {start, dur, level}
      marked: [], hover: null,                           // hover-dim bookkeeping
      fireEls: [], fireT: 0,                             // reduced-motion static highlight
      gesture: { mode: null, id: null, from: null, drop: null, edge: null, startX: 0, startY: 0, vx0: 0, vy0: 0, moved: false },
      paused: false,
      raf: 0, toastT: 0,
      userView: false,                                   // true after the first pan/zoom/drag — auto-fit stands down
      fitFn: null,                                       // latest fit() closure, for the loop (registered once at mount)
      // Ref-callback caches — one stable function per element, forever. A fresh
      // closure per render makes React detach (null) and re-attach EVERY node/
      // edge/flare/speck/stop ref on each render — hundreds of Map churns.
      refCbs: { node: new Map(), flare: new Map(), edge: new Map(), selEdge: new Map(), grad: new Map() },
    };
    S0.speckRefCbs = specks.map((_, i) => (el) => { S0.speckEls[i] = el; });
    S0.poolTRefCbs = POOL_IDX.map((i) => (el) => { S0.poolT[i] = el; });
    S0.poolHRefCbs = POOL_IDX.map((i) => (el) => { S0.poolH[i] = el; });
    st.current = S0;
  }
  const S = st.current;

  // Rebuild the sim during render (not an effect) so ref callbacks in THIS
  // commit already see fresh positions — no first-frame flash at (0,0).
  if (!S.sim || S.sim.genome !== g) S.sim = buildSim(g, S.sim);

  const [toast, setToast] = useState(null);              // activation label — set per event, never per frame
  const [physOn, setPhysOn] = useState(true);

  const svgRef = useRef(null);
  const worldRef = useRef(null);
  const bandRef = useRef(null);
  const zoomTextRef = useRef(null);

  // Render-scope derivations (cheap, coarse-grained — never in the rAF loop).
  const visSet = regionFilter
    ? new Set(g.nodes.filter((n) => regionFilter.has(n.region)).map((n) => n.id))
    : null;
  const enabledOf = {};
  for (let i = 0; i < g.nodes.length; i++) enabledOf[g.nodes[i].id] = g.nodes[i].enabled !== false;

  // ── Color cache — resolve the palette to literals for the one place that
  //    needs them (gradient stops). Called at build time and rebuilt whenever
  //    data-theme flips; everything else in the SVG rides var() and flips on
  //    its own, so this cache exists purely to feed paintDefs. ────────────────
  const rebuildColors = () => {
    const region = {};
    for (let i = 0; i < REGION_KEYS.length; i++) {
      const k = REGION_KEYS[i];
      region[k] = resolveColor(REGIONS[k] ? REGIONS[k].color : "");
    }
    return {
      accent: cssVar("--accent"),
      accentHi: cssVar("--accent-hi"),
      bg: cssVar("--bg"),
      ink: cssVar("--ink"),
      red: cssVar("--red"),
      region,
    };
  };

  // Rewrite gradient stops from the cache. The region orb's sheen is a lightened
  // region color (no var() can express "lighter"), so it lives here; the flat
  // node fill and glow use var() via style and never touch this path.
  const paintDefs = () => {
    const col = S.col;
    if (!col) return;
    for (let i = 0; i < REGION_KEYS.length; i++) {
      const k = REGION_KEYS[i];
      const arr = S.gradEls.get(k);
      if (!arr) continue;
      const hex = col.region[k];
      if (!hex) continue;
      if (arr[0]) arr[0].setAttribute("stop-color", lighten(hex, 0.65));   // specular highlight
      if (arr[1]) arr[1].setAttribute("stop-color", hex);                  // mid tint
      if (arr[2]) arr[2].setAttribute("stop-color", hex);                  // fade to transparent
    }
    if (col.accent) {
      if (S.centerEls[0]) S.centerEls[0].setAttribute("stop-color", col.accent);
      if (S.centerEls[1]) S.centerEls[1].setAttribute("stop-color", col.accent);
    }
  };

  // ── View: pan/zoom applied imperatively; label visibility + HUD readout ride
  //    the same call so they can never drift out of sync. ─────────────────────
  const applyView = () => {
    const v = S.view, w = worldRef.current;
    if (w) {
      w.setAttribute("transform", "translate(" + v.x + " " + v.y + ") scale(" + v.k + ")");
      w.classList.toggle("dna-zoomout", v.k < LABEL_ZOOM);
    }
    if (zoomTextRef.current) zoomTextRef.current.textContent = Math.round(v.k * 100) + "%";
  };

  const zoomAt = (sx, sy, k2) => {                       // zoom keeping (sx,sy) fixed on screen
    const v = S.view;
    k2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k2));
    v.x = sx - ((sx - v.x) / v.k) * k2;
    v.y = sy - ((sy - v.y) / v.k) * k2;
    v.k = k2;
    applyView();
  };

  const zoomBy = (f) => {
    const svg = svgRef.current;
    if (!svg) return;
    S.userView = true;                                   // explicit zoom — auto-fit stands down
    const rect = svg.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, S.view.k * f);
  };

  const fit = () => {                                    // frame every visible node with padding
    const svg = svgRef.current, sim = S.sim;
    if (!svg || !sim || sim.nodes.length === 0) return;
    // Cached measure — fit() runs per frame while the sim settles, right after
    // writePositions' attribute writes; a live getBoundingClientRect here is a
    // forced synchronous layout every hot frame. The ResizeObserver keeps the
    // cache honest.
    const rect = S.rect || (S.rect = svg.getBoundingClientRect());
    if (rect.width < 10 || rect.height < 10) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (let i = 0; i < sim.nodes.length; i++) {
      const n = sim.nodes[i];
      if (regionFilter && !regionFilter.has(n.region)) continue;
      any = true;
      if (n.x - n.r < minX) minX = n.x - n.r;
      if (n.x + n.r > maxX) maxX = n.x + n.r;
      if (n.y - n.r < minY) minY = n.y - n.r;
      if (n.y + n.r > maxY) maxY = n.y + n.r;
    }
    if (!any) return;
    const pad = 70;
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(rect.width / (maxX - minX + pad * 2), rect.height / (maxY - minY + pad * 2))));
    S.view.k = k;
    S.view.x = rect.width / 2 - ((minX + maxX) / 2) * k;
    S.view.y = rect.height / 2 - ((minY + maxY) / 2) * k;
    applyView();
  };

  // The loop reads the LATEST fit closure (it captures regionFilter) — refreshed
  // every render so auto-fit never frames against a stale filter.
  S.fitFn = fit;

  const toWorld = (clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect();
    const v = S.view;
    return { x: (clientX - rect.left - v.x) / v.k, y: (clientY - rect.top - v.y) / v.k };
  };

  // ── Imperative position pass — node transforms + edge paths. Called by the
  //    loop while the sim is hot, and once after settles/rebuilds. ────────────
  const writePositions = () => {
    const sim = S.sim;
    if (!sim) return;
    const ns = sim.nodes;
    for (let i = 0; i < ns.length; i++) {
      const el = S.nodeEls.get(ns[i].id);
      if (el) el.setAttribute("transform", "translate(" + r1(ns[i].x) + " " + r1(ns[i].y) + ")");
    }
    const es = sim.edges;
    for (let i = 0; i < es.length; i++) {
      const rec = S.edgeEls.get(es[i].id);
      if (rec && rec.vis) {
        const d = edgeD(es[i]);
        rec.vis.setAttribute("d", d);
        if (rec.hit) rec.hit.setAttribute("d", d);
      }
    }
    if (S.selEdge && S.selEdge.el) {
      const se = sim.edgeById.get(S.selEdge.id);
      if (se) S.selEdge.el.setAttribute("d", edgeD(se));
    }
  };

  // Reduced-motion "physics": run the sim to convergence synchronously, paint
  // once. The layout is identical — it just arrives without the animation.
  const settle = () => {
    const sim = S.sim;
    if (!sim) return;
    if (!S.paused) { let i = 0; while (sim.alpha > ALPHA_SLEEP && i < 400) { tick(sim); i++; } }
    writePositions();
  };

  // ── Hover dimming — one class on the world group; the hovered node, its
  //    synapses, and their far endpoints get marked so CSS can exempt them. ───
  const setHover = (id) => {
    if (S.hover === id) return;
    S.hover = id;
    for (let i = 0; i < S.marked.length; i++) S.marked[i].classList.remove("dna-hov");
    S.marked.length = 0;
    const world = worldRef.current;
    if (!world) return;
    if (!id) { world.classList.remove("dna-dim"); return; }
    world.classList.add("dna-dim");
    const mark = (el) => { if (el) { el.classList.add("dna-hov"); S.marked.push(el); } };
    mark(S.nodeEls.get(id));
    const es = S.sim.edges;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.a.id !== id && e.b.id !== id) continue;
      const rec = S.edgeEls.get(e.id);
      mark(rec && rec.g);
      mark(S.nodeEls.get(e.a.id === id ? e.b.id : e.a.id));  // far endpoint stays lit so edges don't dangle
    }
  };

  // ── Activation pulses — one dnaBus event becomes a time-staged schedule of
  //    particle spawns + node glows consumed by the loop with index pointers
  //    (no shift/splice, no per-frame allocation). ─────────────────────────────
  const spawnParticle = (sp, now) => {
    const e = S.sim && S.sim.edgeById.get(sp.eid);       // re-resolve — genome may have changed mid-pulse
    if (!e) return;
    for (let i = 0; i < PARTICLES; i++) {
      const rec = S.pool[i];
      if (rec.active) continue;
      rec.active = true; rec.e = e; rec.born = now; rec.dur = sp.dur;
      return;
    }                                                    // pool exhausted → drop the particle, never allocate
  };

  const stepPulses = (now) => {
    const ps = S.pulses;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      while (p.si < p.spawns.length && now >= p.spawns[p.si].at) { spawnParticle(p.spawns[p.si], now); p.si++; }
      while (p.gi < p.glows.length && now >= p.glows[p.gi].at) {
        const gl = p.glows[p.gi];
        S.glows.set(gl.id, { start: now, dur: gl.dur, level: gl.level });
        p.gi++;
      }
      if (p.si >= p.spawns.length && p.gi >= p.glows.length && now > p.end) { ps[i] = ps[ps.length - 1]; ps.pop(); }
    }
    // Particles — manual quadratic interpolation along the live bezier (the
    // endpoints may still be moving; the charge follows the wire).
    for (let i = 0; i < PARTICLES; i++) {
      const pt = S.pool[i];
      if (!pt.active) continue;
      const h = S.poolH[i], tr = S.poolT[i];
      if (!h || !pt.e) { pt.active = false; pt.e = null; continue; }
      const t = (now - pt.born) / pt.dur;
      if (t >= 1) {
        pt.active = false; pt.e = null;
        h.setAttribute("opacity", "0");
        if (tr) tr.setAttribute("opacity", "0");
        continue;
      }
      const e = pt.e;
      const x1 = e.a.x, y1 = e.a.y, x2 = e.b.x, y2 = e.b.y;
      const cx = (x1 + x2) / 2 - (y2 - y1) * BOW;
      const cy = (y1 + y2) / 2 + (x2 - x1) * BOW;
      const u = 1 - t;
      h.setAttribute("cx", r1(u * u * x1 + 2 * u * t * cx + t * t * x2));
      h.setAttribute("cy", r1(u * u * y1 + 2 * u * t * cy + t * t * y2));
      h.setAttribute("opacity", 0.95 * (1 - t * 0.35));
      if (tr) {
        const t2 = t < 0.12 ? 0 : t - 0.12;              // the trail lags the head — a comet, not a dot
        const u2 = 1 - t2;
        tr.setAttribute("cx", r1(u2 * u2 * x1 + 2 * u2 * t2 * cx + t2 * t2 * x2));
        tr.setAttribute("cy", r1(u2 * u2 * y1 + 2 * u2 * t2 * cy + t2 * t2 * y2));
        tr.setAttribute("opacity", 0.4 * (1 - t));
      }
    }
    // Node glows — flare ring expands and fades, brightness ∝ activation level.
    for (const [id, gl] of S.glows) {
      const el = S.flareEls.get(id);
      const sn = S.sim ? S.sim.byId.get(id) : null;
      const pr = (now - gl.start) / gl.dur;
      if (pr >= 1 || !el || !sn) {
        if (el) el.setAttribute("opacity", "0");
        S.glows.delete(id);
        continue;
      }
      el.setAttribute("r", r1(sn.r + 3 + 12 * pr));
      el.setAttribute("opacity", Math.max(0, gl.level * (1 - pr) * 0.9));
    }
  };

  const stepSpecks = () => {
    const sp = S.specks;
    for (let i = 0; i < sp.length; i++) {
      const p = sp[i], el = S.speckEls[i];
      p.x += p.vx; p.y += p.vy;
      p.vx += (Math.random() - 0.5) * 0.006;             // brownian wander so the drift never reads as linear
      p.vy += (Math.random() - 0.5) * 0.006;
      if (p.vx > 0.22) p.vx = 0.22; else if (p.vx < -0.22) p.vx = -0.22;
      if (p.vy > 0.22) p.vy = 0.22; else if (p.vy < -0.22) p.vy = -0.22;
      if (p.x > SPECK_BOUND) p.x = -SPECK_BOUND; else if (p.x < -SPECK_BOUND) p.x = SPECK_BOUND;
      if (p.y > SPECK_BOUND) p.y = -SPECK_BOUND; else if (p.y < -SPECK_BOUND) p.y = SPECK_BOUND;
      if (el) { el.setAttribute("cx", r1(p.x)); el.setAttribute("cy", r1(p.y)); }
    }
  };

  // The frame loop. Physics only runs while hot — asleep, a frame is two
  // comparisons plus the ambient dust. Never touches React state.
  const loop = (now) => {
    S.raf = requestAnimationFrame(loop);
    const sim = S.sim;
    if (sim && !S.paused && sim.alpha > ALPHA_SLEEP) {
      tick(sim);
      writePositions();
      // Camera tracks the settling mind — the sim contracts from the seeded
      // ring toward equilibrium, and without this the mount-time fit() leaves
      // the graph small and off-frame. Stands down forever at the user's first
      // pan/zoom/drag (userView) — never fight a human for the viewport.
      if (!S.userView && S.fitFn) S.fitFn();
    }
    else if (S.gesture.mode === "drag") writePositions(); // pinned node tracks the pointer even when paused
    stepSpecks();
    stepPulses(now);
  };

  // Reduced-motion activation: no particles — a 1.2s static highlight of the
  // affected path (nodes + fired synapses go accent), then everything resets.
  const staticFire = (seeds, order, edgesFired) => {
    clearTimeout(S.fireT);
    for (let i = 0; i < S.fireEls.length; i++) S.fireEls[i].classList.remove("dna-fire");
    S.fireEls.length = 0;
    const mark = (el) => { if (el) { el.classList.add("dna-fire"); S.fireEls.push(el); } };
    const ids = new Set(seeds);
    order.forEach((step) => (step || []).forEach((id) => ids.add(id)));
    ids.forEach((id) => {
      mark(S.nodeEls.get(id));
      const f = S.flareEls.get(id), sn = S.sim ? S.sim.byId.get(id) : null;
      if (f && sn) { f.setAttribute("r", r1(sn.r + 6)); f.setAttribute("opacity", "0.7"); }
    });
    edgesFired.forEach((eid) => { const rec = S.edgeEls.get(eid); mark(rec && rec.g); });
    S.fireT = setTimeout(() => {
      for (let i = 0; i < S.fireEls.length; i++) S.fireEls[i].classList.remove("dna-fire");
      S.fireEls.length = 0;
      S.flareEls.forEach((f) => f && f.setAttribute("opacity", "0"));
    }, 1200);
  };

  // dnaBus → staged pulse. All allocation happens HERE, once per event; the
  // loop only walks index pointers through the sorted schedules.
  const onBus = (evt) => {
    if (!evt || evt.type !== "activation") return;
    setToast("⚡ " + (evt.label || "The mind fires"));
    clearTimeout(S.toastT);
    S.toastT = setTimeout(() => setToast(null), 2600);
    const trace = evt.trace || {};
    const order = Array.isArray(trace.order) ? trace.order : [];
    const seeds = Array.isArray(evt.seeds) && evt.seeds.length ? evt.seeds : order[0] || [];
    const edgesFired = Array.isArray(trace.edgesFired) ? trace.edgesFired : [];
    const levels = trace.levels || {};
    if (RM) { staticFire(seeds, order, edgesFired); return; }
    const sim = S.sim;
    if (!sim) return;
    const t0 = performance.now() + 60;                   // small lead so frame 1 catches step 0 cleanly
    const stepOf = {};
    seeds.forEach((id) => { stepOf[id] = 0; });
    order.forEach((ids, s) => (ids || []).forEach((id) => { if (!(id in stepOf)) stepOf[id] = s; }));
    const spawns = [], glows = [];
    seeds.forEach((id) => glows.push({ id, at: t0, dur: 950, level: 1 }));   // seed flare first…
    edgesFired.forEach((eid) => {
      const e = sim.edgeById.get(eid);
      if (!e) return;
      const s = stepOf[e.a.id] || 0;
      const at = t0 + 220 + s * STEP_MS;                 // …then the wavefront, step by step
      const count = e.w > 0.55 ? 2 : 1;                  // heavier synapses carry more charge
      for (let k = 0; k < count; k++) spawns.push({ eid, at: at + k * 140, dur: 560 + Math.random() * 240 });
    });
    order.forEach((ids, s) => {
      if (s === 0) return;
      (ids || []).forEach((id) => glows.push({ id, at: t0 + 220 + s * STEP_MS + 380, dur: 800, level: Math.max(0.25, levels[id] || 0.4) }));
    });
    spawns.sort((a, b) => a.at - b.at);
    glows.sort((a, b) => a.at - b.at);
    S.pulses.push({ spawns, si: 0, glows, gi: 0, end: t0 + (order.length + 1) * STEP_MS + 1400 });
  };

  // ── Gestures — one pointer state machine covers pan, node drag, link-drag,
  //    and click-selection (a "click" is a gesture that never moved >4px). ────
  const cancelLink = () => {
    const gs = S.gesture;
    if (bandRef.current) bandRef.current.style.display = "none";
    if (gs.drop) {
      const el = S.nodeEls.get(gs.drop);
      if (el) el.classList.remove("dna-droptar");
      gs.drop = null;
    }
  };

  const updateBand = (e) => {
    const gs = S.gesture;
    const src = S.sim.byId.get(gs.from);
    const band = bandRef.current;
    if (!src || !band) return;
    const w = toWorld(e.clientX, e.clientY);
    band.setAttribute("d", "M" + r1(src.x) + " " + r1(src.y) + " L" + r1(w.x) + " " + r1(w.y));
    // Manual drop-target hit test — pointer capture means pointerover won't fire.
    let hit = null;
    const ns = S.sim.nodes;
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      if (n.id === gs.from) continue;
      if (visSet && !visSet.has(n.id)) continue;
      const dx = w.x - n.x, dy = w.y - n.y, rr = n.r + 8;
      if (dx * dx + dy * dy <= rr * rr) { hit = n.id; break; }
    }
    if (hit !== gs.drop) {
      if (gs.drop) { const el = S.nodeEls.get(gs.drop); if (el) el.classList.remove("dna-droptar"); }
      if (hit) { const el = S.nodeEls.get(hit); if (el) el.classList.add("dna-droptar"); }
      gs.drop = hit;
    }
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || S.gesture.mode) return;
    const svg = svgRef.current, t = e.target;
    const closest = (sel) => (t.closest ? t.closest(sel) : null);
    const portG = closest("[data-dna-port]");
    const nodeG = closest("[data-dna-node]");
    const gs = S.gesture;
    S.userView = true;                                   // human touched the canvas — auto-fit stands down
    gs.startX = e.clientX; gs.startY = e.clientY; gs.moved = false;
    try { svg.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
    if (nodeG && (e.shiftKey || portG)) {
      gs.mode = "link"; gs.from = nodeG.dataset.id; gs.drop = null;
      if (bandRef.current) bandRef.current.style.display = "";
      updateBand(e);
    } else if (nodeG) {
      gs.mode = "drag"; gs.id = nodeG.dataset.id;
      const sn = S.sim.byId.get(gs.id);
      if (sn) { sn.fixed = true; sn.vx = 0; sn.vy = 0; }
      if (!S.paused) S.sim.alpha = Math.max(S.sim.alpha, REHEAT);
      svg.classList.add("dna-grabbing");
    } else {
      gs.mode = "pan";
      const edgeG = closest("[data-dna-edge]");
      gs.edge = edgeG ? edgeG.dataset.id : null;         // pressed an edge? a still pointer selects it on release
      gs.vx0 = S.view.x; gs.vy0 = S.view.y;
      svg.classList.add("dna-grabbing");
    }
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    const gs = S.gesture;
    if (!gs.mode) return;
    const dx = e.clientX - gs.startX, dy = e.clientY - gs.startY;
    if (!gs.moved && dx * dx + dy * dy > 16) gs.moved = true;
    if (gs.mode === "pan") {
      S.view.x = gs.vx0 + dx; S.view.y = gs.vy0 + dy;
      applyView();
    } else if (gs.mode === "drag") {
      const sn = S.sim.byId.get(gs.id);
      if (!sn) return;
      const w = toWorld(e.clientX, e.clientY);
      sn.x = w.x; sn.y = w.y;
      if (!S.paused) S.sim.alpha = Math.max(S.sim.alpha, REHEAT);
      if (RM) writePositions();                          // no loop under reduced motion — paint directly
    } else if (gs.mode === "link") {
      updateBand(e);
    }
  };

  const onPointerUp = () => {
    const gs = S.gesture;
    if (!gs.mode) return;
    if (svgRef.current) svgRef.current.classList.remove("dna-grabbing");
    if (gs.mode === "drag") {
      const sn = S.sim.byId.get(gs.id);
      if (sn) sn.fixed = false;
      if (gs.moved && sn) {
        if (onNodeMove) onNodeMove(gs.id, Math.round(sn.x), Math.round(sn.y));
        if (!S.paused) S.sim.alpha = Math.max(S.sim.alpha, REHEAT);   // let the web relax around the new pin
        if (RM) settle();
      } else if (onSelect) {
        onSelect({ type: "node", id: gs.id });
      }
    } else if (gs.mode === "pan") {
      if (!gs.moved && onSelect) onSelect(gs.edge ? { type: "edge", id: gs.edge } : null);
    } else if (gs.mode === "link") {
      if (gs.drop && gs.drop !== gs.from && onAddEdge) onAddEdge({ from: gs.from, to: gs.drop });
      cancelLink();
    }
    gs.mode = null;
  };

  const onPointerCancel = () => {
    const gs = S.gesture;
    if (!gs.mode) return;
    if (gs.mode === "drag") { const sn = S.sim.byId.get(gs.id); if (sn) sn.fixed = false; }
    if (gs.mode === "link") cancelLink();
    if (svgRef.current) svgRef.current.classList.remove("dna-grabbing");
    gs.mode = null;
  };

  const onDblClick = (e) => {
    const t = e.target;
    if (t.closest && (t.closest("[data-dna-node]") || t.closest("[data-dna-edge]"))) return;
    const w = toWorld(e.clientX, e.clientY);
    if (onAddNode) onAddNode({ x: Math.round(w.x), y: Math.round(w.y) });
  };

  const onPointerOver = (e) => {                         // delegated hover — one listener, not n
    if (S.gesture.mode) return;
    const nodeG = e.target.closest ? e.target.closest("[data-dna-node]") : null;
    setHover(nodeG ? nodeG.dataset.id : null);
  };

  const onSvgLeave = () => { if (!S.gesture.mode) setHover(null); };

  const onSvgKeyDown = (e) => {                          // delegated, like hover — nodes are tabbable buttons
    if (e.key !== "Enter" && e.key !== " ") return;
    const nodeG = e.target.closest ? e.target.closest("[data-dna-node]") : null;
    if (nodeG && onSelect) { e.preventDefault(); onSelect({ type: "node", id: nodeG.dataset.id }); }
  };

  const togglePhysics = () => {
    const next = !physOn;
    setPhysOn(next);
    S.paused = !next;
    if (next && S.sim) {
      S.sim.alpha = Math.max(S.sim.alpha, REHEAT);
      if (RM) settle();
    }
  };

  // ── Element ref plumbing — Maps of id → element the loop writes into. Every
  //    factory memoizes per id in S.refCbs so the callback identity is stable
  //    across renders — otherwise React tears down and re-attaches every ref
  //    (a null call + a Map delete/set + a setAttribute apiece) on each render.
  //    Stale ids from removed nodes stay cached; bounded and inert. ───────────
  const cached = (map, key, make) => {
    let f = map.get(key);
    if (!f) { f = make(); map.set(key, f); }
    return f;
  };
  const nodeRefCb = (id) => cached(S.refCbs.node, id, () => (el) => {
    if (el) {
      S.nodeEls.set(id, el);
      const sn = S.sim.byId.get(id);
      if (sn) el.setAttribute("transform", "translate(" + r1(sn.x) + " " + r1(sn.y) + ")");
    } else {
      S.nodeEls.delete(id);
    }
  });
  const flareRefCb = (id) => cached(S.refCbs.flare, id, () => (el) => { if (el) S.flareEls.set(id, el); else S.flareEls.delete(id); });
  const edgeRefCb = (id, key) => cached(S.refCbs.edge, `${id} ${key}`, () => (el) => {
    let rec = S.edgeEls.get(id);
    if (!rec) { rec = { g: null, vis: null, hit: null }; S.edgeEls.set(id, rec); }
    rec[key] = el;
    if (el && key !== "g") {
      const se = S.sim.edgeById.get(id);
      if (se) el.setAttribute("d", edgeD(se));
    }
  });
  const selEdgeRefCb = (id) => cached(S.refCbs.selEdge, id, () => (el) => {
    if (el) {
      S.selEdge = { el, id };
      const se = S.sim.edgeById.get(id);
      if (se) el.setAttribute("d", edgeD(se));
    } else if (S.selEdge && S.selEdge.id === id) {
      S.selEdge = null;
    }
  });
  // Gradient <stop> refs — theme-repainted. Cached like the rest so a coarse
  // re-render never re-attaches the defs.
  const gradStopRef = (k, idx) => cached(S.refCbs.grad, `${k}:${idx}`, () => (el) => {
    let arr = S.gradEls.get(k);
    if (!arr) { arr = []; S.gradEls.set(k, arr); }
    arr[idx] = el;
  });
  const centerStopRef = (idx) => cached(S.refCbs.grad, `center:${idx}`, () => (el) => { S.centerEls[idx] = el; });

  // ── Lifecycle. Layout effect so the first paint is already framed (fit),
  //    positioned, and COLORED (paintDefs). Everything registered here is torn
  //    down on unmount: rAF, bus sub, listeners, style tag, timers, and the
  //    theme observer. ─────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const styleEl = document.createElement("style");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
    // Resolve the palette and paint the gradient stops BEFORE the first frame,
    // so nodes are never briefly the default black stop.
    S.col = rebuildColors();
    paintDefs();
    // Measure once, then only when the box actually changes — the per-frame
    // auto-fit reads S.rect instead of forcing layout with a live measure.
    const svg = svgRef.current;
    const measure = () => { S.rect = svg.getBoundingClientRect(); };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(svg);
    if (RM) settle();
    fit();
    const unsub = dnaBus.on(onBus);
    const onKey = (e) => {
      if (e.key === "Escape" && S.gesture.mode === "link") { cancelLink(); S.gesture.mode = null; }
    };
    window.addEventListener("keydown", onKey);
    // Wheel must be non-passive to preventDefault page scroll — React can't do that.
    const onWheel = (e) => {
      e.preventDefault();
      S.userView = true;                                 // wheel zoom — auto-fit stands down
      const rect = svg.getBoundingClientRect();          // live — needs left/top, and wheel is not per-frame
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, S.view.k * Math.exp(-e.deltaY * 0.0016));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    // ── Theme awareness — the room follows the sun, and so must this canvas.
    //    var()-based fills flip on their own; the gradient stops (a literal
    //    lightened region color) do not, so rebuild the color cache and repaint
    //    the defs whenever data-theme changes. A light reheat lets the running
    //    loop composite the fresh palette; under reduced motion we settle once.
    const onTheme = () => {
      S.col = rebuildColors();
      paintDefs();
      if (RM) { settle(); }
      else if (!S.paused && S.sim) S.sim.alpha = Math.max(S.sim.alpha, 0.14);
    };
    const themeObs = new MutationObserver(onTheme);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (!RM) S.raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(S.raf);
      unsub && unsub();
      window.removeEventListener("keydown", onKey);
      svg.removeEventListener("wheel", onWheel);
      if (ro) ro.disconnect();
      themeObs.disconnect();                             // the theme observer stands down with everything else
      clearTimeout(S.toastT);
      clearTimeout(S.fireT);
      styleEl.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Genome changed (buildSim already ran in render and reheated alpha) — make
  // sure any freshly mounted elements get positions, and settle statically
  // under reduced motion since there's no loop to do it.
  useEffect(() => {
    writePositions();
    if (RM) { settle(); if (!S.userView) fit(); }        // no loop under reduced motion — reframe here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g]);

  // Glass chrome — all tokens, so the HUD and toast re-tone with the room. The
  // app's own --glass-raised / --line / --shadow-float carry the light/dark pair.
  const glass = {
    background: "var(--glass-raised)",
    backdropFilter: "blur(18px) saturate(1.6)",
    WebkitBackdropFilter: "blur(18px) saturate(1.6)",
    border: "1px solid var(--line)",
    boxShadow: "var(--shadow-float)",
  };

  return (
    <div style={{ position: "relative", width: "100%", height, overflow: "hidden" }}>
      <svg
        ref={svgRef}
        className="dna-canvas"
        width="100%"
        height="100%"
        role="application"
        aria-label="Cameron's Mind neural map"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerOver={onPointerOver}
        onPointerLeave={onSvgLeave}
        onDoubleClick={onDblClick}
        onKeyDown={onSvgKeyDown}
      >
        <defs>
          {/* Soft region-color bloom behind each node — a blur applied to a
              var()-filled circle, so the glow follows the theme for free. */}
          <filter id="mindGlow" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="4.5" />
          </filter>
          {/* Specular sheen per region — a highlight blob whose color is a
              LIGHTENED region color (no var() expresses "lighter"), so its
              stops are painted imperatively and repainted on theme flip. */}
          {REGION_KEYS.map((k) => (
            <radialGradient key={k} id={`mindGrad_${k}`} cx="36%" cy="32%" r="72%">
              <stop offset="0%" ref={gradStopRef(k, 0)} stopOpacity="0.9" />
              <stop offset="42%" ref={gradStopRef(k, 1)} stopOpacity="0.16" />
              <stop offset="100%" ref={gradStopRef(k, 2)} stopOpacity="0" />
            </radialGradient>
          ))}
          {/* The one extra lamp — a faint accent pool under the mind's center. */}
          <radialGradient id="mindCenterGlow">
            <stop offset="0%" ref={centerStopRef(0)} stopOpacity="0.08" />
            <stop offset="100%" ref={centerStopRef(1)} stopOpacity="0" />
          </radialGradient>
        </defs>

        <g ref={worldRef} className="dna-world">
          {/* Faint accent pool under the mind's center. */}
          <circle cx="0" cy="0" r="480" fill="url(#mindCenterGlow)" style={{ pointerEvents: "none" }} />

          {/* Ambient dust — ink at ~6% via style so it flips; skipped under
              reduced motion. */}
          {!RM && (
            <g style={{ pointerEvents: "none" }}>
              {S.specks.map((p, i) => (
                <circle key={i} ref={S.speckRefCbs[i]} cx={r1(p.x)} cy={r1(p.y)} r={r1(p.r)} opacity={p.o} style={{ fill: "var(--ink)" }} />
              ))}
            </g>
          )}

          {/* Synapses — accent excitatory, red dashed inhibitory (both via style
              so they flip); width + opacity carry the weight. Each gets an
              invisible fat twin for hit testing. */}
          {g.edges.map((e) => {
            const w = typeof e.weight === "number" ? e.weight : 0.5;
            const inhib = e.polarity === -1;
            const sw = 0.8 + 2.6 * w;                                  // width 0.8–3.4
            const bothOn = enabledOf[e.from] !== false && enabledOf[e.to] !== false;
            const op = (0.22 + 0.28 * w) * (bothOn ? 1 : 0.28);        // excitatory 0.22–0.5 by weight
            const hidden = visSet ? !(visSet.has(e.from) && visSet.has(e.to)) : false;
            const selE = selection && selection.type === "edge" && selection.id === e.id;
            return (
              <g key={e.id} data-dna-edge="" data-id={e.id} ref={edgeRefCb(e.id, "g")} style={{ display: hidden ? "none" : undefined }}>
                {selE && (
                  <path ref={selEdgeRefCb(e.id)} fill="none" strokeWidth={sw + 3.5} opacity="0.3" strokeLinecap="round" style={{ stroke: "var(--accent-hi)", pointerEvents: "none" }} />
                )}
                <path
                  className="dna-evis"
                  ref={edgeRefCb(e.id, "vis")}
                  fill="none"
                  strokeWidth={sw}
                  opacity={op}
                  strokeDasharray={inhib ? "6 5" : undefined}
                  strokeLinecap="round"
                  style={{ stroke: inhib ? "var(--red)" : "var(--accent)" }}
                />
                <path ref={edgeRefCb(e.id, "hit")} fill="none" strokeWidth="11" style={{ stroke: "transparent", pointerEvents: "stroke", cursor: "pointer" }} />
              </g>
            );
          })}

          {/* Link-drag rubber band — shown/positioned imperatively by the gesture. */}
          <path
            ref={bandRef}
            fill="none"
            strokeWidth="1.5"
            strokeDasharray="7 6"
            opacity="0.85"
            style={{ stroke: "var(--accent)", display: "none", pointerEvents: "none" }}
          />

          {/* Nodes — region glow, flare ring (pulse-driven), selection halo,
              flat region core (auto-flips via style), specular sheen, padlock
              for locked governance, hover "+" port, label. */}
          {g.nodes.map((n) => {
            const hidden = visSet ? !visSet.has(n.id) : false;
            const r = nodeR(n.weight);
            const regKey = REGIONS[n.region] ? n.region : "identity";
            const regColor = REGIONS[regKey].color;                   // "var(--…)" — resolves & flips live
            const selN = selection && selection.type === "node" && selection.id === n.id;
            const disabled = n.enabled === false;
            return (
              <g
                key={n.id}
                data-dna-node=""
                data-id={n.id}
                ref={nodeRefCb(n.id)}
                tabIndex={0}
                role="button"
                aria-label={`${n.label} — ${REGIONS[regKey].label}, weight ${Math.round((typeof n.weight === "number" ? n.weight : 0) * 100)}%${disabled ? ", silenced" : ""}`}
                style={{
                  display: hidden ? "none" : undefined,
                  opacity: disabled ? 0.3 : 1,                        // silenced → 0.3 + desaturate
                  filter: disabled ? "saturate(0.2)" : undefined,
                }}
              >
                <title>{n.label}{n.text ? ` — ${n.text}` : ""}</title>
                {/* soft glow — region color, blurred; fill via style so it flips */}
                <circle r={r + 3} opacity="0.4" style={{ fill: regColor, filter: "url(#mindGlow)", pointerEvents: "none" }} />
                <circle className="dna-flare" ref={flareRefCb(n.id)} r={r + 4} fill="none" strokeWidth="2" opacity="0" style={{ stroke: "var(--accent-hi)", pointerEvents: "none" }} />
                {selN && (
                  <>
                    <circle r={r + 9} fill="none" strokeWidth="5" opacity="0.16" style={{ stroke: "var(--accent)", pointerEvents: "none" }} />
                    <circle r={r + 5.5} fill="none" strokeWidth="1.4" opacity="0.95" style={{ stroke: "var(--accent)", pointerEvents: "none" }} />
                  </>
                )}
                {/* flat core — region fill + 1px line-strong stroke, both var() via
                    style, so the node body auto-flips with the theme */}
                <circle className="dna-core" r={r} strokeWidth="1" style={{ fill: regColor, stroke: "var(--line-strong)" }} />
                {/* lit-sphere sheen — the theme-repainted gradient overlay */}
                <circle r={r} fill={`url(#mindGrad_${regKey})`} style={{ pointerEvents: "none" }} />
                {n.locked && (
                  <g transform={`translate(${r1(r * 0.72)} ${r1(-r * 0.72)})`} style={{ pointerEvents: "none" }}>
                    <circle r="5.4" strokeWidth="0.8" style={{ fill: "var(--bg)", stroke: "var(--line-strong)" }} />
                    <path d="M -1.7 -0.4 v -0.9 a 1.7 1.7 0 0 1 3.4 0 v 0.9" fill="none" strokeWidth="1.1" strokeLinecap="round" style={{ stroke: "var(--accent)" }} />
                    <rect x="-2.3" y="-0.5" width="4.6" height="3.5" rx="0.9" style={{ fill: "var(--accent)" }} />
                  </g>
                )}
                <circle className="dna-port" data-dna-port="" data-id={n.id} cx={r1(r + 7)} cy="0" r="5.5" strokeWidth="1" style={{ fill: "var(--surface)", stroke: "var(--line-strong)" }} />
                <path className="dna-port" d={`M ${r1(r + 4.5)} 0 h 5 M ${r1(r + 7)} -2.5 v 5`} fill="none" strokeWidth="1.2" style={{ stroke: "var(--accent)", pointerEvents: "none" }} />
                <text
                  className="dna-label"
                  y={r1(r + 15)}
                  textAnchor="middle"
                  style={{ fontFamily: "var(--font-display)", fontSize: "10px", fontWeight: 600, fill: "var(--ink)", pointerEvents: "none", paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: "3px", strokeLinejoin: "round" }}
                >
                  {n.label}
                </text>
              </g>
            );
          })}

          {/* Particle pool — fixed set of comet pairs, recycled across pulses.
              accent-hi via style so charges tint with the room. */}
          {!RM && (
            <g style={{ pointerEvents: "none" }}>
              {POOL_IDX.map((i) => (
                <g key={i}>
                  <circle ref={S.poolTRefCbs[i]} r="1.6" opacity="0" style={{ fill: "var(--accent-hi)" }} />
                  <circle ref={S.poolHRefCbs[i]} r="2.5" opacity="0" style={{ fill: "var(--accent-hi)" }} />
                </g>
              ))}
            </g>
          )}
        </g>
      </svg>

      {/* Activation toast — floats top-center while the mind works. Offset below
          the host view's header band; long labels ellipsize instead of running
          under whatever floats nearby. */}
      {toast && (
        <div
          style={{
            ...glass,
            position: "absolute", top: `${toastTop}px`, left: "50%", transform: "translateX(-50%)",
            zIndex: 12,   // above the header band — it's transient and pointer-events:none, so it can never block a click
            maxWidth: "clamp(240px, 52vw, 560px)", overflow: "hidden", textOverflow: "ellipsis",
            padding: "7px 16px", borderRadius: "999px", border: "1px solid var(--accent-a40)",
            color: "var(--accent)", fontFamily: "var(--font-display)", fontSize: "12px", fontWeight: 700,
            letterSpacing: "0.02em", whiteSpace: "nowrap", pointerEvents: "none",
            animation: RM ? "none" : "dnaFadeIn 0.25s",
          }}
        >
          {toast}
        </div>
      )}

      {/* HUD — glassy pill cluster, bottom-right. Small enough to never block
          gestures. All tokens, so it re-tones with the room. */}
      <div
        style={{
          ...glass,
          position: "absolute", right: "14px", bottom: "14px",
          display: "flex", alignItems: "center", gap: "2px",
          padding: "4px 6px", borderRadius: "999px",
        }}
      >
        <button className="dna-hudbtn" title="Zoom out" onClick={() => zoomBy(1 / 1.28)}>−</button>
        <span ref={zoomTextRef} style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--sub)", minWidth: "38px", textAlign: "center" }}>
          {Math.round(S.view.k * 100)}%
        </span>
        <button className="dna-hudbtn" title="Zoom in" onClick={() => zoomBy(1.28)}>+</button>
        <span style={{ width: "1px", height: "16px", background: "var(--line)", margin: "0 4px" }} />
        <button
          className="dna-hudbtn"
          title="Fit the whole mind in view"
          onClick={fit}
          style={{ width: "auto", padding: "0 10px", fontSize: "9px", fontWeight: 700, letterSpacing: "0.1em", fontFamily: "var(--font-display)" }}
        >
          FIT
        </button>
        <button
          className="dna-hudbtn"
          title={physOn ? "Pause layout physics" : "Resume layout physics"}
          onClick={togglePhysics}
          style={{ color: physOn ? "var(--accent)" : "var(--sub)", fontSize: "10px" }}
        >
          {physOn ? "❚❚" : "▶"}
        </button>
      </div>
    </div>
  );
}
