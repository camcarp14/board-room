// ─── Drills — the rack ───────────────────────────────────────────────────────
// Six things you can run on their own, outside a prescribed session. The Today
// tab schedules most of these for you; this is where you come when you already
// know what you want to work on, and it is also where the two MEASUREMENTS live
// that a self-taught player otherwise never gets:
//
//   · One-Minute Changes — a count, against benchmarks, per chord pair.
//   · Drop the click — your timing error in milliseconds, with a direction.
//
// Both are cheap, both are objective, and both are things a teacher would tell
// you and nobody else will.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, Button, Sheet, Segmented, PillRow,
  EmptyState, Grid, StatTile,
} from "../../ui/kit.jsx";
import { DRILLS, PROGRESSIONS, STRUM_PATTERNS, strumByKey, BENCHMARKS, SKILLS } from "../../lib/guitar/library.js";
import { SHARP_NAMES, pcName, mod12 } from "../../lib/guitar/theory.js";
import { tuningByKey, scaleMap } from "../../lib/guitar/fretboard.js";
import { lookupChord } from "../../lib/guitar/chords.js";
import { buildBacking } from "../../lib/guitar/progression.js";
import { measureDrift } from "../../lib/guitar/practice.js";
import { createMetronome, playNote, playDrone, unlock, audioNow } from "../../lib/guitar/audio.js";
import { useGuitarSkills, useSaveGuitarSkills } from "../../data/guitar.js";
import ChordDiagram from "./ChordDiagram.jsx";
import Fretboard from "./Fretboard.jsx";
import { PlayerBar } from "./PlayerBar.jsx";

// ─── One-Minute Changes ──────────────────────────────────────────────────────
function OMCRunner({ onClose, isMobile, pairs, onResult }) {
  const [pair, setPair] = useState(pairs[0]?.pair || ["Em", "Am"]);
  const [count, setCount] = useState(0);
  const [left, setLeft] = useState(60);
  const [state, setState] = useState("idle"); // idle | running | done
  const deadline = useRef(0);

  useEffect(() => {
    if (state !== "running") return undefined;
    const t = setInterval(() => {
      const rem = Math.max(0, (deadline.current - Date.now()) / 1000);
      setLeft(rem);
      if (rem <= 0) { setState("done"); clearInterval(t); }
    }, 100);
    return () => clearInterval(t);
  }, [state]);

  const start = () => { setCount(0); setLeft(60); deadline.current = Date.now() + 60000; setState("running"); };
  const bench = BENCHMARKS.omc.filter((b) => count >= b.n).pop();

  return (
    <Sheet title="One-Minute Changes" onClose={onClose} detent={isMobile ? "large" : "auto"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 6 }}>
        {state === "idle" && (
          <>
            <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
              Sixty seconds. Change between these two chords as many times as you can and count
              every one you complete cleanly. It is the most efficient beginner drill that exists
              because it is short, objectively measured, and aimed at the actual bottleneck.
            </div>
            <PillRow options={pairs.map((p) => ({ key: p.id, label: p.pair.join(" ↔ ") }))}
              value={pairs.find((p) => p.pair.join() === pair.join())?.id}
              onChange={(id) => setPair(pairs.find((p) => p.id === id)?.pair || pair)} label="Chord pair" />
          </>
        )}

        <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
          {pair.map((sym) => {
            const v = lookupChord(sym)?.voicings?.[0];
            return v ? <ChordDiagram key={sym} frets={v.frets} fingers={v.fingers} barre={v.barre} label={sym} size={isMobile ? 116 : 132} /> : null;
          })}
        </div>

        {state === "running" ? (
          <>
            <button type="button" onClick={() => setCount((c) => c + 1)} aria-label={`Count a change — ${count} so far`}
              style={{
                border: "none", cursor: "pointer", borderRadius: "var(--r-card)", padding: "34px 12px",
                background: "var(--accent-a12)", color: "var(--accent)",
              }}>
              <div className="t-num" style={{ fontSize: 68, fontWeight: 700, lineHeight: 1 }}>{count}</div>
              <div className="t-cap" style={{ color: "var(--sub)", marginTop: 6 }}>tap on every change</div>
            </button>
            <div className="t-num" style={{ fontSize: 22, textAlign: "center", color: left < 10 ? "var(--amber)" : "var(--sub)" }}>
              {left.toFixed(1)}s
            </div>
            <Button kind="quiet" full onClick={() => setState("done")}>Stop</Button>
          </>
        ) : state === "done" ? (
          <>
            <div style={{ textAlign: "center" }}>
              <div className="t-ltitle" style={{ fontSize: 52, color: "var(--accent)" }}>{count}</div>
              <div className="t-call" style={{ color: "var(--sub)" }}>
                changes a minute{bench ? ` — ${bench.label.toLowerCase()}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {BENCHMARKS.omc.map((b) => (
                <div key={b.n} style={{
                  flex: 1, textAlign: "center", padding: "8px 4px", borderRadius: "var(--r-well)",
                  background: count >= b.n ? "var(--green-a06)" : "var(--surface-2)",
                  color: count >= b.n ? "var(--green)" : "var(--faint)",
                }}>
                  <div className="t-num" style={{ fontSize: 16, fontWeight: 700 }}>{b.n}</div>
                  <div className="t-cap">{b.label}</div>
                </div>
              ))}
            </div>
            <div className="t-cap" style={{ color: "var(--faint)", textAlign: "center", lineHeight: 1.5 }}>
              These are teacher consensus, not measured data. What they are good for is telling you
              whether the number is going up.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button kind="quiet" full onClick={start}>Again</Button>
              <Button kind="primary" full onClick={() => { onResult?.({ pair, count }); onClose(); }}>Log it</Button>
            </div>
          </>
        ) : (
          <Button kind="primary" size="lg" full onClick={start}>Start the minute</Button>
        )}
      </div>
    </Sheet>
  );
}

// ─── Drop the click ──────────────────────────────────────────────────────────
// The metronome plays two bars and goes silent for two. You keep playing, and
// tap on every beat one. When the click comes back, the difference between where
// your taps landed and where the beats actually were is the measurement.
// Sixteen bars: four silent stretches of two, which is enough taps for an
// average that means something and short enough that nobody gives up halfway.
const BARS = 16;
function DriftRunner({ onClose, isMobile }) {
  const [bpm, setBpm] = useState(80);
  const [state, setState] = useState("idle");
  const [result, setResult] = useState(null);
  const [taps, setTaps] = useState(0);
  // THE MUTE HAS TO BE STATE, NOT A REF READ DURING RENDER. The drill's whole
  // instruction — "silent, keep going" — was drawn from mRef.current.muted, which
  // the metronome flips inside its own beat handler. Nothing re-rendered when it
  // did, so the panel sat on whichever value it happened to paint first and the
  // one cue the drill exists to give never appeared.
  const [muted, setMuted] = useState(false);
  const [bar, setBar] = useState(0);
  const mRef = useRef(null);
  const clicks = useRef([]);
  const hits = useRef([]);

  useEffect(() => () => mRef.current?.stop(), []);

  const start = async () => {
    if (!(await unlock())) return;
    clicks.current = []; hits.current = []; setTaps(0); setResult(null); setMuted(false); setBar(0);
    const m = createMetronome({
      bpm, beatsPerBar: 4, subdivision: 1,
      onBeat: (ev) => {
        // Every downbeat is recorded whether it SOUNDED or not — the silent ones
        // are the whole measurement, and a scheduler that only remembered the
        // audible beats would have nothing to compare the silent bars against.
        if (ev.inBar !== 0) return;
        clicks.current.push(ev.time);
        const silent = Math.floor(ev.bar / 2) % 2 === 1;
        m.setMuted(silent);
        setMuted(silent);
        setBar(ev.bar);
        if (ev.bar >= BARS) { m.stop(); finish(); }
      },
    });
    mRef.current = m;
    await m.start();
    setState("running");
  };

  const finish = () => {
    setState("done");
    setResult(measureDrift(clicks.current, hits.current));
  };

  const tap = () => {
    if (state !== "running") return;
    hits.current.push(audioNow());
    setTaps((t) => t + 1);
  };

  const stop = () => { mRef.current?.stop(); finish(); };
  // The metronome is stopped in `onClose` rather than by a close button of our
  // own: Sheet already renders an X and routes it here, so a second one was
  // literally a second X in the header.
  const grade = result ? BENCHMARKS.drift.filter((b) => Math.abs(result.meanMs) <= b.ms).pop() : null;

  return (
    <Sheet title="Drop the click" onClose={() => { mRef.current?.stop(); onClose(); }} detent={isMobile ? "large" : "auto"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 6 }}>
        <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
          Two bars of click, two bars of silence, sixteen bars in all. Keep playing through the gaps
          and tap on every beat one. What comes out is your timing error in milliseconds, and whether
          you rush or drag — which is a thing you can practise against, unlike "you're out of time".
        </div>

        {state === "idle" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="t-num" style={{ fontSize: 26, fontWeight: 700, minWidth: 54 }}>{bpm}</div>
              <input type="range" min={50} max={160} value={bpm} onChange={(e) => setBpm(Number(e.target.value))}
                aria-label="Tempo" style={{ flex: 1, accentColor: "var(--accent)" }} />
            </div>
            <Button kind="primary" size="lg" full onClick={start}>Start</Button>
          </>
        )}

        {state === "running" && (
          <>
            <button type="button" onClick={tap} aria-label={`Tap on beat one — ${taps} so far`}
              style={{
                border: "none", cursor: "pointer", borderRadius: "var(--r-card)", padding: "40px 12px",
                background: muted ? "var(--amber-a08)" : "var(--accent-a12)",
                color: muted ? "var(--amber)" : "var(--accent)",
              }}>
              <div className="t-title1">{muted ? "Silent — keep going" : "Click"}</div>
              <div className="t-num" style={{ fontSize: 40, fontWeight: 700, marginTop: 6 }}>{taps}</div>
              <div className="t-cap" style={{ color: "var(--sub)", marginTop: 4 }}>
                tap on every beat one · bar {bar + 1} of {BARS}
              </div>
            </button>
            <Button kind="quiet" full onClick={stop}>Stop and measure</Button>
          </>
        )}

        {state === "done" && (
          result && result.n >= 3 ? (
            <>
              <Grid min={130} gap={10}>
                <StatTile value={`${result.meanMs > 0 ? "+" : ""}${result.meanMs}ms`} label="average"
                  valueTone={Math.abs(result.meanMs) <= 20 ? "var(--green)" : "var(--amber)"} />
                <StatTile value={`${result.sdMs}ms`} label="spread" />
                <StatTile value={result.tendency} label="tendency" />
              </Grid>
              <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
                {result.tendency === "rushing"
                  ? "You come in early. Almost everyone does — the fix is not to slow down but to put the click on 2 and 4 so there is nothing to hide behind."
                  : result.tendency === "dragging"
                    ? "You come in late. Usually a right hand that is waiting to be sure rather than committing. Play it louder and earlier than feels right for a few minutes."
                    : `Even, within ${Math.abs(result.meanMs)}ms.${grade ? ` That is ${grade.label.toLowerCase()}.` : ""}`}
              </div>
              <Button kind="primary" full onClick={() => setState("idle")}>Again</Button>
            </>
          ) : (
            <EmptyState icon="🥁" title="Not enough taps to measure"
              sub="Tap on every beat one, including through the silent bars — three taps is the minimum for an average that means anything."
              action={<Button kind="tinted" onClick={() => setState("idle")}>Try again</Button>} />
          )
        )}
      </div>
    </Sheet>
  );
}

// ─── ear training ────────────────────────────────────────────────────────────
// A drone holds the key, a note sounds, you name the degree. KEY-CENTRE FIRST,
// intervals later: you hear music in a key, not as a stack of intervals from
// whatever note happened to come before. Degrees unlock as accuracy allows —
// 1, 3 and 5 first, then 2 and 6, then 4 and 7.
const DEGREE_TIERS = [[0, 4, 7], [0, 2, 4, 7, 9], [0, 2, 4, 5, 7, 9, 11]];
const DEGREE_NAMES = { 0: "1", 2: "2", 4: "3", 5: "4", 7: "5", 9: "6", 11: "7" };

function EarRunner({ onClose, isMobile }) {
  const [tonic] = useState(() => 48 + Math.floor(Math.random() * 12));  // C3–B3
  const [tier, setTier] = useState(0);
  const [prompt, setPrompt] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [history, setHistory] = useState([]);
  // Same class of bug as the mute above: the button said "Drone on" for ever
  // because whether the drone was playing lived in a ref nothing re-rendered on.
  const [droning, setDroning] = useState(false);
  const stopDrone = useRef(null);

  const degrees = DEGREE_TIERS[tier];
  const recent = history.slice(-20);
  const acc = recent.length >= 5 ? Math.round((recent.filter(Boolean).length / recent.length) * 100) : null;

  useEffect(() => () => { stopDrone.current?.(); stopDrone.current = null; }, []);

  const startDrone = async () => {
    await unlock();
    stopDrone.current?.();
    stopDrone.current = playDrone(tonic - 12, { gain: 0.16 });
    setDroning(true);
  };

  const next = async () => {
    await unlock();
    if (!stopDrone.current) await startDrone();
    const d = degrees[Math.floor(Math.random() * degrees.length)];
    setPrompt(d); setAnswer(null);
    playNote(tonic + d + 12, { at: audioNow() + 0.25, gain: 0.6 });
  };

  const guess = (d) => {
    if (answer != null) return;
    const ok = d === prompt;
    setAnswer(d);
    setHistory((h) => [...h, ok]);
    playNote(tonic + prompt + 12, { gain: 0.55 });
  };

  // 85% rolling accuracy opens the next tier. Below 80 it closes again — the
  // point is to sit in the band where learning happens, not to collect tiers.
  useEffect(() => {
    if (acc == null) return;
    if (acc >= 85 && tier < DEGREE_TIERS.length - 1) { setTier((t) => t + 1); setHistory([]); }
    else if (acc < 70 && tier > 0) { setTier((t) => t - 1); setHistory([]); }
  }, [acc, tier]);

  return (
    <Sheet title="Scale degrees by ear" onClose={() => { stopDrone.current?.(); onClose(); }} detent={isMobile ? "large" : "auto"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 6 }}>
        <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
          A drone holds {pcName(mod12(tonic))} as home. A note sounds against it — which degree was
          it? Start with 1, 3 and 5; 2 and 6 unlock at 85%, then 4 and 7.
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
          <span className="t-foot" style={{ color: "var(--faint)" }}>
            {degrees.length} degrees{acc != null ? ` · ${acc}% over ${recent.length}` : ""}
          </span>
          <Button kind="quiet" size="sm"
            onClick={() => { if (stopDrone.current) { stopDrone.current(); stopDrone.current = null; setDroning(false); } else startDrone(); }}>
            {droning ? "Drone off" : "Drone on"}
          </Button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(4, degrees.length)}, minmax(0,1fr))`, gap: 8 }}>
          {degrees.map((d) => {
            const chosen = answer === d;
            const correct = answer != null && d === prompt;
            return (
              <button key={d} type="button" disabled={prompt == null || answer != null} onClick={() => guess(d)}
                aria-label={`Scale degree ${DEGREE_NAMES[d]}`}
                style={{
                  minHeight: 62, border: "none", borderRadius: "var(--r-ctl)", cursor: prompt == null || answer != null ? "default" : "pointer",
                  background: correct ? "var(--green-a06)" : chosen ? "var(--red-a32)" : "var(--surface-2)",
                  color: correct ? "var(--green)" : "var(--ink)", fontWeight: 700, fontSize: 22,
                  opacity: prompt == null ? 0.5 : 1,
                }}>{DEGREE_NAMES[d]}</button>
            );
          })}
        </div>

        <Button kind="primary" size="lg" full onClick={next}>
          {prompt == null ? "Play a note" : answer != null ? (answer === prompt ? "Right — next" : `It was ${DEGREE_NAMES[prompt]} — next`) : "Play it again"}
        </Button>
        {prompt != null && answer == null && (
          <Button kind="quiet" full onClick={() => playNote(tonic + prompt + 12, { gain: 0.6 })}>Hear it again</Button>
        )}
      </div>
    </Sheet>
  );
}

// ─── the jam picker ──────────────────────────────────────────────────────────
function JamSetup({ onClose, onPlay, isMobile }) {
  const [prog, setProg] = useState("blues12");
  const [tonic, setTonic] = useState(4);
  const [strum, setStrum] = useState("shuffle");
  const [bpm, setBpm] = useState(90);
  const p = PROGRESSIONS.find((x) => x.key === prog);
  const backing = useMemo(
    () => buildBacking({ progression: prog, tonicPc: tonic, strum, swing: strumByKey(strum).swing || 0, bass: "root_fifth" }),
    [prog, tonic, strum]);
  const scaleKey = p?.minor || /blues/.test(prog) ? "minor_pent" : "major_pent";

  return (
    <Sheet title="Jam" onClose={onClose} detent={isMobile ? "large" : "auto"}
      footer={<Button kind="primary" size="lg" full onClick={() => onPlay({ backing, bpm, title: `${p?.name} in ${pcName(tonic)}` })}>Play it</Button>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 6 }}>
        <PillRow options={PROGRESSIONS.map((x) => ({ key: x.key, label: x.name }))} value={prog} onChange={setProg} label="Progression" />
        {p?.example && <div className="t-foot" style={{ color: "var(--faint)" }}>{p.example}</div>}
        <PillRow options={SHARP_NAMES.map((n, pc) => ({ key: pc, label: n }))} value={tonic} onChange={setTonic} label="Key" />
        <PillRow options={STRUM_PATTERNS.map((s) => ({ key: s.key, label: s.name }))} value={strum} onChange={setStrum} label="Strum" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {backing.chords.map((c, i) => (
            <span key={i} className="t-num" style={{
              minWidth: 46, textAlign: "center", padding: "5px 6px", borderRadius: 8,
              background: "var(--surface-2)", color: "var(--sub)", fontSize: 12.5, fontWeight: 650,
            }}>{c.symbol}</span>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="t-num" style={{ fontSize: 22, fontWeight: 700, minWidth: 50 }}>{bpm}</div>
          <input type="range" min={50} max={200} value={bpm} onChange={(e) => setBpm(Number(e.target.value))}
            aria-label="Tempo" style={{ flex: 1, accentColor: "var(--accent)" }} />
        </div>
        <div>
          <div className="t-label" style={{ color: "var(--sub)", marginBottom: 6 }}>What to play over it</div>
          <Fretboard dots={scaleMap(tonic, scaleKey, { fromFret: 0, toFret: 15 })} toFret={15} height={isMobile ? 140 : 160} label="degree" />
          <div className="t-cap" style={{ color: "var(--faint)", marginTop: 6 }}>
            {pcName(tonic)} {scaleKey === "minor_pent" ? "minor" : "major"} pentatonic. Land on gold, blue and green when the chord changes — those are the chord tones.
          </div>
        </div>
      </div>
    </Sheet>
  );
}

// ─── the panel ───────────────────────────────────────────────────────────────
export function DrillsPanel({ isMobile, settings, updateSetting, onOpenMetronome }) {
  const gs = settings?.guitar || {};
  const tuning = tuningByKey(gs.tuning || "standard").midi;
  const skillsQ = useGuitarSkills();
  const saveSkills = useSaveGuitarSkills();
  const [open, setOpen] = useState(null);
  const [jam, setJam] = useState(null);
  const [toast, setToast] = useState(null);

  // The chord pairs One-Minute Changes offers, weakest first — the pairs in the
  // curriculum, ordered by how they have actually been going.
  const pairs = useMemo(() => {
    const rows = new Map((skillsQ.data?.rows || []).map((r) => [r.id, r]));
    return SKILLS.filter((s) => s.kind === "change")
      .map((s) => ({ id: s.id, pair: s.pair, strength: rows.get(s.id)?.strength ?? 0 }))
      .sort((a, b) => a.strength - b.strength);
  }, [skillsQ.data]);

  const logOMC = async ({ pair, count }) => {
    const skill = SKILLS.find((s) => s.kind === "change" && s.pair?.join() === pair.join());
    if (!skill) return;
    const prev = (skillsQ.data?.rows || []).find((r) => r.id === skill.id);
    const target = skill.target || 30;
    const rating = count >= target ? "clean" : count >= target * 0.6 ? "shaky" : "rough";
    const { applyResult, dayOf } = await import("../../lib/guitar/practice.js");
    const next = applyResult(prev || { id: skill.id }, { rating, bpm: count, day: dayOf(Date.now()), seconds: 60 });
    try {
      await saveSkills.mutateAsync([next]);
      setToast({ tone: "var(--green)", text: `${count} changes logged against ${pair.join(" ↔ ")}.` });
    } catch (e) {
      setToast({ tone: "var(--red)", text: `Couldn't save: ${e.message || "the write didn't land"}` });
    }
  };

  const cards = [
    { key: "metronome", name: "Metronome", about: "Two-and-four, subdivisions, a tempo ramp, and drop-the-click. An error detector, not a speed tool.", run: onOpenMetronome },
    { key: "omc", name: "One-Minute Changes", about: DRILLS.find((d) => d.key === "omc").about, run: () => setOpen("omc") },
    { key: "drift", name: "Drop the click", about: DRILLS.find((d) => d.key === "drift").about, run: () => setOpen("drift") },
    { key: "jam", name: "Play over the changes", about: DRILLS.find((d) => d.key === "jam").about, run: () => setOpen("jam") },
    { key: "ear", name: "Scale degrees by ear", about: DRILLS.find((d) => d.key === "degrees").about, run: () => setOpen("ear") },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {cards.map((c) => (
        <Card key={c.key} pad="md" pressable onClick={c.run}>
          <div className="t-head">{c.name}</div>
          <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.55, marginTop: 4 }}>{c.about}</div>
        </Card>
      ))}

      <Card pad="md">
        <SectionHeader title="Strumming patterns" trailing="easiest first" />
        <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6, marginBottom: 8 }}>
          A dash is not a rest — it is the hand travelling past the strings without hitting them.
          The hand never stops moving. That one fact is what makes patterns five and seven click.
        </div>
        <CellGroup>
          {STRUM_PATTERNS.map((p) => (
            <Cell key={p.key} title={p.name}
              sub={`${p.feel} · ${p.songs.slice(0, 2).join(", ")}`}
              value={<span className="t-num" style={{ fontSize: 13, letterSpacing: "0.18em" }}>{p.pattern}</span>} />
          ))}
        </CellGroup>
      </Card>

      {open === "omc" && <OMCRunner isMobile={isMobile} pairs={pairs} onClose={() => setOpen(null)} onResult={logOMC} />}
      {open === "drift" && <DriftRunner isMobile={isMobile} onClose={() => setOpen(null)} />}
      {open === "ear" && <EarRunner isMobile={isMobile} onClose={() => setOpen(null)} />}
      {open === "jam" && !jam && <JamSetup isMobile={isMobile} onClose={() => setOpen(null)} onPlay={(j) => { setJam(j); setOpen(null); }} />}
      {jam && <PlayerBar title={jam.title} backing={jam.backing} bpm={jam.bpm} isMobile={isMobile} onClose={() => setJam(null)} />}

      {toast && (
        <div className="toasts">
          <div className="toast">
            <span className="tdot" style={{ background: toast.tone }} />
            <span>{toast.text}</span>
            <button onClick={() => setToast(null)} aria-label="Dismiss"
              style={{ background: "none", border: "none", color: "var(--accent)", fontWeight: 600, fontSize: 13.5, cursor: "pointer", padding: "6px 4px", margin: "-6px 0" }}>OK</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DrillsPanel;
