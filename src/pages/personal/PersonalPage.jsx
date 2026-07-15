// ─── Personal — the private wing ──────────────────────────────────────────────
// Router/shell for the Personal tab: a PillRow of sections mounts one of eight
// feature panels and handles cross-app jump/deep-link signals. Panels are
// unmounted when not active (state resets on section switch — current, kept).

import { useState, useEffect } from "react";
import { PillRow } from "../../ui/kit.jsx";
import { supabase } from "../../lib/supabase.js";
import WorkoutPanel from "../../WorkoutPanel.jsx";
import { UpkeepPanel } from "../../features/upkeep/UpkeepPanel.jsx";
import { CreedPanel } from "../../features/creed/CreedPanel.jsx";
import { BirthdaysPanel } from "../../features/birthdays/BirthdaysPanel.jsx";
import { MoviesPanel } from "../../features/movies/MoviesPanel.jsx";
import { FoodPanel } from "../../features/food/FoodPanel.jsx";
import { NotesPanel } from "./NotesPanel.jsx";
import { CalendarPanel } from "./CalendarPanel.jsx";

// Section keys are wired to jump.sub values coming from other parts of the app
// (Summon, Brief) — renaming a key breaks deep links.
const PERSONAL_SUBTABS = [{ key: "notes", label: "Notes" }, { key: "calendar", label: "Calendar" }, { key: "workout", label: "Workout" }, { key: "upkeep", label: "Upkeep" }, { key: "creed", label: "Creed" }, { key: "birthdays", label: "Birthdays" }, { key: "movies", label: "Movies" }, { key: "food", label: "Food" }];
const PERSONAL_SUBTABS_MOBILE = [{ key: "notescal", label: "Notes & Calendar" }, { key: "workout", label: "Workout" }, { key: "upkeep", label: "Upkeep" }, { key: "creed", label: "Creed" }, { key: "birthdays", label: "Birthdays" }, { key: "movies", label: "Movies" }, { key: "food", label: "Food" }];

export function PersonalPage({ isMobile, jumpSignal, jump, settings, updateSetting }) {
  const [sub, setSub] = useState(isMobile ? "notescal" : "notes");
  // Any truthy jumpSignal means "take me to the calendar" (mobile lands on the
  // combined Notes & Calendar view).
  useEffect(() => {
    if (jumpSignal) setSub(isMobile ? "notescal" : "calendar");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSignal]);
  useEffect(() => {
    if (jump?.page !== "personal" || !jump.sub) return;
    const mobileMap = { notes: "notescal", calendar: "notescal" };
    setSub(isMobile ? (mobileMap[jump.sub] || jump.sub) : jump.sub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.t]);
  const noteSignal = jump?.page === "personal" && jump.noteId ? { id: jump.noteId, t: jump.t } : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <PillRow
          options={isMobile ? PERSONAL_SUBTABS_MOBILE : PERSONAL_SUBTABS}
          value={sub}
          onChange={setSub}
          style={isMobile ? undefined : { padding: "2px 2px 12px" }}
        />
        {/* key={sub} restarts the fade on section change — do not lose the key */}
        <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", gap: 12, padding: isMobile ? "2px 16px 0" : "2px 0 0", minWidth: 0 }}>
          {isMobile ? (
            <>
              {sub === "notescal" && (
                <>
                  <CalendarPanel isMobile={isMobile} />
                  <div style={{ height: 12 }} />
                  <NotesPanel isMobile={isMobile} openSignal={noteSignal} />
                </>
              )}
              {sub === "workout" && <WorkoutPanel isMobile={isMobile} supabase={supabase} settings={settings} updateSetting={updateSetting} />}
              {sub === "upkeep" && <UpkeepPanel isMobile={isMobile} />}
              {sub === "creed" && <CreedPanel isMobile={isMobile} />}
              {sub === "birthdays" && <BirthdaysPanel isMobile={isMobile} />}
              {sub === "movies" && <MoviesPanel isMobile={isMobile} />}
              {sub === "food" && <FoodPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} />}
            </>
          ) : (
            <>
              {sub === "notes" && <NotesPanel isMobile={isMobile} openSignal={noteSignal} />}
              {sub === "calendar" && <CalendarPanel isMobile={isMobile} />}
              {sub === "workout" && <WorkoutPanel isMobile={isMobile} supabase={supabase} settings={settings} updateSetting={updateSetting} />}
              {sub === "upkeep" && <UpkeepPanel isMobile={isMobile} />}
              {sub === "creed" && <CreedPanel isMobile={isMobile} />}
              {sub === "birthdays" && <BirthdaysPanel isMobile={isMobile} />}
              {sub === "movies" && <MoviesPanel isMobile={isMobile} />}
              {sub === "food" && <FoodPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default PersonalPage;
