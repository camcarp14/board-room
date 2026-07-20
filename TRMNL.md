# Connecting Board Room to your TRMNL

Your TRMNL currently shows a Google Calendar. This wires it to **Board Room's
own data** instead — your calendar events, birthdays, and upkeep — served
straight from Supabase. Nothing about your existing Board Room UI changes; this
just adds one read-only endpoint (`netlify/functions/trmnl.js`) that publishes
your data in the two shapes TRMNL understands.

There are two ways to connect, and you can use **both** at once:

| You want… | Use | TRMNL side |
|---|---|---|
| The same clean month-grid calendar, but fed by Board Room | **ICS feed** | Native **Calendar** plugin |
| A custom screen with events **+ birthdays + upkeep** together | **JSON brief** | **Private Plugin** (Polling) + the included Liquid |

---

## One-time setup (both options need this)

The endpoint reads Supabase with the **service-role key** (so it works without a
logged-in browser session), so it's gated by a secret token. In **Netlify → Site
configuration → Environment variables**, add:

1. **`TRMNL_TOKEN`** — any long random string (a password manager generator is
   perfect). This is the secret that guards the feed.
2. **`SUPABASE_URL`** and **`SUPABASE_SERVICE_ROLE_KEY`** — you almost certainly
   already have these (they power `export-data`). If not, copy them from
   Supabase → Project Settings → API (use the **service_role** key, not anon).
3. *(optional)* **`TRMNL_USER_ID`** — your Supabase user id, to scope the feed to
   one account. Falls back to `MINER_USER_ID`, then to no filter (fine for a
   single-user site). Yours is in `.env.miner.example`.

Then redeploy (pushing this branch does it). Test it in a browser:

```
https://YOUR-SITE.netlify.app/.netlify/functions/trmnl?view=ics&token=YOUR_TRMNL_TOKEN
```

You should see raw `BEGIN:VCALENDAR…` text. Swap `view=ics` for `view=json` to
see the brief payload.

---

## Option 1 — Calendar via ICS (recommended for the calendar view)

This gives you the exact TRMNL calendar render you have now, sourced from Board
Room.

1. TRMNL dashboard → **Plugins** → add a new **Calendar** plugin (the generic
   one that takes an iCal/ICS URL).
2. Paste this as the calendar URL:
   ```
   https://YOUR-SITE.netlify.app/.netlify/functions/trmnl?view=ics&token=YOUR_TRMNL_TOKEN
   ```
3. Add it to your **Playlist** (replacing or alongside Google Calendar).

The feed includes, as all-day/recurring entries:
- **Events** from your Calendar tab
- **Birthdays** (yearly-recurring, from the Birthdays tab)
- **Upkeep** next-due dates (from the Upkeep tab)

Want just events? Add `&include=events` (or any comma list of
`events,birthdays,upkeep`) to the URL.

---

## Option 2 — Custom "Board Room Brief" screen (Private Plugin)

This is the one that shows **other widgets alongside the calendar** — events,
birthdays, and upkeep in one screen.

1. TRMNL dashboard → **Plugins** → **Private Plugin** → **Add New**.
2. **Strategy:** Polling.
3. **Polling URL:**
   ```
   https://YOUR-SITE.netlify.app/.netlify/functions/trmnl?view=json&token=YOUR_TRMNL_TOKEN
   ```
4. **Refresh rate:** hourly is plenty (the data changes slowly and Netlify
   caches for 5 min).
5. Open the **Markup** editor and paste the contents of
   [`trmnl/board-brief.liquid`](trmnl/board-brief.liquid) into the **Full**
   layout. Save.
6. Add the plugin to your **Playlist**.

The JSON it renders from looks like:

```jsonc
{
  "generated_at": "Jul 20, 12:31 PM",
  "counts": { "events": 4, "birthdays": 2, "upkeep": 1 },
  "events":    [{ "title": "...", "when": "Wed, Jul 22 · 6:00 PM", "rel": "in 2d", "location": "..." }],
  "birthdays": [{ "name": "Natalie", "when": "Jul 22", "rel": "in 2d", "turning": 30 }],
  "upkeep":    [{ "name": "Replace filter", "when": "Jul 25", "rel": "in 5d", "overdue": false }]
}
```

Every field is already human-formatted (times in America/Chicago), so the Liquid
stays simple. Tweak the markup freely — TRMNL's CSS framework is at
<https://usetrmnl.com/framework>.

---

## How it works / notes

- **One function, two views:** `netlify/functions/trmnl.js` — `?view=ics`
  returns `text/calendar`, `?view=json` returns the brief. Both are GET (TRMNL
  polls with GET).
- **Security:** the token is required on every request; a wrong/missing token
  returns 401. Keep the URL private — the token in the query string is the only
  thing guarding your data (same "secret address" model as a private Google
  Calendar ICS link).
- **Adding more widgets later:** extend `renderJson()` in `trmnl.js` (e.g. pull
  in `markets.js`-style quotes or grocery items) and add a column to the Liquid.
- **Health check:** `POST {"ping":true}` to the function reports whether the env
  vars are set, matching the other Board Room functions.
