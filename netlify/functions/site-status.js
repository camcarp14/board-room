// Fan-out HEAD/GET checks against each property's live URL, server-side —
// browsers can't read cross-origin response status directly (CORS gives an
// opaque response), so this has to run here rather than client-side.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function checkOne(url) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    return { url, up: res.status < 500, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { url, up: false, status: 0, ms: Date.now() - t0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "site-status", configured: true });

  // Session-gated: unauthenticated this was a blind probe oracle (status +
  // latency for arbitrary URLs via Netlify's IP). The app always sends the
  // caller's token (callFn attaches it), so requiring it costs nothing.
  const supaUrl = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !service) return json(500, { error: "auth backend not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });
  {
    const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "sign in first" });
    const who = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!who.ok) return json(401, { error: "session expired — refresh and try again" });
  }

  const urls = Array.isArray(body.urls) ? body.urls.filter(Boolean).slice(0, 20) : [];
  if (!urls.length) return json(400, { error: "urls[] is required" });

  const results = await Promise.all(urls.map(checkOne));
  return json(200, { success: true, results });
};
