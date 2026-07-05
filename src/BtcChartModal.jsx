import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, ColorType } from "lightweight-charts";

// Small standalone theme subset so this file has no dependency on App.jsx's
// internals — it just needs a callFnFull(name, payload) passed in as a prop,
// which App.jsx already has defined at module scope.
const T = {
  ink: "#221D14", sub: "#6C6455", faint: "#9A9280",
  brass: "#8F6B1E", line: "rgba(34,29,20,0.10)",
  green: "#1F7A55", red: "#B23A2E",
};

const INTERVALS = [
  { key: "5m", label: "5m" },
  { key: "15m", label: "15m" },
  { key: "30m", label: "30m" },
  { key: "1d", label: "1D" },
  { key: "1w", label: "1W" },
];

export default function BtcChartModal({ isMobile, onClose, callFnFull }) {
  const [interval, setInterval_] = useState("1d");
  const [candles, setCandles] = useState(null);
  const [candleErr, setCandleErr] = useState(null);

  const containerRef = useRef(null);

  // Fetch candles whenever the interval changes
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
  }, [interval]);

  // Render the candlestick chart
  useEffect(() => {
    if (!containerRef.current || !candles || !candles.length) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: T.sub, fontFamily: "'DM Mono', monospace", fontSize: 11 },
      grid: { vertLines: { color: T.line }, horzLines: { color: T.line } },
      rightPriceScale: { borderColor: T.line },
      timeScale: { borderColor: T.line, timeVisible: interval !== "1d" && interval !== "1w" },
      crosshair: {
        vertLine: { color: T.brass, labelBackgroundColor: T.brass },
        horzLine: { color: T.brass, labelBackgroundColor: T.brass },
      },
      width: containerRef.current.clientWidth,
      height: isMobile ? 300 : 400,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: T.green, downColor: T.red, borderVisible: false,
      wickUpColor: T.green, wickDownColor: T.red,
    });
    series.setData(candles);
    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: containerRef.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); };
  }, [candles, interval, isMobile]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4,7,14,0.72)", zIndex: 500, display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "linear-gradient(180deg,#FFFFFF,#F6F3ED)", borderRadius: isMobile ? "20px 20px 0 0" : 18,
        padding: "20px 20px calc(20px + env(safe-area-inset-bottom))", width: isMobile ? "100%" : 720, maxWidth: 720,
        maxHeight: isMobile ? "88vh" : "86vh", overflowY: "auto",
        border: "1px solid rgba(34,29,20,0.1)", boxShadow: "0 32px 80px rgba(30,25,17,0.42)", color: T.ink,
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
                  color: selected ? "#FCFBF9" : T.sub,
                  transition: "all 120ms ease",
                }}>
                {iv.label}
              </button>
            );
          })}
        </div>

        {candleErr && <div style={{ fontSize: 11.5, color: T.faint, padding: "30px 0", textAlign: "center", lineHeight: 1.6 }}>{candleErr}</div>}
        {!candleErr && !candles && <div style={{ fontSize: 11.5, color: T.faint, padding: "30px 0", textAlign: "center", animation: "pulse 1.4s infinite" }}>Loading candles…</div>}
        {!candleErr && candles && <div ref={containerRef} style={{ width: "100%" }} />}
      </div>
    </div>
  );
}
