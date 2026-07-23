// Full data export for local backups — pulls every table that holds
// something you'd actually be upset to lose (notes, calendar, movies,
// chat history, saved recipes, settings) and returns it as one JSON file.
// Deliberately skips auditor_findings, mini_feed, and usage_log — those are
// operational logs, not data, and regenerate on their own.
//
// SECURITY: this uses the Supabase SERVICE ROLE key (not the anon key),
// which bypasses RLS entirely — necessary so a scheduled task with no
// logged-in session can still pull everything. That means this endpoint
// must never be callable by just anyone. It requires a shared secret
// (BACKUP_SECRET) that only you and your scheduled task know.
//
// Setup, one time:
//   1. Generate a random secret (anything long and unguessable works —
//      a password manager's generator is fine).
//   2. Netlify → Site configuration → Environment variables → add
//      BACKUP_SECRET with that value.
//   3. Supabase → Project Settings → API → copy the "service_role" key
//      (NOT the anon key) → add it to Netlify as SUPABASE_SERVICE_ROLE_KEY.
//   4. Use the same BACKUP_SECRET value in the Cowork scheduled task prompt.

const { createClient } = require("@supabase/supabase-js");

const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const TABLES = ["personal_events", "personal_birthdays", "personal_notes", "movies", "grocery_items", "saved_recipes", "chat_messages", "seat_notes", "app_settings"];

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const configured = !!(process.env.BACKUP_SECRET && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (body.ping) {
    const missing = [!process.env.BACKUP_SECRET && "BACKUP_SECRET", !process.env.SUPABASE_URL && "SUPABASE_URL", !process.env.SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean).join(" / ");
    return json(200, { success: true, service: "export-data", configured, missing: configured ? undefined : missing });
  }

  if (!process.env.BACKUP_SECRET || body.secret !== process.env.BACKUP_SECRET) {
    return json(401, { success: false, error: "Missing or incorrect secret." });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { success: false, error: "SUPABASE_SERVICE_ROLE_KEY isn't set in Netlify yet — see the comment at the top of this file." });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "boardroom" } });

  try {
    const results = await Promise.all(TABLES.map(async (table) => {
      const { data, error } = await supabase.from(table).select("*");
      if (error) return [table, { error: error.message }];
      return [table, data];
    }));
    const payload = { exportedAt: new Date().toISOString(), tables: Object.fromEntries(results) };
    return json(200, payload);
  } catch (e) {
    return json(500, { success: false, error: e.message });
  }
};
