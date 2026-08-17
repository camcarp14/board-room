// Supabase persistence adapter for the UPSTREAM engine — server-side ONLY.
// Uses the service-role key, which bypasses RLS —
// every row is stamped with the verified caller's user_id so client RLS reads work.

// ─── the deadline every other outbound fetch in this repo already had ────────
// Every fetch under netlify/functions carries AbortSignal.timeout — that was
// done deliberately, in one pass, for a reason worth restating: a fetch with no
// signal has no ceiling, and a wedged connection does not fail, it simply never
// answers. That pass walked the .js files in the functions directory, and this
// is not one of them; it is a LIBRARY under netlify/lib, so it was never
// visited, and it is the file through which every Supabase read and write the
// Upstream engine makes actually leaves the machine.
//
// (Written without a glob on purpose. scripts/spend-smoke.mjs strips block
// comments before it reads this file, and a bare star-slash inside a line
// comment opens one as far as that regex is concerned — the first draft of this
// note silently swallowed the usage_log write below and failed the suite.)
//
// What that cost. upstream-run-background is a background function, so there is
// no synchronous 26s cap to cut a hung call short — a stalled REST write would
// hold the run open against the platform's own much longer ceiling, and the run's
// rows (the dive, the synthesis, the verdict) are written through this same
// helper, so the work would be finished and unrecorded. verifyUser is worse in a
// smaller way: it is the caller-identity gate, the first thing the handler does,
// so a stall there wedges the function before it has decided who is asking.
//
// The two numbers match what the equivalent calls in netlify/functions use —
// 15s for the identity check (audit.js, calendar-events.js) and 30s for a REST
// round trip (clarify-pipeline.js, auto-fix.js) — because they are the same calls
// to the same host, and inventing new ones here would make this file the odd one
// out a second time.
const IDENTITY_TIMEOUT_MS = 15_000;
const REST_TIMEOUT_MS = 30_000;

function cfg() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const err = new Error('UPSTREAM_ENV_MISSING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    err.code = 'UPSTREAM_ENV_MISSING';
    throw err;
  }
  return { url: SUPABASE_URL.replace(/\/$/, ''), key: SUPABASE_SERVICE_ROLE_KEY };
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const c = cfg();
  const res = await fetch(`${c.url}/rest/v1/${path}`, {
    method,
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    headers: {
      apikey: c.key,
      Authorization: `Bearer ${c.key}`,
      'Content-Type': 'application/json',
      // Board Room's tables live in the `boardroom` schema on the shared
      // Pentagon project. Accept-Profile selects it for reads, Content-Profile
      // for writes (each is ignored by the other verb — safe to send both).
      'Accept-Profile': 'boardroom',
      'Content-Profile': 'boardroom',
      Prefer: prefer || (method === 'GET' ? undefined : 'return=minimal'),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`supabase ${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 200)}`);
  }
  if (method === 'GET' || prefer === 'return=representation') return res.json();
  return null;
}

export async function verifyUser(accessToken) {
  const c = cfg();
  const res = await fetch(`${c.url}/auth/v1/user`, {
    signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    headers: { apikey: c.key, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user?.id || null;
}

export function makeStore(userId) {
  return {
    userId,
    async createRun({ id, surface, domain }) {
      await rest('upstream_runs', {
        method: 'POST',
        body: { id, user_id: userId, surface, domain: domain || null, status: 'running' },
      });
    },
    async saveArtifact(runId, artifact) {
      await rest(`upstream_runs?id=eq.${runId}`, {
        method: 'PATCH',
        body: { artifact, domain: artifact.domain || null },
      });
    },
    async finishRun(runId, { status, verdict, error, finishedAt, durationMs, artifact }) {
      await rest(`upstream_runs?id=eq.${runId}`, {
        method: 'PATCH',
        body: {
          status, verdict: verdict || null, error: error || null,
          finished_at: finishedAt, duration_ms: durationMs,
          artifact, domain: artifact.domain || null,
        },
      });
    },
    async addEvent(runId, event) {
      await rest('upstream_run_events', {
        method: 'POST',
        body: { run_id: runId, user_id: userId, type: event.type, payload: event },
      });
    },
    async recentSubjects(limit = 12) {
      const rows = await rest(`upstream_runs?user_id=eq.${userId}&surface=eq.nostradamus&domain=not.is.null&select=domain&order=started_at.desc&limit=40`);
      return [...new Set(rows.map((r) => r.domain))].slice(0, limit);
    },
    async insertPrediction(runId, subject, p) {
      await rest('upstream_predictions', {
        method: 'POST',
        body: {
          id: p.id, run_id: runId, user_id: userId, subject,
          kind: p.kind, statement: p.statement,
          resolution_date: p.resolutionDate, resolution_criterion: p.resolutionCriterion,
          confidence: p.confidence, causal_chain: p.causalChain, tell: p.tell,
          consensus_counterpart: p.consensusCounterpart,
          delta: p.kind === 'consensus_affirmed' ? (p.delta || 'none — consensus affirmed') : p.delta,
          why_consensus_misses: p.whyConsensusMisses,
        },
      });
    },
    async getPrediction(id) {
      const rows = await rest(`upstream_predictions?id=eq.${id}&user_id=eq.${userId}&select=*`);
      return rows[0] || null;
    },
    async insertTellCheck(predictionId, { signal, summary, evidence }) {
      await rest('upstream_tell_checks', {
        method: 'POST',
        body: { prediction_id: predictionId, user_id: userId, signal, summary, evidence },
      });
    },
    // Spend shows up on the Systems page next to every other Anthropic call.
    async logUsage({ fn, inTokens, outTokens, costUsd, ms, ok, detail }) {
      try {
        await rest('usage_log', {
          method: 'POST',
          body: {
            user_id: userId, fn: fn || 'upstream', kind: 'anthropic', model: 'pipeline',
            in_tokens: Math.round(inTokens || 0), out_tokens: Math.round(outTokens || 0),
            cost_usd: costUsd || 0, ms: Math.round(ms || 0), ok: ok !== false,
            detail: (detail || '').slice(0, 500),
          },
        });
      } catch { /* usage logging is best-effort, never fails a run */ }
    },
  };
}
