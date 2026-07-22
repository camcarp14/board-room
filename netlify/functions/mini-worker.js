// Mini Me worker — the real engine behind the Mini Me page.
// On-demand only: runs when the user hits "Run queue now", "Approve", or
// "Reject" — nothing fires on a schedule. Authenticated with the user's
// Supabase session token.
//
// Real, working controls (all read from the user's `mini` setting):
//   enabled     - master on/off. Off means Run now refuses to do anything.
//   model       - which Claude model generates + critiques each task.
//   budget      - caps tasks processed per run ($1->1, $3->3, $10->8).
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

const MODEL_IDS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-1" };
const PRICING = { haiku: { in: 1, out: 5 }, sonnet: { in: 3, out: 15 }, opus: { in: 15, out: 75 } }; // $ per 1M tokens
const estCost = (mk, i, o) => (i / 1e6) * (PRICING[mk]?.in || 1) + (o / 1e6) * (PRICING[mk]?.out || 5);
const BUDGET_TASK_LIMIT = { "$1": 1, "$3": 3, "$10": 8 };

function env() {
  return { anthropic: process.env.ANTHROPIC_API_KEY, url: process.env.SUPABASE_URL, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
function rest(cfg, path, opts = {}) {
  return fetch(`${cfg.url}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: cfg.service, Authorization: `Bearer ${cfg.service}`, "Content-Type": "application/json", Prefer: "return=minimal", ...(opts.headers || {}) },
  });
}
async function verifyUser(cfg, token) {
  const res = await fetch(`${cfg.url}/auth/v1/user`, { headers: { apikey: cfg.service, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id || null;
}
async function claudeCall(cfg, modelKey, system, user, maxTokens, userId) {
  const t0 = Date.now();
  // 25s abort so one hung upstream call fails ONE task loudly instead of
  // riding the whole invocation to the platform kill with nothing recorded.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": cfg.anthropic, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify({ model: MODEL_IDS[modelKey] || MODEL_IDS.haiku, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
  } finally { clearTimeout(timer); }
  const data = await res.json();
  const ok = res.ok;
  const inTok = data.usage?.input_tokens || 0, outTok = data.usage?.output_tokens || 0;
  if (userId) {
    rest(cfg, "usage_log", { method: "POST", body: JSON.stringify({ user_id: userId, fn: "mini-worker", kind: "anthropic", model: modelKey, in_tokens: inTok, out_tokens: outTok, cost_usd: estCost(modelKey, inTok, outTok), ms: Date.now() - t0, ok, detail: ok ? undefined : (data?.error?.message || `HTTP ${res.status}`) }) })
      .catch(() => {}); // best-effort, fire-and-forget
  }
  if (!ok) throw new Error(data?.error?.message || `Anthropic ${res.status}`);
  const text = (data.content || []).map(b => (b.type === "text" ? b.text : "")).join("");
  return { text, outTok };
}

async function loadUserBundle(cfg, userId) {
  const res = await rest(cfg, `app_settings?user_id=eq.${userId}&setting_key=in.(mini,mini_tasks)&select=setting_key,setting_value`, { headers: { Prefer: "" } });
  const rows = await res.json();
  const out = { mini: {}, mini_tasks: [] };
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
async function saveTasks(cfg, userId, tasks) {
  await rest(cfg, `app_settings?user_id=eq.${userId}&setting_key=eq.mini_tasks`, {
    method: "PATCH",
    body: JSON.stringify({ setting_value: tasks, updated_at: new Date().toISOString() }),
  });
}
// The whole task list lives in one JSON setting, so a plain save is a
// last-write-wins overwrite. Merge against a fresh read instead: rows this
// run touched win, everything else (approvals, deletions, newly queued tasks
// from another device) keeps the stored version.
const taskKey = (t) => t.id || `${t.text}::${t.queued_at || ""}`;
async function mergeSaveTasks(cfg, userId, touched) {
  const byKey = new Map(touched.map(t => [taskKey(t), t]));
  const fresh = await loadUserBundle(cfg, userId);
  const stored = Array.isArray(fresh.mini_tasks) ? fresh.mini_tasks : [];
  const merged = stored.map(t => byKey.get(taskKey(t)) || t);
  await saveTasks(cfg, userId, merged);
  return merged;
}

// The real agentic loop: generate, then optionally critique-and-revise up to
// loopMax times. Stops early on an explicit DONE or two consecutive
// no-change revisions. This is the "think longer" knob — Thorough effort
// (loopOn + a higher Max passes) makes it iterate more before delivering.
async function runTask(cfg, mini, system, taskText, userId) {
  const reflect = mini.reflectOn !== false;
  const loop = mini.loopOn !== false;
  const maxLoops = !reflect ? 1 : (!loop ? 2 : Math.max(2, parseInt(mini.loopMax || "5", 10) || 5));

  let draft = null, prevDraft = null, noProgress = 0, loops = 0, outTok = 0;
  for (let i = 0; i < maxLoops; i++) {
    loops++;
    if (draft === null) {
      const r = await claudeCall(cfg, mini.model, system, taskText, 900, userId);
      draft = r.text; outTok += r.outTok;
      if (!reflect) break;
      continue;
    }
    const critiqueSystem = `You are reviewing your own previous draft against the original task, as "Mini Me". If the draft fully satisfies the task and no meaningful improvement is needed, reply with exactly: DONE
Otherwise, reply with ONLY the complete revised draft (no commentary, no prefix) — it will replace the previous draft as-is.`;
    const r = await claudeCall(cfg, mini.model, critiqueSystem, `ORIGINAL TASK:\n${taskText}\n\nCURRENT DRAFT:\n${draft}`, 900, userId);
    outTok += r.outTok;
    const reply = r.text.trim();
    if (reply === "DONE" || reply.startsWith("DONE")) break;
    if (prevDraft !== null && reply === prevDraft.trim()) { noProgress++; if (noProgress >= 2) break; } else noProgress = 0;
    prevDraft = draft;
    draft = reply;
    if (!loop) break;
  }
  return { draft, loops, outTok };
}

async function processUser(cfg, userId) {
  const bundle = await loadUserBundle(cfg, userId);
  const mini = { model: "haiku", budget: "$3", enabled: true, reflectOn: true, loopOn: true, loopMax: "5", approvalOn: true, ...(bundle.mini || {}) };
  if (mini.enabled === false) return { userId, processed: 0, skipped: "Mini Me is off" };

  const tasks = (Array.isArray(bundle.mini_tasks) ? bundle.mini_tasks : []).map(t => t.id ? t : { ...t, id: t.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  // Reclaim tasks stranded in "working" — a previous invocation the platform
  // killed mid-task never got to write a terminal status.
  const STALE_MS = 15 * 60 * 1000;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (t.status === "working" && (!t.working_at || Date.now() - new Date(t.working_at).getTime() > STALE_MS)) tasks[i] = { ...t, status: "queued", working_at: undefined };
  }
  const queuedIdx = tasks.map((t, i) => (t.status === "queued" ? i : -1)).filter(i => i >= 0);
  if (!queuedIdx.length) { await mergeSaveTasks(cfg, userId, tasks); return { userId, processed: 0, skipped: "no queued tasks" }; }

  const limit = BUDGET_TASK_LIMIT[mini.budget] || 3;
  const toRun = queuedIdx.slice(0, limit);

  // Claim the batch up front: mark it "working" and persist BEFORE spending —
  // a concurrent run (second device, approve-triggered reload) then skips
  // these instead of double-spending on the same queue.
  const claimStamp = new Date().toISOString();
  for (const idx of toRun) tasks[idx] = { ...tasks[idx], status: "working", working_at: claimStamp };
  await mergeSaveTasks(cfg, userId, toRun.map(i => tasks[i]));

  const directive = (mini.directive || "").trim();
  const role = (mini.role || "").trim();
  const skillsBlock = await loadSkillsBlock(cfg, userId);
  const system = `You are "Mini Me", the user's autonomous assistant inside their Board Room app.${role ? ` Your role: ${role}` : ""} Produce the requested deliverable directly and completely — concrete and usable, no preamble, no clarifying questions (make reasonable assumptions and state them briefly at the end if needed).${directive ? `\n\nYour prime directive — this is the overall mission, weigh every task against it: ${directive}` : ""}${skillsBlock}`;

  const feedRows = [];
  let processed = 0;
  for (const idx of toRun) {
    const t = tasks[idx];
    try {
      const { draft, loops, outTok } = await runTask(cfg, mini, system, t.text, userId);
      const status = mini.approvalOn ? "review" : "delivered";
      tasks[idx] = { ...t, status, working_at: undefined, output: draft, loops, delivered_at: new Date().toISOString() };
      feedRows.push({ user_id: userId, text: `${status === "review" ? "Drafted (awaiting your approval)" : "Delivered"} "${t.text.slice(0, 60)}${t.text.length > 60 ? "…" : ""}" — ${loops} loop(s), ~${outTok} tokens on ${mini.model}.` });
      processed++;
    } catch (e) {
      tasks[idx] = { ...t, status: "failed", working_at: undefined, output: `Failed: ${e.message}`, delivered_at: new Date().toISOString() };
      feedRows.push({ user_id: userId, text: `Task failed ("${t.text.slice(0, 50)}…"): ${e.message}` });
    }
    // Checkpoint after EVERY task — if the platform kills this invocation on a
    // later task, the money already spent has its output safely recorded.
    await mergeSaveTasks(cfg, userId, [tasks[idx]]).catch(() => {});
  }

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
  // Merge-save just the changed row — a plain whole-array save here while a
  // queue run is in flight would revert its in-progress statuses.
  await mergeSaveTasks(cfg, userId, [tasks[idx]]);
  return { success: true };
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const cfg = env();
  const configured = !!(cfg.anthropic && cfg.url && cfg.service);

  if (body.ping) return json(200, { success: true, service: "mini-worker", configured, missing: configured ? undefined : "ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
  if (!configured) return json(500, { success: false, error: "worker env vars not set" });

  try {
    const auth = event.headers?.authorization || event.headers?.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return json(401, { success: false, error: "sign-in token required" });
    const userId = await verifyUser(cfg, token);
    if (!userId) return json(401, { success: false, error: "invalid or expired session — sign in again" });
    const owner = process.env.OWNER_USER_ID;
    if (owner && userId !== owner) return json(403, { success: false, error: "this deployment is single-user" });

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
