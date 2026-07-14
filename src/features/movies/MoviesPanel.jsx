import { useState, useEffect } from "react";
import { T, syne, mono } from "../../theme.js";
import { S } from "../../ui/styles.js";
import { db } from "../../data/db.js";
import { callFnFull } from "../../lib/functions.js";

export function MoviesPanel({ isMobile }) {
  const card = isMobile ? S.cardM : S.card;
  const [movies, setMovies] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [editingId, setEditingId] = useState(null); // null = adding new, otherwise editing this movie
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [posterUrl, setPosterUrl] = useState(null);
  const [trueScore, setTrueScore] = useState("");
  const [cameronScore, setCameronScore] = useState("");
  const [note, setNote] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  const refresh = () => { db.loadMovies().then(setMovies).catch(e => setLoadErr(e.message || "Couldn't load movies.")); };
  useEffect(() => { refresh(); }, []);

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
  };
  const saveMovie = () => {
    if (!title.trim()) return;
    setSaving(true); setSaveErr(null);
    const payload = { title: title.trim(), year: year ? Number(year) : null, poster_url: posterUrl, true_quality_score: trueScore === "" ? null : Number(trueScore), cameron_score: cameronScore === "" ? null : Number(cameronScore), note };
    const op = editingId ? db.updateMovie(editingId, payload) : db.saveMovie(payload);
    op.then(() => { setSaving(false); resetForm(); refresh(); })
      .catch(e => { setSaving(false); setSaveErr(e.message || "Couldn't save."); });
  };
  const removeMovie = (id, e) => { e.stopPropagation(); if (!window.confirm("Delete this movie?")) return; db.deleteMovie(id).then(refresh); };
  const scoreColor = (s) => s == null ? T.faint : s >= 70 ? T.green : s >= 40 ? T.amber : T.red;
  const hasBothScores = trueScore !== "" && cameronScore !== "";
  const saveLabel = editingId ? "Save changes" : hasBothScores ? "Log it" : "Add to watchlist";

  const watchlist = (movies || []).filter(m => m.true_quality_score == null && m.cameron_score == null);
  const reviewed = (movies || []).filter(m => m.true_quality_score != null || m.cameron_score != null);

  const MovieRow = ({ m }) => (
    <div onClick={() => startEdit(m)} style={{ ...S.inner, padding: "10px 13px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
      {m.poster_url && <img src={m.poster_url} style={{ width: 32, height: 48, borderRadius: 4, objectFit: "cover", flex: "none" }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne }}>{m.title}{m.year ? ` (${m.year})` : ""}</div>
        {m.true_quality_score != null || m.cameron_score != null ? (
          <div style={{ display: "flex", gap: 12, marginTop: 2 }}>
            <span style={{ fontSize: 10, color: scoreColor(m.true_quality_score) }}>True: {m.true_quality_score != null ? `${m.true_quality_score}%` : "—"}</span>
            <span style={{ fontSize: 10, color: scoreColor(m.cameron_score), fontWeight: 700 }}>Cameron: {m.cameron_score != null ? `${m.cameron_score}%` : "—"}</span>
          </div>
        ) : <div style={{ fontSize: 10, color: T.faint, marginTop: 2 }}>Tap to add your scores once watched</div>}
        {m.note && <div style={{ fontSize: 10, color: T.faint, marginTop: 2 }}>{m.note}</div>}
      </div>
      <button onClick={(e) => removeMovie(m.id, e)} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 14, flex: "none" }}>×</button>
    </div>
  );

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={S.title}>Movies</span>
      </div>

      <div style={{ ...S.inner, padding: "12px 14px", marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {editingId && <div style={{ fontSize: 10, color: T.brass, fontWeight: 700, letterSpacing: "0.04em" }}>EDITING</div>}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {posterUrl && <img src={posterUrl} style={{ width: 30, height: 45, borderRadius: 4, objectFit: "cover", flex: "none" }} />}
          <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter") findPoster(); }} placeholder="Movie title…" style={{ ...S.input, flex: 1, padding: "9px 12px", fontSize: 13 }} />
          <button onClick={findPoster} disabled={searching || !title.trim()} title="Optional — just fills in a poster/year" style={{ ...S.ghostBtn, padding: "9px 12px", fontSize: 11 }}>{searching ? "…" : "🔍"}</button>
        </div>

        {searchResults && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {searchResults.length ? searchResults.map(r => (
              <div key={r.id} onClick={() => pickPoster(r)} style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", padding: "5px 6px", borderRadius: 6 }}>
                {r.poster_url && <img src={r.poster_url} style={{ width: 24, height: 36, borderRadius: 3, objectFit: "cover" }} />}
                <span style={{ fontSize: 11.5 }}>{r.title}{r.year ? ` (${r.year})` : ""}</span>
              </div>
            )) : <div style={{ fontSize: 10.5, color: T.faint }}>No matches — no problem, just fill in the fields below by hand.</div>}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
              <span style={{ fontSize: 9.5, color: T.faint }}>True quality — optional until watched</span>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: mono, color: trueScore === "" ? T.faint : scoreColor(Number(trueScore)) }}>{trueScore === "" ? "—" : `${trueScore}%`}</span>
            </div>
            <input type="range" min="0" max="100" className="scoreSlider" value={trueScore === "" ? 50 : trueScore} onChange={e => setTrueScore(e.target.value)}
              style={{ "--slider-color": trueScore === "" ? T.faint : scoreColor(Number(trueScore)), "--slider-fill": `${trueScore === "" ? 50 : trueScore}%` }} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
              <span style={{ fontSize: 9.5, color: T.faint }}>Cameron score — optional until watched</span>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: mono, color: cameronScore === "" ? T.faint : scoreColor(Number(cameronScore)) }}>{cameronScore === "" ? "—" : `${cameronScore}%`}</span>
            </div>
            <input type="range" min="0" max="100" className="scoreSlider" value={cameronScore === "" ? 50 : cameronScore} onChange={e => setCameronScore(e.target.value)}
              style={{ "--slider-color": cameronScore === "" ? T.faint : scoreColor(Number(cameronScore)), "--slider-fill": `${cameronScore === "" ? 50 : cameronScore}%` }} />
          </div>
        </div>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Quick note (optional)" style={{ ...S.input, padding: "8px 10px", fontSize: 12 }} />
        {saveErr && <div style={{ fontSize: 10.5, color: T.red }}>{saveErr}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={saveMovie} disabled={saving || !title.trim()} style={{ ...S.brassBtn, padding: "8px 16px", fontSize: 11.5, opacity: title.trim() ? 1 : 0.5 }}>{saving ? "Saving…" : saveLabel}</button>
          {(title || editingId) && <button onClick={resetForm} style={{ ...S.ghostBtn, padding: "8px 16px", fontSize: 11.5 }}>{editingId ? "Cancel" : "Clear"}</button>}
        </div>
      </div>

      {loadErr ? <div style={{ fontSize: 11, color: T.faint }}>{loadErr}</div>
        : movies === null ? <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{[0, 1].map(i => <div key={i} className="sk sk-line w60" style={{ margin: 0, height: 26, borderRadius: 8 }} />)}</div>
        : (
          <>
            {watchlist.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 8 }}>WATCHLIST ({watchlist.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {watchlist.map(m => <MovieRow key={m.id} m={m} />)}
                </div>
              </div>
            )}
            <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 8 }}>REVIEWED ({reviewed.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {reviewed.length ? reviewed.map(m => <MovieRow key={m.id} m={m} />) : <div style={{ fontSize: 11, color: T.faint, padding: "6px 0" }}>Nothing reviewed yet.</div>}
            </div>
          </>
        )}
    </div>
  );
}
