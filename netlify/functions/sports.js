// "Sports" tile data — followed teams + auto-detected significant games
// (Game 7s, series clinchers, tournament semis/finals) + manually-added
// watch-list games, minus anything explicitly excluded.
//
// Uses ESPN's public "hidden" API (site.api.espn.com) — undocumented but
// widely used, no key required. Same risk profile as markets.js and
// wire.js in this codebase: could change or break without notice, so this
// caches aggressively and fails soft (empty list, not a crash) rather than
// taking the whole card down.
//
// This was built from verified community documentation of ESPN's endpoint
// shapes, not from a live test against the real API (this sandbox can't
// reach espn.com) — the scoreboard fetch itself is very likely solid (it's
// stable and heavily used), but the "significance" detection (series state,
// tournament round) depends on fields that may not be present identically
// across every sport. Built defensively — if those fields are missing, a
// game just doesn't get flagged as significant, it doesn't break anything.

const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let cache = { data: null, ts: 0, key: "" };
const TTL_MS = 10 * 60 * 1000;
const teamsCache = new Map(); // separate from `cache` above on purpose — different shape, different lifetime

const UA = { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" };

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchScoreboard(sport, league, dateStr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${league} ${res.status}`);
  const data = await res.json();
  return data?.events || [];
}

// Best-effort significance read — Game 7 / clinch situations (best-of-series
// sports) and tournament round names (semifinal/final/championship).
function detectSignificance(event, competition) {
  const notes = (competition?.notes || []).map(n => (n.headline || "").toLowerCase()).join(" ");
  const roundMatch = /(semifinal|final|championship|elite eight|world series|super bowl)/i.exec(notes);
  if (roundMatch) return roundMatch[1].replace(/\b\w/g, c => c.toUpperCase());

  const series = competition?.series;
  if (series?.summary) {
    const s = series.summary.toLowerCase(); // e.g. "series tied 3-3" or "team leads series 3-2"
    if (/3-3|tied 3-3/.test(s)) return "Game 7";
    if (/3-2|3-1|3-0/.test(s) && /leads/.test(s)) return "Clinch chance";
  }
  return null;
}

function teamSide(competitors, home) {
  const c = (competitors || []).find(x => x.homeAway === (home ? "home" : "away"));
  if (!c) return null;
  return { abbr: c.team?.abbreviation || "", name: c.team?.shortDisplayName || c.team?.displayName || "", score: c.score ?? null, winner: !!c.winner };
}

function isFollowed(event, followedTeams, sport, league) {
  const abbrs = (event.competitions?.[0]?.competitors || []).map(c => (c.team?.abbreviation || "").toUpperCase());
  return followedTeams.some(t => t.sport === sport && t.league === league && abbrs.includes((t.team || "").toUpperCase()));
}

function isWatchlisted(event, watchGames, sport, league) {
  const abbrs = (event.competitions?.[0]?.competitors || []).map(c => (c.team?.abbreviation || "").toUpperCase());
  return watchGames.some(g => g.sport === sport && g.league === league &&
    (abbrs.includes((g.team1 || "").toUpperCase()) || abbrs.includes((g.team2 || "").toUpperCase())));
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "sports", configured: true });

  // Team lookup — powers the settings picker so you choose from a real
  // list instead of typing ESPN abbreviations from memory. Small and
  // separately cached (own cache object — this must not share the games
  // cache above, which is keyed/shaped completely differently) since team
  // rosters barely ever change.
  if (body.mode === "teams" && body.sport && body.league) {
    const teamCacheKey = `${body.sport}/${body.league}`;
    const hit = teamsCache.get(teamCacheKey);
    if (hit && Date.now() - hit.ts < 24 * 3600000) return json(200, { success: true, teams: hit.list });
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${body.sport}/${body.league}/teams?limit=200`, { headers: UA });
      if (!res.ok) throw new Error(`teams ${res.status}`);
      const data = await res.json();
      const list = (data?.sports?.[0]?.leagues?.[0]?.teams || []).map(t => ({ abbr: t.team.abbreviation, name: t.team.displayName })).sort((a, b) => a.name.localeCompare(b.name));
      teamsCache.set(teamCacheKey, { list, ts: Date.now() });
      return json(200, { success: true, teams: list });
    } catch (e) {
      return json(502, { success: false, error: e.message });
    }
  }

  const followedTeams = body.followedTeams || [];
  const watchLeagues = body.watchLeagues || [];
  const watchGames = body.watchGames || [];
  const excludedGames = new Set(body.excludedGames || []);

  // Every distinct sport/league we actually need to check.
  const leagueSet = new Map();
  [...followedTeams, ...watchLeagues, ...watchGames].forEach(x => {
    if (x.sport && x.league) leagueSet.set(`${x.sport}/${x.league}`, { sport: x.sport, league: x.league });
  });
  if (!leagueSet.size) return json(200, { success: true, games: [] }); // nothing configured yet

  const cacheKey = JSON.stringify([...leagueSet.keys()].sort());
  if (cache.data && cache.key === cacheKey && Date.now() - cache.ts < TTL_MS) {
    return json(200, { ...cache.data, cached: true });
  }

  const now = new Date();
  const dateWindow = [-1, 0, 1, 2, 3].map(offset => ymd(new Date(now.getTime() + offset * 86400000)));
  const games = [];

  try {
    await Promise.all([...leagueSet.values()].map(async ({ sport, league }) => {
      let events = [];
      try {
        // Explicit dates for the whole window — the no-date "today" call
        // isn't reliable for "what's coming up," and mixing it with explicit
        // dates was producing duplicate entries for the same game. One
        // fetch per date, deduped by event id below.
        const results = await Promise.all(dateWindow.map(d => fetchScoreboard(sport, league, d)));
        const seen = new Set();
        for (const dayEvents of results) {
          for (const ev of dayEvents) {
            if (seen.has(ev.id)) continue;
            seen.add(ev.id);
            events.push(ev);
          }
        }
      } catch { return; } // one league failing doesn't take down the others

      events.forEach(ev => {
        if (excludedGames.has(ev.id)) return;
        const comp = ev.competitions?.[0];
        if (!comp) return;
        const startTime = new Date(ev.date);
        const hoursAgo = (now - startTime) / 3600000;
        if (hoursAgo > 12 && ev.status?.type?.state === "post") return; // completed more than 12h ago — out of window
        if (startTime - now > 7 * 86400000) return; // more than a week out — too far ahead to be useful yet

        const followed = isFollowed(ev, followedTeams, sport, league);
        const watchlisted = isWatchlisted(ev, watchGames, sport, league);
        const significance = detectSignificance(ev, comp);
        if (!followed && !watchlisted && !significance) return; // the actual filter — this is what keeps it from becoming every game everywhere

        games.push({
          id: ev.id, sport, league,
          name: ev.shortName || ev.name,
          date: ev.date,
          state: ev.status?.type?.state || "pre", // "pre" | "in" | "post"
          statusDetail: ev.status?.type?.shortDetail || ev.status?.type?.detail || "",
          isPast: ev.status?.type?.state === "post",
          home: teamSide(comp.competitors, true),
          away: teamSide(comp.competitors, false),
          significance,
          reason: significance ? "significant" : followed ? "followed" : "watchlist",
        });
      });
    }));

    games.sort((a, b) => new Date(a.date) - new Date(b.date));
    const payload = { success: true, games };
    cache = { data: payload, ts: Date.now(), key: cacheKey };
    return json(200, payload);
  } catch (e) {
    if (cache.data) return json(200, { ...cache.data, cached: true, stale: true });
    return json(502, { success: false, error: e.message });
  }
};
