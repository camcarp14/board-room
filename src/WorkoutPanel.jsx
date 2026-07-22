import { useState, useEffect, useMemo, useRef } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, StatTile, Button, PillRow, Segmented,
  Sheet, useConfirm, Field, TextArea, SwitchRow, EmptyState, Dot, Grid,
} from "./ui/kit.jsx";
import {
  IcPlus, IcClose, IcCheck, IcClock, IcChevronLeft, IcChevronRight, IcChevronDown, IcDumbbell,
} from "./ui/icons.jsx";
import {
  e1RM, consistency, weeklySetsByGroup, groupFreshness, warmupRamp,
  suggestNext, weeklyRecap, lifetimeVolume, recentPRs, GROUPS, isCardio, cardioMeta,
  upNext, weeklyVolumeSeries, plateauRead,
} from "./lib/workout-engine.js";

// ════════════════════════════════════════════════════════════════════════════
// WORKOUT — the Train tab (graduated from Personal to its own dock slot).
// Built around the things every fitness app gets wrong:
//   · logging a set takes one tap — values pre-filled from last time
//   · no keyboard hunting mid-set: big − / + steppers (inputs still editable)
//   · last session's numbers sit right under each set number (WORKING sets
//     only — a saved warm-up ramp never becomes a ghost value)
//   · rest timer starts itself when you log; vibrates at zero; the screen
//     stays awake mid-session (wake lock)
//   · set types: tap the set marker to cycle working → warm-up → failure →
//     drop. Warm-ups are saved but NEVER count toward volume, PRs, or
//     weekly sets
//   · "Ramp" inserts bar→55→70→85% warm-up sets from the working weight
//   · a double-progression cue per lift, stated with its numbers
//   · per-lift sticky notes ("seat 4, cues") that show up every session
//   · PRs judged only against your own history (est-1RM Epley, ≤12 reps —
//     beyond that the formula lies, so it estimates nothing); first-ever
//     lift is a baseline, not a PR
//   · This week card: sessions vs goal, weekly streak (an in-progress week
//     can join it, never break it), 20-week heatmap
//   · Progress: est-1RM trend, PR wall, sets-per-muscle-group vs the 10–20
//     band, week-vs-week recap, lifetime tonnage
//   · Apple Watch: a Shortcuts automation POSTs finished workouts to
//     /.netlify/functions/workout-import (token-gated, idempotent) — runs
//     and rides land in History with kcal + avg HR
//   · a workout in progress survives the app closing — resumes where you left it
//   · finishing can write today's numbers back into the routine (one toggle)
//   · your data, your Supabase — CSV export lives in History
// Supabase is the brain (workout_templates + workout_sessions, RLS like every
// other table, cardio imports ride the same rows — zero schema migration);
// localStorage only checkpoints the in-progress session, shape-guarded.
// Every derived number comes from src/lib/workout-engine.js (smoke-tested in
// scripts/workout-smoke.mjs, wired into `npm run verify`).
// ════════════════════════════════════════════════════════════════════════════

// ─── One-time Supabase setup (shown in-app if the tables don't exist yet) ────
export const WORKOUT_SETUP_SQL = `-- Board Room · Workout — one-time setup
create table if not exists public.workout_templates (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  unit text not null default 'lb',
  exercises jsonb not null default '[]'::jsonb,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.workout_templates enable row level security;
create policy "own workout_templates" on public.workout_templates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.workout_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  template_id uuid,
  template_name text,
  unit text not null default 'lb',
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_sec int,
  notes text not null default '',
  exercises jsonb not null default '[]'::jsonb,
  total_volume numeric,
  total_sets int,
  pr_count int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.workout_sessions enable row level security;
create policy "own workout_sessions" on public.workout_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.body_weight_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  weight numeric not null check (weight > 0 and weight < 1500),
  unit text not null default 'lb' check (unit in ('lb','kg')),
  logged_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.body_weight_log enable row level security;
create policy "own body_weight_log" on public.body_weight_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists body_weight_log_user_time on public.body_weight_log (user_id, logged_at desc);`;

// ─── db layer (client passed in from App.jsx — same contract style as db.*) ──
function makeWdb(sb) {
  return {
    async uid() { const { data } = await sb.auth.getUser(); return data?.user?.id || null; },
    async loadTemplates() {
      const { data, error } = await sb.from("workout_templates")
        .select("id,name,unit,exercises,position,updated_at")
        .order("position", { ascending: true }).order("created_at", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    async saveTemplate(t) {
      const user_id = await this.uid();
      if (!user_id) throw new Error("Not signed in");
      const row = { id: t.id, user_id, name: t.name, unit: t.unit || "lb", exercises: t.exercises || [], position: t.position ?? 0, updated_at: new Date().toISOString() };
      const { data, error } = await sb.from("workout_templates").upsert(row, { onConflict: "id" }).select().single();
      if (error) throw error;
      return data;
    },
    async deleteTemplate(id) { try { await sb.from("workout_templates").delete().eq("id", id); } catch {} },
    async loadSessions(limit = 120) {
      const { data, error } = await sb.from("workout_sessions")
        .select("id,template_id,template_name,unit,started_at,ended_at,duration_sec,notes,exercises,total_volume,total_sets,pr_count")
        .order("started_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return data || [];
    },
    async saveSession(row) {
      const user_id = await this.uid();
      if (!user_id) throw new Error("Not signed in");
      // upsert, not insert: the id is client-generated and stable, so Finish
      // is idempotent. A plain insert meant "request committed, response
      // lost" left every retry hitting the duplicate-key error — the workout
      // was saved but the user could never leave the session view via Save.
      const { data, error } = await sb.from("workout_sessions").upsert({ ...row, user_id }, { onConflict: "id" }).select().single();
      if (error) throw error;
      return data;
    },
    async deleteSession(id) {
      const { error } = await sb.from("workout_sessions").delete().eq("id", id);
      if (error) throw error;
    },
    // body-weight log — table ships via migration; a missing table degrades
    // to { error } so the card can say so instead of pretending emptiness
    async loadBodyWeight(limit = 120) {
      const { data, error } = await sb.from("body_weight_log")
        .select("id,weight,unit,logged_at").order("logged_at", { ascending: false }).limit(limit);
      if (error) return { error: error.message };
      return { rows: data || [] };
    },
    async addBodyWeight(weight, unit) {
      const user_id = await this.uid();
      if (!user_id) throw new Error("Not signed in");
      const { data, error } = await sb.from("body_weight_log")
        .insert({ user_id, weight, unit }).select().single();
      if (error) throw error;
      return data;
    },
    async deleteBodyWeight(id) {
      const { error } = await sb.from("body_weight_log").delete().eq("id", id);
      if (error) throw error;
    },
  };
}

// ─── in-progress checkpoint — localStorage only, Supabase stays the brain ────
const ACTIVE_KEY = "br_workout_active";
// Shape-guarded DEEPLY: a drifted/corrupted checkpoint must never
// white-screen the tab — and because a render-time throw would fire on
// EVERY visit (the cleanup effect never commits), anything that isn't a
// plausible session down to the set level reads as "no session" and the
// bad checkpoint is dropped on the spot.
const loadActive = () => {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY));
    const setOk = (s) => s && typeof s === "object"
      && (s.weight == null || Number.isFinite(s.weight))
      && (s.reps == null || Number.isFinite(s.reps));
    const exOk = (e) => e && typeof e === "object" && typeof e.name === "string" && Array.isArray(e.sets) && e.sets.every(setOk);
    const ok = a && typeof a === "object" && Number.isFinite(a.startedAt)
      && Array.isArray(a.exercises) && a.exercises.every(exOk);
    if (!ok) { if (a != null) clearActive(); return null; }
    return a;
  } catch { clearActive(); return null; }
};
const saveActive = (a) => { try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(a)); } catch {} };
const clearActive = () => { try { localStorage.removeItem(ACTIVE_KEY); } catch {} };

// ─── helpers ─────────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
const norm = (s) => (s || "").trim().toLowerCase();
// Roman numbering retired from set rows in the SESSION redesign (tabular
// arabic reads faster mid-set) — helper kept for compatibility.
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const roman = (n) => ROMAN[n] || String(n); // eslint-disable-line no-unused-vars
// est-1RM comes from the engine: Epley, capped at 12 reps — a 20-rep set
// returns null and can neither chart nor set a "PR". 0 here = no estimate.
const epley = (w, r) => (w > 0 ? e1RM(w, r) ?? 0 : 0);
// Set kinds: undefined/absent = working. Warm-ups never count toward
// volume, PRs, or weekly sets; failure/drop are working sets with a badge.
const KIND_NEXT = { working: "warmup", warmup: "failure", failure: "drop", drop: "working" };
const KIND_BADGE = { warmup: { label: "WU", tone: "var(--amber)" }, failure: { label: "F", tone: "var(--red)" }, drop: { label: "D", tone: "var(--blue)" } };
const isWU = (s) => s?.kind === "warmup";
const buzz = (enabled, pattern) => { if (enabled) try { navigator.vibrate?.(pattern); } catch { /* unsupported */ } };
const conv = (w, from, to) => (w == null || from === to ? w : from === "lb" ? w / 2.20462 : w * 2.20462);
const fmtW = (w) => (w == null ? "—" : (Math.round(w * 10) / 10).toString().replace(/\.0$/, ""));
const fmtVol = (v) => (v >= 10000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toLocaleString());
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.round(s / 60)}m`);
const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const REST_CYCLE = [45, 60, 90, 120, 150, 180, 0];
const PLATES = { lb: [45, 35, 25, 10, 5, 2.5], kg: [25, 20, 15, 10, 5, 2.5, 1.25] };

function plateBreakdown(weight, unit, bar) {
  if (weight == null || weight <= 0) return null;
  if (weight < bar) return { text: `below the ${fmtW(bar)} ${unit} bar` };
  if (weight === bar) return { text: "bar only" };
  let side = (weight - bar) / 2, parts = [];
  for (const p of PLATES[unit] || PLATES.lb) {
    while (side >= p - 1e-9) { parts.push(p); side -= p; }
  }
  const text = parts.length ? parts.map(fmtW).join(" · ") + " per side" : "bar only";
  return { text: side > 0.01 ? `${text} (+${fmtW(side * 2)} unplateable)` : text };
}

// ─── exercise library — a starting vocabulary; anything typed is fair game ───
const LIB = [
  ["Chest", ["Barbell Bench Press", "Incline Barbell Bench", "Dumbbell Bench Press", "Incline Dumbbell Press", "Chest Fly (Machine)", "Cable Crossover", "Push-Up", "Dip (Chest)"]],
  ["Back", ["Deadlift", "Barbell Row", "Pull-Up", "Chin-Up", "Lat Pulldown", "Seated Cable Row", "Dumbbell Row", "T-Bar Row", "Rack Pull", "Face Pull"]],
  ["Shoulders", ["Overhead Press (Barbell)", "Seated Dumbbell Press", "Lateral Raise", "Rear Delt Fly", "Arnold Press", "Upright Row", "Front Raise", "Shrug"]],
  ["Arms", ["Barbell Curl", "Dumbbell Curl", "Hammer Curl", "Preacher Curl", "Cable Curl", "Close-Grip Bench", "Skullcrusher", "Triceps Pushdown", "Overhead Triceps Extension", "Dip (Triceps)"]],
  ["Legs", ["Back Squat", "Front Squat", "Leg Press", "Romanian Deadlift", "Bulgarian Split Squat", "Walking Lunge", "Leg Extension", "Leg Curl", "Hip Thrust", "Calf Raise", "Goblet Squat", "Hack Squat"]],
  ["Core", ["Plank", "Hanging Leg Raise", "Cable Crunch", "Ab Wheel Rollout", "Russian Twist", "Side Plank", "Dead Bug"]],
  ["Conditioning", ["Rowing (Erg)", "Assault Bike", "Sled Push", "Farmer's Carry", "Kettlebell Swing", "Box Jump", "Burpee"]],
];

// ════════════════════════════════════════════════════════════════════════════
// Main panel
// ════════════════════════════════════════════════════════════════════════════
export default function WorkoutPanel({ isMobile, supabase, settings, updateSetting }) {
  const wdb = useMemo(() => makeWdb(supabase), [supabase]);
  const [confirmEl, confirm] = useConfirm();

  // preferences ride the existing app_settings table under one key
  const ws = (settings && settings.workout) || {};
  const unit = ws.unit === "kg" ? "kg" : "lb";
  const bar = Number(ws.bar) > 0 ? Number(ws.bar) : unit === "kg" ? 20 : 45;
  const defaultRest = Number.isFinite(Number(ws.rest)) ? Number(ws.rest) : 90;
  // Guard the boot window: before settings load, ws is {} and a write here
  // would clobber the whole workout key (importToken, exNotes) server-side.
  const setWs = (patch) => { if (settings == null) return; updateSetting("workout", { ...ws, ...patch }); };

  const [templates, setTemplates] = useState(null); // null = loading
  const [sessions, setSessions] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [active, setActive] = useState(() => loadActive());
  const [view, setView] = useState(() => (loadActive() ? "session" : "train"));
  const [editingTpl, setEditingTpl] = useState(null); // template object being edited, or "new"
  const [receipt, setReceipt] = useState(null); // post-save summary sheet ("the shareable moment")

  const missingTables = (e) => /does not exist|relation|schema cache|42P01/i.test(e?.message || "");
  const refreshAll = () => {
    setLoadErr(null);
    Promise.all([wdb.loadTemplates(), wdb.loadSessions()])
      .then(([t, s]) => { setTemplates(t); setSessions(s); setSetupNeeded(false); })
      .catch((e) => { if (missingTables(e)) setSetupNeeded(true); else setLoadErr(e.message || "Couldn't load workouts."); });
  };
  useEffect(() => { refreshAll(); /* eslint-disable-next-line */ }, []);

  // checkpoint the in-progress session on every change — a dead phone battery
  // shouldn't cost you a workout
  useEffect(() => { if (active) saveActive(active); else clearActive(); }, [active]);

  // ─── history lookups: "what did I do last time" + all-time best per lift ───
  // WORKING sets only on both maps: a saved warm-up ramp must never become a
  // ghost value on a working row, and a 45-lb bar warm-up is not a "best".
  const { prevByEx, bestByEx } = useMemo(() => {
    const prev = new Map(), best = new Map();
    for (const s of sessions || []) { // already newest-first
      if (isCardio(s)) continue;
      // aggregate duplicate entries of the same lift WITHIN a session first —
      // "bench, accessories, bench again" is legal, and last-time must mean
      // ALL of last time's working sets, not just the first block
      const inSession = new Map();
      for (const ex of s.exercises || []) {
        const k = norm(ex.name);
        if (!k) continue;
        const sets = (ex.sets || []).filter((x) => x.weight != null && x.reps != null && !isWU(x));
        if (sets.length) inSession.set(k, [...(inSession.get(k) || []), ...sets]);
        for (const x of sets) {
          const e1 = epley(conv(x.weight, s.unit || "lb", "lb"), x.reps); // compare in lb; >12-rep sets estimate 0
          if (e1 > (best.get(k) || 0)) best.set(k, e1);
        }
      }
      for (const [k, sets] of inSession) if (!prev.has(k)) prev.set(k, { sets, unit: s.unit || "lb" });
    }
    return { prevByEx: prev, bestByEx: best };
  }, [sessions]);

  // build a session exercise: sets prefilled from the last time you did this
  // lift (per-set where possible), falling back to the routine's targets.
  // targetUnit: the ACTIVE SESSION's unit — mid-session additions must land
  // in the unit the session started with, not whatever prefs say now.
  const buildSessionExercise = (name, tpl = {}, targetUnit = unit) => {
    const hist = prevByEx.get(norm(name)); // working sets only — warmups never ghost
    const count = Math.max(1, tpl.targetSets || hist?.sets.length || 3);
    const sets = [];
    for (let i = 0; i < count; i++) {
      const h = hist ? hist.sets[Math.min(i, hist.sets.length - 1)] : null;
      const w = h ? conv(h.weight, hist.unit, targetUnit) : conv(tpl.weight ?? 0, tpl.unit || targetUnit, targetUnit);
      sets.push({
        id: uuid(),
        weight: Math.round((w || 0) * 10) / 10,
        reps: h?.reps ?? tpl.targetReps ?? 8,
        done: false,
        prev: h ? `${fmtW(conv(h.weight, hist.unit, targetUnit))}×${h.reps}` : null,
      });
    }
    return { id: uuid(), name, restSec: tpl.restSec ?? defaultRest, targetReps: tpl.targetReps ?? null, sets };
  };

  const startWorkout = async (tpl) => {
    if (active) {
      const ok = await confirm({
        title: "Workout in progress",
        message: "A workout is already in progress. Discard it and start fresh?",
        confirmLabel: "Discard & start", cancelLabel: "Resume it", destructive: true,
      });
      if (!ok) { setView("session"); return; } // declining resumes instead of discarding
    }
    setActive({
      id: uuid(),
      templateId: tpl?.id || null,
      templateName: tpl?.name || "Quick session",
      unit,
      bar, // snapshot: plate math + ramp must not mix a switched-prefs bar with this session's unit
      startedAt: Date.now(),
      rest: null,
      exercises: (tpl?.exercises || []).map((e) => buildSessionExercise(e.name, { ...e, unit: tpl.unit || "lb" })),
    });
    setView("session");
  };

  const discardWorkout = () => { setActive(null); setView("train"); };

  const finishWorkout = async ({ notes, updateTemplate }) => {
    const a = active;
    const done = [];
    const prSets = [];
    let volume = 0, setCount = 0, prCount = 0;
    for (const ex of a.exercises) {
      const sets = ex.sets.filter((s) => s.done).map((s) => ({ weight: s.weight, reps: s.reps, ...(s.kind && s.kind !== "working" ? { kind: s.kind } : {}), ...(s.pr ? { pr: true } : {}) }));
      if (!sets.length) continue;
      done.push({ name: ex.name, sets });
      // warm-ups are saved (they're what happened) but never counted
      for (const s of sets) {
        if (isWU(s)) continue;
        volume += (s.weight || 0) * (s.reps || 0); setCount++;
        if (s.pr) { prCount++; prSets.push({ name: ex.name, weight: s.weight, reps: s.reps }); }
      }
    }
    const durationSec = Math.max(1, Math.round((Date.now() - a.startedAt) / 1000));
    const row = {
      id: a.id, template_id: a.templateId, template_name: a.templateName, unit: a.unit,
      started_at: new Date(a.startedAt).toISOString(), ended_at: new Date().toISOString(),
      duration_sec: durationSec, notes: notes || "", exercises: done,
      total_volume: Math.round(volume), total_sets: setCount, pr_count: prCount,
    };
    await wdb.saveSession(row);
    // Past this point the session IS saved — a routine write-back hiccup
    // must not fail the finish (retrying Save would hit the same id).
    try {
    if (updateTemplate && a.templateId) {
      const src = (templates || []).find((t) => t.id === a.templateId);
      if (src) {
        // write-back reads WORKING sets only — a warm-up ramp must never
        // inflate the routine's set count or reset its weight to the bar;
        // an exercise left with ONLY warm-ups defines nothing and is skipped
        const exercises = a.exercises
          .filter((ex) => ex.sets.some((s) => !isWU(s)))
          .map((ex) => {
            const working = ex.sets.filter((s) => !isWU(s));
            const dsets = working.filter((s) => s.done);
            const ref = dsets.length ? dsets : working;
            const last = ref[ref.length - 1];
            return { id: uuid(), name: ex.name, targetSets: ref.length, targetReps: last.reps, weight: last.weight, restSec: ex.restSec };
          });
        await wdb.saveTemplate({ ...src, unit: a.unit, exercises });
      }
    }
    } catch { /* routine update failed — the workout itself is safe */ }
    setActive(null);
    setView("train");
    // streak read before/after THIS session so the receipt can say whether
    // it kept the week alive — computed, never guessed
    const goal = Number(ws.goal) > 0 ? Math.round(Number(ws.goal)) : 3;
    // sessions === null means history never loaded — a streak computed from
    // an empty list would be a confident lie, so the receipt omits it
    const canStreak = sessions != null;
    const streakBefore = canStreak ? consistency(sessions, { goalPerWeek: goal }).streakWeeks : null;
    const after = canStreak ? consistency([{ started_at: row.started_at }, ...sessions], { goalPerWeek: goal }) : null;
    setReceipt({
      volume, setCount, prCount, prSets, durationSec, unit: a.unit,
      streak: after?.streakWeeks ?? null, streakUp: after != null && after.streakWeeks > streakBefore,
      weekCount: after?.thisWeekCount ?? null, goal,
    });
    refreshAll();
  };

  // ─── render ─────────────────────────────────────────────────────────────
  if (setupNeeded) return <SetupCard onRetry={refreshAll} />;

  if (view === "session" && active) {
    return (
      <>
        <ActiveSession
          isMobile={isMobile} active={active} setActive={setActive}
          bar={bar} bestByEx={bestByEx} prevByEx={prevByEx} defaultRest={defaultRest}
          buildSessionExercise={buildSessionExercise}
          vibrate={ws.vibrate !== false}
          exNotes={ws.exNotes || {}}
          historyFor={(name) => {
            const rows = [];
            for (const s of sessions || []) {
              if (isCardio(s)) continue;
              const sets = [];
              for (const ex of s.exercises || []) if (norm(ex.name) === norm(name)) sets.push(...(ex.sets || []).filter((x) => !isWU(x)));
              if (sets.length) rows.push({ date: s.started_at, unit: s.unit || "lb", sets });
              if (rows.length >= 3) break;
            }
            return rows;
          }}
          onSaveNote={(name, text) => {
            const next = { ...(ws.exNotes || {}) };
            if (text.trim()) next[norm(name)] = text.trim(); else delete next[norm(name)];
            setWs({ exNotes: next });
          }}
          onBack={() => setView("train")} onFinish={finishWorkout} onDiscard={discardWorkout}
        />
        {confirmEl}
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <Segmented
        options={[{ key: "train", label: "Train" }, { key: "routines", label: "Routines" }, { key: "progress", label: "Progress" }, { key: "history", label: "History" }]}
        value={view} onChange={setView}
        style={isMobile ? undefined : { maxWidth: 480 }}
      />
      {loadErr && (
        <Card pad="md">
          <EmptyState icon={<IcDumbbell size={26} />} title="Couldn't load your training" sub={loadErr}
            action={<Button kind="tinted" size="md" onClick={refreshAll}>Retry</Button>} />
        </Card>
      )}
      {view === "train" && (
        <TrainHome
          isMobile={isMobile} templates={templates} sessions={sessions}
          active={active} unit={unit}
          onResume={() => setView("session")} onStart={startWorkout}
          onQuickStart={() => startWorkout(null)}
          onManage={() => setView("routines")} onHistory={() => setView("history")}
          ws={{ ...ws, unit, bar, defaultRest }} setWs={setWs}
        />
      )}
      {view === "progress" && (
        <ProgressView isMobile={isMobile} sessions={sessions} unit={unit} goal={Number(ws.goal) > 0 ? Number(ws.goal) : 3} wdb={wdb} />
      )}
      {view === "routines" && (
        editingTpl ? (
          <RoutineEditor
            isMobile={isMobile} unit={unit} defaultRest={defaultRest}
            initial={editingTpl === "new" ? null : editingTpl}
            nextPosition={(templates || []).length}
            onSave={async (tpl) => { await wdb.saveTemplate(tpl); setEditingTpl(null); refreshAll(); }}
            onDelete={async (id) => { await wdb.deleteTemplate(id); setEditingTpl(null); refreshAll(); }}
            onCancel={() => setEditingTpl(null)}
          />
        ) : (
          <RoutineList templates={templates} onNew={() => setEditingTpl("new")} onEdit={setEditingTpl} onStart={startWorkout} />
        )
      )}
      {view === "history" && (
        <HistoryView isMobile={isMobile} sessions={sessions} unit={unit}
          onDelete={async (id) => { await wdb.deleteSession(id); refreshAll(); }} />
      )}
      {/* The receipt — the earned moment after saving. Dismiss and move on. */}
      {receipt && <ReceiptSheet r={receipt} onClose={() => setReceipt(null)} />}
      {confirmEl}
    </div>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────────
// Numeric input that doesn't fight the keyboard: while focused it holds raw
// text (so "187." on the way to 187.5 survives); numbers commit as you type,
// and the display re-syncs from the real value on blur / external change.
function useNumText(value, onChange, { decimals = false, min = 0 } = {}) {
  const [txt, setTxt] = useState(value === 0 || value ? String(value) : "");
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setTxt(value === 0 || value ? String(value) : ""); }, [value, focused]);
  const clamp = (n) => Math.max(min, Math.round(n * 10) / 10);
  return {
    value: txt,
    inputMode: decimals ? "decimal" : "numeric",
    onFocus: () => setFocused(true),
    onBlur: () => { setFocused(false); setTxt(value === 0 || value ? String(value) : ""); },
    onChange: (e) => {
      const v = e.target.value.replace(decimals ? /[^0-9.]/g : /[^0-9]/g, "");
      setTxt(v);
      const n = Number(v);
      if (v !== "" && !Number.isNaN(n)) onChange(clamp(n)); else if (v === "") onChange(0);
    },
  };
}

function NumField({ value, onChange, width = 64, decimals = false, style }) {
  const bind = useNumText(value, onChange, { decimals });
  return <input {...bind} className="field t-num" style={{ width, height: 44, minHeight: 44, padding: "0 6px", textAlign: "center", fontSize: 15, ...style }} />;
}

// The gym stepper: 44×44 − / + targets, editable mono value between them.
function Stepper({ value, onChange, step, min = 0, decimals = false, style }) {
  const clamp = (n) => Math.max(min, Math.round(n * 10) / 10);
  const bind = useNumText(value, onChange, { decimals, min });
  const btn = {
    width: 44, height: 44, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
    background: "transparent", border: "none", color: "var(--ink)", fontFamily: "var(--font-mono)",
    fontSize: 21, fontWeight: 500, lineHeight: 1, padding: 0, cursor: "pointer",
  };
  return (
    <div style={{ display: "flex", alignItems: "stretch", background: "var(--surface-2)", borderRadius: 12, overflow: "hidden", ...style }}>
      <button type="button" onClick={() => onChange(clamp((value || 0) - step))} style={btn} aria-label="decrease">−</button>
      <input {...bind} style={{
        flex: 1, minWidth: 0, width: "100%", height: 44, padding: 0, textAlign: "center",
        background: "transparent", border: "none", borderLeft: "0.5px solid var(--line)", borderRight: "0.5px solid var(--line)",
        borderRadius: 0, color: "var(--ink)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", fontWeight: 600, fontSize: 16,
      }} />
      <button type="button" onClick={() => onChange(clamp((value || 0) + step))} style={btn} aria-label="increase">+</button>
    </div>
  );
}

// ─── setup card — shown once, before the tables exist ────────────────────────
function SetupCard({ onRetry }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(WORKOUT_SETUP_SQL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); };
  return (
    <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="t-head">One-time setup</span>
      <span className="t-foot" style={{ lineHeight: 1.6 }}>
        The two workout tables aren't in Supabase yet. Paste this into the Supabase <b>SQL Editor</b> and run it once — then come back and hit retry. RLS is included, same pattern as every other Board Room table.
      </span>
      <pre className="t-num" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", fontSize: 11, lineHeight: 1.55, color: "var(--sub)", overflowX: "auto", whiteSpace: "pre", margin: 0 }}>
        {WORKOUT_SETUP_SQL}
      </pre>
      <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
        <Button kind="primary" size="md" onClick={copy}>{copied ? <><IcCheck size={15} /> Copied</> : "Copy SQL"}</Button>
        <Button kind="quiet" size="md" onClick={onRetry}>I've run it — retry</Button>
      </div>
    </Card>
  );
}

// ─── Train home — resume, this week, start, recent, recovery, preferences ────
function TrainHome({ isMobile, templates, sessions, active, unit, onResume, onStart, onQuickStart, onManage, onHistory, ws, setWs }) {
  const doneSets = active ? active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done && !isWU(s)).length, 0) : 0;
  const mins = active ? Math.max(1, Math.round((Date.now() - active.startedAt) / 60000)) : 0;
  const recent = (sessions || []).slice(0, 3);
  const goal = Number(ws.goal) > 0 ? Math.round(Number(ws.goal)) : 3;
  const cons = useMemo(() => consistency(sessions || [], { goalPerWeek: goal, weeks: 20 }), [sessions, goal]);
  const recap = useMemo(() => weeklyRecap(sessions || [], { unit }), [sessions, unit]);
  const fresh = useMemo(() => {
    const rows = groupFreshness(sessions || []);
    const trained = rows.filter((r) => r.lastAt != null).sort((a, b) => a.pct - b.pct);
    return trained.length ? trained : null; // no history → no fake recovery talk
  }, [sessions]);
  const [watchOpen, setWatchOpen] = useState(false);
  const watchCount = useMemo(() => (sessions || []).filter((s) => isCardio(s) && cardioMeta(s)?.source === "watch").length, [sessions]);
  // the coach line: which routine does today want? (ranked by days-since +
  // muscle-group freshness — transparent score, facts in the reason)
  const pick = useMemo(() => {
    if (!templates?.length || sessions == null) return null;
    const ranked = upNext(templates, sessions);
    // never pitch a routine that already ran today — done is done
    return ranked[0]?.daysAgo === 0 ? null : ranked[0] ?? null;
  }, [templates, sessions]);

  return (
    <>
      {active && (
        <Card pad="md" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Dot tone="var(--accent)" pulse size={6} />
              <span className="t-cap" style={{ color: "var(--accent)", fontWeight: 600 }}>In progress</span>
            </span>
            <div className="t-head" style={{ marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{active.templateName}</div>
            <div className="t-foot" style={{ marginTop: 1 }}>{mins}m in · {doneSets} set{doneSets === 1 ? "" : "s"} logged</div>
          </div>
          <Button kind="primary" size="md" onClick={onResume} style={{ flex: "none" }}>Resume</Button>
        </Card>
      )}

      {/* This week — the scoreboard that gets you back in the door */}
      <Card pad="md">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <span className="t-head">This week</span>
          <span className="t-cap" style={{ color: cons.streakWeeks > 0 ? "var(--accent)" : "var(--faint)", fontWeight: 600 }}>
            {cons.streakWeeks > 0 ? `${cons.streakWeeks}-week streak` : "streak starts at " + goal + "/wk"}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 10 }}>
          <StatTile value={`${cons.thisWeekCount}/${goal}`} label="Workouts" valueTone={cons.thisWeekCount >= goal ? "var(--green)" : undefined} />
          <StatTile value={fmtVol(recap?.thisWeek.volume || 0)} label={`Volume (${unit})`} />
          <StatTile value={recap?.thisWeek.sets || 0} label="Sets" />
          <StatTile value={recap?.thisWeek.cardioMin ? fmtDur(recap.thisWeek.cardioMin * 60) : "—"} label="Cardio" valueTone={recap?.thisWeek.cardioMin ? undefined : "var(--faint)"} />
        </div>
        <ConsistencyHeatmap days={cons.days} />
        <div className="t-cap" style={{ color: "var(--faint)", marginTop: 6 }}>
          Last 20 weeks · streak counts weeks with ≥{goal} sessions — this week can join it, never break it.
        </div>
      </Card>

      <Grid min={340} gap={12}>
        <section style={{ minWidth: 0 }}>
          <SectionHeader title="Start training" />
          {templates === null ? (
            <div className="sk" style={{ height: 140, borderRadius: 18 }} />
          ) : templates.length === 0 ? (
            <Card pad="md">
              <EmptyState icon={<IcDumbbell size={26} />} title="No routines yet"
                sub="Build one once — every session after is two taps."
                action={<Button kind={active ? "tinted" : "primary"} size="md" onClick={onManage}>Build your first routine</Button>} />
            </Card>
          ) : (
            <>
            {pick && (
              <Card pad="md" style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <span className="t-label" style={{ color: "var(--accent)" }}>Up next</span>
                  <div className="t-head" style={{ marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pick.template.name}</div>
                  <div className="t-foot" style={{ marginTop: 1, color: "var(--sub)" }}>{pick.reason}</div>
                </div>
                <Button kind="primary" size="md" onClick={() => onStart(pick.template)} style={{ flex: "none" }}>Start</Button>
              </Card>
            )}
            <CellGroup>
              {templates.map((t) => {
                const sets = (t.exercises || []).reduce((n, e) => n + (e.targetSets || 0), 0);
                return (
                  <Cell key={t.id} title={t.name}
                    sub={`${(t.exercises || []).length} exercise${(t.exercises || []).length === 1 ? "" : "s"} · ${sets} sets`}
                    trailing={<Button kind="tinted" size="md" onClick={() => onStart(t)} style={{ flex: "none" }}>Start</Button>} />
                );
              })}
              <Cell title="Quick start" sub="Empty workout — add exercises as you go" onClick={onQuickStart}
                trailing={<span className="cell-chevron" style={{ display: "inline-flex" }}><IcPlus size={16} /></span>} />
              <Cell title="Manage routines" chevron onClick={onManage} />
            </CellGroup>
            </>
          )}
        </section>

        {recent.length > 0 && (
          <section style={{ minWidth: 0 }}>
            <SectionHeader title="Recent" />
            <CellGroup>
              {recent.map((s) => (
                <Cell key={s.id} title={s.template_name || "Quick session"}
                  sub={
                    <span className="t-num" style={{ fontSize: 11.5 }}>
                      {fmtDate(s.started_at)} · {isCardio(s)
                        ? <>{s.duration_sec ? fmtDur(s.duration_sec) : "cardio"}{cardioMeta(s)?.source === "watch" ? " · watch" : ""}</>
                        : <>{fmtVol(s.total_volume || 0)} {s.unit}</>}
                      {s.pr_count ? <span style={{ color: "var(--accent)", fontWeight: 600 }}> · ◆{s.pr_count}</span> : null}
                    </span>
                  } />
              ))}
              <Cell title="All history" chevron onClick={onHistory} />
            </CellGroup>
          </section>
        )}

        {fresh && (
          <section style={{ minWidth: 0 }}>
            <SectionHeader title="Recovery clock" />
            <Card pad="md">
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {fresh.map((f) => (
                  <div key={f.group} style={{ display: "grid", gridTemplateColumns: "92px 1fr 58px", gap: 10, alignItems: "center" }}>
                    <span className="t-call" style={{ fontWeight: 600 }}>{f.group}</span>
                    <div style={{ height: 5, borderRadius: 99, background: "var(--ink-a06)", overflow: "hidden" }}>
                      <div style={{ width: `${f.pct}%`, height: "100%", borderRadius: 99, background: f.state === "fresh" ? "var(--green)" : f.state === "recovering" ? "var(--blue)" : "var(--amber)" }} />
                    </div>
                    <span className="t-cap" style={{ color: "var(--faint)", textAlign: "right" }}>
                      {f.state === "fresh" ? "fresh" : f.hoursAgo < 48 ? `${f.hoursAgo}h ago` : `${Math.round(f.hoursAgo / 24)}d ago`}
                    </span>
                  </div>
                ))}
              </div>
              <div className="t-cap" style={{ color: "var(--faint)", marginTop: 10 }}>
                A rule-of-thumb clock (big movers ~72h, small ~48h) — not a measurement of anything.
              </div>
            </Card>
          </section>
        )}

        <section style={{ minWidth: 0 }}>
          <SectionHeader title="Preferences" />
          <CellGroup>
            <Cell title="Units" sub="Switching resets the bar weight"
              trailing={
                <Segmented style={{ width: 128, flex: "none" }}
                  options={[{ key: "lb", label: "lb" }, { key: "kg", label: "kg" }]}
                  value={unit}
                  onChange={(u) => setWs({ unit: u, bar: u === "kg" ? 20 : 45 })} />
              } />
            <Cell title="Bar weight" sub="Feeds the per-side plate math"
              trailing={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
                  <NumField value={ws.bar} decimals width={76} onChange={(v) => setWs({ bar: v })} />
                  <span className="t-cap" style={{ color: "var(--faint)", minWidth: 18 }}>{unit}</span>
                </span>
              } />
            <Cell title="Default rest" sub="Tune it per exercise during a session"
              trailing={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
                  <NumField value={ws.defaultRest} width={76} onChange={(v) => setWs({ rest: v })} />
                  <span className="t-cap" style={{ color: "var(--faint)", minWidth: 18 }}>sec</span>
                </span>
              } />
            <Cell title="Weekly goal" sub="Drives the streak and the heatmap bar"
              trailing={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
                  <NumField value={goal} width={64} onChange={(v) => setWs({ goal: Math.max(1, Math.min(14, Math.round(v || 0))) })} />
                  <span className="t-cap" style={{ color: "var(--faint)", minWidth: 30 }}>/ wk</span>
                </span>
              } />
            <SwitchRow title="Vibrate" sub="On set log and when rest hits zero (phones that support it)"
              on={ws.vibrate !== false} onToggle={() => setWs({ vibrate: ws.vibrate === false })} />
          </CellGroup>
        </section>

        <section style={{ minWidth: 0 }}>
          <SectionHeader title="Apple Watch" />
          <CellGroup>
            <Cell title="Auto-import workouts" chevron onClick={() => setWatchOpen(true)}
              sub={watchCount > 0 ? `${watchCount} imported so far — runs, rides, rows land in History` : "Not receiving yet — one-time Shortcuts setup"}
              trailing={watchCount > 0 ? <Dot tone="var(--green)" size={7} /> : undefined} />
          </CellGroup>
        </section>
      </Grid>
      {watchOpen && <WatchSheet ws={ws} setWs={setWs} watchCount={watchCount} onClose={() => setWatchOpen(false)} />}
    </>
  );
}

// GitHub-style consistency grid — columns are Monday-weeks, tone is the
// data blue (gold stays reserved). Zero-days are faint ink; future days
// nearly invisible. Pure SVG, horizontally scrollable on narrow phones.
function ConsistencyHeatmap({ days }) {
  if (!days?.length) return null;
  const weeks = Math.floor(days.length / 7);
  const cell = 11, gap = 3;
  const w = weeks * (cell + gap) + 2;
  const h = 7 * (cell + gap) + 14;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const labels = [];
  for (let wk = 0; wk < weeks; wk++) {
    const first = days[wk * 7].date;
    const prev = wk > 0 ? days[(wk - 1) * 7].date : null;
    if (!prev || first.slice(5, 7) !== prev.slice(5, 7)) labels.push({ x: wk * (cell + gap), label: MONTHS[+first.slice(5, 7) - 1] });
  }
  const fill = (d) => d.future ? "transparent" : d.count === 0 ? "var(--ink-a06)" : d.count === 1 ? "color-mix(in srgb, var(--blue) 55%, transparent)" : "var(--blue)";
  return (
    // Scrolled to the newest weeks ONCE on mount — the old inline ref callback
    // re-ran on every parent re-render (each preference keystroke) and yanked
    // the strip back while the user was looking at older weeks.
    <div ref={(el) => { if (el && !el.dataset.scrolled) { el.dataset.scrolled = "1"; el.scrollLeft = el.scrollWidth; } }} style={{ overflowX: "auto", marginTop: 12 }}>
      <svg width={w} height={h} style={{ display: "block" }} role="img" aria-label={`Training heatmap, last ${weeks} weeks`}>
        {labels.map((m, i) => <text key={i} x={m.x} y={9} fill="var(--faint)" fontSize="10.5">{m.label}</text>)}
        {days.map((d, i) => {
          const wk = Math.floor(i / 7), day = i % 7;
          return <rect key={d.date} x={wk * (cell + gap)} y={14 + day * (cell + gap)} width={cell} height={cell} rx="2.5" fill={fill(d)}>
            <title>{`${d.date}: ${d.count} workout${d.count === 1 ? "" : "s"}`}</title>
          </rect>;
        })}
      </svg>
    </div>
  );
}

// ─── Active session — the room where it happens ──────────────────────────────
function ActiveSession({ isMobile, active, setActive, bar, bestByEx, prevByEx, defaultRest, buildSessionExercise, vibrate, exNotes, onSaveNote, historyFor, onBack, onFinish, onDiscard }) {
  const [now, setNow] = useState(Date.now());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [confirmEl, confirm] = useConfirm();
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);

  // Side-by-side (exercises | summary/timer) only when the left column can
  // still hold full-width 44pt stepper rows — below that, one honest column.
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1020px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1020px)");
    const fn = (e) => setWide(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  const twoCol = !isMobile && wide;

  const upd = (fn) => setActive((a) => ({ ...a, ...fn(a) }));
  const updEx = (exId, fn) => upd((a) => ({ exercises: a.exercises.map((e) => (e.id === exId ? { ...e, ...fn(e) } : e)) }));

  // the session's own bar (snapshotted at start) — a mid-session prefs unit
  // flip resets the prefs bar to 20/45 in the NEW unit, which must not feed
  // plate math or the ramp for weights recorded in this session's unit
  const sessionBar = Number(active.bar) > 0 ? Number(active.bar) : bar;

  // ── supersets: PAIRS, not chains. ex.link means "pair with whatever sits
  // directly below". Pairs resolve left-to-right, first link in a run wins,
  // so reorders/removals can never create chains or asymmetric partners —
  // the chips always show the pair that's actually in effect.
  const exRefs = useRef({});
  const pairMap = useMemo(() => {
    const m = new Map();
    const arr = active.exercises;
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i]?.link && !m.has(arr[i].id)) {
        m.set(arr[i].id, arr[i + 1].id);
        m.set(arr[i + 1].id, arr[i].id);
        i++; // the paired exercise's own stale link (if any) is inert
      }
    }
    return m;
  }, [active.exercises]);
  const partnerOf = (exId) => {
    const pid = pairMap.get(exId);
    return pid ? active.exercises.find((e) => e.id === pid) ?? null : null;
  };
  const toggleLink = (i) => upd((a) => ({
    exercises: a.exercises.map((e, idx) => (idx === i ? { ...e, link: !e.link } : e)),
  }));

  const elapsed = Math.floor((now - active.startedAt) / 1000);
  const doneSets = active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done && !isWU(s)).length, 0);
  const volume = active.exercises.reduce((v, e) => v + e.sets.reduce((x, s) => x + (s.done && !isWU(s) ? (s.weight || 0) * (s.reps || 0) : 0), 0), 0);

  // keep the screen awake mid-session — a dark phone between sets is a
  // re-auth ritual; best-effort, silently absent where unsupported
  useEffect(() => {
    let lock = null;
    const acquire = async () => { try { lock = await navigator.wakeLock?.request("screen"); } catch { /* denied — fine */ } };
    acquire();
    const onVis = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); try { lock?.release(); } catch { /* released */ } };
  }, []);

  // one tap logs the set — and PR detection happens right here, live.
  // Warm-up sets log and start the timer, but can never flag a PR.
  const toggleSet = (ex, set) => {
    if (set.done) { // undo a mis-tap, keep the numbers
      updEx(ex.id, (e) => ({ sets: e.sets.map((s) => (s.id === set.id ? { ...s, done: false, pr: false } : s)) }));
      return;
    }
    const inLb = (w) => conv(w, active.unit, "lb");
    const hasHistory = bestByEx.has(norm(ex.name)); // first-ever session of a lift is a baseline, not a PR
    let best = bestByEx.get(norm(ex.name)) || 0;
    for (const e of active.exercises) if (norm(e.name) === norm(ex.name))
      for (const s of e.sets) if (s.done && !isWU(s) && s.id !== set.id) best = Math.max(best, epley(inLb(s.weight), s.reps));
    const pr = !isWU(set) && hasHistory && set.weight > 0 && epley(inLb(set.weight), set.reps) > best;
    buzz(vibrate, pr ? [30, 40, 60] : 15);
    updEx(ex.id, (e) => ({ sets: e.sets.map((s) => (s.id === set.id ? { ...s, done: true, pr } : s)) }));
    // superset flow — rest per ROUND, not per set: A1 → glide to B, no rest;
    // B1 closes the round → rest fires (and we glide back for A2). Only
    // undone WORKING sets count — a skipped warm-up row on the partner must
    // never starve the rest timer forever.
    const partner = !isWU(set) ? partnerOf(ex.id) : null;
    if (partner) {
      const myDone = ex.sets.filter((s) => s.done && !isWU(s) && s.id !== set.id).length + 1;
      const theirDone = partner.sets.filter((s) => s.done && !isWU(s)).length;
      const theirUndone = partner.sets.some((s) => !s.done && !isWU(s));
      if (theirUndone) requestAnimationFrame(() => exRefs.current[partner.id]?.scrollIntoView({ behavior: "smooth", block: "start" }));
      if (theirUndone && theirDone < myDone) return; // mid-round: hold the rest
    }
    if (ex.restSec > 0) upd(() => ({ rest: { until: Date.now() + ex.restSec * 1000, total: ex.restSec, label: ex.name } }));
  };

  const addSet = (ex) => updEx(ex.id, (e) => {
    const last = e.sets[e.sets.length - 1];
    return { sets: [...e.sets, { id: uuid(), weight: last?.weight ?? 0, reps: last?.reps ?? 8, done: false, prev: null }] };
  });
  const removeSet = async (ex, setId) => {
    // destructive and near high-frequency controls — a sheet confirm beats trusting sweaty aim
    if (!(await confirm({ title: "Remove set?", confirmLabel: "Remove", destructive: true }))) return;
    updEx(ex.id, (e) => ({ sets: e.sets.filter((s) => s.id !== setId) }));
  };
  const cycleRest = (ex) => updEx(ex.id, (e) => ({ restSec: REST_CYCLE[(REST_CYCLE.indexOf(e.restSec) + 1) % REST_CYCLE.length] ?? defaultRest }));
  const moveEx = (exId, dir) => upd((a) => {
    const i = a.exercises.findIndex((e) => e.id === exId), j = i + dir;
    if (j < 0 || j >= a.exercises.length) return {};
    const arr = [...a.exercises]; [arr[i], arr[j]] = [arr[j], arr[i]];
    return { exercises: arr };
  });
  const removeEx = async (exId) => {
    const name = active.exercises.find((e) => e.id === exId)?.name || "this exercise";
    if (!(await confirm({ title: "Remove exercise?", message: `${name} comes off today's session. History is untouched.`, confirmLabel: "Remove", destructive: true }))) return;
    upd((a) => ({ exercises: a.exercises.filter((e) => e.id !== exId) }));
  };
  // mid-session additions land in the SESSION's unit — prefs may have moved
  const addExercise = (name) => { upd((a) => ({ exercises: [...a.exercises, buildSessionExercise(name, {}, a.unit)] })); setPickerOpen(false); };

  const restRemain = active.rest ? Math.ceil((active.rest.until - now) / 1000) : null;
  const resting = restRemain != null && restRemain > -5; // linger 5s in "GO" state

  // one buzz the moment rest hits zero — the phone is face-up on the bench.
  // The > -5 window means a checkpoint resumed hours later mounts silently
  // instead of buzzing for a rest that ended before the app was even open.
  const restDoneRef = useRef(null);
  useEffect(() => {
    if (restRemain == null) { restDoneRef.current = null; return; }
    if (restRemain <= 0 && restRemain > -5 && restDoneRef.current !== active.rest?.until) {
      restDoneRef.current = active.rest?.until ?? null;
      buzz(vibrate, [80, 60, 80]);
    }
  }, [restRemain, active.rest?.until, vibrate]);
  const prCount = active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done && s.pr).length, 0);

  const doFinish = async (opts) => {
    setSaving(true); setSaveErr(null);
    try { await onFinish(opts); }
    catch (e) { setSaving(false); setSaveErr(e.message || "Couldn't save — check your connection."); }
  };

  const liveLabel = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Dot tone="var(--accent)" pulse size={6} />
      <span className="t-cap" style={{ color: "var(--accent)", fontWeight: 600 }}>In session</span>
    </span>
  );
  const metaLine = (
    <span>
      {doneSets} set{doneSets === 1 ? "" : "s"} · {fmtVol(volume)} {active.unit} volume
      {prCount ? <span className="t-num" style={{ color: "var(--accent)", fontWeight: 600, fontSize: 12 }}> · ◆ {prCount} PR{prCount > 1 ? "s" : ""}</span> : null}
    </span>
  );

  const exerciseColumn = (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      {active.exercises.length === 0 && (
        <Card pad="md">
          <EmptyState icon={<IcDumbbell size={26} />} title="Empty session" sub="Add an exercise below to start logging." />
        </Card>
      )}
      {active.exercises.map((ex, i) => {
        const hist = prevByEx.get(norm(ex.name));
        const suggestion = hist ? suggestNext(
          hist.sets.map((s) => ({ weight: conv(s.weight, hist.unit, active.unit), reps: s.reps })),
          { targetReps: ex.targetReps || 8, increment: active.unit === "kg" ? 2.5 : 5 },
        ) : null;
        const firstWork = ex.sets.find((s) => !isWU(s) && s.weight > 0);
        const canRamp = !ex.sets.some(isWU) && !!firstWork && firstWork.weight > sessionBar;
        const linked = pairMap.has(ex.id);
        // pairs only: offer a link when neither this card nor the next is
        // already in an effective pair
        const canLink = i < active.exercises.length - 1
          && !pairMap.has(ex.id)
          && !pairMap.has(active.exercises[i + 1].id);
        // the tinted state reflects the pair actually in effect, not a stale flag
        const linkOn = !!ex.link && pairMap.get(ex.id) === active.exercises[i + 1]?.id;
        return (
          <div key={ex.id} ref={(el) => { exRefs.current[ex.id] = el; }} style={{ scrollMarginTop: 8 }}>
          <ExerciseCard isMobile={isMobile} ex={ex} index={i} count={active.exercises.length}
            unit={active.unit} bar={sessionBar}
            linked={linked} canLink={canLink} linkOn={linkOn} onToggleLink={() => toggleLink(i)}
            history={historyFor ? historyFor(ex.name) : []}
            suggestion={suggestion}
            note={exNotes[norm(ex.name)] || ""}
            onSaveNote={(text) => onSaveNote(ex.name, text)}
            canRamp={canRamp}
            onAddRamp={() => {
              const ramp = warmupRamp(firstWork.weight, { barWeight: sessionBar, step: active.unit === "kg" ? 2.5 : 5 });
              if (!ramp.length) return;
              updEx(ex.id, (e) => ({
                sets: [...ramp.map((r) => ({ id: uuid(), weight: r.weight, reps: r.reps, done: false, prev: null, kind: "warmup" })), ...e.sets],
              }));
            }}
            onCycleKind={(setId) => updEx(ex.id, (e) => ({
              sets: e.sets.map((s) => (s.id === setId ? { ...s, kind: KIND_NEXT[s.kind || "working"], pr: false } : s)),
            }))}
            onToggleSet={(s) => toggleSet(ex, s)}
            // editing a LOGGED set's numbers voids its PR flag — a mis-tapped
            // 500 corrected to 50 must not keep wearing the diamond
            onSetChange={(setId, patch) => updEx(ex.id, (e) => ({
              sets: e.sets.map((s) => (s.id === setId
                ? { ...s, ...patch, ...(s.done && ("weight" in patch || "reps" in patch) ? { pr: false } : {}) }
                : s)),
            }))}
            onAddSet={() => addSet(ex)} onRemoveSet={(setId) => removeSet(ex, setId)}
            onCycleRest={() => cycleRest(ex)} onMove={(d) => moveEx(ex.id, d)} onRemove={() => removeEx(ex.id)}
          />
          </div>
        );
      })}
      <Button kind="quiet" size="md" full onClick={() => setPickerOpen(true)}><IcPlus size={16} /> Add exercise</Button>
    </div>
  );

  // The rest meridian — starts itself, one tap to skip or extend
  const restBar = resting ? (
    <RestBar rest={active.rest} restRemain={restRemain} mobile={!twoCol}
      onExtend={() => upd((a) => ({ rest: { ...a.rest, until: a.rest.until + 30000, total: a.rest.total + 30 } }))}
      onClear={() => upd(() => ({ rest: null }))} />
  ) : null;

  const sheets = (
    <>
      {pickerOpen && <ExercisePicker onPick={addExercise} onClose={() => setPickerOpen(false)} />}
      {finishOpen && (
        <FinishSheet active={active} doneSets={doneSets} volume={volume} prCount={prCount} elapsed={elapsed}
          saving={saving} saveErr={saveErr}
          onSave={doFinish} onClose={() => setFinishOpen(false)}
          onDiscard={async () => {
            if (await confirm({ title: "Discard workout?", message: "Nothing will be saved.", confirmLabel: "Discard", destructive: true })) {
              setFinishOpen(false); onDiscard();
            }
          }}
        />
      )}
      {confirmEl}
    </>
  );

  if (!twoCol) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Card pad="md">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, margin: "-4px 0 6px -10px" }}>
            <Button kind="plain" size="md" onClick={onBack} style={{ paddingLeft: 10, paddingRight: 12 }}>
              <IcChevronLeft size={15} /> Overview
            </Button>
            <Button kind="primary" size="md" onClick={() => setFinishOpen(true)}>Finish</Button>
          </div>
          {liveLabel}
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginTop: 2 }}>
            <span className="t-title2" style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{active.templateName}</span>
            <span className="t-num" style={{ fontSize: 22, fontWeight: 600, flex: "none" }}>{fmtClock(elapsed)}</span>
          </div>
          <div className="t-foot" style={{ marginTop: 3 }}>{metaLine}</div>
        </Card>
        {exerciseColumn}
        {restBar}
        {sheets}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 12, alignItems: "start" }}>
      {exerciseColumn}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, position: "sticky", top: 12 }}>
        <Card pad="md">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, margin: "-6px -8px 0 0" }}>
            {liveLabel}
            <Button kind="plain" size="md" onClick={onBack} style={{ paddingLeft: 12, paddingRight: 12 }}>
              <IcChevronLeft size={14} /> Overview
            </Button>
          </div>
          <div className="t-title2" style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{active.templateName}</div>
          <div className="t-num" style={{ fontSize: 30, fontWeight: 600, margin: "4px 0 12px" }}>{fmtClock(elapsed)}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            <StatTile value={doneSets} label="Sets" />
            <StatTile value={fmtVol(volume)} label={`Volume (${active.unit})`} />
            <StatTile value={prCount ? `◆ ${prCount}` : "—"} label="PRs" valueTone={prCount ? "var(--accent)" : "var(--faint)"} />
          </div>
          <Button kind="primary" size="lg" full style={{ marginTop: 12 }} onClick={() => setFinishOpen(true)}>Finish</Button>
        </Card>
        {restBar}
      </div>
      {sheets}
    </div>
  );
}

// Rest countdown. Phone: a glass bar stuck to the bottom of the page scroll —
// it rides above the in-flow tab bar (which owns env(safe-area-inset-bottom)),
// so it can never reach the home indicator; when the keyboard hides the dock,
// the scroll bottom retreats above the keyboard with it. Tablet: a card in the
// sticky right column.
function RestBar({ rest, restRemain, onExtend, onClear, mobile }) {
  const going = restRemain <= 0;
  const pct = Math.max(0, Math.min(100, (restRemain / rest.total) * 100));
  const inner = (
    <>
      <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: "var(--accent-a12)", transition: "width 0.5s linear" }} />
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px 10px 14px" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Dot tone={going ? "var(--green)" : "var(--accent)"} pulse={!going} size={6} />
            <span className="t-cap" style={{ color: going ? "var(--green)" : "var(--accent)", fontWeight: 600 }}>{going ? "Go" : "Rest"}</span>
          </span>
          <div className="t-cap" style={{ color: "var(--faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{rest.label}</div>
        </div>
        <span className="t-num" style={{ fontSize: 24, fontWeight: 600, color: going ? "var(--green)" : "var(--ink)", flex: "none" }}>
          {going ? "0:00" : fmtClock(restRemain)}
        </span>
        <div style={{ display: "flex", gap: 8, flex: "none" }}>
          <Button kind="quiet" size="md" onClick={onExtend} style={{ padding: "0 12px" }}><span className="t-num" style={{ fontSize: 13 }}>+30s</span></Button>
          <Button kind="quiet" size="md" onClick={onClear} style={{ padding: "0 12px" }}>{going ? "Clear" : "Skip"}</Button>
        </div>
      </div>
    </>
  );
  if (mobile) {
    return (
      <div style={{
        position: "sticky", bottom: 10, zIndex: 5, borderRadius: 16, overflow: "hidden",
        background: "var(--glass-raised)",
        WebkitBackdropFilter: "blur(20px) saturate(1.8)", backdropFilter: "blur(20px) saturate(1.8)",
        boxShadow: "inset 0 0 0 0.5px var(--line), var(--shadow-float)",
      }}>
        {inner}
      </div>
    );
  }
  return (
    <div style={{ position: "relative", overflow: "hidden", borderRadius: "var(--r-card)", background: "var(--surface)", boxShadow: "var(--shadow-card)" }}>
      {inner}
    </div>
  );
}

function ExerciseCard({ isMobile, ex, index, count, unit, bar, suggestion, note, onSaveNote, canRamp, onAddRamp, linked, canLink, linkOn, onToggleLink, history, onCycleKind, onToggleSet, onSetChange, onAddSet, onRemoveSet, onCycleRest, onMove, onRemove }) {
  const [showPlates, setShowPlates] = useState(false);
  const [showHist, setShowHist] = useState(false);
  // Plate math uses the next undone set (or last set if all done) as its weight source
  const nextSet = ex.sets.find((s) => !s.done) || ex.sets[ex.sets.length - 1];
  const plates = nextSet ? plateBreakdown(nextSet.weight, unit, bar) : null;
  const wFlex = { flex: "1.3 1 0", minWidth: 136, maxWidth: 210 };
  const rFlex = { flex: "1 1 0", minWidth: 118, maxWidth: 180 };

  return (
    <Card pad={isMobile ? "sm" : "md"}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="t-head" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ex.name}</span>
        {linked && <span className="t-cap" style={{ color: "var(--blue)", fontWeight: 600, flex: "none" }}>⧉ superset</span>}
        <button onClick={onRemove} aria-label="remove exercise" style={{
          width: 44, height: 44, flex: "none", margin: "-8px -10px -8px 0", display: "inline-flex", alignItems: "center",
          justifyContent: "center", background: "none", border: "none", color: "var(--faint)", cursor: "pointer", padding: 0,
        }}>
          <IcClose size={17} />
        </button>
      </div>
      {/* double-progression cue — stated with its numbers, from real history only */}
      {suggestion && (
        <div className="t-cap" style={{ color: "var(--sub)", marginTop: 2 }}>→ {suggestion.reason}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 2px", flexWrap: "wrap" }}>
        <Button kind="quiet" size="md" onClick={onCycleRest} title="Tap to change rest for this exercise" style={{ padding: "0 12px", gap: 6 }}>
          <IcClock size={15} />
          <span className="t-num" style={{ fontSize: 13 }}>{ex.restSec > 0 ? `${ex.restSec}s rest` : "no rest"}</span>
        </Button>
        <Button kind={showPlates ? "tinted" : "quiet"} size="md" onClick={() => setShowPlates((v) => !v)} style={{ padding: "0 12px" }}>Plates</Button>
        {canRamp && <Button kind="quiet" size="md" onClick={onAddRamp} title="Insert bar→55→70→85% warm-up sets" style={{ padding: "0 12px" }}>Ramp</Button>}
        {(canLink || ex.link) && (
          <Button kind={linkOn ? "tinted" : "quiet"} size="md" onClick={onToggleLink}
            title={linkOn ? "Unlink superset" : "Superset with the exercise below — logging a set glides to it, rest waits for the round"}
            style={{ padding: "0 12px" }}>
            {linkOn ? "⧉ Linked" : "⧉ Link"}
          </Button>
        )}
        {history.length > 0 && (
          <Button kind={showHist ? "tinted" : "quiet"} size="md" onClick={() => setShowHist((v) => !v)} style={{ padding: "0 12px" }}>History</Button>
        )}
        <span style={{ flex: 1 }} />
        <Button kind="quiet" size="md" onClick={() => onMove(-1)} disabled={index === 0} aria-label="move up" style={{ width: 44, padding: 0 }}>
          <IcChevronDown size={15} style={{ transform: "rotate(180deg)" }} />
        </Button>
        <Button kind="quiet" size="md" onClick={() => onMove(1)} disabled={index === count - 1} aria-label="move down" style={{ width: 44, padding: 0 }}>
          <IcChevronDown size={15} />
        </Button>
      </div>

      {showPlates && plates && (
        <div className="t-num" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "9px 12px", margin: "8px 0 2px", fontSize: 12.5 }}>
          <span style={{ color: "var(--sub)" }}>{fmtW(nextSet.weight)} {unit} → </span>
          <span style={{ color: "var(--ink)", fontWeight: 600 }}>{plates.text}</span>
          <span style={{ color: "var(--faint)", fontSize: 11 }}> ({fmtW(bar)} bar)</span>
        </div>
      )}

      {/* the mid-set history drawer — all of the last three visits, one glance */}
      {showHist && history.length > 0 && (
        <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "9px 12px", margin: "8px 0 2px", display: "flex", flexDirection: "column", gap: 4 }}>
          {history.map((h, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span className="t-cap" style={{ color: "var(--faint)", flex: "none", minWidth: 78 }}>{fmtDate(h.date)}</span>
              <span className="t-num" style={{ fontSize: 12, color: "var(--sub)" }}>
                {h.sets.map((x, j) => `${j ? " · " : ""}${fmtW(conv(x.weight, h.unit, unit))}×${x.reps}${x.pr ? "◆" : ""}`).join("")}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* column captions so the two steppers never need guessing */}
      {ex.sets.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 0 4px" }}>
          <span className="t-cap" style={{ ...wFlex, textAlign: "center", color: "var(--faint)" }}>weight ({unit})</span>
          <span className="t-cap" style={{ ...rFlex, textAlign: "center", color: "var(--faint)" }}>reps</span>
          <span style={{ width: 44, flex: "none" }} />
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column" }}>
        {(() => { let workNo = 0; return ex.sets.map((set, i) => {
          const badge = KIND_BADGE[set.kind];
          const label = badge ? badge.label : String(++workNo);
          const meta = set.pr
            ? <span className="t-num" style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", whiteSpace: "nowrap" }}>◆ PR</span>
            : isWU(set)
              ? <span className="t-num" style={{ fontSize: 11, color: "var(--amber)", whiteSpace: "nowrap" }}>warm-up · no credit</span>
              : set.kind === "failure" || set.kind === "drop"
                ? <span className="t-num" style={{ fontSize: 11, color: badge.tone, whiteSpace: "nowrap" }}>{set.kind === "failure" ? "to failure" : "drop set"}</span>
                : <span className="t-num" style={{ fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{set.prev ? `last ${set.prev}` : "new"}</span>;
          const weightStepper = <Stepper value={set.weight} step={unit === "kg" ? 2.5 : 5} decimals onChange={(v) => onSetChange(set.id, { weight: v })} style={wFlex} />;
          const repsStepper = <Stepper value={set.reps} step={1} onChange={(v) => onSetChange(set.id, { reps: v })} style={rFlex} />;
          const logBtn = (
            <button onClick={() => onToggleSet(set)} aria-label={set.done ? "undo set" : "log set"} style={{
              width: 44, height: 44, flex: "none", borderRadius: 12, border: "none", cursor: "pointer",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: set.done ? "var(--green)" : "var(--ink-a06)",
              color: set.done ? "var(--surface)" : "var(--faint)",
            }}>
              <IcCheck size={20} />
            </button>
          );
          const removeBtn = (extra) => (
            <button onClick={() => onRemoveSet(set.id)} aria-label="remove set" style={{
              width: 44, height: 44, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", color: "var(--faint)", cursor: "pointer", padding: 0, ...extra,
            }}>
              <IcClose size={15} />
            </button>
          );
          const sep = i ? { marginTop: 10, paddingTop: 10, borderTop: "0.5px solid var(--line)" } : {};
          return (
            <div key={set.id} style={{ opacity: set.done ? 0.92 : 1, display: "flex", flexDirection: "column", gap: 8, ...sep }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32 }}>
                {/* tap the set marker to cycle working → warm-up → failure → drop */}
                <button onClick={() => onCycleKind(set.id)} aria-label={`set type: ${set.kind || "working"} — tap to change`}
                  title="Tap to change set type" className="t-num" style={{
                    minWidth: 34, height: 34, flex: "none", margin: "-1px 0", padding: "0 6px",
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    background: badge ? "var(--surface-2)" : "transparent", border: "none", borderRadius: 9, cursor: "pointer",
                    fontSize: badge ? 12 : 14, fontWeight: 600,
                    color: set.done && !badge ? "var(--green)" : badge ? badge.tone : "var(--sub)",
                  }}>
                  {label}
                </button>
                {meta}
                {removeBtn({ margin: "-6px -8px -6px auto" })}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {weightStepper}
                {repsStepper}
                {logBtn}
              </div>
            </div>
          );
        }); })()}
      </div>

      <Button kind="quiet" size="md" full onClick={onAddSet} style={{ marginTop: 12 }}><IcPlus size={15} /> Add set</Button>

      {/* the sticky note — persists per lift, shows up every session ("seat 4, cues") */}
      <input
        key={`note-${ex.id}`}
        className="field t-call"
        defaultValue={note}
        placeholder="Note to future you — seat height, grip, cues…"
        maxLength={200}
        onBlur={(e) => { if (e.target.value !== note) onSaveNote(e.target.value); }}
        style={{ marginTop: 10, background: "var(--surface-2)", fontSize: 13, minHeight: 40 }}
        aria-label={`Sticky note for ${ex.name}`}
      />
    </Card>
  );
}

// ─── exercise picker — search the library or type anything ───────────────────
function ExercisePicker({ onPick, onClose }) {
  const [q, setQ] = useState("");
  const nq = norm(q);
  const groups = LIB.map(([g, items]) => [g, items.filter((n) => !nq || norm(n).includes(nq))]).filter(([, items]) => items.length);
  const exact = LIB.some(([, items]) => items.some((n) => norm(n) === nq));
  return (
    // z 320 keeps the picker above the sticky rest bar (z 5)
    <Sheet onClose={onClose} title="Add exercise" z={320} bodyStyle={{ minHeight: "min(66dvh, 560px)" }}>
      {/* deliberately no autoFocus — the keyboard would bury the library list; tap to search instead */}
      <Field value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, or type your own…"
        onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) onPick(q.trim()); }}
        style={{ marginBottom: 12 }} />
      {q.trim() && !exact && (
        <Button kind="quiet" size="md" full onClick={() => onPick(q.trim())} style={{ justifyContent: "flex-start", marginBottom: 12 }}>
          <IcPlus size={15} /> Add "{q.trim()}" as a custom exercise
        </Button>
      )}
      {groups.map(([g, items]) => (
        <div key={g} style={{ marginBottom: 14 }}>
          <div className="t-label" style={{ padding: "0 4px 8px" }}>{g}</div>
          <CellGroup style={{ background: "var(--surface-2)", boxShadow: "none" }}>
            {items.map((n) => <Cell key={n} title={n} onClick={() => onPick(n)} />)}
          </CellGroup>
        </div>
      ))}
      {!groups.length && !q.trim() && <EmptyState title="Nothing here." />}
    </Sheet>
  );
}

// ─── finish sheet — summary, notes, and the write-back toggle ─────────────────
function FinishSheet({ active, doneSets, volume, prCount, elapsed, saving, saveErr, onSave, onClose, onDiscard }) {
  const [notes, setNotes] = useState("");
  // updateTemplate defaults ON whenever the session came from a routine — progressive overload by default
  const [updateTemplate, setUpdateTemplate] = useState(!!active.templateId);
  return (
    <Sheet onClose={onClose} title="Finish workout" z={320}
      footer={
        <>
          <Button kind="quiet" size="lg" onClick={onClose} style={{ flex: 1 }}>Keep going</Button>
          <Button kind="primary" size="lg" onClick={() => onSave({ notes, updateTemplate })} disabled={saving || doneSets === 0} style={{ flex: 1.4 }}>
            {saving ? "Saving…" : "Save workout"}
          </Button>
        </>
      }>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        <StatTile value={fmtDur(elapsed)} label="Time" />
        <StatTile value={doneSets} label="Sets" />
        <StatTile value={`${fmtVol(volume)} ${active.unit}`} label="Volume" />
        <StatTile value={prCount ? `◆ ${prCount}` : "—"} label="PRs" valueTone={prCount ? "var(--accent)" : "var(--faint)"} />
      </div>
      {doneSets === 0 && (
        <div className="t-foot" style={{ color: "var(--amber)", marginTop: 10 }}>
          No sets logged yet — finishing now saves nothing. Discard instead, or go log a set.
        </div>
      )}
      <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
        placeholder="Notes — how it felt, anything to remember (optional)"
        style={{ marginTop: 12, resize: "vertical" }} />
      {active.templateId && (
        <div style={{ marginTop: 12, background: "var(--surface-2)", borderRadius: 12, overflow: "hidden" }}>
          <SwitchRow title="Update routine" sub={`Write today's weights, reps & sets back to ${active.templateName}`}
            on={updateTemplate} onToggle={() => setUpdateTemplate((v) => !v)} />
        </div>
      )}
      {saveErr && <div className="t-foot" style={{ color: "var(--red)", marginTop: 10 }}>{saveErr}</div>}
      <Button kind="danger" size="md" full onClick={onDiscard} style={{ marginTop: 14 }}>Discard workout</Button>
    </Sheet>
  );
}

// ─── Routines — list + builder ────────────────────────────────────────────────
function RoutineList({ templates, onNew, onEdit, onStart }) {
  return (
    <section style={{ minWidth: 0 }}>
      <SectionHeader title="Routines"
        trailing={<button className="sec-link" style={{ padding: "12px 8px", margin: "-12px -8px" }} onClick={onNew}>New routine</button>} />
      {templates === null ? (
        <div className="sk" style={{ height: 120, borderRadius: 18 }} />
      ) : templates.length === 0 ? (
        <Card pad="md">
          <EmptyState icon={<IcDumbbell size={26} />} title="No routines yet"
            sub="Name it, add the lifts and targets — starting a session becomes two taps."
            action={<Button kind="primary" size="md" onClick={onNew}><IcPlus size={15} /> New routine</Button>} />
        </Card>
      ) : (
        <CellGroup>
          {templates.map((t) => (
            <Cell key={t.id} title={t.name}
              sub={(t.exercises || []).map((e) => e.name).join(" · ") || "Empty"}
              trailing={
                <span style={{ display: "inline-flex", gap: 8, flex: "none" }}>
                  <Button kind="quiet" size="md" onClick={() => onEdit(t)}>Edit</Button>
                  <Button kind="tinted" size="md" onClick={() => onStart(t)}>Start</Button>
                </span>
              } />
          ))}
        </CellGroup>
      )}
    </section>
  );
}

function RoutineEditor({ isMobile, unit, defaultRest, initial, nextPosition, onSave, onDelete, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  // stored weights convert from the template's saved unit to the CURRENT preference unit —
  // the routine is written back in the current unit on save
  const [exercises, setExercises] = useState(() => (initial?.exercises || []).map((e) => ({ ...e, id: e.id || uuid(), weight: Math.round((conv(e.weight, initial?.unit || "lb", unit) || 0) * 10) / 10 })));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const updEx = (id, patch) => setExercises((arr) => arr.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const move = (id, dir) => setExercises((arr) => {
    const i = arr.findIndex((e) => e.id === id), j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    const next = [...arr]; [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const numField = (val, onCh, w = 56, dec = false) => (
    <NumField value={val} onChange={onCh} width={w} decimals={dec} style={{ background: "var(--surface)" }} />
  );
  const ctlBtn = {
    width: 44, height: 44, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
    background: "none", border: "none", color: "var(--faint)", cursor: "pointer", padding: 0, margin: "-4px 0",
  };

  const save = () => {
    if (!name.trim()) { setErr("Name the routine."); return; }
    if (!exercises.length) { setErr("Add at least one exercise."); return; }
    setSaving(true); setErr(null);
    onSave({ id: initial?.id || uuid(), name: name.trim(), unit, exercises, position: initial?.position ?? nextPosition })
      .catch((e) => { setSaving(false); setErr(e.message || "Couldn't save."); });
  };

  return (
    <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, margin: "-4px 0 -2px -10px" }}>
        <Button kind="plain" size="md" onClick={onCancel} style={{ paddingLeft: 10, paddingRight: 12 }}>
          <IcChevronLeft size={15} /> Routines
        </Button>
        <span className="t-label">{initial ? "Editing" : "New routine"}</span>
      </div>
      <Field value={name} onChange={(e) => setName(e.target.value)} placeholder="Routine name — e.g. Push Day"
        style={{ fontWeight: 600, fontSize: 16 }} />

      {exercises.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {exercises.map((ex, i) => (
            <div key={ex.id} style={{ background: "var(--surface-2)", borderRadius: 12, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <span className="t-call" style={{ fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ex.name}</span>
                <button onClick={() => move(ex.id, -1)} disabled={i === 0} aria-label="move up" style={{ ...ctlBtn, opacity: i === 0 ? 0.35 : 1 }}>
                  <IcChevronDown size={14} style={{ transform: "rotate(180deg)" }} />
                </button>
                <button onClick={() => move(ex.id, 1)} disabled={i === exercises.length - 1} aria-label="move down" style={{ ...ctlBtn, opacity: i === exercises.length - 1 ? 0.35 : 1 }}>
                  <IcChevronDown size={14} />
                </button>
                <button onClick={() => setExercises((arr) => arr.filter((e) => e.id !== ex.id))} aria-label="remove" style={{ ...ctlBtn, marginRight: -8 }}>
                  <IcClose size={15} />
                </button>
              </div>
              <div style={{ display: "flex", gap: isMobile ? 8 : 14, flexWrap: "wrap", marginTop: 8 }}>
                <div><div className="t-cap" style={{ color: "var(--faint)", marginBottom: 4 }}>Sets</div>{numField(ex.targetSets ?? 3, (v) => updEx(ex.id, { targetSets: v }))}</div>
                <div><div className="t-cap" style={{ color: "var(--faint)", marginBottom: 4 }}>Reps</div>{numField(ex.targetReps ?? 8, (v) => updEx(ex.id, { targetReps: v }))}</div>
                <div><div className="t-cap" style={{ color: "var(--faint)", marginBottom: 4 }}>Weight ({unit})</div>{numField(ex.weight ?? 0, (v) => updEx(ex.id, { weight: v }), 72, true)}</div>
                <div><div className="t-cap" style={{ color: "var(--faint)", marginBottom: 4 }}>Rest (sec)</div>{numField(ex.restSec ?? defaultRest, (v) => updEx(ex.id, { restSec: v }), 64)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button kind="quiet" size="md" full onClick={() => setPickerOpen(true)}><IcPlus size={15} /> Add exercise</Button>
      {err && <div className="t-foot" style={{ color: "var(--red)" }}>{err}</div>}
      <div style={{ display: "flex", gap: 10 }}>
        <Button kind="primary" size="md" onClick={save} disabled={saving} style={{ flex: 1 }}>{saving ? "Saving…" : "Save routine"}</Button>
        <Button kind="quiet" size="md" onClick={onCancel}>Cancel</Button>
      </div>
      {initial && (
        <Button kind="danger" size="md" full
          onClick={async () => {
            if (await confirm({ title: "Delete routine?", message: "Past sessions stay in History.", confirmLabel: "Delete", destructive: true })) onDelete(initial.id);
          }}>
          Delete routine
        </Button>
      )}
      {pickerOpen && (
        <ExercisePicker
          onPick={(n) => { setExercises((arr) => [...arr, { id: uuid(), name: n, targetSets: 3, targetReps: 8, weight: 0, restSec: defaultRest }]); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)} />
      )}
      {confirmEl}
    </Card>
  );
}

// ─── Watch sheet — the honest Apple Watch hookup ──────────────────────────────
// A web app cannot touch HealthKit; the working path is an iOS Shortcuts
// automation ("When I finish a workout" → POST here). The only status shown
// is how many workouts actually arrived — no fake "connected" state.
function WatchSheet({ ws, setWs, watchCount, onClose }) {
  const [copied, setCopied] = useState(null);
  const endpoint = `${window.location.origin}/.netlify/functions/workout-import`;
  const token = ws.importToken || "";
  const copy = (label, text) => { navigator.clipboard?.writeText(text).then(() => { setCopied(label); setTimeout(() => setCopied(null), 1800); }); };
  const genToken = () => setWs({ importToken: uuid() });
  return (
    <Sheet onClose={onClose} title="Apple Watch · auto-import" z={320}>
      <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
        Finish a workout on the watch → an iPhone Shortcuts automation posts it here → it lands in
        History with calories and average heart rate. Re-sends are skipped, never duplicated.
        {watchCount > 0 ? ` ${watchCount} imported so far.` : " Nothing has arrived yet."}
      </div>

      <div className="t-label" style={{ margin: "16px 0 8px" }}>Your import token</div>
      {token ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <code className="t-num" style={{ flex: 1, minWidth: 0, background: "var(--surface-2)", borderRadius: 10, padding: "10px 12px", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{token}</code>
          <Button kind="quiet" size="md" onClick={() => copy("token", token)}>{copied === "token" ? "Copied" : "Copy"}</Button>
        </div>
      ) : (
        <Button kind="primary" size="md" onClick={genToken}>Generate token</Button>
      )}
      {token && (
        <div className="t-foot" style={{ color: "var(--faint)", marginTop: 6 }}>
          The token is the only key to this door — treat it like a password.{" "}
          <button className="sec-link" style={{ font: "inherit" }} onClick={genToken}>Regenerate</button> to revoke the old one.
        </div>
      )}

      <div className="t-label" style={{ margin: "16px 0 8px" }}>One-time setup (iPhone)</div>
      <ol className="t-call" style={{ color: "var(--sub)", lineHeight: 1.7, margin: 0, paddingLeft: 20 }}>
        <li>Shortcuts → Automation → <b>+</b> → <b>When I finish a workout</b> → Run Immediately.</li>
        <li>Add action <b>Get Contents of URL</b>:&nbsp;
          <code className="t-num" style={{ fontSize: 11.5, background: "var(--surface-2)", borderRadius: 6, padding: "2px 6px", wordBreak: "break-all" }}>{endpoint}</code>
          <Button kind="quiet" size="md" onClick={() => copy("url", endpoint)} style={{ marginLeft: 6, padding: "0 10px", height: 30, minHeight: 30 }}>{copied === "url" ? "Copied" : "Copy"}</Button>
        </li>
        <li>Method <b>POST</b> · Request Body <b>JSON</b> with fields from the automation's workout:
          <pre className="t-num" style={{ background: "var(--surface-2)", borderRadius: 10, padding: "10px 12px", fontSize: 11, lineHeight: 1.55, overflowX: "auto", margin: "8px 0 0" }}>
{`{ "token": "<your token>",
  "workouts": [{
    "type":        <Workout Type>,
    "start":       <Start Date (ISO 8601)>,
    "durationMin": <Duration (minutes)>,
    "calories":    <Active Energy>,
    "avgHeartRate":<Average Heart Rate>,
    "distanceKm":  <Distance (km)>
  }] }`}</pre>
          Only type, start, and duration are required. The <b>Health Auto Export</b> app's REST automation pointed at the same URL works too.
        </li>
      </ol>
    </Sheet>
  );
}

// ─── receipt — the earned moment after a save ────────────────────────────────
function ReceiptSheet({ r, onClose }) {
  return (
    <Sheet onClose={onClose} title="Workout saved" z={330}
      footer={<Button kind="primary" size="lg" full onClick={onClose}>Done</Button>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        <StatTile value={fmtDur(r.durationSec)} label="Time" />
        <StatTile value={r.setCount} label="Sets" />
        <StatTile value={`${fmtVol(r.volume)} ${r.unit}`} label="Volume" />
        <StatTile value={r.prCount ? `◆ ${r.prCount}` : "—"} label="PRs" valueTone={r.prCount ? "var(--accent)" : "var(--faint)"} />
      </div>
      {r.prSets?.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
          {r.prSets.map((p, i) => (
            <div key={i} className="t-call" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "9px 12px" }}>
              <span style={{ color: "var(--accent)" }}>◆</span> <b>{p.name}</b> — {fmtW(p.weight)}×{p.reps} {r.unit}, a lifetime best
            </div>
          ))}
        </div>
      )}
      {r.weekCount != null && (
        <div className="t-call" style={{ marginTop: 12, color: "var(--sub)" }}>
          {r.weekCount}/{r.goal} this week
          {r.streak > 0 && <> · <b style={{ color: r.streakUp ? "var(--accent)" : "var(--ink)" }}>{r.streak}-week streak{r.streakUp ? " — extended" : " — alive"}</b></>}
        </div>
      )}
    </Sheet>
  );
}

// ─── Progress — trend, PR wall, weekly muscle sets, recap ────────────────────
function ProgressView({ isMobile, sessions, unit, goal, wdb }) {
  const [trendEx, setTrendEx] = useState("");

  const strength = useMemo(() => (sessions || []).filter((s) => !isCardio(s)), [sessions]);
  const exNames = useMemo(() => {
    const freq = new Map();
    for (const s of strength) for (const ex of s.exercises || []) if (ex.name) freq.set(ex.name, (freq.get(ex.name) || 0) + 1);
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  }, [strength]);
  useEffect(() => { if (!trendEx && exNames.length) setTrendEx(exNames[0]); }, [exNames, trendEx]);

  // est-1RM per day for the picked lift — WORKING sets only, and sets over
  // 12 reps return no estimate at all (engine cap), so they leave a gap
  // instead of a flattering spike.
  const trend = useMemo(() => {
    if (!trendEx) return [];
    const pts = [];
    for (const s of [...strength].reverse()) { // oldest first
      let best = 0;
      for (const ex of s.exercises || []) if (norm(ex.name) === norm(trendEx))
        for (const x of ex.sets || []) if (!isWU(x)) best = Math.max(best, epley(conv(x.weight, s.unit || "lb", unit), x.reps));
      if (best > 0) pts.push({ t: new Date(s.started_at).getTime(), v: best });
    }
    return pts;
  }, [strength, trendEx, unit]);

  const prs = useMemo(() => recentPRs(sessions || [], 8), [sessions]);
  const week = useMemo(() => weeklySetsByGroup(sessions || [], { weeks: 1 })[0] || null, [sessions]);
  const recap = useMemo(() => weeklyRecap(sessions || [], { unit }), [sessions, unit]);
  const lifetime = useMemo(() => lifetimeVolume(sessions || [], unit), [sessions, unit]);
  const totalPRs = useMemo(() => (sessions || []).reduce((n, s) => n + (s.pr_count || 0), 0), [sessions]);

  if (sessions === null) return <Card pad="md"><div className="sk" style={{ height: 140, borderRadius: 12 }} /></Card>;
  if (!sessions.length) {
    return <Card pad="md"><EmptyState icon={<IcDumbbell size={26} />} title="No data yet" sub="Progress builds itself from finished workouts." /></Card>;
  }

  const bestPt = trend.reduce((m, p) => (p.v > m ? p.v : m), 0);
  const groupsShown = week ? GROUPS.filter((g) => g !== "Other" || week.byGroup.Other > 0) : [];
  const d = (a, b) => (a === b ? "—" : `${a > b ? "+" : ""}${fmtVol(a - b)}`);

  return (
    <Grid min={340} gap={12}>
      <Card pad="md" style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <span className="t-head">Est. 1RM trend</span>
          {exNames.length > 4 && (
            <select className="field t-num" value={trendEx} onChange={(e) => setTrendEx(e.target.value)}
              style={{ width: "auto", maxWidth: isMobile ? 185 : 260, fontSize: 13, padding: "8px 12px" }}>
              {exNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
        </div>
        {exNames.length > 0 && exNames.length <= 4 && (
          <PillRow options={exNames} value={trendEx} onChange={setTrendEx} style={{ padding: "0 0 10px" }} />
        )}
        {trend.length >= 2 ? (
          <>
            <TrendLine points={trend} unit={unit} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 12 }}>
              <StatTile value={`${fmtW(bestPt)} ${unit}`} label="Best est 1RM" />
              <StatTile value={`${fmtW(trend[trend.length - 1].v)} ${unit}`} label="Latest" />
              <StatTile value={trend.length} label="Sessions" />
            </div>
          </>
        ) : (
          <div className="t-foot" style={{ color: "var(--faint)", padding: "10px 0" }}>
            Log {trendEx || "a lift"} twice and the trend line appears here.
          </div>
        )}
        {(() => { const plat = plateauRead(trend); return plat ? (
          <div className="t-foot" style={{ color: "var(--amber)", marginTop: 8 }}>
            No new best across the last {plat.sessions} sessions of this lift — a lighter week or a rep-range change often unsticks it. (A nudge, not a diagnosis.)
          </div>
        ) : null; })()}
        <div className="t-cap" style={{ color: "var(--faint)", marginTop: 10 }}>
          Epley estimate from working sets ≤ 12 reps — a trend-reading tool, not a max-attempt promise.
        </div>
      </Card>

      <Card pad="md" style={{ minWidth: 0 }}>
        <span className="t-head">Recent PRs</span>
        {prs.length === 0 ? (
          <div className="t-foot" style={{ color: "var(--faint)", padding: "10px 0" }}>
            PRs land here — each judged against your own history only. A first-ever lift is a baseline, not a PR.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
            {prs.map((p, i) => (
              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, background: "var(--surface-2)", borderRadius: 12, padding: "9px 12px" }}>
                <span style={{ color: "var(--accent)", flex: "none" }}>◆</span>
                <span className="t-call" style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                <span className="t-num" style={{ fontSize: 12.5, color: "var(--sub)", marginLeft: "auto", flex: "none" }}>
                  {fmtW(p.weight)}×{p.reps} {p.unit} · {fmtDate(new Date(p.t).toISOString())}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card pad="md" style={{ minWidth: 0 }}>
        <span className="t-head">Working sets by muscle group — this week</span>
        {week && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 10 }}>
            {groupsShown.map((g) => {
              const v = week.byGroup[g] || 0;
              const inBand = v >= 10 && v <= 20;
              return (
                <div key={g} style={{ display: "grid", gridTemplateColumns: "92px 1fr 34px", gap: 10, alignItems: "center" }}>
                  <span className="t-call" style={{ fontWeight: 600 }}>{g}</span>
                  <div style={{ position: "relative", height: 5, borderRadius: 99, background: "var(--ink-a06)", overflow: "hidden" }}>
                    <div style={{ width: `${Math.min(100, (v / 20) * 100)}%`, height: "100%", borderRadius: 99, background: inBand ? "var(--green)" : v > 20 ? "var(--amber)" : "var(--blue)" }} />
                  </div>
                  <span className="t-num" style={{ fontSize: 12.5, textAlign: "right" }}>{v}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="t-cap" style={{ color: "var(--faint)", marginTop: 10 }}>
          Warm-ups excluded · grouped by exercise name (unknowns read "Other") · 10–20/wk is the common hypertrophy guideline, not a law.
        </div>
      </Card>

      <Card pad="md" style={{ minWidth: 0 }}>
        <span className="t-head">This week vs last</span>
        {recap && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 10 }}>
            <StatTile value={recap.thisWeek.sessions} label="Workouts" />
            <StatTile value={fmtVol(recap.thisWeek.volume)} label={`Volume (${unit})`} />
            <StatTile value={recap.thisWeek.sets} label="Sets" />
          </div>
        )}
        {recap && (
          <div className="t-foot" style={{ color: "var(--faint)", marginTop: 8 }}>
            vs last week: {recap.thisWeek.sessions - recap.lastWeek.sessions >= 0 ? "+" : ""}{recap.thisWeek.sessions - recap.lastWeek.sessions} workouts · {d(Math.round(recap.thisWeek.volume), Math.round(recap.lastWeek.volume))} {unit} · Mon–Sun weeks
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 12 }}>
          <StatTile value={fmtVol(lifetime)} label={`Lifetime volume (${unit})`} />
          <StatTile value={totalPRs ? `◆ ${totalPRs}` : "—"} label="Lifetime PRs" valueTone={totalPRs ? "var(--accent)" : "var(--faint)"} />
        </div>
      </Card>

      <Card pad="md" style={{ minWidth: 0 }}>
        <span className="t-head">Volume — last 8 weeks</span>
        <WeeklyVolumeBars rows={weeklyVolumeSeries(sessions || [], { weeks: 8, unit })} unit={unit} />
        <div className="t-cap" style={{ color: "var(--faint)", marginTop: 8 }}>
          Working-set tonnage per Monday-week, mixed units converted · cardio isn't tonnage.
        </div>
      </Card>

      <BodyWeightCard wdb={wdb} unit={unit} />
    </Grid>
  );
}

// Eight quiet bars — the newest carries its number. Data blue; gold stays reserved.
function WeeklyVolumeBars({ rows, unit }) {
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.volume));
  const W = 300, H = 96, PAD = 2, bw = (W - PAD * 2) / rows.length;
  const last = rows[rows.length - 1];
  return (
    <div style={{ marginTop: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }} aria-hidden>
        {rows.map((r, i) => {
          const h = r.volume > 0 ? Math.max(3, (r.volume / max) * (H - 18)) : 2;
          return <rect key={r.weekStart} x={PAD + i * bw + bw * 0.18} y={H - h} width={bw * 0.64} height={h} rx="3"
            fill={i === rows.length - 1 ? "var(--blue)" : "color-mix(in srgb, var(--blue) 45%, transparent)"} />;
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span className="t-cap" style={{ color: "var(--faint)" }}>{rows[0].weekStart.slice(5)}</span>
        <span className="t-num" style={{ fontSize: 12, fontWeight: 600 }}>{fmtVol(last.volume)} {unit} · {last.sets} sets this wk</span>
      </div>
    </div>
  );
}

// ─── body weight — the other trend line that matters ─────────────────────────
function BodyWeightCard({ wdb, unit }) {
  const [state, setState] = useState(null); // null loading | {error} | {rows}
  const [val, setVal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmEl, confirm] = useConfirm();
  const load = () => wdb.loadBodyWeight().then(setState).catch((e) => setState({ error: e.message }));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const rows = state?.rows || [];
  const pts = [...rows].reverse().map((r) => ({ t: new Date(r.logged_at).getTime(), v: conv(r.weight, r.unit || "lb", unit) }));
  const latest = rows[0] ? conv(rows[0].weight, rows[0].unit || "lb", unit) : null;
  const monthAgo = Date.now() - 30 * 86400000;
  const oldest30 = [...rows].reverse().find((r) => new Date(r.logged_at).getTime() >= monthAgo);
  const delta = latest != null && oldest30 && oldest30.id !== rows[0].id ? latest - conv(oldest30.weight, oldest30.unit || "lb", unit) : null;

  // write failures are SHOWN — a swallowed insert error looks exactly like
  // success to someone who just weighed in
  const [actionErr, setActionErr] = useState(null);
  const add = async () => {
    if (!(val > 0)) return;
    setBusy(true); setActionErr(null);
    try { await wdb.addBodyWeight(Math.round(val * 10) / 10, unit); setVal(0); await load(); }
    catch (e) { setActionErr(`Couldn't log it: ${e.message || "unknown error"}`); }
    setBusy(false);
  };
  const removeLatest = async () => {
    if (!rows[0]) return;
    if (!(await confirm({ title: "Remove latest entry?", confirmLabel: "Remove", destructive: true }))) return;
    setBusy(true); setActionErr(null);
    try { await wdb.deleteBodyWeight(rows[0].id); await load(); }
    catch (e) { setActionErr(`Couldn't remove it: ${e.message || "unknown error"}`); }
    setBusy(false);
  };

  return (
    <Card pad="md" style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span className="t-head">Body weight</span>
        {rows.length > 0 && <Button kind="quiet" size="md" disabled={busy} onClick={removeLatest}>Undo last</Button>}
      </div>
      {state?.error ? (
        <div className="t-foot" style={{ color: "var(--faint)", padding: "10px 0" }}>
          Couldn't load the body-weight log ({state.error}). If this install predates the Train tab,
          re-run the one-time Train setup SQL (Routines → it appears when tables are missing) — it now includes this table.
        </div>
      ) : (
        <>
          {pts.length >= 2
            ? <div style={{ marginTop: 8 }}><TrendLine points={pts} unit={unit} /></div>
            : <div className="t-foot" style={{ color: "var(--faint)", padding: "8px 0" }}>Two entries make a trend line. Log it after the same morning routine for a signal, not noise.</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <NumField value={val || ""} decimals width={92} onChange={setVal} />
            <span className="t-cap" style={{ color: "var(--faint)" }}>{unit}</span>
            <Button kind="tinted" size="md" disabled={busy || !(val > 0)} onClick={add}>{busy ? "…" : "Log weight"}</Button>
            {delta != null && (
              <span className="t-num" style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--sub)" }}>
                {delta >= 0 ? "+" : ""}{fmtW(delta)} {unit} / 30d
              </span>
            )}
          </div>
          {actionErr && <div className="t-foot" style={{ color: "var(--red)", marginTop: 8 }}>{actionErr}</div>}
        </>
      )}
      {confirmEl}
    </Card>
  );
}

// ─── History — sessions + CSV export ─────────────────────────────────────────
function HistoryView({ isMobile, sessions, unit, onDelete }) {
  const [openId, setOpenId] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const exportCsv = () => {
    // naive CSV escaping: commas are stripped from name fields, never emitted raw
    const rows = [["date", "routine", "exercise", "set", "kind", "weight", "unit", "reps", "est_1rm"]];
    for (const s of sessions || []) {
      if (isCardio(s)) {
        const c = cardioMeta(s);
        rows.push([s.started_at, (c.activity || "Cardio").replace(/,/g, " "), "cardio", 1, "cardio", "", "", "", ""]);
        continue;
      }
      for (const ex of s.exercises || []) (ex.sets || []).forEach((x, i) => {
        const e1 = isWU(x) ? null : e1RM(x.weight, x.reps);
        rows.push([s.started_at, (s.template_name || "Quick session").replace(/,/g, " "), ex.name.replace(/,/g, " "), i + 1, x.kind || "working", x.weight, s.unit || "lb", x.reps, e1 == null ? "" : Math.round(e1)]);
      });
    }
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "board-room-workouts.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (sessions === null) {
    return (
      <Card pad="md">
        <div className="sk sk-line w40" />
        <div className="sk" style={{ height: 76, borderRadius: 12, margin: "12px 0" }} />
        <div className="sk sk-line w60" />
      </Card>
    );
  }
  if (!sessions.length) {
    return (
      <Card pad="md">
        <EmptyState icon={<IcDumbbell size={26} />} title="Nothing logged yet" sub="Your first finished workout lands here." />
      </Card>
    );
  }

  const visible = showAll || sessions.length <= 12 ? sessions : sessions.slice(0, 10);

  return (
    <Grid min={340} gap={12}>
      <Card style={{ padding: 0, overflow: "hidden", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 12px 4px 16px" }}>
          <span className="t-head">Sessions</span>
          <Button kind="quiet" size="md" onClick={exportCsv}>Export CSV</Button>
        </div>
        <div style={{ paddingBottom: 6 }}>
          {visible.map((s, idx) => {
            const open = openId === s.id;
            return (
              <div key={s.id}>
                {idx > 0 && <div style={{ height: 0.5, background: "var(--line)", marginLeft: 16 }} />}
                <button className="cell tappable" onClick={() => setOpenId(open ? null : s.id)} style={{ width: "100%" }}>
                  <span className="cell-body">
                    <span className="cell-title">
                      {isCardio(s) ? (cardioMeta(s).activity || "Cardio") : (s.template_name || "Quick session")}
                      {isCardio(s) && cardioMeta(s).source === "watch" && <span className="t-cap" style={{ color: "var(--green)", fontWeight: 600 }}> · watch</span>}
                      {s.pr_count ? <span className="t-num" style={{ color: "var(--accent)", fontWeight: 600, fontSize: 12.5 }}> ◆{s.pr_count}</span> : null}
                    </span>
                    <span className="cell-sub t-num" style={{ fontSize: 11.5 }}>
                      {isCardio(s) ? (
                        <>
                          {fmtDate(s.started_at)} · {s.duration_sec ? fmtDur(s.duration_sec) : "—"}
                          {Number.isFinite(cardioMeta(s).distanceKm) && <> · {Math.round(cardioMeta(s).distanceKm * 10) / 10} km</>}
                          {Number.isFinite(cardioMeta(s).avgHr) && <> · {Math.round(cardioMeta(s).avgHr)} bpm</>}
                          {Number.isFinite(cardioMeta(s).kcal) && <> · {Math.round(cardioMeta(s).kcal)} kcal</>}
                        </>
                      ) : (
                        <>{fmtDate(s.started_at)} · {s.duration_sec ? fmtDur(s.duration_sec) : "—"} · {s.total_sets || 0} sets · {fmtVol(s.total_volume || 0)} {s.unit}</>
                      )}
                    </span>
                  </span>
                  <span className="cell-chevron" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }}>
                    <IcChevronRight />
                  </span>
                </button>
                <div className={`expand${open ? " open" : ""}`}>
                  <div>
                    <div style={{ padding: "2px 16px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                      {isCardio(s) && (
                        <div className="t-foot" style={{ color: "var(--sub)" }}>
                          {cardioMeta(s).source === "watch" ? "Imported from Apple Watch." : "Logged cardio."}
                        </div>
                      )}
                      {!isCardio(s) && (s.exercises || []).map((ex, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                          <span className="t-call" style={{ fontWeight: 600, flex: "none", minWidth: 0 }}>{ex.name}</span>
                          <span className="t-num" style={{ fontSize: 12, color: "var(--sub)" }}>
                            {(ex.sets || []).map((x, j) => (
                              <span key={j}>{j > 0 ? ", " : ""}{isWU(x) ? "wu " : x.kind === "failure" ? "F " : x.kind === "drop" ? "D " : ""}{fmtW(x.weight)}×{x.reps}{x.pr ? <span style={{ color: "var(--accent)" }}>◆</span> : ""}</span>
                            ))}
                          </span>
                        </div>
                      ))}
                      {s.notes && <div className="t-foot" style={{ fontStyle: "italic" }}>"{s.notes}"</div>}
                      <Button kind="danger" size="md" style={{ alignSelf: "flex-start", marginTop: 4 }}
                        onClick={async () => {
                          if (await confirm({ title: "Delete session?", message: "It comes out of History for good.", confirmLabel: "Delete", destructive: true })) onDelete(s.id);
                        }}>
                        Delete session
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {sessions.length > 12 && !showAll && (
            <Button kind="plain" size="md" full onClick={() => setShowAll(true)}>Show all {sessions.length} sessions</Button>
          )}
        </div>
      </Card>
      {confirmEl}
    </Grid>
  );
}

// Sparkline, not a chart: no axes — just the three numbers the eye needs
// (max, min, latest) in quiet mono, and a 2px line with a 9% wash.
function TrendLine({ points, unit }) {
  const W = 300, H = 76, P = 12;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1; // span fallback avoids divide-by-zero on flat data
  const x = (i) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  const last = points[points.length - 1];
  const linePts = points.map((p, i) => `${x(i)},${y(p.v)}`).join(" ");
  const area = `${x(0)},${H} ${linePts} ${x(points.length - 1)},${H}`;
  const lastXPct = (x(points.length - 1) / W) * 100;
  const lastYPct = (y(last.v) / H) * 100;
  return (
    <div style={{ position: "relative", margin: "2px 0" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }} aria-hidden>
        <polygon points={area} fill="var(--blue)" opacity="0.09" />
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <polyline points={linePts} fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* last-point marker + direct label (text lives in HTML so it never stretches with the svg) */}
      <span style={{
        position: "absolute", left: `${lastXPct}%`, top: `${lastYPct}%`, width: 7, height: 7, borderRadius: "50%",
        background: "var(--blue)", boxShadow: "0 0 0 1.5px var(--surface)", transform: "translate(-50%, -50%)",
      }} />
      <span className="t-num" style={{
        position: "absolute", right: 0, fontSize: 11, fontWeight: 600, color: "var(--ink)", lineHeight: 1, whiteSpace: "nowrap",
        ...(lastYPct < 50 ? { top: `calc(${lastYPct}% + 9px)` } : { top: `calc(${lastYPct}% - 19px)` }),
      }}>
        {fmtW(last.v)} {unit}
      </span>
      <span className="t-num" style={{ position: "absolute", left: 0, top: 0, fontSize: 10.5, color: "var(--faint)", lineHeight: 1 }}>{fmtW(max)}</span>
      <span className="t-num" style={{ position: "absolute", left: 0, bottom: 0, fontSize: 10.5, color: "var(--faint)", lineHeight: 1 }}>{fmtW(min)}</span>
    </div>
  );
}
