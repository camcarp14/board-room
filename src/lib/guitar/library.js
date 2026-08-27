// ─── The library — the program, the drills, and the songs ────────────────────
// Static data, no I/O, no React. Everything the Guitar tab teaches comes from
// this file; the panels only draw it. Kept apart from theory.js and chords.js on
// purpose: those two are FACTS about music and can be checked against arithmetic,
// while everything here is a JUDGEMENT about how to learn — an order, a
// benchmark, a piece of advice — and judgements deserve to be arguable in one
// place rather than sprinkled through components.
//
// The curriculum is the JustinGuitar-shaped spine (the one most self-taught
// adults actually complete) with entry and exit GATES rather than lesson counts,
// because "watched the video" is not a skill and "thirty changes a minute" is.
//
// SONG CHARTS HOLD CHORDS AND STRUCTURE. No lyrics, no tab, no audio — a chord
// sequence is a fact about a song, and it is also the only part of one that this
// app has any business storing. Each chart is the common simplified reading, the
// one a competent player would busk from; Cameron can edit any of them and add
// his own, which is what the editor in the Songs tab is for.

import { mod12 } from "./theory.js";

// ─── strumming patterns ──────────────────────────────────────────────────────
// One character per subdivision. D down, U up, "-" the hand travelling past the
// strings without hitting them, "x" a muted chuck.
//
// "-" IS NOT A REST, AND THE ANIMATION DEPENDS ON THAT. The strumming hand keeps
// moving in constant eighths (or sixteenths) through every pattern here; the
// difference between D-DU-UDU and something unplayable is entirely about which
// passes of a continuously moving hand touch the strings. Draw the strokes only
// and pattern 5 is a riddle; draw the hand and it is obvious. Anything rendering
// these has to render the whole motion.
//
// `swing` IS A PROPERTY OF THE PATTERN, NOT A DECISION EACH SCREEN MAKES. It
// lived as a ternary at two call sites once, and the two disagreed: the Jam
// drill swung every straight pattern and left the shuffle straight, while the
// song player had a `? 0 : 0` that could not swing anything. Both read as
// deliberate. A pattern is straight or it is not, that is a fact about the
// pattern, and it belongs here where there is exactly one of it.
//
// The 12/8 shuffle is 0 for a reason that is easy to get backwards: it is
// ALREADY written in triplets, so the grid does the swinging. Ask for swing on
// top and every off-beat lands past the triplet — progression.strumTimeline
// guards against it, but the number here should say the true thing anyway.
export const STRUM_PATTERNS = [
  { key: "quarters", name: "Quarter downs", pattern: "D-D-D-D-", sub: 8, swing: 0, difficulty: 1, feel: "Slow ballad", songs: ["Knockin' on Heaven's Door"] },
  { key: "eighths", name: "Eighth downs", pattern: "DDDDDDDD", sub: 8, swing: 0, difficulty: 2, feel: "Driving, punk", songs: ["Blitzkrieg Bop"] },
  { key: "eighths_du", name: "Down-up eighths", pattern: "DUDUDUDU", sub: 8, swing: 0, difficulty: 3, feel: "Busy, even", songs: ["Twist and Shout"] },
  { key: "d_du", name: "D · D-U", pattern: "D-DUD-DU", sub: 8, swing: 0, difficulty: 4, feel: "All-purpose pop", songs: ["Free Fallin'", "Brown Eyed Girl"] },
  { key: "old_faithful", name: "Old faithful", pattern: "D-DU-UDU", sub: 8, swing: 0, difficulty: 5, feel: "The folk/pop default", songs: ["Wonderwall", "Wish You Were Here"] },
  { key: "lighter", name: "D · D-U · U-D", pattern: "D-DU-UD-", sub: 8, swing: 0, difficulty: 5, feel: "Lighter cousin", songs: ["A Horse with No Name", "Bad Moon Rising"] },
  { key: "syncopated", name: "Syncopated", pattern: "DU-UDU-U", sub: 8, swing: 0, difficulty: 6, feel: "Pushes the beat", songs: ["Riptide", "I'm Yours"] },
  { key: "swung_eighths", name: "Swung eighths", pattern: "D-DU-UDU", sub: 8, swing: 0.9, difficulty: 6, feel: "Blues/jazz lilt", songs: ["Ain't No Sunshine"] },
  { key: "shuffle", name: "Shuffle (12/8)", pattern: "D-DD-DD-DD-D", sub: 12, swing: 0, difficulty: 7, feel: "Triplet swing", songs: ["Folsom Prison Blues"] },
  { key: "backbeat", name: "Percussive backbeat", pattern: "D-x-D-x-", sub: 8, swing: 0, difficulty: 7, feel: "Slap on 2 and 4", songs: ["Use Somebody"] },
  { key: "funk16", name: "Sixteenth funk", pattern: "DUxUDUxUDUxUDUxU", sub: 16, swing: 0, difficulty: 9, feel: "Constant sixteenths", songs: ["Superstition"] },
];
export const strumByKey = (key) => STRUM_PATTERNS.find((p) => p.key === key) || STRUM_PATTERNS[0];

// ─── progressions ────────────────────────────────────────────────────────────
// Roman numerals, resolved against whatever key you pick by
// theory.numeralToChord. Storing degrees rather than chords is the whole point:
// one row here is twelve keys of practice, and a progression you can only play in
// C is not a progression you understand.
//
// `bars` is one entry per BAR, so a twelve-bar blues is twelve entries rather
// than three with a comment about repeats. `minor: true` reads the numerals
// against the natural minor scale.
export const PROGRESSIONS = [
  { key: "axis", name: "The four chords", bars: ["I", "V", "vi", "IV"], example: "Let It Be · With or Without You · Don't Stop Believin'", tags: ["pop", "core"] },
  { key: "axis_vi", name: "vi–IV–I–V", bars: ["vi", "IV", "I", "V"], example: "Zombie · Africa", tags: ["pop"] },
  { key: "doowop", name: "'50s / doo-wop", bars: ["I", "vi", "IV", "V"], example: "Stand By Me · Every Breath You Take", tags: ["pop", "core"] },
  { key: "three_chord", name: "I–IV–V", bars: ["I", "IV", "V"], example: "Twist and Shout · La Bamba", tags: ["core"] },
  { key: "blues12", name: "12-bar blues", bars: ["I7", "I7", "I7", "I7", "IV7", "IV7", "I7", "I7", "V7", "IV7", "I7", "V7"], example: "Johnny B. Goode", tags: ["blues", "core"] },
  { key: "blues12_quick", name: "12-bar, quick change", bars: ["I7", "IV7", "I7", "I7", "IV7", "IV7", "I7", "I7", "V7", "IV7", "I7", "V7"], example: "Hoochie Coochie Man", tags: ["blues"] },
  { key: "ii_v_i", name: "ii–V–I", bars: ["ii7", "V7", "Imaj7", "Imaj7"], example: "Autumn Leaves", tags: ["jazz", "core"] },
  { key: "turnaround", name: "I–vi–ii–V", bars: ["I", "vi", "ii", "V7"], example: "Heart and Soul", tags: ["jazz"] },
  { key: "andalusian", name: "Andalusian cadence", bars: ["i", "VII", "VI", "V"], minor: true, example: "Hit the Road Jack · Sultans of Swing (intro)", tags: ["minor"] },
  { key: "minor_pop", name: "i–VI–III–VII", bars: ["i", "VI", "III", "VII"], minor: true, example: "Numb · Save Tonight", tags: ["minor", "pop"] },
  { key: "mixolydian", name: "I–♭VII–IV", bars: ["I", "bVII", "IV"], example: "Sympathy for the Devil · Sweet Home Alabama", tags: ["rock"] },
  { key: "pachelbel", name: "Pachelbel", bars: ["I", "V", "vi", "iii", "IV", "I", "IV", "V"], example: "Canon in D · Basket Case", tags: ["classic"] },
  { key: "sad_pop", name: "vi–IV–V–I", bars: ["vi", "IV", "V", "I"], example: "Grenade · Someone Like You (chorus)", tags: ["pop"] },
  { key: "plagal", name: "IV–I (amen)", bars: ["IV", "I"], example: "Hymn cadences · Hey Jude (outro)", tags: ["classic"] },
  { key: "blues_turn", name: "I–VI7–ii–V", bars: ["I", "VI7", "ii", "V7"], example: "Sweet Georgia Brown", tags: ["jazz", "blues"] },
];
export const progressionByKey = (key) => PROGRESSIONS.find((p) => p.key === key) || null;

// ─── the curriculum ──────────────────────────────────────────────────────────
// Eight levels, each with a gate you can actually check. `exit` is prose the
// panel prints; `gate` is the machine-checkable version, evaluated against the
// skill table by `levelState` below — the two must say the same thing, which is
// why they sit on the same line.
export const LEVELS = [
  {
    n: 0, key: "setup", name: "First contact", weeks: "Week 1",
    about: "Hold it, tune it, read a chord box, make one note ring clean. Then play a two-chord song — actual music, on day one, not exercises.",
    skills: ["tune", "chord_em", "chord_a7", "strum_quarters"],
    exit: "Tune it unaided, fret a note that rings on every string, strum in time for 60 seconds.",
    gate: { skills: ["chord_em", "chord_a7"], minStrength: 55 },
  },
  {
    n: 1, key: "open", name: "Open chords & changing", weeks: "Months 1–3",
    about: "The eight open chords, in the order that makes each one cheaper than the last. Em first — two fingers, adjacent strings, nothing to mute, the highest success-per-effort chord on the instrument. G last, with the ring-and-pinky fingering, because that is what makes G→C and G→D cheap for the next decade.",
    skills: ["chord_em", "chord_e", "chord_a", "chord_d", "chord_am", "chord_dm", "chord_c", "chord_g",
      "chg_em_am", "chg_g_c", "chg_c_d", "chg_am_f", "strum_eighths", "strum_d_du"],
    exit: "All eight open chords clean · 30+ changes a minute on three pairs · five songs start to finish.",
    gate: { skills: ["chord_c", "chord_g", "chord_d", "chord_am", "chord_em"], minStrength: 65, songs: 5 },
  },
  {
    n: 2, key: "rhythm", name: "Rhythm & function", weeks: "Months 3–6",
    about: "Where a chord vocabulary becomes music: strumming patterns, palm muting, dynamics, the twelve-bar blues in two keys, power chords, and the number system. Power chords come BEFORE barre chords deliberately — one shape, twelve chords, on a grip you can already hold, so a movable shape is a familiar idea by the time it arrives in a hard package.",
    skills: ["strum_old_faithful", "strum_syncopated", "power_e5", "power_a5", "blues_12", "palm_mute", "capo", "pent_box1"],
    exit: "Twelve-bar blues in two keys without stopping · you can hear the change coming in a new song · ten songs.",
    gate: { skills: ["blues_12", "strum_old_faithful", "power_e5"], minStrength: 65, songs: 10 },
  },
  {
    n: 3, key: "barre", name: "Barre chords & the F problem", weeks: "Months 6–12",
    about: "F is the single most common quit point on the guitar, and it is not one skill — it is barre strength, thumb leverage and a four-finger shape stacked on top of each other. So it arrives last, as the hardest instance of a shape you already own: Fmaj7 mini-barre, then the four-string F, then the A-shape barre at the fifth fret (fewer strings under the barre, friendlier action), then the E-shape at the fifth, then walk it down 5→4→3→2→1.",
    skills: ["barre_fmaj7", "barre_f_small", "barre_a_shape", "barre_e_shape", "barre_walk", "chord_f", "bend_target", "vibrato", "pent_box2"],
    exit: "F clean on five strings, held four bars · a whole song on barre chords without cramping · twenty songs.",
    gate: { skills: ["chord_f", "barre_e_shape"], minStrength: 60, songs: 20 },
  },
  {
    n: 4, key: "caged", name: "CAGED & fretboard logic", weeks: "Year 1–2",
    about: "The neck stops being twelve unrelated boxes. Five shapes you already know as open chords, moved; the five pentatonic boxes connected by their shared notes; and triads on string sets — the most underrated intermediate skill there is, because it turns \"I know that chord down here\" into \"I can play that chord anywhere, in three registers\".",
    skills: ["caged_c", "caged_a", "caged_g", "caged_e", "caged_d", "notes_e_string", "notes_a_string", "notes_all", "triads_123", "triads_234", "pent_connect", "arp_maj"],
    exit: "Name the root of any CAGED shape at any fret · a I–IV–V with triads on three string sets · improvise over a backing track using two connected boxes.",
    gate: { skills: ["notes_all", "caged_e", "caged_a", "pent_connect"], minStrength: 65 },
  },
  {
    n: 5, key: "lead", name: "Lead vocabulary & picking", weeks: "Year 2–3",
    about: "Pentatonic blending, the blues scale, target-note soloing (chord tones landing on beats one and three), phrasing, and the picking mechanics that decide your ceiling. If slowing something down makes it easy it is an accuracy problem and the ladder fixes it; if slowing it down is ALSO hard, more reps make it worse and the motion itself is what needs changing.",
    skills: ["alt_picking", "tremolo", "blues_scale", "target_notes", "seq_thirds", "seq_fours", "legato", "phrasing"],
    exit: "Three choruses over a blues without repeating a lick · a learned solo at its own tempo · alternate picking at 120 bpm sixteenths, clean.",
    gate: { skills: ["alt_picking", "blues_scale", "target_notes"], minStrength: 65 },
  },
  {
    n: 6, key: "finger", name: "Fingerstyle & hybrid picking", weeks: "Parallel track — start any time from level 3",
    about: "Thumb alone until it is unconscious, then a finger on the beat, then a finger OFF the beat — that third step is the whole technique, and it is where everyone stalls. Only then patterns, chord changes underneath them, and Travis picking proper.",
    skills: ["thumb_bass", "finger_on_beat", "finger_off_beat", "travis", "hybrid_pick"],
    exit: "Alternating bass steady while you hold a conversation · a Travis-picked song end to end.",
    gate: { skills: ["travis"], minStrength: 60 },
  },
  {
    n: 7, key: "harmony", name: "Harmony & modes", weeks: "Year 3+",
    about: "Extensions, drop-2 voicings, modal harmony, arpeggios over changes, transcription. Modes taught PARALLEL rather than derivative: D Dorian is D minor with a raised sixth, not \"C major started on D\" — the second is efficient for finding the shape and produces players who never hear a mode or know when to use one. Order by usefulness: Dorian, Mixolydian, Aeolian, Lydian, Phrygian.",
    skills: ["mode_dorian", "mode_mixo", "drop2", "arps_changes", "transcribe", "modulation"],
    exit: "A mode used because it was the right sound · a solo transcribed by ear · a song learned alone in a week.",
    gate: { skills: ["mode_dorian", "transcribe"], minStrength: 60 },
  },
];
export const levelByKey = (key) => LEVELS.find((l) => l.key === key) || null;

// ─── skills ──────────────────────────────────────────────────────────────────
// The atoms the scheduler moves around. `kind` decides which drill runs;
// `target` is a tempo where one applies. Ids are permanent — they are the keys
// the practice history is filed under, so renaming one loses a year of progress.
const S = (id, name, level, kind, extra = {}) => ({ id, name, level, kind, ...extra });
export const SKILLS = [
  // level 0–1 — chords and changes
  S("tune", "Tune it by ear against the app", 0, "tool"),
  S("chord_em", "Em", 0, "chord", { chord: "Em" }),
  S("chord_a7", "A7", 0, "chord", { chord: "A7" }),
  S("chord_e", "E", 1, "chord", { chord: "E" }),
  S("chord_a", "A", 1, "chord", { chord: "A" }),
  S("chord_d", "D", 1, "chord", { chord: "D" }),
  S("chord_am", "Am", 1, "chord", { chord: "Am" }),
  S("chord_dm", "Dm", 1, "chord", { chord: "Dm" }),
  S("chord_c", "C", 1, "chord", { chord: "C" }),
  S("chord_g", "G", 1, "chord", { chord: "G" }),
  S("chg_em_am", "Em ↔ Am", 1, "change", { pair: ["Em", "Am"], target: 30 }),
  S("chg_g_c", "G ↔ C", 1, "change", { pair: ["G", "C"], target: 30 }),
  S("chg_c_d", "C ↔ D", 1, "change", { pair: ["C", "D"], target: 30 }),
  S("chg_am_f", "Am ↔ F", 1, "change", { pair: ["Am", "F"], target: 25 }),
  S("strum_quarters", "Quarter-note downs", 0, "strum", { strum: "quarters", target: 70 }),
  S("strum_eighths", "Eighth-note downs", 1, "strum", { strum: "eighths", target: 80 }),
  S("strum_d_du", "D · D-U", 1, "strum", { strum: "d_du", target: 80 }),
  // level 2 — rhythm and function
  S("strum_old_faithful", "Old faithful (D-DU-UDU)", 2, "strum", { strum: "old_faithful", target: 90 }),
  S("strum_syncopated", "The syncopated one", 2, "strum", { strum: "syncopated", target: 90 }),
  S("power_e5", "Power chords — 6th string root", 2, "shape", { shape: "E_5" }),
  S("power_a5", "Power chords — 5th string root", 2, "shape", { shape: "A_5" }),
  S("blues_12", "Twelve-bar blues in E and A", 2, "progression", { progression: "blues12", target: 90 }),
  S("palm_mute", "Palm muting", 2, "technique"),
  S("capo", "Capo — shape vs sound", 2, "tool"),
  S("pent_box1", "Minor pentatonic, box 1", 2, "scale", { scale: "minor_pent", box: 0, target: 80 }),
  // level 3 — barres
  S("barre_fmaj7", "Fmaj7 mini-barre", 3, "chord", { chord: "Fmaj7" }),
  S("barre_f_small", "F, the four-string one", 3, "chord", { chord: "F" }),
  S("barre_a_shape", "A-shape barre at the 5th", 3, "shape", { shape: "A_maj" }),
  S("barre_e_shape", "E-shape barre at the 5th", 3, "shape", { shape: "E_maj" }),
  S("barre_walk", "Walk the E-shape down 5→1", 3, "shape", { shape: "E_maj", target: 60 }),
  S("chord_f", "F (full barre)", 3, "chord", { chord: "F" }),
  S("bend_target", "Target-note bending", 3, "technique"),
  S("vibrato", "Vibrato", 3, "technique"),
  S("pent_box2", "Minor pentatonic, box 2", 3, "scale", { scale: "minor_pent", box: 1, target: 80 }),
  // level 4 — CAGED
  S("caged_c", "CAGED — C shape", 4, "shape", { shape: "C_maj" }),
  S("caged_a", "CAGED — A shape", 4, "shape", { shape: "A_maj" }),
  S("caged_g", "CAGED — G shape", 4, "shape", { shape: "G_maj" }),
  S("caged_e", "CAGED — E shape", 4, "shape", { shape: "E_maj" }),
  S("caged_d", "CAGED — D shape", 4, "shape", { shape: "D_maj" }),
  S("notes_e_string", "Notes on the low E", 4, "fretboard", { strings: [0], target: 12 }),
  S("notes_a_string", "Notes on the A", 4, "fretboard", { strings: [1], target: 12 }),
  S("notes_all", "Notes, all six strings", 4, "fretboard", { strings: [0, 1, 2, 3, 4, 5], target: 20 }),
  S("triads_123", "Triads on strings 1–2–3", 4, "shape"),
  S("triads_234", "Triads on strings 2–3–4", 4, "shape"),
  S("pent_connect", "Connect boxes 1 and 2", 4, "scale", { scale: "minor_pent", target: 90 }),
  S("arp_maj", "Major arpeggios in position", 4, "scale", { target: 80 }),
  // level 5 — lead
  S("alt_picking", "Alternate picking", 5, "technique", { target: 120 }),
  S("tremolo", "Tremolo on one string", 5, "technique", { target: 150 }),
  S("blues_scale", "The blues scale", 5, "scale", { scale: "blues", target: 100 }),
  S("target_notes", "Chord tones on 1 and 3", 5, "technique", { target: 90 }),
  S("seq_thirds", "Broken thirds", 5, "scale", { target: 90 }),
  S("seq_fours", "Groups of four", 5, "scale", { target: 100 }),
  S("legato", "Legato — hammer-ons and pull-offs", 5, "technique", { target: 100 }),
  S("phrasing", "Phrasing — space and question/answer", 5, "technique"),
  // level 6 — fingerstyle
  S("thumb_bass", "Thumb alone — alternating bass", 6, "technique", { target: 80 }),
  S("finger_on_beat", "Thumb + finger, on the beat", 6, "technique", { target: 80 }),
  S("finger_off_beat", "Thumb + finger, off the beat", 6, "technique", { target: 80 }),
  S("travis", "Travis picking", 6, "technique", { target: 110 }),
  S("hybrid_pick", "Hybrid picking", 6, "technique", { target: 100 }),
  // level 7 — harmony
  S("mode_dorian", "Dorian, by its sound", 7, "scale", { scale: "dorian" }),
  S("mode_mixo", "Mixolydian, by its sound", 7, "scale", { scale: "mixolydian" }),
  S("drop2", "Drop-2 voicings", 7, "shape"),
  S("arps_changes", "Arpeggios over changes", 7, "scale", { target: 100 }),
  S("transcribe", "Transcribe by ear", 7, "ear"),
  S("modulation", "Key modulation", 7, "technique"),
];
export const skillById = (id) => SKILLS.find((s) => s.id === id) || null;
export const skillsForLevel = (n) => SKILLS.filter((s) => s.level === n);

// WHAT THE SCHEDULER IS ALLOWED TO PUT IN FRONT OF YOU TODAY, and it is a much
// shorter list than "everything". Two rules, and both were bugs before they were
// rules:
//
//  · A `tool` is not a drill. "Tune it by ear" and "capo — shape vs sound" are
//    things to understand once, not items with a tempo and a strength that decay
//    and come due. The scheduler ranks by how overdue something is, a skill
//    nobody has ever practised is maximally overdue, and so a brand-new account
//    was handed "Tune it by ear against the app" as its headline practice item.
//  · A LEVEL YOU HAVE NOT REACHED IS NOT DUE. Same arithmetic, worse outcome: on
//    day one every skill in the curriculum is equally never-practised, so the
//    sort put "Transcribe by ear" and "Drop-2 voicings" in front of somebody who
//    cannot yet hold an E minor. The gates in LEVELS exist precisely to say what
//    is next; the scheduler has to read them.
//
// Fingerstyle is the documented exception. It is a PARALLEL track — the thumb
// work can start any time from level 3 and does not gate the spine — so it opens
// at 3 rather than at 6.
const PARALLEL_FROM = { finger: 3 };
export function schedulableSkills(levelN, all = SKILLS) {
  const n = Math.max(0, Math.min(LEVELS.length - 1, Number(levelN) || 0));
  return all.filter((s) => {
    if (s.kind === "tool") return false;
    const lvl = LEVELS.find((l) => l.n === s.level);
    const from = (lvl && PARALLEL_FROM[lvl.key]) ?? s.level;
    return from <= n;
  });
}

// Where you are in the program: the highest level whose gate is met, plus what
// stands between you and the next one.
//
// `floor` IS WHAT STOPS THE PROGRAM EATING ITSELF, and it took an eighteen-month
// simulation to see why it has to exist. The gate reads DECAYED strength, which
// is right for "what should I practise" and catastrophic for "what have I
// reached": three weeks without touching Em drops the level-0 gate, the level
// drops with it, the pool shrinks from sixteen skills back to three — and the
// thirteen skills that just fell out of it are now unpractised, so they decay
// further and the level cannot climb back. The simulated learner oscillated 0-1-0
// for a year and a half and finished having touched sixteen of sixty-five skills.
//
// A LEVEL IS SOMETHING YOU REACHED, NOT SOMETHING YOU ARE HOLDING. You do not
// un-clear level 1 because you had a fortnight off. So the caller passes the
// highest level ever reached and the answer never goes below it; what decays is
// the individual skill, which is what the scheduler reads, and that is where
// forgetting belongs. `computed` is still returned so the panel can say "this one
// has slipped" without demoting anything.
export function levelState(skillStates, { songsOwned = 0, strengthOf, floor = 0 } = {}) {
  const strength = strengthOf || ((id) => skillStates?.[id]?.strength ?? 0);
  const met = (lvl) => {
    const g = lvl.gate || {};
    const need = g.skills || [];
    const short = need.filter((id) => strength(id) < (g.minStrength ?? 60));
    const songsShort = Math.max(0, (g.songs ?? 0) - songsOwned);
    return { ok: !short.length && !songsShort, short, songsShort };
  };
  let computed = LEVELS[0];
  for (const lvl of LEVELS) {
    if (lvl.key === "finger") continue;               // the parallel track never gates the spine
    if (met(lvl).ok) computed = LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(lvl) + 1)];
    else { computed = lvl; break; }
  }
  const n = Math.max(computed.n, Math.max(0, Math.min(LEVELS.length - 1, Math.round(Number(floor) || 0))));
  const current = LEVELS.find((l) => l.n === n) || LEVELS[0];
  const status = met(current);
  return { level: current, computed, reached: n, ...status, all: LEVELS.map((l) => ({ level: l, ...met(l) })) };
}

// ─── drills ──────────────────────────────────────────────────────────────────
// What a block of the session actually IS. `runner` names the component that
// drives it; `seconds` is the default slot length.
export const DRILLS = [
  { key: "chromatic", name: "Chromatic warm-up", runner: "metronome", seconds: 180, kind: "warmup",
    about: "One of the twenty-four 1-2-3-4 permutations against the click, 60–70 bpm. Two a day, not all of them — this is a warm-up, not a workout." },
  { key: "chord_perfect", name: "Chord Perfect", runner: "chord", seconds: 120, kind: "chord",
    about: "Place the chord. Pick every string one at a time. Take the whole hand off. Place it again. Five times. This trains PLACEMENT, which One-Minute Changes does not — and placement is what a change is made of." },
  { key: "omc", name: "One-Minute Changes", runner: "omc", seconds: 60, kind: "change",
    about: "Two chords, sixty seconds, count the changes. Objectively measured, sixty seconds long, and aimed squarely at the actual bottleneck — which is why it is the most efficient beginner drill that exists. 20 a minute is functional, 30 is song-ready, 60 is automatic." },
  { key: "ladder", name: "Tempo ladder", runner: "ladder", seconds: 240, kind: "technique",
    about: "Three clean reps, then up. One flubbed note and the count restarts. The tempos spiral rather than climb — 60, 70, 65, 75 — so nothing ends up clean at exactly one speed." },
  { key: "burst", name: "Speed burst", runner: "ladder", seconds: 180, kind: "technique",
    about: "For a wall rather than a wobble. Four to eight notes at 115% of target, two seconds, rest twenty. Ten of them. You are looking for the fast MOTION, not grinding the slow one — they are different motions, and laddering upward can install one with no path to speed." },
  { key: "note_finder", name: "Note Finder", runner: "fretboard", seconds: 180, kind: "fretboard",
    about: "Find every C♯ on the neck, timed. Then every F. The single highest-return skill most self-taught players skip entirely." },
  { key: "reverse_finder", name: "Reverse Finder", runner: "fretboard", seconds: 180, kind: "fretboard",
    about: "String four, fret seven — what note? The other direction, and the harder one." },
  { key: "degrees", name: "Scale degrees by ear", runner: "ear", seconds: 240, kind: "ear",
    about: "A drone holds the key. A note sounds. Which degree was it? Starts on 1, 3 and 5 only, and unlocks 2 and 6, then 4 and 7, at 85% rolling. Key-centre first, intervals later — you hear music in a key, not as a stack of intervals." },
  { key: "quality", name: "Chord quality by ear", runner: "ear", seconds: 180, kind: "ear",
    about: "Major or minor. Then sevenths. Then sus. The one that makes learning a song by ear possible." },
  { key: "drift", name: "Drop the click", runner: "drift", seconds: 180, kind: "timing",
    about: "The metronome plays two bars and goes silent for two. Keep playing. When it comes back, were you there? Reported in milliseconds, early or late, because \"you rush\" is a complaint and \"34 ms early\" is something to practise against." },
  { key: "seam", name: "Seam drill", runner: "song", seconds: 180, kind: "song",
    about: "Take the last two notes of one chunk and the first two of the next, and practise ONLY that, ten times, at tempo. Almost every \"I can play the parts but not together\" is a seam failure, and almost nobody drills seams." },
  { key: "audit", name: "Six-string audit", runner: "chord", seconds: 120, kind: "chord",
    about: "Fret the barre. Pick strings six to one, one at a time. Log which ones buzz. The pattern names the fix — see the cue cards." },
  { key: "jam", name: "Play over the changes", runner: "jam", seconds: 300, kind: "song",
    about: "A backing track from any progression in any key. The point of everything else." },
  { key: "runthrough", name: "Full run-through", runner: "song", seconds: 240, kind: "song",
    about: "Start to finish, no stopping, mistakes included. A song you only ever play in pieces is a song you cannot play." },
];
export const drillByKey = (key) => DRILLS.find((d) => d.key === key) || null;

// ─── cue cards ───────────────────────────────────────────────────────────────
// SYMPTOM → CAUSE → FIX. This is the substitute for a teacher watching you, and
// it is the one thing a video genuinely does worse: a video shows you a correct
// hand, and what you need is the name of what YOUR hand is doing wrong.
export const CUE_CARDS = [
  { key: "barre_b_dead", applies: ["barre", "chord"], symptom: "The B string is dead in every barre chord.",
    cause: "The index finger is flat. The pad face is soft and cannot press evenly, and the B string sits in the crease of the first joint.",
    fix: "Roll the index slightly onto its bony outer edge, towards the nut side. The finger should feel like it is on its side, not its face." },
  { key: "barre_outer_dead", applies: ["barre"], symptom: "Strings 1 and 6 are dead but the middle is fine.",
    cause: "The barre is sitting in the middle of the fret, or the wrist has not dropped.",
    fix: "Move the barre as close to the fret wire as you can without being on it. Drop the wrist so the finger lies straight across." },
  { key: "barre_exhausted", applies: ["barre"], symptom: "Everything is dead and your hand is exhausted after four bars.",
    cause: "You are squeezing. This is leverage, not strength.",
    fix: "Thumb flat on the BACK of the neck, roughly behind the index, never hooked over. Then push the elbow down and slightly forward — that is the clamp. If it still needs force, the guitar's action wants looking at." },
  { key: "barre_middle_dead", applies: ["barre"], symptom: "The middle strings buzz but the barre itself is fine.",
    cause: "Not a barre problem at all — the other fingers are collapsing at the last joint.",
    fix: "Check each of fingers 2, 3, 4 individually. Arch them; press with the tip, not the pad." },
  { key: "change_slow", applies: ["change"], symptom: "The change is clean but slow.",
    cause: "You are moving one finger at a time, and looking at each one land.",
    fix: "Lift all fingers together and place all fingers together — one movement, one arrival. Practise the AIR change with no strumming for thirty seconds first." },
  { key: "change_anchor", applies: ["change"], symptom: "Two chords in a pair share a finger and it still leaves the string.",
    cause: "Nobody told you it did not have to.",
    fix: "Find the anchor. Em→Am shares nothing but the shape; G→Cadd9 keeps fingers 3 and 4 planted; C→Am7 keeps the index. Leave the shared finger down and the change costs half as much." },
  { key: "strum_stops", applies: ["strum"], symptom: "The strumming hand stops when the chord changes.",
    cause: "You are treating the pattern as a list of hits rather than a moving hand.",
    fix: "The hand never stops. Keep it swinging in eighths and let it MISS the strings during the change — a missed strum in time beats a correct strum late, every time." },
  { key: "strum_wrong_feel", applies: ["strum"], symptom: "You have the right strokes and it still sounds wrong.",
    cause: "Almost always the up-strokes: you are hitting all six strings on the way up.",
    fix: "Up-strokes catch the top three or four strings only, and lighter. Down is the whole chord; up is the top of it." },
  { key: "buzz_general", applies: ["chord", "technique"], symptom: "A fretted note buzzes on one string.",
    cause: "The finger is too far behind the fret, or on top of it, or another finger is leaning on the string.",
    fix: "Just behind the fret wire, on the fingertip, nail short. Then pick each string alone to find the leaner." },
  { key: "tempo_wall", applies: ["technique"], symptom: "You hit the same bpm three sessions running and cannot pass it.",
    cause: "This is a mechanics problem, not a reps problem, and more laddering will make it worse — the slow motion and the fast one are not the same motion.",
    fix: "Stop the ladder. Do speed bursts: the fragment at 115%, two seconds, twenty seconds off, ten times. Find the fast motion first, then make it clean." },
  { key: "picking_trapped", applies: ["technique"], symptom: "Single-string picking is fast, string changes fall apart.",
    cause: "Trapped motion — neither the up- nor the down-stroke escapes the strings, so there is no clean path off the string you are leaving.",
    fix: "Tilt the pick and the wrist so ONE of the two strokes lifts clear of the strings. Then choose licks with note-groupings that leave each string on that stroke, rather than forcing the motion to fit the lick." },
  { key: "no_rhythm", applies: ["timing"], symptom: "It sounds right alone and wrong against a metronome.",
    cause: "You have been practising the notes and not the time.",
    fix: "Put the click on 2 and 4 instead of every beat. It is twice as hard and it is the only version that teaches you where the beat actually is." },
  { key: "songs_unfinished", applies: ["song"], symptom: "Lots of half-learned songs, nothing you can play end to end.",
    cause: "Nothing forces a finish, so the interesting part gets learned and the rest does not.",
    fix: "Three songs in Learning at a time, hard cap. A fourth means one has to be demoted. The only metric that counts here is songs you can play start to finish." },
];
export const cuesFor = (kind) => CUE_CARDS.filter((c) => c.applies.includes(kind));

// ─── the seed repertoire ─────────────────────────────────────────────────────
// Chords and structure. `sections` is [name, "chord chord | chord chord"] where
// "|" separates bars and a bar may hold one or two chords. `capo` is where the
// capo goes; `key` is the SOUNDING key, so a chart with a capo prints its shapes
// and names its real key without either of them lying.
//
// These are the common simplified readings — what a competent player would busk.
// They are a starting point and every one of them is editable; the point of the
// Songs tab is your repertoire, not this list.
//
// `key` IS THE SOUNDING KEY, NEVER THE SHAPES. With a capo those are different
// answers, and getting it wrong is the quiet kind of wrong: Riptide was filed in
// C because the shapes are Am–G–C, when a capo at the first fret puts it in D♭,
// and Jolene was filed in A minor when Dolly plays it at the fourth fret in C♯
// minor. Both would have sent you looking for the wrong scale to solo over.
// scripts/guitar-smoke.mjs now checks every row: the stated tonic has to appear
// among the chart's chord roots AFTER the capo is applied.
const song = (id, title, artist, o) => ({ id, title, artist, capo: 0, difficulty: 2, ...o });
export const SONGS = [
  song("horse", "A Horse with No Name", "America", { key: "Em", bpm: 122, difficulty: 1, strum: "lighter",
    sections: [["Verse", "Em | D6/9"], ["Chorus", "Em | D6/9"]], note: "Two chords, the whole song. The classic day-one song that is genuinely worth playing." }),
  song("heavens_door", "Knockin' on Heaven's Door", "Bob Dylan", { key: "G", bpm: 70, difficulty: 1, strum: "quarters",
    sections: [["Verse", "G | D | Am | Am"], ["Verse 2", "G | D | C | C"]] }),
  song("three_birds", "Three Little Birds", "Bob Marley", { key: "A", bpm: 76, difficulty: 1, strum: "d_du",
    sections: [["Verse", "A | A | E | E | A | A"], ["Chorus", "A | D | A | E A"]] }),
  song("bad_moon", "Bad Moon Rising", "CCR", { key: "D", bpm: 180, difficulty: 1, strum: "lighter",
    sections: [["Verse", "D A G | D | D A G | D"], ["Chorus", "G | D | A | G | D"]] }),
  song("ring_of_fire", "Ring of Fire", "Johnny Cash", { key: "G", bpm: 108, difficulty: 1, strum: "d_du",
    sections: [["Verse", "G | C G | G | D G"], ["Chorus", "C G | D G | C G | D G"]] }),
  song("blowin", "Blowin' in the Wind", "Bob Dylan", { key: "G", bpm: 88, difficulty: 1, strum: "d_du",
    sections: [["Verse", "G C | G | G C | D"], ["Chorus", "C D | G | C D | G"]] }),
  song("wagon_wheel", "Wagon Wheel", "Old Crow Medicine Show", { key: "G", bpm: 150, difficulty: 2, strum: "d_du",
    sections: [["Verse", "G | D | Em | C"], ["Chorus", "G | D | Em | C"]] }),
  song("stand_by_me", "Stand By Me", "Ben E. King", { key: "G", bpm: 118, difficulty: 2, strum: "d_du",
    sections: [["Verse", "G | G | Em | Em | C | D | G | G"]], progression: "doowop" }),
  song("zombie", "Zombie", "The Cranberries", { key: "Em", bpm: 84, difficulty: 2, strum: "eighths",
    sections: [["All of it", "Em | C | G | D"]], progression: "axis_vi" }),
  song("let_it_be", "Let It Be", "The Beatles", { key: "C", bpm: 72, difficulty: 2, strum: "d_du",
    sections: [["Verse", "C | G | Am | F"], ["Turn", "C | G | F | C"]], progression: "axis" }),
  song("free_fallin", "Free Fallin'", "Tom Petty", { key: "F", bpm: 84, difficulty: 2, capo: 3, strum: "d_du",
    sections: [["All of it", "D | Dsus4 | G | G"]], note: "Capo 3. The shapes are D–Dsus4–G; it sounds in F." }),
  song("sweet_home", "Sweet Home Alabama", "Lynyrd Skynyrd", { key: "D", bpm: 98, difficulty: 2, strum: "d_du",
    sections: [["All of it", "D | C | G | G"]], progression: "mixolydian" }),
  song("brown_eyed", "Brown Eyed Girl", "Van Morrison", { key: "G", bpm: 148, difficulty: 2, strum: "d_du",
    sections: [["Verse", "G | C | G | D"], ["Chorus", "C | D | G | Em | C | D | G | D"]] }),
  song("wonderwall", "Wonderwall", "Oasis", { key: "F#m", bpm: 87, difficulty: 2, capo: 2, strum: "old_faithful",
    sections: [["Verse", "Em7 | G | Dsus4 | A7sus4"], ["Chorus", "Cadd9 | Dsus4 | Em7 | Em7"]],
    note: "Capo 2. Shapes are Em7–G–Dsus4–A7sus4; it sounds in F♯ minor. Fingers 3 and 4 never leave the third fret." }),
  song("wish_you_were_here", "Wish You Were Here", "Pink Floyd", { key: "G", bpm: 60, difficulty: 3, strum: "old_faithful",
    sections: [["Intro/Verse", "Em7 | G | Em7 | A7sus4"], ["Turn", "G | C | D | Am | G"]] }),
  song("good_riddance", "Good Riddance (Time of Your Life)", "Green Day", { key: "G", bpm: 94, difficulty: 3, strum: "d_du",
    sections: [["Verse", "G | Cadd9 | D | D"], ["Chorus", "Em | D | C | G"]] }),
  song("riptide", "Riptide", "Vance Joy", { key: "Db", bpm: 102, difficulty: 2, capo: 1, strum: "syncopated",
    sections: [["Verse", "Am | G | C | C"], ["Chorus", "Am | G | C | C | F"]],
    note: "Capo 1. Shapes are Am–G–C; it sounds in D♭ (B♭ minor)." }),
  song("im_yours", "I'm Yours", "Jason Mraz", { key: "B", bpm: 76, difficulty: 3, capo: 4, strum: "syncopated",
    sections: [["All of it", "G | D | Em | C"]],
    note: "Capo 4. Shapes are G–D–Em–C; it sounds in B. Four chords, the whole song." }),
  song("perfect", "Perfect", "Ed Sheeran", { key: "Ab", bpm: 64, difficulty: 3, capo: 1, strum: "quarters",
    sections: [["Verse", "G | Em | C | D"], ["Chorus", "G | Em | C | D"]], note: "Capo 1, 6/8 feel — count it in twos." }),
  song("hallelujah", "Hallelujah", "Leonard Cohen", { key: "C", bpm: 60, difficulty: 3, strum: "quarters",
    sections: [["Verse", "C | Am | C | Am"], ["Turn", "F | G | C | G"], ["Chorus", "F | Am | F | C G | C"]] }),
  song("house_rising", "The House of the Rising Sun", "The Animals", { key: "Am", bpm: 76, difficulty: 3, strum: "shuffle",
    sections: [["Verse", "Am | C | D | F | Am | C | E | E"], ["Turn", "Am | C | D | F | Am | E | Am | E"]], note: "6/8. Arpeggiate it rather than strumming." }),
  song("jolene", "Jolene", "Dolly Parton", { key: "C#m", bpm: 110, difficulty: 2, capo: 4, strum: "d_du",
    sections: [["Verse", "Am | C G | Am | Am"], ["Chorus", "Am | C G | Am | Am"]],
    note: "Capo 4. Shapes are Am–C–G; it sounds in C♯ minor, which is where Dolly plays it." }),
  song("hurt", "Hurt", "Johnny Cash", { key: "Am", bpm: 84, difficulty: 2, strum: "quarters",
    sections: [["Verse", "Am | C | D | Am"], ["Chorus", "C | D | G | G"]] }),
  song("country_roads", "Take Me Home, Country Roads", "John Denver", { key: "A", bpm: 84, difficulty: 2, strum: "d_du",
    sections: [["Verse", "A | F#m | E | D | A"], ["Chorus", "E | A | F#m | D | A | E | A"]] }),
  song("with_or_without", "With or Without You", "U2", { key: "D", bpm: 110, difficulty: 2, strum: "eighths",
    sections: [["All of it", "D | A | Bm | G"]], progression: "axis" }),
  song("creep", "Creep", "Radiohead", { key: "G", bpm: 92, difficulty: 3, strum: "eighths",
    sections: [["All of it", "G | B | C | Cm"]], note: "The B major is the whole song. Barre it at 2." }),
  song("losing_religion", "Losing My Religion", "R.E.M.", { key: "Am", bpm: 126, difficulty: 3, strum: "eighths_du",
    sections: [["Verse", "F Dm | G Am | Am"], ["Chorus", "Am | Em | Am | Em | Dm | G | Am"]] }),
  song("boulevard", "Boulevard of Broken Dreams", "Green Day", { key: "Fm", bpm: 84, difficulty: 3, capo: 1, strum: "eighths",
    sections: [["Verse", "Em | G | D | A"], ["Chorus", "C | G | D | Em | C | G | D | D"]],
    note: "Capo 1. Shapes are Em–G–D–A; it sounds in F minor." }),
  song("nothing_else", "Nothing Else Matters", "Metallica", { key: "Em", bpm: 70, difficulty: 4, strum: "quarters",
    sections: [["Verse", "Em | D | C | G"], ["Chorus", "Am | Em | C | D | Em"]], note: "Fingerpicked. Level 6 material, but the chords are level 2." }),
  song("dust_in_wind", "Dust in the Wind", "Kansas", { key: "C", bpm: 90, difficulty: 5, strum: "quarters",
    sections: [["Verse", "C | Cmaj7 | Cadd9 | C | Am | Asus2 | Am | Asus2"], ["Turn", "G | D/F# | Am | Am"]], note: "Travis picking. The chord shapes are easy; the right hand is the work." }),
  song("folsom", "Folsom Prison Blues", "Johnny Cash", { key: "E", bpm: 108, difficulty: 2, strum: "shuffle",
    sections: [["12-bar", "E | E | E | E | A | A | E | E | B7 | A | E | B7"]], progression: "blues12" }),
  song("johnny_b", "Johnny B. Goode", "Chuck Berry", { key: "A", bpm: 168, difficulty: 4, strum: "shuffle",
    sections: [["12-bar", "A | A | A | A | D | D | A | A | E | D | A | E"]], progression: "blues12" }),
  song("smoke_water", "Smoke on the Water", "Deep Purple", { key: "Gm", bpm: 112, difficulty: 2, strum: "eighths",
    sections: [["Riff", "G5 | Bb5 C5 | G5 | Bb5 Db5 C5"]], note: "The riff is fourths on two strings, not power chords — but power chords get you there." }),
  song("seven_nation", "Seven Nation Army", "The White Stripes", { key: "Em", bpm: 124, difficulty: 1, strum: "eighths",
    sections: [["Riff", "Em | Em | G | Em D C"]], note: "The riff is one string. Everyone's first riff, for good reason." }),
  song("come_as_you_are", "Come As You Are", "Nirvana", { key: "F#m", bpm: 120, difficulty: 2, strum: "eighths",
    sections: [["Riff", "F#5 | F#5 | E5 | E5"], ["Chorus", "A5 | A5 | B5 | B5"]], note: "Tuned down a whole step on the record; the shapes are the same." }),
  song("sunshine", "Sunshine of Your Love", "Cream", { key: "D", bpm: 116, difficulty: 3, strum: "eighths",
    sections: [["Riff", "D | D | D | D"], ["Chorus", "G | G | A | A"]], note: "The riff is D minor pentatonic, box 1, in D. Box 1 is the whole song." }),
  song("autumn_leaves", "Autumn Leaves", "Standard", { key: "Gm", bpm: 120, difficulty: 5, strum: "quarters",
    sections: [["A", "Cm7 | F7 | Bbmaj7 | Ebmaj7"], ["A2", "Am7b5 | D7 | Gm | Gm"]], progression: "ii_v_i", note: "The ii–V–I workout. Every jazz player's first tune." }),
];
export const songById = (id) => SONGS.find((s) => s.id === id) || null;

// ─── chart parsing ───────────────────────────────────────────────────────────
// "Em7 | G | Dsus4 A7sus4" → bars of chord symbols. Bars are split on "|", and a
// bar with two chords splits the bar between them. Returns null on an unreadable
// chart rather than a partial one — half a chart drawn confidently is worse than
// a chart the editor says it cannot read.
export function parseBars(line) {
  if (typeof line !== "string") return null;
  const bars = line.split("|").map((b) => b.trim()).filter(Boolean);
  if (!bars.length) return null;
  return bars.map((b, i) => {
    const chords = b.split(/\s+/).filter(Boolean);
    return { bar: i, chords, beatsEach: 4 / Math.max(1, chords.length) };
  });
}
// Every chord symbol a chart mentions, deduped, in order of appearance — what
// the "chords in this song" strip draws, and what tells the practice engine
// which chord skills a song exercises.
export function chartChords(sections) {
  const out = [];
  for (const [, line] of sections || []) {
    for (const bar of parseBars(line) || []) for (const c of bar.chords) if (!out.includes(c)) out.push(c);
  }
  return out;
}
// The sounding key of a chart played with a capo. `key` on a song row is already
// the sounding key; this is for a chart typed in by hand, where the shapes are
// what got typed.
export const soundingKeyPc = (shapeKeyPc, capo) => mod12(shapeKeyPc + (Number(capo) || 0));

// ─── benchmarks ──────────────────────────────────────────────────────────────
// The numbers the drills are scored against. Teacher consensus rather than
// measured data, and labelled as such wherever they are printed — a benchmark
// presented as science is a benchmark somebody feels bad about.
export const BENCHMARKS = {
  omc: [{ n: 20, label: "Functional" }, { n: 30, label: "Song-ready" }, { n: 60, label: "Automatic" }],
  noteFinder: [{ s: 60, label: "Learning" }, { s: 30, label: "Solid" }, { s: 15, label: "Fluent" }],
  drift: [{ ms: 40, label: "Loose" }, { ms: 20, label: "Tight" }, { ms: 10, label: "Locked" }],
};
