// ─── Note capture — the Apple Watch seam for words ───────────────────────────
// workout-import.js is the watch seam for exercise; this is the one for
// thoughts. A watchOS Shortcut ("Dictate Text" → "Get Contents of URL") POSTs
// here and the words land in personal_notes, which is the same table the
// Notes tab and the Brief's Notes tile already read. No new surface, no sync
// job — the note is simply there the next time either one loads.
//
// Two shapes, one endpoint:
//
//   {"token":"…","text":"call the roofer"}          → a new note
//   {"token":"…","text":"grout sealer","into":"Errands — {date}"}
//                                                    → appended as a "- " line
//                                                      to that note, created on
//                                                      first use of the day
//
// The append mode is the one worth building a complication for. Dictating
// eight things over a day as eight notes buries the Notes tab in fragments;
// dictating them INTO one titled note leaves a single readable list, and the
// "- " prefix is exactly the bullet syntax the editor's list continuation
// already speaks (see continueListOnEnter in src/ui/shared.jsx).
//
// Auth: a per-user capture token generated in Notes → Watch capture and stored
// at app_settings[notes_capture].captureToken — the same token-is-the-only-key
// model workout-import uses, because no Supabase session survives inside a
// Shortcut. Unknown token → 401, always the same body (no user-exists oracle).
//
// Idempotent within a 90-second window: watch connectivity is flaky and
// Shortcuts will happily re-run an action it thinks failed. The same text
// arriving twice in that window is answered with the first note's id and
// duplicate:true rather than written again.
//
// Needs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BOARD_USER_ID.
//
// Deliberately self-contained (no require of _shared/response) — see the header
// of workout-import.js and scripts/functions-smoke.mjs for why a required
// helper's module.exports silently deletes this function's handler.

const TZ = "America/Chicago"; // matches trmnl.js / calendar.js / the rest of the app

const json = (statusCode, data) =>
  new Response(JSON.stringify(data), { status: statusCode, headers: { "Content-Type": "application/json" } });
const fail = (statusCode, message) => json(statusCode, { error: message });

// ─── limits ──────────────────────────────────────────────────────────────────
// A dictated note is a sentence or two; the ceiling exists so a runaway
// Shortcut loop can't paste a megabyte into a note nobody will ever scroll.
export const MAX_BODY = 10000;
export const MAX_TITLE = 120;
export const DEDUPE_MS = 90_000;
export const SEALS = ["brass", "green", "blue", "red"]; // NOTE_SEALS in src/ui/shared.jsx

function cfg() {
  return {
    url: process.env.SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    owner: String(process.env.BOARD_USER_ID || "").trim(),
  };
}
function rest(c, path, opts = {}) {
  return fetch(`${c.url}/rest/v1/${path}`, {
    signal: AbortSignal.timeout(8000),
    ...opts,
    headers: {
      apikey: c.service, Authorization: `Bearer ${c.service}`, "Content-Type": "application/json",
      "Accept-Profile": "boardroom", "Content-Profile": "boardroom", ...(opts.headers || {}),
    },
  });
}

// ─── pure helpers (asserted in scripts/note-capture-smoke.mjs) ───────────────

// Shortcuts sends "1"/"true"/1 for a toggle depending on which magic variable
// you dropped in. Anything unrecognizable reads as absent, not as false, so a
// caller can tell "didn't ask" from "asked for off".
export function bool(x) {
  if (typeof x === "boolean") return x;
  if (typeof x === "number") return x === 1 ? true : x === 0 ? false : null;
  if (typeof x === "string") {
    const s = x.trim().toLowerCase();
    if (["true", "yes", "1", "on"].includes(s)) return true;
    if (["false", "no", "0", "off"].includes(s)) return false;
  }
  return null;
}

// The date and time the note is FILED under, in Chicago — not in whatever zone
// the Netlify region happens to run in. A note dictated at 11pm Central must
// file under that day, not tomorrow's UTC one.
export function chicagoDate(now = Date.now(), tz = TZ) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric", weekday: "short" })
    .formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return { weekday: get("weekday"), month: get("month"), day: get("day"), year: get("year"), label: `${get("month")} ${get("day")}` };
}
export function chicagoTime(now = Date.now(), tz = TZ) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(now));
}

/**
 * `into` is a TEMPLATE, so one Shortcut can feed a different note every day
 * without being edited. {date} → "Aug 8", {weekday} → "Fri", {year} → "2026".
 *
 * The whole point of the daily variant: a complication you tap all day appends
 * to today's list and starts a clean one tomorrow, with no action from you.
 */
export function resolveTitle(template, now = Date.now(), tz = TZ) {
  const d = chicagoDate(now, tz);
  return String(template)
    .replace(/\{date\}/gi, d.label)
    .replace(/\{today\}/gi, d.label)
    .replace(/\{weekday\}/gi, d.weekday)
    .replace(/\{month\}/gi, d.month)
    .replace(/\{day\}/gi, d.day)
    .replace(/\{year\}/gi, d.year)
    .trim();
}

/**
 * Reject loudly, never coerce. A Shortcut that sends an empty magic variable
 * (the dictation was cancelled, the clipboard was empty) must get a 400 it can
 * show in a notification — not a silent empty note that looks like the capture
 * worked and quietly loses the thought.
 */
export function normalizeCapture(input, now = Date.now(), tz = TZ) {
  if (!input || typeof input !== "object") return { error: "body must be a JSON object" };

  const raw = input.text ?? input.note ?? input.body ?? input.content ?? input.dictation;
  if (typeof raw !== "string") return { error: "text is required (a string)" };
  const body = raw.trim();
  if (!body) return { error: "text is empty — nothing to capture" };
  if (body.length > MAX_BODY) return { error: `text must be ${MAX_BODY} characters or fewer (got ${body.length})` };

  const titleRaw = input.title ?? input.name ?? "";
  if (typeof titleRaw !== "string") return { error: "title must be a string" };
  const title = titleRaw.trim();
  if (title.length > MAX_TITLE) return { error: `title must be ${MAX_TITLE} characters or fewer` };

  const sealRaw = input.seal ?? input.color ?? null;
  let color = null;
  if (sealRaw != null && String(sealRaw).trim() !== "") {
    color = String(sealRaw).trim().toLowerCase();
    if (!SEALS.includes(color)) return { error: `seal must be one of ${SEALS.join(", ")}` };
  }

  const pinned = bool(input.pin ?? input.pinned) === true;

  const intoRaw = input.into ?? input.append ?? input.list ?? null;
  let into = null;
  if (intoRaw != null && String(intoRaw).trim() !== "") {
    if (typeof intoRaw !== "string") return { error: "into must be a string" };
    into = resolveTitle(intoRaw, now, tz);
    if (!into) return { error: "into resolved to an empty title" };
    if (into.length > MAX_TITLE) return { error: `into must resolve to ${MAX_TITLE} characters or fewer` };
  }
  // A time stamp is right for a running list and wrong for a one-off note, so
  // it defaults on only in append mode. Either default can be overridden.
  const stamp = bool(input.stamp) ?? !!into;

  return { body, title, color, pinned, into, stamp };
}

/**
 * One appended line, in the editor's own list syntax.
 *
 * "- " is what continueListOnEnter/toggleBulletAtCaret in src/ui/shared.jsx
 * read as a bullet, so a list built by the watch continues correctly the
 * moment you open it on the phone and press Enter.
 */
export function appendEntry(existing, text, { stamp = true, now = Date.now(), tz = TZ } = {}) {
  const line = `- ${stamp ? `${chicagoTime(now, tz)} · ` : ""}${text.replace(/\n+/g, " ").trim()}`;
  const base = String(existing || "").replace(/\s+$/, "");
  return base ? `${base}\n${line}` : line;
}

// Did this exact capture already land? Compared on the trimmed body for a new
// note, and on the appended LINE's text for an append — a retry of an append
// re-sends the same words, but the timestamp in the rendered line may have
// ticked over a minute, so the words are what's compared.
export function isDuplicate(recent, { body, into }, now = Date.now(), windowMs = DEDUPE_MS) {
  const needle = body.trim();
  for (const row of recent || []) {
    if (now - Date.parse(row.updated_at || 0) > windowMs) continue;
    if (into) {
      if ((row.title || "").trim() !== into) continue;
      const last = String(row.body || "").split("\n").filter((l) => l.trim()).pop() || "";
      if (last.replace(/^- (\d{1,2}:\d{2}\s?[AP]M\s·\s)?/i, "").trim() === needle.replace(/\n+/g, " ").trim()) return row;
    } else if (String(row.body || "").trim() === needle) {
      return row;
    }
  }
  return null;
}

// ─── handler ─────────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method !== "POST") return fail(405, "POST only");
  const c = cfg();

  const raw = await req.text();
  let parsed = null;
  try { parsed = JSON.parse(raw || "{}"); } catch { parsed = null; }
  // A Shortcut's "Get Contents of URL" with Request Body = Text posts the
  // dictation as-is. That's the fewest taps to build, so it's accepted: the
  // whole body becomes the note and the token comes from the header or query.
  const url = new URL(req.url);
  if (typeof parsed === "string") parsed = { text: parsed };
  else if (parsed == null || typeof parsed !== "object") parsed = { text: raw };

  if (parsed.ping === true) {
    return json(200, {
      success: true, service: "note-capture",
      configured: !!(c.url && c.service && c.owner),
      missing: c.url && c.service && c.owner ? undefined : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BOARD_USER_ID",
    });
  }
  if (!c.url || !c.service || !c.owner) return fail(503, "server owner is not configured");

  const token = String(
    parsed.token || req.headers.get("x-capture-token") || url.searchParams.get("token") || ""
  ).trim();
  if (token.length < 16 || token.length > 80) return fail(401, "unknown token");

  const now = Date.now();
  const v = normalizeCapture(parsed, now);
  if (v.error) return fail(400, v.error);

  try {
    // token → user. Same jsonb-field lookup workout-import does, against the
    // notes_capture settings row.
    const lookup = await rest(c, `app_settings?setting_key=eq.notes_capture&setting_value->>captureToken=eq.${encodeURIComponent(token)}&select=user_id&limit=1`);
    if (!lookup.ok) return fail(502, `settings lookup failed (${lookup.status})`);
    const user_id = (await lookup.json())?.[0]?.user_id;
    if (!user_id) return fail(401, "unknown token");
    if (user_id !== c.owner) return fail(403, "this account is not allowed to use Board Room");

    // Recent rows serve two purposes in one round trip: the retry check, and
    // (for a same-day append) the target note itself.
    const since = new Date(now - DEDUPE_MS).toISOString();
    const recentRes = await rest(c, `personal_notes?user_id=eq.${user_id}&updated_at=gte.${encodeURIComponent(since)}&select=id,title,body,updated_at&order=updated_at.desc&limit=20`);
    if (!recentRes.ok) return fail(502, `notes lookup failed (${recentRes.status})`);
    const dupe = isDuplicate(await recentRes.json(), v, now);
    if (dupe) return json(200, { success: true, duplicate: true, id: dupe.id, mode: v.into ? "append" : "new" });

    if (v.into) {
      // Find the note this list lives in. `title=eq.` is exact — the resolved
      // template, not a fuzzy match, so "Errands — Aug 8" never appends into
      // "Errands — Aug 7".
      const targetRes = await rest(c, `personal_notes?user_id=eq.${user_id}&title=eq.${encodeURIComponent(v.into)}&select=id,body&order=updated_at.desc&limit=1`);
      if (!targetRes.ok) return fail(502, `note lookup failed (${targetRes.status})`);
      const target = (await targetRes.json())?.[0];
      if (target) {
        const nextBody = appendEntry(target.body, v.body, { stamp: v.stamp, now });
        if (nextBody.length > MAX_BODY * 6) return fail(409, `"${v.into}" is full — start a new list`);
        const patch = await rest(c, `personal_notes?id=eq.${target.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ body: nextBody, updated_at: new Date(now).toISOString() }),
        });
        if (!patch.ok) return fail(502, `append failed (${patch.status}): ${(await patch.text()).slice(0, 200)}`);
        return json(200, { success: true, mode: "append", id: target.id, title: v.into });
      }
    }

    const id = globalThis.crypto.randomUUID();
    const title = v.into || v.title;
    // A new list's first line is a bullet like every line after it; a plain
    // one-off note is just the words unless a stamp was explicitly asked for.
    const body = (v.into || v.stamp) ? appendEntry("", v.body, { stamp: v.stamp, now }) : v.body;
    const created = await insertNote(c, { id, user_id, title, body, color: v.color, pinned: v.pinned, now });
    if (created.error) return fail(created.status || 502, created.error);
    return json(200, { success: true, mode: v.into ? "append" : "new", id, title, sealed: created.sealed });
  } catch (e) {
    return fail(500, e.message || "capture failed");
  }
};

/**
 * Insert, then fall back once for the pre-upgrade schema.
 *
 * `pinned` and `color` are the two columns NOTES_UPGRADE_SQL adds, and
 * db.loadNotes() already tolerates their absence (the `legacy` flag). A capture
 * from the watch has no UI to show that banner in, so rather than 500 on a
 * table that hasn't been upgraded, the note is written WITHOUT the seal and
 * the response says so — the words are what matter; the color is a garnish.
 */
async function insertNote(c, { id, user_id, title, body, color, pinned, now }) {
  const iso = new Date(now).toISOString();
  const base = { id, user_id, title, body, created_at: iso, updated_at: iso };
  const wantsExtras = color != null || pinned;
  const first = await rest(c, "personal_notes", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify(wantsExtras ? { ...base, color, pinned } : base),
  });
  if (first.ok) return { sealed: wantsExtras ? true : undefined };

  const detail = (await first.text()).slice(0, 300);
  if (wantsExtras && /column|pinned|color|PGRST204|42703/i.test(detail)) {
    const retry = await rest(c, "personal_notes", {
      method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(base),
    });
    if (retry.ok) return { sealed: false };
    return { error: `insert failed (${retry.status}): ${(await retry.text()).slice(0, 200)}` };
  }
  return { error: `insert failed (${first.status}): ${detail.slice(0, 200)}` };
}
