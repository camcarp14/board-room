-- ═══════════════════════════════════════════════════════════════════════════
-- 0036 · boardroom.personal_notes — the shelf and the bin
--
-- Two columns, and each one closes a hole that was visible from the app.
--
-- `archived` — there was no way to keep a note and not have it on the Brief.
-- The Brief's tile takes the first five notes by manual order, so the only way
-- to clear the homescreen was to delete the note, which is the wrong trade for
-- something you wrote down on purpose. Archived notes stay in the Notes tab
-- behind a filter and leave the homescreen. Boolean rather than a status enum
-- because there are exactly two answers and a third would need a migration
-- either way.
--
-- `deleted_at` — personal_notes was the last table in this app that lost rows
-- outright. affirmations (0013) and dream_items (0014) were given soft deletes
-- after a wall built over months went behind one confirm dialog; notes kept the
-- hard delete, with a six-second toast holding the rows in memory as the only
-- undo. Miss the toast, background the PWA, or reload, and the note was gone
-- with no copy anywhere. This is the same column, with the same meaning, purged
-- by the same act: `purge deleted > 30d` in netlify/functions/db-admin.js, which
-- now names three tables instead of two.
--
-- BOTH READERS STILL TOLERATE THEIR ABSENCE, exactly as 0008 describes for
-- pinned/color, and for the same reason: this file arrives in the SQL editor by
-- hand and the code arrives on a deploy, in either order. db.loadNotes falls
-- back to the previous column set on a 42703 and reports `legacy`, and the panel
-- shows the upgrade banner rather than an error.
--
-- THE DELETE FALLS BACK TOO, AND THAT IS A DELIBERATE DEPARTURE from
-- 0013/0014, where the delete throws instead. There the choice was between an
-- inconvenience and a loss, because writing deleted_at IS the delete and the
-- only alternative destroys the row. Here the alternative is what notes have
-- always done and what this database is still set up for — the hard delete plus
-- the six-second toast — so refusing to delete at all would break a working
-- feature to protect a column that is not there yet. Falling back leaves notes
-- exactly as capable as they were yesterday, and the banner says why.
--
-- Safe to re-run: add column if not exists, index if not exists.
-- ═══════════════════════════════════════════════════════════════════════════

alter table boardroom.personal_notes
  add column if not exists archived   boolean     not null default false;

alter table boardroom.personal_notes
  add column if not exists deleted_at timestamptz;

-- Every read the app makes is "this user's live notes, newest first"
-- (db.loadNotes) or "this user's bin" (db.loadDeletedNotes). deleted_at leads
-- the trailing columns so both are served by one index: the live read matches
-- deleted_at is null, the bin matches is not null, and updated_at keeps the
-- ordering out of a sort. The 0008 index stays — note-capture's lookups do not
-- filter on deleted_at and should not start paying for a column they ignore.
create index if not exists personal_notes_user_shelf_idx
  on boardroom.personal_notes (user_id, deleted_at, updated_at desc);
