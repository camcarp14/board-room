// ─── Today — the prescribed session ──────────────────────────────────────────
// The tab's landing screen, and the answer to the only question that actually
// stops people practising: what should I do for the next twenty-five minutes.
//
// THE SESSION IS PRESCRIBED, NOT CHOSEN. Ericsson's definition of deliberate
// practice presupposes a coach supplying the diagnosis, and a self-taught player
// fails on exactly that clause — they practise what they can already do. So the
// plan is built by lib/guitar/practice.js from what has decayed, what is overdue
// and what is still being acquired, and "free practice" is a button rather than
// a default.
//
// WHAT IS ON SCREEN IS ALWAYS ONE THING. A session runner that shows the whole
// plan is a to-do list; one that shows the current block, its timer, and the
// rating buttons is something you can do with a guitar in your hands. Everything
// else is one tap away and none of it is in the way.
//
// THE LOG SURVIVES EVERYTHING. Every rating and every block transition is
// checkpointed to localStorage, because a dead battery, a reload or a
// backgrounded PWA must not cost twenty minutes of work. The row is written to
// Supabase at the end and the checkpoint is cleared only once it has landed.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, StatTile, Button, Segmented,
  EmptyState, Grid, useConfirm, TextArea,
} from "../../ui/kit.jsx";
import { IcCheck, IcClose, IcClock, IcChevronRight } from "../../ui/icons.jsx";
import {
  buildSession, completeSession, streak, weeklyMinutes, dayOf, dueItems,
  currentStrength, bandFor, nextReviewDays, rollingAccuracy, difficultyVerdict, isAcquisition,
} from "../../lib/guitar/practice.js";
import { SKILLS, LEVELS, levelState, schedulableSkills, skillById, drillByKey, cuesFor, BENCHMARKS } from "../../lib/guitar/library.js";
import {
  useGuitarSessions, useGuitarSkills, useGuitarSongs, useSaveGuitarSession,
  loadActiveSession, saveActiveSession, clearActiveSession, GUITAR_SETUP_SQL,
} from "../../data/guitar.js";
import ChordDiagram from "./ChordDiagram.jsx";
import { lookupChord } from "../../lib/guitar/chords.js";

const MINUTE_CHOICES = [10, 15, 25, 40];
const RATINGS = [
  { key: "clean", label: "Clean", tone: "var(--green)", help: "All of it, at tempo." },
  { key: "shaky", label: "Shaky", tone: "var(--amber)", help: "Got through it, not clean." },
  { key: "rough", label: "Rough", tone: "var(--red)", help: "Not there yet." },
];

const fmtClock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

// ─── the setup card ──────────────────────────────────────────────────────────
function SetupCard() {
  const [copied, setCopied] = useState(false);
  return (
    <Card pad="lg">
      <div className="t-title2" style={{ marginBottom: 6 }}>One-time setup</div>
      <div className="t-body" style={{ color: "var(--sub)", lineHeight: 1.6, marginBottom: 12 }}>
        The Guitar tab keeps your practice log, your skill state and your repertoire in your own
        Supabase. Run this once in the SQL editor and everything on this page starts saving.
        Nothing here is sent anywhere else.
      </div>
      <pre style={{
        background: "var(--surface-2)", borderRadius: "var(--r-well)", padding: 12, overflow: "auto",
        fontSize: 11, lineHeight: 1.5, maxHeight: 260, margin: 0, fontFamily: "var(--font-mono)", color: "var(--sub)",
      }}>{GUITAR_SETUP_SQL}</pre>
      <Button kind="tinted" full style={{ marginTop: 10 }}
        onClick={() => { navigator.clipboard?.writeText(GUITAR_SETUP_SQL); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
        {copied ? "Copied" : "Copy the SQL"}
      </Button>
    </Card>
  );
}

// ─── the runner ──────────────────────────────────────────────────────────────
function BlockRunner({ plan, active, onUpdate, onFinish, onAbandon, songs }) {
  const block = plan.blocks[active.blockIndex] || null;
  const [remaining, setRemaining] = useState(active.remaining ?? block?.seconds ?? 0);
  const [paused, setPaused] = useState(false);
  const [note, setNote] = useState(active.note || "");
  const tickRef = useRef(null);
  // The item inside a skill block. Interleaved blocks rotate through the picks
  // every 60–90 seconds; blocked ones stay on one until it is rated.
  const [itemIndex, setItemIndex] = useState(0);

  // THE TIMER IS DRIVEN OFF A TIMESTAMP, NOT A COUNTER. `setInterval` in a
  // backgrounded tab is throttled to once a second at best and stops entirely on
  // iOS, so a decrementing counter loses however long the phone was in a pocket
  // and a five-minute block becomes forty. Storing the deadline and subtracting
  // means the clock is right the moment the screen comes back.
  const deadline = useRef(Date.now() + (active.remaining ?? block?.seconds ?? 0) * 1000);
  useEffect(() => {
    deadline.current = Date.now() + (active.remaining ?? block?.seconds ?? 0) * 1000;
    setRemaining(active.remaining ?? block?.seconds ?? 0);
    setItemIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.blockIndex]);

  useEffect(() => {
    if (paused || !block) return undefined;
    const tick = () => setRemaining(Math.max(0, Math.round((deadline.current - Date.now()) / 1000)));
    tick();
    tickRef.current = setInterval(tick, 250);
    return () => clearInterval(tickRef.current);
  }, [paused, block, active.blockIndex]);

  // Pausing moves the deadline rather than freezing a counter, so the two ways of
  // measuring time cannot drift apart.
  const togglePause = () => {
    if (paused) deadline.current = Date.now() + remaining * 1000;
    setPaused((p) => !p);
  };

  if (!block) return null;

  const isLast = active.blockIndex >= plan.blocks.length - 1;
  const items = block.items || [];
  const item = items[itemIndex] || null;
  const rated = new Set(active.results.map((r) => r.id));
  const skill = item ? skillById(item.id) : null;
  const drill = block.kind === "skill" && skill
    ? drillByKey(skill.kind === "change" ? "omc" : skill.kind === "chord" ? "chord_perfect" : skill.kind === "fretboard" ? "note_finder" : "ladder")
    : block.kind === "warmup" ? drillByKey("chromatic")
      : block.kind === "sharpen" ? drillByKey(block.focus === "ear" ? "degrees" : "note_finder")
        : block.kind === "song" ? drillByKey("runthrough") : null;

  const rate = (rating) => {
    if (!item) return;
    const seconds = Math.round((block.seconds || 0) / Math.max(1, items.length));
    const results = [...active.results.filter((r) => r.id !== item.id), { id: item.id, name: item.name, rating, bpm: item.bpm ?? null, seconds }];
    const nextIndex = itemIndex + 1;
    onUpdate({ ...active, results, remaining });
    if (nextIndex < items.length) setItemIndex(nextIndex);
  };

  const nextBlock = () => {
    if (isLast) { onFinish({ ...active, note }); return; }
    const nextIdx = active.blockIndex + 1;
    onUpdate({ ...active, blockIndex: nextIdx, remaining: plan.blocks[nextIdx]?.seconds ?? 0, note });
  };

  const cues = cuesFor(skill?.kind || block.kind).slice(0, 2);
  const chordSym = skill?.chord || (skill?.pair ? skill.pair[Math.min(1, itemIndex % 2)] : null);
  const chord = chordSym ? lookupChord(chordSym) : null;
  // The LIVE row wins, the frozen one is the fallback. The plan is frozen into
  // the checkpoint when the session starts, so a song edited between blocks
  // would otherwise show its old chart for the rest of the session. Written the
  // other way round it read as a fallback and was dead code: with `block.song`
  // truthy the find never ran, and with it falsy the find looked up `undefined`.
  const song = (block.song && songs?.find((s) => s.id === block.song.id)) || block.song || null;

  return (
    <Card pad="lg" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* where you are */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {plan.blocks.map((b, i) => (
          <span key={b.kind + i} aria-hidden style={{
            flex: b.seconds, height: 4, borderRadius: 999,
            background: i < active.blockIndex ? "var(--accent)" : i === active.blockIndex ? "var(--accent-a40)" : "var(--ink-a08)",
          }} />
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="t-label" style={{ color: "var(--accent)" }}>{block.title}</div>
          <div className="t-title2" style={{ marginTop: 2 }}>
            {block.kind === "skill" ? (item?.name || "Skill block")
              : block.kind === "song" ? (song?.title || "Song work")
                : block.kind === "sharpen" ? (block.focus === "ear" ? "Scale degrees by ear" : "Note Finder")
                  : block.title}
          </div>
          {block.kind === "skill" && items.length > 1 && (
            <div className="t-foot" style={{ color: "var(--faint)", marginTop: 3 }}>
              {block.schedule === "interleaved" ? "Interleaved" : "One at a time"} · {itemIndex + 1} of {items.length}
              {rated.size ? ` · ${rated.size} rated` : ""}
            </div>
          )}
        </div>
        <button type="button" onClick={togglePause} aria-label={paused ? "Resume" : "Pause"}
          style={{
            border: "none", background: "none", cursor: "pointer", textAlign: "right", padding: 0,
            color: remaining <= 10 && !paused ? "var(--amber)" : "var(--ink)",
          }}>
          <div className="t-num" style={{ fontSize: 34, fontWeight: 700, lineHeight: 1 }}>{fmtClock(remaining)}</div>
          <div className="t-cap" style={{ color: "var(--faint)", marginTop: 2 }}>{paused ? "Paused — tap to go" : "Tap to pause"}</div>
        </button>
      </div>

      {/* what to actually do */}
      {drill && (
        <div style={{ background: "var(--surface-2)", borderRadius: "var(--r-well)", padding: 12 }}>
          <div className="t-head" style={{ marginBottom: 4 }}>{drill.name}</div>
          <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.55 }}>{drill.about}</div>
        </div>
      )}

      {block.kind === "break" && (
        <div className="t-body" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
          Hands off the guitar. This one is not optional — the gains from the last block are
          consolidating right now, and they do it better if you stop.
        </div>
      )}

      {chord?.voicings?.length > 0 && (
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          {(skill?.pair || [chordSym]).map((sym) => {
            const v = lookupChord(sym)?.voicings?.[0];
            return v ? <ChordDiagram key={sym} frets={v.frets} fingers={v.fingers} barre={v.barre} label={sym} size={116} /> : null;
          })}
          {skill?.pair && (
            <div className="t-call" style={{ color: "var(--sub)", flex: 1, minWidth: 160, lineHeight: 1.55 }}>
              Sixty seconds, count the changes. {BENCHMARKS.omc.map((b) => `${b.n} = ${b.label.toLowerCase()}`).join(" · ")}.
            </div>
          )}
        </div>
      )}

      {song && block.kind === "song" && (
        <div>
          <div className="t-head">{song.title}<span className="t-foot" style={{ color: "var(--faint)", fontWeight: 400 }}>{song.artist ? ` · ${song.artist}` : ""}</span></div>
          {(song.sections || []).map(([name, line]) => (
            <div key={name} style={{ marginTop: 6 }}>
              <span className="t-cap" style={{ color: "var(--faint)" }}>{name}</span>
              <div className="t-num" style={{ fontSize: 13.5, color: "var(--ink)", letterSpacing: "0.02em", marginTop: 2 }}>{line}</div>
            </div>
          ))}
        </div>
      )}

      {cues.length > 0 && block.kind !== "break" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cues.map((c) => (
            <div key={c.key} style={{ borderLeft: "2px solid var(--amber-a35)", paddingLeft: 10 }}>
              <div className="t-foot" style={{ color: "var(--ink)", fontWeight: 600 }}>{c.symptom}</div>
              <div className="t-foot" style={{ color: "var(--sub)", marginTop: 2, lineHeight: 1.5 }}>{c.fix}</div>
            </div>
          ))}
        </div>
      )}

      {block.kind === "log" && (
        <TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="What worked, what didn't, where to start next time." />
      )}

      {/* the rating — the only feedback loop this tab has, so it is one tap */}
      {block.kind === "skill" && item && (
        <div>
          <div className="t-label" style={{ color: "var(--sub)", marginBottom: 6 }}>How did {item.name} go?</div>
          <div style={{ display: "flex", gap: 8 }}>
            {RATINGS.map((r) => {
              const chosen = active.results.find((x) => x.id === item.id)?.rating === r.key;
              return (
                <button key={r.key} type="button" onClick={() => rate(r.key)}
                  style={{
                    flex: 1, minHeight: 52, border: "none", cursor: "pointer", borderRadius: "var(--r-ctl)",
                    background: chosen ? `color-mix(in srgb, ${r.tone} 18%, transparent)` : "var(--surface-2)",
                    color: chosen ? r.tone : "var(--sub)", fontWeight: 650, fontSize: 14,
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
                  }}>
                  <span>{r.label}</span>
                  <span className="t-cap" style={{ color: "var(--faint)", fontWeight: 400, fontSize: 10.5 }}>{r.help}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="quiet" onClick={onAbandon} style={{ flex: "none" }}>End</Button>
        <Button kind="primary" size="lg" full onClick={nextBlock}>
          {isLast ? "Finish and log it" : `Next — ${plan.blocks[active.blockIndex + 1]?.title}`}
        </Button>
      </div>
    </Card>
  );
}

// ─── the panel ───────────────────────────────────────────────────────────────
export function TodayPanel({ isMobile, settings, updateSetting, onOpenTuner, onOpenMetronome, onJump }) {
  const gs = settings?.guitar || {};
  const sessionsQ = useGuitarSessions();
  const skillsQ = useGuitarSkills();
  const songsQ = useGuitarSongs();
  const save = useSaveGuitarSession();
  const [confirmEl, confirm] = useConfirm();

  const [minutes, setMinutes] = useState(Number(gs.minutes) || 25);
  const [active, setActive] = useState(() => loadActiveSession());
  const [toast, setToast] = useState(null);

  const today = dayOf(Date.now());
  const sessions = sessionsQ.data?.rows || [];
  const skillRows = skillsQ.data?.rows || [];
  const songs = songsQ.songs || [];
  const setup = sessionsQ.data?.setup || skillsQ.data?.setup || songsQ.setup;
  const loading = sessionsQ.isPending || skillsQ.isPending;
  const failed = sessionsQ.error || skillsQ.error;

  // A skill the database has never seen still has to be schedulable, so the
  // curriculum is the source of the ITEM LIST and the table is the source of its
  // state. Merging the other way round (rows first) would mean a fresh account
  // had nothing to practise.
  const skills = useMemo(() => {
    const byId = new Map(skillRows.map((r) => [r.id, r]));
    return SKILLS.map((s) => ({ ...s, ...(byId.get(s.id) || { strength: 0, sessions: 0, minutes: 0, history: [] }) }));
  }, [skillRows]);

  const lastSession = sessions[0] || null;
  const days = sessions.map((s) => s.day);
  const st = streak(days, today);
  const weeks = weeklyMinutes(sessions, { today, weeks: 12 });
  const thisWeek = weeks[0] || { minutes: 0, sessions: 0, days: 0 };
  const owned = songs.filter((s) => s.status === "owned").length;
  // Strength is DECAYED before the gate reads it — a level does not stay unlocked
  // on the strength of work done last spring.
  // The highest level ever reached, kept in settings, so a fortnight off cannot
  // demote you — and cannot shrink the practice pool back to three items and
  // strand everything that just fell out of it. See the note on `floor` in
  // library.js; the simulation that found this is in the commit message.
  const lvl = levelState(
    Object.fromEntries(skills.map((s) => [s.id, { strength: currentStrength(s, today) }])),
    { songsOwned: owned, floor: Number(gs.level) || 0 });
  useEffect(() => {
    if (settings == null) return;
    if (lvl.computed.n <= (Number(gs.level) || 0)) return;
    updateSetting?.("guitar", { ...gs, level: lvl.computed.n });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lvl.computed.n, settings]);
  // Only what this level has actually reached, and no tools — see the note on
  // schedulableSkills. Without it, day one opens with "Transcribe by ear".
  const pool = useMemo(() => {
    const eligible = new Set(schedulableSkills(lvl.level.n).map((s) => s.id));
    return skills.filter((s) => eligible.has(s.id));
  }, [skills, lvl.level.n]);
  const plan = useMemo(
    () => buildSession(pool, { minutes, today, lastSession, songs: songs.filter((s) => s.status === "learning" || s.status === "polishing") }),
    [pool, minutes, today, lastSession, songs]);

  useEffect(() => { if (active) saveActiveSession(active); }, [active]);
  useEffect(() => {
    if (settings == null) return;
    if (Number(gs.minutes) === minutes) return;
    const t = setTimeout(() => updateSetting?.("guitar", { ...gs, minutes }), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes]);

  // THE PLAN IS FROZEN WHEN THE SESSION STARTS, and the runner reads the frozen
  // copy rather than the live one. `plan` is recomputed from the skill table, and
  // the skill table refetches — so a background invalidation ten minutes into a
  // session could hand the runner a different block list, with different items,
  // at whatever index it happened to be on. It is also what makes the session
  // survive a reload: the checkpoint carries the plan it was running, not a
  // recipe for building a new one.
  const start = () => {
    setActive({
      day: today, startedAt: Date.now(), blockIndex: 0,
      remaining: plan.blocks[0]?.seconds ?? 0, results: [], note: "",
      plan: { focus: plan.focus, minutes: plan.minutes, seconds: plan.seconds, schedule: plan.schedule, blocks: plan.blocks },
    });
  };

  const finish = async (a) => {
    const { session, skills: updated } = completeSession({ day: a.day, focus: a.plan?.focus || plan.focus }, a.results, skillRows);
    // The minutes logged are the minutes ELAPSED, not the minutes planned. A
    // session you cut short at eight minutes is an eight-minute session, and a
    // streak built out of intentions is not worth having.
    const elapsed = Math.max(1, Math.round((Date.now() - a.startedAt) / 60000));
    try {
      await save.mutateAsync({
        session: { ...session, minutes: elapsed, startedAt: new Date(a.startedAt).toISOString(), endedAt: new Date().toISOString(), note: a.note || "" },
        skills: updated.filter((s) => a.results.some((r) => r.id === s.id)),
      });
      clearActiveSession();
      setActive(null);
      setToast({ tone: "var(--green)", text: `${elapsed} minute${elapsed === 1 ? "" : "s"} logged.` });
    } catch (e) {
      // The checkpoint stays. Nothing is lost, and the message says so rather
      // than leaving a green tick over a write that did not land.
      setToast({ tone: "var(--red)", text: `Couldn't save: ${e.message || "the write didn't land"}. Your session is still here — try Finish again.` });
    }
  };

  const abandon = async () => {
    const keep = active?.results?.length > 0;
    const ok = await confirm({
      title: keep ? "Log what you did?" : "End the session?",
      message: keep
        ? `You rated ${active.results.length} item${active.results.length === 1 ? "" : "s"}. Log the session as it stands, or throw it away?`
        : "Nothing has been rated yet, so there is nothing to log.",
      confirmLabel: keep ? "Log it" : "End",
      cancelLabel: keep ? "Throw it away" : "Keep going",
    });
    if (keep && ok) { await finish(active); return; }
    if (!keep && !ok) return;
    clearActiveSession();
    setActive(null);
  };

  if (setup) return <SetupCard />;
  if (failed) {
    return (
      <EmptyState icon="⚠️" title="Couldn't load your practice log"
        sub={failed.message || "The read didn't come back. Nothing you've saved is affected."}
        action={<Button kind="tinted" onClick={() => { sessionsQ.refetch(); skillsQ.refetch(); }}>Try again</Button>} />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {confirmEl}

      {/* a checkpoint that outlived its session */}
      {active?.stale && (
        <Card pad="md" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div className="t-head">A session from earlier is still open</div>
            <div className="t-foot" style={{ color: "var(--sub)", marginTop: 2 }}>
              Started {new Date(active.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, {active.results.length} item{active.results.length === 1 ? "" : "s"} rated.
            </div>
          </div>
          <Button kind="tinted" onClick={() => finish(active)}>Log it</Button>
          <Button kind="quiet" onClick={() => { clearActiveSession(); setActive(null); }}>Discard</Button>
        </Card>
      )}

      {active && !active.stale ? (
        <BlockRunner plan={active.plan || plan} active={active} songs={songs}
          onUpdate={setActive} onFinish={finish} onAbandon={abandon} />
      ) : (
        <>
          {/* the numbers */}
          <Grid min={isMobile ? 140 : 160} gap={10}>
            <StatTile value={st.current} label={st.current === 1 ? "day streak" : "day streak"}
              valueTone={st.practicedToday ? "var(--accent)" : undefined} />
            <StatTile value={`${thisWeek.minutes}m`} label="this week" />
            <StatTile value={owned} label="songs you own" />
            <StatTile value={`L${lvl.level.n}`} label={lvl.level.name} />
          </Grid>

          {/* the plan */}
          {loading ? (
            <div className="sk sk-card" />
          ) : (
            <Card pad="lg" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <div className="t-label" style={{ color: "var(--accent)" }}>Today</div>
                  <div className="t-title2" style={{ marginTop: 2 }}>{plan.focus}</div>
                </div>
                <div className="t-num" style={{ fontSize: 15, color: "var(--sub)" }}>{plan.minutes} min</div>
              </div>

              <Segmented options={MINUTE_CHOICES.map((m) => ({ key: m, label: `${m} min` }))} value={minutes} onChange={setMinutes} />

              <CellGroup>
                {plan.blocks.map((b, i) => (
                  <Cell key={b.kind + i}
                    leading={<span className="t-num" style={{ fontSize: 12 }}>{Math.round(b.seconds / 60)}′</span>}
                    title={b.kind === "skill" ? b.items.map((x) => x.name).join(" · ") || b.title
                      : b.kind === "song" ? (b.song?.title || "Song work")
                        : b.kind === "sharpen" ? (b.focus === "ear" ? "Scale degrees by ear" : "Note Finder")
                          : b.title}
                    sub={b.kind === "skill" ? (b.schedule === "interleaved" ? "Interleaved — rotate, don't grind" : "One at a time — this is new")
                      : b.kind === "break" ? "Hands off. Non-negotiable."
                        : b.kind === "warmup" ? "Chromatic permutation, 60–70 bpm"
                          : b.kind === "log" ? "What worked, what didn't" : null} />
                ))}
              </CellGroup>

              <Button kind="primary" size="lg" full onClick={start}>Start the session</Button>
              <div style={{ display: "flex", gap: 8 }}>
                <Button kind="quiet" full onClick={onOpenTuner}>Tune first</Button>
                <Button kind="quiet" full onClick={onOpenMetronome}>Metronome</Button>
              </div>
            </Card>
          )}

          {/* what is due, and what it means */}
          {!loading && (
            <Card pad="md">
              <SectionHeader title="What's slipping" trailing={`${dueItems(pool, today).filter((s) => s.overdue > 0 && s.sessions > 0).length} overdue`} />
              <CellGroup>
                {dueItems(pool, today).filter((s) => s.sessions > 0).slice(0, 6).map((s) => {
                  const acc = rollingAccuracy(s.history);
                  const verdict = difficultyVerdict(acc);
                  return (
                    <Cell key={s.id} title={s.name}
                      sub={`${bandFor(s.strengthNow).label}${s.overdue > 0 ? ` · ${s.overdue}d overdue` : ` · due in ${Math.max(0, nextReviewDays(s.strengthNow) - (0))}d`}${acc != null ? ` · ${acc}% clean` : ""}`}
                      value={Math.round(s.strengthNow)}
                      trailing={acc != null ? (
                        <span className="t-cap" style={{
                          color: verdict.key === "zone" ? "var(--green)" : verdict.key === "easy" ? "var(--blue)" : "var(--amber)",
                          fontWeight: 600,
                        }}>{verdict.key === "zone" ? "in the zone" : verdict.key === "easy" ? "too easy" : "too hard"}</span>
                      ) : null} />
                  );
                })}
                {!pool.some((s) => s.sessions > 0) && (
                  <Cell title="Nothing practised yet" sub="Run one session and this fills in — the schedule builds itself out of what you rate." />
                )}
              </CellGroup>
            </Card>
          )}

          {/* the level */}
          {!loading && (
            <Card pad="md">
              <SectionHeader title={`Level ${lvl.level.n} — ${lvl.level.name}`} trailing={lvl.level.weeks} />
              <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6, marginTop: 2 }}>{lvl.level.about}</div>
              <div style={{ marginTop: 10, background: "var(--surface-2)", borderRadius: "var(--r-well)", padding: 10 }}>
                <div className="t-cap" style={{ color: "var(--faint)", marginBottom: 4 }}>TO CLEAR THIS LEVEL</div>
                <div className="t-foot" style={{ color: "var(--ink)", lineHeight: 1.55 }}>{lvl.level.exit}</div>
                {(lvl.short?.length > 0 || lvl.songsShort > 0) && (
                  <div className="t-foot" style={{ color: "var(--amber)", marginTop: 6 }}>
                    Still short: {[
                      ...(lvl.short || []).map((id) => skillById(id)?.name || id),
                      lvl.songsShort ? `${lvl.songsShort} more song${lvl.songsShort === 1 ? "" : "s"}` : null,
                    ].filter(Boolean).join(", ")}
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* the log */}
          {!loading && sessions.length > 0 && (
            <Card pad="md">
              <SectionHeader title="Recent sessions" trailing={`${sessions.length} logged`} />
              <CellGroup>
                {sessions.slice(0, 6).map((s) => (
                  <Cell key={s.id} title={s.focus || "Practice"}
                    sub={`${new Date(`${s.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}${s.note ? ` · ${s.note.slice(0, 40)}${s.note.length > 40 ? "…" : ""}` : ""}`}
                    value={`${s.minutes}m`} />
                ))}
              </CellGroup>
            </Card>
          )}

          {/* the weeks */}
          {!loading && sessions.length > 0 && (
            <Card pad="md">
              <SectionHeader title="Minutes a week" trailing={`best ${Math.max(...weeks.map((w) => w.minutes))}m`} />
              <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 68, marginTop: 6 }}>
                {[...weeks].reverse().map((w) => {
                  const max = Math.max(1, ...weeks.map((x) => x.minutes));
                  return (
                    <div key={w.week} title={`${w.week}: ${w.minutes} min over ${w.days} day${w.days === 1 ? "" : "s"}`}
                      style={{
                        flex: 1, height: `${Math.max(3, (w.minutes / max) * 100)}%`, borderRadius: 3,
                        background: w.week === weeks[0].week ? "var(--accent)" : "var(--ink-a12)",
                      }} />
                  );
                })}
              </div>
              <div className="t-cap" style={{ color: "var(--faint)", marginTop: 6 }}>
                Twelve weeks. Frequency beats duration — two fifteen-minute days beat one thirty-minute one, because consolidation is sleep-gated.
              </div>
            </Card>
          )}
        </>
      )}

      {toast && (
        <div className="toasts">
          <div className="toast">
            <span className="tdot" style={{ background: toast.tone }} />
            <span>{toast.text}</span>
            <button onClick={() => setToast(null)} aria-label="Dismiss"
              style={{ background: "none", border: "none", color: "var(--accent)", fontWeight: 600, fontSize: 13.5, cursor: "pointer", padding: "6px 4px", margin: "-6px 0" }}>OK</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default TodayPanel;
