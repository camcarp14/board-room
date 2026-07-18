// Stage 1 — candidate questions, on Fable, with the consensus artifact as burned territory.
import { MODELS, structured, LoudError } from './llm.js';

const STRATEGIES = [
  'inversion', 'constraint_shift', 'incentive_shift', 'time_shift',
  'measurement_critique', 'second_order', 'stakeholder_shift', 'mechanism',
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'rationale', 'decisionsChanged', 'strategy'],
        properties: {
          text: { type: 'string', description: 'the question itself' },
          rationale: { type: 'string', description: 'why this is load-bearing and non-obvious' },
          decisionsChanged: { type: 'string', description: 'the concrete decision that changes if answered' },
          strategy: { type: 'string', enum: STRATEGIES },
        },
      },
    },
  },
};

const SYSTEM = `You generate the questions nobody on page one is asking.

You will receive a domain and a CONSENSUS ARTIFACT: the questions everyone already asks about it, plus the standard framings and positions. Treat the artifact as burned territory. Your default output IS the consensus — the highest-probability question about any topic is the one already ranked on Google — so anything that paraphrases the artifact, narrows it trivially (bolting on a year, a demographic, "in the age of AI"), or feeds the same underlying decision is worthless here.

Every question you generate must be:
- LOAD-BEARING: if answered well, a real decision changes. Name the decision in decisionsChanged.
- NON-OBVIOUS: absent from the artifact at every causal level — different mechanism, different stakeholder, different constraint. Not the same question in a costume.
- TRACTABLE: movable with evidence that exists in public — filings, datasets, price series, procurement records, job postings, regulatory dockets, shipping manifests.

Strategies that reliably get off the consensus manifold (tag each question with the one you used):
- inversion: what would make the consensus question moot?
- constraint_shift: which constraint does everyone assume fixed that is actually moving?
- incentive_shift: whose incentive quietly inverted? who profits from the standard framing staying standard?
- time_shift: what does this look like after the current bottleneck breaks — or before it existed?
- measurement_critique: what is the standard metric actually measuring, and what is mispriced because of it?
- second_order: what does everyone's REACTION to the consensus cause?
- stakeholder_shift: who bears the cost silently — all the exposure, no seat at the table?
- mechanism: what physical, contractual, or regulatory machinery sits under the abstraction everyone argues about?

Do NOT manufacture contrarianism. A question whose only virtue is disagreeing with consensus is as worthless as consensus. Aim for questions a sharp operator would pin to the wall, not debate-club prompts.`;

export async function generateCandidates({ domain, consensus, ledger, timeoutMs = 130000 }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const artifact = [
    `CONSENSUS QUESTIONS (burned territory):`,
    ...consensus.questions.map((q) => `- ${q.text}`),
    ``,
    `STANDARD FRAMINGS: ${consensus.framings.join(' | ')}`,
    ``,
    `STANDARD POSITIONS:`,
    ...consensus.positions.map((p) => `- [${p.topic}] ${p.position}`),
  ].join('\n');

  const { data, meta } = await structured({
    model: MODELS.fable,
    effort: 'high',
    maxTokens: 16000,
    timeoutMs,
    ledger,
    system: SYSTEM,
    user: `Domain: ${domain}\n\n${artifact}\n\nGenerate exactly 10 candidate questions.`,
    schema: SCHEMA,
  });

  // No silent drops: every returned candidate becomes an item; malformed ones get killed
  // (with a recorded fate) in the gauntlet prefilter, not filtered here.
  const items = (data.candidates || [])
    .slice(0, 12)
    .map((c, i) => ({ id: `q${i + 1}`, ...c, text: String(c.text || '').trim() }));

  // A generation failure must never masquerade as the boring verdict: an empty, thin, or
  // junk-filled candidate set is a FAILED run, not "consensus holds". The gate counts
  // WELL-FORMED candidates — ten malformed stubs are still a generation failure.
  const wellFormed = items.filter((c) => c.text.length >= 15).length;
  if (wellFormed < 5) {
    throw new LoudError(`candidate generation produced only ${wellFormed} well-formed candidates of ${items.length} returned (10 requested) — generation failure, not a verdict`, 'CANDIDATES_THIN');
  }

  return {
    startedAt,
    items,
    servedBy: meta.servedBy,
    fallbackUsed: meta.fallbackUsed,
    durationMs: Date.now() - t0,
  };
}
