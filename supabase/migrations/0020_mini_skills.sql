-- ═══════════════════════════════════════════════════════════════════════════
-- 0020 · boardroom.mini_skills — what the Learn tab taught the worker
--
-- `enabled` is the column with consequences. mini-worker.js pulls
-- `enabled=eq.true` ordered updated_at desc and concatenates the content into
-- every queue run's system prompt, so this flag is the difference between a
-- skill costing tokens on every task and costing nothing. It defaults to true
-- because a skill you just taught should apply.
--
-- `source_kind` is 'text' for something pasted and names the fetch path
-- otherwise; `source_url` is null for pasted content. Both are provenance rather
-- than function — they exist so the card can say where a skill came from, which
-- is the only way to judge a distillation you did not watch happen.
--
-- Two readers, one index: the tab's own full list (ordered updated_at desc) and
-- the worker's enabled-only slice, which filters user_id and enabled first.
--
-- THIS IS ONE OF THE FOUR SCHEMA CORRECTIONS. LearnPanel.jsx still shows the user
-- `create table if not exists public.mini_skills`, and `public` is a schema this
-- app cannot read. See 0000_schema.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.mini_skills (
  id          uuid        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  title       text        not null,
  description text        not null default '',
  content     text        not null default '',
  source_url  text,
  source_kind text        not null default 'text',
  enabled     boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists mini_skills_user_enabled_idx
  on boardroom.mini_skills (user_id, enabled, updated_at desc);

alter table boardroom.mini_skills enable row level security;

-- The name matches SKILLS_SETUP_SQL in LearnPanel.jsx, which already carries the
-- drop, so this is a no-op against production rather than a second policy.
drop policy if exists "own mini_skills" on boardroom.mini_skills;
create policy "own mini_skills" on boardroom.mini_skills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.mini_skills to authenticated;
