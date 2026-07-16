// Tap the nav bar 5 times to open this — every number the device is willing
// to admit about its viewport, so a geometry quirk can be diagnosed from a
// single screenshot instead of blind deploys.
import { useState, useEffect } from "react";
import { IS_STANDALONE } from "../hooks/index.js";

export function ViewportDiag({ onClose }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    const probe = (css) => {
      const el = document.createElement("div");
      el.style.cssText = `position:fixed;left:-9999px;top:0;width:10px;height:${css};`;
      document.body.appendChild(el);
      const h = el.getBoundingClientRect().height;
      el.remove();
      return Math.round(h);
    };
    const vv = window.visualViewport;
    const dock = document.querySelector(".dock")?.getBoundingClientRect();
    const shell = document.getElementById("page-scroll")?.parentElement?.getBoundingClientRect();
    setInfo({
      build: typeof __BUILD__ !== "undefined" ? __BUILD__ : "dev",
      standalone: String(IS_STANDALONE),
      "screen h×w": `${window.screen?.height}×${window.screen?.width}`,
      innerHeight: window.innerHeight,
      clientHeight: document.documentElement.clientHeight,
      "vv.height": vv ? Math.round(vv.height) : "n/a",
      "vv.offsetTop": vv ? Math.round(vv.offsetTop) : "n/a",
      "100vh": probe("100vh"),
      "100dvh": probe("100dvh"),
      "100svh": probe("100svh"),
      "100lvh": probe("100lvh"),
      "env(top)": probe("env(safe-area-inset-top)"),
      "env(bottom)": probe("env(safe-area-inset-bottom)"),
      "shell bottom": shell ? Math.round(shell.bottom) : "n/a",
      "dock bottom": dock ? Math.round(dock.bottom) : "n/a",
    });
  }, []);
  // Physical ruler: absolutely-positioned lines at the client-y of each
  // reported height. A screenshot shows exactly where each coordinate
  // system believes the bottom is versus where the glass actually ends.
  const rulers = info ? [
    { y: Number(info["vv.height"]) || 0, color: "var(--red)", label: "vv" },
    { y: Number(info["100lvh"]) || 0, color: "var(--green)", label: "lvh" },
    { y: Number(info.innerHeight) || 0, color: "var(--blue)", label: "inner" },
  ] : [];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 5000, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      {rulers.map((r, i) => r.y > 0 && (
        <div key={i} style={{ position: "absolute", left: 0, right: 0, top: r.y - 2, height: 2, background: r.color, opacity: 0.9, pointerEvents: "none" }}>
          <span className="t-num" style={{ position: "absolute", right: 6, bottom: 3, fontSize: 10.5, color: r.color }}>{r.label} {r.y}</span>
        </div>
      ))}
      <div className="card pad-lg" style={{ width: "100%", maxWidth: 340, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink)", lineHeight: 1.9, boxShadow: "var(--shadow-deep)" }}>
        <div className="t-head" style={{ marginBottom: 8 }}>Viewport Diagnostics</div>
        {info && Object.entries(info).map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <span style={{ color: "var(--sub)" }}>{k}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{String(v)}</span>
          </div>
        ))}
        <div className="t-cap" style={{ marginTop: 8, color: "var(--faint)" }}>Tap anywhere to close · screenshot this if the dock sits wrong</div>
      </div>
    </div>
  );
}
