-- ═══════════════════════════════════════════════════════════════════════════
-- 0008 · boardroom.personal_notes — Notes, and the two columns that arrived late
--
-- `pinned` and `color` are the pair NOTES_UPGRADE_SQL adds (src/pages/personal/
-- NotesPanel.jsx), and BOTH READERS STILL TOLERATE THEIR ABSENCE. db.loadNotes()
-- tries the full select, and on a 42703/"column" error falls back to the base
-- columns and returns `legacy: true` so the panel can show the upgrade banner
-- instead of an error. note-capture.js does the same thing from the other side:
-- a capture from the watch has no UI to show a banner in, so an insert that
-- trips the missing columns is retried WITHOUT them and the response says the
-- note went in unsealed. The words are what matter; the colour is a garnish.
--
-- That fallback is why this file declares them with defaults and no not-null on
-- color: a database built from this file has them, a database that predates them
-- keeps working, and neither reader can tell the difference by accident.
--
-- The index matches every read: notes are always ordered updated_at desc, by
-- db.loadNotes and by note-capture's "did I just write to a note" lookup, which
-- also filters `updated_at >= since`. note-capture additionally matches on
-- `title = eq.<name>` for an append-into-an-existing-note capture, which scans —
-- acceptable against a personal notes table, and cheap next to the LLM call that
-- decided to append in the first place.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.personal_notes (
  id         uuid        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  title      text        not null default '',
  body       text        not null default '',
  pinned     boolean     not null default false,
  color      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists personal_notes_user_updated_idx
  on boardroom.personal_notes (user_id, updated_at desc);

alter table boardroom.personal_notes enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'personal_notes'
  ) then
    create policy "personal_notes own rows" on boardroom.personal_notes
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.personal_notes to authenticated;
