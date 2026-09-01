import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

// One cache key, read by two screens: the panel that edits the list and the
// calendar that draws it. Sharing the key is what makes an anniversary added in
// the panel appear on the grid without a reload — the invalidation below
// refetches for both.
export const ANNIVERSARIES_KEY = ["anniversaries"];

export function useAnniversaries() {
  return useQuery({ queryKey: ANNIVERSARIES_KEY, queryFn: () => db.loadAnniversaries() });
}

function useInvalidatingMutation(mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: ANNIVERSARIES_KEY }) });
}

export const useSaveAnniversary = () => useInvalidatingMutation((a) => db.saveAnniversary(a));
export const useDeleteAnniversary = () => useInvalidatingMutation((id) => db.deleteAnniversary(id));
