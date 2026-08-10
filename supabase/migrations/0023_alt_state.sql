-- ═══════════════════════════════════════════════════════════════════════════
-- 0023 · boardroom.alt_state — one row, called 'latest'
--
-- The crypto screener's whole answer, as a single jsonb payload under a text
-- primary key whose only value is the literal 'latest'. alt-cron-background
-- upserts it hourly; alt-scan reads it and hands the payload to the client
-- untouched. That is why there are three columns and not thirty: the client
-- contract is the payload's shape, and putting it in Postgres columns would mean
-- a migration every time the Markets card learns a new field.
--
-- updated_at IS READ, NOT DECORATION. alt-scan selects `updated_at, payload`
-- together so it can tell two different failures apart and say which one
-- happened. No row at all means the screener has never completed a pass — check
-- back after the first hourly run. A row whose payload is missing means the last
-- write at a specific timestamp produced nothing usable, which is a bug, not
-- timing. Collapsing those into one generic "hasn't run yet" is exactly what hid
-- a real defect (a growing per-row update loop timing the pass out every hour
-- after the first) behind a message that looked like ordinary first-deploy delay.
--
-- SERVER-ONLY. Only the service role touches this table — the browser reaches it
-- through the alt-scan function, never directly. RLS is switched on as the belt:
-- the service role bypasses it, so this cannot break the engine, and it means an
-- anon or authenticated role that somehow acquired a grant still reads nothing.
-- No grant is issued here, and none is revoked either: whatever privileges the
-- live database carries were not observable from the code, so this file does not
-- pretend to know them.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.alt_state (
  id         text        primary key,
  updated_at timestamptz,
  payload    jsonb
);

alter table boardroom.alt_state enable row level security;
