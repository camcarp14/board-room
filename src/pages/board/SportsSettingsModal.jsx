// ─── Sports settings ──────────────────────────────────────────────────────────
// Configures the Brief's sports card: leagues to watch, followed teams,
// specific games, and unhiding hidden games. Every mutation calls onSave
// immediately (settings persist per tap — Done is close-only, so there is no
// dirty state to guard). The cfg keys (watchLeagues / followedTeams /
// watchGames / excludedGames) are POSTed as-is to the 'sports' Netlify fn —
// never rename them. League keys are ESPN API slugs paired with their sport
// strings; the sport/league pair must stay intact.
import { useState, useEffect } from "react";
import { Sheet, Button, Pill } from "../../ui/kit.jsx";
import { IcClose } from "../../ui/icons.jsx";
import { callFnFull } from "../../lib/functions.js";

// One line per entry, parsed on save — simpler to build reliably and just
// as easy to edit as a row-based form, and easy to bulk-edit/copy-paste.
const COMMON_LEAGUES = [
  { sport: "football", league: "nfl", name: "NFL" },
  { sport: "basketball", league: "nba", name: "NBA" },
  { sport: "baseball", league: "mlb", name: "MLB" },
  { sport: "hockey", league: "nhl", name: "NHL" },
  { sport: "basketball", league: "wnba", name: "WNBA" },
  { sport: "football", league: "college-football", name: "College Football" },
  { sport: "basketball", league: "mens-college-basketball", name: "Men's College BB" },
  { sport: "basketball", league: "womens-college-basketball", name: "Women's College BB" },
  { sport: "soccer", league: "eng.1", name: "Premier League" },
  { sport: "soccer", league: "usa.1", name: "MLS" },
  { sport: "soccer", league: "uefa.champions", name: "Champions League" },
];

/* Native <select> kept on purpose — iOS hands it the system picker. Dressed
   as a field: surface-2 well, no border, 44pt. */
const SEL = { minHeight: 44, padding: "10px 12px", fontSize: 15, border: "none", borderRadius: 12, background: "var(--surface-2)", color: "var(--ink)", flex: 1, minWidth: 0, fontFamily: "var(--font-body)" };

/* Removable capsule — tap anywhere on it to remove/unhide. */
function RemovableChip({ label, onRemove, mono, title = "Tap to remove" }) {
  return (
    <button onClick={onRemove} title={title}
      className={mono ? "t-cap t-num" : "t-cap"}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 34, padding: "4px 12px", borderRadius: 999, border: "none", background: "var(--ink-a05)", color: "var(--ink)", cursor: "pointer", fontWeight: 500, maxWidth: "100%" }}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <IcClose size={11} style={{ color: "var(--faint)", flex: "none" }} />
    </button>
  );
}

function SectionLabel({ children, hint }) {
  return (
    <div style={{ paddingBottom: 8 }}>
      <div className="t-label">{children}</div>
      {hint && <div className="t-cap" style={{ color: "var(--faint)", fontWeight: 400, marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

function RetryLine({ name, onRetry }) {
  return (
    <div className="t-foot" style={{ color: "var(--red)", margin: "6px 0 2px", display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
      Couldn't load {name} teams.
      <button className="sec-link" onClick={onRetry} style={{ minHeight: 34 }}>Retry</button>
    </div>
  );
}

export function SportsSettingsModal({ cfg, onSave, onClose, isMobile }) { // eslint-disable-line no-unused-vars -- isMobile: contract prop; the Sheet self-adapts by viewport
  const [teamOptions, setTeamOptions] = useState({}); // "sport/league" -> [{abbr,name}] | "loading" | "error"
  const [addLeague, setAddLeague] = useState(COMMON_LEAGUES[0].league);
  const [addTeam, setAddTeam] = useState("");
  const [gameLeague, setGameLeague] = useState(COMMON_LEAGUES[0].league);
  const [gameTeam1, setGameTeam1] = useState("");
  const [gameTeam2, setGameTeam2] = useState("");

  const leagueByKey = (league) => COMMON_LEAGUES.find(l => l.league === league) || COMMON_LEAGUES[0];

  const ensureTeams = async (league, force) => {
    const { sport } = leagueByKey(league);
    const key = `${sport}/${league}`;
    if (!force && Array.isArray(teamOptions[key])) return; // only skip if we already have a real list — "error" should always be retryable
    setTeamOptions(prev => ({ ...prev, [key]: "loading" }));
    const res = await callFnFull("sports", { mode: "teams", sport, league });
    if (res.ok && res.data?.success && Array.isArray(res.data.teams)) setTeamOptions(prev => ({ ...prev, [key]: res.data.teams }));
    else setTeamOptions(prev => ({ ...prev, [key]: "error" }));
  };
  useEffect(() => { ensureTeams(addLeague); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLeague]);
  useEffect(() => { if (gameLeague !== addLeague) ensureTeams(gameLeague); // avoid firing the exact same fetch twice on mount when both pickers still point at the default league
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameLeague]);

  const toggleWatchLeague = (l) => {
    const exists = (cfg.watchLeagues || []).some(w => w.league === l.league);
    const next = exists ? (cfg.watchLeagues || []).filter(w => w.league !== l.league) : [...(cfg.watchLeagues || []), { sport: l.sport, league: l.league, displayName: l.name }];
    onSave({ ...cfg, watchLeagues: next });
  };
  const addFollowedTeam = () => {
    if (!addTeam) return;
    const { sport, name: leagueName } = leagueByKey(addLeague);
    const key = `${sport}/${addLeague}`;
    const teamInfo = (Array.isArray(teamOptions[key]) ? teamOptions[key] : []).find(t => t.abbr === addTeam);
    if (!teamInfo) return;
    const next = [...(cfg.followedTeams || []), { sport, league: addLeague, team: teamInfo.abbr, displayName: `${teamInfo.name} (${leagueName})` }];
    onSave({ ...cfg, followedTeams: next });
    setAddTeam("");
  };
  const removeFollowedTeam = (i) => onSave({ ...cfg, followedTeams: (cfg.followedTeams || []).filter((_, idx) => idx !== i) });
  const addWatchGame = () => {
    if (!gameTeam1 || !gameTeam2 || gameTeam1 === gameTeam2) return;
    const { sport } = leagueByKey(gameLeague);
    const next = [...(cfg.watchGames || []), { sport, league: gameLeague, team1: gameTeam1, team2: gameTeam2 }];
    onSave({ ...cfg, watchGames: next });
    setGameTeam1(""); setGameTeam2("");
  };
  const removeWatchGame = (i) => onSave({ ...cfg, watchGames: (cfg.watchGames || []).filter((_, idx) => idx !== i) });
  const removeExcluded = (id) => onSave({ ...cfg, excludedGames: (cfg.excludedGames || []).filter(x => x !== id) });

  const teamsFor = (league) => { const { sport } = leagueByKey(league); const t = teamOptions[`${sport}/${league}`]; return Array.isArray(t) ? t : []; };
  const stateFor = (league) => teamOptions[`${leagueByKey(league).sport}/${league}`];
  const chipWrap = { display: "flex", flexWrap: "wrap", gap: 8 };

  return (
    <Sheet
      onClose={onClose}
      title="Sports Settings"
      footer={<Button kind="primary" size="lg" full onClick={onClose}>Done</Button>}>

      <SectionLabel hint="Significant games show even without a followed team — tap to toggle.">Watch leagues</SectionLabel>
      <div style={{ ...chipWrap, paddingBottom: 20 }}>
        {COMMON_LEAGUES.map(l => (
          <Pill key={l.league} active={(cfg.watchLeagues || []).some(w => w.league === l.league)} onClick={() => toggleWatchLeague(l)}>{l.name}</Pill>
        ))}
      </div>

      <SectionLabel>Followed teams</SectionLabel>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select value={addLeague} onChange={e => { setAddLeague(e.target.value); setAddTeam(""); }} style={SEL} aria-label="League">
          {COMMON_LEAGUES.map(l => <option key={l.league} value={l.league}>{l.name}</option>)}
        </select>
        <select value={addTeam} onChange={e => setAddTeam(e.target.value)} style={{ ...SEL, flex: 1.6 }} aria-label="Team">
          <option value="">{stateFor(addLeague) === "loading" ? "Loading teams…" : "Choose a team…"}</option>
          {teamsFor(addLeague).map(t => <option key={t.abbr} value={t.abbr}>{t.name}</option>)}
        </select>
        <Button kind="quiet" size="md" onClick={addFollowedTeam} disabled={!addTeam} style={{ flex: "none" }}>Add</Button>
      </div>
      {stateFor(addLeague) === "error" && <RetryLine name={leagueByKey(addLeague).name} onRetry={() => ensureTeams(addLeague, true)} />}
      <div style={{ ...chipWrap, padding: "10px 0 20px" }}>
        {(cfg.followedTeams || []).map((t, i) => (
          <RemovableChip key={i} label={t.displayName || t.team} onRemove={() => removeFollowedTeam(i)} />
        ))}
        {!(cfg.followedTeams || []).length && <span className="t-foot" style={{ color: "var(--faint)" }}>None yet.</span>}
      </div>

      <SectionLabel>Specific games to watch</SectionLabel>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select value={gameLeague} onChange={e => { setGameLeague(e.target.value); setGameTeam1(""); setGameTeam2(""); }} style={{ ...SEL, flexBasis: "100%" }} aria-label="League">
          {COMMON_LEAGUES.map(l => <option key={l.league} value={l.league}>{l.name}</option>)}
        </select>
        <select value={gameTeam1} onChange={e => setGameTeam1(e.target.value)} style={SEL} aria-label="Team 1">
          <option value="">{stateFor(gameLeague) === "loading" ? "Loading…" : "Team 1…"}</option>
          {teamsFor(gameLeague).map(t => <option key={t.abbr} value={t.abbr}>{t.name}</option>)}
        </select>
        <select value={gameTeam2} onChange={e => setGameTeam2(e.target.value)} style={SEL} aria-label="Team 2">
          <option value="">{stateFor(gameLeague) === "loading" ? "Loading…" : "Team 2…"}</option>
          {teamsFor(gameLeague).map(t => <option key={t.abbr} value={t.abbr}>{t.name}</option>)}
        </select>
        <Button kind="quiet" size="md" onClick={addWatchGame} disabled={!gameTeam1 || !gameTeam2} style={{ flex: "none" }}>Add</Button>
      </div>
      {stateFor(gameLeague) === "error" && <RetryLine name={leagueByKey(gameLeague).name} onRetry={() => ensureTeams(gameLeague, true)} />}
      <div style={{ ...chipWrap, padding: "10px 0 20px" }}>
        {(cfg.watchGames || []).map((g, i) => (
          <RemovableChip key={i} label={`${g.team1} vs ${g.team2}`} onRemove={() => removeWatchGame(i)} />
        ))}
        {!(cfg.watchGames || []).length && <span className="t-foot" style={{ color: "var(--faint)" }}>None yet.</span>}
      </div>

      {(cfg.excludedGames || []).length > 0 && (
        <div style={{ paddingBottom: 8 }}>
          <SectionLabel hint="Games you hid on the Brief — tap one to unhide it.">Hidden games ({(cfg.excludedGames || []).length})</SectionLabel>
          <div style={chipWrap}>
            {(cfg.excludedGames || []).map(id => (
              <RemovableChip key={id} mono label={id} onRemove={() => removeExcluded(id)} title="Tap to unhide" />
            ))}
          </div>
        </div>
      )}
    </Sheet>
  );
}
