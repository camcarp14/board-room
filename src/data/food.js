import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

const GROCERIES = ["groceries"];
const RECIPES = ["recipes"];

// Errors PROPAGATE — swallowing them into [] made an outage render as the
// designed empty state ("List's empty."), which on a flaky connection reads
// as "my items are gone". The panel shows an error row + Retry instead.
export function useGroceries() {
  return useQuery({ queryKey: GROCERIES, queryFn: () => db.loadGroceryItems() });
}
export function useSavedRecipes() {
  return useQuery({ queryKey: RECIPES, queryFn: () => db.loadSavedRecipes() });
}

function useInvalidatingMutation(key, mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
}

export const useAddGrocery = () => useInvalidatingMutation(GROCERIES, (name) => db.addGroceryItem(name));
export const useToggleGrocery = () => useInvalidatingMutation(GROCERIES, ({ id, checked }) => db.toggleGroceryItem(id, checked));
export const useDeleteGrocery = () => useInvalidatingMutation(GROCERIES, (id) => db.deleteGroceryItem(id));
export const useClearCheckedGroceries = () =>
  useInvalidatingMutation(GROCERIES, (items) => Promise.all(items.map((g) => db.deleteGroceryItem(g.id))));

export const useSaveRecipe = () => useInvalidatingMutation(RECIPES, ({ title, body }) => db.saveRecipe(title, body));
export const useDeleteRecipe = () => useInvalidatingMutation(RECIPES, (id) => db.deleteRecipe(id));
