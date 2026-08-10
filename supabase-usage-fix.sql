-- ═══════════════════════════════════════════════════════════════════════════
-- usage_log + usage_summary — the spend ledger behind Systems → Usage.
--
-- This file is idempotent: run it in the Supabase SQL editor as many times as
-- you like. The table, index and policies are created only if absent. The
-- aggregate is the one exception — it is dropped and recreated every run, which
-- is deliberate (see the note above it) and safe: it holds no data.
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
--
-- WHY THIS FILE IS STILL AT THE REPOSITORY ROOT and not in supabase/migrations/
-- with the other 32 tables: SystemsPage.jsx:228 tells the user to "Run
-- supabase-usage-fix.sql in the Supabase SQL editor", BY THIS FILENAME, when the
-- usage_summary aggregate is missing. An error message that names a file which no
-- longer exists is worse than the missing aggregate it is trying to explain. So
-- this stays put and stays the file you run.
-- supabase/migrations/0004_usage_log.sql is the schema RECORD for this table —
-- the create and the index only, copied from below so the migrations directory
-- covers all 32 tables. The policies, the grants and the aggregate live here and
-- nowhere else. If you change the table shape, change both.
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
-- id/user_id defaults match what production already has (uuid + auth.uid()),
-- not what a clean-sheet design would pick. `create table if not exists` is a
-- no-op against the live table, so a divergence here would only ever show up on
-- a fresh database — as a schema that silently disagrees with production.
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

-- The only query shapes that run: "my rows since T" (both the aggregate and
-- the raw log below it) and the 30-day retention sweep on Systems → Database.
create index if not exists usage_log_user_created_idx
  on boardroom.usage_log (user_id, created_at desc);

-- ── row-level security ─────────────────────────────────────────────────────
-- Reads are the user's own rows only. The insert policy is scoped the same way
-- rather than being a blanket grant: the server-side writers use the
-- service-role key and bypass RLS entirely, so the only thing this policy has to
-- admit is telemetry.js inserting under the caller's own session.
alter table boardroom.usage_log enable row level security;

-- These guards test for a policy on the COMMAND, never on a policy NAME. The
-- name check was a real bug: production's policies are called "own rows select"
-- and "own rows insert" (created by hand, long before this file existed), so
-- name-matching found nothing and the script cheerfully added a second,
-- identically-scoped policy under its own name. Permissive policies OR together,
-- so nothing broke visibly — it just quietly doubled the policy set every run.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'boardroom' and tablename = 'usage_log' and cmd = 'SELECT'
  ) then
    create policy usage_log_select_own on boardroom.usage_log
      for select using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'boardroom' and tablename = 'usage_log' and cmd = 'INSERT'
  ) then
    create policy usage_log_insert_own on boardroom.usage_log
      for insert with check (auth.uid() = user_id);
  end if;

  -- Systems → Database offers "clear usage_log > 30d"; that runs as the user, so
  -- without a DELETE policy RLS filters every row out and the sweep deletes
  -- nothing at all — silently, since a 0-row delete is not an error. Production
  -- ran without this policy until 2026-07-31.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'boardroom' and tablename = 'usage_log' and cmd = 'DELETE'
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
-- DROP, not `create or replace`. Replace cannot change a function's return type
-- (Postgres 42P13), and production already had a 7-column usage_summary — no
-- model, no ms_avg — so the replace failed outright and took the whole script's
-- transaction down with it. Dropping first is what makes this file idempotent
-- against a database that has an older version of the aggregate, which is the
-- only interesting case: a database that has none was never the hard one.
drop function if exists boardroom.usage_summary(timestamptz);

create function boardroom.usage_summary(since_ts timestamptz)
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
