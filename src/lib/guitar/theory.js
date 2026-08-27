// ─── Guitar theory — the arithmetic under every screen in the tab ─────────────
// PURE. No React, no Web Audio, no I/O. Everything here is a function of its
// arguments, which is what lets scripts/guitar-smoke.mjs execute it rather than
// grep for it. If a number is printed anywhere in the Guitar tab, it was
// computed in this file or in fretboard.js / practice.js next door.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: a chord diagram is a CLAIM. Six
// numbers on a page assert "press these frets and you will hear an A minor
// seventh". Nothing about that is checkable by eye — a transcription slip on the
// third string is invisible in review and audible in the room, and it teaches
// the wrong shape every day until someone notices. So the voicings in
// data/chords.js are stored as fret arrays AND the smoke recomputes the pitch
// classes each one actually sounds, against the formula for the chord it claims
// to be. A voicing that does not spell its own name fails the build. Nothing in
// this app may show a chord it has not verified.
//
// Pitch-class convention: C = 0 … B = 11. MIDI: A4 = 69 = 440 Hz, C-1 = 0,
// so middle C (C4) = 60 and the guitar's low E (E2) = 40.

// ─── names ───────────────────────────────────────────────────────────────────
export const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];

// ASCII in, typography out. Everything the user can type ("Bb", "F#m7") comes in
// through parseNote/parseChord; everything the app prints uses the ♯/♭ glyphs.
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const mod12 = (n) => ((n % 12) + 12) % 12;

// A key's spelling is a property of the key, not of the note: D major has F♯ and
// never G♭, F major has B♭ and never A♯. Every printed note name in the tab goes
// through here so one accidental style is used per screen.
export function pcName(pc, { flats = false } = {}) {
  const i = mod12(Math.round(pc));
  return flats ? FLAT_NAMES[i] : SHARP_NAMES[i];
}

// "Bb" / "B♭" / "f#" / "Eb" → pitch class. null for anything else — a caller
// that cannot tell a typo from a note would print one as the other.
export function parseNote(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^([A-Ga-g])([#♯b♭]?)$/);
  if (!m) return null;
  const base = LETTER_PC[m[1].toUpperCase()];
  const acc = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  return mod12(base + acc);
}

// ─── pitch ───────────────────────────────────────────────────────────────────
export const A4_HZ = 440;
// MIDI 0 is C-1, so the octave number is floor(m/12) - 1 and C4 = 60.
export const midiToFreq = (m, a4 = A4_HZ) => a4 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (hz, a4 = A4_HZ) => (hz > 0 ? 69 + 12 * Math.log2(hz / a4) : null);
export const midiPc = (m) => mod12(m);
export const midiOctave = (m) => Math.floor(m / 12) - 1;
export const midiName = (m, opts) => `${pcName(mod12(m), opts)}${midiOctave(m)}`;

// How far off you are, in cents, from the nearest note — the tuner's whole
// reading. Returned WITH the note it is measured against, because "−14 cents" on
// its own is a number about nothing.
//
// Signed and unbounded on purpose: a caller that wants ±50 gets it by choosing
// the nearest MIDI note (nearestNote below); a caller checking intonation
// against a SPECIFIC target string wants to know it is 700 cents out rather than
// being told it is fine because it happens to be a fifth away.
export function centsOff(hz, midi, a4 = A4_HZ) {
  if (!(hz > 0)) return null;
  return 1200 * Math.log2(hz / midiToFreq(midi, a4));
}

// The note a frequency is closest to, and by how much. Half of the tuner.
export function nearestNote(hz, a4 = A4_HZ) {
  const m = freqToMidi(hz, a4);
  if (m == null || !Number.isFinite(m)) return null;
  const midi = Math.round(m);
  return { midi, cents: (m - midi) * 100, name: midiName(midi), pc: mod12(midi), octave: midiOctave(midi) };
}

// ─── intervals ───────────────────────────────────────────────────────────────
export const INTERVAL_NAMES = [
  "R", "♭2", "2", "♭3", "3", "4", "♭5", "5", "♯5", "6", "♭7", "7",
];
export const INTERVAL_LONG = [
  "root", "minor 2nd", "major 2nd", "minor 3rd", "major 3rd", "perfect 4th",
  "tritone", "perfect 5th", "minor 6th", "major 6th", "minor 7th", "major 7th",
];
export const intervalName = (semitones) => INTERVAL_NAMES[mod12(semitones)];
export const intervalLong = (semitones) => INTERVAL_LONG[mod12(semitones)];
// The degree a pitch class plays against a root — what colours a fretboard dot.
export const degreeOf = (pc, rootPc) => mod12(pc - rootPc);

// ─── scales ──────────────────────────────────────────────────────────────────
// Semitone offsets from the root. Ordered so `SCALES` can drive a picker
// directly: the ones a guitarist reaches for first come first.
export const SCALES = [
  { key: "minor_pent", name: "Minor pentatonic", steps: [0, 3, 5, 7, 10], family: "pentatonic" },
  { key: "major_pent", name: "Major pentatonic", steps: [0, 2, 4, 7, 9], family: "pentatonic" },
  { key: "blues", name: "Blues (minor)", steps: [0, 3, 5, 6, 7, 10], family: "pentatonic" },
  { key: "major_blues", name: "Blues (major)", steps: [0, 2, 3, 4, 7, 9], family: "pentatonic" },
  { key: "major", name: "Major (Ionian)", steps: [0, 2, 4, 5, 7, 9, 11], family: "diatonic" },
  { key: "dorian", name: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10], family: "diatonic" },
  { key: "phrygian", name: "Phrygian", steps: [0, 1, 3, 5, 7, 8, 10], family: "diatonic" },
  { key: "lydian", name: "Lydian", steps: [0, 2, 4, 6, 7, 9, 11], family: "diatonic" },
  { key: "mixolydian", name: "Mixolydian", steps: [0, 2, 4, 5, 7, 9, 10], family: "diatonic" },
  { key: "minor", name: "Natural minor (Aeolian)", steps: [0, 2, 3, 5, 7, 8, 10], family: "diatonic" },
  { key: "locrian", name: "Locrian", steps: [0, 1, 3, 5, 6, 8, 10], family: "diatonic" },
  { key: "harmonic_minor", name: "Harmonic minor", steps: [0, 2, 3, 5, 7, 8, 11], family: "minor" },
  { key: "melodic_minor", name: "Melodic minor", steps: [0, 2, 3, 5, 7, 9, 11], family: "minor" },
  { key: "phrygian_dom", name: "Phrygian dominant", steps: [0, 1, 4, 5, 7, 8, 10], family: "exotic" },
  { key: "whole_tone", name: "Whole tone", steps: [0, 2, 4, 6, 8, 10], family: "exotic" },
  { key: "dim_hw", name: "Diminished (half–whole)", steps: [0, 1, 3, 4, 6, 7, 9, 10], family: "exotic" },
  { key: "dim_wh", name: "Diminished (whole–half)", steps: [0, 2, 3, 5, 6, 8, 9, 11], family: "exotic" },
];
export const scaleByKey = (key) => SCALES.find((s) => s.key === key) || null;
// The sounding pitch classes of a scale — what a fretboard map tests each fret against.
export const scalePcs = (rootPc, key) => {
  const s = scaleByKey(key);
  return s ? s.steps.map((n) => mod12(rootPc + n)) : [];
};

// ─── chords ──────────────────────────────────────────────────────────────────
// `steps` are semitones from the root, and the 9/11/13 extensions are written as
// their compound value (14, 17, 21) so the FORMULA still reads like the chord's
// name. They are reduced mod 12 wherever pitch classes are compared, which is
// the only comparison a guitar voicing can honestly support: six strings cannot
// state a 13th chord's full stack, and every real voicing drops something.
export const CHORDS = [
  { key: "5", name: "5 (power)", sym: "5", steps: [0, 7] },
  { key: "maj", name: "Major", sym: "", steps: [0, 4, 7] },
  { key: "min", name: "Minor", sym: "m", steps: [0, 3, 7] },
  { key: "dim", name: "Diminished", sym: "dim", steps: [0, 3, 6] },
  { key: "aug", name: "Augmented", sym: "aug", steps: [0, 4, 8] },
  { key: "sus2", name: "Suspended 2nd", sym: "sus2", steps: [0, 2, 7] },
  { key: "sus4", name: "Suspended 4th", sym: "sus4", steps: [0, 5, 7] },
  { key: "6", name: "Major 6th", sym: "6", steps: [0, 4, 7, 9] },
  { key: "m6", name: "Minor 6th", sym: "m6", steps: [0, 3, 7, 9] },
  { key: "7", name: "Dominant 7th", sym: "7", steps: [0, 4, 7, 10] },
  { key: "maj7", name: "Major 7th", sym: "maj7", steps: [0, 4, 7, 11] },
  { key: "m7", name: "Minor 7th", sym: "m7", steps: [0, 3, 7, 10] },
  { key: "m7b5", name: "Half-diminished", sym: "m7♭5", steps: [0, 3, 6, 10] },
  { key: "dim7", name: "Diminished 7th", sym: "dim7", steps: [0, 3, 6, 9] },
  { key: "7sus4", name: "Dominant 7 sus4", sym: "7sus4", steps: [0, 5, 7, 10] },
  { key: "add9", name: "Added 9th", sym: "add9", steps: [0, 4, 7, 14] },
  { key: "madd9", name: "Minor added 9th", sym: "m(add9)", steps: [0, 3, 7, 14] },
  { key: "69", name: "6/9", sym: "6/9", steps: [0, 4, 7, 9, 14] },
  { key: "9", name: "Dominant 9th", sym: "9", steps: [0, 4, 7, 10, 14] },
  { key: "maj9", name: "Major 9th", sym: "maj9", steps: [0, 4, 7, 11, 14] },
  { key: "m9", name: "Minor 9th", sym: "m9", steps: [0, 3, 7, 10, 14] },
  { key: "7b9", name: "Dominant 7♭9", sym: "7♭9", steps: [0, 4, 7, 10, 13] },
  { key: "7s9", name: "Dominant 7♯9", sym: "7♯9", steps: [0, 4, 7, 10, 15] },
  { key: "13", name: "Dominant 13th", sym: "13", steps: [0, 4, 7, 10, 21] },
  { key: "m11", name: "Minor 11th", sym: "m11", steps: [0, 3, 7, 10, 14, 17] },
];
export const chordByKey = (key) => CHORDS.find((c) => c.key === key) || null;
// The pitch classes a chord quality contains, deduped. This is the yardstick the
// voicing verifier measures every fret array against.
export function chordPcs(rootPc, qualityKey) {
  const q = chordByKey(qualityKey);
  if (!q) return [];
  return [...new Set(q.steps.map((n) => mod12(rootPc + n)))].sort((a, b) => a - b);
}
// The printed name. Slash chords carry their own bass: "D/F♯".
export function chordName(rootPc, qualityKey, { bassPc = null, flats = false } = {}) {
  const q = chordByKey(qualityKey);
  if (!q) return "";
  const head = pcName(rootPc, { flats }) + q.sym;
  return bassPc == null || mod12(bassPc) === mod12(rootPc) ? head : `${head}/${pcName(bassPc, { flats })}`;
}

// "Am7", "F#m7b5", "D/F#", "Cadd9" → { rootPc, quality, bassPc }.
//
// THE MATCH IS EXACT, NOT A PREFIX SCAN, and that is the point. "m7b5" starts
// with "m7", "maj9" starts with "maj", and "m" is a prefix of nearly all of them,
// so a scan that accepts the first alias that FITS turns Am7♭5 into Am7 — a
// different chord, printed confidently, with the ♭5 silently dropped. Requiring
// the whole remainder to be a known quality means an unrecognised symbol comes
// back null and the caller says "I don't know that chord" instead of guessing.
const QUALITY_ALIASES = [
  ["", "maj"], ["M", "maj"], ["maj", "maj"], ["major", "maj"],
  ["m", "min"], ["min", "min"], ["-", "min"], ["minor", "min"],
  ["5", "5"], ["dim", "dim"], ["°", "dim"], ["aug", "aug"], ["+", "aug"],
  ["sus2", "sus2"], ["sus4", "sus4"], ["sus", "sus4"],
  ["6", "6"], ["m6", "m6"], ["min6", "m6"], ["-6", "m6"],
  ["7", "7"], ["dom7", "7"],
  ["maj7", "maj7"], ["M7", "maj7"], ["Δ", "maj7"], ["Δ7", "maj7"],
  ["m7", "m7"], ["min7", "m7"], ["-7", "m7"],
  ["m7b5", "m7b5"], ["m7♭5", "m7b5"], ["ø", "m7b5"], ["ø7", "m7b5"], ["halfdim", "m7b5"],
  ["dim7", "dim7"], ["°7", "dim7"],
  ["7sus4", "7sus4"], ["7sus", "7sus4"],
  ["add9", "add9"], ["add2", "add9"],
  ["madd9", "madd9"], ["m(add9)", "madd9"], ["minadd9", "madd9"],
  ["69", "69"], ["6/9", "69"],
  ["9", "9"], ["maj9", "maj9"], ["M9", "maj9"], ["m9", "m9"], ["min9", "m9"],
  ["7b9", "7b9"], ["7♭9", "7b9"], ["7#9", "7s9"], ["7♯9", "7s9"],
  ["13", "13"], ["m11", "m11"], ["min11", "m11"],
];

export function parseChord(sym) {
  if (typeof sym !== "string") return null;
  const s = sym.trim();
  if (!s) return null;
  const m = s.match(/^([A-Ga-g][#♯b♭]?)(.*)$/);
  if (!m) return null;
  const rootPc = parseNote(m[1]);
  if (rootPc == null) return null;
  let rest = m[2];
  let bassPc = null;
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    // A slash that isn't a bass note ("6/9") stays part of the quality.
    const maybe = parseNote(rest.slice(slash + 1));
    if (maybe != null) { bassPc = maybe; rest = rest.slice(0, slash); }
  }
  const hit = QUALITY_ALIASES.find(([alias]) => alias === rest);
  if (!hit) return null;
  return { rootPc, quality: hit[1], bassPc };
}

// ─── keys ────────────────────────────────────────────────────────────────────
// The circle of fifths, as the app actually uses it: which accidentals a key
// spells with (so pcName gets the right flag), its relative minor, and the seven
// chords built on its own degrees.
const MAJOR_DEGREE_QUALITIES = ["maj", "min", "min", "maj", "maj", "min", "dim"];
const MAJOR_NUMERALS = ["I", "ii", "iii", "IV", "V", "vi", "vii°"];
const MINOR_DEGREE_QUALITIES = ["min", "dim", "maj", "min", "min", "maj", "maj"];
const MINOR_NUMERALS = ["i", "ii°", "III", "iv", "v", "VI", "VII"];

// Sharp keys vs flat keys, by pitch class of the tonic. F and everything round
// the flat side of the circle spell with flats; the rest with sharps. F♯/G♭ is a
// genuine coin flip at 6 sharps or 6 flats — G♭ is the commoner chart spelling
// for a guitarist, so flats.
const FLAT_MAJOR_PCS = new Set([5, 10, 3, 8, 1, 6]);      // F B♭ E♭ A♭ D♭ G♭
const FLAT_MINOR_PCS = new Set([2, 7, 0, 5, 10, 3]);      // Dm Gm Cm Fm B♭m E♭m
export const keyUsesFlats = (tonicPc, minor = false) =>
  (minor ? FLAT_MINOR_PCS : FLAT_MAJOR_PCS).has(mod12(tonicPc));

// The diatonic chords of a key, in degree order, each with its numeral.
export function keyChords(tonicPc, minor = false) {
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const quals = minor ? MINOR_DEGREE_QUALITIES : MAJOR_DEGREE_QUALITIES;
  const nums = minor ? MINOR_NUMERALS : MAJOR_NUMERALS;
  const flats = keyUsesFlats(tonicPc, minor);
  return steps.map((st, i) => {
    const rootPc = mod12(tonicPc + st);
    return {
      degree: i + 1, numeral: nums[i], rootPc, quality: quals[i],
      name: chordName(rootPc, quals[i], { flats }),
    };
  });
}
export const relativeMinorPc = (majorPc) => mod12(majorPc + 9);
export const relativeMajorPc = (minorPc) => mod12(minorPc + 3);

// The circle, starting at C and walking fifths clockwise. `accidentals` is
// SIGNED — positive is that many sharps, negative that many flats, zero is C —
// because the two sides of the circle are the same axis and a key signature is
// never both. Walking fifths reaches C♯ (7 sharps) at step 7; this spells the far
// side flat instead (D♭, 5 flats), which is what a chart hands a guitarist, so
// the count from step 6 on is measured backwards from 12.
export const CIRCLE_OF_FIFTHS = Array.from({ length: 12 }, (_, i) => {
  const pc = mod12(i * 7);
  const flats = keyUsesFlats(pc, false);
  const minorPc = relativeMinorPc(pc);
  return {
    pc, major: pcName(pc, { flats }),
    minorPc,
    minor: pcName(minorPc, { flats: keyUsesFlats(minorPc, true) }) + "m",
    accidentals: flats ? -(12 - i) : i,
  };
});

// A roman numeral against a key → a real chord. This is what turns a stored
// progression ("I–V–vi–IV") into six shapes you can actually play, in whatever
// key the song is in, which is the only way a progression library is worth
// anything on a guitar.
const ROMAN_ORDER = ["i", "ii", "iii", "iv", "v", "vi", "vii"];
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
export function numeralToChord(numeral, tonicPc, { minor = false } = {}) {
  if (typeof numeral !== "string") return null;
  const m = numeral.trim().match(/^([b♭#♯]?)([ivIV]+)(.*)$/);
  if (!m) return null;
  const idx = ROMAN_ORDER.indexOf(m[2].toLowerCase());
  if (idx < 0) return null;
  const acc = m[1] === "b" || m[1] === "♭" ? -1 : m[1] === "#" || m[1] === "♯" ? 1 : 0;
  // In a minor key the bare numerals are read against the NATURAL MINOR scale —
  // III is the ♭3, VII is the ♭7 — which is the standard analysis and what every
  // minor-key progression in the library is written in. An explicit accidental
  // overrides that and is measured off the major scale, because ♭VI in a minor
  // key would otherwise flatten a degree that is already flat.
  const base = acc !== 0 || !minor ? MAJOR_STEPS[idx] : MINOR_STEPS[idx];
  const rootPc = mod12(tonicPc + base + acc);
  const upper = m[2] === m[2].toUpperCase();
  const suffix = m[3];
  // ── THE SUFFIX IS A CHORD SUFFIX, SO parseChord READS IT ───────────────────
  // This used to be a second ladder of substring tests, and a second ladder is a
  // second set of holes. Every test is a substring search, so "maj9" fell past
  // /maj7|M7|Δ/ and was claimed by /9/ — Imaj9 came back as a DOMINANT ninth,
  // one note different, silently. So did V7♭9 and V7♯9 (the alteration dropped),
  // V13 and im11 (bare triads), and ii7♭5 (a plain m7) — which is the exact
  // failure parseChord's own header says the design exists to prevent. One
  // function got it right and its sibling in the same file did not.
  //
  // Now there is one reader. The numeral's CASE still carries the triad quality
  // when there is no suffix, and supplies the "m" when a lowercase numeral takes
  // one; everything after that is parseChord's job.
  let quality = upper ? "maj" : "min";
  if (/°|dim/.test(suffix)) quality = /7/.test(suffix) ? "dim7" : "dim";
  else if (/ø/.test(suffix)) quality = "m7b5";
  else if (suffix) {
    // A lowercase numeral means minor, so its suffix needs the m unless it
    // already carries one (im11) or the suffix is itself a quality word (isus4).
    const needsM = !upper && !/^(m|min|-|maj|M|Δ|sus|add|aug|\+|dim|°|ø|6|69|5)/.test(suffix);
    const body = needsM ? `m${suffix}` : suffix;
    const p = parseChord(`${SHARP_NAMES[mod12(rootPc)]}${body}`);
    // A suffix nothing can read is not a chord to guess at — that guess is the
    // whole bug above.
    if (!p || p.rootPc !== mod12(rootPc)) return null;
    quality = p.quality;
  } else if (!upper || true) {
    // ── AND A BARE NUMERAL AGREES WITH keyChords ─────────────────────────────
    // Two degrees of the diatonic set are DIMINISHED — vii in major, ii in minor
    // — and keyChords knows it while a bare lowercase numeral did not, so
    // numeralToChord("vii") in C gave B minor, whose F♯ is not in C major. Two
    // functions in one file disagreeing about the same degree of the same key is
    // worse than either convention on its own. The rest is untouched: V in a
    // minor key is still major, which is what everybody actually plays.
    const d = mod12(base + acc);
    const diatonicDim = minor ? d === 2 : d === 11;
    if (diatonicDim && !upper) quality = "dim";
  }
  return { rootPc, quality, numeral: numeral.trim() };
}

// ─── rhythm ──────────────────────────────────────────────────────────────────
// A strumming pattern is stored as one character per eighth note: D down, U up,
// "-" a rest, "x" a muted chuck. Everything about a pattern the UI needs — how
// many bars, where the beats fall, whether it syncopates — is derived, so a
// pattern is one short string in the data file and nothing else.
export const STRUM_CHARS = new Set(["D", "U", "-", "x", "X"]);
export function parseStrum(pattern, { subdivision = 8 } = {}) {
  if (typeof pattern !== "string") return null;
  const chars = pattern.replace(/[\s|]/g, "").split("");
  if (!chars.length || chars.some((c) => !STRUM_CHARS.has(c))) return null;
  const perBar = subdivision === 16 ? 16 : subdivision === 12 ? 12 : 8;
  // Four beats a bar in all three: 8 is eighths in 4/4, 16 is sixteenths in 4/4,
  // and 12 is 12/8 — four DOTTED-quarter beats of three, which is why the beat
  // arithmetic below divides by perBar/4 rather than assuming two per beat.
  const beatsPerBar = 4;
  return {
    steps: chars.map((c, i) => ({
      i, stroke: c === "X" ? "x" : c,
      // Where this step lands in the bar, in beats — what a metronome lines up to.
      beat: (i % perBar) / (perBar / beatsPerBar),
      onBeat: (i % (perBar / beatsPerBar)) === 0,
      bar: Math.floor(i / perBar),
    })),
    bars: Math.ceil(chars.length / perBar),
    perBar, beatsPerBar, subdivision: perBar,
  };
}

// ─── transposition ───────────────────────────────────────────────────────────
// A capo does not change what you PLAY, it changes what is HEARD. Both readings
// are needed on screen at once: the shape you finger and the chord that sounds.
export const soundingPc = (shapePc, capo) => mod12(shapePc + (Number(capo) || 0));
export const shapePcForSounding = (soundingPcValue, capo) => mod12(soundingPcValue - (Number(capo) || 0));
