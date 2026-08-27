// ─── The metronome ───────────────────────────────────────────────────────────
// Reachable from every sub-tab, because it is the cheapest objective feedback
// device that exists and the whole practice engine assumes it is available.
//
// It is an ERROR DETECTOR, not a speed tool, and the two extra modes here are
// the ones that make it one:
//
//  · TWO AND FOUR. The click on beats 2 and 4 instead of every beat. Twice as
//    hard, and the only version that teaches where the beat actually is — with a
//    click on every beat you can be substantially out and never know, because
//    there is always another one arriving to hide behind.
//  · DROP THE CLICK. Two bars on, two bars silent, repeat. Keep playing through
//    the silence; when it comes back you find out whether you were still there.
//    The transport keeps running through the muted bars, which is the point —
//    stopping it would lose the phase, and the phase is the whole measurement.
//
// The tempo comes from lib/guitar/audio.js's lookahead scheduler, which puts
// every click on the audio clock ahead of time. A metronome built on setInterval
// drifts audibly inside a minute and you will have practised to it for six weeks
// before you notice.

import { useEffect, useRef, useState } from "react";
import { Sheet, Button, Segmented, SwitchRow, CellGroup } from "../../ui/kit.jsx";
import { IcPlus } from "../../ui/icons.jsx";
import { createMetronome, unlock } from "../../lib/guitar/audio.js";
import { rampBpm } from "../../lib/guitar/dsp.js";

const SUBDIVISIONS = [
  { key: 1, label: "♩", sub: "Beats" },
  { key: 2, label: "♪", sub: "Eighths" },
  { key: 3, label: "⅗", sub: "Triplets" },
  { key: 4, label: "♬", sub: "16ths" },
];
const METERS = [2, 3, 4, 5, 6, 7];
const TAP_WINDOW = 6;

export function MetronomeSheet({ onClose, settings, updateSetting, isMobile, initialBpm = null }) {
  const gs = settings?.guitar || {};
  const [bpm, setBpm] = useState(initialBpm || Number(gs.bpm) || 90);
  const [meter, setMeter] = useState(Number(gs.meter) || 4);
  const [sub, setSub] = useState(Number(gs.sub) || 1);
  const [twoFour, setTwoFour] = useState(!!gs.twoFour);
  const [dropClick, setDropClick] = useState(false);
  const [running, setRunning] = useState(false);
  const [beat, setBeat] = useState(null);
  const [blocked, setBlocked] = useState(false);
  // The ramp: a target and a step, so the tempo trainer is the metronome rather
  // than a second screen that does the same thing with a different click.
  const [ramp, setRamp] = useState(null); // { to, step, everyBars }

  const mRef = useRef(null);
  const taps = useRef([]);
  // Where the ramp started, in bpm AND in bars. Both halves matter: switching the
  // ramp on at bar 40 must start it from the tempo and the bar it was switched on
  // at, not from bar zero — otherwise it jumps forty bars' worth of increments the
  // instant you flip the switch.
  const rampBase = useRef({ bpm, bar: 0 });
  // Read by the beat handler below so the CURRENT settings reach it without the
  // metronome being rebuilt — a rebuild would restart the phase, and the phase is
  // what the drop-the-click drill measures. Declared before the effect that reads
  // them so the order on the page matches the order they are needed in.
  const rampRef = useRef(ramp); rampRef.current = ramp;
  const dropRef = useRef(dropClick); dropRef.current = dropClick;

  // One metronome for the life of the sheet. Rebuilding it on every tempo change
  // would restart the phase — and the phase is what the drills measure.
  useEffect(() => {
    const m = createMetronome({
      bpm, beatsPerBar: meter, subdivision: sub,
      onBeat: (ev) => {
        setBeat(ev);
        // The ramp steps on the bar line, and only upward through whole bars, so
        // the tempo never changes in the middle of one.
        if (ev.onBeat && ev.inBar === 0 && rampRef.current) {
          const r = rampRef.current;
          const base = rampBase.current;
          const next = rampBpm({ from: base.bpm, to: r.to, step: r.step, everyBars: r.everyBars }, Math.max(0, ev.bar - base.bar));
          if (next !== m.bpm) { m.setBpm(next); setBpm(next); }
        }
        // Drop the click: two bars audible, two silent, forever.
        if (ev.onBeat && ev.inBar === 0 && dropRef.current) m.setMuted(Math.floor(ev.bar / 2) % 2 === 1);
      },
    });
    mRef.current = m;
    return () => { m.stop(); mRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { mRef.current?.setBpm(bpm); }, [bpm]);
  useEffect(() => { mRef.current?.setSubdivision(sub); }, [sub]);
  useEffect(() => {
    // 2-and-4 is a per-beat mask over the bar. In anything but 4/4 it means
    // "the back half of the bar", which is the same idea and still useful.
    mRef.current?.setPattern(twoFour ? Array.from({ length: meter }, (_, i) => (i % 2 === 1 ? 1 : 0)) : null);
  }, [twoFour, meter]);
  useEffect(() => { if (!dropClick) mRef.current?.setMuted(false); }, [dropClick]);

  const toggle = async () => {
    const m = mRef.current;
    if (!m) return;
    if (m.running) { m.stop(); setRunning(false); setBeat(null); return; }
    if (!(await unlock())) { setBlocked(true); return; }
    setBlocked(false);
    rampBase.current = { bpm, bar: 0 };
    const ok = await m.start();
    setRunning(!!ok);
  };

  // Tap tempo. Median of the recent intervals rather than the mean: one late tap
  // in six is normal and a mean lets it drag the whole reading.
  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current, now].filter((t) => now - t < 3000).slice(-TAP_WINDOW);
    if (taps.current.length < 2) return;
    const gaps = taps.current.slice(1).map((t, i) => t - taps.current[i]).sort((a, b) => a - b);
    const mid = gaps.length >> 1;
    const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    const next = Math.round(60000 / median);
    if (next >= 30 && next <= 260) setBpm(next);
  };

  const save = () => { if (settings != null) updateSetting?.("guitar", { ...gs, bpm, meter, sub, twoFour }); };
  useEffect(() => { const t = setTimeout(save, 900); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [bpm, meter, sub, twoFour]);

  const nudge = (d) => setBpm((b) => Math.max(30, Math.min(260, b + d)));

  return (
    <Sheet title="Metronome" onClose={onClose} detent={isMobile ? "large" : "auto"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 6 }}>
        {/* the number */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14 }}>
          <button type="button" className="icon-btn" aria-label="Slower" onClick={() => nudge(-1)}
            style={{ fontSize: 22, fontWeight: 600, width: 44, height: 44 }}>−</button>
          <div style={{ textAlign: "center", minWidth: 128 }}>
            <div className="t-num" style={{ fontSize: 54, lineHeight: 1, fontWeight: 700, color: running ? "var(--accent)" : "var(--ink)" }}>{bpm}</div>
            <div className="t-cap" style={{ color: "var(--faint)", marginTop: 2 }}>bpm</div>
          </div>
          <button type="button" className="icon-btn" aria-label="Faster" onClick={() => nudge(1)}
            style={{ width: 44, height: 44 }}><IcPlus /></button>
        </div>

        {/* the beat lights — the bar you are in, drawn */}
        <div style={{ display: "flex", gap: 6, justifyContent: "center", minHeight: 16 }}>
          {Array.from({ length: meter }, (_, i) => {
            const on = running && beat?.inBar === i;
            const silent = twoFour && i % 2 === 0;
            return (
              <span key={i} aria-hidden style={{
                width: i === 0 ? 14 : 10, height: i === 0 ? 14 : 10, borderRadius: 999,
                background: on ? "var(--accent)" : silent ? "transparent" : "var(--ink-a10)",
                boxShadow: silent && !on ? "inset 0 0 0 1.5px var(--ink-a10)" : "none",
                alignSelf: "center",
                transition: "background var(--dur-1) var(--ease-out)",
              }} />
            );
          })}
        </div>

        <input type="range" min={30} max={240} value={bpm} onChange={(e) => setBpm(Number(e.target.value))}
          aria-label="Tempo" style={{ width: "100%", accentColor: "var(--accent)" }} />

        <div style={{ display: "flex", gap: 8 }}>
          <Button kind={running ? "quiet" : "primary"} size="lg" style={{ flex: 2 }} onClick={toggle}>
            {running ? "Stop" : "Start"}
          </Button>
          <Button kind="tinted" size="lg" style={{ flex: 1 }} onClick={tap}>Tap</Button>
        </div>
        {blocked && (
          <div className="t-foot" style={{ color: "var(--amber)", textAlign: "center" }}>
            The browser hasn't let this page make sound yet. Tap Start once more.
          </div>
        )}

        <div>
          <div className="t-label" style={{ color: "var(--sub)", marginBottom: 6 }}>Subdivision</div>
          <Segmented options={SUBDIVISIONS.map((s) => ({ key: s.key, label: s.label, sub: s.sub }))} value={sub} onChange={setSub} />
        </div>

        <div>
          <div className="t-label" style={{ color: "var(--sub)", marginBottom: 6 }}>Beats in a bar</div>
          <div style={{ display: "flex", gap: 6 }}>
            {METERS.map((m) => (
              <button key={m} type="button" className={`pill${m === meter ? " active" : ""}`} aria-pressed={m === meter}
                onClick={() => setMeter(m)} style={{ flex: 1, justifyContent: "center" }}>{m}</button>
            ))}
          </div>
        </div>

        <CellGroup>
          <SwitchRow title="Click on 2 and 4" sub="Half the clicks, twice the information. The only version that shows you where the beat really is."
            on={twoFour} onToggle={() => setTwoFour((v) => !v)} />
          <SwitchRow title="Drop the click" sub="Two bars on, two bars silent. Keep playing through the gap — when it comes back you find out whether you were still there."
            on={dropClick} onToggle={() => setDropClick((v) => !v)} />
          <SwitchRow title="Ramp the tempo" sub={ramp ? `+${ramp.step} bpm every ${ramp.everyBars} bars, up to ${ramp.to}` : "Climb on its own while you play."}
            on={!!ramp} onToggle={() => setRamp((r) => {
              if (r) return null;
              rampBase.current = { bpm, bar: mRef.current?.position?.().bar ?? 0 };
              return { to: Math.min(240, bpm + 30), step: 5, everyBars: 4 };
            })} />
        </CellGroup>

        {ramp && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="t-foot" style={{ color: "var(--sub)", flex: "none" }}>Up to</span>
            <input type="range" min={bpm} max={Math.max(bpm + 10, 240)} value={ramp.to}
              onChange={(e) => setRamp({ ...ramp, to: Number(e.target.value) })}
              aria-label="Ramp target" style={{ flex: 1, accentColor: "var(--accent)" }} />
            <span className="t-num" style={{ fontSize: 14, color: "var(--ink)", minWidth: 34, textAlign: "right" }}>{ramp.to}</span>
          </div>
        )}

        {dropClick && running && (
          <div className="t-foot" style={{
            color: mRef.current?.muted ? "var(--amber)" : "var(--green)", textAlign: "center", fontWeight: 600,
          }}>
            {mRef.current?.muted ? "Silent — keep going" : "Listening bars"}
          </div>
        )}
      </div>
    </Sheet>
  );
}

export default MetronomeSheet;
