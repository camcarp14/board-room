import { useQuery } from "@tanstack/react-query";
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
