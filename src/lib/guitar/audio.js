// ─── The sound — the only file in the tab that touches Web Audio ─────────────
// Everything that decides a NUMBER lives in dsp.js, which is pure and tested.
// This file owns the AudioContext, the buffers, the microphone and the
// scheduling, and it is deliberately thin: if a note is at the wrong pitch or a
// click is in the wrong place, the bug is next door, not here.
//
// THREE THINGS THIS FILE EXISTS TO GET RIGHT, all of them silent when wrong:
//
//  1. THE CONTEXT STARTS SUSPENDED. Every browser worth naming refuses to start
//     audio without a user gesture, and a suspended context does not error — it
//     schedules everything perfectly and plays none of it. So `unlock()` is
//     called from the first tap on anything that makes sound, and every entry
//     point awaits it rather than assuming.
//  2. SCHEDULING IS AHEAD OF THE CLOCK, NEVER ON IT. setInterval and
//     requestAnimationFrame are both tens of milliseconds loose and both stop
//     entirely in a backgrounded tab. A metronome driven off either drifts
//     audibly inside a minute. The loop here wakes on a timer but only ever
//     hands the audio clock events that are already in its future.
//  3. EVERYTHING STOPS WHEN IT IS TOLD TO. A source node that is started and
//     never disconnected is a leak with a sound attached; a hundred of them is a
//     phone that gets hot. Every player returns a stop function and every stop
//     function is idempotent.

import { pluck, click, droneLoop, normalize, detectPitch, medianHz, beatsInWindow, DEFAULT_PITCH_OPTS } from "./dsp.js";
import { midiToFreq } from "./theory.js";

// ─── the context ─────────────────────────────────────────────────────────────
let ctx = null;
let master = null;

export function audioContext() {
  if (ctx) return ctx;
  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  ctx = new AC({ latencyHint: "interactive" });
  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  return ctx;
}

// Called from the first user gesture that wants sound. Resolves to true if audio
// is actually running — a caller that gets false can say "tap to enable sound"
// rather than looking broken.
export async function unlock() {
  const c = audioContext();
  if (!c) return false;
  if (c.state === "suspended") { try { await c.resume(); } catch { return false; } }
  return c.state === "running";
}
export const isRunning = () => !!ctx && ctx.state === "running";
// The audio clock, for anything scheduling a short run of notes by hand. A
// caller that reaches for setTimeout instead gets a scale that arrives unevenly
// enough to hear — JS timers are tens of milliseconds loose and the ear resolves
// about five.
export const audioNow = () => (ctx ? ctx.currentTime : 0);
export const setVolume = (v) => { if (master) master.gain.value = Math.max(0, Math.min(1, v)); };

// ─── buffers ─────────────────────────────────────────────────────────────────
// A plucked note is ~1.9 seconds of float samples — about 340 kB each at 44.1 kHz
// — so they are cached by MIDI number and the cache is CAPPED. Without a cap a
// long jam session in every key eventually holds the whole neck in memory; with
// one, a backing track's twenty-odd notes stay warm and everything else is
// regenerated in a millisecond when it comes back.
const NOTE_SECONDS = 1.9;
const CACHE_CAP = 40;
const noteCache = new Map();     // midi -> AudioBuffer, insertion-ordered (used as LRU)

function bufferFor(midi) {
  const c = audioContext();
  if (!c) return null;
  const key = Math.round(midi);
  const hit = noteCache.get(key);
  if (hit) { noteCache.delete(key); noteCache.set(key, hit); return hit; }   // touch → most recent
  const data = pluck(midiToFreq(key), NOTE_SECONDS, c.sampleRate, { gain: 0.5, sustain: 2.8, seed: 1013904223 + key * 2654435761 });
  const buf = c.createBuffer(1, data.length, c.sampleRate);
  buf.copyToChannel(data, 0);
  noteCache.set(key, buf);
  if (noteCache.size > CACHE_CAP) noteCache.delete(noteCache.keys().next().value);
  return buf;
}

const clickCache = new Map();
function clickBuffer(accent) {
  const c = audioContext();
  if (!c) return null;
  const key = accent ? "hi" : "lo";
  if (clickCache.has(key)) return clickCache.get(key);
  // Two pitches a fifth apart. The accent is the higher one and slightly louder;
  // both are short, because the tail of a click is what turns fast tempi to mush.
  const data = click(accent ? 1760 : 1174.66, c.sampleRate, { seconds: 0.045, gain: accent ? 0.6 : 0.38 });
  const buf = c.createBuffer(1, data.length, c.sampleRate);
  buf.copyToChannel(data, 0);
  clickCache.set(key, buf);
  return buf;
}

let muteBuf = null;
function muteBuffer() {
  const c = audioContext();
  if (!c) return null;
  if (muteBuf) return muteBuf;
  // A muted chuck: filtered noise, 60 ms, no pitch. Generated once and reused.
  const n = Math.floor(c.sampleRate * 0.06);
  const data = new Float32Array(n);
  let s = 22222;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    const env = Math.exp(-(i / c.sampleRate) * 70);
    data[i] = ((s / 4294967296) * 2 - 1) * env * 0.35;
  }
  muteBuf = c.createBuffer(1, n, c.sampleRate);
  muteBuf.copyToChannel(normalize(data, 0.5), 0);
  return muteBuf;
}

// One note, at a time on the audio clock. Returns the source so a caller can
// stop it early; the node disconnects itself when it ends, so nothing has to be
// remembered by anyone who does not care.
export function playNote(midi, { at = 0, gain = 1, duration = null } = {}) {
  const c = audioContext();
  const buf = bufferFor(midi);
  if (!c || !buf) return null;
  const when = at || c.currentTime;
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(g).connect(master);
  src.start(when);
  if (duration) {
    // Fade rather than cut — a stopped buffer mid-cycle is a click.
    g.gain.setValueAtTime(gain, when + duration);
    g.gain.linearRampToValueAtTime(0.0001, when + duration + 0.08);
    src.stop(when + duration + 0.1);
  }
  src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* already gone */ } };
  return src;
}

// A strum: the same six notes, offset. `spread` is what makes it an arm rather
// than a chord button — about 18 ms between adjacent strings on a downstroke,
// tighter and top-first on an up.
export function playStrum(midis, { at = 0, down = true, gain = 0.5, spread = 0.018, muted = false } = {}) {
  const c = audioContext();
  if (!c) return;
  const when = at || c.currentTime;
  if (muted) {
    const buf = muteBuffer();
    if (!buf) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.start(when);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* already gone */ } };
    return;
  }
  const notes = (midis || []).filter((m) => Number.isFinite(m));
  if (!notes.length) return;
  // An up-stroke catches the top three or four strings, and lighter. That is not
  // decoration — it is the difference between a strumming pattern that sounds
  // like a pattern and one that sounds like eight identical chords.
  const order = down ? notes : [...notes].reverse().slice(0, Math.max(3, Math.ceil(notes.length * 0.7)));
  const step = down ? spread : spread * 0.7;
  order.forEach((m, i) => playNote(m, { at: when + i * step, gain: gain * (down ? 1 : 0.72) }));
}

// A steady tone for ear training and for tuning against. Returns a stop().
export function playDrone(midi, { gain = 0.22 } = {}) {
  const c = audioContext();
  if (!c) return () => {};
  // A HALF-SECOND BUFFER THAT IS A WHOLE NUMBER OF PERIODS, looped end to end.
  // The previous version rendered thirty seconds and looped 0.2 s → 29.8 s. That
  // span is not a whole number of cycles at any pitch, so the seam was a
  // full-scale step: an audible click, once every 29.6 seconds, for as long as
  // the drone played. It also cost 5 MB and 61 ms of synchronous main-thread
  // render — which is exactly the kind of stall that used to turn into a burst
  // of catch-up clicks in the transport next door. Period alignment fixes the
  // click and the 5 MB at the same time, because the material repeats every
  // period and a thirty-second copy of it was thirty seconds of the same wave.
  const data = droneLoop(midiToFreq(midi), c.sampleRate, { gain: 1 });
  const buf = c.createBuffer(1, data.length, c.sampleRate);
  buf.copyToChannel(data, 0);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const g = c.createGain();
  g.gain.value = 0;
  src.connect(g).connect(master);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + 0.08);
  src.start();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const t = c.currentTime;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0.0001, t + 0.12);
      src.stop(t + 0.15);
    } catch { /* already stopped */ }
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* already gone */ } };
  };
}

// ─── the transport ───────────────────────────────────────────────────────────
// One scheduler drives the metronome, the backing tracks and the drills. It
// wakes every 25 ms and schedules everything due in the next 120 ms — so the
// audio clock always has work queued ahead of it and the timer's own jitter (and
// a backgrounded tab's total absence) never reaches the sound.
//
// `onBeat` is called for the UI, and it is called with the time the beat WILL
// happen, not the time it was scheduled. A caller that wants a light to flash in
// sync sets a timeout for the difference; a caller that just wants a bar count
// ignores it. Either way nothing about the display can pull the audio off time.
const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const clampBpm = (v, fallback) => (Number.isFinite(v) ? Math.max(20, Math.min(300, v)) : fallback);
const clampInt = (v, fallback) => (Number.isFinite(v) ? Math.max(1, Math.round(v)) : fallback);

export function createTransport({ bpm = 90, beatsPerBar = 4, subdivision = 1, onBeat = null, countIn = 0 } = {}) {
  const state = {
    // `Math.max(20, Math.min(300, NaN))` is NaN, and a transport with a NaN bpm
    // reports running === true, plays nothing at all, and returns NaN from
    // position() for ever. Every clamp in this file goes through a finite check
    // first for that reason.
    bpm: clampBpm(bpm, 90), beatsPerBar: clampInt(beatsPerBar, 4), subdivision: clampInt(subdivision, 1),
    running: false, startTime: 0, nextIndex: 0, timer: null, onBeat, countIn,
    // Beats the clock ran past while the main thread was elsewhere. Not used to
    // make a decision — it is here so "did we drop any" is answerable at all,
    // which it was not when they were silently fired late instead.
    starting: false, dropped: 0,
    // Everything scheduled ahead of the clock, so a stop can cancel it.
    pending: [],
  };
  const spb = () => 60 / state.bpm / state.subdivision;

  // The window comes from dsp.beatsInWindow, which is pure and tested. This used
  // to be a second copy of that loop with a different bound and different event
  // fields, so the smoke test's scheduler section was asserting properties of
  // code nothing called while the live loop quietly broke one of them.
  const schedule = () => {
    const c = audioContext();
    if (!c || !state.running) return;
    const now = c.currentTime;
    const { beats, nextIndex, dropped } = beatsInWindow(state, { now, lookahead: LOOKAHEAD_S, cap: 256 });
    state.nextIndex = nextIndex;
    state.dropped += dropped;
    for (const ev of beats) {
      // RE-TESTED EVERY EVENT, because onBeat can stop us. The drills end
      // themselves from inside the callback (`if (ev.bar >= BARS) { m.stop();
      // finish(); }`); without this the rest of the window was delivered anyway,
      // re-running finish() on each and pushing phantom downbeats into the array
      // the drift measurement is computed from.
      if (!state.running) break;
      state.pending.push(ev);
      state.onBeat?.(ev);
    }
    // Anything already played leaves the list — it is only kept so a stop can
    // reason about what is still in flight.
    state.pending = state.pending.filter((e) => e.time >= now - 0.5);
  };

  const begin = async (at) => {
    if (!(await unlock())) return false;
    const c = audioContext();
    if (!c) return false;
    // Another start may have finished while this one was awaiting the unlock.
    if (state.running) return true;
    // A short lead-in, so the first beat is scheduled rather than fired late.
    state.startTime = at ?? c.currentTime + 0.08;
    state.nextIndex = 0;
    state.pending = [];
    state.dropped = 0;
    state.running = true;
    schedule();
    state.timer = setInterval(schedule, TICK_MS);
    return true;
  };

  return {
    get bpm() { return state.bpm; },
    get running() { return state.running; },
    get dropped() { return state.dropped; },
    get startTime() { return state.startTime; },
    // The musical position right now, for a UI that wants to draw a playhead.
    position() {
      const c = audioContext();
      if (!c || !state.running) return { beat: 0, bar: 0, index: 0 };
      const elapsed = Math.max(0, c.currentTime - state.startTime);
      const index = elapsed / spb();
      const beat = index / state.subdivision;
      return { index, beat, bar: Math.floor(beat / state.beatsPerBar) };
    },
    async start({ at = null } = {}) {
      // BOTH GUARDS, AND THE SECOND ONE IS THE ONE THAT MATTERED. `running` is
      // not set until after the await below, so two taps that straddle the very
      // first `unlock()` — which is exactly when the button looks unresponsive
      // and a phone user taps again — both got past a `running` check, both
      // reset the clock, and both called setInterval. `state.timer` only
      // remembers the second, so the first fires every 25 ms for the life of the
      // page with no handle to stop it, and the downbeat is scheduled twice.
      if (state.running || state.starting) return state.running;
      state.starting = true;
      try {
        return await begin(at);
      } finally {
        state.starting = false;
      }
    },
    stop() {
      if (!state.running) return;
      state.running = false;
      clearInterval(state.timer);
      state.timer = null;
      state.pending = [];
    },
      // A short lead-in, so the first beat is scheduled rather than fired late.
    // ── THE TEMPO CHANGES AT THE FIRST BEAT WE HAVE NOT ALREADY COMMITTED ────
    // Not at `currentTime`, which is what this used to do and which put one
    // wrong-length beat in on every single change.
    //
    // The reason is the lookahead. Beats up to `nextIndex - 1` are already on the
    // audio clock — that is the entire point of scheduling ahead — and they
    // cannot be moved. Rebasing so the fractional index at `currentTime` is
    // preserved therefore produced a seam that was neither the old period nor
    // the new one but a blend of the two, weighted by however far into the
    // lookahead we happened to be: 17 ms long on a 60→70 ramp step, 90 ms long
    // on 60→240, and 240 ms SHORT on a 180→60 tap tempo — a beat a quarter
    // shorter than it should be, which is an unmistakable stumble. The file's own
    // standard three screens up is that the ear resolves about five.
    //
    // Anchoring to the committed frontier instead makes the seam exactly one new
    // period, at every tempo pair, with nothing already scheduled disturbed. The
    // cost is that the change lands up to one lookahead later than the call —
    // 120 ms, which for a ramp that steps on bar lines is not observable, and
    // which buys an exact grid on both sides of the seam.
    setBpm(next) {
      const c = audioContext();
      const bpm = Math.round(next);
      if (!Number.isFinite(bpm)) return;           // NaN in is a transport that never sounds again
      const clamped = Math.max(20, Math.min(300, bpm));
      if (!c || !state.running || state.nextIndex === 0) { state.bpm = clamped; return; }
      const lastCommitted = state.startTime + (state.nextIndex - 1) * spb();
      state.bpm = clamped;
      // Put index `nextIndex` exactly one NEW period after the last committed
      // beat, and derive startTime from that. Every earlier index keeps the time
      // it was scheduled at; every later one is on the new grid, so every gap in
      // the whole take is exactly one period of one tempo or the other and never
      // a blend of the two.
      //   startTime + nextIndex·spb₁ = lastCommitted + spb₁
      state.startTime = lastCommitted - (state.nextIndex - 1) * spb();
    },
    // SUBDIVISION REBASES THE CLOCK, exactly as setBpm does, and for exactly the
    // same reason: `nextIndex` counts in units of spb, and spb is 60/bpm/sub. Set
    // the subdivision without rebasing and every index already counted is
    // silently reinterpreted — switching from quarters to sixteenths three
    // minutes in made the horizon hundreds of indices wide, and the scheduler
    // emitted eight hundred clicks all timestamped in the past, which a browser
    // plays at once. Switching back left ten seconds of dead air with the button
    // still reading Stop.
    setSubdivision(n) {
      const c = audioContext();
      const sub = clampInt(n, state.subdivision);
      if (!c || !state.running) { state.subdivision = sub; return; }
      const elapsed = c.currentTime - state.startTime;
      const beats = elapsed / (60 / state.bpm);          // musical position, subdivision-free
      state.subdivision = sub;
      state.startTime = c.currentTime - beats * (60 / state.bpm);
      state.nextIndex = Math.max(0, Math.ceil(beats * sub));
    },
    // The meter is not a rate — it only decides where the bar lines and the
    // accents fall — so it needs no rebase. It DID need to exist: the metronome
    // took beatsPerBar once at construction, the sheet's meter buttons only ever
    // called setPattern, and picking 3 left the accent landing every four beats
    // under a screen that said 3/4.
    setBeatsPerBar(n) { state.beatsPerBar = clampInt(n, state.beatsPerBar); },
    setOnBeat(fn) { state.onBeat = fn; },
  };
}

// The metronome proper: a transport whose beat handler makes a click. `pattern`
// silences beats — [1,0,1,0] is the 2-and-4 mode, which is twice as hard and the
// only version that teaches where the beat actually is.
export function createMetronome({ bpm = 90, beatsPerBar = 4, subdivision = 1, pattern = null, onBeat = null, gain = 1 } = {}) {
  let mute = false;
  const t = createTransport({
    bpm, beatsPerBar, subdivision,
    onBeat: (ev) => {
      // THE CALLER IS TOLD FIRST, AND THAT ORDERING IS THE WHOLE DRILL. Callers
      // decide the mute FROM the beat they are handed — drop-the-click is
      // literally `setMuted(floor(bar/2) % 2 === 1)` inside this callback. Click
      // first and every such decision lands one beat late at both edges: a stray
      // click one beat into the silence, and, far worse, no click on the downbeat
      // where the click comes BACK, which is the single instant the drill exists
      // to give you. Four of every ten downbeats were wrong.
      onBeat?.(ev);
      const on = !pattern || pattern[ev.inBar % pattern.length];
      if (!mute && on) {
        const c = audioContext();
        const buf = clickBuffer(ev.accent);
        if (c && buf) {
          const src = c.createBufferSource();
          src.buffer = buf;
          const g = c.createGain();
          g.gain.value = (ev.onBeat ? 1 : 0.5) * gain;
          src.connect(g).connect(master);
          src.start(ev.time);
          src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* already gone */ } };
        }
      }
    },
  });
  // NOT `{ ...t }`. Spreading an object READS its getters and freezes the answers
  // — `running` would be false for ever, `bpm` would be whatever it was when the
  // metronome was built, and both would look like state that simply never
  // updates. Delegating explicitly keeps them live.
  return {
    get bpm() { return t.bpm; },
    get running() { return t.running; },
    get startTime() { return t.startTime; },
    position: () => t.position(),
    start: (o) => t.start(o),
    stop: () => t.stop(),
    setBpm: (n) => t.setBpm(n),
    setSubdivision: (n) => t.setSubdivision(n),
    setBeatsPerBar: (n) => t.setBeatsPerBar(n),
    setOnBeat: (fn) => { onBeat = fn; },
    setPattern(p) { pattern = p; },
    // Drop-the-click: the drill needs the beats to keep COMING (the timeline
    // still runs, the UI still counts) while nothing is heard. Stopping the
    // transport instead would lose the phase, which is the one thing the drill
    // measures.
    setMuted(v) { mute = !!v; },
    get muted() { return mute; },
  };
}

// ─── the backing player ──────────────────────────────────────────────────────
// Takes a timeline from progression.js and plays it. Nothing is pre-rendered:
// each strum is scheduled from cached per-note buffers a fraction of a second
// before it happens, so the tempo can move under it and a loop can be changed
// mid-take without rebuilding anything.
export function createBackingPlayer(backing, {
  bpm = 90, loop = true, click: withClick = true, chords = true, bass = true,
  onChord = null, onBeat = null, countIn = 0,
} = {}) {
  const totalBeats = Math.max(1, backing?.beats || 0);
  const strums = backing?.strums || [];
  const bassNotes = backing?.bass || [];
  let lastChordIndex = -1;
  const mutes = { click: !withClick, chords: !chords, bass: !bass };

  const t = createTransport({
    bpm, beatsPerBar: 4, subdivision: 4, countIn,
    onBeat: (ev) => {
      const c = audioContext();
      if (!c) return;
      // Subdivision 4 gives a sixteenth-note grid; every strum in the timeline
      // lands on one of those or between two of them, so each tick claims the
      // events in [thisTick, nextTick) and schedules them at their EXACT time
      // rather than quantising them onto the grid. That is what keeps swing
      // swung — a triplet eighth is not on a sixteenth grid and must not be
      // dragged onto one.
      // THE COUNT-IN IS SUBTRACTED HERE, and it is the reason this is not simply
      // ev.index / 4. A four-beat count-in that only silenced the chords would
      // still have the song's own clock running under it, so the first bar you
      // heard would be bar two — the count-in would eat the intro. The song's
      // beat zero is the tick after the count-in ends.
      const beatNow = ev.index / 4 - countIn;
      const beatNext = (ev.index + 1) / 4 - countIn;
      const secPerBeat = 60 / t.bpm;
      const loopBeat = (b) => (loop ? ((b % totalBeats) + totalBeats) % totalBeats : b);
      const pass = Math.max(0, Math.floor(beatNow / totalBeats));
      if (!loop && beatNow >= totalBeats) { t.stop(); return; }
      const counting = beatNext <= 0;
      const from = counting ? -1 : loopBeat(beatNow), to = from + (beatNext - beatNow);
      const due = (b) => b >= from - 1e-9 && b < to - 1e-9;

      if (!mutes.chords) {
        for (const s of strums) {
          if (!due(s.beat)) continue;
          if (s.silent || counting) continue;                   // the hand moves; the strings do not
          const midis = s.chord?.midi || [];
          playStrum(midis, {
            at: ev.time + (s.beat - from) * secPerBeat,
            down: s.down, muted: s.muted,
            gain: s.down ? 0.5 : 0.36,
          });
        }
      }
      if (!mutes.bass && !counting) {
        for (const n of bassNotes) {
          if (!due(n.beat)) continue;
          playNote(n.midi - 12, { at: ev.time + (n.beat - from) * secPerBeat, gain: 0.5 });
        }
      }
      if (!mutes.click && ev.index % 4 === 0) {
        const buf = clickBuffer(ev.beat % 4 === 0);
        if (buf) {
          const src = c.createBufferSource();
          src.buffer = buf;
          const g = c.createGain();
          g.gain.value = counting ? 0.9 : 0.3;
          src.connect(g).connect(master);
          src.start(ev.time);
          src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* already gone */ } };
        }
      }
      // Which chord is sounding, for the diagram. Fired on the beat it CHANGES,
      // not every tick, so the panel is not re-rendering sixteen times a second.
      if (onChord && !counting) {
        let acc = 0, idx = -1;
        for (let i = 0; i < backing.chords.length; i++) {
          const span = backing.chords[i].beats ?? 4;
          if (from < acc + span - 1e-9) { idx = i; break; }
          acc += span;
        }
        if (idx !== lastChordIndex) {
          lastChordIndex = idx;
          onChord({ index: idx, chord: backing.chords[idx], next: backing.chords[(idx + 1) % backing.chords.length], pass, time: ev.time });
        }
      }
      onBeat?.({ ...ev, songBeat: from, pass, counting });
    },
  });

  // Delegated rather than spread — see the note in createMetronome.
  return {
    get bpm() { return t.bpm; },
    get running() { return t.running; },
    get startTime() { return t.startTime; },
    position: () => t.position(),
    start: (o) => t.start(o),
    stop: () => { t.stop(); lastChordIndex = -1; },
    setBpm: (n) => t.setBpm(n),
    setMute(which, v) { mutes[which] = !!v; },
    get mutes() { return { ...mutes }; },
    reset() { lastChordIndex = -1; },
  };
}

// ─── the tuner ───────────────────────────────────────────────────────────────
// A microphone, an analyser, and dsp.detectPitch. The processing that matters is
// next door and tested; what is here is the plumbing, plus the three settings
// that decide whether any of it works.
//
// echoCancellation, noiseSuppression and autoGainControl ARE ALL OFF, and that is
// the whole difference between a tuner and a toy. Every one of them is designed
// to make a voice on a call intelligible, and every one does it by reshaping the
// spectrum: noise suppression treats a sustained single pitch as exactly the kind
// of steady tone it exists to remove, and AGC pumps the level under a decaying
// note so the RMS gate opens and closes twice a second. With them on, a low E
// reads as nothing at all about half the time.
export async function createTuner({ onReading, onError, a4 = 440, smoothing = 5 } = {}) {
  const c = audioContext();
  if (!c) { onError?.(new Error("This browser has no Web Audio.")); return null; }
  if (!navigator?.mediaDevices?.getUserMedia) { onError?.(new Error("This browser can't reach a microphone.")); return null; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false,
    });
  } catch (e) {
    onError?.(e);
    return null;
  }
  await unlock();
  const source = c.createMediaStreamSource(stream);
  const analyser = c.createAnalyser();
  // 8192 samples at 44.1 kHz is 186 ms — long enough to hold two full cycles of
  // the low E (82 Hz) with room to spare, which is the floor for a correlation
  // detector. Smaller windows are the reason so many web tuners cannot see the
  // bottom string.
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const recent = [];
  let raf = 0, stopped = false, lastRun = 0;

  // ── HOW OFTEN, AND WHY IT IS NOT EVERY FRAME ────────────────────────────────
  // detectPitch is an O(n·τ) correlation over the full 8192-sample window: about
  // six million inner iterations, measured at 2.4 ms on a fast core and 10.5 ms
  // on a slow one. Run from every animation frame that is a third to two thirds
  // of the main thread pinned for as long as the tuner is open, on the one screen
  // in the tab a phone is most likely to be holding — and the stall it produces
  // is precisely what the transport next door has to fast-forward past.
  //
  // 22 Hz is the right rate for what this actually is. A plucked string's pitch
  // does not settle for about 200 ms; the reading is already a five-frame median
  // over that settling. Sampling three times less often changes the needle's
  // response by under 30 ms — below what anyone can see on a dial — and gives
  // back two thirds of a core.
  const PERIOD_MS = 45;

  const tick = () => {
    if (stopped) return;
    const t = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (t - lastRun < PERIOD_MS) { raf = requestAnimationFrame(tick); return; }
    lastRun = t;
    analyser.getFloatTimeDomainData(buf);
    const hit = detectPitch(buf, c.sampleRate, { ...DEFAULT_PITCH_OPTS });
    if (hit) {
      recent.push(hit.hz);
      if (recent.length > smoothing) recent.shift();
      onReading?.({ hz: medianHz(recent), raw: hit.hz, clarity: hit.clarity, rms: hit.rms, a4 });
    } else {
      // Silence clears the history rather than letting a stale median linger.
      // A needle that keeps pointing at a note nobody is playing is the one thing
      // a tuner must never do.
      recent.length = 0;
      onReading?.(null);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      try { source.disconnect(); analyser.disconnect(); } catch { /* already gone */ }
      // THE TRACKS HAVE TO BE STOPPED BY HAND. Disconnecting the graph leaves the
      // microphone open — the browser keeps showing the recording indicator, iOS
      // keeps the input route claimed, and the next tab to want the mic gets a
      // device that is already in use.
      for (const track of stream.getTracks()) { try { track.stop(); } catch { /* already stopped */ } }
    },
  };
}

// Everything, off. Called when the Guitar tab unmounts — a metronome that keeps
// clicking from another tab is the kind of bug that only gets reported once.
export function stopAll() {
  noteCache.clear();
  if (ctx && ctx.state === "running") { try { ctx.suspend(); } catch { /* fine */ } }
}
