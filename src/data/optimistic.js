import { useMutation, useQueryClient } from "@tanstack/react-query";

// ─── a delete that leaves the list on the tap, not on the round trip ─────────
// The list-row deletes (calendar events, movies, birthdays, anniversaries) used
// to wait for the server before the row moved, and only refreshed on success —
// so on a slow signal you confirmed, saw nothing happen, and tapped again; and a
// delete that failed did nothing at all, with nothing said. This is the same
// shape as useMarkUpkeepDone: take the row out of the cached list now, put the
// list back exactly as it was if the write fails, and refetch either way so the
// server has the last word. The panel's own onError is what tells you.
export function useOptimisticDelete(key, mutationFn) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, (old) => (Array.isArray(old) ? old.filter((r) => r.id !== id) : old));
      return { prev };
    },
    onError: (_e, _id, ctx) => { if (ctx?.prev !== undefined) qc.setQueryData(key, ctx.prev); },
    // Not returned: TanStack waits for a returned promise before it runs the
    // caller's own onError, so the "couldn't delete" toast would sit behind a
    // whole refetch — on a bad signal, behind the same timeout that failed.
    onSettled: () => { qc.invalidateQueries({ queryKey: key }); },
  });
}
