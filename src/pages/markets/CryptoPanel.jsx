// ─── Crypto — Bitcoin plus the market's vital signs ──────────────────────────
// The Brief's Markets card answers "what's Bitcoin doing" in passing; this
// panel is the same hero with room to breathe, plus the pulse numbers the
// alt-season read is built from (dominance, sentiment, total cap, ETH/BTC).
// The interpretation of those numbers deliberately does NOT live here — the
// regime score belongs to the Alt Season sub, and repeating it in two places
// would mean two slightly different answers to the same question.
import { lazy, Suspense, useState } from "react";
import { T } from "../../theme.js";
import { Card, StatTile, Button, Dot, Delta } from "../../ui/kit.jsx";
import { CARD_STATES } from "../../ui/shared.jsx";
import { NumTween, Sparkline } from "../../ui/primitives.jsx";
import { callFnFull } from "../../lib/functions.js";
import { useAltScan } from "../../data/altseason.js";

// Lazy — lightweight-charts stays in its own chunk until a chart is opened.
const BtcChartModal = lazy(() => import("../../BtcChartModal.jsx"));

// Compact dollars for the total-cap tile: two decimals in the trillions where
// a tick is tens of billions; whole billions below.
const compactUsd = (n) => {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(0)}B`;
  return `$${Math.round(n / 1e6)}M`;
};
const signedPct = (n, digits = 1) => (n == null || !isFinite(n) ? "" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`);
// alternative.me's own bands, so the word here matches the site people check.
const fearGreedLabel = (v) => (v >= 76 ? "Extreme greed" : v >= 56 ? "Greed" : v >= 45 ? "Neutral" : v >= 25 ? "Fear" : "Extreme fear");
const fearGreedTone = (v) => (v >= 56 ? T.green : v >= 45 ? T.sub : T.red);

/* Same anatomy as the Brief's FeedFallbackRow, minus states this card can't be
   in (the alt-scan function ships with the tab — "not deployed" here means the
   whole build is broken, not one feed). */
function FallbackRow({ detail, onRetry }) {
  return (
    <div style={{ background: "var(--surface-2)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 13px", minHeight: 52 }}>
      <Dot tone={CARD_STATES.error.color} />
      <span className="t-foot" style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>{detail || "Feed unavailable."}</span>
      <Button kind="quiet" size="sm" style={{ height: 44, flex: "none" }} onClick={onRetry}>Retry</Button>
    </div>
  );
}

export function CryptoPanel({ isMobile, btc }) {
  const [btcChartOpen, setBtcChartOpen] = useState(false);
  const alt = useAltScan();
  const season = alt.data?.season;
  const mkt = alt.data?.global;

  // Same placeholder ladder as the Brief's hero: the seeded/stale price stays
  // up through a blip — never yank a real number for an em-dash.
  const price = btc.loading && btc.price == null ? "…" : btc.price == null ? "—" : "$" + btc.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const hasChange = !btc.loading && btc.changePct !== null && btc.changePct !== undefined;
  const up = (btc.changePct || 0) >= 0;

  const tileGrid = { display: "grid", gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 };
  // domTrend is a headwind/tailwind word, not a gain or a loss — it stays in
  // --sub rather than borrowing the green/red that Delta reserves for P&L.
  const trendWord = season?.domTrend ? season.domTrend[0].toUpperCase() + season.domTrend.slice(1) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Bitcoin hero — price, day move, sparkline; the whole card taps to the chart */}
      <Card pad="md" pressable onClick={() => setBtcChartOpen(true)} title="Tap for the full chart">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: btc.price != null ? 10 : 4 }}>
          <span className="t-cap" style={{ color: "var(--faint)", flex: "none" }}>Bitcoin</span>
          <span className="t-title1 t-num">{btc.price != null ? <NumTween v={btc.price} f={n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 })} /> : price}</span>
          {hasChange && <Delta pct={btc.changePct} />}
        </div>
        {btc.points?.length > 0 && <Sparkline points={btc.points} color={up ? T.green : T.red} height={34} />}
      </Card>

      {/* Market pulse — the raw inputs behind the alt-season read */}
      <Card pad="md">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
          <span className="t-head">Market pulse</span>
        </div>
        {alt.data ? (
          <div style={tileGrid}>
            <StatTile
              value={mkt?.btcDominance != null ? `${mkt.btcDominance.toFixed(1)}%` : "—"}
              valueTone={mkt?.btcDominance != null ? undefined : T.faint}
              label="BTC dominance" delta={trendWord} deltaTone={T.sub} />
            <StatTile
              value={season?.fearGreed != null ? String(season.fearGreed) : "—"}
              valueTone={season?.fearGreed != null ? undefined : T.faint}
              label="Fear & Greed"
              delta={season?.fearGreed != null ? fearGreedLabel(season.fearGreed) : null}
              deltaTone={season?.fearGreed != null ? fearGreedTone(season.fearGreed) : T.sub} />
            <StatTile
              value={compactUsd(mkt?.totalMcapUsd)}
              valueTone={mkt?.totalMcapUsd != null ? undefined : T.faint}
              label="Total market cap"
              delta={signedPct(mkt?.mcapChange24hPct) || null}
              deltaTone={(mkt?.mcapChange24hPct || 0) >= 0 ? T.green : T.red} />
            <StatTile
              value={signedPct(season?.ethBtc7d) || "—"}
              valueTone={season?.ethBtc7d != null ? (season.ethBtc7d >= 0 ? T.green : T.red) : T.faint}
              label="ETH vs BTC 7d" />
          </div>
        ) : alt.isError ? (
          <FallbackRow detail={alt.error?.message} onRetry={() => alt.refetch()} />
        ) : (
          <div style={tileGrid}>
            {[0, 1, 2, 3].map(i => <div key={i} className="sk sk-tile" />)}
          </div>
        )}
        <div className="t-foot" style={{ marginTop: 8, color: "var(--faint)" }}>
          Alt season read lives in the Alt Season tab
        </div>
      </Card>

      {btcChartOpen && (
        <Suspense fallback={null}>
          <BtcChartModal isMobile={isMobile} onClose={() => setBtcChartOpen(false)} callFnFull={callFnFull} />
        </Suspense>
      )}
    </div>
  );
}

export default CryptoPanel;
