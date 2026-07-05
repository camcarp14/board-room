// Proxies /v1/messages so ANTHROPIC_API_KEY stays server-side.
// { ping: true } → config status only, no API call, no spend.
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "invalid JSON" }); }

  const key = process.env.ANTHROPIC_API_KEY;

  if (body.ping) {
    return json(200, { success: true, service: "claude", configured: !!key, missing: key ? undefined : "ANTHROPIC_API_KEY" });
  }
  if (!key) return json(500, { error: "ANTHROPIC_API_KEY is not set on this site" });

  // Only forward the fields the app actually uses.
  const payload = {
    model: body.model,
    max_tokens: Math.min(body.max_tokens || 800, 4096),
    messages: body.messages,
  };
  if (body.system) payload.system = body.system;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return json(res.status, data);
  } catch (e) {
    return json(502, { error: "upstream request failed: " + e.message });
  }
};
