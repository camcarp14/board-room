// Mini Me worker — the real engine behind the Mini Me page.
// On-demand only: runs when the user hits "Run queue now", "Approve", or
// "Reject" — nothing fires on a schedule. Authenticated with the user's
// Supabase session token.
//
// Real, working controls (all read from the user's `mini` setting):
//   enabled     - master on/off. Off means Run now refuses to do anything.
//   model       - which Claude model generates + critiques each task.
//   budget      - a REAL dollar cap. The run accumulates each call's estimated
//                 cost and stops before starting a task that would exceed it;
//                 unrun tasks stay queued. A task-count ceiling ($1->1, $3->3,
//                 $10->8) still backstops it against a runaway single task.
//   directive   - one-line mission, synthesized from the directive chat on
//                 the page — read before every task, takes priority over role.
//   role        - the identity/expertise Mini Me should adopt, set directly.
//   reflectOn   - after generating a draft, Mini Me critiques its own work
//                 and revises if the critique finds gaps.
//   loopOn      - allow more than one critique/revise cycle (bounded by
//                 loopMax); off means exactly one critique pass.
//   loopMax     - hard ceiling on critique/revise cycles for loopOn.
//   approvalOn  - finished drafts land in "review" instead of "delivered"
//                 until the user taps Approve.
// Needs: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Mirrors MODEL_IDS / PRICING in src/lib/claude.js — keep in sync (a stale id
// here fails every queued task with a raw Anthropic 404 in the task's output).
const MODEL_IDS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-5", opus: "claude-opus-4-8" };
// $ per 1M tokens. Duplicated from src/lib/claude.js ON PURPOSE — a required
// helper's module.exports clobbers this bundle's exports and deploys a handler-
// less function (see audit.js). scripts/spend-smoke.mjs asserts they agree.
// Sonnet 5 is on introductory pricing ($2/$10) through 2026-08-31.
const SONNET_INTRO_ENDS = Date.parse("2026-09-01T00:00:00Z");
const PRICING = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15, introIn: 2, introOut: 10, introUntil: SONNET_INTRO_ENDS },
  opus: { in: 5, out: 25 },
};
const rateFor = (mk, at = Date.now()) => {
  const p = PRICING[mk] || PRICING.haiku;
  return p.introUntil && at < p.introUntil ? { in: p.introIn, out: p.introOut } : { in: p.in, out: p.out };
};
// Cache tokens: write 1.25x input, read 0.1x input. Zero today (nothing sets
// cache_control), priced so enabling caching can't silently undercount.
const estCost = (mk, i, o, cacheWrite = 0, cacheRead = 0) => {
  const p = rateFor(mk);
  return ((i + cacheWrite * 1.25 + cacheRead * 0.1) * p.in + o * p.out) / 1e6;
};
// Task-count ceiling per run. This is a SAFETY STOP, not the budget — the real
// budget is the dollar figure below, which the run accumulates against actual
// per-call cost. Before that existed, "$3" capped the run at 3 Haiku tasks
// (about one cent) and the dollar labels were off by ~300x.
const BUDGET_TASK_LIMIT = { "$1": 1, "$3": 3, "$10": 8 };
const BUDGET_USD = { "$1": 1, "$3": 3, "$10": 10 };

function env() {
  return { anthropic: process.env.ANTHROPIC_API_KEY, url: process.env.SUPABASE_URL, service: process.env.SUPABASE_SERVICE_ROLE_KEY, owner: String(process.env.BOARD_USER_ID || "").trim() };
}
function rest(cfg, path, opts = {}) {
  return fetch(`${cfg.url}/rest/v1/${path}`, { signal: AbortSignal.timeout(30000),
    ...opts,
    headers: { apikey: cfg.service, Authorization: `Bearer ${cfg.service}`, "Content-Type": "application/json", "Accept-Profile": "boardroom", "Content-Profile": "boardroom", Prefer: "return=minimal", ...(opts.headers || {}) },
  });
}
async function verifyUser(cfg, token) {
  const res = await fetch(`${cfg.url}/auth/v1/user`, { signal: AbortSignal.timeout(30000), headers: { apikey: cfg.service, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id || null;
}
async function claudeCall(cfg, modelKey, system, user, maxTokens, userId) {
  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", { signal: AbortSignal.timeout(120000),
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": cfg.anthropic, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL_IDS[modelKey] || MODEL_IDS.haiku, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await res.json();
  const ok = res.ok;
  const u = data.usage || {};
  const cacheWrite = u.cache_creation_input_tokens || 0, cacheRead = u.cache_read_input_tokens || 0;
  const inTok = (u.input_tokens || 0) + cacheWrite + cacheRead, outTok = u.output_tokens || 0;
  const cost = estCost(modelKey, u.input_tokens || 0, outTok, cacheWrite, cacheRead);
  if (userId) {
    rest(cfg, "usage_log", { method: "POST", body: JSON.stringify({ user_id: userId, fn: "mini-worker", kind: "anthropic", model: modelKey, in_tokens: inTok, out_tokens: outTok, cost_usd: cost, ms: Date.now() - t0, ok, detail: ok ? undefined : (data?.error?.message || `HTTP ${res.status}`) }) })
      .catch(() => {}); // best-effort, fire-and-forget
  }
  if (!ok) throw new Error(data?.error?.message || `Anthropic ${res.status}`);
  const text = (data.content || []).map(b => (b.type === "text" ? b.text : "")).join("");
  // `cost` rides back to processUser so the run can stop on the DOLLAR budget
  // rather than only on a task count that had no relationship to it.
  return { text, outTok, cost };
}

async function loadUserBundle(cfg, userId) {
  // mind_prompt is the compiled Mind (doctrine only). The editor that compiled
  // it has been deleted, so this row is now FROZEN at whatever the last save
  // wrote — it still shapes every run, but nothing can change it any more.
  // It's read SERVER-SIDE from app_settings rather than taken off the request body:
  // the client used to POST `mind: <compiled prompt>` and this function never
  // read it, so tuning a Neuron changed nothing about what a queue run produced.
  // Reading it here also means we don't trust a client-supplied system prompt.
  const res = await rest(cfg, `app_settings?user_id=eq.${userId}&setting_key=in.(mini,mini_tasks,mind_prompt)&select=setting_key,setting_value`, { headers: { Prefer: "" } });
  const rows = await res.json();
  const out = { mini: {}, mini_tasks: [], mind_prompt: null };
  (Array.isArray(rows) ? rows : []).forEach(r => { out[r.setting_key] = r.setting_value; });
  return out;
}

// Skills taught on the Learn tab — enabled ones ride along in the worker's
// system prompt. Mirrors buildSkillsBlock in src/LearnPanel.jsx (keep in
// sync). Silently returns "" if the table doesn't exist yet.
async function loadSkillsBlock(cfg, userId, budget = 9000) {
  try {
    const res = await rest(cfg, `mini_skills?user_id=eq.${userId}&enabled=eq.true&select=title,description,content&order=updated_at.desc`, { headers: { Prefer: "" } });
    if (!res.ok) return "";
    const skills = await res.json();
    if (!Array.isArray(skills) || !skills.length) return "";
    const index = skills.map(s => `• ${s.title} — ${s.description}`).join("\n");
    let out = `\n\nLEARNED SKILLS — knowledge the user has explicitly taught you. Apply when relevant; cite the skill by name when you lean on one.\nIndex:\n${index}\n`;
    let used = out.length, loaded = 0;
    for (const s of skills) {
      const block = `\n[SKILL: ${s.title}]\n${s.content}\n`;
      if (used + block.length > budget) break;
      out += block; used += block.length; loaded++;
    }
    if (loaded < skills.length) out += `\n(${skills.length - loaded} more skill${skills.length - loaded > 1 ? "s" : ""} known by title only.)`;
    return out;
  } catch { return ""; }
}
/** Reconcile our task list against whatever is live, by task id. Pure, and
 *  exported so a test can assert it (Netlify reads `handler` and ignores the
 *  rest of the exports). This comment used to name a specific smoke script that
 *  has never existed in the repo — the same trap that had Systems → Usage
 *  pointing at a SQL file nobody had written. spend-smoke now fails on a
 *  comment that names a missing file, so name one here only once it exists.
 *
 *  Both sides used to write the WHOLE array: the client upserts it on every
 *  queue/remove, and this function replaced it at the end of a run. Queue a task
 *  from Summon or the task field while a run was in flight and whichever write
 *  landed second silently discarded the other's changes — a lost task, or a lost
 *  deliverable. Live order is preserved (the client prepends new tasks, so a task
 *  queued mid-run stays at the top and gets picked up next run); ours wins for
 *  ids we touched; anything of ours the live row hasn't seen is appended. */
function mergeTasks(ours, live) {
  const mine = new Map((ours || []).filter(t => t && t.id).map(t => [t.id, t]));
  if (!Array.isArray(live)) return ours || [];
  const seen = new Set();
  const merged = live.filter(t => t && t.id).map(t => { seen.add(t.id); return mine.get(t.id) || t; });
  for (const t of ours || []) if (t && t.id && !seen.has(t.id)) merged.push(t);
  return merged;
}
exports.mergeTasks = mergeTasks;

async function saveTasks(cfg, userId, tasks) {
  let merged = tasks;
  try {
    const res = await rest(cfg, `app_settings?user_id=eq.${userId}&setting_key=eq.mini_tasks&select=setting_value`, { headers: { Prefer: "" } });
    const rows = await res.json();
    merged = mergeTasks(tasks, Array.isArray(rows) ? rows[0]?.setting_value : null);
  } catch { /* couldn't re-read — write what we have rather than lose the run's output */ }
  // UPSERT, not PATCH. A PATCH filtered on (user_id, setting_key) matches no row
  // on a first-ever run and then succeeds having written nothing at all — the run
  // reported success and saved none of its output. The table has the unique
  // constraint the client already upserts against, so merge-duplicates works here.
  await rest(cfg, "app_settings", {
    method: "POST",
    headers: { Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify({ user_id: userId, setting_key: "mini_tasks", setting_value: merged, updated_at: new Date().toISOString() }),
  });
}

// The real agentic loop: generate, then optionally critique-and-revise up to
// loopMax times. Stops early on an explicit DONE or two consecutive
// no-change revisions. This is the "think longer" knob — Thorough effort
// (loopOn + a higher Max passes) makes it iterate more before delivering.
async function runTask(cfg, mini, system, taskText, userId) {
  const reflect = mini.reflectOn !== false;
  const loop = mini.loopOn !== false;
  const maxLoops = !reflect ? 1 : (!loop ? 2 : Math.max(2, parseInt(mini.loopMax || "5", 10) || 5));

  let draft = null, prevDraft = null, noProgress = 0, loops = 0, outTok = 0, cost = 0;
  for (let i = 0; i < maxLoops; i++) {
    loops++;
    if (draft === null) {
      const r = await claudeCall(cfg, mini.model, system, taskText, 900, userId);
      draft = r.text; outTok += r.outTok; cost += r.cost;
      if (!reflect) break;
      continue;
    }
    const critiqueSystem = `You are reviewing your own previous draft against the original task, as "Mini Me". If the draft fully satisfies the task and no meaningful improvement is needed, reply with exactly: DONE
Otherwise, reply with ONLY the complete revised draft (no commentary, no prefix) — it will replace the previous draft as-is.`;
    const r = await claudeCall(cfg, mini.model, critiqueSystem, `ORIGINAL TASK:\n${taskText}\n\nCURRENT DRAFT:\n${draft}`, 900, userId);
    outTok += r.outTok; cost += r.cost;
    const reply = r.text.trim();
    if (reply === "DONE" || reply.startsWith("DONE")) break;
    if (prevDraft !== null && reply === prevDraft.trim()) { noProgress++; if (noProgress >= 2) break; } else noProgress = 0;
    prevDraft = draft;
    draft = reply;
    if (!loop) break;
  }
  return { draft, loops, outTok, cost };
}

async function processUser(cfg, userId) {
  const bundle = await loadUserBundle(cfg, userId);
  const mini = { model: "haiku", budget: "$3", enabled: true, reflectOn: true, loopOn: true, loopMax: "5", approvalOn: true, ...(bundle.mini || {}) };
  if (mini.enabled === false) return { userId, processed: 0, skipped: "Mini Me is off" };

  const tasks = (Array.isArray(bundle.mini_tasks) ? bundle.mini_tasks : []).map(t => t.id ? t : { ...t, id: t.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  const queuedIdx = tasks.map((t, i) => (t.status === "queued" ? i : -1)).filter(i => i >= 0);
  if (!queuedIdx.length) { await saveTasks(cfg, userId, tasks); return { userId, processed: 0, skipped: "no queued tasks" }; }

  const limit = BUDGET_TASK_LIMIT[mini.budget] || 3;
  const budgetUsd = BUDGET_USD[mini.budget] || 3;
  const toRun = queuedIdx.slice(0, limit);
  const directive = (mini.directive || "").trim();
  const role = (mini.role || "").trim();
  const skillsBlock = await loadSkillsBlock(cfg, userId);
  // The Mind leads, when there is one. Guarded: a missing/blank/oversized value
  // falls straight back to the pre-Mind prompt, so a device that has never opened
  // the Mind tab (or a corrupt setting) can never blank the delegate's
  // instructions. The 24k ceiling is well clear of a real genome — the seed
  // compiles to ~5k — and stops one bad write from eating the context window.
  const mindPrompt = (() => {
    const p = bundle.mind_prompt && typeof bundle.mind_prompt.prompt === "string" ? bundle.mind_prompt.prompt.trim() : "";
    return p && p.length <= 24000 ? p : "";
  })();
  const base = `You are "Mini Me", the user's autonomous assistant inside their Board Room app.${role ? ` Your role: ${role}` : ""} Produce the requested deliverable directly and completely — concrete and usable, no preamble, no clarifying questions (make reasonable assumptions and state them briefly at the end if needed).${directive ? `\n\nYour prime directive — this is the overall mission, weigh every task against it: ${directive}` : ""}`;
  // Skills come from loadSkillsBlock (live, server-read) rather than from the
  // compiled mind, which is why mind_prompt is stored doctrine-only: teaching a
  // skill in Learn takes effect on the next run without recompiling the genome.
  const system = `${mindPrompt ? `${mindPrompt}\n\n` : ""}${base}${skillsBlock}`;

  const feedRows = [];
  let processed = 0, spentUsd = 0;
  for (const idx of toRun) {
    const t = tasks[idx];
    // Stop on the real budget. Checked BEFORE starting a task, so the cap is
    // never breached mid-task; the task stays queued for the next run.
    if (spentUsd >= budgetUsd) {
      feedRows.push({ user_id: userId, text: `Stopped at the ${mini.budget} budget — $${spentUsd.toFixed(4)} spent this run. ${toRun.length - processed} task(s) still queued.` });
      break;
    }
    try {
      const { draft, loops, outTok, cost } = await runTask(cfg, mini, system, t.text, userId);
      spentUsd += cost;
      const status = mini.approvalOn ? "review" : "delivered";
      tasks[idx] = { ...t, status, output: draft, loops, delivered_at: new Date().toISOString() };
      feedRows.push({ user_id: userId, text: `${status === "review" ? "Drafted (awaiting your approval)" : "Delivered"} "${t.text.slice(0, 60)}${t.text.length > 60 ? "…" : ""}" — ${loops} loop(s), ~${outTok} tokens on ${mini.model}, $${cost.toFixed(4)}.` });
      processed++;
    } catch (e) {
      tasks[idx] = { ...t, status: "failed", output: `Failed: ${e.message}`, delivered_at: new Date().toISOString() };
      feedRows.push({ user_id: userId, text: `Task failed ("${t.text.slice(0, 50)}…"): ${e.message}` });
    }
  }

  await saveTasks(cfg, userId, tasks);
  if (feedRows.length) await rest(cfg, "mini_feed", { method: "POST", body: JSON.stringify(feedRows) });
  return { userId, processed };
}

async function approveOrReject(cfg, userId, taskId, approve) {
  const bundle = await loadUserBundle(cfg, userId);
  const tasks = Array.isArray(bundle.mini_tasks) ? bundle.mini_tasks : [];
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx < 0) return { success: false, error: "task not found" };
  if (approve) {
    tasks[idx] = { ...tasks[idx], status: "delivered" };
    await rest(cfg, "mini_feed", { method: "POST", body: JSON.stringify([{ user_id: userId, text: `You approved "${tasks[idx].text.slice(0, 60)}…".` }]) });
  } else {
    tasks[idx] = { ...tasks[idx], status: "queued", output: null };
    await rest(cfg, "mini_feed", { method: "POST", body: JSON.stringify([{ user_id: userId, text: `You rejected a draft — requeued "${tasks[idx].text.slice(0, 60)}…".` }]) });
  }
  await saveTasks(cfg, userId, tasks);
  return { success: true };
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const cfg = env();
  const configured = !!(cfg.anthropic && cfg.url && cfg.service && cfg.owner);

  if (body.ping) return json(200, { success: true, service: "mini-worker", configured, missing: configured ? undefined : "ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BOARD_USER_ID" });
  if (!configured) return json(503, { success: false, error: "server owner is not configured" });

  try {
    const auth = event.headers?.authorization || event.headers?.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return json(401, { success: false, error: "sign-in token required" });
    const userId = await verifyUser(cfg, token);
    if (!userId) return json(401, { success: false, error: "invalid or expired session — sign in again" });
    if (userId !== cfg.owner) return json(403, { success: false, error: "this account is not allowed to use Board Room" });

    if (body.approve || body.reject) {
      const result = await approveOrReject(cfg, userId, body.approve || body.reject, !!body.approve);
      return json(result.success ? 200 : 404, result);
    }

    const result = await processUser(cfg, userId);
    return json(200, { success: true, processed: result.processed, message: result.skipped || `processed ${result.processed} task(s)` });
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
