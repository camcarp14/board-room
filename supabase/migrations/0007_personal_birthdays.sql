-- ═══════════════════════════════════════════════════════════════════════════
-- 0007 · boardroom.personal_birthdays — recurring dates with no year required
--
-- Month and day are separate integers rather than a date because that is the
-- whole point: a birthday repeats every year, and trmnl.js reconstructs the
-- occurrence with `icsDate(thisYear, b.month, b.day)` plus FREQ=YEARLY. `year`
-- is nullable — db.saveBirthday writes `b.year ?? null` — so a birthday whose
-- year nobody knows still works, it just has no age attached.
--
-- db.loadBirthdays() selects id,name,month,day,year,notes with no ORDER BY at
-- all; the sort into "who's next" happens in the client, against the current
-- date, which no SQL ordering of (month, day) could give you. No index for the
-- same reason: this is a full read of a short table every time.
--
-- id is client-generated and the upsert conflicts on it alone.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.personal_birthdays (
  id         uuid        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  name       text        not null,
  month      integer     not null,
  day        integer     not null,
  year       integer,
  notes      text        not null default '',
  created_at timestamptz not null default now()
);

alter table boardroom.personal_birthdays enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'personal_birthdays'
  ) then
    create policy "personal_birthdays own rows" on boardroom.personal_birthdays
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.personal_birthdays to authenticated;
