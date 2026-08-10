-- ═══════════════════════════════════════════════════════════════════════════
-- 0024 · boardroom.alt_flags — one row per flagged episode, open or closed
--
-- The id is `${coin_id}:${YYYYMMDD}` in UTC, built in transitionFlags. That
-- composite is doing real work: a coin closed and re-flagged inside the same UTC
-- day collides with the closed episode's id and is dropped by
-- `ignoreDuplicates: true` rather than resurrected.
--
-- THE PARTIAL UNIQUE INDEX IS THE CONCURRENCY GUARD, and the code names it.
-- alt_flags_one_open_uidx is referenced by name in alt-cron-background.js as the
-- reason a cross-day double-open is safe: two overlapping passes that both read
-- before either wrote cannot both insert, because the second one's insert errors
-- and is logged instead of applied. The batched update path gave up its
-- per-row compare-and-swap in exchange for one round trip, so this index is now
-- the only thing standing between an overlapping pass and a duplicate open
-- episode. Do not drop it, and do not make it a plain unique index — a coin is
-- allowed any number of CLOSED episodes.
--
-- resolved_at null means open. Every read is either "the open ones"
-- (.is("resolved_at", null), served by the partial index) or "the closed ones,
-- newest first" (order by resolved_at desc), which is the second index.
--
-- notes is jsonb and holds why an episode ended — closedBy: invalidation /
-- faded / stale / unscreened, plus tierUpgradedAt. status holds what it REACHED:
-- active, hit_t1, hit_t2, hit_t3, invalidated, faded. Those two are separate on
-- purpose. The ladder ratchets up only and a rung once printed survives the
-- close, so a name that tagged T2 and later lost its stop is filed as a win that
-- gave it all back, not as a loss. The stock engine had this wrong in three
-- separate places before it was fixed to match.
--
-- t1/t2/t3/invalidation are FROZEN at flag time and never recomputed. Grading
-- against moving targets would make the hit rate meaningless.
--
-- SERVER-ONLY, RLS as the belt, no grant issued or revoked — see 0023_alt_state.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.alt_flags (
  id               text        primary key,
  coin_id          text        not null,
  symbol           text,
  name             text,
  tier             text,
  status           text        not null default 'active',
  first_flagged_at timestamptz,
  flag_price       numeric,
  score            integer,
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

-- Named in alt-cron-background.js. One open episode per coin, ever.
create unique index if not exists alt_flags_one_open_uidx
  on boardroom.alt_flags (coin_id) where resolved_at is null;

create index if not exists alt_flags_resolved_idx
  on boardroom.alt_flags (resolved_at desc);

alter table boardroom.alt_flags enable row level security;
