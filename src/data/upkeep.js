import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

const KEY = ["upkeep"];

export function useUpkeep() {
  return useQuery({ queryKey: KEY, queryFn: () => db.loadUpkeep() });
}

function useInvalidatingMutation(mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useSaveUpkeepItem = () => useInvalidatingMutation((item) => db.saveUpkeepItem(item));
export const useDeleteUpkeepItem = () => useInvalidatingMutation((id) => db.deleteUpkeepItem(id));

// "Log it done" flips last_done to today. Optimistic: the row updates in the
// cache immediately, rolls back on failure, and reconciles on settle.
export function useMarkUpkeepDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ item, today }) => db.saveUpkeepItem({ ...item, last_done: today }),
    onMutate: async ({ item, today }) => {
      await qc.cancelQueries({ queryKey: KEY });
      const prev = qc.getQueryData(KEY);
      qc.setQueryData(KEY, (old) => (old || []).map((r) => (r.id === item.id ? { ...r, last_done: today } : r)));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev !== undefined) qc.setQueryData(KEY, ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
