# Board Room on the iPhone Home Screen

[`scriptable/board-room-calendar.js`](scriptable/board-room-calendar.js) is a
[Scriptable](https://scriptable.app) widget that puts your Board Room calendar —
events, birthdays, and upkeep — on the Home Screen and Lock Screen.

**There is nothing to deploy.** It reads the same endpoint the TRMNL bridge
already uses (`/.netlify/functions/trmnl?view=json`), so it inherits that
function's auth, its Supabase service-role read, and its America/Chicago
formatting. See [TRMNL.md](TRMNL.md) for how that endpoint works.

---

## Setup

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

## Sizes

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

## Behaviour worth knowing

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

## Changing it

The renderers are one function per family (`renderSmall`, `renderMedium`,
`renderLarge`, and the three accessory ones), all fed by the same normalized
payload, so a layout change touches exactly one function. Dots and hairlines are
sized empty stacks rather than `DrawContext` images on purpose — a rasterized
image would bake in one appearance and stop following light/dark.

To show more than the feed's 14-day / 12-event window, widen it in `renderJson()`
in [`netlify/functions/trmnl.js`](netlify/functions/trmnl.js); the widget picks
that up with no changes.
