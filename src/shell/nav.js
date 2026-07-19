// ─── Navigation config ────────────────────────────────────────────────────────
// One list drives both platforms: the phone's tab bar and the tablet sidebar.
// Same keys as ever (deep links, Summon targets, and previews depend on them).
export const NAV = [
  { key: "brief", label: "Brief", group: "Today" },
  { key: "personal", label: "Personal", group: "Today" },
  { key: "boardroom", label: "Mini Me", group: "The Firm" },
  { key: "assets", label: "Assets", group: "The Firm" },
  { key: "systems", label: "Systems", group: "The Firm" },
  // Upstream is built and deployed but hidden from nav while the pipeline settles.
  // To bring it back, uncomment this line — the page, route, HEADERS entry and the
  // Supabase tables are all still wired.
  // { key: "upstream", label: "Upstream", group: "The Firm" },
];

const DATE_LINE = (d) =>
  d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

// Large-title copy per page. sub() takes the current Date so the Brief can
// carry the day itself — the calmest possible subtitle.
export const HEADERS = {
  brief: { title: "Brief", sub: (d) => DATE_LINE(d) },
  personal: { title: "Personal", sub: () => "Notes, calendar, and training" },
  boardroom: { title: "Mini Me", sub: () => "Your delegate — queue, run, review" },
  assets: { title: "Assets", sub: () => "Everything you run" },
  systems: { title: "Systems", sub: () => "Usage, status, and deploys" },
  upstream: { title: "Upstream", sub: () => "Non-consensus questions · NOSTRADAMUS" },
};
