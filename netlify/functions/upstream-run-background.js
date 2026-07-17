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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
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
