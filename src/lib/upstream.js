// Client API for the UPSTREAM engine. Runs execute in the background function
// (upstream-run-background); the client generates the runId up front, then follows
// progress by polling the RLS-scoped tables.
import { supabase } from "./supabase.js";

async function accessToken() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

export async function startJob(kind, extra = {}) {
  const token = await accessToken();
  if (!token) throw new Error("Not signed in");
  const runId = crypto.randomUUID();
  const res = await fetch("/.netlify/functions/upstream-run-background", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, runId, accessToken: token, ...extra }),
  });
  // Background functions ACK with 202 before the work runs; anything else is a launch failure.
  if (res.status !== 202 && !res.ok) {
    let msg = `engine start failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return runId;
}

export async function fetchRuns(surface, limit = 40) {
  const { data, error } = await supabase.from("upstream_runs")
    .select("id,surface,domain,status,verdict,error,started_at,finished_at,duration_ms")
    .eq("surface", surface).order("started_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function fetchRun(id) {
  const { data, error } = await supabase.from("upstream_runs").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function fetchPredictions() {
  const [{ data: preds, error }, { data: checks }] = await Promise.all([
    supabase.from("upstream_predictions").select("*").order("created_at", { ascending: false }),
    supabase.from("upstream_tell_checks").select("*").order("id"),
  ]);
  if (error) throw new Error(error.message);
  const byPred = {};
  (checks || []).forEach((c) => { (byPred[c.prediction_id] ||= []).push(c); });
  return (preds || []).map((p) => ({ ...p, tellChecks: byPred[p.id] || [] }));
}

// Deletes cascade in the DB: a run takes its events with it, a prediction its tell checks.
export async function deleteRun(id) {
  const { error } = await supabase.from("upstream_runs").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deletePrediction(id) {
  const { error } = await supabase.from("upstream_predictions").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function resolvePrediction(id, status, note) {
  const { error } = await supabase.from("upstream_predictions")
    .update({ status, resolved_at: status === "open" ? null : new Date().toISOString(), resolution_note: note || null })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

// Brier + confidence buckets, computed client-side from the ledger rows.
export function calibration(preds) {
  const rows = preds.filter((p) => !String(p.subject || "").startsWith("(demo)"));
  const buckets = [
    { label: "0.05-0.2", lo: 0.05, hi: 0.2 }, { label: "0.2-0.4", lo: 0.2, hi: 0.4 },
    { label: "0.4-0.6", lo: 0.4, hi: 0.6 }, { label: "0.6-0.8", lo: 0.6, hi: 0.8 },
    { label: "0.8-0.95", lo: 0.8, hi: 0.96 },
  ].map((b) => ({ ...b, open: 0, resolved: 0, hits: 0 }));
  let brierSum = 0, brierN = 0;
  for (const r of rows) {
    const b = buckets.find((x) => r.confidence >= x.lo && r.confidence < x.hi) || buckets[buckets.length - 1];
    if (r.status === "open") { b.open++; continue; }
    if (r.status === "void") continue;
    b.resolved++;
    const outcome = r.status === "correct" ? 1 : 0;
    if (outcome) b.hits++;
    brierSum += (r.confidence - outcome) ** 2;
    brierN++;
  }
  return {
    total: rows.length,
    open: rows.filter((r) => r.status === "open").length,
    resolved: brierN,
    brier: brierN ? Number((brierSum / brierN).toFixed(4)) : null,
    buckets,
  };
}

export const fmtDuration = (ms) => (ms == null ? "—" : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
export const daysUntil = (d) => Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
export const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } };
