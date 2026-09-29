// ─── The road every note editor save travels ────────────────────────────────
//
// Pure: no React, no Supabase. The save function is handed in (db.saveNote in
// the app, an in-memory table in scripts/note-conflict-smoke.mjs), which is what
// lets the behaviour below be RUN offline rather than pattern-matched.
//
// db.saveNote writes conditionally on the row the editor started from, and when
// it loses that compare-and-set it decides between rebasing and saving a
// "conflicted copy" (the long version is on db.saveNote). That decision is only
// as good as what the caller tells it, and a first version of this lived inline
// in NotesPanel and got four things wrong that a review then ran:
//
//  1. ONE SLOT FOR "WHAT THE SERVER HOLDS". A late save for note A landed after
//     the editor had moved to note B and overwrote B's base with A's row — so
//     B's first save went out unconditional, the overwrite this exists to stop.
//     Bases are now kept PER NOTE, and only ever move forward in time.
//  2. A CONFLICT REDIRECT THAT OUTLIVED ITS EDIT. After a conflict, saves queued
//     for the original must follow the draft onto its copy — but the redirect
//     lived as long as the panel, so reopening the original later to merge by
//     hand wrote into the COPY. Redirects now belong to one editor session.
//  3. A LOST RESPONSE READ AS SOMEBODY ELSE. A save that commits but whose answer
//     never arrives (the phone locked mid-request — "Load failed") left the base
//     on the old stamp, so the next save lost the compare to its own write and
//     minted a conflicted copy of your own words. The session now remembers the
//     stamps it SENT, and db.saveNote treats a row carrying one as ours.
//  4. RETRIES MINTED COPIES. A copy whose upsert answer was lost got a fresh
//     random id on every retry. The copy id is now fixed per session and note,
//     so a retried copy is the same row written again.
//
// Every save goes down one chain, in order: the autosave, the flush on close,
// the flush on hide and on unmount can all be in flight on a slow link, and two
// conditional writes racing from one editor would each read the other's stamp
// as a conflict.

const ms = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : -Infinity;
};

export const noteBase = (n) => (n && n.id
  ? { id: n.id, title: n.title || "", body: n.body || "", pinned: !!n.pinned, color: n.color || null, updated_at: n.updated_at || null }
  : null);

export function createNoteSaver({ save, uuid = () => crypto.randomUUID(), now = () => new Date() } = {}) {
  if (typeof save !== "function") throw new Error("createNoteSaver needs a save function");
  const bases = new Map();
  let chain = Promise.resolve();
  let seq = 0;

  /** Record what the server holds for a note, as far as we know. Never moves a
   *  base backwards: a stale list row must not undo what a save just learned. */
  const learn = (row) => {
    const b = noteBase(row);
    if (!b) return;
    const cur = bases.get(b.id);
    if (!cur || ms(b.updated_at) >= ms(cur.updated_at)) bases.set(b.id, b);
  };

  /** A fresh editor session: open a note, start a new one, reopen a rescue. */
  const newSession = () => ({ id: ++seq, sent: new Set(), redirect: new Map(), copyIds: new Map() });

  /**
   * Queue one save for `session`. Resolves with db.saveNote's answer (which may
   * carry `conflict`), rejects if the write failed. The row's target, base and
   * stamp are all decided when the save RUNS, not when it was queued, so it
   * always starts from whatever the saves ahead of it learned.
   */
  const enqueue = (session, row) => {
    const run = async () => {
      // A session closed on purpose (its note was deleted from this device) sends
      // nothing more: a queued save reaching a binned row would come back as a
      // "deleted elsewhere" conflict and resurrect the note as a copy.
      if (session.cancelled) return null;
      const target = session.redirect.get(row.id) || row.id;
      // Strictly later than anything this session sent, even inside one
      // millisecond, so "the newest stamp is ours" can never be ambiguous.
      let t = now().getTime();
      for (const s of session.sent) if (s >= t) t = s + 1;
      const stamp = new Date(t).toISOString();
      session.sent.add(t);
      if (!session.copyIds.has(target)) session.copyIds.set(target, uuid());
      const saved = await save({ ...row, id: target }, {
        base: bases.get(target) || null,
        stamp,
        mine: session.sent,
        copyId: session.copyIds.get(target),
      });
      if (saved?.conflict) session.redirect.set(saved.conflict.originalId, saved.id);
      learn(saved);
      return saved;
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };

  /** Settles once every save queued so far has run (success or failure). */
  const drain = () => chain;

  return { learn, baseOf: (id) => bases.get(id) || null, newSession, enqueue, drain, stampMs: ms };
}
