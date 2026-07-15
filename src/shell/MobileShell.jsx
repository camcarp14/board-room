// ─── The phone shell ──────────────────────────────────────────────────────────
// Glass nav bar (compact title fades in as the page's large title scrolls
// away), page scroller, and a native-grammar tab bar. The geometry engineering
// below is field-proven on iOS standalone — treat every comment as load-bearing.
import { useState, useRef, useEffect } from "react";
import { NAV, HEADERS } from "./nav.js";
import { TopStatus } from "./TopStatus.jsx";
import { ThemeToggle } from "./Boot.jsx";
import { ViewportDiag } from "./ViewportDiag.jsx";
import { NAV_ICONS, IcSearch } from "../ui/icons.jsx";
import { LargeTitle } from "../ui/kit.jsx";
import { IS_STANDALONE, useVisualViewport } from "../hooks/index.js";

export function MobileShell({ page, navDir, theme, onNavigate, onSummon, now, dataStamp, refreshing, onRefresh, children }) {
  const { vvh, envTop } = useVisualViewport();
  const [scrolled, setScrolled] = useState(false);
  const diagTaps = useRef({ n: 0, t: 0 });
  const [diagOpen, setDiagOpen] = useState(false);
  const scrollerRef = useRef(null);

  // Five quick taps on the nav bar open the viewport diagnostics.
  const onBarTap = () => {
    const t = Date.now();
    const d = diagTaps.current;
    d.n = t - d.t < 2000 ? d.n + 1 : 1;
    d.t = t;
    if (d.n >= 5) { d.n = 0; setDiagOpen(true); }
  };

  // The compact bar title appears only once the large title has scrolled away.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setScrolled(el.scrollTop > 44));
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { cancelAnimationFrame(raf); el.removeEventListener("scroll", onScroll); };
  }, []);
  useEffect(() => { setScrolled((scrollerRef.current?.scrollTop || 0) > 44); }, [page]);

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
  const sub = head.sub(new Date(now));

  return (
    <div className={letterboxed ? "lbx" : undefined} style={{ position: "fixed", top: 0, left: 0, right: 0, height: shellHeight, display: "flex", flexDirection: "column", color: "var(--ink)", overflow: "hidden" }}>
      <div className={`nav-bar${scrolled ? " scrolled" : ""}`} onClick={onBarTap}>
        <span className="nav-bar-title">{head.title}</span>
        <span /* left spacer keeps the actions right-aligned */ />
        <div className="nav-actions" onClick={e => e.stopPropagation()}>
          <ThemeToggle theme={theme} />
          <button className="icon-btn" onClick={onSummon} aria-label="Summon — search everything" title="Summon">
            <IcSearch size={19} />
          </button>
          <TopStatus now={now} dataStamp={dataStamp} refreshing={refreshing} onRefresh={onRefresh} compact />
        </div>
      </div>

      <div id="page-scroll" ref={scrollerRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", touchAction: "pan-y" }}>
        <div key={page} className={navDir === "l" ? "pageslide-l" : navDir === "r" ? "pageslide-r" : "pagefade"} style={{ display: "flex", flexDirection: "column", flex: 1, paddingBottom: 20 }}>
          <LargeTitle title={head.title} sub={sub} />
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
