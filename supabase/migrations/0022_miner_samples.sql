-- ═══════════════════════════════════════════════════════════════════════════
-- 0022 · boardroom.miner_samples — a 2-minute pulse from the machine at home
--
-- Written by scripts/miner-push.mjs (a Windows scheduled task, not a Netlify
-- function) with the service-role key; read by src/lib/miner.js in the browser,
-- which takes payload,created_at ordered created_at desc limit 1. So the read is
-- always "the latest one" and the index exists for that plus the prune.
--
-- THE THREE DENORMALISED COLUMNS ARE THE ONES ON SCREEN. hash_rate, temp and
-- power are pulled out of the payload at write time — hash_rate specifically from
-- payload.hashRate_10m, the steadier figure and the one the panel leads with, so
-- the column matches what you actually see rather than the noisier instantaneous
-- reading. All three are nullable: a sample from a miner that answered but did
-- not report a field must not become a zero.
--
-- IT IS PRUNED, NOT APPENDED FOREVER. A 2-minute cadence is roughly 260,000 rows
-- a year, so miner-push deletes anything past its retention window on every push
-- — an indexed delete that usually matches nothing is cheap enough to just run
-- every time rather than track when it last happened. That delete filters
-- (user_id, created_at), which is the index below.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.miner_samples (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  payload    jsonb       not null,
  hash_rate  numeric,
  temp       numeric,
  power      numeric,
  created_at timestamptz not null default now()
);

create index if not exists miner_samples_user_created_idx
  on boardroom.miner_samples (user_id, created_at desc);

alter table boardroom.miner_samples enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'miner_samples'
  ) then
    create policy "miner_samples own rows" on boardroom.miner_samples
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on boardroom.miner_samples to authenticated;
