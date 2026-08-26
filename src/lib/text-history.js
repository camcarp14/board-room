// ─── Undo for the note editor, because the browser's own is gone ─────────────
//
// A <textarea> has undo built in. This one does not, and it is worth being
// precise about why, because "just use the native stack" is the obvious answer
// and it does not work here.
//
//   THE FIELD IS CONTROLLED. NotesPanel renders `value={draft.body}` and rewrites
//   it from React state on every keystroke. WebKit — which is every browser on
//   the iPhone this app is mostly used from — treats a programmatic value
//   assignment as a reason to drop the undo stack. So ⌘Z inside the editor is
//   unreliable at best and, once React has re-rendered the field, usually a
//   no-op.
//
//   THE BULLET HELPERS GUARANTEE IT. continueListOnEnter and toggleBulletAtCaret
//   (src/ui/shared.jsx) rewrite the whole value and then call setSelectionRange
//   to put the caret back. That is exactly the operation that clears native undo
//   in every engine. Press Enter once inside a list and whatever the browser was
//   still holding is gone.
//
//   AND ON A PHONE THERE IS NO ⌘Z ANYWAY. iOS offers shake-to-undo and the
//   keyboard's undo key, both of which read the same native stack the two points
//   above have already emptied. The primary device had no undo at all.
//
// So the editor keeps its own history. Pure and framework-free so
// scripts/text-history-smoke.mjs can drive it — the coalescing rules below are
// the whole feel of the feature and they are not something you can eyeball.

// A run of typing is ONE undo, not one per keystroke. Anything else and undo is
// a character-by-character rewind that nobody can use.
export const COALESCE_MS = 600;
// Past this, a single edit is a paste or a cut rather than typing, and it gets
// its own step whatever else is going on.
export const BIG_EDIT = 24;
// Far more than anyone will reach in one editing session, and small enough that
// a very long note's history cannot grow without bound.
export const MAX_ENTRIES = 200;

const snap = (v) => ({ title: v?.title ?? "", body: v?.body ?? "" });
const same = (a, b) => a.title === b.title && a.body === b.body;

/**
 * Which field moved, and in which direction.
 *
 * "delete" is the case this whole module exists for and it is treated as
 * special everywhere below: a deletion NEVER merges into the entry before it, so
 * one undo puts back exactly what one act removed. Merging a deletion into the
 * typing that preceded it is how you get an undo that restores the text and then
 * eats the sentence you wrote before it.
 */
function classify(prev, next) {
  for (const field of ["body", "title"]) {
    if (prev[field] === next[field]) continue;
    const delta = next[field].length - prev[field].length;
    return { field, delta, kind: delta > 0 ? "insert" : delta < 0 ? "delete" : "replace" };
  }
  return null;
}

/**
 * A linear undo stack with a cursor.
 *
 * REDO IS TRUNCATED BY A NEW EDIT, which is the behaviour every text editor has
 * and the one people have muscle memory for: undo three times, type a character,
 * and the three things you undid are not coming back. Keeping them would let a
 * later redo overwrite text typed after them.
 */
export function createTextHistory(initial = {}) {
  let entries = [{ ...snap(initial), field: "body", caret: (initial?.body ?? "").length }];
  let i = 0;                 // cursor into entries; entries[i] is what is on screen
  let lastAt = 0;            // when the entry at the cursor was pushed
  let lastKind = null;       // how it got there — "insert" merges, "delete" never does

  const clampCursor = () => { i = Math.max(0, Math.min(i, entries.length - 1)); };

  return {
    /** Start over on a different note. The seed is the note's saved text, so the
     *  first undo in a session can only ever reach what was already stored — it
     *  can never wind back past the point the editor was opened at and show you
     *  a different note's words. */
    reset(value) {
      entries = [{ ...snap(value), field: "body", caret: (value?.body ?? "").length }];
      i = 0; lastAt = 0; lastKind = null;
    },

    /**
     * Record an edit. Returns true if a NEW step was created (as opposed to the
     * current one being extended), which is only useful to tests — callers push
     * unconditionally and let the rules here decide.
     *
     * `now` is injected so the smoke can drive coalescing without sleeping.
     */
    push(value, { field, caret, now = Date.now() } = {}) {
      const next = snap(value);
      const cur = entries[i];
      if (same(cur, next)) return false;         // nothing moved; not a step
      const how = classify(cur, next);
      const at = typeof caret === "number" ? caret : (next[how?.field || "body"] || "").length;
      const on = field || how?.field || "body";

      // MERGE ONLY A RUN OF ORDINARY TYPING INTO ITSELF. Every clause is a case
      // that must break the run: a deletion (the one we are protecting), a big
      // edit (paste/cut), a pause, a jump to the other field, or a redo branch
      // we are about to truncate.
      const merges =
        lastKind === "insert" && how?.kind === "insert" &&
        Math.abs(how.delta) < BIG_EDIT &&
        now - lastAt <= COALESCE_MS &&
        cur.field === on &&
        i === entries.length - 1;

      if (merges) {
        entries[i] = { ...next, field: on, caret: at };
        lastAt = now;
        return false;
      }

      // A new edit after undoing discards the redo branch — standard, and
      // necessary: those entries describe a future that no longer follows from
      // the text now on screen.
      entries = entries.slice(0, i + 1);
      entries.push({ ...next, field: on, caret: at });
      if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
      i = entries.length - 1;
      lastAt = now; lastKind = how?.kind || "replace";
      return true;
    },

    canUndo: () => i > 0,
    canRedo: () => i < entries.length - 1,

    /** Step back. Returns the state to paint, or null when there is nothing to
     *  undo — callers use null to leave the field untouched rather than to clear
     *  it, which would be the worst possible reading of "undo". */
    undo() {
      if (i <= 0) return null;
      i -= 1;
      // A step taken breaks the typing run: the next keystroke must start a NEW
      // entry rather than merging into the one we just landed on, or typing
      // after an undo would silently rewrite the thing you undid to.
      lastKind = null; lastAt = 0;
      clampCursor();
      return { ...entries[i] };
    },

    redo() {
      if (i >= entries.length - 1) return null;
      i += 1;
      lastKind = null; lastAt = 0;
      clampCursor();
      return { ...entries[i] };
    },

    /** What is on screen according to the history — used to keep the editor and
     *  the stack from drifting when something else writes the draft. */
    current: () => ({ ...entries[i] }),
    depth: () => entries.length,
  };
}
