// ─── Upstream — the question engine + NOSTRADAMUS, native ─────────────────────
// Two surfaces on one engine, running in the upstream-run-background function
// (≤8-minute pipeline) with all state in Supabase. This page is the audit trail:
// the consensus artifact is shown BEFORE the candidates it burned, every killed
// candidate carries its phase + reason + overlap numbers, every claim carries a
// live-fetched citation, and the boring verdict renders as a win. Predictions
// persist to a ledger and get scored as reality lands.
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, StatTile, Button, Segmented, Field,
  Dot, EmptyState, Spinner,
} from "../../ui/kit.jsx";
import { IcRefresh, IcChevronDown, IcExternal } from "../../ui/icons.jsx";
import {
  startJob, fetchRuns, fetchRun, fetchPredictions, resolvePrediction,
  calibration, fmtDuration, daysUntil, hostOf,
} from "../../lib/upstream.js";

/* ── small shared pieces ────────────────────────────────────────────────────── */

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
      fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
      color: tone, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)`,
      background: `color-mix(in srgb, ${tone} 10%, transparent)`,
      borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function RunBadge({ run }) {
  if (run.status === "running") return <Tag tone="var(--brass)">RUNNING</Tag>;
  const v = VERDICT[run.verdict] || { tone: "var(--faint)", label: (run.status || "—").toUpperCase() };
  return <Tag tone={v.tone}>{v.label}</Tag>;
}

function Reveal({ summary, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(!open)} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--faint)", fontSize: 11.5 }}>
        <IcChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms" }} /> {summary}
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

const kLabel = { fontSize: 10, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--faint)", display: "block", marginBottom: 3 };

function StageRail({ stages, artifact, run }) {
  const st = artifact?.stages || {};
  const statusOf = (key, idx) => {
    const present = key === "dives" ? (st.dives || []).length > 0 : Boolean(st[key]);
    if (present) return run.status === "failed" && artifact?.failure?.stage === key ? "fail" : "done";
    if (run.status === "failed") return artifact?.failure?.stage === key ? "fail" : "idle";
    if (run.status === "running") {
      const prevPresent = idx === 0 || Boolean(st[stages[idx - 1].key]) || (stages[idx - 1].key === "dives" && (st.dives || []).length);
      return prevPresent ? "run" : "idle";
    }
    return "idle";
  };
  const tone = { done: "var(--green)", run: "var(--brass)", fail: "var(--red)", idle: "var(--ink-a18, var(--faint))" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "10px 0 4px" }}>
      {stages.map((s, i) => {
        const state = statusOf(s.key, i);
        return (
          <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {i > 0 && <span style={{ width: 18, height: 1, background: "var(--line)" }} />}
            <Dot tone={tone[state]} pulse={state === "run"} size={8} />
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: state === "idle" ? "var(--faint)" : "var(--ink)" }}>{s.label}</span>
          </span>
        );
      })}
    </div>
  );
}

function Conf({ value }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 90, height: 5, borderRadius: 99, background: "var(--line)", overflow: "hidden", display: "inline-block" }}>
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--brass)" }} />
      </span>
      <span className="t-num" style={{ fontSize: 13, color: "var(--brass)", fontWeight: 700 }}>{pct}%</span>
    </span>
  );
}

function Mechanism({ mech }) {
  if (!mech?.type) return null;
  if (mech.type === "none_consensus_correct") {
    return <div style={{ marginTop: 10 }}><span style={kLabel}>error mechanism</span><span style={{ fontSize: 13, color: "var(--green)" }}>none — consensus is correct here, and that is the finding</span></div>;
  }
  return (
    <div style={{ marginTop: 10 }}>
      <span style={kLabel}>why smart people believe otherwise</span>
      <span style={{ fontSize: 13 }}><Tag tone="var(--brass)">{mech.type.replace(/_/g, " ")}</Tag>{" "}<b>{mech.who}</b> — {mech.why}</span>
    </div>
  );
}

/* ── run detail (both surfaces) ─────────────────────────────────────────────── */

const UP_STAGES = [
  { key: "consensus", label: "Consensus" }, { key: "candidates", label: "Candidates" },
  { key: "gauntlet", label: "Gauntlet" }, { key: "dives", label: "Dives" }, { key: "synthesis", label: "POVs" },
];
const NOS_STAGES = [
  { key: "subject", label: "Subject" }, { key: "consensusFuture", label: "Consensus Future" }, { key: "predictions", label: "Predictions" },
];

function RunDetail({ run }) {
  const a = run.artifact || { stages: {} };
  const isNos = run.surface === "nostradamus";
  return (
    <Card pad="lg" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 16.5, fontWeight: 700, flex: 1, minWidth: 200 }}>{run.domain || (isNos ? "choosing a subject…" : "run")}</span>
        <RunBadge run={run} />
        <span className="t-num" style={{ fontSize: 11.5, color: "var(--faint)" }}>
          {run.status === "running" ? `${fmtDuration(Date.now() - new Date(run.started_at).getTime())} · live` : fmtDuration(run.duration_ms)}
        </span>
      </div>
      <StageRail stages={isNos ? NOS_STAGES : UP_STAGES} artifact={a} run={run} />
      {run.status === "failed" && (
        <div style={{ border: "1px solid color-mix(in srgb, var(--red) 35%, transparent)", background: "color-mix(in srgb, var(--red) 8%, transparent)", borderRadius: 12, padding: "12px 15px", margin: "10px 0" }}>
          <b>Failed loudly</b> — <b>{a.failure?.stage || "unknown stage"}</b>: {a.failure?.reason || run.error}. Nothing was faked to cover it; the sections below are what completed.
        </div>
      )}
      {isNos ? <NosBody a={a} /> : <UpBody a={a} />}
      {a.usageTotal && (
        <div className="t-num" style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11, color: "var(--faint)", marginTop: 16 }}>
          <span>{Math.round((a.durationMs || 0) / 1000)}s wall</span>
          <span>{(a.usageTotal.inputTokens || 0).toLocaleString()} in / {(a.usageTotal.outputTokens || 0).toLocaleString()} out</span>
          <span>{a.usageTotal.searches || 0} searches</span>
          <span>≈ ${Number(a.usageTotal.estCostUsd || 0).toFixed(2)}</span>
        </div>
      )}
    </Card>
  );
}

function SectionTitle({ children, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "18px 0 8px" }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)" }}>{children}</span>
      {right}
    </div>
  );
}

function UpBody({ a }) {
  const st = a.stages || {};
  const items = st.candidates?.items || [];
  const g = st.gauntlet;
  const survivors = new Set(g?.survivors || []);
  const killById = Object.fromEntries((g?.kills || []).map((k) => [k.id, k]));
  const scoreById = Object.fromEntries((g?.scores || []).map((s) => [s.id, s]));
  const ordered = [...items].sort((x, y) => (survivors.has(y.id) ? 1 : 0) - (survivors.has(x.id) ? 1 : 0));

  return (
    <>
      {st.consensus && (
        <>
          <SectionTitle right={<Tag tone="var(--sub)">{st.consensus.questions.length} questions</Tag>}>Consensus artifact — emitted before any candidate existed</SectionTitle>
          {st.consensus.searchDegraded && <div style={{ fontSize: 12, color: "var(--brass)", marginBottom: 6 }}>⚠ web grounding degraded — artifact is model-prior only; read novelty skeptically</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
            {st.consensus.questions.slice(0, 12).map((q) => (
              <div key={q.id} style={{ fontSize: 12, color: "var(--sub)", border: "1px solid var(--line)", borderRadius: 9, padding: "7px 10px" }}>
                <span style={{ fontSize: 9, color: "var(--faint)", textTransform: "uppercase", marginRight: 6 }}>{q.source}</span>{q.text}
              </div>
            ))}
          </div>
          {st.consensus.questions.length > 12 && (
            <Reveal summary={`show all ${st.consensus.questions.length} questions + standard positions`}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
                {st.consensus.questions.slice(12).map((q) => (
                  <div key={q.id} style={{ fontSize: 12, color: "var(--sub)", border: "1px solid var(--line)", borderRadius: 9, padding: "7px 10px" }}>{q.text}</div>
                ))}
              </div>
              {(st.consensus.positions || []).map((p, i) => <p key={i} style={{ fontSize: 12.5, color: "var(--sub)", margin: "8px 0 0" }}><b>{p.topic}:</b> {p.position}</p>)}
            </Reveal>
          )}
        </>
      )}

      {items.length > 0 && g && (
        <>
          <SectionTitle right={<>
            <Tag tone="var(--sub)">{g.survivors.length} of {items.length} survive</Tag>
            {(st.candidates.fallbackUsed || g.fallbackUsed) && <Tag tone="var(--red)">FALLBACK SERVED A PROTECTED STAGE</Tag>}
          </>}>The gauntlet</SectionTitle>
          {ordered.map((c) => {
            const alive = survivors.has(c.id);
            const kill = killById[c.id];
            const score = scoreById[c.id];
            return (
              <div key={c.id} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "11px 14px", margin: "7px 0", opacity: alive ? 1 : 0.62 }}>
                <p style={{ margin: "0 0 6px", fontSize: 14 }}>{c.text}</p>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Tag tone={alive ? "var(--green)" : "var(--red)"}>{alive ? "→ DEEP DIVE" : `KILLED · ${kill?.phase || "?"}`}</Tag>
                  <Tag tone="var(--faint)">{c.strategy}</Tag>
                </div>
                {!alive && kill && <p style={{ fontSize: 12.5, color: "var(--sub)", margin: "6px 0 0" }}>{kill.reason}</p>}
                {score && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 10 }}>
                    {["leverage", "tractability", "novelty"].map((ax) => (
                      <div key={ax}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--faint)", marginBottom: 3 }}>
                          <span>{ax}</span><span className="t-num">{score[ax]}/10</span>
                        </div>
                        <div style={{ height: 4, borderRadius: 99, background: "var(--line)", overflow: "hidden" }}>
                          <div style={{ width: `${score[ax] * 10}%`, height: "100%", background: score[ax] >= (g.thresholds?.[ax] ?? 7) ? "var(--brass)" : "var(--red)" }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {score?.nearestConsensus && (
                  <div style={{ borderLeft: "2px solid var(--brass)", padding: "3px 10px", marginTop: 9, fontSize: 12.5, color: "var(--sub)" }}>
                    nearest consensus: “{score.nearestConsensus.text}” — <b style={{ color: "var(--ink)" }}>{score.nearestConsensus.delta}</b>
                  </div>
                )}
                {score && (
                  <Reveal summary="scoring reasoning">
                    {["leverage", "tractability", "novelty"].map((ax) => <p key={ax} style={{ fontSize: 12.5, color: "var(--sub)", margin: "4px 0" }}><b>{ax}:</b> {score.reasoning?.[ax]}</p>)}
                  </Reveal>
                )}
              </div>
            );
          })}
        </>
      )}

      {a.verdict === "consensus_holds" && (
        <div style={{ border: "1px solid color-mix(in srgb, var(--green) 35%, transparent)", background: "color-mix(in srgb, var(--green) 8%, transparent)", borderRadius: 14, padding: "16px 18px", margin: "14px 0" }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>Consensus holds.</p>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--sub)" }}>
            No candidate beat the consensus artifact on leverage, novelty and tractability at once.
            On this topic the questions everyone asks are the right ones — a finding, not a failure.
          </p>
        </div>
      )}

      {(st.dives || []).length > 0 && (
        <>
          <SectionTitle right={<Tag tone="var(--sub)">live-fetched sources only</Tag>}>Deep dives</SectionTitle>
          {st.dives.map((d) => {
            const q = items.find((c) => c.id === d.questionId);
            return (
              <div key={d.questionId} style={{ margin: "0 0 16px" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                  <b style={{ fontSize: 13.5 }}>{q?.text || d.question}</b>
                  <Tag tone={d.status === "ok" ? "var(--green)" : "var(--red)"}>{d.status === "ok" ? `${d.claims.length} cited claims` : "DIVE FAILED"}</Tag>
                  <Tag tone="var(--faint)">{d.searchCount} searches</Tag>
                </div>
                {d.status !== "ok" && <p style={{ fontSize: 12.5, color: "var(--red)", margin: "4px 0" }}>{d.failReason}</p>}
                {d.claims.map((cl) => (
                  <div key={cl.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "9px 12px", margin: "6px 0" }}>
                    <p style={{ margin: 0, fontSize: 13 }}><Tag tone="var(--faint)">{cl.id}</Tag> {cl.claim}</p>
                    {cl.quote && <p style={{ margin: "5px 0 0", fontSize: 11.5, fontStyle: "italic", color: "var(--sub)", borderLeft: "2px solid var(--line)", paddingLeft: 8 }}>“{cl.quote}”</p>}
                    <a href={cl.urls[0]} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--brass)", display: "inline-flex", alignItems: "center", gap: 4, marginTop: 5 }}>
                      <IcExternal size={11} /> {cl.sourceTitle || hostOf(cl.urls[0])} · {hostOf(cl.urls[0])}
                    </a>
                  </div>
                ))}
                {(d.rejectedClaims || []).length > 0 && (
                  <Reveal summary={`${d.rejectedClaims.length} claims rejected (no live citation)`}>
                    {d.rejectedClaims.map((r, i) => <p key={i} style={{ fontSize: 12, color: "var(--faint)", margin: "3px 0" }}>✕ {r.claim} — {r.reason}</p>)}
                  </Reveal>
                )}
              </div>
            );
          })}
        </>
      )}

      {st.synthesis && (
        <>
          <SectionTitle right={st.synthesis.fallbackUsed ? <Tag tone="var(--red)">FALLBACK SERVED A PROTECTED STAGE</Tag> : null}>The POVs</SectionTitle>
          {st.synthesis.runSpine && (
            <p style={{ fontStyle: "italic", fontSize: 15, borderLeft: "3px solid var(--brass)", padding: "4px 14px", margin: "4px 0 12px" }}>{st.synthesis.runSpine}</p>
          )}
          {st.synthesis.povs.map((p) => {
            const q = items.find((c) => c.id === p.questionId);
            const dive = (st.dives || []).find((d) => d.questionId === p.questionId);
            return (
              <div key={p.questionId} style={{ border: "1px solid var(--line-strong, var(--line))", borderRadius: 14, padding: "15px 17px", margin: "10px 0" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <Tag tone={p.verdict === "contrarian" ? "var(--brass)" : "var(--green)"}>{p.verdict === "contrarian" ? "CONTRARIAN" : "CONSENSUS CORRECT"}</Tag>
                  <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{q?.text}</span>
                </div>
                <p style={{ fontSize: 16.5, fontWeight: 700, lineHeight: 1.35, margin: "10px 0 12px" }}>{p.spine}</p>
                <div><span style={kLabel}>falsifiable claim</span><span style={{ fontSize: 13 }}>{p.falsifiableClaim}</span></div>
                <div style={{ marginTop: 10 }}><span style={kLabel}>confidence</span><Conf value={p.confidence} /></div>
                <div style={{ marginTop: 10 }}><span style={kLabel}>this dies if</span><span style={{ fontSize: 13 }}>{p.falsifier}</span></div>
                <Mechanism mech={p.errorMechanism} />
                <div style={{ marginTop: 10 }}>
                  <span style={kLabel}>load-bearing evidence</span>
                  {(p.citedClaimIds || []).map((cid) => {
                    const cl = dive?.claims.find((c) => c.id === cid);
                    return cl
                      ? <a key={cid} href={cl.urls[0]} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: "var(--brass)", marginRight: 10 }}>{cid} · {hostOf(cl.urls[0])}</a>
                      : <span key={cid} style={{ fontSize: 11.5, color: "var(--faint)", marginRight: 10 }}>{cid}</span>;
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

function NosBody({ a }) {
  const st = a.stages || {};
  return (
    <>
      {st.subject && (
        <>
          <SectionTitle>Subject — self-selected</SectionTitle>
          <p style={{ margin: 0, fontSize: 14.5 }}><b>{st.subject.subject}</b></p>
          <p style={{ margin: "5px 0 0", fontSize: 13, color: "var(--sub)" }}>{st.subject.whyItMatters}</p>
          <Reveal summary="altitude check · avoided subjects">
            <p style={{ fontSize: 12.5, color: "var(--sub)", margin: "4px 0" }}>{st.subject.altitudeCheck}</p>
            {(st.subject.avoidedSubjects || []).length > 0 && <p style={{ fontSize: 12, color: "var(--faint)", margin: "4px 0" }}>avoided: {st.subject.avoidedSubjects.join(" · ")}</p>}
          </Reveal>
        </>
      )}
      {st.consensusFuture && (
        <>
          <SectionTitle right={<Tag tone="var(--sub)">{st.consensusFuture.claims.length} cited claims · {st.consensusFuture.searchCount} searches</Tag>}>The consensus future</SectionTitle>
          {st.consensusFuture.claims.map((c) => (
            <div key={c.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "9px 12px", margin: "6px 0" }}>
              <p style={{ margin: 0, fontSize: 13 }}><Tag tone="var(--faint)">{c.horizon || "horizon n/a"}</Tag> {c.claim}</p>
              <a href={c.urls[0]} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--brass)" }}>{hostOf(c.urls[0])}</a>
            </div>
          ))}
        </>
      )}
      {st.predictions && (
        <>
          <SectionTitle right={<Tag tone="var(--sub)">{st.predictions.shipped.length} shipped · {st.predictions.rejected.length} rejected at the gates</Tag>}>Predictions</SectionTitle>
          {a.verdict === "consensus_affirmed" && (
            <p style={{ fontSize: 13, color: "var(--green)", margin: "4px 0 10px" }}>The consensus future is simply correct here — every shipped entry affirms it, dated and scoreable.</p>
          )}
          {st.predictions.shipped.map((p) => <PredictionCard key={p.id} p={normalizeArtifactPred(p, a.domain)} />)}
          {st.predictions.rejected.length > 0 && (
            <Reveal summary={`rejected at the ship gates (${st.predictions.rejected.length})`}>
              {st.predictions.rejected.map((r, i) => <p key={i} style={{ fontSize: 12, color: "var(--faint)", margin: "4px 0" }}>✕ “{String(r.statement).slice(0, 90)}” — {r.problems.join("; ")}</p>)}
            </Reveal>
          )}
        </>
      )}
    </>
  );
}

/* ── prediction cards (ledger + run detail) ─────────────────────────────────── */

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
  return (
    <div style={{ border: "1px solid var(--line-strong, var(--line))", borderRadius: 14, padding: "15px 17px", margin: "10px 0" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Tag tone={p.kind === "bold" ? "var(--brass)" : "var(--green)"}>{p.kind === "bold" ? "BOLD" : "CONSENSUS AFFIRMED"}</Tag>
        {p.status && <Tag tone={{ open: "var(--faint)", correct: "var(--green)", wrong: "var(--red)", void: "var(--faint)" }[p.status]}>{p.status.toUpperCase()}</Tag>}
        <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{p.subject}</span>
        {last && <Tag tone={sigTone[last.signal]}>tell: {last.signal}</Tag>}
      </div>
      <p style={{ fontSize: 15.5, fontWeight: 700, lineHeight: 1.4, margin: "10px 0 12px" }}>{p.statement}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <div><span style={kLabel}>resolves</span><span className="t-num" style={{ fontSize: 13 }}>{p.resolution_date}{days != null && p.status === "open" ? ` · ${days > 0 ? `${days}d out` : `${-days}d overdue`}` : ""}</span></div>
        <div><span style={kLabel}>confidence</span><Conf value={p.confidence} /></div>
        <div><span style={kLabel}>resolution criterion</span><span style={{ fontSize: 12.5 }}>{p.resolution_criterion}</span></div>
      </div>
      <Reveal summary={`causal chain — ${(p.causal_chain || []).length} steps, in order`}>
        <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {(p.causal_chain || []).map((s, i) => <li key={i} style={{ fontSize: 12.5, color: "var(--sub)", margin: "3px 0" }}>{s}</li>)}
        </ol>
      </Reveal>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 10 }}>
        <div>
          <span style={kLabel}>the tell — go look at this</span>
          <span style={{ fontSize: 12.5 }}>{p.tell?.observable}</span>
          <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 2 }}>where: {p.tell?.whereToLook}</div>
        </div>
        <div>
          <span style={kLabel}>consensus says</span>
          <span style={{ fontSize: 12.5 }}>{p.consensus_counterpart?.position}{" "}
            {(p.consensus_counterpart?.urls || []).map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--brass)", marginLeft: 4 }}>{hostOf(u)}</a>)}
          </span>
        </div>
        {p.kind === "bold" && p.delta && <div><span style={kLabel}>delta from consensus</span><span style={{ fontSize: 12.5 }}>{p.delta}</span></div>}
      </div>
      <Mechanism mech={p.why_consensus_misses} />
      {last && (
        <div style={{ marginTop: 10 }}>
          <span style={kLabel}>latest tell check</span>
          <span style={{ fontSize: 12.5 }}>{last.summary}{" "}
            {(last.evidence || []).map((e) => <a key={e.url} href={e.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--brass)", marginLeft: 4 }}>{hostOf(e.url)}</a>)}
          </span>
        </div>
      )}
      {actions && p.status === "open" && (
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
          <Button kind="quiet" size="md" disabled={actions.checking === p.id} onClick={() => actions.onCheckTell(p.id)}>
            {actions.checking === p.id ? <><Spinner size={12} /> checking…</> : "Check the tell"}
          </Button>
          <Button kind="quiet" size="md" onClick={() => setResolving(!resolving)}>Resolve…</Button>
          {resolving && (
            <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <Field value={note} onChange={(e) => setNote(e.target.value)} placeholder="resolution note" style={{ width: 180 }} />
              <Button kind="quiet" size="md" style={{ color: "var(--green)" }} onClick={() => actions.onResolve(p.id, "correct", note)}>correct</Button>
              <Button kind="quiet" size="md" style={{ color: "var(--red)" }} onClick={() => actions.onResolve(p.id, "wrong", note)}>wrong</Button>
              <Button kind="quiet" size="md" onClick={() => actions.onResolve(p.id, "void", note)}>void</Button>
            </span>
          )}
        </div>
      )}
      {p.status !== "open" && p.resolution_note && (
        <div style={{ marginTop: 8 }}><span style={kLabel}>resolution note</span><span style={{ fontSize: 12.5 }}>{p.resolution_note}</span></div>
      )}
    </div>
  );
}

/* ── the page ───────────────────────────────────────────────────────────────── */

export function UpstreamPage({ isMobile }) {
  const [tab, setTab] = useState("engine");
  const pad = isMobile ? "0 14px 14px" : "0 4px 8px";
  return (
    <div style={{ padding: pad }}>
      <Segmented
        options={[{ key: "engine", label: "Question Engine" }, { key: "nostradamus", label: "Nostradamus" }]}
        value={tab} onChange={setTab} style={{ maxWidth: 420, marginBottom: 14 }}
      />
      {tab === "engine" ? <EngineTab /> : <NostradamusTab />}
    </div>
  );
}

// Polls the selected run while it's running; both tabs share this.
function useRunPolling(runId, onDone) {
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);
  const doneRef = useRef(false);
  useEffect(() => {
    if (!runId) { setRun(null); return undefined; }
    doneRef.current = false;
    let timer = null;
    let cancelled = false;
    let missingPolls = 0;
    const tick = async () => {
      try {
        const r = await fetchRun(runId);
        if (cancelled) return;
        setErr(null);
        if (r) setRun(r);
        else if (++missingPolls >= 20) {
          // The background function ACKed but never created the run row — a pre-run
          // failure (env, auth). Fail loudly instead of spinning forever.
          setErr("The engine acknowledged the run but never started it — check the upstream-run-background function logs on Netlify (likely a missing env var).");
          return;
        }
        if (r && r.status !== "running") {
          if (!doneRef.current) { doneRef.current = true; onDone?.(r); }
          return; // stop polling
        }
      } catch (e) { if (!cancelled) setErr(e.message); }
      timer = setTimeout(tick, 3000);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { run, err };
}

function EngineTab() {
  const [domain, setDomain] = useState("");
  const [runs, setRuns] = useState(null);
  const [listErr, setListErr] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [launching, setLaunching] = useState(false);
  const [launchErr, setLaunchErr] = useState(null);

  const loadRuns = useCallback(() => {
    setListErr(null);
    fetchRuns("upstream").then(setRuns).catch((e) => setListErr(e.message));
  }, []);
  useEffect(loadRuns, [loadRuns]);

  const { run: selectedRun, err: pollErr } = useRunPolling(selectedId, loadRuns);

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

  const active = runs?.some((r) => r.status === "running") || selectedRun?.status === "running";

  return (
    <>
      <Card pad="lg">
        <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 15.5 }}>What should you actually be asking?</p>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--sub)", lineHeight: 1.6 }}>
          Give it a domain. It maps the consensus questions first, hunts for the 2–3 that are
          non-obvious <i>and</i> load-bearing, deep-dives them against live sources, and ships a POV
          with a spine. When consensus is simply right, it says so. Runs take 5–8 minutes.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Field value={domain} onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") launch(); }}
            placeholder='e.g. "the future of desalination"' style={{ flex: 1, minWidth: 220 }} />
          <Button kind="primary" size="lg" disabled={launching || active} onClick={launch}>
            {launching ? <><Spinner size={13} /> starting…</> : active ? "run in progress" : "Run upstream"}
          </Button>
        </div>
        {launchErr && <p style={{ color: "var(--red)", fontSize: 12.5, margin: "8px 0 0" }}>{launchErr}</p>}
      </Card>

      {selectedId && (selectedRun
        ? <RunDetail run={selectedRun} />
        : (
          <Card pad="lg" style={{ marginTop: 12 }}>
            {!pollErr && <><Spinner size={16} /> <span style={{ fontSize: 13, color: "var(--sub)" }}>engine starting — first artifact lands in ~30s</span></>}
            {pollErr && <p style={{ color: "var(--red)", fontSize: 12.5, margin: 0 }}>{pollErr}</p>}
          </Card>
        ))}

      <SectionHeader title="Runs" trailing={<Button kind="quiet" size="md" onClick={loadRuns} aria-label="Refresh runs"><IcRefresh size={13} /></Button>} style={{ marginTop: 20 }} />
      {listErr && <Card><p style={{ color: "var(--red)", fontSize: 13, margin: 0 }}>{listErr}</p><Button kind="quiet" size="md" onClick={loadRuns} style={{ marginTop: 8 }}>Retry</Button></Card>}
      {runs && runs.length === 0 && !listErr && (
        <EmptyState title="No runs yet" sub="Type a domain above and watch the gauntlet work. The first run maps consensus, kills the obvious questions, and dives what survives." />
      )}
      {runs && runs.length > 0 && (
        <CellGroup>
          {runs.map((r) => (
            <Cell key={r.id} title={r.domain || "(run)"}
              sub={`${fmtDuration(r.duration_ms)} · ${new Date(r.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
              trailing={<RunBadge run={r} />} chevron onClick={() => setSelectedId(r.id)} />
          ))}
        </CellGroup>
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
  const [launchErr, setLaunchErr] = useState(null);
  const [checking, setChecking] = useState(null);
  const checkTimer = useRef(null);

  const load = useCallback(() => {
    setErr(null);
    Promise.all([fetchPredictions(), fetchRuns("nostradamus")])
      .then(([p, c]) => { setPreds(p); setConsults(c); })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); return () => clearTimeout(checkTimer.current); }, [load]);

  const { run: selectedRun } = useRunPolling(selectedId, load);

  const consult = async () => {
    setLaunching(true); setLaunchErr(null);
    try {
      const runId = await startJob("nostradamus");
      setSelectedId(runId);
      setTimeout(load, 1500);
    } catch (e) { setLaunchErr(e.message); }
    setLaunching(false);
  };

  const onCheckTell = async (id) => {
    setChecking(id);
    try {
      await startJob("tell_check", { predictionId: id });
      // The check runs in the background (~60-90s); poll the ledger until a new check lands.
      const before = (preds.find((p) => p.id === id)?.tellChecks || []).length;
      let waited = 0;
      const poll = async () => {
        waited += 6000;
        const fresh = await fetchPredictions().catch(() => null);
        if (fresh) {
          setPreds(fresh);
          const now = (fresh.find((p) => p.id === id)?.tellChecks || []).length;
          if (now > before) { setChecking(null); return; }
        }
        if (waited >= 240000) { setChecking(null); setErr("Tell check timed out — see Systems → usage for what happened."); return; }
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
  const active = consults?.some((r) => r.status === "running") || selectedRun?.status === "running";

  return (
    <>
      <Card pad="lg">
        <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 15.5 }}>NOSTRADAMUS</p>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--sub)", lineHeight: 1.6 }}>
          It picks its own subjects — civilizational altitude only — maps the consensus future from
          live sources, and ships dated predictions measurably outside it. Everything persists and
          gets scored as reality lands. Undated boldness is astrology; you won't find any here.
        </p>
        <Button kind="primary" size="lg" disabled={launching || active} onClick={consult}>
          {launching ? <><Spinner size={13} /> consulting…</> : active ? "consult in progress" : "Consult the oracle"}
        </Button>
        {launchErr && <p style={{ color: "var(--red)", fontSize: 12.5, margin: "8px 0 0" }}>{launchErr}</p>}
      </Card>

      {selectedId && selectedRun && <RunDetail run={selectedRun} />}
      {err && <Card style={{ marginTop: 12 }}><p style={{ color: "var(--red)", fontSize: 13, margin: 0 }}>{err}</p><Button kind="quiet" size="md" onClick={load} style={{ marginTop: 8 }}>Retry</Button></Card>}

      {cal && (
        <>
          <SectionHeader title="Calibration" style={{ marginTop: 20 }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
            <StatTile value={String(cal.open)} label="open" />
            <StatTile value={String(cal.resolved)} label="resolved" />
            <StatTile value={cal.brier == null ? "—" : String(cal.brier)} label="brier" />
          </div>
          {cal.resolved === 0
            ? <p style={{ fontSize: 12.5, color: "var(--sub)", margin: "8px 0 0" }}>Nothing has resolved yet — calibration becomes visible as resolution dates arrive. Until then, tell checks track whether the causal chains are live.</p>
            : (
              <Card style={{ marginTop: 10 }}>
                {cal.buckets.map((b) => (
                  <div key={b.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
                    <span className="t-num">{b.label}</span>
                    <span style={{ color: "var(--sub)" }}>{b.open} open · {b.resolved} resolved · {b.resolved ? `${Math.round((b.hits / b.resolved) * 100)}% hit` : "—"}</span>
                  </div>
                ))}
              </Card>
            )}
        </>
      )}

      <SectionHeader title={`Open predictions${open.length ? ` · ${open.length}` : ""}`} style={{ marginTop: 20 }} />
      {preds == null && !err && <Card><Spinner size={14} /></Card>}
      {preds != null && open.length === 0 && (
        <EmptyState title="The ledger is empty" sub="Consult the oracle — it picks a subject, maps the consensus future, and puts dated claims on the record." />
      )}
      {open.map((p) => <PredictionCard key={p.id} p={p} actions={{ onCheckTell, onResolve, checking }} />)}

      {closed.length > 0 && (
        <>
          <SectionHeader title={`Resolved · ${closed.length}`} style={{ marginTop: 20 }} />
          {closed.map((p) => <PredictionCard key={p.id} p={p} />)}
        </>
      )}

      {consults && consults.length > 0 && (
        <>
          <SectionHeader title="Consult history" style={{ marginTop: 20 }} />
          <CellGroup>
            {consults.map((r) => (
              <Cell key={r.id} title={r.domain || "(subject not reached)"}
                sub={`${fmtDuration(r.duration_ms)} · ${new Date(r.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                trailing={<RunBadge run={r} />} chevron onClick={() => setSelectedId(r.id)} />
            ))}
          </CellGroup>
        </>
      )}
    </>
  );
}
