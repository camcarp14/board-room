// ─── Markets — the tape, in three depths ─────────────────────────────────────
// Alt Season is the read — the cycle dial, the capital ladder, your book, then
// narratives and the graded log. Crypto is the board (Bitcoin, then every
// screened coin with all five change windows). Stocks is the watchlist.
//
// ALT SEASON IS THE DEFAULT, and this is the third time the default has moved.
// It shipped as Alt Season, lost to Crypto, and is back — but the reason is a
// change in the artifact, not a change of mind, so both prior arguments still
// deserve an answer.
//
// The argument that won last time was sound at the time: opening a markets tab
// is a reflex, the reflex wants prices, and Alt Season was a read you went to
// deliberately — a 0–100 score you could not act on, over four lists of coins.
// Landing there meant landing on homework.
//
// What changed is that the panel no longer opens with a number or a list. It
// opens with one sentence telling you what to do about the tape, and under it a
// six-rung picture of where capital actually is. That is a better answer to the
// reflex than a price grid: a price you already half-know, and the instruction
// you don't. The layer ordering inside the panel makes the same argument one
// level down — the read comes before the rows, everywhere.
//
// The tab order follows the default rather than being left as it was, because a
// first tab that is not the landing tab reads as a bug every time you see it.
// Crypto keeps everything it had and is one tap away.
import { lazy, Suspense, useState, useEffect } from "react";
import { Segmented } from "../../ui/kit.jsx";

// All three stay lazy, and Alt Season staying lazy matters MORE now that it is
// the default, not less: the chunk it pulls is the biggest of the three, and
// the bundle that has to paint the Brief is not the place for it. Landing here
// costs one chunk fetch on navigation, which is what the Suspense skeleton
// below is sized to cover.
const CryptoPanel = lazy(() => import("./CryptoPanel.jsx").then(m => ({ default: m.CryptoPanel })));
const StocksPanel = lazy(() => import("./StocksPanel.jsx").then(m => ({ default: m.StocksPanel })));
const AltSeasonPanel = lazy(() => import("./AltSeasonPanel.jsx"));

const SUBTABS = [
  { key: "altseason", label: "Alt Season" },
  { key: "crypto", label: "Crypto" },
  { key: "stocks", label: "Stocks" },
];
// The landing sub, named once. SUBTABS[0] would read as the same thing and
// isn't: it ties "which tab is first" to "which tab opens", and those are two
// decisions that have already disagreed once in this file's history.
const DEFAULT_SUB = "altseason";

// settings/updateSetting ride along unused for now — every page takes them, and
// the stocks sub will want a configurable watchlist when it grows past four tiles.
export function MarketsPage({ isMobile, btc, jump, settings, updateSetting }) { // eslint-disable-line no-unused-vars
  const [sub, setSub] = useState(DEFAULT_SUB);
  useEffect(() => {
    if (jump?.page === "markets" && SUBTABS.some(t => t.key === jump.sub)) setSub(jump.sub);
  }, [jump?.t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Land at the top — on arrival AND on every sub switch.
  //
  // THE REAL CULPRIT WAS NOT HERE, and this effect could not have caught it:
  // PillRow used to call scrollIntoView on mount, which scrolls every
  // scrollable ancestor, so the Movers pill strip — four cards down the Alt
  // Season panel — dragged #page-scroll to itself the moment the lazy panel
  // rendered, ~160px past the top, smoothly, and long after both resets below
  // had already run. Fixed at the source in ui/kit.jsx. What follows still
  // earns its place for the reasons written under it, but if this tab ever
  // opens mid-page again, look for something that scrolls ITSELF into view
  // before touching this.
  //
  // The tab opened mid-page: App's own nav handler scrolls the shell back up,
  // but it does that with `behavior: "smooth"` against a page whose panels are
  // lazy. The animation starts over a 220px Suspense skeleton and is still
  // running when the real panel (sixty board rows) lands underneath it, so the
  // scroller settles wherever the newly-tall content left the in-flight
  // animation — which on a phone is around the middle of the board. Setting
  // scrollTop directly is instant and has no window for the content to grow
  // inside. Runs on mount too, since `sub` is set on the first render.
  // Twice: once now, once on the next frame. App's handler schedules its
  // smooth scroll in a rAF of its own and only starts one when scrollTop is
  // already > 0, so the second reset both lands after that check (leaving
  // nothing to animate) and catches the case where this page mounted first.
  useEffect(() => {
    const el = document.getElementById("page-scroll");
    if (!el) return undefined;
    el.scrollTop = 0;
    const raf = requestAnimationFrame(() => { el.scrollTop = 0; });
    return () => cancelAnimationFrame(raf);
  }, [sub]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0, padding: isMobile ? "0 16px" : 0 }}>
        <Segmented options={SUBTABS} value={sub} onChange={setSub} style={{ marginBottom: 12, flex: "none" }} />
        {/* key={sub} restarts the fade on every switch — do not lose the key. */}
        <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <Suspense fallback={<div className="sk" style={{ height: 220, borderRadius: 18 }} />}>
            {sub === "crypto" && <CryptoPanel isMobile={isMobile} btc={btc} />}
            {sub === "stocks" && <StocksPanel isMobile={isMobile} />}
            {sub === "altseason" && <AltSeasonPanel isMobile={isMobile} />}
          </Suspense>
        </div>
      </div>
    </div>
  );
}

export default MarketsPage;
