// Stage 0 — the consensus artifact. Emitted BEFORE any candidate exists.
// Deliberately NOT on Fable: Haiku's default output is the purest sample of the
// highest-probability take, and Sonnet+web-search grounds it in what page one
// actually asks. The foil should be the modal take, not the smartest take.
import { MODELS, structured, searchCall, parseJsonLoose, repairJson, LoudError } from './llm.js';
import { consensusCheck } from './exclusion.js';

const HAIKU_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions', 'framings', 'positions'],
  properties: {
    questions: { type: 'array', items: { type: 'string' } },
    framings: { type: 'array', items: { type: 'string' } },
    positions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['topic', 'position'],
        properties: { topic: { type: 'string' }, position: { type: 'string' } },
      },
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions', 'positions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'url'],
        properties: { text: { type: 'string' }, url: { type: 'string' } },
      },
    },
    positions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['topic', 'position'],
        properties: { topic: { type: 'string' }, position: { type: 'string' } },
      },
    },
  },
};

export async function buildConsensus({ domain, ledger, onEvent = () => {} }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const haikuP = structured({
    model: MODELS.haiku,
    effort: undefined,
    maxTokens: 6000,
    timeoutMs: 90000,
    ledger,
    system:
      'You enumerate the standard, most common questions people ask about a topic — exactly the questions that rank on page one of Google, appear in People-Also-Ask boxes, FAQ pages, and intro explainers. Do not be clever or original. Your job is to be perfectly, boringly representative of the mainstream conversation. Also list the standard framings (the lenses articles use) and the standard consensus positions (the answers most sources converge on).',
    user: `Topic: ${domain}\n\nList 18 standard questions, 5 standard framings, and 6 standard consensus positions.`,
    schema: HAIKU_SCHEMA,
  });

  const searchP = (async () => {
    const res = await searchCall({
      model: MODELS.sonnet,
      maxUses: 3,
      maxTokens: 10000,
      effort: 'medium',
      timeoutMs: 110000,
      ledger,
      system:
        'You map the consensus conversation about a topic by looking at what actually ranks: FAQs, explainers, "everything you need to know" pieces, People-Also-Ask-style questions. Search the web, then report the standard questions being asked (with the URL of a page asking or answering each) and the standard consensus positions. Be representative, not original. End your reply with a single JSON object: {"questions":[{"text":"...","url":"..."}],"positions":[{"topic":"...","position":"..."}]} and nothing after it.',
      user: `Topic: ${domain}\n\nFind the page-one questions and consensus positions. 10-14 questions.`,
    });
    let parsed = parseJsonLoose(res.lastText) || parseJsonLoose(res.text);
    if (!parsed) parsed = await repairJson(res.lastText || res.text, SEARCH_SCHEMA, ledger);
    return { parsed, fetchedUrls: res.fetchedUrls, searchCount: res.searchCount };
  })();

  const [haikuR, searchR] = await Promise.allSettled([haikuP, searchP]);

  if (haikuR.status === 'rejected') {
    throw new LoudError(`consensus stage: haiku sampling failed — ${haikuR.reason?.message}`, 'CONSENSUS_FAILED');
  }
  const haiku = haikuR.value.data;

  const questions = [];
  const addQuestion = (text, source, urls = []) => {
    if (!text || text.trim().length < 8) return;
    for (const q of questions) {
      const m = consensusCheck(text, [q.text], domain);
      if (m.killed) { // same question — merge provenance
        if (source !== q.source) q.source = 'both';
        for (const u of urls) if (!q.urls.includes(u)) q.urls.push(u);
        return;
      }
    }
    questions.push({ id: `c${questions.length + 1}`, text: text.trim(), source, urls });
  };

  for (const q of haiku.questions || []) addQuestion(q, 'haiku');
  let searchDegraded = true;
  let fetchedUrls = [];
  const positions = (haiku.positions || []).slice(0, 8);
  if (searchR.status === 'fulfilled' && searchR.value.parsed) {
    const { parsed } = searchR.value;
    fetchedUrls = searchR.value.fetchedUrls;
    const got = (parsed.questions || []).filter((q) => q.text);
    if (got.length >= 3) searchDegraded = false;
    for (const q of got) addQuestion(q.text, 'search', q.url ? [q.url] : []);
    for (const p of parsed.positions || []) if (positions.length < 12) positions.push(p);
  }
  if (searchDegraded) onEvent({ type: 'warn', stage: 'consensus', message: 'web grounding degraded — consensus artifact is model-prior only' });

  if (questions.length < 8) {
    throw new LoudError(`consensus stage produced only ${questions.length} questions — too thin to be a real foil`, 'CONSENSUS_THIN');
  }

  return {
    startedAt,
    questions: questions.slice(0, 26),
    framings: (haiku.framings || []).slice(0, 6),
    positions,
    fetchedUrls,
    searchDegraded,
    servedBy: `${MODELS.haiku} + ${MODELS.sonnet}(search)`,
    durationMs: Date.now() - t0,
  };
}
