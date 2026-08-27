// ─── The chord library — every shape, and the proof it is that chord ─────────
// Open and first-position voicings, plus the handful of movable grips that are
// not derivable from the CAGED shapes in fretboard.js. Barre chords are NOT
// listed here: `placeShape(movableByKey("E_maj"), rootPc)` is a better answer
// than 12 hand-typed rows, and it cannot be typed wrong.
//
// EVERY ROW IN THIS FILE IS CHECKED BY THE BUILD. scripts/guitar-smoke.mjs runs
// `verifyVoicing` over the whole table — it recomputes the pitch classes each
// fret array actually sounds and compares them against the formula for the chord
// the row claims to be, then mutates one fret at a time and asserts the check
// notices. A shape whose name and sound disagree fails `npm run verify` and
// never reaches the screen. That is the only reason it is safe to have typed two
// hundred numbers into a file.
//
// CONVENTIONS (see the header of fretboard.js — this file obeys it):
//   frets   six entries, LOW E FIRST, `null` = muted, `0` = open.
//   fingers same shape. 0 = open, null = muted, 1–4 = index…pinky.
//   barre   { fret, from, to } as STRING INDICES into the arrays above, or null.
//
// A NOTE ON DROPPED FIFTHS, because it looks like a bug and is not. The standard
// open C7 (x32310) is C–E–B♭–C–E: no fifth anywhere. That is the conventional
// voicing, in every chord book ever printed, because the fifth is the one tone a
// chord can lose without changing what it is. The verifier is built around that
// fact — root and fifth are droppable, everything else is not — so C7 passes on
// its merits rather than through an exception.

import { mod12, chordName, parseChord } from "./theory.js";
import { verifyVoicing, voicingDifficulty, MOVABLE, movableByKey, placeShape, STANDARD } from "./fretboard.js";

// A barre spanning every string from `from` to the top, at `fret`.
const bar = (fret, from = 0, to = 5) => ({ fret, from, to });

// rootPc, quality, frets, fingers, barre, label, tags.
// `label` overrides the generated name — used only where a shape is known by
// something other than its chord symbol ("F, the easy one").
const V = (rootPc, quality, frets, fingers, opts = {}) => ({
  rootPc: mod12(rootPc), quality, frets, fingers,
  barre: opts.barre || null,
  label: opts.label || null,
  bassPc: opts.bassPc == null ? null : mod12(opts.bassPc),
  // Degrees this shape deliberately leaves out, and why. See the note on
  // `omits` in verifyVoicing — a row may drop a defining tone only by saying so.
  omits: opts.omits || null,
  why: opts.why || null,
  tags: opts.tags || [],
  open: frets.some((f) => f === 0),
});

// ─── the table ───────────────────────────────────────────────────────────────
// Ordered roughly the way a player meets them: the eight open chords that unlock
// most of popular music, then the sevenths, the colours, and the awkward ones.
export const VOICINGS = [
  // ── A ──
  V(9, "maj", [null, 0, 2, 2, 2, 0], [null, 0, 1, 2, 3, 0], { tags: ["core", "open"] }),
  V(9, "min", [null, 0, 2, 2, 1, 0], [null, 0, 2, 3, 1, 0], { tags: ["core", "open"] }),
  V(9, "7", [null, 0, 2, 0, 2, 0], [null, 0, 2, 0, 3, 0], { tags: ["open", "blues"] }),
  V(9, "m7", [null, 0, 2, 0, 1, 0], [null, 0, 2, 0, 1, 0], { tags: ["open"] }),
  V(9, "maj7", [null, 0, 2, 1, 2, 0], [null, 0, 2, 1, 3, 0], { tags: ["open"] }),
  V(9, "sus2", [null, 0, 2, 2, 0, 0], [null, 0, 1, 2, 0, 0], { tags: ["open", "colour"] }),
  V(9, "sus4", [null, 0, 2, 2, 3, 0], [null, 0, 1, 2, 3, 0], { tags: ["open", "colour"] }),
  V(9, "5", [null, 0, 2, 2, null, null], [null, 0, 1, 2, null, null], { tags: ["power"] }),
  V(9, "6", [null, 0, 2, 2, 2, 2], [null, 0, 1, 1, 1, 1], { tags: ["open", "colour"] }),
  V(9, "aug", [null, 0, 3, 2, 2, 1], [null, 0, 4, 2, 3, 1], { tags: ["colour"] }),
  V(9, "9", [null, 0, 2, 4, 2, 3], [null, 0, 1, 3, 2, 4], { tags: ["blues", "jazz"] }),
  V(9, "7sus4", [null, 0, 2, 0, 3, 0], [null, 0, 2, 0, 3, 0], { tags: ["open", "colour"] }),
  V(9, "m7b5", [null, 0, 1, 0, 1, null], [null, 0, 1, 0, 2, null], { tags: ["jazz"] }),

  // ── B ──
  V(11, "7", [null, 2, 1, 2, 0, 2], [null, 2, 1, 3, 0, 4], { tags: ["core", "open"] }),
  V(11, "m7", [null, 2, 0, 2, 0, 2], [null, 1, 0, 2, 0, 3], { tags: ["open"] }),
  V(11, "dim7", [null, 2, 3, 1, 3, null], [null, 2, 3, 1, 4, null], { tags: ["jazz"] }),

  // ── C ──
  V(0, "maj", [null, 3, 2, 0, 1, 0], [null, 3, 2, 0, 1, 0], { tags: ["core", "open"] }),
  V(0, "maj7", [null, 3, 2, 0, 0, 0], [null, 3, 2, 0, 0, 0], { tags: ["open"] }),
  // The dropped fifth this file's header is about. C–E–B♭–C–E.
  V(0, "7", [null, 3, 2, 3, 1, 0], [null, 3, 2, 4, 1, 0], { tags: ["open", "blues"], label: "C7" }),
  V(0, "7", [null, 3, 2, 3, 1, 3], [null, 2, 1, 3, 1, 4], { tags: ["blues"], label: "C7 (with the 5th)" }),
  // The campfire Cadd9: fingers 3 and 4 stay planted on the third fret through
  // Cadd9 → G → Em7 → Dsus4, which is why this voicing and not x32030.
  V(0, "add9", [null, 3, 2, 0, 3, 3], [null, 2, 1, 0, 3, 4], { tags: ["core", "open", "campfire"] }),
  V(0, "add9", [null, 3, 2, 0, 3, 0], [null, 3, 2, 0, 4, 0], { tags: ["open"], label: "Cadd9 (small)" }),
  V(0, "6", [null, 3, 2, 2, 1, 0], [null, 4, 2, 3, 1, 0], { tags: ["colour"] }),
  V(0, "5", [null, 3, 5, 5, null, null], [null, 1, 3, 4, null, null], { tags: ["power"] }),
  V(0, "aug", [null, 3, 2, 1, 1, null], [null, 4, 3, 1, 2, null], { tags: ["colour"] }),
  V(0, "9", [null, 3, 2, 3, 3, 3], [null, 2, 1, 3, 3, 3], { barre: bar(3, 3, 5), tags: ["blues", "jazz"] }),
  V(0, "dim7", [null, 3, 4, 2, 4, null], [null, 2, 3, 1, 4, null], { tags: ["jazz"] }),

  // ── D ──
  V(2, "maj", [null, null, 0, 2, 3, 2], [null, null, 0, 1, 3, 2], { tags: ["core", "open"] }),
  V(2, "min", [null, null, 0, 2, 3, 1], [null, null, 0, 2, 3, 1], { tags: ["core", "open"] }),
  V(2, "7", [null, null, 0, 2, 1, 2], [null, null, 0, 2, 1, 3], { tags: ["core", "open", "blues"] }),
  V(2, "m7", [null, null, 0, 2, 1, 1], [null, null, 0, 2, 1, 1], { tags: ["open"] }),
  V(2, "maj7", [null, null, 0, 2, 2, 2], [null, null, 0, 1, 1, 1], { tags: ["open"] }),
  V(2, "sus2", [null, null, 0, 2, 3, 0], [null, null, 0, 1, 3, 0], { tags: ["open", "colour"] }),
  V(2, "sus4", [null, null, 0, 2, 3, 3], [null, null, 0, 1, 3, 4], { tags: ["open", "colour", "campfire"] }),
  V(2, "5", [null, null, 0, 2, 3, null], [null, null, 0, 1, 3, null], { tags: ["power"] }),
  V(2, "6", [null, null, 0, 2, 0, 2], [null, null, 0, 2, 0, 3], { tags: ["colour"] }),
  // The other half of "A Horse with No Name", and the one shape in this file that
  // deliberately has no third in it. D–A–B–E over an Em vamp: the missing third is
  // exactly why it floats instead of resolving, and naming it D6 or Dsus2 would
  // each be describing a different chord that nobody plays there.
  V(2, "69", [null, null, 0, 2, 0, 0], [null, null, 0, 2, 0, 0], { tags: ["colour", "open"], omits: [4], why: "no third — the vamp floats on the 6 and the 9", label: "D6/9" }),
  V(2, "69", [null, 5, 4, 4, 5, 5], [null, 2, 1, 1, 3, 4], { barre: bar(4, 2, 3), tags: ["jazz"] }),

  // ── E ──
  V(4, "maj", [0, 2, 2, 1, 0, 0], [0, 2, 3, 1, 0, 0], { tags: ["core", "open"] }),
  V(4, "min", [0, 2, 2, 0, 0, 0], [0, 2, 3, 0, 0, 0], { tags: ["core", "open"] }),
  V(4, "7", [0, 2, 0, 1, 0, 0], [0, 2, 0, 1, 0, 0], { tags: ["core", "open", "blues"] }),
  V(4, "7", [0, 2, 2, 1, 3, 0], [0, 2, 3, 1, 4, 0], { tags: ["blues"], label: "E7 (fuller)" }),
  V(4, "m7", [0, 2, 0, 0, 0, 0], [0, 2, 0, 0, 0, 0], { tags: ["open"] }),
  V(4, "m7", [0, 2, 2, 0, 3, 0], [0, 2, 3, 0, 4, 0], { tags: ["open", "campfire"], label: "Em7 (fuller)" }),
  V(4, "maj7", [0, 2, 1, 1, 0, 0], [0, 3, 1, 2, 0, 0], { tags: ["open"] }),
  V(4, "sus4", [0, 2, 2, 2, 0, 0], [0, 1, 2, 3, 0, 0], { tags: ["open", "colour"] }),
  V(4, "5", [0, 2, 2, null, null, null], [0, 1, 2, null, null, null], { tags: ["power"] }),
  V(4, "aug", [0, 3, 2, 1, 1, 0], [0, 4, 3, 1, 2, 0], { tags: ["colour"] }),
  V(4, "9", [0, 2, 0, 1, 0, 2], [0, 2, 0, 1, 0, 3], { tags: ["blues", "jazz"] }),

  // ── F ──
  V(5, "maj", [1, 3, 3, 2, 1, 1], [1, 3, 4, 2, 1, 1], { barre: bar(1, 0, 5), tags: ["core", "barre"] }),
  V(5, "maj", [null, null, 3, 2, 1, 1], [null, null, 3, 2, 1, 1], { barre: bar(1, 4, 5), tags: ["core"], label: "F (the small one)" }),
  V(5, "maj7", [null, null, 3, 2, 1, 0], [null, null, 3, 2, 1, 0], { tags: ["open"] }),
  V(5, "maj7", [1, 3, 3, 2, 1, 0], [1, 3, 4, 2, 1, 0], { barre: bar(1, 0, 4), tags: ["barre"], label: "Fmaj7 (barre)" }),

  // ── G ──
  V(7, "maj", [3, 2, 0, 0, 0, 3], [2, 1, 0, 0, 0, 3], { tags: ["core", "open"] }),
  V(7, "maj", [3, 2, 0, 0, 3, 3], [2, 1, 0, 0, 3, 4], { tags: ["core", "open", "campfire"], label: "G (the rock one)" }),
  V(7, "7", [3, 2, 0, 0, 0, 1], [3, 2, 0, 0, 0, 1], { tags: ["core", "open", "blues"] }),
  V(7, "maj7", [3, 2, 0, 0, 0, 2], [3, 2, 0, 0, 0, 1], { tags: ["open"] }),
  V(7, "add9", [3, 2, 0, 2, 0, 3], [3, 1, 0, 2, 0, 4], { tags: ["open", "colour"] }),
  V(7, "sus4", [3, 3, 0, 0, 1, 3], [2, 3, 0, 0, 1, 4], { tags: ["colour"] }),
  V(7, "5", [3, 5, 5, null, null, null], [1, 3, 4, null, null, null], { tags: ["power"] }),

  // ── the slash chords that actually get used ──
  // A bass note that is not the root is a different thing from a wrong bass
  // note, and the only way the verifier can tell is if the row says so.
  V(7, "maj", [null, 2, 0, 0, 3, 3], [null, 1, 0, 0, 3, 4], { bassPc: 11, tags: ["slash"], label: "G/B" }),
  V(2, "maj", [2, 0, 0, 2, 3, 2], [1, 0, 0, 2, 4, 3], { bassPc: 6, tags: ["slash"], label: "D/F♯" }),
  V(0, "maj", [3, 3, 2, 0, 1, 0], [3, 4, 2, 0, 1, 0], { bassPc: 7, tags: ["slash"], label: "C/G" }),
  // Charts write this one "Am/G", and the verifier is right that it is not: a G
  // under an A minor triad IS the ♭7, so the shape sounds A–C–E–G. It is filed
  // and printed as what it plays. The song parser still accepts "Am/G" and lands
  // here, which is the useful half of the convention without the wrong name.
  V(9, "m7", [3, 0, 2, 2, 1, 0], [3, 0, 2, 4, 1, 0], { bassPc: 7, tags: ["slash"] }),
  V(4, "min", [null, 2, 2, 0, 0, 0], [null, 1, 2, 0, 0, 0], { bassPc: 11, tags: ["slash"], label: "Em/B" }),
];

// The name a voicing prints under. Everything reads through here so a slash
// chord and a labelled shape can never disagree with the row they came from.
export const voicingName = (v, opts) => v.label || chordName(v.rootPc, v.quality, { bassPc: v.bassPc, ...opts });
// A stable id — the same shape gets the same key across reloads, which is what
// the practice scheduler's per-item history is filed under.
export const voicingId = (v) => `${v.rootPc}:${v.quality}:${v.frets.map((f) => (f == null ? "x" : f)).join("-")}`;

// Every voicing this app knows for a chord: the tabulated ones first (they are
// the ones a human chose), then the movable shapes placed at that root. Sorted
// easiest first, so the list a beginner sees opens with something playable.
export function voicingsFor(rootPc, quality, { tuning = STANDARD, maxFret = 12, includeMovable = true } = {}) {
  const pc = mod12(rootPc);
  const out = VOICINGS.filter((v) => v.rootPc === pc && v.quality === quality)
    .map((v) => ({ ...v, id: voicingId(v), source: "library", difficulty: voicingDifficulty(v.frets, { barre: v.barre?.fret ?? null }) }));
  if (includeMovable) {
    for (const shape of MOVABLE) {
      if (shape.quality !== quality) continue;
      const placed = placeShape(shape, pc, { tuning, minFret: 1, maxFret });
      if (!placed) continue;
      // A movable shape that reproduces a tabulated one adds nothing but a
      // duplicate row — the open E at the twelfth fret is not a second answer.
      const key = placed.frets.map((f) => (f == null ? "x" : f)).join("-");
      if (out.some((v) => v.frets.map((f) => (f == null ? "x" : f)).join("-") === key)) continue;
      out.push({
        rootPc: pc, quality, frets: placed.frets,
        // Fingering for a barre shape is the shape's own, shifted with it —
        // stored on the shape rather than recomputed, because "which finger"
        // is a fact about the grip, not about the fret number.
        fingers: shape.fingers || null,
        barre: placed.barre == null ? null : bar(placed.barre, shape.offsets.findIndex((o) => o === shape.barre), 5),
        label: null, bassPc: null, tags: ["movable"], open: false,
        id: `${pc}:${quality}:${shape.key}:${placed.baseFret}`,
        source: "movable", shape: shape.key, shapeName: shape.name,
        difficulty: voicingDifficulty(placed.frets, { barre: placed.barre }),
      });
    }
  }
  return out.sort((a, b) => a.difficulty - b.difficulty);
}

// "Am7" → its voicings. The path from anything the user typed to something
// drawable, and it returns null rather than an empty list for an unreadable
// symbol so the caller can say "I don't know that chord" instead of "no shapes".
export function lookupChord(symbol, opts) {
  const parsed = parseChord(symbol);
  if (!parsed) return null;
  const list = voicingsFor(parsed.rootPc, parsed.quality, opts);
  // A slash chord asks for a specific bass; prefer a shape that has it.
  if (parsed.bassPc != null) {
    const withBass = VOICINGS.filter((v) => v.rootPc === parsed.rootPc && v.quality === parsed.quality && v.bassPc === parsed.bassPc)
      .map((v) => ({ ...v, id: voicingId(v), source: "library", difficulty: voicingDifficulty(v.frets, { barre: v.barre?.fret ?? null }) }));
    if (withBass.length) return { ...parsed, voicings: [...withBass, ...list] };
  }
  return { ...parsed, voicings: list };
}

// Sanity, callable at runtime as well as from the smoke: does this shape sound
// like the chord it says it is? The custom-song editor runs it on anything typed
// by hand, so a shape Cameron invents gets the same check as one that shipped.
export const checkVoicing = (v, tuning = STANDARD) =>
  verifyVoicing(v.frets, v.rootPc, v.quality, { tuning, bassPc: v.bassPc, omits: v.omits || [] });

// Fingerings for the movable shapes, attached here rather than in fretboard.js:
// that file is about where the notes are, and which finger presses them is a
// different kind of fact. Same index convention as everything else.
const SHAPE_FINGERS = {
  E_maj: [1, 3, 4, 2, 1, 1], E_min: [1, 3, 4, 1, 1, 1], E_7: [1, 3, 1, 2, 1, 1],
  E_m7: [1, 3, 1, 1, 1, 1], E_maj7: [1, 3, 2, 2, 1, 1], E_5: [1, 3, 4, null, null, null],
  A_maj: [null, 1, 2, 3, 4, 1], A_min: [null, 1, 3, 4, 2, 1], A_7: [null, 1, 3, 1, 4, 1],
  A_m7: [null, 1, 3, 1, 2, 1], A_maj7: [null, 1, 3, 2, 4, 1], A_5: [null, 1, 3, 4, null, null],
  C_maj: [null, 4, 3, 1, 2, 1], G_maj: [3, 2, 1, 1, 1, 4], D_maj: [null, null, 1, 2, 4, 3],
  D_min: [null, null, 1, 3, 4, 2],
};
for (const shape of MOVABLE) shape.fingers = SHAPE_FINGERS[shape.key] || null;

export { movableByKey, placeShape };
