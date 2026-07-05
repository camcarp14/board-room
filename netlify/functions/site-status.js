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

  const urls = Array.isArray(body.urls) ? body.urls.filter(Boolean).slice(0, 20) : [];
  if (!urls.length) return json(400, { error: "urls[] is required" });

  const results = await Promise.all(urls.map(checkOne));
  return json(200, { success: true, results });
};
