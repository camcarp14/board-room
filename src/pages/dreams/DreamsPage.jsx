// ─── Dreams — the board wall ──────────────────────────────────────────────────
// Thin page shell, same well and padding grammar as Creed and Grocery. Sits
// after Creed on purpose: the Creed is what you hold, the boards are what you're
// holding it FOR.
//
// settings/updateSetting are threaded through for one thing — the list of board
// names (app_settings.dream_boards). Boards are otherwise derived from the tiles
// themselves; the saved list is only what lets a board you just made survive
// having nothing on it yet. See dreamLogic's header.
import { lazy, Suspense } from "react";

const DreamBoardPanel = lazy(() => import("../../features/dreams/DreamBoardPanel.jsx").then(m => ({ default: m.DreamBoardPanel })));

export function DreamsPage({ isMobile, settings, updateSetting }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0, padding: isMobile ? "0 16px" : 0 }}>
        <Suspense fallback={<div className="sk" style={{ height: 220, borderRadius: 18 }} />}>
          <DreamBoardPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} />
        </Suspense>
      </div>
    </div>
  );
}

export default DreamsPage;
