-- ═══════════════════════════════════════════════════════════════════════════
-- 0009 · boardroom.upkeep_items — recurring maintenance with a memory
--
-- Oil change, AC filter, anything on a cadence. Two columns carry the whole
-- feature: `interval_days` and `last_done`. Everything else about a due date is
-- derived — src/lib/upkeep.js in the browser and upkeepDue() in trmnl.js both
-- compute last_done + interval_days and neither stores the result, which is why
-- there is no next_due column to fall out of sync.
--
-- last_done is a DATE, not a timestamp, and that is deliberate: a completion is
-- a day, and storing an instant would have re-imported the timezone bug that
-- src/lib/dates.js exists to warn about. It is nullable — db.saveUpkeepItem
-- writes `item.last_done || null` — and both due-date functions return null for
-- an item that has never been logged, which the UI renders as "Never logged"
-- rather than as overdue.
--
-- db.loadUpkeep() selects id,name,interval_days,last_done,notes ordered by
-- created_at ascending, so the list keeps the order you built it in.
--
-- THIS IS ONE OF THE FOUR SCHEMA CORRECTIONS. UpkeepPanel.jsx still shows the
-- user `create table if not exists public.upkeep_items` in its setup card, and
-- `public` is a schema this app cannot read. See 0000_schema.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.upkeep_items (
  id            uuid        primary key,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  name          text        not null,
  interval_days integer     not null default 90,
  last_done     date,
  notes         text        not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists upkeep_items_user_created_idx
  on boardroom.upkeep_items (user_id, created_at);

alter table boardroom.upkeep_items enable row level security;

-- The name here is the one UpkeepPanel.jsx's setup card already establishes, so
-- drop-then-create is a no-op against production rather than a second policy.
drop policy if exists "upkeep own rows" on boardroom.upkeep_items;
create policy "upkeep own rows" on boardroom.upkeep_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.upkeep_items to authenticated;
