// ─── The tuner ───────────────────────────────────────────────────────────────
// The most-used screen in the tab, and the one with the strictest honesty rule:
// A NEEDLE IS A CLAIM THAT SOMETHING WAS MEASURED. Over silence it shows
// nothing — not a centred needle, not the last note, not a hopeful zero. The
// three states are "listening", "here is what I hear", and "I can't hear you",
// and the first and the third look different from each other on purpose.
//
// The reading itself comes from lib/guitar/dsp.js, which is pure and tested
// against synthesised tones to a hundredth of a cent. What is here is the
// picture, the string picker, and the permission story.

import { useEffect, useRef, useState } from "react";
import { Sheet, Button, PillRow, EmptyState, Spinner } from "../../ui/kit.jsx";

import { TUNINGS, tuningByKey, stringLabels, nearestString } from "../../lib/guitar/fretboard.js";
import { nearestNote } from "../../lib/guitar/theory.js";
import { createTuner, playNote, unlock } from "../../lib/guitar/audio.js";

// ±5 cents is the band inside which a guitar is in tune by any standard anyone
// uses. Below 3 the reading is fighting the instrument's own intonation.
const IN_TUNE_CENTS = 5;

function Needle({ cents, note, hz, target }) {
  // The dial is ±50 cents — half a semitone each way, which is the whole space
  // between one note and the next. Clamped so a wild reading pins rather than
  // running off the card.
  const c = Math.max(-50, Math.min(50, cents ?? 0));
  const inTune = Math.abs(cents ?? 99) <= IN_TUNE_CENTS;
  const tone = inTune ? "var(--green)" : Math.abs(c) < 18 ? "var(--amber)" : "var(--red)";
  const W = 320, H = 120, cx = W / 2;
  const px = cx + (c / 50) * (W / 2 - 26);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: 420, margin: "0 auto" }}
      role="img" aria-label={note ? `${note}, ${Math.round(cents)} cents` : "no reading"}>
      {/* the track */}
      <line x1={22} y1={64} x2={W - 22} y2={64} stroke="var(--line)" strokeWidth={2} strokeLinecap="round" />
      {/* the in-tune window, drawn so "close enough" is a place and not a number */}
      <rect x={cx - (IN_TUNE_CENTS / 50) * (W / 2 - 26)} y={52} width={(IN_TUNE_CENTS / 25) * (W / 2 - 26)} height={24}
        rx={6} fill="var(--green)" opacity={inTune ? 0.22 : 0.1} />
      {[-50, -25, 0, 25, 50].map((t) => (
        <line key={t} x1={cx + (t / 50) * (W / 2 - 26)} y1={t === 0 ? 46 : 56}
          x2={cx + (t / 50) * (W / 2 - 26)} y2={t === 0 ? 82 : 72}
          stroke={t === 0 ? "var(--sub)" : "var(--line-strong)"} strokeWidth={t === 0 ? 2 : 1.2} strokeLinecap="round" />
      ))}
      {note != null && (
        <>
          <circle cx={px} cy={64} r={11} fill={tone} />
          <text x={cx} y={30} textAnchor="middle" fontSize={30} fontWeight={700} fill="var(--ink)">{note}</text>
          <text x={cx} y={104} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--sub)"
            style={{ fontFamily: "var(--font-mono)" }}>
            {`${cents > 0 ? "+" : ""}${Math.round(cents)}¢`}
            {hz ? ` · ${hz.toFixed(1)} Hz` : ""}
            {target ? ` · target ${target.toFixed(1)}` : ""}
          </text>
        </>
      )}
      {note == null && (
        <text x={cx} y={38} textAnchor="middle" fontSize={15} fontWeight={600} fill="var(--faint)">
          Play a string
        </text>
      )}
    </svg>
  );
}

export function TunerSheet({ onClose, settings, updateSetting, isMobile }) {
  const gs = settings?.guitar || {};
  const [tuningKey, setTuningKey] = useState(gs.tuning || "standard");
  const [a4] = useState(Number(gs.a4) > 0 ? Number(gs.a4) : 440);
  const tuning = tuningByKey(tuningKey).midi;
  const capo = Number(gs.capo) || 0;

  const [state, setState] = useState({ status: "idle" }); // idle | asking | live | denied | unsupported
  const [reading, setReading] = useState(null);
  const tunerRef = useRef(null);
  // The reading arrives on every animation frame; React state at 60 Hz is fine
  // for one number but the last-seen string is kept in a ref so the "which
  // string is settled" ticks don't re-render the whole sheet.
  const settled = useRef({});
  const [settledTick, setSettledTick] = useState(0);
  // Alive until the sheet unmounts. `createTuner` awaits getUserMedia, and the
  // permission prompt can sit on screen for as long as the user leaves it there
  // — long enough to close the sheet first. The old code assigned to tunerRef
  // AFTER that await, so the assignment landed on a component that no longer
  // existed and the unmount cleanup had already run against an empty ref: a live
  // MediaStream, an AnalyserNode and an rAF loop, all unreachable, all running
  // until the tab closed, with the browser's recording dot on the whole time.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The reading handler is built once and never rebuilt (createTuner takes it at
  // construction), so it must not close over tuning/capo/a4 from the render it
  // happened to be created in — change the tuning to Drop D mid-session and the
  // strings would be measured against standard forever, quietly never going
  // green. The ref is refreshed on every render, so the handler always reads
  // today's values.
  const cfg = useRef({ tuning, capo, a4 });
  cfg.current = { tuning, capo, a4 };

  const start = async () => {
    if (tunerRef.current) return;
    setState({ status: "asking" });
    const t = await createTuner({
      a4,
      onReading: (r) => {
        setReading(r);
        if (!r) return;
        const s = nearestString(r.hz, cfg.current);
        if (s && Math.abs(s.cents) <= IN_TUNE_CENTS) {
          if (!settled.current[s.string]) { settled.current = { ...settled.current, [s.string]: Date.now() }; setSettledTick((n) => n + 1); }
        }
      },
      onError: (e) => setState({ status: /denied|NotAllowed/i.test(e?.name || e?.message || "") ? "denied" : "unsupported", message: e?.message }),
    });
    if (!t) return;
    // Closed while the prompt was up: shut the microphone down instead of
    // storing it, and do not touch state on a dead component.
    if (!alive.current) { t.stop(); return; }
    tunerRef.current = t;
    setState({ status: "live" });
  };

  // The microphone is released the moment this sheet goes away. Without it the
  // browser keeps showing the recording indicator and iOS keeps the input route
  // claimed for the rest of the session.
  useEffect(() => () => { tunerRef.current?.stop(); tunerRef.current = null; }, []);

  const note = reading ? nearestNote(reading.hz, a4) : null;
  const str = reading ? nearestString(reading.hz, { tuning, capo, a4 }) : null;
  // Spelled the way the tuning is written down — a half-step-down guitar is in
  // E♭, never in D♯, and the row carries which.
  const labels = stringLabels(tuning, { capo, flats: !!tuningByKey(tuningKey).flats });

  const saveTuning = (key) => {
    setTuningKey(key);
    settled.current = {};
    setSettledTick((n) => n + 1);
    if (settings != null) updateSetting?.("guitar", { ...gs, tuning: key });
  };

  return (
    <Sheet title="Tuner" onClose={onClose} detent={isMobile ? "medium" : "auto"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 6 }}>
        {state.status === "live" ? (
          <>
            <Needle
              cents={str ? str.cents : note?.cents}
              note={str ? str.name.replace(/\d$/, "") : note?.name.replace(/\d$/, "")}
              hz={reading?.hz}
              target={str ? str.target : null} />
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${labels.length}, minmax(0,1fr))`, gap: 6 }}>
              {labels.map((l) => {
                const active = str?.string === l.string;
                const ok = settled.current[l.string];
                return (
                  <button key={l.string} type="button"
                    onClick={async () => { await unlock(); playNote(l.midi, { gain: 0.65 }); }}
                    aria-label={`Play the ${l.note} string`}
                    style={{
                      border: "none", cursor: "pointer", borderRadius: "var(--r-well)", padding: "10px 2px",
                      background: active ? "var(--accent-a16)" : ok ? "var(--green-a06)" : "var(--surface-2)",
                      color: active ? "var(--accent)" : ok ? "var(--green)" : "var(--sub)",
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minHeight: 52,
                    }}>
                    <span className="t-head" style={{ fontSize: 16, color: "inherit" }}>{l.note}</span>
                    <span className="t-cap" style={{ color: "var(--faint)", fontSize: 10.5 }}>{l.number}</span>
                  </button>
                );
              })}
            </div>
            <div className="t-cap" style={{ color: "var(--faint)", textAlign: "center" }}>
              {settledTick >= 0 && Object.keys(settled.current).length === labels.length
                ? "All six settled. Check them again after the first chord — new strings move."
                : "Tap a string to hear it. Green means within 5 cents."}
            </div>
          </>
        ) : state.status === "asking" ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "36px 0" }}><Spinner size={22} /></div>
        ) : state.status === "denied" ? (
          <EmptyState icon="🎤" title="Microphone blocked"
            sub="The tuner needs to hear the guitar. Allow the microphone for this site in your browser's settings, then reopen this sheet. Nothing is recorded or sent anywhere — the pitch is worked out on this device and thrown away."
            action={<Button kind="tinted" onClick={start}>Try again</Button>} />
        ) : state.status === "unsupported" ? (
          <EmptyState icon="🎤" title="No microphone here"
            sub={state.message || "This browser won't give the page a microphone. The reference tones below still work — tune by ear against them."}
            action={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                {labels.map((l) => (
                  <Button key={l.string} kind="quiet" size="sm" onClick={async () => { await unlock(); playNote(l.midi, { gain: 0.65 }); }}>{l.note}</Button>
                ))}
              </div>
            } />
        ) : (
          <EmptyState icon="🎸" title="Ready when you are"
            sub="Turn on the microphone and play one string at a time. The reading is worked out here on the device — no audio leaves it, and nothing is stored."
            action={<Button kind="primary" size="lg" onClick={start}>Turn on the microphone</Button>} />
        )}

        <div>
          <div className="t-label" style={{ color: "var(--sub)", marginBottom: 6 }}>Tuning</div>
          <PillRow options={TUNINGS} value={tuningKey} onChange={saveTuning}
            fmt={(t) => t.name} keyOf={(t) => t.key} label="Tuning" />
          <div className="t-foot" style={{ color: "var(--faint)", marginTop: 8, fontFamily: "var(--font-mono)" }}>
            {tuningByKey(tuningKey).short}
            {capo ? ` · capo ${capo}` : ""}
            {a4 !== 440 ? ` · A4 = ${a4} Hz` : ""}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

export default TunerSheet;
