import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createChart, CandlestickSeries, ColorType } from "lightweight-charts";
import { cssVar } from "./theme.js";
import { Sheet, PillRow, Button, EmptyState } from "./ui/kit.jsx";

const INTERVALS = [
  { key: "1m", label: "1m" },
  { key: "5m", label: "5m" },
  { key: "15m", label: "15m" },
  { key: "30m", label: "30m" },
  { key: "1d", label: "1D" },
  { key: "1w", label: "1W" },
];

// Chart height follows the rendered width (≈0.6 aspect), never under 280px and
// never past 60% of the viewport — landscape phones stay inside the sheet.
const chartHeight = (width) =>
  Math.min(Math.max(280, Math.round(width * 0.6)), Math.round(window.innerHeight * 0.6));

// isMobile is accepted for call-site compat only — one Sheet mount now adapts
// by breakpoint (bottom sheet on phone, centered modal ≥761px).
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
    const container = containerRef.current;
    // lightweight-charts draws to canvas — resolve the CSS variables to
    // literals at creation so the chart matches the room's current theme.
    const resolve = () => ({
      faint: cssVar("--faint"), line: cssVar("--line"), accent: cssVar("--accent"),
      green: cssVar("--green"), red: cssVar("--red"),
    });
    let C = resolve();
    const monoStack = cssVar("--font-mono");
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: C.faint, fontFamily: monoStack, fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: C.line } }, // horizontal hairlines only
      rightPriceScale: { borderColor: C.line },
      timeScale: { borderColor: C.line, timeVisible: interval !== "1d" && interval !== "1w" },
      crosshair: {
        vertLine: { color: C.accent, labelBackgroundColor: C.accent },
        horzLine: { color: C.accent, labelBackgroundColor: C.accent },
      },
      width: container.clientWidth,
      height: chartHeight(container.clientWidth),
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: C.green, downColor: C.red, borderVisible: false,
      wickUpColor: C.green, wickDownColor: C.red,
    });
    series.setData(candles);
    chart.timeScale().fitContent();

    // Canvas colors are literals, so they don't follow var() — re-resolve when
    // [data-theme] flips while the chart is open (user toggle, or the auto
    // theme crossing 19:00/07:00).
    const retheme = () => {
      C = resolve();
      chart.applyOptions({
        layout: { textColor: C.faint },
        grid: { vertLines: { visible: false }, horzLines: { color: C.line } },
        rightPriceScale: { borderColor: C.line },
        timeScale: { borderColor: C.line },
        crosshair: {
          vertLine: { color: C.accent, labelBackgroundColor: C.accent },
          horzLine: { color: C.accent, labelBackgroundColor: C.accent },
        },
      });
      series.applyOptions({ upColor: C.green, downColor: C.red, wickUpColor: C.green, wickDownColor: C.red });
    };
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // Size from the container, not window resize alone — the sheet's width can
    // change without a window resize (breakpoint crossing, scrollbars).
    const applySize = () => {
      const cw = container.clientWidth;
      if (cw) chart.applyOptions({ width: cw, height: chartHeight(cw) });
    };
    let ro;
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(applySize); ro.observe(container); }
    window.addEventListener("resize", applySize); // catches height-only viewport changes
    return () => {
      window.removeEventListener("resize", applySize);
      ro?.disconnect();
      mo.disconnect();
      chart.remove();
    };
  }, [candles, interval, isMobile]);

  // Portal to <body>: the Brief's entrance animations leave transforms on
  // ancestor plates, and a transformed ancestor traps position:fixed — the
  // overlay was centering inside the tall page column instead of the viewport
  // (hence scrolling to find the chart). From <body> it opens where you are.
  return createPortal(
    <Sheet
      onClose={onClose}
      title="BTC/USDT"
      // keep the chart clear of the home indicator on iOS standalone
      bodyStyle={{ paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}
    >
      <PillRow
        options={INTERVALS}
        value={interval}
        onChange={setInterval_}
        style={{ margin: "0 -16px 4px" }}
      />

      {candleErr && (
        <EmptyState
          title="Chart unavailable"
          sub={candleErr}
          action={
            <Button kind="tinted" size="md" onClick={() => setRetryNonce((n) => n + 1)}>
              Retry
            </Button>
          }
        />
      )}
      {!candleErr && !candles && (
        <div
          className="sk"
          style={{ width: "100%", aspectRatio: "5 / 3", minHeight: 280, maxHeight: "60vh", borderRadius: 12 }}
        />
      )}
      {!candleErr && candles && <div ref={containerRef} style={{ width: "100%" }} />}
    </Sheet>,
    document.body
  );
}
