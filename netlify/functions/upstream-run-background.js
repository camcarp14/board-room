// UPSTREAM engine runner ("-background" = Netlify allows up to 15 minutes; the engine's
// own hard deadline is 8). The client generates the runId, POSTs here with its Supabase
// access token, gets a 202 immediately, and follows progress by polling upstream_runs /
// upstream_run_events (RLS-scoped). Writes happen with the service-role key, stamped with
// the VERIFIED caller's user_id — no token, no run.
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (same set the other
// background workers already use).
import { makeStore, verifyUser } from '../lib/upstream/store.js';
import { runUpstream } from '../lib/upstream/upstream-run.js';
import { runNostradamus, checkTell } from '../lib/upstream/nostradamus-run.js';

// ─── PAUSED ──────────────────────────────────────────────────────────────────
// Both engines are off. Flip PAUSED to false here AND in src/lib/upstream.js to
// bring them back; scripts/upstream-paused-smoke.mjs fails the build if the two
// ever disagree, because a half-reconnect is the dangerous state — a live UI in
// front of a dead gate looks broken, and a live gate behind a dead UI spends
// money nobody meant to spend.
//
// WHY THE GATE IS HERE and not only in the client. This is the only door to the
// engines, and it is a plain HTTP endpoint: a tab left open from before the
// pause, a replayed request, or a curl with a valid token all reach it directly.
// A disabled button stops none of those. Refusing here is what makes "paused"
// mean paused.
//
// It refuses BEFORE reading the body or verifying the caller — nothing needs to
// be known about a request that is going to be declined, and a run that never
// starts is a run that cannot bill. Every kind is covered, tell_check included:
// it is Nostradamus's follow-up pass and calls sonnet with web search, so
// leaving it open would leave a paused tool spending.
const PAUSED = true;
const PAUSED_ERROR = 'UPSTREAM and Nostradamus are paused and will not run. Reconnect them before use.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  // 503, not 403: the engines are unavailable on purpose and will work again.
  // `paused: true` lets the client tell this apart from a real launch failure.
  if (PAUSED) return json(503, { error: PAUSED_ERROR, paused: true });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad json' }); }

  const userId = body?.accessToken ? await verifyUser(body.accessToken) : null;
  if (!userId) return json(401, { error: 'unauthorized' });

  const store = makeStore(userId);
  try {
    if (body.kind === 'upstream') {
      if (!UUID_RE.test(String(body.runId || ''))) return json(400, { error: 'runId must be a uuid' });
      await runUpstream({ runId: body.runId, domain: String(body.domain || '').trim(), store });
    } else if (body.kind === 'nostradamus') {
      if (!UUID_RE.test(String(body.runId || ''))) return json(400, { error: 'runId must be a uuid' });
      await runNostradamus({ runId: body.runId, store });
    } else if (body.kind === 'tell_check') {
      await checkTell({ predictionId: String(body.predictionId || ''), store });
    } else {
      return json(400, { error: 'kind must be upstream | nostradamus | tell_check' });
    }
  } catch (e) {
    // Orchestrators persist their own loud failures; this catch covers pre-run errors
    // (e.g. missing env) so the function never crashes silently.
    console.error('[upstream-run]', body?.kind, e);
  }
  return json(200, { ok: true });
};
