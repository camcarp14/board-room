-- ═══════════════════════════════════════════════════════════════════════════
-- 0017 · boardroom.body_weight_log — one number, logged over and over
--
-- Copied from WORKOUT_SETUP_SQL in src/WorkoutPanel.jsx, schema-corrected. The
-- two CHECK constraints come from that block and are worth keeping: a weight
-- outside (0, 1500) is a typo rather than a reading, and a unit that is not 'lb'
-- or 'kg' makes every chart on the card a lie about magnitude.
--
-- The reader is the one place in the Train tab that degrades instead of throwing:
-- makeWdb().loadBodyWeight() returns { error: message } when the table is
-- missing so the card can SAY the table is missing. That is the house rule doing
-- its job — an empty chart and a chart that could not be loaded look identical,
-- and only one of them is true.
--
-- THIS IS ONE OF THE FOUR SCHEMA CORRECTIONS. WorkoutPanel.jsx still shows the
-- user `create table if not exists public.body_weight_log`. See 0000_schema.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.body_weight_log (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  weight     numeric     not null check (weight > 0 and weight < 1500),
  unit       text        not null default 'lb' check (unit in ('lb', 'kg')),
  logged_at  timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists body_weight_log_user_time
  on boardroom.body_weight_log (user_id, logged_at desc);

alter table boardroom.body_weight_log enable row level security;

-- The name matches WORKOUT_SETUP_SQL; the drop is added here for re-runnability
-- (see the same note in 0015_workout_templates.sql).
drop policy if exists "own body_weight_log" on boardroom.body_weight_log;
create policy "own body_weight_log" on boardroom.body_weight_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.body_weight_log to authenticated;
