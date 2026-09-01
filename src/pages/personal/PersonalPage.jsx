// ─── Personal — the private wing ──────────────────────────────────────────────
// Router/shell for the Personal tab: a PillRow of sections mounts one of eight
// feature panels and handles cross-app jump/deep-link signals. Panels are
// unmounted when not active (state resets on section switch — current, kept).

import { useState, useEffect, lazy, Suspense } from "react";
import { PillRow } from "../../ui/kit.jsx";
// Notes & Calendar is the sub-tab you land on, so it stays in this chunk —
// first paint must not wait on a second request. The other five are one tap away
// and rarely the reason you opened Personal, so they split out: opening the tab
// you actually use every day no longer downloads Movies, Food, Birthdays and
// Upkeep alongside it.
import { NotesPanel } from "./NotesPanel.jsx";
import { CalendarPanel } from "./CalendarPanel.jsx";
const PonderPanel = lazy(() => import("./PonderPanel.jsx").then(m => ({ default: m.PonderPanel })));
const UpkeepPanel = lazy(() => import("../../features/upkeep/UpkeepPanel.jsx").then(m => ({ default: m.UpkeepPanel })));
const BirthdaysPanel = lazy(() => import("../../features/birthdays/BirthdaysPanel.jsx").then(m => ({ default: m.BirthdaysPanel })));
const AnniversariesPanel = lazy(() => import("../../features/anniversaries/AnniversariesPanel.jsx").then(m => ({ default: m.AnniversariesPanel })));
const MoviesPanel = lazy(() => import("../../features/movies/MoviesPanel.jsx").then(m => ({ default: m.MoviesPanel })));
const FoodPanel = lazy(() => import("../../features/food/FoodPanel.jsx").then(m => ({ default: m.FoodPanel })));

// Local boundary so a lazy panel shows a card-shaped skeleton in place, rather
// than falling through to App's page-level fallback and blanking the pill row.
const PanelFallback = () => (
  <div className="sk" style={{ height: 180, borderRadius: 18 }} />
);

// Section keys are wired to jump.sub values coming from other parts of the app
// (Summon, Brief) — renaming a key breaks deep links.
// One list everywhere — Notes and Calendar ride together on every width now.
// Workout graduated to its own tab (Train) — jump.sub "workout" is remapped in
// App.jsx so old deep links still land somewhere sensible.
// Creed graduated to its own tab, like Workout did before it — App.jsx remaps
// jump.sub "creed" so old deep links still land on it.
// Anniversaries sits directly after Birthdays because it is the same question
// asked backwards — days that come around for people who are here, then days
// that come around because they already happened. Both land on the same
// calendar; keeping them apart in the pill row would hide that.
const PERSONAL_SUBTABS = [{ key: "notescal", label: "Notes & Calendar" }, { key: "ponder", label: "Ponder" }, { key: "upkeep", label: "Upkeep" }, { key: "birthdays", label: "Birthdays" }, { key: "anniversaries", label: "Anniversaries" }, { key: "movies", label: "Movies" }, { key: "food", label: "Food" }];

export function PersonalPage({ isMobile, jumpSignal, jump, settings, updateSetting }) {
  const [sub, setSub] = useState("notescal");
  // Any truthy jumpSignal means "take me to the calendar" — which now lives in
  // the combined Notes & Calendar view on every width.
  useEffect(() => {
    if (jumpSignal) setSub("notescal");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSignal]);
  useEffect(() => {
    if (jump?.page !== "personal" || !jump.sub) return;
    const map = { notes: "notescal", calendar: "notescal" };
    setSub(map[jump.sub] || jump.sub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.t]);
  const noteSignal = jump?.page === "personal" && jump.noteId ? { id: jump.noteId, t: jump.t } : null;
  // Tapping a day on the Brief mini-calendar deep-links here to open a new event
  // pre-dated to it (CalendarPanel opens the form on a fresh signal).
  const newEventSignal = jump?.page === "personal" && jump.newEventDate ? { date: jump.newEventDate, t: jump.t } : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <PillRow
          options={PERSONAL_SUBTABS}
          value={sub}
          onChange={setSub}
          style={isMobile ? undefined : { padding: "2px 2px 12px" }}
        />
        {/* key={sub} restarts the fade on section change — do not lose the key */}
        <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", gap: 12, padding: isMobile ? "2px 16px 0" : "2px 0 0", minWidth: 0 }}>
          {sub === "notescal" && (
            <>
              <CalendarPanel isMobile={isMobile} newEventSignal={newEventSignal} />
              <div style={{ height: 12 }} />
              <NotesPanel isMobile={isMobile} openSignal={noteSignal} settings={settings} updateSetting={updateSetting} />
            </>
          )}
          {sub !== "notescal" && (
            <Suspense fallback={<PanelFallback />}>
              {sub === "ponder" && <PonderPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} />}
              {sub === "upkeep" && <UpkeepPanel isMobile={isMobile} />}
              {sub === "birthdays" && <BirthdaysPanel isMobile={isMobile} />}
              {sub === "anniversaries" && <AnniversariesPanel isMobile={isMobile} />}
              {sub === "movies" && <MoviesPanel isMobile={isMobile} />}
              {sub === "food" && <FoodPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} />}
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}

export default PersonalPage;
