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

-- If the first version of the in-app block was ever run, it made
-- public.dream_items, which this app cannot see. Nothing was ever written to it:
--   drop table if exists public.dream_items;
