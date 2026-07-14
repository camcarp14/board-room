import { logUsage } from "./telemetry.js";

// ─── Netlify function helpers (graceful fallback when a fn isn't built yet) ──
export async function callFn(name, payload, extraHeaders) {
  const t0 = Date.now();
  let ok = false, detail;
  try {
    const res = await fetch(`/.netlify/functions/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(extraHeaders || {}) }, body: JSON.stringify(payload || {}),
    });
    ok = res.ok;
    if (!ok) { detail = `HTTP ${res.status}`; throw new Error(detail); }
    return await res.json();
  } catch {
    if (!detail) detail = "network error";
    return null;
  } finally {
    logUsage({ fn: name, kind: "call", ms: Date.now() - t0, ok, detail });
  }
}
// Like callFn but keeps HTTP status + error body so the UI can say WHY a card isn't live.
export async function callFnFull(name, payload) {
  const t0 = Date.now();
  let ok = false, status = 0, data = null, detail;
  try {
    const res = await fetch(`/.netlify/functions/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}),
    });
    status = res.status; ok = res.ok;
    data = await res.json().catch(() => null);
    if (!ok) detail = data?.error || `HTTP ${status}`;
    return { ok, status, data };
  } catch {
    detail = "network error";
    return { ok: false, status: 0, data: null };
  } finally {
    logUsage({ fn: name, kind: "call", ms: Date.now() - t0, ok, detail });
  }
}
