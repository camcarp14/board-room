// Fan-out HEAD/GET checks against each property's live URL, server-side —
// browsers can't read cross-origin response status directly (CORS gives an
// opaque response), so this has to run here rather than client-side.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Status checks must only reach public properties. Session authentication stops
// anonymous abuse, but it does not make caller-supplied internal URLs safe.
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;
function badUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return "not a valid URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) URLs are supported";
  if (u.username || u.password) return "URLs cannot include credentials";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    PRIVATE_HOST.test(host) || host === "::" || host === "::1" ||
    host.startsWith("::ffff:") || host.startsWith("fe80:") ||
    host.startsWith("fc") || host.startsWith("fd") ||
    host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")
  ) return "that host isn't reachable from here";
  return null;
}

async function fetchPublicUrl(raw, init) {
  let url = raw;
  for (let hop = 0; hop <= 3; hop++) {
    const problem = badUrl(url);
    if (problem) throw new Error(problem);
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    if (hop === 3) throw new Error("too many redirects");
    url = new URL(location, url).toString();
  }
}

// Session gate, inlined ON PURPOSE. Under this repo's "type":"module" + esbuild
// bundling, `module.exports` inside a required helper clobbers the bundle's
// exports before `exports.handler` is assigned and the function deploys with NO
// handler — a 502 on every call. See the same note in tmdb.js and
// workout-import.js; btc.js / mini-worker.js work precisely because they are
// self-contained. Do NOT refactor these back into a shared module.
async function denyUnlessSignedIn(event) {
  const url = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const owner = String(process.env.BOARD_USER_ID || "").trim();
  if (!url || !service || !owner) return json(503, { success: false, error: "server owner is not configured" });
  const h = event.headers || {};
  const token = String(h.authorization || h.Authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { success: false, error: "sign in first" });
  try {
    const who = await fetch(`${url}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!who.ok) return json(401, { success: false, error: "session expired — refresh and try again" });
    const u = await who.json();
    if (u?.id !== owner) return json(403, { success: false, error: "this account is not allowed to use Board Room" });
  } catch {
    return json(503, { success: false, error: "couldn't verify your session — try again in a moment" });
  }
  return null;
}

async function checkOne(url) {
  const t0 = Date.now();
  const problem = badUrl(url);
  if (problem) return { url, up: false, status: 0, ms: 0, error: problem };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetchPublicUrl(url, { signal: controller.signal });
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

  // Session required: this fans out up to 20 caller-supplied fetches from our
  // domain and reports each status, which is a fine uptime check for the
  // Properties page and a fine port scanner for anyone else.
  const denied = await denyUnlessSignedIn(event);
  if (denied) return denied;

  const urls = Array.isArray(body.urls)
    ? body.urls.filter((url) => typeof url === "string" && url.trim()).map((url) => url.trim()).slice(0, 20)
    : [];
  if (!urls.length) return json(400, { error: "urls[] is required" });

  const results = await Promise.all(urls.map(checkOne));
  return json(200, { success: true, results });
};

// Exported only for functions-smoke.mjs. Netlify reads `handler`.
exports.badUrl = badUrl;
