// The rigor contract: what a POV and a prediction MUST carry to ship.
// Engine uses these to reject; eval graders use the same functions to grade.
// A validator that can't catch a planted violation fails eval:fast.

export const MECHANISM_TYPES = [
  'incentive_gradient',    // who profits from the consensus being believed
  'measurement_artifact',  // the metric everyone quotes measures the wrong thing
  'selection_effect',      // the visible sample isn't the population
  'composition_fallacy',   // true for parts, false for the whole (or vice versa)
  'stale_prior',           // was true, conditions changed, belief didn't update
  'principal_agent',       // deciders don't bear the outcome
  'goodhart',              // the target became the metric and broke it
  'narrative_capture',     // a story is doing the work evidence should do
  'coordination_failure',  // everyone knows, nobody can move first
  'base_rate_neglect',     // vivid cases swamp the denominator
];

// Allowed only on kind='consensus_affirmed' predictions and verdict='consensus_correct' POVs.
export const NO_EDGE_TYPE = 'none_consensus_correct';

// Tripwire, not a guarantee: catches the common lazy phrasings. Semantic vacuity that
// dodges these patterns is caught by the live rigor judge (eval:live suite R), never
// claimed to be caught deterministically — see EVAL.md.
export const VACUOUS_PATTERNS = [
  /haven'?t (really |ever )?(looked|examined|studied|checked)/i,
  /people are (just )?wrong/i,
  /hasn'?t been considered/i,
  /most people don'?t realize/i,
  /just haven'?t thought/i,
  /nobody ((has|have) )?(noticed|is paying attention|pays attention)/i,
  /simply (don'?t|do not) understand/i,
  /the (mainstream|masses) (is|are) asleep/i,
  /not paying attention/i,
  // Anchored to negation: "they have NOT looked at the data" is vacuous; an honest
  // mechanism that says analysts HAVE looked but misread it must not trip this.
  /(haven'?t|hasn'?t|not|never|nobody|no one)[^.]{0,40}looked at the (underlying )?data/i,
];

const str = (v, min) => typeof v === 'string' && v.trim().length >= min;
const vacuous = (v) => VACUOUS_PATTERNS.some((re) => re.test(String(v || '')));

export function validatePov(pov) {
  const p = [];
  if (!str(pov?.spine, 20)) p.push('spine missing or under 20 chars');
  if (!['contrarian', 'consensus_correct'].includes(pov?.verdict)) p.push('verdict must be contrarian|consensus_correct');
  if (!str(pov?.falsifiableClaim, 30)) p.push('falsifiableClaim missing or under 30 chars');
  if (typeof pov?.confidence !== 'number' || pov.confidence < 0.05 || pov.confidence > 0.95)
    p.push('confidence must be a number in [0.05, 0.95] — certainty is a schema violation');
  if (!str(pov?.falsifier, 30)) p.push('falsifier missing or under 30 chars (name the observable that would kill this)');
  const m = pov?.errorMechanism;
  const allowedTypes = pov?.verdict === 'consensus_correct' ? [...MECHANISM_TYPES, NO_EDGE_TYPE] : MECHANISM_TYPES;
  if (!m || !allowedTypes.includes(m.type)) p.push(`errorMechanism.type must be one of the typology (${pov?.verdict === 'consensus_correct' ? 'or none_consensus_correct' : 'no edge without a mechanism'})`);
  if (m && m.type !== NO_EDGE_TYPE) {
    if (!str(m.who, 20)) p.push('errorMechanism.who missing or under 20 chars (who holds the error)');
    if (!str(m.why, 20)) p.push('errorMechanism.why missing or under 20 chars (why smart people believe otherwise)');
    if (vacuous(m.why) || vacuous(m.who)) p.push('errorMechanism is vacuous ("people just haven\'t looked" is not a mechanism)');
  }
  if (!Array.isArray(pov?.citedClaimIds) || pov.citedClaimIds.length < 1)
    p.push('citedClaimIds must reference at least one dive claim');
  return p;
}

const DAY = 24 * 3600 * 1000;

export function validatePrediction(pred, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const fetchedUrls = opts.fetchedUrls || null; // when provided, counterpart URLs must be in it
  const p = [];
  const affirmed = pred?.kind === 'consensus_affirmed';
  if (!['bold', 'consensus_affirmed'].includes(pred?.kind)) p.push('kind must be bold|consensus_affirmed');
  if (!str(pred?.statement, 30)) p.push('statement missing or under 30 chars');
  const d = new Date(String(pred?.resolutionDate || ''));
  if (Number.isNaN(d.getTime())) p.push('resolutionDate missing or unparseable — undated boldness is astrology');
  else {
    const dt = d.getTime() - now.getTime();
    if (dt < 90 * DAY) p.push('resolutionDate under 3 months out — not a prediction, a news item');
    if (dt > 20 * 365 * DAY) p.push('resolutionDate over 20 years out — unresolvable in practice');
  }
  if (!str(pred?.resolutionCriterion, 30)) p.push('resolutionCriterion missing or under 30 chars (must be objectively checkable)');
  if (typeof pred?.confidence !== 'number' || pred.confidence < 0.05 || pred.confidence > 0.95)
    p.push('confidence must be a number in [0.05, 0.95]');
  if (!Array.isArray(pred?.causalChain) || pred.causalChain.length < 2 || pred.causalChain.some((s) => !str(s, 15)))
    p.push('causalChain must be ≥2 ordered preconditions, each substantive');
  if (!str(pred?.tell?.observable, 15)) p.push('tell.observable missing (the earliest thing you could go look at)');
  if (!str(pred?.tell?.whereToLook, 10)) p.push('tell.whereToLook missing (a named place/source to check)');
  const cc = pred?.consensusCounterpart;
  if (!str(cc?.position, 20)) p.push('consensusCounterpart.position missing');
  if (!Array.isArray(cc?.urls) || cc.urls.length < 1) p.push('consensusCounterpart.urls missing — consensus must be cited, not remembered');
  else if (fetchedUrls && !cc.urls.some((u) => fetchedUrls.includes(u)))
    p.push('consensusCounterpart cites a URL that was never fetched this run');
  if (!affirmed && !str(pred?.delta, 15)) p.push('delta missing — bold is a distance measure; state direction/timing vs consensus');
  const m = pred?.whyConsensusMisses;
  if (affirmed) {
    if (m && m.type && m.type !== NO_EDGE_TYPE) p.push('affirmed predictions use mechanism type none_consensus_correct');
  } else {
    if (!m || !MECHANISM_TYPES.includes(m.type)) p.push('whyConsensusMisses.type must be one of the typology');
    if (!str(m?.why, 20) || vacuous(m?.why)) p.push('whyConsensusMisses.why missing or vacuous');
  }
  return p;
}
