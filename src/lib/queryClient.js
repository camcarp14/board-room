import { QueryClient } from "@tanstack/react-query";

// One cache for the whole app. Data is considered fresh for a minute (the app's
// data changes slowly), we don't refetch on every window focus (the header's
// Refresh button and mutations drive invalidation instead), and a single retry
// covers a transient network blip without hanging a card on a real outage.
export const queryClient = new QueryClient({
  defaultOptions: {
    // gcTime long enough that entries survive to be written to localStorage and
    // rehydrated on the next launch (see main.jsx) — this is what lets the
    // Docket, calendar, notes, etc. paint their last-known data instantly on
    // reopen instead of flashing skeletons while the network round-trips.
    queries: { staleTime: 60_000, gcTime: 1000 * 60 * 60 * 24, refetchOnWindowFocus: false, retry: 1 },
  },
});
