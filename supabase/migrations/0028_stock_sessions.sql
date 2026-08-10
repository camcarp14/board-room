-- ═══════════════════════════════════════════════════════════════════════════
-- 0028 · boardroom.stock_sessions — one row per settled trading session
--
-- session_date is the primary key because it is the natural one: the settle
-- upserts on it (onConflict: "session_date"), which is what makes re-settling a
-- session idempotent. Re-settling is a real operation, not an accident — after a
-- calibration change the stored board is the OLD verdict, and the Run now button
-- has to mean run now rather than answer "already done".
--
-- `coverage` is the honesty column. A pass that saw most of the universe writes;
-- a pass that saw half of it must not overwrite a good board with a thin one,
-- because the regime, the breadth denominators and the percentile floor would all
-- be computed off a sample nobody chose. A rejected thin pass records itself in
-- the state payload's lastPass rather than here, so the tab can say a pass came
-- back thin AND that the board it is showing is still whole. Writing the rejected
-- coverage over the accepted one inverted the meaning of the single line whose
-- entire job is describing data quality.
--
-- `qualifiers` is an integer count of names that met the flag bar this session,
-- not a list. score_dist, closes and anchor are jsonb maps; `anchor` is written as
-- an empty object today and is recorded here because the column is written on
-- every settle.
--
-- PRUNED to a rolling window: the pass deletes rows older than the cut date it
-- computes from the SPY calendar, filtering on session_date, which the primary
-- key already serves.
--
-- SERVER-ONLY, RLS as the belt, no grant issued or revoked — see 0023_alt_state.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.stock_sessions (
  session_date  date        primary key,
  settled_at    timestamptz,
  regime_score  numeric,
  regime_phase  text,
  breadth5      numeric,
  breadth21     numeric,
  participation numeric,
  score_dist    jsonb,
  qualifiers    integer,
  coverage      numeric,
  closes        jsonb,
  anchor        jsonb
);

alter table boardroom.stock_sessions enable row level security;
