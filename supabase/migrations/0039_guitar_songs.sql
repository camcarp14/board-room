-- ═══════════════════════════════════════════════════════════════════════════
-- 0039 · boardroom.guitar_songs — the repertoire
--
-- The headline metric of the whole Guitar tab is how many songs you can play
-- start to finish, so this is the table that answers the only question the tab
-- is really about.
--
-- THE SEED REPERTOIRE IS NOT IN HERE. src/lib/guitar/library.js ships about
-- three dozen chord charts in the bundle, and data/guitar.js merges them into
-- the list at read time rather than inserting them on first launch. Rows are for
-- songs Cameron added or edited; a seed chart becomes a row the moment it is
-- changed, under its own id, and the row wins from then on. Seeding the table
-- instead would mean migrating rows every time a chart was corrected, and
-- deleted seeds would quietly come back on the next device to sign in.
--
-- `id` IS TEXT, NOT UUID, AND THAT IS THE FIX FOR A DUPLICATION BUG. The seed
-- charts carry slugs ("wonderwall", "folsom"); a song Cameron writes gets a
-- crypto.randomUUID(). With a uuid column the slug could not be stored, so
-- editing a seed song saved a row under a FRESH id — and the merge in
-- data/guitar.js, which hides a seed only when a row already has its id, then
-- showed both. One "Wonderwall" you had edited and one you had not, forever,
-- multiplying by one every time you touched it. Widening the column is what lets
-- a seed keep its own identity when it becomes a row.
--
-- `chart` is { sections: [[name, "C | G | Am | F"]] } — bars separated by "|",
-- two chords in a bar splitting it. jsonb rather than a child table because a
-- chart is only ever read and written whole, and the alternative is a join for
-- something that is one document.
--
-- `song_key`, not `key`: `key` is not reserved in Postgres, but it is in enough
-- of the tooling around it (and in PostgREST's own vocabulary) that the column
-- is spelled out. The client maps it back to `key` on the way through.
--
-- `status` is learning | polishing | owned | shelved, as free text rather than
-- an enum. An enum would need a migration to add a fifth, and this is a
-- single-owner console where the client is the only writer; the values are
-- documented in src/pages/guitar/SongsPanel.jsx.
--
-- `clean_runs` is the completion criterion: three clean run-throughs at tempo is
-- what moves a song from polishing to owned. It is a count rather than a boolean
-- because "I got through it once" and "I can play this" are different claims.
--
-- One reader, one index: db.loadGuitarSongs takes everything for the user
-- ordered by updated_at descending.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.guitar_songs (
  id          text        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  title       text        not null,
  artist      text        not null default '',
  song_key    text,
  bpm         integer,
  capo        integer     not null default 0,
  difficulty  integer     not null default 2,
  status      text        not null default 'learning',
  chart       jsonb       not null default '{}'::jsonb,
  strum       text,
  clean_runs  integer     not null default 0,
  last_played date,
  note        text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists guitar_songs_user_updated_idx
  on boardroom.guitar_songs (user_id, updated_at desc);

alter table boardroom.guitar_songs enable row level security;

drop policy if exists "own guitar_songs" on boardroom.guitar_songs;
create policy "own guitar_songs" on boardroom.guitar_songs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.guitar_songs to authenticated;
