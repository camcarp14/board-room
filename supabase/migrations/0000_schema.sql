-- ═══════════════════════════════════════════════════════════════════════════
-- 0000 · the boardroom schema itself
--
-- Board Room's tables do not live in `public`. src/lib/supabase.js builds the
-- browser client with db: { schema: "boardroom" }, and every Netlify function
-- that talks to PostgREST sends Accept-Profile / Content-Profile: boardroom.
-- So a table created in `public` is a table this app can never see — it 404s
-- forever while the setup card that just "worked" keeps offering itself.
--
-- That is not hypothetical. It shipped once, with the Dream boards: the first
-- version of dreamLogic.SETUP_SQL said `public.dream_items`, copied from the
-- Creed's card, and running it created a real table nothing could read. See
-- the note at src/features/finances/financeLogic.js:653, which records the
-- lesson. Every file in this directory is boardroom-qualified for that reason,
-- and scripts/migrations-smoke.mjs refuses to let one drift back.
--
-- RUN THIS FIRST. The rest of the files assume the schema exists and do not
-- repeat this statement.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists boardroom;

-- Usage on the schema is the precondition for every per-table grant that
-- follows. Without it the tables are unreachable by the app's roles even with
-- correct row-level policies: RLS filters what a role can already see, it does
-- not hand out access.
grant usage on schema boardroom to anon, authenticated;

-- PostgREST caches the schema. Without this, a table or function added above
-- 404s until the next Supabase restart or deploy.
notify pgrst, 'reload schema';
