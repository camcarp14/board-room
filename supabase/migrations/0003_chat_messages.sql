-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 · boardroom.chat_messages — the Room's transcript
--
-- db.loadChat() selects role,content,consulted_seats,created_at,source ordered
-- created_at desc with a limit, then reverses in JS. db.clearChat() deletes with
-- `.gte("created_at", "1970-01-01")` — not a real filter, just something to
-- satisfy supabase-js's refusal to issue an unqualified delete; RLS is what
-- actually scopes it.
--
-- USER_ID DEFAULTS TO auth.uid(), and that is load-bearing rather than tidy.
-- db.saveMessage() inserts { role, content, consulted_seats } and NOTHING else —
-- no user_id at all. Without the default the insert fails the not-null
-- constraint, and saveMessage swallows its own errors on purpose ("try/catch {}"
-- so a logging failure never eats a reply), so the transcript would simply stop
-- recording with no sign anywhere that it had.
--
-- consulted_seats is jsonb because the value is an array of seat keys
-- (m.consulted || []). `source` is 'web' for rows the local-storage import
-- replayed and for what the app writes now; board-work-background.js writes the
-- Discord exchanges through the service role.
--
-- The index matches the only two query shapes: the newest N of my rows, and the
-- HEAD count db-admin.js and the Status tab use as their "can I reach the
-- database at all" probe (connections.js: supabase_db).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.chat_messages (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  role            text        not null,
  content         text        not null default '',
  consulted_seats jsonb       not null default '[]'::jsonb,
  source          text,
  created_at      timestamptz not null default now()
);

create index if not exists chat_messages_user_created_idx
  on boardroom.chat_messages (user_id, created_at desc);

alter table boardroom.chat_messages enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'chat_messages'
  ) then
    create policy "chat_messages own rows" on boardroom.chat_messages
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.chat_messages to authenticated;
