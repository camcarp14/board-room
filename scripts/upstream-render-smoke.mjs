// Render smoke for the Upstream page. Server-renders RunView against real artifact
// shapes — including partial/failed runs — so a null-access crash is caught here rather
// than in Cameron's browser. No network, no API spend.
//   node scripts/upstream-render-smoke.mjs
import { renderToString } from "react-dom/server";
import React from "react";
import { register } from "node:module";

// Vite/JSX isn't available in bare node, so this file is run through esbuild by the
// npm script (see package.json "smoke:upstream").
import { RunView } from "../src/pages/upstream/UpstreamPage.jsx";

let pass = 0, fail = 0;
const check = (name, fn) => {
  try {
    const html = fn();
    if (typeof html !== "string" || html.length < 50) throw new Error("rendered empty");
    pass++; console.log(`ok:   ${name}`);
    return html;
  } catch (e) {
    fail++; console.error(`FAIL: ${name}\n      ${e.message}`);
    return "";
  }
};

const render = (run) => renderToString(React.createElement(RunView, { run }));

// 1. The real failure from the live baseball run: gauntlet completed, all dives failed.
const baseballFailed = {
  id: "r1", surface: "upstream", domain: "the future of baseball",
  status: "failed", verdict: "failed", started_at: new Date().toISOString(), duration_ms: 360000,
  artifact: {
    domain: "the future of baseball", durationMs: 360000,
    verdict: "failed", failure: { stage: "dives", reason: "all dives failed — no live-cited evidence base to reason from" },
    stages: {
      consensus: {
        questions: Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, text: `Standard baseball question ${i}?`, source: "haiku", urls: [] })),
        positions: [{ topic: "attendance", position: "Attendance is flat." }],
        searchDegraded: false, servedBy: "claude-haiku-4-5 + claude-sonnet-5(search)",
      },
      candidates: {
        items: [
          { id: "q1", text: "Now that Diamond Sports' bankruptcy has forced MLB to produce local broadcasts, at what point does league-run local media become a de facto national revenue pool?", decisionsChanged: "CBA positioning", strategy: "second_order" },
          { id: "q2", text: "Is a $100M+ multi-year pitcher contract now an actuarially unsound instrument?", decisionsChanged: "roster construction", strategy: "constraint_shift" },
          { id: "q9", text: "Is baseball dying in America?", decisionsChanged: "n/a", strategy: "inversion" },
        ],
        servedBy: "claude-fable-5", fallbackUsed: false,
      },
      gauntlet: {
        survivors: ["q1", "q2"],
        kills: [{ id: "q9", phase: "prefilter", reason: 'consensus duplicate — token overlap (j=0.61, c=0.88)' }],
        scores: [
          { id: "q1", leverage: 8, tractability: 6, novelty: 8, reasoning: { leverage: "Reorders revenue sharing.", tractability: "Filings are public.", novelty: "Absent from page one." }, nearestConsensus: { text: "How will streaming change baseball viewership?", delta: "asks about political economy, not distribution" } },
          { id: "q2", leverage: 7, tractability: 7, novelty: 8, reasoning: { leverage: "Repricing risk.", tractability: "Injury data exists.", novelty: "Different instrument." }, nearestConsensus: { text: "Will baseball salaries continue to increase?", delta: "asks whether the instrument is mispriced" } },
        ],
        thresholds: { leverage: 7, tractability: 5, novelty: 7 }, servedBy: "claude-fable-5", fallbackUsed: false,
      },
      dives: [
        { questionId: "q1", status: "failed", failReason: "searchCall exceeded its 88s stage timeout", claims: [], rejectedClaims: [], searchCount: 0, tensions: [] },
        { questionId: "q2", status: "failed", failReason: "searchCall exceeded its 88s stage timeout", claims: [], rejectedClaims: [], searchCount: 0, tensions: [] },
      ],
    },
    usageTotal: { inputTokens: 100000, outputTokens: 9000, estCostUsd: 0.9, searches: 0 },
  },
};
check("failed run (dives timed out) renders with partial artifact", () => render(baseballFailed));

// 2. A fully successful run — the payload-first path.
const good = JSON.parse(JSON.stringify(baseballFailed));
good.status = "done"; good.verdict = "povs_shipped";
good.artifact.verdict = "povs_shipped"; good.artifact.failure = null;
good.artifact.stages.dives = [{
  questionId: "q1", status: "ok", searchCount: 5, tensions: ["Sources disagree on the baseline year."],
  claims: [
    { id: "q1-cl1", claim: "Diamond Sports emerged from Chapter 11 in 2025 having shed 11 RSN contracts.", urls: ["https://www.reuters.com/media/diamond"], quote: "shed eleven regional contracts", sourceTitle: "Reuters", matchTier: "exact" },
    { id: "q1-cl2", claim: "MLB now produces local broadcasts for six clubs directly.", urls: ["https://www.mlb.com/press"], quote: "six clubs", sourceTitle: "MLB", matchTier: "host" },
  ],
  rejectedClaims: [{ claim: "An uncited assertion.", reason: "url_not_fetched_this_session" }],
}];
good.artifact.stages.synthesis = {
  runSpine: "Baseball's next labor fight is a media-ownership fight wearing a payroll costume.",
  povs: [{
    questionId: "q1", spine: "League-run local media is quietly becoming a national revenue pool.",
    verdict: "contrarian",
    falsifiableClaim: "By the 2026 CBA, MLB will centrally produce local broadcasts for 10+ clubs.",
    confidence: 0.62, falsifier: "MLB divesting local production rights back to regional partners before 2026.",
    errorMechanism: { type: "narrative_capture", who: "beat writers covering the RSN collapse", why: "the story is framed as a distribution crisis, so the ownership shift underneath goes unreported" },
    citedClaimIds: ["q1-cl1", "q1-cl2"],
  }],
  servedBy: "claude-fable-5", fallbackUsed: false,
};
check("successful run renders spine + question cards", () => {
  const html = render(good);
  if (!html.includes("the spine")) throw new Error("spine block missing");
  if (!html.includes("What you should be asking") && !html.includes("should be asking")) throw new Error("question section missing");
  return html;
});

// 3. The boring verdict — must render as a finding, not a failure.
const boring = JSON.parse(JSON.stringify(baseballFailed));
boring.status = "done"; boring.verdict = "consensus_holds";
boring.artifact.verdict = "consensus_holds"; boring.artifact.failure = null;
boring.artifact.stages.gauntlet.survivors = [];
delete boring.artifact.stages.dives;
check("boring verdict renders as a finding", () => {
  const html = render(boring);
  if (!html.includes("Consensus holds")) throw new Error("boring verdict panel missing");
  return html;
});

// 4. A running run — mid-flight, only consensus present.
check("running run renders with only the first stage present", () => render({
  id: "r4", surface: "upstream", domain: "x", status: "running",
  started_at: new Date().toISOString(), duration_ms: null,
  artifact: { stages: { consensus: baseballFailed.artifact.stages.consensus } },
}));

// 5. Nostradamus with a shipped prediction (the real GLP-1 shape).
check("nostradamus run renders predictions + tell", () => {
  const html = render({
    id: "r5", surface: "nostradamus", domain: "GLP-1 agonists at population scale",
    status: "done", verdict: "predictions_shipped", started_at: new Date().toISOString(), duration_ms: 300000,
    artifact: {
      domain: "GLP-1 agonists at population scale", durationMs: 300000, verdict: "predictions_shipped",
      stages: {
        subject: { subject: "GLP-1 agonists at population scale", whyItMatters: "Repricing $4.9T of US health economy.", altitudeCheck: "Touches 100M+ people." },
        consensusFuture: { claims: [{ id: "cf1", claim: "Market forecasts size GLP-1 strictly on diabetes and obesity.", urls: ["https://www.morganstanley.com/ideas"], horizon: "by 2030" }], fetchedUrls: ["https://www.morganstanley.com/ideas"], searchCount: 6 },
        predictions: {
          shipped: [{
            id: "p1", kind: "bold",
            statement: "By 2031-12-31, the FDA approves a GLP-1 receptor agonist for a substance-use indication.",
            resolutionDate: "2031-12-31", resolutionCriterion: "Drugs@FDA shows an approved label including alcohol use disorder.",
            confidence: 0.18,
            causalChain: ["A Phase 3 trial registers with an AUD primary endpoint", "Readout shows effect", "FDA accepts the filing"],
            tell: { observable: "Registration of an industry-sponsored Phase 3 GLP-1 trial with an alcohol-use-disorder primary endpoint", whereToLook: "clinicaltrials.gov" },
            consensusCounterpart: { position: "No mapped forecast includes an addiction indication.", urls: ["https://www.morganstanley.com/ideas"] },
            delta: "Adds an indication axis absent from consensus models.",
            whyConsensusMisses: { type: "narrative_capture", who: "pharma sell-side analysts", why: "the class is locked in as 'the weight-loss drugs' so models only track company-sponsored pipelines" },
          }],
          rejected: [{ statement: "Something undated.", problems: ["resolutionDate missing"] }],
        },
      },
      usageTotal: { inputTokens: 90000, outputTokens: 8000, estCostUsd: 0.7, searches: 6 },
    },
  });
  if (!html.includes("the tell")) throw new Error("tell block missing — it is the actionable part");
  return html;
});

// 6. Degenerate shapes must not crash.
check("run with no artifact renders", () => render({ id: "r6", surface: "upstream", domain: "x", status: "done", verdict: "povs_shipped", started_at: new Date().toISOString(), duration_ms: 1, artifact: null }));
check("run with empty stages renders", () => render({ id: "r7", surface: "nostradamus", domain: null, status: "done", verdict: null, started_at: new Date().toISOString(), duration_ms: 1, artifact: { stages: {} } }));

console.log(`\n${pass}/${pass + fail} render checks passed`);
if (fail) { console.error("RENDER SMOKE FAILED"); process.exit(1); }
console.log("RENDER SMOKE PASS");
