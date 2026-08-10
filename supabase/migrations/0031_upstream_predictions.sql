-- ═══════════════════════════════════════════════════════════════════════════
-- 0031 · boardroom.upstream_predictions — the calibration ledger
--
-- This is the table the whole Nostradamus surface exists to fill, and the one
-- whose integrity decides whether any of it is worth believing. The client
-- computes a Brier score and confidence buckets straight off these rows
-- (src/lib/upstream.js calibration()), so every column here is an input to a
-- number that judges the engine.
--
-- confidence is numeric in 0..1 — calibration() bins it into five buckets and
-- squares (confidence − outcome), so a stored percentage instead of a fraction
-- would silently make every Brier score enormous.
--
-- status is 'open' until resolved, then 'correct', 'wrong' or 'void'. void rows
-- are excluded from the score entirely rather than counted as wrong. Resolving is
-- always reversible — resolvePrediction() writes resolved_at back to null when the
-- status returns to 'open' — which is why resolved_at and resolution_note are
-- nullable and are cleared rather than left standing.
--
-- FOUR JSONB COLUMNS, each a structure the page renders directly:
--   causal_chain            an ordered array — "what has to happen first, in order".
--   tell                   { observable, whereToLook } — the falsifier.
--   consensus_counterpart  { position, urls } — what the crowd says, with sources.
--   why_consensus_misses   the error mechanism, keyed by `type`, including the
--                          'none_consensus_correct' case where the finding is
--                          that consensus is right. That is a real answer and the
--                          page says so in green rather than hiding it.
-- `delta` is plain text and only shown for kind = 'bold'; a consensus-affirmed
-- prediction stores the literal 'none — consensus affirmed'.
--
-- run_id HAS NO FOREIGN KEY HERE, deliberately. The cascade comment in
-- src/lib/upstream.js names exactly two: a run takes its EVENTS with it, and a
-- prediction takes its TELL CHECKS. It does not say a run takes its predictions,
-- and a ledger that silently deleted resolved calls when their run was tidied up
-- would corrupt the calibration score with no trace. If the live database has a
-- constraint here, this is the one place in this directory where the record may be
-- narrower than production — check before relying on it either way.
--
-- Ordered created_at desc on read, hence the index.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.upstream_predictions (
  id                    uuid        primary key,
  run_id                uuid,
  user_id               uuid        not null references auth.users(id) on delete cascade,
  subject               text,
  kind                  text,
  statement             text,
  resolution_date       date,
  resolution_criterion  text,
  confidence            numeric,
  causal_chain          jsonb,
  tell                  jsonb,
  consensus_counterpart jsonb,
  delta                 text,
  why_consensus_misses  jsonb,
  status                text        not null default 'open',
  resolved_at           timestamptz,
  resolution_note       text,
  created_at            timestamptz not null default now()
);

create index if not exists upstream_predictions_user_created_idx
  on boardroom.upstream_predictions (user_id, created_at desc);

alter table boardroom.upstream_predictions enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'upstream_predictions'
  ) then
    create policy "upstream_predictions own rows" on boardroom.upstream_predictions
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.upstream_predictions to authenticated;
