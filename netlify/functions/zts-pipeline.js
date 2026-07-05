// Zero To Secure creator-outreach pipeline stats, pulled directly from the
// ZTS Creator Registry app's own Supabase project.
//
// IMPORTANT — same caveat as clarify-pipeline.js: this schema is an
// educated guess, not a confirmed contract. It assumes a `creators` table
// shaped like:
//   status text    — 'prospected' | 'sent' | 'replied' | 'collab' | 'closed' | 'lost'
//   reach  numeric — follower count / weighted reach for that creator
// If the real table/column names differ, tell Claude and this gets fixed
// in one pass rather than silently showing wrong numbers.
// Needs: ZTS_SUPABASE_URL, ZTS_SUPABASE_ANON_KEY (or a service role key if
// RLS blocks anon reads on this table).
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const url = process.env.ZTS_SUPABASE_URL;
  const key = process.env.ZTS_SUPABASE_ANON_KEY;
  const configured = !!(url && key);

  if (body.ping) return json(200, { success: true, service: "zts-pipeline", configured, missing: configured ? undefined : "ZTS_SUPABASE_URL / ZTS_SUPABASE_ANON_KEY" });
  if (!configured) return json(500, { error: "ZTS Supabase env vars not set" });

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const count = async (query) => {
    const res = await fetch(`${url}/rest/v1/creators?${query}&select=id`, { headers: { ...headers, Prefer: "count=exact", Range: "0-0" } });
    if (!res.ok) throw new Error(`creators query failed (${res.status}) — check the "creators" table exists with the expected columns`);
    return parseInt(res.headers.get("content-range")?.split("/")[1] || "0", 10);
  };
  const sum = async (query, column) => {
    const res = await fetch(`${url}/rest/v1/creators?${query}&select=${column}`, { headers });
    if (!res.ok) throw new Error(`creators query failed (${res.status})`);
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).reduce((s, r) => s + (Number(r[column]) || 0), 0);
  };

  try {
    const [prospected, sent, replied, collab, weightedReach] = await Promise.all([
      count("status=eq.prospected"),
      count("status=eq.sent"),
      count("status=eq.replied"),
      count("status=eq.collab"),
      sum("status=not.in.(closed,lost)", "reach"),
    ]);
    return json(200, { success: true, prospected, sent, replied, collab, weightedReach });
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
