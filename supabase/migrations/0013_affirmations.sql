-- ═══════════════════════════════════════════════════════════════════════════
-- 0013 · boardroom.affirmations — the Creed
--
-- Copied from CREED_SETUP_SQL in src/features/creed/CreedPanel.jsx, which is
-- already boardroom-qualified and already carries its grants. This is the one
-- setup block in the app that was corrected rather than the one that shipped
-- wrong — scripts/dreams-smoke.mjs checks it against the schema in supabase.js
-- on every verify, which is why it has stayed right.
--
-- `kind` defaults to 'creed' and separates the Creed's lines from anything else
-- filed alongside them. `text` is the column name, which is also a type name in
-- Postgres — legal, and left alone: db.loadAffirmations selects it by that name
-- and CreedPanel renders it by that name, so renaming the column would be a
-- change to live reads for no gain.
--
-- Ordered created_at ascending: the Creed is a numbered list, and the number is
-- the position you wrote it in. CreedPanel renders those positions as Roman
-- numerals, so a re-sort would silently renumber your own doctrine.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.affirmations (
  id         uuid        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  text       text        not null,
  kind       text        not null default 'creed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists affirmations_user_created_idx
  on boardroom.affirmations (user_id, created_at);

alter table boardroom.affirmations enable row level security;

-- The name matches CreedPanel.jsx's setup card, so this is a no-op against
-- production rather than a second policy.
drop policy if exists "affirmations own rows" on boardroom.affirmations;
create policy "affirmations own rows" on boardroom.affirmations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.affirmations to authenticated;
