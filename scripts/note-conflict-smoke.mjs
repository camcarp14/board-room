// Note saves are conditional on the version the editor opened — RUN, not read.
//
// THE BUG THIS PINS. db.saveNote upserted the whole row unconditionally and an
// open editor never re-read its note. Open a note on the phone, lock it, dictate
// two lines into it from the Watch (note-capture appends and stamps updated_at),
// unlock, fix a typo: the autosave wrote the old body over the new one and the
// editor said "Saved". saveNote now writes only if nobody else has since, and
// src/lib/note-saver.js feeds it what it needs to tell "somebody else" from "a
// save of mine whose answer got lost".
//
// The first version of this fix passed a text-pinned smoke and then failed an
// adversarial review on nine counts, every one of them a SEQUENCE: a response
// lost after the write committed, a delete that never touches updated_at, a
// redirect outliving its session, a retry minting a second copy. So this file
// runs sequences. db.js and note-saver.js are bundled with esbuild and
// lib/supabase.js is replaced by an in-memory personal_notes table that behaves
// like PostgREST where it matters: filters on update, `is(deleted_at, null)`,
// a missing column on a pre-0036 database, and a write that COMMITS and then
// throws — which is what a phone locking mid-request looks like from here.
import { build } from "esbuild";
import path from "node:path";
import { readFile, rm as rmFile } from "node:fs/promises";
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
  stdin: {
    contents: `export { db } from "./src/data/db.js"; export { createNoteSaver, noteBase } from "./src/lib/note-saver.js";`,
    resolveDir: process.cwd(), loader: "js",
  },
  bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error",
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
const { db, createNoteSaver } = mod;

// ── the fake table ────────────────────────────────────────────────────────────
const table = new Map();
const log = [];
// loseUpdate / loseUpsert: the next N writes of that kind COMMIT, then throw.
const net = { loseUpdate: 0, loseUpsert: 0, noBin: false };
let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 8, 28, 12, 0, 0) + ++tick * 1000).toISOString();
// PostgREST hands timestamps back in its own format; the client compares them
// as instants, never as strings, so the fake does the same.
const pg = (iso) => iso ? new Date(iso).toISOString().replace("Z", "+00:00") : iso;
const loseMaybe = (kind, result) => {
  if (net[kind] > 0) { net[kind]--; throw new TypeError("Load failed"); }
  return result;
};
const same = (c, a, b) => (c === "updated_at" ? Date.parse(a) === Date.parse(b) : a === b);
globalThis.__notes = {
  from: () => ({
    upsert: (row) => {
      const exec = async () => {
        const prev = table.get(row.id) || { deleted_at: null, archived: false, pinned: false, color: null, created_at: row.updated_at };
        const next = { ...prev, ...row, updated_at: pg(row.updated_at || stamp()) };
        table.set(row.id, next);
        log.push({ kind: "upsert", id: row.id });
        return loseMaybe("loseUpsert", { data: { ...next }, error: null });
      };
      const q = { select: () => q, abortSignal: () => q, single: exec };
      return q;
    },
    update: (patch) => {
      const filters = [];
      let binFilter = false;
      const q = {
        eq: (c, v) => { filters.push([c, v]); return q; },
        is: (c, v) => { if (c === "deleted_at" && v === null) binFilter = true; return q; },
        abortSignal: () => q,
        select: () => q,
        then: (res, rej) => (async () => {
          if (binFilter && net.noBin) return { data: null, error: { code: "42703", message: 'column personal_notes.deleted_at does not exist' } };
          const hits = [...table.values()].filter((r) => filters.every(([c, v]) => same(c, r[c], v)) && (!binFilter || r.deleted_at == null));
          for (const r of hits) Object.assign(r, patch, patch.updated_at ? { updated_at: pg(patch.updated_at) } : {});
          log.push({ kind: "update", filters: filters.map(([c]) => c), bin: binFilter, hits: hits.length });
          return loseMaybe(hits.length ? "loseUpdate" : "none", { data: hits.map((r) => ({ ...r })), error: null });
        })().then(res, rej),
      };
      return q;
    },
    select: () => {
      const filters = [];
      const q = {
        eq: (c, v) => { filters.push([c, v]); return q; },
        abortSignal: () => q,
        maybeSingle: async () => ({ data: (() => { const r = [...table.values()].find((x) => filters.every(([c, v]) => x[c] === v)); return r ? { ...r } : null; })(), error: null }),
      };
      return q;
    },
  }),
};
const seed = (row) => {
  const r = { pinned: false, color: null, archived: false, deleted_at: null, title: "", body: "", ...row, updated_at: pg(stamp()) };
  table.set(r.id, r);
  return { ...r };
};
const reset = () => { table.clear(); log.length = 0; net.loseUpdate = 0; net.loseUpsert = 0; net.noBin = false; };
const copies = () => [...table.values()].filter((r) => /conflicted copy/i.test(r.title || ""));

// ════════ db.saveNote ════════════════════════════════════════════════════════

// 1. nothing in the way
reset();
let base = seed({ id: "n1", body: "call plumber" });
let saved = await db.saveNote({ id: "n1", title: "", body: "call plumber re leak" }, { base });
check("a save with nothing in the way lands, as one conditional update", table.get("n1").body === "call plumber re leak" && !saved.conflict && log.length === 1 && log[0].kind === "update" && log[0].filters.includes("updated_at"));
check("…which refuses a binned row (deleted_at is null is part of the compare)", log[0].bin === true);

// 2. the Watch dictation survives an old draft
reset();
base = seed({ id: "n2", title: "Captured — Sep 28", body: "a\nb\nc" });
Object.assign(table.get("n2"), { body: "a\nb\nc\nd (watch)", updated_at: pg(stamp()) });
saved = await db.saveNote({ id: "n2", title: "Captured — Sep 28", body: "a\nb\nc!" }, { base, copyId: "copy-2" });
check("a stale draft never overwrites words that arrived since", table.get("n2").body === "a\nb\nc\nd (watch)");
check("…the draft becomes its own note, under the id the caller fixed", saved.id === "copy-2" && table.get("copy-2")?.body === "a\nb\nc!" && saved.conflict?.reason === "changed");

// 3. only metadata moved: rebase, keep both sides' flags
reset();
base = seed({ id: "n3", title: "Groceries", body: "milk" });
Object.assign(table.get("n3"), { pinned: true, archived: true, updated_at: pg(stamp()) });
saved = await db.saveNote({ id: "n3", title: "Groceries", body: "milk\neggs", pinned: false, color: "green" }, { base });
const n3 = table.get("n3");
check("a metadata-only move is rebased onto, not a conflict", !saved.conflict && n3.body === "milk\neggs" && copies().length === 0);
check("…the other device's pin and archive survive; this editor's seal lands", n3.pinned === true && n3.archived === true && n3.color === "green");

// 4. a seal change alone, after another device archived (review M4)
reset();
base = seed({ id: "n4", title: "", body: "ideas" });
Object.assign(table.get("n4"), { archived: true, updated_at: pg(stamp()) });
saved = await db.saveNote({ id: "n4", title: "", body: "ideas", pinned: false, color: "blue" }, { base });
check("a seal-only edit is not swallowed when the stamp moved under it", table.get("n4").color === "blue" && !saved.conflict);

// 4b. an unchanged flag is never sent on a save that wins the compare
reset();
base = seed({ id: "n4b", title: "", body: "list", pinned: false });
Object.assign(table.get("n4b"), { pinned: true, updated_at: pg(stamp()) });   // another device pins it…
base = { ...base, pinned: true, updated_at: table.get("n4b").updated_at };     // …the editor adopts the fresh row
saved = await db.saveNote({ id: "n4b", title: "", body: "list + more", pinned: false, color: null }, { base: { ...base, pinned: false } });
check("a save that wins the compare doesn't put back a pin it never changed", table.get("n4b").pinned === true && table.get("n4b").body === "list + more");

// 5. a REAL delete: deleted_at set, updated_at untouched (review M2)
reset();
base = seed({ id: "n5", title: "Ideas", body: "one" });
table.get("n5").deleted_at = pg(stamp());  // exactly what db.deleteNotes writes
saved = await db.saveNote({ id: "n5", title: "Ideas", body: "one\ntwo" }, { base, copyId: "copy-5" });
check("words typed into a note binned elsewhere never land in the bin", table.get("n5").body === "one");
check("…they are saved as a new note, and the caller is told it was a delete", saved.conflict?.reason === "deleted" && table.get("copy-5")?.body === "one\ntwo");

// 6. a pre-0036 database has no deleted_at: step down, don't fail
reset(); net.noBin = true;
base = seed({ id: "n6", body: "v1" });
saved = await db.saveNote({ id: "n6", title: "", body: "v2" }, { base });
check("with no bin column the compare steps down to the stamp alone", table.get("n6").body === "v2" && !saved.conflict);

// 7. my own write, its answer lost (review H2)
reset();
base = seed({ id: "n7", body: "call" });
const mine = new Set();
const s1 = new Date(Date.UTC(2026, 8, 28, 13, 0, 0)).toISOString(); mine.add(Date.parse(s1));
net.loseUpdate = 1;
let threw = false;
try { await db.saveNote({ id: "n7", title: "", body: "call plumber" }, { base, stamp: s1, mine }); } catch { threw = true; }
check("(the first save committed and then 'Load failed')", threw && table.get("n7").body === "call plumber");
const s2 = new Date(Date.UTC(2026, 8, 28, 13, 0, 1)).toISOString(); mine.add(Date.parse(s2));
saved = await db.saveNote({ id: "n7", title: "", body: "call plumber tomorrow" }, { base, stamp: s2, mine, copyId: "copy-7" });
check("the next save recognises the committed write as its own — no conflicted copy", !saved.conflict && table.get("n7").body === "call plumber tomorrow" && !table.has("copy-7"));
// …and without `mine` the same sequence is exactly the false copy the review found
reset();
base = seed({ id: "n7b", body: "call" });
net.loseUpdate = 1;
try { await db.saveNote({ id: "n7b", title: "", body: "call plumber" }, { base }); } catch {}
saved = await db.saveNote({ id: "n7b", title: "", body: "call plumber tomorrow" }, { base, copyId: "copy-7b" });
check("(control: without the session's stamps it WOULD have filed a false copy)", saved.conflict?.reason === "changed");

// 8. a retried copy is the same row again, not a second copy
reset();
base = seed({ id: "n8", title: "T", body: "x" });
Object.assign(table.get("n8"), { body: "x (watch)", updated_at: pg(stamp()) });
net.loseUpsert = 1;   // the copy is written, its answer never arrives
let lostCopy = false;
try { await db.saveNote({ id: "n8", title: "T", body: "y" }, { base, copyId: "copy-8" }); } catch { lostCopy = true; }
saved = await db.saveNote({ id: "n8", title: "T", body: "y" }, { base, copyId: "copy-8" });
check("a copy whose answer was lost, retried, is still ONE copy", lostCopy && copies().length === 1 && table.get("copy-8")?.body === "y" && table.get("n8").body === "x (watch)");

// 9. no base, and a row purged meanwhile
reset();
saved = await db.saveNote({ id: "n9", title: "", body: "fresh" });
check("a brand-new note (no base) is a plain upsert", log.length === 1 && log[0].kind === "upsert" && table.get("n9")?.body === "fresh");
reset();
saved = await db.saveNote({ id: "n10", title: "", body: "still here" }, { base: { id: "n10", title: "", body: "x", updated_at: "2026-01-01T00:00:00.000Z" } });
check("a row purged from the bin meanwhile is re-created, not lost", table.get("n10")?.body === "still here" && !saved.conflict);

// ════════ note-saver: the session rules (review H1, H2, M6) ═══════════════════
let uuidN = 0;
const saver = () => createNoteSaver({ save: (r, o) => db.saveNote(r, o), uuid: () => `uuid-${++uuidN}` });

// H1 — a conflict redirect belongs to the session that made it
reset();
{
  const sv = saver();
  const a = seed({ id: "A", title: "Plan", body: "v1" });
  sv.learn(a);
  const sess1 = sv.newSession();
  Object.assign(table.get("A"), { body: "v1 + watch", updated_at: pg(stamp()) });
  const r1 = await sv.enqueue(sess1, { id: "A", title: "Plan", body: "v1 edited" });
  const copyId = r1.id;
  check("session 1 conflicts onto a copy", r1.conflict?.originalId === "A" && table.get(copyId)?.body === "v1 edited");
  const r1b = await sv.enqueue(sess1, { id: "A", title: "Plan", body: "v1 edited more" });
  check("…and its next save follows the draft onto that copy", r1b.id === copyId && table.get("A").body === "v1 + watch");
  // reopen A later to merge by hand: a NEW session, based on what the list shows
  sv.learn({ ...table.get("A") });
  const sess2 = sv.newSession();
  await sv.enqueue(sess2, { id: "A", title: "Plan", body: "merged by hand" });
  check("reopening the original writes the ORIGINAL, never the copy", table.get("A").body === "merged by hand" && table.get(copyId).body === "v1 edited more");
}

// H2 end to end — a lost answer inside a session files no copy
reset();
{
  const sv = saver();
  sv.learn(seed({ id: "B", body: "draft" }));
  const sess = sv.newSession();
  net.loseUpdate = 1;
  await sv.enqueue(sess, { id: "B", title: "", body: "draft 2" }).catch(() => {});
  const r = await sv.enqueue(sess, { id: "B", title: "", body: "draft 3" });
  check("hide-flush lost, keep typing: the next save lands on the same note, no copy", !r.conflict && table.get("B").body === "draft 3" && copies().length === 0);
}

// M6 — bases are per note, and never move backwards
reset();
{
  const sv = saver();
  const a = seed({ id: "C", body: "c" });
  const b = seed({ id: "D", body: "d" });
  sv.learn(a); sv.learn(b);
  const sA = sv.newSession();
  const pA = sv.enqueue(sA, { id: "C", title: "", body: "c2" });
  const sB = sv.newSession();          // the editor moved to D before C's save answered
  await pA;
  check("a late save for one note leaves another note's base alone", sv.baseOf("D")?.body === "d" && sv.baseOf("C")?.body === "c2");
  log.length = 0;
  await sv.enqueue(sB, { id: "D", title: "", body: "d2" });
  check("…so that note's first save is still conditional", log[0]?.kind === "update" && log[0].filters.includes("updated_at"));
  sv.learn({ ...b });                  // a stale list row
  check("a stale list row never moves a base backwards", sv.baseOf("D")?.body === "d2");
}

// a cancelled session sends nothing; the chain runs in order
reset();
{
  const sv = saver();
  sv.learn(seed({ id: "E", body: "e" }));
  const sess = sv.newSession();
  sess.cancelled = true;
  const r = await sv.enqueue(sess, { id: "E", title: "", body: "e2" });
  check("a session closed by a delete sends nothing more", r === null && table.get("E").body === "e" && log.length === 0);
  const s2 = sv.newSession();
  const order = [];
  const p1 = sv.enqueue(s2, { id: "E", title: "", body: "one" }).then(() => order.push(1));
  const p2 = sv.enqueue(s2, { id: "E", title: "", body: "two" }).then(() => order.push(2));
  await Promise.all([p1, p2]);
  check("saves from one editor run in single file, in order", order.join() === "1,2" && table.get("E").body === "two" && copies().length === 0);
}

// ════════ wiring: both editors use it ═════════════════════════════════════════
const panel = await readFile("src/pages/personal/NotesPanel.jsx", "utf8");
const tile = await readFile("src/pages/brief/NotesTile.jsx", "utf8");
check("the Notes editor saves only through the saver", /createNoteSaver\(\{ save: \(row, opts\) => db\.saveNote\(row, opts\) \}\)/.test(panel) && /saver\.enqueue\(session, row\)/.test(panel) && !/db\.saveNote\(noteRow\(\)/.test(panel));
check("every editor open starts a new session", (panel.match(/beginSession\(\);/g) || []).length >= 4);
check("a failed delete reopens the session instead of leaving saves to vanish",
  (panel.match(/if \(sessionRef\.current\.cancelled\) \{ beginSession\(\);/g) || []).length === 2 &&
  /if \(!saved\) throw new Error\(/.test(panel));
check("a delete closes the session and drains before deleting", /sessionRef\.current\.cancelled = true;\s*\n\s*await saver\.drain\(\);/.test(panel));
check("an emptied draft or a deleted note takes its rescue with it", /dropRescue\(\[activeId\]\)/.test(panel) && /dropRescue\(\[n\.id\]\)/.test(panel) && /dropRescue\(\[\.\.\.selected\]\)/.test(panel));
check("a rescue never reopens under another account, or while its own tab is alive", /const foreign = r\.uid && uid && r\.uid !== uid;/.test(panel) && /r\.tab !== TAB_ID && Date\.now\(\) - \(r\.beat \|\| 0\) < 30_000/.test(panel));
check("close is bounded and re-flushes what was typed during the flush", /new Promise\(\(r\) => setTimeout\(\(\) => r\("slow"\), 6000\)\)/.test(panel) && /if \(editSeq\.current === seq\) break;/.test(panel));
check("a suppressor can't leak past a close", /if \(!activeId\) \{ skipNextAutosave\.current = false; return; \}/.test(panel));
check("the Brief tile sends its session's stamps and a fixed copy id", /mine: editing\.sent, copyId: editing\.copyId/.test(tile));

if (failures) { console.log(`\n${failures} FAILURE(S)\nNOTE CONFLICT SMOKE FAILED`); process.exit(1); }
console.log("\nNOTE CONFLICT SMOKE PASS");
