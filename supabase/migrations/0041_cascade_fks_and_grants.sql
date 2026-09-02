-- ═══════════════════════════════════════════════════════════════════════════
-- 0041 · the erasure promise, made true; and the privileges nobody meant to give
--
-- TWO THINGS THE AUDIT FOUND BY ASKING PRODUCTION RATHER THAN THE FILES.
--
-- 1. SIX TABLES HAD NO FOREIGN KEY TO auth.users. The privacy page and the
--    retention policy both say that deleting the account removes every row
--    because "each table holding user data declares its user reference on
--    delete cascade". The migrations for grocery_items (0011), movies (0010) and
--    saved_recipes (0012) do declare exactly that — but each is `create table if
--    not exists`, and all three tables pre-date their migration file, so the
--    declaration never reached the live schema. The three upstream child tables
--    (predictions, run_events, tell_checks) cascade from their run but never
--    from the user. Live check on 2026-09-02: every one of the six had zero
--    orphan rows and zero null user_ids, so the constraints below attach
--    cleanly. Each is guarded by name so this file is re-runnable.
--
-- 2. anon AND authenticated HELD EVERY PRIVILEGE ON 34 OF 38 TABLES — select,
--    insert, update, delete, and also TRUNCATE, REFERENCES and TRIGGER — and a
--    default-privileges rule on the schema (owner postgres) granted the same
--    to every table created since. The migrations only ever asked for
--    `select, insert, update, delete ... to authenticated`; the rest arrived
--    with the schema being exposed. RLS restricts rows, not privileges:
--    TRUNCATE is not subject to row policies at all. The anon role is the key
--    compiled into every client bundle; it has no business holding anything
--    here — the app makes no request before sign-in, and every read after it
--    runs as `authenticated`. The four tables that already had no anon grant
--    (alt_state, alt_snapshots, alt_flags, plaid_items — the token table) show
--    what the intent always was.
--
--    So: anon loses everything on boardroom tables and sequences (schema USAGE
--    is left alone — a denied table read is a clearer failure than a missing
--    schema); authenticated keeps exactly the four DML privileges the
--    migrations name; and the default-privileges rule is corrected so the next
--    table starts right. usage_summary(timestamptz) was also executable by
--    PUBLIC (the leading `=X` in its acl); only authenticated needs it.
--
-- Nothing here changes what the signed-in owner can do. Every client path runs
-- as `authenticated` with select/insert/update/delete, and every Netlify
-- function that needs more runs as service_role, which is untouched.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the missing cascades ─────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['grocery_items', 'movies', 'saved_recipes',
                           'upstream_predictions', 'upstream_run_events', 'upstream_tell_checks']
  loop
    if not exists (
      select 1 from pg_constraint
      where conname = t || '_user_id_fkey'
        and conrelid = ('boardroom.' || t)::regclass
    ) then
      execute format(
        'alter table boardroom.%I add constraint %I foreign key (user_id) references auth.users(id) on delete cascade',
        t, t || '_user_id_fkey');
    end if;
  end loop;
end $$;

-- ── 2. privileges: what the migrations asked for, and nothing more ──────────
revoke all on all tables in schema boardroom from anon;
revoke all on all sequences in schema boardroom from anon;
revoke truncate, references, trigger on all tables in schema boardroom from authenticated;

alter default privileges for role postgres in schema boardroom revoke all on tables from anon;
alter default privileges for role postgres in schema boardroom revoke all on sequences from anon;
alter default privileges for role postgres in schema boardroom revoke truncate, references, trigger on tables from authenticated;

-- usage_summary is the Systems → Usage RPC; the owner calls it signed in.
do $$
begin
  if exists (select 1 from pg_proc p, pg_namespace n
             where n.oid = p.pronamespace and n.nspname = 'boardroom' and p.proname = 'usage_summary') then
    revoke execute on function boardroom.usage_summary(timestamptz) from public;
    grant execute on function boardroom.usage_summary(timestamptz) to authenticated;
  end if;
end $$;
