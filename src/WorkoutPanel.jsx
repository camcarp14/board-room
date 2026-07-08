import { useState, useEffect, useMemo } from "react";
import { T, syne, mono } from "./theme.js";

// ════════════════════════════════════════════════════════════════════════════
// WORKOUT — the Personal tab's training room.
// Built around the things every fitness app gets wrong:
//   · logging a set takes one tap — values pre-filled from last time
//   · no keyboard hunting mid-set: big − / + steppers (inputs still editable)
//   · last session's numbers sit right under each set number
//   · rest timer starts itself when you log, and is one tap to skip or extend
//   · a workout in progress survives the app closing — resumes where you left it
//   · mid-session edits are free: add/remove sets & exercises, reorder, adjust
//   · finishing can write today's numbers back into the routine (one toggle)
//   · tap "Plates" on any exercise for the per-side plate math
//   · history shows volume, duration, PRs, and a per-lift est-1RM trend
//   · your data, your Supabase — CSV export lives in History
// Supabase is the brain (workout_templates + workout_sessions, RLS like every
// other table); localStorage only checkpoints the in-progress session.
// ════════════════════════════════════════════════════════════════════════════

// Palette tokens come from theme.js (CSS variables — Daylight/Nocturne aware).
// S keeps this panel's plate shapes, pixel-identical to its siblings.
const S = {
  card: { padding: "19px 21px", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 14, boxShadow: "none" },
  cardM: { padding: 17, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 13, boxShadow: "none" },
  inner: { background: "transparent", border: `1px solid ${T.line}`, borderRadius: 10 },
  title: { fontSize: 11, fontWeight: 600, fontFamily: syne, color: T.ink, letterSpacing: "0.18em", textTransform: "uppercase" },
  microLabel: { fontSize: 9, color: T.faint, fontFamily: mono, letterSpacing: "0.14em", textTransform: "uppercase" },
  brassBtn: { background: T.brass, border: "none", borderRadius: 9, color: T.onBrass, fontWeight: 700, fontFamily: syne, letterSpacing: "0.04em", cursor: "pointer", boxShadow: "none" },
  ghostBtn: { background: "transparent", border: `1px solid ${T.lineStrong}`, borderRadius: 9, color: T.sub, fontWeight: 600, cursor: "pointer" },
  input: { background: T.surface2, border: `1px solid ${T.lineStrong}`, borderRadius: 9, color: T.ink },
};

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
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`;

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
      const { data, error } = await sb.from("workout_sessions").insert({ ...row, user_id }).select().single();
      if (error) throw error;
      return data;
    },
    async deleteSession(id) {
      const { error } = await sb.from("workout_sessions").delete().eq("id", id);
      if (error) throw error;
    },
  };
}

// ─── in-progress checkpoint — localStorage only, Supabase stays the brain ────
const ACTIVE_KEY = "br_workout_active";
const loadActive = () => { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY)); } catch { return null; } };
const saveActive = (a) => { try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(a)); } catch {} };
const clearActive = () => { try { localStorage.removeItem(ACTIVE_KEY); } catch {} };

// ─── helpers ─────────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
const norm = (s) => (s || "").trim().toLowerCase();
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const roman = (n) => ROMAN[n] || String(n);
const epley = (w, r) => (w > 0 && r > 0 ? w * (1 + r / 30) : 0); // est. 1RM
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
  const card = isMobile ? S.cardM : S.card;
  const wdb = useMemo(() => makeWdb(supabase), [supabase]);

  // preferences ride the existing app_settings table under one key
  const ws = (settings && settings.workout) || {};
  const unit = ws.unit === "kg" ? "kg" : "lb";
  const bar = Number(ws.bar) > 0 ? Number(ws.bar) : unit === "kg" ? 20 : 45;
  const defaultRest = Number.isFinite(Number(ws.rest)) ? Number(ws.rest) : 90;
  const setWs = (patch) => updateSetting("workout", { ...ws, ...patch });

  const [templates, setTemplates] = useState(null); // null = loading
  const [sessions, setSessions] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [active, setActive] = useState(() => loadActive());
  const [view, setView] = useState(() => (loadActive() ? "session" : "train"));
  const [editingTpl, setEditingTpl] = useState(null); // template object being edited, or "new"
  const [savedFlash, setSavedFlash] = useState(null); // brief confirmation after finishing

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
  const { prevByEx, bestByEx } = useMemo(() => {
    const prev = new Map(), best = new Map();
    for (const s of sessions || []) { // already newest-first
      for (const ex of s.exercises || []) {
        const k = norm(ex.name);
        if (!k) continue;
        const sets = (ex.sets || []).filter((x) => x.weight != null && x.reps != null);
        if (sets.length && !prev.has(k)) prev.set(k, { sets, unit: s.unit || "lb" });
        for (const x of sets) {
          const e1 = epley(conv(x.weight, s.unit || "lb", "lb"), x.reps); // compare in lb
          if (e1 > (best.get(k) || 0)) best.set(k, e1);
        }
      }
    }
    return { prevByEx: prev, bestByEx: best };
  }, [sessions]);

  // build a session exercise: sets prefilled from the last time you did this
  // lift (per-set where possible), falling back to the routine's targets
  const buildSessionExercise = (name, tpl = {}) => {
    const hist = prevByEx.get(norm(name));
    const count = Math.max(1, tpl.targetSets || hist?.sets.length || 3);
    const sets = [];
    for (let i = 0; i < count; i++) {
      const h = hist ? hist.sets[Math.min(i, hist.sets.length - 1)] : null;
      const w = h ? conv(h.weight, hist.unit, unit) : conv(tpl.weight ?? 0, tpl.unit || unit, unit);
      sets.push({
        id: uuid(),
        weight: Math.round((w || 0) * 10) / 10,
        reps: h?.reps ?? tpl.targetReps ?? 8,
        done: false,
        prev: h ? `${fmtW(conv(h.weight, hist.unit, unit))}×${h.reps}` : null,
      });
    }
    return { id: uuid(), name, restSec: tpl.restSec ?? defaultRest, sets };
  };

  const startWorkout = (tpl) => {
    if (active && !window.confirm("A workout is already in progress. Discard it and start fresh?")) { setView("session"); return; }
    setActive({
      id: uuid(),
      templateId: tpl?.id || null,
      templateName: tpl?.name || "Quick session",
      unit,
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
    let volume = 0, setCount = 0, prCount = 0;
    for (const ex of a.exercises) {
      const sets = ex.sets.filter((s) => s.done).map((s) => ({ weight: s.weight, reps: s.reps, ...(s.pr ? { pr: true } : {}) }));
      if (!sets.length) continue;
      done.push({ name: ex.name, sets });
      for (const s of sets) { volume += (s.weight || 0) * (s.reps || 0); setCount++; if (s.pr) prCount++; }
    }
    const durationSec = Math.max(1, Math.round((Date.now() - a.startedAt) / 1000));
    const row = {
      id: a.id, template_id: a.templateId, template_name: a.templateName, unit: a.unit,
      started_at: new Date(a.startedAt).toISOString(), ended_at: new Date().toISOString(),
      duration_sec: durationSec, notes: notes || "", exercises: done,
      total_volume: Math.round(volume), total_sets: setCount, pr_count: prCount,
    };
    await wdb.saveSession(row);
    if (updateTemplate && a.templateId) {
      const src = (templates || []).find((t) => t.id === a.templateId);
      if (src) {
        const exercises = a.exercises
          .filter((ex) => ex.sets.length)
          .map((ex) => {
            const dsets = ex.sets.filter((s) => s.done);
            const ref = dsets.length ? dsets : ex.sets;
            const last = ref[ref.length - 1];
            return { id: uuid(), name: ex.name, targetSets: ref.length, targetReps: last.reps, weight: last.weight, restSec: ex.restSec };
          });
        await wdb.saveTemplate({ ...src, unit: a.unit, exercises });
      }
    }
    setActive(null);
    setView("train");
    setSavedFlash({ volume, setCount, prCount, durationSec, unit: a.unit });
    setTimeout(() => setSavedFlash(null), 5000);
    refreshAll();
  };

  // ─── render ─────────────────────────────────────────────────────────────
  if (setupNeeded) return <SetupCard card={card} onRetry={refreshAll} />;

  if (view === "session" && active) {
    return (
      <ActiveSession
        card={card} isMobile={isMobile} active={active} setActive={setActive}
        bar={bar} bestByEx={bestByEx} prevByEx={prevByEx} defaultRest={defaultRest}
        buildSessionExercise={buildSessionExercise}
        onBack={() => setView("train")} onFinish={finishWorkout} onDiscard={discardWorkout}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PillNav value={view} onChange={setView} />
      {loadErr && <div style={{ ...card, fontSize: 11.5, color: T.red }}>{loadErr}</div>}
      {view === "train" && (
        <TrainHome
          card={card} isMobile={isMobile} templates={templates} sessions={sessions}
          active={active} unit={unit} savedFlash={savedFlash}
          onResume={() => setView("session")} onStart={startWorkout}
          onQuickStart={() => startWorkout(null)}
          onManage={() => setView("routines")} onHistory={() => setView("history")}
          ws={{ unit, bar, defaultRest }} setWs={setWs}
        />
      )}
      {view === "routines" && (
        editingTpl ? (
          <RoutineEditor
            card={card} isMobile={isMobile} unit={unit} defaultRest={defaultRest}
            initial={editingTpl === "new" ? null : editingTpl}
            nextPosition={(templates || []).length}
            onSave={async (tpl) => { await wdb.saveTemplate(tpl); setEditingTpl(null); refreshAll(); }}
            onDelete={async (id) => { await wdb.deleteTemplate(id); setEditingTpl(null); refreshAll(); }}
            onCancel={() => setEditingTpl(null)}
          />
        ) : (
          <RoutineList card={card} templates={templates} onNew={() => setEditingTpl("new")} onEdit={setEditingTpl} onStart={startWorkout} />
        )
      )}
      {view === "history" && (
        <HistoryView card={card} isMobile={isMobile} sessions={sessions} unit={unit}
          onDelete={async (id) => { await wdb.deleteSession(id); refreshAll(); }} />
      )}
    </div>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────────
function PillNav({ value, onChange }) {
  const opts = [{ key: "train", label: "Train" }, { key: "routines", label: "Routines" }, { key: "history", label: "History" }];
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {opts.map((o) => (
        <button key={o.key} onClick={() => onChange(o.key)}
          style={{ padding: "7px 13px", background: value === o.key ? "var(--brass-a12)" : "var(--ink-a03)", border: `1px solid ${value === o.key ? "var(--brass-a40)" : "var(--line)"}`, borderRadius: 10, color: value === o.key ? T.brass : T.sub, fontSize: 11, fontWeight: 700, fontFamily: syne, cursor: "pointer" }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

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

function NumField({ value, onChange, width = 52, decimals = false, style }) {
  const bind = useNumText(value, onChange, { decimals });
  return <input {...bind} style={{ ...S.input, width, padding: "8px 0", textAlign: "center", fontFamily: mono, fontSize: 12.5, ...style }} />;
}

function Stepper({ value, onChange, step, min = 0, inputWidth = 52, decimals = false }) {
  const btn = { width: 30, height: 42, background: "var(--ink-a04)", border: "1px solid var(--ink-a12)", color: T.sub, fontSize: 16, fontWeight: 700, cursor: "pointer", lineHeight: 1, padding: 0, flex: "none" };
  const clamp = (n) => Math.max(min, Math.round(n * 10) / 10);
  const bind = useNumText(value, onChange, { decimals, min });
  return (
    <div style={{ display: "flex", alignItems: "stretch", flex: "none" }}>
      <button onClick={() => onChange(clamp((value || 0) - step))} style={{ ...btn, borderRadius: "10px 0 0 10px", borderRight: "none" }} aria-label="decrease">−</button>
      <input {...bind}
        style={{ ...S.input, width: inputWidth, borderRadius: 0, textAlign: "center", fontFamily: mono, fontWeight: 600, fontSize: 15, padding: 0, height: 42, borderLeft: "1px solid var(--ink-a12)", borderRight: "1px solid var(--ink-a12)" }}
      />
      <button onClick={() => onChange(clamp((value || 0) + step))} style={{ ...btn, borderRadius: "0 10px 10px 0", borderLeft: "none" }} aria-label="increase">+</button>
    </div>
  );
}

function SheetShell({ onClose, children, isMobile }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4,7,14,0.72)", zIndex: 320, display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: T.surface, borderRadius: isMobile ? "20px 20px 0 0" : 18, padding: "22px 22px calc(22px + env(safe-area-inset-bottom))", width: isMobile ? "100%" : 520, maxWidth: 520, maxHeight: "84dvh", overflowY: "auto", border: "1px solid var(--ink-a10)", boxShadow: "var(--shadow-deep)", animation: "sheetup 0.2s ease both", color: T.ink }}>
        {children}
      </div>
    </div>
  );
}

// ─── setup card — shown once, before the tables exist ────────────────────────
function SetupCard({ card, onRetry }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(WORKOUT_SETUP_SQL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); };
  return (
    <div style={card}>
      <span style={S.title}>Workout — one-time setup</span>
      <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.6, margin: "10px 0 12px" }}>
        The two workout tables aren't in Supabase yet. Paste this into the Supabase <b>SQL Editor</b> and run it once — then come back and hit retry. RLS is included, same pattern as every other Board Room table.
      </div>
      <textarea readOnly value={WORKOUT_SETUP_SQL} rows={12} style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 10, fontFamily: mono, lineHeight: 1.5, resize: "vertical", color: T.sub }} />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={copy} style={{ ...S.brassBtn, padding: "9px 16px", fontSize: 11.5 }}>{copied ? "Copied" : "Copy SQL"}</button>
        <button onClick={onRetry} style={{ ...S.ghostBtn, padding: "9px 16px", fontSize: 11.5 }}>I've run it — retry</button>
      </div>
    </div>
  );
}

// ─── Train home — resume, start, recent, preferences ─────────────────────────
function TrainHome({ card, isMobile, templates, sessions, active, unit, savedFlash, onResume, onStart, onQuickStart, onManage, onHistory, ws, setWs }) {
  const doneSets = active ? active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0) : 0;
  const mins = active ? Math.max(1, Math.round((Date.now() - active.startedAt) / 60000)) : 0;
  const recent = (sessions || []).slice(0, 3);

  return (
    <>
      {savedFlash && (
        <div style={{ ...card, borderTop: `2px solid ${T.green}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, fontFamily: syne, color: T.green }}>Workout saved</div>
            <div style={{ fontSize: 10.5, color: T.sub, marginTop: 2 }}>
              {fmtDur(savedFlash.durationSec)} · {savedFlash.setCount} sets · {fmtVol(savedFlash.volume)} {savedFlash.unit}{savedFlash.prCount ? ` · ${savedFlash.prCount} PR${savedFlash.prCount > 1 ? "s" : ""}` : ""}
            </div>
          </div>
          <span style={{ fontSize: 18, color: T.green }}>✓</span>
        </div>
      )}

      {active && (
        <div style={{ ...card, borderTop: "2px solid var(--brass-a85)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...S.microLabel, color: T.brass }}>IN PROGRESS</div>
            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: syne, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{active.templateName}</div>
            <div style={{ fontSize: 10.5, color: T.sub, marginTop: 2 }}>{mins}m in · {doneSets} set{doneSets === 1 ? "" : "s"} logged</div>
          </div>
          <button onClick={onResume} style={{ ...S.brassBtn, padding: "10px 18px", fontSize: 12, flex: "none", animation: "breathe 2.6s ease-in-out infinite" }}>Resume</button>
        </div>
      )}

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={S.title}>Start training</span>
          <button onClick={onManage} style={{ background: "none", border: "none", color: T.brass, fontFamily: syne, fontWeight: 700, fontSize: 11, cursor: "pointer", padding: 0 }}>Manage routines ›</button>
        </div>
        {templates === null ? (
          <div style={{ fontSize: 11.5, color: T.faint, padding: "14px 0", textAlign: "center", animation: "pulse 1.4s infinite" }}>Loading…</div>
        ) : templates.length === 0 ? (
          <div style={{ ...S.inner, padding: "18px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 12, fontWeight: 700, fontFamily: syne, marginBottom: 4 }}>No routines yet</div>
            <div style={{ fontSize: 10.5, color: T.sub, marginBottom: 12 }}>Build one once — every session after is two taps.</div>
            <button onClick={onManage} style={{ ...S.brassBtn, padding: "9px 16px", fontSize: 11.5 }}>Build your first routine</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {templates.map((t) => {
              const sets = (t.exercises || []).reduce((n, e) => n + (e.targetSets || 0), 0);
              return (
                <div key={t.id} style={{ ...S.inner, padding: "11px 13px", display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
                    <div style={{ fontSize: 10, color: T.faint, marginTop: 2 }}>{(t.exercises || []).length} exercises · {sets} sets</div>
                  </div>
                  <button onClick={() => onStart(t)} style={{ ...S.brassBtn, padding: "9px 18px", fontSize: 11.5, flex: "none" }}>Start</button>
                </div>
              );
            })}
          </div>
        )}
        <button onClick={onQuickStart} style={{ ...S.ghostBtn, width: "100%", padding: "10px 0", fontSize: 11.5, marginTop: 10 }}>Quick start — empty workout</button>
      </div>

      {recent.length > 0 && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={S.title}>Recent</span>
            <button onClick={onHistory} style={{ background: "none", border: "none", color: T.brass, fontFamily: syne, fontWeight: 700, fontSize: 11, cursor: "pointer", padding: 0 }}>All history ›</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {recent.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, padding: "4px 2px" }}>
                <span style={{ fontSize: 11.5, color: T.ink, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.template_name || "Quick session"}</span>
                <span style={{ fontSize: 10, color: T.faint, fontFamily: mono, flex: "none" }}>
                  {fmtDate(s.started_at)} · {fmtVol(s.total_volume || 0)} {s.unit}{s.pr_count ? <span style={{ color: T.brass }}> · ◆{s.pr_count}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={card}>
        <span style={S.title}>Preferences</span>
        <div style={{ display: "flex", gap: isMobile ? 10 : 16, marginTop: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ ...S.microLabel, marginBottom: 6 }}>UNITS</div>
            <div style={{ display: "flex" }}>
              {["lb", "kg"].map((u, i) => (
                <button key={u} onClick={() => setWs({ unit: u, bar: u === "kg" ? 20 : 45 })}
                  style={{ padding: "9px 16px", fontSize: 11.5, fontWeight: 700, fontFamily: syne, cursor: "pointer", background: unit === u ? T.brass : "var(--ink-a03)", border: `1px solid ${unit === u ? "var(--brass-a40)" : "var(--ink-a12)"}`, color: unit === u ? T.onBrass : T.sub, borderRadius: i === 0 ? "10px 0 0 10px" : "0 10px 10px 0", borderRight: i === 0 ? "none" : undefined }}>
                  {u}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ ...S.microLabel, marginBottom: 6 }}>BAR ({unit.toUpperCase()})</div>
            <NumField value={ws.bar} decimals width={64} style={{ padding: "9px 0", fontSize: 13 }} onChange={(v) => setWs({ bar: v })} />
          </div>
          <div>
            <div style={{ ...S.microLabel, marginBottom: 6 }}>DEFAULT REST (SEC)</div>
            <NumField value={ws.defaultRest} width={72} style={{ padding: "9px 0", fontSize: 13 }} onChange={(v) => setWs({ rest: v })} />
          </div>
        </div>
        <div style={{ fontSize: 9.5, color: T.faint, marginTop: 10 }}>Bar weight feeds the per-side plate math. Rest can be tuned per exercise during a session.</div>
      </div>
    </>
  );
}

// ─── Active session — the room where it happens ──────────────────────────────
function ActiveSession({ card, isMobile, active, setActive, bar, bestByEx, prevByEx, defaultRest, buildSessionExercise, onBack, onFinish, onDiscard }) {
  const [now, setNow] = useState(Date.now());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);

  const upd = (fn) => setActive((a) => ({ ...a, ...fn(a) }));
  const updEx = (exId, fn) => upd((a) => ({ exercises: a.exercises.map((e) => (e.id === exId ? { ...e, ...fn(e) } : e)) }));

  const elapsed = Math.floor((now - active.startedAt) / 1000);
  const doneSets = active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
  const volume = active.exercises.reduce((v, e) => v + e.sets.reduce((x, s) => x + (s.done ? (s.weight || 0) * (s.reps || 0) : 0), 0), 0);

  // one tap logs the set — and PR detection happens right here, live
  const toggleSet = (ex, set) => {
    if (set.done) { // undo a mis-tap, keep the numbers
      updEx(ex.id, (e) => ({ sets: e.sets.map((s) => (s.id === set.id ? { ...s, done: false, pr: false } : s)) }));
      return;
    }
    const inLb = (w) => conv(w, active.unit, "lb");
    const hasHistory = bestByEx.has(norm(ex.name)); // first-ever session of a lift is a baseline, not a PR
    let best = bestByEx.get(norm(ex.name)) || 0;
    for (const e of active.exercises) if (norm(e.name) === norm(ex.name))
      for (const s of e.sets) if (s.done && s.id !== set.id) best = Math.max(best, epley(inLb(s.weight), s.reps));
    const pr = hasHistory && set.weight > 0 && epley(inLb(set.weight), set.reps) > best;
    updEx(ex.id, (e) => ({ sets: e.sets.map((s) => (s.id === set.id ? { ...s, done: true, pr } : s)) }));
    if (ex.restSec > 0) upd(() => ({ rest: { until: Date.now() + ex.restSec * 1000, total: ex.restSec, label: ex.name } }));
  };

  const addSet = (ex) => updEx(ex.id, (e) => {
    const last = e.sets[e.sets.length - 1];
    return { sets: [...e.sets, { id: uuid(), weight: last?.weight ?? 0, reps: last?.reps ?? 8, done: false, prev: null }] };
  });
  const removeSet = (ex, setId) => updEx(ex.id, (e) => ({ sets: e.sets.filter((s) => s.id !== setId) }));
  const cycleRest = (ex) => updEx(ex.id, (e) => ({ restSec: REST_CYCLE[(REST_CYCLE.indexOf(e.restSec) + 1) % REST_CYCLE.length] ?? defaultRest }));
  const moveEx = (exId, dir) => upd((a) => {
    const i = a.exercises.findIndex((e) => e.id === exId), j = i + dir;
    if (j < 0 || j >= a.exercises.length) return {};
    const arr = [...a.exercises]; [arr[i], arr[j]] = [arr[j], arr[i]];
    return { exercises: arr };
  });
  const removeEx = (exId) => { if (window.confirm("Remove this exercise from today's session?")) upd((a) => ({ exercises: a.exercises.filter((e) => e.id !== exId) })); };
  const addExercise = (name) => { upd((a) => ({ exercises: [...a.exercises, buildSessionExercise(name)] })); setPickerOpen(false); };

  const restRemain = active.rest ? Math.ceil((active.rest.until - now) / 1000) : null;
  const resting = restRemain != null && restRemain > -5; // linger 5s in "GO" state
  const prCount = active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done && s.pr).length, 0);

  const doFinish = async (opts) => {
    setSaving(true); setSaveErr(null);
    try { await onFinish(opts); }
    catch (e) { setSaving(false); setSaveErr(e.message || "Couldn't save — check your connection."); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <button onClick={onBack} style={{ background: "none", border: "none", color: T.brass, fontFamily: syne, fontWeight: 700, fontSize: 12, cursor: "pointer", padding: 0, flex: "none" }}>‹ Overview</button>
          <button onClick={() => setFinishOpen(true)} style={{ ...S.brassBtn, padding: "9px 18px", fontSize: 11.5, flex: "none" }}>Finish</button>
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ ...S.microLabel, color: T.brass }}>IN SESSION</div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginTop: 3 }}>
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: syne, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{active.templateName}</span>
            <span style={{ fontSize: 15, fontFamily: mono, fontWeight: 600, color: T.ink, flex: "none" }}>{fmtClock(elapsed)}</span>
          </div>
          <div style={{ fontSize: 10.5, color: T.sub, marginTop: 4 }}>
            {doneSets} set{doneSets === 1 ? "" : "s"} · {fmtVol(volume)} {active.unit} volume{prCount ? <span style={{ color: T.brass, fontWeight: 700 }}> · ◆ {prCount} PR{prCount > 1 ? "s" : ""}</span> : null}
          </div>
        </div>
      </div>

      {active.exercises.length === 0 && (
        <div style={{ ...card, textAlign: "center", padding: "26px 20px" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, marginBottom: 4 }}>Empty session</div>
          <div style={{ fontSize: 10.5, color: T.sub }}>Add an exercise below to start logging.</div>
        </div>
      )}

      {active.exercises.map((ex, i) => (
        <ExerciseCard key={ex.id} card={card} isMobile={isMobile} ex={ex} index={i} count={active.exercises.length}
          unit={active.unit} bar={bar}
          onToggleSet={(s) => toggleSet(ex, s)}
          onSetChange={(setId, patch) => updEx(ex.id, (e) => ({ sets: e.sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)) }))}
          onAddSet={() => addSet(ex)} onRemoveSet={(setId) => removeSet(ex, setId)}
          onCycleRest={() => cycleRest(ex)} onMove={(d) => moveEx(ex.id, d)} onRemove={() => removeEx(ex.id)}
        />
      ))}

      <button onClick={() => setPickerOpen(true)} style={{ ...S.ghostBtn, padding: "12px 0", fontSize: 12 }}>+ Add exercise</button>

      {/* The rest meridian — starts itself, one tap to skip or extend */}
      {resting && (
        <div style={{ position: "sticky", bottom: isMobile ? 8 : 12, zIndex: 5, borderRadius: 12, overflow: "hidden", border: "1px solid var(--brass-a40)", background: T.surface, boxShadow: "var(--shadow-float)", animation: restRemain > 0 ? "breathe 2.6s ease-in-out infinite" : "none" }}>
          <div style={{ position: "absolute", inset: 0, width: `${Math.max(0, Math.min(100, (restRemain / active.rest.total) * 100))}%`, background: "var(--brass-a16)", transition: "width 0.5s linear" }} />
          <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ ...S.microLabel, color: restRemain > 0 ? T.brass : T.green }}>{restRemain > 0 ? "REST" : "GO"}</div>
              <div style={{ fontSize: 9.5, color: T.faint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{active.rest.label}</div>
            </div>
            <span style={{ fontSize: 22, fontFamily: mono, fontWeight: 600, color: restRemain > 0 ? T.ink : T.green, flex: "none" }}>{restRemain > 0 ? fmtClock(restRemain) : "0:00"}</span>
            <div style={{ display: "flex", gap: 6, flex: "none" }}>
              <button onClick={() => upd((a) => ({ rest: { ...a.rest, until: a.rest.until + 30000, total: a.rest.total + 30 } }))} style={{ ...S.ghostBtn, padding: "8px 11px", fontSize: 11 }}>+30s</button>
              <button onClick={() => upd(() => ({ rest: null }))} style={{ background: "none", border: `1px solid ${T.line}`, borderRadius: 8, color: T.sub, fontSize: 11, fontWeight: 700, fontFamily: syne, cursor: "pointer", padding: "8px 11px" }}>{restRemain > 0 ? "Skip" : "Clear"}</button>
            </div>
          </div>
        </div>
      )}

      {pickerOpen && <ExercisePicker isMobile={isMobile} onPick={addExercise} onClose={() => setPickerOpen(false)} />}
      {finishOpen && (
        <FinishSheet isMobile={isMobile} active={active} doneSets={doneSets} volume={volume} prCount={prCount} elapsed={elapsed}
          saving={saving} saveErr={saveErr}
          onSave={doFinish} onClose={() => setFinishOpen(false)}
          onDiscard={() => { if (window.confirm("Discard this workout? Nothing will be saved.")) { setFinishOpen(false); onDiscard(); } }}
        />
      )}
    </div>
  );
}

function ExerciseCard({ card, isMobile, ex, index, count, unit, bar, onToggleSet, onSetChange, onAddSet, onRemoveSet, onCycleRest, onMove, onRemove }) {
  const [showPlates, setShowPlates] = useState(false);
  const nextSet = ex.sets.find((s) => !s.done) || ex.sets[ex.sets.length - 1];
  const plates = nextSet ? plateBreakdown(nextSet.weight, unit, bar) : null;
  const arrow = { background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 11, padding: "1px 3px", lineHeight: 1 };
  const chip = { background: "var(--ink-a04)", border: "1px solid var(--ink-a10)", borderRadius: 999, color: T.sub, fontSize: 9.5, fontWeight: 700, cursor: "pointer", padding: "5px 10px", fontFamily: mono, letterSpacing: "0.03em", flex: "none" };

  return (
    <div style={{ ...card, padding: isMobile ? "14px 13px" : "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: "none" }}>
          <button onClick={() => onMove(-1)} disabled={index === 0} style={{ ...arrow, opacity: index === 0 ? 0.25 : 1 }} aria-label="move up">▲</button>
          <button onClick={() => onMove(1)} disabled={index === count - 1} style={{ ...arrow, opacity: index === count - 1 ? 0.25 : 1 }} aria-label="move down">▼</button>
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: syne, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ex.name}</span>
        <button onClick={onCycleRest} style={chip} title="Tap to change rest for this exercise">{ex.restSec > 0 ? `${ex.restSec}s rest` : "no rest"}</button>
        <button onClick={() => setShowPlates((v) => !v)} style={{ ...chip, color: showPlates ? T.brass : T.sub, borderColor: showPlates ? "var(--brass-a40)" : "var(--ink-a10)" }}>plates</button>
        <button onClick={onRemove} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 15, padding: 2, lineHeight: 1, flex: "none" }} aria-label="remove exercise">×</button>
      </div>

      {showPlates && plates && (
        <div style={{ ...S.inner, padding: "8px 11px", marginBottom: 10, fontSize: 10.5, color: T.sub, fontFamily: mono }}>
          {fmtW(nextSet.weight)} {unit} → <span style={{ color: T.brass, fontWeight: 700 }}>{plates.text}</span> <span style={{ color: T.faint }}>({fmtW(bar)} bar)</span>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {ex.sets.map((set, i) => (
          <div key={set.id} style={{ display: "flex", alignItems: "center", gap: 6, opacity: set.done ? 0.92 : 1 }}>
            <div style={{ width: 42, flex: "none", textAlign: "center" }}>
              <div style={{ fontSize: 12, fontWeight: 700, fontFamily: syne, color: set.done ? T.brass : T.sub }}>{roman(i + 1)}</div>
              <div style={{ fontSize: 8, fontFamily: mono, color: set.pr ? T.brass : T.faint, fontWeight: set.pr ? 700 : 400, whiteSpace: "nowrap" }}>
                {set.pr ? "◆ PR" : set.prev || "new"}
              </div>
            </div>
            <Stepper value={set.weight} step={unit === "kg" ? 2.5 : 5} inputWidth={isMobile ? 52 : 62} decimals onChange={(v) => onSetChange(set.id, { weight: v })} />
            <Stepper value={set.reps} step={1} inputWidth={isMobile ? 36 : 44} onChange={(v) => onSetChange(set.id, { reps: v })} />
            <button onClick={() => onToggleSet(set)} aria-label={set.done ? "undo set" : "log set"}
              style={{ width: 42, height: 42, flex: "none", borderRadius: 10, cursor: "pointer", fontSize: 16, fontWeight: 700, transition: "all 0.15s ease", ...(set.done ? { ...S.brassBtn, borderRadius: 10 } : { background: "var(--brass-a06)", border: "1.5px solid var(--brass-a40)", color: T.brass }) }}>
              ✓
            </button>
            <button onClick={() => onRemoveSet(set.id)} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 13, padding: 2, flex: "none", lineHeight: 1 }} aria-label="remove set">×</button>
          </div>
        ))}
      </div>
      <button onClick={onAddSet} style={{ background: "none", border: `1px dashed var(--brass-a40)`, borderRadius: 9, color: T.brass, fontSize: 10.5, fontWeight: 700, fontFamily: syne, cursor: "pointer", padding: "8px 0", width: "100%", marginTop: 9 }}>+ Add set</button>
    </div>
  );
}

// ─── exercise picker — search the library or type anything ───────────────────
function ExercisePicker({ isMobile, onPick, onClose }) {
  const [q, setQ] = useState("");
  const nq = norm(q);
  const groups = LIB.map(([g, items]) => [g, items.filter((n) => !nq || norm(n).includes(nq))]).filter(([, items]) => items.length);
  const exact = LIB.some(([, items]) => items.some((n) => norm(n) === nq));
  return (
    <SheetShell onClose={onClose} isMobile={isMobile}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={S.title}>Add exercise</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: T.faint, fontSize: 17, cursor: "pointer", padding: 2, lineHeight: 1 }}>×</button>
      </div>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, or type your own…"
        onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) onPick(q.trim()); }}
        style={{ ...S.input, width: "100%", padding: "11px 13px", fontSize: 13, marginBottom: 12 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: isMobile ? "48dvh" : 380, overflowY: "auto", paddingRight: 2 }}>
        {q.trim() && !exact && (
          <button onClick={() => onPick(q.trim())} style={{ ...S.ghostBtn, padding: "11px 13px", fontSize: 12, textAlign: "left" }}>
            + Add "{q.trim()}" as a custom exercise
          </button>
        )}
        {groups.map(([g, items]) => (
          <div key={g}>
            <div style={{ ...S.microLabel, marginBottom: 6 }}>{g.toUpperCase()}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {items.map((n) => (
                <button key={n} onClick={() => onPick(n)}
                  style={{ ...S.inner, padding: "10px 12px", fontSize: 12, color: T.ink, textAlign: "left", cursor: "pointer", fontWeight: 600 }}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && !q.trim() && <div style={{ fontSize: 11, color: T.faint, textAlign: "center", padding: "12px 0" }}>Nothing here.</div>}
      </div>
    </SheetShell>
  );
}

// ─── finish sheet — summary, notes, and the write-back toggle ─────────────────
function FinishSheet({ isMobile, active, doneSets, volume, prCount, elapsed, saving, saveErr, onSave, onClose, onDiscard }) {
  const [notes, setNotes] = useState("");
  const [updateTemplate, setUpdateTemplate] = useState(!!active.templateId);
  const stat = (label, val, color) => (
    <div style={{ ...S.inner, padding: "10px 12px", flex: 1, minWidth: 0 }}>
      <div style={S.microLabel}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, fontFamily: mono, color: color || T.ink, marginTop: 3 }}>{val}</div>
    </div>
  );
  return (
    <SheetShell onClose={onClose} isMobile={isMobile}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: syne }}>Finish workout</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: T.faint, fontSize: 17, cursor: "pointer", padding: 2, lineHeight: 1 }}>×</button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {stat("TIME", fmtDur(elapsed))}
        {stat("SETS", doneSets)}
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {stat("VOLUME", `${fmtVol(volume)} ${active.unit}`)}
        {stat("PRS", prCount ? `◆ ${prCount}` : "—", prCount ? T.brass : T.faint)}
      </div>
      {doneSets === 0 && <div style={{ fontSize: 10.5, color: T.amber, marginBottom: 12 }}>No sets logged yet — finishing now saves nothing. Discard instead, or go log a set.</div>}
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes — how it felt, anything to remember (optional)" rows={2}
        style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 12.5, resize: "vertical", marginBottom: 12 }} />
      {active.templateId && (
        <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", marginBottom: 14, ...S.inner, padding: "11px 12px" }}>
          <input type="checkbox" checked={updateTemplate} onChange={(e) => setUpdateTemplate(e.target.checked)} style={{ accentColor: T.brass, width: 16, height: 16, flex: "none" }} />
          <span style={{ fontSize: 11.5, color: T.ink }}>Update <b>{active.templateName}</b> with today's weights, reps & set counts</span>
        </label>
      )}
      {saveErr && <div style={{ fontSize: 10.5, color: T.red, marginBottom: 10 }}>{saveErr}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => onSave({ notes, updateTemplate })} disabled={saving || doneSets === 0}
          style={{ ...S.brassBtn, flex: 1, padding: "12px 0", fontSize: 12.5, opacity: doneSets === 0 ? 0.45 : 1 }}>
          {saving ? "Saving…" : "Save workout"}
        </button>
        <button onClick={onClose} style={{ ...S.ghostBtn, padding: "12px 18px", fontSize: 12.5 }}>Keep going</button>
      </div>
      <button onClick={onDiscard} style={{ background: "none", border: "none", color: T.red, fontSize: 10.5, fontWeight: 700, cursor: "pointer", padding: "12px 0 0", width: "100%", fontFamily: syne }}>Discard workout</button>
    </SheetShell>
  );
}

// ─── Routines — list + builder ────────────────────────────────────────────────
function RoutineList({ card, templates, onNew, onEdit, onStart }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={S.title}>Routines</span>
        <button onClick={onNew} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11.5 }}>+ New routine</button>
      </div>
      {templates === null ? (
        <div style={{ fontSize: 11.5, color: T.faint, padding: "16px 0", textAlign: "center", animation: "pulse 1.4s infinite" }}>Loading…</div>
      ) : templates.length === 0 ? (
        <div style={{ fontSize: 11.5, color: T.faint, padding: "20px 0", textAlign: "center" }}>No routines yet — tap "+ New routine" to build one.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {templates.map((t) => (
            <div key={t.id} style={{ ...S.inner, padding: "11px 13px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
                <div style={{ fontSize: 10, color: T.faint, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {(t.exercises || []).map((e) => e.name).join(" · ") || "Empty"}
                </div>
              </div>
              <button onClick={() => onEdit(t)} style={{ ...S.ghostBtn, padding: "8px 14px", fontSize: 11, flex: "none" }}>Edit</button>
              <button onClick={() => onStart(t)} style={{ ...S.brassBtn, padding: "8px 14px", fontSize: 11, flex: "none" }}>Start</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RoutineEditor({ card, isMobile, unit, defaultRest, initial, nextPosition, onSave, onDelete, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const [exercises, setExercises] = useState(() => (initial?.exercises || []).map((e) => ({ ...e, id: e.id || uuid(), weight: Math.round((conv(e.weight, initial?.unit || "lb", unit) || 0) * 10) / 10 })));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const updEx = (id, patch) => setExercises((arr) => arr.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const move = (id, dir) => setExercises((arr) => {
    const i = arr.findIndex((e) => e.id === id), j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    const next = [...arr]; [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const numField = (val, onCh, w = 52, dec = false) => <NumField value={val} onChange={onCh} width={w} decimals={dec} />;

  const save = () => {
    if (!name.trim()) { setErr("Name the routine."); return; }
    if (!exercises.length) { setErr("Add at least one exercise."); return; }
    setSaving(true); setErr(null);
    onSave({ id: initial?.id || uuid(), name: name.trim(), unit, exercises, position: initial?.position ?? nextPosition })
      .catch((e) => { setSaving(false); setErr(e.message || "Couldn't save."); });
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: T.brass, fontFamily: syne, fontWeight: 700, fontSize: 12, cursor: "pointer", padding: 0 }}>‹ Routines</button>
        <span style={S.microLabel}>{initial ? "EDITING" : "NEW ROUTINE"}</span>
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Routine name — e.g. Push Day"
        style={{ ...S.input, width: "100%", padding: "11px 13px", fontSize: 14, fontWeight: 700, fontFamily: syne, marginBottom: 12 }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {exercises.map((ex, i) => (
          <div key={ex.id} style={{ ...S.inner, padding: "11px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
              <div style={{ display: "flex", flexDirection: "column", flex: "none" }}>
                <button onClick={() => move(ex.id, -1)} disabled={i === 0} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 10, padding: "1px 3px", lineHeight: 1, opacity: i === 0 ? 0.25 : 1 }}>▲</button>
                <button onClick={() => move(ex.id, 1)} disabled={i === exercises.length - 1} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 10, padding: "1px 3px", lineHeight: 1, opacity: i === exercises.length - 1 ? 0.25 : 1 }}>▼</button>
              </div>
              <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ex.name}</span>
              <button onClick={() => setExercises((arr) => arr.filter((e) => e.id !== ex.id))} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 14, padding: 2, lineHeight: 1 }} aria-label="remove">×</button>
            </div>
            <div style={{ display: "flex", gap: isMobile ? 8 : 14, flexWrap: "wrap" }}>
              <div><div style={{ ...S.microLabel, marginBottom: 4 }}>SETS</div>{numField(ex.targetSets ?? 3, (v) => updEx(ex.id, { targetSets: v }), 44)}</div>
              <div><div style={{ ...S.microLabel, marginBottom: 4 }}>REPS</div>{numField(ex.targetReps ?? 8, (v) => updEx(ex.id, { targetReps: v }), 44)}</div>
              <div><div style={{ ...S.microLabel, marginBottom: 4 }}>WEIGHT ({unit.toUpperCase()})</div>{numField(ex.weight ?? 0, (v) => updEx(ex.id, { weight: v }), 60, true)}</div>
              <div><div style={{ ...S.microLabel, marginBottom: 4 }}>REST (SEC)</div>{numField(ex.restSec ?? defaultRest, (v) => updEx(ex.id, { restSec: v }), 52)}</div>
            </div>
          </div>
        ))}
      </div>

      <button onClick={() => setPickerOpen(true)} style={{ ...S.ghostBtn, width: "100%", padding: "11px 0", fontSize: 11.5, marginTop: 10 }}>+ Add exercise</button>
      {err && <div style={{ fontSize: 10.5, color: T.red, marginTop: 10 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={save} disabled={saving} style={{ ...S.brassBtn, flex: 1, padding: "11px 0", fontSize: 12 }}>{saving ? "Saving…" : "Save routine"}</button>
        <button onClick={onCancel} style={{ ...S.ghostBtn, padding: "11px 18px", fontSize: 12 }}>Cancel</button>
      </div>
      {initial && (
        <button onClick={() => { if (window.confirm("Delete this routine? Past sessions stay in History.")) onDelete(initial.id); }}
          style={{ background: "none", border: "none", color: T.red, fontSize: 10.5, fontWeight: 700, cursor: "pointer", padding: "12px 0 0", width: "100%", fontFamily: syne }}>
          Delete routine
        </button>
      )}
      {pickerOpen && (
        <ExercisePicker isMobile={isMobile}
          onPick={(n) => { setExercises((arr) => [...arr, { id: uuid(), name: n, targetSets: 3, targetReps: 8, weight: 0, restSec: defaultRest }]); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}

// ─── History — sessions, per-lift trend, CSV export ──────────────────────────
function HistoryView({ card, isMobile, sessions, unit, onDelete }) {
  const [openId, setOpenId] = useState(null);
  const [trendEx, setTrendEx] = useState("");

  const exNames = useMemo(() => {
    const freq = new Map();
    for (const s of sessions || []) for (const ex of s.exercises || []) freq.set(ex.name, (freq.get(ex.name) || 0) + 1);
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  }, [sessions]);
  useEffect(() => { if (!trendEx && exNames.length) setTrendEx(exNames[0]); }, [exNames, trendEx]);

  const trend = useMemo(() => {
    if (!trendEx) return [];
    const pts = [];
    for (const s of [...(sessions || [])].reverse()) {
      let best = 0;
      for (const ex of s.exercises || []) if (norm(ex.name) === norm(trendEx))
        for (const x of ex.sets || []) best = Math.max(best, epley(conv(x.weight, s.unit || "lb", unit), x.reps));
      if (best > 0) pts.push({ t: new Date(s.started_at).getTime(), v: best });
    }
    return pts;
  }, [sessions, trendEx, unit]);

  const exportCsv = () => {
    const rows = [["date", "routine", "exercise", "set", "weight", "unit", "reps", "est_1rm"]];
    for (const s of sessions || []) for (const ex of s.exercises || []) (ex.sets || []).forEach((x, i) => {
      rows.push([s.started_at, (s.template_name || "Quick session").replace(/,/g, " "), ex.name.replace(/,/g, " "), i + 1, x.weight, s.unit || "lb", x.reps, Math.round(epley(x.weight, x.reps))]);
    });
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "board-room-workouts.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (sessions === null) return <div style={{ ...card, fontSize: 11.5, color: T.faint, textAlign: "center", animation: "pulse 1.4s infinite" }}>Loading history…</div>;
  if (!sessions.length) return <div style={{ ...card, fontSize: 11.5, color: T.faint, textAlign: "center", padding: "26px 20px" }}>Nothing logged yet — your first finished workout lands here.</div>;

  const bestPt = trend.reduce((m, p) => (p.v > m ? p.v : m), 0);

  return (
    <>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
          <span style={S.title}>Progress</span>
          <select value={trendEx} onChange={(e) => setTrendEx(e.target.value)} style={{ ...S.input, padding: "7px 10px", fontSize: 11.5, maxWidth: isMobile ? 170 : 260 }}>
            {exNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        {trend.length >= 2 ? (
          <>
            <TrendLine points={trend} />
            <div style={{ display: "flex", gap: 16, marginTop: 10 }}>
              <span style={{ fontSize: 10, color: T.sub, fontFamily: mono }}>BEST EST 1RM <b style={{ color: T.brass }}>{fmtW(bestPt)} {unit}</b></span>
              <span style={{ fontSize: 10, color: T.sub, fontFamily: mono }}>LATEST <b style={{ color: T.ink }}>{fmtW(trend[trend.length - 1].v)} {unit}</b></span>
              <span style={{ fontSize: 10, color: T.faint, fontFamily: mono }}>{trend.length} SESSIONS</span>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: T.faint, padding: "10px 0" }}>Log {trendEx || "a lift"} twice and the trend line appears here.</div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={S.title}>Sessions</span>
          <button onClick={exportCsv} style={{ ...S.ghostBtn, padding: "7px 13px", fontSize: 10.5 }}>Export CSV</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sessions.map((s) => {
            const open = openId === s.id;
            return (
              <div key={s.id} style={{ ...S.inner, padding: "11px 13px" }}>
                <div onClick={() => setOpenId(open ? null : s.id)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, fontFamily: syne, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.template_name || "Quick session"}{s.pr_count ? <span style={{ color: T.brass }}> · ◆{s.pr_count}</span> : null}
                    </div>
                    <div style={{ fontSize: 9.5, color: T.faint, fontFamily: mono, marginTop: 2 }}>
                      {fmtDate(s.started_at)} · {s.duration_sec ? fmtDur(s.duration_sec) : "—"} · {s.total_sets || 0} sets · {fmtVol(s.total_volume || 0)} {s.unit}
                    </div>
                  </div>
                  <span style={{ color: T.faint, fontSize: 11, flex: "none", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>›</span>
                </div>
                {open && (
                  <div style={{ marginTop: 10, borderTop: `1px solid ${T.line}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {(s.exercises || []).map((ex, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: T.ink, flex: "none", minWidth: 0 }}>{ex.name}</span>
                        <span style={{ fontSize: 10, color: T.sub, fontFamily: mono }}>
                          {(ex.sets || []).map((x, j) => <span key={j}>{j > 0 ? ", " : ""}{fmtW(x.weight)}×{x.reps}{x.pr ? <span style={{ color: T.brass }}>◆</span> : ""}</span>)}
                        </span>
                      </div>
                    ))}
                    {s.notes && <div style={{ fontSize: 10.5, color: T.sub, fontStyle: "italic" }}>"{s.notes}"</div>}
                    <button onClick={() => { if (window.confirm("Delete this session from history?")) onDelete(s.id); }}
                      style={{ background: "none", border: "none", color: T.red, fontSize: 10, fontWeight: 700, cursor: "pointer", padding: "4px 0 0", textAlign: "left", fontFamily: syne }}>
                      Delete session
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function TrendLine({ points }) {
  const W = 300, H = 64, P = 6;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const x = (i) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  const d = points.map((p, i) => `${x(i)},${y(p.v)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <polyline points={d} fill="none" stroke={T.brass} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(last.v)} r="3.2" fill={T.brass} stroke={T.surface} strokeWidth="1.5" />
    </svg>
  );
}
