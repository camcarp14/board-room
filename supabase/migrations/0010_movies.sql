-- ═══════════════════════════════════════════════════════════════════════════
-- 0010 · boardroom.movies — what was watched, and what it was worth
--
-- TWO SCORES ON PURPOSE. `true_quality_score` is the outside world's number,
-- pulled from TMDB when the title is matched; `cameron_score` is the one that
-- actually decides anything. Both are nullable (db.saveMovie writes
-- `m.true_quality_score ?? null`), because an unrated film is a real state — and
-- a table that coerced a missing rating to 0 would put every unrated film at the
-- bottom of the list as though it had been panned.
--
-- watched_date is a DATE and comes from todayISO(), not toISOString().slice(0,10).
-- That distinction is the whole comment sitting on it in src/data/db.js: the UTC
-- day stamped a movie logged any evening in Central time with TOMORROW's date.
-- This table was the last holdout of the bug src/lib/dates.js opens by warning
-- about, so keep the column a date and keep the writer on todayISO().
--
-- db.loadMovies() does `select *` ordered watched_date desc; db.updateMovie
-- PATCHes an arbitrary partial patch by id, so every column has to tolerate
-- being written on its own. No id is supplied on insert, hence the default.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.movies (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references auth.users(id) on delete cascade,
  title              text        not null,
  year               integer,
  poster_url         text,
  true_quality_score numeric,
  cameron_score      numeric,
  note               text        not null default '',
  watched_date       date        not null default current_date,
  created_at         timestamptz not null default now()
);

create index if not exists movies_user_watched_idx
  on boardroom.movies (user_id, watched_date desc);

alter table boardroom.movies enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'movies'
  ) then
    create policy "movies own rows" on boardroom.movies
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.movies to authenticated;
