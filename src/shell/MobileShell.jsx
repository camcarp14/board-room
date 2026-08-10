// ─── The phone shell ──────────────────────────────────────────────────────────
// A thin safe-area cap (the notch, nothing more), a page scroller whose large
// title carries the settings/refresh controls inline, a compact glass bar that
// takes those same controls over once the large title has scrolled away, a
// pull-to-refresh gauge on the scroller itself, and a native-grammar tab bar.
// The geometry engineering below is field-proven on iOS standalone — treat every
// comment as load-bearing.
import { useState, useRef, useEffect } from "react";
import { NAV, HEADERS } from "./nav.js";
import { TopStatus } from "./TopStatus.jsx";
import { ViewportDiag } from "./ViewportDiag.jsx";
import { NAV_ICONS, IcSettings, IcBoardRoom } from "../ui/icons.jsx";
import { LargeTitle, Spinner } from "../ui/kit.jsx";
import { IS_STANDALONE, useVisualViewport } from "../hooks/index.js";

// ─── pull-to-refresh geometry ────────────────────────────────────────────────
// PTR_ARM is both the arming threshold and the height the gauge rests at while
// the refresh actually runs, and the two being the same number is what makes the
// release quiet. Let go at the threshold and the gap does not move at all — only
// the thing inside it changes (arc → spinner); let go deeper into the band and it
// settles back the short distance to where it armed. Any other run height would
// mean a visible jump at the exact moment the user is watching for an answer.
//
// The damping curve below is the whole feel of the gesture. 0.65 of the finger
// means a 68px drag arms it — comfortably more travel than the 64px App.jsx
// wants for a horizontal tab swipe, so the two gestures don't feel like they're
// competing for the same small movement. Past the arm point the page follows at
// a quarter rate and stops dead at PTR_MAX, which is the "there is nothing more
// to give" signal every native scroller ends on.
const PTR_ARM = 44;
const PTR_MAX = 72;
const PTR_ARC_R = 9;
const PTR_ARC_C = 2 * Math.PI * PTR_ARC_R;
const ptrDamp = (dy) => {
  const raw = dy * 0.65;
  return Math.max(0, Math.min(PTR_MAX, raw <= PTR_ARM ? raw : PTR_ARM + (raw - PTR_ARM) * 0.25));
};

export function MobileShell({ page, navDir, nav = NAV, onNavigate, onOpenSettings, now, dataStamp, refreshing, onRefresh, children }) {
  const { vvh, envTop } = useVisualViewport();
  const diagTaps = useRef({ n: 0, t: 0 });
  const [diagOpen, setDiagOpen] = useState(false);
  const scrollRef = useRef(null);

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
  //
  // ONE ELEMENT, RENDERED TWICE. The large title and the compact bar below get
  // literally the same node, because "the same two buttons" has to stay true as
  // this row changes: anything added here — a fourth control, another chip —
  // arrives in both places or in neither. Only one of the two is ever visible
  // (the compact bar is `visibility: hidden` until the title leaves), so the
  // duplicate pair is never on screen, in the tab order, or in the
  // accessibility tree at the same time.
  const controls = (
    <div className="nav-actions">
      <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings" title="Settings">
        <IcSettings size={19} />
      </button>
      <TopStatus now={now} dataStamp={dataStamp} refreshing={refreshing} onRefresh={onRefresh} compact />
    </div>
  );

  // ─── the compact scrolled header ──────────────────────────────────────────
  // DESIGN.md §7 specified this and it was never built: the sentinel attribute
  // has been sitting on the large title in kit.jsx with no observer anywhere in
  // the app, which meant that on a phone the title, Settings and Refresh all
  // scrolled away and stayed away until you scrolled back to the top. On the
  // app's primary surface, the two controls you reach for most were reachable
  // only from one scroll position.
  //
  // An IntersectionObserver, NOT a scroll listener. A scroll handler on this
  // element would run on every frame of every flick on every page and would
  // have to measure the title to know anything; the observer is the browser
  // telling us the one fact we need, off the main thread, and it costs nothing
  // while you are sitting still.
  //
  // `root` is the scroller, not the viewport — #page-scroll is the only thing
  // that scrolls in this shell, so a viewport-relative observation would never
  // fire at all. And it re-runs on `page` because the large title lives inside
  // the keyed page wrapper: every navigation destroys the old sentinel and
  // builds a new one, and an observer still holding the old node is watching an
  // element that has left the document.
  const [compactOn, setCompactOn] = useState(false);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const sentinel = root.querySelector("[data-lt-sentinel]");
    // No large title on this page means nothing to hand over from. Falling back
    // to "hidden" is the honest answer: an empty bar carrying a title it never
    // read would be chrome asserting something it doesn't know.
    if (!sentinel) { setCompactOn(false); return; }
    // NO rootMargin, deliberately. The tempting version insets the root by the
    // bar's own 48px so the bar arrives exactly as the title slides under it —
    // and it is a hair-trigger: .lt-block's 12px top padding plus a 36.8px
    // line box puts the title's bottom edge at 48.8px, which is 0.8px from
    // firing while the page is sitting at rest at the top. One font-metric
    // change and the bar is permanently on. Waiting for the title to leave
    // completely costs a few tens of pixels of scroll and cannot misfire.
    const io = new IntersectionObserver(([entry]) => setCompactOn(!entry.isIntersecting), { root, threshold: 0 });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [page]);

  // ─── pull to refresh ──────────────────────────────────────────────────────
  // Wired to the same onRefresh the button in the bar calls, so there is exactly
  // one refresh path and one place that can lie about it.
  //
  // WHAT THE GAUGE IS ALLOWED TO SAY. It shows how far you have pulled, and then
  // that a refresh is in flight for exactly as long as onRefresh's promise is
  // unsettled. It never reports success: App's freshness pill is the only thing
  // that gets to say whether data actually landed, because it is the only thing
  // that knows (refreshData stamps per-slice and deliberately does not stamp a
  // total failure). A green tick here would be a second, dumber opinion about
  // the same question, and it would be right by accident at best.
  //
  // WHY THE DOM IS WRITTEN DIRECTLY. The offset tracks a finger, so it changes
  // ~60 times a second; routing that through setState would re-render the whole
  // chrome on every touchmove to move one element four pixels. React state here
  // carries only the four discrete phases — the arc's colour, the spinner
  // swap — which change a handful of times per gesture and bail out for free
  // when the value repeats.
  const ptrWrapRef = useRef(null);   // the content, which travels with the pull
  const ptrGapRef = useRef(null);    // the space the gauge is revealed in
  const ptrArcRef = useRef(null);    // the progress arc's dash offset
  const [ptrPhase, setPtrPhase] = useState("idle"); // idle | pull | armed | run
  // The listeners mount once; the props they need are read through a ref so a
  // new `refreshing` value never re-binds a live gesture out from under itself.
  const ptrProps = useRef(null);
  ptrProps.current = { onRefresh, refreshing };

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    // Read live rather than at mount: a user who turns Reduce Motion on in
    // Settings gets a still app on the next gesture, not on the next reload.
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let start = null;    // { x, y } while this touch is still a candidate
    let claimed = false; // we own the vertical axis for this touch
    let off = 0;         // the rendered offset, in px
    let running = false;

    const paint = (next, animate) => {
      off = next;
      const gap = ptrGapRef.current, wrap = ptrWrapRef.current, arc = ptrArcRef.current;
      if (gap) {
        gap.style.transition = animate ? "height var(--dur-3) var(--ease-out)" : "none";
        gap.style.height = `${next}px`;
      }
      if (wrap) {
        wrap.style.transition = animate ? "transform var(--dur-3) var(--ease-out)" : "none";
        // REDUCED MOTION LOSES THE RUBBER BAND, NOT THE GESTURE. The page never
        // travels; the gauge still comes out and still shows real progress,
        // because the progress is information, not decoration. It surfaces over
        // the top of the content instead of being revealed by it, which is why
        // the gauge wears glass and a shadow in both modes.
        //
        // Clearing the property rather than writing translateY(0) matters: a
        // transform makes this element the containing block for any
        // position:fixed descendant, and the whole app's chrome depends on that
        // NOT happening. At rest there is no transform here at all.
        wrap.style.transform = next > 0 && !reduced?.matches ? `translateY(${next}px)` : "";
      }
      if (arc) {
        arc.style.transition = animate ? "stroke-dashoffset var(--dur-2) var(--ease-out)" : "none";
        arc.style.strokeDashoffset = String(PTR_ARC_C * (1 - Math.min(1, next / PTR_ARM)));
      }
    };

    const settle = () => {
      claimed = false;
      start = null;
      root.removeEventListener("touchmove", onMove);
    };
    // Settle AND put the page back. Every exit that isn't "the refresh is
    // starting" comes through here, including the one that caught me out: a
    // second finger landing mid-pull re-enters onStart, which used to only
    // settle — so the touchmove listener went away with the page still held 40px
    // down and nothing left that would ever move it back. `running` is excluded
    // because a refresh in flight legitimately owns the offset.
    const abandon = () => {
      if (off > 0 && !running) { setPtrPhase("idle"); paint(0, true); }
      settle();
    };

    const onStart = (e) => {
      abandon();
      if (running || ptrProps.current.refreshing) return; // a refresh is already in flight
      if (e.touches.length !== 1) return;                 // pinch/two-finger — not ours
      if (root.scrollTop > 0) return;                     // only from the very top of the page
      const t = e.touches[0];
      // The same shape of guard App.jsx's swipe uses, on the other axis: a drag
      // that begins inside a text control or inside a scroller of its own
      // belongs to that thing. The Wire and Watch This Week are 340–480px tall
      // internal scrollers that fill most of a phone screen, and stealing their
      // first 68px of travel would make them unscrollable from the top.
      let el = t.target;
      while (el && el !== root) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (el.scrollHeight > el.clientHeight + 8) {
          const oy = getComputedStyle(el).overflowY;
          if (oy === "auto" || oy === "scroll") return;
        }
        el = el.parentElement;
      }
      start = { x: t.clientX, y: t.clientY };
      // NON-PASSIVE, AND ONLY NOW. Cancelling the scroller's own overscroll is
      // the only way this pull and iOS's rubber band aren't both moving the page
      // at once, and that needs preventDefault, which needs a non-passive
      // listener. A permanently-registered one would make the browser wait on JS
      // for every touchmove of every flick on every page — so it is attached
      // for the life of one candidate gesture and detached the moment the touch
      // ends. Scrolling anywhere below the top never pays for it.
      root.addEventListener("touchmove", onMove, { passive: false });
    };

    const onMove = (e) => {
      if (!start || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x, dy = t.clientY - start.y;
      if (!claimed) {
        // NO WAITING PERIOD ON THE CLAIM, and that is the difference between a
        // pull that works and one that argues with the rubber band all the way
        // down. iOS decides what a gesture is on the first touchmove it is
        // allowed to keep: a "let the finger travel 6px before deciding" version
        // hands the overscroll to Safari on move one and then spends the rest of
        // the drag with two things moving the page. Claiming on the first
        // downward-and-vertical sample costs nothing, because at scrollTop 0
        // downward is the one direction where the native answer is the bounce
        // and never a scroll — so this can only ever take something Safari was
        // going to throw away.
        if (dy > 0 && dy > Math.abs(dx)) claimed = true;
        // Anything else, once it is past jitter, is somebody else's gesture — a
        // scroll or App.jsx's tab swipe — and is refused for the rest of this
        // touch without ever having called preventDefault on it.
        else if (Math.max(Math.abs(dx), Math.abs(dy)) >= 4) { settle(); return; }
        else return;
      }
      // Dragged back up past where it started: hand the gesture back rather than
      // sitting at zero eating a scroll the user is plainly trying to do.
      if (dy <= 0) { paint(0, false); setPtrPhase("idle"); settle(); return; }
      // THE HORIZONTAL SWIPE WINS TIES, AND THIS IS THE EXACT COMPLEMENT OF ITS
      // TEST. App.jsx (~line 429) switches tabs when |dx| ≥ 64 AND
      // |dx| ≥ 2.2·|dy|; refusing on precisely that second inequality means no
      // gesture on earth can satisfy both conditions, so a diagonal drag can
      // never both change tabs and fire a refresh. Checked on every move, not
      // just at the end, so a pull that turns into a swipe lets go of the page
      // as it turns instead of snapping back afterwards.
      if (Math.abs(dx) >= 2.2 * Math.abs(dy)) { paint(0, true); setPtrPhase("idle"); settle(); return; }
      if (e.cancelable) e.preventDefault();
      const next = ptrDamp(dy);
      paint(next, false);
      setPtrPhase(next >= PTR_ARM ? "armed" : "pull");
    };

    const onEnd = (e) => {
      if (!claimed) { abandon(); return; }
      const t = e.changedTouches?.[0];
      const dx = t ? t.clientX - start.x : 0, dy = t ? t.clientY - start.y : 0;
      settle();
      // The complement test again, on the final delta this time — belt and
      // braces on the one rule that keeps the two gestures apart.
      if (off < PTR_ARM || Math.abs(dx) >= 2.2 * Math.abs(dy)) { setPtrPhase("idle"); paint(0, true); return; }
      running = true;
      setPtrPhase("run");
      paint(PTR_ARM, true);
      // The spinner's lifetime IS the refresh's lifetime. refreshData resolves
      // when its reads have all settled (it uses allSettled and never rejects),
      // and if it early-returns because there is no session the promise settles
      // immediately and the gauge just retracts — nothing happened, so nothing
      // is claimed. Promise.resolve wraps it because onRefresh is a prop and
      // this must not depend on it being async.
      Promise.resolve().then(() => ptrProps.current.onRefresh?.()).catch(() => {}).then(() => {
        running = false;
        setPtrPhase("idle");
        paint(0, true);
      });
    };

    const onCancel = () => { abandon(); };

    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchend", onEnd, { passive: true });
    root.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onCancel);
      root.removeEventListener("touchmove", onMove);
    };
  }, []);

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

      <div id="page-scroll" ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", touchAction: "pan-y" }}>
        {/* THE COMPACT HEADER IS A STICKY FIRST CHILD OF THE SCROLLER, not a
            fixed overlay, and that is not a stylistic preference. Everything
            about this shell's vertical geometry — the vvh-pinned height, the
            statuscap above, the in-flow tab bar below, the keyboard collapse —
            was won by taking things OUT of the fixed-position coordinate systems
            iOS standalone lies about. A new fixed element here would have to be
            told where the safe areas and the keyboard are all over again, and
            would be wrong the first time one of them moved. Sticky inside the
            scroller is measured by the scroller, which cannot be lied to.

            The perch is zero-height on purpose: the bar inside it overflows
            downward and floats over the content, so the page's own layout is
            byte-for-byte what it was before this existed. A bar that took 48px
            of flow would push every page down by a bar's worth of nothing
            whenever it was invisible, which is most of the time. */}
        <div className="cbar-perch">
          <div className={`cbar${compactOn ? " on" : ""}`}>
            {/* An empty cell the exact width of the control cluster opposite,
                which is what actually centres the title. Absolute centring was
                the alternative and it collides: with the unsaved chip showing,
                the right cluster reaches past the middle of a 360px phone, and
                a centred title would sit under it. This way the title is
                perfectly centred in the ordinary case and slides left by half
                the chip's width when there is a failed write to report —
                exactly what UIKit does with a wide bar-button item, and only
                ever in the state where something is already wrong. */}
            <span className="cbar-mirror" aria-hidden="true" />
            <span className="cbar-title">{head.title}</span>
            {controls}
          </div>
        </div>

        {/* The pull-to-refresh gauge, in its own zero-height perch so it sits
            still at the top of the scrollport while the content travels past
            it. Below the compact bar in z-order, which never matters in
            practice — a pull can only start at scrollTop 0 and the bar is only
            visible above it — but ordering them by hand beats finding out. */}
        <div className="ptr-perch">
          <div className="ptr-gap" ref={ptrGapRef}>
            <span
              className={`ptr-gauge${ptrPhase === "armed" ? " armed" : ""}${ptrPhase === "run" ? " running" : ""}`}
              {...(ptrPhase === "run"
                ? { role: "status", "aria-label": "Refreshing data" }
                // Hidden from assistive tech while it is only tracking a finger.
                // A pull is a gesture VoiceOver users don't perform, and the
                // Refresh button two inches away is already labelled and does
                // the identical thing — announcing a live progress value for a
                // drag nobody is dragging is noise pretending to be access.
                : { "aria-hidden": true })}
            >
              <svg className="ptr-ring" width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <circle className="ptr-track" cx="11" cy="11" r={PTR_ARC_R} strokeWidth="1.8" />
                <circle
                  ref={ptrArcRef} className="ptr-arc" cx="11" cy="11" r={PTR_ARC_R}
                  strokeWidth="1.8" strokeLinecap="round"
                  strokeDasharray={PTR_ARC_C} strokeDashoffset={PTR_ARC_C}
                  transform="rotate(-90 11 11)"
                />
              </svg>
              {ptrPhase === "run" && <Spinner size={17} />}
            </span>
          </div>
        </div>

        {/* The travelling half of the pull. It has to be a wrapper OUTSIDE the
            keyed page div: that div's entrance animation (.pagefade /
            .pageslide-*) is declared `both`, so its final transform keeps
            winning over anything written to the element's own style for as long
            as it stays mounted — an inline translateY there would silently do
            nothing forever. */}
        <div className="ptr-wrap" ref={ptrWrapRef}>
          <div key={page} className={navDir === "l" ? "pageslide-l" : navDir === "r" ? "pageslide-r" : "pagefade"} style={{ display: "flex", flexDirection: "column", flex: 1, paddingBottom: 20 }}>
            {/* The house mark rides beside every page title. The rail carries it on
                desktop; phone has no rail, so this header is the only place the
                app says whose room you're in. It tints itself off --accent* — see
                IcBoardRoom — so it follows the palette without anything here. */}
            <LargeTitle title={head.title} sub={sub} trailing={controls} leading={<IcBoardRoom size={26} />} onTitleTap={onBarTap} />
            {children}
          </div>
        </div>
      </div>

      {/* The tab bar — last flex child, IN FLOW. Every positioned approach
          (dvh, fixed-inset, visualViewport, lvh) got lied to by some iOS
          standalone coordinate system; normal flow at the bottom of the
          flex column cannot be. Hidden entirely while the keyboard is up. */}
      <div className="dock-wrap" style={{ flex: "none", display: keyboardOpen ? "none" : undefined }}>
        <nav className="dock" aria-label="Primary">
          {nav.map(n => {
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
