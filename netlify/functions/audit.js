// Fetches a property's live HTML and has Haiku audit it, returning structured
// findings for the Site Auditor card. Needs: ANTHROPIC_API_KEY.
//
// SECURITY — this function used to be wide open, and it holds the Anthropic key.
// Anonymous callers could (a) spend that key without limit, and (b) use it as a
// server-side fetcher for any URL, getting back either an LLM summary of the
// response or the raw error string. Both are closed now:
//   · a session gate — same posture as claude/deploy/db-admin/fetch-page.
//   · badUrl() — http(s) only, no private/loopback/link-local hosts. Same guard
//     fetch-page has carried all along; this function was missing it entirely.
//   · a 10s abort timer, because there wasn't one.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Session gate, inlined ON PURPOSE. Under this repo's "type":"module" + esbuild
// bundling, `module.exports` inside a required helper clobbers the bundle's
// exports before `exports.handler` is assigned and the function deploys with NO
// handler — a 502 on every call. See the same note in tmdb.js and
// workout-import.js; btc.js / mini-worker.js work precisely because they are
// self-contained. Do NOT refactor these back into a shared module.
// Degrades open when the service key is absent so `netlify dev` still runs.
// Returns { denied } to refuse, or { userId } to proceed. It used to verify the
// token and throw the identity away; usage_log needs it, so the id now rides
// back out. userId is null when the service key is absent (the degrade-open
// path) — spend simply goes unlogged there, same as it always did locally.
async function denyUnlessSignedIn(event) {
  const url = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return { userId: null };
  const h = event.headers || {};
  const token = String(h.authorization || h.Authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { denied: json(401, { success: false, error: "sign in first" }) };
  try {
    const who = await fetch(`${url}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!who.ok) return { denied: json(401, { success: false, error: "session expired — refresh and try again" }) };
    const u = await who.json();
    return { userId: u?.id || null };
  } catch {
    return { denied: json(503, { success: false, error: "couldn't verify your session — try again in a moment" }) };
  }
}

// Spend accounting. This function bills the owner's Anthropic key on every
// call and wrote NOTHING to usage_log — callFn logged a kind:"call" row with no
// tokens and no cost, so Systems → Usage showed the audit happening at $0.
// Inlined for the same bundling reason as the session gate above; the pricing
// table is asserted against src/lib/claude.js by scripts/spend-smoke.mjs.
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
const estCost = (mk, i, o, cacheWrite = 0, cacheRead = 0) => {
  const p = rateFor(mk);
  return ((i + cacheWrite * 1.25 + cacheRead * 0.1) * p.in + o * p.out) / 1e6;
};
/** Fire-and-forget usage row. Never awaited, never throws into the caller —
 *  accounting must not be able to fail an audit. */
function logSpend(userId, { modelKey, usage, ms, ok, detail }) {
  const url = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service || !userId) return;
  const u = usage || {};
  const cacheWrite = u.cache_creation_input_tokens || 0, cacheRead = u.cache_read_input_tokens || 0;
  const inTok = (u.input_tokens || 0) + cacheWrite + cacheRead;
  const outTok = u.output_tokens || 0;
  try {
    fetch(`${url}/rest/v1/usage_log`, {
      method: "POST",
      headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json", "Content-Profile": "boardroom", Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: userId, fn: "audit", kind: "anthropic", model: modelKey, in_tokens: inTok, out_tokens: outTok, cost_usd: estCost(modelKey, u.input_tokens || 0, outTok, cacheWrite, cacheRead), ms, ok, detail: detail ? String(detail).slice(0, 500) : undefined }),
    }).catch(() => {});
  } catch { /* accounting is best-effort */ }
}

// Mirrors fetch-page.js — keep the two in sync.
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

function badUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return "that's not a valid URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http and https URLs can be audited";
  if (PRIVATE_HOST.test(u.hostname)) return "that host isn't reachable from here";
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const key = process.env.ANTHROPIC_API_KEY;
  // Ping stays tokenless — the Status tab's health pills don't carry a session.
  if (body.ping) return json(200, { success: true, service: "audit", configured: !!key, missing: key ? undefined : "ANTHROPIC_API_KEY" });
  if (!key) return json(500, { error: "ANTHROPIC_API_KEY not set" });

  const gate = await denyUnlessSignedIn(event);
  if (gate.denied) return gate.denied;
  const userId = gate.userId;

  if (!body.url) return json(400, { error: "url is required" });
  const problem = badUrl(String(body.url).trim());
  if (problem) return json(400, { error: problem });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    // 1. Fetch the live page (truncate — enough signal, controlled tokens)
    const pageRes = await fetch(body.url, {
      headers: { "User-Agent": "BoardRoom-Auditor/1.0" },
      redirect: "follow",
      signal: controller.signal,
    });
    const status = pageRes.status;
    const html = (await pageRes.text()).slice(0, 25000);

    // 2. Ask Haiku for findings as strict JSON
    const system = `You audit websites for a solo founder. Given raw HTML and HTTP status, return ONLY a JSON array (no markdown, no prose) of 0-4 findings. Each finding: {"severity":"high"|"medium"|"low","area":"seo"|"performance"|"conversion"|"content"|"technical","finding":"one specific sentence","suggestion":"one actionable sentence"}. Only report things actually visible in the HTML. If the site looks healthy, return [].`;
    const aiT0 = Date.now();
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 800,
        system,
        messages: [{ role: "user", content: `Site: ${body.name || body.url}\nHTTP status: ${status}\n\nHTML (truncated):\n${html}` }],
      }),
    });
    const aiData = await aiRes.json();
    logSpend(userId, { modelKey: "haiku", usage: aiData.usage, ms: Date.now() - aiT0, ok: aiRes.ok, detail: aiRes.ok ? undefined : (aiData?.error?.message || `HTTP ${aiRes.status}`) });
    const text = (aiData.content || []).map(b => b.type === "text" ? b.text : "").join("");
    let findings = [];
    try { findings = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch {}
    if (!Array.isArray(findings)) findings = [];

    if (status >= 400) findings.unshift({ severity: "high", area: "technical", finding: `Site returned HTTP ${status}.`, suggestion: "Check the deploy status and DNS immediately." });

    return json(200, { success: true, findings: findings.slice(0, 4) });
  } catch (e) {
    const why = e.name === "AbortError" ? "the site took longer than 10s to respond" : e.message;
    return json(200, { success: true, findings: [{ severity: "high", area: "technical", finding: `Site unreachable: ${why}`, suggestion: "Verify the URL resolves and the Netlify deploy is live." }] });
  } finally {
    clearTimeout(timer);
  }
};
