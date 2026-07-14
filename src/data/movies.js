import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

// Movies data, cached under one key. Mutations invalidate that key so every
// view of the list refetches once — no manual refresh() plumbing per caller.
const KEY = ["movies"];

export function useMovies() {
  return useQuery({ queryKey: KEY, queryFn: () => db.loadMovies() });
}

// One mutation for both create and edit: pass an id to update, omit it to add.
export function useSaveMovie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => (id ? db.updateMovie(id, payload) : db.saveMovie(payload)),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteMovie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => db.deleteMovie(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
