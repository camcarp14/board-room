// ─── Markets — the tape, in three depths ─────────────────────────────────────
// Crypto is the board (Bitcoin, then every screened coin with all five change
// windows), Stocks is the watchlist, Alt Season is the read — a regime score,
// a flag radar, and a graded log over the same hourly screener.
//
// CRYPTO IS THE DEFAULT, and it was Alt Season for exactly one build. The
// argument for Alt Season was that it's the surface you come here to work in;
// the argument that beat it is that opening a markets tab is a reflex, and the
// reflex wants prices. Alt Season is a read you go to deliberately, which
// makes it the wrong thing to have to tap past every single time.
import { lazy, Suspense, useState, useEffect } from "react";
import { Segmented } from "../../ui/kit.jsx";

// All three lazy — Alt Season carries the heaviest panel and none of them
// belongs in the bundle that paints the Brief.
const CryptoPanel = lazy(() => import("./CryptoPanel.jsx").then(m => ({ default: m.CryptoPanel })));
const StocksPanel = lazy(() => import("./StocksPanel.jsx").then(m => ({ default: m.StocksPanel })));
const AltSeasonPanel = lazy(() => import("./AltSeasonPanel.jsx"));

const SUBTABS = [
  { key: "crypto", label: "Crypto" },
  { key: "stocks", label: "Stocks" },
  { key: "altseason", label: "Alt Season" },
];

// settings/updateSetting ride along unused for now — every page takes them, and
// the stocks sub will want a configurable watchlist when it grows past four tiles.
export function MarketsPage({ isMobile, btc, jump, settings, updateSetting }) { // eslint-disable-line no-unused-vars
  const [sub, setSub] = useState("crypto");
  useEffect(() => {
    if (jump?.page === "markets" && SUBTABS.some(t => t.key === jump.sub)) setSub(jump.sub);
  }, [jump?.t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Land at the top — on arrival AND on every sub switch.
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
