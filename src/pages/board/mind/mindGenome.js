import { sm } from "../../../lib/storage.js";

// ════════════════════════════════════════════════════════════════════════════
// CAMERON'S MIND — the genome layer. Nodes are aspects of how he thinks
// (identity, principles, knowledge, signals, skills, goals); edges are weighted
// synapses. The graph is FUNCTIONAL: compileGenome() deterministically turns it
// into the system prompt the Mind (and, downstream, the Mini Me delegate) runs
// on, and propagate() computes the activation wave the canvas animates.
// Persistence is `sm` (localStorage, src/lib/storage.js) under GENOME_KEY —
// which resolves to the raw key `br_mind_genome` because sm prefixes `br_`.
// The seed genome is DATA, not code: this file's logic never mentions a specific
// node, so the mind can be rewired, exported, and re-imported without edits.
// Ported from clarify-outreach/src/lib/dna.js — same public API, single genome,
// blended seed (Cameron's operating system + the five board seats' wisdom).
// ════════════════════════════════════════════════════════════════════════════

// The sm-key. sm.get/set prefix `br_`, so the true localStorage key is
// `br_mind_genome` — the value the integration spec pins.
export const GENOME_KEY = "mind_genome";

// Single region vocabulary — every consumer (canvas, panel, delegate) reads
// this. Colors are CSS-var strings so they FLIP with the theme: the canvas and
// panels feed them straight into element.style.* and the browser resolves each
// var() live against whichever <html data-theme> is active (day/night). Never
// hardcode a hex here — a literal would freeze one node color across both themes.
export const REGIONS = {
  identity:  { label: "Identity",   color: "var(--accent)", desc: "Who Cameron is" },
  principle: { label: "Principles", color: "var(--purple)", desc: "Rules that govern every call" },
  knowledge: { label: "Knowledge",  color: "var(--blue)",   desc: "What he knows and has learned" },
  signal:    { label: "Signals",    color: "var(--amber)",  desc: "Inputs he weighs when deciding" },
  skill:     { label: "Skills",     color: "var(--green)",  desc: "Moves the mind can make" },
  goal:      { label: "Goals",      color: "var(--pink)",   desc: "What he is driving toward" },
};

// Compile order is MEANING, not alphabet: who you are → what you must never do
// → what you want → what you're seeing → what you know → what you can do.
// The MIND_CHARTER always precedes all of it (prepended verbatim in compileGenome).
export const REGION_ORDER = ["identity", "principle", "goal", "signal", "knowledge", "skill"];

// The charter — the fixed frame the whole compiled mind hangs off. It leads
// compileGenome's systemPrompt verbatim so that no weight slider anywhere in the
// genome can out-rank the operating stance: pressure-test, ten-hours, decouple,
// name conflicts, advisory. Cameron decides — the mind only argues well.
export const MIND_CHARTER =
  "You are Cameron's Mind — a model of how he thinks and operates. " +
  "Pressure-test over validation; never glaze weaknesses. " +
  "Optimize for the best use of the next 10 hours and for decoupling income from hours sold. " +
  "Name conflicts; don't smooth them. Advisory — Cameron decides.";


// ─── small pure helpers ───────────────────────────────────────────────────────
const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };

// ONE truthiness rule for `enabled`, everywhere: a node is awake unless it is
// EXPLICITLY disabled. Hand-authored / imported genomes may omit the field — the
// panel, canvas, compiler, propagator, and stats all read `!== false`, and they
// MUST agree, or an imported mind renders fully awake while compiling to nothing.
const isAwake = (n) => !!n && n.enabled !== false;

// djb2 — the classic Bernstein hash, kept in 32-bit int math and rendered as
// unsigned hex. Tiny, dependency-free, and stable across sessions/browsers,
// which is all the "mind hash" needs to be.
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// Deterministic 0..1 "jitter" derived from the node id — the seed layout looks
// organic but two seedGenome() calls are structurally identical (testable, and
// resetting the mind doesn't reshuffle the map under you).
const jitter = (id, salt) => (parseInt(djb2(salt + id), 16) % 997) / 997;

let mutSeq = 0; // uniqueness within a single millisecond of rapid edits
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${(mutSeq++).toString(36)}`;

const slugify = (label) => String(label || "node").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "node";


// ─── event bus — module-level singleton ──────────────────────────────────────
// Declared early so persistence can emit into it without any temporal-dead-zone
// worry. One channel, two event shapes:
//   {type:"activation", seeds, trace, label}  — a pulse fires the canvas
//   {type:"genome", genome}                   — every saveGenome, so all views converge
// Listeners are isolated: one throwing subscriber never silences the rest.
export const dnaBus = (() => {
  const subs = new Set();
  return {
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(evt) { subs.forEach(fn => { try { fn(evt); } catch { /* a bad listener can't break the bus */ } }); },
  };
})();


// ─── seed layout — hexagonal region arrangement ──────────────────────────────
// Identity sits at the center (everything radiates from who Cameron is); the
// other five regions ring it at radius ~320, principles crowning the top.
// Nodes fan around their region anchor with deterministic jitter so the first
// paint already reads as a living thing, before physics ever runs.
const RING_R = 320;
const SPREAD_R = 92;
const RING_DEG = { principle: -90, knowledge: -18, signal: 54, skill: 126, goal: 198 };

function seedPosition(region, index, count, id) {
  const a = region === "identity" ? { x: 0, y: 0 }
    : { x: Math.cos((RING_DEG[region] * Math.PI) / 180) * RING_R, y: Math.sin((RING_DEG[region] * Math.PI) / 180) * RING_R };
  const deg = -90 + (index * 360) / count + (jitter(id, "a") - 0.5) * 26;
  const r = SPREAD_R * (0.72 + jitter(id, "r") * 0.55);
  return {
    x: Math.round(a.x + Math.cos((deg * Math.PI) / 180) * r),
    y: Math.round(a.y + Math.sin((deg * Math.PI) / 180) * r),
  };
}


// ─── the seed genome — Cameron's actual mind, the BLEND ──────────────────────
// Core = Cameron's personal operating system. Knowledge = the five board seats'
// charters (claude.js BOARD) ported in as wisdom, the board mechanism dropped.
// Every text is a real directive. All six principles are LOCKED — the operating
// spine can be re-weighted but not silenced or deleted. Skill nodes carry model
// defaults ({modelKey, maxTokens}) so the panel/delegate know what to run them on.
const seedN = (id, label, weight, text, extra = {}) => ({ id, label, weight, text, ...extra });

const SEED_NODES = {
  identity: [
    seedN("n_id_builder", "Builder — two ventures + a day job", 0.85,
      "Cameron is a builder: he runs Clarify and Zero To Secure alongside a Senior Analyst day job. Every hour is contested. Operate like an owner who is short on time, never like an employee filling one."),
    seedN("n_id_decouple", "Decoupling income from hours", 0.9,
      "The through-line of everything he does: build assets and systems that earn without his hours attached. Trade time for leverage, not for wages — that is the whole game."),
    seedN("n_id_voice", "Direct, pressure-tested voice", 0.85,
      "Speak plainly, lead with the real number, and put the weakness in the first sentence — not buried at the end. He asked for pressure-testing over validation; honor it in how you talk, not just what you conclude."),
    seedN("n_id_standard", "The Firm / Roman operating standard", 0.75,
      "Work carries a craft standard — precise, unhurried, zero filler. Discipline over motion. A thing is done when it would survive scrutiny, not when it merely stopped."),
  ],
  principle: [
    seedN("n_pr_pressure", "Pressure-test over validation", 1.0,
      "Never validate to be agreeable. Argue the other side, surface the weakest assumption first, and never glaze over a flaw to make an idea feel better than it is.", { locked: true }),
    seedN("n_pr_10hours", "Best use of the next 10 hours", 0.95,
      "Measure every choice against one question: is this the highest-leverage use of the next 10 hours? A task that can't defend itself against that question does not get done.", { locked: true }),
    seedN("n_pr_decouple", "Decouple income from hours sold", 0.95,
      "Bias every recommendation toward assets, systems, and recurring revenue over billable time. Selling hours is the trap being escaped, not the plan.", { locked: true }),
    seedN("n_pr_ship", "Ship — published beats perfect", 0.85,
      "A shipped B beats an unshipped A. Momentum compounds; private polish does not. Push it live, then iterate against reality.", { locked: true }),
    seedN("n_pr_conflict", "Name conflicts, don't smooth them", 0.9,
      "When two aims or two takes collide, say so plainly and give a recommendation. Smoothing a conflict over hides the decision that actually has to be made.", { locked: true }),
    seedN("n_pr_risk", "Manage risk asymmetries", 0.9,
      "Size for survival first. The leveraged WBTC-on-Aave position is managed carefully — respect the liquidation math, never chase, and weigh downside asymmetry before any upside.", { locked: true }),
  ],
  knowledge: [
    seedN("n_kn_clarify", "Clarify economics", 0.75,
      "Clarify is a boutique Google Ads agency for high-value local service verticals — legal, med spa, dental, home services. It lives on pipeline value, reply rates, and retainer economics; legal and med-spa retainers are the large ones. Be direct about what will and won't move revenue."),
    seedN("n_kn_zts", "ZTS DTC unit economics", 0.7,
      "Zero To Secure sells a $150 stainless-steel seed-phrase backup kit, DTC on Shopify. Growth comes from creator collabs, YouTube Shorts, and SEO content; the levers are audience-fit reach, content cadence, and conversion on premium unit economics."),
    seedN("n_kn_macro", "BTC / macro thesis", 0.75,
      "Long-term Bitcoin conviction plus a leveraged WBTC-on-Aave position, managed carefully. Live thesis on an AI-investment bubble — circular hyperscaler financing and private-credit exposure. The job here is honest pressure-testing: flag risk asymmetries, don't cheerlead the position."),
    seedN("n_kn_ops", "Ops & finance discipline", 0.7,
      "Across every venture, watch time allocation, AI/tool spend, and whether effort matches expected return. The governing question is always whether this is the best use of the next 10 hours."),
    seedN("n_kn_career", "Career ladder", 0.65,
      "Senior Analyst in paid search at Ovative Group — Chicago, healthcare portfolio — where promotions are tenure-weighted and upward mobility is capped. Path: RevOps Manager at a mid-size SaaS within ~2 years for materially higher comp; Salesforce-adjacent skills matter. Weigh day-job moves against the ventures without romanticizing either."),
    seedN("n_kn_custody", "Self-custody conviction", 0.6,
      "Bitcoin self-custody is empowerment over fear. The point of ZTS and of the macro conviction alike is control of your own keys and outcomes — sold as capability, never as panic."),
    seedN("n_kn_recurring", "Recurring revenue is the win", 0.7,
      "Near-term success is defined narrowly: meaningful recurring revenue from a venture. One-off wins are noise; monthly recurring is the scoreboard that counts right now."),
  ],
  signal: [
    seedN("n_sg_time", "Time allocation (next 10 hours)", 0.9,
      "Where are the next 10 hours actually going? Watch for hours leaking into low-leverage motion — the calendar is the truest statement of priorities."),
    seedN("n_sg_recurring", "Recurring-revenue progress", 0.85,
      "Track real movement toward recurring revenue: new retainers, repeat and subscription momentum. Flat MRR is the signal that the current plan is not working yet."),
    seedN("n_sg_btc_risk", "BTC position risk", 0.8,
      "Watch the WBTC-on-Aave health factor, the leverage ratio, and the macro regime. Rising liquidation risk or a shifting rate/vol backdrop outranks any upside excitement."),
    seedN("n_sg_momentum", "Venture momentum", 0.75,
      "Read the leading indicators — Clarify pipeline value and reply rates, ZTS content cadence and conversion. Momentum is the cheapest thing to lose and the most expensive to rebuild."),
    seedN("n_sg_dayjob", "Day-job leverage vs venture pull", 0.65,
      "Weigh what the Ovative role compounds — comp, RevOps-adjacent skill, stability — against the pull of the ventures. Neither gets romanticized; the ledger decides."),
    seedN("n_sg_spend", "AI / tool spend", 0.6,
      "Watch AI and tooling spend against return. Cheap-first — a tool earns its subscription or it gets cut."),
  ],
  skill: [
    seedN("n_sk_triage", "Triage the day", 0.85,
      "Read the current state and name the single highest-leverage move for the next block of hours — specific and actionable, not a menu of options.",
      { modelKey: "haiku", maxTokens: 500 }),
    seedN("n_sk_pressure", "Pressure-test a decision", 0.85,
      "Take a decision or plan and argue against it: name the weakest assumption, the risk asymmetry, the thing being glazed over — then give a clear verdict.",
      { modelKey: "sonnet", maxTokens: 700 }),
    seedN("n_sk_brief", "Brief the delegate", 0.7,
      "Turn an intention into a crisp, self-contained brief the Mini Me delegate can execute — scope, the context it needs, and an explicit definition of done.",
      { modelKey: "haiku", maxTokens: 500 }),
    seedN("n_sk_strategy", "Synthesize weekly strategy", 0.75,
      "Compile the week: read momentum across the ventures, the day job, and macro, and name the two or three moves that actually matter — not a list of everything possible.",
      { modelKey: "sonnet", maxTokens: 900 }),
    seedN("n_sk_grow", "Grow the mind", 0.55,
      "Scan what's been learned and propose new nodes or rewirings for this genome — the mind updates itself from what actually worked.",
      { modelKey: "haiku", maxTokens: 500 }),
  ],
  goal: [
    seedN("n_gl_decouple", "Decouple income from hours", 0.95,
      "The north star: income that does not require selling more hours. Grade every venture and career move on whether it moves toward this or away from it."),
    seedN("n_gl_recurring", "Meaningful recurring revenue", 0.85,
      "Get at least one venture to meaningful, durable recurring revenue — the nearest concrete proof that the decoupling is real."),
    seedN("n_gl_revops", "RevOps move within ~2 years", 0.7,
      "Land a RevOps Manager role at a mid-size SaaS within roughly two years for materially higher comp, and build the Salesforce-adjacent skills that get there."),
    seedN("n_gl_btc", "Grow the BTC position safely", 0.75,
      "Grow the Bitcoin position across the cycle without ever taking a forced liquidation. Compound conviction, sized so a drawdown never ends the game."),
  ],
};

// Synapses. Excitatory (+1) wiring: goals prime signals, signals + knowledge
// drive skills, identity soaks into the doing, skills feed back into goals.
// Inhibitory (−1) wiring is where the character lives: the locked principles
// TEMPER the action skills and the riskier goals — these compile into the
// INTERNAL TENSIONS block, and in propagate() they dampen the very skills the
// signals are exciting, so the model is told which impulse wins, not left to
// average two of them.
const seedE = (from, to, weight, polarity = 1) => ({ id: `e_${from.slice(2)}_${to.slice(2)}`, from, to, weight, polarity });

const SEED_EDGES = [
  // goals → signals (what he wants primes what he watches)
  seedE("n_gl_decouple", "n_sg_time", 0.7),
  seedE("n_gl_decouple", "n_sg_recurring", 0.8),
  seedE("n_gl_decouple", "n_sg_dayjob", 0.5),
  seedE("n_gl_recurring", "n_sg_recurring", 0.85),
  seedE("n_gl_recurring", "n_sg_momentum", 0.7),
  seedE("n_gl_revops", "n_sg_dayjob", 0.8),
  seedE("n_gl_revops", "n_sg_time", 0.4),
  seedE("n_gl_btc", "n_sg_btc_risk", 0.85),
  // signals → skills (what he sees drives what the mind does)
  seedE("n_sg_time", "n_sk_triage", 0.9),
  seedE("n_sg_momentum", "n_sk_triage", 0.7),
  seedE("n_sg_recurring", "n_sk_strategy", 0.75),
  seedE("n_sg_btc_risk", "n_sk_pressure", 0.8),
  seedE("n_sg_dayjob", "n_sk_pressure", 0.6),
  seedE("n_sg_momentum", "n_sk_strategy", 0.65),
  seedE("n_sg_spend", "n_sk_triage", 0.5),
  seedE("n_sg_recurring", "n_sk_triage", 0.55),
  seedE("n_sg_time", "n_sk_brief", 0.5),
  seedE("n_sg_spend", "n_sk_pressure", 0.45),
  // knowledge → skills (the blended playbook informs the acts)
  seedE("n_kn_ops", "n_sk_triage", 0.7),
  seedE("n_kn_recurring", "n_sk_strategy", 0.7),
  seedE("n_kn_macro", "n_sk_pressure", 0.75),
  seedE("n_kn_clarify", "n_sk_strategy", 0.55),
  seedE("n_kn_zts", "n_sk_strategy", 0.55),
  seedE("n_kn_career", "n_sk_pressure", 0.5),
  seedE("n_kn_ops", "n_sk_brief", 0.5),
  seedE("n_kn_recurring", "n_sk_triage", 0.5),
  seedE("n_kn_custody", "n_sk_grow", 0.4),
  seedE("n_kn_clarify", "n_sk_grow", 0.45),
  // identity → everything, lightly (who he is soaks into all of it)
  seedE("n_id_voice", "n_sk_pressure", 0.55),
  seedE("n_id_voice", "n_sk_strategy", 0.4),
  seedE("n_id_decouple", "n_gl_decouple", 0.5),
  seedE("n_id_builder", "n_sk_triage", 0.4),
  seedE("n_id_standard", "n_sk_brief", 0.4),
  seedE("n_id_standard", "n_gl_recurring", 0.35),
  // principles → skills (two of the locks also POWER the doing, not just temper)
  seedE("n_pr_10hours", "n_sk_triage", 0.65),
  seedE("n_pr_pressure", "n_sk_pressure", 0.6),
  seedE("n_pr_conflict", "n_sk_pressure", 0.45),
  // skills → goals + skill chaining (acting moves the mission)
  seedE("n_sk_triage", "n_gl_recurring", 0.6),
  seedE("n_sk_triage", "n_gl_decouple", 0.5),
  seedE("n_sk_strategy", "n_gl_decouple", 0.6),
  seedE("n_sk_strategy", "n_gl_recurring", 0.55),
  seedE("n_sk_pressure", "n_gl_btc", 0.5),
  seedE("n_sk_brief", "n_gl_recurring", 0.45),
  seedE("n_sk_grow", "n_kn_recurring", 0.5),
  seedE("n_sk_triage", "n_sk_brief", 0.5),
  seedE("n_sk_strategy", "n_sk_triage", 0.45),
  seedE("n_sk_pressure", "n_sk_strategy", 0.4),
  // ── inhibitory tensions ── the locks temper the impulses (12) ─────────────
  seedE("n_pr_decouple", "n_sg_dayjob", 0.6, -1),   // decoupling ⊣ over-weighting the day job
  seedE("n_pr_pressure", "n_sk_strategy", 0.7, -1), // pressure-test ⊣ a cheerleading weekly narrative
  seedE("n_pr_pressure", "n_sk_triage", 0.55, -1),  // pressure-test ⊣ picking the fun move
  seedE("n_pr_pressure", "n_sk_grow", 0.6, -1),     // pressure-test ⊣ adding flattering nodes
  seedE("n_pr_10hours", "n_sk_brief", 0.55, -1),    // ten-hours ⊣ delegating busywork
  seedE("n_pr_10hours", "n_sk_grow", 0.5, -1),      // ten-hours ⊣ meta-work over real work
  seedE("n_pr_risk", "n_gl_btc", 0.7, -1),          // risk asymmetry ⊣ growing BTC too fast
  seedE("n_pr_risk", "n_sk_strategy", 0.5, -1),     // risk discipline ⊣ an aggressive plan
  seedE("n_pr_conflict", "n_sk_strategy", 0.5, -1), // name-conflicts ⊣ a too-smooth synthesis
  seedE("n_pr_decouple", "n_gl_revops", 0.45, -1),  // decoupling ⊣ the RevOps move (still selling hours)
  seedE("n_pr_ship", "n_sk_pressure", 0.45, -1),    // ship-beats-perfect ⊣ analysis paralysis
  seedE("n_pr_conflict", "n_sk_triage", 0.45, -1),  // name-conflicts ⊣ papering over the hard tradeoff
];


export function seedGenome() {
  const now = new Date().toISOString();
  const nodes = [];
  Object.entries(SEED_NODES).forEach(([region, defs]) => {
    defs.forEach((d, i) => {
      const pos = seedPosition(region, i, defs.length, d.id);
      const node = {
        id: d.id, label: d.label, region, weight: d.weight,
        enabled: true, locked: !!d.locked, text: d.text,
        x: pos.x, y: pos.y, source: "seed", created_at: now,
      };
      // Skill model defaults ride along on the node so the panel's model picker
      // and the delegate both read them straight off the genome.
      if (d.modelKey) node.modelKey = d.modelKey;
      if (d.maxTokens) node.maxTokens = d.maxTokens;
      nodes.push(node);
    });
  });
  return {
    version: 1,
    genome_key: "cameron_mind",
    updated_at: now,
    nodes,
    edges: SEED_EDGES.map(e => ({ ...e })),
    mutations: [],
  };
}


// ─── persistence ─────────────────────────────────────────────────────────────
export function loadGenome() {
  const stored = sm.get(GENOME_KEY);
  if (stored && stored.version === 1 && validateGenome(stored).ok) return stored;
  return saveGenome(seedGenome()); // missing or corrupt → re-seed (never render a broken mind)
}

export function saveGenome(genome) {
  genome.updated_at = new Date().toISOString();
  sm.set(GENOME_KEY, genome);
  dnaBus.emit({ type: "genome", genome }); // every save announces itself — panel + canvas stay live
  return genome;
}

export function resetGenome() {
  return saveGenome(recordMutation(seedGenome(), "reset", "Mind reset to seed"));
}


// ─── mutation history ─────────────────────────────────────────────────────────
// Mutates the PASSED genome's `mutations` field (reassigns a fresh array, so a
// prior genome snapshot sharing the old array is never touched) and returns it.
// CRUD below always calls this on the freshly-copied genome, which is how the
// "pure-ish" contract holds: callers' original objects stay intact.
export function recordMutation(genome, kind, summary) {
  const entry = { id: newId("mut"), ts: new Date().toISOString(), kind, summary };
  genome.mutations = [entry, ...(genome.mutations || [])].slice(0, 200);
  return genome;
}


// ─── CRUD — take genome, return NEW genome; refusals return the SAME reference
//     so callers can cheaply detect a no-op (nextGenome === genome). ──────────
export function addNode(genome, { label, region, text, weight = 0.6, x = 0, y = 0, source = "user" }) {
  const reg = REGIONS[region] ? region : "knowledge"; // unknown region → knowledge, the least presumptuous home
  const base = `n_${slugify(label)}`;
  let id = base, n = 2;
  while (genome.nodes.some(nd => nd.id === id)) id = `${base}_${n++}`;
  const node = {
    id, label: String(label || "New node").slice(0, 28), region: reg, weight: clamp01(weight),
    enabled: true, locked: false, text: String(text || ""), x, y, source,
    created_at: new Date().toISOString(),
  };
  const next = recordMutation(
    { ...genome, nodes: [...genome.nodes, node] },
    "add_node", `Grew "${node.label}" in ${REGIONS[reg].label}${source === "learned" ? " (learned)" : ""}`
  );
  return { genome: next, node };
}

export function updateNode(genome, id, patch) {
  const node = genome.nodes.find(n => n.id === id);
  if (!node) return genome;
  const p = { ...patch };
  if (node.locked) { // doctrine armor: a locked node cannot be disabled or unlocked
    if (p.enabled === false) delete p.enabled;
    if (p.locked === false) delete p.locked;
  }
  if (p.weight !== undefined) p.weight = clamp01(p.weight);
  if (p.label !== undefined) p.label = String(p.label).slice(0, 28);
  if (Object.keys(p).length === 0) return genome;
  const next = { ...genome, nodes: genome.nodes.map(n => (n.id === id ? { ...n, ...p } : n)) };
  // Position-only patches are layout, not thought — the canvas writes x,y on
  // every drag end and that must not flood the mutation history.
  if (Object.keys(p).every(k => k === "x" || k === "y")) return next;
  let summary;
  if (p.weight !== undefined && p.weight !== node.weight) {
    summary = `${p.weight > node.weight ? "Strengthened" : "Weakened"} "${node.label}" ${node.weight.toFixed(2)} → ${p.weight.toFixed(2)}`;
  } else if (p.enabled === false && isAwake(node)) summary = `Silenced "${node.label}"`;
  else if (p.enabled === true && !isAwake(node)) summary = `Awakened "${node.label}"`;
  else if (p.modelKey !== undefined && p.modelKey !== node.modelKey) summary = `Retuned "${node.label}" to ${p.modelKey}`;
  else summary = `Rewrote "${p.label || node.label}"`;
  return recordMutation(next, "update_node", summary);
}

export function removeNode(genome, id) {
  const node = genome.nodes.find(n => n.id === id);
  if (!node || node.locked) return genome; // locked = load-bearing; deletion refused
  const cut = genome.edges.filter(e => e.from === id || e.to === id).length;
  const next = {
    ...genome,
    nodes: genome.nodes.filter(n => n.id !== id),
    edges: genome.edges.filter(e => e.from !== id && e.to !== id), // cascade — no dangling synapses, ever
  };
  return recordMutation(next, "remove_node", `Removed "${node.label}"${cut ? ` and ${cut} synapse${cut !== 1 ? "s" : ""}` : ""}`);
}

const nodeLabel = (genome, id) => genome.nodes.find(n => n.id === id)?.label || id;

export function addEdge(genome, { from, to, weight = 0.6, polarity = 1 }) {
  if (!from || !to || from === to) return genome;                        // no self-loops
  if (!genome.nodes.some(n => n.id === from) || !genome.nodes.some(n => n.id === to)) return genome; // no dangling
  if (genome.edges.some(e => e.from === from && e.to === to)) return genome; // one synapse per direction pair
  const base = `e_${from.replace(/^n_/, "")}_${to.replace(/^n_/, "")}`;
  let id = base, n = 2;
  while (genome.edges.some(e => e.id === id)) id = `${base}_${n++}`;
  const pol = polarity === -1 ? -1 : 1;
  const edge = { id, from, to, weight: clamp01(weight), polarity: pol };
  return recordMutation(
    { ...genome, edges: [...genome.edges, edge] },
    "add_edge", `Wired "${nodeLabel(genome, from)}" ${pol === -1 ? "⊣" : "→"} "${nodeLabel(genome, to)}" at ${edge.weight.toFixed(2)}`
  );
}

export function updateEdge(genome, id, patch) {
  const edge = genome.edges.find(e => e.id === id);
  if (!edge) return genome;
  const p = { ...patch };
  delete p.from; delete p.to; // rewiring endpoints is remove+add, not a patch — keeps dupe/self-loop guards honest
  if (p.weight !== undefined) p.weight = clamp01(p.weight);
  if (p.polarity !== undefined) p.polarity = p.polarity === -1 ? -1 : 1;
  if (Object.keys(p).length === 0) return genome;
  const next = { ...genome, edges: genome.edges.map(e => (e.id === id ? { ...e, ...p } : e)) };
  const pair = `"${nodeLabel(genome, edge.from)}" → "${nodeLabel(genome, edge.to)}"`;
  const summary = p.polarity !== undefined && p.polarity !== edge.polarity
    ? `Flipped ${pair} to ${p.polarity === -1 ? "tempering" : "excitatory"}`
    : `Retuned ${pair} ${edge.weight.toFixed(2)} → ${(p.weight !== undefined ? p.weight : edge.weight).toFixed(2)}`;
  return recordMutation(next, "update_edge", summary);
}

export function removeEdge(genome, id) {
  const edge = genome.edges.find(e => e.id === id);
  if (!edge) return genome;
  return recordMutation(
    { ...genome, edges: genome.edges.filter(e => e.id !== id) },
    "remove_edge", `Cut synapse "${nodeLabel(genome, edge.from)}" → "${nodeLabel(genome, edge.to)}"`
  );
}


// ─── validation — guards imports and self-inflicted corruption ───────────────
// Rejects: non-array nodes/edges, non-object entries, missing/duplicate node ids,
// unknown regions, out-of-range weights, missing labels, missing/duplicate edge
// ids, self-loops, duplicate from→to pairs, dangling endpoints, and bad polarity.
export function validateGenome(g) {
  const errors = [];
  if (!g || typeof g !== "object") return { ok: false, errors: ["genome is not an object"] };
  if (!Array.isArray(g.nodes)) errors.push("nodes is not an array");
  if (!Array.isArray(g.edges)) errors.push("edges is not an array");
  if (errors.length) return { ok: false, errors };
  // Entry guards first — a null/scalar entry is INVALID, never a TypeError.
  // loadGenome's re-seed path and the panel's import toast both rely on this
  // function returning {ok:false} for any garbage, not throwing on it.
  const ids = new Set();
  g.nodes.forEach(n => {
    if (!n || typeof n !== "object") { errors.push("node is not an object"); return; }
    if (!n.id || typeof n.id !== "string") errors.push("node with missing id");
    else if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    else ids.add(n.id);
    if (!REGIONS[n.region]) errors.push(`node ${n.id}: unknown region "${n.region}"`);
    if (typeof n.weight !== "number" || !Number.isFinite(n.weight) || n.weight < 0 || n.weight > 1) errors.push(`node ${n.id}: weight out of 0..1`);
    if (typeof n.label !== "string" || !n.label) errors.push(`node ${n.id}: missing label`);
  });
  const eids = new Set();
  const pairs = new Set();
  g.edges.forEach(e => {
    if (!e || typeof e !== "object") { errors.push("edge is not an object"); return; }
    if (!e.id || eids.has(e.id)) errors.push(`edge with missing or duplicate id ${e.id || "?"}`);
    else eids.add(e.id);
    if (e.from === e.to) errors.push(`edge ${e.id}: self-loop on "${e.from}"`);
    else {
      const pair = `${e.from}→${e.to}`;
      if (pairs.has(pair)) errors.push(`edge ${e.id}: duplicate synapse ${pair}`);
      else pairs.add(pair);
    }
    if (!ids.has(e.from)) errors.push(`edge ${e.id}: dangling from "${e.from}"`);
    if (!ids.has(e.to)) errors.push(`edge ${e.id}: dangling to "${e.to}"`);
    if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || e.weight < 0 || e.weight > 1) errors.push(`edge ${e.id}: weight out of 0..1`);
    if (e.polarity !== 1 && e.polarity !== -1) errors.push(`edge ${e.id}: polarity must be 1 or -1`);
  });
  return { ok: errors.length === 0, errors };
}


// ─── the compiler — the graph IS the prompt ──────────────────────────────────
// DETERMINISTIC: same genome ⇒ byte-identical string ⇒ same hash. Everything
// that could wobble is pinned — region order is REGION_ORDER, in-region order is
// weight desc then id asc, tension order is edge id asc. MIND_CHARTER leads
// verbatim so no weight slider can ever out-rank the operating stance. Weight
// bands translate a slider into prompt emphasis: ≥0.75 commands (PRIMARY), ≥0.4
// informs, <0.4 barely whispers (Minor). Disabled nodes don't exist. Inhibitory
// edges between enabled nodes become explicit conflict-resolution lines — the
// model is TOLD which impulse wins, not left to average them.
export function compileGenome(genome) {
  const byId = new Map(genome.nodes.map(n => [n.id, n]));
  const sections = [];
  for (const region of REGION_ORDER) {
    const lines = genome.nodes
      .filter(n => isAwake(n) && n.region === region)
      .sort((a, b) => (b.weight - a.weight) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(n => (n.weight >= 0.75 ? `PRIMARY — ${n.text}` : n.weight >= 0.4 ? n.text : `Minor — ${n.text}`));
    if (lines.length) sections.push({ region, lines });
  }
  const tensions = genome.edges
    .filter(e => e.polarity === -1 && isAwake(byId.get(e.from)) && isAwake(byId.get(e.to)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(e => `TENSION: ${byId.get(e.from).label} tempers ${byId.get(e.to).label} — when they conflict, ${byId.get(e.from).label} wins.`);

  const parts = [MIND_CHARTER];
  sections.forEach(s => {
    parts.push(`${REGIONS[s.region].label.toUpperCase()} — ${REGIONS[s.region].desc}:\n${s.lines.map(l => `- ${l}`).join("\n")}`);
  });
  if (tensions.length) {
    parts.push(`INTERNAL TENSIONS:\n${tensions.map(l => `- ${l}`).join("\n")}`);
    sections.push({ region: "tension", lines: tensions }); // pseudo-section so UIs can render the tension block too
  }
  const systemPrompt = parts.join("\n\n");
  return { systemPrompt, sections, hash: djb2(systemPrompt) };
}

// The delegate hook — the Mini Me executor and any external caller read the mind
// through this one door: compile whatever is persisted right now. Kept trivial
// on purpose so tweaking a node in the panel visibly changes the delegate.
export function getCompiledMind() {
  return compileGenome(loadGenome());
}


// ─── activation spread — pure, for pulses and task traces ────────────────────
// Seeds light at 1.0 and the wave rolls outward along edge direction. Per step,
// every edge reads its source's level FROM THE PREVIOUS STEP (synchronous
// update, so within-step edge order can never change the result):
//   excitatory:  target = max(target, source·weight·decay)   — order-free (max)
//   inhibitory:  target = max(0, target − source·weight·decay) — dampens, clamps at 0
// Excitation applies before inhibition inside a step, so tempering always gets
// the last word — the same rule the compiler states in its TENSION lines.
// Disabled nodes never activate and never relay. max() + multiplicative decay
// makes levels monotone-bounded, so the wave provably dies; we stop the moment a
// step changes nothing, or at `steps`, whichever comes first.
export function propagate(genome, seedIds, { steps = 4, decay = 0.55 } = {}) {
  const EPS = 0.01; // below this a node is "dark" — keeps ripples finite and traces readable
  const enabled = new Set(genome.nodes.filter(n => isAwake(n)).map(n => n.id));
  const levels = {};
  genome.nodes.forEach(n => { levels[n.id] = 0; });
  const step0 = [];
  (seedIds || []).forEach(id => {
    if (enabled.has(id) && levels[id] !== 1) { levels[id] = 1; step0.push(id); }
  });
  const order = [step0];
  const edgesFired = [];
  const firedSet = new Set();

  for (let s = 0; s < steps; s++) {
    const prev = { ...levels };
    for (const e of genome.edges) { // excitation pass — reads prev, max() into levels
      if (e.polarity === -1 || !enabled.has(e.from) || !enabled.has(e.to)) continue;
      const src = prev[e.from];
      if (src <= EPS) continue;
      const push = src * e.weight * decay;
      if (push > levels[e.to]) {
        levels[e.to] = push;
        if (!firedSet.has(e.id)) { firedSet.add(e.id); edgesFired.push(e.id); }
      }
    }
    for (const e of genome.edges) { // inhibition pass — tempering gets the last word
      if (e.polarity !== -1 || !enabled.has(e.from) || !enabled.has(e.to)) continue;
      const src = prev[e.from];
      if (src <= EPS || levels[e.to] <= 0) continue;
      levels[e.to] = Math.max(0, levels[e.to] - src * e.weight * decay);
      if (!firedSet.has(e.id)) { firedSet.add(e.id); edgesFired.push(e.id); }
    }
    let changed = false;
    const newly = [];
    genome.nodes.forEach(n => {
      if (levels[n.id] !== prev[n.id]) changed = true;
      if (prev[n.id] <= EPS && levels[n.id] > EPS) newly.push(n.id);
    });
    if (newly.length) order.push(newly);
    if (!changed) break; // fixpoint — the wave died before the step budget did
  }
  return { levels, order, edgesFired };
}


// Task kind → seed ids for the activation trace. The mapped skill node leads,
// followed by its strongest ENABLED excitatory inputs (the signals/knowledge
// that argue FOR the act) so each task kind lights a distinct causal
// neighborhood — the tempering principles then fire via propagate itself.
const TASK_SKILL = {
  triage: "n_sk_triage",
  pressure: "n_sk_pressure",
  brief: "n_sk_brief",
  strategy: "n_sk_strategy",
  grow: "n_sk_grow",
};

export function seedsForTask(genome, kind) {
  const skillId = TASK_SKILL[kind];
  if (!skillId || !genome.nodes.some(n => n.id === skillId)) return [];
  const enabled = new Set(genome.nodes.filter(n => isAwake(n)).map(n => n.id));
  const inputs = genome.edges
    .filter(e => e.to === skillId && e.polarity === 1 && enabled.has(e.from))
    .sort((a, b) => (b.weight - a.weight) || (a.id < b.id ? -1 : 1))
    .slice(0, 4)
    .map(e => e.from);
  return [skillId, ...inputs];
}


// ─── stats — the header pills read this ──────────────────────────────────────
export function genomeStats(genome) {
  const byRegion = {};
  Object.keys(REGIONS).forEach(r => { byRegion[r] = 0; });
  let enabled = 0;
  genome.nodes.forEach(n => {
    byRegion[n.region] = (byRegion[n.region] || 0) + 1;
    if (isAwake(n)) enabled++;
  });
  return { nodes: genome.nodes.length, edges: genome.edges.length, enabled, byRegion };
}
