import { useState, useEffect, useRef } from "react";
import { getThemePref, setThemePref, resolveTheme, applyTheme, getPalettePref, setPalettePref, getAmbientPref, setAmbientPref } from "../theme.js";
import { updateSnapshot, getSnapshot } from "../lib/snapshot.js";

// The room follows the sun: Nocturne 19:00–07:00, Daylight otherwise, unless
// pinned. index.html applies the same resolution pre-paint; this keeps it
// live afterwards (the minute-tick catches sunset while the app is open).
export function useThemeController() {
  const [pref, setPrefState] = useState(getThemePref);
  const [palette, setPaletteState] = useState(getPalettePref);
  const [resolved, setResolved] = useState(() => resolveTheme(getThemePref()));
  useEffect(() => {
    applyTheme(resolveTheme(pref), { palette });
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
  }, [pref, palette]);
  const setPref = (p) => {
    setThemePref(p);
    setPrefState(p);
    applyTheme(resolveTheme(p), { animate: true, palette });
    setResolved(resolveTheme(p));
  };
  // Switching palette keeps the light/dark mode exactly where it is — the two
  // axes never move each other. The veil cross-fade is reused so a 20-token
  // repaint doesn't hard-cut.
  const setPalette = (key) => {
    setPalettePref(key);
    setPaletteState(key);
    applyTheme(resolveTheme(pref), { animate: true, palette: key });
  };
  // Ambience rides along on this controller rather than getting its own hook:
  // Settings already receives the whole `theme` object, so the toggle costs no
  // new prop plumbing through two shells, and all three appearance axes stay in
  // one place. No applyTheme call — the ambient layer is a React node, not an
  // attribute on <html>, so re-rendering it IS applying it.
  const [ambient, setAmbientState] = useState(getAmbientPref);
  const setAmbient = (on) => { setAmbientPref(on); setAmbientState(on); };
  return { pref, setPref, resolved, palette, setPalette, ambient, setAmbient };
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
      // Without these, a CoinGecko 429/5xx (common on rate-limited mobile IPs —
      // the very reason the proxy exists) parses to price:null and would be
      // written straight through updateSnapshot, destroying the last-good seed.
      if (!priceRes.ok || !chartRes.ok) throw new Error(`coingecko ${priceRes.status}/${chartRes.status}`);
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
          if (data?.success && data.price != null && alive) { const next = { price: data.price, changePct: data.changePct, points: data.points || [], high24: data.high24 ?? null, low24: data.low24 ?? null, loading: false, error: null, stale: !!(data.stale || data.cached), fetchedAt: Date.now() }; setState(next); updateSnapshot({ btc: next }); return; }
        }
        if (res.status !== 404) throw new Error(`proxy ${res.status}`);
      } catch { /* fall through to direct fetch below */ }
      // Function not deployed yet (e.g. plain `vite dev`) or the proxy failed — try direct.
      try {
        const direct = await fetchDirect();
        if (alive) { const next = { ...direct, loading: false, error: null, fetchedAt: Date.now() }; setState(next); if (next.price != null) updateSnapshot({ btc: next }); }
      } catch { if (alive) setState(s => ({ ...s, loading: false, error: "price feed unavailable" })); }
    };
    load();
    const iv = setInterval(load, 5 * 60 * 1000); // cheap now that it's proxied+cached
    return () => { alive = false; clearInterval(iv); };
  }, [nonce]);
  return { ...state, refresh: () => setNonce(n => n + 1) };
}

// ─── the tween's bookkeeping ──────────────────────────────────────────────────
// A TWEEN STARTS FROM WHERE THE PIXELS ARE, NOT FROM THE LAST TARGET IT REACHED.
//
// This used to keep its origin in a ref that only advanced when a flight ran to
// COMPLETION, and a target that changes mid-flight cancels the frame loop — so
// the next flight interpolated from the reading two updates ago and the figure
// counted BACKWARDS through numbers nobody measured, for as long as updates kept
// arriving faster than the duration. Settings → Systems → Status → Run all checks
// is the reproduction: connections.js seeds every row to "checking", turns two
// green in the same tick and a third about 200ms later, and the "Live" tile
// dropped from 2 back to 0 and re-counted to 3 — printing "0 live" as a fact with
// two checks already green. Before every stat tile in the app went through
// useTween that reached seventeen hand-wrapped call sites; now it reaches all of
// them, which is what turned a wobble into a lie.
//
// Lifted out of the hook as a plain object, and that is deliberate: this fails in
// complete silence — nothing throws, the number still animates, it just animates
// from a reading that has been superseded — so scripts/ambient-smoke.mjs drives an
// interrupted retarget through this directly instead of grepping for the line.
export function createTween(at = 0) {
  let from = at, target = at, t0 = 0, shown = at;
  return {
    // Aim at a new reading, from whatever is currently painted. Returns false
    // when there is nothing to animate — the figure is already sitting there.
    retarget(next, now) {
      from = shown;
      target = next;
      t0 = now;
      return from !== target;
    },
    // The frame at `now`, and whether it is the last one. The last frame lands
    // exactly on the target rather than a rounding away from it, so a completed
    // flight cannot leave a fraction behind for the next one to start from.
    frame(now, dur) {
      const p = dur > 0 ? Math.min(1, (now - t0) / dur) : 1;
      shown = p >= 1 ? target : from + (target - from) * (1 - Math.pow(1 - p, 3));
      return { value: shown, done: p >= 1 };
    },
    // The frame last handed out, before the hook's display rounding — which is to
    // say what is on screen, to within the precision it is printed at. An
    // interrupted flight resumes here.
    painted() { return shown; },
  };
}

// Numbers behave like instruments: big metrics count to their value.
export function useTween(target, dur = 700) {
  const [v, setV] = useState(target ?? 0);
  const twRef = useRef(null);
  if (!twRef.current) twRef.current = createTween(target ?? 0);
  useEffect(() => {
    if (target == null) return;
    const tw = twRef.current;
    // Nothing painted between two target changes means `painted()` is still the
    // last frame anyone saw, which is exactly the origin this wants.
    if (!tw.retarget(target, performance.now())) { setV(target); return; }
    let raf;
    const step = (now) => {
      const { value, done } = tw.frame(now, dur);
      setV(value);
      if (!done) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  // ROUND TO THE VALUE'S OWN SCALE, not to whole numbers. This was a flat
  // Math.round, which is right for a BTC price or a rep count and destroys an
  // altcoin: PUMP at $0.002399 tweened through Math.round() to 0, so the coin
  // sheet printed its headline price as "$0". Everything at or above 1 still
  // rounds exactly as before (every caller formats its own decimals anyway);
  // below 1 we keep four significant figures, which is the precision px()
  // renders at.
  if (target == null) return null;
  const a = Math.abs(target);
  if (!(a > 0) || a >= 1) return Math.round(v);
  const p = Math.pow(10, Math.min(12, Math.ceil(-Math.log10(a)) + 3));
  return Math.round(v * p) / p;
}
