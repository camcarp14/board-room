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
  // PLAN IS THE NINTH, AND SECOND. The note on Guitar below said a ninth needs
  // its own measurement rather than this paragraph, so here it is — the same
  // method that produced Guitar's numbers (the real dock CSS and Inter, rendered
  // in Chromium at 3x, widths read off the DOM; it reproduces the eight-tab
  // figures below to the tenth of a pixel):
  //
  //   375pt   columns 41.0px, "Personal" 43.1 · "Finances" 44.5 · 0 clipped
  //   390pt   columns 43.2px, "Finances" 44.5                    · 0 clipped
  //   320pt   columns 30.5–44.5px, flex giving the long ones room · 0 clipped
  //
  // Nothing truncates at any of the three widths — the bar Guitar was held to —
  // and that bar turned out to be the wrong one. With equal columns, "Markets"
  // and "Finances" sat 0.5px apart at 375pt and the screenshot read
  // "MarketsFinances". So a bar of nine also gets `.dock-crowded` (MobileShell,
  // components.css): padding inside each tab, bounded by the viewport so the bar
  // can never be wider than the screen (a flat 3px pushed the last tab off a
  // 320pt phone entirely). At 375pt and up every gap between labels is ≥6px; at
  // 320pt the bar fits exactly with ~1px gaps, which is where eight tabs already
  // were there. Columns vary (36.7–50.5px at 375pt). Hide a tab in Settings →
  // Tabs and the bar goes back to even columns. A tenth has no room left to find.
  //
  // Second because it is a morning surface like the Brief: the Brief is what the
  // day holds, the Plan is how it's meant to go. It is also the tab that matters
  // most on the morning you're least inclined to open it. (A saved order from
  // Settings → Tabs that predates this key gets it appended at the end, like
  // every new tab — drag it up there.)
  { key: "plan", label: "Plan" },
  { key: "personal", label: "Personal" },
  { key: "train", label: "Train" },
  // Creed came out of Personal for the same reason Grocery and Train did: it's
  // something you consult against a decision, and three taps deep behind a pill
  // row is the wrong depth for that. Filed between birthdays and movies it read
  // as one more list; on the bar it reads as a standing commitment.
  { key: "creed", label: "Creed" },
  // Dreams is a SUB-TAB of Creed, not a destination of its own — same argument
  // from two directions, and six tabs to reach a wall you look at rather than
  // work in was one too many. App.jsx remaps the retired "dreams" page key.
  // Grocery earns a top-level tab because of WHERE it gets used: standing in a
  // shop, one-handed. Two taps deep inside Personal → Food was the wrong depth
  // for that, whatever its topical home.
  { key: "grocery", label: "Grocery" },
  // Markets sits between Grocery and Finances so the two money tabs read as a
  // cluster at the end of the bar. It's a daily check-in surface (the alt
  // radar refreshes hourly), which is why it earns a bar slot at all.
  { key: "markets", label: "Markets" },
  // Finances is last because it's the one you visit deliberately rather than
  // pass through — everything before it is a daily surface. The old comment
  // here called six tabs the ceiling and a seventh impossible; that was
  // derived from a 65px column budget, which was generous. Measured for real:
  // at seven tabs a 375pt phone gives each column ~53px, and the longest
  // labels ("Finances", "Personal") set at 10px/600 run ~46px — tight but
  // clear. SEVEN IS THE CEILING NOW; an eighth genuinely doesn't fit, and the
  // proof burden for anyone tempted is a screenshot at 375pt, not arithmetic.
  { key: "finances", label: "Finances" },
  // GUITAR IS THE EIGHTH, AND THE NOTE ABOVE SAID AN EIGHTH DOESN'T FIT. It also
  // said the proof burden was a screenshot at 375pt rather than arithmetic, so
  // here is the screenshot's numbers — the real dock CSS rendered in Chromium,
  // label widths read off the DOM rather than estimated:
  //
  //   375pt (iPhone 12–15)  columns 46.9px · "Finances" 44px · 2.9px gutter · 0 clipped
  //   390pt                 columns 48.8px · "Finances" 44px · 4.8px gutter · 0 clipped
  //   320pt (SE, 1st gen)   columns 38.8–44.2px, flex giving the long labels
  //                         their width back · 0.2px gutter · 0 clipped
  //
  // Tight, and it reads. The old estimate ("~46px labels in ~53px columns") was
  // measuring the labels about two pixels generously; at 10px/600 Inter,
  // "Finances" is 44px and "Personal" is 43px. Nothing is truncated at any of the
  // three widths, including the narrowest phone anybody still runs this on.
  //
  // Two things follow, and both are done rather than promised. `.dock-label` now
  // carries text-overflow: ellipsis, so if a ninth ever arrives the failure is a
  // legible "Financ…" instead of a letter sliced down the middle. And the burden
  // stays where it was: a ninth needs its own measurement, not this paragraph.
  //
  // On placement: last, after Finances, because it is the one tab that is not
  // about the day's business at all. It is also the one most likely to be used on
  // a tablet propped against something with a guitar in your hands, where the
  // sidebar has no ceiling worth worrying about.
  { key: "guitar", label: "Guitar" },
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
  // The bar says "Plan" because nine labels share 375 points; the page has the
  // room to say what it is.
  plan: { title: "Daily Plan" },
  personal: { title: "Personal" },
  train: { title: "Train" },
  creed: { title: "Creed" },
  grocery: { title: "Grocery" },
  markets: { title: "Markets" },
  finances: { title: "Finances" },
  guitar: { title: "Guitar" },
  upstream: { title: "Upstream" },
};
