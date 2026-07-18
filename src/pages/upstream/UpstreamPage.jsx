// ─── Upstream — the question engine + NOSTRADAMUS, native ─────────────────────
// Design rule: LEAD WITH THE PAYLOAD, hide the machinery.
// What you came for is the 2-3 questions and the take on each. The audit trail
// (consensus map, killed candidates, scores, raw evidence) is what makes those
// trustworthy, so it stays one click away under "Show the work" — never in the
// way. Same rule on the Nostradamus side: the claim and the tell lead; the
// causal chain and consensus counterpart sit behind a reveal.
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, StatTile, Button, Segmented, Field,
  Dot, EmptyState, Spinner,
} from "../../ui/kit.jsx";
import { IcRefresh, IcChevronDown, IcExternal, IcSearch } from "../../ui/icons.jsx";
import {
  startJob, fetchRuns, fetchRun, fetchPredictions, resolvePrediction,
  calibration, fmtDuration, daysUntil, hostOf,
} from "../../lib/upstream.js";

/* ── primitives ─────────────────────────────────────────────────────────────── */

const VERDICT = {
  povs_shipped: { tone: "var(--brass)", label: "POVS SHIPPED" },
  consensus_holds: { tone: "var(--green)", label: "CONSENSUS HOLDS" },
  predictions_shipped: { tone: "var(--brass)", label: "PREDICTIONS SHIPPED" },
  consensus_affirmed: { tone: "var(--green)", label: "CONSENSUS AFFIRMED" },
  failed: { tone: "var(--red)", label: "FAILED" },
};

function Tag({ tone = "var(--sub)", children, title }) {
  return (
    <span title={title} style={{
      fontSize: 9.5, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase",
      color: tone, border: `1px solid color-mix(in srgb, ${tone} 32%, transparent)`,
      background: `color-mix(in srgb, ${tone} 9%, transparent)`,
      borderRadius: 5, padding: "2px 7px", whiteSpace: "nowrap", flex: "none",
    }}>{children}</span>
  );
}

function RunBadge({ run }) {
  if (run.status === "running") return <Tag tone="var(--brass)">RUNNING</Tag>;
  const v = VERDICT[run.verdict] || { tone: "var(--faint)", label: (run.status || "—").toUpperCase() };
  return <Tag tone={v.tone}>{v.label}</Tag>;
}

function Reveal({ summary, children, tone = "var(--faint)", defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setOpen(!open)} style={{
        display: "inline-flex", alignItems: "center", gap: 5, background: "none",
        border: "none", padding: 0, cursor: "pointer", color: tone, fontSize: 11.5, fontWeight: 600,
      }}>
        <IcChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />
        {summary}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

const kLabel = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
  color: "var(--faint)", display: "block", marginBottom: 4,
};

const hr = { height: 1, background: "var(--line)", margin: "14px 0" };

function ConfBar({ value, width = 88 }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ width, height: 5, borderRadius: 99, background: "var(--line)", overflow: "hidden", display: "inline-block", flex: "none" }}>
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--brass)" }} />
      </span>
      <span className="t-num" style={{ fontSize: 14, color: "var(--brass)", fontWeight: 700 }}>{pct}%</span>
    </span>
  );
}

// "Why smart people believe otherwise" — the thing that separates an edge from a
// disagreement. Always rendered as prose, never a bare enum.
function Mechanism({ mech, compact }) {
  if (!mech?.type) return null;
  if (mech.type === "none_consensus_correct") {
    return (
      <div style={{ marginTop: compact ? 8 : 12 }}>
        <span style={kLabel}>the edge</span>
        <span style={{ fontSize: 13, color: "var(--green)" }}>None — consensus is correct here, and that is the finding.</span>
      </div>
    );
  }
  return (
    <div style={{ marginTop: compact ? 8 : 12 }}>
      <span style={kLabel}>why smart people miss it</span>
      <div style={{ display: "flex", gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
        <Tag tone="var(--brass)">{mech.type.replace(/_/g, " ")}</Tag>
        <span style={{ fontSize: 13, lineHeight: 1.55, flex: 1, minWidth: 200 }}>
          <b>{mech.who}</b> — {mech.why}
        </span>
      </div>
    </div>
  );
}

function SourceLink({ url, label }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" style={{
      fontSize: 11, color: "var(--brass)", display: "inline-flex", alignItems: "center",
      gap: 4, marginRight: 10, whiteSpace: "nowrap",
    }}><IcExternal size={10} /> {label || hostOf(url)}</a>
  );
}

/* ── stage rail (progress, not decoration) ──────────────────────────────────── */

const UP_STAGES = [
  { key: "consensus", label: "Consensus map" }, { key: "candidates", label: "Candidates" },
  { key: "gauntlet", label: "Gauntlet" }, { key: "dives", label: "Research" }, { key: "synthesis", label: "POVs" },
];
const NOS_STAGES = [
  { key: "subject", label: "Subject" }, { key: "consensusFuture", label: "Consensus future" }, { key: "predictions", label: "Predictions" },
];

function StageRail({ stages, artifact, run }) {
  const st = artifact?.stages || {};
  const statusOf = (key, idx) => {
    const present = key === "dives" ? (st.dives || []).length > 0 : Boolean(st[key]);
    if (present) return run.status === "failed" && artifact?.failure?.stage === key ? "fail" : "done";
    if (run.status === "failed") return artifact?.failure?.stage === key ? "fail" : "idle";
    if (run.status === "running") {
      const prev = idx === 0 || Boolean(st[stages[idx - 1].key]) || (stages[idx - 1].key === "dives" && (st.dives || []).length);
      return prev ? "run" : "idle";
    }
    return "idle";
  };
  const tone = { done: "var(--green)", run: "var(--brass)", fail: "var(--red)", idle: "var(--faint)" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", margin: "12px 0 2px" }}>
      {stages.map((s, i) => {
        const state = statusOf(s.key, i);
        return (
          <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {i > 0 && <span style={{ width: 14, height: 1, background: "var(--line)" }} />}
            <Dot tone={tone[state]} pulse={state === "run"} size={7} />
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
              color: state === "idle" ? "var(--faint)" : state === "run" ? "var(--brass)" : "var(--sub)",
            }}>{s.label}</span>
          </span>
        );
      })}
    </div>
  );
}

/* ══ UPSTREAM: the result view ══════════════════════════════════════════════ */

// One question fused with its take. Self-contained and readable top to bottom —
// this is the unit of value, so nothing else competes with it.
function QuestionCard({ n, question, pov, dive, score }) {
  const claimsById = Object.fromEntries((dive?.claims || []).map((c) => [c.id, c]));
  const cited = (pov?.citedClaimIds || []).map((id) => claimsById[id]).filter(Boolean);
  const otherClaims = (dive?.claims || []).filter((c) => !(pov?.citedClaimIds || []).includes(c.id));

  return (
    <Card pad="lg" style={{ marginBottom: 12 }}>
      {/* the question */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <span className="t-num" style={{
          fontSize: 12, fontWeight: 700, color: "var(--brass)", background: "color-mix(in srgb, var(--brass) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--brass) 30%, transparent)", borderRadius: 7,
          width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", marginTop: 2,
        }}>{n}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.45, margin: 0 }}>{question.text}</p>
          {question.decisionsChanged && (
            <p style={{ fontSize: 12.5, color: "var(--sub)", margin: "7px 0 0", lineHeight: 1.55 }}>
              <span style={{ color: "var(--faint)" }}>Changes: </span>{question.decisionsChanged}
            </p>
          )}
        </div>
      </div>

      {!pov && dive?.status !== "ok" && (
        <>
          <div style={hr} />
          <p style={{ fontSize: 12.5, color: "var(--red)", margin: 0 }}>
            No take — research failed for this question{dive?.failReason ? `: ${dive.failReason}` : ""}. Nothing was written from memory to cover the gap.
          </p>
        </>
      )}

      {pov && (
        <>
          <div style={hr} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={kLabel}>the take</span>
            <Tag tone={pov.verdict === "contrarian" ? "var(--brass)" : "var(--green)"}>
              {pov.verdict === "contrarian" ? "non-consensus" : "consensus is right"}
            </Tag>
          </div>
          <p style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.5, margin: "0 0 12px" }}>{pov.spine}</p>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: "0 0 14px", color: "var(--sub)" }}>{pov.falsifiableClaim}</p>

          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div>
              <span style={kLabel}>confidence</span>
              <ConfBar value={pov.confidence} />
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <span style={kLabel}>dies if</span>
              <span style={{ fontSize: 12.5, lineHeight: 1.55 }}>{pov.falsifier}</span>
            </div>
          </div>

          <Mechanism mech={pov.errorMechanism} />

          {cited.length > 0 && (
            <Reveal summary={`Evidence — ${cited.length} source${cited.length > 1 ? "s" : ""} behind this take${otherClaims.length ? ` (+${otherClaims.length} more found)` : ""}`}>
              {cited.map((c) => <EvidenceRow key={c.id} c={c} />)}
              {otherClaims.length > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
                  <span style={kLabel}>other findings from this dive</span>
                  {otherClaims.map((c) => <EvidenceRow key={c.id} c={c} dim />)}
                </div>
              )}
              {(dive?.tensions || []).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <span style={kLabel}>sources disagree on</span>
                  {dive.tensions.map((t, i) => <p key={i} style={{ fontSize: 12.5, color: "var(--sub)", margin: "3px 0" }}>{t}</p>)}
                </div>
              )}
            </Reveal>
          )}
        </>
      )}

      {score && (
        <Reveal summary={`Scores — leverage ${score.leverage} · tractability ${score.tractability} · novelty ${score.novelty}`}>
          {["leverage", "tractability", "novelty"].map((ax) => (
            <div key={ax} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--faint)", marginBottom: 3 }}>
                <span>{ax}</span><span className="t-num">{score[ax]}/10</span>
              </div>
              <p style={{ fontSize: 12.5, color: "var(--sub)", margin: 0, lineHeight: 1.5 }}>{score.reasoning?.[ax]}</p>
            </div>
          ))}
          {score.nearestConsensus && (
            <div style={{ borderLeft: "2px solid var(--brass)", padding: "3px 11px", marginTop: 8 }}>
              <span style={kLabel}>closest thing anyone else asks</span>
              <p style={{ fontSize: 12.5, color: "var(--sub)", margin: "0 0 4px", fontStyle: "italic" }}>“{score.nearestConsensus.text}”</p>
              <p style={{ fontSize: 12.5, margin: 0 }}>{score.nearestConsensus.delta}</p>
            </div>
          )}
        </Reveal>
      )}
    </Card>
  );
}

function EvidenceRow({ c, dim }) {
  return (
    <div style={{ padding: "8px 0", borderTop: "1px solid var(--line)", opacity: dim ? 0.72 : 1 }}>
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55 }}>{c.claim}</p>
      {c.quote && <p style={{ margin: "5px 0 0", fontSize: 11.5, fontStyle: "italic", color: "var(--sub)", borderLeft: "2px solid var(--line)", paddingLeft: 9 }}>“{c.quote}”</p>}
      <div style={{ marginTop: 5 }}>
        <SourceLink url={c.urls[0]} label={c.sourceTitle ? `${c.sourceTitle} · ${hostOf(c.urls[0])}` : hostOf(c.urls[0])} />
        {c.matchTier === "host" && <span style={{ fontSize: 10, color: "var(--faint)" }}>(domain-level citation)</span>}
      </div>
    </div>
  );
}

// Everything that proves the result is honest — one drawer, out of the way.
function ShowTheWork({ a }) {
  const st = a.stages || {};
  const items = st.candidates?.items || [];
  const g = st.gauntlet;
  const survivors = new Set(g?.survivors || []);
  const killed = (g?.kills || []).map((k) => ({ ...k, item: items.find((c) => c.id === k.id), score: (g?.scores || []).find((s) => s.id === k.id) })).filter((k) => k.item);
  const consensusQs = st.consensus?.questions || [];

  return (
    <Card pad="lg" style={{ marginTop: 4 }}>
      <Reveal
        tone="var(--sub)"
        summary={`Show the work — consensus map (${consensusQs.length}), rejected candidates (${killed.length}), routing`}
      >
        {/* consensus map */}
        <div style={{ marginTop: 4 }}>
          <span style={kLabel}>the consensus map — built before any candidate existed</span>
          <p style={{ fontSize: 12.5, color: "var(--sub)", margin: "0 0 8px", lineHeight: 1.55 }}>
            Every question below was treated as burned territory. Survivors had to be demonstrably outside it.
          </p>
          {st.consensus?.searchDegraded && (
            <p style={{ fontSize: 12, color: "var(--brass)", margin: "0 0 8px" }}>
              ⚠ Web grounding was degraded — this map is model-prior only, so novelty scores deserve skepticism.
            </p>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 5 }}>
            {consensusQs.map((q) => (
              <div key={q.id} style={{ fontSize: 11.5, color: "var(--sub)", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 9px", lineHeight: 1.45 }}>{q.text}</div>
            ))}
          </div>
          {(st.consensus?.positions || []).length > 0 && (
            <Reveal summary={`standard positions (${st.consensus.positions.length})`}>
              {st.consensus.positions.map((p, i) => (
                <p key={i} style={{ fontSize: 12.5, color: "var(--sub)", margin: "5px 0", lineHeight: 1.5 }}><b style={{ color: "var(--ink)" }}>{p.topic}:</b> {p.position}</p>
              ))}
            </Reveal>
          )}
        </div>

        {/* graveyard */}
        {killed.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <span style={kLabel}>rejected candidates — {killed.length} of {items.length} generated</span>
            {killed.map((k) => (
              <div key={k.id} style={{ padding: "9px 0", borderTop: "1px solid var(--line)" }}>
                <p style={{ margin: 0, fontSize: 12.5, color: "var(--sub)", lineHeight: 1.5 }}>{k.item.text}</p>
                <div style={{ display: "flex", gap: 7, alignItems: "center", marginTop: 5, flexWrap: "wrap" }}>
                  <Tag tone="var(--red)">{k.phase}</Tag>
                  <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{k.reason}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* routing + receipts */}
        <div style={{ marginTop: 18 }}>
          <span style={kLabel}>routing</span>
          <div style={{ fontSize: 11.5, color: "var(--sub)", lineHeight: 1.7 }}>
            <div>Consensus map · <span className="t-num">{st.consensus?.servedBy}</span></div>
            <div>Candidates · <span className="t-num">{st.candidates?.servedBy}</span> {st.candidates?.fallbackUsed && <Tag tone="var(--red)">fallback</Tag>}</div>
            <div>Gauntlet · <span className="t-num">{g?.servedBy}</span> {g?.fallbackUsed && <Tag tone="var(--red)">fallback</Tag>}</div>
            {st.synthesis && <div>POVs · <span className="t-num">{st.synthesis.servedBy}</span> {st.synthesis.fallbackUsed && <Tag tone="var(--red)">fallback</Tag>}</div>}
          </div>
        </div>
      </Reveal>
    </Card>
  );
}

function UpstreamResult({ run }) {
  const a = run.artifact || { stages: {} };
  const st = a.stages || {};
  const items = st.candidates?.items || [];
  const povById = Object.fromEntries((st.synthesis?.povs || []).map((p) => [p.questionId, p]));
  const diveById = Object.fromEntries((st.dives || []).map((d) => [d.questionId, d]));
  const scoreById = Object.fromEntries((st.gauntlet?.scores || []).map((s) => [s.id, s]));
  const survivors = (st.gauntlet?.survivors || []).map((id) => items.find((c) => c.id === id)).filter(Boolean);
  const boring = a.verdict === "consensus_holds";

  return (
    <>
      {/* the spine — the single sentence answer */}
      {st.synthesis?.runSpine && (
        <Card pad="lg" style={{ marginTop: 12, background: "color-mix(in srgb, var(--brass) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--brass) 25%, transparent)" }}>
          <span style={kLabel}>the spine</span>
          <p style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.45, margin: 0 }}>{st.synthesis.runSpine}</p>
        </Card>
      )}

      {boring && (
        <Card pad="lg" style={{ marginTop: 12, background: "color-mix(in srgb, var(--green) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--green) 30%, transparent)" }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 16 }}>Consensus holds.</p>
          <p style={{ margin: "7px 0 0", fontSize: 13.5, color: "var(--sub)", lineHeight: 1.6 }}>
            Nothing beat the standard questions on leverage, novelty and tractability at the same time.
            On this topic the questions everyone already asks are the right ones — that is a real finding,
            not a failed run. The rejected candidates and why they fell short are under “Show the work”.
          </p>
        </Card>
      )}

      {survivors.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <SectionHeader title={`What you should be asking · ${survivors.length}`} />
          {survivors.map((q, i) => (
            <QuestionCard
              key={q.id} n={i + 1} question={q}
              pov={povById[q.id]} dive={diveById[q.id]} score={scoreById[q.id]}
            />
          ))}
        </div>
      )}

      <ShowTheWork a={a} />
    </>
  );
}

/* ══ NOSTRADAMUS: prediction card ═══════════════════════════════════════════ */

const normalizeArtifactPred = (p, subject) => ({
  id: p.id, kind: p.kind, subject, statement: p.statement,
  resolution_date: p.resolutionDate, resolution_criterion: p.resolutionCriterion,
  confidence: p.confidence, causal_chain: p.causalChain, tell: p.tell,
  consensus_counterpart: p.consensusCounterpart, delta: p.delta,
  why_consensus_misses: p.whyConsensusMisses, status: "open", tellChecks: [],
});

function PredictionCard({ p, actions }) {
  const [note, setNote] = useState("");
  const [resolving, setResolving] = useState(false);
  const days = p.resolution_date ? daysUntil(p.resolution_date) : null;
  const last = p.tellChecks?.length ? p.tellChecks[p.tellChecks.length - 1] : null;
  const sigTone = { none: "var(--faint)", early: "var(--brass)", strong: "var(--green)", contra: "var(--red)" };
  const statusTone = { open: "var(--faint)", correct: "var(--green)", wrong: "var(--red)", void: "var(--faint)" };
  const yrs = days != null ? (days / 365).toFixed(1) : null;

  return (
    <Card pad="lg" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <Tag tone={p.kind === "bold" ? "var(--brass)" : "var(--green)"}>{p.kind === "bold" ? "bold call" : "consensus affirmed"}</Tag>
        {p.status && p.status !== "open" && <Tag tone={statusTone[p.status]}>{p.status}</Tag>}
        {last && <Tag tone={sigTone[last.signal]}>tell: {last.signal}</Tag>}
      </div>

      {/* the claim */}
      <p style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.45, margin: "0 0 14px" }}>{p.statement}</p>

      {/* when + how sure — the two numbers that matter */}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <span style={kLabel}>resolves</span>
          <span className="t-num" style={{ fontSize: 14, fontWeight: 600 }}>{p.resolution_date}</span>
          {days != null && p.status === "open" && (
            <span style={{ fontSize: 11.5, color: "var(--faint)", marginLeft: 7 }}>
              {days > 0 ? `${yrs}y out` : `${-days}d overdue`}
            </span>
          )}
        </div>
        <div>
          <span style={kLabel}>confidence</span>
          <ConfBar value={p.confidence} />
        </div>
      </div>

      {/* THE TELL — the actionable part, so it gets its own block */}
      <div style={{
        marginTop: 14, padding: "12px 14px", borderRadius: 11,
        background: "color-mix(in srgb, var(--brass) 7%, transparent)",
        border: "1px solid color-mix(in srgb, var(--brass) 22%, transparent)",
      }}>
        <span style={kLabel}>the tell — the earliest thing you could go check</span>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>{p.tell?.observable}</p>
        <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--sub)" }}>
          <span style={{ color: "var(--faint)" }}>Where: </span>{p.tell?.whereToLook}
        </p>
        {last && (
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--sub)", paddingTop: 8, borderTop: "1px solid var(--line)" }}>
            <b style={{ color: sigTone[last.signal] }}>{last.signal.toUpperCase()}</b> — {last.summary}{" "}
            {(last.evidence || []).map((e) => <SourceLink key={e.url} url={e.url} />)}
          </p>
        )}
      </div>

      <Reveal summary="The reasoning — causal chain, what consensus says, why it misses">
        <div style={{ marginBottom: 12 }}>
          <span style={kLabel}>what has to happen first, in order</span>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {(p.causal_chain || []).map((s, i) => (
              <li key={i} style={{ fontSize: 12.5, color: "var(--sub)", margin: "4px 0", lineHeight: 1.5 }}>{s}</li>
            ))}
          </ol>
        </div>
        <div style={{ marginBottom: 12 }}>
          <span style={kLabel}>consensus says</span>
          <p style={{ fontSize: 12.5, margin: 0, lineHeight: 1.55, color: "var(--sub)" }}>{p.consensus_counterpart?.position}</p>
          <div style={{ marginTop: 5 }}>
            {(p.consensus_counterpart?.urls || []).map((u) => <SourceLink key={u} url={u} />)}
          </div>
        </div>
        {p.kind === "bold" && p.delta && (
          <div style={{ marginBottom: 4 }}>
            <span style={kLabel}>how far outside that this is</span>
            <p style={{ fontSize: 12.5, margin: 0, lineHeight: 1.55 }}>{p.delta}</p>
          </div>
        )}
        <Mechanism mech={p.why_consensus_misses} />
        <div style={{ marginTop: 12 }}>
          <span style={kLabel}>resolution criterion</span>
          <p style={{ fontSize: 12, margin: 0, color: "var(--sub)", lineHeight: 1.55 }}>{p.resolution_criterion}</p>
        </div>
      </Reveal>

      {actions && p.status === "open" && (
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
          <Button kind="quiet" size="md" disabled={actions.checking === p.id} onClick={() => actions.onCheckTell(p.id)}>
            {actions.checking === p.id ? <><Spinner size={12} /> checking…</> : "Check the tell"}
          </Button>
          <Button kind="quiet" size="md" onClick={() => setResolving(!resolving)}>Resolve…</Button>
          {resolving && (
            <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <Field value={note} onChange={(e) => setNote(e.target.value)} placeholder="note" style={{ width: 150 }} />
              <Button kind="quiet" size="md" style={{ color: "var(--green)" }} onClick={() => actions.onResolve(p.id, "correct", note)}>correct</Button>
              <Button kind="quiet" size="md" style={{ color: "var(--red)" }} onClick={() => actions.onResolve(p.id, "wrong", note)}>wrong</Button>
              <Button kind="quiet" size="md" onClick={() => actions.onResolve(p.id, "void", note)}>void</Button>
            </span>
          )}
        </div>
      )}
      {p.status !== "open" && p.resolution_note && (
        <p style={{ marginTop: 10, fontSize: 12.5, color: "var(--sub)" }}>
          <span style={{ color: "var(--faint)" }}>Resolution note: </span>{p.resolution_note}
        </p>
      )}
    </Card>
  );
}

function NostradamusResult({ run }) {
  const a = run.artifact || { stages: {} };
  const st = a.stages || {};
  return (
    <>
      {st.subject && (
        <Card pad="lg" style={{ marginTop: 12 }}>
          <span style={kLabel}>it chose this subject</span>
          <p style={{ fontSize: 15.5, fontWeight: 700, lineHeight: 1.45, margin: "0 0 8px" }}>{st.subject.subject}</p>
          <p style={{ fontSize: 13, color: "var(--sub)", margin: 0, lineHeight: 1.6 }}>{st.subject.whyItMatters}</p>
        </Card>
      )}

      {(st.predictions?.shipped || []).length > 0 && (
        <div style={{ marginTop: 16 }}>
          <SectionHeader title={`Predictions · ${st.predictions.shipped.length}`} />
          {st.predictions.shipped.map((p) => <PredictionCard key={p.id} p={normalizeArtifactPred(p, a.domain)} />)}
        </div>
      )}

      <Card pad="lg" style={{ marginTop: 4 }}>
        <Reveal tone="var(--sub)" summary={`Show the work — consensus future (${(st.consensusFuture?.claims || []).length} cited), rejected predictions (${(st.predictions?.rejected || []).length})`}>
          {(st.consensusFuture?.claims || []).length > 0 && (
            <div>
              <span style={kLabel}>the consensus future it had to beat</span>
              {st.consensusFuture.claims.map((c) => (
                <div key={c.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                  <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
                    {c.horizon && <Tag tone="var(--faint)">{c.horizon}</Tag>} {c.claim}
                  </p>
                  <div style={{ marginTop: 4 }}><SourceLink url={c.urls[0]} /></div>
                </div>
              ))}
            </div>
          )}
          {(st.predictions?.rejected || []).length > 0 && (
            <div style={{ marginTop: 16 }}>
              <span style={kLabel}>rejected at the ship gates</span>
              {st.predictions.rejected.map((r, i) => (
                <div key={i} style={{ padding: "7px 0", borderTop: "1px solid var(--line)" }}>
                  <p style={{ margin: 0, fontSize: 12.5, color: "var(--sub)" }}>{String(r.statement).slice(0, 140)}</p>
                  <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--red)" }}>{r.problems.join("; ")}</p>
                </div>
              ))}
            </div>
          )}
          {st.subject?.altitudeCheck && (
            <div style={{ marginTop: 16 }}>
              <span style={kLabel}>altitude check</span>
              <p style={{ fontSize: 12.5, color: "var(--sub)", margin: 0, lineHeight: 1.55 }}>{st.subject.altitudeCheck}</p>
            </div>
          )}
        </Reveal>
      </Card>
    </>
  );
}

/* ══ run shell (header, rail, failure, receipts) ════════════════════════════ */

export function RunView({ run }) {
  const a = run.artifact || { stages: {} };
  const isNos = run.surface === "nostradamus";
  const running = run.status === "running";
  const [, force] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const stages = isNos ? NOS_STAGES : UP_STAGES;
  const liveLabel = (() => {
    const st = a.stages || {};
    for (let i = stages.length - 1; i >= 0; i--) {
      const k = stages[i].key;
      const present = k === "dives" ? (st.dives || []).length > 0 : Boolean(st[k]);
      if (present) return stages[Math.min(i + 1, stages.length - 1)].label;
    }
    return stages[0].label;
  })();

  return (
    <div>
      <Card pad="lg" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1, minWidth: 200, lineHeight: 1.4 }}>
            {run.domain || (isNos ? "choosing a subject…" : "run")}
          </span>
          <RunBadge run={run} />
          <span className="t-num" style={{ fontSize: 11.5, color: "var(--faint)" }}>
            {running ? `${fmtDuration(Date.now() - new Date(run.started_at).getTime())} elapsed` : fmtDuration(run.duration_ms)}
          </span>
        </div>
        <StageRail stages={stages} artifact={a} run={run} />
        {running && (
          <p style={{ fontSize: 12.5, color: "var(--sub)", margin: "10px 0 0" }}>
            <Spinner size={12} /> Working on <b>{liveLabel}</b>. Runs take 5–8 minutes; results appear here as each stage lands — you can leave and come back.
          </p>
        )}
        {run.status === "failed" && (
          <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 11, border: "1px solid color-mix(in srgb, var(--red) 32%, transparent)", background: "color-mix(in srgb, var(--red) 7%, transparent)" }}>
            <p style={{ margin: 0, fontSize: 13.5, fontWeight: 700 }}>Stopped at {a.failure?.stage || "an unknown stage"}</p>
            <p style={{ margin: "5px 0 0", fontSize: 12.5, color: "var(--sub)", lineHeight: 1.55 }}>
              {a.failure?.reason || run.error}
            </p>
            <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--faint)" }}>
              Nothing was invented to cover the gap — whatever completed is shown below.
            </p>
          </div>
        )}
        {a.usageTotal && (
          <div className="t-num" style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 10.5, color: "var(--faint)", marginTop: 12 }}>
            <span>{Math.round((a.durationMs || 0) / 1000)}s</span>
            <span>{a.usageTotal.searches || 0} searches</span>
            <span>${Number(a.usageTotal.estCostUsd || 0).toFixed(2)}</span>
          </div>
        )}
      </Card>
      {isNos ? <NostradamusResult run={run} /> : <UpstreamResult run={run} />}
    </div>
  );
}

/* ══ page ═══════════════════════════════════════════════════════════════════ */

export function UpstreamPage({ isMobile }) {
  const [tab, setTab] = useState("engine");
  return (
    <div style={{ padding: isMobile ? "0 14px 14px" : "0 4px 8px" }}>
      <Segmented
        options={[{ key: "engine", label: "Question Engine" }, { key: "nostradamus", label: "Nostradamus" }]}
        value={tab} onChange={setTab} style={{ maxWidth: 420, marginBottom: 14 }}
      />
      {tab === "engine" ? <EngineTab /> : <NostradamusTab />}
    </div>
  );
}

function useRunPolling(runId, onDone) {
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);
  const doneRef = useRef(false);
  useEffect(() => {
    if (!runId) { setRun(null); return undefined; }
    doneRef.current = false;
    let timer = null;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetchRun(runId);
        if (cancelled) return;
        setErr(null);
        if (r) setRun(r);
        if (r && r.status !== "running") {
          if (!doneRef.current) { doneRef.current = true; onDone?.(r); }
          return;
        }
      } catch (e) { if (!cancelled) setErr(e.message); }
      timer = setTimeout(tick, 3000);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { run, err };
}

const EXAMPLES = ["the future of baseball", "US grid buildout under AI datacenter load", "GLP-1 drugs and the food industry"];

function EngineTab() {
  const [domain, setDomain] = useState("");
  const [runs, setRuns] = useState(null);
  const [listErr, setListErr] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [launching, setLaunching] = useState(false);
  const [launchErr, setLaunchErr] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const loadRuns = useCallback(() => {
    setListErr(null);
    fetchRuns("upstream").then((rs) => {
      setRuns(rs);
      // Always land on something useful: newest run, unless the user picked one.
      setSelectedId((cur) => cur || rs[0]?.id || null);
    }).catch((e) => setListErr(e.message));
  }, []);
  useEffect(loadRuns, [loadRuns]);

  const { run: selectedRun } = useRunPolling(selectedId, loadRuns);
  const active = runs?.some((r) => r.status === "running") || selectedRun?.status === "running";

  const launch = async () => {
    const d = domain.trim();
    if (d.length < 3) { setLaunchErr("Give it a real domain or situation."); return; }
    setLaunching(true); setLaunchErr(null);
    try {
      const runId = await startJob("upstream", { domain: d });
      setSelectedId(runId);
      setDomain("");
      setTimeout(loadRuns, 1500);
    } catch (e) { setLaunchErr(e.message); }
    setLaunching(false);
  };

  return (
    <>
      <Card pad="lg">
        <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 15.5 }}>What should you actually be asking?</p>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--sub)", lineHeight: 1.6 }}>
          Name a domain. It maps what everyone already asks, then finds the 2–3 questions that are
          non-obvious <i>and</i> load-bearing, researches them against live sources, and takes a position
          on each. If the standard questions are already the right ones, it says so.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Field value={domain} onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") launch(); }}
            placeholder="a domain or situation…" style={{ flex: 1, minWidth: 200 }} />
          <Button kind="primary" size="lg" disabled={launching || active} onClick={launch}>
            {launching ? <><Spinner size={13} /> starting…</> : active ? "run in progress" : "Run"}
          </Button>
        </div>
        {!active && !launching && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {EXAMPLES.map((ex) => (
              <button key={ex} onClick={() => setDomain(ex)} style={{
                background: "none", border: "1px solid var(--line)", borderRadius: 99,
                padding: "4px 11px", fontSize: 11.5, color: "var(--sub)", cursor: "pointer",
              }}>{ex}</button>
            ))}
          </div>
        )}
        {launchErr && <p style={{ color: "var(--red)", fontSize: 12.5, margin: "8px 0 0" }}>{launchErr}</p>}
      </Card>

      {listErr && (
        <Card style={{ marginTop: 12 }}>
          <p style={{ color: "var(--red)", fontSize: 13, margin: 0 }}>{listErr}</p>
          <Button kind="quiet" size="md" onClick={loadRuns} style={{ marginTop: 8 }}>Retry</Button>
        </Card>
      )}

      {selectedRun && <RunView run={selectedRun} />}
      {selectedId && !selectedRun && !listErr && (
        <Card pad="lg" style={{ marginTop: 12 }}><Spinner size={14} /> <span style={{ fontSize: 13, color: "var(--sub)" }}>loading…</span></Card>
      )}
      {runs && runs.length === 0 && !listErr && (
        <EmptyState icon={<IcSearch size={20} />} title="Nothing run yet"
          sub="Name a domain above. First run maps the consensus, kills the obvious questions, and researches what survives — about 6 minutes." />
      )}

      {runs && runs.length > 1 && (
        <div style={{ marginTop: 18 }}>
          <SectionHeader title="Earlier runs" trailing={
            <Button kind="quiet" size="md" onClick={() => setShowHistory(!showHistory)}>{showHistory ? "hide" : `show ${runs.length - 1}`}</Button>
          } />
          {showHistory && (
            <CellGroup>
              {runs.filter((r) => r.id !== selectedId).map((r) => (
                <Cell key={r.id} title={r.domain || "(run)"}
                  sub={`${fmtDuration(r.duration_ms)} · ${new Date(r.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  trailing={<RunBadge run={r} />} chevron onClick={() => { setSelectedId(r.id); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
              ))}
            </CellGroup>
          )}
        </div>
      )}
    </>
  );
}

function NostradamusTab() {
  const [preds, setPreds] = useState(null);
  const [consults, setConsults] = useState(null);
  const [err, setErr] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [launching, setLaunching] = useState(false);
  const [checking, setChecking] = useState(null);
  const [showConsults, setShowConsults] = useState(false);
  const checkTimer = useRef(null);

  const load = useCallback(() => {
    setErr(null);
    Promise.all([fetchPredictions(), fetchRuns("nostradamus")])
      .then(([p, c]) => { setPreds(p); setConsults(c); })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); return () => clearTimeout(checkTimer.current); }, [load]);

  const { run: selectedRun } = useRunPolling(selectedId, load);
  const active = consults?.some((r) => r.status === "running") || selectedRun?.status === "running";

  const consult = async () => {
    setLaunching(true); setErr(null);
    try {
      const runId = await startJob("nostradamus");
      setSelectedId(runId);
      setTimeout(load, 1500);
    } catch (e) { setErr(e.message); }
    setLaunching(false);
  };

  const onCheckTell = async (id) => {
    setChecking(id);
    try {
      await startJob("tell_check", { predictionId: id });
      const before = (preds.find((p) => p.id === id)?.tellChecks || []).length;
      let waited = 0;
      const poll = async () => {
        waited += 6000;
        const fresh = await fetchPredictions().catch(() => null);
        if (fresh) {
          setPreds(fresh);
          if ((fresh.find((p) => p.id === id)?.tellChecks || []).length > before) { setChecking(null); return; }
        }
        if (waited >= 240000) { setChecking(null); setErr("Tell check timed out — see Systems → usage."); return; }
        checkTimer.current = setTimeout(poll, 6000);
      };
      checkTimer.current = setTimeout(poll, 8000);
    } catch (e) { setErr(e.message); setChecking(null); }
  };

  const onResolve = async (id, status, note) => {
    try { await resolvePrediction(id, status, note); load(); } catch (e) { setErr(e.message); }
  };

  const cal = preds ? calibration(preds) : null;
  const open = (preds || []).filter((p) => p.status === "open");
  const closed = (preds || []).filter((p) => p.status !== "open");

  // Group open predictions by subject so the long subject line appears once, not per card.
  const grouped = useMemo(() => {
    const by = new Map();
    for (const p of open) {
      if (!by.has(p.subject)) by.set(p.subject, []);
      by.get(p.subject).push(p);
    }
    return [...by.entries()];
  }, [open]);

  return (
    <>
      <Card pad="lg">
        <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 15.5 }}>Nostradamus</p>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--sub)", lineHeight: 1.6 }}>
          It picks its own subject at civilizational scale, maps what mainstream forecasts expect, and
          only ships predictions measurably outside that — each one dated, with the earliest signal you
          could go check yourself. Everything here gets scored as reality lands.
        </p>
        <Button kind="primary" size="lg" disabled={launching || active} onClick={consult}>
          {launching ? <><Spinner size={13} /> consulting…</> : active ? "consult in progress" : "Consult"}
        </Button>
      </Card>

      {err && (
        <Card style={{ marginTop: 12 }}>
          <p style={{ color: "var(--red)", fontSize: 13, margin: 0 }}>{err}</p>
          <Button kind="quiet" size="md" onClick={load} style={{ marginTop: 8 }}>Retry</Button>
        </Card>
      )}

      {selectedRun && selectedRun.status === "running" && <RunView run={selectedRun} />}

      {cal && cal.total > 0 && (
        <div style={{ marginTop: 18 }}>
          <SectionHeader title="Track record" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10 }}>
            <StatTile value={String(cal.open)} label="open" />
            <StatTile value={String(cal.resolved)} label="resolved" />
            <StatTile value={cal.brier == null ? "—" : String(cal.brier)} label="brier score" />
          </div>
          {cal.resolved === 0 && (
            <p style={{ fontSize: 12.5, color: "var(--sub)", margin: "8px 0 0", lineHeight: 1.55 }}>
              Nothing has resolved yet — the first dates are years out. Until then, “check the tell” is how
              you find out early whether a call is tracking.
            </p>
          )}
        </div>
      )}

      {preds == null && !err && <Card style={{ marginTop: 12 }}><Spinner size={14} /></Card>}
      {preds != null && open.length === 0 && (
        <EmptyState style={{ marginTop: 12 }} title="No predictions on the record yet"
          sub="Consult — it picks a subject, maps the consensus future, and puts dated calls on the record." />
      )}

      {grouped.map(([subject, items]) => (
        <div key={subject} style={{ marginTop: 18 }}>
          <div style={{ marginBottom: 10 }}>
            <span style={kLabel}>on the subject of</span>
            <p style={{ fontSize: 13, color: "var(--sub)", margin: 0, lineHeight: 1.55 }}>{subject}</p>
          </div>
          {items.map((p) => <PredictionCard key={p.id} p={p} actions={{ onCheckTell, onResolve, checking }} />)}
        </div>
      ))}

      {closed.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <SectionHeader title={`Resolved · ${closed.length}`} />
          {closed.map((p) => <PredictionCard key={p.id} p={p} />)}
        </div>
      )}

      {consults && consults.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <SectionHeader title="Consults" trailing={
            <Button kind="quiet" size="md" onClick={() => setShowConsults(!showConsults)}>{showConsults ? "hide" : `show ${consults.length}`}</Button>
          } />
          {showConsults && (
            <CellGroup>
              {consults.map((r) => (
                <Cell key={r.id} title={r.domain || "(subject not reached)"}
                  sub={`${fmtDuration(r.duration_ms)} · ${new Date(r.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  trailing={<RunBadge run={r} />} chevron onClick={() => setSelectedId(r.id)} />
              ))}
            </CellGroup>
          )}
          {showConsults && selectedRun && selectedRun.status !== "running" && <RunView run={selectedRun} />}
        </div>
      )}
    </>
  );
}
