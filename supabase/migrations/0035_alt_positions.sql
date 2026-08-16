-- ═══════════════════════════════════════════════════════════════════════════
-- 0035 · boardroom.alt_positions — what you actually own, and the next rung
--
-- THE FIRST TABLE ON THIS TAB THAT IS YOURS. alt_flags is the screener's log:
-- ideas it had, graded honestly against frozen targets, and it grades them
-- whether or not a dollar was ever put behind one. Nothing anywhere recorded
-- the other half — what was bought, at what price, and what the plan for
-- selling it was — which meant the exit ladder, the single part of the strategy
-- that decides whether a run ends at 2× or 10×, existed only on paper.
--
-- COST BASIS IS AN AVERAGE, AND AVERAGING IS WHY THIS IS NOT A TRADE LOG. The
-- plan this serves buys in tranches (six monthly buys into the core sleeve), so
-- a table of individual fills would need to be collapsed to answer the only
-- question the row asks — how far is this from its next rung. It is collapsed
-- on write instead: db.saveAltPosition recomputes cost_basis and units as a
-- weighted average when a tranche is added. The fills are not recoverable from
-- this table, deliberately; the app is a monitor, not accounting software.
--
-- rungs_hit IS A COUNT, NOT A PRICE, and it ratchets. The ladder is a fixed
-- fraction sequence (see ALT_LADDER in src/data/db.js), so rung N's multiple is
-- derivable from the count and the basis, and storing the prices would let the
-- ladder and the row disagree after an edit. Same discipline as alt_flags'
-- status ladder, which also ratchets up only and for the same reason: a rung
-- that printed, printed, and a later drawdown does not un-print it.
--
-- sleeve is 'core' | 'survivor' | 'tail' — the three barbell sleeves. Stored as
-- text rather than an enum so a fourth sleeve is an app change and not a
-- migration, which is the same call every other status column in this schema
-- makes.
--
-- closed_at null means open. Closed rows stay: the whole point of writing the
-- ladder down is being able to look back at whether it was followed.
--
-- BROWSER-WRITTEN, so unlike alt_state/alt_flags/alt_snapshots (server-only,
-- RLS as a belt, no grants) this one carries the full own-rows policy and the
-- authenticated grant — the dream_items pattern, which is the pattern for every
-- table the app writes from the client.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.alt_positions (
  id          uuid        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  coin_id     text        not null,
  symbol      text        not null default '',
  name        text,
  sleeve      text        not null default 'tail',
  -- Average entry price and total units held. numeric, not float: these are
  -- money, and a sub-cent alt price carried as a float is a rounding error that
  -- compounds through every rung comparison.
  cost_basis  numeric     not null,
  units       numeric,
  rungs_hit   integer     not null default 0,
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,
  notes       jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The only read the panel makes: this user's open positions, newest first.
-- Ordered on the index rather than sorted in the client because a phone opening
-- this tab should paint the book before it paints the board.
create index if not exists alt_positions_user_idx
  on boardroom.alt_positions (user_id, closed_at, opened_at desc);

alter table boardroom.alt_positions enable row level security;

drop policy if exists "alt_positions own rows" on boardroom.alt_positions;
create policy "alt_positions own rows" on boardroom.alt_positions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.alt_positions to authenticated;
