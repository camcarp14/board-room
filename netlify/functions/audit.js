// Fetches a property's live HTML and has Haiku audit it, returning structured
// findings for the Site Auditor card. Needs: ANTHROPIC_API_KEY.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const key = process.env.ANTHROPIC_API_KEY;
  if (body.ping) return json(200, { success: true, service: "audit", configured: !!key, missing: key ? undefined : "ANTHROPIC_API_KEY" });
  if (!key) return json(500, { error: "ANTHROPIC_API_KEY not set" });
  if (!body.url) return json(400, { error: "url is required" });

  try {
    // 1. Fetch the live page (truncate — enough signal, controlled tokens)
    const pageRes = await fetch(body.url, { headers: { "User-Agent": "BoardRoom-Auditor/1.0" }, redirect: "follow" });
    const status = pageRes.status;
    const html = (await pageRes.text()).slice(0, 25000);

    // 2. Ask Haiku for findings as strict JSON
    const system = `You audit websites for a solo founder. Given raw HTML and HTTP status, return ONLY a JSON array (no markdown, no prose) of 0-4 findings. Each finding: {"severity":"high"|"medium"|"low","area":"seo"|"performance"|"conversion"|"content"|"technical","finding":"one specific sentence","suggestion":"one actionable sentence"}. Only report things actually visible in the HTML. If the site looks healthy, return [].`;
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        system,
        messages: [{ role: "user", content: `Site: ${body.name || body.url}\nHTTP status: ${status}\n\nHTML (truncated):\n${html}` }],
      }),
    });
    const aiData = await aiRes.json();
    const text = (aiData.content || []).map(b => b.type === "text" ? b.text : "").join("");
    let findings = [];
    try { findings = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch {}
    if (!Array.isArray(findings)) findings = [];

    if (status >= 400) findings.unshift({ severity: "high", area: "technical", finding: `Site returned HTTP ${status}.`, suggestion: "Check the deploy status and DNS immediately." });

    return json(200, { success: true, findings: findings.slice(0, 4) });
  } catch (e) {
    return json(200, { success: true, findings: [{ severity: "high", area: "technical", finding: `Site unreachable: ${e.message}`, suggestion: "Verify the URL resolves and the Netlify deploy is live." }] });
  }
};
