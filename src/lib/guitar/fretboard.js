// ─── The neck — tunings, voicings, boxes, and the verifier ───────────────────
// PURE, like theory.js next door. This is the file that turns "string 5, fret 3"
// into a pitch and back again, and it is where every shape the app draws is
// checked against the chord or scale it claims to be.
//
// THE ARRAY CONVENTION, ONCE, EVERYWHERE. A voicing is six entries, LOW E FIRST
// (string 6 → string 1), matching how chord charts are printed left-to-right and
// how tab is stacked bottom-to-top:
//
//     index   0    1    2    3    4    5
//     string  6    5    4    3    2    1
//     std     E2   A2   D3   G3   B3   E4
//
// `null` is a muted string. `0` is open. A negative number is NOT a mute — it is
// a bug, and every reader here rejects it rather than quietly treating it as one,
// because the two conventions ("x" as -1, "x" as null) both exist in the wild and
// silently accepting both means a -1 typed for a real fret reads as a mute.
//
// The diagrams are drawn low-string-at-the-BOTTOM on screen (a right-handed
// player's view of their own neck), so the render layer reverses this array. It
// is not stored reversed: every piece of music software in the world writes
// "x32010" low-to-high, and a stored order that disagreed with the source
// material would guarantee a transcription error eventually.

import { mod12, midiToFreq, midiName, chordPcs, scalePcs, degreeOf, pcName, parseNote } from "./theory.js";

// ─── tunings ─────────────────────────────────────────────────────────────────
// MIDI numbers, low string first. A4 = 69, so E2 = 40 (C-1 = 0 ⇒ C2 = 36).
// The `drop` flag is what the tuner uses to decide whether a power chord across
// the bottom three strings is one finger — it is not decoration.
// `flats` is the SPELLING, and it is a property of the tuning rather than of the
// notes. E♭ A♭ D♭ G♭ B♭ E♭ and D♯ G♯ C♯ F♯ A♯ D♯ are the same six pitches, and
// exactly one of them is what anyone writes down: a half-step-down guitar is in
// E♭, always, in every chart and every conversation. Storing the preference next
// to the pitches is what stops `short` and the string labels disagreeing — which
// they did, silently, and only the smoke noticed.
export const TUNINGS = [
  { key: "standard", name: "Standard", short: "E A D G B E", midi: [40, 45, 50, 55, 59, 64] },
  { key: "drop_d", name: "Drop D", short: "D A D G B E", midi: [38, 45, 50, 55, 59, 64], drop: true },
  { key: "half_down", name: "Half step down", short: "E♭ A♭ D♭ G♭ B♭ E♭", midi: [39, 44, 49, 54, 58, 63], flats: true },
  { key: "full_down", name: "Whole step down", short: "D G C F A D", midi: [38, 43, 48, 53, 57, 62] },
  { key: "drop_c", name: "Drop C", short: "C G C F A D", midi: [36, 43, 48, 53, 57, 62], drop: true },
  { key: "dadgad", name: "DADGAD", short: "D A D G A D", midi: [38, 45, 50, 55, 57, 62] },
  { key: "open_g", name: "Open G", short: "D G D G B D", midi: [38, 43, 50, 55, 59, 62] },
  { key: "open_d", name: "Open D", short: "D A D F♯ A D", midi: [38, 45, 50, 54, 57, 62] },
  { key: "open_e", name: "Open E", short: "E B E G♯ B E", midi: [40, 47, 52, 56, 59, 64] },
  { key: "double_drop_d", name: "Double drop D", short: "D A D G B D", midi: [38, 45, 50, 55, 59, 62], drop: true },
];
export const tuningByKey = (key) => TUNINGS.find((t) => t.key === key) || TUNINGS[0];
export const STANDARD = TUNINGS[0].midi;

// The one place string-index arithmetic happens. `capo` raises every string; a
// capo at 0 is the identity, which is why nothing else in this file special-cases it.
export function midiAt(stringIndex, fret, tuning = STANDARD, capo = 0) {
  const open = tuning[stringIndex];
  if (open == null || !Number.isFinite(fret) || fret < 0) return null;
  return open + fret + (Number(capo) || 0);
}
export const freqAt = (stringIndex, fret, tuning = STANDARD, capo = 0, a4) => {
  const m = midiAt(stringIndex, fret, tuning, capo);
  return m == null ? null : midiToFreq(m, a4);
};
export const pcAt = (stringIndex, fret, tuning = STANDARD, capo = 0) => {
  const m = midiAt(stringIndex, fret, tuning, capo);
  return m == null ? null : mod12(m);
};

// Every place on the neck (up to `maxFret`) that sounds one pitch class. The
// note-finder drill's answer key, and the "where else is this note" overlay.
export function positionsOfPc(pc, { tuning = STANDARD, maxFret = 15, capo = 0 } = {}) {
  const want = mod12(pc);
  const out = [];
  for (let s = 0; s < tuning.length; s++) {
    for (let f = 0; f <= maxFret; f++) {
      if (pcAt(s, f, tuning, capo) === want) out.push({ string: s, fret: f, midi: midiAt(s, f, tuning, capo) });
    }
  }
  return out;
}

// ─── voicings ────────────────────────────────────────────────────────────────
// The sounding MIDI notes of a fret array, low string first, mutes dropped.
// THE ORDER IS PITCH ORDER ONLY BY ACCIDENT of standard tuning — [0] is the
// lowest-numbered STRING that sounds, which for a voicing like D/F♯ is also the
// bass. Callers that need the true bass use `bassMidi` below.
export function voicingMidi(frets, tuning = STANDARD, capo = 0) {
  if (!Array.isArray(frets)) return [];
  const out = [];
  for (let s = 0; s < Math.min(frets.length, tuning.length); s++) {
    const f = frets[s];
    if (f == null) continue;
    if (!Number.isFinite(f) || f < 0) continue; // a negative fret is a bug, not a mute — see the header
    out.push(midiAt(s, f, tuning, capo));
  }
  return out;
}
export const voicingPcs = (frets, tuning = STANDARD, capo = 0) =>
  [...new Set(voicingMidi(frets, tuning, capo).map(mod12))].sort((a, b) => a - b);
export function bassMidi(frets, tuning = STANDARD, capo = 0) {
  const notes = voicingMidi(frets, tuning, capo);
  return notes.length ? Math.min(...notes) : null;
}

// ═══ THE VERIFIER — the reason this file can be trusted ══════════════════════
// Given a voicing that CLAIMS to be a chord, decide whether it is one. Used by
// scripts/guitar-smoke.mjs over the entire chord library on every `npm run
// verify`, and by the custom-song editor when Cameron types a shape of his own.
//
// Four separable failures, reported separately rather than as one boolean,
// because they are four different mistakes and only one of them is fatal:
//
//   · `extra`   — a pitch class the chord does not contain. FATAL. This is the
//                 transcription slip: one fret wrong on one string and the shape
//                 sounds a note that is not in the chord.
//   · `missing` — a chord tone the voicing does not sound. USUALLY FINE. Six
//                 strings cannot state a 13th chord, and dropping the 5th is
//                 standard practice; `missingCore` is the one that matters,
//                 because a "minor" chord with no third is not a minor chord.
//   · `bass`    — the lowest sounding note is not the root, and no slash bass was
//                 declared. Worth knowing (that is an inversion, and the chart
//                 should say so), never fatal.
//   · `shape`   — impossible to fret: more than a four-fret span between the
//                 lowest and highest fretted note, ignoring open strings.
//
// `missingCore` is the half of `missing` that decides the chord's identity — see
// the note on it below. The root and the fifth may go; nothing else may.
// ─── shapes for a neck this table has never seen ─────────────────────────────
// EVERY STORED SHAPE IS A FACT ABOUT STANDARD TUNING. The 65 tabulated voicings
// and the movable CAGED shapes are fret offsets, and a fret offset only means a
// chord if the strings underneath it are tuned the way they were when somebody
// wrote it down. Re-rooting them in DADGAD or open G does not transpose them —
// it produces a different chord, or no chord. Measured: of 65 voicings, 23 stop
// spelling their chord in drop D, 62 in DADGAD, 65 in open E. Ask for a C major
// in open G and the app offered six diagrams, not one of which sounds a C major
// triad, under an empty state that promises it only shows verified ones.
//
// So for any neck that is not standard, the shapes are SEARCHED rather than
// recalled. For each four-fret window, each string may be muted, played open, or
// fretted inside the window — but only at a fret whose pitch is in the chord, so
// the candidate set per string is two or three, not thirteen. Everything that
// survives goes through verifyVoicing, which is the same gate the tabulated rows
// pass. Nothing is invented: a shape is offered only if the neck really makes it.
export function searchVoicings(rootPc, quality, {
  tuning = STANDARD, maxFret = 12, limit = 6, bassPc = null, maxSpan = 4,
} = {}) {
  const pcs = new Set(chordPcs(rootPc, quality));
  if (!pcs.size) return [];
  const strings = tuning.length;
  const wantBass = bassPc == null ? mod12(rootPc) : mod12(bassPc);
  const seen = new Set();
  const found = [];

  for (let base = 0; base + maxSpan - 1 <= maxFret; base++) {
    // What each string may do in this window. `null` is muted; 0 is the open
    // string, which is available in every window and is what makes an open
    // tuning's own shapes findable at all.
    const options = [];
    for (let st = 0; st < strings; st++) {
      const opts = [null];
      if (pcs.has(mod12(tuning[st]))) opts.push(0);
      for (let f = Math.max(1, base); f < base + maxSpan; f++) {
        if (f <= maxFret && pcs.has(mod12(tuning[st] + f))) opts.push(f);
      }
      options.push(opts);
    }
    // Depth-first over the strings. The tree is narrow — two or three branches a
    // string — so this is a few hundred leaves per window, not thirteen to the six.
    const frets = new Array(strings).fill(null);
    const walk = (st) => {
      if (found.length >= limit * 8) return;            // plenty to rank; stop early
      if (st === strings) {
        const sounding = frets.filter((f) => f != null).length;
        if (sounding < 3) return;
        // No hole in the middle: a muted string between two sounding ones is a
        // grip almost nobody can actually damp cleanly.
        const first = frets.findIndex((f) => f != null);
        const last = strings - 1 - [...frets].reverse().findIndex((f) => f != null);
        for (let i = first; i <= last; i++) if (frets[i] == null) return;
        const key = frets.map((f) => (f == null ? "x" : f)).join("-");
        if (seen.has(key)) return;
        const v = verifyVoicing(frets, rootPc, quality, { tuning, bassPc, maxSpan: maxSpan + 1 });
        if (!v.ok || !v.bassOk) return;
        seen.add(key);
        found.push({ frets: [...frets], difficulty: voicingDifficulty(frets, { barre: null }) });
        return;
      }
      for (const f of options[st]) { frets[st] = f; walk(st + 1); }
      frets[st] = null;
    };
    walk(0);
  }
  return found.sort((a, b) => a.difficulty - b.difficulty).slice(0, limit);
}

export function verifyVoicing(frets, rootPc, quality, { tuning = STANDARD, bassPc = null, maxSpan = 5, omits = [] } = {}) {
  const sounded = voicingPcs(frets, tuning);
  const want = chordPcs(rootPc, quality);
  const wantSet = new Set(want);
  const extra = sounded.filter((pc) => !wantSet.has(pc));
  const soundedSet = new Set(sounded);
  const missing = want.filter((pc) => !soundedSet.has(pc));
  // THE ROOT AND THE FIFTH ARE THE DROPPABLE ONES, and everything else is core.
  // That is the rule rather than a list of degrees, because it is the rule
  // guitarists actually play by: the bass has the root, the fifth adds nothing a
  // chord's identity depends on, and every other tone in the formula is there
  // precisely because it makes this chord that chord. A "minor" with no third is
  // a power chord; a "maj7" with no seventh is a triad; a "6" with no sixth is a
  // triad wearing the wrong name.
  //
  // `omits` is the declared exception, and it is per-voicing rather than global.
  // Some shapes drop a defining tone ON PURPOSE — the two-chord vamp in "A Horse
  // with No Name" is a 6/9 with no third at all, and that missing third is the
  // sound; a rootless jazz grip leaves the root to the bass player. A row that
  // does that has to SAY so, in degrees from the root, and the library's smoke
  // asserts every declaration carries a reason. What it may never be is a
  // blanket relaxation of the check: the whole value of this function is that a
  // tone goes missing only when somebody wrote down why.
  const omitted = new Set((omits || []).map((d) => mod12(d)));
  const core = want.filter((pc) => {
    const d = mod12(pc - rootPc);
    return d !== 0 && d !== 7 && !omitted.has(d);
  });
  const missingCore = core.filter((pc) => !soundedSet.has(pc));
  const fretted = (Array.isArray(frets) ? frets : []).filter((f) => Number.isFinite(f) && f > 0);
  const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) + 1 : 0;
  const low = bassMidi(frets, tuning);
  const wantBass = bassPc == null ? rootPc : bassPc;
  const bassOk = low == null ? false : mod12(low) === mod12(wantBass);
  return {
    ok: extra.length === 0 && missingCore.length === 0 && span <= maxSpan && sounded.length >= 2,
    extra, missing, missingCore, span, bassOk,
    sounded, want,
    // Every sounding string, annotated — this is what the diagram prints under
    // each dot when "show intervals" is on.
    notes: voicingMidi(frets, tuning).map((m) => ({
      midi: m, name: midiName(m), pc: mod12(m), degree: degreeOf(mod12(m), rootPc),
    })),
  };
}

// How hard a shape is to hold, on a scale the UI can sort by. Not a claim about
// anyone's hands — a stated heuristic, so the chord library can put open C before
// barre F♯m7♭5 without someone hand-ranking two hundred shapes.
// `barre` may be a fret number or the whole { fret, from, to } — HOW MANY STRINGS
// IT COVERS IS PART OF HOW HARD IT IS, and treating every barre alike scored the
// two-string mini-F exactly the same as the six-string full barre next to it.
export function voicingDifficulty(frets, { barre = null } = {}) {
  const fretted = (Array.isArray(frets) ? frets : []).filter((f) => Number.isFinite(f) && f > 0);
  if (!fretted.length) return 0;                       // all open — Em, E5
  const span = Math.max(...fretted) - Math.min(...fretted);
  const barStrings = barre && typeof barre === "object" && Number.isFinite(barre.from) && Number.isFinite(barre.to)
    ? Math.max(1, barre.to - barre.from + 1)
    : (barre ? 6 : 0);                                 // a bare fret number means "assume the worst"
  const fingers = barre ? 1 + fretted.filter((f) => f > Math.min(...fretted)).length : fretted.length;
  const muted = (Array.isArray(frets) ? frets : []).filter((f) => f == null).length;
  // WHERE ON THE NECK, which this had no term for at all — the same shape cost
  // exactly the same at the first fret and the twelfth. Nothing stopped the
  // beginner's chord picker from opening at the ninth, and for the five barre
  // chords the curriculum actually teaches (F, B, Bm, Cm, B♭) that is what it
  // did. First position is free; every four frets up is worth about one more
  // finger, which is roughly what reaching and holding it costs.
  const position = Math.min(12, Math.min(...fretted));
  // Weights, stated: a barre is the single biggest step up for a beginner, a
  // stretch past three frets is the next, an inner mute (a string you have to
  // deaden mid-chord) is worth about as much as one more finger.
  // ── THE WEIGHTS, AND WHERE THEY CAME FROM ──────────────────────────────────
  // Not guessed. Every panel draws voicings[0] as THE picture of a chord, so the
  // ordering this produces is the app's answer to "what does an F look like" —
  // and with no position term at all it answered with a C-shape barre at the
  // fifth fret, drew Creep's B at the ninth under a note that says "barre it at
  // 2", and drew Bm at the seventh. So the weights were SOLVED: a sweep over the
  // twenty chords whose right answer the curriculum states outright (level 3's
  // prose for the F's, each song's own note for the rest) picked the set that
  // reproduces all twenty. scripts/guitar-smoke.mjs pins the same twenty, so a
  // future weight change has to keep answering them correctly or fail.
  //
  //   barre      1.5 flat, plus 0.1 a string — a two-string mini-barre is most of
  //              a normal finger; a six-string one is the wall every beginner hits
  //   span       1 a fret past the first — the stretch
  //   fingers    0.75 each past two
  //   mutes      0.5 each past one — a string you have to deaden mid-chord
  //   position   0.25 a fret up the neck — reaching it, and finding it at all
  //
  // This number is a SORT KEY and is never shown. It does not need to be an
  // integer and it does not need to mean anything on its own; it needs to put the
  // right shape first.
  const barreCost = barre ? 1.5 + barStrings * 0.1 : 0;
  return barreCost
    + Math.max(0, span - 1)
    + Math.max(0, fingers - 2) * 0.75
    + Math.max(0, muted - 1) * 0.5
    + position * 0.25;
}

// ─── movable shapes (the CAGED spine) ────────────────────────────────────────
// A movable shape is stored as OFFSETS from its own barre/index fret, plus which
// string the root sits on and at what offset. `placeShape` then answers "where
// does this shape go for a G?" without any fret arithmetic at the call site —
// which is exactly the arithmetic that goes wrong by one at 2am.
//
// offsets: six entries, low string first, null = muted, integers ≥ 0.
// rootString: index into that array. rootOffset: the offset AT that string.
export const MOVABLE = [
  { key: "E_maj", name: "E shape", quality: "maj", rootString: 0, offsets: [0, 2, 2, 1, 0, 0], barre: 0 },
  { key: "E_min", name: "Em shape", quality: "min", rootString: 0, offsets: [0, 2, 2, 0, 0, 0], barre: 0 },
  { key: "E_7", name: "E7 shape", quality: "7", rootString: 0, offsets: [0, 2, 0, 1, 0, 0], barre: 0 },
  { key: "E_m7", name: "Em7 shape", quality: "m7", rootString: 0, offsets: [0, 2, 0, 0, 0, 0], barre: 0 },
  { key: "E_maj7", name: "Emaj7 shape", quality: "maj7", rootString: 0, offsets: [0, 2, 1, 1, 0, 0], barre: 0 },
  { key: "E_5", name: "Power (6th string)", quality: "5", rootString: 0, offsets: [0, 2, 2, null, null, null] },
  { key: "A_maj", name: "A shape", quality: "maj", rootString: 1, offsets: [null, 0, 2, 2, 2, 0], barre: 0 },
  { key: "A_min", name: "Am shape", quality: "min", rootString: 1, offsets: [null, 0, 2, 2, 1, 0], barre: 0 },
  { key: "A_7", name: "A7 shape", quality: "7", rootString: 1, offsets: [null, 0, 2, 0, 2, 0], barre: 0 },
  { key: "A_m7", name: "Am7 shape", quality: "m7", rootString: 1, offsets: [null, 0, 2, 0, 1, 0], barre: 0 },
  { key: "A_maj7", name: "Amaj7 shape", quality: "maj7", rootString: 1, offsets: [null, 0, 2, 1, 2, 0], barre: 0 },
  { key: "A_5", name: "Power (5th string)", quality: "5", rootString: 1, offsets: [null, 0, 2, 2, null, null] },
  // C, G and D shapes complete CAGED. They are stored with the root NOT at
  // offset 0, which is the whole reason `rootOffset` exists — the C shape's root
  // is three frets above its own lowest note, so placing it by its bottom fret
  // puts every chord a minor third out.
  // THE C AND G SHAPES ARE BARRES, AND SAYING SO IS LOAD-BEARING. Placed above
  // the nut their offset-0 notes need an index bar — chords.SHAPE_FINGERS already
  // puts finger 1 on several strings for both. Without the flag placeShape
  // returned barre: null, voicingDifficulty's +3 never fired, and the C-shape F
  // at the fifth fret scored EASIER than the F barre at the first: the app drew a
  // five-fret-span C-shape barre as its picture of "F" for a beginner, and drew
  // Creep's B at the ninth fret under a note that says "barre it at 2".
  { key: "C_maj", name: "C shape", quality: "maj", rootString: 1, rootOffset: 3, offsets: [null, 3, 2, 0, 1, 0], barre: 0 },
  { key: "G_maj", name: "G shape", quality: "maj", rootString: 0, rootOffset: 3, offsets: [3, 2, 0, 0, 0, 3], barre: 0 },
  { key: "D_maj", name: "D shape", quality: "maj", rootString: 2, rootOffset: 0, offsets: [null, null, 0, 2, 3, 2] },
  { key: "D_min", name: "Dm shape", quality: "min", rootString: 2, rootOffset: 0, offsets: [null, null, 0, 2, 3, 1] },
];
export const movableByKey = (key) => MOVABLE.find((s) => s.key === key) || null;

// Put a movable shape where its root is the note you asked for.
// Returns null rather than a negative fret when the shape cannot sit that low —
// a G shape rooted on an open low E would need fret −3, and a caller that got
// back a fret array with −3 in it would draw one.
export function placeShape(shape, rootPc, { tuning = STANDARD, minFret = 1, maxFret = 15 } = {}) {
  if (!shape) return null;
  const openPc = mod12(tuning[shape.rootString]);
  const rootOffset = shape.rootOffset ?? shape.offsets[shape.rootString] ?? 0;
  // The fret the ROOT must land on, then back out the shape's index fret.
  let rootFret = mod12(mod12(rootPc) - openPc);
  let base = rootFret - rootOffset;
  const lowest = Math.min(...shape.offsets.filter((o) => o != null));
  while (base + lowest < minFret) base += 12;
  const frets = shape.offsets.map((o) => (o == null ? null : base + o));
  const top = Math.max(...frets.filter((f) => f != null));
  if (top > maxFret) return null;
  return {
    frets, baseFret: base, rootFret: base + rootOffset,
    barre: shape.barre != null ? base + shape.barre : null,
    shape: shape.key, quality: shape.quality, rootPc: mod12(rootPc),
  };
}

// The five CAGED root positions for one chord, left to right up the neck. This
// is the whole system in one function: the same five shapes, in the same order,
// every time, with the root's fret on each — which is what makes the neck stop
// being twelve unrelated boxes.
const CAGED_ORDER = ["C_maj", "A_maj", "G_maj", "E_maj", "D_maj"];
export function cagedPositions(rootPc, { tuning = STANDARD, maxFret = 15 } = {}) {
  return CAGED_ORDER.map((key) => {
    const placed = placeShape(movableByKey(key), rootPc, { tuning, minFret: 0, maxFret });
    return placed ? { ...placed, letter: key[0] } : null;
  }).filter(Boolean).sort((a, b) => a.baseFret - b.baseFret);
}

// ─── scale shapes ────────────────────────────────────────────────────────────
// Everything in a fret window that belongs to a scale. The generic map behind the
// fretboard explorer: nothing is hard-coded, so it is correct for every scale in
// SCALES and every tuning in TUNINGS, including ones nobody has drawn a box for.
export function scaleMap(rootPc, scaleKey, { tuning = STANDARD, fromFret = 0, toFret = 15, capo = 0 } = {}) {
  const pcs = scalePcs(rootPc, scaleKey);
  if (!pcs.length) return [];
  const set = new Set(pcs);
  const out = [];
  for (let s = 0; s < tuning.length; s++) {
    for (let f = fromFret; f <= toFret; f++) {
      const pc = pcAt(s, f, tuning, capo);
      if (pc != null && set.has(pc)) {
        out.push({ string: s, fret: f, pc, degree: degreeOf(pc, rootPc), root: pc === mod12(rootPc), midi: midiAt(s, f, tuning, capo) });
      }
    }
  }
  return out;
}

// THE FIVE PENTATONIC BOXES, and why they are a table rather than a window.
//
// A box is NOT "every scale tone between fret X and fret X+3". That rule builds
// box 1 correctly and then falls apart, because the B string is tuned a major
// third above the G rather than a fourth, so every shape from box 3 up bends
// around it by a fret. A uniform window drops the 9th-fret E in box 3 and the
// 13th-fret C in box 3's second string, which are two of the five notes.
//
// So the offsets are stored per string, relative to the ROOT's fret on the low E
// (box 1's index), and scripts/guitar-smoke.mjs proves them rather than trusting
// them: every offset in every box must land on a pitch class the scale contains,
// each box must contain all five degrees, and consecutive boxes must overlap.
const MINOR_PENT_BOXES = [
  // Box 1 — the shape everyone learns first: root on the low E under the index
  // finger, and the only two-fret-wide box in the set.
  [[0, 3], [0, 2], [0, 2], [0, 2], [0, 3], [0, 3]],
  [[3, 5], [2, 5], [2, 5], [2, 4], [3, 5], [3, 5]],
  [[5, 7], [5, 7], [5, 7], [4, 7], [5, 8], [5, 7]],
  [[7, 10], [7, 10], [7, 9], [7, 9], [8, 10], [7, 10]],
  [[10, 12], [10, 12], [9, 12], [9, 12], [10, 12], [10, 12]],
];

// MAJOR PENTATONIC IS DERIVED, NOT TRANSCRIBED, and that is the safest thing in
// this file. C major pentatonic and A minor pentatonic are the SAME FIVE NOTES —
// the major root sits three semitones above the minor one — so major box n is
// minor box n+1 read from a root three frets higher. Writing that as arithmetic
// means the five major shapes cannot disagree with the five minor ones, which is
// exactly the disagreement a second hand-typed table would eventually contain.
// The +12 on the wrap keeps every offset for box 5 positive; the placement code
// below shifts an octave anyway when a box would fall off the nut, or off the
// last fret.
const MAJOR_PENT_BOXES = MINOR_PENT_BOXES.map((_, i) => {
  const src = MINOR_PENT_BOXES[(i + 1) % MINOR_PENT_BOXES.length];
  const wrapped = i === MINOR_PENT_BOXES.length - 1;
  return src.map((s) => s.map((off) => off - 3 + (wrapped ? 12 : 0)));
});

export const PENTATONIC_BOXES = { minor_pent: MINOR_PENT_BOXES, major_pent: MAJOR_PENT_BOXES };

// One box, placed for a root, as dots a diagram can draw.
export function pentatonicBox(rootPc, boxIndex, { scaleKey = "minor_pent", tuning = STANDARD, maxFret = 22 } = {}) {
  const table = PENTATONIC_BOXES[scaleKey];
  if (!table) return null;
  const box = table[((boxIndex % table.length) + table.length) % table.length];
  const openPc = mod12(tuning[0]);
  let rootFret = mod12(mod12(rootPc) - openPc);
  // Each box is placed on its own. One whose offsets reach below the nut — a
  // major box, which sits three frets under its minor twin — goes up an octave;
  // box 1 rooted at fret 0 is open position and stays.
  const lowest = Math.min(...box.map((s) => Math.min(...s)));
  while (rootFret + lowest < 0) rootFret += 12;
  // …AND DOWN AN OCTAVE WHEN IT WOULD RUN OFF THE OTHER END. That loop only ever
  // raises the root, so E♭ — root fret 11 — put box 5's top offset at fret 23,
  // and the `fret <= maxFret` clip below drew the box as one dot per string: six
  // of its twelve notes, confidently, with nothing on screen saying so. A box is
  // the same shape an octave down, and frets 8–11 is where E♭ box 5 is actually
  // played, so the box drops when its top would leave the neck.
  const highest = Math.max(...box.map((s) => Math.max(...s)));
  while (rootFret + highest > maxFret && rootFret - 12 + lowest >= 0) rootFret -= 12;

  // ── THE TABLE IS A FACT ABOUT STANDARD TUNING, SO THE WINDOW IS TAKEN FROM IT
  //    AND THE NOTES ARE TAKEN FROM THE NECK ────────────────────────────────────
  // The offsets are per-string distances measured against standard tuning's
  // string intervals, and re-rooting them without touching the offsets does not
  // transpose a box, it breaks it: in drop D — where only the sixth string moves
  // — A minor pentatonic box 1 came out containing F♯ and B. 238 of 720 dots off
  // the scale in drop D and drop C, 215 in open D and open E.
  //
  // scaleMap and threeNotePerString next door do not have this problem because
  // they compute the fret from the PITCH. So does this now: the table decides the
  // fret window each string sits in — which is what a "box" actually is, the
  // shape of the position under the hand — and which notes fall in that window is
  // read off the tuning. In standard tuning the answer is identical to the table,
  // dot for dot, which is the check that keeps this honest.
  const wanted = new Set(scalePcs(rootPc, scaleKey));
  const dots = [];
  for (let s = 0; s < box.length && s < tuning.length; s++) {
    const offs = box[s];
    const lo = rootFret + Math.min(...offs);
    const hi = rootFret + Math.max(...offs);
    for (let fret = Math.max(0, lo); fret <= hi && fret <= maxFret; fret++) {
      const pc = pcAt(s, fret, tuning, 0);
      if (!wanted.has(pc)) continue;
      dots.push({ string: s, fret, pc, degree: degreeOf(pc, rootPc), root: pc === mod12(rootPc), midi: midiAt(s, fret, tuning) });
    }
  }
  const frets = dots.map((d) => d.fret);
  return { dots, index: boxIndex, rootFret, from: Math.min(...frets), to: Math.max(...frets) };
}

// Three-notes-per-string positions for a seven-note scale. Generated, not stored:
// start on the nth scale degree on the low string, then take three consecutive
// scale tones per string, moving up. Seven positions per scale, one per mode, and
// there is nothing here to transcribe wrongly.
export function threeNotePerString(rootPc, scaleKey, position, { tuning = STANDARD, maxFret = 22 } = {}) {
  const pcs = scalePcs(rootPc, scaleKey);
  if (pcs.length !== 7) return null;
  const set = new Set(pcs);
  const p = ((position % 7) + 7) % 7;
  // The p-th DEGREE of the scale — sorting by distance from the root is what
  // makes "position 3" mean the third degree rather than the third-lowest pitch
  // class, which are different notes in every key but C.
  const startPc = [...pcs].sort((a, b) => mod12(a - rootPc) - mod12(b - rootPc))[p];
  let midi = tuning[0] + mod12(startPc - mod12(tuning[0]));
  // An open-string start leaves the shape no room to breathe on the strings above
  // it; take the same note an octave up.
  if (midi === tuning[0]) midi += 12;
  // WALK THE SCALE, NOT THE FRETS. Three consecutive scale tones per string, each
  // placed at the one fret on that string that sounds it — so the shape is a
  // CONSEQUENCE of the scale rather than a picture of one, and there is nothing
  // here that can be transcribed wrongly. A note that would need a negative fret
  // (this string is already tuned above it) or one past the end of the neck fails
  // the whole position rather than bending it into a shape nobody plays.
  const next = (m) => { let n = m + 1; while (!set.has(mod12(n))) n++; return n; };
  const dots = [];
  for (let s = 0; s < tuning.length; s++) {
    for (let k = 0; k < 3; k++) {
      const fret = midi - tuning[s];
      if (fret < 0 || fret > maxFret) return null;
      const pc = mod12(midi);
      dots.push({ string: s, fret, pc, degree: degreeOf(pc, rootPc), root: pc === mod12(rootPc), midi });
      midi = next(midi);
    }
  }
  const frets = dots.map((d) => d.fret);
  return { dots, position: p, from: Math.min(...frets), to: Math.max(...frets) };
}

// ─── tuner support ───────────────────────────────────────────────────────────
// Which open string a heard frequency is trying to be. Not simply "nearest
// string": a low E played sloppily reads 30 cents flat and is still the low E,
// while the same pitch a fifth up is the A string and must not be reported as a
// very sharp E. So the match is by nearest string IN CENTS, with a stated
// tolerance past which the tuner says it cannot tell rather than guessing.
export function nearestString(hz, { tuning = STANDARD, capo = 0, a4 = 440, tolerance = 300 } = {}) {
  if (!(hz > 0)) return null;
  let best = null;
  for (let s = 0; s < tuning.length; s++) {
    const target = midiToFreq(tuning[s] + (Number(capo) || 0), a4);
    const cents = 1200 * Math.log2(hz / target);
    if (!best || Math.abs(cents) < Math.abs(best.cents)) best = { string: s, cents, target, midi: tuning[s] + (Number(capo) || 0) };
  }
  if (!best || Math.abs(best.cents) > tolerance) return null;
  return { ...best, name: midiName(best.midi), inTune: Math.abs(best.cents) <= 5 };
}

// The label a string wears in the tuner: "6 · E".
export function stringLabels(tuning = STANDARD, { capo = 0, flats = false } = {}) {
  return tuning.map((m, i) => ({
    string: i, number: tuning.length - i,
    midi: m + (Number(capo) || 0),
    note: pcName(mod12(m + (Number(capo) || 0)), { flats }),
    full: midiName(m + (Number(capo) || 0), { flats }),
    hz: midiToFreq(m + (Number(capo) || 0)),
  }));
}

// ─── parsing what a human types ──────────────────────────────────────────────
// "x32010", "X-3-2-0-1-0", "022000", "10 x 10 10 10 x" → a fret array. Returns
// null on anything it cannot read, because a half-understood shape drawn as a
// diagram is worse than a rejected one.
export function parseFrets(input, strings = 6) {
  if (Array.isArray(input)) {
    return input.length === strings && input.every((f) => f == null || (Number.isInteger(f) && f >= 0)) ? [...input] : null;
  }
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  // Two grammars. Separated ("x 3 2 0 1 0", "10-x-10-10") allows two-digit frets;
  // compact ("x32010") does not and must be exactly one character per string.
  const tokens = s.split(/[\s,\-–_|]+/).filter(Boolean);
  const read = (tok) => {
    if (/^[xX]$/.test(tok)) return null;
    if (/^\d{1,2}$/.test(tok)) { const n = Number(tok); return n <= 24 ? n : undefined; }
    return undefined;
  };
  if (tokens.length === strings) {
    const out = tokens.map(read);
    return out.some((v) => v === undefined) ? null : out;
  }
  const compact = s.replace(/[\s,\-–_|]/g, "");
  if (compact.length !== strings) return null;
  const out = compact.split("").map(read);
  return out.some((v) => v === undefined) ? null : out;
}

// "x32010" back out of a fret array — the compact form a chord chart prints, and
// the only form that survives being pasted anywhere else.
export const fretsToString = (frets) =>
  (Array.isArray(frets) ? frets : []).map((f) => (f == null ? "x" : f > 9 ? `(${f})` : String(f))).join("");

// A tuning typed by hand ("D A D G A D", "EADGBE", "Eb Ab Db Gb Bb Eb") → MIDI
// numbers, keeping each string in the octave the standard tuning has it in. This
// is what makes a custom tuning safe: it can only ever be a semitone shift of a
// real string, never an octave leap nobody meant.
export function parseTuning(input, base = STANDARD) {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;
  const tokens = raw.includes(" ") || raw.includes("-")
    ? raw.split(/[\s\-–,|]+/).filter(Boolean)
    : raw.split("");
  if (tokens.length !== base.length) return null;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const pc = parseNote(tokens[i]);
    if (pc == null) return null;
    // Land within a tritone of the standard pitch — the closest octave, so "D"
    // on the low E is 38 (a step down) and never 50 (an octave and a fourth up).
    const ref = base[i];
    let m = ref - mod12(ref) + pc;
    while (m - ref > 6) m -= 12;
    while (ref - m > 6) m += 12;
    out.push(m);
  }
  return out;
}
