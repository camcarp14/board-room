-- ═══════════════════════════════════════════════════════════════════════════
-- 0030 · boardroom.upstream_run_events — the progress trail of a run
--
-- Written only by netlify/lib/upstream/store.js addEvent(), one row per step, and
-- NOT READ ANYWHERE in the app today. That is recorded rather than used as an
-- argument to drop it: the client's design is to follow a run by polling
-- RLS-scoped tables, and this is the table that would carry step-level progress
-- if the page ever shows it. Until then it is written and never queried.
--
-- THE CASCADE IS DECLARED IN THE CODE, so it is declared here. src/lib/upstream.js
-- says plainly that deletes cascade in the database — "a run takes its events with
-- it, a prediction its tell checks" — and deleteRun() therefore issues one delete
-- against upstream_runs and expects the events to go. Without this foreign key
-- that comment becomes false and every deleted run leaves its events behind
-- forever, invisibly.
--
-- `type` is duplicated out of the payload so a future reader can filter without
-- opening jsonb; `payload` is the whole event object.
--
-- `id` is a bigserial: nothing reads it, but the rows are a sequence and a
-- sequence wants a monotonic key. The live column's type was not observable from
-- the code, so treat that as the least surprising choice rather than a reading of
-- production.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.upstream_run_events (
  id         bigserial   primary key,
  run_id     uuid        not null references boardroom.upstream_runs(id) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  type       text,
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists upstream_run_events_run_idx
  on boardroom.upstream_run_events (run_id, id);

alter table boardroom.upstream_run_events enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'upstream_run_events'
  ) then
    create policy "upstream_run_events own rows" on boardroom.upstream_run_events
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.upstream_run_events to authenticated;
