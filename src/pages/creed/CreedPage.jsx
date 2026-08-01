// ─── Creed — the room, and the wall next to it ────────────────────────────────
// Two sub-tabs: the Creed itself and the Dream boards. They belong together
// because they're the same argument from two directions — the Creed is what you
// hold, the boards are what you're holding it FOR — and neither is a separate
// errand from the other. Dreams had its own nav tab for exactly one release;
// six tabs to reach a wall you look at, not one you work in, was one too many.
//
// It earns its own tab (rather than sitting inside Personal) for the reason
// Grocery and Train did: WHEN it gets used. This is what you check a decision
// against, and three taps deep behind a pill row is the wrong depth for
// something you consult rather than administer.
//
// Sits after Train on purpose: Brief and Personal are what happened, Train and
// Creed are what you're doing about it.
import { lazy, Suspense, useState, useEffect } from "react";
import { Segmented } from "../../ui/kit.jsx";

// Both lazy — nothing here belongs in the bundle that paints the Brief, and the
// board is only ever one of the two on screen.
const CreedPanel = lazy(() => import("../../features/creed/CreedPanel.jsx").then(m => ({ default: m.CreedPanel })));
const DreamBoardPanel = lazy(() => import("../../features/dreams/DreamBoardPanel.jsx").then(m => ({ default: m.DreamBoardPanel })));

// Keys are stable — App.jsx remaps the retired "dreams" page key onto this
// sub-tab, so a saved link still lands on the boards.
const SUBTABS = [{ key: "creed", label: "Creed" }, { key: "dreams", label: "Dreams" }];

export function CreedPage({ isMobile, settings, updateSetting, jump }) {
  const [sub, setSub] = useState("creed");
  useEffect(() => {
    if (jump?.page === "creed" && SUBTABS.some(t => t.key === jump.sub)) setSub(jump.sub);
  }, [jump?.t]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0, padding: isMobile ? "0 16px" : 0 }}>
        <Segmented options={SUBTABS} value={sub} onChange={setSub} style={{ marginBottom: 12, flex: "none" }} />
        {/* key={sub} restarts the fade on every switch — do not lose the key. */}
        <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <Suspense fallback={<div className="sk" style={{ height: 220, borderRadius: 18 }} />}>
            {sub === "creed" && <CreedPanel isMobile={isMobile} />}
            {sub === "dreams" && <DreamBoardPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} />}
          </Suspense>
        </div>
      </div>
    </div>
  );
}

export default CreedPage;
