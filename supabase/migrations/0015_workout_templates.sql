-- ═══════════════════════════════════════════════════════════════════════════
-- 0015 · boardroom.workout_templates — the routines, not the sessions
--
-- `exercises` is jsonb, holding the array of exercise definitions a template
-- prescribes. It is not normalised into rows and should not be: a template is
-- edited and saved whole, never queried by exercise, and the shape is validated
-- in JS on the way out of localStorage (see the deep shape guard in
-- WorkoutPanel.jsx, which exists because a drifted checkpoint used to white-
-- screen the tab on every visit).
--
-- `position` is the hand-arranged order of the list, with created_at as the tie
-- break — makeWdb().loadTemplates() orders by position then created_at, hence
-- the index covering both.
--
-- THIS IS ONE OF THE FOUR SCHEMA CORRECTIONS. WorkoutPanel.jsx still shows the
-- user `create table if not exists public.workout_templates`, and `public` is a
-- schema this app cannot read. See 0000_schema.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.workout_templates (
  id         uuid        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  name       text        not null,
  unit       text        not null default 'lb',
  exercises  jsonb       not null default '[]'::jsonb,
  position   integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workout_templates_user_position_idx
  on boardroom.workout_templates (user_id, position, created_at);

alter table boardroom.workout_templates enable row level security;

-- The name matches WORKOUT_SETUP_SQL in WorkoutPanel.jsx. That block has no
-- `drop policy if exists`, so re-running it against a database that already has
-- the policy errors out — this file adds the drop so it is genuinely re-runnable.
drop policy if exists "own workout_templates" on boardroom.workout_templates;
create policy "own workout_templates" on boardroom.workout_templates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.workout_templates to authenticated;
