// ─── Navigation config ────────────────────────────────────────────────────────
// One flat list drives both platforms: the phone's tab bar and the tablet
// sidebar. Same keys as ever (deep links, Summon targets, and previews depend
// on them).
//
// No `group` field any more. Five destinations don't need section headers —
// "Today" over three items and "The Firm" over exactly one was more chrome than
// content, and it made Assets read as a separate class of thing when it's just
// the fourth tab. Order is the grouping now.
export const NAV = [
  { key: "brief", label: "Brief" },
  { key: "personal", label: "Personal" },
  { key: "train", label: "Train" },
  // Grocery earns a top-level tab because of WHERE it gets used: standing in a
  // shop, one-handed. Two taps deep inside Personal → Food was the wrong depth
  // for that, whatever its topical home.
  { key: "grocery", label: "Grocery" },
  // Systems folded into Assets, supplying its Usage/Status/Deploy/Supabase/Miner
  // sub-tabs; the page lands on Usage. Mind was removed from the app entirely.
  // App.jsx redirects any stray "systems"/"boardroom" deep link here.
  { key: "assets", label: "Assets" },
  // Upstream is built and deployed but hidden from nav while the pipeline settles.
  // To bring it back, uncomment this line — the page, route, HEADERS entry and the
  // Supabase tables are all still wired.
  // { key: "upstream", label: "Upstream" },
];

const DATE_LINE = (d) =>
  d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

// Large-title copy per page. sub() takes the current Date so the Brief can
// carry the day itself — the calmest possible subtitle.
export const HEADERS = {
  brief: { title: "Brief", sub: (d) => DATE_LINE(d) },
  personal: { title: "Personal", sub: () => "Notes, calendar, and life admin" },
  train: { title: "Train", sub: () => "Log it. Beat last time." },
  grocery: { title: "Grocery", sub: () => "What to buy, and what's already in the cart" },
  assets: { title: "Assets", sub: () => "Everything you own, and what runs it" },
  // Both kept as defensive fallbacks: App.jsx redirects "systems" and the retired
  // "boardroom" to "assets", so the shell should never actually read either — but
  // a header lookup must never crash, and a stale saved link must not render a
  // page titled after a tab that no longer exists.
  systems: { title: "Assets", sub: () => "Everything you own, and what runs it" },
  boardroom: { title: "Assets", sub: () => "Everything you own, and what runs it" },
  upstream: { title: "Upstream", sub: () => "Non-consensus questions · NOSTRADAMUS" },
};
