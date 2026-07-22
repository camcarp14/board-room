// ─── Train — the training room, promoted to its own tab ──────────────────────
// Thin page shell: same 900px well and padding grammar as Personal. All the
// muscle lives in WorkoutPanel.
import { supabase } from "../../lib/supabase.js";
import WorkoutPanel from "../../WorkoutPanel.jsx";

export function TrainPage({ isMobile, settings, updateSetting, jump }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0, padding: isMobile ? "0 16px" : 0 }}>
        <WorkoutPanel isMobile={isMobile} supabase={supabase} settings={settings} updateSetting={updateSetting} jump={jump} />
      </div>
    </div>
  );
}

export default TrainPage;
