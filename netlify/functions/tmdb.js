// Movie search — OPTIONAL. Only used to auto-fill a poster + confirm the
// year/title spelling when logging a movie. Both scores in the Movies tab
// are Cameron's own, typed by hand — this never supplies either one.
// Uses TMDb (themoviedb.org), a legitimate, actively-maintained free API —
// unlike several other integrations in this app, this one needs you to
// actually sign up (free, instant, no card) and set TMDB_API_KEY in Netlify.
// If you don't bother setting this up, the Movies tab still works fully —
// you just won't get a poster image, and you'll type the year by hand.
//   1. https://www.themoviedb.org/signup
//   2. Once logged in: Settings → API → request a free "API Read Access Token" (v4 auth) or classic API key (v3)
//   3. Netlify → Site configuration → Environment variables → add TMDB_API_KEY

const { json, error, methodGuard } = require("./_shared/response");

exports.handler = async (event) => {
  const guard = methodGuard(event, "POST");
  if (guard) return guard;

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return error(500, "Missing TMDB_API_KEY in Netlify env vars — see comment at the top of this file for the free signup steps.");

  try {
    const { title } = JSON.parse(event.body || "{}");
    if (!title) return error(400, "title is required");

    const res = await fetch(`https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(title)}&include_adult=false`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`TMDb ${res.status}`);
    const data = await res.json();

    const results = (data.results || []).slice(0, 6).map(m => ({
      id: m.id,
      title: m.title,
      year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      poster_url: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : null,
      overview: m.overview,
      // Not used as this app's "true quality score" — that's Cameron's own
      // rating, typed by hand. This is just extra context if useful.
      tmdb_rating: m.vote_average ? Math.round(m.vote_average * 10) : null,
    }));
    return json(200, { success: true, results });
  } catch (e) {
    return error(500, e.message);
  }
};
