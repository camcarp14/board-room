// Deterministic consensus-overlap metric. Shared by the engine (kill gate) and the eval
// graders (single source of truth — see eval/EVAL.md "Anti-Goodhart notes").

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','of','in','on','at','to','for','from',
  'by','with','about','as','into','than','over','under','is','are','was','were','be','been',
  'being','do','does','did','have','has','had','will','would','can','could','should','shall',
  'may','might','must','it','its','this','that','these','those','there','their','they','them',
  'you','your','we','our','i','my','me','he','she','his','her','not','no','so','too','very',
  'just','more','most','some','any','all','each','every','both','few','other','such','own',
  'same','s','t','don','now','how','what','when','where','which','who','whom','why','whose',
  'much','many','lot','really','actually','going','get','gets','getting','got','make','makes',
  'made','vs','versus','per','also','still','even','ever','yet','one','two','way','ways',
]);

// Light suffix stem — enough to make "prices"/"price", "offices"/"office",
// "investing"/"invest" collide. The trailing-e strip keeps plural/singular symmetric
// ("offices"→es→"offic" and "office"→e→"offic") — asymmetry here was caught by smoke.
function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('es') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}

export function tokenize(text, domainText = '') {
  // Domain tokens are stripped: every in-domain question shares the domain's words, which
  // would inflate overlap between ANY two questions about the same topic.
  // Unicode-aware split so non-English content still tokenizes (stemming stays English-only).
  const domainTokens = new Set(
    String(domainText).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem)
  );
  const out = new Set();
  for (const raw of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (!s || STOPWORDS.has(s) || domainTokens.has(s)) continue;
    out.add(s);
  }
  return out;
}

export function overlap(textA, textB, domainText = '') {
  const a = tokenize(textA, domainText);
  const b = tokenize(textB, domainText);
  if (a.size === 0 || b.size === 0) return { jaccard: 0, containment: 0, shared: 0 };
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return {
    jaccard: union ? shared / union : 0,
    containment: shared / Math.min(a.size, b.size),
    shared,
  };
}

// minShared=2, not 3: after domain-token stripping, short consensus questions can carry
// only 2-3 content tokens, and containment is exactly the signal that matters there.
// (Tuned against planted smoke problems, never against eval fixtures.)
export const KILL_THRESHOLDS = { jaccard: 0.5, containment: 0.75, minShared: 2 };

// Kill decision for one candidate question against the whole consensus artifact.
// The kill test runs against EVERY neighbor — a containment kill on question Y must not
// be masked by question X having higher Jaccard (qa-adversary finding, fixed).
// A candidate with <2 content tokens after domain stripping is a pure restatement of the
// domain: it cannot demonstrate distance, so it dies deterministically (zeroContent).
// Scripts without word delimiters (CJK) tokenize to one giant token, so the zero-content
// rule would false-kill EVERYTHING and manufacture a consensus_holds. For CJK content the
// deterministic layer stands down (metrics ~0, nothing killed) and exclusion rests on the
// Fable semantic pass — degraded but honest, vs. deterministically wrong.
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

export function consensusCheck(candidateText, consensusQuestions, domainText, thresholds = KILL_THRESHOLDS) {
  if (!CJK_RE.test(String(candidateText)) && tokenize(candidateText, domainText).size < 2) {
    return { killed: true, zeroContent: true, neighborText: null, jaccard: 0, containment: 0, shared: 0 };
  }
  let best = null;    // max-Jaccard neighbor, for the audit trail
  let killer = null;  // strongest neighbor that trips the kill bar
  for (const cq of consensusQuestions) {
    const text = typeof cq === 'string' ? cq : cq.text;
    const m = overlap(candidateText, text, domainText);
    if (!best || m.jaccard > best.jaccard) best = { neighborText: text, ...m };
    const trips = m.shared >= thresholds.minShared &&
      (m.jaccard >= thresholds.jaccard || m.containment >= thresholds.containment);
    if (trips && (!killer || Math.max(m.jaccard, m.containment) > Math.max(killer.jaccard, killer.containment))) {
      killer = { neighborText: text, ...m };
    }
  }
  if (!best) return { killed: false, zeroContent: false, neighborText: null, jaccard: 0, containment: 0, shared: 0 };
  const chosen = killer || best;
  return { killed: Boolean(killer), zeroContent: false, ...chosen };
}

// Looser matcher for eval recall (is fixture question X covered by the artifact?).
export function looseMatch(textA, textB, domainText) {
  const m = overlap(textA, textB, domainText);
  return m.shared >= 2 && (m.jaccard >= 0.33 || m.containment >= 0.6);
}
