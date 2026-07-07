// Game detail — only called when you tap into a specific game from the
// Sports tile. Deliberately separate from sports.js so the main scoreboard
// list stays a cheap, fast call; this one does the heavier per-game lookup
// only on demand.
//
// Same ESPN hidden-API caveat as sports.js: built from documented endpoint
// shapes, not live-tested against the real API from this environment.

const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  if (body.ping) return json(200, { success: true, service: "sports-detail", configured: true });

  const { sport, league, eventId } = body;
  if (!sport || !league || !eventId) return json(400, { success: false, error: "sport, league, and eventId are required" });

  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/summary?event=${encodeURIComponent(eventId)}`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoom/1.0)" } }
    );
    if (!res.ok) throw new Error(`summary ${res.status}`);
    const data = await res.json();

    const comp = data?.header?.competitions?.[0];
    const state = comp?.status?.type?.state || "pre";
    const teamAt = (home) => {
      const c = (comp?.competitors || []).find(x => x.homeAway === (home ? "home" : "away"));
      if (!c) return null;
      return { abbr: c.team?.abbreviation || "", name: c.team?.displayName || "", score: c.score ?? null, record: (c.records || []).find(r => r.type === "total")?.summary || null };
    };

    const payload = {
      success: true,
      state,
      venue: comp?.venue?.fullName || null,
      broadcast: comp?.broadcasts?.[0]?.names?.[0] || null,
      home: teamAt(true),
      away: teamAt(false),
      // Field name for a linescore's value has been inconsistent across
      // what this endpoint's lightweight "header" section returns vs the
      // full boxscore — try the known variants rather than assume one.
      linescores: (comp?.competitors || [])
        .map(c => ({ abbr: c.team?.abbreviation, periods: (c.linescores || []).map(l => l.value ?? l.displayValue ?? l.score).filter(v => v !== undefined && v !== null) }))
        .filter(l => l.periods.length > 0),
      // A couple of leaders (top performer) when present — works across most sports without needing sport-specific stat parsing.
      leaders: (data?.leaders || []).slice(0, 2).flatMap(cat =>
        (cat.leaders || []).slice(0, 1).map(l => ({ team: cat.team?.abbreviation, category: cat.name, athlete: l.athlete?.shortName, value: l.displayValue }))
      ),
      // Pre-game: a plain-text preview if ESPN has one; otherwise this is just absent.
      preview: data?.article?.description || data?.gameInfo?.venue ? (data?.article?.description || null) : null,
    };
    return json(200, payload);
  } catch (e) {
    return json(502, { success: false, error: e.message });
  }
};
