// Zero To Secure creator-outreach pipeline stats, pulled directly from the
// ZTS Creator Registry app's own Supabase project.
//
// Real schema, confirmed against an actual export (2026-07-05) — this
// replaces an earlier version that guessed at flat status/reach columns
// and got it wrong. The real table is `creators`, and everything lives in
// a JSONB `payload` column rather than flat columns:
//   payload.stage     text  — free-text funnel stage, e.g. "prospect",
//                             "vetted", "outreach sent", "in conversation",
//                             "negotiating", "active partner" (only
//                             "prospect" was confirmed against real data —
//                             the rest are inferred from an activity log
//                             on a single test row, so the stage→bucket
//                             mapping below uses loose keyword matching
//                             rather than exact string equality, to be
//                             more resilient to slug formatting I couldn't
//                             directly confirm)
//   payload.audience  text  — formatted follower count, e.g. "5K", "1.2M"
//                             — not a number, has to be parsed
//   payload.log       array — activity entries; a {"type":"reply"} entry
//                             is a more reliable "they replied" signal
//                             than any stage value
// PostgREST can't filter/aggregate JSONB text like this cleanly, so this
// fetches all rows and classifies them in code instead.
// Needs: ZTS_SUPABASE_URL, ZTS_SUPABASE_ANON_KEY (or a service role key if
// RLS blocks anon reads on this table).
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function parseAudience(raw) {
  if (!raw) return 0;
  const m = String(raw).trim().match(/^([\d.]+)\s*([KkMmBb]?)$/);
  if (!m) return Number(raw) || 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}
function bucketOf(payload) {
  const stage = String(payload.stage || "").toLowerCase();
  const replied = Array.isArray(payload.log) && payload.log.some(l => l.type === "reply");
  if (stage.includes("partner")) return "collab";
  if (replied || stage.includes("negotiat") || stage.includes("conversation")) return "replied";
  if (stage.includes("outreach") || stage.includes("sent")) return "sent";
  return "prospected"; // prospect, vetted, or anything else early-funnel
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const url = process.env.ZTS_SUPABASE_URL;
  const key = process.env.ZTS_SUPABASE_ANON_KEY;
  const configured = !!(url && key);

  if (body.ping) return json(200, { success: true, service: "zts-pipeline", configured, missing: configured ? undefined : "ZTS_SUPABASE_URL / ZTS_SUPABASE_ANON_KEY" });
  if (!configured) return json(500, { error: "ZTS Supabase env vars not set" });

  try {
    const res = await fetch(`${url}/rest/v1/creators?select=payload`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`creators query failed (${res.status}) — check the "creators" table still has a "payload" column`);
    const rows = await res.json();

    const counts = { prospected: 0, sent: 0, replied: 0, collab: 0 };
    let weightedReach = 0;
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const payload = row.payload || {};
      counts[bucketOf(payload)]++;
      weightedReach += parseAudience(payload.audience);
    }

    return json(200, { success: true, ...counts, weightedReach: Math.round(weightedReach) });
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
