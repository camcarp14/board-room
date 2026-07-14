import { useQuery } from "@tanstack/react-query";
import { db } from "./db.js";

// db.loadNotes() returns { rows, legacy }. Both note surfaces (the Personal tab
// and the Brief tile) read this one cache, so an edit in either shows in both
// after invalidation, and the header Refresh refetches it like everything else.
export function useNotes() {
  return useQuery({ queryKey: ["notes"], queryFn: () => db.loadNotes() });
}
