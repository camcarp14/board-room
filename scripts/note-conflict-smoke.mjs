// Note saves are conditional on the version the editor opened — run, not read.
//
// THE BUG THIS PINS. db.saveNote upserted the whole row unconditionally and an
// open editor never re-read its note. Open a note on the phone, lock it, dictate
// two lines into it from the Watch (note-capture appends and stamps updated_at),
// unlock, fix a typo: the autosave wrote the old body over the new one and the
// editor said "Saved". So saveNote now takes the row the editor last saw as
// `base` and writes only if nobody else has since — and when somebody has, it
// either rebases (only metadata moved), recognises its own words already there,
// or saves the draft as a separate copy. Never an overwrite.
//
// db.js is bundled with esbuild and lib/supabase.js is replaced by an in-memory
// personal_notes table that honours .eq() filters on update, which is the whole
// mechanism under test. Same technique as systems-smoke's section 8.
import { build } from "esbuild";
import path from "node:path";
import { rm as rmFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`ok: ${name}`);
  else { failures++; console.log(`FAIL: ${name}${detail !== undefined ? ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
};

const stub = `
  export const ANTHROPIC_API_KEY = "";
  export const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: "smoke-user" } } } }) },
    from: (t) => globalThis.__notes.from(t),
    rpc: async () => ({ data: null, error: null }),
  };
`;
const out = path.resolve(".note-conflict-smoke.tmp.mjs");
await build({
  entryPoints: ["src/data/db.js"], bundle: true, platform: "node", format: "esm",
  outfile: out, logLevel: "error",
  plugins: [{
    name: "stub-supabase",
    setup(b) {
      b.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "supabase-stub", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }));
    },
  }],
});
let mod;
try { mod = await import(pathToFileURL(out).href); } finally { await rmFile(out, { force: true }); }
const { db } = mod;

// ── the fake table ────────────────────────────────────────────────────────────
const table = new Map();
const writes = [];
let tick = 0;
// Distinct, increasing stamps even inside one millisecond — the property the
// compare-and-set relies on in Postgres too.
const stamp = () => new Date(Date.UTC(2026, 8, 28, 12, 0, 0) + ++tick).toISOString();
globalThis.__notes = {
  from: () => ({
    upsert: (row) => {
      const done = () => {
        const prev = table.get(row.id) || {};
        const next = { ...prev, ...row, updated_at: row.updated_at || stamp() };
        table.set(row.id, next);
        writes.push({ kind: "upsert", row });
        return { data: { ...next }, error: null };
      };
      return { select: () => ({ single: async () => done() }) };
    },
    update: (patch) => {
      const filters = [];
      const q = {
        eq: (c, v) => { filters.push([c, v]); return q; },
        select: async () => {
          const hits = [...table.values()].filter((r) => filters.every(([c, v]) => r[c] === v));
          for (const r of hits) Object.assign(r, patch);
          writes.push({ kind: "update", patch, filters, hits: hits.length });
          return { data: hits.map((r) => ({ ...r })), error: null };
        },
      };
      return q;
    },
    select: () => {
      const filters = [];
      const q = {
        eq: (c, v) => { filters.push([c, v]); return q; },
        maybeSingle: async () => ({ data: [...table.values()].find((r) => filters.every(([c, v]) => r[c] === v)) || null, error: null }),
      };
      return q;
    },
  }),
};
const seed = (row) => { const r = { pinned: false, color: null, deleted_at: null, ...row, updated_at: stamp() }; table.set(r.id, r); return { ...r }; };
const reset = () => { table.clear(); writes.length = 0; };

// ── 1. the ordinary save still lands ─────────────────────────────────────────
reset();
let seen = seed({ id: "n1", title: "", body: "call plumber" });
let saved = await db.saveNote({ id: "n1", title: "", body: "call plumber re leak" }, { base: seen });
check("an unconditional-looking save with nothing in the way lands", table.get("n1").body === "call plumber re leak" && !saved.conflict);
check("…as ONE conditional update, not an upsert", writes.length === 1 && writes[0].kind === "update" && writes[0].filters.some(([c]) => c === "updated_at"));

// ── 2. the Watch dictation survives an old draft ─────────────────────────────
reset();
seen = seed({ id: "n2", title: "Captured — Sep 28", body: "a\nb\nc" });
// The Watch appends while the phone's editor sits open on the 3-line version.
Object.assign(table.get("n2"), { body: "a\nb\nc\nd (watch)\ne (watch)", updated_at: stamp() });
saved = await db.saveNote({ id: "n2", title: "Captured — Sep 28", body: "a\nb\nc (typo fixed)" }, { base: seen });
check("a stale draft never overwrites words that arrived since", table.get("n2").body === "a\nb\nc\nd (watch)\ne (watch)");
check("…the draft is saved as its own note instead", saved.conflict?.originalId === "n2" && saved.id !== "n2" && table.get(saved.id)?.body === "a\nb\nc (typo fixed)");
check("…named so it can be found", /conflicted copy/.test(table.get(saved.id)?.title || ""));
check("…and the caller is told the words moved, not that the note was deleted", saved.conflict?.reason === "changed");

// ── 3. only metadata moved: rebase, keep both changes ────────────────────────
reset();
seen = seed({ id: "n3", title: "Groceries", body: "milk", pinned: false, color: null });
// Another device archives + pins it (bulkUpdateNotes stamps updated_at).
Object.assign(table.get("n3"), { pinned: true, archived: true, updated_at: stamp() });
saved = await db.saveNote({ id: "n3", title: "Groceries", body: "milk\neggs", pinned: false, color: "green" }, { base: seen });
const n3 = table.get("n3");
check("a metadata-only move is rebased onto, not treated as a conflict", !saved.conflict && n3.body === "milk\neggs");
check("…the other device's pin survives (this editor never changed it)", n3.pinned === true);
check("…and so does its archive", n3.archived === true);
check("…while this editor's own seal change lands", n3.color === "green");

// ── 4. its own words already there: no duplicate ─────────────────────────────
reset();
seen = seed({ id: "n4", title: "", body: "old" });
// A save whose answer was lost: the server has the new words, the editor's base is old.
Object.assign(table.get("n4"), { body: "new", updated_at: stamp() });
const before = table.size;
saved = await db.saveNote({ id: "n4", title: "", body: "new" }, { base: seen });
check("replaying words the server already holds makes no copy", !saved.conflict && table.size === before && saved.body === "new");

// ── 5. binned elsewhere: the words are not written into the bin ──────────────
reset();
seen = seed({ id: "n5", title: "Ideas", body: "one" });
Object.assign(table.get("n5"), { deleted_at: stamp(), updated_at: stamp() });
saved = await db.saveNote({ id: "n5", title: "Ideas", body: "one\ntwo" }, { base: seen });
check("a note deleted on another device gets the draft as a NEW note", saved.conflict?.reason === "deleted" && table.get("n5").body === "one" && table.get(saved.id)?.body === "one\ntwo");

// ── 6. no base: the plain upsert it always was ───────────────────────────────
reset();
saved = await db.saveNote({ id: "n6", title: "", body: "fresh" });
check("a brand-new note (no base) is a plain upsert", writes.length === 1 && writes[0].kind === "upsert" && table.get("n6")?.body === "fresh");
// Purged from the bin meanwhile: nothing to protect, so the words go back in.
reset();
saved = await db.saveNote({ id: "n7", title: "", body: "still here" }, { base: { id: "n7", title: "", body: "x", updated_at: "2026-01-01T00:00:00.000Z" } });
check("a row that no longer exists is re-created rather than lost", table.get("n7")?.body === "still here" && !saved.conflict);

// ── 7. the wiring: both editors send their base ──────────────────────────────
const { readFile } = await import("node:fs/promises");
const panel = await readFile("src/pages/personal/NotesPanel.jsx", "utf8");
const tile = await readFile("src/pages/brief/NotesTile.jsx", "utf8");
check("the Notes editor saves through one serialized path with its base",
  /db\.saveNote\(r, \{ base \}\)/.test(panel) && /saveChain\.current\.then\(run, run\)/.test(panel));
check("…and nothing in the panel autosaves around it",
  !/db\.saveNote\(noteRow\(\)\)/.test(panel));
check("closing after a failed save retries it instead of dropping the draft",
  /if \(saveState !== "saving" && saveState !== "error"\) return true;/.test(panel) && /const ok = await flushSave\(\);\s*\n\s*if \(!ok\)/.test(panel));
check("a failed quick-add puts the words back in the box", /setQuick\(q => \(q \? q : t\)\)/.test(panel));
check("an unmount or a hidden page flushes instead of only clearing the timer",
  /document\.addEventListener\("visibilitychange", onHide\)/.test(panel) && /const row = dirtyRow\(\);\s*\n\s*if \(row\) persist\(row\)/.test(panel));
check("every unsaved draft has a rescue copy on the device", /writeRescue\(row\);/.test(panel) && /br_note_rescue/.test(panel));
check("the Brief tile saves with the base it opened", /db\.saveNote\(\{ id: editing\.id, title: editing\.title, body: editing\.body \}, \{ base: editing\.base \}\)/.test(tile));

if (failures) { console.log(`\n${failures} FAILURE(S)\nNOTE CONFLICT SMOKE FAILED`); process.exit(1); }
console.log("\nNOTE CONFLICT SMOKE PASS");
