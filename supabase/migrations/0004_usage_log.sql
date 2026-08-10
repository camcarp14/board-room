-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 · boardroom.usage_log — the spend ledger behind Systems → Usage
--
-- THIS FILE IS THE RECORD. /supabase-usage-fix.sql AT THE REPO ROOT IS THE ONE
-- YOU RUN. It is not moved in here and should not be: SystemsPage.jsx:228 tells
-- the user "Run supabase-usage-fix.sql in the Supabase SQL editor" by that exact
-- filename when the usage_summary aggregate is missing, and a message that names
-- a file which no longer exists is worse than the missing aggregate. That file
-- also carries three things this one deliberately does not — the usage_summary
-- aggregate, the RLS policies, and the grants.
--
-- The table and index below are copied from it verbatim so this directory's
-- inventory is complete. If you change one, change both; scripts/
-- migrations-smoke.mjs checks that this file mentions the table, not that the
-- two texts agree, so that part is on you.
--
-- WHY THE POLICIES ARE NOT HERE. Production's policies on this table are called
-- "own rows select" and "own rows insert" — made by hand, years before any DDL
-- existed. supabase-usage-fix.sql matches on the COMMAND rather than the name
-- for exactly that reason, and it also carries the DELETE policy that the
-- Systems → Database "clear usage_log > 30d" prune needs (without it RLS filters
-- every row out and the sweep deletes nothing, silently, since a 0-row delete
-- is not an error — production ran that way until 2026-07-31). Repeating a
-- second copy of that logic here would be one more place for it to drift.
--
-- Six writers put rows in: src/lib/telemetry.js from the browser, mini-worker,
-- board-work-background, audit, auto-fix, and netlify/lib/upstream/store.js.
-- Every one of them treats logging as best-effort and swallows its errors, which
-- is correct — accounting must not be able to fail the work — and is also why a
-- broken ledger is invisible until the Usage card reads $0.000.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.usage_log (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  fn          text        not null,
  kind        text        not null default 'anthropic',
  model       text,
  in_tokens   integer     not null default 0,
  out_tokens  integer     not null default 0,
  cost_usd    numeric(12, 6) not null default 0,
  ms          integer,
  ok          boolean     not null default true,
  detail      text,
  created_at  timestamptz not null default now()
);

-- The only query shapes that run: "my rows since T" (the usage_summary aggregate
-- and the raw log below it) and the 30-day retention sweep on Systems → Database.
create index if not exists usage_log_user_created_idx
  on boardroom.usage_log (user_id, created_at desc);
