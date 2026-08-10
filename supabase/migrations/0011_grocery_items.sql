-- ═══════════════════════════════════════════════════════════════════════════
-- 0011 · boardroom.grocery_items — five columns, and everything else is text
--
-- THERE IS NO qty COLUMN, NO store COLUMN AND NO section COLUMN, and that is a
-- decision rather than an omission. Quantity lives inside the item text ("2x
-- milk"), a store is a trailing "@Costco", and a section is a trailing "#bakery"
-- — all parsed out by src/features/food/groceryLogic.js. So bumping a count is a
-- text rewrite (db.updateGroceryItem), which is also what lets an add that
-- matches an existing row merge into it instead of opening a duplicate line.
-- The aisle is derived from the item text too and never stored.
--
-- The consequence for this file: `item` carries structure, so nothing here may
-- normalise, trim or case it on the way in. The parser is the schema.
--
-- db.loadGroceryItems() does `select *` ordered created_at ascending, so the list
-- stays in the order you added things.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.grocery_items (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  item       text        not null,
  checked    boolean     not null default false,
  created_at timestamptz not null default now()
);

create index if not exists grocery_items_user_created_idx
  on boardroom.grocery_items (user_id, created_at);

alter table boardroom.grocery_items enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'grocery_items'
  ) then
    create policy "grocery_items own rows" on boardroom.grocery_items
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.grocery_items to authenticated;
