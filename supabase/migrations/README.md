# boardroom schema — a record, backfilled from live usage

## What this is

Board Room reads and writes 32 tables in the `boardroom` schema of the shared
Pentagon Supabase project. Until this directory existed, **ten** of them had DDL
anywhere in the repository: four in-app setup cards that got the schema right
(`affirmations`, `dream_items`, `transactions`, `plaid_items`), five shown to the
user with the wrong schema (`workout_templates`, `workout_sessions`,
`body_weight_log`, `upkeep_items`, `mini_skills`), and `usage_log` in
`/supabase-usage-fix.sql`. The other 22 existed only in production, described
nowhere.

Each file here reconstructs one table from how the code actually reads and writes
it: every column the app selects, inserts, upserts, orders by or filters on, plus
the indexes those query shapes need. The prose in each file records why the shape
is what it is, which is usually a bug that shaped it.

## What this is NOT

**These files are a record, not a dump of the live DDL.** Nothing here was read
off the database. They were derived from the source, so:

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

If you want the authoritative live schema, get it from the database. Use these to
understand it, to rebuild it, and to notice when it drifts.

## Running them

Every file is idempotent: `create table if not exists`, `create index if not
exists`, and policies guarded so a second run cannot double the policy set. Run
them in numeric order in the Supabase SQL editor.

`0000_schema.sql` must go first — it creates the schema and grants usage on it,
and no other file repeats those statements.

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
are correct; those five constants are not, and fixing them is a separate change to
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

`scripts/migrations-smoke.mjs` runs in `npm run verify` and checks four things:

1. Every table the code reaches has a file here.
2. Every file is `boardroom`-qualified, with no uncommented `public.<table>`.
3. Every file is idempotent.
4. `netlify/functions/export-data.js` backs up this exact list — so the backup
   can never again cover nine tables while the app uses 32.
