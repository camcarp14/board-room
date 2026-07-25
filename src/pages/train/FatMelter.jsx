// ─── Fat Melter — four taps → a fat-loss session you can start now ────────────
// Sits beside "Find your workout" on the Train home. Same integration contract:
// onStart / onSaveRoutine take the generated workout unchanged, so a started
// session prefills weights from your history and every move lands in the
// muscle-group heatmap. All the generation is pure and smoke-tested in
// src/lib/fat-melter.js; this file is the sheet that drives it.
//
// The copy here is deliberately honest about mechanism. A "fat burner" widget is
// the easiest place in a fitness app to promise something training can't deliver
// on its own — the deficit does the fat loss, and this session's job is to spend
// energy while keeping the muscle that keeps your BMR up. Saying that plainly is
// the same rule the rest of the app follows about not showing numbers it can't
// stand behind.

import { useState, useMemo } from "react";
import { Card, Button, Pill, Sheet } from "../../ui/kit.jsx";
import { IcHeart, IcCheck, IcClock, IcChevronRight, IcDumbbell } from "../../ui/icons.jsx";
import { MELT_QUIZ, buildFatMelter } from "../../lib/fat-melter.js";
import { totalSets } from "../../lib/workout-library.js";

export function FatMelter({ isMobile, sessions, unit, onStart, onSaveRoutine, style }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card pad="md" pressable onClick={() => setOpen(true)} style={style}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "color-mix(in srgb, var(--red) 12%, transparent)", color: "var(--red)" }}>
            <IcHeart size={19} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="t-head">Fat Melter</div>
            <div className="t-foot" style={{ color: "var(--sub)", marginTop: 1 }}>Four taps → a high-burn session that keeps your muscle</div>
          </div>
          <IcChevronRight size={16} style={{ color: "var(--faint)", flex: "none" }} />
        </div>
      </Card>
      {open && (
        <FatMelterSheet
          isMobile={isMobile} sessions={sessions} unit={unit}
          onStart={onStart} onSaveRoutine={onSaveRoutine} onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const repsLabel = (reps) => (reps === 1 ? "hold" : reps);

function FatMelterSheet({ sessions, onStart, onSaveRoutine, onClose }) {
  const [answers, setAnswers] = useState({});
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  // Recovery-aware: the picker biases toward muscle you've actually recovered,
  // using the same groupFreshness clock the rest of Train reads. Nothing to ask
  // about soreness — it already knows what you trained.
  const built = useMemo(() => buildFatMelter(answers, { sessions: sessions || [] }), [answers, sessions]);

  // Single-select questions replace; the multi-select one (gear) toggles
  // membership, because equipment combines — "Dumbbells + Bike" is a garage.
  const pick = (q, optKey) => {
    setSaved(false);
    setAnswers((a) => {
      if (!q.multi) {
        if (a[q.key] === optKey) { const n = { ...a }; delete n[q.key]; return n; } // second tap clears
        return { ...a, [q.key]: optKey };
      }
      const cur = Array.isArray(a[q.key]) ? a[q.key] : a[q.key] ? [a[q.key]] : [];
      const next = cur.includes(optKey) ? cur.filter((k) => k !== optKey) : [...cur, optKey];
      if (!next.length) { const n = { ...a }; delete n[q.key]; return n; }
      return { ...a, [q.key]: next };
    });
  };
  const isOn = (q, optKey) => {
    const v = answers[q.key];
    return q.multi ? (Array.isArray(v) ? v.includes(optKey) : v === optKey) : v === optKey;
  };

  const start = () => { onStart(built); onClose(); };
  const save = async () => {
    if (saving || !onSaveRoutine) return;
    setSaving(true); setSaveErr(null);
    try { await onSaveRoutine(built); setSaved(true); }
    catch (e) { setSaveErr(e?.message || "Couldn't save the routine."); }
    setSaving(false);
  };

  return (
    <Sheet
      onClose={onClose} title="Fat Melter" z={320}
      bodyStyle={{ minHeight: "min(70dvh, 620px)" }}
      footer={
        <>
          <Button kind="quiet" size="lg" style={{ flex: 1 }} disabled={saving || saved} onClick={save}>
            {saved ? <><IcCheck size={15} /> Saved</> : saving ? "Saving…" : "Save as routine"}
          </Button>
          <Button kind="primary" size="lg" style={{ flex: 1.4 }} onClick={start}>Start now</Button>
        </>
      }
    >
      <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.55, marginBottom: 16 }}>
        Built for energy spent per minute, with the strength work kept in — that's
        the part that protects muscle while you're in a deficit. Answer what you
        like; it always lands on something you can start.
      </div>

      {MELT_QUIZ.map((q) => (
        <div key={q.key} style={{ marginBottom: 14 }}>
          <div className="t-call" style={{ fontWeight: 600 }}>{q.q}</div>
          {q.help && <div className="t-cap" style={{ color: "var(--faint)", marginTop: 2 }}>{q.help}</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {q.options.map((o) => {
              const on = isOn(q, o.key);
              return (
                <Pill key={o.key} active={on} onClick={() => pick(q, o.key)}>
                  {on && <IcCheck size={11} />}{o.label}
                </Pill>
              );
            })}
          </div>
        </div>
      ))}

      <div style={{ height: "0.5px", background: "var(--line)", margin: "6px 0 14px" }} />

      <div className="t-label" style={{ color: "var(--red)", marginBottom: 6 }}>Your session</div>
      <Card pad="md">
        <div className="t-title2">{built.name}</div>
        <div className="t-foot" style={{ color: "var(--sub)", marginTop: 2, lineHeight: 1.5 }}>{built.blurb}</div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, marginTop: 12 }}>
          <span className="t-cap" style={{ color: "var(--faint)", display: "inline-flex", alignItems: "center", gap: 5 }}>
            <IcClock size={13} /> ~{built.estMinutes} min
          </span>
          <span className="t-cap" style={{ color: "var(--faint)", display: "inline-flex", alignItems: "center", gap: 5 }}>
            <IcDumbbell size={13} /> {built.exercises.length} moves · {totalSets(built.exercises)} sets
          </span>
          <span className="t-cap" style={{ color: "var(--faint)" }}>{built.groups.length} muscle groups</span>
        </div>

          {/* The honest gap, when there is one — a conditioning-only answer spends
            plenty of energy but protects no muscle, and that's half the reason
            this tool exists. Stated in the card, not buried in a footnote. */}
        {built.caveat && (
          <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, background: "color-mix(in srgb, var(--amber) 10%, transparent)" }}>
            <div className="t-cap" style={{ color: "var(--amber)", fontWeight: 700, letterSpacing: "0.02em", textTransform: "uppercase", marginBottom: 3 }}>Worth knowing</div>
            <div className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.5 }}>{built.caveat}</div>
          </div>
        )}

      {/* Blocks, not one flat list. The structure IS the method here — a circuit
            read as ten unrelated exercises would lose the whole point, and the
            rest figures are what make it a fat-loss session rather than a
            hypertrophy one. The logged data is still the flat list underneath. */}
        {built.blocks.map((b) => (
          <div key={b.key} style={{ marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
              <span className="t-cap" style={{ fontWeight: 700, color: "var(--ink)", letterSpacing: "0.02em", textTransform: "uppercase" }}>{b.label}</span>
            </div>
            <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45, marginTop: 2 }}>{b.note}</div>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column" }}>
              {b.moves.map((m, i) => (
                <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderTop: i ? "0.5px solid var(--line)" : "none" }}>
                  <span className="t-call" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</span>
                  <span className="t-cap" style={{ color: "var(--faint)", flex: "none" }}>{m.group}</span>
                  <span className="t-num" style={{ color: "var(--sub)", fontSize: 12.5, flex: "none", minWidth: 54, textAlign: "right" }}>
                    {m.sets} × {repsLabel(m.reps)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Card>
      {saveErr && <div className="t-foot" style={{ color: "var(--red)", marginTop: 8 }}>{saveErr}</div>}

      <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.55, marginTop: 12 }}>
        Worth being straight about: training doesn't burn fat on its own — the
        calorie deficit does, and this can't see your food. What a session like
        this does is spend a lot of energy in the time you've got and keep the
        muscle that holds your metabolism up, so the deficit takes fat instead of
        both. The "afterburn" effect is real but small. Consistency beats intensity.
      </div>
    </Sheet>
  );
}

export default FatMelter;
