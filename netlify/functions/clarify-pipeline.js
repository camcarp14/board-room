// Clarify Outreach pipeline stats, pulled directly from the Clarify Outreach
// app's own Supabase project (a separate project from Board Room's).
//
// IMPORTANT — this schema is an educated guess, not a confirmed contract
// (unlike gsc.js/shopify.js, which integrate documented public APIs). It
// assumes a `leads` table shaped like:
//   status        text   — 'prospected' | 'drafted' | 'sent' | 'replied' | 'closed' | 'lost'
//   source        text   — e.g. 'outreach' | 'inbound'
//   monthly_value numeric — recurring value if the deal closes
// If your actual table/column names differ, this will error clearly rather
// than show wrong numbers — tell Claude the real names and this gets fixed
// in one pass.
// Needs: CLARIFY_SUPABASE_URL, CLARIFY_SUPABASE_ANON_KEY (or a service role
// key if RLS blocks anon reads on this table).
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const url = process.env.CLARIFY_SUPABASE_URL;
  const key = process.env.CLARIFY_SUPABASE_ANON_KEY;
  const configured = !!(url && key);

  if (body.ping) return json(200, { success: true, service: "clarify-pipeline", configured, missing: configured ? undefined : "CLARIFY_SUPABASE_URL / CLARIFY_SUPABASE_ANON_KEY" });
  if (!configured) return json(500, { error: "Clarify Supabase env vars not set" });

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const count = async (query) => {
    const res = await fetch(`${url}/rest/v1/leads?${query}&select=id`, { headers: { ...headers, Prefer: "count=exact", Range: "0-0" } });
    if (!res.ok) throw new Error(`leads query failed (${res.status}) — check the "leads" table exists with the expected columns`);
    return parseInt(res.headers.get("content-range")?.split("/")[1] || "0", 10);
  };
  const sum = async (query, column) => {
    const res = await fetch(`${url}/rest/v1/leads?${query}&select=${column}`, { headers });
    if (!res.ok) throw new Error(`leads query failed (${res.status})`);
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).reduce((s, r) => s + (Number(r[column]) || 0), 0);
  };

  try {
    const [prospected, drafts, sent, replied, activeInbound, valueAtStake] = await Promise.all([
      count("status=eq.prospected"),
      count("status=eq.drafted"),
      count("status=eq.sent"),
      count("status=eq.replied"),
      count("source=eq.inbound&status=not.in.(closed,lost,converted)"),
      sum("status=not.in.(closed,lost)", "monthly_value"),
    ]);
    const replyRate = sent > 0 ? Math.round((replied / sent) * 100) : 0;
    return json(200, { success: true, prospected, drafts, sent, replied, replyRate, activeInbound, valueAtStake });
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
