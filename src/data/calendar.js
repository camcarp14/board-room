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
// Scoped edits and deletes on a repeating series — the plan comes from
// lib/recurrence.js, which decides WHAT to write; this just performs it.
export const useApplyEventPlan = () => useInvalidatingMutation((plan) => db.applyEventPlan(plan));
