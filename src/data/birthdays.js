import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

const KEY = ["birthdays"];

export function useBirthdays() {
  return useQuery({ queryKey: KEY, queryFn: () => db.loadBirthdays() });
}

function useInvalidatingMutation(mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useSaveBirthday = () => useInvalidatingMutation((b) => db.saveBirthday(b));
export const useDeleteBirthday = () => useInvalidatingMutation((id) => db.deleteBirthday(id));
export const useSaveBirthdaysBulk = () => useInvalidatingMutation((rows) => db.saveBirthdaysBulk(rows));
