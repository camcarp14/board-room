-- ═══════════════════════════════════════════════════════════════════════════
-- 0032 · boardroom.upstream_tell_checks — did the falsifier show up yet
--
-- Append-only. Every time a prediction's tell is checked, one row lands here with
-- a `signal` from a closed set — none, early, strong, contra — enforced upstream
-- in nostradamus-run.js, which throws LoudError('TELL_UNPARSEABLE') rather than
-- store an unclassifiable answer. The page colours the badge from that set and
-- treats an unknown value as no colour at all, so an out-of-set signal would read
-- as neutral rather than as a problem.
--
-- THE ID IS THE CHRONOLOGY. fetchPredictions() reads the whole table with
-- `.order("id")` and the card takes the LAST element of each prediction's list as
-- the current check. So id has to be monotonically increasing per insert —
-- bigserial. A uuid primary key would still sort, but it would sort into a random
-- order, and the card would show an arbitrary historical check as the latest one.
-- That is the single most breakable thing on this table.
--
-- checked_at IS NEVER WRITTEN BY THE INSERTER. store.js insertTellCheck posts only
-- { prediction_id, user_id, signal, summary, evidence }, and the card reads
-- last.checked_at to render "checked 3d ago". So the default below is what makes
-- that line work; without it every check reads "never checked" while sitting right
-- next to its own summary.
--
-- evidence is a jsonb array of { url, note }, already filtered to entries whose
-- url matched something actually fetched — an unmatched citation is dropped rather
-- than shown, because a source link that goes nowhere is worse than no link.
--
-- The cascade is the second of the two src/lib/upstream.js names: a prediction
-- takes its tell checks with it.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.upstream_tell_checks (
  id            bigserial   primary key,
  prediction_id uuid        not null references boardroom.upstream_predictions(id) on delete cascade,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  signal        text        not null,
  summary       text        not null default '',
  evidence      jsonb       not null default '[]'::jsonb,
  checked_at    timestamptz not null default now()
);

create index if not exists upstream_tell_checks_prediction_idx
  on boardroom.upstream_tell_checks (prediction_id, id);

alter table boardroom.upstream_tell_checks enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'upstream_tell_checks'
  ) then
    create policy "upstream_tell_checks own rows" on boardroom.upstream_tell_checks
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.upstream_tell_checks to authenticated;
