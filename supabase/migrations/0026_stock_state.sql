-- ═══════════════════════════════════════════════════════════════════════════
-- 0026 · boardroom.stock_state — one row, called 'latest'
--
-- The equities screener's answer, same three-column shape as alt_state and for
-- the same reason: the payload IS the client contract, and moving it into columns
-- would mean a migration every time the card learns a field.
--
-- THE PAYLOAD CARRIES A CIRCUIT BREAKER. payload.feed.blocked plus feed.since is
-- how a refused quote feed backs off for a full session instead of retrying
-- hourly into a wall — and stock-scan throws the whole Stocks tab down on that
-- flag. It used to be possible to get stuck there: the tick path spread `...prev`
-- verbatim, carrying feed.blocked forward untouched, so a breaker trip at a
-- moment when nothing was flagged left the tab reading "the quote feed refused
-- us" with a days-old timestamp for as long as no flag was open. Clearing it is
-- now allowed on the path that proves the feed answered on that very pass.
--
-- payload.settledSession is the marker that decides whether a session still needs
-- settling, and it is only stamped once the flags have actually been graded — a
-- single statement timeout used to leave a session permanently ungraded while the
-- marker said the work was done.
--
-- updated_at is read alongside the payload so stock-scan can tell "never settled"
-- apart from "the last write produced nothing usable", the same two-message split
-- alt_state carries.
--
-- SERVER-ONLY, RLS as the belt, no grant issued or revoked — see 0023_alt_state.sql.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.stock_state (
  id         text        primary key,
  updated_at timestamptz,
  payload    jsonb
);

alter table boardroom.stock_state enable row level security;
