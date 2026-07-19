// ─── Page: Mind (neural canvas · Mini Me delegate · Learn) ───────────────────
// The board (chat + seats) was retired; this page now hosts the Mind neural
// canvas as its home sub-tab, with the Mini Me delegate and Learn alongside.
import { useState, useEffect } from "react";
import { Segmented } from "../../ui/kit.jsx";
import { callClaude } from "../../lib/claude.js";
import { supabase } from "../../lib/supabase.js";
import LearnPanel from "../../LearnPanel.jsx";
import { MiniMePage } from "./MiniMePage.jsx";
import { MindPanel } from "./mind/MindPanel.jsx";

/* ── sub-navigation ─────────────────────────────────────────────────────────── */
// Keys are wired to jump.sub deep links (Summon, Brief). "neural" is the Mind
// canvas (the tab's home); the old board keys ("chat"/"seats") are gone —
// stale deep links to them fall through to the neural canvas.
const BOARDROOM_SUBTABS = [{ key: "neural", label: "Mind" }, { key: "mini", label: "Mini Me" }, { key: "learn", label: "Learn" }];

export function BoardRoomPage({ settings, updateSetting, session, onWorkerRun, onSkillsChanged, jump, isMobile }) {
  // "neural" (the Mind canvas) is the tab's home; Mini Me (the delegate) and
  // Learn are one tap away. The board — chat + seats — was retired; the mind now
  // compiles into how the delegate thinks.
  const [sub, setSub] = useState("neural");
  useEffect(() => {
    // Consume deep links; retired board sub-keys ("chat"/"seats") route to the mind.
    if (jump?.page === "boardroom" && jump.sub) setSub(BOARDROOM_SUBTABS.some(t => t.key === jump.sub) ? jump.sub : "neural");
  }, [jump?.t]); // eslint-disable-line react-hooks/exhaustive-deps
  const skillSpotlight = jump?.page === "boardroom" && jump.skillId ? { id: jump.skillId, t: jump.t } : null;

  const learnPanel = (
    <div style={{ width: "100%", maxWidth: 760, margin: "0 auto", padding: isMobile ? "8px 16px 0" : "4px 0 0" }}>
      <LearnPanel isMobile={isMobile} supabase={supabase} callClaude={callClaude} session={session}
        modelKey={(settings?.mini || {}).model || "haiku"} onSkillsChanged={onSkillsChanged} spotlight={skillSpotlight} />
    </div>
  );

  const panel = (key) => (
    key === "mini" ? (
      <MiniMePage settings={settings} updateSetting={updateSetting} session={session} onWorkerRun={onWorkerRun} onOpenLearn={() => setSub("learn")} isMobile={isMobile} />
    ) : key === "learn" ? (
      learnPanel
    ) : (
      <MindPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} session={session} jump={jump} />
    )
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ flex: "none", padding: isMobile ? "2px 16px 12px" : "0 0 14px", ...(isMobile ? {} : { display: "flex", justifyContent: "center" }) }}>
        <Segmented options={BOARDROOM_SUBTABS} value={sub} onChange={setSub} style={isMobile ? undefined : { width: "100%", maxWidth: 520 }} />
      </div>
      {/* key={sub} restarts the fade on tab change — do not lose the key */}
      <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {panel(sub)}
      </div>
    </div>
  );
}

export default BoardRoomPage;
