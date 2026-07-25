// ─── Mind genome smoke — PLANTED problems, known answers, zero deps ──────────
// mindGenome.js is pure by contract (only `sm` for storage, and an INJECTED cloud
// writer) precisely so it can be tested here, the way workout-engine and
// workout-library are. Two of these assertions cover bugs that shipped:
//
//   · an inhibitory edge onto a learned_<skillId> endpoint silently never reached
//     the compiled TENSIONS block, because compileGenome built its id map from the
//     raw nodes instead of the merged view. addEdge allows those endpoints, so the
//     UI let you draw a tempering synapse that did nothing.
//   · the genome lived only in localStorage — no sync between devices, and absent
//     from export-data's backup. saveGenome now writes through a registered sink
//     and hydrateGenomeFromCloud adopts a newer copy (last write wins).
//
// Run by `npm run verify`.

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};

const g = await import("../src/pages/board/mind/mindGenome.js");

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const SKILL = { id: "s1", title: "Cold email teardown", description: "critique outreach copy", content: "Lead with the specific.", enabled: true };
const bump = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const clone = (o) => JSON.parse(JSON.stringify(o));

// 0 — the purity contract itself: this module must load without a bundler.
check("mindGenome loads in plain Node (no import.meta.env dependency)", typeof g.compileGenome === "function");

// 1 — seed integrity
const seed = g.seedGenome();
check("seed genome validates", g.validateGenome(seed).ok, JSON.stringify(g.validateGenome(seed).errors));
check("seed is deterministic (same structure twice)",
  JSON.stringify(g.seedGenome().nodes.map((n) => [n.id, n.x, n.y])) === JSON.stringify(seed.nodes.map((n) => [n.id, n.x, n.y])));
check("charter leads the compiled prompt verbatim", g.compileGenome(seed).systemPrompt.startsWith(g.MIND_CHARTER));
check("locked principles cannot be silenced", g.updateNode(seed, "n_pr_pressure", { enabled: false }) === seed);
check("locked principles cannot be deleted", g.removeNode(seed, "n_pr_pressure") === seed);

// 2 — tensions on LEARNED endpoints (the compile bug)
const wired = g.addEdge(seed, { from: "n_pr_pressure", to: "learned_s1", weight: 0.6, polarity: -1 });
check("addEdge accepts a learned_* endpoint", wired !== seed);
check("tension onto a taught skill compiles into TENSIONS",
  /TENSION: .*tempers Cold email teardown/.test(g.compileGenome(wired, { skills: [SKILL] }).systemPrompt));
check("no phantom tension when the skill isn't present", !/teardown/.test(g.compileGenome(wired).systemPrompt));
check("a disabled taught skill compiles no tension",
  !/teardown/.test(g.compileGenome(wired, { skills: [{ ...SKILL, enabled: false }] }).systemPrompt));
check("compile is deterministic (same genome+skills ⇒ same hash)",
  g.compileGenome(wired, { skills: [SKILL] }).hash === g.compileGenome(wired, { skills: [SKILL] }).hash);

// 3 — the cloud sink: injected, called with both keys, and never able to break an edit
const writes = [];
g.setGenomeCloudWriter((k, v) => { writes.push([k, v]); });
g.saveGenome(g.seedGenome());
check("saveGenome writes mind_genome AND mind_prompt",
  writes.map((w) => w[0]).sort().join() === `${g.GENOME_KEY},${g.MIND_PROMPT_KEY}`, JSON.stringify(writes.map((w) => w[0])));
const promptWrite = (writes.find((w) => w[0] === g.MIND_PROMPT_KEY) || [])[1] || {};
check("mind_prompt carries prompt + hash + at", typeof promptWrite.prompt === "string" && !!promptWrite.hash && !!promptWrite.at);
// Doctrine-only is load-bearing: mini-worker adds its own LIVE skills block, so
// folding skills in here would go stale the moment one changed in Learn.
check("mind_prompt is doctrine-only (no LEARNED SKILLS block)", !/LEARNED SKILLS/.test(promptWrite.prompt || ""));
check("mind_prompt fits the worker's 24k ceiling", (promptWrite.prompt || "").length < 24000, `${(promptWrite.prompt || "").length} chars`);

for (const [label, sink] of [["rejecting", () => Promise.reject(new Error("offline"))], ["throwing", () => { throw new Error("boom"); }]]) {
  g.setGenomeCloudWriter(sink);
  let survived = true;
  try { g.saveGenome(g.seedGenome()); } catch { survived = false; }
  check(`a ${label} cloud sink never breaks the edit path`, survived);
}
g.setGenomeCloudWriter(null);

// 4 — hydration: newest wins, garbage never overwrites a good local mind
const local = g.loadGenome();
const newer = clone(local); newer.updated_at = bump(local.updated_at, 60000); newer.nodes[0].label = "OTHER DEVICE";
check("hydrate adopts a strictly-newer cloud genome", g.hydrateGenomeFromCloud(newer).nodes[0].label === "OTHER DEVICE");
const older = clone(newer); older.updated_at = bump(local.updated_at, -60000); older.nodes[0].label = "STALE";
check("hydrate refuses an older cloud genome", g.hydrateGenomeFromCloud(older).nodes[0].label !== "STALE");
check("hydrate refuses a corrupt cloud genome", g.hydrateGenomeFromCloud({ version: 1, nodes: [{ id: "x" }], edges: [] }).nodes[0].label === "OTHER DEVICE");
check("hydrate tolerates null / unknown version", !!g.hydrateGenomeFromCloud(null) && !!g.hydrateGenomeFromCloud({ version: 9 }));
const writeBack = [];
g.setGenomeCloudWriter((k) => writeBack.push(k));
const newest = clone(local); newest.updated_at = bump(local.updated_at, 120000);
g.hydrateGenomeFromCloud(newest);
g.setGenomeCloudWriter(null);
check("hydrate does not write back to the cloud (no save loop)", writeBack.length === 0, JSON.stringify(writeBack));

// 5 — propagate stays finite and inhibition gets the last word
const pulse = g.propagate(seed, g.seedsForTask(seed, "triage"));
check("propagate seeds light at 1.0", Object.values(pulse.levels).some((v) => v === 1));
check("propagate terminates within the step budget", pulse.order.length <= 5, `${pulse.order.length} waves`);
check("propagate never returns a negative level", Object.values(pulse.levels).every((v) => v >= 0));

console.log(`\n${failed ? `${failed} FAILURE(S)` : "MIND SMOKE: ALL CLEAN"}`);
if (failed) { console.error("MIND SMOKE FAILED"); process.exit(1); }
