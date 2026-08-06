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
    //
    // networkMode "offlineFirst" ON READS ONLY. The v5 default is "online",
    // which PAUSES a query when the browser reports itself offline rather than
    // running it: status stays `pending`, `isError` never becomes true, and
    // every card in the app that branches `data ? … : isError ? … : skeleton`
    // sits on an animated skeleton indefinitely, saying nothing and offering no
    // control. Relaunching the installed PWA with no signal and a cold cache
    // did exactly that across all three Markets tabs — the one failure mode
    // with no message and no Retry, in a tab where every other one has both.
    //
    // Attempting anyway is also the truer answer for a PWA: the service worker
    // may well have the response, and navigator.onLine lies in both directions.
    // A genuine failure then lands in `error`, which every panel already draws.
    //
    // MUTATIONS KEEP THE DEFAULT deliberately. A paused write resumes when the
    // connection returns, which is what you want from a write; failing it fast
    // would just lose the edit.
    queries: {
      staleTime: 60_000, gcTime: 1000 * 60 * 60 * 24, refetchOnWindowFocus: false,
      retry: 1, networkMode: "offlineFirst",
    },
  },
});
