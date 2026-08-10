-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 · boardroom.app_settings — the key/value store the whole app boots from
--
-- Read by db.loadSettings() (src/data/db.js) as one flat select of
-- setting_key,setting_value and written one key at a time by db.saveSetting(),
-- which upserts on (user_id, setting_key) — that conflict target is why the
-- primary key below is the pair rather than a synthetic id.
--
-- It is not only the client's. Four Netlify functions read and write it with the
-- service-role key, and two of them look a row up by a value INSIDE the JSON:
--
--   mini-worker.js      setting_key in (mini, mini_tasks, mind_prompt), and it
--                       writes mini_tasks back after a queue run.
--   note-capture.js     setting_key = notes_capture, matched on
--                       setting_value->>captureToken — the watch's credential.
--   workout-import.js   setting_key = workout, matched on
--                       setting_value->>importToken — same shape.
--   econ-resolve-background.js  its own result key, POSTed with
--                       on_conflict=user_id,setting_key and
--                       Prefer: resolution=merge-duplicates, which is the REST
--                       spelling of the same upsert.
--
-- setting_value is jsonb, not text. It holds objects (mini, notes_capture),
-- arrays (mini_tasks, the saved dream-board list, notes_order) and bare strings
-- (calendar_url), and the two token lookups above use the ->> operator, which
-- only exists on json/jsonb.
--
-- NO INDEX, deliberately. The token lookups filter on an expression with no
-- user_id, so they scan — but this table holds one row per settings key for one
-- owner, on the order of dozens. An index here would cost more to explain than
-- it saves. If it ever grows a row per anything, the index to add is on
-- ((setting_value->>'captureToken')) where setting_key = 'notes_capture'.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.app_settings (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  setting_key   text        not null,
  setting_value jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, setting_key)
);

alter table boardroom.app_settings enable row level security;

-- THE POLICY IS TESTED BY COMMAND, NEVER BY NAME. Production's policies for
-- this table were created by hand, long before any of this was written down,
-- and nothing in the repository records what they are called. A name check
-- therefore finds nothing and cheerfully adds a second, identically-scoped
-- policy under its own name — and because permissive policies OR together,
-- nothing breaks visibly. The policy set just doubles on every run. That exact
-- bug is documented in supabase-usage-fix.sql, which is where this guard comes
-- from; the other files in this directory reuse it and point back here rather
-- than repeating the story.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'app_settings'
  ) then
    create policy "app_settings own rows" on boardroom.app_settings
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- RLS filters; it does not grant. Supabase's default privileges cover `public`,
-- so a table in `boardroom` stays invisible to the signed-in role until this
-- line runs no matter what the policy above says.
grant select, insert, update, delete on boardroom.app_settings to authenticated;
