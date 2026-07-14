import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

const GROCERIES = ["groceries"];
const RECIPES = ["recipes"];

// Both lists degrade to empty on error (matching the panel's original behaviour).
export function useGroceries() {
  return useQuery({ queryKey: GROCERIES, queryFn: () => db.loadGroceryItems().catch(() => []) });
}
export function useSavedRecipes() {
  return useQuery({ queryKey: RECIPES, queryFn: () => db.loadSavedRecipes().catch(() => []) });
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
