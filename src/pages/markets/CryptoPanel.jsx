// ─── Crypto — the coin board, every window at once ───────────────────────────
// The board is the tab: sixty screened coins, price plus all five change
// windows per row, sortable by any of them — the layout the phone build
// always had, rebuilt on the screener's data. 4h/12h are OUR windows (diffs
// against the cron's hourly snapshots; CoinGecko doesn't sell them), so they
// read "—" until the snapshot series is old enough, and that's stated under
// the sort row rather than shown as zeros. A row wearing an open flag shows
// its tier pill, and the tap-through is the same coin sheet the Alt Season
// radar opens — the two sub-tabs are one tool with two entrances.
import { lazy, Suspense, useMemo, useState } from "react";
import { T } from "../../theme.js";
import { Card, StatTile, Button, Dot, Delta, PillRow } from "../../ui/kit.jsx";
import { CARD_STATES } from "../../ui/shared.jsx";
import { NumTween, Sparkline } from "../../ui/primitives.jsx";
import { callFnFull } from "../../lib/functions.js";
import { useAltScan } from "../../data/altseason.js";
import AltCoinSheet, { TonePill } from "./AltCoinSheet.jsx";

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
// Sub-dollar prices get significant digits, not two decimals — "$0.00" is not
// a price. Same rule the Alt Season panel applies.
const px = (x) => {
  if (x == null || !isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1000) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (a >= 1) return `$${x.toFixed(2)}`;
  if (a === 0) return "$0";
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
};

const WINDOWS = [
  { key: "chg4h", label: "4H" },
  { key: "chg12h", label: "12H" },
  { key: "chg24h", label: "24H" },
  { key: "chg7d", label: "7D" },
  { key: "chg30d", label: "30D" },
];
const SORTS = [
  { key: "chg4h", label: "4h" }, { key: "chg12h", label: "12h" }, { key: "chg24h", label: "24h" },
  { key: "chg7d", label: "7D" }, { key: "chg30d", label: "30D" },
  { key: "size", label: "Size" }, { key: "az", label: "A–Z" },
];

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
  const [sort, setSort] = useState("chg24h");
  const [sel, setSel] = useState(null);     // board row → coin sheet
  const [chart, setChart] = useState(null); // {id, symbol} → candles modal
  const alt = useAltScan();
  const season = alt.data?.season;
  const mkt = alt.data?.global;
  const board = alt.data?.board;

  // Same placeholder ladder as the Brief's hero: the seeded/stale price stays
  // up through a blip — never yank a real number for an em-dash.
  const price = btc.loading && btc.price == null ? "…" : btc.price == null ? "—" : "$" + btc.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const hasChange = !btc.loading && btc.changePct !== null && btc.changePct !== undefined;
  const up = (btc.changePct || 0) >= 0;

  // Sort: change windows descend with unmeasured rows last (a "—" must never
  // outrank a real number in either direction); Size is market cap; A–Z is
  // the ticker. The server's deterministic order keeps ties stable.
  const rows = useMemo(() => {
    if (!Array.isArray(board)) return null;
    const out = [...board];
    if (sort === "az") out.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
    else if (sort === "size") out.sort((a, b) => (b.mcap ?? -1) - (a.mcap ?? -1));
    else out.sort((a, b) => {
      const av = a[sort], bv = b[sort];
      if (!Number.isFinite(av)) return Number.isFinite(bv) ? 1 : 0;
      if (!Number.isFinite(bv)) return -1;
      return bv - av;
    });
    return out;
  }, [board, sort]);

  const episodeFor = (id) => (alt.data?.flags?.active || []).find((e) => e.coinId === id) || null;
  const selRow = sel && Array.isArray(board) ? board.find((r) => r.id === sel.id) || null : null;

  const tileGrid = { display: "grid", gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 };
  // domTrend is a headwind/tailwind word, not a gain or a loss — it stays in
  // --sub rather than borrowing the green/red that Delta reserves for P&L.
  const trendWord = season?.domTrend ? season.domTrend[0].toUpperCase() + season.domTrend.slice(1) : null;
  const snapshotsPending = !!alt.data && !!alt.data.movers && alt.data.movers["4h"] == null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* A REFRESH THAT FAILED WHILE GOOD DATA IS ON SCREEN. Every card below
          renders `alt.data ? board : alt.isError ? fallback : skeleton`, and
          data wins — so once a payload has loaded, or been rehydrated from the
          persisted query cache on reopen, a failing refresh drew the whole
          sixty-coin board with prices and five change columns and said nothing
          at all. This is the DEFAULT sub-tab: opening the app offline, or
          during a Supabase outage, showed a confident stale tape.

          The other two panels have carried this row at the top of their column
          since they shipped. This one never did. Same anatomy, same wording,
          same place — first in the column, so Retry cannot hide below the fold. */}
      {alt.isError && (
        <Card pad="sm">
          <FallbackRow detail={`Refresh failed — showing the last good scan (${alt.error?.message || "unreachable"})`} onRetry={() => alt.refetch()} />
        </Card>
      )}

      {/* Bitcoin hero — price, day move, sparkline; the whole card taps to the chart */}
      <Card pad="md" pressable onClick={() => setBtcChartOpen(true)} title="Tap for the full chart">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: btc.price != null ? 10 : 4 }}>
          <span className="t-cap" style={{ color: "var(--faint)", flex: "none" }}>Bitcoin</span>
          <span className="t-title1 t-num">{btc.price != null ? <NumTween v={btc.price} f={n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 })} /> : price}</span>
          {hasChange && <Delta pct={btc.changePct} />}
        </div>
        {btc.points?.length > 0 && <Sparkline points={btc.points} color={up ? T.green : T.red} height={34} />}
      </Card>

      {/* The board — sixty screened coins, five windows each, sortable */}
      <Card pad="md">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span className="t-head">Board</span>
          {alt.data?.stale && <span className="t-cap" style={{ color: T.amber }}>stale</span>}
        </div>
        <PillRow options={SORTS} value={sort} onChange={setSort} style={{ margin: "0 -16px 2px" }} />
        {snapshotsPending && (sort === "chg4h" || sort === "chg12h") && (
          <div className="t-foot" style={{ color: "var(--faint)", padding: "4px 0 2px" }}>
            4h/12h come from our own hourly snapshots — measured once the series is old enough.
          </div>
        )}
        {rows ? (
          rows.length ? (
            <div>
              {rows.map((r, i) => (
                <button
                  key={r.id}
                  onClick={() => setSel({ id: r.id, symbol: r.symbol, name: r.name })}
                  style={{
                    display: "block", width: "100%", textAlign: "left", background: "none",
                    border: "none", color: "inherit", font: "inherit",
                    padding: "10px 0 11px", cursor: "pointer",
                    // after `border: none` on purpose — the divider is the one edge that stays
                    borderTop: i === 0 ? "none" : "1px solid var(--line)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                    <span className="t-label">{r.symbol}</span>
                    <span className="t-cap" style={{ color: "var(--faint)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    {r.flag && (
                      <TonePill tone={r.flag.tier === "igniting" ? T.green : T.amber}>
                        {r.flag.tier === "igniting" ? "Igniting" : "Building"}
                      </TonePill>
                    )}
                    <span className="t-num" style={{ fontWeight: 600, flex: "none" }}>{px(r.price)}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 4 }}>
                    {WINDOWS.map((w) => {
                      const v = r[w.key];
                      const has = Number.isFinite(v);
                      return (
                        <div key={w.key} style={{ minWidth: 0 }}>
                          <div className="t-cap" style={{ color: "var(--faint)", fontSize: 10 }}>{w.label}</div>
                          <div className="t-num" style={{ fontSize: 12.5, color: has ? (v >= 0 ? T.green : T.red) : "var(--faint)" }}>
                            {has ? signedPct(v) : "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="t-foot" style={{ color: "var(--faint)", padding: "8px 0" }}>No board yet — the hourly screener hasn't completed a pass.</div>
          )
        ) : alt.isError ? (
          <FallbackRow detail={alt.error?.message} onRetry={() => alt.refetch()} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 6 }}>
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="sk" style={{ height: 56, borderRadius: 12 }} />)}
          </div>
        )}
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

      {sel && (
        <AltCoinSheet
          sel={sel}
          row={selRow}
          episode={episodeFor(sel.id)}
          onClose={() => setSel(null)}
          onChart={() => setChart({ id: sel.id, symbol: sel.symbol })}
        />
      )}
      {chart && (
        <Suspense fallback={null}>
          <BtcChartModal isMobile={isMobile} onClose={() => setChart(null)} callFnFull={callFnFull}
            title={chart.symbol} fn="alt-candles" fnArgs={{ id: chart.id }} defaultInterval="1m" z={480}
            intervals={[
              { key: "1d", label: "1D" }, { key: "1w", label: "1W" }, { key: "1m", label: "1M" },
              { key: "3m", label: "3M" }, { key: "6m", label: "6M" }, { key: "1y", label: "1Y" },
            ]} />
        </Suspense>
      )}
      {btcChartOpen && (
        <Suspense fallback={null}>
          <BtcChartModal isMobile={isMobile} onClose={() => setBtcChartOpen(false)} callFnFull={callFnFull} />
        </Suspense>
      )}
    </div>
  );
}

export default CryptoPanel;
