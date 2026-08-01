// ─── Dream board logic smoke — PLANTED problems, known answers ────────────────
// Pure (src/features/dreams/dreamLogic.js) because every way this can be wrong
// is a wrong-but-plausible answer rather than a crash:
//
//   · a board that disappears the moment its last tile is deleted
//   · "Health" and "health" quietly becoming two boards
//   · a tile whose colour changes every render, making the wall feel unstable
//   · a `javascript:` value reaching an <img src>
//
// Run by `npm run verify`.

import {
  DEFAULT_BOARD, SETUP_SQL, DREAM_STARTERS, TILE_TONES,
  boardsOf, tilesOf, boardCounts, tileKind, toneFor, nextSort, moveTile, isImageUrl,
} from "../src/features/dreams/dreamLogic.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const items = [
  { id: "a", board: "Dreams", title: "A door onto water", sort: 20, created_at: "2026-01-02" },
  { id: "b", board: "Dreams", title: "Fluent in a second language", sort: 10, created_at: "2026-01-01" },
  { id: "c", board: "Health", title: "Still doing this at sixty", image_url: "https://img.example/x", sort: 10, created_at: "2026-01-03" },
  { id: "d", board: "health", title: "Cased differently on purpose", sort: 20, created_at: "2026-01-04" },
];

// ─── 1. boards are derived, and survive being empty ──────────────────────────
check("boards come from the tiles", boardsOf(items).join(",") === "Dreams,Health", boardsOf(items).join(","));
// THE ONE THAT MATTERS. A board is a value on a tile, so a brand-new board has
// nothing to derive it from — without the saved list it would vanish between
// creating it and putting the first thing on it.
check("a board you just made survives being empty",
  boardsOf([], ["Business"]).join(",") === "Business");
check("saved and derived boards merge without duplicating",
  boardsOf(items, ["Dreams", "Business"]).join(",") === "Dreams,Business,Health",
  boardsOf(items, ["Dreams", "Business"]).join(","));
check("case doesn't fork a board into two", boardsOf(items).filter(b => b.toLowerCase() === "health").length === 1);
check("the default board leads when it exists", boardsOf(items)[0] === DEFAULT_BOARD);
check("without the default, order is alphabetical",
  boardsOf([{ board: "Zoo" }, { board: "Aviary" }]).join(",") === "Aviary,Zoo");
check("blank names are not boards", boardsOf([{ board: "" }, { board: "   " }]).length === 0);
check("boardsOf tolerates nulls", boardsOf(null, null).length === 0);

// ─── 2. tiles: the right ones, in the arranged order ─────────────────────────
check("a board's tiles are its own", tilesOf(items, "Dreams").map(t => t.id).join(",") === "b,a");
check("tiles sort by their arranged position, not by when they were added",
  tilesOf(items, "Dreams")[0].id === "b");
check("the board match is case-insensitive", tilesOf(items, "HEALTH").map(t => t.id).sort().join(",") === "c,d");
check("an unknown board has no tiles, not an error", tilesOf(items, "Nope").length === 0);
check("tilesOf tolerates nulls", tilesOf(null, "Dreams").length === 0);
{
  const n = boardCounts(items);
  check("each board counts its own tiles", n.Dreams === 2 && n.Health === 1, JSON.stringify(n));
  check("boardCounts tolerates an empty list", Object.keys(boardCounts([])).length === 0);
}

// ─── 3. what a tile is ───────────────────────────────────────────────────────
check("a tile with an image is a photo tile", tileKind({ image_url: "https://img.example/x.jpg" }) === "photo");
check("a tile without one is a type tile — a real outcome, not a failure",
  tileKind({ title: "Just words" }) === "text" && tileKind({ image_url: "" }) === "text");
// Permissive about extensions: half the image links worth pinning end in a
// query string, and demanding .jpg would reject the common case.
check("an extensionless CDN link is still an image", isImageUrl("https://images.unsplash.com/photo-123?w=800"));
check("a data image is allowed", isImageUrl("data:image/png;base64,iVBORw0KGgo="));
// THE GUARD. This value goes straight into an <img src>; a bad scheme is the
// one input here that's a security problem rather than a broken picture.
for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "  javascript:void(0)", "file:///etc/passwd"]) {
  check(`"${bad.trim().slice(0, 22)}" is refused`, !isImageUrl(bad));
}
check("empty and null are not images", !isImageUrl("") && !isImageUrl(null) && !isImageUrl(undefined));

// ─── 4. tints are stable ─────────────────────────────────────────────────────
// A tile that re-coloured itself on every render would make the wall feel
// unstable; one coloured by POSITION would repaint the whole board every time
// you added something at the top. So it comes from the tile's own id.
check("a tile's tint never changes", toneFor("abc") === toneFor("abc"));
check("tints come from the palette", TILE_TONES.includes(toneFor("whatever")));
check("different tiles spread across the palette",
  new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(toneFor)).size >= 3);
check("toneFor survives a missing id", TILE_TONES.includes(toneFor(undefined)));

// ─── 5. ordering ─────────────────────────────────────────────────────────────
check("a new tile goes to the end", nextSort(tilesOf(items, "Dreams")) === 30, String(nextSort(tilesOf(items, "Dreams"))));
// Sparse steps so a future drag can slot between neighbours without renumbering.
check("the step leaves room to insert between", nextSort([{ sort: 10 }]) - 10 >= 10);
check("an empty board starts somewhere sane", nextSort([]) === 10 && nextSort(null) === 10);
{
  const d = tilesOf(items, "Dreams");
  check("a tile moves one place", moveTile(d, "a", -1).join(",") === "a,b");
  check("moving the other way is symmetric", moveTile(d, "b", 1).join(",") === "a,b");
  check("the first tile can't move up", moveTile(d, "b", -1) === null);
  check("the last tile can't move down", moveTile(d, "a", 1) === null);
  check("an unknown id moves nothing", moveTile(d, "zz", 1) === null);
  check("moveTile tolerates nulls", moveTile(null, "a", 1) === null);
  check("a move never loses or duplicates a tile", (() => {
    const out = moveTile(d, "a", -1);
    return out.length === d.length && new Set(out).size === d.length;
  })());
}

// ─── 6. the setup SQL has to actually be runnable ────────────────────────────
// The panel tells you to paste this into Supabase, so a typo here is a dead end
// with no error anyone can act on.
check("the SQL creates the table the loader reads", /create table if not exists public\.dream_items/.test(SETUP_SQL));
check("every column the client writes exists in the SQL",
  ["id", "user_id", "board", "title", "image_url", "note", "sort"].every(c => new RegExp(`\\n\\s+${c}\\b`).test(SETUP_SQL)),
  SETUP_SQL);
// Without RLS every row would be readable by every account on the project.
check("row-level security is switched on", /enable row level security/.test(SETUP_SQL));
check("the policy scopes both reads and writes to the owner",
  /using \(auth\.uid\(\) = user_id\) with check \(auth\.uid\(\) = user_id\)/.test(SETUP_SQL));
check("it is safe to run twice",
  /create table if not exists/.test(SETUP_SQL) && /drop policy if exists/.test(SETUP_SQL) && /create index if not exists/.test(SETUP_SQL));
check("there are starters for an empty board", DREAM_STARTERS.length >= 3);

console.log(failed ? `\n${failed} dream check(s) failed` : "\nDREAMS SMOKE PASS");
process.exit(failed ? 1 : 0);
