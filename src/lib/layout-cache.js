// ─── the shape of the app, remembered for the first frame ────────────────────
// Settings are not in the persisted query cache: App.jsx reads them fresh on
// every launch, and they arrive 0.3–2 s after the first paint. Until they do,
// the dock drew all eight tabs and the Brief drew all eleven cards in the
// default order — hidden ones included — and then both snapped to the layout
// you actually chose. iOS evicts the installed app often enough that this was
// most launches.
//
// This is a DISPLAY-ONLY copy of the handful of settings that decide that
// shape. It is read only where the app draws the dock and arranges the Brief,
// and only while the real settings are still null. Nothing reads it to decide
// a write: updateSetting still refuses while settings are null, so a stale copy
// here can never be saved over the row.
//
// Account switching: the key starts with br_ and is not on the sign-out purge's
// keep-list (App.jsx, purgeDevice), so it goes with everything else.
const KEY = "br_layout_cache";
const FIELDS = ["navigation", "hidden_tabs", "brief_hidden", "brief_order", "brief_active_layout", "brief_layouts", "brief_columns"];

/** The last-seen shape, or null when there is none or it can't be read. */
export function readLayoutCache() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** Remember the shape-deciding fields of a loaded settings object. */
export function writeLayoutCache(settings) {
  if (!settings || typeof settings !== "object") return;
  const out = {};
  for (const k of FIELDS) if (settings[k] !== undefined) out[k] = settings[k];
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* storage full or blocked — the app just paints the default shape */ }
}
