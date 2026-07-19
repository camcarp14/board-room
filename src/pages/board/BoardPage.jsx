// ─── Page: Mind (Mind delegate · Neurons canvas · Learn) ─────────────────────
// The board (chat + seats) was retired; this page is now one mind viewed three
// ways: the Mind delegate (home) thinks with the compiled Neurons, the Neurons
// canvas is its wiring (doctrine + everything taught), and Learn teaches it.
import { useState, useEffect } from "react";
import { Segmented } from "../../ui/kit.jsx";
import { callClaude } from "../../lib/claude.js";
import { supabase } from "../../lib/supabase.js";
import LearnPanel from "../../LearnPanel.jsx";
import { MiniMePage } from "./MiniMePage.jsx";
import { MindPanel } from "./mind/MindPanel.jsx";

/* ── sub-navigation ─────────────────────────────────────────────────────────── */
// Keys are wired to jump.sub deep links (Summon, Brief) and stay stable so old
// links survive; only labels/order/default changed. "mini" is the Mind delegate
// (the tab's home), "neural" the Neurons canvas, "learn" teaches. Retired board
// keys ("chat"/"seats") — and any stale sub — fall through to "mini".
const BOARDROOM_SUBTABS = [{ key: "mini", label: "Mind" }, { key: "neural", label: "Neurons" }, { key: "learn", label: "Learn" }];

export function BoardRoomPage({ settings, updateSetting, session, onWorkerRun, onSkillsChanged, jump, isMobile, skills = [] }) {
  // "mini" (the Mind delegate) is the tab's home; Neurons (the canvas) and Learn
  // are one tap away. The delegate is the face of the mind, Neurons its wiring,
  // Learn teaches it — one system, three views.
  const [sub, setSub] = useState("mini");
  // Intra-tab focus target: a skillId carried across a sub-tab switch so the
  // destination panel can flash/select the matching neuron (Neurons) or skill
  // row (Learn). Cleared on manual tab taps and on external deep links (those
  // arrive via `jump`/`spotlight` instead).
  const [focus, setFocus] = useState(null); // { sub, id, t } | null
  useEffect(() => {
    // Consume cross-page deep links; retired/stale sub-keys route to the delegate.
    if (jump?.page === "boardroom" && jump.sub) {
      setSub(BOARDROOM_SUBTABS.some(t => t.key === jump.sub) ? jump.sub : "mini");
      setFocus(null);
    }
  }, [jump?.t]); // eslint-disable-line react-hooks/exhaustive-deps
  const skillSpotlight = jump?.page === "boardroom" && jump.skillId ? { id: jump.skillId, t: jump.t } : null;

  // Manual sub-tab tap — clear any pending intra-tab focus so it doesn't leak
  // into a panel the user navigated to by hand.
  const changeSub = (key) => { setSub(key); setFocus(null); };

  // Intra-tab jump (Neurons ⇄ Learn cross-nav): switch sub-tab and stash the
  // skillId so the destination can focus it. onJump({ sub:"neural", skillId }) →
  // MindPanel focusSkillId; onJump({ sub:"learn", skillId }) → LearnPanel spotlight.
  const onJump = (target) => {
    if (!target?.sub) return;
    setSub(BOARDROOM_SUBTABS.some(t => t.key === target.sub) ? target.sub : "mini");
    setFocus(target.skillId != null ? { sub: target.sub, id: target.skillId, t: Date.now() } : null);
  };
  // Raw skill id for MindPanel (it prefixes "learned_"), only when the focus is
  // aimed at Neurons. LearnPanel takes an { id, t } spotlight from either an
  // intra-tab jump to Learn or an external deep link.
  const focusSkillId = focus?.sub === "neural" ? focus.id : null;
  const learnSpotlight = (focus?.sub === "learn" ? { id: focus.id, t: focus.t } : null) || skillSpotlight;

  const learnPanel = (
    <div style={{ width: "100%", maxWidth: 760, margin: "0 auto", padding: isMobile ? "8px 16px 0" : "4px 0 0" }}>
      <LearnPanel isMobile={isMobile} supabase={supabase} callClaude={callClaude} session={session}
        modelKey={(settings?.mini || {}).model || "haiku"} onSkillsChanged={onSkillsChanged} onJump={onJump} spotlight={learnSpotlight} />
    </div>
  );

  const panel = (key) => (
    key === "mini" ? (
      <MiniMePage settings={settings} updateSetting={updateSetting} session={session} onWorkerRun={onWorkerRun} skills={skills} jump={jump} onJump={onJump} isMobile={isMobile} />
    ) : key === "learn" ? (
      learnPanel
    ) : (
      <MindPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} session={session} jump={jump} onJump={onJump} skills={skills} onSkillsChanged={onSkillsChanged} focusSkillId={focusSkillId} />
    )
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ flex: "none", padding: isMobile ? "2px 16px 12px" : "0 0 14px", ...(isMobile ? {} : { display: "flex", justifyContent: "center" }) }}>
        <Segmented options={BOARDROOM_SUBTABS} value={sub} onChange={changeSub} style={isMobile ? undefined : { width: "100%", maxWidth: 520 }} />
      </div>
      {/* key={sub} restarts the fade on tab change — do not lose the key */}
      <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {panel(sub)}
      </div>
    </div>
  );
}

export default BoardRoomPage;
