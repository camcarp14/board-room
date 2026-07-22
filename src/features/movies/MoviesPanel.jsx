import { useState, useRef } from "react";
import { callFnFull } from "../../lib/functions.js";
import { useMovies, useSaveMovie, useDeleteMovie } from "../../data/movies.js";
import { Card, SectionHeader, CellGroup, Button, Field, Spinner, EmptyState, Dot, useConfirm } from "../../ui/kit.jsx";
import { IcSearch, IcClose, IcFilm } from "../../ui/icons.jsx";

// Reset that lets a <button> wear the kit's .cell-body anatomy (rows keep a
// separate delete button, so the whole cell can't be one <button> itself).
const rowBtn = { background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", alignSelf: "stretch", justifyContent: "center" };

export function MoviesPanel({ isMobile }) {
  const { data: movies, error: loadErr, isLoading, refetch } = useMovies();
  const saveMut = useSaveMovie();
  const delMut = useDeleteMovie();
  const [editingId, setEditingId] = useState(null); // null = adding new, otherwise editing this movie
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [posterUrl, setPosterUrl] = useState(null);
  const [trueScore, setTrueScore] = useState("");
  const [cameronScore, setCameronScore] = useState("");
  const [note, setNote] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [saveErr, setSaveErr] = useState(null);
  const [confirmEl, confirm] = useConfirm();
  const formRef = useRef(null);

  // Purely optional — just fills in a poster + confirms the year/title
  // spelling. Your two scores are always typed by you; this never sets them.
  const findPoster = async () => {
    if (!title.trim()) return;
    setSearching(true); setSearchResults(null);
    const res = await callFnFull("tmdb", { title: title.trim() });
    setSearching(false);
    setSearchResults(res.ok && res.data?.success ? res.data.results : []);
  };
  const pickPoster = (r) => { setTitle(r.title); setYear(r.year ? String(r.year) : ""); setPosterUrl(r.poster_url); setSearchResults(null); };

  const resetForm = () => { setEditingId(null); setTitle(""); setYear(""); setPosterUrl(null); setTrueScore(""); setCameronScore(""); setNote(""); setSaveErr(null); setSearchResults(null); };
  const startEdit = (m) => {
    setEditingId(m.id); setTitle(m.title); setYear(m.year ? String(m.year) : ""); setPosterUrl(m.poster_url);
    setTrueScore(m.true_quality_score != null ? String(m.true_quality_score) : "");
    setCameronScore(m.cameron_score != null ? String(m.cameron_score) : "");
    setNote(m.note || ""); setSearchResults(null); setSaveErr(null);
    // the form may be scrolled away — bring it back so the edit is visible
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const saveMovie = () => {
    if (!title.trim()) return;
    setSaveErr(null);
    const payload = { title: title.trim(), year: year ? Number(year) : null, poster_url: posterUrl, true_quality_score: trueScore === "" ? null : Number(trueScore), cameron_score: cameronScore === "" ? null : Number(cameronScore), note };
    saveMut.mutate({ id: editingId, payload }, {
      onSuccess: () => resetForm(),
      onError: (e) => setSaveErr(e.message || "Couldn't save."),
    });
  };
  const removeMovie = async (m) => {
    if (!(await confirm({ title: `Delete "${m.title}"?`, confirmLabel: "Delete", destructive: true }))) return;
    delMut.mutate(m.id, {
      onError: (e) => confirm({ title: "Couldn't delete", message: e.message || "Try again in a moment.", confirmLabel: "OK", cancelLabel: false }),
    });
  };
  const scoreColor = (s) => s == null ? "var(--faint)" : s >= 70 ? "var(--green)" : s >= 40 ? "var(--amber)" : "var(--red)";
  const hasBothScores = trueScore !== "" && cameronScore !== "";
  const saveLabel = editingId ? "Save changes" : hasBothScores ? "Log it" : "Add to watchlist";

  const watchlist = (movies || []).filter(m => m.true_quality_score == null && m.cameron_score == null);
  const reviewed = (movies || []).filter(m => m.true_quality_score != null || m.cameron_score != null);

  // Slider for feel + a numeric field for precision (touch sliders are coarse).
  const scoreBlock = (label, val, setVal) => {
    const sc = val === "" ? "var(--faint)" : scoreColor(Number(val));
    const setFromField = (raw) => {
      const digits = raw.replace(/\D/g, "").slice(0, 3);
      setVal(digits === "" ? "" : String(Math.min(100, Number(digits))));
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="t-cap" style={{ color: "var(--sub)" }}>{label} <span style={{ color: "var(--faint)" }}>— optional until watched</span></span>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <input type="range" min="0" max="100" className="scoreSlider" value={val === "" ? 50 : val} onChange={e => setVal(e.target.value)} aria-label={label}
            style={{ flex: 1, minWidth: 0, "--slider-color": sc, "--slider-fill": `${val === "" ? 50 : val}%` }} />
          <Field value={val} onChange={e => setFromField(e.target.value)} placeholder="—" inputMode="numeric" aria-label={`${label} — exact score`}
            className="t-num" style={{ width: 64, flex: "none", textAlign: "center", color: sc, fontWeight: 600 }} />
        </div>
      </div>
    );
  };

  // A plain render helper, NOT a component: defining a component inside the
  // render gives it a new type every render, so React remounted every row
  // (DOM + <img> recreated) on each form keystroke.
  const movieRow = (m) => {
    const editing = editingId === m.id;
    const scored = m.true_quality_score != null || m.cameron_score != null;
    return (
      <div key={m.id} className="cell" style={{ paddingRight: 8, ...(editing ? { boxShadow: "inset 0 0 0 1.5px var(--accent)" } : null) }}>
        {m.poster_url && <img src={m.poster_url} alt="" style={{ width: 32, height: 48, borderRadius: 4, objectFit: "cover", flex: "none" }} />}
        <button className="cell-body" onClick={() => startEdit(m)} style={rowBtn}>
          <span className="cell-title">{m.title}{m.year ? ` (${m.year})` : ""}</span>
          {scored ? (
            <span className="cell-sub">
              True <span className="t-num" style={{ color: scoreColor(m.true_quality_score), fontWeight: 600 }}>{m.true_quality_score != null ? `${m.true_quality_score}%` : "—"}</span>
              {" · "}
              Cameron <span className="t-num" style={{ color: scoreColor(m.cameron_score), fontWeight: 600 }}>{m.cameron_score != null ? `${m.cameron_score}%` : "—"}</span>
            </span>
          ) : (
            <span className="cell-sub">Tap to add your scores once watched</span>
          )}
          {m.note && <span className="cell-sub" style={{ color: "var(--faint)" }}>{m.note}</span>}
        </button>
        <button className="icon-btn" aria-label={`Delete ${m.title}`} onClick={() => removeMovie(m)}><IcClose size={16} /></button>
      </div>
    );
  };

  const lists = (
    <>
      {loadErr ? (
        <Card pad="md">
          <EmptyState icon={<IcFilm size={24} />} title="Couldn't load movies" sub={loadErr.message || "Couldn't load movies."}
            action={<Button kind="quiet" size="md" onClick={() => refetch()}>Retry</Button>} />
        </Card>
      ) : isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0, 1].map(i => <div key={i} className="sk" style={{ height: 56, borderRadius: 18 }} />)}
        </div>
      ) : (
        <>
          {watchlist.length > 0 && (
            <div>
              <SectionHeader title="Watchlist" trailing={String(watchlist.length)} />
              <CellGroup>{watchlist.map(movieRow)}</CellGroup>
            </div>
          )}
          <div>
            <SectionHeader title="Reviewed" trailing={String(reviewed.length)} />
            {reviewed.length ? (
              <CellGroup>{reviewed.map(movieRow)}</CellGroup>
            ) : (
              <Card pad="md">
                <EmptyState icon={<IcFilm size={24} />} title="Nothing reviewed yet" sub="Tap a movie in the watchlist to score it once you've seen it." />
              </Card>
            )}
          </div>
        </>
      )}
    </>
  );

  return (
    <section style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 5fr) minmax(0, 6fr)", gap: isMobile ? 12 : 16, alignItems: "start", minWidth: 0 }}>
      <div ref={formRef} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span className="t-head">{editingId ? "Edit movie" : "Log a movie"}</span>
            {editingId && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
                <Dot tone="var(--accent)" size={6} />
                <span className="t-cap" style={{ color: "var(--accent)", fontWeight: 600 }}>Editing</span>
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {posterUrl && <img src={posterUrl} alt="" style={{ width: 34, height: 51, borderRadius: 6, objectFit: "cover", flex: "none" }} />}
            <Field value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter") findPoster(); }} placeholder="Movie title…" style={{ flex: 1, minWidth: 0 }} />
            <Button kind="quiet" size="md" onClick={findPoster} disabled={searching || !title.trim()} aria-label="Look up poster and year" title="Optional — just fills in a poster/year" style={{ width: 46, padding: 0, flex: "none" }}>
              {searching ? <Spinner size={15} /> : <IcSearch size={17} />}
            </Button>
          </div>

          {searchResults && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {searchResults.length ? searchResults.map(r => (
                <button key={r.id} className="hoverable" onClick={() => pickPoster(r)}
                  style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "4px 8px", background: "none", border: 0, borderRadius: 10, cursor: "pointer", textAlign: "left", font: "inherit", color: "inherit" }}>
                  {r.poster_url ? <img src={r.poster_url} alt="" style={{ width: 26, height: 39, borderRadius: 4, objectFit: "cover", flex: "none" }} /> : <span style={{ width: 26, flex: "none" }} />}
                  <span className="t-call">{r.title}{r.year ? ` (${r.year})` : ""}</span>
                </button>
              )) : <span className="t-foot" style={{ padding: "2px 0" }}>No matches — no problem, just fill in the fields by hand.</span>}
            </div>
          )}

          {scoreBlock("True quality", trueScore, setTrueScore)}
          {scoreBlock("Cameron score", cameronScore, setCameronScore)}

          <Field value={note} onChange={e => setNote(e.target.value)} placeholder="Quick note (optional)" />
          {saveErr && <div className="t-foot" style={{ color: "var(--red)" }}>{saveErr}</div>}
          <div style={{ display: "flex", gap: 10 }}>
            <Button kind="primary" size="md" onClick={saveMovie} disabled={saveMut.isPending || !title.trim()} style={{ flex: 1 }}>{saveMut.isPending ? "Saving…" : saveLabel}</Button>
            {(title || editingId) && <Button kind="quiet" size="md" onClick={resetForm}>{editingId ? "Cancel" : "Clear"}</Button>}
          </div>
        </Card>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {lists}
      </div>
      {confirmEl}
    </section>
  );
}
