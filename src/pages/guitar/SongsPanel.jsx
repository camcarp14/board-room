// ─── Songs — the repertoire, which is the only metric that counts ────────────
// The headline number of this whole tab is songs you can play start to finish.
// Not accuracy, not minutes, not a streak: those are inputs, and a year of them
// with nothing to show is exactly the failure this is built against.
//
// THREE IN LEARNING, HARD CAP. The commonest self-taught failure is a pile of
// half-learned songs and nothing playable, because nothing ever forces a finish —
// the interesting eight bars get learned and the rest does not. A fourth song
// has to displace one, which turns "I'll come back to it" into a decision.
//
// A chart holds CHORDS AND STRUCTURE and nothing else. That is the part of a song
// this app has any business storing, and it happens to be the part you need.

import { useMemo, useState } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, Button, Segmented, Sheet, Field, TextArea,
  EmptyState, useConfirm, PillRow, Grid,
} from "../../ui/kit.jsx";
import { IcCheck, IcGuitar, IcPlus } from "../../ui/icons.jsx";
import { STRUM_PATTERNS, strumByKey, chartChords, parseBars } from "../../lib/guitar/library.js";
import { lookupChord } from "../../lib/guitar/chords.js";
import { buildBacking } from "../../lib/guitar/progression.js";
import { tuningByKey } from "../../lib/guitar/fretboard.js";
import { useGuitarSongs, useSaveGuitarSong, useDeleteGuitarSong } from "../../data/guitar.js";
import { dayOf } from "../../lib/guitar/practice.js";
import ChordDiagram from "./ChordDiagram.jsx";
import { PlayerBar } from "./PlayerBar.jsx";

const STATUSES = [
  { key: "learning", label: "Learning", cap: 3, blurb: "Three at a time. A fourth has to push one out." },
  { key: "polishing", label: "Polishing", blurb: "Playable end to end, not clean yet." },
  { key: "owned", label: "Owned", blurb: "Three clean run-throughs at tempo." },
  { key: "library", label: "Library", blurb: "Charts that ship with the app. Adding one copies it to yours." },
];

const DIFFICULTY = ["", "Day one", "Easy", "Moderate", "Hard", "Hard work"];

// ─── the chart ───────────────────────────────────────────────────────────────
// Bars, with the chords over them and a diagram for every distinct shape. The
// diagram strip is what makes a chart usable rather than a reminder — a chord
// name you cannot finger is not information.
function Chart({ song, tuning, isMobile, onPlaySection }) {
  const chords = chartChords(song.sections);
  const known = chords.map((sym) => ({ sym, hit: lookupChord(sym) }));
  const unknown = known.filter((k) => !k.hit?.voicings?.length).map((k) => k.sym);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Grid min={isMobile ? 104 : 118} gap={10}>
        {known.filter((k) => k.hit?.voicings?.length).map((k) => {
          const v = k.hit.voicings[0];
          return <ChordDiagram key={k.sym} frets={v.frets} fingers={v.fingers} barre={v.barre}
            label={k.sym} size={isMobile ? 100 : 114} tuning={tuning} />;
        })}
      </Grid>
      {unknown.length > 0 && (
        <div className="t-foot" style={{ color: "var(--amber)" }}>
          No verified shape for {unknown.join(", ")} — the chart still plays, but there is no diagram
          for those, and nothing here will draw a shape it hasn't checked.
        </div>
      )}
      {(song.sections || []).map(([name, line], i) => {
        const bars = parseBars(line) || [];
        return (
          <div key={`${name}${i}`}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
              <span className="t-label" style={{ color: "var(--sub)" }}>{name}</span>
              {onPlaySection && (
                <button type="button" className="sec-link" style={{ padding: "12px 8px", margin: "-12px -8px" }}
                  onClick={() => onPlaySection([[name, line]])}>Loop this</button>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
              {bars.map((b) => (
                <span key={b.bar} style={{
                  minWidth: 62, padding: "6px 8px", borderRadius: "var(--r-well)",
                  background: "var(--surface-2)", display: "flex", gap: 6, justifyContent: "center",
                }}>
                  {b.chords.map((c) => (
                    <span key={c} className="t-num" style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{c}</span>
                  ))}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── the editor ──────────────────────────────────────────────────────────────
function SongEditor({ song, onClose, onSave, onDelete, isMobile }) {
  const [draft, setDraft] = useState(() => ({
    id: song?.id, title: song?.title || "", artist: song?.artist || "",
    key: song?.key || "", bpm: song?.bpm || "", capo: song?.capo ?? 0,
    difficulty: song?.difficulty ?? 2, status: song?.status === "library" ? "learning" : (song?.status || "learning"),
    strum: song?.strum || "d_du", note: song?.note || "",
    text: (song?.sections || []).map(([n, l]) => `[${n}]\n${l}`).join("\n\n"),
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // Parsed live, so a typo is visible while you type rather than after you save.
  const parsed = useMemo(() => {
    const sections = [];
    let name = "Verse";
    const bad = [];
    for (const raw of draft.text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const head = line.match(/^\[(.+)\]$/);
      if (head) { name = head[1].trim(); continue; }
      if (!parseBars(line)) { bad.push(line); continue; }
      for (const b of parseBars(line)) for (const c of b.chords) if (!lookupChord(c)) bad.push(c);
      sections.push([name, line]);
    }
    return { sections, bad: [...new Set(bad)] };
  }, [draft.text]);

  const save = async () => {
    if (!draft.title.trim()) { setErr("It needs a title."); return; }
    if (!parsed.sections.length) { setErr("It needs at least one line of chords."); return; }
    setSaving(true); setErr(null);
    try {
      await onSave({
        ...draft, title: draft.title.trim(), artist: draft.artist.trim(),
        bpm: draft.bpm === "" ? null : Number(draft.bpm),
        capo: Number(draft.capo) || 0, sections: parsed.sections,
      });
      onClose();
    } catch (e) {
      // The sheet stays open with everything still in it. A "Saved" that did not
      // save is the one outcome this must never produce.
      setErr(e.message || "That didn't save. Nothing has been lost — try again.");
      setSaving(false);
    }
  };

  return (
    <Sheet title={song?.id ? "Edit song" : "Add a song"} onClose={onClose} detent={isMobile ? "large" : "auto"}
      footer={
        <>
          {song?.id && (
            <Button kind="quiet" size="lg" onClick={() => onDelete(song)} style={{ flex: "none" }}>Delete</Button>
          )}
          <Button kind="primary" size="lg" style={{ flex: 1 }} disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 6 }}>
        <Field placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <Field placeholder="Artist" value={draft.artist} onChange={(e) => setDraft({ ...draft, artist: e.target.value })} />
        <div style={{ display: "flex", gap: 8 }}>
          <Field placeholder="Key" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} style={{ flex: 1 }} />
          <Field placeholder="BPM" inputMode="numeric" value={draft.bpm} onChange={(e) => setDraft({ ...draft, bpm: e.target.value.replace(/\D/g, "") })} style={{ flex: 1 }} />
          <Field placeholder="Capo" inputMode="numeric" value={draft.capo} onChange={(e) => setDraft({ ...draft, capo: e.target.value.replace(/\D/g, "") })} style={{ flex: 1 }} />
        </div>

        <div>
          <div className="t-label" style={{ color: "var(--sub)", marginBottom: 6 }}>Where it lives</div>
          <Segmented options={STATUSES.filter((s) => s.key !== "library")} value={draft.status} onChange={(v) => setDraft({ ...draft, status: v })} />
        </div>

        <div>
          <div className="t-label" style={{ color: "var(--sub)", marginBottom: 6 }}>Strum</div>
          <PillRow options={STRUM_PATTERNS.map((p) => ({ key: p.key, label: p.name }))} value={draft.strum}
            onChange={(v) => setDraft({ ...draft, strum: v })} label="Strum pattern" />
          <div className="t-num" style={{ fontSize: 15, letterSpacing: "0.22em", color: "var(--ink)", marginTop: 6 }}>
            {strumByKey(draft.strum).pattern}
          </div>
        </div>

        <div>
          <div className="t-label" style={{ color: "var(--sub)", marginBottom: 6 }}>The chart</div>
          <TextArea rows={8} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            placeholder={"[Verse]\nC | G | Am | F\n\n[Chorus]\nF | C | G | G"}
            style={{ fontFamily: "var(--font-mono)", fontSize: 13.5 }} />
          <div className="t-cap" style={{ color: "var(--faint)", marginTop: 6, lineHeight: 1.5 }}>
            One line per phrase. Bars separated by <code>|</code>; two chords in a bar split it.
            A <code>[Section]</code> header names what follows.
          </div>
          {parsed.bad.length > 0 && (
            <div className="t-foot" style={{ color: "var(--amber)", marginTop: 6 }}>
              {/* "Skipped" was not true and was contradicted by the green line below,
                  which counted the very symbols this line rejects. The bar is saved,
                  drawn, and played silent — which is what Chart and PlayerBar both
                  say downstream. This now says the same thing they do. */}
              Can't read: {parsed.bad.slice(0, 6).join(", ")}{parsed.bad.length > 6 ? "…" : ""}. Those bars save and show, but play
              silent — nothing here will guess a shape it hasn't verified.
            </div>
          )}
          {parsed.sections.length > 0 && (
            <div className="t-foot" style={{ color: "var(--green)", marginTop: 6 }}>
              {/* Only the ones with a verified shape — counting the unreadable ones
                  here is what made the two lines disagree. */}
              {parsed.sections.length} line{parsed.sections.length === 1 ? "" : "s"}, {chartChords(parsed.sections).filter(lookupChord).length} playable chord{chartChords(parsed.sections).filter(lookupChord).length === 1 ? "" : "s"}.
            </div>
          )}
        </div>

        <TextArea rows={2} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          placeholder="Anything worth remembering — the capo, the tricky bar, the fingering." />

        {err && <div className="t-foot" style={{ color: "var(--red)" }}>{err}</div>}
      </div>
    </Sheet>
  );
}

// ─── the panel ───────────────────────────────────────────────────────────────
export function SongsPanel({ isMobile, settings, updateSetting }) {
  const gs = settings?.guitar || {};
  const tuning = tuningByKey(gs.tuning || "standard").midi;
  const { songs, isPending, error, refetch, setup } = useGuitarSongs();
  const saveSong = useSaveGuitarSong();
  const removeSong = useDeleteGuitarSong();
  const [confirmEl, confirm] = useConfirm();

  const [filter, setFilter] = useState("learning");
  const [open, setOpen] = useState(null);       // a song being viewed
  const [editing, setEditing] = useState(null); // a song being edited, or "new"
  const [playing, setPlaying] = useState(null); // { song, sections }
  const [toast, setToast] = useState(null);

  // THE BACKING TRACK IS MEMOISED, AND THAT IS LOAD-BEARING, NOT TIDINESS.
  // PlayerBar rebuilds its transport whenever the `backing` object identity
  // changes — it has to, because a new timeline is a new song. Built inline in
  // the JSX it was a NEW object on every render of this panel, and the shell
  // re-renders every tab every 30 seconds to move the clock. So a song stopped
  // dead half a minute in, the button still read Stop, and pressing it started
  // the count-in over. Nothing logged, nothing threw.
  const backing = useMemo(() => {
    if (!playing) return null;
    const strum = playing.song.strum || "d_du";
    // capo included: the chart tells you to put one on, so the track has to be in
    // the key the chart is actually in. See the note in buildBacking.
    return buildBacking({ sections: playing.sections, strum, swing: strumByKey(strum).swing || 0, repeats: 1, tuning, capo: playing.song.capo || 0 });
  }, [playing, tuning]);

  const byStatus = useMemo(() => {
    const m = { learning: [], polishing: [], owned: [], library: [], shelved: [] };
    for (const s of songs) (m[s.status] || m.library).push(s);
    return m;
  }, [songs]);
  const learningCount = byStatus.learning.length;

  // A SEED SONG KEEPS ITS OWN ID WHEN IT BECOMES A ROW. Sending `id: undefined`
  // made the database mint a fresh uuid, and the merge in data/guitar.js hides a
  // seed only when a saved row already carries the seed's id — so every edit
  // produced a second copy of the same song, one saved and one not, for ever.
  // guitar_songs.id is text precisely so a slug can be stored (see 0039).
  // THE CAP IS A FUNCTION, NOT A LINE INSIDE ONE HANDLER. It lived inside
  // setStatus, and setStatus is only reached from the Move-it row — so "Clean
  // run-through" on a library song (which promotes it to Learning on its own),
  // Save in the editor, and Write a chart all walked straight past it. Four taps
  // on four library songs put four songs in Learning, which is exactly the pile
  // of half-learned songs the cap exists to prevent.
  const capBlocked = async (song) => {
    if (!(learningCount >= 3 && song?.status !== "learning")) return false;
    // Informational, and the cap holds either way — the sheet has one button.
    await confirm({
      title: "Three at a time",
      message: `You already have ${learningCount} songs in Learning. That cap is the whole point — a fourth is how a pile of half-learned songs happens. Move one to Polishing first.`,
      confirmLabel: "OK", cancelLabel: false,
    });
    return true;
  };

  const setStatus = async (song, status) => {
    if (status === "learning" && await capBlocked(song)) return;
    try {
      const saved = await saveSong.mutateAsync({ ...song, status, lastPlayed: dayOf(Date.now()) });
      setOpen((o) => (o && o.id === song.id ? { ...o, status } : o));
      setToast({ tone: "var(--green)", text: `${song.title} → ${status}` });
      return saved;
    } catch (e) {
      setToast({ tone: "var(--red)", text: `Couldn't save: ${e.message || "the write didn't land"}` });
      return null;
    }
  };

  const logRun = async (song) => {
    // A library song's first clean run promotes it into Learning, so it is
    // subject to the cap like any other route in.
    if (song.status === "library" && await capBlocked(song)) return;
    // Clamped: an owned song logged a fourth time used to display "4/3".
    const runs = Math.min(3, (song.cleanRuns || 0) + 1);
    const status = runs >= 3 && song.status !== "owned" ? "owned" : song.status === "library" ? "learning" : song.status;
    try {
      await saveSong.mutateAsync({ ...song, cleanRuns: runs, status, lastPlayed: dayOf(Date.now()) });
      setOpen((o) => (o && o.id === song.id ? { ...o, cleanRuns: runs, status } : o));
      setToast({
        tone: "var(--green)",
        text: runs >= 3 ? `${song.title} is yours — three clean runs.` : `${runs} of 3 clean runs.`,
      });
    } catch (e) {
      setToast({ tone: "var(--red)", text: `Couldn't save: ${e.message || "the write didn't land"}` });
    }
  };

  const del = async (song) => {
    const ok = await confirm({
      title: `Delete ${song.title}?`, message: "The chart goes for good. If it came with the app it will reappear in Library.",
      confirmLabel: "Delete", destructive: true,
    });
    if (!ok) return;
    try { await removeSong.mutateAsync(song.id); setEditing(null); setOpen(null); }
    catch (e) { setToast({ tone: "var(--red)", text: `Couldn't delete: ${e.message || "the write didn't land"}` }); }
  };

  if (error) {
    return (
      <EmptyState icon={<IcGuitar size={24} />} title="Couldn't load your songs"
        sub={error.message || "The read didn't come back. Nothing you've saved is affected."}
        action={<Button kind="tinted" onClick={() => refetch()}>Try again</Button>} />
    );
  }

  const list = byStatus[filter] || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {confirmEl}

      <Segmented options={STATUSES.map((s) => ({ key: s.key, label: s.label, sub: String((byStatus[s.key] || []).length) }))}
        value={filter} onChange={setFilter} />

      <div className="t-cap" style={{ color: "var(--faint)", textAlign: "center" }}>
        {STATUSES.find((s) => s.key === filter)?.blurb}
      </div>

      {isPending ? <div className="sk sk-card" /> : list.length === 0 ? (
        <EmptyState icon={<IcGuitar size={24} />}
          title={filter === "owned" ? "Nothing owned yet" : filter === "learning" ? "Nothing on the go" : "Empty"}
          sub={filter === "owned"
            ? "A song is yours after three clean run-throughs at tempo. That's the bar, and it is the only number on this page worth chasing."
            : "Pick something from Library, or write your own chart."}
          action={<Button kind="tinted" onClick={() => setFilter("library")}>Open the library</Button>} />
      ) : (
        <Card pad="sm">
          <CellGroup>
            {list.map((s) => (
              <Cell key={s.id} title={s.title} sub={[s.artist, s.key, s.capo ? `capo ${s.capo}` : null, DIFFICULTY[s.difficulty] || null].filter(Boolean).join(" · ")}
                /* Learning too — that is where runs 1 and 2 are actually logged, and
                   the count was invisible there. It only ever appeared in a toast
                   you could dismiss. */
                value={["learning", "polishing", "owned"].includes(s.status) ? `${Math.min(3, s.cleanRuns || 0)}/3` : null}
                chevron onClick={() => setOpen(s)} />
            ))}
          </CellGroup>
        </Card>
      )}

      <Button kind="tinted" full onClick={() => setEditing("new")}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><IcPlus size={15} /> Write a chart</span>
      </Button>

      {setup && (
        <div className="t-cap" style={{ color: "var(--amber)", textAlign: "center" }}>
          Your own songs aren't saving yet — run the setup SQL on the Today tab. The library still works.
        </div>
      )}

      {/* one song */}
      {open && (
        <Sheet title={open.title} onClose={() => setOpen(null)} detent={isMobile ? "large" : "auto"}
          footer={
            <>
              <Button kind="quiet" size="lg" onClick={() => { setEditing(open); setOpen(null); }} style={{ flex: "none" }}>Edit</Button>
              <Button kind="primary" size="lg" style={{ flex: 1 }} onClick={() => logRun(open)}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><IcCheck size={15} /> Clean run-through</span>
              </Button>
            </>
          }>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 6 }}>
            <div className="t-call" style={{ color: "var(--sub)" }}>
              {[open.artist, open.key, open.bpm ? `${open.bpm} bpm` : null, open.capo ? `capo ${open.capo}` : null,
                open.strum ? strumByKey(open.strum).name : null].filter(Boolean).join(" · ")}
            </div>
            {open.note && (
              <div className="t-foot" style={{ color: "var(--sub)", background: "var(--surface-2)", padding: 10, borderRadius: "var(--r-well)", lineHeight: 1.55 }}>
                {open.note}
              </div>
            )}
            <Chart song={open} tuning={tuning} isMobile={isMobile}
              onPlaySection={(sections) => setPlaying({ song: open, sections })} />
            <Button kind="tinted" full onClick={() => setPlaying({ song: open, sections: open.sections })}>
              Play the whole thing
            </Button>
            <div>
              <div className="t-label" style={{ color: "var(--sub)", marginBottom: 6 }}>Move it</div>
              <Segmented options={STATUSES.filter((s) => s.key !== "library")} value={open.status === "library" ? "learning" : open.status}
                onChange={(v) => setStatus(open, v)} />
            </div>
          </div>
        </Sheet>
      )}

      {/* the player */}
      {playing && (
        <PlayerBar
          title={playing.song.title}
          backing={backing}
          bpm={playing.song.bpm || 90}
          onClose={() => setPlaying(null)}
          isMobile={isMobile} />
      )}

      {/* A new chart gets a fresh id; an edited one — seed or not — keeps its own,
          so editing never mints a second copy of the same song. guitar_songs.id is
          text precisely so a seed's slug can be stored as a row id (see 0039). */}
      {editing && (
        <SongEditor isMobile={isMobile} song={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          /* THE FIELDS THE EDITOR DOES NOT SHOW ARE CARRIED, NOT DROPPED.
             db.saveGuitarSong builds a FULL row and upserts it — nothing merges
             with what is already there — and the editor's draft has no
             `cleanRuns` and no `lastPlayed`. So opening a song sitting at 2 of 3
             clean runs, changing nothing, and pressing Save reset it to 0/3 with
             no message. That is the one number this panel says counts. */
          onSave={async (s) => {
            // The cap applies here too — Save is the third way into Learning. The
            // editor's own catch shows this where the user is, with the sheet
            // still open and everything still in it; a confirm dialog stacked on
            // top of a sheet is a worse way to say the same thing.
            const already = editing !== "new" && editing.status === "learning";
            if (s.status === "learning" && !already && learningCount >= 3) {
              throw new Error(`You already have ${learningCount} songs in Learning. Move one to Polishing first, or save this one as Shelved.`);
            }
            return saveSong.mutateAsync({
              ...s,
              id: editing === "new" ? crypto.randomUUID() : editing.id,
              cleanRuns: editing === "new" ? 0 : (editing.cleanRuns ?? 0),
              lastPlayed: editing === "new" ? null : (editing.lastPlayed ?? null),
            });
          }}
          onDelete={del} />
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

export default SongsPanel;
