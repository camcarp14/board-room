// ─── Event categories — the four colours, and nothing else ───────────────────
// This is a leaf on purpose, and the reason is measurable. It used to live at the
// top of pages/personal/CalendarPanel.jsx, and the Brief imported it from there
// for the mini-calendar's category pills — one named import of a four-entry
// array. ES modules do not work that way: importing one binding evaluates the
// whole module, so that line put CalendarPanel (27.5 kB of month grid, event
// sheet and Claude-vision bulk import) plus everything it reaches — recurrence.js,
// calendar-overlays.js, calendar-layout.js, holidays.js, data/birthdays.js — into
// the LANDING PAGE's first-paint chunk. The Brief is the tab that opens on every
// launch; the Calendar is behind a lazy import of Personal that most launches
// never touch. So the whole calendar was being downloaded and evaluated before
// the greeting could paint, to read four hex-free colour tokens.
//
// A module with no imports but the token bridge cannot do that to anyone. Anything
// that needs the colours takes them from here; CalendarPanel re-exports the same
// binding so older call sites keep resolving.
import { T } from "../theme.js";

// Keys personal/work/health/bills are stored values in the events.category
// column — do not rename. Colors ride the validated data palette.
export const EVENT_CATEGORIES = [
  { key: "personal", label: "Personal", color: T.blue },
  { key: "work", label: "Work", color: T.amber },
  { key: "health", label: "Health", color: T.green },
  { key: "bills", label: "Bills / Finance", color: T.red },
];
