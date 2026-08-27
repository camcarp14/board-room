-- ═══════════════════════════════════════════════════════════════════════════
-- 0038 · boardroom.guitar_skills — the scheduler's memory
--
-- One row per skill the practice engine tracks, keyed by the string ids in
-- src/lib/guitar/library.js. THOSE IDS ARE PERMANENT: renaming "chg_g_c" to
-- something tidier orphans every row filed under the old one, and what is lost
-- is not a label but a year of decayed-and-rebuilt strength that cannot be
-- recomputed from anything except guitar_sessions.items (0037).
--
-- COMPOSITE PRIMARY KEY, no surrogate id. A user has exactly one state per
-- skill, the client upserts a batch of them at the end of every session, and
-- onConflict needs a real unique constraint to aim at. A uuid id with a separate
-- unique index would be the same thing with an extra column and one more way for
-- two rows to exist for one skill.
--
-- `strength` is 0–100 and DECAYS WITH TIME rather than being recomputed on
-- write — src/lib/guitar/practice.js integrates the decay from `last_practiced`
-- on every read. So the number stored here is the strength as of the last
-- session, never as of now, and anything reading this table directly (a future
-- export, a Brief tile) has to decay it or it will overstate every skill by
-- however long it has been.
--
-- `history` is the last 20 attempts — [{ day, rating, bpm }] — and it is capped
-- at the client. It is what the 80–92% rolling-accuracy band is computed from;
-- twenty is roughly a month of contact with an item, which is the window over
-- which "am I in the zone on this" is a meaningful question.
--
-- `best_bpm` and `ceiling_bpm` are two different facts.
--
-- best_bpm is the fastest CLEAN rep ever recorded and is LIVE: practice.js's
-- applyResult writes it on a clean rep, and the regression rule reads it. For a
-- one-minute-changes skill the unit is changes per minute, which is that drill's
-- own measure of tempo.
--
-- ceiling_bpm is RESERVED AND NOT YET WRITTEN. The intent is where the tempo
-- ladder last broke, so the next session opens five below the first failure
-- rather than at the wall it stopped at — but practice.js's ladderPlan and
-- ladderStep have no caller in the app yet, so nothing sets this and every row
-- has it null. Said plainly here because the previous version of this comment
-- described the behaviour in the present tense, and a schema comment that
-- describes a mechanism which does not exist is worse than no comment.
--
-- No index beyond the primary key: the only read is "all of this user's skills",
-- which the pkey's leading user_id already serves, and the table is bounded by
-- the size of the curriculum (about 65 rows) rather than by time.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.guitar_skills (
  user_id        uuid        not null references auth.users(id) on delete cascade,
  skill_id       text        not null,
  strength       numeric     not null default 0,
  last_practiced date,
  sessions       integer     not null default 0,
  minutes        numeric     not null default 0,
  best_bpm       integer,
  ceiling_bpm    integer,
  history        jsonb       not null default '[]'::jsonb,
  updated_at     timestamptz not null default now(),
  primary key (user_id, skill_id)
);

alter table boardroom.guitar_skills enable row level security;

drop policy if exists "own guitar_skills" on boardroom.guitar_skills;
create policy "own guitar_skills" on boardroom.guitar_skills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.guitar_skills to authenticated;
