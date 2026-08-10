// ─── stock-cron-background — the hourly trigger, and nothing else ────────────
//
// This file exists because of one Netlify constraint: a function that carries a
// `schedule` cannot be invoked over HTTP in production. The engine used to
// carry the schedule itself, which meant the ONLY thing that could ever start a
// pass was the scheduler — so a missed fire left the tab empty until the next
// hour, on the surface whose entire job is having tomorrow's plan ready before
// the bell.
//
// Splitting them costs thirty lines and buys two things: the tab gets a Run now
// button, and the schedule becomes one of two callers rather than the only one.
//
// It deliberately does NOT require the engine. The house rule is self-contained
// functions (see the scripts/functions-smoke.mjs header for the outage that
// paid for it), and a shim that imports the brain would be a second copy of it
// in the bundle. An HTTP POST to a sibling function is the cheap, honest hop.
//
// Fire-and-forget by design: the target is a BACKGROUND function, so it answers
// 202 the moment it starts and keeps running for up to fifteen minutes. This
// shim is done as soon as the 202 lands and must not wait for the pass — a
// scheduled function that blocks for three minutes is a scheduled function that
// times out.

const json = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Netlify sets URL to the site's primary address on every deploy. DEPLOY_URL is
// the per-deploy alias and is the right fallback in a deploy preview; a
// hardcoded hostname would silently point production at a preview or vice versa.
const siteUrl = () =>
  process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";

exports.handler = async () => {
  const base = siteUrl();
  if (!base) {
    console.error("[stock-cron-background] no site URL in env — cannot reach the engine");
    return json(200, { success: false, service: "stock-cron-background", error: "no site URL" });
  }
  const target = `${base}/.netlify/functions/stock-settle-background`;
  // The engine sits on a public URL, and `{source:"cron"}` in the body proves
  // nothing — anyone can type it. This header is what actually distinguishes
  // the hourly pass from the internet, and it is the same INTERNAL_WORKER_SECRET
  // discord-board.js presents to board-work-background: one secret for every
  // function-to-function hop on this site, so there is one variable to set and
  // one to rotate. Unset is not fatal here — see the note on the engine's side.
  const workerSecret = process.env.INTERNAL_WORKER_SECRET;
  if (!workerSecret) console.warn("[stock-cron-background] INTERNAL_WORKER_SECRET is not set — the engine cannot tell this pass from an anonymous one");
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(workerSecret ? { "x-internal-worker-secret": workerSecret } : {}) },
      body: JSON.stringify({ source: "cron" }),
      // Generous relative to a 202, tight relative to the scheduler's patience.
      signal: AbortSignal.timeout(10000),
    });
    // 202 is the expected answer from a background function. Anything else is
    // worth a log line: a 404 here means the split is broken and the engine is
    // never running, which is exactly the silent failure this file exists to
    // make impossible.
    console.log(`[stock-cron-background] kicked stock-settle-background — HTTP ${res.status}`);
    return json(200, { success: res.status === 202 || res.ok, service: "stock-cron-background", status: res.status });
  } catch (e) {
    console.error("[stock-cron-background] could not reach the engine:", (e && e.message) || e);
    return json(200, { success: false, service: "stock-cron-background", error: String((e && e.message) || e) });
  }
};
