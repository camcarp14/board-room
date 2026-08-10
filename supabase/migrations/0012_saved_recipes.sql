-- ═══════════════════════════════════════════════════════════════════════════
-- 0012 · boardroom.saved_recipes — a recipe kept after the model produced it
--
-- Two content columns and nothing else. `content` is the whole recipe as markdown
-- text — no ingredients table, no steps table, no parsing. It was generated as
-- prose and it is read as prose; splitting it into structure would be work in
-- service of a query nothing makes.
--
-- db.loadSavedRecipes() does `select *` ordered created_at desc. db.saveRecipe
-- takes (title, content) and supplies no id, hence the default.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.saved_recipes (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  title      text        not null,
  content    text        not null default '',
  created_at timestamptz not null default now()
);

create index if not exists saved_recipes_user_created_idx
  on boardroom.saved_recipes (user_id, created_at desc);

alter table boardroom.saved_recipes enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'saved_recipes'
  ) then
    create policy "saved_recipes own rows" on boardroom.saved_recipes
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.saved_recipes to authenticated;
