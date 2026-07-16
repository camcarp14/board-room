import { useState, useEffect, useRef } from "react";
import { getThemePref, setThemePref, resolveTheme, applyTheme } from "../theme.js";
import { updateSnapshot, getSnapshot } from "../lib/snapshot.js";

// The room follows the sun: Nocturne 19:00–07:00, Daylight otherwise, unless
// pinned. index.html applies the same resolution pre-paint; this keeps it
// live afterwards (the minute-tick catches sunset while the app is open).
export function useThemeController() {
  const [pref, setPrefState] = useState(getThemePref);
  const [resolved, setResolved] = useState(() => resolveTheme(getThemePref()));
  useEffect(() => {
    applyTheme(resolveTheme(pref));
    setResolved(resolveTheme(pref));
    if (pref !== "auto") return;
    // auto follows the device appearance — react the instant it flips, and
    // keep a slow tick as a fallback for the sun-based path (older browsers
    // with no prefers-color-scheme support).
    const reresolve = () => {
      const r = resolveTheme("auto");
      setResolved(prev => { if (prev !== r) applyTheme(r, { animate: true }); return r; });
    };
    const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener?.("change", reresolve);
    const iv = setInterval(reresolve, 60 * 1000);
    return () => { mq?.removeEventListener?.("change", reresolve); clearInterval(iv); };
  }, [pref]);
  const setPref = (p) => {
    setThemePref(p);
    setPrefState(p);
    applyTheme(resolveTheme(p), { animate: true });
    setResolved(resolveTheme(p));
  };
  return { pref, setPref, resolved };
}

// iOS standalone under-reports the viewport through several APIs at once
// (ICB, 100%/dvh, sometimes visualViewport), which left the dock floating
// with a dead band below it. Belt and suspenders: take the LARGEST of
// visualViewport and 100lvh when installed, and keep a tap-the-title-5x
// diagnostics overlay so any remaining device quirk shows its numbers.
export const IS_STANDALONE = typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true);

// Measured env(safe-area-inset-top): >0 means the window sits UNDER the
// status bar (top-anchored). The broken letterboxed window has envTop 59;
// a healthy below-status-bar window has envTop 0 — the discriminator for
// whether the reported bottom inset corresponds to paintable space.
function measureEnvTop() {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:env(safe-area-inset-top);";
  document.body.appendChild(el);
  const h = el.getBoundingClientRect().height;
  el.remove();
  return Math.round(h);
}

export function useVisualViewport() {
  const get = () => ({
    vvh: typeof window !== "undefined" && window.visualViewport ? Math.round(window.visualViewport.height) : null,
    envTop: typeof document !== "undefined" && document.body ? measureEnvTop() : 0,
  });
  const [vp, setVp] = useState(get);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setVp(get())); };
    on();
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    window.addEventListener("orientationchange", on);
    return () => { cancelAnimationFrame(raf); vv.removeEventListener("resize", on); vv.removeEventListener("scroll", on); window.removeEventListener("orientationchange", on); };
  }, []);
  return vp;
}

export function useIsMobile() {
  const [is, setIs] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const fn = (e) => setIs(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return is;
}

// ─── Bitcoin ──────────────────────────────────────────────────────────────────
export function useBitcoinPrice() {
  // Seed from the persisted snapshot so the BTC hero shows the last price
  // instantly on reopen (flagged stale) instead of "…" while the proxy answers.
  const [state, setState] = useState(() => {
    const b = getSnapshot().btc;
    return b && b.price != null
      ? { price: b.price, changePct: b.changePct, points: b.points || [], high24: b.high24 ?? null, low24: b.low24 ?? null, loading: false, error: null, stale: true, fetchedAt: b.fetchedAt || null }
      : { price: null, changePct: null, points: [], high24: null, low24: null, loading: true, error: null, stale: false, fetchedAt: null };
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const fetchDirect = async () => {
      const [priceRes, chartRes] = await Promise.all([
        fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true"),
        fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1"),
      ]);
      const priceData = await priceRes.json();
      const chartData = await chartRes.json();
      const raw = (chartData.prices || []).map(([, p]) => p);
      const step = Math.max(1, Math.floor(raw.length / 48));
      return { price: priceData.bitcoin?.usd ?? null, changePct: priceData.bitcoin?.usd_24h_change ?? null, points: raw.filter((_, i) => i % step === 0), high24: raw.length ? Math.max(...raw) : null, low24: raw.length ? Math.min(...raw) : null };
    };
    const load = async () => {
      // Prefer the server-side proxy — same-origin, immune to the visitor's
      // own IP being rate-limited by CoinGecko (a common mobile-carrier issue).
      try {
        const res = await fetch("/.netlify/functions/btc");
        if (res.ok) {
          const data = await res.json();
          if (data?.success && alive) { const next = { price: data.price, changePct: data.changePct, points: data.points || [], high24: data.high24 ?? null, low24: data.low24 ?? null, loading: false, error: null, stale: !!(data.stale || data.cached), fetchedAt: Date.now() }; setState(next); updateSnapshot({ btc: next }); return; }
        }
        if (res.status !== 404) throw new Error(`proxy ${res.status}`);
      } catch { /* fall through to direct fetch below */ }
      // Function not deployed yet (e.g. plain `vite dev`) or the proxy failed — try direct.
      try {
        const direct = await fetchDirect();
        if (alive) { const next = { ...direct, loading: false, error: null, fetchedAt: Date.now() }; setState(next); updateSnapshot({ btc: next }); }
      } catch { if (alive) setState(s => ({ ...s, loading: false, error: "price feed unavailable" })); }
    };
    load();
    const iv = setInterval(load, 5 * 60 * 1000); // cheap now that it's proxied+cached
    return () => { alive = false; clearInterval(iv); };
  }, [nonce]);
  return { ...state, refresh: () => setNonce(n => n + 1) };
}

// Numbers behave like instruments: big metrics count to their value.
export function useTween(target, dur = 700) {
  const [v, setV] = useState(target ?? 0);
  const fromRef = useRef(target ?? 0);
  useEffect(() => {
    if (target == null) return;
    const from = fromRef.current ?? 0;
    if (from === target) { setV(target); return; }
    let raf;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      setV(from + (target - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return target == null ? null : Math.round(v);
}
