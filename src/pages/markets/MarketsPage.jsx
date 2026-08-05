// ─── Markets — the tape, in three depths ─────────────────────────────────────
// Crypto is the glance (Bitcoin plus the market's vital signs), Stocks is the
// watchlist, Alt Season is the tool — an hourly screener with a regime score,
// a flag radar, and a graded log. Alt Season is the default sub on purpose:
// it's the one you come here to work in, and the other two are a tap away.
// The Brief keeps its own Markets card; this tab is for sitting with the
// market rather than glancing at it on the way past.
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
  const [sub, setSub] = useState("altseason");
  useEffect(() => {
    if (jump?.page === "markets" && SUBTABS.some(t => t.key === jump.sub)) setSub(jump.sub);
  }, [jump?.t]); // eslint-disable-line react-hooks/exhaustive-deps

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
