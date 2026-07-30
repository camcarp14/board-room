-- ═══════════════════════════════════════════════════════════════════════════
-- usage_log + usage_summary — the spend ledger behind Systems → Usage.
--
-- This file is idempotent: run it in the Supabase SQL editor as many times as
-- you like. It creates what's missing and leaves what's already there alone.
--
-- WHY IT EXISTS. Systems → Usage points you here by name when the aggregate is
-- missing ("Run supabase-usage-fix.sql in the Supabase SQL editor"), and until
-- now the file did not exist anywhere in the repository — nor did any DDL for
-- usage_log itself. That is a bad failure mode for a spend ledger, because
-- every writer treats logging as best-effort and swallows errors on purpose
-- (see src/lib/telemetry.js: "table may not exist yet, or offline — never
-- break the caller"). If this table or function were ever dropped, accounting
-- would stop silently and the Usage card would read $0.000 rather than error.
--
-- SCHEMA. Board Room's tables live in `boardroom`, not `public` — the client
-- sets db.schema (src/lib/supabase.js) and the functions send Accept-Profile /
-- Content-Profile headers. Everything below is qualified accordingly.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists boardroom;

-- ── the ledger ─────────────────────────────────────────────────────────────
-- One row per billable event. Two kinds share the table:
--   kind = 'anthropic'  a model call: tokens + estimated cost are populated.
--   kind = 'call'       a Netlify function hit: timing only, no tokens/cost.
-- The Usage card's cost and token boxes filter on kind = 'anthropic'; the
-- call/failure counters count every kind. Health probes ({ping:true}) are
-- deliberately not logged — they cost nothing and used to dominate the table.
--
-- in_tokens is TOTAL input: uncached input plus both cache counters. Anthropic
-- returns input_tokens as the *uncached remainder* only, so every writer sums
-- input_tokens + cache_creation_input_tokens + cache_read_input_tokens before
-- storing. Keep that convention or the token column stops being comparable.
--
-- cost_usd is an ESTIMATE computed at write time from the rate in force then,
-- which is what makes historical rows survive a price change (Sonnet 5's
-- introductory pricing ends 2026-08-31). It is not billing truth — reconcile
-- against the Anthropic console for that.
create table if not exists boardroom.usage_log (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
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

-- The only query shapes that run: "my rows since T" (both the aggregate and
-- the raw log below it) and the 30-day retention sweep on Systems → Database.
create index if not exists usage_log_user_created_idx
  on boardroom.usage_log (user_id, created_at desc);

-- ── row-level security ─────────────────────────────────────────────────────
-- Reads are the user's own rows only. There is deliberately NO insert policy
-- for authenticated clients: every writer either goes through the service-role
-- key (which bypasses RLS) or is the client's own session insert via
-- telemetry.js, which the policy below permits for its own user_id.
alter table boardroom.usage_log enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'boardroom' and tablename = 'usage_log' and policyname = 'usage_log_select_own'
  ) then
    create policy usage_log_select_own on boardroom.usage_log
      for select using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'boardroom' and tablename = 'usage_log' and policyname = 'usage_log_insert_own'
  ) then
    create policy usage_log_insert_own on boardroom.usage_log
      for insert with check (auth.uid() = user_id);
  end if;

  -- Systems → Database offers "clear usage_log > 30d"; that runs as the user.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'boardroom' and tablename = 'usage_log' and policyname = 'usage_log_delete_own'
  ) then
    create policy usage_log_delete_own on boardroom.usage_log
      for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ── the aggregate ──────────────────────────────────────────────────────────
-- Systems → Usage calls this instead of selecting rows and summing in JS. That
-- mattered: the old client-side select was row-capped, so at real call volume
-- the 7d / 30d / All windows all silently showed the same few hours as 24h.
-- Aggregating in Postgres removes the row ceiling from the numbers that matter.
--
-- Grouped by (fn, kind, model) because the card needs spend-by-function, an
-- anthropic-only cost/token total, and an all-kinds call/failure count from a
-- single round trip. SECURITY INVOKER (the default) keeps RLS in force, so a
-- caller can only ever aggregate their own rows.
create or replace function boardroom.usage_summary(since_ts timestamptz)
returns table (
  fn         text,
  kind       text,
  model      text,
  calls      bigint,
  failed     bigint,
  in_tokens  bigint,
  out_tokens bigint,
  cost_usd   numeric,
  ms_avg     numeric
)
language sql
stable
as $$
  select
    u.fn,
    u.kind,
    u.model,
    count(*)                                   as calls,
    count(*) filter (where not u.ok)           as failed,
    coalesce(sum(u.in_tokens), 0)              as in_tokens,
    coalesce(sum(u.out_tokens), 0)             as out_tokens,
    coalesce(sum(u.cost_usd), 0)               as cost_usd,
    round(coalesce(avg(u.ms), 0)::numeric, 0)  as ms_avg
  from boardroom.usage_log u
  where u.created_at >= since_ts
  group by u.fn, u.kind, u.model
  order by cost_usd desc, calls desc;
$$;

-- PostgREST resolves rpc('usage_summary') against the schema the client is
-- pinned to, so the grant has to reach the roles the app actually uses.
grant usage on schema boardroom to anon, authenticated;
grant select, insert, delete on boardroom.usage_log to authenticated;
grant execute on function boardroom.usage_summary(timestamptz) to authenticated;

-- PostgREST caches the schema; without this the new function 404s until the
-- next deploy or restart.
notify pgrst, 'reload schema';
