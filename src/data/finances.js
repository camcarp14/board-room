import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

const KEY = ["transactions"];

// Deliberately NOT `.catch(() => [])`. A failed read that resolves to an empty
// array is stored by react-query as a successful empty result, and in a
// budgeting tool that renders as a month where you spent nothing — indis-
// tinguishable from a real quiet month, and far worse than an error. Letting it
// throw puts the query in `error` while `data` keeps the last good ledger.
// Returns the envelope, not the bare array: `{ rows, total, limit, capped }`.
// loadTransactions caps at 5,000 and PostgREST has a max-rows ceiling of its own,
// and until this carried `capped` a silent slice was indistinguishable from the
// whole history — so the month totals, the budget status and the recurring
// detector were all computed over "some of it" and presented as "all of it".
// A wrong number is worse here than a missing one, because a budget you are
// under by a slice is a budget you think you are under.
export function useTransactions() {
  return useQuery({ queryKey: KEY, queryFn: () => db.readTransactions() });
}

/** An import. Returns how many rows were written so the receipt can say so. */
export function useImportTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows) => db.saveTransactions(rows),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * Recategorising one row.
 *
 * Optimistic, because this is the one thing you do repeatedly while reading the
 * breakdown — tap, tap, tap down a list — and a round trip per tap makes the
 * whole exercise feel broken. Writes `category_override` rather than `category`
 * so the imported value survives underneath: re-importing the same export can
 * never quietly undo a correction you made.
 *
 * The cached data is the ENVELOPE from useTransactions, so the optimistic
 * update maps `old.rows`, not `old`. It mapped `old` directly for a while,
 * which threw inside onMutate — and react-query runs onMutate BEFORE the
 * mutationFn, so the throw aborted the whole mutation: "Just this one" closed
 * the sheet and changed nothing, with no error anywhere.
 */
export function useSetCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, category }) => db.setTransactionCategory(id, category),
    onMutate: async ({ id, category }) => {
      await qc.cancelQueries({ queryKey: KEY });
      const prev = qc.getQueryData(KEY);
      qc.setQueryData(KEY, (old) => (old
        ? { ...old, rows: (old.rows || []).map((t) => (t.id === id ? { ...t, category_override: category } : t)) }
        : old));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev !== undefined) qc.setQueryData(KEY, ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Removing an account's rows — the undo for importing the wrong file. */
export function useForgetAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (account) => db.deleteTransactionsForAccount(account),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
