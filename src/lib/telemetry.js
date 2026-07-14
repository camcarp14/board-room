import { supabase } from "./supabase.js";

// Durable, cross-device usage log (Supabase) — separate from the
// localStorage-only `obs` tracker below, which resets per-browser. Every
// Anthropic call and every Netlify function hit gets a row here, powering
// the Usage section in IT Department. Fire-and-forget; never blocks or
// throws into the caller.
export async function logUsage(row) {
  if (!supabase) return;
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    if (!uid) return;
    await supabase.from("usage_log").insert({ user_id: uid, ...row });
  } catch { /* table may not exist yet, or offline — never break the caller */ }
}
