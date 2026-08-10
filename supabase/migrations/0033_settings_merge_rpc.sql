-- ═══════════════════════════════════════════════════════════════════════════
-- 0033 · boardroom.settings_merge — the settings write that stops two devices
--        from silently deleting each other's work
--
-- THIS FILE DEFINES NO TABLE. It is the first function in this directory, and it
-- belongs here for the same reason the tables do: it is schema, it is
-- boardroom-qualified, and it has to be pasted into the SQL editor before the
-- client that calls it ships. 0001_app_settings.sql is the table it writes.
--
-- WHAT WENT WRONG. app_settings is a key/value store, but several of its values
-- are not preferences at all — they are documents the owner types into:
-- ponder_items, finance_rules, budgets, navigation, brief_order, notes_order,
-- grocery_stores, the saved dream-board list. The browser loads every setting
-- ONCE at sign-in into a single plain object (db.loadSettings), and every panel
-- writes by reading that in-memory copy, changing one thing inside it, and
-- upserting the WHOLE value back with on_conflict = user_id,setting_key. There
-- is no realtime subscription anywhere in src/, so that copy never finds out
-- that anything changed underneath it.
--
-- Two devices is all it takes. Park a thought in Ponder on the iPad: the row's
-- value becomes [new, …old]. The phone has been signed in since this morning and
-- still holds the array as it was before that thought existed, so the moment it
-- archives an item it upserts its own array straight over the top. The iPad's
-- thought is gone. Nothing returns an error, because the upsert did exactly what
-- it was asked to do, and nothing on either side ever compared what was already
-- there. The only trace is the thought being missing the next time the iPad
-- reloads, which reads as "I must not have saved it".
--
-- WHAT THIS FUNCTION DOES. It moves the read-modify-write inside the database,
-- where the read and the write are one statement that cannot straddle somebody
-- else's, and it takes the writer's belief about the row's updated_at as an
-- argument so a writer working from a superseded copy can be told no.
--
-- TWO STRATEGIES, BECAUSE THERE ARE TWO SHAPES, AND ONE OF THEM CANNOT BE MERGED
--
--   'merge'   — for OBJECT-shaped values (finance_rules is { merchantKey:
--               category }). The patch is applied to whatever the row holds at
--               the instant of the write, key by key, so a rule the other device
--               added for a different merchant survives instead of being erased
--               by a stale snapshot that never knew about it. Deletions are
--               expressed as a JSON null for that key — the same convention as
--               RFC 7386's merge patch — because a key simply absent from a
--               patch has to mean "leave it alone", which is the entire point.
--               A stale expected_updated_at is NOT a veto here: the merge is
--               applied to current data, so there is nothing to protect against.
--               The result reports stale = true so the caller can adopt the
--               merged value it did not predict.
--
--   'replace' — for ARRAY-shaped values (ponder_items is a list of item objects;
--               brief_order and notes_order are lists of ids). There is no
--               honest merge for these. Union by id resurrects an item the other
--               device deleted; last-one-wins on each element drops edits; and
--               either one throws away the ORDER, which for these arrays is the
--               data. So the array is written whole and only ever onto the exact
--               revision the writer read: if updated_at has moved, the write is
--               REFUSED and the current value is handed back with it. Rejecting
--               is the honest answer — the alternative is inventing a merge
--               whose failures are as quiet as the bug this replaces.
--
-- THE ALLOWLIST IS THE SAFETY VALVE. Exactly two keys go through here today,
-- ponder_items and finance_rules. Every other setting keeps db.saveSetting's
-- plain upsert. This must not become the write path for all of app_settings in
-- one commit: mini_tasks and notes_capture are written by Netlify functions with
-- the service-role key, econ-resolve-background POSTs its own key straight to
-- PostgREST, and none of those callers has ever heard of an expected updated_at.
-- The list below and MERGING_SETTINGS in src/data/db.js are the same list twice;
-- scripts/systems-smoke.mjs fails if they disagree.
--
-- SECURITY INVOKER, and scoped to auth.uid() on top of that. Invoker keeps RLS
-- in force, so the policy in 0001_app_settings.sql (auth.uid() = user_id) filters
-- the read and checks the write exactly as it does for any other client
-- statement. The explicit user_id = auth.uid() on every statement is not
-- redundant: it is what makes this function still correct if it is ever called
-- with a key that bypasses RLS, and it is why the function cannot be pointed at
-- another user's row by passing a different argument — there is no argument for
-- whose row to touch.
--
-- Called straight from the browser with the anon key. It needs no Netlify
-- function in front of it, for the same reason boardroom.usage_summary needs none
-- (see supabase-usage-fix.sql and the rpc call in SystemsPage.jsx): supabase-js
-- sends Content-Profile: boardroom on rpc, the schema is exposed, and RLS plus
-- the auth.uid() guard are the whole authorization story.
-- ═══════════════════════════════════════════════════════════════════════════

-- DROP FIRST, then create. `create or replace function` cannot change a return
-- type (Postgres 42P13), and the one thing certain about a function that will be
-- edited again is that its return shape will grow a field. Dropping is what makes
-- this file re-runnable against a database that already has an older version,
-- which is the only interesting case — a database that has none was never hard.
drop function if exists boardroom.settings_merge(text, jsonb, timestamptz);

create function boardroom.settings_merge(
  p_key                 text,
  p_patch               jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
-- Empty search_path, so every name below resolves to what it says and nothing
-- can be shadowed by a schema that happens to come first for some caller.
-- Everything is therefore qualified: boardroom.app_settings, auth.uid().
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_strategy text;
  v_cur      jsonb;
  v_cur_at   timestamptz;
  v_base     jsonb;
  v_drop     text[] := '{}';
  v_stale    boolean;
  v_next     jsonb;
  v_at       timestamptz;
begin
  -- Not signed in is an exception, not a rejection: a rejection means "your copy
  -- was out of date", and answering that to a caller with no session at all would
  -- send it into a refetch it cannot perform either.
  if v_uid is null then
    raise exception 'settings_merge: no signed-in user' using errcode = '28000';
  end if;

  -- ── the allowlist ─────────────────────────────────────────────────────────
  v_strategy := case p_key
    when 'finance_rules' then 'merge'
    when 'ponder_items'  then 'replace'
    else null
  end;

  if v_strategy is null then
    raise exception 'settings_merge: % is not a merging setting', p_key
      using errcode = '22023';
  end if;

  -- The shape has to match the strategy the key was given, and a mismatch has to
  -- be loud. A patch that arrives as an array under a 'merge' key means the panel
  -- writing it changed shape since this list was written, and quietly picking one
  -- of the two behaviours for it is how a settings row gets silently mangled by
  -- the very function that exists to stop that.
  if v_strategy = 'merge' and jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'settings_merge: % merges objects, got %', p_key, coalesce(jsonb_typeof(p_patch), 'nothing')
      using errcode = '22023';
  end if;

  if v_strategy = 'replace' and jsonb_typeof(p_patch) is distinct from 'array' then
    raise exception 'settings_merge: % replaces arrays, got %', p_key, coalesce(jsonb_typeof(p_patch), 'nothing')
      using errcode = '22023';
  end if;

  -- FOR UPDATE, so two devices arriving together are serialised rather than
  -- interleaved: the second one waits here and then reads the first one's
  -- updated_at, which is exactly the value it has to be compared against. On a
  -- key that has never been written there is no row and no lock, and the insert
  -- below carries its own guard for that case.
  select s.setting_value, s.updated_at
    into v_cur, v_cur_at
    from boardroom.app_settings s
   where s.user_id = v_uid
     and s.setting_key = p_key
     for update;

  -- `is distinct from` rather than <>, so all four null combinations are right:
  -- no row and no expectation match (a first write), while no expectation against
  -- a row that exists is a mismatch — a caller that never read the row must not
  -- get to overwrite an array it has never seen.
  v_stale := v_cur_at is distinct from p_expected_updated_at;

  if v_strategy = 'merge' then
    -- A JSON null in the stored value is treated as no value at all; anything
    -- else that is not an object is refused rather than merged into, because the
    -- alternative is discarding whatever is really in there.
    if v_cur is null or jsonb_typeof(v_cur) = 'null' then
      v_base := '{}'::jsonb;
    elsif jsonb_typeof(v_cur) = 'object' then
      v_base := v_cur;
    else
      raise exception 'settings_merge: % holds a % in the database, not an object', p_key, jsonb_typeof(v_cur)
        using errcode = '22023';
    end if;

    -- The keys the patch nulls out are deletions (RFC 7386). They have to be
    -- removed from the base BEFORE the concatenation, because jsonb || would
    -- otherwise store a key whose value is null — which reads back as a rule that
    -- exists and has no category, not as a rule that was cleared.
    select coalesce(array_agg(e.key), '{}'::text[])
      into v_drop
      from jsonb_each(p_patch) as e
     where jsonb_typeof(e.value) = 'null';

    v_next := (v_base - v_drop) || (p_patch - v_drop);
  else
    v_next := p_patch;
  end if;

  -- ONE STATEMENT DOES THE WHOLE WRITE, including the compare-and-set.
  --
  -- The insert covers a key written for the first time. The conflict path covers
  -- every later write, and it recomputes the merge from s.setting_value — the row
  -- as it stands at this instant — rather than from v_base, so even the sliver
  -- between the select above and this statement cannot lose a concurrent write.
  --
  -- The where clause on the update is the compare-and-set, and it is the reason a
  -- stale array writer is refused instead of winning: for 'replace' the row is
  -- touched only while its updated_at is still the one the caller read. 'merge'
  -- short-circuits it because a merge onto current data has nothing to lose.
  insert into boardroom.app_settings as s (user_id, setting_key, setting_value, updated_at)
  values (v_uid, p_key, v_next, now())
  on conflict (user_id, setting_key) do update
     set setting_value = case
           when v_strategy = 'merge'
             then (coalesce(nullif(s.setting_value, 'null'::jsonb), '{}'::jsonb) - v_drop) || (p_patch - v_drop)
           else excluded.setting_value
         end,
         updated_at = now()
   where v_strategy = 'merge'
      or s.updated_at is not distinct from p_expected_updated_at
  returning s.setting_value, s.updated_at into v_next, v_at;

  if not found then
    -- Refused. NOTHING was written, and saying so is the entire job — but the
    -- caller also needs the value it lost the race to, or its next attempt is
    -- another guess. Handing the current row back with the refusal is what turns
    -- "try again" into one round trip instead of a retry that cannot yet succeed.
    select s.setting_value, s.updated_at
      into v_cur, v_cur_at
      from boardroom.app_settings s
     where s.user_id = v_uid
       and s.setting_key = p_key;

    return jsonb_build_object(
      'key',        p_key,
      'strategy',   v_strategy,
      'applied',    false,
      'stale',      true,
      -- NOT "changed on another device". This function knows the row's revision
      -- moved after the writer read it; it does not know WHO moved it, and it
      -- cannot — the writer's own earlier write moves it too. Naming a device
      -- here is a claim nothing verified, and a client that built an error
      -- message out of this string would put that claim in front of the user.
      -- (db.js deliberately ignores this field for exactly that reason; it is
      -- kept for the function log, where a wrong actor is merely unhelpful.)
      'reason',     'the stored revision moved after this writer read it',
      'value',      v_cur,
      'updated_at', v_cur_at
    );
  end if;

  -- Applied. The merged value and the new updated_at go back so the caller can
  -- adopt both: the value because a merge can legitimately contain keys this
  -- caller has never seen, and the stamp because it is the expectation its next
  -- write has to carry.
  return jsonb_build_object(
    'key',        p_key,
    'strategy',   v_strategy,
    'applied',    true,
    'stale',      coalesce(v_stale, false),
    'reason',     null,
    'value',      v_next,
    'updated_at', v_at
  );
end
$$;

-- Functions are executable by PUBLIC by default, and a fresh create restores that
-- default every run — so the revoke has to follow the create, every run. The
-- auth.uid() guard inside is the real gate; this just means an unauthenticated
-- caller cannot reach the guard to be refused by it.
revoke execute on function boardroom.settings_merge(text, jsonb, timestamptz) from public;
grant  execute on function boardroom.settings_merge(text, jsonb, timestamptz) to authenticated;

-- PostgREST caches the schema. Without this the rpc 404s — looking exactly like a
-- function that was never created — until the next restart.
notify pgrst, 'reload schema';
