// ─── Undo, and the four rules that decide whether it is usable ───────────────
//
// The note editor keeps its own undo stack because the browser's is not
// available: the field is controlled, and the bullet helpers rewrite the value
// and move the caret, which clears the native stack in every engine (the long
// version is at the top of src/lib/text-history.js). On the phone — the device
// this app is mostly used from — there was no undo at all.
//
// What makes an undo stack good or useless is entirely in the coalescing, and
// coalescing is not something you can eyeball in a diff. Four rules, each of
// which is a way the feature fails if it is wrong:
//
//   TYPING MERGES, or undo is a character-by-character rewind nobody can use.
//   A DELETION NEVER MERGES, or the one thing this was built for — "I deleted
//     some text by accident" — takes back the deletion AND the sentence you
//     typed before it, in one step, with no way to stop half way.
//   A PAUSE BREAKS THE RUN, or a whole session of typing is one undo.
//   A NEW EDIT TRUNCATES REDO, or a redo after typing can overwrite the words
//     that replaced what you undid.
//
// Run by `npm run verify`.

import { readFileSync } from "node:fs";
import {
  createTextHistory, COALESCE_MS, BIG_EDIT, MAX_ENTRIES,
} from "../src/lib/text-history.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const read = (p) => readFileSync(p, "utf8");
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A typist: pushes one character at a time, `gap` ms apart.
const type = (h, text, { from = "", at = 1000, gap = 60 } = {}) => {
  let body = from, t = at;
  for (const ch of text) { body += ch; t += gap; h.push({ body }, { field: "body", caret: body.length, now: t }); }
  return { body, t };
};

// ── 1. typing is one step ────────────────────────────────────────────────────
{
  const h = createTextHistory({ title: "", body: "" });
  const { body } = type(h, "the quick brown fox");
  check("a run of typing is a single undo, not one per keystroke", h.depth() === 2, `depth ${h.depth()}`);
  check("…and undoing it goes all the way back to empty", h.undo().body === "");
  check("…with redo returning the whole run", h.redo().body === body);
}

// ── 2. THE RULE THIS EXISTS FOR: a deletion is its own step ─────────────────
{
  const h = createTextHistory({ title: "", body: "" });
  const { body, t } = type(h, "a paragraph worth keeping");
  // …and now the accident: a selection replaced, or a chunk deleted.
  h.push({ body: "a paragraph" }, { field: "body", caret: 11, now: t + 50 });
  check("a deletion never merges into the typing before it", h.depth() === 3, `depth ${h.depth()}`);
  const back = h.undo();
  check("one undo restores exactly what was deleted", back.body === body, JSON.stringify(back.body));
  check("…and does NOT also swallow the sentence typed before it", back.body !== "");
}
{
  // The harshest version: select-all and type over it. One character in, the
  // whole note is gone — and one undo has to bring it back.
  const h = createTextHistory({ title: "", body: "" });
  const { body, t } = type(h, "everything I wrote this morning");
  h.push({ body: "x" }, { field: "body", caret: 1, now: t + 40 });
  check("select-all-and-overtype is one undo away from the original",
    h.undo().body === body, "the whole note has to come back in one step");
}
{
  // Deleting one character at a time (holding backspace) must not collapse into
  // the typing either — each backspace is a delete, and deletes never merge.
  const h = createTextHistory({ title: "", body: "abcdef" });
  let body = "abcdef", t = 2000;
  for (let n = 0; n < 3; n++) { body = body.slice(0, -1); t += 40; h.push({ body }, { field: "body", caret: body.length, now: t }); }
  check("held backspace does not merge into a preceding typing run", h.depth() === 4, `depth ${h.depth()}`);
  check("…and steps back one deletion at a time", h.undo().body === "abcd");
}

// ── 3. a pause breaks the run ────────────────────────────────────────────────
{
  const h = createTextHistory({ title: "", body: "" });
  const a = type(h, "first thought");
  const b = type(h, " and later", { from: a.body, at: a.t + COALESCE_MS + 200 });
  check("a pause longer than the window starts a new step", h.depth() === 3, `depth ${h.depth()}`);
  check("…so undo takes back only the later thought", h.undo().body === a.body);
}
{
  const h = createTextHistory({ title: "", body: "" });
  // A paste is a big edit and gets its own step even mid-run.
  type(h, "note: ");
  h.push({ body: "note: " + "x".repeat(BIG_EDIT + 5) }, { field: "body", caret: 6, now: 1400 });
  check("a paste is its own step however fast it lands", h.depth() === 3, `depth ${h.depth()}`);
}
{
  // Moving between fields breaks the run — otherwise one undo would revert an
  // edit to the title and an edit to the body together.
  const h = createTextHistory({ title: "", body: "" });
  type(h, "body text");
  h.push({ title: "T" }, { field: "title", caret: 1, now: 1600 });
  check("a jump to the other field starts a new step", h.depth() === 3, `depth ${h.depth()}`);
  check("…and undoing the title leaves the body alone",
    (() => { const u = h.undo(); return u.title === "" && u.body === "body text"; })());
}

// ── 4. redo is truncated by a new edit ───────────────────────────────────────
{
  const h = createTextHistory({ title: "", body: "" });
  const a = type(h, "one");
  type(h, " two", { from: a.body, at: a.t + COALESCE_MS + 200 });
  h.undo();
  check("there is something to redo after an undo", h.canRedo());
  type(h, " three", { from: "one", at: 9000 });
  check("typing after an undo discards the redo branch", !h.canRedo());
  // And the new typing must not have merged into the entry we undid TO — that
  // would rewrite the thing you just undid rather than adding to it.
  check("…and starts a fresh step rather than rewriting the one undone to",
    h.undo().body === "one", "the undone-to state has to still be reachable");
}

// ── 5. the edges ─────────────────────────────────────────────────────────────
{
  const h = createTextHistory({ title: "", body: "seed" });
  check("nothing to undo at the seed", !h.canUndo() && h.undo() === null);
  check("nothing to redo at the head", !h.canRedo() && h.redo() === null);
  h.push({ body: "seed" }, { field: "body", caret: 4, now: 100 });
  check("a no-op edit records nothing", h.depth() === 1);
  // reset is what stops one note's words appearing while editing another.
  h.push({ body: "seed and more" }, { field: "body", caret: 13, now: 200 });
  h.reset({ title: "", body: "a different note" });
  check("reset clears the stack for a different note", !h.canUndo() && h.depth() === 1);
  check("…and seeds it with the new note's own text", h.current().body === "a different note");
}
{
  const h = createTextHistory({ title: "", body: "" });
  let body = "", t = 0;
  // Each push is separated by more than the window, so every one is its own step.
  for (let n = 0; n < MAX_ENTRIES + 40; n++) { body += "x"; t += COALESCE_MS + 50; h.push({ body }, { field: "body", caret: body.length, now: t }); }
  check("the stack is capped rather than growing without bound", h.depth() === MAX_ENTRIES, `depth ${h.depth()}`);
  check("…and the newest entry survives the cap", h.current().body === body);
}

// ── 6. both editors actually use it ──────────────────────────────────────────
const panel = code(read("src/pages/personal/NotesPanel.jsx"));
const tile = code(read("src/pages/brief/NotesTile.jsx"));
for (const [name, src] of [["the Notes tab editor", panel], ["the Brief tile editor", tile]]) {
  check(`${name} keeps a history`, /createTextHistory\(/.test(src));
  check(`${name} routes its text through one funnel`, /const editText = /.test(src));
  check(`${name} offers a visible Undo`, /undoText/.test(src) && /IcUndo/.test(src));
  check(`${name} reseeds the stack per note`, /historyRef\.current\.reset\(/.test(src));
}
// NO ROUTE MAY CHANGE THE WORDS WITHOUT THE HISTORY SEEING IT. A stray
// setDraft/setEditing on title or body is an edit undo cannot take back, and it
// would look like the button randomly skipping a change.
// EVERY ROUTE THAT OPENS THE EDITOR WITH CONTENT MUST SEED THE STACK. There are
// three — openNote, newNote, and the ⇧Enter hand-off from quick capture — and the
// third was missed on the first pass, which meant the first ⌘Z after capturing a
// thought could paint the PREVIOUS note's words over it. Counted rather than
// pattern-matched: the two have to move together or this fails.
const opens = (panel.match(/setActiveId\(/g) || []).length;
const seeds = (panel.match(/historyRef\.current\.reset\(/g) || []).length;
check("every route that opens the editor seeds the undo stack",
  seeds >= opens - 2, `setActiveId x${opens}, reset x${seeds}`); // -2: the two closes pass null/clear
check("…including the ⇧Enter hand-off from quick capture",
  /setDraft\(\{ title: "", body: t[\s\S]{0,600}?historyRef\.current\.reset\(\{ title: "", body: t \}\)/.test(panel));
check("the Brief tile has no setEditing that writes text behind the funnel's back",
  !/setEditing\(ed => \(\{ \.\.\.ed, (?:title|body): e\.target/.test(tile));
// pinned/color deliberately stay OUT of the history — undoing a seal is not what
// ⌘Z means, and folding them in would make an undo after typing change a colour.
check("the seal and the pin are not on the undo stack",
  !/historyRef\.current\.push\([^)]*color/.test(panel) && !/historyRef\.current\.push\([^)]*pinned/.test(panel));
// The restored text has to be saved, or undo works until the next reload.
check("an undo is autosaved like any other edit",
  /skipNextAutosave` is NOT|skipNextAutosave is NOT/.test(read("src/pages/personal/NotesPanel.jsx"))
  || !/applyHistory[\s\S]{0,400}skipNextAutosave\.current = true/.test(panel));
// The browser's own undo must be suppressed where we handle it, or two stacks
// fight and the field ends up in a state neither of them describes.
check("⌘Z is prevented from also running the browser's broken native undo",
  /e\.preventDefault\(\); undoText\(\)/.test(panel) && /e\.preventDefault\(\); undoText\(\)/.test(tile));

console.log(`\n${failed ? `${failed} FAILURE(S)` : "TEXT HISTORY SMOKE: ALL CLEAN"}`);
if (failed) { console.error("TEXT HISTORY SMOKE FAILED"); process.exit(1); }
