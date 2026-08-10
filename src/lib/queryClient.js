import { QueryClient } from "@tanstack/react-query";
import { GROCERIES, GROCERY_KEYS, GROCERY_REPLAY } from "../data/food.js";

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
    // would just lose the edit. The other half of that promise — surviving a
    // relaunch, not just a reconnection — is the outbox below.
    queries: {
      staleTime: 60_000, gcTime: 1000 * 60 * 60 * 24, refetchOnWindowFocus: false,
      retry: 1, networkMode: "offlineFirst",
    },
  },
});

// ─── the outbox ───────────────────────────────────────────────────────────────
// A paused write survives a relaunch only if something can find its request
// again on the other side. Dehydration keeps a mutation's key, its state and its
// variables and nothing else — a function does not serialise — so a rehydrated
// mutation is a set of arguments with nothing to pass them to, and resuming one
// fails with "No mutationFn found". These defaults are the missing half: the key
// is stored, the key finds the function, the function takes the variables.
//
// REGISTERED HERE, not from data/food.js, and that placement is the point. The
// grocery page is lazy-loaded (App.jsx), so on a launch where you never open the
// grocery tab that module is never imported. Registering the defaults from inside
// it would mean the outbox worked only if you happened to visit the screen whose
// writes it was holding — which is the launch where you would least notice that
// it hadn't.
//
// A write is in the outbox if and only if it has a key with an entry in
// GROCERY_REPLAY. Nothing else in the app has a mutation key, so nothing else is
// eligible, and adding a key alone is not enough — see the docstring on
// GROCERY_REPLAY for what has to be true of a request before it may be replayed,
// and why clear-checked, the store rename and the Finance CSV import are all out.
for (const [name, key] of Object.entries(GROCERY_KEYS)) {
  const mutationFn = GROCERY_REPLAY[name];
  if (!mutationFn) continue;
  queryClient.setMutationDefaults(key, {
    mutationFn,
    // Only ever used by a REHYDRATED mutation. defaultMutationOptions spreads a
    // live useMutation's own options last, so every hook's own onSettled beats
    // this one and nothing about a normal write changes. A resumed write, though,
    // has no hook behind it: none of the optimistic rollback or reconcile
    // handlers were dehydrated, so without this a replay the server REJECTED
    // would leave the optimistic value sitting on screen looking saved — the
    // exact lie the outbox exists to end, arriving one step later. Invalidating
    // either way makes the server the last word.
    onSettled: () => queryClient.invalidateQueries({ queryKey: GROCERIES }),
  });
}

// A write is worth replaying for a day. Past that, drop it: a week-old toggle
// arriving on relaunch is its own kind of lie — you have shopped since, someone
// may have edited the row from another device, and the tap it came from was
// about a list that no longer exists. Dropping it leaves the optimistic value on
// screen until the next successful read replaces it with the truth, which is the
// honest trade; replaying it would write the stale intention into the database
// and make it true.
export const OUTBOX_MAX_AGE = 1000 * 60 * 60 * 24;

// `submittedAt` is stamped when the mutation goes pending, and it rides along in
// the dehydrated state, so it survives the relaunch that the mutation is being
// judged for.
const outboxAge = (mutation) => Date.now() - mutation.state.submittedAt;

/**
 * What gets written to disk (main.jsx passes this as shouldDehydrateMutation).
 *
 * isPaused is the only honest signal available, and it is a strong one: the
 * network is checked before the mutation function is called, so a paused write
 * has not been sent and cannot have been. A write that was IN FLIGHT when the
 * process died is `pending` but not paused, and is deliberately not persisted —
 * we have no way to know whether it landed, and an insert sent twice is a
 * duplicate row.
 */
export const shouldPersistMutation = (mutation) =>
  mutation.state.isPaused
  && !!queryClient.getMutationDefaults(mutation.options.mutationKey).mutationFn
  && outboxAge(mutation) < OUTBOX_MAX_AGE;

/**
 * The other end of the cap, run after the restore and before the resume.
 *
 * The dehydrate-side check cannot cover this by itself, because it judges a write
 * at the moment the blob is WRITTEN and the blob is read whenever you next open
 * the app: one persisted at hour 23 is restored at hour 30. The blob's own maxAge
 * doesn't catch it either — it is rewritten on every cache event, so its timestamp
 * keeps moving forward while the write sits inside it, and three days in a dead
 * zone with the app opened each morning never produces a blob older than a
 * minute. This is the check that actually expires the write.
 *
 * Age is the only test here, on purpose. A mutation this old cannot be one from
 * the running session, so nothing live can be thrown away by mistake. Anything
 * rehydrated that has no function to run — a paused write from a build before
 * this existed — is left alone: resuming it fails harmlessly, which stops it
 * being paused, which is what keeps it out of the next blob.
 */
export function dropStaleOutboxMutations() {
  const cache = queryClient.getMutationCache();
  let dropped = 0;
  for (const mutation of cache.getAll()) {
    if (!mutation.state.isPaused || outboxAge(mutation) < OUTBOX_MAX_AGE) continue;
    cache.remove(mutation);
    dropped += 1;
  }
  return dropped;
}
