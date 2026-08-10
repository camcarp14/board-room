# boardroom schema — a record, backfilled from live usage

## What this is

Board Room reads and writes 33 tables in the `boardroom` schema of the shared
Pentagon Supabase project. It was 32 when this directory was written, and **ten**
of those had DDL anywhere in the repository: four in-app setup cards that got the
schema right (`affirmations`, `dream_items`, `transactions`, `plaid_items`), five
shown to the user with the wrong schema (`workout_templates`, `workout_sessions`,
`body_weight_log`, `upkeep_items`, `mini_skills`), and `usage_log` in
`/supabase-usage-fix.sql`. The other 22 existed only in production, described
nowhere.

Most of these files reconstruct one table from how the code actually reads and
writes it: every column the app selects, inserts, upserts, orders by or filters on,
plus the indexes those query shapes need. The prose in each file records why the
shape is what it is, which is usually a bug that shaped it.

One table per file, named for it, in numeric order — with three files that are not
that, and they are the ones to know about before reading the directory listing as
an inventory:

- **`0000_schema.sql` creates no table.** It creates the schema and grants usage on
  it, and must run first; no other file repeats those statements.
- **`0033_settings_merge_rpc.sql` creates no table either.** It is the first
  function here — `boardroom.settings_merge(text, jsonb, timestamptz)`, the
  read-modify-write that stops two signed-in devices from upserting whole settings
  documents over each other. It belongs in this directory for the same reason the
  tables do: it is schema, it is `boardroom`-qualified, and it has to be in the
  database before the client that calls it ships. `0001_app_settings.sql` is the
  table it writes.
- **`0034_client_errors.sql` was not reconstructed.** `client_errors` is what took
  the inventory from 32 to 33, and it is the one table here whose file came
  *first* — written with the crash reporter (`src/lib/telemetry.js`, read by
  Systems → Status), so this file is the DDL rather than a description of DDL that
  already existed somewhere else.

## What this is NOT

**These files are a record, not a dump of the live DDL.** Nothing here was read
off the database. `0001`–`0032` were derived from the source, so:

- Column **types** are inferred from the values the code writes and the operators
  it uses. Where a genuine coin flip was involved — `personal_events.exdates` as
  `jsonb` versus `text[]`, the surrogate keys on `alt_snapshots` and
  `upstream_run_events` — the file says so in a SQL comment instead of implying
  certainty.
- **Defaults and nullability** follow what the code depends on. Several are
  load-bearing (`chat_messages.user_id` defaults to `auth.uid()` because
  `db.saveMessage` never sends one, and swallows its own errors), and those are
  called out where they appear.
- **Constraints that exist in production but nothing in the code touches** cannot
  be here, because there was no way to see them. The clearest known instance is
  flagged in `0031_upstream_predictions.sql`: whether `run_id` carries a foreign
  key is not observable from the source, so this file records none.
- **Row-level security posture** is reconstructed the same way. Tables the browser
  reads get RLS plus an own-rows policy; tables only the service role touches get
  RLS switched on with no policy and no grant (see `0023_alt_state.sql`);
  `plaid_items` keeps its deliberate revoke. If a live table currently has RLS
  **off** and reads work on the grant alone, running its file here turns RLS on —
  which is correct for a single-owner console, but it would hide any row whose
  `user_id` is not yours.

None of that applies to `0033` or `0034`. Those two were authored alongside the
code that uses them, so they are the definition rather than a reconstruction of
one, and their types, defaults and RLS are simply what they say.

If you want the authoritative live schema, get it from the database. Use these to
understand it, to rebuild it, and to notice when it drifts.

## Running them

Every file is idempotent: `create table if not exists`, `create index if not
exists`, and policies guarded so a second run cannot double the policy set. Run
them in numeric order in the Supabase SQL editor.

`0000_schema.sql` must go first — it creates the schema and grants usage on it,
and no other file repeats those statements.

`0033_settings_merge_rpc.sql` gets there a different way, because a function has
no `if not exists` worth having: `create or replace function` cannot change a
return type (Postgres 42P13), and the one certainty about a function that will be
edited again is that its return shape will grow a field. So it drops first, then
creates, then re-applies its `revoke`/`grant execute` (a fresh create restores
PUBLIC execute every run), and ends with `notify pgrst, 'reload schema'` — without
that last line the rpc 404s, looking exactly like a function that was never
created, until PostgREST next restarts.

## The schema, and the four cards that still get it wrong

**Everything is `boardroom`-qualified.** `src/lib/supabase.js` pins the browser
client with `db: { schema: "boardroom" }` and every function sends
`Accept-Profile` / `Content-Profile: boardroom`. A table created in `public` is
one this app can never see — it 404s forever while the setup card that just
"worked" keeps offering itself. That shipped once, with the Dream boards; the note
at `src/features/finances/financeLogic.js:653` records it.

Four in-app setup cards showed the user `public.` when this directory was written
(2026-08-10). If one of them has since been corrected, this table is out of date
by exactly that much — `scripts/migrations-smoke.mjs` checks that every card
which is *currently* wrong appears here, not that the ones listed are still wrong,
because a smoke that fails when someone repairs a panel is a smoke people delete.

| File | Constant | Tables |
| --- | --- | --- |
| `src/WorkoutPanel.jsx` | `WORKOUT_SETUP_SQL` | `workout_templates`, `workout_sessions`, `body_weight_log` |
| `src/features/upkeep/UpkeepPanel.jsx` | `UPKEEP_SETUP_SQL` | `upkeep_items` |
| `src/LearnPanel.jsx` | `SKILLS_SETUP_SQL` | `mini_skills` |
| `src/pages/personal/NotesPanel.jsx` | `NOTES_UPGRADE_SQL` | `personal_notes` (the `pinned` / `color` `alter table`) |

Anyone who copies one of those into the SQL editor creates a table in the wrong
schema, or alters a table that is not the one the app reads. The migrations here
are correct; those four constants are not, and fixing them is a separate change to
files outside this directory.

## Two tables that are deliberately absent

`outreach` and `creators` are referenced by `netlify/functions/clarify-pipeline.js`
and `netlify/functions/zts-pipeline.js`, and they are **not** Board Room's. They
live in a different project entirely (`CLARIFY_SUPABASE_URL`), `creators` under a
`zts` schema selected by its own `Accept-Profile` header. They are read
cross-tool for the Pentagon roll-up and are owned by those tools.
`scripts/migrations-smoke.mjs` asserts they stay out of this directory, so a later
pass cannot helpfully "complete" the inventory with two tables this app does not
own.

## Keeping it true

`scripts/migrations-smoke.mjs` runs in `npm run verify`, in seven groups:

1. **The record is complete, both directions.** Every table the code reaches has a
   file here — swept from `.from("…")`, from `/rest/v1/<name>`, and from the
   `rest(cfg, "table", …)` / `sb("table", …)` helper forms, because `plaid.js` and
   `netlify/lib/upstream/store.js` never call `.from()` at all. No file describes a
   table nothing reads. Every file is named for the table it creates. The inventory
   is pinned at 33, so a new `.from()` moves that number *with* a file rather than
   instead of one. `outreach` and `creators` stay out.
2. **Everything is `boardroom`-qualified** — the creates, and the indexes and
   policies too, with no uncommented `public.<table>` anywhere. The schema name is
   read out of `src/lib/supabase.js` rather than typed into the test, so these files
   and the client cannot disagree about it, and `0000` has to create and grant it
   before anything needs it.
3. **Every file can be run twice**: `if not exists` on tables and indexes, policies
   guarded, no bare `drop table`.
4. **`netlify/functions/export-data.js` backs up this exact list** — nothing
   missing, no table it names that the app doesn't use, and every deliberate
   omission stated with a reason. It shipped covering nine tables out of 32.
5. **The export's own honesty rules**: a table that errors fails the whole thing
   with a 500 rather than embedding `{ error }` in a 200, the secret compares in
   constant time behind a length guard, guessing it is rate limited, and the Status
   tab's `{ ping: true }` stays ahead of that limiter.
6. **Every in-app setup card that is *currently* wrong is named in this file** (the
   table above). Forward only, for the reason given in that section.
7. **This README does not overclaim**: it still says these were backfilled from
   live usage, and that they are a record rather than a dump of the live DDL.

Nothing in there checks `0033`'s function body — a plpgsql definition is not
text-checkable in any way that would have caught a real bug, and the invariant that
matters about it lives elsewhere: `scripts/systems-smoke.mjs` fails if the
allowlist inside the function and `MERGING_SETTINGS` in `src/data/db.js` disagree
about which settings keys go through the rpc.
