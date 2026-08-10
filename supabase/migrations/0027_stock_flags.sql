-- ═══════════════════════════════════════════════════════════════════════════
-- 0027 · boardroom.stock_flags — the equities twin of alt_flags
--
-- Same anatomy, one difference that matters: the id is `${ticker_id}:${session_date}`
-- rather than a UTC day, because equities have sessions and crypto does not. The
-- foreign key column is ticker_id, not coin_id.
--
-- THE PARTIAL UNIQUE INDEX IS NAMED IN THE CODE. stock_flags_one_open_uidx is
-- cited in stock-settle-background.js as the reason two overlapping passes are
-- safe — a human can start one from the Run now button while the hourly cron is
-- mid-flight, and the database, not the code, is what refuses the duplicate open
-- episode. The state row is last-write-wins over two passes computing the same
-- thing from the same bars, which is a tie rather than a race. Keep the index
-- partial: a ticker is allowed any number of closed episodes.
--
-- Two writers grade this table and they must agree. The settle grades against the
-- session's high and low; the intra-session tick grades against the day high and
-- low an hour at a time. Both follow the same rule — the earned rung survives, so
-- only a flag that never reached one closes as `invalidated`, and notes.closedBy
-- carries the rest of the story. The grade a flag gets must not depend on whether
-- its stop was crossed inside a session or between two of them, which is a
-- distinction nobody ever made and which this file's shape has to keep supporting:
-- status is what it REACHED, notes.closedBy is HOW IT ENDED, and they are separate
-- columns precisely so a win that gave it all back stays distinguishable in the
-- Record.
--
-- score is numeric here where alt_flags rounds to an integer — the equities
-- screener stores s.score as computed.
--
-- SERVER-ONLY, RLS as the belt, no grant issued or revoked — see 0023_alt_state.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.stock_flags (
  id               text        primary key,
  ticker_id        text        not null,
  symbol           text,
  name             text,
  tier             text,
  status           text        not null default 'active',
  first_flagged_at timestamptz,
  flag_price       numeric,
  score            numeric,
  t1               numeric,
  t2               numeric,
  t3               numeric,
  invalidation     numeric,
  peak_price       numeric,
  peak_at          timestamptz,
  last_price       numeric,
  last_seen_at     timestamptz,
  resolved_at      timestamptz,
  notes            jsonb       not null default '{}'::jsonb
);

-- Named in stock-settle-background.js. One open episode per ticker, ever.
create unique index if not exists stock_flags_one_open_uidx
  on boardroom.stock_flags (ticker_id) where resolved_at is null;

create index if not exists stock_flags_resolved_idx
  on boardroom.stock_flags (resolved_at desc);

alter table boardroom.stock_flags enable row level security;
