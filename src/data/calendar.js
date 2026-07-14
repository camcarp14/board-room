import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

const KEY = ["events"];

export function useEvents() {
  return useQuery({ queryKey: KEY, queryFn: () => db.loadEvents() });
}

function useInvalidatingMutation(mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useSaveEvent = () => useInvalidatingMutation((ev) => db.saveEvent(ev));
export const useDeleteEvent = () => useInvalidatingMutation((id) => db.deleteEvent(id));
