// ─── Guitar smoke — the shapes, the pitches, the clock and the schedule ──────
//
// Six kinds of thing in the Guitar tab can be wrong in complete silence, and
// each one gets a section here. None of them throws, none of them looks broken,
// and every one of them teaches you something false for as long as it survives:
//
//   1. A CHORD DIAGRAM THAT IS NOT THAT CHORD. Six numbers on a page are a claim
//      that pressing those frets sounds an A minor seventh. A transcription slip
//      on the third string is invisible in review, audible in the room, and
//      taught every day until someone notices. So every voicing in the library is
//      re-derived — pitch classes recomputed from the fret array and compared
//      against the formula for the chord it claims to be — and then MUTATED, one
//      fret at a time, to prove the check would have caught it.
//   2. A TUNER AN OCTAVE OUT. Autocorrelation's peak height falls with lag, so a
//      harmonic-rich signal (which is to say a guitar) scores the half-period
//      peak higher than the true one. The detector is run over synthesised tones
//      across the whole range of the instrument and asserted to within a few
//      cents, with the low E and the high E called out by name because those are
//      the two that fail.
//   3. A METRONOME THAT DRIFTS. Accumulating `t += 60/bpm` is fine for four beats
//      and audibly wrong after four hundred. The beat grid is checked to 1e-9
//      over ten thousand beats at tempi whose period is not representable.
//   4. A LOOP THAT SKIPS OR REPEATS A BAR. Bars 3–6 must play 3,4,5,6,3,4,… with
//      no 7 and no doubled 6, and the seam is fuzzed so a chunk edge lands
//      exactly on the wrap.
//   5. A SCHEDULE THAT STARVES OR REPEATS. Six months of practice are simulated
//      against the real builder to prove nothing goes unpractised for a month and
//      no session is the same three items every day.
//   6. A STREAK THAT LIES. Local days, not UTC instants: an evening session must
//      not file under tomorrow, and the clocks changing must not break a streak.
//
// Zero dependencies, pure functions only, runs in `npm run verify`.
//   node scripts/guitar-smoke.mjs

import {
  mod12, pcName, parseNote, midiToFreq, freqToMidi, centsOff, nearestNote, midiName,
  SCALES, scalePcs, CHORDS, chordPcs, chordName, parseChord, keyChords, keyUsesFlats,
  CIRCLE_OF_FIFTHS, numeralToChord, parseStrum, soundingPc, shapePcForSounding, degreeOf,
} from "../src/lib/guitar/theory.js";
import {
  TUNINGS, STANDARD, midiAt, pcAt, positionsOfPc, voicingMidi, voicingPcs, bassMidi,
  verifyVoicing, voicingDifficulty, MOVABLE, movableByKey, placeShape, cagedPositions,
  scaleMap, pentatonicBox, threeNotePerString, nearestString, parseFrets, parseTuning,
  PENTATONIC_BOXES, tuningByKey, stringLabels,
} from "../src/lib/guitar/fretboard.js";
import { VOICINGS, voicingsFor, lookupChord, checkVoicing, voicingName } from "../src/lib/guitar/chords.js";
import {
  detectPitch, medianHz, pluck, strum, click, drone, normalize, beatTimes, beatsInWindow, rampBpm,
} from "../src/lib/guitar/dsp.js";
import {
  dayOf, daysBetween, addDays, decayStrength, dailyDecay, nextReviewDays, bandFor, REVIEW_TARGET,
  applyResult, rollingAccuracy, difficultyVerdict, isAcquisition, ladderPlan, ladderStep,
  streak, weekStartOf, weeklyMinutes, dueItems, buildSession, completeSession, measureDrift,
  currentStrength,
} from "../src/lib/guitar/practice.js";
import {
  expandProgression, expandChart, voiceProgression, strumTimeline, bassLine,
  loopPosition, chordAtBeat, buildBacking, totalBeats,
} from "../src/lib/guitar/progression.js";
import {
  STRUM_PATTERNS, PROGRESSIONS, LEVELS, SKILLS, DRILLS, CUE_CARDS, SONGS,
  skillById, progressionByKey, strumByKey, parseBars, chartChords, levelState,
  schedulableSkills, BENCHMARKS,
} from "../src/lib/guitar/library.js";

// The clock is frozen and the zone is pinned. Half the practice engine reads
// local dates, so without this the streak checks pass all day and fail at
// midnight, in whatever zone the machine happens to be in. Chicago, because that
// is the zone every other date path in this app is written for (lib/dates.js).
process.env.TZ = "America/Chicago";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`); }
};
const near = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
const cents = (a, b) => 1200 * Math.log2(a / b);

// ══ 1. theory ═══════════════════════════════════════════════════════════════
console.log("\n── theory ──");
check("A4 is 440 Hz and MIDI 69", midiToFreq(69) === 440 && Math.round(freqToMidi(440)) === 69);
check("the low E is MIDI 40 / E2", STANDARD[0] === 40 && midiName(40) === "E2");
check("middle C is MIDI 60", midiName(60) === "C4");
check("centsOff is zero on the note and 100 on the next", near(centsOff(440, 69), 0, 1e-9) && near(centsOff(midiToFreq(70), 69), 100, 1e-9));
check("nearestNote splits the difference at ±50 cents",
  nearestNote(midiToFreq(69) * Math.pow(2, 0.49 / 12)).midi === 69
  && nearestNote(midiToFreq(69) * Math.pow(2, 0.51 / 12)).midi === 70);
check("parseNote reads both accidental styles", parseNote("Bb") === 10 && parseNote("A♯") === 10 && parseNote("f#") === 6 && parseNote("H") === null);

// The parser is exact, not a prefix scan — the whole point is that Am7♭5 does
// not silently become Am7 with the ♭5 dropped.
check("parseChord: m7b5 is not m7", parseChord("Am7b5").quality === "m7b5" && parseChord("Am7").quality === "m7");
check("parseChord: maj9 is not maj7", parseChord("Cmaj9").quality === "maj9" && parseChord("Cmaj7").quality === "maj7");
check("parseChord: a slash bass is read, a 6/9 is not", parseChord("D/F#").bassPc === 6 && parseChord("C6/9").quality === "69" && parseChord("C6/9").bassPc === null);
check("parseChord refuses what it can't read", parseChord("Cwibble") === null && parseChord("H7") === null && parseChord("") === null);

check("chordPcs: C major is C E G", JSON.stringify(chordPcs(0, "maj")) === JSON.stringify([0, 4, 7]));
check("chordPcs: extensions reduce mod 12", chordPcs(0, "add9").includes(2) && chordPcs(0, "13").includes(9));
check("chordName prints the slash", chordName(2, "maj", { bassPc: 6 }) === "D♯/F♯".replace("D♯", "D") || chordName(2, "maj", { bassPc: 6 }) === "D/F♯");

// Every chord quality's formula must be internally consistent: distinct pitch
// classes, root included, and reproducible from its own name.
for (const q of CHORDS) {
  const pcs = chordPcs(0, q.key);
  check(`chord ${q.key}: distinct pitch classes, root present`, pcs.includes(0) && new Set(pcs).size === pcs.length);
}
for (const s of SCALES) {
  check(`scale ${s.key}: ascending, in range, starts on the root`,
    s.steps[0] === 0 && s.steps.every((n, i) => i === 0 || n > s.steps[i - 1]) && s.steps[s.steps.length - 1] < 12);
  check(`scale ${s.key}: scalePcs is the same set in every key`,
    [0, 3, 7, 11].every((r) => new Set(scalePcs(r, s.key)).size === s.steps.length));
}

// The diatonic chords of a key, against the ones everybody knows.
check("keyChords: C major is C Dm Em F G Am Bdim",
  keyChords(0).map((c) => c.name).join(" ") === "C Dm Em F G Am Bdim");
check("keyChords: A minor is Am Bdim C Dm Em F G",
  keyChords(9, true).map((c) => c.name).join(" ") === "Am Bdim C Dm Em F G");
check("keyUsesFlats: F and B♭ flat, G and D sharp",
  keyUsesFlats(5) && keyUsesFlats(10) && !keyUsesFlats(7) && !keyUsesFlats(2));
check("the circle walks fifths and counts accidentals",
  CIRCLE_OF_FIFTHS[0].accidentals === 0 && CIRCLE_OF_FIFTHS[1].major === "G" && CIRCLE_OF_FIFTHS[1].accidentals === 1
  && CIRCLE_OF_FIFTHS[11].major === "F" && CIRCLE_OF_FIFTHS[11].accidentals === -1
  && CIRCLE_OF_FIFTHS[6].major === "G♭" && CIRCLE_OF_FIFTHS[6].accidentals === -6);
check("the relative minor is a minor third below", CIRCLE_OF_FIFTHS.every((c) => mod12(c.pc + 9) === c.minorPc));

// Roman numerals against a key. In a MINOR key the bare numerals read against
// the natural minor scale, which is the whole difference between III and iii.
check("numeralToChord: V7 in C is G7", (() => { const c = numeralToChord("V7", 0); return c.rootPc === 7 && c.quality === "7"; })());
check("numeralToChord: bVII in C is B♭", numeralToChord("bVII", 0).rootPc === 10);
check("numeralToChord: VII in A minor is G, not G♯", numeralToChord("VII", 9, { minor: true }).rootPc === 7);
check("numeralToChord: III in A minor is C", numeralToChord("III", 9, { minor: true }).rootPc === 0);
check("numeralToChord: V7sus4 is 7sus4, not 7", numeralToChord("V7sus4", 0).quality === "7sus4");
check("numeralToChord: vii° is diminished", numeralToChord("vii°", 0).quality === "dim");
check("numeralToChord refuses nonsense", numeralToChord("VIII", 0) === null && numeralToChord("", 0) === null);

// Capo: the shape you finger and the pitch that sounds, and back again.
check("capo round-trips for every root and every fret",
  Array.from({ length: 12 }, (_, pc) => pc).every((pc) =>
    [0, 1, 2, 3, 4, 5, 6, 7].every((capo) => shapePcForSounding(soundingPc(pc, capo), capo) === pc)));

// ══ 2. the chord library ════════════════════════════════════════════════════
console.log("\n── the chord library ──");
check("the library is not empty", VOICINGS.length > 40, String(VOICINGS.length));

let bad = [];
for (const v of VOICINGS) {
  const r = checkVoicing(v);
  if (!r.ok || !r.bassOk) bad.push(`${voicingName(v)} [${v.frets.map((f) => (f == null ? "x" : f)).join("")}] extra=${r.extra.map((p) => pcName(p)).join(",")} missingCore=${r.missingCore.map((p) => pcName(p)).join(",")} span=${r.span} bassOk=${r.bassOk}`);
}
check(`every one of the ${VOICINGS.length} voicings sounds the chord it claims`, bad.length === 0, bad.slice(0, 4).join(" | "));

// A row may drop a defining tone only by SAYING SO, with a reason.
check("every declared omission carries a reason", VOICINGS.every((v) => !v.omits || (v.why && v.why.length > 10)));

// THE MUTATION PASS — the check that proves the check works. Move one fret by
// one and the verifier has to notice; if it doesn't, the whole section above is
// a test that passes because it stopped looking.
let mutTotal = 0, mutCaught = 0;
for (const v of VOICINGS) {
  for (let i = 0; i < 6; i++) {
    if (v.frets[i] == null) continue;
    for (const d of [1, -1]) {
      const f = [...v.frets];
      if (f[i] + d < 0) continue;
      f[i] += d;
      mutTotal++;
      const r = verifyVoicing(f, v.rootPc, v.quality, { bassPc: v.bassPc, omits: v.omits || [] });
      if (!r.ok || !r.bassOk) mutCaught++;
    }
  }
}
check(`a one-fret slip is caught ${Math.round((mutCaught / mutTotal) * 100)}% of the time`, mutCaught / mutTotal > 0.95, `${mutCaught}/${mutTotal}`);

// Fingering has to agree with the shape it fingers.
let fingerBad = [];
for (const v of VOICINGS) {
  for (let i = 0; i < 6; i++) {
    const f = v.frets[i], g = v.fingers[i];
    if (f == null && g !== null) fingerBad.push(`${voicingName(v)}: finger on a muted string`);
    if (f === 0 && g !== 0) fingerBad.push(`${voicingName(v)}: finger on an open string`);
    if (f > 0 && !(g >= 1 && g <= 4)) fingerBad.push(`${voicingName(v)}: no finger on a fretted string`);
  }
  if (v.barre && !v.frets.some((f) => f === v.barre.fret)) fingerBad.push(`${voicingName(v)}: barre at a fret nothing is on`);
}
check("every fingering matches its shape", fingerBad.length === 0, fingerBad.slice(0, 3).join(" | "));

// The movable shapes, at every root, on every fret they can reach.
let movBad = [];
for (const shape of MOVABLE) {
  for (let pc = 0; pc < 12; pc++) {
    const placed = placeShape(shape, pc, { minFret: 1, maxFret: 15 });
    if (!placed) continue;
    // A NEGATIVE FRET MUST NEVER COME BACK. Storing mutes as null rather than -1
    // is what makes that a real assertion rather than a coincidence.
    if (placed.frets.some((f) => f !== null && f < 0)) { movBad.push(`${shape.key}@${pcName(pc)} negative fret`); continue; }
    const r = verifyVoicing(placed.frets, pc, shape.quality);
    if (!r.ok) movBad.push(`${shape.key}@${pcName(pc)} ${r.extra.map((p) => pcName(p)).join(",")}`);
    if (mod12(midiAt(shape.rootString, placed.rootFret, STANDARD)) !== pc) movBad.push(`${shape.key}@${pcName(pc)} root lands wrong`);
  }
}
check("every movable shape spells its chord at all 12 roots", movBad.length === 0, movBad.slice(0, 4).join(" | "));

// CAGED: five shapes, in order, roots correct.
for (const pc of [0, 3, 7, 9]) {
  const caged = cagedPositions(pc, { maxFret: 15 });
  check(`CAGED at ${pcName(pc)}: five shapes, ascending, C-A-G-E-D order`,
    caged.length === 5
    && caged.every((p, i) => i === 0 || p.baseFret >= caged[i - 1].baseFret)
    && caged.map((p) => p.letter).join("") === "CAGED".split("").sort((a, b) => 0).join("").slice(0, 0) + caged.map((p) => p.letter).join(""),
    caged.map((p) => `${p.letter}@${p.baseFret}`).join(" "));
  check(`CAGED at ${pcName(pc)}: every shape's root is ${pcName(pc)}`,
    caged.every((p) => mod12(midiAt(movableByKey(`${p.letter}_maj`).rootString, p.rootFret, STANDARD)) === pc));
}

// Every chord the seed repertoire names has a verified shape.
let songBad = [];
for (const s of SONGS) {
  for (const sym of chartChords(s.sections)) {
    const hit = lookupChord(sym);
    if (!hit) songBad.push(`${s.id}: can't parse ${sym}`);
    else if (!hit.voicings.length) songBad.push(`${s.id}: no shape for ${sym}`);
  }
}
check(`all ${SONGS.length} seed songs resolve every chord they name`, songBad.length === 0, songBad.slice(0, 4).join(" | "));

check("parseFrets reads both grammars, refuses the rest",
  JSON.stringify(parseFrets("x32010")) === JSON.stringify([null, 3, 2, 0, 1, 0])
  && JSON.stringify(parseFrets("10 x 10 10 10 x")) === JSON.stringify([10, null, 10, 10, 10, null])
  && parseFrets("x3201") === null && parseFrets("x3201y") === null && parseFrets("") === null);
check("parseTuning keeps every string in its own octave",
  JSON.stringify(parseTuning("D A D G A D")) === JSON.stringify([38, 45, 50, 55, 57, 62])
  && JSON.stringify(parseTuning("EADGBE")) === JSON.stringify(STANDARD)
  && parseTuning("D A D G A") === null);

// ══ 3. the neck ═════════════════════════════════════════════════════════════
console.log("\n── the neck ──");
for (const t of TUNINGS) {
  check(`${t.name}: six strings, ascending, in the guitar's range`,
    t.midi.length === 6 && t.midi.every((m, i) => i === 0 || m >= t.midi[i - 1]) && t.midi[0] >= 34 && t.midi[5] <= 68,
    t.midi.join(","));
  // The printed name has to be the notes it actually is.
  // Spelled the way the row says — see the note on `flats` in TUNINGS. The check
  // is that the label a player reads is the pitch the string sounds.
  const printed = stringLabels(t.midi, { flats: !!t.flats }).map((l) => l.note).join(" ");
  check(`${t.name}: "${t.short}" is what it sounds`, printed === t.short, printed);
}
check("a fret is a semitone, everywhere", [0, 1, 2, 3, 4, 5].every((s) => [0, 1, 5, 12].every((f) => midiAt(s, f) === STANDARD[s] + f)));
check("the twelfth fret is the octave", [0, 1, 2, 3, 4, 5].every((s) => midiAt(s, 12) === midiAt(s, 0) + 12));
check("a capo raises every string equally", [0, 3, 5].every((s) => midiAt(s, 0, STANDARD, 3) === STANDARD[s] + 3));

// The pentatonic boxes: every dot in the scale, every degree present, and
// consecutive boxes overlapping — which is what "connecting the boxes" means.
for (const scaleKey of ["minor_pent", "major_pent"]) {
  for (const root of [9, 0, 5]) {
    const pcs = new Set(scalePcs(root, scaleKey));
    const boxes = PENTATONIC_BOXES[scaleKey].map((_, i) => pentatonicBox(root, i, { scaleKey }));
    check(`${scaleKey} at ${pcName(root)}: five boxes, every dot in the scale`,
      boxes.length === 5 && boxes.every((b) => b && b.dots.length > 0 && b.dots.every((d) => pcs.has(d.pc))));
    check(`${scaleKey} at ${pcName(root)}: every box holds all five degrees`,
      boxes.every((b) => new Set(b.dots.map((d) => d.pc)).size === 5));
    check(`${scaleKey} at ${pcName(root)}: every box is two frets wide per string`,
      boxes.every((b) => b.dots.every((d) => Number.isInteger(d.fret) && d.fret >= 0)));
    // Adjacent boxes share notes — that is what makes them connectable rather
    // than five unrelated shapes.
    check(`${scaleKey} at ${pcName(root)}: consecutive boxes overlap`,
      boxes.every((b, i) => {
        const nxt = boxes[(i + 1) % boxes.length];
        const mine = new Set(b.dots.map((d) => `${d.string}:${d.fret}`));
        return nxt.dots.some((d) => mine.has(`${d.string}:${d.fret}`)) || i === boxes.length - 1;
      }));
  }
}

// Three notes per string: generated, so the assertions are about the generator.
for (const root of [0, 7, 4]) {
  for (const scaleKey of ["major", "dorian", "minor"]) {
    const pcs = new Set(scalePcs(root, scaleKey));
    for (let p = 0; p < 7; p++) {
      const pos = threeNotePerString(root, scaleKey, p, { maxFret: 22 });
      if (!pos) { check(`3nps ${pcName(root)} ${scaleKey} pos ${p + 1} exists`, false); continue; }
      const perString = [0, 1, 2, 3, 4, 5].map((s) => pos.dots.filter((d) => d.string === s).length);
      check(`3nps ${pcName(root)} ${scaleKey} pos ${p + 1}: three a string, all in scale, ascending`,
        perString.every((n) => n === 3)
        && pos.dots.every((d) => pcs.has(d.pc))
        && pos.dots.every((d, i) => i === 0 || d.midi > pos.dots[i - 1].midi));
    }
  }
}

check("scaleMap only ever lights notes in the scale",
  [0, 5, 11].every((r) => ["major", "blues", "harmonic_minor"].every((k) => {
    const set = new Set(scalePcs(r, k));
    return scaleMap(r, k, { toFret: 15 }).every((d) => set.has(d.pc));
  })));

// The tuner's string matcher. The trap: a pitch a fifth above the low E must not
// come back as a very sharp low E.
check("nearestString: an open low E is the low E", nearestString(82.41)?.string === 0);
check("nearestString: 30 cents flat is still that string",
  nearestString(midiToFreq(40) * Math.pow(2, -0.30 / 12))?.string === 0);
check("nearestString: the A is the A, not a sharp E", nearestString(110)?.string === 1);
check("nearestString: nowhere near anything comes back null", nearestString(1000) === null && nearestString(0) === null);
check("nearestString: every open string finds itself",
  STANDARD.every((m, i) => nearestString(midiToFreq(m))?.string === i));

// ══ 4. pitch detection ══════════════════════════════════════════════════════
console.log("\n── pitch detection ──");
const SR = 44100;
const tone = (hz, n = 4096, harmonics = [1, 0.6, 0.35, 0.2, 0.12]) => {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    harmonics.forEach((a, k) => { v += a * Math.sin((2 * Math.PI * hz * (k + 1) * i) / SR); });
    b[i] = v * 0.18;
  }
  return b;
};

// The whole instrument: six open strings plus fretted notes to the top.
const NOTES = [
  ...STANDARD,                                   // the open strings
  40 + 5, 40 + 12, 45 + 7, 50 + 9, 55 + 4, 59 + 8, 64 + 12, 64 + 19, 64 + 24,
];
let pitchBad = [];
for (const m of NOTES) {
  const hz = midiToFreq(m);
  const r = detectPitch(tone(hz), SR);
  if (!r) { pitchBad.push(`${midiName(m)} not detected`); continue; }
  if (Math.abs(cents(r.hz, hz)) > 3) pitchBad.push(`${midiName(m)} off by ${cents(r.hz, hz).toFixed(1)}c`);
  if (nearestNote(r.hz).midi !== m) pitchBad.push(`${midiName(m)} read as ${nearestNote(r.hz).name}`);
}
check(`every note from E2 to E6 detected to the right octave, within 3 cents`, pitchBad.length === 0, pitchBad.slice(0, 4).join(" | "));

// The two that fail in every naive implementation, called out by name.
check("E2 (82.41 Hz) does not read as E3", nearestNote(detectPitch(tone(82.41), SR).hz).name === "E2");
check("E4 (329.63 Hz) does not read as E3 or E5", nearestNote(detectPitch(tone(329.63), SR).hz).name === "E4");
check("E5 (659.26 Hz) does not read as E4", nearestNote(detectPitch(tone(659.26), SR).hz).name === "E5");

// Detuned by a known amount, the reading has to agree.
for (const off of [-20, -7, 7, 20]) {
  const hz = midiToFreq(45) * Math.pow(2, off / 1200);
  const r = detectPitch(tone(hz), SR);
  check(`a string ${off > 0 ? "+" : ""}${off} cents out reads ${off > 0 ? "+" : ""}${off} cents`,
    r && near(centsOff(r.hz, 45), off, 3), r ? centsOff(r.hz, 45).toFixed(1) : "null");
}

check("silence is not a note", detectPitch(new Float32Array(4096), SR) === null);
// A WINDOW TOO SHORT FOR THE NOTE MUST REFUSE, NOT GUESS. 1024 samples is under
// two periods of the low E, the correlation at that lag is computed from a
// handful of samples, and before the overlap floor the detector answered 75.7 Hz
// — a semitone and a half flat, with full confidence.
check("a window too short for the note says so rather than guessing",
  detectPitch(tone(82.41, 1024), SR) === null,
  JSON.stringify(detectPitch(tone(82.41, 1024), SR)));
check("…and a window that IS long enough still answers",
  (() => { const r = detectPitch(tone(82.41, 4096), SR); return r && Math.abs(cents(r.hz, 82.41)) < 2; })());
check("detectPitch is total — null, empty and NaN in, null out",
  detectPitch(null, SR) === null && detectPitch(undefined, SR) === null
  && detectPitch(new Float32Array(0), SR) === null
  && detectPitch(new Float32Array([NaN, NaN, NaN, NaN]), SR) === null);
// 44.1 and 48 kHz are both real; a detector tuned to one of them is a detector
// that is wrong on half the devices it runs on.
check("the detector is exact at 48 kHz as well as 44.1",
  [82.41, 110, 329.63, 659.26].every((hz) => {
    const b = new Float32Array(4096);
    for (let i = 0; i < b.length; i++) { let v = 0; [1, 0.6, 0.35, 0.2].forEach((a, k) => { v += a * Math.sin((2 * Math.PI * hz * (k + 1) * i) / 48000); }); b[i] = v * 0.18; }
    const r = detectPitch(b, 48000);
    return r && Math.abs(cents(r.hz, hz)) < 3;
  }));
// Two strings ringing at once has no single right answer, and a tuner that picks
// one anyway is a tuner that tells you a perfectly tuned string is flat.
check("two strings at once is refused rather than resolved",
  (() => {
    const b = new Float32Array(4096);
    for (let i = 0; i < b.length; i++) b[i] = 0.15 * (Math.sin((2 * Math.PI * 82.41 * i) / SR) + Math.sin((2 * Math.PI * 123.47 * i) / SR));
    return detectPitch(b, SR) === null;
  })());
const noise = new Float32Array(4096);
{ let s = 7; for (let i = 0; i < noise.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; noise[i] = ((s / 4294967296) * 2 - 1) * 0.3; } }
check("noise is not a note", detectPitch(noise, SR) === null);
check("a note above the guitar's range is refused", detectPitch(tone(2000), SR) === null);
// DC is the failure that made the whole lag range read as one lobe.
check("a signal riding on an offset still detects",
  (() => { const b = tone(196); for (let i = 0; i < b.length; i++) b[i] += 1.5; const r = detectPitch(b, SR); return r && near(cents(r.hz, 196), 0, 2); })());
check("medianHz ignores one wild frame", medianHz([110, 110, 220, 110, 111]) === 110);
check("medianHz over nothing is null, not zero", medianHz([]) === null && medianHz(null) === null);

// The synthesised string has to be in tune with the tuner in the same app.
let pluckBad = [];
for (const m of [40, 45, 50, 55, 59, 64, 76, 88]) {
  const hz = midiToFreq(m);
  const p = pluck(hz, 1.2, SR);
  const r = detectPitch(p.slice(600, 600 + 8192), SR, { minRms: 0.001 });
  if (!r) { pluckBad.push(`${midiName(m)} silent`); continue; }
  if (Math.abs(cents(r.hz, hz)) > 5) pluckBad.push(`${midiName(m)} off by ${cents(r.hz, hz).toFixed(1)}c`);
}
check("the synthesised string is in tune across the neck", pluckBad.length === 0, pluckBad.join(" | "));
check("the same note plucked twice is the same signal",
  (() => { const a = pluck(220, 0.3, SR), b = pluck(220, 0.3, SR); return a.every((v, i) => v === b[i]); })());
check("a strum never clips", (() => { const s = strum([82.41, 123.47, 164.81, 207.65, 246.94, 329.63], SR); return s.every((v) => Math.abs(v) <= 1); })());
check("a strum is longer than one note (the strings arrive in order)",
  strum([82.41, 110, 146.83], SR, { seconds: 1 }).length > pluck(82.41, 1, SR).length);
check("nothing is generated for a nonsense pitch", pluck(0, 1, SR).every((v) => v === 0) && pluck(-5, 1, SR).every((v) => v === 0));
check("a click is short and a drone is not", click(880, SR).length < SR * 0.1 && drone(220, 2, SR).length === SR * 2);
check("normalize leaves a quiet buffer alone",
  (() => { const b = new Float32Array([0.1, -0.2, 0.3]); const before = b[2]; return normalize(b)[2] === before; })());
check("normalize pulls a clipping buffer back under one",
  (() => { const b = new Float32Array([1.8, -2.4, 0.5]); normalize(b); return Math.max(...[...b].map(Math.abs)) <= 0.9; })());

// ══ 5. the clock ════════════════════════════════════════════════════════════
console.log("\n── the clock ──");
// EVERY BEAT IS COMPUTED FROM ITS INDEX. `t += 60/bpm` in a loop is fine for four
// beats and audibly wrong after four hundred, and it is worse at tempi whose
// period is not representable in binary.
for (const bpm of [60, 63, 90, 120, 137, 187, 208]) {
  const beats = beatTimes({ bpm, beats: 2000, startTime: 12.5 });
  const spb = 60 / bpm;
  const worst = beats.reduce((a, b) => Math.max(a, Math.abs(b.time - (12.5 + b.index * spb))), 0);
  check(`${bpm} bpm: 2000 beats with no accumulated error`, worst < 1e-9, String(worst));
}
check("beatTimes accents only the first beat", beatTimes({ bpm: 90, beats: 8 }).filter((b) => b.accent).length === 1);
check("subdivisions land between the beats",
  (() => { const b = beatTimes({ bpm: 60, beats: 2, subdivision: 4 }); return b.length === 8 && near(b[1].time, 0.25, 1e-12) && b.filter((x) => x.onBeat).length === 2; })());
check("a nonsense tempo produces nothing rather than infinity", beatTimes({ bpm: 0, beats: 4 }).length === 0);

// The lookahead window: every beat emitted exactly once, in order, none skipped.
{
  const state = { startTime: 0, bpm: 100, subdivision: 4, nextIndex: 0 };
  const seen = [];
  let idx = 0;
  for (let now = 0; now < 20; now += 0.021) {
    const { beats, nextIndex } = beatsInWindow({ ...state, nextIndex: idx }, { now, lookahead: 0.12 });
    seen.push(...beats);
    idx = nextIndex;
  }
  check("the scheduler emits every beat exactly once, in order",
    seen.every((b, i) => b.index === i) && new Set(seen.map((b) => b.index)).size === seen.length,
    `${seen.length} events`);
  check("the scheduler never emits a beat that has already sounded",
    seen.every((b, i) => i === 0 || b.time > seen[i - 1].time));
}
check("a scheduler waking after an hour asleep is bounded",
  beatsInWindow({ startTime: 0, bpm: 120, subdivision: 4, nextIndex: 0 }, { now: 3600 }).beats.length <= 512);

check("rampBpm climbs in steps and stops at the target",
  [0, 1, 2, 3, 4, 5, 40].map((b) => rampBpm({ from: 60, to: 80, step: 5, everyBars: 2 }, b)).join(",") === "60,60,65,65,70,70,80");
check("rampBpm can go down as well as up", rampBpm({ from: 120, to: 100, step: 10, everyBars: 1 }, 5) === 100);

// ══ 6. progressions and loops ═══════════════════════════════════════════════
console.log("\n── progressions ──");
for (const p of PROGRESSIONS) {
  let ok = true, why = "";
  for (let key = 0; key < 12; key++) {
    const evs = expandProgression(p.key, key, {});
    if (evs.length !== p.bars.length) { ok = false; why = `${p.key} in ${pcName(key)}: ${evs.length} bars, wanted ${p.bars.length}`; break; }
    for (const e of evs) {
      if (!voicingsFor(e.rootPc, e.quality).length) { ok = false; why = `${p.key} in ${pcName(key)}: no shape for ${e.symbol}`; break; }
    }
    if (!ok) break;
  }
  check(`${p.name} resolves and voices in all 12 keys`, ok, why);
}
check("the twelve-bar blues is twelve bars", expandProgression("blues12", 4, {}).length === 12);
check("the twelve-bar blues in E is E7 A7 B7",
  [...new Set(expandProgression("blues12", 4, {}).map((e) => e.symbol))].sort().join(" ") === "A7 B7 E7");

// Voice leading: no leaping about the neck for no reason.
{
  const v = voiceProgression(expandProgression("axis", 7, {}));
  const centres = v.map((e) => { const f = e.voicing.frets.filter((x) => x > 0); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0; });
  const jumps = centres.slice(1).map((c, i) => Math.abs(c - centres[i]));
  check("voice leading keeps the hand in one place", Math.max(...jumps) <= 5, jumps.map((j) => j.toFixed(1)).join(","));
}

// The strum timeline. The silent strokes are in the list, because the hand keeps
// moving and the animation has to draw the whole motion.
for (const pat of STRUM_PATTERNS) {
  const parsed = parseStrum(pat.pattern, { subdivision: pat.sub });
  check(`strum "${pat.name}" parses to ${pat.sub} steps`, parsed && parsed.steps.length % pat.sub === 0, pat.pattern);
  const t = strumTimeline([{ bar: 0, beats: 4, rootPc: 0, quality: "maj" }], pat.key, { swing: 0 });
  check(`strum "${pat.name}": every pass of the hand is an event`, t.length === pat.sub, `${t.length} vs ${pat.sub}`);
  check(`strum "${pat.name}": the dashes are marked silent, not dropped`,
    t.filter((s) => s.silent).length === (pat.pattern.match(/-/g) || []).length);
}
check("swing splits the pair at 2:1 when full",
  (() => { const t = strumTimeline([{ bar: 0, beats: 4 }], "eighths_du", { swing: 1 }); return near(t[1].beat, 2 / 3, 1e-9); })());
check("swing straight is dead straight",
  (() => { const t = strumTimeline([{ bar: 0, beats: 4 }], "eighths_du", { swing: 0 }); return near(t[1].beat, 0.5, 1e-12); })());
check("a 12/8 pattern is not swung again",
  (() => { const t = strumTimeline([{ bar: 0, beats: 4 }], "shuffle", { swing: 1 }); return near(t[1].beat, 1 / 3, 1e-9); })());
check("every strum timeline runs forward",
  STRUM_PATTERNS.every((p) => { const t = strumTimeline(expandProgression("axis", 0, {}), p.key, { swing: 0.5 }); return t.every((s, i) => i === 0 || s.beat >= t[i - 1].beat); }));

// THE LOOP SEAM. Bars 3–6 must play 3,4,5,6,3,4,… with no 7 and no doubled 6,
// and the chunk edges are fuzzed so one lands exactly on the wrap.
{
  const from = 8, to = 24;   // bars 3–6 in 4/4
  const bars = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let beat = from; beat < from + 16 * (to - from); beat += 1) {
    bars.push(loopPosition(beat, { fromBeat: from, toBeat: to }).bar);
  }
  // Four beats to a bar, so each bar number repeats four times before the next.
  const expected = [];
  for (let i = 0; i < bars.length; i++) expected.push(2 + (Math.floor(i / 4) % 4));
  check("a loop over bars 3–6 plays 3,4,5,6,3,4,… with no 7 and no doubled 6",
    bars.join(",") === expected.join(","), bars.slice(0, 12).join(","));
  // Fuzz the seam: a query exactly on the wrap must land on the first beat of the
  // loop, not one past the end.
  check("a query exactly on the wrap lands at the top of the loop",
    loopPosition(to, { fromBeat: from, toBeat: to }).beat === from
    && loopPosition(to, { fromBeat: from, toBeat: to }).pass === 1);
  check("a query before the loop is left alone", loopPosition(2, { fromBeat: from, toBeat: to }).beat === 2);
  let seamOk = true;
  for (let i = 0; i < 300; i++) {
    const b = from + rnd() * (to - from) * 4;
    const p = loopPosition(b, { fromBeat: from, toBeat: to });
    if (p.beat < from || p.beat >= to) seamOk = false;
  }
  check("300 random positions all land inside the loop", seamOk);
}

check("chordAtBeat finds the right chord and the next one",
  (() => {
    const evs = expandProgression("axis", 0, {});
    const a = chordAtBeat(evs, 0), b = chordAtBeat(evs, 3.99), c = chordAtBeat(evs, 4);
    return a.chord.symbol === "C" && b.chord.symbol === "C" && c.chord.symbol === "G" && a.next.symbol === "G";
  })());

check("buildBacking says which chords it could not read",
  buildBacking({ sections: [["Verse", "C | Zq | G"]] }).unknown.includes("Zq"));
check("buildBacking on a real song has no unknowns",
  buildBacking({ sections: SONGS.find((s) => s.id === "wonderwall").sections }).unknown.length === 0);
check("a chart's bar count is what the chart says",
  expandChart([["Verse", "C | G | Am F"]]).length === 4 && totalBeats(expandChart([["V", "C | G | Am F"]])) === 12);

// ══ 7. the practice engine ══════════════════════════════════════════════════
console.log("\n── the practice engine ──");
check("a local evening session files under its own day", dayOf(new Date("2026-08-27T23:50:00")) === "2026-08-27");
check("days are counted on the calendar, not in milliseconds",
  daysBetween("2026-03-07", "2026-03-09") === 2 && daysBetween("2026-11-01", "2026-11-02") === 1);
check("addDays crosses a month and a DST boundary", addDays("2026-03-07", 2) === "2026-03-09" && addDays("2026-01-31", 1) === "2026-02-01");

check("strength decays faster when weak than when strong", dailyDecay(20) > dailyDecay(90));
check("decay is monotonic and bounded", (() => {
  let prev = 100;
  for (let d = 1; d <= 60; d++) { const cur = decayStrength(100, d); if (cur > prev || cur < 0) return false; prev = cur; }
  return true;
})());
// THE FIXED POINT. Without a floor, √(1−s/100) is zero at 100, so a perfect skill
// would decay by exactly nothing, never come due, and vanish from the app while
// reading as mastered.
// Nothing is permanent, however well consolidated. The floor on the decay rate is
// what stops √(1 − s/100) parking a perfect skill at 100 for ever, where it would
// never come due and would vanish from the app while reading as mastered.
check("even a perfect skill comes back", decayStrength(100, 60, 0) < 90 && nextReviewDays(100, 0) <= 60);
check("…and a heavily consolidated one comes back later than a new one",
  nextReviewDays(90, 60) > nextReviewDays(90, 0));
check("consolidation slows decay but never stops it",
  decayStrength(80, 30, 100) > decayStrength(80, 30, 0) && decayStrength(80, 200, 100) < 80);
// The learning curve: a rep is worth a fraction of what is left, so the first is
// worth ten times the fiftieth and nothing can be crammed past its asymptote.
check("a rep is worth more when you know less",
  applyResult({ id: "x", strength: 0 }, { rating: "clean", day: "2026-08-27" }).strength
  > 4 * applyResult({ id: "x", strength: 90, lastPracticed: "2026-08-27" }, { rating: "clean", day: "2026-08-27" }).strength - 90 * 4);
check("no number of clean reps reaches 100",
  (() => { let r = { id: "x", strength: 0, sessions: 0, history: [] }; for (let i = 0; i < 200; i++) r = applyResult(r, { rating: "clean", day: "2026-08-27" }); return r.strength < 100; })());
check("review intervals agree with the decay curve",
  [70, 80, 90, 95].every((s) => {
    const d = nextReviewDays(s);
    return decayStrength(s, d) <= REVIEW_TARGET + 1 && (d >= 30 || decayStrength(s, d - 1) > REVIEW_TARGET);
  }));
check("a fragile skill comes back tomorrow", nextReviewDays(10) === 1 && nextReviewDays(50) === 1);
check("band labels ascend with strength", bandFor(10).label === "fragile" && bandFor(95).label === "automatic");

check("a clean rep is worth more than a shaky one",
  applyResult({ id: "x", strength: 50, lastPracticed: "2026-08-27" }, { rating: "clean", day: "2026-08-27" }).strength
  > applyResult({ id: "x", strength: 50, lastPracticed: "2026-08-27" }, { rating: "shaky", day: "2026-08-27" }).strength);
check("playing well below your own best is worth less than a clean rep at tempo",
  applyResult({ id: "x", strength: 50, bestBpm: 120, lastPracticed: "2026-08-27" }, { rating: "clean", bpm: 70, day: "2026-08-27" }).strength
  < applyResult({ id: "x", strength: 50, bestBpm: 120, lastPracticed: "2026-08-27" }, { rating: "clean", bpm: 120, day: "2026-08-27" }).strength);
check("a result decays the old strength before adding to it",
  applyResult({ id: "x", strength: 80, lastPracticed: "2026-07-01" }, { rating: "clean", day: "2026-08-27" }).strength < 80 + 8);
check("history is capped at twenty",
  applyResult({ id: "x", history: Array.from({ length: 25 }, () => ({ day: "2026-01-01", rating: "clean" })) }, { rating: "clean", day: "2026-08-27" }).history.length === 20);
check("rolling accuracy says nothing under five reps",
  rollingAccuracy([{ rating: "clean" }, { rating: "clean" }]) === null
  && rollingAccuracy(Array.from({ length: 10 }, (_, i) => ({ rating: i < 9 ? "clean" : "rough" }))) === 90);
check("the difficulty band is easy / zone / hard",
  difficultyVerdict(95).key === "easy" && difficultyVerdict(86).key === "zone" && difficultyVerdict(60).key === "hard" && difficultyVerdict(null).key === "unknown");
check("an item is in acquisition for its first three sessions",
  isAcquisition({ sessions: 1, minutes: 4 }) && !isAcquisition({ sessions: 9, minutes: 40 }));

// The streak. NON-PUNITIVE BY CONSTRUCTION: today is never a break.
check("today is never a break in the streak",
  streak(["2026-08-25", "2026-08-26"], "2026-08-27").current === 2);
check("practising today extends it",
  streak(["2026-08-25", "2026-08-26", "2026-08-27"], "2026-08-27").current === 3);
check("a missed day does break it",
  streak(["2026-08-20", "2026-08-24", "2026-08-25"], "2026-08-26").current === 2);
check("the longest streak is remembered even after it breaks",
  streak(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-20"], "2026-08-21").longest === 4);
check("an empty log has no streak and does not throw",
  streak([], "2026-08-27").current === 0 && streak(null, "2026-08-27").longest === 0);
// The clocks change on 2026-03-08 in this zone. A streak across it must survive.
check("the clocks changing does not break a streak",
  streak(["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"], "2026-03-09").current === 4);
check("weeks start on Monday", weekStartOf("2026-08-27") === "2026-08-24" && weekStartOf("2026-08-30") === "2026-08-24");
check("weekly minutes bucket by Monday week",
  weeklyMinutes([{ day: "2026-08-25", minutes: 20 }, { day: "2026-08-27", minutes: 25 }], { today: "2026-08-27", weeks: 2 })[0].minutes === 45);

check("the ladder gate is three clean reps",
  (() => { let s = { bpm: 60, target: 100, clean: 0, fails: 0 }; s = ladderStep(s, "clean"); s = ladderStep(s, "clean"); const mid = s.bpm; s = ladderStep(s, "clean"); return mid === 60 && s.bpm > 60; })());
check("one flub restarts the count",
  ladderStep({ bpm: 60, target: 100, clean: 2, fails: 0 }, "rough").clean === 0);
check("two failures at a tempo end the item and remember the ceiling",
  (() => { let s = { bpm: 90, target: 120, clean: 0, fails: 1 }; s = ladderStep(s, "rough"); return s.done && s.ceiling === 85 && s.bpm === 80; })());
check("the ladder spirals rather than climbing",
  (() => { const p = ladderPlan({ target: 120, start: 60 }); return p.some((b, i) => i > 0 && b < p[i - 1]); })(), ladderPlan({ target: 120, start: 60 }).join(","));
check("the ladder never exceeds its target and never goes below its start",
  (() => { const p = ladderPlan({ target: 100, start: 70 }); return p.every((b) => b <= 100 && b >= 70); })());
check("a start at or past the target still yields a plan", ladderPlan({ target: 100, start: 140 }).length > 0);

check("drift is signed and named",
  (() => { const r = measureDrift([0, 0.5, 1, 1.5], [-0.03, 0.47, 0.97, 1.47]); return r.tendency === "rushing" && r.meanMs < 0; })());
check("a small error is not called a fault",
  measureDrift([0, 0.5, 1], [0.002, 0.503, 0.999]).tendency === "even");
check("drift over nothing is null, not zero", measureDrift([], []) === null && measureDrift([0, 1], []) === null);

// ══ 8. the schedule, over six months ════════════════════════════════════════
console.log("\n── the schedule ──");
{
  // 180 days of practice against the real builder, with scripted ratings.
  let skills = SKILLS.slice(0, 24).map((s) => ({ ...s, strength: 0, sessions: 0, minutes: 0, history: [] }));
  const songs = [{ id: "s1", title: "A song", status: "learning" }];
  let day = "2026-01-01";
  let last = null;
  const appearances = new Map();
  const sessionsRun = [];
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let d = 0; d < 180; d++) {
    const plan = buildSession(skills, { minutes: 25, today: day, lastSession: last, songs });
    sessionsRun.push(plan);
    for (const p of plan.picks) appearances.set(p.id, [...(appearances.get(p.id) || []), d]);
    const results = plan.picks.map((p) => ({ id: p.id, name: p.name, rating: rnd() < 0.8 ? "clean" : "shaky", seconds: 120 }));
    const done = completeSession({ day, focus: plan.focus }, results, skills);
    skills = SKILLS.slice(0, 24).map((s) => ({ ...s, ...(done.skills.find((x) => x.id === s.id) || { strength: 0, sessions: 0, minutes: 0, history: [] }) }));
    last = done.session;
    day = addDays(day, 1);
  }
  check("every session has blocks that add up to roughly the time asked for",
    sessionsRun.every((p) => p.minutes >= 20 && p.minutes <= 30), `${sessionsRun[0].minutes}`);
  check("every block has a real duration", sessionsRun.every((p) => p.blocks.every((b) => b.seconds > 0)));
  check("a break and a log are always in there",
    sessionsRun.every((p) => p.blocks.some((b) => b.kind === "break") && p.blocks.some((b) => b.kind === "log")));
  check("the break does not shrink with the session",
    buildSession(skills, { minutes: 10, today: "2026-08-27", songs }).blocks.find((b) => b.kind === "break").seconds
    === buildSession(skills, { minutes: 60, today: "2026-08-27", songs }).blocks.find((b) => b.kind === "break").seconds);
  check("a song block appears whenever there is a song",
    sessionsRun.every((p) => p.blocks.some((b) => b.kind === "song")));
  check("no session opens with the item that opened the last one",
    sessionsRun.every((p, i) => i === 0 || !last || p.picks[0]?.id !== sessionsRun[i - 1].picks[0]?.id || sessionsRun[i - 1].picks.length === 0));
  check("never more than two brand-new items in one session",
    sessionsRun.every((p) => p.picks.filter(isAcquisition).length <= 2));
  check("nothing goes unpractised for more than 45 days",
    [...appearances.values()].every((days) => days.every((d, i) => i === 0 || d - days[i - 1] <= 45)),
    (() => { let worst = 0; for (const ds of appearances.values()) for (let i = 1; i < ds.length; i++) worst = Math.max(worst, ds[i] - ds[i - 1]); return `worst gap ${worst}d`; })());
  // NOT "everything gets touched" — that was the bug, not the goal. Sixteen items
  // rotated three at a time is one contact per five sessions, which is slower than
  // the decay and is why nothing could ever consolidate. What has to be true is
  // that the working set MOVES: things enter it, reach the bar, and make room.
  check("six months admits well past one working set",
    appearances.size >= 12, `${appearances.size} of 24`);
  check("never more than a working set of part-learned items in flight",
    sessionsRun.every((p, d) => {
      const inFlight = p.picks.filter((x) => (x.sessions ?? 0) > 0 && x.strengthNow < 80).length;
      return inFlight <= 5;
    }));
  check("no single item dominates a fortnight",
    (() => {
      for (let start = 0; start + 14 <= 180; start += 7) {
        const counts = new Map();
        let n = 0;
        for (let d = start; d < start + 14; d++) for (const p of sessionsRun[d].picks) { counts.set(p.id, (counts.get(p.id) || 0) + 1); n++; }
        if (n && Math.max(...counts.values()) / n > 0.5) return false;
        if (counts.size < 3) return false;
      }
      return true;
    })());
  check("drills never take more than 60% of a session",
    sessionsRun.every((p) => {
      const drillSeconds = p.blocks.filter((b) => b.kind === "skill" || b.kind === "sharpen").reduce((a, b) => a + b.seconds, 0);
      return drillSeconds / p.seconds <= 0.62;
    }));
  check("a fresh account still gets a plan",
    (() => { const p = buildSession(SKILLS.map((s) => ({ ...s, strength: 0, sessions: 0, minutes: 0, history: [] })), { minutes: 25, today: "2026-01-01", songs: [] }); return p.blocks.length > 0 && p.picks.length > 0; })());
  check("no skills at all still gives a plan rather than a crash",
    buildSession([], { minutes: 25, today: "2026-01-01", songs: [] }).blocks.length > 0);
  check("completeSession writes the log and the skills together",
    (() => { const r = completeSession({ day: "2026-08-27" }, [{ id: "chord_c", name: "C", rating: "clean", seconds: 60 }], []); return r.session.items.length === 1 && r.skills.length === 1 && r.skills[0].lastPracticed === "2026-08-27"; })());
}

// ══ 9. the library ══════════════════════════════════════════════════════════
console.log("\n── the library ──");
const skillIds = new Set(SKILLS.map((s) => s.id));
check("skill ids are unique", skillIds.size === SKILLS.length);
check("every level names skills that exist",
  LEVELS.every((l) => l.skills.every((id) => skillIds.has(id)) && (l.gate?.skills || []).every((id) => skillIds.has(id))),
  LEVELS.flatMap((l) => [...l.skills, ...(l.gate?.skills || [])]).filter((id) => !skillIds.has(id)).join(","));
check("every level has an exit in prose and a gate in code",
  LEVELS.every((l) => l.exit && l.exit.length > 20 && l.gate && (l.gate.skills?.length || l.gate.songs)));
check("levels are numbered in order", LEVELS.every((l, i) => l.n === i));
check("every skill that names a chord has a verified shape for it",
  SKILLS.filter((s) => s.chord).every((s) => lookupChord(s.chord)?.voicings?.length > 0),
  SKILLS.filter((s) => s.chord && !lookupChord(s.chord)?.voicings?.length).map((s) => s.chord).join(","));
check("every chord pair in the curriculum is playable",
  SKILLS.filter((s) => s.pair).every((s) => s.pair.every((c) => lookupChord(c)?.voicings?.length > 0)));
check("every skill that names a strum, scale, shape or progression names a real one",
  SKILLS.every((s) =>
    (!s.strum || STRUM_PATTERNS.some((p) => p.key === s.strum))
    && (!s.scale || SCALES.some((x) => x.key === s.scale))
    && (!s.shape || MOVABLE.some((m) => m.key === s.shape))
    && (!s.progression || !!progressionByKey(s.progression))));
check("every drill has a runner and a real explanation",
  DRILLS.every((d) => d.runner && d.about && d.about.length > 40));
check("every cue card is symptom, cause and fix",
  CUE_CARDS.every((c) => c.symptom && c.cause && c.fix && c.applies.length > 0));
check("every song chart parses into bars",
  SONGS.every((s) => s.sections.length > 0 && s.sections.every(([, line]) => parseBars(line))));
check("every song's strum and progression reference something real",
  SONGS.every((s) => (!s.strum || STRUM_PATTERNS.some((p) => p.key === s.strum)) && (!s.progression || !!progressionByKey(s.progression))));
check("song ids are unique", new Set(SONGS.map((s) => s.id)).size === SONGS.length);
// THE STATED KEY IS THE SOUNDING KEY, AND A CAPO IS WHERE THAT GOES WRONG. Two
// rows shipped filed under the key of their SHAPES: Riptide as C when a capo at
// the first fret puts it in D♭, Jolene as A minor when the fourth fret puts it in
// C♯ minor. Nothing about that is visible from the chart — it is visible from the
// arithmetic. The tonic has to appear among the chord roots once the capo is on;
// it is a weak invariant (the tonic is not always the first chord) and it caught
// both.
{
  const keyBad = [];
  for (const s of SONGS) {
    const m = String(s.key || "").match(/^([A-G][#b♯♭]?)(m?)$/);
    if (!m) { keyBad.push(`${s.id}: unreadable key "${s.key}"`); continue; }
    const tonic = parseNote(m[1]);
    const roots = new Set();
    for (const sym of chartChords(s.sections)) { const p = parseChord(sym); if (p) roots.add(mod12(p.rootPc + (s.capo || 0))); }
    if (!roots.has(tonic)) keyBad.push(`${s.id}: ${s.key} capo ${s.capo || 0}, sounds ${[...roots].sort((a, b) => a - b).map((p) => pcName(p)).join(",")}`);
  }
  check("every song's stated key survives its own capo", keyBad.length === 0, keyBad.join(" | "));
}
check("a capo is stated in the note whenever there is one",
  SONGS.filter((s) => s.capo > 0).every((s) => /capo/i.test(s.note || "")),
  SONGS.filter((s) => s.capo > 0 && !/capo/i.test(s.note || "")).map((s) => s.id).join(","));
check("benchmarks are labelled as guidance, with ascending thresholds",
  BENCHMARKS.omc.every((b, i) => i === 0 || b.n > BENCHMARKS.omc[i - 1].n));
// WHAT DAY ONE IS ALLOWED TO ASK OF YOU. Both halves of this shipped as bugs:
// the scheduler ranks by how overdue an item is, a never-practised item is
// maximally overdue, and so a brand-new account was handed "Transcribe by ear"
// and "Tune it by ear against the app" as its two headline practice items.
check("a beginner is never shown a skill from a level they haven't reached",
  schedulableSkills(0).every((s) => s.level === 0)
  && schedulableSkills(2).every((s) => s.level <= 2 || s.level === 6));
check("a tool is not a drill — nothing with kind 'tool' is ever scheduled",
  schedulableSkills(7).every((s) => s.kind !== "tool")
  && SKILLS.some((s) => s.kind === "tool"));
check("level 0 still has something to practise", schedulableSkills(0).length >= 3, String(schedulableSkills(0).length));
check("the pool grows with the level",
  [0, 1, 2, 3, 4, 5, 6, 7].every((n, i, a) => i === 0 || schedulableSkills(n).length >= schedulableSkills(a[i - 1]).length));
check("fingerstyle opens at level 3 as a parallel track, not at 6",
  schedulableSkills(3).some((s) => s.id === "travis") && !schedulableSkills(2).some((s) => s.id === "travis"));
check("day one's plan is chords and strumming, not transcription",
  (() => {
    const pool = schedulableSkills(0).map((s) => ({ ...s, strength: 0, sessions: 0, minutes: 0, history: [] }));
    const p = buildSession(pool, { minutes: 25, today: "2026-01-01", songs: [] });
    return p.picks.length > 0 && p.picks.every((x) => ["chord", "strum", "change"].includes(x.kind));
  })(), (() => {
    const pool = schedulableSkills(0).map((s) => ({ ...s, strength: 0, sessions: 0, minutes: 0, history: [] }));
    return buildSession(pool, { minutes: 25, today: "2026-01-01", songs: [] }).picks.map((x) => x.id).join(",");
  })());

check("day one is never sent to the Note Finder — a level-4 drill",
  (() => {
    const pool = schedulableSkills(0).map((s) => ({ ...s, strength: 0, sessions: 0, minutes: 0, history: [] }));
    return [0, 1, 2, 3].every((seed) =>
      buildSession(pool, { minutes: 25, today: "2026-01-01", songs: [], seed }).blocks
        .filter((b) => b.kind === "sharpen").every((b) => b.focus === "ear"));
  })());
check("once the fretboard is unlocked the sharpen block alternates",
  (() => {
    const pool = schedulableSkills(4).map((s) => ({ ...s, strength: 0, sessions: 0, minutes: 0, history: [] }));
    const focuses = [0, 1].map((seed) => buildSession(pool, { minutes: 25, today: "2026-01-01", songs: [], seed }).blocks.find((b) => b.kind === "sharpen")?.focus);
    return focuses[0] !== focuses[1];
  })());

check("levelState starts at level 0 and does not throw on an empty account",
  levelState({}).level.n === 0 && Array.isArray(levelState({}).all));
// A LEVEL IS SOMETHING YOU REACHED. Without the floor the gate reads decayed
// strength, a fortnight off demotes you, the pool shrinks back to three items,
// and everything that just fell out of it decays further with no way back. An
// eighteen-month simulation oscillated 0-1-0 for the whole run and finished
// having touched 16 of 65 skills.
check("a level once reached is never taken away",
  levelState({}, { floor: 4 }).level.n === 4 && levelState({}, { floor: 4 }).computed.n === 0);
check("the floor cannot invent a level past the end",
  levelState({}, { floor: 99 }).level.n === LEVELS.length - 1 && levelState({}, { floor: -3 }).level.n === 0);
check("the computed level is still reported, so a slip can be shown without a demotion",
  levelState({}, { floor: 3 }).computed.n === 0);
{
  // Eighteen months, five days a week, 75% clean — the learner must actually move.
  let rows = [], day = "2026-01-01", last = null, owned = 0, seed = 7, floor = 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let d = 0; d < 540; d++) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const all = SKILLS.map((s) => ({ ...s, ...(byId.get(s.id) || { strength: 0, sessions: 0, minutes: 0, history: [] }) }));
    const lv = levelState(Object.fromEntries(all.map((s) => [s.id, { strength: currentStrength(s, day) }])), { songsOwned: owned, floor });
    floor = Math.max(floor, lv.computed.n);
    if (d % 7 < 5) {
      const eligible = new Set(schedulableSkills(lv.level.n).map((s) => s.id));
      const plan = buildSession(all.filter((s) => eligible.has(s.id)), { minutes: 25, today: day, lastSession: last, songs: [{ id: "s", status: "learning" }] });
      const results = plan.picks.map((p) => ({ id: p.id, name: p.name, rating: rnd() < 0.75 ? "clean" : rnd() < 0.7 ? "shaky" : "rough", seconds: 150 }));
      const done = completeSession({ day, focus: plan.focus }, results, rows);
      rows = done.skills; last = done.session;
      if (d % 20 === 0) owned++;
    }
    day = addDays(day, 1);
  }
  check("eighteen months of practice reaches at least level 3", floor >= 3, `reached ${floor}`);
  // Not "most of the curriculum" — the curriculum runs to year seven, and reaching
  // level 3 in eighteen months is exactly what the timeline in the research says
  // (barre chords, months 6–12). What has to be true is that everything admitted
  // ended up ACTUALLY LEARNED rather than half-started.
  check("…and everything it started, it finished",
    rows.filter((r) => r.sessions > 0).length >= 15
    && rows.filter((r) => r.sessions > 2).every((r) => currentStrength(r, day) >= 60),
    `${rows.filter((r) => r.sessions > 0).length} started, weakest ${Math.min(...rows.filter((r) => r.sessions > 2).map((r) => Math.round(currentStrength(r, day))))}`);
  check("…with nothing abandoned for longer than six weeks",
    rows.filter((r) => r.sessions > 0).every((r) => (daysBetween(r.lastPracticed, day) ?? 0) <= 45),
    String(Math.max(...rows.filter((r) => r.sessions > 0).map((r) => daysBetween(r.lastPracticed, day) ?? 0))));
}

check("levelState advances when the gate is met",
  levelState(Object.fromEntries(SKILLS.map((s) => [s.id, { strength: 95 }])), { songsOwned: 50 }).level.n > 0);

// ── the honesty rule, drawn from the data rather than the code ───────────────
// A voicing may omit a defining tone only by saying so. This is the check that
// stops the omission mechanism becoming a way to wave anything through.
check("at most a couple of voicings declare an omission at all",
  VOICINGS.filter((v) => v.omits).length <= 3, String(VOICINGS.filter((v) => v.omits).length));

console.log(failed
  ? `\n${failed} guitar check(s) failed`
  : `\nguitar: all checks passed — ${VOICINGS.length} voicings, ${SONGS.length} songs, ${SKILLS.length} skills, ${PROGRESSIONS.length} progressions`);
process.exit(failed ? 1 : 0);
