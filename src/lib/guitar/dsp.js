// ─── DSP — the sound, as arithmetic ──────────────────────────────────────────
// PURE. Not one Web Audio object is constructed in this file; `audio.js` next
// door owns the AudioContext and does nothing but hand these functions a sample
// rate and play what comes back.
//
// THAT SPLIT IS THE WHOLE POINT. A tuner and a metronome are the two features in
// this tab whose failure is silent — a pitch detector that is an octave out still
// draws a confident needle, and a metronome that drifts is a metronome you
// practise to for six weeks before noticing. Neither can be tested through a
// browser API that does not exist in Node. So everything that decides a NUMBER
// lives here, where scripts/guitar-smoke.mjs synthesises a signal, runs the
// detector over it, and asserts the answer is within a few cents of the note it
// generated. The browser half is left with nothing to be wrong about but wiring.

// ─── pitch detection (McLeod / NSDF) ─────────────────────────────────────────
// WHY NOT PLAIN AUTOCORRELATION. Raw autocorrelation's peak height falls away
// with lag, so a signal with strong harmonics — which is to say a guitar string —
// reliably scores the half-period peak higher than the true one, and the tuner
// reports the octave above. Detuning by an octave is not a small error on an
// instrument where the whole job is telling E2 from E3.
//
// The normalised square difference function divides out that decay:
//
//     nsdf(τ) = 2·Σ x[i]·x[i+τ]  /  Σ (x[i]² + x[i+τ]²)
//
// which is bounded to [−1, 1] with 1 = perfect periodicity at that lag, flat
// across lags. The period is then the FIRST key maximum that clears a fraction of
// the global one — first, not highest, because octave errors show up as a second
// peak that is very slightly taller, and preferring the earlier peak at 90% of the
// tallest is exactly the rule that refuses them.

// Parabolic interpolation through three samples around a peak. Without it the
// resolution of the whole detector is one sample of lag, which at 44.1 kHz and
// 82 Hz (the low E) is about 19 cents — three times the error a tuner is allowed
// to have. With it, well under one cent.
function refinePeak(nsdf, i) {
  const y0 = nsdf[i - 1], y1 = nsdf[i], y2 = nsdf[i + 1];
  const denom = 2 * (2 * y1 - y0 - y2);
  if (!Number.isFinite(denom) || denom === 0) return { tau: i, value: y1 };
  const delta = (y2 - y0) / denom;
  // A correction of more than half a sample means the three points are not a peak
  // — keep the integer lag rather than inventing precision from a bad fit.
  if (!Number.isFinite(delta) || Math.abs(delta) > 1) return { tau: i, value: y1 };
  return { tau: i + delta, value: y1 - 0.25 * (y0 - y2) * delta };
}

// ─── how much of the signal is actually AT the frequency we think it is ─────
// A Goertzel: one DFT bin, computed in a single pass without an FFT, normalised
// so a pure sine at `f` scores 1 and a signal with nothing there scores ~0.
//
// THIS IS THE POLYPHONY GATE, and the tuner is unsafe without it. A correlation
// detector answers "what period does this waveform repeat at", which is not the
// same question as "what note is this". Strike the B and high E together — the
// two closest-spaced strings on the guitar and what a clumsy pick stroke does
// every day — and you get 247 Hz and 330 Hz, the 3rd and 4th harmonics of 82.4.
// The sum genuinely IS periodic at 82.4 Hz, so the NSDF finds that period as the
// first key maximum AND the tallest, and reports the low E at clarity 1.00 while
// the low E is not being touched. TunerSheet then ticks it permanently green.
// The octave rule cannot help: 82.4 is not an octave error, it is the right
// answer to the wrong question.
//
// What separates the two cases is that a real plucked string puts energy at its
// own fundamental and a phantom one does not. Measured over the whole neck at
// both sample rates, through mic roll-off down to a 150 Hz highpass, at
// amplitudes down to the RMS gate and with noise added: 122 of 122 phantom
// readings score under 0.003, and 1461 of 1470 correct ones score above 0.006.
// The nine that do not are single frames, and a single dropped frame costs the
// needle one update — where the alternative is a green tick on a string nobody
// is playing.
export function bandEnergy(buf, freq, sampleRate) {
  const n = buf?.length || 0;
  if (!n || !(freq > 0) || !(sampleRate > 0) || freq * 2 >= sampleRate) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += buf[i];
  mean /= n;
  const k = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = buf[i] - mean + k * s1 - s2; s2 = s1; s1 = s0; }
  const mag = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (n / 2);
  let sq = 0;
  for (let i = 0; i < n; i++) { const v = buf[i] - mean; sq += v * v; }
  const rms = Math.sqrt(sq / n);
  return rms > 0 ? mag / (rms * Math.SQRT2) : 0;
}

export const DEFAULT_PITCH_OPTS = {
  minHz: 60,      // below the low E in every tuning this app ships (Drop C is 65.4)
  maxHz: 1400,    // above the 24th fret of the high E (E6 = 1318.5)
  clarity: 0.9,   // the "first peak within 90% of the tallest" rule above
  threshold: 0.5, // a peak below this is noise, not a note
  minRms: 0.008,  // a room with a guitar in it, not a room
  // The share of the signal that has to be at the reported pitch for it to count
  // as a note rather than a period two other notes happen to share. See
  // bandEnergy above for where 0.006 comes from. Set it to 0 to get the raw
  // periodicity answer — the smoke test does, to prove the gate is what changed.
  minFundamental: 0.006,
};

// A window of samples → { hz, clarity, rms } or null. Null means "I cannot tell",
// which is a real answer and the only honest one for a silent room; a tuner that
// prints a note over silence is a tuner nobody can trust when it matters.
export function detectPitch(buf, sampleRate, opts = {}) {
  const o = { ...DEFAULT_PITCH_OPTS, ...opts };
  // Total in its argument: a caller with nothing to analyse gets "I cannot tell"
  // rather than a TypeError. The tuner's read loop runs on every animation frame
  // and one throw there takes the whole sheet down mid-tune.
  if (!buf || typeof buf.length !== "number") return null;
  const n = buf.length;
  if (!n || !(sampleRate > 0)) return null;

  // DC FIRST, AND IT IS NOT HOUSEKEEPING. The NSDF's sign is what separates one
  // periodic region from the next — the peak scan below walks forward until the
  // function goes NEGATIVE — and a signal riding on a constant offset never does.
  // It correlates positively with itself at every lag, the whole lag range reads
  // as one enormous lobe around zero, no key maxima are found at all, and the
  // detector returns "I cannot tell" over a perfectly clear note. Every real
  // microphone has some offset, and so does a Karplus–Strong string (the
  // averaging filter in its loop passes DC at unity gain, so whatever the
  // excitation started with never leaves). Subtracting the window's own mean
  // costs one pass and removes the entire failure mode.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i];
  const mean = sum / n;
  let sumsq = 0;
  for (let i = 0; i < n; i++) { const v = buf[i] - mean; sumsq += v * v; }
  const rms = Math.sqrt(sumsq / n);
  if (rms < o.minRms) return null;

  const minTau = Math.max(2, Math.floor(sampleRate / o.maxHz));
  // A LAG NEEDS ENOUGH OVERLAP TO MEAN ANYTHING, and n − 1 is not it. The NSDF at
  // lag τ correlates n − τ samples, so a lag near the window's own length is
  // computed from a handful of them and is dominated by whatever noise happens to
  // line up: handed 1024 samples of a low E — a note whose period is 535 of them —
  // the detector found a spurious peak and reported 75.7 Hz, a confident answer a
  // semitone and a half flat. Two and a half periods is the floor; below that the
  // honest answer is that the window is too short, and the range check at the
  // bottom turns "no peak I can trust" into null rather than into a guess. The
  // tuner's own window is 8192 samples, so this never binds there — it binds on
  // any other caller, which is exactly who it is for.
  const maxTau = Math.min(Math.floor(n / 2.5), Math.ceil(sampleRate / o.minHz));
  if (maxTau <= minTau) return null;

  // NSDF over the lag range, O(n·τ). An FFT-based autocorrelation is
  // asymptotically faster; this one is a straight transcription of the
  // definition, which is why it can be checked by reading it.
  //
  // WHAT IT COSTS, MEASURED, because the previous note here guessed and guessed
  // low: on the tuner's own 8192-sample window this is ~6M inner iterations and
  // 2.4–11 ms depending on the core. Run from every animation frame — which is
  // what the tuner used to do — that is a third to two thirds of the main thread
  // pinned for as long as the screen is open. audio.js's createTuner therefore
  // calls it at 22 Hz, not 60; see the note there for why that costs the needle
  // nothing. The RMS gate above returns before this loop, so a silent room is
  // free either way.
  //
  // FROM LAG 1, NOT FROM minTau, AND THAT COST A REAL BUG. The peak scan below
  // has to step over the lobe around lag 0 (every signal correlates with itself
  // at a lag of nothing) by walking until the function first goes negative.
  // Starting the array at minTau meant that walk began INSIDE the first true
  // peak whenever the note was high — the top string above the twelfth fret —
  // so the first peak was skipped as though it were the lag-0 lobe and the
  // detector reported the octave below. The range check on the ANSWER at the
  // bottom is what keeps notes above maxHz out; the lag range never was.
  const nsdf = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let acf = 0, m = 0;
    const lim = n - tau;
    for (let i = 0; i < lim; i++) {
      const a = buf[i] - mean, b = buf[i + tau] - mean;
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // Key maxima: the highest point of each positive-going region. This is the
  // McLeod definition, and it is what makes "the first one that clears the bar"
  // well-defined — a plain local-maximum scan finds ripple.
  const peaks = [];
  let tau = 1;
  while (tau < maxTau && nsdf[tau] > 0) tau++;   // skip the lobe around lag 0
  while (tau < maxTau) {
    if (nsdf[tau] > 0) {
      let best = tau;
      while (tau < maxTau && nsdf[tau] > 0) { if (nsdf[tau] > nsdf[best]) best = tau; tau++; }
      if (best > 1 && best < maxTau) peaks.push(best);
    } else tau++;
  }
  if (!peaks.length) return null;

  let highest = peaks[0];
  for (const p of peaks) if (nsdf[p] > nsdf[highest]) highest = p;
  if (nsdf[highest] < o.threshold) return null;

  // THE OCTAVE RULE, in one line: take the FIRST peak that reaches `clarity` of
  // the tallest, not the tallest itself.
  const bar = nsdf[highest] * o.clarity;
  const chosen = peaks.find((p) => nsdf[p] >= bar) ?? highest;

  const { tau: refined, value } = refinePeak(nsdf, chosen);
  if (!(refined > 0)) return null;
  const hz = sampleRate / refined;
  // The floor is whichever is HIGHER: the caller's minHz, or the lowest pitch a
  // window this short can actually resolve. Below 2.5 periods the NSDF's longest
  // lags are computed from a handful of sample pairs and hit ±1 on noise — 256
  // samples of a low E produced a confident F3 that is not in the signal at all.
  // maxTau already caps the lag; this is the same fact stated about the ANSWER,
  // which is where it has to be stated to be a refusal rather than a guess.
  const floorHz = Math.max(o.minHz, sampleRate / maxTau);
  if (!(hz >= floorHz && hz <= o.maxHz)) return null;
  // Two strings at once, or a period nothing is actually sounding at. See
  // bandEnergy. Null, not a wrong note: the tuner draws "Play a string".
  const fundamental = o.minFundamental > 0 ? bandEnergy(buf, hz, sampleRate) : 1;
  if (fundamental < o.minFundamental) return null;
  return { hz, clarity: Math.max(-1, Math.min(1, value)), rms, fundamental };
}

// A short median over recent readings. A plucked string's pitch wanders for the
// first ~200 ms (the fundamental settles as the initial transient decays), so a
// needle driven straight off detectPitch dances even on a perfectly tuned string.
// Median rather than mean, deliberately: one bad frame in five is common when a
// neighbouring string rings, and a mean lets that frame pull the reading while a
// median simply ignores it.
export function medianHz(readings) {
  const xs = (readings || []).filter((h) => Number.isFinite(h) && h > 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// ─── Karplus–Strong: a plucked string, from noise and a delay line ───────────
// A burst of noise into a delay line one period long, fed back through a
// two-point average, is a plucked string. It is four lines of arithmetic and it
// sounds like a guitar, which is the entire reason this app can play you a chord
// without shipping a single audio file or asking anyone's permission.
//
// The output is a plain Float32Array. audio.js copies it into an AudioBuffer and
// plays it — which means the synthesis is testable in Node, and what the browser
// does with the result cannot change what it sounds like.
export function pluck(freq, seconds, sampleRate, opts = {}) {
  // SUSTAIN IS IN SECONDS, NOT IN FEEDBACK GAIN, because the loop goes round once
  // per PERIOD and a fixed per-period factor therefore means a completely
  // different note length at each pitch. The textbook 0.996 rings for six seconds
  // on the low E and dies in under one at the top of the neck, which made a
  // strummed chord lose its treble before the bass had finished arriving.
  // `sustain` is the time to −60 dB and the factor is solved from it.
  const { damping = 0.5, gain = 0.5, seed = 1, sustain = 3.2 } = opts;
  const len = Math.max(1, Math.floor(seconds * sampleRate));
  const out = new Float32Array(len);
  if (!(freq > 0) || !(sampleRate > 0) || freq * 3 >= sampleRate) return out;
  const perPeriod = opts.decay ?? Math.pow(0.001, 1 / Math.max(1, freq * sustain));

  // ── the loop ───────────────────────────────────────────────────────────────
  // A Karplus–Strong string is a delay line one period long fed back through a
  // lowpass. Everything below is about the two things that go wrong with the
  // textbook version, and both of them are audible.
  //
  // 1 · THE DELAY MUST BE FRACTIONAL, AND IT MUST NOT COST AMPLITUDE.
  //     Rounding the loop to whole samples puts the string at sr/round(sr/f) —
  //     8 cents sharp on the A below middle C, 21 cents at the top of the neck.
  //     A reference tone a fifth of a semitone out teaches the ear a wrong pitch
  //     and disagrees with the tuner in the same app. Interpolating between two
  //     taps fixes the pitch and introduces a NEW problem: linear interpolation
  //     is itself a lowpass, it sits inside the feedback path, and at 1300 Hz it
  //     alone kills the note in half a second no matter what sustain asks for.
  //     A first-order ALLPASS has magnitude exactly 1 at every frequency and
  //     delays by a tuneable fraction of a sample, which is precisely the thing
  //     wanted: pitch without loss.
  //
  // 2 · THE FILTERS' DELAY IS PART OF THE PERIOD. The lowpass and the allpass
  //     each contribute their own, so the delay LINE carries the remainder. Both
  //     are computed exactly at the fundamental rather than approximated, which
  //     is what makes the pitch right to a hundredth of a cent instead of a few.
  //
  // And one thing that follows from getting those right: the loop's gain at DC
  // is now `fb`, same as everywhere else, so a trapped offset decays with the
  // note. With linear interpolation it did not — the interpolator forced the
  // feedback to be clamped near unity to keep any sustain at all, DC has unity
  // gain through every lowpass ever written, and the "string" ended up as a
  // constant 0.014 offset that outlived the sound and ate 6% of the headroom of
  // every chord it was strummed into.
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const c = Math.cos(w0), sn = Math.sin(w0);
  const k = 1 - c;
  // The lowpass is (1−b) + b·z⁻¹; its gain at w0, squared, is 1 − 2k·b(1−b).
  // Take the largest b ≤ ½ (darkest, most string-like) whose gain still clears
  // what the sustain needs — b = ½ is the classic average, and the top strings
  // open it up only as far as they must, which is also why they ring bright.
  let b = 0.5;
  if (k > 1e-9) {
    const T = (1 - perPeriod * perPeriod) / (2 * k);
    b = T >= 0.25 ? 0.5 : (1 - Math.sqrt(Math.max(0, 1 - 4 * T))) / 2;
  }
  const lpGain = Math.sqrt(Math.max(1e-12, 1 - 2 * k * b * (1 - b)));
  // The lowpass's exact phase delay at the fundamental, in samples.
  const lpDelay = Math.abs(w0) > 1e-9 ? Math.atan2(b * sn, (1 - b) + b * c) / w0 : b;

  const D = sampleRate / freq;
  // Leave the allpass a fraction in [0.5, 1.5) — where a first-order section
  // tracks its target delay closely — and give the rest to the delay line.
  const N = Math.max(1, Math.floor(D - lpDelay - 0.5));
  const apDelay = D - lpDelay - N;
  // The classic tuning for a first-order allpass (a + z⁻¹)/(1 + a·z⁻¹) to have
  // phase delay `d` at ω. Exact at the fundamental; |a| < 1, so it is stable.
  const denom = Math.sin((w0 * (1 + apDelay)) / 2);
  const a = Math.abs(denom) > 1e-12 ? Math.sin((w0 * (1 - apDelay)) / 2) / denom : 0;
  // Clamped strictly below 1: a feedback loop at unity gain never stops, and one
  // above it is an oscillator that clips the buffer and then the speakers.
  const fb = Math.min(0.9999, perPeriod / Math.max(1e-6, lpGain));

  // ── the excitation ────────────────────────────────────────────────────────
  const buf = new Float32Array(N);
  // A SEEDED generator, not Math.random. Two plucks of the same note must sound
  // the same, an offline render must equal the one before it, and a smoke test
  // cannot assert anything at all about a signal that is different every run.
  let st = seed >>> 0 || 1;
  const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >> 17; st ^= st << 5; st >>>= 0; return (st / 4294967296) * 2 - 1; };
  for (let i = 0; i < N; i++) buf[i] = rnd();
  // Zero-mean: a string has no DC, and a burst of fifty random numbers does.
  let dc = 0;
  for (let i = 0; i < N; i++) dc += buf[i];
  dc /= N;
  for (let i = 0; i < N; i++) buf[i] -= dc;
  // One pass of averaging over the excitation takes the top off the initial
  // transient — the difference between "plucked" and "snapped with a coin".
  if (N > 1) {
    const first = buf[0];
    for (let i = 0; i < N - 1; i++) buf[i] = buf[i] * (1 - damping) + buf[i + 1] * damping;
    buf[N - 1] = buf[N - 1] * (1 - damping) + first * damping;
  }

  let w = 0, lpPrev = 0, apPrevIn = 0, apPrevOut = 0;
  for (let i = 0; i < len; i++) {
    const d = buf[w];                                  // the sample N steps ago
    const lp = (1 - b) * d + b * lpPrev;               // string damping
    lpPrev = d;
    const ap = a * lp + apPrevIn - a * apPrevOut;      // the fractional delay
    apPrevIn = lp; apPrevOut = ap;
    const y = ap * fb;
    out[i] = y * gain;
    buf[w] = y;
    w = w + 1 === N ? 0 : w + 1;
  }
  // A hard stop at the end of the buffer is a click. Twelve milliseconds of
  // fade-out is inaudible as a fade and completely removes it.
  const fade = Math.min(len, Math.floor(sampleRate * 0.012));
  for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade;
  return out;
}

// A strum is six plucks, offset. `spread` is the time between adjacent strings —
// about 18 ms down, a little tighter up, which is what makes a downstroke sound
// like an arm rather than a chord button. Muted strings are simply absent.
export function strum(freqs, sampleRate, opts = {}) {
  const { seconds = 2.2, spread = 0.018, up = false, gain = 0.42, damping = 0.5, sustain = 3.2 } = opts;
  const notes = (freqs || []).filter((f) => Number.isFinite(f) && f > 0);
  if (!notes.length) return new Float32Array(1);
  const order = up ? [...notes].reverse() : notes;
  const total = Math.floor((seconds + spread * order.length) * sampleRate);
  const out = new Float32Array(Math.max(1, total));
  order.forEach((f, i) => {
    // A seed per string, so the six voices are decorrelated (six copies of one
    // noise burst sum into a comb filter, not a chord) while staying repeatable.
    const v = pluck(f, seconds, sampleRate, { gain, damping, sustain, seed: 1013904223 + i * 2654435761 });
    const at = Math.floor(i * spread * sampleRate);
    for (let j = 0; j < v.length && at + j < out.length; j++) out[at + j] += v[j];
  });
  return normalize(out);
}

// A click, as a decaying sine with a very short attack. Two pitches: the accent
// on beat one and the plain click everywhere else. Short — 40 ms — because the
// tail of a metronome click is what makes fast tempi turn to mush.
export function click(freq, sampleRate, { seconds = 0.04, gain = 0.5 } = {}) {
  const len = Math.max(1, Math.floor(seconds * sampleRate));
  const out = new Float32Array(len);
  const attack = Math.max(1, Math.floor(sampleRate * 0.001));
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const env = (i < attack ? i / attack : 1) * Math.exp(-t * 55);
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * gain;
  }
  return out;
}

// A steady reference tone for ear training and for tuning by ear against a drone.
// Three harmonics, because a pure sine is genuinely hard to match a string to.
export function drone(freq, seconds, sampleRate, { gain = 0.25, fade = true } = {}) {
  const len = Math.max(1, Math.floor(seconds * sampleRate));
  const out = new Float32Array(len);
  if (!(freq > 0) || !(sampleRate > 0)) return out;
  // `ramp` of zero would make the envelope 0/0 = NaN, and NaN written into an
  // AudioBuffer is silence you cannot debug. A one-sample buffer has no room for
  // a fade, so it gets none.
  const ramp = Math.max(1, Math.min(Math.floor(len / 2), Math.floor(sampleRate * 0.05)));
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const v = Math.sin(2 * Math.PI * freq * t)
      + 0.32 * Math.sin(4 * Math.PI * freq * t)
      + 0.12 * Math.sin(6 * Math.PI * freq * t);
    const env = fade ? Math.min(1, i / ramp, (len - i) / ramp) : 1;
    out[i] = v * gain * env;
  }
  return out;
}

// A drone buffer meant to be LOOPED, and the whole difference is that its length
// is a whole number of periods.
//
// The 30-second buffer this replaced looped from 0.2 s to 29.8 s. That span is
// not a whole number of cycles of any tonic the ear drill uses, so the last
// sample before the seam and the first sample after it were at unrelated points
// in the waveform: a full-scale step, which is a click, once every 29.6 seconds
// for as long as the drone played. Putting the seam in steady-state material
// (which is what the old code did) moves the click out of the fade; it does not
// make the seam continuous. Only period alignment does.
//
// It is also 90 kB instead of 5 MB, and 1 ms of synchronous render instead of
// 61 — the material repeats every period, so a 30-second copy of it was 30
// seconds of the same half-second.
export function droneLoop(freq, sampleRate, { gain = 0.25, minSeconds = 0.5 } = {}) {
  if (!(freq > 0) || !(sampleRate > 0)) return new Float32Array(1);
  // A BUFFER LENGTH HAS TO BE A WHOLE NUMBER OF SAMPLES AND WE WANT A WHOLE
  // NUMBER OF CYCLES, and in general no length is both. So search: over a
  // half-second of slack there is always a sample count that lands within a
  // hundredth of a cycle, and the residue is what is left at the seam.
  //
  // Rounding to the nearest sample instead — the obvious version — leaves up to
  // half a sample of phase error, which is 0.2% of a cycle at 82 Hz but 10% of
  // the third harmonic's cycle at 175 Hz. That is a step of a tenth of full
  // scale: quieter than the click it replaced, and still a click.
  const cyclesPerSample = freq / sampleRate;
  const minLen = Math.max(2, Math.floor(minSeconds * sampleRate));
  let len = minLen, best = Infinity;
  for (let n = minLen; n < minLen * 2; n++) {
    const frac = n * cyclesPerSample % 1;
    const err = Math.min(frac, 1 - frac);          // distance to a whole cycle
    if (err < best) { best = err; len = n; if (err < 1e-6) break; }
  }
  return drone(freq, len / sampleRate, sampleRate, { gain, fade: false });
}

// Peak-normalise, with headroom. Six plucked strings summed can clip, and a
// clipped chord in a learning tool teaches you the app is broken.
export function normalize(buf, peak = 0.89) {
  let max = 0;
  // NaN IS NOT A QUIET SAMPLE. `Math.abs(NaN) > max` is false, so a buffer with a
  // NaN in it used to sail through the "never clip" gate unchanged and reach an
  // AudioBuffer, where it is silence from that sample on with nothing logged.
  // Zeroing is the only recovery: there is no right value to guess, and a gap is
  // audible where an entire dead voice is not.
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (!Number.isFinite(v)) { buf[i] = 0; continue; }
    const a = Math.abs(v);
    if (a > max) max = a;
  }
  if (max <= peak || max === 0) return buf;
  const k = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] *= k;
  return buf;
}

// The window of beats that fall inside a scheduler's lookahead — schedule ahead
// of the audio clock in small slices, so setInterval jitter (tens of
// milliseconds, and worse on a backgrounded tab) never reaches the sound.
//
// EVERY TIME IN THIS APP IS COMPUTED FROM THE BEAT INDEX, NEVER ACCUMULATED.
// `t += 60/bpm` inside a loop is how metronomes drift: the error in one interval
// is nothing and the error after four hundred of them is audible, and it is
// worse in floating point at tempi whose period is not representable.
// `startTime + i * spb` has no accumulated error at all, by construction.
//
// Returned times are SECONDS ON THE AUDIO CLOCK, which is what a Web Audio
// scheduler needs and what makes this testable — the caller adds nothing.
// THIS IS THE SCHEDULER THE APP ACTUALLY RUNS. It used to be a second, prettier
// copy of one: createTransport carried its own inline loop with a different
// bound and different event fields, so every assertion here was about code
// nothing called — including "never emits a beat that has already sounded",
// which the live loop violated under any main-thread stall. Two implementations
// of one algorithm is one implementation and one lie about it.
//
// `beatsPerBar` and `countIn` are here because the transport's callers need the
// bar, the accent and the count-in flag, and a function that returns everything
// except those forces the caller to recompute them — which is how the two copies
// drifted apart in the first place.
export function beatsInWindow(state, { now, lookahead = 0.12, cap = 512 } = {}) {
  const { startTime = 0, bpm = 90, subdivision = 1, nextIndex = 0, beatsPerBar = 4, countIn = 0 } = state || {};
  if (!(bpm > 0) || !Number.isFinite(startTime) || !Number.isFinite(now)) return { beats: [], nextIndex, dropped: 0 };
  const sub = Math.max(1, Math.round(subdivision));
  const bar = Math.max(1, Math.round(beatsPerBar));
  const spb = 60 / bpm / sub;
  const beats = [];

  // ── NOTHING IN THE PAST IS EVER RETURNED ────────────────────────────────────
  // Web Audio plays a source scheduled at a time already gone IMMEDIATELY, so a
  // window that only asks "is this before the horizon" hands the clock every
  // beat it missed at one instant. A 300 ms main-thread stall — a lazy chunk
  // landing, a sheet mounting, a GC — is routine on a phone; five seconds
  // backgrounded came back as forty beats fired together, thirty-nine of them
  // late by up to 4.8 seconds. A bound on the loop does not help: it drops
  // nothing, so the burst just takes several ticks to arrive.
  //
  // The fix is a fast-forward, not a filter, so the cost is the same whether the
  // gap was 300 ms or an hour. Missed beats stay missed — they cannot be played,
  // and playing them late is worse than not playing them. `startTime` never
  // moves, so the grid, the bar count and the phase all survive the gap intact.
  let i = nextIndex;
  let dropped = 0;
  const elapsedIndex = (now - startTime) / spb;
  if (elapsedIndex > i) { const to = Math.ceil(elapsedIndex); dropped = to - i; i = to; }

  // A bound, not a while(true): a bpm/lookahead pair that would emit thousands of
  // events must not lock the main thread.
  const limit = i + cap;
  while (i < limit && startTime + i * spb < now + lookahead) {
    const beat = Math.floor(i / sub);
    const inBar = ((beat % bar) + bar) % bar;
    beats.push({
      time: startTime + i * spb, index: i, beat,
      bar: Math.floor(beat / bar), inBar, sub: i % sub,
      accent: inBar === 0 && i % sub === 0,
      onBeat: i % sub === 0,
      countIn: beat < countIn,
    });
    i++;
  }
  return { beats, nextIndex: i, dropped };
}

// The tempo trainer's one rule, stated once. Ramp the tempo every `everyBars`
// bars by `step`, stopping at `to`. Returns the bpm for a given bar, so a UI can
// print the whole ladder before you start rather than surprising you with it.
export function rampBpm({ from = 60, to = 120, step = 5, everyBars = 2 }, bar = 0) {
  if (!(from > 0) || !(step > 0) || !(everyBars > 0)) return from;
  const up = to >= from;
  const bpm = from + Math.floor(bar / everyBars) * step * (up ? 1 : -1);
  return up ? Math.min(to, bpm) : Math.max(to, bpm);
}
