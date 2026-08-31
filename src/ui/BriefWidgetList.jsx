// ─── The Brief's widget switches ─────────────────────────────────────────────
// One list of switches, rendered in two places on purpose: Settings → Tabs
// (reachable from the phone, where there is no Layout button) and the desktop
// Brief's Layout sheet (where you're already arranging the same cards). Both
// write app_settings.brief_hidden, so a widget put away on the phone is away on
// the Mac a refresh later.
//
// It deliberately looks like the tab switches directly above it in Settings:
// same 52px rows, same dimmed label when off, same one-tap toggle. Hiding a
// widget and hiding a tab are the same act at two scales, and learning it twice
// would be one time too many.
//
// Shared rather than duplicated because the two copies would drift — and the
// copy that drifts is the one on the surface you use least, which is exactly
// the one you'd trust to be telling the truth.
import { SectionHeader, Switch } from "./kit.jsx";
import { BRIEF_CARDS, hiddenBriefCards, toggleBriefCard } from "../lib/brief-cards.js";

const DEFAULT_NOTE =
  "Off takes the widget off the Brief and stops it holding a column — nothing is deleted, "
  + "and switching it back on puts it where you left it.";

export function BriefWidgetList({ settings, updateSetting, title = "The Brief's widgets", note = DEFAULT_NOTE }) {
  const hidden = hiddenBriefCards(settings);
  const toggle = (id) => updateSetting?.("brief_hidden", toggleBriefCard(hidden, id));

  return (
    <>
      <SectionHeader
        title={title}
        // Only offered when there is something to undo — a "Show all" that does
        // nothing is a button that teaches you it does nothing.
        trailing={hidden.size ? "Show all" : undefined}
        onTrailing={hidden.size ? () => updateSetting?.("brief_hidden", []) : undefined}
        style={{ marginTop: 12 }}
      />
      <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "2px 12px" }}>
        {BRIEF_CARDS.map((c, i) => (
          <div key={c.id} style={{
            display: "flex", alignItems: "center", gap: 8, minHeight: 52,
            borderTop: i === 0 ? "none" : "1px solid var(--line)",
            opacity: hidden.has(c.id) ? 0.55 : 1,
          }}>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
            <Switch on={!hidden.has(c.id)} onToggle={() => toggle(c.id)} aria-label={c.label} />
          </div>
        ))}
      </div>
      {note && (
        <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, padding: "8px 4px 0" }}>{note}</div>
      )}
    </>
  );
}
