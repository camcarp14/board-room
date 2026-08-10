-- ═══════════════════════════════════════════════════════════════════════════
-- 0019 · boardroom.plaid_items — a credential store, not a data table
--
-- Copied from PLAID_SQL in src/features/finances/plaid.js. It is the one table in
-- this directory that grants nothing to anybody, and that is the point.
--
-- RLS ON, NO POLICY, GRANTS REVOKED. It holds long-lived bank access tokens, and
-- the only thing that should ever read them is netlify/functions/plaid.js, which
-- uses the service-role key and bypasses RLS by design. RLS with no policy means
-- the browser cannot read this table even with a valid session — so a stolen
-- session still cannot lift a bank token. Every other table here grants the
-- signed-in role its own rows; do not "fix" this one to match them.
--
-- It is also the one table netlify/functions/export-data.js refuses to include in
-- a backup, and says so in the response rather than dropping it silently. A JSON
-- file on a laptop is not where live bank credentials belong; re-linking an
-- institution is a two-minute job, and losing the token costs nothing else.
--
-- The primary key is (user_id, item_id) because item_id is Plaid's identifier,
-- not ours. `cursor` is Plaid's incremental-sync cursor and `synced_at` is when it
-- last advanced — both nullable, because a freshly linked item has neither.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.plaid_items (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  item_id      text        not null,
  access_token text        not null,
  institution  text        not null default 'Bank',
  cursor       text,
  synced_at    timestamptz,
  created_at   timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table boardroom.plaid_items enable row level security;
revoke all on boardroom.plaid_items from anon, authenticated;
