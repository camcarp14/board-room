import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

const KEY = ["affirmations"];

export function useAffirmations() {
  return useQuery({ queryKey: KEY, queryFn: () => db.loadAffirmations() });
}

function useInvalidatingMutation(mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useSaveAffirmation = () => useInvalidatingMutation((a) => db.saveAffirmation(a));

// ─── deleting a line of the Creed is reversible now ───────────────────────────
// db.deleteAffirmation marks the row rather than destroying it, so the id the
// delete was given is the whole undo:
//
//   delMut.mutate(id, { onSuccess: () => offerUndo(id) })
//
// and useRestoreAffirmation(id) puts the line back where it was — created_at never
// moved, so it keeps its number in the list, which matters here because CreedPanel
// renders those positions as Roman numerals.
//
// CreedPanel draws it: a delete now ends in a short toast with Undo that calls
// useRestoreAffirmation, and the confirm no longer promises the entry is gone
// for good. The hook lives here so that panel never has to touch db.js.
export const useDeleteAffirmation = () => useInvalidatingMutation((id) => db.deleteAffirmation(id));
export const useRestoreAffirmation = () => useInvalidatingMutation((id) => db.restoreAffirmation(id));
