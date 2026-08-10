import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";
import {
  parseItem, formatItem, bumpFrequency, STAPLES_KEY,
  planAdd, applyAdd, requestFor, isTempId, TMP_PREFIX, applyRetag,
} from "../features/food/groceryLogic.js";

// Exported because the outbox registers the replayed writes from outside this
// module (lib/queryClient.js) and they have to invalidate the same list.
export const GROCERIES = ["groceries"];
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
// The recipes read made the same mistake one function further down: it ended in
// `.catch(() => [])`, so a failed read came back as a *successful empty list*
// and the panel drew "nothing saved" over however many recipes are actually in
// the table. Persistence turned that from a wrong screen into a remembered one —
// main.jsx dehydrates successful queries, so one blip on launch was written to
// localStorage as "you have no recipes" and outlived the blip for a day.
//
// It throws now. The query lands in `error` with the last good list still in
// `data`, which is the contract every other read in this file follows. FoodPanel
// has no error state for this list yet, so a failure still draws the same absent
// Saved section as an empty list — but it no longer stores the failure as a
// fact, and there is now something true for that panel to render when it gets one.
export function useSavedRecipes() {
  return useQuery({ queryKey: RECIPES, queryFn: () => db.loadSavedRecipes() });
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
function useOptimisticGrocery(apply, mutationFn, mutationKey) {
  const qc = useQueryClient();
  return useMutation({
    // The key is what lets a paused write be found again after a relaunch — see
    // the outbox note below. It changes nothing about how this mutation runs.
    mutationKey,
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
function useGuardedOptimistic(apply, mutationFn, idOf, mutationKey) {
  const m = useOptimisticGrocery(apply, mutationFn, mutationKey);
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

// ─── The outbox: what a write needs to survive being relaunched ────────────────
// Writes keep react-query's default networkMode, so a write made with no signal
// PAUSES instead of failing (lib/queryClient.js has the reasoning). The pause is
// checked before the mutation function is ever called, which is worth stating
// plainly because everything below depends on it: A PAUSED WRITE HAS NOT BEEN
// SENT AND CANNOT HAVE BEEN.
//
// That was only half a promise, because the pause did not survive the process.
// The optimistic cache write is persisted along with every read, so you could
// tick an item off in a dead zone, relaunch the next morning to a still-ticked
// box, and watch it un-tick itself the moment the first good read landed. The
// app had shown a saved write that never happened and never would. Two pieces
// were missing: a dehydrated mutation keeps its key, its state and its variables
// and NOTHING ELSE — a function cannot be serialised — so nothing could re-find
// the request to send; and nothing ever called resumePausedMutations().
//
// So every write here gets a stable key, and the ones that may honestly be
// replayed get a function registered against that key in lib/queryClient.js,
// where it is reachable on a launch that never opens the grocery tab.
//
// EVERY FUNCTION IN GROCERY_REPLAY IS A FUNCTION OF ITS VARIABLES AND NOTHING
// ELSE — no cache reads, no closure over React state, no clock. That is the
// entire requirement for replay: after a reload there is no cache to read and no
// component to read from, only the variables that were written to disk. The
// hooks use these same functions rather than inline copies, so the write that
// replays is literally the write that was made and the two cannot drift.
export const GROCERY_KEYS = {
  add: ["grocery", "add"],
  toggle: ["grocery", "toggle"],
  qty: ["grocery", "qty"],
  edit: ["grocery", "edit"],
  delete: ["grocery", "delete"],
  retag: ["grocery", "retag-store"],          // key only — see GROCERY_REPLAY
  clearChecked: ["grocery", "clear-checked"], // key only — see GROCERY_REPLAY
};

/** Re-format an item string with a new quantity — the stepper on a row, and the
 *  write that stepper sends.
 *
 *  Re-formats from the WHOLE parse, not just the name: quantity, store and
 *  pinned section all live in the same string, so rebuilding it from `name`
 *  alone (which is what this used to do) would drop "@Costco" on the floor
 *  every time you tapped +. */
const reQty = (item, qty) => { const p = parseItem(item); return formatItem(qty, p.name, p); };

/**
 * The requests the outbox is allowed to replay — and WHY GROCERY IS THE SAFE
 * THING TO PILOT THAT ON.
 *
 * Replaying a write is only defensible if sending it twice means what sending it
 * once meant, because an outbox cannot prove a request never landed. It can only
 * prove one was never started, which is what isPaused means.
 *
 * Every write here sends an ABSOLUTE value rather than a delta. A toggle sets
 * checked to exactly true or false. A quantity change, an edit and an add that
 * merges all send the finished item string, composed at the moment you tapped. A
 * delete names a row. Send any of them twice and the row still ends up where it
 * was going. The one that isn't a value at all is an add that inserts — there is
 * no server id for it to be absolute about — and that one is safe for the
 * narrower reason above: a paused insert has never called this function, so the
 * replay is the first send rather than a second one.
 *
 * TWO OF THE SEVEN KEYS ARE DELIBERATELY ABSENT HERE, and a key with no entry is
 * exactly how something stays out: lib/queryClient.js registers what it finds in
 * this object, and only what is registered is written to disk.
 *
 * CLEAR-CHECKED, because its frequency tally is a DELTA — bumpFrequency adds one
 * buy per cleared item — so a replay inflates the counts that decide whether a
 * thing ever surfaces as a staple, which is the same damage the comment on
 * useClearCheckedGroceries was written for. And it composes that write by reading
 * the tally out of the query cache, so it is not a function of its variables at
 * all: after a relaunch there is no trustworthy base to add to. The cart still
 * clears optimistically and the deletes still go out while the app is open. They
 * just don't come back from the dead.
 *
 * RETAG-STORE, for a subtler reason worth writing down, because the request
 * itself is perfectly replayable — every update sends a finished string and every
 * delete names a row. The problem is that renaming a store is only HALF a
 * mutation. The other half is the grocery_stores setting, and GroceryPanel writes
 * that from a per-call onSuccess passed to mutate() precisely so it lands only if
 * the item rewrite succeeded. Per-call callbacks are not dehydrated. So a
 * replayed rename would rewrite every item to the new name and leave the setting
 * holding the old one — and storesOf unions the two, which puts two shops in the
 * picker where you renamed one. That is the exact bug the comment at that call
 * site was written to fix, and an outbox that reintroduces it on relaunch has
 * made things worse rather than better. An offline rename is therefore still lost
 * on relaunch, as it is today; landing half of it would be the lie.
 *
 * Finance's CSV import stays out for the plainest reason of all — replaying a
 * bulk import is how you end up with every transaction twice.
 */
export const GROCERY_REPLAY = {
  add: (plan) => {
    const r = requestFor(plan);
    return r.op === "update" ? db.updateGroceryItem(r.id, r.patch) : db.addGroceryItem(r.item);
  },
  toggle: ({ id, checked }) => db.toggleGroceryItem(id, checked),
  qty: ({ id, qty, item }) => db.updateGroceryItem(id, { item: reQty(item, qty) }),
  edit: ({ id, item }) => db.updateGroceryItem(id, { item }),
  delete: (id) => db.deleteGroceryItem(id),
};

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
    mutationKey: GROCERY_KEYS.add,
    mutationFn: GROCERY_REPLAY.add,
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
    GROCERY_REPLAY.toggle,
    (v) => v?.id,
    GROCERY_KEYS.toggle,
  );
}

export function useDeleteGrocery() {
  return useGuardedOptimistic(
    (prev, id) => prev.filter((it) => it.id !== id),
    GROCERY_REPLAY.delete,
    (id) => id,
    GROCERY_KEYS.delete,
  );
}

/** Change an item's quantity in place — the stepper on a row. reQty and the
 *  request both live in the outbox block above, because the write this sends has
 *  to be reproducible from its variables alone. */
export function useSetGroceryQty() {
  return useGuardedOptimistic(
    (prev, { id, qty }) => prev.map((it) => (it.id === id ? { ...it, item: reQty(it.item, qty) } : it)),
    GROCERY_REPLAY.qty,
    (v) => v?.id,
    GROCERY_KEYS.qty,
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
    GROCERY_REPLAY.edit,
    (v) => v?.id,
    GROCERY_KEYS.edit,
  );
}

/**
 * Rename a store, or remove it — one plan, many rows.
 *
 * Because the store is part of each item's text, this is a bulk rewrite: N
 * updates and however many deletes the merge produced (see planRetag). Rows
 * whose insert is still in flight are dropped from the plan rather than sent —
 * a temporary id is a guaranteed 400, and one of those inside Promise.all takes
 * the whole rename down with it.
 *
 * Not Promise.allSettled: a half-applied rename is worse than a failed one,
 * because you'd be left with items split across the old and new name and no
 * indication of which. Failing whole means the rollback restores the list you
 * had, and you can just try again.
 */
export function useRetagGroceryStore() {
  const qc = useQueryClient();
  return useMutation({
    // Keyed, but with no entry in GROCERY_REPLAY, so it stays out of the outbox.
    // The request would replay cleanly; the saved-store half of the rename, which
    // GroceryPanel writes from a per-call onSuccess, would not — and half a rename
    // is the two-shops-for-one bug that call site already paid for. The full
    // argument is in the GROCERY_REPLAY docstring.
    mutationKey: GROCERY_KEYS.retag,
    mutationFn: async (plan) => {
      await Promise.all([
        ...plan.updates.map((u) => db.updateGroceryItem(u.id, { item: u.item })),
        ...plan.deletes.map((id) => db.deleteGroceryItem(id)),
      ]);
    },
    onMutate: async (plan) => {
      await qc.cancelQueries({ queryKey: GROCERIES });
      const prev = qc.getQueryData(GROCERIES) || [];
      qc.setQueryData(GROCERIES, applyRetag(prev, plan));
      return { prev };
    },
    onError: (_e, _plan, ctx) => { if (ctx?.prev) qc.setQueryData(GROCERIES, ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: GROCERIES }),
  });
}

/**
 * Clearing the cart is also the only honest signal of what you actually buy —
 * you checked it off and took it home. That's where the frequency tally is
 * incremented from, not from what gets typed and later deleted.
 */
export function useClearCheckedGroceries() {
  const qc = useQueryClient();
  return useMutation({
    // Keyed like the rest, but with no entry in GROCERY_REPLAY, which keeps it
    // out of the outbox — the tally below is a delta and the mutationFn reads the
    // cache, so this is the one grocery write a replay would corrupt rather than
    // complete. The full argument is in the GROCERY_REPLAY docstring.
    mutationKey: GROCERY_KEYS.clearChecked,
    mutationFn: async (items) => {
      // THE BASE HAS TO BE REAL. `getQueryData(...) || {}` fabricated one
      // whenever the tally had never loaded — and bumpFrequency then returned
      // a tally containing only this cart, which the write below put over the
      // top of every buy count in the database. Losing them is not cosmetic:
      // staples only surface once an item crosses STAPLE_MIN_BUYS, so the
      // suggestions quietly stop and nothing says why.
      //
      // No trustworthy base means no tally write. The cart still clears, which
      // is what was actually asked for; the counts simply do not move.
      const base = qc.getQueryData(GROCERY_FREQ);
      const tally = base && typeof base === "object" ? bumpFrequency(base, items) : null;
      // One un-landed row in the cart would 400 and take the whole clear down
      // with it, tally included. It leaves the screen either way — Promise.all
      // rejects on the first failure, so this is not a place to be optimistic.
      await Promise.all(items.filter((g) => !isTempId(g.id)).map((g) => db.deleteGroceryItem(g.id)));
      if (tally) await db.saveSetting(STAPLES_KEY, tally);
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
      // A FAILED READ IS NOT AN EMPTY TALLY. This swallowed the error and
      // returned {}, which react-query then cached as real data — and the next
      // cart clear reads that cached tally, adds the cart to it, and writes the
      // result back. So one settings blip permanently destroyed every buy count
      // the app had learned, and with them the staple suggestions that only
      // appear once a thing crosses STAPLE_MIN_BUYS. Throwing puts the query in
      // `error` with the last good tally still in `data`, which is the whole
      // contract the rest of the app's queries follow.
      const all = await db.loadSettings();
      const t = all?.[STAPLES_KEY];
      return t && typeof t === "object" && !Array.isArray(t) ? t : {};
    },
    staleTime: 5 * 60 * 1000, // it only changes when you clear the cart
  });
}

export const useSaveRecipe = () => useInvalidatingMutation(RECIPES, ({ title, body }) => db.saveRecipe(title, body));
export const useDeleteRecipe = () => useInvalidatingMutation(RECIPES, (id) => db.deleteRecipe(id));
