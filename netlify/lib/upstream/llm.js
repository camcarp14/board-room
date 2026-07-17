// Model router + call helpers. Routing per DECISIONS.md:
//   Fable 5  → protected stages (candidates, scoring, synthesis, subject pick, predictions)
//              with server-side refusal fallback to Opus 4.8, recorded in the artifact.
//   Sonnet 5 → web-search stages (dives, consensus-future, page-one sampling) + judges.
//   Haiku    → consensus prior sampling, JSON repair.
import Anthropic from '@anthropic-ai/sdk';

// Netlify function env: ANTHROPIC_API_KEY (same var board-work-background uses).
function requireApiKey() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('UPSTREAM_ENV_MISSING: ANTHROPIC_API_KEY not set on this site');
    err.code = 'UPSTREAM_ENV_MISSING';
    throw err;
  }
  return key;
}

export const MODELS = {
  fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fallback: 'claude-opus-4-8',
};

const PRICE = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-opus-4-8': { in: 5, out: 25 },
};
const SEARCH_COST = 0.01; // $10 / 1k searches

let _client = null;
export function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: requireApiKey(), maxRetries: 2 });
  return _client;
}

export class LoudError extends Error {
  constructor(message, code) { super(message); this.code = code || 'LOUD_FAILURE'; }
}

// ---------- usage ledger ----------
export function makeLedger() { return { entries: [], searches: 0 }; }

export function ledgerAdd(ledger, model, usage = {}, searches = 0) {
  if (!ledger) return;
  ledger.entries.push({
    model,
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
  });
  ledger.searches += searches;
}

export function ledgerTotal(ledger) {
  const byModel = {};
  let inputTokens = 0, outputTokens = 0, estCostUsd = ledger.searches * SEARCH_COST;
  for (const e of ledger.entries) {
    inputTokens += e.input + e.cacheRead + e.cacheWrite;
    outputTokens += e.output;
    const p = PRICE[e.model] || PRICE[MODELS.sonnet];
    const cost = (e.input * p.in + e.cacheWrite * p.in * 1.25 + e.cacheRead * p.in * 0.1 + e.output * p.out) / 1e6;
    estCostUsd += cost;
    byModel[e.model] = (byModel[e.model] || 0) + cost;
  }
  return { inputTokens, outputTokens, estCostUsd: Number(estCostUsd.toFixed(3)), byModel, searches: ledger.searches };
}

// ---------- plumbing ----------
async function finalWithTimeout(stream, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      stream.finalMessage(),
      new Promise((_, rej) => {
        timer = setTimeout(() => {
          try { stream.abort(); } catch { /* already closed */ }
          rej(new LoudError(`${label} exceeded its ${Math.round(timeoutMs / 1000)}s stage timeout`, 'STAGE_TIMEOUT'));
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function fallbackInfo(msg) {
  const iterations = msg.usage?.iterations || [];
  const fallbackUsed =
    iterations.some((e) => e.type === 'fallback_message') ||
    (msg.content || []).some((b) => b.type === 'fallback');
  return { servedBy: msg.model, fallbackUsed };
}

function textOf(msg) {
  return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function guardStop(msg, label) {
  if (msg.stop_reason === 'refusal') {
    const cat = msg.stop_details?.category || 'unspecified';
    throw new LoudError(`${label}: model declined (refusal, category=${cat}) and fallback chain did not rescue it`, 'REFUSAL');
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new LoudError(`${label}: output truncated at max_tokens — raise the budget`, 'TRUNCATED');
  }
}

// ---------- structured call (json_schema output) ----------
export async function structured({ model, system, user, schema, maxTokens = 8000, effort = 'high', timeoutMs = 240000, ledger }) {
  const c = getClient();
  const body = {
    model,
    max_tokens: Math.max(maxTokens, 4000),
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  };
  if (model !== MODELS.haiku && effort) body.output_config.effort = effort;

  let stream;
  if (model === MODELS.fable) {
    try {
      stream = c.beta.messages.stream({
        ...body,
        betas: ['server-side-fallback-2026-06-01'],
        fallbacks: [{ model: MODELS.fallback }],
      });
    } catch {
      stream = null;
    }
  }
  let msg;
  if (stream) {
    try {
      msg = await finalWithTimeout(stream, timeoutMs, `structured(${model})`);
    } catch (e) {
      // If the fallback beta itself is rejected, retry plain Fable once. Timeouts/refusals propagate.
      if (e?.status === 400 && /fallback/i.test(String(e.message))) msg = null;
      else throw e;
    }
  }
  if (!msg) {
    msg = await finalWithTimeout(c.messages.stream(body), timeoutMs, `structured(${model})`);
  }
  guardStop(msg, `structured(${model})`);
  ledgerAdd(ledger, msg.model, msg.usage);
  const raw = textOf(msg);
  let data;
  try { data = JSON.parse(raw); } catch {
    data = parseJsonLoose(raw);
    if (data == null) throw new LoudError(`structured(${model}) returned non-JSON despite json_schema: ${raw.slice(0, 200)}`, 'BAD_JSON');
  }
  return { data, meta: { ...fallbackInfo(msg), usage: msg.usage } };
}

export async function jsonCall(opts) { return (await structured(opts)).data; }

// ---------- web-search call ----------
export async function searchCall({ model = MODELS.sonnet, system, user, maxUses = 6, maxTokens = 12000, effort = 'medium', timeoutMs = 300000, ledger }) {
  const c = getClient();
  let messages = [{ role: 'user', content: user }];
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }];
  const fetched = new Map(); // normalized -> original url string
  const citations = [];
  let searchCount = 0;
  const texts = [];
  let msg;
  // timeoutMs is a WHOLE-CALL budget: pause_turn continuation hops share it rather than
  // each getting a fresh allowance (otherwise a failing search stage could run 5x past
  // its stage budget before failing).
  const callT0 = Date.now();
  for (let hop = 0; hop < 5; hop++) {
    const hopBudget = timeoutMs - (Date.now() - callT0);
    if (hopBudget < 5000) throw new LoudError(`searchCall(${model}) exhausted its ${Math.round(timeoutMs / 1000)}s budget across continuation hops`, 'STAGE_TIMEOUT');
    const stream = c.messages.stream({ model, max_tokens: maxTokens, system, messages, tools, output_config: { effort } });
    msg = await finalWithTimeout(stream, hopBudget, `searchCall(${model})`);
    let hopSearches = 0;
    for (const block of msg.content || []) {
      if (block.type === 'server_tool_use') hopSearches++;
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r?.url) fetched.set(normalizeUrl(r.url), r.url);
        }
      }
      if (block.type === 'text') {
        if (block.text) texts.push(block.text);
        for (const cit of block.citations || []) {
          if (cit?.url) citations.push({ url: cit.url, title: cit.title || '', citedText: cit.cited_text || '' });
        }
      }
    }
    searchCount += hopSearches;
    ledgerAdd(ledger, msg.model, msg.usage, hopSearches);
    if (msg.stop_reason === 'pause_turn') {
      messages = [...messages, { role: 'assistant', content: msg.content }];
      continue;
    }
    break;
  }
  if (msg.stop_reason === 'pause_turn') {
    throw new LoudError(`searchCall(${model}) still paused after 5 continuation hops — search loop exhausted`, 'SEARCH_EXHAUSTED');
  }
  guardStop(msg, `searchCall(${model})`);
  return {
    text: texts.join('\n'),
    lastText: textOf(msg),
    fetchedUrls: [...fetched.values()],
    fetchedNormalized: fetched,
    searchCount,
    citations,
    meta: { servedBy: msg.model },
  };
}

// ---------- JSON utilities ----------
export function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* keep going */ }
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch { /* keep going */ }
  }
  return null;
}

// Last-resort repair: Haiku extracts the JSON faithfully (no invention) against the schema.
export async function repairJson(text, schema, ledger) {
  const { data } = await structured({
    model: MODELS.haiku,
    system: 'Extract the JSON object described by the schema from the user text. Reproduce content faithfully — do not invent, embellish, or fill gaps. If a field is absent in the text, use an empty string/array.',
    user: String(text).slice(0, 60000),
    schema,
    maxTokens: 8000,
    effort: undefined,
    ledger,
  });
  return data;
}

export function normalizeUrl(u) {
  try {
    const url = new URL(String(u));
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (/^utm_|^fbclid|^gclid/i.test(k)) url.searchParams.delete(k);
    let path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return String(u).trim().replace(/\/+$/, '').toLowerCase();
  }
}
