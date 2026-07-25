// ─── requireUser — one session gate for every function that shouldn't be open ──
// This exact six-line check was hand-copied into claude/deploy/db-admin/
// fetch-page/mini-worker, and then NOT copied into audit, shopify, gsc, and the
// two pipeline functions — which is how an LLM proxy and four business-metric
// endpoints ended up answering anonymous POSTs. One helper so the next function
// can't forget it.
//
// Usage — always AFTER the { ping: true } branch, so health pills (which are
// deliberately tokenless) keep working:
//
//   const { json } = require("./_shared/response");
//   const { requireUser } = require("./_shared/require-user");
//   …
//   if (body.ping) return json(200, { success: true, service: "x", configured });
//   const denied = await requireUser(event, json);
//   if (denied) return denied;
//
// Returns null when the caller is verified, or a ready-to-return 401 response.
//
// Degrades open when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set, which
// is what makes `netlify dev` usable without the service key — the same posture
// the five original call sites already took. In production those vars are set,
// so the gate is live.

async function requireUser(event, json) {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return null; // local dev without the service key

  const headers = event.headers || {};
  const token = String(headers.authorization || headers.Authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) return json(401, { success: false, error: "sign in first" });

  try {
    const who = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: service, Authorization: `Bearer ${token}` },
    });
    if (!who.ok) return json(401, { success: false, error: "session expired — refresh and try again" });
  } catch {
    // Can't reach Supabase to verify. Fail CLOSED: an unverifiable caller is
    // exactly the case this gate exists for, and every caller here is a
    // dashboard card that degrades to "Error" gracefully.
    return json(503, { success: false, error: "couldn't verify your session — try again in a moment" });
  }
  return null;
}

module.exports = { requireUser };
