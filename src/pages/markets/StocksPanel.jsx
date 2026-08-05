// ─── Stocks — the watchlist, and honestly nothing more ───────────────────────
// Four tiles: spot gold (COMEX front month) and the names worth watching.
// Deliberately a placeholder — this sub-tab exists so Markets has a stocks
// address when a real tool grows here, not to pretend four quotes are one.
// Same tiles as the Brief's Markets card; here they get the full-width grid
// and each one taps to its own chart.
import { lazy, Suspense, useState } from "react";
import { T } from "../../theme.js";
import { Card, StatTile, Button, Dot } from "../../ui/kit.jsx";
import { CARD_STATES } from "../../ui/shared.jsx";
import { callFnFull } from "../../lib/functions.js";
import { useStockQuotes } from "../../data/altseason.js";

// Lazy — lightweight-charts stays in its own chunk until a chart is opened.
const BtcChartModal = lazy(() => import("../../BtcChartModal.jsx"));

// Keys match the markets function's payload; labels are display-only.
const TICKERS = [
  ["Gold", "gold"],
  ["NVDA", "nvda"],
  ["MSTR", "mstr"],
  ["STRC", "strc"],
];

/* Same anatomy as the Brief's FeedFallbackRow, trimmed to the states an open
   (keyless) quote feed can actually reach. */
function FallbackRow({ detail, onRetry }) {
  return (
    <div style={{ background: "var(--surface-2)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 13px", minHeight: 52 }}>
      <Dot tone={CARD_STATES.error.color} />
      <span className="t-foot" style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>{detail || "Quotes unavailable."}</span>
      <Button kind="quiet" size="sm" style={{ height: 44, flex: "none" }} onClick={onRetry}>Retry</Button>
    </div>
  );
}

export function StocksPanel({ isMobile }) {
  const q = useStockQuotes();
  const [tickerChart, setTickerChart] = useState(null); // {key,label} of the open chart

  const tileGrid = { display: "grid", gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card pad="md">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
          <span className="t-head">Watchlist</span>
        </div>
        {q.data ? (
          <div style={tileGrid}>
            {TICKERS.map(([label, key]) => {
              const s = q.data[key];
              const lvl = s?.price && s.price !== "—" ? s.price : (s?.value || "—");
              const live = lvl !== "—";
              // Dead tiles (no quote — one bad ticker upstream) aren't tappable.
              return <StatTile key={key} value={lvl} label={label} delta={s?.delta || null} deltaTone={s?.up ? T.green : T.red}
                valueTone={live ? undefined : T.faint} onClick={live ? () => setTickerChart({ key, label }) : undefined} />;
            })}
          </div>
        ) : q.isError ? (
          <FallbackRow detail={q.error?.message} onRetry={() => q.refetch()} />
        ) : (
          <div style={tileGrid}>
            {[0, 1, 2, 3].map(i => <div key={i} className="sk sk-tile" />)}
          </div>
        )}
        <div className="t-foot" style={{ marginTop: 8, color: "var(--faint)" }}>
          {q.data?.stale ? "Showing the last good prices." : "Quotes only for now — a fuller stocks tool comes later."}
        </div>
      </Card>

      {tickerChart && (
        <Suspense fallback={null}>
          <BtcChartModal
            key={tickerChart.key}
            isMobile={isMobile}
            onClose={() => setTickerChart(null)}
            callFnFull={callFnFull}
            title={tickerChart.label}
            fn="ticker-candles"
            fnArgs={{ symbol: tickerChart.key }}
            defaultInterval="1d"
          />
        </Suspense>
      )}
    </div>
  );
}

export default StocksPanel;
