// Stage 4 — POV synthesis on Fable. Evidence = the dive's cited claims ONLY.
// Schema violations are rejected, retried once with the problems fed back, then fail loudly.
import { MODELS, structured, LoudError } from './llm.js';
import { MECHANISM_TYPES, NO_EDGE_TYPE, validatePov } from './rigor.js';

const POV_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['spine', 'verdict', 'falsifiableClaim', 'confidence', 'falsifier', 'errorMechanism', 'citedClaimIds'],
  properties: {
    spine: { type: 'string', description: 'one declarative sentence — the stance' },
    verdict: { type: 'string', enum: ['contrarian', 'consensus_correct'] },
    falsifiableClaim: { type: 'string', description: 'specific, dated or bounded, checkable' },
    confidence: { type: 'number', description: '0.05-0.95, calibrated' },
    falsifier: { type: 'string', description: 'the specific observable that would prove this wrong' },
    errorMechanism: {
      type: 'object', additionalProperties: false, required: ['type', 'who', 'why'],
      properties: {
        type: { type: 'string', enum: [...MECHANISM_TYPES, NO_EDGE_TYPE] },
        who: { type: 'string', description: 'who holds the error' },
        why: { type: 'string', description: 'why smart, informed people believe otherwise' },
      },
    },
    citedClaimIds: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You produce a POV with a spine from an evidence brief. You receive: a question, cited findings from a live research dive (your ONLY permitted evidence), and the consensus positions on the domain.

Rules:
- Evidence discipline: reason only from the provided findings. If they don't support an edge over consensus, the verdict is consensus_correct — say consensus is right, with full rigor (a real confidence number and a falsifier stating what would make consensus wrong). Manufactured contrarianism is the one unforgivable failure.
- spine: one declarative sentence. The stance someone could disagree with.
- falsifiableClaim: specific, dated or bounded, checkable by a named kind of evidence.
- confidence: 0.05-0.95. Calibrate like a bettor: 0.9 means you'd take a 9:1 bet. Bold claims on thin evidence get LOW numbers — that is what honesty looks like.
- falsifier: the earliest concrete observable that would prove the claim wrong — something a person could actually go look at.
- errorMechanism: WHY smart, informed people currently believe otherwise. Pick the type that actually fits. "People haven't looked closely" is not a mechanism — no mechanism means no edge, just a disagreement. For consensus_correct verdicts use type ${NO_EDGE_TYPE}.
- citedClaimIds: the ids of the findings doing load-bearing work (at least one).`;

export async function synthesizePov({ domain, question, dive, consensus, ledger, timeoutMs = 200000 }) {
  const findings = dive.claims.map((c) => `[${c.id}] ${c.claim} (source: ${c.sourceTitle} — ${c.urls[0]})${c.quote ? ` — "${c.quote}"` : ''}`).join('\n');
  const tensions = dive.tensions.length ? `\nTENSIONS BETWEEN SOURCES:\n${dive.tensions.map((t) => `- ${t}`).join('\n')}` : '';
  const positions = consensus.positions.map((p) => `- [${p.topic}] ${p.position}`).join('\n');
  const user = `Domain: ${domain}\nQuestion: ${question.text}\n\nFINDINGS (your only evidence):\n${findings}${tensions}\n\nCONSENSUS POSITIONS (for contrast):\n${positions}`;

  let lastProblems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, meta } = await structured({
      model: MODELS.fable,
      effort: 'high',
      maxTokens: 12000,
      timeoutMs,
      ledger,
      system: SYSTEM,
      user: attempt === 0 ? user : `${user}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED FOR: ${lastProblems.join('; ')}. Fix every problem.`,
      schema: POV_SCHEMA,
    });
    const pov = { questionId: question.id, ...data };
    // Only claim ids from this dive count.
    pov.citedClaimIds = (pov.citedClaimIds || []).filter((id) => dive.claims.some((c) => c.id === id));
    lastProblems = validatePov(pov);
    if (lastProblems.length === 0) return { pov, meta };
  }
  throw new LoudError(`synthesis for ${question.id} failed rigor validation twice: ${lastProblems.join('; ')}`, 'POV_REJECTED');
}

export async function synthesizeSpine({ domain, povs, ledger, timeoutMs = 120000 }) {
  const { data, meta } = await structured({
    model: MODELS.fable,
    effort: 'medium',
    maxTokens: 5000,
    timeoutMs,
    ledger,
    system: 'You write the one-sentence spine that ties a set of POVs into a single stance on a domain. Declarative, specific, disagreeable. No hedging, no "it depends".',
    user: `Domain: ${domain}\n\nPOVs:\n${povs.map((p) => `- ${p.spine} (${p.verdict}, conf ${p.confidence})`).join('\n')}`,
    schema: {
      type: 'object', additionalProperties: false, required: ['runSpine'],
      properties: { runSpine: { type: 'string' } },
    },
  });
  return { runSpine: data.runSpine, meta };
}
