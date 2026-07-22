// ─── Find your workout — the zero-friction "what do I do today" tool ─────────
// Tap a few answers → the recommender surfaces the workout that best fits your
// time, energy, gear, and what you've recovered from — start it in one tap, or
// browse the alternates it also ranked. The whole point is to kill the "I don't
// know what to do" stall between opening the app and lifting.
// All the scoring is pure and smoke-tested in src/lib/workout-library.js; this
// file is just the sheet that drives it.

import { useState, useMemo } from "react";
import { Card, CellGroup, Cell, Button, Pill, Sheet } from "../../ui/kit.jsx";
import { IcSpark, IcCheck, IcClock, IcChevronRight, IcDumbbell } from "../../ui/icons.jsx";
import { QUIZ, recommendWorkouts, buildPerfectWorkout, totalSets } from "../../lib/workout-library.js";

// The entry card — drop it anywhere on the Train home; it owns its own sheet.
export function FindWorkout({ isMobile, sessions, unit, onStart, onSaveRoutine, style }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card pad="md" pressable onClick={() => setOpen(true)} style={style}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--accent-a12)", color: "var(--accent)" }}>
            <IcSpark size={19} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="t-head">Find your workout</div>
            <div className="t-foot" style={{ color: "var(--sub)", marginTop: 1 }}>A few taps → a workout you can start now</div>
          </div>
          <IcChevronRight size={16} style={{ color: "var(--faint)", flex: "none" }} />
        </div>
      </Card>
      {open && (
        <FindWorkoutSheet
          isMobile={isMobile} sessions={sessions} unit={unit}
          onStart={onStart} onSaveRoutine={onSaveRoutine} onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const repsLabel = (reps) => (reps === 1 ? "hold" : reps);

function FindWorkoutSheet({ sessions, onStart, onSaveRoutine, onClose }) {
  const [answers, setAnswers] = useState({});
  const [selectedId, setSelectedId] = useState(null); // an alternate the user promoted to the featured slot
  const [savedId, setSavedId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  // Only feasible picks are ever shown — you can't start what you can't equip.
  const ranked = useMemo(
    () => recommendWorkouts(answers, { sessions: sessions || [] }).filter((r) => r.feasible),
    [answers, sessions],
  );
  const featured = ranked.find((r) => r.workout.id === selectedId) || ranked[0] || null;
  const built = featured ? buildPerfectWorkout(featured.workout, answers) : null;
  const alternates = ranked.filter((r) => r !== featured).slice(0, 3);

  // Tapping an answer re-lets the recommender pick the featured slot (and a
  // second tap on the same option clears it — "no preference").
  const pick = (qKey, optKey) => {
    setSelectedId(null); setSavedId(null);
    setAnswers((a) => {
      if (a[qKey] === optKey) { const n = { ...a }; delete n[qKey]; return n; }
      return { ...a, [qKey]: optKey };
    });
  };

  const start = () => { if (built) { onStart(built); onClose(); } };
  const save = async () => {
    if (!built || saving || !onSaveRoutine) return;
    setSaving(true); setSaveErr(null);
    try { await onSaveRoutine(built); setSavedId(built.sourceId); }
    catch (e) { setSaveErr(e?.message || "Couldn't save the routine."); }
    setSaving(false);
  };
  const isSaved = savedId != null && built != null && savedId === built.sourceId;

  return (
    <Sheet
      onClose={onClose} title="Find your workout" z={320}
      bodyStyle={{ minHeight: "min(70dvh, 620px)" }}
      footer={
        <>
          <Button kind="quiet" size="lg" style={{ flex: 1 }} disabled={!built || saving || isSaved} onClick={save}>
            {isSaved ? <><IcCheck size={15} /> Saved</> : saving ? "Saving…" : "Save as routine"}
          </Button>
          <Button kind="primary" size="lg" style={{ flex: 1.4 }} disabled={!built} onClick={start}>Start now</Button>
        </>
      }
    >
      <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.55, marginBottom: 16 }}>
        Answer as many or as few as you like — it always lands on a workout you can start in one tap.
      </div>

      {QUIZ.map((q) => (
        <div key={q.key} style={{ marginBottom: 14 }}>
          <div className="t-call" style={{ fontWeight: 600 }}>{q.q}</div>
          {q.help && <div className="t-cap" style={{ color: "var(--faint)", marginTop: 2 }}>{q.help}</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {q.options.map((o) => {
              const on = answers[q.key] === o.key;
              return (
                <Pill key={o.key} active={on} onClick={() => pick(q.key, o.key)}>
                  {on && <IcCheck size={11} />}{o.label}
                </Pill>
              );
            })}
          </div>
        </div>
      ))}

      <div style={{ height: "0.5px", background: "var(--line)", margin: "6px 0 14px" }} />

      {built ? (
        <>
          <div className="t-label" style={{ color: "var(--accent)", marginBottom: 6 }}>Recommended for you</div>
          <Card pad="md">
            <div className="t-title2" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{built.name}</div>
            <div className="t-foot" style={{ color: "var(--sub)", marginTop: 2 }}>{built.blurb}</div>

            {featured.reasons?.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                {featured.reasons.map((r, i) => (
                  <span key={i} className="t-cap" style={{ background: "var(--surface-2)", color: "var(--sub)", borderRadius: 99, padding: "4px 10px" }}>{r}</span>
                ))}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 12 }}>
              <span className="t-cap" style={{ color: "var(--faint)", display: "inline-flex", alignItems: "center", gap: 5 }}><IcClock size={13} /> ~{built.time} min</span>
              <span className="t-cap" style={{ color: "var(--faint)", display: "inline-flex", alignItems: "center", gap: 5 }}><IcDumbbell size={13} /> {built.exercises.length} moves · {totalSets(built.exercises)} sets</span>
            </div>

            <div style={{ marginTop: 12, display: "flex", flexDirection: "column" }}>
              {built.exercises.map((e, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: i ? "0.5px solid var(--line)" : "none" }}>
                  <span className="t-num" style={{ width: 18, color: "var(--faint)", fontSize: 12, flex: "none" }}>{i + 1}</span>
                  <span className="t-call" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</span>
                  <span className="t-num" style={{ color: "var(--sub)", fontSize: 12.5, flex: "none" }}>{e.targetSets} × {repsLabel(e.targetReps)}</span>
                </div>
              ))}
            </div>
          </Card>
          {saveErr && <div className="t-foot" style={{ color: "var(--red)", marginTop: 8 }}>{saveErr}</div>}

          {alternates.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="t-label" style={{ marginBottom: 6 }}>More that fit</div>
              <CellGroup>
                {alternates.map((r) => (
                  <Cell
                    key={r.workout.id}
                    title={r.workout.name}
                    sub={`~${r.workout.time} min · ${r.workout.exercises.length} moves${r.reasons[0] ? " · " + r.reasons[0] : ""}`}
                    trailing={<IcChevronRight size={14} style={{ color: "var(--faint)", flex: "none" }} />}
                    onClick={() => { setSelectedId(r.workout.id); setSavedId(null); }}
                  />
                ))}
              </CellGroup>
              <div className="t-cap" style={{ color: "var(--faint)", marginTop: 8 }}>
                Tap one to preview it above — proven, balanced templates you can tweak once you start.
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="t-foot" style={{ color: "var(--faint)", padding: "10px 0" }}>
          No match for that combination — try loosening the equipment or focus.
        </div>
      )}
    </Sheet>
  );
}

export default FindWorkout;
