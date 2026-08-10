-- ═══════════════════════════════════════════════════════════════════════════
-- 0021 · boardroom.mini_feed — an append-only note of what the worker did
--
-- Three writers, no reader. mini-worker.js appends a line per finished task and
-- per approve/reject; src/App.jsx appends an "Oversight: …" line when the
-- oversight pass finds that a synthesis flattened a real disagreement between
-- seats. NOTHING in the app selects from this table any more — the surface that
-- displayed it is gone.
--
-- That is recorded here rather than treated as a reason to drop the table. The
-- rows are still being written, they still cost storage, and the oversight lines
-- in particular are the only durable trace that the check ran at all. If this
-- ever gets a reader again it will want an index on (user_id, created_at desc);
-- until then adding one would be an index maintained for no query.
--
-- The browser writes here with the anon key (App.jsx supplies user_id
-- explicitly), so unlike the other server-written tables this one genuinely needs
-- an insert policy and a grant.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.mini_feed (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  text       text        not null,
  created_at timestamptz not null default now()
);

alter table boardroom.mini_feed enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'mini_feed'
  ) then
    create policy "mini_feed own rows" on boardroom.mini_feed
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.mini_feed to authenticated;
