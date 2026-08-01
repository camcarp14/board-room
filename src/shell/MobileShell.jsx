// ─── The phone shell ──────────────────────────────────────────────────────────
// A thin safe-area cap (the notch, nothing more), a page scroller whose large
// title carries the theme/search/refresh controls inline, and a native-grammar
// tab bar. No pinned header bar — the controls scroll away with the title so
// they never own a full row of the screen. The geometry engineering below is
// field-proven on iOS standalone — treat every comment as load-bearing.
import { useState, useRef } from "react";
import { NAV, HEADERS } from "./nav.js";
import { TopStatus } from "./TopStatus.jsx";
import { ViewportDiag } from "./ViewportDiag.jsx";
import { NAV_ICONS, IcSettings } from "../ui/icons.jsx";
import { LargeTitle } from "../ui/kit.jsx";
import { IS_STANDALONE, useVisualViewport } from "../hooks/index.js";

export function MobileShell({ page, navDir, onNavigate, onOpenSettings, now, dataStamp, refreshing, onRefresh, children }) {
  const { vvh, envTop } = useVisualViewport();
  const diagTaps = useRef({ n: 0, t: 0 });
  const [diagOpen, setDiagOpen] = useState(false);

  // Five quick taps on the page title open the viewport diagnostics.
  const onBarTap = () => {
    const t = Date.now();
    const d = diagTaps.current;
    d.n = t - d.t < 2000 ? d.n + 1 : 1;
    d.t = t;
    if (d.n >= 5) { d.n = 0; setDiagOpen(true); }
  };

  // When the keyboard eats most of the viewport, slide the tab bar away
  // instead of letting it hover mid-screen.
  const keyboardOpen = vvh != null && window.screen?.height ? vvh < window.screen.height * 0.72 : false;
  // visualViewport is the ONLY height this window can actually render.
  // Field-proven on device (day-theme letterbox showed WHITE under a beige
  // canvas): 100vh/100lvh report the full screen, but iOS standalone clips
  // everything below vvh — content sized past it gets cut, never shown.
  const shellHeight = vvh == null ? "100%" : `${vvh}px`;
  // Letterboxed standalone window: renderable height falls short of the
  // screen WHILE the window is top-anchored under the status bar
  // (envTop > 0). There the OS strip already clears the home indicator and
  // the reported env(bottom) is dead space — collapse the tab bar to its
  // tight browser-mode geometry. A healthy below-status-bar window
  // (envTop 0) keeps the native inset even though vvh < screen.height.
  const letterboxed = IS_STANDALONE && vvh != null && window.screen?.height ? (window.screen.height - vvh >= 20 && envTop > 0) : false;

  const head = HEADERS[page];
  // Optional now — only the Brief still carries one (today's date). LargeTitle
  // renders nothing for a falsy sub, so the title closes up rather than
  // holding an empty line open.
  const sub = head.sub?.(new Date(now));

  // Theme moved into Settings, where it's three labelled choices instead of a
  // cycling icon whose current state you had to infer — and where sign-out and
  // the calendar feed live too. Four icons in this row was already the ceiling.
  const controls = (
    <div className="nav-actions">
      <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings" title="Settings">
        <IcSettings size={19} />
      </button>
      <TopStatus now={now} dataStamp={dataStamp} refreshing={refreshing} onRefresh={onRefresh} compact />
    </div>
  );

  return (
    <div className={letterboxed ? "lbx" : undefined} style={{ position: "fixed", top: 0, left: 0, right: 0, height: shellHeight, display: "flex", flexDirection: "column", color: "var(--ink)", overflow: "hidden" }}>
      {/* Notch reservation ONLY — the status-bar zone, no header bar. Content
          starts right below it; the title + controls live in the scroller.

          TRANSPARENT, not var(--bg). Now that the window runs under the status
          bar (index.html), whatever is behind the shell paints this strip — and
          what's behind the shell is the ambient wash, which is a gradient. A
          flat --bg fill here would have swapped iOS's grey cap for our own: the
          same hard edge, one shade closer. Letting it through is the only way
          the top of the screen is genuinely the same surface as the rest.
          .statuscap carries the one thing it does need — see components.css. */}
      <div className="statuscap" />

      <div id="page-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", touchAction: "pan-y" }}>
        <div key={page} className={navDir === "l" ? "pageslide-l" : navDir === "r" ? "pageslide-r" : "pagefade"} style={{ display: "flex", flexDirection: "column", flex: 1, paddingBottom: 20 }}>
          <LargeTitle title={head.title} sub={sub} trailing={controls} onTitleTap={onBarTap} />
          {children}
        </div>
      </div>

      {/* The tab bar — last flex child, IN FLOW. Every positioned approach
          (dvh, fixed-inset, visualViewport, lvh) got lied to by some iOS
          standalone coordinate system; normal flow at the bottom of the
          flex column cannot be. Hidden entirely while the keyboard is up. */}
      <div className="dock-wrap" style={{ flex: "none", display: keyboardOpen ? "none" : undefined }}>
        <nav className="dock" aria-label="Primary">
          {NAV.map(n => {
            const active = page === n.key;
            const Icon = active ? NAV_ICONS[n.key].fill : NAV_ICONS[n.key].line;
            return (
              <button key={n.key} className={`dock-tab${active ? " active" : ""}`} onClick={() => onNavigate(n.key)} title={n.label} aria-label={n.label} aria-current={active ? "page" : undefined}>
                <span className="dock-icon"><Icon size={25} /></span>
                <span className="dock-label">{n.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {diagOpen && <ViewportDiag onClose={() => setDiagOpen(false)} />}
    </div>
  );
}
