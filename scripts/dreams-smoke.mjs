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

import { readFileSync, readdirSync } from "node:fs";
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
// The panel tells you to paste this into Supabase, so a mistake here is a dead
// end with no error anyone can act on — and this block already shipped one.
//
// THE BUG THIS SECTION EXISTS FOR: the SQL said `public.dream_items` while
// supabase.js pins the client to the `boardroom` schema. Running it created a
// real table the app could never see, so the loader kept 404ing and the panel
// kept offering the setup card that had just been run — invisible from both
// sides. So the schema isn't asserted against a literal here; it's read out of
// supabase.js, which means the two cannot drift apart again.
const clientSrc = readFileSync("src/lib/supabase.js", "utf8");
const SCHEMA = clientSrc.match(/db:\s*\{\s*schema:\s*"(\w+)"/)?.[1];
check("the client's schema is discoverable", !!SCHEMA, SCHEMA);
check("the SQL creates the table in the schema the client reads",
  new RegExp(`create table if not exists ${SCHEMA}\\.dream_items`).test(SETUP_SQL), SCHEMA);
check("every statement targets that schema, none left in public",
  !/\bpublic\.dream_items\b/.test(SETUP_SQL.replace(/^\s*--.*$/gm, "")),
  "an uncommented public.dream_items survives");
check("the schema itself is created first", new RegExp(`create schema if not exists ${SCHEMA}`).test(SETUP_SQL));
// RLS filters; it does not grant. A table in a non-public schema is invisible
// to the signed-in role until it is granted, no matter what the policy says.
check("usage on the schema is granted", new RegExp(`grant usage on schema ${SCHEMA}`).test(SETUP_SQL));
check("the table is granted to the signed-in role",
  new RegExp(`grant [^;]*on ${SCHEMA}\\.dream_items to [^;]*authenticated`).test(SETUP_SQL));

// The Creed's block carried the same mistake; it is the only other setup SQL in
// the app, and it must not drift back.
const creedSrc = readFileSync("src/features/creed/CreedPanel.jsx", "utf8");
const creedSql = creedSrc.match(/const CREED_SETUP_SQL = `([\s\S]*?)`;/)?.[1] || "";
check("the Creed's setup SQL targets the same schema",
  new RegExp(`create table if not exists ${SCHEMA}\\.affirmations`).test(creedSql));
check("…and grants it too", new RegExp(`grant [^;]*on ${SCHEMA}\\.affirmations`).test(creedSql));
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

// ─── 7. the delete that used to take the whole wall ──────────────────────────
// deleteDreamBoard was one statement that destroyed every tile on a board, behind
// one confirm dialog, with no undo and — until the week this section was written —
// no backup either. deleteAffirmation took a line of the Creed the same way. Both
// write `deleted_at` now and the readers filter on it, which moves the risk from
// "a delete loses data" to two quieter failures this section is here to hold shut:
//
//   · a READER added later without the filter, which puts deleted tiles back on
//     the wall and reads as data coming back from the dead rather than as a
//     missing WHERE clause
//   · a delete quietly reverting to `.delete()`, which looks like a tidy-up in a
//     diff and is the loss coming back
//
// Text-based against src/data/db.js and the migrations, like migrations-smoke.mjs:
// this is SQL and a module that only runs against Supabase, and the invariant is
// about which statements exist rather than about a value some function returns.
// The Creed's half lives here too, next to the Creed's setup SQL above, for the
// same reason it does — one place to look at both tables.
const SOFT = [
  ["dream_items", "supabase/migrations/0014_dream_items.sql"],
  ["affirmations", "supabase/migrations/0013_affirmations.sql"],
];

for (const [table, file] of SOFT) {
  const mig = readFileSync(file, "utf8");
  check(`${file} adds deleted_at`,
    new RegExp(`alter table ${SCHEMA}\\.${table}\\s+add column if not exists deleted_at timestamptz`).test(mig), file);
  // These files get pasted into the SQL editor by hand, sometimes twice.
  check(`${file}'s alter is safe to run twice`, /add column if not exists/.test(mig));
  // THE ONE THAT WOULD BE A CATASTROPHE. `deleted_at timestamptz default now()`
  // marks every row in the table deleted the moment the migration runs, and the
  // app would come back up with an empty board and an empty Creed and no error
  // anywhere. NULL has to mean live.
  check(`${file} gives deleted_at no default — a default would delete the table`,
    !/deleted_at\s+timestamptz[^;\n]*default/i.test(mig));
}

// Every read of these two tables has to carry the filter, so the check is a sweep
// rather than a look at the one reader we happen to know about. db.js is the only
// module allowed to name either table: it holds the single read path
// (readUndeleted), and a `.from("dream_items")` appearing anywhere else is a reader
// nobody remembered to filter.
//
// netlify/functions/export-data.js is the deliberate exception and does not trip
// this, because it reaches every table through a variable in a list rather than by
// name. It reads both tables WHOLE, on purpose: a backup that dropped the rows you
// deleted last week would be the one copy that cannot give them back.
const sources = new Map();
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) sources.set(p, readFileSync(p, "utf8"));
  }
};
walk("src"); walk("netlify");
for (const [table] of SOFT) {
  const reach = [...sources].filter(([, s]) => new RegExp(`\\.from\\(\\s*["'\`]${table}`).test(s)).map(([p]) => p);
  check(`${table} is reached from src/data/db.js and nowhere else`,
    reach.length === 1 && reach[0] === "src/data/db.js", reach.join(", ") || "nothing reaches it at all");
}

const dbSrc = readFileSync("src/data/db.js", "utf8");
// Methods are two-space members of one object literal, so a body runs to the first
// `\n  },`. If db.js is ever reshaped, every check below goes vacuously true —
// which is why each one is guarded by the length test, the same failure mode
// migrations-smoke.mjs guards its setup-card section against.
const body = (name) => dbSrc.match(new RegExp(`async ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\},`))?.[1] || "";
for (const name of ["loadDreamItems", "deleteDreamItem", "deleteDreamBoard", "restoreDreamItems", "renameDreamBoard", "loadAffirmations", "deleteAffirmation", "restoreAffirmation"]) {
  check(`db.${name} is still where this check looks for it`, body(name).length > 0, name);
}

check("the filter lives in one read path, not in each reader",
  /\.is\("deleted_at", null\)/.test(dbSrc.match(/async function readUndeleted[\s\S]*?\n\}/)?.[0] || ""));
check("both readers go through it",
  /readUndeleted\(/.test(body("loadDreamItems")) && /readUndeleted\(/.test(body("loadAffirmations")));

// Nothing may hard-delete from either table. Checked against the statement that
// follows each `.from(<table>)` rather than against the whole file, so a delete on
// some other table can't satisfy it and one on these can't hide behind one.
for (const [table] of SOFT) {
  const chains = dbSrc.split(new RegExp(`\\.from\\(["']${table}["']\\)`)).slice(1).map((s) => s.slice(0, 160));
  check(`nothing hard-deletes from ${table}`, chains.length > 0 && chains.every((c) => !/\.delete\(/.test(c)),
    `${chains.length} statement(s)`);
}
for (const name of ["deleteDreamItem", "deleteDreamBoard", "deleteAffirmation"]) {
  check(`db.${name} marks the row instead`, /deleted_at: now/.test(body(name)));
  // Deleting the same thing twice must not push its thirty-day clock forward —
  // deleted_at is when it was deleted, and the sweep reads it as exactly that.
  check(`db.${name} does not restamp a row that is already deleted`, /\.is\("deleted_at", null\)/.test(body(name)));
}
check("a board delete hands back the ids it marked, so the undo can be precise",
  /\.select\("id"\)/.test(body("deleteDreamBoard")) && /return \(data \|\| \[\]\)\.map/.test(body("deleteDreamBoard")));
check("both tables have a restore path",
  /deleted_at: null/.test(body("restoreDreamItems")) && /deleted_at: null/.test(body("restoreAffirmation")));
// A rename has to reach deleted rows too: the board name is the only link between
// a tile and a board, so a deleted tile left on the old name is restored onto a
// board that no longer exists. Pinned because adding the filter here looks like
// consistency and is a bug.
check("a rename deliberately reaches deleted tiles as well", !/deleted_at/.test(body("renameDreamBoard")));

// The column arrives by hand and the code arrives on a deploy, in either order, and
// the in-app setup cards do not create it at all yet. So a read has to survive
// 42703 — and a delete must NOT, because the only fallback available to it destroys
// the row this whole section is about.
check("a read survives deleted_at not existing yet", /42703/.test(dbSrc) && /isMissingColumn/.test(dbSrc));
check("…and a delete says which file to run instead of falling back",
  /RUN_THE_MIGRATION/.test(dbSrc) && /migrations\/0014_dream_items\.sql/.test(dbSrc));
// Where the thirty-day purge lives, so the next reader of db.js can find it. There
// is no automatic sweep; it is a counted command next to the prunes that already
// exist for auditor_findings and usage_log.
check("db.js names the home of the thirty-day purge", /db-admin\.js/.test(dbSrc));

console.log(failed ? `\n${failed} dream check(s) failed` : "\nDREAMS SMOKE PASS");
process.exit(failed ? 1 : 0);
