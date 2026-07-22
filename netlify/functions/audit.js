// Fetches a property's live HTML and has Haiku audit it, returning structured
// findings for the Site Auditor card. Needs: ANTHROPIC_API_KEY (+ SUPABASE_URL
// and SUPABASE_SERVICE_ROLE_KEY to verify the caller — required: this spends
// the owner's Anthropic budget and fetches URLs server-side).
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Keep in sync with fetch-page.js / calendar-events.js — inlined (not shared)
// because requiring a common module from these CJS functions under
// `"type":"module"` + esbuild clobbers `exports` (see tmdb.js's comment).
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|0x[0-9a-f]+$|0\d+\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.|::ffff:169\.254\.)/i;
function badUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return "that's not a valid URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) URLs";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOST.test(host) || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") || /^\d+$/.test(host)) return "that host isn't reachable from here";
  return null;
}
const withTimeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const key = process.env.ANTHROPIC_API_KEY;
  if (body.ping) return json(200, { success: true, service: "audit", configured: !!key, missing: key ? undefined : "ANTHROPIC_API_KEY" });
  if (!key) return json(500, { error: "ANTHROPIC_API_KEY not set" });

  // Require a valid Supabase session before fetching arbitrary URLs and
  // spending the owner's API key — same posture as claude.js/fetch-page.js,
  // but fail-closed: if the verification pair isn't configured, refuse rather
  // than run open on a public domain.
  const supaUrl = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !service) return json(500, { error: "auth backend not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });
  {
    const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "sign in first" });
    const who = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!who.ok) return json(401, { error: "session expired — refresh and try again" });
    const owner = process.env.OWNER_USER_ID;
    if (owner) {
      const u = await who.json().catch(() => null);
      if (u?.id !== owner) return json(403, { error: "this deployment is single-user" });
    }
  }

  if (!body.url) return json(400, { error: "url is required" });
  const problem = badUrl(String(body.url).trim());
  if (problem) return json(400, { error: problem });

  try {
    // 1. Fetch the live page (truncate — enough signal, controlled tokens).
    // 5s cap so a slow property can't eat the whole sync-function budget.
    const pageT = withTimeout(5000);
    const pageRes = await fetch(body.url, { headers: { "User-Agent": "BoardRoom-Auditor/1.0" }, redirect: "follow", signal: pageT.signal });
    const status = pageRes.status;
    const html = (await pageRes.text()).slice(0, 25000);
    pageT.done();

    // 2. Ask Haiku for findings as strict JSON
    const system = `You audit websites for a solo founder. Given raw HTML and HTTP status, return ONLY a JSON array (no markdown, no prose) of 0-4 findings. Each finding: {"severity":"high"|"medium"|"low","area":"seo"|"performance"|"conversion"|"content"|"technical","finding":"one specific sentence","suggestion":"one actionable sentence"}. Only report things actually visible in the HTML. If the site looks healthy, return [].`;
    const ask = String(body.ask || "").trim().slice(0, 500);
    const aiT = withTimeout(8500);
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: aiT.signal,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        system,
        messages: [{ role: "user", content: `Site: ${body.name || body.url}\nHTTP status: ${status}${ask ? `\nFocus the audit on: ${ask}` : ""}\n\nHTML (truncated):\n${html}` }],
      }),
    });
    const aiData = await aiRes.json();
    aiT.done();
    const text = (aiData.content || []).map(b => b.type === "text" ? b.text : "").join("");
    let findings = [];
    try { findings = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch {}
    if (!Array.isArray(findings)) findings = [];

    if (status >= 400) findings.unshift({ severity: "high", area: "technical", finding: `Site returned HTTP ${status}.`, suggestion: "Check the deploy status and DNS immediately." });

    return json(200, { success: true, findings: findings.slice(0, 4) });
  } catch (e) {
    const msg = e.name === "AbortError" ? "timed out" : e.message;
    return json(200, { success: true, findings: [{ severity: "high", area: "technical", finding: `Site unreachable: ${msg}`, suggestion: "Verify the URL resolves and the Netlify deploy is live." }] });
  }
};
