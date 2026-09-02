// ─── Resolved economic-release verdicts ───────────────────────────────────────
// Read side of netlify/functions/econ-resolve-background.js. Verdicts live in one
// app_settings row, so they are computed once for the account and every device
// reads the same answers — the previous design looked the same print up again on
// each device and each page load, and paid for every one.
//
// Nothing here spends anything. The only call that costs money is the trigger,
// and the Brief fires that at most once per page load for the whole card.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";
import { callFn } from "../lib/functions.js";

export const ECON_RESULTS = ["econ-results"];
export const RESULT_KEY = "econ_results";

/**
 * The verdict store: { [eventId]: { status, actual, take, at } }.
 *
 * Degrades to {} on any failure. An unreachable settings row means "no verdicts
 * yet", which renders as the honest unconfirmed state — never as a wrong answer.
 */
export function useEconResults() {
  return useQuery({
    queryKey: ECON_RESULTS,
    queryFn: async () => {
      try {
        // loadSetting, not loadSettings: the full read re-seeds the two-device
        // merge baseline for ponder_items and finance_rules as it goes, and a
        // reader that keeps this one key and drops the rest moved that baseline
        // on every Brief return without App ever seeing the value it now had to
        // match — the note on db.loadSetting has what that cost.
        const v = await db.loadSetting(RESULT_KEY);
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
      } catch { return {}; }
    },
    staleTime: 60 * 1000,
  });
}

/** Ask the background resolver to price out whatever is still unresolved. */
export function useResolveEconEvents() {
  const qc = useQueryClient();
  return {
    trigger: async (events) => {
      if (!events?.length) return;
      // Background function: Netlify answers 202 immediately and keeps running,
      // so this never blocks the card and can't time out the way the old
      // synchronous lookup did.
      await callFn("econ-resolve-background", { events });
    },
    refetch: () => qc.invalidateQueries({ queryKey: ECON_RESULTS }),
  };
}
