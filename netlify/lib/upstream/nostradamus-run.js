// NOSTRADAMUS — Supabase-backed port. Picks its own subject, maps the consensus future
// with citations, ships only dated/resolvable predictions measurably outside it
// (engine-side distance judge), persists them to the ledger for scoring over time.
import {
  MODELS, makeLedger, ledgerTotal, structured, searchCall, jsonCall,
  parseJsonLoose, repairJson, normalizeUrl, LoudError,
} from './llm.js';
import { MECHANISM_TYPES, NO_EDGE_TYPE, validatePrediction } from './rigor.js';
import { overlap } from './exclusion.js';

export const DEADLINE_MS = 480000;
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

const SUBJECT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subject', 'whyItMatters', 'altitudeCheck'],
  properties: {
    subject: { type: 'string' },
    whyItMatters: { type: 'string' },
    altitudeCheck: { type: 'string', description: 'why this clears the civilizational bar' },
  },
};

const CF_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['claim', 'url', 'horizon'],
        properties: { claim: { type: 'string' }, url: { type: 'string' }, horizon: { type: 'string' } },
      },
    },
  },
};

const PRED_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['predictions'],
  properties: {
    predictions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'statement', 'resolutionDate', 'resolutionCriterion', 'confidence', 'causalChain', 'tell', 'consensusCounterpart', 'delta', 'whyConsensusMisses'],
        properties: {
          kind: { type: 'string', enum: ['bold', 'consensus_affirmed'] },
          statement: { type: 'string' },
          resolutionDate: { type: 'string', description: 'YYYY-MM-DD, 3 months to 20 years out' },
          resolutionCriterion: { type: 'string', description: 'objectively checkable' },
          confidence: { type: 'number' },
          causalChain: { type: 'array', items: { type: 'string' } },
          tell: {
            type: 'object', additionalProperties: false, required: ['observable', 'whereToLook'],
            properties: { observable: { type: 'string' }, whereToLook: { type: 'string' } },
          },
          consensusCounterpart: {
            type: 'object', additionalProperties: false, required: ['position', 'urls'],
            properties: { position: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } } },
          },
          delta: { type: 'string' },
          whyConsensusMisses: {
            type: 'object', additionalProperties: false, required: ['type', 'who', 'why'],
            properties: {
              type: { type: 'string', enum: [...MECHANISM_TYPES, NO_EDGE_TYPE] },
              who: { type: 'string' }, why: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

const SUBJECT_SYSTEM = `You pick ONE subject for a civilizational-altitude forecast.

The register: self-assembling orbital infrastructure; compute leaving the atmosphere; what breaks in the year after AI passes an economic tipping point; where US health goes as its incentive structure inverts. That altitude — not next-quarter takes, not single-company stock calls, not product reviews.

The bar: the subject concerns a system touching on the order of 100 million people or more, or load-bearing global infrastructure (energy, compute, orbit, health systems, food, water, finance rails, semiconductors, shipping), on a 2-20 year horizon. It must have a mappable consensus future (mainstream forecasts, agency outlooks, analyst roadmaps that can be found and cited) and plausible near-term tells (observables that would move within 1-3 years).

Pick something specific enough to predict about — "the future of technology" is not a subject; "who finances the grid buildout when datacenter demand breaks utility planning models" is.`;

const PRED_SYSTEM = `You make dated, bold predictions at civilizational altitude. You receive a subject and the MAPPED CONSENSUS FUTURE — what mainstream forecasts actually say, each claim carrying its source URL.

Bold is a distance measure, not a tone. A prediction ships only if it is measurably OUTSIDE the mapped consensus: a different direction, a timing shift big enough to change decisions, or a mechanism the consensus rejects. Restating consensus with dramatic language is a hard fail. So is undated boldness — a prediction that cannot resolve is astrology.

Every prediction carries:
- statement: specific and dated. A stranger in the resolution year must be able to say true/false.
- resolutionDate (YYYY-MM-DD, 3 months to 20 years out) and resolutionCriterion: exactly what evidence resolves it, from a checkable source.
- confidence 0.05-0.95, calibrated like a bettor. Genuinely bold claims deserve LOW numbers — 0.15 on a wild claim that resolves true is worth more than 0.9 on a hedge. Never use high confidence to perform conviction.
- causalChain: what has to become true first, in order. Each step checkable on its own.
- tell: the EARLIEST observable that would show the chain is live, and exactly where to look — a filing database, a procurement record, a price series, a permits office, a jobs board. Something a person could go check next month.
- consensusCounterpart: the consensus position this deviates from, citing URL(s) copied exactly from the provided consensus claims.
- delta: direction + magnitude/timing of the deviation from that counterpart.
- whyConsensusMisses: the typed error mechanism — why smart forecasters get this wrong. "They haven't noticed" is not a mechanism.

The boring verdict holds here too: if the consensus future on this subject is simply correct, ship kind=consensus_affirmed entries — the consensus forecast, dated, with criterion, confidence and tell — instead of manufacturing deviation. Never pad: ship 1 excellent prediction over 3 mediocre ones. At most 3.`;

// Engine-side distance gate: a separate judge call decides whether a bold prediction is
// measurably outside the mapped consensus. Fails closed — judge errors reject the prediction.
async function distanceGate(pred, cfClaims, ledger) {
  if (pred.kind === 'consensus_affirmed') return { pass: true, reasoning: 'affirmation — no distance required' };
  try {
    const out = await jsonCall({
      model: MODELS.sonnet, effort: 'low', maxTokens: 3000, timeoutMs: 90000, ledger,
      system: 'You judge whether a prediction is measurably OUTSIDE a mapped consensus, or just a hedge/restatement of it. Materially outside = different direction, or timing shifted enough to change decisions, or a mechanism consensus rejects. Restating consensus with higher drama is NOT outside it.',
      user: `Mapped consensus:\n${cfClaims.map((c, i) => `${i + 1}. ${c.claim}`).join('\n')}\n\nPrediction: "${pred.statement}"\nClaimed delta: "${pred.delta}"\n\nIs the prediction materially outside the mapped consensus?`,
      schema: {
        type: 'object', additionalProperties: false, required: ['materially_outside', 'reasoning'],
        properties: { materially_outside: { type: 'boolean' }, reasoning: { type: 'string' } },
      },
    });
    return { pass: out.materially_outside === true, reasoning: out.reasoning };
  } catch (e) {
    return { pass: false, reasoning: `distance judge failed (${e.message}) — fails closed` };
  }
}

export async function runNostradamus({ runId, store }) {
  const startedAt = nowIso();
  const t0 = Date.now();
  const ledger = makeLedger();
  const artifact = {
    domain: null, startedAt, finishedAt: null, durationMs: null,
    budget: { deadlineMs: DEADLINE_MS, breached: false },
    verdict: null, failure: null, stages: {}, usageTotal: null,
  };

  const recent = await store.recentSubjects(12).catch(() => []);
  await store.createRun({ id: runId, surface: 'nostradamus', domain: null });
  const save = () => store.saveArtifact(runId, artifact).catch(() => {});
  const emit = (ev) => { store.addEvent(runId, { ...ev, ts: nowIso(), elapsedMs: Date.now() - t0 }).catch(() => {}); };
  const checkBudget = (stage) => {
    if (Date.now() - t0 > DEADLINE_MS) { artifact.budget.breached = true; throw new LoudError(`time budget exceeded before ${stage}`, 'TIME_BUDGET'); }
  };
  let currentStage = 'subject';
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
      fn: 'nostradamus',
      inTokens: artifact.usageTotal.inputTokens, outTokens: artifact.usageTotal.outputTokens,
      costUsd: artifact.usageTotal.estCostUsd, ms: artifact.durationMs,
      ok: status === 'done', detail: `${artifact.verdict || status}: ${artifact.domain || '(no subject)'}`,
    });
  };

  try {
    emit({ type: 'stage', stage: 'subject', status: 'start' });
    const subjStart = nowIso();
    // Subject pick with deterministic repeat guard: exact/lowercase or heavy-overlap match
    // against recent subjects rejects; one retry, then fail loudly.
    let subjR = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await structured({
        model: MODELS.fable, effort: 'medium', maxTokens: 6000, timeoutMs: 150000, ledger,
        system: SUBJECT_SYSTEM,
        user: `Today: ${startedAt.slice(0, 10)}.\nRecently covered subjects to AVOID (repeats are rejected):\n${recent.length ? recent.map((s) => `- ${s}`).join('\n') : '(none yet)'}${attempt ? '\n\nYour previous pick repeated a recent subject. Pick something clearly different.' : ''}\n\nPick the subject.`,
        schema: SUBJECT_SCHEMA,
      });
      const subj = String(r.data.subject || '').trim();
      const repeats = recent.some((prev) => {
        if (subj.toLowerCase() === String(prev).toLowerCase()) return true;
        const m = overlap(subj, prev, '');
        return m.jaccard >= 0.6;
      });
      if (!repeats && subj) { subjR = r; break; }
    }
    if (!subjR) throw new LoudError('subject picker repeated recent subjects twice — nothing ships', 'SUBJECT_REPEAT');
    artifact.domain = subjR.data.subject;
    artifact.stages.subject = {
      startedAt: subjStart, ...subjR.data, avoidedSubjects: recent,
      servedBy: subjR.meta.servedBy, fallbackUsed: subjR.meta.fallbackUsed,
      durationMs: Date.now() - new Date(subjStart).getTime(),
    };
    await save();
    emit({ type: 'stage', stage: 'subject', status: 'done', summary: { subject: artifact.domain } });

    currentStage = 'consensusFuture';
    checkBudget(currentStage);
    emit({ type: 'stage', stage: 'consensusFuture', status: 'start' });
    const cfStart = nowIso();
    const cf = await searchCall({
      model: MODELS.sonnet, maxUses: 6, maxTokens: 12000, effort: 'medium', timeoutMs: 300000, ledger,
      system: `You map the CONSENSUS FUTURE for a subject: what mainstream forecasts, agency outlooks, analyst roadmaps, and industry projections actually say will happen. Search the live web. Report 5-10 consensus claims, each with the URL of the source making it and its horizon (e.g. "by 2030"). Be representative of the mainstream, not original. End with a single JSON object and nothing after it: {"claims":[{"claim":"...","url":"...","horizon":"..."}]}`,
      user: `Subject: ${artifact.domain}\n\nMap the consensus future.`,
    });
    let cfParsed = parseJsonLoose(cf.lastText) || parseJsonLoose(cf.text);
    if (!cfParsed || !Array.isArray(cfParsed.claims)) cfParsed = await repairJson(cf.lastText || cf.text, CF_SCHEMA, ledger);
    const cfClaims = [];
    for (const c of cfParsed?.claims || []) {
      const orig = c.url ? cf.fetchedNormalized.get(normalizeUrl(c.url)) : null;
      if (orig && c.claim) cfClaims.push({ id: `cf${cfClaims.length + 1}`, claim: c.claim, urls: [orig], horizon: c.horizon || '' });
    }
    artifact.stages.consensusFuture = {
      startedAt: cfStart, claims: cfClaims, fetchedUrls: cf.fetchedUrls,
      searchDegraded: cfClaims.length < 3, searchCount: cf.searchCount,
      servedBy: cf.meta.servedBy, durationMs: Date.now() - new Date(cfStart).getTime(),
    };
    await save();
    if (cfClaims.length < 3) throw new LoudError(`consensus future unmappable — only ${cfClaims.length} cited claims found; distance cannot be measured, so nothing ships`, 'CONSENSUS_FUTURE_UNMAPPABLE');
    emit({ type: 'stage', stage: 'consensusFuture', status: 'done', summary: { claims: cfClaims.length } });

    currentStage = 'predictions';
    checkBudget(currentStage);
    emit({ type: 'stage', stage: 'predictions', status: 'start' });
    const pStart = nowIso();
    const cfText = cfClaims.map((c) => `[${c.id}] ${c.claim} (horizon: ${c.horizon}) — source: ${c.urls[0]}`).join('\n');
    const baseUser = `Today: ${startedAt.slice(0, 10)}.\nSubject: ${artifact.domain}\n\nMAPPED CONSENSUS FUTURE:\n${cfText}\n\nShip at most 3 predictions.`;

    let shipped = [];
    let rejected = [];
    let meta = null;
    let user = baseUser;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await structured({
        model: MODELS.fable, effort: 'high', maxTokens: 16000, timeoutMs: 240000, ledger,
        system: PRED_SYSTEM, user, schema: PRED_SCHEMA,
      });
      meta = r.meta;
      shipped = []; rejected = [];
      for (const raw of (r.data.predictions || []).slice(0, 3)) {
        const pred = { id: newId(), ...raw };
        pred.consensusCounterpart = pred.consensusCounterpart || {};
        pred.consensusCounterpart.urls = (pred.consensusCounterpart.urls || [])
          .map((u) => cf.fetchedNormalized.get(normalizeUrl(u))).filter(Boolean);
        const problems = validatePrediction(pred, { fetchedUrls: artifact.stages.consensusFuture.fetchedUrls, now: startedAt });
        if (problems.length) { rejected.push({ statement: pred.statement || '(no statement)', problems }); continue; }
        const dist = await distanceGate(pred, cfClaims, ledger);
        if (!dist.pass) { rejected.push({ statement: pred.statement, problems: [`not measurably outside consensus: ${dist.reasoning}`] }); continue; }
        pred.distanceJudge = dist.reasoning;
        shipped.push(pred);
      }
      if (shipped.length > 0 || attempt === 1) break;
      user = `${baseUser}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED. Problems:\n${rejected.map((x) => `- "${String(x.statement).slice(0, 60)}": ${x.problems.join('; ')}`).join('\n')}\nFix every problem. Copy counterpart URLs exactly from the consensus claims above.`;
    }
    artifact.stages.predictions = {
      startedAt: pStart, shipped, rejected,
      servedBy: meta.servedBy, fallbackUsed: meta.fallbackUsed,
      durationMs: Date.now() - new Date(pStart).getTime(),
    };
    await save();
    if (shipped.length === 0) throw new LoudError(`no prediction cleared the ship gates (${rejected.length} rejected) — nothing ships`, 'NOTHING_SHIPPABLE');

    // Budget gate BEFORE the ledger writes: an over-budget consult must not ship.
    checkBudget('finalize');
    for (const p of shipped) await store.insertPrediction(runId, artifact.domain, p);
    artifact.verdict = shipped.every((p) => p.kind === 'consensus_affirmed') ? 'consensus_affirmed' : 'predictions_shipped';
    emit({ type: 'stage', stage: 'predictions', status: 'done', summary: { shipped: shipped.length, rejected: rejected.length, verdict: artifact.verdict } });
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

// ---------- tell checks ----------
const TELL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['signal', 'summary', 'evidence'],
  properties: {
    signal: { type: 'string', enum: ['none', 'early', 'strong', 'contra'] },
    summary: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['url', 'note'],
        properties: { url: { type: 'string' }, note: { type: 'string' } },
      },
    },
  },
};

export async function checkTell({ predictionId, store }) {
  const row = await store.getPrediction(predictionId);
  if (!row) throw new LoudError(`prediction ${predictionId} not found`, 'NOT_FOUND');
  const tell = typeof row.tell === 'string' ? JSON.parse(row.tell) : row.tell;
  const ledger = makeLedger();
  const t0 = Date.now();
  const res = await searchCall({
    model: MODELS.sonnet, maxUses: 4, maxTokens: 8000, effort: 'medium', timeoutMs: 240000, ledger,
    system: `You check whether a predicted "tell" (an early observable) has started moving. Search the live web for current evidence. Classify: none (no movement), early (first credible signs), strong (clearly underway), contra (evidence points the OTHER way). Cite only pages you fetched. End with one JSON object: {"signal":"none|early|strong|contra","summary":"...","evidence":[{"url":"...","note":"..."}]}`,
    user: `Prediction: ${row.statement}\nTell to check: ${tell.observable}\nWhere to look: ${tell.whereToLook}\nToday: ${nowIso().slice(0, 10)}`,
  });
  let parsed = parseJsonLoose(res.lastText) || parseJsonLoose(res.text);
  if (!parsed) parsed = await repairJson(res.lastText || res.text, TELL_SCHEMA, ledger);
  if (!parsed || !['none', 'early', 'strong', 'contra'].includes(parsed.signal)) {
    throw new LoudError('tell check produced no classifiable signal', 'TELL_UNPARSEABLE');
  }
  const evidence = (parsed.evidence || [])
    .map((e) => ({ url: res.fetchedNormalized.get(normalizeUrl(e.url)) || null, note: e.note }))
    .filter((e) => e.url);
  await store.insertTellCheck(predictionId, { signal: parsed.signal, summary: parsed.summary || '', evidence });
  const totals = ledgerTotal(ledger);
  await store.logUsage({
    fn: 'upstream-tell', inTokens: totals.inputTokens, outTokens: totals.outputTokens,
    costUsd: totals.estCostUsd, ms: Date.now() - t0, ok: true,
    detail: `tell ${parsed.signal}: ${String(row.statement).slice(0, 80)}`,
  });
  return { predictionId, signal: parsed.signal };
}
