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
// Needs: CLARIFY_SUPABASE_URL and a key the table admits.
//
// THE ANON KEY IS NOT THAT KEY, AND HAS NOT BEEN SINCE 2026-08-02. public.outreach
// grants select to postgres, service_role and authenticated only, and its one
// RLS policy (outreach_operator_only) is for {authenticated}: a request wearing
// the anon key gets `permission denied for table outreach`, a 401 from
// PostgREST. Every call this function made for a month was that 401 — 1,600+
// usage_log rows — and the error text blamed the table's columns, which were
// fine, so the outage read as a schema question nobody could answer. The Brief's
// Clarify card sat in its error state the whole time.
//
// So the read uses CLARIFY_SUPABASE_SERVICE_ROLE_KEY when it is set. That key
// bypasses RLS on a project Board Room does not own, which is acceptable only
// because it never leaves this function: the caller's own session is verified
// first (denyUnlessSignedIn below), the read is four exact-count HEAD-shaped
// queries, and nothing from the request body reaches the query string. The anon
// key remains the fallback so a project that DOES grant anon keeps working, and
// the 401/403 branch now names the real problem instead of the columns.
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
  const serviceKey = process.env.CLARIFY_SUPABASE_SERVICE_ROLE_KEY;
  const key = serviceKey || process.env.CLARIFY_SUPABASE_ANON_KEY;
  const configured = !!(url && key);

  if (body.ping) return json(200, { success: true, service: "clarify-pipeline", configured, missing: configured ? undefined : "CLARIFY_SUPABASE_URL / CLARIFY_SUPABASE_SERVICE_ROLE_KEY" });
  if (!configured) return json(500, { error: "Clarify Supabase env vars not set" });

  // Outreach pipeline counts from the Clarify project — session required.
  const denied = await denyUnlessSignedIn(event);
  if (denied) return denied;

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const count = async (query) => {
    const res = await fetch(`${url}/rest/v1/outreach?${query}&select=id`, { signal: AbortSignal.timeout(30000), headers: { ...headers, Prefer: "count=exact", Range: "0-0" } });
    // A 401/403 is the KEY being refused, not the columns — see the header. The
    // old message sent the reader to check a schema that was never wrong.
    if (res.status === 401 || res.status === 403) {
      throw new Error(serviceKey
        ? `outreach query failed (${res.status}) — CLARIFY_SUPABASE_SERVICE_ROLE_KEY is not allowed to read "outreach"; check it is the Clarify project's service_role key`
        : `outreach query failed (${res.status}) — the anon key has no grant on "outreach"; set CLARIFY_SUPABASE_SERVICE_ROLE_KEY in Netlify env vars and redeploy`);
    }
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
