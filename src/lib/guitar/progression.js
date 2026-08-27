// ─── Progressions → something you can play along to ──────────────────────────
// PURE. Turns a row of roman numerals (or a song's chord chart) into a timeline
// of chords, real fingerings for them, and the exact beat each strum lands on.
// audio.js takes that timeline and makes noise; the panels take the same
// timeline and draw the diagram that is sounding right now. One source, so the
// picture and the sound can never disagree about which chord you are on.
//
// THIS IS WHERE THE BACKING TRACKS COME FROM, and it is the reason this tab has
// any without shipping a single audio file. Fifteen progressions × twelve keys ×
// ten strum patterns is a couple of thousand play-alongs out of about two hundred
// lines of data — and unlike a library of recordings, every one of them is in
// whatever key and at whatever tempo you need.

import { mod12, numeralToChord, chordName, keyUsesFlats, parseChord, parseStrum, chordByKey } from "./theory.js";
import { voicingMidi, STANDARD } from "./fretboard.js";
import { voicingsFor, lookupChord } from "./chords.js";
import { progressionByKey, strumByKey, parseBars } from "./library.js";

// ─── the chord timeline ──────────────────────────────────────────────────────
// One entry per BAR — the unit everything downstream counts in. `beats` is how
// long this chord holds, so two chords in one bar are two events of two beats
// rather than a special case anybody has to remember.
export function expandProgression(progKey, tonicPc, { bars = null, barsPerChord = 1, repeats = 1 } = {}) {
  const prog = progressionByKey(progKey);
  if (!prog) return [];
  const flats = keyUsesFlats(tonicPc, !!prog.minor);
  const out = [];
  let bar = 0;
  for (let r = 0; r < Math.max(1, repeats); r++) {
    for (const numeral of prog.bars) {
      const ch = numeralToChord(numeral, tonicPc, { minor: !!prog.minor });
      if (!ch) continue;
      for (let b = 0; b < Math.max(1, barsPerChord); b++) {
        out.push({
          bar: bar++, beats: 4, numeral,
          rootPc: ch.rootPc, quality: ch.quality,
          symbol: chordName(ch.rootPc, ch.quality, { flats }),
        });
      }
    }
  }
  return bars ? out.slice(0, bars) : out;
}

// A song's chart → the same timeline, so the Songs tab and the Jam tab feed one
// player rather than two that drift apart.
export function expandChart(sections, { repeats = 1 } = {}) {
  const out = [];
  let bar = 0;
  for (let r = 0; r < Math.max(1, repeats); r++) {
    for (const [name, line] of sections || []) {
      const parsed = parseBars(line);
      if (!parsed) continue;
      for (const b of parsed) {
        for (const sym of b.chords) {
          const p = parseChord(sym);
          out.push({
            bar, beats: b.beatsEach, section: name, symbol: sym,
            rootPc: p?.rootPc ?? null, quality: p?.quality ?? null, bassPc: p?.bassPc ?? null,
            unknown: !p,
          });
        }
        bar++;
      }
    }
  }
  return out;
}

// ─── voice leading ───────────────────────────────────────────────────────────
// Pick a fingering for each chord that is near the last one. Not for elegance:
// a backing track that leaps from an open C to a barre at the eighth fret and
// back sounds like two different guitars, and — much worse for a practice tool —
// it stops being a picture of what your hands should do.
//
// The cost is the total fret travel of the fingered notes, with an explicit
// preference for open shapes near the nut when nothing is playing yet. Ties go to
// the easier grip, because at equal distance the beginner's answer is the right
// one.
const centreOf = (frets) => {
  const f = (frets || []).filter((x) => Number.isFinite(x) && x > 0);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0;
};
export function voiceProgression(events, { tuning = STANDARD, maxFret = 12, preferOpen = true, start = null } = {}) {
  let prev = start;
  const out = [];
  for (const ev of events) {
    if (ev.rootPc == null || !ev.quality) { out.push({ ...ev, voicing: null }); continue; }
    let options = voicingsFor(ev.rootPc, ev.quality, { tuning, maxFret });
    // A slash chord wants its bass; if we have a shape with it, that is the shape.
    if (ev.bassPc != null) {
      const withBass = options.filter((v) => v.bassPc === ev.bassPc);
      if (withBass.length) options = withBass;
    }
    if (!options.length) { out.push({ ...ev, voicing: null }); continue; }
    const prevCentre = prev ? centreOf(prev.frets) : preferOpen ? 0 : 5;
    const best = options.reduce((a, b) => (score(b) < score(a) ? b : a));
    function score(v) {
      const travel = Math.abs(centreOf(v.frets) - prevCentre);
      // Difficulty is worth about a fret and a half of travel: enough to break a
      // tie toward the easy shape, never enough to send the hand up the neck.
      return travel + v.difficulty * 0.6 + (preferOpen && !prev && v.open ? -1.5 : 0);
    }
    prev = best;
    out.push({ ...ev, voicing: best, midi: voicingMidi(best.frets, tuning) });
  }
  return out;
}

// ─── the strum timeline ──────────────────────────────────────────────────────
// Every stroke of the strumming hand across the whole progression, in BEATS from
// the start. Beats rather than seconds on purpose: the tempo can change (the
// tempo trainer ramps it mid-take) and a timeline in seconds would have to be
// rebuilt, while a timeline in beats is just read at a different rate.
//
// SILENT STROKES ARE IN THE LIST. A "-" in a pattern is the hand travelling past
// the strings without touching them, and it is emitted here as an event with
// `silent: true` — because the animation has to draw the whole motion. Draw the
// hits only and D-DU-UDU is a riddle; draw the hand and it is obvious. A player
// who learns the hits alone learns to stop the hand between them, which is the
// single most common reason a strumming pattern will not come.
//
// `swing` delays every off-beat subdivision toward a triplet feel. 0 is straight,
// 1 is full triplet swing (the off-beat lands two-thirds of the way through the
// beat); shuffle patterns want about 0.6.
export function strumTimeline(events, patternKey, { swing = 0, beatsPerBar = 4 } = {}) {
  const pat = strumByKey(patternKey);
  const parsed = parseStrum(pat.pattern, { subdivision: pat.sub });
  if (!parsed) return [];
  const perBeat = parsed.perBar / beatsPerBar;
  const out = [];

  // ── THE GRID IS ABSOLUTE, AND THE CHORD IS LOOKED UP UNDER IT ───────────────
  // The strumming hand keeps a steady grid and the chords change underneath it.
  // Walking per-chord instead — `steps = round(span · perBeat)` inside a loop over
  // the events — is exact only when every chord's span lands on a whole number of
  // steps, and a THREE-CHORD BAR does not: span is 4/3, so an eighth pattern got
  // round(2.667) = 3 steps per chord, NINE strokes in a four-beat bar, at 1/3-beat
  // offsets no eighth pattern has, with pattern step 5 sounded twice. Bad Moon
  // Rising, Seven Nation Army and Smoke on the Water all have three-chord bars,
  // and all three are difficulty 1–2 — the first songs anyone here plays. You read
  // D-DU-UD- off the screen and heard something else.
  //
  // Absolute indexing keeps what the per-chord walk was for (the pattern runs
  // continuously across chord changes rather than restarting on each) and drops
  // what it got wrong.
  const bounds = [];
  let acc = 0;
  for (const ev of events) {
    const span = ev.beats ?? beatsPerBar;
    bounds.push({ to: acc + span, ev });
    acc += span;
  }
  const totalSteps = Math.round(acc * perBeat);
  let bi = 0;
  // The direction of the last stroke that actually hit the strings. A pattern
  // that opens on a silent step has the hand coming down into it.
  let lastPlayedDown = false;
  {
    for (let stepIndex = 0; stepIndex < totalSteps; stepIndex++) {
      const i = stepIndex;
      const s = parsed.steps[stepIndex % parsed.steps.length];
      // SWING DELAYS THE SECOND OF EACH PAIR, and it is expressed as the ratio
      // the pair is split at: 0.5 is dead straight, 2⁄3 is a full triplet
      // shuffle, and `swing` slides between them. Applied to the pattern's own
      // subdivision, so eighth-note patterns swing their eighths and sixteenth
      // patterns swing their sixteenths.
      //
      // A TWELVE-STEP PATTERN IS NOT SWUNG, and that is the whole reason this is
      // a guard rather than a multiplier. 12/8 is already written in triplets —
      // the shuffle IS the grid — so swinging it again pushes every off-beat
      // past where a triplet lands and produces a limp nothing has ever played.
      const j = i % perBeat;
      const beatIdx = Math.floor(i / perBeat);
      const unit = 1 / perBeat;
      const swingable = perBeat % 2 === 0;
      const within = beatIdx + (swingable && j % 2 === 1
        ? Math.floor(j / 2) * 2 * unit + 2 * unit * (0.5 + swing / 6)
        : j * unit);
      const swung = within;
      // Which chord is sounding at this stroke. `bi` only moves forward, so the
      // whole walk is linear no matter how many chords the chart has.
      while (bi < bounds.length - 1 && swung >= bounds[bi].to - 1e-9) bi++;
      const ev = bounds[bi]?.ev;
      if (!ev) break;
      // WHICH WAY THE HAND IS TRAVELLING ON A PASS IT DOES NOT PLAY. A sounded
      // step is whatever the pattern writes; a silent one is the hand on its way
      // back from the last stroke it made — so it travels OPPOSITE to that. This
      // was a flat `D`, so seven of the eleven patterns drew a hand travelling
      // downward on consecutive passes, "quarters" — the first pattern anybody
      // meets — showing eight downstrokes in a row. Which defeats the one thing
      // the silent steps are emitted for: the note sixty lines up says draw the
      // hits alone and D-DU-UDU is a riddle, draw the hand and it is obvious.
      //
      // Opposite-of-the-last-stroke rather than index parity, because parity is
      // only right when the hand's unit is the subdivision. It is not in 12/8: a
      // ballad plays one stroke a dotted-quarter and the hand is rising across
      // BOTH silent triplets, which parity would draw as up-then-down.
      const isSilent = s.stroke === "-";
      const handDown = !lastPlayedDown;
      const down = isSilent ? handDown : s.stroke !== "U";
      if (!isSilent) lastPlayedDown = down;
      out.push({
        beat: swung,
        stroke: isSilent ? (down ? "D" : "U") : s.stroke,
        silent: isSilent,
        muted: s.stroke === "x",
        down,
        chord: ev,
        bar: ev.bar,
      });
    }
  }
  return out;
}

// The bass note under each chord. Root on beat one, root-and-fifth alternating,
// or a walk into the next chord — the third is what makes a backing track sound
// like a band rather than a metronome with chords on it.
// The bass note under a chord, in the octave the guitar is playing in. `rootPc`
// is the chord's own root; a slash chord's written bass (`bassPc`) wins, because
// that is the entire point of writing one.
function noteUnder(pc, lowest) {
  // Nearest note of that pitch class at or below the voicing's own bottom, so
  // the bass never crosses above the chord it is holding up.
  const d = mod12(mod12(lowest) - mod12(pc));
  return lowest - d;
}
// What beat one plays: a slash chord's WRITTEN bass, otherwise the chord's root.
function rootUnder(ev, lowest) {
  return noteUnder(ev.voicing?.bassPc ?? ev.bassPc ?? ev.rootPc ?? mod12(lowest), lowest);
}

// The fifth this quality actually has, in semitones above the root. Null-safe:
// an unknown quality falls back to the perfect fifth, which is what it was.
function fifthAbove(quality) {
  const steps = chordByKey(quality)?.steps;
  if (!Array.isArray(steps)) return 7;
  const fifth = steps.find((i) => i === 6 || i === 7 || i === 8);
  return fifth ?? 12;                     // no fifth in the chord — the octave, not an invention
}

export function bassLine(events, { style = "root", beatsPerBar = 4, tuning = STANDARD } = {}) {
  const out = [];
  let beat = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const span = ev.beats ?? beatsPerBar;
    // THE ROOT IS THE CHORD'S ROOT, NOT THE LOWEST NOTE SOUNDING. Those are the
    // same thing only in root position, and a bass player under a slash chord
    // plays the written bass, not the root — but a bass player under a plain
    // chord plays the ROOT, whatever inversion the guitar happens to be in.
    // Taking min(midi) meant the bass followed the guitarist's voicing around.
    const lowest = ev.midi?.length ? Math.min(...ev.midi) : null;
    if (lowest == null) { beat += span; continue; }
    const rootMidi = rootUnder(ev, lowest);
    if (style === "root") {
      out.push({ beat, midi: rootMidi, chord: ev });
    } else if (style === "root_fifth") {
      out.push({ beat, midi: rootMidi, chord: ev });
      // THE FIFTH COMES FROM THE CHORD, NOT FROM +7. A blind perfect fifth is
      // wrong for every altered-fifth quality there is: dim, dim7 and m7♭5 have
      // a ♭5 and aug has a ♯5, so this played a natural E under the A half-
      // diminished in Autumn Leaves — the one note that chord is defined by not
      // having. Where a chord has no fifth at all, the octave is the honest
      // alternative; inventing one is not.
      // AND MEASURED FROM THE CHORD'S ROOT, NOT FROM WHAT BEAT ONE PLAYED. Under
      // a slash chord those differ: D/F♯ puts F♯ on beat one, and a fifth above
      // F♯ is C♯ — not a note in D major. A bass player answers the written bass
      // with a chord tone, so beat three takes the fifth of the CHORD.
      if (span >= 4) {
        const chordRoot = ev.rootPc != null ? noteUnder(ev.rootPc, lowest) : rootMidi;
        out.push({ beat: beat + span / 2, midi: chordRoot + fifthAbove(ev.quality), chord: ev });
      }
    } else if (style === "walk") {
      // One note a beat, stepping toward the next chord's root — the last note
      // before a change is always a semitone or tone away from where it is going.
      const next = events[i + 1];
      const nextLow = next?.midi?.length ? Math.min(...next.midi) : null;
      const target = nextLow == null ? rootMidi : rootUnder(next, nextLow);
      const n = Math.max(1, Math.round(span));
      for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0 : k / (n - 1);
        const midi = k === 0 ? rootMidi
          : k === n - 1 ? target + (target > rootMidi ? -1 : target < rootMidi ? 1 : -1)
            : Math.round(rootMidi + (target - rootMidi) * t);
        out.push({ beat: beat + k, midi, chord: ev, passing: k > 0 });
      }
    }
    beat += span;
  }
  return out;
}

// Beats → seconds, at a tempo. The one place the conversion happens, so a change
// of tempo never has to walk a timeline and rewrite it.
export const beatsToSeconds = (beats, bpm) => (Number(beats) || 0) * (60 / Math.max(1, bpm));
export const totalBeats = (events, beatsPerBar = 4) => (events || []).reduce((a, e) => a + (e.beats ?? beatsPerBar), 0);

// ─── loops ───────────────────────────────────────────────────────────────────
// Where a loop wraps, and what bar you are in at a given beat. THE OFF-BY-ONE
// LIVES HERE AND NOWHERE ELSE — a loop over bars 3–6 must play 3, 4, 5, 6, 3 …
// with no 7 and no repeated 6, and every place that recomputed it independently
// got a different answer at the seam.
export function loopPosition(beat, { fromBeat = 0, toBeat = null, beatsPerBar = 4 } = {}) {
  const b = Math.max(0, Number(beat) || 0);
  if (toBeat == null || toBeat <= fromBeat) return { beat: b, pass: 0, bar: Math.floor(b / beatsPerBar) };
  const span = toBeat - fromBeat;
  if (b < fromBeat) return { beat: b, pass: 0, bar: Math.floor(b / beatsPerBar) };
  const rel = b - fromBeat;
  const pass = Math.floor(rel / span);
  const within = rel - pass * span;
  const abs = fromBeat + within;
  return { beat: abs, pass, bar: Math.floor(abs / beatsPerBar) };
}

// Which chord is sounding at a beat, and which is next — the two things the
// player's header prints. Returns indices so a caller can highlight the diagram
// without searching the list again.
export function chordAtBeat(events, beat, { beatsPerBar = 4 } = {}) {
  let acc = 0;
  for (let i = 0; i < events.length; i++) {
    const span = events[i].beats ?? beatsPerBar;
    if (beat < acc + span - 1e-9) return { index: i, chord: events[i], next: events[i + 1] || events[0] || null, startBeat: acc, endBeat: acc + span };
    acc += span;
  }
  const last = events.length - 1;
  return last >= 0 ? { index: last, chord: events[last], next: events[0] || null, startBeat: acc, endBeat: acc } : null;
}

// Everything a player needs, from one call. The Jam tab and a song's Sections row
// both go through here, which is what keeps them honest about each other.
export function buildBacking({
  progression = null, sections = null, tonicPc = 0, minor = false,
  strum = "d_du", swing = 0, bass = "root_fifth", repeats = 1,
  barsPerChord = 1, tuning = STANDARD, maxFret = 12, capo = 0,
} = {}) {
  const raw = sections
    ? expandChart(sections, { repeats })
    : expandProgression(progression, tonicPc, { barsPerChord, repeats });
  const voiced = voiceProgression(raw, { tuning, maxFret });
  const bassNotes = bassLine(voiced, { style: bass, tuning });

  // ── THE CAPO MOVES THE PITCH, NOT THE SHAPE ─────────────────────────────────
  // It was taken as an argument, stamped on the result and never used, so the
  // seven capoed songs in the library played their backing in the wrong key while
  // their own notes told you to put the capo on. Wonderwall's note says "Capo 2 …
  // it sounds in F♯ minor"; the track played E minor. Follow the instruction and
  // you were a whole tone above your own backing.
  //
  // Mutated in place ON PURPOSE: `strums[i].chord` and `bass[i].chord` are the
  // same objects as `voiced[i]`, so shifting here is what makes all three agree.
  // The DIAGRAMS are untouched — a capo does not change what your fingers do, and
  // the shape you are shown is the shape you play.
  const cp = Math.max(0, Math.min(12, Math.round(Number(capo) || 0)));
  if (cp > 0) {
    for (const c of voiced) if (Array.isArray(c.midi)) c.midi = c.midi.map((m) => m + cp);
    for (const n of bassNotes) if (Number.isFinite(n.midi)) n.midi += cp;
  }
  const strums = strumTimeline(voiced, strum, { swing });
  return {
    chords: voiced,
    strums,
    bass: bassNotes,
    beats: totalBeats(voiced),
    capo: cp,
    minor,
    // Anything the chart named that this app could not read. Surfaced rather
    // than skipped: a backing track that silently drops two bars is a backing
    // track that teaches the wrong form.
    unknown: voiced.filter((c) => c.unknown || !c.voicing).map((c) => c.symbol),
  };
}

export { lookupChord };
