# Board Room on the iPhone Home Screen

Two [Scriptable](https://scriptable.app) widgets put Board Room on the Home
Screen and Lock Screen:

| Widget | Shows | Reads |
|---|---|---|
| [`board-room-notes.js`](scriptable/board-room-notes.js) | Your notes — the Brief's, or one note by name | `trmnl?view=notes` |
| [`board-room-calendar.js`](scriptable/board-room-calendar.js) | Events, birthdays, and upkeep | `trmnl?view=json` |

Both read the endpoint the TRMNL bridge already uses
(`/.netlify/functions/trmnl`), so they inherit that function's auth, its
Supabase service-role read, and its America/Chicago formatting — **no Netlify
settings to add**. They also share one keychain entry, so the token is entered
once per device, whichever widget you set up first. See [TRMNL.md](TRMNL.md)
for how that endpoint works.

---

## Notes

### Setup

1. Install **Scriptable** from the App Store (free).
2. Scriptable → **+** → paste the whole contents of
   `scriptable/board-room-notes.js` → name it **Board Room Notes**.
3. Tap **▶** to run it once *inside the app*. If the calendar widget is already
   on this phone there's nothing to type; otherwise it asks for your
   `TRMNL_TOKEN` and keeps it in the **iOS keychain**, never in the script file
   (which Scriptable syncs through iCloud Drive).
4. Home Screen → long-press → **+** → **Scriptable** → choose a size → place it.
   Then long-press the placed widget → **Edit Widget** → **Script: Board Room
   Notes**.

### Which notes

**By default, exactly what the Brief's Notes tile shows, in the same order.**
Drag a note to the top of the Brief and it's the top of the widget; take a note
**Off the Brief** or archive it and it leaves the widget too. Sealed notes keep
their color — the same tinted paper and seal dot they have in the app.

| Family | Shows |
|---|---|
| **Small** | The top note, `+N more` |
| **Medium** | The top two notes |
| **Large** | The top five |
| **XL** (iPad) | The top ten, in two columns |
| **Lock Screen** | Rectangular: the top note. Inline: its title. Circular: how many. |

### One note by name

Set **Edit Widget → Parameter** to a note's title and the widget shows that one
note, as much of it as the size holds — a grocery list, a packing list, the
running list you took off the Brief for being long (those work here).

- Case doesn't matter, and a title that only *starts* with what you typed
  counts: `Captured` shows the newest `Captured — Oct 22`.
- It takes the same templates as a Watch capture's `into`
  ([WATCH.md](WATCH.md)): `{date}`, `{weekday}`, `{month}`, `{day}`, `{year}`.
  So **`Captured — {date}`** follows the list your watch is filling *today*,
  and starts clean at midnight on its own.

### Tapping

Tapping a note opens it in Board Room; anywhere else opens the Notes tab
(`/?note=<id>` and `/?note`, handled in `src/App.jsx`). A small widget has one
tap target, so it opens the note it shows. iOS opens links from widgets in
Safari rather than in the Home Screen app, so you need to be signed in to Board
Room in Safari too — a tap that lands signed out keeps its place through
sign-in.

### Behaviour worth knowing

- **Offline:** the last good payload is cached per parameter, and shown with a
  small `cached HH:MM` marker. A Groceries widget never falls back to the Brief
  widget's notes. Past 24h it shows an error card instead.
- **Refresh:** asks iOS for 20 minutes (10 while serving stale data). iOS
  decides, and widgets get a daily refresh budget, so an edit can take a while
  to land — running the script in Scriptable refreshes the preview immediately.
  The feed itself is never cached (`no-store`).
- **A site without the notes view** (an older deploy) says so on the widget face
  rather than showing a generic error.

### Changing it

`renderNotes()` in [`netlify/functions/trmnl.js`](netlify/functions/trmnl.js)
decides which notes are sent; the widget only lays them out, one renderer per
family. That function carries copies of the app's note-order and
on-the-Brief rules (it can't import `src/lib`), and
`scripts/notes-widget-smoke.mjs` runs the copies beside the originals. The same
smoke runs the widget itself at every size under a stand-in for Scriptable
(`scripts/scriptable-mock.mjs`), so `npm run verify` catches a widget that
would crash or draw the wrong notes.

---

## Calendar

### Setup

1. Install **Scriptable** from the App Store (free).
2. Scriptable → **+** → paste the whole contents of
   `scriptable/board-room-calendar.js` → name it **Board Room Calendar**.
3. Tap **▶** to run it once *inside the app*. It prompts for your
   `TRMNL_TOKEN` and stores it in the **iOS keychain** — deliberately not in the
   script file, which Scriptable syncs through iCloud Drive. A preview renders
   immediately if the token is right.
4. Home Screen → long-press → **+** → **Scriptable** → choose a size → place it.
   Then long-press the placed widget → **Edit Widget** → **Script: Board Room
   Calendar**.

The site URL is already filled in (`https://board-room.netlify.app`) and the
Netlify side is already configured — the function's health ping reports
`configured: true`.

### Sizes

| Family | Shows |
|---|---|
| **Small** | Big date, the next two items, `+N more` |
| **Medium** | Date rail + a four-row agenda with weekday/time on the right |
| **Large / XL** | Date, a 7-day dot strip, a day-grouped agenda, then birthdays + upkeep |
| **Lock Screen** | Inline, circular, and rectangular are all laid out separately |

Category dots use the same colors as the Calendar tab (`EVENT_CATEGORIES` in
`src/pages/personal/CalendarPanel.jsx`): personal blue, work amber, health
green, bills red — plus pink for birthdays and purple for upkeep. The palette is
Porcelain from `src/design/themes.css`, wired through `Color.dynamic` so iOS
does the light/dark swap itself.

**Widget parameter** (Edit Widget → Parameter): leave blank for everything, or
set `events` to hide birthdays and upkeep.

### Behaviour worth knowing

- **Offline:** every successful fetch is cached. If the network fails, the
  widget renders the last good payload with a small `cached HH:MM` marker rather
  than going blank. Past 24h the cache is considered too old and it shows an
  error card instead.
- **Refresh:** asks iOS for a 30-minute cadence, dropping to 10 minutes when
  it's serving stale data so it recovers quickly. iOS always has final say.
- **Tapping** the widget opens Board Room.
- **A wrong or missing token** surfaces the function's own message
  ("Missing or incorrect token.") on the widget face, so it's obvious what
  broke. To replace a stored token, run the script in-app after deleting the
  keychain entry, or set `TOKEN` at the top of the file temporarily.

### Changing it

The renderers are one function per family (`renderSmall`, `renderMedium`,
`renderLarge`, and the three accessory ones), all fed by the same normalized
payload, so a layout change touches exactly one function. Dots and hairlines are
sized empty stacks rather than `DrawContext` images on purpose — a rasterized
image would bake in one appearance and stop following light/dark.

To show more than the feed's 14-day / 12-event window, widen it in `renderJson()`
in [`netlify/functions/trmnl.js`](netlify/functions/trmnl.js); the widget picks
that up with no changes.
