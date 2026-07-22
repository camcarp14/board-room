// ─── Navigation config ────────────────────────────────────────────────────────
// One list drives both platforms: the phone's tab bar and the tablet sidebar.
// Same keys as ever (deep links, Summon targets, and previews depend on them).
export const NAV = [
  { key: "brief", label: "Brief", group: "Today" },
  { key: "personal", label: "Personal", group: "Today" },
  { key: "train", label: "Train", group: "Today" },
  { key: "boardroom", label: "Mind", group: "The Firm" },
  // Systems was folded into Assets — its Usage/Status/Deploy/Supabase/Miner
  // panels are now sub-tabs of the Assets page (App.jsx redirects any stray
  // "systems" deep link to "assets").
  { key: "assets", label: "Assets", group: "The Firm" },
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
  personal: { title: "Personal", sub: () => "Notes, calendar, and life admin" },
  train: { title: "Train", sub: () => "Log it. Beat last time." },
  boardroom: { title: "Mind", sub: () => "The mind behind the delegate" },
  assets: { title: "Assets", sub: () => "Everything you own, and what runs it" },
  // Kept as a defensive fallback: App.jsx redirects "systems" → "assets", so the
  // shell should never actually read this — but a header lookup must never crash.
  systems: { title: "Assets", sub: () => "Everything you own, and what runs it" },
  upstream: { title: "Upstream", sub: () => "Non-consensus questions · NOSTRADAMUS" },
};
