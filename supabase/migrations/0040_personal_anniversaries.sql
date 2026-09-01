-- ═══════════════════════════════════════════════════════════════════════════
-- 0040 · boardroom.personal_anniversaries — the days that already happened
--
-- personal_birthdays (0007) records days that come around for people who are
-- here. This records the other kind: the day somebody died, and any other date
-- worth being reminded of on its anniversary — a start date, a move, a
-- diagnosis, a wedding. Deliberately a SECOND TABLE rather than a `kind` column
-- bolted onto birthdays: the two lists are read for opposite reasons ("whose
-- birthday do I need a card for" vs "what happened on this date"), the Brief's
-- birthday card and trmnl.js both read personal_birthdays as "upcoming
-- birthdays" with no filter, and a passing that arrived in that list because of
-- a forgotten `where kind = 'birthday'` is the worst bug this app could ship.
--
-- Month and day are separate integers for the same reason as 0007: the row
-- repeats every year by construction, so there is no single date to store.
-- `year` is the year it HAPPENED and is nullable — it exists only so the app
-- can say "five years today", and src/lib/anniversaries.js refuses to count
-- from a year that is absent, before 1900, or in the future rather than
-- printing a confident wrong number on the day somebody died.
--
-- `kind` is 'passing' or 'milestone', checked here so a typo in a future client
-- can't create a third kind the UI has no words for. The client normalizes
-- anything unknown to 'milestone' on read — wrong in the harmless direction.
-- To add a kind: extend the check constraint and ANNIVERSARY_KINDS together.
--
-- No ORDER BY on the read and no index, exactly as 0007: the sort is "soonest
-- next occurrence", which is a function of today's date and cannot be an index,
-- and this is a full read of a short table.
--
-- Re-runnable: create if not exists, policy created only when absent, and the
-- check constraint added only when it isn't already there.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.personal_anniversaries (
  id         uuid        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  name       text        not null,
  kind       text        not null default 'milestone',
  month      integer     not null,
  day        integer     not null,
  year       integer,
  notes      text        not null default '',
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'personal_anniversaries_kind_check'
      and conrelid = 'boardroom.personal_anniversaries'::regclass
  ) then
    alter table boardroom.personal_anniversaries
      add constraint personal_anniversaries_kind_check check (kind in ('passing', 'milestone'));
  end if;
end $$;

alter table boardroom.personal_anniversaries enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'personal_anniversaries'
  ) then
    create policy "personal_anniversaries own rows" on boardroom.personal_anniversaries
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.personal_anniversaries to authenticated;
