# Board Room on the Apple Watch

Two seams exist, and they're the only two that can exist: watchOS can't open a
web app, and a web app can't read HealthKit. Both directions go through iOS
**Shortcuts**, which runs on the watch and can POST to a URL.

| Direction | Endpoint | Setup UI | Doc |
|---|---|---|---|
| Words **in** — dictate a note | `/.netlify/functions/note-capture` | Personal → Notes → **Watch** | this file |
| Workouts **in** — finished exercise | `/.netlify/functions/workout-import` | Train → **Apple Watch** | [WorkoutPanel header](src/WorkoutPanel.jsx) |
| Calendar **out** — glanceable agenda | `/.netlify/functions/trmnl?view=json` | — | [SCRIPTABLE.md](SCRIPTABLE.md), [TRMNL.md](TRMNL.md) |

Everything below is the first row.

---

## The 60-second version

1. Board Room → **Personal** → Notes → **Watch** → **Generate token**. Copy it.
2. iPhone → Shortcuts → **+** → name it **Board Note**.
3. Add **Dictate Text** (Stop Listening → *After Pause*).
4. Add **Get Contents of URL** → your site's
   `/.netlify/functions/note-capture` → Method **POST** → Request Body **JSON**:

   ```json
   { "token": "<your token>", "text": <Dictated Text> }
   ```

   `<Dictated Text>` is the magic variable from step 3 — insert it from the
   variable picker, don't type it.
5. Shortcut details (ⓘ) → **Show on Apple Watch** ON, **Pin on Apple Watch** ON.
6. Run it once on the phone. A note appears in Notes. Done.

## Getting it to *one tap*

Pinning it in the watch's Shortcuts app is three taps. These are one:

- **Watch face complication** — Watch app → Face Gallery → edit a face → set a
  corner complication to **Shortcuts** → pick the shortcut. Raise wrist, tap
  corner, talk. This is the one worth doing.
- **Action Button** (Ultra) — Watch → Settings → Action Button → Shortcut.
  No screen needed at all.
- **Double Tap** (Series 9+) — put the shortcut in the Smart Stack, then pinch.
- **Siri** — "Hey Siri, Board Note." The shortcut's *name* is the phrase, which
  is why step 2 says to name it something you'd say out loud.

## The payload

Only `token` and `text` are required. Everything else is optional and can be
dropped from the JSON entirely.

| Field | Aliases | Meaning |
|---|---|---|
| `token` | header `X-Capture-Token`, `?token=` | Your capture token. |
| `text` | `note`, `body`, `content`, `dictation` | The note. 1–10,000 characters. |
| `title` | `name` | Optional title. ≤120 characters. |
| `seal` | `color` | `brass`, `green`, `blue` or `red` — the Notes tab's color seals. |
| `pin` | `pinned` | `true` pins it to the top. |
| `into` | `append`, `list` | Append to the note with this exact title instead of making a new one. |
| `stamp` | — | Prefix the line with the time. Defaults **on** for `into`, **off** otherwise. |

**Field names are case-insensitive**, and that is not politeness — the Shortcuts
JSON body editor auto-capitalizes the key field, so typing `token` gets you
`Token`, and a case-sensitive read would 401 with `unknown token` while the
shortcut looked perfectly correct on screen. `Token`, `TOKEN` and `token` are
all the same field. An exactly-lowercase key wins if both are somehow present.

If the body isn't valid JSON at all, the whole raw body is taken as the note
text — so a Shortcut with Request Body = **Text** and the token in the
`X-Capture-Token` header works too. That's fewer taps to build and no quoting
to get wrong.

### `into` is the one that changes how you use it

Dictating eight things over a day as eight notes buries the Notes tab in
fragments. Dictating them *into* one note leaves a single readable list:

```json
{ "token": "…", "text": <Dictated Text>, "into": "Captured — {date}" }
```

```
Captured — Aug 7
- 8:14 AM · ask Dana about the roof quote
- 11:02 AM · grout sealer, the grey one
- 4:47 PM · move the Thursday call
```

`{date}` resolves against the **America/Chicago** clock at write time, so
today's note is created on the first tap and a fresh one starts tomorrow with
no action from you. Available tokens: `{date}` / `{today}` (`Aug 7`),
`{weekday}` (`Fri`), `{month}`, `{day}`, `{year}`. An unrecognized `{token}` is
left in the title as-is rather than silently erased.

Lines are written as `- …`, which is exactly the bullet syntax the note editor's
list continuation reads — open the list on the phone, press Enter, and it keeps
bulleting.

## Shortcuts worth having

| Name | Body | Why |
|---|---|---|
| **Board Note** | `{"text": <Dictated Text>}` | The default. Put this on the watch face. |
| **Board List** | `{"text": <Dictated Text>, "into": "Captured — {date}"}` | One note a day instead of forty fragments. |
| **Board Idea** | `{"text": <Dictated Text>, "seal": "brass", "title": "Idea"}` | Pre-sealed so it filters out of the noise later. |
| **Board Errand** | `{"text": <Dictated Text>, "into": "Errands"}` | A single standing list, no date token. |
| **Clip to Board** | `{"text": <Shortcut Input>}` | Share-sheet shortcut (Accept *Text* / *URLs*), not a watch one — same endpoint. |

Each is the same shortcut with a different JSON body. Duplicate, edit two
fields, rename.

## Behaviour worth knowing

- **Retries don't double.** The same text arriving twice within 90 seconds is
  answered with the first note's id and `duplicate: true`. A watch losing
  signal mid-request and Shortcuts re-running the action is normal, not
  exceptional — this is why the window exists.
- **A cancelled dictation is a 400, never an empty note.** An empty magic
  variable gets `text is empty — nothing to capture` back, which Shortcuts can
  show in a notification. Silently writing a blank note would look like the
  capture worked and lose the thought.
- **A bad seal is a 400 too**, not a silently colorless note.
- **The pre-upgrade schema still works.** If `pinned`/`color` haven't been added
  yet (the SQL banner in the Notes tab), the note is written *without* the seal
  and the response says `sealed: false`. The words matter; the color is garnish.
- **Timestamps are Central**, not the Netlify region's clock — an 11pm note
  files under today, not tomorrow.
- **The response** is `{ success, mode, id, title }`. Add a **Show Notification**
  action after the URL call if you want the watch to confirm.

## Failures and what they mean

| Status | Body | Fix |
|---|---|---|
| 401 | `unknown token` | Token missing, mistyped, or regenerated in the app. (Key capitalization is *not* a cause — `Token` works.) |
| 400 | `text is empty — nothing to capture` | Dictation was cancelled or produced nothing. |
| 400 | `seal must be one of …` | Typo in the seal name. |
| 403 | `this account is not allowed…` | The token belongs to a non-owner account. |
| 503 | `server owner is not configured` | Netlify is missing an env var (below). |

Health check, no token needed:

```bash
curl -sX POST https://board-room.netlify.app/.netlify/functions/note-capture \
  -H 'Content-Type: application/json' -d '{"ping":true}'
```

## Server requirements

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BOARD_USER_ID` — all three are
already set for `workout-import` and `db-admin`. Nothing new to configure.

The token itself is per-user and lives in
`app_settings.notes_capture.captureToken`, written by the Watch sheet.
Regenerating it in the app revokes the old one immediately; any shortcut still
carrying it starts getting 401s, which is the point.

## Security

The token is the only key — the endpoint has no session, because no Supabase
session survives inside a Shortcut. It reaches the database through the service
role key, so:

- Treat the token like a password. Shortcuts stores it in the shortcut, which
  syncs through iCloud.
- Prefer the JSON body or the `X-Capture-Token` header over `?token=` — query
  strings land in access logs. The query form exists for the raw-text shortcut
  and is the same "secret address" model a private `.ics` feed uses.
- The endpoint only ever **writes** notes, and only for the owner account. It
  reads nothing back and returns no note content — a leaked token costs you
  junk notes, not your data.

## Changing it

The whole decision layer of
[`netlify/functions/note-capture.js`](netlify/functions/note-capture.js) is
pure and asserted in
[`scripts/note-capture-smoke.mjs`](scripts/note-capture-smoke.mjs)
(`npm run smoke:capture`) — every failure mode here is silent (an empty note, a
doubled note, a note filed under tomorrow), so new behaviour needs a new
assertion, not just a manual run from the wrist.
