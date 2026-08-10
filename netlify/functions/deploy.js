// Triggers a fresh build for one of your Netlify sites via the Netlify API, and
// — because the reason you open this panel is usually that the last build broke
// something — lists that site's recent deploys and puts an old one back.
// Needs: NETLIFY_API_TOKEN (User settings → Applications → Personal access token).
// The `site` value from PROPERTIES is treated as the site name/slug and
// resolved to a site_id. Zip uploads from the UI are intentionally not
// supported here — trigger builds from the connected repo instead.
//
// Three actions, all against the same resolved site:
//   build    POST /sites/:id/builds                  a fresh build of the repo
//   list     GET  /sites/:id/deploys?per_page=15     the recent ones, trimmed
//   restore  POST /sites/:id/deploys/:deploy/restore republish one of them
//
// `list` returns only deploys in state "ready". Netlify hands back the failed
// and building ones too, and neither has an artifact to republish — restoring
// one fails at the API, and the only place that shows up is a UI reporting
// "rollback failed" for a row it should never have offered in the first place.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const API = "https://api.netlify.com/api/v1";
const ACTIONS = ["build", "list", "restore"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const token = process.env.NETLIFY_API_TOKEN;
  if (body.ping) return json(200, { success: true, service: "deploy", configured: !!token, missing: token ? undefined : "NETLIFY_API_TOKEN" });
  if (!token) return json(500, { error: "NETLIFY_API_TOKEN not set" });

  // Only the configured owner may trigger builds with the Netlify token.
  const supaUrl = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const owner = String(process.env.BOARD_USER_ID || "").trim();
  if (!supaUrl || !service || !owner) return json(503, { error: "server owner is not configured" });
  const auth = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
  if (!auth) return json(401, { error: "sign in first" });
  const who = await fetch(`${supaUrl}/auth/v1/user`, { signal: AbortSignal.timeout(15000), headers: { apikey: service, Authorization: `Bearer ${auth}` } });
  if (!who.ok) return json(401, { error: "session expired — refresh and try again" });
  const user = await who.json().catch(() => null);
  if (user?.id !== owner) return json(403, { error: "this account is not allowed to use Board Room" });

  if (!body.site) return json(400, { error: "site is required" });
  const action = String(body.action || "build");
  if (!ACTIONS.includes(action)) return json(400, { error: `unknown action '${action}' — supported: ${ACTIONS.join(", ")}. Zip deploys stay disabled by design.` });

  // A restore interpolates the deploy id straight into a Netlify URL path, so
  // it is checked here rather than trusted for having come from our own list
  // call — the client is the network, and nothing stops a hand-rolled POST.
  // Netlify deploy ids are 24 hex characters; the length range is loose because
  // that is their choice to change, but the alphabet is not negotiable.
  const deployId = String(body.deploy_id || "").trim();
  if (action === "restore") {
    if (!deployId) return json(400, { error: "deploy_id is required to restore" });
    if (!/^[0-9a-f]{20,30}$/i.test(deployId)) return json(400, { error: "deploy_id is not a Netlify deploy id" });
  }

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    // Resolve slug/name → site_id
    const sitesRes = await fetch(`${API}/sites?name=${encodeURIComponent(body.site)}`, { signal: AbortSignal.timeout(15000), headers });
    const sites = await sitesRes.json();
    const site = (Array.isArray(sites) ? sites : []).find(s => s.name === body.site) || sites[0];
    if (!site?.id) return json(404, { error: `site '${body.site}' not found for this token` });

    if (action === "list") {
      const listRes = await fetch(`${API}/sites/${site.id}/deploys?per_page=15`, { signal: AbortSignal.timeout(15000), headers });
      const raw = await listRes.json();
      if (!listRes.ok) return json(listRes.status, { error: raw?.message || "could not read the deploy list" });
      // Which deploy is actually live right now. The site payload names it as an
      // id and also carries the whole deploy nested; read whichever is present
      // rather than betting on one, because getting it wrong marks the wrong row
      // as current and offers a "rollback" to the build already running — a
      // no-op the UI would have to report as a success.
      const publishedId = site.published_deploy_id || site.published_deploy?.id || null;
      const deploys = (Array.isArray(raw) ? raw : [])
        .filter(d => d.state === "ready")
        .map(d => ({
          id: d.id,
          state: d.state,
          created_at: d.created_at,
          branch: d.branch,
          commit_ref: d.commit_ref,
          commit_url: d.commit_url,
          title: d.title,
          published: !!publishedId && d.id === publishedId,
        }));
      return json(200, { success: true, site: site.name, deploys });
    }

    if (action === "restore") {
      const restoreRes = await fetch(`${API}/sites/${site.id}/deploys/${deployId}/restore`, { signal: AbortSignal.timeout(15000), method: "POST", headers, body: JSON.stringify({}) });
      const restored = await restoreRes.json().catch(() => ({}));
      if (!restoreRes.ok) return json(restoreRes.status, { error: restored?.message || "restore failed" });
      const short = String(restored.commit_ref || deployId).slice(0, 7);
      return json(200, { success: true, site: site.name, deploy_id: restored.id || deployId, state: restored.state, commit_ref: restored.commit_ref, message: `${site.name} rolled back to ${short}` });
    }

    const buildRes = await fetch(`${API}/sites/${site.id}/builds`, { signal: AbortSignal.timeout(15000), method: "POST", headers, body: JSON.stringify({}) });
    const build = await buildRes.json();
    if (!buildRes.ok) return json(buildRes.status, { error: build.message || "build trigger failed" });

    return json(200, { success: true, site: site.name, build_id: build.id, message: `build triggered for ${site.name}` });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
