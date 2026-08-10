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
// Nothing draws that yet. The confirm still says the entry "comes off the plate for
// good", which is no longer true; the panel is where the sentence and the undo both
// belong, and this hook is here so that edit does not have to touch db.js.
export const useDeleteAffirmation = () => useInvalidatingMutation((id) => db.deleteAffirmation(id));
export const useRestoreAffirmation = () => useInvalidatingMutation((id) => db.restoreAffirmation(id));
