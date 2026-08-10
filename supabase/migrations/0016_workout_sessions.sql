-- ═══════════════════════════════════════════════════════════════════════════
-- 0016 · boardroom.workout_sessions — what actually happened
--
-- The three denormalised totals — total_volume, total_sets, pr_count — are
-- computed at save time from `exercises` and stored anyway. That is on purpose:
-- the Train tab's history, the 12-week volume shape and the all-time bests all
-- read them straight, and recomputing them out of jsonb on every render is work
-- for an answer that cannot change after the session ends. total_volume and
-- total_sets are nullable because an imported session may not carry enough to
-- compute them, and a null reads as "unknown" where a 0 would read as "you did
-- nothing".
--
-- template_id is a plain uuid with NO foreign key to workout_templates,
-- deliberately: deleting a routine must not delete the sessions you did with it,
-- and template_name is stored alongside so a finished session can still say what
-- it was even after the template is gone.
--
-- Two readers, one index. makeWdb().loadSessions() takes the newest 300 ordered
-- started_at desc — 300 rather than 120 because Rides reads all-time bests out
-- of the same list, and a rider who also lifts four times a week would have had
-- their cycling history quietly cut off at the old ceiling. workout-import.js
-- reads the same window (started_at, exercises, limit 300) with the service role
-- to dedupe an incoming import.
--
-- THIS IS ONE OF THE FOUR SCHEMA CORRECTIONS. WorkoutPanel.jsx still shows the
-- user `create table if not exists public.workout_sessions`. See 0000_schema.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.workout_sessions (
  id            uuid        primary key,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  template_id   uuid,
  template_name text,
  unit          text        not null default 'lb',
  started_at    timestamptz not null,
  ended_at      timestamptz,
  duration_sec  integer,
  notes         text        not null default '',
  exercises     jsonb       not null default '[]'::jsonb,
  total_volume  numeric,
  total_sets    integer,
  pr_count      integer     not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists workout_sessions_user_started_idx
  on boardroom.workout_sessions (user_id, started_at desc);

alter table boardroom.workout_sessions enable row level security;

-- The name matches WORKOUT_SETUP_SQL; the drop is added here for re-runnability
-- (see the same note in 0015_workout_templates.sql).
drop policy if exists "own workout_sessions" on boardroom.workout_sessions;
create policy "own workout_sessions" on boardroom.workout_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.workout_sessions to authenticated;
