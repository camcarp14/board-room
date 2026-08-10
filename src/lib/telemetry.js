import { supabase } from "./supabase.js";

// Durable, cross-device usage log (Supabase) — separate from the
// localStorage-only `obs` tracker below, which resets per-browser. Every
// Anthropic call and every Netlify function hit gets a row here, powering
// the Usage section in IT Department. Fire-and-forget; never blocks or
// throws into the caller.
//
// The catch below used to be decorative, and for the same reason the four writes
// in data/db.js were: supabase-js RESOLVES with { data, error } on a PostgREST
// rejection or an RLS denial rather than rejecting, so an insert this table
// refused never reached it. That is quieter than it sounds — usage_log is the
// only record of what the models cost, so a refused write means Systems → Usage
// reports a smaller bill than the one Anthropic will send, with nothing anywhere
// saying a row went missing. Reading .error and console.warn-ing is the whole
// fix: this stays fire-and-forget by design (a metering write must never break
// the call it is metering), but it is no longer SILENT, and a run of these in
// the console is the thread to pull when the numbers look low.
export async function logUsage(row) {
  if (!supabase) return;
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    if (!uid) return;
    const { error } = await supabase.from("usage_log").insert({ user_id: uid, ...row });
    if (error) throw error;
  } catch (e) {
    // Named, not swallowed. Still never rethrown — see above.
    console.warn(`[telemetry] usage_log write failed for fn=${row?.fn ?? "?"}: ${e?.message || e}`);
  }
}
