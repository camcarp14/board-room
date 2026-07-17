// Stage 2 — the gauntlet. Deterministic consensus prefilter, then Fable scoring with
// mandatory nearest-consensus-neighbor + delta. Every candidate gets exactly one fate.
import { MODELS, structured, LoudError } from './llm.js';
import { consensusCheck, KILL_THRESHOLDS } from './exclusion.js';

export const GATES = { leverage: 7, novelty: 7, tractability: 5 };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'leverage', 'tractability', 'novelty', 'reasoning', 'nearestConsensus', 'semanticDup'],
        properties: {
          id: { type: 'string' },
          leverage: { type: 'integer' },
          tractability: { type: 'integer' },
          novelty: { type: 'integer' },
          reasoning: {
            type: 'object', additionalProperties: false, required: ['leverage', 'tractability', 'novelty'],
            properties: {
              leverage: { type: 'string' }, tractability: { type: 'string' }, novelty: { type: 'string' },
            },
          },
          nearestConsensus: {
            type: 'object', additionalProperties: false, required: ['text', 'delta'],
            properties: {
              text: { type: 'string', description: 'nearest consensus question, verbatim from the artifact' },
              delta: { type: 'string', description: 'what this candidate asks that the consensus question does not' },
            },
          },
          semanticDup: { type: 'boolean', description: 'true if a paraphrase or trivial narrowing of any consensus question' },
        },
      },
    },
  },
};

const SYSTEM = `You are the gauntlet. You receive a domain, the consensus artifact, and candidate questions. Score each candidate 0-10 on three axes, with one or two sentences of reasoning per axis:

- leverage: if this question were answered well, how much would real decisions change, for whom, and how much value swings? 9-10 = reorders a major allocation decision; 5 = interesting but decisions barely move; 0-2 = trivia.
- tractability: could a sharp analyst with a web connection move this meaningfully in an hour? Is there public evidence — data, filings, prices, dockets? 9-10 = directly checkable; 5 = partial proxies; 0-2 = unfalsifiable or needs private data.
- novelty: distance from the consensus artifact. 9-10 = absent from it at every causal level; 5 = adjacent or a narrowing; 0-2 = paraphrase.

For every candidate, name the single NEAREST consensus question (verbatim from the artifact) and state the delta: what the candidate asks that the consensus question does not. If the candidate is a paraphrase or trivial narrowing of ANY consensus question, set semanticDup=true — that kills it regardless of scores.

Score harshly; a 7 is earned. Manufactured contrarianism — a question that exists only to disagree — scores LOW on leverage, because no decision hangs on a pose. If nothing clears the bar, that is a valid, useful outcome. Do not inflate.`;

export async function runGauntlet({ domain, consensus, candidates, ledger, timeoutMs = 220000 }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const kills = [];
  const prefilter = [];

  // Deterministic prefilter: malformed kill, zero-content kill, token-overlap kill.
  // Every candidate gets exactly one recorded fate — nothing is silently dropped.
  const surviving = [];
  for (const cand of candidates.items) {
    if (!cand.text || cand.text.length < 15) {
      prefilter.push({ id: cand.id, killed: true, neighborText: null, jaccard: 0, containment: 0, shared: 0 });
      kills.push({ id: cand.id, phase: 'malformed', reason: `candidate under 15 chars ("${cand.text}") — generation artifact` });
      continue;
    }
    const m = consensusCheck(cand.text, consensus.questions, domain, KILL_THRESHOLDS);
    prefilter.push({ id: cand.id, killed: m.killed, zeroContent: m.zeroContent, neighborText: m.neighborText, jaccard: Number(m.jaccard.toFixed(3)), containment: Number(m.containment.toFixed(3)), shared: m.shared });
    if (m.killed && m.zeroContent) kills.push({ id: cand.id, phase: 'prefilter', reason: 'restates the domain itself — no content tokens beyond it, distance undemonstrable' });
    else if (m.killed) kills.push({ id: cand.id, phase: 'prefilter', reason: `consensus duplicate — token overlap with "${m.neighborText}" (j=${m.jaccard.toFixed(2)}, c=${m.containment.toFixed(2)})` });
    else surviving.push(cand);
  }
  if (surviving.length === 0) {
    return {
      startedAt, prefilter, scores: [], survivors: [], kills,
      thresholds: { ...GATES, jaccard: KILL_THRESHOLDS.jaccard, containment: KILL_THRESHOLDS.containment },
      servedBy: MODELS.fable, fallbackUsed: false, durationMs: Date.now() - t0,
    };
  }

  const artifactText = consensus.questions.map((q) => `- ${q.text}`).join('\n');
  const { data, meta } = await structured({
    model: MODELS.fable,
    effort: 'high',
    maxTokens: 16000,
    timeoutMs,
    ledger,
    system: SYSTEM,
    user: [
      `Domain: ${domain}`,
      ``, `CONSENSUS ARTIFACT:`, artifactText,
      ``, `CANDIDATES:`,
      ...surviving.map((c) => `[${c.id}] ${c.text}\n  (claimed decision changed: ${c.decisionsChanged})`),
    ].join('\n'),
    schema: SCHEMA,
  });

  const scores = (data.scores || []).filter((s) => surviving.some((c) => c.id === s.id));
  const scoredIds = new Set(scores.map((s) => s.id));
  for (const c of surviving) {
    if (!scoredIds.has(c.id)) {
      throw new LoudError(`gauntlet: scorer silently dropped candidate ${c.id} — every candidate must have a fate`, 'SILENT_DROP');
    }
  }
  for (const s of scores) {
    // Scores must be honest integers on the stated scale — fabricated ranges fail loudly.
    for (const ax of ['leverage', 'tractability', 'novelty']) {
      if (!Number.isInteger(s[ax]) || s[ax] < 0 || s[ax] > 10) {
        throw new LoudError(`gauntlet: score ${s.id}.${ax}=${s[ax]} outside 0-10`, 'BAD_SCORE');
      }
    }
    // Canonicalize the named nearest-consensus neighbor to a verbatim artifact member, so
    // "demonstrably not in it" is machine-checkable against the stored artifact. Only a
    // near-verbatim citation (≥2 shared content tokens with some artifact question) may
    // canonicalize — a zero-overlap citation is a fabricated audit field and fails loudly
    // instead of being laundered into a legitimate-looking one.
    if (s.nearestConsensus?.text && !consensus.questions.some((q) => q.text === s.nearestConsensus.text)) {
      const m = consensusCheck(s.nearestConsensus.text, consensus.questions, domain, { jaccard: 99, containment: 99, minShared: 99 });
      if (m.neighborText && m.shared >= 2) s.nearestConsensus.text = m.neighborText;
      else throw new LoudError(`gauntlet: score ${s.id} cites a nearest-consensus neighbor with no overlap to any artifact question ("${String(s.nearestConsensus.text).slice(0, 60)}") — fabricated audit field`, 'FABRICATED_NEIGHBOR');
    }
  }

  const passers = [];
  for (const s of scores) {
    if (s.semanticDup) { kills.push({ id: s.id, phase: 'semantic', reason: `paraphrase of consensus: "${s.nearestConsensus?.text}"` }); continue; }
    const below = [];
    if (s.leverage < GATES.leverage) below.push(`leverage ${s.leverage}<${GATES.leverage}`);
    if (s.novelty < GATES.novelty) below.push(`novelty ${s.novelty}<${GATES.novelty}`);
    if (s.tractability < GATES.tractability) below.push(`tractability ${s.tractability}<${GATES.tractability}`);
    if (below.length) { kills.push({ id: s.id, phase: 'scores', reason: `below bar: ${below.join(', ')}` }); continue; }
    passers.push(s);
  }
  passers.sort((a, b) => (b.leverage + b.novelty + b.tractability) - (a.leverage + a.novelty + a.tractability));
  const survivors = passers.slice(0, 3).map((s) => s.id);
  for (const p of passers.slice(3)) kills.push({ id: p.id, phase: 'capacity', reason: 'cleared the bar but outside top 3 by composite — max 3 reach deep dive' });

  return {
    startedAt, prefilter, scores, survivors, kills,
    thresholds: { ...GATES, jaccard: KILL_THRESHOLDS.jaccard, containment: KILL_THRESHOLDS.containment },
    servedBy: meta.servedBy, fallbackUsed: meta.fallbackUsed, durationMs: Date.now() - t0,
  };
}
