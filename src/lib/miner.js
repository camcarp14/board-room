// ─── NerdQaxe++ miner — two ways in, because one of them can't reach it ──────
// The miner is an ESP32 on the home LAN serving plain HTTP. Verified 2026-07-18:
// it DOES send permissive CORS headers (Access-Control-Allow-Origin: *), so the
// browser fetch itself is fine — but only from an http:// page.
//
// From the deployed HTTPS site the browser blocks the request as mixed ACTIVE
// content before it ever reaches the network. Three dead ends, all measured, so
// nobody re-litigates them:
//   · no CORS header can authorize it — this is a page-scheme rule, not CORS;
//   · `mode: "no-cors"` fails too, and even when it resolves the response is
//     opaque, so the JSON body is unreadable — it is not a workaround;
//   · a Netlify function proxy can't help either: 10.0.0.157 is RFC1918, and
//     the cloud has no route to a private LAN.
//
// The fix isn't a better pull, it's a push: scripts/miner-push.mjs runs on a
// machine that CAN reach the miner and writes readings to Supabase, which every
// client can already read over HTTPS. So there are two sources, in order:
//
//   1. DIRECT   — fetch the miner. Live, 5s. Only possible on an http:// page,
//                 i.e. local dev on the home network.
//   2. SUPABASE — the newest pushed sample. Works on the phone, the tablet, the
//                 deployed site, and off your WiFi entirely. As fresh as the
//                 push cadence (default 2 min).
//
// localStorage remains the last-resort seed so a cold offline open still shows
// real numbers instead of a blank panel.

import { useState, useEffect } from "react";
import { sm } from "./storage.js";
import { supabase } from "./supabase.js";

export const MINER_URL = "http://10.0.0.157/api/system/info";

const DIRECT_POLL_MS = 5000;   // the miner is on the LAN — cheap to ask often
const REMOTE_POLL_MS = 30000;  // Supabase only changes when the pusher writes
const TIMEOUT_MS = 4000;       // shorter than the poll, so requests never stack

// A sample older than this means the pushing machine has gone quiet (asleep,
// rebooted, off the network). 2.5x the default 2-minute cadence, so an ordinary
// late push doesn't trip it.
export const STALE_MS = 5 * 60 * 1000;

// Deterministic — computed once at module load, not per attempt.
export const MIXED_CONTENT_BLOCKED =
  typeof window !== "undefined" &&
  window.location.protocol === "https:" &&
  MINER_URL.startsWith("http://");

/* ── the poll ──────────────────────────────────────────────────────────────── */

// Returns { data, at, live, tried, source }. `data` is the last GOOD payload
// and `at` is when that reading was TAKEN (not when we read it — a Supabase row
// carries its own timestamp, and "last updated" must reflect the miner, not the
// query). Never throws; failure is a normal state here.
export function useMiner(active) {
  const [state, setState] = useState(() => {
    const c = sm.get("miner"); // br_miner
    return { data: c?.data ?? null, at: c?.at ?? null, live: false, tried: false, source: c?.data ? "cache" : null };
  });

  useEffect(() => {
    if (!active) return;
    let alive = true;

    // Source 2. The pusher writes the whole miner response, so the payload here
    // is the same shape a direct fetch returns and the panel needs no branch.
    const readRemote = async () => {
      if (!supabase) return null;
      // try/catch as well as the error field: supabase-js reports query errors
      // in `error`, but a dead network (or the placeholder creds used in
      // preview mode) rejects outright. This runs inside setInterval, where an
      // unhandled rejection would kill the poll loop.
      const ctrl = new AbortController();
      const bail = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const { data, error } = await supabase
          .from("miner_samples")
          .select("payload, created_at")
          .order("created_at", { ascending: false })
          .limit(1)
          .abortSignal(ctrl.signal) // never outlive the poll interval
          .maybeSingle();
        if (error || !data?.payload) return null;
        return { data: data.payload, at: new Date(data.created_at).getTime() };
      } catch { return null; }
      finally { clearTimeout(bail); }
    };

    // `force` is the mount/return-to-tab fetch, which must always run. The
    // visibility guard exists to stop the REPEATING poll from burning radio and
    // battery in the background — if it also gated the first attempt, a panel
    // mounted while the tab was hidden would sit on "Looking for the miner…"
    // forever with no request ever sent. (Caught in the browser, not in review.)
    const tick = async (force) => {
      if (!force && document.visibilityState === "hidden") return;

      // Source 1 — skipped entirely when the page scheme makes it impossible,
      // rather than firing a doomed request every few seconds.
      if (!MIXED_CONTENT_BLOCKED) {
        const ctrl = new AbortController();
        const bail = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
          const r = await fetch(MINER_URL, { signal: ctrl.signal, cache: "no-store" });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          if (!alive) return;
          const at = Date.now();
          setState({ data, at, live: true, tried: true, source: "direct" });
          sm.set("miner", { data, at });
          return;
        } catch {
          // Off-network or the miner is rebooting — fall through to Supabase,
          // which may still hold a recent reading from the pushing machine.
          // Drop the live flag NOW rather than after that round trip: if the
          // remote read is slow (or hangs, as it does against preview-mode
          // placeholder credentials), the badge would otherwise keep claiming
          // "Live" while nothing at all is working.
          if (alive) setState((s) => ({ ...s, live: false, tried: true }));
        } finally {
          clearTimeout(bail);
        }
      }

      const remote = await readRemote();
      if (!alive) return;
      if (remote) {
        setState({ ...remote, live: false, tried: true, source: "supabase" });
        sm.set("miner", remote);
        return;
      }
      // Both sources dark. Hold whatever we already had.
      setState((s) => ({ ...s, live: false, tried: true }));
    };

    tick(true);
    const iv = setInterval(tick, MIXED_CONTENT_BLOCKED ? REMOTE_POLL_MS : DIRECT_POLL_MS);
    // Coming back to the tab shouldn't wait out the rest of the interval.
    const onVis = () => { if (document.visibilityState === "visible") tick(true); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [active]);

  return state;
}

/* ── formatters ────────────────────────────────────────────────────────────── */

// Difficulty spans orders of magnitude (7930170 → "7.93M"), so scale it rather
// than printing a wall of digits nobody can read at a glance.
export function fmtDiff(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return String(Math.round(n));
}

export function fmtUptime(s) {
  if (s == null || isNaN(s)) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtAgo(at) {
  if (!at) return "never";
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtNum(n, digits = 0) {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/* ── derived values ────────────────────────────────────────────────────────── */

// Watts per terahash — the MPG of mining. Takes hashrate in GH/s.
export function efficiency(power, hashRateGh) {
  if (!power || !hashRateGh) return null;
  return power / (hashRateGh / 1000);
}

// The firmware cuts power at overheat_temp (70°C stock). Amber gives ~15° of
// warning, red ~5° — enough lead time to react, not so twitchy it cries wolf.
export function tempTone(t, overheat = 70) {
  if (t == null) return "var(--ink)";
  if (t >= overheat - 5) return "var(--red)";
  if (t >= overheat - 15) return "var(--amber)";
  return "var(--green)";
}

// The regulators tolerate far more than the ASIC does — the TPS546 is rated
// well past 100°C. Same grammar, its own scale: don't reuse the chip numbers.
export function vrTempTone(t) {
  if (t == null) return "var(--ink)";
  if (t >= 95) return "var(--red)";
  if (t >= 80) return "var(--amber)";
  return "var(--green)";
}

// A few rejects are normal; a rising share of them means the pool is throwing
// work away. Stay quiet under 2%, which is well inside ordinary noise.
export function rejectTone(accepted, rejected) {
  const total = (accepted || 0) + (rejected || 0);
  if (!total || !rejected) return "var(--sub)";
  const pct = (rejected / total) * 100;
  if (pct >= 5) return "var(--red)";
  if (pct >= 2) return "var(--amber)";
  return "var(--sub)";
}
