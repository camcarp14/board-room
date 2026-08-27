// ─── Guitar — a practice program, not a rack of tools ────────────────────────
// Four sub-tabs and two header tools:
//
//   Today      the prescribed session — the answer to "what do I do now"
//   Drills     the rack, plus the two measurements nobody self-taught ever gets
//   Songs      the repertoire, which is the only metric that counts
//   Fretboard  the reference and the trainers, on one screen
//
// THE TUNER AND THE METRONOME ARE NOT SUB-TABS. They are the two things you
// reach for constantly and from anywhere — a tuner you have to navigate to is a
// tuner you use a different app for — so they sit in the page header and open
// over whatever you were doing. That costs one row of chrome and saves two taps
// every single session.
//
// WHY THIS EXISTS AT ALL. The Gibson app is £160 a year and its practice engine
// is the weak half of it; what it sells is content — licensed audio, video,
// artist lessons — none of which can be bought here and none of which is the
// binding constraint for one motivated adult. The constraint is not "I have no
// lessons", it is "I don't know what to practise today and I can't tell if I'm
// improving", and that is entirely solvable with data, arithmetic and the Web
// Audio API. Everything you hear in this tab is synthesised on the device from a
// chord chart. There are no recordings, no video, and nothing leaves the phone.

import { lazy, Suspense, useEffect, useState } from "react";
import { Segmented, Button } from "../../ui/kit.jsx";

// All four panels are lazy. The Guitar chunk pulls the whole theory library, the
// chord table and the DSP, and none of that belongs in the bundle that has to
// paint the Brief.
const TodayPanel = lazy(() => import("./TodayPanel.jsx").then((m) => ({ default: m.TodayPanel })));
const DrillsPanel = lazy(() => import("./DrillsPanel.jsx").then((m) => ({ default: m.DrillsPanel })));
const SongsPanel = lazy(() => import("./SongsPanel.jsx").then((m) => ({ default: m.SongsPanel })));
const FretboardPanel = lazy(() => import("./FretboardPanel.jsx").then((m) => ({ default: m.FretboardPanel })));
const TunerSheet = lazy(() => import("./TunerSheet.jsx").then((m) => ({ default: m.TunerSheet })));
const MetronomeSheet = lazy(() => import("./MetronomeSheet.jsx").then((m) => ({ default: m.MetronomeSheet })));

const SUBTABS = [
  { key: "today", label: "Today" },
  { key: "drills", label: "Drills" },
  { key: "songs", label: "Songs" },
  { key: "fretboard", label: "Fretboard" },
];
const DEFAULT_SUB = "today";

export function GuitarPage({ isMobile, settings, updateSetting, jump }) {
  const [sub, setSub] = useState(DEFAULT_SUB);
  const [tuner, setTuner] = useState(false);
  const [metronome, setMetronome] = useState(false);

  useEffect(() => {
    if (jump?.page === "guitar" && SUBTABS.some((t) => t.key === jump.sub)) setSub(jump.sub);
  }, [jump?.t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Land at the top, on arrival and on every sub switch. Set directly rather than
  // scrolled: App's nav handler schedules a SMOOTH scroll in a rAF, and these
  // panels are lazy — the animation starts over a skeleton and is still running
  // when a full fretboard lands underneath it, so the scroller settles wherever
  // the newly-tall content left it. The long version of this is at the top of
  // pages/markets/MarketsPage.jsx.
  useEffect(() => {
    const el = document.getElementById("page-scroll");
    if (!el) return undefined;
    el.scrollTop = 0;
    const raf = requestAnimationFrame(() => { el.scrollTop = 0; });
    return () => cancelAnimationFrame(raf);
  }, [sub]);

  // Everything stops when the tab does. A metronome still clicking from a page
  // nobody is looking at is the kind of bug that gets reported once, angrily.
  useEffect(() => () => {
    import("../../lib/guitar/audio.js").then((a) => a.stopAll()).catch(() => { /* never loaded */ });
  }, []);

  const shared = { isMobile, settings, updateSetting };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0, padding: isMobile ? "0 16px" : 0 }}>
        <Segmented options={SUBTABS} value={sub} onChange={setSub} style={{ marginBottom: 10, flex: "none" }} />

        {/* the two tools, from anywhere */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <Button kind="quiet" full onClick={() => setTuner(true)}>Tuner</Button>
          <Button kind="quiet" full onClick={() => setMetronome(true)}>Metronome</Button>
        </div>

        {/* key={sub} restarts the fade on every switch — do not lose the key. */}
        <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <Suspense fallback={<div className="sk" style={{ height: 240, borderRadius: 18 }} />}>
            {sub === "today" && <TodayPanel {...shared} onOpenTuner={() => setTuner(true)} onOpenMetronome={() => setMetronome(true)} />}
            {sub === "drills" && <DrillsPanel {...shared} onOpenMetronome={() => setMetronome(true)} />}
            {sub === "songs" && <SongsPanel {...shared} />}
            {sub === "fretboard" && <FretboardPanel {...shared} />}
          </Suspense>
        </div>
      </div>

      <Suspense fallback={null}>
        {tuner && <TunerSheet {...shared} onClose={() => setTuner(false)} />}
        {metronome && <MetronomeSheet {...shared} onClose={() => setMetronome(false)} />}
      </Suspense>
    </div>
  );
}

export default GuitarPage;
