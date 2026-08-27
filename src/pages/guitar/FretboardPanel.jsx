// ─── Fretboard — the reference and the drills, on one screen ─────────────────
// Reference and trainer live together because you look a shape up IN ORDER TO
// drill it. Splitting them into two sub-tabs would mean tapping back and forth
// between a picture and a test of the same picture, which is the kind of
// navigation that gets a feature abandoned.
//
// Everything drawn here is generated, not stored: the scale maps come out of
// lib/guitar/fretboard.js's scaleMap and threeNotePerString, the CAGED positions
// out of placeShape, and the chord voicings out of the verified library. So the
// neck is correct in every key, every tuning and every scale this app knows
// about, rather than in the handful somebody drew.

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, SectionHeader, Button, Segmented, PillRow, CellGroup, Cell, EmptyState, Grid } from "../../ui/kit.jsx";
import { SHARP_NAMES, SCALES, CHORDS, scaleByKey, pcName, keyChords, keyUsesFlats, CIRCLE_OF_FIFTHS, mod12 } from "../../lib/guitar/theory.js";
import {
  scaleMap, pentatonicBox, threeNotePerString, cagedPositions, tuningByKey,
  positionsOfPc, midiAt, voicingMidi,
} from "../../lib/guitar/fretboard.js";
import { voicingsFor, voicingName } from "../../lib/guitar/chords.js";
import { playNote, playStrum, unlock, audioNow } from "../../lib/guitar/audio.js";
import Fretboard from "./Fretboard.jsx";
import ChordDiagram from "./ChordDiagram.jsx";

const MODES = [
  { key: "chords", label: "Chords" },
  { key: "scales", label: "Scales" },
  { key: "caged", label: "CAGED" },
  { key: "train", label: "Train" },
];
// The qualities a picker can hold without becoming a wall of options. The rest
// are still reachable — anything the chart parser accepts resolves through
// lookupChord — but a strip of twenty-five is not a picker, it is a list.
const COMMON_QUALITIES = ["maj", "min", "7", "m7", "maj7", "sus2", "sus4", "5", "add9", "dim7", "m7b5", "9"];

// ─── chords ──────────────────────────────────────────────────────────────────
function ChordsMode({ rootPc, tuning, isMobile }) {
  const [quality, setQuality] = useState("maj");
  const [showIntervals, setShowIntervals] = useState(false);
  const voicings = useMemo(() => voicingsFor(rootPc, quality, { tuning }), [rootPc, quality, tuning]);
  const flats = keyUsesFlats(rootPc, quality === "min" || quality === "m7");
  const name = useMemo(() => {
    const q = CHORDS.find((c) => c.key === quality);
    return pcName(rootPc, { flats }) + (q?.sym ?? "");
  }, [rootPc, quality, flats]);

  const play = async (v) => {
    await unlock();
    playStrum(voicingMidi(v.frets, tuning), { gain: 0.55 });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PillRow options={COMMON_QUALITIES.map((k) => ({ key: k, label: CHORDS.find((c) => c.key === k)?.sym || k }))}
        value={quality} onChange={setQuality} label="Chord quality"
        fmt={(o) => (o.label === "" ? "major" : o.label)} />

      <Card pad="md">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div className="t-title1">{name}</div>
          <button type="button" onClick={() => setShowIntervals((v) => !v)}
            className="sec-link" style={{ background: "none", border: "none", cursor: "pointer" }}>
            {showIntervals ? "Hide intervals" : "Show intervals"}
          </button>
        </div>
        {voicings.length === 0 ? (
          <EmptyState icon="🎸" title="No shape for that here"
            sub="Every voicing this app draws has been checked against the notes it actually sounds, and there isn't a verified one for this chord in this tuning yet." />
        ) : (
          <Grid min={isMobile ? 118 : 140} gap={12}>
            {/* If ANY shape in this grid has a name of its own, every box reserves
                the band for one, so the nuts stay on a line. */}
            {voicings.slice(0, 8).map((v) => (
              <div key={v.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                {/* Named only when the name is NOT the card's own title — an
                    inversion (C/G) and a plain C are different chords and the
                    grid has to say which is which, but repeating "C" over eight
                    boxes under a heading that already says C is noise. */}
                <ChordDiagram frets={v.frets} fingers={v.fingers} barre={v.barre} rootPc={rootPc}
                  showIntervals={showIntervals} tuning={tuning} size={isMobile ? 112 : 128}
                  onClick={() => play(v)}
                  label={voicingName(v, { flats }) !== name ? voicingName(v, { flats }) : null}
                  labelSpace={voicings.slice(0, 8).some((o) => voicingName(o, { flats }) !== name)}
                  sub={v.shapeName || (v.tags?.includes("campfire") ? "campfire" : v.open ? "open" : null)} />
                <button type="button" onClick={() => play(v)} className="sec-link"
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12 }}>Play</button>
              </div>
            ))}
          </Grid>
        )}
        {voicings[0]?.why && (
          <div className="t-foot" style={{ color: "var(--sub)", marginTop: 10, lineHeight: 1.5 }}>
            {voicingName(voicings[0])}: {voicings[0].why}.
          </div>
        )}
      </Card>

      <Card pad="md">
        <SectionHeader title={`The key of ${pcName(rootPc, { flats: keyUsesFlats(rootPc) })}`} />
        <CellGroup>
          {keyChords(rootPc, quality === "min" || quality === "m7").map((c) => (
            <Cell key={c.degree} leading={<span className="t-num" style={{ fontSize: 12 }}>{c.numeral}</span>}
              title={c.name}
              sub={c.degree === 1 ? "home" : c.degree === 5 ? "the one that wants to go home" : c.degree === 4 ? "the other one that always works" : null}
              onClick={async () => { await unlock(); const v = voicingsFor(c.rootPc, c.quality, { tuning })[0]; if (v) playStrum(voicingMidi(v.frets, tuning), { gain: 0.5 }); }}
              chevron={false} />
          ))}
        </CellGroup>
      </Card>
    </div>
  );
}

// ─── scales ──────────────────────────────────────────────────────────────────
function ScalesMode({ rootPc, tuning, isMobile }) {
  const [scaleKey, setScaleKey] = useState("minor_pent");
  // C minor pentatonic is C E♭ F G B♭, never C D♯ F G A♯. The accidental is a
  // property of the key, and a scale whose third is a MINOR third is read flat.
  const minorish = /minor|blues|dorian|phrygian|locrian|aeolian/.test(scaleKey);
  const flats = keyUsesFlats(rootPc, minorish);
  const [view, setView] = useState("all");   // all | box1..5 | 3nps
  const scale = scaleByKey(scaleKey);
  const isPent = scaleKey === "minor_pent" || scaleKey === "major_pent";
  const has7 = (scale?.steps?.length || 0) === 7;

  const dots = useMemo(() => {
    if (view === "all") return scaleMap(rootPc, scaleKey, { tuning, fromFret: 0, toFret: 15 });
    if (view.startsWith("box")) {
      const box = pentatonicBox(rootPc, Number(view.slice(3)) - 1, { scaleKey, tuning });
      return box?.dots || [];
    }
    if (view.startsWith("pos")) {
      const p = threeNotePerString(rootPc, scaleKey, Number(view.slice(3)) - 1, { tuning });
      return p?.dots || [];
    }
    return [];
  }, [rootPc, scaleKey, view, tuning]);

  // THE NECK IS AS LONG AS THE SHAPE ON IT. Pentatonic box 5 in D minor reaches
  // the twenty-second fret; drawn on a board that stopped at fifteen, seven of
  // its dots landed outside the coordinate table and SVG dropped them without a
  // sound — Box 3 quietly showed eleven of its twelve notes and looked fine.
  // The board scrolls, so a longer neck costs nothing but the scrollbar.
  const toFret = useMemo(
    () => Math.min(22, Math.max(15, ...dots.map((d) => d.fret + 1))),
    [dots]);

  const views = [
    { key: "all", label: "Whole neck" },
    ...(isPent ? [1, 2, 3, 4, 5].map((n) => ({ key: `box${n}`, label: `Box ${n}` })) : []),
    ...(has7 ? [1, 2, 3, 4, 5, 6, 7].map((n) => ({ key: `pos${n}`, label: `Pos ${n}` })) : []),
  ];
  useEffect(() => { if (!views.some((v) => v.key === view)) setView("all"); /* eslint-disable-next-line */ }, [scaleKey]);

  // Playing a scale is the fastest way to find out whether the shape on screen is
  // the sound you meant. Ascending, one note every 160 ms, from the lowest dot.
  const playScale = async () => {
    await unlock();
    // Ascending, one note every 160 ms, scheduled on the AUDIO clock — a run of
    // notes fired from setTimeout arrives unevenly enough to hear, and an uneven
    // scale is a scale you cannot check a shape against.
    const seen = new Set();
    const notes = [...dots].sort((a, b) => a.midi - b.midi)
      .filter((d) => (seen.has(d.midi) ? false : (seen.add(d.midi), true)))
      .slice(0, 16);
    const t0 = audioNow() + 0.05;
    notes.forEach((d, i) => playNote(d.midi, { at: t0 + i * 0.16, gain: 0.5 }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PillRow options={SCALES.map((s) => ({ key: s.key, label: s.name }))} value={scaleKey} onChange={setScaleKey} label="Scale" />
      <Card pad="md">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div>
            <div className="t-title2">{pcName(rootPc, { flats })} {scale?.name?.toLowerCase()}</div>
            <div className="t-foot" style={{ color: "var(--faint)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
              {(scale?.steps || []).map((st) => pcName(mod12(rootPc + st), { flats })).join(" · ")}
            </div>
          </div>
          <Button kind="tinted" size="sm" onClick={playScale}>Hear it</Button>
        </div>
        {views.length > 1 && <PillRow options={views} value={view} onChange={setView} label="Position" style={{ marginBottom: 10 }} />}
        <Fretboard tuning={tuning} dots={dots} toFret={toFret} label="degree" height={isMobile ? 152 : 176}
          onDot={async (d) => { await unlock(); playNote(d.midi, { gain: 0.6 }); }} />
        <div className="t-cap" style={{ color: "var(--faint)", marginTop: 8, lineHeight: 1.5 }}>
          Gold is the root. Blue is the third, green the fifth, purple the seventh — the notes that
          land well on a chord change. Tap any dot to hear it.
        </div>
      </Card>
    </div>
  );
}

// ─── CAGED ───────────────────────────────────────────────────────────────────
function CagedMode({ rootPc, tuning, isMobile }) {
  const positions = useMemo(() => cagedPositions(rootPc, { tuning, maxFret: 15 }), [rootPc, tuning]);
  const [sel, setSel] = useState(0);
  const p = positions[Math.min(sel, positions.length - 1)] || null;
  const dots = useMemo(() => {
    if (!p) return [];
    return p.frets.map((f, s) => (f == null ? null : {
      string: s, fret: f, pc: mod12(tuning[s] + f),
      degree: mod12(tuning[s] + f - rootPc), root: mod12(tuning[s] + f) === mod12(rootPc),
      midi: midiAt(s, f, tuning),
    })).filter(Boolean);
  }, [p, tuning, rootPc]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card pad="md">
        <SectionHeader title="One chord, five places" trailing={`${positions.length} shapes`} />
        <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6, marginBottom: 10 }}>
          The same five shapes you already know as open chords — C, A, G, E, D — moved up the neck so
          their root lands on {pcName(rootPc)}. They interlock in that order, always, in every key.
          Once you can see them the neck stops being twelve unrelated boxes.
        </div>
        <PillRow options={positions.map((q, i) => ({ key: i, label: `${q.letter} shape · fret ${q.baseFret || "open"}` }))}
          value={sel} onChange={setSel} label="CAGED position" style={{ marginBottom: 10 }} />
        {p ? (
          <>
            <Fretboard tuning={tuning} dots={dots} toFret={15} label="degree" height={isMobile ? 148 : 172}
              onDot={async (d) => { await unlock(); playNote(d.midi, { gain: 0.6 }); }} />
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <ChordDiagram frets={p.frets} barre={p.barre == null ? null : { fret: p.barre, from: p.frets.findIndex((f) => f != null), to: 5 }}
                rootPc={rootPc} tuning={tuning} size={isMobile ? 118 : 132} label={`${p.letter} shape`} />
              <div style={{ flex: 1, minWidth: 170 }}>
                <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
                  Root on fret {p.rootFret}{p.barre != null ? `, barre at ${p.barre}` : ", open strings"}.
                  {" "}The shape below it is the {positions[(sel + positions.length - 1) % positions.length]?.letter}; above it, the {positions[(sel + 1) % positions.length]?.letter}.
                </div>
                <Button kind="tinted" size="sm" style={{ marginTop: 8 }}
                  onClick={async () => { await unlock(); playStrum(voicingMidi(p.frets, tuning), { gain: 0.55 }); }}>Hear it</Button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState icon="🎸" title="Nothing fits on this neck" sub="Every CAGED position for this root would need a fret past the fifteenth." />
        )}
      </Card>

      <Card pad="md">
        <SectionHeader title="The circle" />
        <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6, marginBottom: 8 }}>
          Neighbours on the circle share all but one note, which is why almost every song moves
          between them. The minor underneath each key is its relative — same notes, different home.
        </div>
        <CellGroup>
          {CIRCLE_OF_FIFTHS.slice(0, 8).map((c) => (
            <Cell key={c.pc} title={c.major} sub={`${c.minor} · ${c.accidentals === 0 ? "no sharps or flats" : c.accidentals > 0 ? `${c.accidentals} sharp${c.accidentals === 1 ? "" : "s"}` : `${-c.accidentals} flat${c.accidentals === -1 ? "" : "s"}`}`}
              value={keyChords(c.pc).map((k) => k.name).slice(0, 4).join(" ")}
              titleStyle={c.pc === mod12(rootPc) ? { color: "var(--accent)" } : undefined} />
          ))}
        </CellGroup>
      </Card>
    </div>
  );
}

// ─── the trainers ────────────────────────────────────────────────────────────
// Note Finder and Reverse Finder. Both are timed, both log per-note times, and
// both bias the next prompt toward whatever has been slowest — which is the
// entire difference between a drill and a quiz.
function TrainMode({ tuning, isMobile }) {
  const [drill, setDrill] = useState("find");
  const [target, setTarget] = useState(() => Math.floor(Math.random() * 12));
  const [found, setFound] = useState([]);
  const [wrong, setWrong] = useState(null);
  const [startedAt, setStartedAt] = useState(null);
  const [times, setTimes] = useState({});      // pc -> [seconds]
  const [reverse, setReverse] = useState(null); // { string, fret, answerPc }
  const [reverseResult, setReverseResult] = useState(null);
  const timerRef = useRef(null);
  const wrongTimer = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => () => clearTimeout(wrongTimer.current), []);

  const answers = useMemo(() => positionsOfPc(target, { tuning, maxFret: 12 }), [target, tuning]);
  // Fret 12 is the octave of the open string; counting both would mean two taps
  // for the same note in the same place, so the open string is the one that
  // counts and the drill runs to the eleventh fret plus the opens.
  const wanted = useMemo(() => answers.filter((a) => a.fret < 12), [answers]);

  useEffect(() => {
    if (!startedAt) return undefined;
    const t = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 100);
    timerRef.current = t;
    return () => clearInterval(t);
  }, [startedAt]);

  const nextTarget = () => {
    // Weight toward the slowest notes, which is what makes this a drill.
    const scored = SHARP_NAMES.map((_, pc) => {
      const xs = times[pc] || [];
      const avg = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 30;
      return { pc, weight: avg + (xs.length ? 0 : 10) };
    });
    const total = scored.reduce((a, s) => a + s.weight, 0);
    let r = Math.random() * total;
    for (const s of scored) { r -= s.weight; if (r <= 0) { setTarget(s.pc); break; } }
    setFound([]); setWrong(null); setStartedAt(Date.now()); setElapsed(0);
  };

  const tapFret = ({ string, fret, midi }) => {
    if (drill === "reverse") return;
    if (!startedAt) setStartedAt(Date.now());
    const ok = mod12(midi) === mod12(target) && fret < 12;
    // One flash timer, replaced rather than stacked: two wrong taps in quick
    // succession used to queue two clears, and the first one landing wiped the
    // second dot after 200 ms instead of 500.
    if (!ok) {
      setWrong({ string, fret });
      clearTimeout(wrongTimer.current);
      wrongTimer.current = setTimeout(() => setWrong(null), 500);
      return;
    }
    const key = `${string}:${fret}`;
    if (found.includes(key)) return;
    const next = [...found, key];
    setFound(next);
    unlock().then(() => playNote(midi, { gain: 0.55 }));
    if (next.length >= wanted.length) {
      const secs = (Date.now() - (startedAt || Date.now())) / 1000;
      setTimes((t) => ({ ...t, [target]: [...(t[target] || []), secs].slice(-5) }));
      setStartedAt(null);
    }
  };

  // Never the square you just answered. Uniform picking over 72 squares means a
  // repeat roughly one round in seventy-two, and the one time it happens it
  // reads as the drill having frozen rather than as a coincidence — you tap the
  // same answer, it goes green again, and there is nothing on screen to say a
  // new question was asked.
  const newReverse = () => {
    setReverse((prev) => {
      let s, f;
      do {
        s = Math.floor(Math.random() * tuning.length);
        f = Math.floor(Math.random() * 12);
      } while (prev && prev.string === s && prev.fret === f);
      return { string: s, fret: f, answerPc: mod12(midiAt(s, f, tuning)) };
    });
    setReverseResult(null);
  };
  // A FRESH QUESTION ON EVERY ARRIVAL, not only the first. Guarding on `!reverse`
  // alone meant Reverse → Note Finder → Reverse came back to the question you had
  // already answered, its answer still lit and all twelve buttons still disabled —
  // a drill with no way to continue but switching tabs again.
  useEffect(() => { if (drill === "reverse" && (!reverse || reverseResult)) newReverse(); /* eslint-disable-next-line */ }, [drill]);

  const dots = drill === "find"
    ? [
      ...found.map((k) => { const [s, f] = k.split(":").map(Number); return { string: s, fret: f, pc: target, root: true, degree: 0 }; }),
      ...(wrong ? [{ string: wrong.string, fret: wrong.fret, pc: null, tone: "var(--red)", degree: null }] : []),
    ]
    : reverse ? [{ string: reverse.string, fret: reverse.fret, pc: reverse.answerPc, tone: "var(--accent)", degree: null }] : [];

  const done = drill === "find" && found.length >= wanted.length && wanted.length > 0;
  const best = times[target]?.length ? Math.min(...times[target]) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Segmented options={[{ key: "find", label: "Note Finder" }, { key: "reverse", label: "Reverse" }]} value={drill} onChange={setDrill} />

      {drill === "find" ? (
        <Card pad="md">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <div>
              <div className="t-label" style={{ color: "var(--sub)" }}>Find every</div>
              <div className="t-ltitle" style={{ fontSize: 40, color: "var(--accent)" }}>{pcName(target)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="t-num" style={{ fontSize: 26, fontWeight: 700, color: done ? "var(--green)" : "var(--ink)" }}>
                {elapsed.toFixed(1)}s
              </div>
              <div className="t-cap" style={{ color: "var(--faint)" }}>
                {found.length}/{wanted.length}{best != null ? ` · best ${best.toFixed(1)}s` : ""}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <Fretboard tuning={tuning} dots={dots} toFret={11} label="none" height={isMobile ? 150 : 174}
              onFret={tapFret} showFretNumbers />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Button kind={done ? "primary" : "tinted"} full onClick={nextTarget}>{done ? "Next note" : "Skip"}</Button>
          </div>
          {done && (
            <div className="t-foot" style={{ color: "var(--green)", marginTop: 8, textAlign: "center" }}>
              All {wanted.length} in {elapsed.toFixed(1)}s. Under 30 is solid, under 15 is fluent.
            </div>
          )}
          <div className="t-cap" style={{ color: "var(--faint)", marginTop: 8, lineHeight: 1.5 }}>
            Frets 0–11 only — the twelfth is the open string again. The next note picked is the one
            you have been slowest at, which is the whole point.
          </div>
        </Card>
      ) : (
        <Card pad="md">
          <div className="t-label" style={{ color: "var(--sub)" }}>What note is this?</div>
          <div className="t-title1" style={{ marginTop: 2 }}>
            {reverse ? `String ${tuning.length - reverse.string}, fret ${reverse.fret}` : "—"}
          </div>
          <div style={{ marginTop: 10 }}>
            <Fretboard tuning={tuning} dots={reverseResult ? dots : []} toFret={11} label="none" height={isMobile ? 150 : 174} highlight={reverse} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0,1fr))", gap: 6, marginTop: 12 }}>
            {SHARP_NAMES.map((n, pc) => {
              const chosen = reverseResult?.picked === pc;
              const correct = reverseResult && pc === reverse.answerPc;
              return (
                <button key={pc} type="button" disabled={!!reverseResult} aria-label={`Answer ${n}`}
                  onClick={async () => {
                    setReverseResult({ picked: pc, ok: pc === reverse.answerPc });
                    await unlock();
                    playNote(midiAt(reverse.string, reverse.fret, tuning), { gain: 0.6 });
                  }}
                  style={{
                    minHeight: 44, border: "none", borderRadius: "var(--r-ctl)", cursor: reverseResult ? "default" : "pointer",
                    background: correct ? "var(--green-a06)" : chosen ? "var(--red-a32)" : "var(--surface-2)",
                    color: correct ? "var(--green)" : "var(--ink)", fontWeight: 650, fontSize: 14,
                  }}>{n}</button>
              );
            })}
          </div>
          {reverseResult && (
            <Button kind="primary" full style={{ marginTop: 10 }} onClick={newReverse}>
              {reverseResult.ok ? "Right — next" : `It was ${pcName(reverse.answerPc)} — next`}
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}

// ─── the panel ───────────────────────────────────────────────────────────────
export function FretboardPanel({ isMobile, settings, updateSetting }) {
  const gs = settings?.guitar || {};
  const [mode, setMode] = useState("chords");
  const [rootPc, setRootPc] = useState(Number.isInteger(gs.root) ? gs.root : 0);
  const tuning = tuningByKey(gs.tuning || "standard").midi;

  const setRoot = (pc) => {
    setRootPc(pc);
    if (settings != null) updateSetting?.("guitar", { ...gs, root: pc });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Segmented options={MODES} value={mode} onChange={setMode} />
      {mode !== "train" && (
        <PillRow options={SHARP_NAMES.map((n, pc) => ({ key: pc, label: n }))} value={rootPc} onChange={setRoot} label="Root note" />
      )}
      {mode === "chords" && <ChordsMode rootPc={rootPc} tuning={tuning} isMobile={isMobile} />}
      {mode === "scales" && <ScalesMode rootPc={rootPc} tuning={tuning} isMobile={isMobile} />}
      {mode === "caged" && <CagedMode rootPc={rootPc} tuning={tuning} isMobile={isMobile} />}
      {mode === "train" && <TrainMode tuning={tuning} isMobile={isMobile} />}
      {gs.tuning && gs.tuning !== "standard" && (
        <div className="t-cap" style={{ color: "var(--faint)", textAlign: "center" }}>
          Everything above is drawn for {tuningByKey(gs.tuning).name} ({tuningByKey(gs.tuning).short}). Change it in the tuner.
        </div>
      )}
    </div>
  );
}

export default FretboardPanel;
