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
  // Mind and Systems both fold into Assets — Mind is the Assets page's first
  // sub-tab (with its own Mind/Neurons/Learn sub-sub-tabs), Systems supplies the
  // Usage/Status/Deploy/Supabase/Miner sub-tabs. App.jsx redirects any stray
  // "boardroom"/"systems" deep link to the right Assets sub-tab.
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
  boardroom: { title: "Mind", sub: () => "The mind behind the delegate" },
  assets: { title: "Assets", sub: () => "Everything you own, and what runs it" },
  // Kept as a defensive fallback: App.jsx redirects "systems" → "assets", so the
  // shell should never actually read this — but a header lookup must never crash.
  systems: { title: "Assets", sub: () => "Everything you own, and what runs it" },
  upstream: { title: "Upstream", sub: () => "Non-consensus questions · NOSTRADAMUS" },
};
