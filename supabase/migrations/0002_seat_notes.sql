-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 · boardroom.seat_notes — the standing brief for each board seat
--
-- One row per seat. db.loadSeatNotes() selects seat_key,notes and folds it into
-- an object; db.saveSeatNote() upserts on (user_id, seat_key), which is the
-- primary key below. There is no id column because there was never a need for
-- one: a seat has exactly one note.
--
-- Two server-side readers matter for the shape:
--   board-work-background.js reads these with the service role to build the
--   Discord convene's context. That function's header records what it cost when
--   the hop into it was unauthenticated — private seat notes and private chat
--   history synthesised into an answer delivered to a caller-chosen webhook.
--   db-admin.js counts rows for the "vacuum seat_notes" console command.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.seat_notes (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  seat_key   text        not null,
  notes      text        not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, seat_key)
);

alter table boardroom.seat_notes enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'seat_notes'
  ) then
    create policy "seat_notes own rows" on boardroom.seat_notes
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.seat_notes to authenticated;
