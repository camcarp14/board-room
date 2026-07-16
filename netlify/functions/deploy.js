// Triggers a fresh build for one of your Netlify sites via the Netlify API.
// Needs: NETLIFY_API_TOKEN (User settings → Applications → Personal access token).
// The `site` value from PROPERTIES is treated as the site name/slug and
// resolved to a site_id. Zip uploads from the UI are intentionally not
// supported here — trigger builds from the connected repo instead.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const API = "https://api.netlify.com/api/v1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const token = process.env.NETLIFY_API_TOKEN;
  if (body.ping) return json(200, { success: true, service: "deploy", configured: !!token, missing: token ? undefined : "NETLIFY_API_TOKEN" });
  if (!token) return json(500, { error: "NETLIFY_API_TOKEN not set" });

  // Require a valid session before triggering builds with the Netlify token.
  const supaUrl = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supaUrl && service) {
    const auth = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
    if (!auth) return json(401, { error: "sign in first" });
    const who = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${auth}` } });
    if (!who.ok) return json(401, { error: "session expired — refresh and try again" });
  }

  if (!body.site) return json(400, { error: "site is required" });
  if (body.action && body.action !== "build") return json(400, { error: "only action:'build' is supported — zip deploys are disabled by design" });

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    // Resolve slug/name → site_id
    const sitesRes = await fetch(`${API}/sites?name=${encodeURIComponent(body.site)}`, { headers });
    const sites = await sitesRes.json();
    const site = (Array.isArray(sites) ? sites : []).find(s => s.name === body.site) || sites[0];
    if (!site?.id) return json(404, { error: `site '${body.site}' not found for this token` });

    const buildRes = await fetch(`${API}/sites/${site.id}/builds`, { method: "POST", headers, body: JSON.stringify({}) });
    const build = await buildRes.json();
    if (!buildRes.ok) return json(buildRes.status, { error: build.message || "build trigger failed" });

    return json(200, { success: true, site: site.name, build_id: build.id, message: `build triggered for ${site.name}` });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
