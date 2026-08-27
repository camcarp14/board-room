import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db, isMissingTable } from "./db.js";
import { SONGS as SEED_SONGS } from "../lib/guitar/library.js";

// ─── Guitar data ─────────────────────────────────────────────────────────────
// Three reads, cached under three keys, invalidated by the writes that touch
// them — the same grammar as data/movies.js and data/dreams.js next door.
//
// THE SEED REPERTOIRE IS MERGED IN HERE, NOT WRITTEN TO THE DATABASE. The three
// dozen charts in lib/guitar/library.js are bundle data: they cost nothing, they
// arrive with a deploy, and nobody had to press a button to get them. Inserting
// them into guitar_songs on first launch would have turned them into rows —
// which then have to be migrated when a chart is corrected, and which quietly
// resurrect after a delete. So a seed song stays a seed song until it is edited,
// at which point it is saved under its own id and the saved copy wins.

const SESSIONS = ["guitar-sessions"];
const SKILLS = ["guitar-skills"];
const SONGS = ["guitar-songs"];

// A missing table is not an error, it is a setup state, and the panel draws it
// as one. `setup: true` says the SQL has not been run yet; a genuine failure
// still throws so the card can say what went wrong instead of showing a setup
// card for a network blip.
const tolerant = (name, run) => async () => {
  try { return { rows: await run(), setup: false }; }
  catch (e) { if (isMissingTable(e, name)) return { rows: [], setup: true }; throw e; }
};

export function useGuitarSessions() {
  return useQuery({ queryKey: SESSIONS, queryFn: tolerant("guitar_sessions", () => db.loadGuitarSessions()) });
}
export function useGuitarSkills() {
  return useQuery({ queryKey: SKILLS, queryFn: tolerant("guitar_skills", () => db.loadGuitarSkills()) });
}

// The repertoire the app shows: everything saved, plus the seed charts that have
// not been saved over. Sorted so what you are learning is at the top, because
// that is what the Today block reaches for.
const STATUS_ORDER = { learning: 0, polishing: 1, owned: 2, shelved: 3 };
export function useGuitarSongs() {
  const q = useQuery({ queryKey: SONGS, queryFn: tolerant("guitar_songs", () => db.loadGuitarSongs()) });
  const own = q.data?.rows || [];
  const ownIds = new Set(own.map((s) => s.id));
  const merged = [
    ...own,
    ...SEED_SONGS.filter((s) => !ownIds.has(s.id)).map((s) => ({ ...s, status: s.status || "library", source: "seed", cleanRuns: 0 })),
  ].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4)
    || (a.difficulty || 2) - (b.difficulty || 2)
    || a.title.localeCompare(b.title));
  return { ...q, songs: merged, own, setup: q.data?.setup };
}

function useInvalidating(keys, mutationFn) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => { for (const k of keys) qc.invalidateQueries({ queryKey: k }); } });
}

// A finished session writes BOTH the log row and the skill states, in that
// order, and the mutation resolves only when both have landed. Splitting them
// into two mutations was the obvious shape and the wrong one: a session whose
// log saved and whose skills did not would show up in the streak while the
// scheduler carried on as though the work had never happened, and nothing on
// screen would say so.
export const useSaveGuitarSession = () => useInvalidating([SESSIONS, SKILLS], async ({ session, skills }) => {
  const saved = await db.saveGuitarSession(session);
  if (skills?.length) await db.saveGuitarSkills(skills);
  return saved;
});
export const useDeleteGuitarSession = () => useInvalidating([SESSIONS], (id) => db.deleteGuitarSession(id));
export const useSaveGuitarSkills = () => useInvalidating([SKILLS], (rows) => db.saveGuitarSkills(rows));
export const useSaveGuitarSong = () => useInvalidating([SONGS], (song) => db.saveGuitarSong(song));
export const useDeleteGuitarSong = () => useInvalidating([SONGS], (id) => db.deleteGuitarSong(id));

// ─── the session in progress ─────────────────────────────────────────────────
// localStorage, shape-guarded, exactly like the Train tab's in-progress workout
// and for exactly the same reason: a dead battery, a reload or a backgrounded
// PWA must not cost you the twenty minutes you just did. Supabase is still the
// brain — this is a checkpoint, and it is cleared the moment the row lands.
//
// The guard is DEEP. A drifted or corrupted checkpoint must never white-screen
// the tab, and because a render-time throw would fire on every single visit
// (the effect that would clear it never commits), anything that is not a
// plausible session reads as no session and the bad checkpoint is dropped.
const ACTIVE_KEY = "br_guitar_active";
export function loadActiveSession() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY));
    const itemOk = (i) => i && typeof i === "object" && typeof i.id === "string";
    const ok = a && typeof a === "object"
      && typeof a.day === "string" && Number.isFinite(a.startedAt)
      && Array.isArray(a.results) && a.results.every(itemOk)
      && Number.isFinite(a.blockIndex)
      // The frozen plan has to be there and has to have the block the index
      // points at, or the runner resumes into `undefined` and renders nothing
      // with no way out but clearing storage by hand.
      && a.plan && Array.isArray(a.plan.blocks) && a.plan.blocks.length > a.blockIndex
      && a.plan.blocks.every((b) => b && typeof b.kind === "string" && Number.isFinite(b.seconds));
    if (!ok) { if (a != null) clearActiveSession(); return null; }
    // Older than three hours is not a session you are still in; it is one you
    // walked away from. Offered as "save what you did" rather than resumed.
    return { ...a, stale: Date.now() - a.startedAt > 3 * 3600 * 1000 };
  } catch { clearActiveSession(); return null; }
}
export const saveActiveSession = (a) => { try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(a)); } catch { /* private mode */ } };
export const clearActiveSession = () => { try { localStorage.removeItem(ACTIVE_KEY); } catch { /* private mode */ } };

// ─── the one-time setup SQL ──────────────────────────────────────────────────
// boardroom, NOT public — src/lib/supabase.js pins the client to the boardroom
// schema and every function sends Accept-Profile, so a table created in public
// is one this app can never see: it 404s forever while the setup card that just
// "worked" keeps offering itself. That shipped once with the Dream boards; the
// note at src/features/finances/financeLogic.js:653 records it, and
// scripts/migrations-smoke.mjs is what stops it happening again.
export const GUITAR_SETUP_SQL = `-- Board Room · Guitar — one-time setup
-- Runs against the boardroom schema, which is the one this app reads.
create schema if not exists boardroom;
grant usage on schema boardroom to anon, authenticated;

create table if not exists boardroom.guitar_sessions (
  id          uuid        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  day         date        not null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  minutes     integer     not null default 0,
  items       jsonb       not null default '[]'::jsonb,
  focus       text,
  drift_ms    numeric,
  note        text        not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists guitar_sessions_user_day_idx on boardroom.guitar_sessions (user_id, day desc);
alter table boardroom.guitar_sessions enable row level security;
drop policy if exists "own guitar_sessions" on boardroom.guitar_sessions;
create policy "own guitar_sessions" on boardroom.guitar_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

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

create table if not exists boardroom.guitar_songs (
  id          text        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  title       text        not null,
  artist      text        not null default '',
  song_key    text,
  bpm         integer,
  capo        integer     not null default 0,
  difficulty  integer     not null default 2,
  status      text        not null default 'learning',
  chart       jsonb       not null default '{}'::jsonb,
  strum       text,
  clean_runs  integer     not null default 0,
  last_played date,
  note        text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists guitar_songs_user_updated_idx on boardroom.guitar_songs (user_id, updated_at desc);
alter table boardroom.guitar_songs enable row level security;
drop policy if exists "own guitar_songs" on boardroom.guitar_songs;
create policy "own guitar_songs" on boardroom.guitar_songs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- A custom schema grants nothing by default. Without these the tables exist,
-- RLS is on, the policies are right, and every read still comes back empty.
grant select, insert, update, delete on boardroom.guitar_sessions to authenticated;
grant select, insert, update, delete on boardroom.guitar_skills to authenticated;
grant select, insert, update, delete on boardroom.guitar_songs to authenticated;`;
