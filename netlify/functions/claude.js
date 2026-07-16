// Proxies /v1/messages so ANTHROPIC_API_KEY stays server-side.
// { ping: true } → config status only, no API call, no spend.
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// The only models the app ever asks for. Allowlisted so a caller can't request
// an arbitrary (expensive) model even with a valid session.
const ALLOWED_MODELS = new Set(["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-1"]);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "invalid JSON" }); }

  const key = process.env.ANTHROPIC_API_KEY;

  if (body.ping) {
    return json(200, { success: true, service: "claude", configured: !!key, missing: key ? undefined : "ANTHROPIC_API_KEY" });
  }
  if (!key) return json(500, { error: "ANTHROPIC_API_KEY is not set on this site" });

  // Require a valid Supabase session before spending the owner's API key —
  // otherwise this is an open, guessable LLM proxy on a public domain. Same
  // posture as fetch-page/mini-worker: enforced whenever the service key is set.
  const supaUrl = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supaUrl && service) {
    const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "sign in first" });
    const who = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!who.ok) return json(401, { error: "session expired — refresh and try again" });
  }

  if (!ALLOWED_MODELS.has(body.model)) return json(400, { error: "unsupported model" });

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
