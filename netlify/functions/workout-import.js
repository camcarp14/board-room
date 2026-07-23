// ─── Workout import — the Apple Watch seam ───────────────────────────────────
// An iOS Shortcuts automation ("When I finish a workout" → Get Contents of
// URL) or the Health Auto Export app POSTs finished workouts here; they land
// in workout_sessions as cardio rows and show up in Train → History.
//
// Auth: a per-user import token generated in Train → Apple Watch and stored
// at app_settings[workout].importToken. The token is the only key — no
// Supabase session survives inside a Shortcut. Unknown token → 401, always
// the same body (no user-exists oracle).
//
// Idempotent by design: a Shortcut that re-sends the last week must never
// duplicate history. Dedupe key = same activity (case-insensitive) starting
// within 60s of an already-stored cardio session.
//
// Needs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already set for db-admin
// and mini-worker).
//
// Deliberately self-contained (no require of _shared/response): with the
// repo's "type":"module" + esbuild bundling, `module.exports` inside a
// required helper clobbers the bundle's exports object before
// `exports.handler` is assigned — the function deploys with NO handler.
// Verified against Netlify's own bundler; btc.js/mini-worker.js work
// precisely because they are self-contained. (tmdb.js has this same latent
// bug from an earlier commit.)
const json = (statusCode, data) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const error = (statusCode, message) => json(statusCode, { error: message });
const randomUUID = () => globalThis.crypto.randomUUID();

function cfg() {
  return { url: process.env.SUPABASE_URL, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
function rest(c, path, opts = {}) {
  return fetch(`${c.url}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: c.service, Authorization: `Bearer ${c.service}`, "Content-Type": "application/json", "Accept-Profile": "boardroom", "Content-Profile": "boardroom", ...(opts.headers || {}) },
  });
}

// Accepts the loose shapes Shortcuts / Health Auto Export send and normalizes.
// Bounds are hard: an unparseable or absurd record is rejected LOUDLY (its
// index named), never coerced into plausible-looking history.
const MIN_START = Date.parse("2000-01-01T00:00:00Z");
function normalizeWorkouts(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 50) return { error: "workouts must be an array of 1–50" };
  const now = Date.now();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (!w || typeof w !== "object") return { error: `workout ${i}: must be an object` };
    const activityRaw = w.activity ?? w.type ?? w.name;
    const activity = typeof activityRaw === "string" ? activityRaw.trim().slice(0, 60) : "";
    if (!activity) return { error: `workout ${i}: activity/type must be a non-empty string` };
    const start = w.start ?? w.startedAt ?? w.startDate;
    let startedAt = null;
    if (typeof start === "string") {
      const t = Date.parse(start);
      if (!Number.isNaN(t)) startedAt = t;
    } else if (Number.isFinite(start) && start > 0) {
      startedAt = start > 1e12 ? start : start > 1e9 ? start * 1000 : null;
    }
    // ISO strings get the same range gate as epochs — "+275000-01-01" is not
    // a workout, it's a payload bug that would pin itself to the top of
    // History forever.
    if (startedAt == null || startedAt < MIN_START || startedAt > now + 48 * 3600e3) {
      return { error: `workout ${i}: start must be ISO 8601 or epoch, between 2000 and 48h from now` };
    }
    let durationSec = null;
    if (Number.isFinite(w.durationSec)) durationSec = Math.round(w.durationSec);
    else if (Number.isFinite(w.durationMin)) durationSec = Math.round(w.durationMin * 60);
    else if (Number.isFinite(w.duration)) durationSec = Math.round(w.duration > 1440 ? w.duration : w.duration * 60); // bare "duration" ≤ 1440 reads as minutes
    if (durationSec == null || durationSec < 30 || durationSec > 86400) {
      return { error: `workout ${i}: duration must be 30s–24h (durationSec or durationMin)` };
    }
    const num = (x, lo, hi) => (Number.isFinite(x) && x >= lo && x <= hi ? x : null);
    out.push({
      activity, startedAt, durationSec,
      kcal: num(w.kcal ?? w.calories ?? w.activeEnergy, 0, 10000),
      avgHr: num(w.avgHr ?? w.avgHeartRate ?? w.heartRateAvg, 20, 250),
      distanceKm: num(w.distanceKm ?? w.distance, 0, 500),
    });
  }
  return { workouts: out };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  const c = cfg();
  if (!c.url || !c.service) return error(500, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return error(400, "body must be JSON"); }

  const token = String(body.token || event.headers["x-import-token"] || "").trim();
  if (token.length < 16 || token.length > 80) return error(401, "unknown token");

  try {
    // token → user (the -> operator keeps it a jsonb compare; ->> would also work)
    const lookup = await rest(c, `app_settings?setting_key=eq.workout&setting_value->>importToken=eq.${encodeURIComponent(token)}&select=user_id&limit=1`);
    if (!lookup.ok) return error(502, `settings lookup failed (${lookup.status})`);
    const rows = await lookup.json();
    const user_id = rows?.[0]?.user_id;
    if (!user_id) return error(401, "unknown token");

    const v = normalizeWorkouts(body.workouts ?? body);
    if (v.error) return error(400, v.error);

    // existing cardio rows for the dedupe window
    const existingRes = await rest(c, `workout_sessions?user_id=eq.${user_id}&select=started_at,exercises&order=started_at.desc&limit=300`);
    if (!existingRes.ok) return error(502, `sessions lookup failed (${existingRes.status})`);
    const existing = (await existingRes.json())
      .filter((r) => Array.isArray(r.exercises) && r.exercises.length === 1 && r.exercises[0]?.cardio)
      .map((r) => ({ t: Date.parse(r.started_at), activity: String(r.exercises[0].activity || "").toLowerCase() }));

    let imported = 0, skipped = 0;
    const inserts = [];
    for (const w of v.workouts) {
      const dupe = existing.some((e) => e.activity === w.activity.toLowerCase() && Math.abs(e.t - w.startedAt) < 60_000);
      if (dupe) { skipped++; continue; }
      existing.push({ t: w.startedAt, activity: w.activity.toLowerCase() });
      inserts.push({
        id: randomUUID(), user_id,
        template_id: null, template_name: w.activity, unit: "lb",
        started_at: new Date(w.startedAt).toISOString(),
        ended_at: new Date(w.startedAt + w.durationSec * 1000).toISOString(),
        duration_sec: w.durationSec, notes: "",
        exercises: [{ cardio: true, activity: w.activity, kcal: w.kcal, avgHr: w.avgHr, distanceKm: w.distanceKm, source: "watch" }],
        total_volume: 0, total_sets: 0, pr_count: 0,
      });
      imported++;
    }
    if (inserts.length) {
      const ins = await rest(c, "workout_sessions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(inserts) });
      if (!ins.ok) return error(502, `insert failed (${ins.status}): ${(await ins.text()).slice(0, 200)}`);
    }
    return json(200, { success: true, imported, skipped });
  } catch (e) {
    return error(500, e.message || "import failed");
  }
};
