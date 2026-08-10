// ─── Dream board intelligence ─────────────────────────────────────────────────
// Pure, like groceryLogic and creedLogic, and for the same reason: every way
// this can go wrong is a wrong-but-plausible answer — a board that vanishes the
// moment its last tile is deleted, a tile that lands on a board with a
// differently-cased name, an image URL that quietly turns out to be a page
// rather than a picture. None of those throw. Asserted by scripts/dreams-smoke.mjs.
//
// ONE TABLE. A board is a text value on the tile, not a row of its own, so a
// board cannot be orphaned or half-renamed, and deleting one is a delete of its
// tiles rather than a cascade you have to trust. The cost is that an EMPTY board
// has nothing to derive it from — solved the same way the grocery list solved
// empty stores: the names you've created are also kept in app_settings, and the
// two are unioned. Tiles win, so a board holding tiles can never disappear
// because a settings write failed.

export const DEFAULT_BOARD = "Dreams";

/** Boards, in a stable order: the default first if present, then alphabetical.
 *  Compared case-insensitively but shown as written — "health" and "Health" are
 *  one board, and the version you typed first is the one you see. */
export function boardsOf(items, saved) {
  const seen = new Map();
  for (const name of [...(saved || []), ...(items || []).map((i) => i.board)]) {
    const label = String(name ?? "").trim();
    if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  const out = [...seen.values()].sort((a, b) => a.localeCompare(b));
  const i = out.findIndex((b) => b.toLowerCase() === DEFAULT_BOARD.toLowerCase());
  return i > 0 ? [out[i], ...out.slice(0, i), ...out.slice(i + 1)] : out;
}

/** The tiles on one board, in their arranged order. */
export const tilesOf = (items, board) =>
  (items || [])
    .filter((i) => String(i.board ?? "").toLowerCase() === String(board ?? "").toLowerCase())
    .slice()
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.created_at || "").localeCompare(String(b.created_at || "")));

/** How many tiles each board holds — the count on each board's chip. */
export function boardCounts(items) {
  const out = {};
  for (const i of items || []) {
    const b = String(i.board ?? "").trim();
    if (!b) continue;
    out[b] = (out[b] || 0) + 1;
  }
  return out;
}

/**
 * Does this look like an image we can actually render?
 *
 * Deliberately permissive about EXTENSION and strict about SCHEME. Half the
 * image URLs worth pinning have no extension at all (CDN and Unsplash links end
 * in a query string), so demanding ".jpg" would reject the common case. What
 * must be checked is the scheme: a `javascript:` or `data:text/html` value in
 * an <img src> is the one input here that is a security problem rather than a
 * broken picture, and a plain http/https URL that turns out to be a web page
 * just fails to load and falls back to the text tile.
 */
export function isImageUrl(url) {
  const u = String(url ?? "").trim();
  if (!u) return false;
  if (/^data:image\//i.test(u)) return true;
  return /^https?:\/\/[^\s]+$/i.test(u);
}

/**
 * What a tile IS, decided once so the grid and the editor can't disagree.
 *
 * A tile with a usable image is a photo tile; anything else is a type tile, and
 * a type tile is a first-class outcome rather than a fallback — a board of bold
 * sentences is a real vision board, and it's the only kind you can make without
 * hunting for pictures first.
 */
export const tileKind = (it) => (isImageUrl(it?.image_url) ? "photo" : "text");

/**
 * A deterministic tint per text tile, so a board of type reads as a collage
 * rather than a column of identical cards.
 *
 * Derived from the tile's own id, which means it never changes — a tile that
 * re-coloured itself on every render would make the board feel unstable, and
 * one coloured by position would repaint the whole board when you added
 * something at the top.
 */
export const TILE_TONES = ["var(--accent)", "var(--purple)", "var(--pink)", "var(--amber)", "var(--green)", "var(--blue)"];
export function toneFor(id) {
  const s = String(id ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TILE_TONES[h % TILE_TONES.length];
}

/**
 * Where a new tile goes: the end of the board.
 *
 * `sort` is sparse (steps of 10) so a future drag can slot a tile between two
 * neighbours without renumbering the whole board. Nothing does that yet; the
 * gap costs nothing and its absence would cost a migration.
 */
export const nextSort = (tiles) =>
  ((tiles || []).reduce((m, t) => Math.max(m, t.sort ?? 0), 0) || 0) + 10;

/** Move a tile one place; returns the ids in their new order, or null if it
 *  can't move (already at an end). Pure so the reorder is testable. */
export function moveTile(tiles, id, dir) {
  const list = (tiles || []).slice();
  const i = list.findIndex((t) => t.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return null;
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((t) => t.id);
}

/** Starters for an empty board — a first tile beats a blank grid and a button. */
export const DREAM_STARTERS = [
  "A year where the work pays for the life, not the other way round.",
  "Somewhere with a door that opens onto water.",
  "Fluent enough to argue in a second language.",
  "A body that can still do this at sixty.",
];

/**
 * The one-time setup, in the schema the CLIENT ACTUALLY READS.
 *
 * `boardroom`, not `public` — src/lib/supabase.js creates the client with
 * `db: { schema: "boardroom" }`, so every .from() in this app resolves there.
 * The first version of this block said `public.dream_items`, copied from the
 * Creed's setup card, which has the same stale text for a table that predates
 * the schema move and already existed in boardroom. Running it created a real
 * table that the app could never see: the loader kept 404ing and the panel kept
 * offering the setup card that had just been run. Nothing about that is visible
 * from either side, which is why the smoke test now checks the schema here
 * against the one in supabase.js rather than trusting this string.
 *
 * The grants are not optional either. Supabase's default privileges cover
 * `public`; a table in a custom schema is unreachable by anon/authenticated
 * until it is granted explicitly, and RLS on its own does not grant anything —
 * it only filters what a role already has.
 */
export const SETUP_SQL = `-- Board Room · Dream boards — one-time setup
-- Safe to run as many times as you like.
create schema if not exists boardroom;

create table if not exists boardroom.dream_items (
  id         uuid primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  board      text not null default 'Dreams',
  title      text not null default '',
  image_url  text,
  note       text,
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Nullable, no default: a default of now() would mark every row deleted the
  -- moment this ran. Deleting a tile writes this column instead of removing the
  -- row, and db.js's readers filter on it — so a table built without it reads
  -- fine but refuses every delete. See supabase/migrations/0014_dream_items.sql.
  deleted_at timestamptz
);
create index if not exists dream_items_board_idx
  on boardroom.dream_items (user_id, board, sort);

alter table boardroom.dream_items enable row level security;
drop policy if exists "dream_items own rows" on boardroom.dream_items;
create policy "dream_items own rows" on boardroom.dream_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- RLS filters; it does not grant. Without these the table is invisible to the
-- signed-in role no matter what the policy says.
grant usage on schema boardroom to anon, authenticated;
grant select, insert, update, delete on boardroom.dream_items to authenticated;

-- If you ran the first version of this block, it made public.dream_items, which
-- this app cannot see. Nothing was ever written to it — drop it:
--   drop table if exists public.dream_items;`;
