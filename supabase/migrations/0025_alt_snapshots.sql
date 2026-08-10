-- ═══════════════════════════════════════════════════════════════════════════
-- 0025 · boardroom.alt_snapshots — the hourly time series the movers are measured against
--
-- One row an hour: BTC dominance, the fear/greed reading, and a prices map keyed
-- by coin id. It exists so the 4h and 12h mover windows can be measured rather
-- than guessed — alt-cron-background looks for the stored snapshot nearest
-- now−4h and now−12h with a ±45 minute tolerance, and when it cannot find one it
-- tells the UI how long until that window CAN be measured instead of leaving a
-- silent blank.
--
-- It is also the rebuild source for the dominance history: when the state
-- payload's domHistory has fewer than two points, the pass replays up to 2,400
-- rows of (taken_at, btc_dominance) — filtered to non-null dominance — to
-- reconstruct it.
--
-- PRUNED, not append-only: the pass deletes anything older than its retention
-- window on every run. Every query here filters or orders on taken_at, in four
-- different shapes (a range for the baselines, ascending-with-limit for the
-- rebuild, ascending limit 1 for "how old is the oldest sample", and a range
-- delete for the prune), so taken_at is the one index that matters.
--
-- `id` is not read anywhere. It is recorded as a bigserial because the table is
-- append-then-prune and needs some primary key; the live column's type was not
-- observable from the code, so treat this line as the least surprising choice
-- rather than as a reading of production.
--
-- fear_greed is an integer (the index is published 0-100); btc_dominance is a
-- percentage as numeric. Both nullable — a pass where the global endpoint failed
-- still writes prices, and a null there is honest where a 0 would be a lie about
-- Bitcoin's share of the market.
--
-- SERVER-ONLY, RLS as the belt, no grant issued or revoked — see 0023_alt_state.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.alt_snapshots (
  id            bigserial   primary key,
  taken_at      timestamptz not null,
  btc_dominance numeric,
  fear_greed    integer,
  prices        jsonb       not null default '{}'::jsonb
);

create index if not exists alt_snapshots_taken_at_idx
  on boardroom.alt_snapshots (taken_at);

alter table boardroom.alt_snapshots enable row level security;
