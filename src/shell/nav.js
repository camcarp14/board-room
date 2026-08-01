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
  // Creed came out of Personal for the same reason Grocery and Train did: it's
  // something you consult against a decision, and three taps deep behind a pill
  // row is the wrong depth for that. Filed between birthdays and movies it read
  // as one more list; on the bar it reads as a standing commitment.
  { key: "creed", label: "Creed" },
  // Grocery earns a top-level tab because of WHERE it gets used: standing in a
  // shop, one-handed. Two taps deep inside Personal → Food was the wrong depth
  // for that, whatever its topical home.
  { key: "grocery", label: "Grocery" },
  // Assets is no longer a destination. Its last three sub-tabs — Usage, Status,
  // Miner — moved into the Settings sheet's Systems tab, because none of them is
  // somewhere you GO: they're things you check, on the same footing as which
  // theme you're in. Four tabs that are all daily surfaces beats five where the
  // last one is a machine room. App.jsx sends any stray "assets"/"systems"/
  // "boardroom" deep link to the Brief.
  // Upstream is built and deployed but hidden from nav while the pipeline settles.
  // To bring it back, uncomment this line — the page, route, HEADERS entry and the
  // Supabase tables are all still wired.
  // { key: "upstream", label: "Upstream" },
];

const DATE_LINE = (d) =>
  d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

// Large-title copy per page.
//
// The taglines are gone — "Everything you own, and what runs it", "Log it. Beat
// last time.", and the rest. They described the tab you had already chosen to
// open, to someone who had already opened it: a line of copy under every title
// that you read once and then spent months scrolling past. The title carries the
// page now.
//
// The Brief keeps its sub, because it isn't a tagline — it's today's date, which
// is information you actually want and can't get from the word "Brief". `sub` is
// therefore OPTIONAL from here on, and both shells render nothing when it's
// absent rather than an empty line holding space open.
export const HEADERS = {
  brief: { title: "Brief", sub: (d) => DATE_LINE(d) },
  personal: { title: "Personal" },
  train: { title: "Train" },
  creed: { title: "Creed" },
  grocery: { title: "Grocery" },
  upstream: { title: "Upstream" },
};
