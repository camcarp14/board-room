import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";
import {
  parseItem, formatItem, bumpFrequency, STAPLES_KEY,
  planAdd, applyAdd, requestFor, isTempId, TMP_PREFIX,
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
 * A row still carrying a temporary id has nothing on the server to change yet,
 * so any request built from one is a guaranteed 400. GroceryPanel disables the
 * controls on such a row; this is the second line of defence, for the tap that
 * beats the re-render.
 */
function useGuardedOptimistic(apply, mutationFn, idOf) {
  const m = useOptimisticGrocery(apply, mutationFn);
  // mutateAsync is wrapped too, not because anything calls it today but because
  // it is the obvious way for the next edit to bypass the guard entirely.
  return {
    ...m,
    mutate: (vars, opts) => { if (!isTempId(idOf(vars))) m.mutate(vars, opts); },
    mutateAsync: (vars, opts) => (isTempId(idOf(vars)) ? Promise.resolve() : m.mutateAsync(vars, opts)),
  };
}

// Date.now() alone collides when two items go in inside the same millisecond,
// and two rows sharing an id makes the wrong one get replaced on success.
let tmpSeq = 0;
const nextTmpId = () => `${TMP_PREFIX}${Date.now()}-${++tmpSeq}`;

/**
 * Add — or merge. `mutate(text)` where text is whatever was typed.
 *
 * If the list already has that item (case-, plural- and quantity-insensitively),
 * this bumps its quantity and unchecks it rather than inserting a second row.
 * Adding milk twice should mean "two milks", not two lines that both say milk.
 *
 * The merge-or-insert decision is made HERE, in mutate(), against the list as it
 * stands before onMutate has touched it — NOT inside mutationFn, which runs after
 * onMutate and would see the optimistic row this add just created. That ordering
 * mistake broke every add on the list; planAdd()'s docstring has the full story.
 * The rule this shape enforces: mutationFn reads the plan and nothing else.
 */
export function useAddGrocery() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (plan) => {
      const r = requestFor(plan);
      return r.op === "update" ? db.updateGroceryItem(r.id, r.patch) : db.addGroceryItem(r.item);
    },
    onMutate: async (plan) => {
      await qc.cancelQueries({ queryKey: GROCERIES });
      const prev = qc.getQueryData(GROCERIES) || [];
      qc.setQueryData(GROCERIES, applyAdd(prev, plan, new Date().toISOString()));
      return { prev };
    },
    onError: (_e, _plan, ctx) => { if (ctx?.prev) qc.setQueryData(GROCERIES, ctx.prev); },
    // Swap the temporary row for the real one the insert returned, so the row
    // becomes tappable the moment the write lands rather than when the refetch
    // does. Without this the row sits inert for a second round trip.
    onSuccess: (row, plan) => {
      if (plan.kind !== "insert" || !row?.id) return;
      qc.setQueryData(GROCERIES, (prev) => (prev || []).map((it) => (it.id === plan.id ? row : it)));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: GROCERIES }),
  });

  // Both entry points plan, so neither can hand raw text to a mutationFn that
  // expects a plan. mutate(text) keeps the signature the panel already calls.
  const plan = (text) => planAdd(qc.getQueryData(GROCERIES) || [], text, nextTmpId());
  return {
    ...m,
    mutate: (text, opts) => { const p = plan(text); if (p) m.mutate(p, opts); },
    mutateAsync: (text, opts) => { const p = plan(text); return p ? m.mutateAsync(p, opts) : Promise.resolve(); },
  };
}

export function useToggleGrocery() {
  return useGuardedOptimistic(
    (prev, { id, checked }) => prev.map((it) => (it.id === id ? { ...it, checked } : it)),
    ({ id, checked }) => db.toggleGroceryItem(id, checked),
    (v) => v?.id,
  );
}

export function useDeleteGrocery() {
  return useGuardedOptimistic(
    (prev, id) => prev.filter((it) => it.id !== id),
    (id) => db.deleteGroceryItem(id),
    (id) => id,
  );
}

/** Change an item's quantity in place — the stepper on a row.
 *
 *  Re-formats from the WHOLE parse, not just the name: quantity, store and
 *  pinned section all live in the same string, so rebuilding it from `name`
 *  alone (which is what this used to do) would drop "@Costco" on the floor
 *  every time you tapped +. */
const reQty = (item, qty) => { const p = parseItem(item); return formatItem(qty, p.name, p); };

export function useSetGroceryQty() {
  return useGuardedOptimistic(
    (prev, { id, qty }) => prev.map((it) => (it.id === id ? { ...it, item: reQty(it.item, qty) } : it)),
    ({ id, qty, item }) => db.updateGroceryItem(id, { item: reQty(item, qty) }),
    (v) => v?.id,
  );
}

/**
 * Edit a row in place — the name, its store, its pinned section, all at once.
 *
 * Takes the already-composed item string (the panel builds it with formatItem)
 * so this stays the same shape as every other mutation here: one optimistic
 * write, one request, one rollback. Quantity rides along inside that string,
 * which is why the editor can change it too without a second round trip.
 */
export function useEditGrocery() {
  return useGuardedOptimistic(
    (prev, { id, item }) => prev.map((it) => (it.id === id ? { ...it, item } : it)),
    ({ id, item }) => db.updateGroceryItem(id, { item }),
    (v) => v?.id,
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
      // One un-landed row in the cart would 400 and take the whole clear down
      // with it, tally included. It leaves the screen either way — Promise.all
      // rejects on the first failure, so this is not a place to be optimistic.
      await Promise.all(items.filter((g) => !isTempId(g.id)).map((g) => db.deleteGroceryItem(g.id)));
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
