// UPSTREAM run orchestrator — Supabase-backed port of the Command Center engine.
// Consensus artifact FIRST, then candidates, the gauntlet, ≤3 dives, synthesis.
// Hard 8-minute budget (the background function itself caps at 15). Loud failures.
import { makeLedger, ledgerTotal, LoudError } from './llm.js';
import { buildConsensus } from './consensus.js';
import { generateCandidates } from './candidates.js';
import { runGauntlet } from './scoring.js';
import { deepDive } from './dive.js';
import { synthesizePov, synthesizeSpine } from './synthesis.js';

export const DEADLINE_MS = 480000;
const nowIso = () => new Date().toISOString();

export async function runUpstream({ runId, domain, store }) {
  const startedAt = nowIso();
  const t0 = Date.now();
  const ledger = makeLedger();
  const artifact = {
    domain, startedAt, finishedAt: null, durationMs: null,
    budget: { deadlineMs: DEADLINE_MS, breached: false },
    verdict: null, failure: null, stages: {}, usageTotal: null,
  };

  await store.createRun({ id: runId, surface: 'upstream', domain });
  const save = () => store.saveArtifact(runId, artifact).catch(() => {});
  const emit = (ev) => {
    store.addEvent(runId, { ...ev, ts: nowIso(), elapsedMs: Date.now() - t0 }).catch(() => {});
  };
  const checkBudget = (stage) => {
    if (Date.now() - t0 > DEADLINE_MS) {
      artifact.budget.breached = true;
      throw new LoudError(`time budget (${DEADLINE_MS / 1000}s) exceeded before ${stage}`, 'TIME_BUDGET');
    }
  };
  let currentStage = 'consensus';
  const finalize = async (status) => {
    artifact.finishedAt = nowIso();
    artifact.durationMs = Date.now() - t0;
    artifact.usageTotal = ledgerTotal(ledger);
    await store.finishRun(runId, {
      status, verdict: artifact.verdict,
      error: artifact.failure ? artifact.failure.reason : null,
      finishedAt: artifact.finishedAt, durationMs: artifact.durationMs, artifact,
    });
    await store.logUsage({
      fn: 'upstream',
      inTokens: artifact.usageTotal.inputTokens, outTokens: artifact.usageTotal.outputTokens,
      costUsd: artifact.usageTotal.estCostUsd, ms: artifact.durationMs,
      ok: status === 'done', detail: `${artifact.verdict || status}: ${domain}`,
    });
  };

  try {
    if (!domain || domain.length < 3 || domain.length > 300) {
      throw new LoudError('domain must be 3-300 chars', 'BAD_INPUT');
    }
    emit({ type: 'stage', stage: 'consensus', status: 'start' });
    artifact.stages.consensus = await buildConsensus({ domain, ledger, onEvent: emit });
    await save();
    emit({ type: 'stage', stage: 'consensus', status: 'done', summary: { questions: artifact.stages.consensus.questions.length, searchDegraded: artifact.stages.consensus.searchDegraded } });

    currentStage = 'candidates';
    checkBudget(currentStage);
    emit({ type: 'stage', stage: 'candidates', status: 'start' });
    artifact.stages.candidates = await generateCandidates({ domain, consensus: artifact.stages.consensus, ledger });
    await save();
    emit({ type: 'stage', stage: 'candidates', status: 'done', summary: { count: artifact.stages.candidates.items.length, fallbackUsed: artifact.stages.candidates.fallbackUsed } });

    currentStage = 'gauntlet';
    checkBudget(currentStage);
    emit({ type: 'stage', stage: 'gauntlet', status: 'start' });
    artifact.stages.gauntlet = await runGauntlet({ domain, consensus: artifact.stages.consensus, candidates: artifact.stages.candidates, ledger });
    await save();
    emit({ type: 'stage', stage: 'gauntlet', status: 'done', summary: { survivors: artifact.stages.gauntlet.survivors.length, kills: artifact.stages.gauntlet.kills.length } });

    const items = artifact.stages.candidates.items;
    const survivors = artifact.stages.gauntlet.survivors.map((id) => items.find((x) => x.id === id)).filter(Boolean);

    if (survivors.length === 0) {
      checkBudget('finalize'); // the boring-verdict path is a 'done' path — same budget gate
      artifact.verdict = 'consensus_holds';
      emit({ type: 'verdict', verdict: 'consensus_holds', message: 'No candidate cleared the bar — on this topic the consensus questions are the right questions.' });
      await finalize('done');
      emit({ type: 'done', verdict: artifact.verdict });
      return { runId, artifact };
    }

    currentStage = 'dives';
    checkBudget(currentStage);
    emit({ type: 'stage', stage: 'dives', status: 'start', summary: { questions: survivors.map((s) => s.text) } });
    const diveBudget = Math.min(300000, Math.max(45000, DEADLINE_MS - (Date.now() - t0) - 120000));
    artifact.stages.dives = await Promise.all(
      survivors.map((q) => deepDive({ question: q.text, questionId: q.id, domain, ledger, timeoutMs: diveBudget })
        .then((d) => { emit({ type: 'dive', questionId: q.id, status: d.status, claims: d.claims?.length || 0, rejected: d.rejectedClaims?.length || 0 }); return d; })),
    );
    await save();
    const okDives = artifact.stages.dives.filter((d) => d.status === 'ok');
    for (const d of artifact.stages.dives) {
      if (d.status !== 'ok') emit({ type: 'warn', stage: 'dives', message: `dive ${d.questionId} failed: ${d.failReason}` });
    }
    if (okDives.length === 0) throw new LoudError('all dives failed — no live-cited evidence base to reason from', 'DIVES_FAILED');

    currentStage = 'synthesis';
    checkBudget(currentStage);
    emit({ type: 'stage', stage: 'synthesis', status: 'start' });
    const synthStartedAt = nowIso();
    const synthBudget = Math.min(200000, Math.max(45000, DEADLINE_MS - (Date.now() - t0) - 30000));
    const povResults = await Promise.all(okDives.map((d) => {
      const q = survivors.find((s) => s.id === d.questionId);
      return synthesizePov({ domain, question: q, dive: d, consensus: artifact.stages.consensus, ledger, timeoutMs: synthBudget });
    }));
    const povs = povResults.map((r) => r.pov);
    const spine = await synthesizeSpine({ domain, povs, ledger, timeoutMs: 90000 });
    const servedSet = new Set([...povResults.map((r) => r.meta.servedBy), spine.meta.servedBy]);
    artifact.stages.synthesis = {
      startedAt: synthStartedAt,
      povs,
      runSpine: spine.runSpine,
      servedBy: [...servedSet].join(' + '),
      fallbackUsed: povResults.some((r) => r.meta.fallbackUsed) || spine.meta.fallbackUsed,
      durationMs: Date.now() - new Date(synthStartedAt).getTime(),
    };
    checkBudget('finalize');
    artifact.verdict = 'povs_shipped';
    await save();
    emit({ type: 'stage', stage: 'synthesis', status: 'done', summary: { povs: povs.length, verdicts: povs.map((p) => p.verdict) } });

    await finalize('done');
    emit({ type: 'done', verdict: artifact.verdict });
    return { runId, artifact };
  } catch (e) {
    artifact.verdict = 'failed';
    artifact.failure = { stage: currentStage, reason: e.message, code: e.code || 'UNEXPECTED' };
    await finalize('failed');
    emit({ type: 'error', stage: currentStage, message: e.message, code: e.code });
    return { runId, artifact };
  }
}
