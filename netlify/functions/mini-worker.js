// Mini Me worker — the real engine behind the Mini Me page.
// Two ways it runs:
//   1. Scheduled nightly via netlify.toml (09:00 UTC ≈ 3–4 AM Chicago) for
//      every user whose "Overnight autonomy" toggle is on.
//   2. On demand: POST { run: true } with the signed-in user's Supabase
//      access token in the Authorization header ("Run queue now" button).
// For each queued task it calls Claude (model + budget from the user's Mini
// Me controls), writes the deliverable back onto the task, and appends a row
// to mini_feed — so the stats/feed in the UI are real activity, not mockups.
// Needs: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const MODEL_IDS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-1" };
const BUDGET_TASK_LIMIT = { "$1": 1, "$3": 3, "$10": 8 }; // tasks per run, a rough budget proxy

function env() {
  return {
    anthropic: process.env.ANTHROPIC_API_KEY,
    url: process.env.SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
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

async function claudeCall(cfg, modelKey, system, user, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": cfg.anthropic, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL_IDS[modelKey] || MODEL_IDS.haiku, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic ${res.status}`);
  const text = (data.content || []).map(b => (b.type === "text" ? b.text : "")).join("");
  return { text, outTok: data.usage?.output_tokens || 0 };
}

async function loadUserBundle(cfg, userId) {
  const res = await rest(cfg, `app_settings?user_id=eq.${userId}&setting_key=in.(mini,mini_tasks,mini_skills)&select=setting_key,setting_value`, { headers: { Prefer: "" } });
  const rows = await res.json();
  const out = { mini: {}, mini_tasks: [], mini_skills: [] };
  (Array.isArray(rows) ? rows : []).forEach(r => { out[r.setting_key] = r.setting_value; });
  return out;
}

async function processUser(cfg, userId, { manual = false } = {}) {
  const bundle = await loadUserBundle(cfg, userId);
  const mini = { model: "haiku", budget: "$3", night: true, ...(bundle.mini || {}) };
  if (!manual && mini.night === false) return { userId, processed: 0, skipped: "night off" };

  const tasks = Array.isArray(bundle.mini_tasks) ? bundle.mini_tasks : [];
  const queuedIdx = tasks.map((t, i) => (t.status === "queued" ? i : -1)).filter(i => i >= 0);
  if (!queuedIdx.length) return { userId, processed: 0, skipped: "no queued tasks" };

  const limit = BUDGET_TASK_LIMIT[mini.budget] || 3;
  const toRun = queuedIdx.slice(0, limit);
  const skillNotes = (Array.isArray(bundle.mini_skills) ? bundle.mini_skills : [])
    .filter(s => s.note).map(s => `- ${s.name}: ${s.note}`).join("\n");
  const system = `You are "Mini Me", the user's autonomous overnight assistant inside their Board Room app. Produce the requested deliverable directly and completely — concrete and usable, no preamble, no clarifying questions (make reasonable assumptions and state them briefly at the end if needed).${skillNotes ? `\n\nStanding guidance from the user:\n${skillNotes}` : ""}`;

  const feedRows = [];
  let processed = 0;
  for (const idx of toRun) {
    const t = tasks[idx];
    try {
      const { text, outTok } = await claudeCall(cfg, mini.model, system, t.text, 900);
      tasks[idx] = { ...t, status: "delivered", output: text, delivered_at: new Date().toISOString() };
      feedRows.push({ user_id: userId, text: `Delivered "${t.text.slice(0, 70)}${t.text.length > 70 ? "…" : ""}" — ${outTok} tokens on ${mini.model}.` });
      processed++;
    } catch (e) {
      tasks[idx] = { ...t, status: "failed", output: `Failed: ${e.message}`, delivered_at: new Date().toISOString() };
      feedRows.push({ user_id: userId, text: `Task failed ("${t.text.slice(0, 50)}…"): ${e.message}` });
    }
  }

  await rest(cfg, `app_settings?user_id=eq.${userId}&setting_key=eq.mini_tasks`, {
    method: "PATCH",
    body: JSON.stringify({ setting_value: tasks, updated_at: new Date().toISOString() }),
  });
  if (feedRows.length) await rest(cfg, "mini_feed", { method: "POST", body: JSON.stringify(feedRows) });

  return { userId, processed };
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const cfg = env();
  const configured = !!(cfg.anthropic && cfg.url && cfg.service);

  if (body.ping) return json(200, { success: true, service: "mini-worker", configured, missing: configured ? undefined : "ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
  if (!configured) return json(500, { success: false, error: "worker env vars not set" });

  // Scheduled invocations carry next_run in the body and no user auth.
  const isScheduled = !!body.next_run;

  try {
    if (isScheduled) {
      const res = await rest(cfg, "app_settings?setting_key=eq.mini_tasks&select=user_id", { headers: { Prefer: "" } });
      const rows = await res.json();
      const userIds = [...new Set((Array.isArray(rows) ? rows : []).map(r => r.user_id))];
      const results = [];
      for (const uid of userIds) results.push(await processUser(cfg, uid));
      const total = results.reduce((s, r) => s + r.processed, 0);
      return json(200, { success: true, scheduled: true, users: userIds.length, processed: total });
    }

    // On-demand: authenticate the caller.
    const auth = event.headers?.authorization || event.headers?.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return json(401, { success: false, error: "sign-in token required" });
    const userId = await verifyUser(cfg, token);
    if (!userId) return json(401, { success: false, error: "invalid or expired session — sign in again" });

    const result = await processUser(cfg, userId, { manual: true });
    return json(200, { success: true, processed: result.processed, message: result.skipped ? result.skipped : `processed ${result.processed} task(s)` });
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
