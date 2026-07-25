// ─── The ventures — the single source of truth for the properties ───────────
// Lives in its own module so both the Assets page (properties list + auditor)
// and the Systems tabs (Deploy + Replace-a-File) can import it without a
// circular dependency. The array shape
// (name/desc/url/appUrl/color/repo/site/assetsOnly/cta) is load-bearing:
// netlify/functions/deploy.js treats `site` as the Netlify slug, the auditor
// reads `repo`, and `assetsOnly` keeps a venture out of the deploy controls.
// ZTS, Clarify Outreach, Runway, and Macro were unified into one app — "The
// Pentagon" (https://the-pentagon.netlify.app) — so their four appUrls now all
// point there. Their old standalone Netlify sites (zts-command-center,
// clarify-outreach, runway-command-center, macro-command-center) are retired
// and DELETED; the shared site's tool toggle switches between them.
// Because the code moved into the monorepo (GitHub repo `camcarp14/the-pentagon`,
// formerly `zts-command-center`), the retired per-app repos are gone too: the
// `repo` pointers below follow the code to the monorepo (auto-fix probes
// apps/shell/ there — see REPO_DIRS in netlify/functions/auto-fix.js), and
// Macro's `site` slug follows the deploy target to the-pentagon. Pointing either
// at a deleted repo/site 404s. Keep `repo` on the CURRENT name: GitHub redirects
// reads after a rename, but auto-fix commits via a PUT that won't follow that
// redirect, so a stale name breaks Approve while propose still appears to work.
export const PROPERTIES = [
  { name: "Zero To Secure", desc: "Premium seed phrase backup", url: "https://zerotosecure.com", appUrl: "https://the-pentagon.netlify.app", color: "var(--green)", repo: "camcarp14/the-pentagon", site: "zero-to-secure" },
  { name: "Clarify Paid Search", desc: "Boutique Google Ads agency", url: "https://clarifypaidsearch.com", appUrl: "https://the-pentagon.netlify.app", color: "var(--amber)", repo: "camcarp14/the-pentagon", site: "clarify-paid-search" },
  { name: "Clarify SaaS", desc: "Google Ads auditing tool", url: null, appUrl: "https://clarify-saas.netlify.app/", color: "var(--pink)", repo: "camcarp14/clarify-saas", site: "clarify-saas" },
  { name: "Macro Command Center", desc: "Markets, portfolio, thesis", url: null, appUrl: "https://the-pentagon.netlify.app", color: "var(--blue)", repo: "camcarp14/the-pentagon", site: "the-pentagon" },
  // assetsOnly: shown as reference cards on Assets (link + live status) but kept
  // out of the Systems deploy/replace controls, since their Netlify slugs and
  // repos aren't wired up here and FFSR's two views share one site.
  { name: "Runway", desc: "Job-search command board", url: null, appUrl: "https://the-pentagon.netlify.app", color: "var(--purple)", repo: null, site: null, assetsOnly: true },
  // FFSR: one card, two links — main site + the /team management view, the same
  // Site ›/Command Center › two-button layout Zero To Secure uses.
  { name: "FFSR", desc: "Main site & team management", url: "https://ffsr.netlify.app/#/", appUrl: "https://ffsr.netlify.app/#/team", color: "var(--pink)", repo: null, site: null, assetsOnly: true, cta: "Management Center ›" },
];
