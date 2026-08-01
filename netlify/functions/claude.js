// Proxies /v1/messages so ANTHROPIC_API_KEY stays server-side.
// { ping: true } → config status only, no API call, no spend.
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// The only models the app ever asks for. Allowlisted so a caller can't request
// an arbitrary (expensive) model even with a valid session.
// MUST match MODEL_IDS in src/lib/claude.js — a client-side id that isn't here
// comes back as "unsupported model", which looks nothing like the real cause.
const ALLOWED_MODELS = new Set(["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"]);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "invalid JSON" }); }

  const key = process.env.ANTHROPIC_API_KEY;

  if (body.ping) {
    return json(200, { success: true, service: "claude", configured: !!key, missing: key ? undefined : "ANTHROPIC_API_KEY" });
  }
  if (!key) return json(500, { error: "ANTHROPIC_API_KEY is not set on this site" });

  // Require the configured owner before spending the shared API key.
  const supaUrl = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const owner = String(process.env.BOARD_USER_ID || "").trim();
  if (!supaUrl || !service || !owner) return json(503, { error: "server owner is not configured" });
  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "sign in first" });
  const who = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
  if (!who.ok) return json(401, { error: "session expired — refresh and try again" });
  const user = await who.json().catch(() => null);
  if (user?.id !== owner) return json(403, { error: "this account is not allowed to use Board Room" });

  if (!ALLOWED_MODELS.has(body.model)) return json(400, { error: "unsupported model" });

  // Only forward the fields the app actually uses.
  const payload = {
    model: body.model,
    max_tokens: Math.min(body.max_tokens || 800, 4096),
    messages: body.messages,
  };
  if (body.system) payload.system = body.system;
  // Sonnet 5 runs ADAPTIVE thinking when `thinking` is omitted, so a call with a
  // tight max_tokens can spend its budget reasoning and truncate the answer.
  // The vision-parse call passes {type:"disabled"} for exactly that reason —
  // forward it, or the opt-out silently doesn't happen.
  if (body.thinking) payload.thinking = body.thinking;

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
