import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";
import { useOptimisticDelete } from "./optimistic.js";

const KEY = ["events"];

export function useEvents() {
  return useQuery({ queryKey: KEY, queryFn: () => db.loadEvents() });
}

function useInvalidatingMutation(mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useSaveEvent = () => useInvalidatingMutation((ev) => db.saveEvent(ev));
export const useDeleteEvent = () => useOptimisticDelete(KEY, (id) => db.deleteEvent(id));
// Scoped edits and deletes on a repeating series — the plan comes from
// lib/recurrence.js, which decides WHAT to write; this just performs it.
export const useApplyEventPlan = () => useInvalidatingMutation((plan) => db.applyEventPlan(plan));
