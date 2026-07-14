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
export const useDeleteAffirmation = () => useInvalidatingMutation((id) => db.deleteAffirmation(id));
