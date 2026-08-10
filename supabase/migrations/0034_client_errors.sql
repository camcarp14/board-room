-- ═══════════════════════════════════════════════════════════════════════════
-- 0034 · boardroom.client_errors — crashes, as reported by the browser
--
-- Written by reportClientError() in src/lib/telemetry.js, from three places:
-- the render boundary (src/shell/ErrorBoundary.jsx) and the two global handlers
-- registered in src/main.jsx. Read by Systems → Status, which counts the rows
-- carrying the build this device is running.
--
-- Before this table existed the boundary wrote every crash into
-- localStorage.br_crashes and nothing in the app ever read that key back, so a
-- crash on the phone was recorded on the phone, for nobody, and was gone the
-- next time Safari evicted the origin's storage. Errors thrown outside a React
-- render — an async handler, a rejected promise, an event listener — were not
-- recorded at all. The local log still gets written (it is the only record that
-- survives with no network, and Status shows it now), and this table is the
-- durable half.
--
-- `build` IS THE POINT OF THE TABLE. It carries __BUILD__ whole — the timestamp
-- and the short commit sha, exactly as vite.config.js stamps it and exactly as
-- Status prints it — so "did that deploy break something" is a question with an
-- answer instead of a feeling. It is nullable only because a bundle loaded
-- without vite in front of it reports the string "dev"; nothing writes a null on
-- purpose.
--
-- `kind` is one of 'render', 'window' or 'rejection', named after where the
-- error was caught rather than what it was. Deliberately a plain text column and
-- not a check constraint: `create table if not exists` skips the whole statement
-- on a second run, so a constraint written here would silently not exist on the
-- table production already has, and a constraint that only applies to fresh
-- databases is worse than none — it reads as a guarantee while enforcing
-- nothing. The writer is the only gate, and there is exactly one writer.
--
-- `hash` is a cheap digest of message+stack, computed in the browser. It is what
-- makes the reporter safe to point at a render loop: telemetry.js refuses to
-- insert a hash it has already sent for this build, so a component throwing
-- three hundred times a second produces one row. It is stored rather than
-- discarded because it is also the only way to fold the same crash reported from
-- two devices or across two sessions into one line later on.
--
-- For a 'render' row the first line of `stack` names the boundary that caught it
-- ("boundary: grocery"), because that label is genuinely the top frame of a
-- React render crash and there is nothing analogous for the other two kinds.
--
-- NO RETENTION SWEEP, and it does not need one. The client-side cap in
-- telemetry.js is what bounds this table: at most a couple of dozen distinct
-- crashes per build per browser, and a build lasts until the next deploy. If it
-- ever does grow, the prune to add is the same shape as "clear findings > 30d"
-- in netlify/functions/db-admin.js, and the index below already serves it.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.client_errors (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text        not null,
  message    text        not null,
  stack      text,
  build      text,
  url        text,
  hash       text        not null,
  created_at timestamptz not null default now()
);

-- The only read that runs: "my crashes on this build, newest first" (Systems →
-- Status). created_at leads on the same index for a future retention sweep.
create index if not exists client_errors_user_build_created_idx
  on boardroom.client_errors (user_id, build, created_at desc);

alter table boardroom.client_errors enable row level security;

-- Tested by command, not by name — see the long note in 0001_app_settings.sql.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'boardroom' and tablename = 'client_errors'
  ) then
    create policy "client_errors own rows" on boardroom.client_errors
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- RLS filters; it does not grant. Without this line the insert is refused for
-- the signed-in role no matter what the policy above says — and a crash reporter
-- whose writes are refused is the exact failure this file exists to end.
grant select, insert, update, delete on boardroom.client_errors to authenticated;
