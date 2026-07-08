import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, ColorType } from "lightweight-charts";
import { T, cssVar } from "./theme.js";

const INTERVALS = [
  { key: "1m", label: "1m" },
  { key: "5m", label: "5m" },
  { key: "15m", label: "15m" },
  { key: "30m", label: "30m" },
  { key: "1d", label: "1D" },
  { key: "1w", label: "1W" },
];

export default function BtcChartModal({ isMobile, onClose, callFnFull }) {
  const [interval, setInterval_] = useState("1m");
  const [candles, setCandles] = useState(null);
  const [candleErr, setCandleErr] = useState(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const containerRef = useRef(null);

  // Fetch candles whenever the interval changes (or Retry is tapped)
  useEffect(() => {
    let cancelled = false;
    setCandles(null);
    setCandleErr(null);
    callFnFull("btc-candles", { interval }).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok && data?.success) setCandles(data.candles);
      else setCandleErr(data?.error || "Couldn't load candles — try again in a moment.");
    });
    return () => { cancelled = true; };
  }, [interval, retryNonce]);

  // Render the candlestick chart
  useEffect(() => {
    if (!containerRef.current || !candles || !candles.length) return;
    // lightweight-charts draws to canvas — resolve the CSS variables to
    // literals at creation so the chart matches the room's current theme.
    const C = {
      sub: cssVar("--sub"), line: cssVar("--line"), brass: cssVar("--brass"),
      green: cssVar("--green"), red: cssVar("--red"),
    };
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: C.sub, fontFamily: "'DM Mono', monospace", fontSize: 11 },
      grid: { vertLines: { color: C.line }, horzLines: { color: C.line } },
      rightPriceScale: { borderColor: C.line },
      timeScale: { borderColor: C.line, timeVisible: interval !== "1d" && interval !== "1w" },
      crosshair: {
        vertLine: { color: C.brass, labelBackgroundColor: C.brass },
        horzLine: { color: C.brass, labelBackgroundColor: C.brass },
      },
      width: containerRef.current.clientWidth,
      height: isMobile ? 300 : 400,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: C.green, downColor: C.red, borderVisible: false,
      wickUpColor: C.green, wickDownColor: C.red,
    });
    series.setData(candles);
    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: containerRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); };
  }, [candles, interval, isMobile]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--scrim)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: isMobile ? 16 : 0, animation: "fadein 0.15s ease both" }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "linear-gradient(180deg, var(--surface-2), var(--surface))", borderRadius: 18,
        padding: "20px 20px calc(20px + env(safe-area-inset-bottom))", width: isMobile ? "100%" : 720, maxWidth: 720,
        maxHeight: isMobile ? "88vh" : "86vh", overflowY: "auto",
        border: "1px solid var(--line)", boxShadow: "var(--shadow-deep)", color: T.ink,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 20, height: 20, borderRadius: "50%", background: "linear-gradient(135deg,#F7931A,#C77416)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: "#1A0F00" }}>₿</span>
            <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Cinzel', serif" }}>BTC/USDT</span>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: T.faint, fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {INTERVALS.map(iv => {
            const selected = iv.key === interval;
            return (
              <button key={iv.key} onClick={() => setInterval_(iv.key)}
                style={{
                  fontFamily: "'Cinzel', serif", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase",
                  padding: "6px 14px", borderRadius: 999, cursor: "pointer",
                  border: selected ? `1px solid ${T.brass}` : `1px solid ${T.line}`,
                  background: selected ? T.brass : "transparent",
                  color: selected ? "var(--on-brass)" : T.sub,
                  transition: "all 120ms ease",
                }}>
                {iv.label}
              </button>
            );
          })}
        </div>

        {candleErr && (
          <div style={{ padding: "30px 0", textAlign: "center" }}>
            <div style={{ fontSize: 11.5, color: T.faint, lineHeight: 1.6, marginBottom: 10 }}>{candleErr}</div>
            <button onClick={() => setRetryNonce(n => n + 1)}
              style={{ background: "transparent", border: "1px solid var(--line-strong)", borderRadius: 8, color: T.sub, fontWeight: 600, cursor: "pointer", padding: "7px 16px", fontSize: 11 }}>
              Retry
            </button>
          </div>
        )}
        {!candleErr && !candles && (
          <div className="sk" style={{ width: "100%", height: isMobile ? 300 : 400, borderRadius: 12 }} />
        )}
        {!candleErr && candles && <div ref={containerRef} style={{ width: "100%" }} />}
      </div>
    </div>
  );
}
