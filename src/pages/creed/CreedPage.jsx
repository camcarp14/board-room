// ─── Creed — promoted out of Personal ─────────────────────────────────────────
// Thin page shell, same well and padding grammar as Grocery and Train. The panel
// itself is unchanged; only where you reach it moved.
//
// It earns a tab for the same reason Grocery and Train did: WHEN it gets used.
// The Creed is what you check a decision against, and three taps deep behind
// Personal → Creed is the wrong depth for something you consult rather than
// administer. Filed between birthdays and movies it read as one more list; on
// the bar next to Train it reads as a standing commitment, which is what it is.
//
// Sits after Train on purpose: Brief and Personal are what happened, Train and
// Creed are what you're doing about it.
import { lazy, Suspense } from "react";

// Lazy for the same reason it was lazy inside Personal — nothing about the Creed
// needs to be in the bundle that paints the Brief.
const CreedPanel = lazy(() => import("../../features/creed/CreedPanel.jsx").then(m => ({ default: m.CreedPanel })));

export function CreedPage({ isMobile }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0, padding: isMobile ? "0 16px" : 0 }}>
        <Suspense fallback={<div className="sk" style={{ height: 180, borderRadius: 18 }} />}>
          <CreedPanel isMobile={isMobile} />
        </Suspense>
      </div>
    </div>
  );
}

export default CreedPage;
