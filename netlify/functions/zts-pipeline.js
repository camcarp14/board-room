// Zero To Secure creator-outreach pipeline stats.
//
// ZTS used to be its own standalone app with its own Supabase project (a
// `creators` table whose data all lived in a JSONB `payload` column). It has
// since been folded into "The Pentagon" (https://the-pentagon.netlify.app),
// which consolidated ZTS, Clarify, and Runway onto ONE Supabase project — the
// same one Clarify uses — with each tool in its own schema. So ZTS's data now
// lives in the `zts` schema of the Clarify/Pentagon project, and the table is
// flat, not JSONB:
//   stage             text — 'prospected' | 'drafted' | 'sent' | 'replied' | 'collab'
//   subscriber_count  int  — the creator's audience size (a real number now)
// We therefore read from CLARIFY_SUPABASE_URL (the surviving project) and select
// the `zts` schema with PostgREST's Accept-Profile header.
//
// Needs: CLARIFY_SUPABASE_URL, CLARIFY_SUPABASE_ANON_KEY (the same vars the
// clarify-pipeline function uses). If RLS blocks anon reads on zts.creators,
// either add a policy allowing anon SELECT or point the anon var at a
// service-role key.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Flat stage → the four buckets the Brief card shows. "drafted" is a pre-send
// stage, so it folds in with prospected.
function bucketOf(stage) {
  const s = String(stage || "").toLowerCase();
  if (s === "collab") return "collab";
  if (s === "replied") return "replied";
  if (s === "sent") return "sent";
  return "prospected"; // prospected, drafted, or anything else early-funnel
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const url = process.env.CLARIFY_SUPABASE_URL;
  const key = process.env.CLARIFY_SUPABASE_ANON_KEY;
  const configured = !!(url && key);

  if (body.ping) return json(200, { success: true, service: "zts-pipeline", configured, missing: configured ? undefined : "CLARIFY_SUPABASE_URL / CLARIFY_SUPABASE_ANON_KEY" });
  if (!configured) return json(500, { error: "Pentagon (Clarify) Supabase env vars not set" });

  try {
    // Accept-Profile selects the `zts` schema on the shared project.
    const res = await fetch(`${url}/rest/v1/creators?select=stage,subscriber_count`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "zts" },
    });
    if (!res.ok) throw new Error(`creators query failed (${res.status}) — check the zts schema is exposed and the "creators" table has stage/subscriber_count columns`);
    const rows = await res.json();

    const counts = { prospected: 0, sent: 0, replied: 0, collab: 0 };
    let weightedReach = 0;
    for (const row of (Array.isArray(rows) ? rows : [])) {
      counts[bucketOf(row.stage)]++;
      weightedReach += Number(row.subscriber_count) || 0;
    }

    return json(200, { success: true, ...counts, weightedReach: Math.round(weightedReach) });
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
