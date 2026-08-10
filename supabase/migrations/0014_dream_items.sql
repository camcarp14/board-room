-- ═══════════════════════════════════════════════════════════════════════════
-- 0014 · boardroom.dream_items — ONE table, not two
--
-- Copied from SETUP_SQL in src/features/dreams/dreamLogic.js, which already
-- carries the correct schema and the grants. The table this whole directory
-- exists because of: the first version of that block said `public.dream_items`,
-- and running it created a real table the app could never see — the loader kept
-- 404ing and the panel kept offering the setup card that had just been run.
-- Nothing about that is visible from either side.
--
-- A board is a text VALUE on the tile rather than a row of its own, so a board
-- can never be orphaned, renamed halfway, or left holding rows that point at a
-- board that was deleted. Renaming a board rewrites every tile on it
-- (db.renameDreamBoard); deleting one deletes its tiles. The list of boards is
-- derived from the tiles by dreamLogic.boardsOf and unioned with the names saved
-- in app_settings, which is what lets a board you just created survive being
-- empty. Exactly the shape the grocery list's stores landed on.
--
-- `sort` is the arranged position within a board, with created_at as the tie
-- break, which is why the index is (user_id, board, sort) and not (user_id, sort).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.dream_items (
  id         uuid        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  board      text        not null default 'Dreams',
  title      text        not null default '',
  image_url  text,
  note       text,
  sort       integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dream_items_board_idx
  on boardroom.dream_items (user_id, board, sort);

alter table boardroom.dream_items enable row level security;

-- The name matches dreamLogic.js's setup card, so this is a no-op against
-- production rather than a second policy.
drop policy if exists "dream_items own rows" on boardroom.dream_items;
create policy "dream_items own rows" on boardroom.dream_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.dream_items to authenticated;

-- ─── deleted_at · the delete that took a whole wall ─────────────────────────
-- Added after the fact, which is why it is an alter rather than a column in the
-- create above: this table is live and the create is a no-op against it. Written
-- with `if not exists` so the file stays re-runnable, the property
-- scripts/migrations-smoke.mjs checks.
--
-- THE CALL THIS IS FOR: db.deleteDreamBoard used to be one statement that deleted
-- every tile on a board, behind a single confirm dialog, with no undo and — until
-- the week this was written — no backup either. It now writes now() into this
-- column and hands the ids back to the caller, db.loadDreamItems filters on
-- `deleted_at is null`, and db.restoreDreamItems clears it again. The rows are
-- destroyed thirty days later by `purge deleted > 30d` in
-- netlify/functions/db-admin.js.
--
-- NULL means live. The timestamp is the thirty-day clock, so a boolean flag would
-- need a second column to carry the same thing.
--
-- db.renameDreamBoard deliberately rewrites `board` on deleted rows as well as live
-- ones. The board name is the only link between a tile and a board, so a deleted
-- tile left behind on the old name comes back onto a board that no longer exists.
--
-- No partial index. dream_items_board_idx above still serves the filtered read at
-- the size a hand-built vision board reaches, and a partial index here would be an
-- object nobody can measure.
alter table boardroom.dream_items
  add column if not exists deleted_at timestamptz;

-- If the first version of the in-app block was ever run, it made
-- public.dream_items, which this app cannot see. Nothing was ever written to it:
--   drop table if exists public.dream_items;
