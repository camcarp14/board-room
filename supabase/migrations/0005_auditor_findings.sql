-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 · boardroom.auditor_findings — what the Site Auditor found
--
-- Written by db.saveFindings() in batches of { property, severity, area,
-- finding, suggestion } and read back newest-first with a limit. Like
-- chat_messages, the insert never supplies user_id, so the default of auth.uid()
-- is what makes the write land at all — and saveFindings is another wrapped
-- try/catch, so a failure here is silent by design.
--
-- `area` is explicitly nullable: saveFindings writes `r.area || null`, so a
-- finding that names no area stores a null rather than an empty string.
--
-- Operational, not data. db-admin.js offers "clear findings > 30d", which
-- deletes on created_at with Prefer: count=exact so the console can report a
-- number instead of "done" — hence the index on (user_id, created_at desc),
-- which serves both the read and the prune.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.auditor_findings (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  property   text        not null,
  severity   text        not null,
  area       text,
  finding    text        not null,
  suggestion text,
  created_at timestamptz not null default now()
);

create index if not exists auditor_findings_user_created_idx
  on boardroom.auditor_findings (user_id, created_at desc);

alter table boardroom.auditor_findings enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'auditor_findings'
  ) then
    create policy "auditor_findings own rows" on boardroom.auditor_findings
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.auditor_findings to authenticated;
