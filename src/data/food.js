import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";
import {
  parseItem, formatItem, findDuplicate, bumpFrequency, STAPLES_KEY,
} from "../features/food/groceryLogic.js";

const GROCERIES = ["groceries"];
const RECIPES = ["recipes"];
const GROCERY_FREQ = ["grocery-frequency"];

// Groceries deliberately do NOT swallow errors into []. This used to read
// `.catch(() => [])`, which turns a failed read into a *successful empty result*
// — react-query stores it, and the whole list blanks. That was survivable when
// the only fetch was on mount; it is not now that every optimistic mutation ends
// in an invalidate, so one dropped request mid-shop would have wiped the list off
// the screen. Letting it throw puts the query in `error` state while `data` keeps
// the last good list, which is the honest behaviour: stale beats empty.
export function useGroceries() {
  return useQuery({ queryKey: GROCERIES, queryFn: () => db.loadGroceryItems() });
}
export function useSavedRecipes() {
  return useQuery({ queryKey: RECIPES, queryFn: () => db.loadSavedRecipes().catch(() => []) });
}

function useInvalidatingMutation(key, mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
}

// ─── Optimistic groceries ─────────────────────────────────────────────────────
// Every mutation below used to be invalidate-on-success, which meant a tap on a
// row did nothing at all until Supabase answered. That's tolerable at a desk and
// wrong in a shop with one bar of signal: you tap, nothing moves, you tap again,
// and now the item is checked and unchecked. So these write to the cache first,
// fire the request, and roll back the exact previous snapshot if it fails.
//
// The rollback is the whole point of doing this by hand rather than trusting
// `onSettled` to refetch — on a dropped connection there is nothing to refetch
// from, and the list must not keep a change the server rejected.
function useOptimisticGrocery(apply, mutationFn) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: GROCERIES });
      const prev = qc.getQueryData(GROCERIES) || [];
      qc.setQueryData(GROCERIES, apply(prev, vars));
      return { prev };
    },
    onError: (_e, _vars, ctx) => { if (ctx?.prev) qc.setQueryData(GROCERIES, ctx.prev); },
    // Reconcile against the server once the dust settles — an optimistic insert
    // carries a temporary id, and this is what swaps in the real row.
    onSettled: () => qc.invalidateQueries({ queryKey: GROCERIES }),
  });
}

/**
 * Add — or merge. `mutate(text)` where text is whatever was typed.
 *
 * If the list already has that item (case-, plural- and quantity-insensitively),
 * this bumps its quantity and unchecks it rather than inserting a second row.
 * Adding milk twice should mean "two milks", not two lines that both say milk.
 */
export function useAddGrocery() {
  const qc = useQueryClient();
  return useOptimisticGrocery(
    (prev, text) => {
      const dup = findDuplicate(prev, text);
      if (dup) {
        const merged = formatItem(parseItem(dup.item).qty + parseItem(text).qty, parseItem(dup.item).name);
        return prev.map((it) => (it.id === dup.id ? { ...it, item: merged, checked: false } : it));
      }
      // Temp id, replaced by onSettled's refetch. Prefixed so a stray render
      // can't mistake it for a real row id.
      return [...prev, { id: `tmp-${Date.now()}`, item: String(text).trim(), checked: false, created_at: new Date().toISOString() }];
    },
    async (text) => {
      const items = qc.getQueryData(GROCERIES) || [];
      const dup = findDuplicate(items, text);
      if (dup) {
        const merged = formatItem(parseItem(dup.item).qty + parseItem(text).qty, parseItem(dup.item).name);
        return db.updateGroceryItem(dup.id, { item: merged, checked: false });
      }
      return db.addGroceryItem(String(text).trim());
    },
  );
}

export function useToggleGrocery() {
  return useOptimisticGrocery(
    (prev, { id, checked }) => prev.map((it) => (it.id === id ? { ...it, checked } : it)),
    ({ id, checked }) => db.toggleGroceryItem(id, checked),
  );
}

export function useDeleteGrocery() {
  return useOptimisticGrocery(
    (prev, id) => prev.filter((it) => it.id !== id),
    (id) => db.deleteGroceryItem(id),
  );
}

/** Change an item's quantity in place — the stepper on a row. */
export function useSetGroceryQty() {
  return useOptimisticGrocery(
    (prev, { id, qty }) => prev.map((it) => (it.id === id ? { ...it, item: formatItem(qty, parseItem(it.item).name) } : it)),
    ({ id, qty, item }) => db.updateGroceryItem(id, { item: formatItem(qty, parseItem(item).name) }),
  );
}

/**
 * Clearing the cart is also the only honest signal of what you actually buy —
 * you checked it off and took it home. That's where the frequency tally is
 * incremented from, not from what gets typed and later deleted.
 */
export function useClearCheckedGroceries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items) => {
      const tally = bumpFrequency(qc.getQueryData(GROCERY_FREQ) || {}, items);
      await Promise.all(items.map((g) => db.deleteGroceryItem(g.id)));
      await db.saveSetting(STAPLES_KEY, tally);
      return tally;
    },
    onMutate: async (items) => {
      await qc.cancelQueries({ queryKey: GROCERIES });
      const prev = qc.getQueryData(GROCERIES) || [];
      const ids = new Set(items.map((g) => g.id));
      qc.setQueryData(GROCERIES, prev.filter((it) => !ids.has(it.id)));
      return { prev };
    },
    onError: (_e, _vars, ctx) => { if (ctx?.prev) qc.setQueryData(GROCERIES, ctx.prev); },
    onSuccess: (tally) => qc.setQueryData(GROCERY_FREQ, tally),
    onSettled: () => qc.invalidateQueries({ queryKey: GROCERIES }),
  });
}

/**
 * The frequency tally, read from app_settings so it follows the account rather
 * than the device. Missing/garbage settings degrade to {} — a missing tally just
 * means no suggestions yet, which is the correct state for a new account anyway.
 */
export function useGroceryFrequency() {
  return useQuery({
    queryKey: GROCERY_FREQ,
    queryFn: async () => {
      try {
        const all = await db.loadSettings();
        const t = all?.[STAPLES_KEY];
        return t && typeof t === "object" && !Array.isArray(t) ? t : {};
      } catch { return {}; }
    },
    staleTime: 5 * 60 * 1000, // it only changes when you clear the cart
  });
}

export const useSaveRecipe = () => useInvalidatingMutation(RECIPES, ({ title, body }) => db.saveRecipe(title, body));
export const useDeleteRecipe = () => useInvalidatingMutation(RECIPES, (id) => db.deleteRecipe(id));
