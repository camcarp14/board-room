import { QueryClient } from "@tanstack/react-query";

// One cache for the whole app. Data is considered fresh for a minute (the app's
// data changes slowly), we don't refetch on every window focus (the header's
// Refresh button and mutations drive invalidation instead), and a single retry
// covers a transient network blip without hanging a card on a real outage.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
});
