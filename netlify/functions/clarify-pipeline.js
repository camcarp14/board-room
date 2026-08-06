// Clarify Outreach pipeline stats, pulled directly from the Clarify Outreach
// app's own Supabase project (a separate project from Board Room's).
//
// Real schema, confirmed against an actual export (2026-07-05) — this
// replaces an earlier version that guessed at a "leads" table and got it
// wrong. The real table is `outreach`:
//   status      text      — 'prospected' | 'draft' | 'sent' (not 'drafted')
//   replied_at  timestamp — reply state is tracked here, not as a status
//                            value (a row can be status='sent' and still
//                            have replied_at populated once they reply)
// There's no dollar-value or inbound/outbound-source column anywhere in
// this table, so "value at stake" and "active inbound leads" aren't
// computable from it — dropped rather than guessed. If those live
// somewhere else (a `prospects` table?), tell Claude the real source and
// they can be added back for real.
// Needs: CLARIFY_SUPABASE_URL, CLARIFY_SUPABASE_ANON_KEY (or a service role
// key if RLS blocks anon reads on this table).
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
    const who = await fetch(`${url}/auth/v1/user`, { signal: AbortSignal.timeout(30000), headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!who.ok) return json(401, { success: false, error: "session expired — refresh and try again" });
    const u = await who.json();
    if (u?.id !== owner) return json(403, { success: false, error: "this account is not allowed to use Board Room" });
  } catch {
    return json(503, { success: false, error: "couldn't verify your session — try again in a moment" });
  }
  return null;
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const url = process.env.CLARIFY_SUPABASE_URL;
  const key = process.env.CLARIFY_SUPABASE_ANON_KEY;
  const configured = !!(url && key);

  if (body.ping) return json(200, { success: true, service: "clarify-pipeline", configured, missing: configured ? undefined : "CLARIFY_SUPABASE_URL / CLARIFY_SUPABASE_ANON_KEY" });
  if (!configured) return json(500, { error: "Clarify Supabase env vars not set" });

  // Outreach pipeline counts from the Clarify project — session required.
  const denied = await denyUnlessSignedIn(event);
  if (denied) return denied;

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const count = async (query) => {
    const res = await fetch(`${url}/rest/v1/outreach?${query}&select=id`, { signal: AbortSignal.timeout(30000), headers: { ...headers, Prefer: "count=exact", Range: "0-0" } });
    if (!res.ok) throw new Error(`outreach query failed (${res.status}) — check the "outreach" table and its columns still match`);
    return parseInt(res.headers.get("content-range")?.split("/")[1] || "0", 10);
  };

  try {
    const [prospected, drafts, sent, replied] = await Promise.all([
      count("status=eq.prospected"),
      count("status=eq.draft"),
      count("status=eq.sent"),
      count("replied_at=not.is.null"),
    ]);
    const replyRate = sent > 0 ? Math.round((replied / sent) * 100) : 0;
    return json(200, { success: true, prospected, drafts, sent, replied, replyRate });
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
