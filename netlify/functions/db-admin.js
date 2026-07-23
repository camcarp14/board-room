// Maintenance against the shared brain via the service-role key — which never
// leaves this function. Arbitrary SQL is deliberately NOT supported; only the
// allowlisted commands below run. Extend the map when you need a new op.
// Needs: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const configured = !!(url && key);

  if (body.ping) return json(200, { success: true, service: "db-admin", configured, missing: configured ? undefined : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
  if (!configured) return json(500, { error: "Supabase service env vars not set" });

  // Require a valid session before running service-role commands (which include
  // DELETEs against the shared brain). Unauthenticated, this exposed row counts
  // and destructive maintenance to anyone who found the URL.
  {
    const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "sign in first" });
    const who = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!who.ok) return json(401, { error: "session expired — refresh and try again" });
  }

  const rest = (path, opts = {}) => fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Accept-Profile": "boardroom", "Content-Profile": "boardroom", Prefer: "count=exact", ...(opts.headers || {}) },
  });

  const cmd = String(body.command || "").trim().toLowerCase();

  try {
    // ── Allowlisted commands ──────────────────────────────────────────────
    if (cmd === "backup chat_messages") {
      const res = await rest("chat_messages?select=*", { method: "HEAD" });
      const count = res.headers.get("content-range")?.split("/")[1] || "?";
      return json(200, { success: true, message: `chat_messages verified — ${count} rows readable with service role. For a real backup, run a scheduled pg_dump or use Supabase's daily backups.` });
    }
    if (cmd === "vacuum seat_notes") {
      const res = await rest("seat_notes?select=*", { method: "HEAD" });
      const count = res.headers.get("content-range")?.split("/")[1] || "?";
      return json(200, { success: true, message: `seat_notes healthy — ${count} rows. (True VACUUM runs automatically via Postgres autovacuum on Supabase.)` });
    }
    if (cmd === "clear findings > 30d") {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const res = await rest(`auditor_findings?created_at=lt.${cutoff}`, { method: "DELETE" });
      const count = res.headers.get("content-range")?.split("/")[1] || "0";
      return json(200, { success: true, message: `deleted ${count} findings older than 30 days` });
    }
    if (cmd.startsWith("count ")) {
      const table = cmd.slice(6).replace(/[^a-z_]/g, "");
      const allowed = ["chat_messages", "seat_notes", "app_settings", "auditor_findings"];
      if (!allowed.includes(table)) return json(400, { error: `count only supports: ${allowed.join(", ")}` });
      const res = await rest(`${table}?select=*`, { method: "HEAD" });
      const count = res.headers.get("content-range")?.split("/")[1] || "?";
      return json(200, { success: true, message: `${table}: ${count} rows` });
    }

    return json(400, { error: `command not in allowlist. Supported: backup chat_messages · vacuum seat_notes · clear findings > 30d · count <table>` });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
