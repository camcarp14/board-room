// ─── The player ──────────────────────────────────────────────────────────────
// One transport for backing tracks, shared by the Jam drill and by a song's
// Sections row. Both feed it a timeline from lib/guitar/progression.js, so the
// chord you SEE and the chord you HEAR are the same object — a player that
// recomputed the display separately is a player that eventually shows bar 3 while
// bar 4 is sounding, and there is no way to notice that from the code.
//
// THE HAND KEEPS MOVING. The strum animation draws every pass of the strumming
// hand including the ones that miss the strings, because that is the whole
// instruction: draw the hits alone and D-DU-UDU is a riddle, draw the hand and it
// is obvious. A learner who copies the hits stops the hand between them, which is
// the single most common reason a strumming pattern will not come.
//
// The playhead is driven off the AUDIO clock, read on animation frames. Not off a
// counter incremented by the beat callback: the callback fires when a beat is
// SCHEDULED, up to 120 ms before it sounds, so a display driven by it runs
// visibly ahead of the music.

import { useEffect, useRef, useState } from "react";
import { Sheet, Button, Switch } from "../../ui/kit.jsx";

import { createBackingPlayer, unlock } from "../../lib/guitar/audio.js";
import { chordAtBeat } from "../../lib/guitar/progression.js";
import ChordDiagram from "./ChordDiagram.jsx";

export function PlayerBar({ title, backing, bpm: initialBpm = 90, onClose, isMobile, subtitle = null }) {
  const [bpm, setBpm] = useState(Math.max(40, Math.min(220, Math.round(initialBpm || 90))));
  const [running, setRunning] = useState(false);
  const [pos, setPos] = useState({ beat: 0, bar: 0 });
  const [mutes, setMutes] = useState({ click: false, chords: false, bass: false });
  const [blocked, setBlocked] = useState(false);
  const playerRef = useRef(null);
  const rafRef = useRef(0);

  // One player for the life of the sheet, rebuilt only when the TIMELINE changes.
  // Rebuilding on a tempo change would restart the bar count in the middle of a
  // take, which is exactly when you least want to lose your place.
  useEffect(() => {
    const p = createBackingPlayer(backing, { bpm, loop: true, countIn: 4 });
    playerRef.current = p;
    return () => { p.stop(); playerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backing]);

  useEffect(() => { playerRef.current?.setBpm(bpm); }, [bpm]);
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    for (const k of Object.keys(mutes)) p.setMute(k, mutes[k]);
  }, [mutes]);

  // Read the transport on every frame while it runs, and stop reading the moment
  // it does not — a rAF loop left running behind a closed sheet is a battery bug
  // with no symptom until the phone is warm.
  useEffect(() => {
    if (!running) return undefined;
    const tick = () => {
      const p = playerRef.current;
      if (p?.running) {
        const q = p.position();
        // The transport counts sixteenths from its own start, including the
        // count-in; the timeline counts beats from the song's start.
        const songBeat = q.beat - 4;
        const total = Math.max(1, backing.beats);
        setPos({
          beat: songBeat < 0 ? songBeat : ((songBeat % total) + total) % total,
          bar: songBeat < 0 ? -1 : Math.floor((((songBeat % total) + total) % total) / 4),
          counting: songBeat < 0,
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, backing.beats]);

  const toggle = async () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.running) { p.stop(); setRunning(false); return; }
    if (!(await unlock())) { setBlocked(true); return; }
    setBlocked(false);
    const ok = await p.start();
    setRunning(!!ok);
  };

  const at = pos.counting ? null : chordAtBeat(backing.chords, Math.max(0, pos.beat));
  const current = at?.chord || backing.chords[0] || null;
  const next = at?.next || backing.chords[1] || null;
  const bars = Math.ceil(backing.beats / 4);

  // Where the strumming hand is inside the current beat, for the pendulum: 0 at
  // the top of a downstroke, 1 at the bottom.
  const phase = pos.counting ? 0 : (pos.beat % 1);
  const handY = Math.sin(phase * Math.PI * 2 - Math.PI / 2);

  return (
    <Sheet title={title} onClose={onClose} detent={isMobile ? "large" : "auto"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 6 }}>
        {subtitle && <div className="t-call" style={{ color: "var(--sub)" }}>{subtitle}</div>}

        {backing.unknown?.length > 0 && (
          <div className="t-foot" style={{ color: "var(--amber)" }}>
            {backing.unknown.join(", ")} — no verified shape, so {backing.unknown.length === 1 ? "that bar plays" : "those bars play"} silent
            rather than as a chord nobody checked.
          </div>
        )}

        {/* the chord, large, and what is coming */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, minHeight: 132 }}>
          {current?.voicing ? (
            <ChordDiagram frets={current.voicing.frets} fingers={current.voicing.fingers} barre={current.voicing.barre}
              label={current.symbol} size={isMobile ? 118 : 132} />
          ) : (
            <div style={{ width: isMobile ? 118 : 132 }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-label" style={{ color: "var(--faint)" }}>
              {pos.counting ? "Count in" : `Bar ${(pos.bar ?? 0) + 1} of ${bars}`}
            </div>
            <div className="t-ltitle" style={{ fontSize: 38, color: pos.counting ? "var(--faint)" : "var(--accent)", marginTop: 2 }}>
              {pos.counting ? "…" : (current?.symbol || "—")}
            </div>
            {next && !pos.counting && (
              <div className="t-call" style={{ color: "var(--sub)", marginTop: 4 }}>next · {next.symbol}</div>
            )}
            {/* the strumming hand, drawn as a whole motion */}
            <svg viewBox="0 0 120 34" width="100%" height={34} style={{ marginTop: 8, maxWidth: 180 }} aria-hidden>
              <line x1={10} y1={17} x2={110} y2={17} stroke="var(--line)" strokeWidth={1.5} />
              <circle cx={60} cy={17 + handY * 11} r={6}
                fill={running && !pos.counting ? "var(--accent)" : "var(--ink-a20)"} />
            </svg>
          </div>
        </div>

        {/* the bars */}
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {backing.chords.map((c, i) => (
            <span key={i} style={{
              flex: `1 1 ${100 / Math.min(8, backing.chords.length)}%`, minWidth: 42, textAlign: "center",
              padding: "5px 4px", borderRadius: 8, fontSize: 12, fontWeight: 650,
              background: at?.index === i ? "var(--accent-a16)" : "var(--surface-2)",
              color: at?.index === i ? "var(--accent)" : "var(--sub)",
              fontFamily: "var(--font-mono)",
            }}>{c.symbol}</span>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="t-num" style={{ fontSize: 26, fontWeight: 700, minWidth: 56 }}>{bpm}</div>
          <input type="range" min={40} max={200} value={bpm} onChange={(e) => setBpm(Number(e.target.value))}
            aria-label="Tempo" style={{ flex: 1, accentColor: "var(--accent)" }} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <Button kind={running ? "quiet" : "primary"} size="lg" full onClick={toggle}>{running ? "Stop" : "Play"}</Button>
        </div>
        {blocked && (
          <div className="t-foot" style={{ color: "var(--amber)", textAlign: "center" }}>
            The browser hasn't let this page make sound yet. Tap Play once more.
          </div>
        )}

        <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
          {[["click", "Click"], ["chords", "Chords"], ["bass", "Bass"]].map(([k, label]) => (
            <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <Switch small on={!mutes[k]} onToggle={() => setMutes((m) => ({ ...m, [k]: !m[k] }))} aria-label={label} />
              <span className="t-foot" style={{ color: "var(--sub)" }}>{label}</span>
            </label>
          ))}
        </div>

        <div className="t-cap" style={{ color: "var(--faint)", textAlign: "center", lineHeight: 1.5 }}>
          Everything you hear is synthesised on this device from the chord chart — no recordings, no
          network. Mute the chords and it becomes a click with a bass player.
        </div>
      </div>
    </Sheet>
  );
}

export default PlayerBar;
