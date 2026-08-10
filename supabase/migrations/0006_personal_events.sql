-- ═══════════════════════════════════════════════════════════════════════════
-- 0006 · boardroom.personal_events — the calendar
--
-- db.loadEvents() selects id,title,notes,start_time,end_time,all_day,location,
-- category,rrule,exdates,series_id ordered start_time ascending, and every write
-- path upserts on `id` alone — the id is generated client-side, so it is the
-- primary key and the conflict target. trmnl.js reads a narrower set of the same
-- columns with the service role to build the e-ink ICS feed.
--
-- THE THREE RECURRENCE COLUMNS ARE WHY THIS TABLE IS NOT SIMPLE.
--
--   rrule      the repeat rule, or null for a one-off. db.saveEvent writes
--              `ev.rrule || null` rather than omitting the key, because editing
--              a repeating event down to "Does not repeat" has to CLEAR the
--              rule, and an omitted key in an upsert leaves the old one standing.
--   exdates    days lifted out of the series. src/lib/recurrence.js builds it as
--              an array of `YYYY-MM-DD` strings and always writes an array, never
--              null, for the same reason. Declared jsonb here; text[] would
--              behave identically over PostgREST and the code cannot tell the
--              two apart, so this is the honest half of a coin flip rather than
--              a reading of the live column.
--   series_id  ties a split-off occurrence back to its master. recurrence.js
--              uses `master.series_id || master.id`, and ids here are
--              crypto.randomUUID() values, so uuid.
--
-- applyEventPlan() lands updates and inserts BEFORE deletes on purpose, so a
-- part-way failure leaves a duplicate occurrence on screen — obvious and fixable
-- by hand — rather than a deleted series with no replacement.
--
-- The index matches the load: my events, in start order.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.personal_events (
  id         uuid        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  title      text        not null,
  notes      text        not null default '',
  start_time timestamptz not null,
  end_time   timestamptz,
  all_day    boolean     not null default false,
  location   text        not null default '',
  category   text        not null default 'personal',
  rrule      text,
  exdates    jsonb       not null default '[]'::jsonb,
  series_id  uuid,
  created_at timestamptz not null default now()
);

create index if not exists personal_events_user_start_idx
  on boardroom.personal_events (user_id, start_time);

-- Editing "this and all future" rewrites a whole series in one pass, which finds
-- its members by series_id (falling back to the master's own id).
create index if not exists personal_events_series_idx
  on boardroom.personal_events (user_id, series_id);

alter table boardroom.personal_events enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'personal_events'
  ) then
    create policy "personal_events own rows" on boardroom.personal_events
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.personal_events to authenticated;
