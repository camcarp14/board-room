// Stage 3 — deep dive. Sonnet + live web search. Every claim must cite a URL from THIS
// dive's own fetched set; anything else is rejected and recorded. Nothing from memory.
import { MODELS, searchCall, parseJsonLoose, repairJson, matchFetched, LoudError } from './llm.js';

const DIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims', 'tensions'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'url', 'quote', 'sourceTitle'],
        properties: {
          claim: { type: 'string' },
          url: { type: 'string' },
          quote: { type: 'string' },
          sourceTitle: { type: 'string' },
        },
      },
    },
    tensions: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You are a research analyst producing an evidence brief for one question. Search the live web. Rules:

- Every claim you report MUST come from a page you actually fetched this session, with its URL and a short supporting quote. Nothing from memory or training data — if you can't source it live, it doesn't go in the brief.
- Prefer primary and quantitative sources: filings, datasets, regulator documents, price series, official statistics, technical reports. Named journalism is acceptable; SEO listicles are not.
- Hunt for evidence that could CHANGE someone's mind, including evidence AGAINST the obvious answer. Record genuine tensions between sources.
- 5 to 9 claims. Specific numbers, dates, named actors.

End your reply with a single JSON object and nothing after it:
{"claims":[{"claim":"...","url":"...","quote":"...","sourceTitle":"..."}],"tensions":["..."]}`;

export async function deepDive({ question, questionId, domain, ledger, timeoutMs = 300000 }) {
  const t0 = Date.now();
  const base = {
    questionId, question, claims: [], rejectedClaims: [], fetchedUrls: [],
    searchCount: 0, tensions: [], servedBy: MODELS.sonnet,
  };
  let res;
  try {
    res = await searchCall({
      model: MODELS.sonnet,
      maxUses: 5,
      maxTokens: 14000,
      effort: 'medium',
      timeoutMs,
      ledger,
      system: SYSTEM,
      user: `Domain: ${domain}\nQuestion under investigation: ${question}\n\nBuild the evidence brief.`,
    });
  } catch (e) {
    return { ...base, status: 'failed', failReason: `dive call failed: ${e.message}`, durationMs: Date.now() - t0 };
  }

  let parsed = parseJsonLoose(res.lastText) || parseJsonLoose(res.text);
  if (!parsed || !Array.isArray(parsed.claims)) {
    try { parsed = await repairJson(res.lastText || res.text, DIVE_SCHEMA, ledger); } catch { parsed = null; }
  }
  if (!parsed || !Array.isArray(parsed.claims)) {
    return { ...base, status: 'failed', failReason: 'dive output unparseable', fetchedUrls: res.fetchedUrls, searchCount: res.searchCount, harvest: res.harvest, durationMs: Date.now() - t0 };
  }

  // Citation gate: every claim must cite a URL this dive actually fetched (tiered match,
  // stored back as the canonical fetched string so audits are exact-match). Nothing from memory.
  const claims = [];
  const rejectedClaims = [];
  let n = 0;
  for (const c of parsed.claims) {
    if (!c.claim || String(c.claim).trim().length < 15) { rejectedClaims.push({ claim: String(c.claim || ''), reason: 'empty_or_trivial' }); continue; }
    const hit = c.url ? matchFetched(c.url, res.fetchedNormalized) : null;
    if (!hit) { rejectedClaims.push({ claim: c.claim, reason: c.url ? 'url_not_fetched_this_session' : 'no_citation' }); continue; }
    n++;
    claims.push({
      id: `${questionId}-cl${n}`,
      claim: String(c.claim).trim(),
      urls: [hit.url],
      matchTier: hit.tier,
      quote: String(c.quote || '').slice(0, 400),
      sourceTitle: String(c.sourceTitle || ''),
    });
  }

  const total = claims.length + rejectedClaims.length;
  const rejectRate = total ? rejectedClaims.length / total : 1;
  // The documented loudness gate (DECISIONS.md): <3 live-cited claims OR >30% rejects = failed dive.
  const status = claims.length >= 3 && rejectRate <= 0.3 ? 'ok' : 'failed';
  return {
    ...base,
    status,
    failReason: status === 'failed' ? `only ${claims.length} live-cited claims (${rejectedClaims.length} rejected)` : undefined,
    claims, rejectedClaims,
    fetchedUrls: res.fetchedUrls,
    searchCount: res.searchCount,
    harvest: res.harvest,
    tensions: (parsed.tensions || []).slice(0, 6).map(String),
    durationMs: Date.now() - t0,
  };
}
