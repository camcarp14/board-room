import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

const KEY = ["dream-items"];

export function useDreamItems() {
  return useQuery({ queryKey: KEY, queryFn: () => db.loadDreamItems() });
}

function useInvalidating(mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useSaveDreamItem = () => useInvalidating((it) => db.saveDreamItem(it));
export const useDeleteDreamItem = () => useInvalidating((id) => db.deleteDreamItem(id));
export const useRenameDreamBoard = () => useInvalidating(({ from, to }) => db.renameDreamBoard(from, to));
export const useDeleteDreamBoard = () => useInvalidating((board) => db.deleteDreamBoard(board));
