import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db.js";

const KEY = ["dream-items"];

export function useDreamItems() {
  return useQuery({ queryKey: KEY, queryFn: () => db.loadDreamItems() });
}

function useInvalidating(mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export const useSaveDreamItem = () => useInvalidating((it) => db.saveDreamItem(it));
export const useDeleteDreamItem = () => useInvalidating((id) => db.deleteDreamItem(id));
export const useRenameDreamBoard = () => useInvalidating(({ from, to }) => db.renameDreamBoard(from, to));

// ─── the deletes are reversible now, and the caller has to carry the receipt ──
// db.deleteDreamBoard marks its tiles instead of destroying them and RESOLVES WITH
// THE IDS IT MARKED, so the mutation's onSuccess receives them:
//
//   dropBoardMut.mutate(name, { onSuccess: (ids) => offerUndo(ids) })
//
// and passing that same array to useRestoreDreamItems puts exactly those tiles
// back — not every tile that shares the board name, which would also drag in one
// you deleted on its own three weeks ago. A single tile's undo is its own id.
//
// DreamBoardPanel draws it: a board delete keeps the ids dropBoardMut resolves
// with and offers Undo through useRestoreDreamItems, and the confirm no longer
// says it can't be undone. The hooks exist so that stayed a panel change and not
// a data-layer one.
export const useDeleteDreamBoard = () => useInvalidating((board) => db.deleteDreamBoard(board));
export const useRestoreDreamItems = () => useInvalidating((ids) => db.restoreDreamItems(ids));
