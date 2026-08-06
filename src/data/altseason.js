import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { callFnFull } from "../lib/functions.js";

// ─── Markets tab feeds — the alt-season scan and the stock watchlist ─────────
// Both queryFns throw on failure instead of resolving to an empty shape — same
// reasoning as finances.js: a failed read that resolves "successfully" gets
// cached as real data, and here that renders as a market with no movers and no
// flags, indistinguishable from a genuinely dead tape. Throwing puts the query
// in `error` while `data` keeps the last good payload on screen.
//
// The persisted query cache (lib/queryClient.js) gives both hooks instant
// seeds on reopen for free — no bespoke localStorage.

const fnQuery = (name) => async () => {
  const { ok, status, data } = await callFnFull(name, {});
  if (!ok || !data?.success) throw new Error(data?.error || (status ? `HTTP ${status}` : "unreachable"));
  return data;
};

// The hourly cron already did the heavy math; alt-scan just overlays live
// prices onto the stored board (and caches for 60s server-side), so a
// one-minute poll is cheap and keeps the movers feeling live. Focus refetch is
// ON — unusual for this app, but this page is checked in bursts, and coming
// back to 40-minute-old prices on a momentum monitor defeats the point.
export function useAltScan() {
  return useQuery({
    queryKey: ["alt-scan"],
    queryFn: fnQuery("alt-scan"),
    refetchInterval: 60_000,
    staleTime: 45_000,
    refetchOnWindowFocus: true,
  });
}

// Yahoo quotes via the markets function, which caches for five minutes —
// polling any faster would only re-read the same server cache.
export function useStockQuotes() {
  return useQuery({
    queryKey: ["markets"],
    queryFn: fnQuery("markets"),
    refetchInterval: 300_000,
  });
}

// The stock screener. NOTHING ABOUT THIS POLLS LIKE THE CRYPTO ONE, and the
// difference is the market's clock rather than a preference:
//
//   · stock-scan makes zero upstream calls and the cron settles once a session,
//     so a 60s poll would re-read an identical payload ~60 times an hour.
//   · the poll is DISABLED while the market is shut. Re-fetching a finished
//     tape on a timer is theatre, and this tab is checked on a phone.
//   · focus refetch stays on: coming back to the tab is a real signal that you
//     want to know whether anything moved, and it costs one cached read.
//
// The 5-minute interval while open matches the tick's own hourly cadence with
// room to spare — the payload only changes when a tick writes.
export function useStockScan() {
  const [open, setOpen] = useState(() => marketMayBeOpen());
  useEffect(() => {
    const iv = setInterval(() => setOpen(marketMayBeOpen()), 60_000);
    return () => clearInterval(iv);
  }, []);
  return useQuery({
    queryKey: ["stock-scan"],
    queryFn: fnQuery("stock-scan"),
    refetchInterval: open ? 300_000 : false,
    staleTime: 120_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Run the screener NOW.
 *
 * THE TAB MUST NOT DEPEND ON A CRON HAVING FIRED. Its whole job is having the
 * next open's plan ready, and "the scheduler will get to it" is not a plan —
 * a missed fire used to mean an empty card until the following hour, and there
 * was no way for anyone to do anything about it.
 *
 * stock-settle-background is a BACKGROUND function: it answers 202 the instant
 * it starts and then runs for a couple of minutes. So there is nothing to await
 * — the mutation resolves on the ack, and the caller polls stock-scan until a
 * board appears. Invalidating the query on success is what starts that polling.
 */
export function useRunStockScreener() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // force: a manual run means RE-RUN. Without it the engine answers
      // "already settled" and idles, so the button would do nothing every time
      // it matters most — right after a change to how the screen scores.
      const { ok, status } = await callFnFull("stock-settle-background", { source: "manual", force: true });
      // 202 Accepted is the success case for a background function, and it is
      // NOT ok:true — treating it as a failure would show an error on the one
      // path that worked.
      if (!ok && status !== 202) throw new Error(status ? `HTTP ${status}` : "couldn't reach the screener");
      return true;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stock-scan"] }),
  });
}

/**
 * Could the US market be open right now — a CHEAP GUESS, used only to decide
 * whether to poll. The payload's `session.state` is the authority, and it comes
 * from SPY's own printed sessions; this is a weekday-and-clock heuristic that
 * exists so a phone left on the tab over a weekend does not poll all weekend.
 * It is deliberately allowed to be wrong on a market holiday: the cost is a few
 * cached reads, and the tab never renders anything off it.
 */
function marketMayBeOpen(now = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = {};
  for (const p of f.formatToParts(now)) if (p.type !== "literal") parts[p.type] = p.value;
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const h = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const mins = h * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
