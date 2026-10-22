// ─── Notes widget smoke — the Home Screen shows what the Brief shows ─────────
//
// scriptable/board-room-notes.js puts notes on the iPhone Home Screen, fed by
// trmnl.js?view=notes. Four promises, and each one is broken by a failure that
// nothing else in `npm run verify` would see:
//
//  1. THE SAME NOTES AS THE BRIEF, IN THE SAME ORDER. trmnl.js cannot import
//     src/lib (see audit.js on esbuild), so it carries copies of applyNotesOrder
//     and onBrief. A copy that drifts puts an archived or Off-the-Brief note on
//     the Home Screen, or a different note on top, and both surfaces look fine
//     on their own. The copies are run beside the originals here.
//  2. NEVER THE BIN, AND NEVER A WRONG ANSWER STATED CONFIDENTLY. The read climbs
//     down a column ladder for databases that predate a migration; a ladder that
//     steps past a real error to a narrower select quietly drops the filters.
//  3. THE NOTES VIEW READS ONLY NOTES, behind the same token as the rest.
//  4. THE WIDGET RUNS. It executes on a phone, in Scriptable, where nothing here
//     can reach it — so it is run under scripts/scriptable-mock.mjs at every size
//     and in every state (no token, wrong token, offline, stale, empty, an old
//     site), fed by the real renderer's output rather than a hand-made payload.
//
// Bare Node plus esbuild. Run by `npm run verify`.

import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import esbuild from "esbuild";
import { applyNotesOrder } from "../src/lib/notes-order.js";
import { onBrief, homescreenNotes } from "../src/lib/notes-shelf.js";
import { resolveTitle } from "../netlify/functions/note-capture.js";
import { runWidget, texts, urls } from "./scriptable-mock.mjs";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};
const read = (p) => readFileSync(p, "utf8");
/** Strip comments so prose about a rule cannot satisfy a test for it. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const ids = (rows) => rows.map((n) => n.id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ─── bundle trmnl.js, with Supabase replaced by a recorder ───────────────────
// The fake answers every query through globalThis.__fakeSupabase.answer and
// records it in .queries, so the handler can be driven end to end without a
// network and its reads inspected afterwards.
const DIR = ".notes-widget-smoke";
const FAKE_SUPABASE = `
const st = () => globalThis.__fakeSupabase;
exports.createClient = () => ({
  from(table) {
    const q = { table, ops: [] };
    const b = {};
    for (const op of ["select", "eq", "is", "not", "in", "order", "limit", "maybeSingle"]) {
      b[op] = (...a) => { q.ops.push([op, ...a]); return b; };
    }
    b.then = (ok, bad) => { st().queries.push(q); return Promise.resolve(st().answer(q)).then(ok, bad); };
    return b;
  },
});
`;
let fn = null;
try {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/fake-supabase.cjs`, FAKE_SUPABASE);
  esbuild.buildSync({
    entryPoints: ["netlify/functions/trmnl.js"], bundle: true, platform: "node", format: "cjs",
    outfile: `${DIR}/trmnl.cjs`, alias: { "@supabase/supabase-js": `./${DIR}/fake-supabase.cjs` }, logLevel: "silent",
  });
  fn = createRequire(import.meta.url)(resolve(`${DIR}/trmnl.cjs`));
} catch (e) {
  check("trmnl.js bundles for execution", false, (e.message || String(e)).split("\n")[0]);
} finally {
  rmSync(DIR, { recursive: true, force: true });
}
check("trmnl.js exports the notes pieces for this smoke",
  ["renderNotes", "orderNotes", "onBriefNote", "resolveNoteTitle", "loadNotes", "handler"].every((k) => typeof fn?.[k] === "function"));
if (!fn) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}

// ─── fixtures ────────────────────────────────────────────────────────────────
// 10am CDT on Thursday Oct 22 2026.
const NOW = Date.parse("2026-10-22T15:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const ROWS = [
  { id: "a", title: "Groceries", body: "- eggs\n- milk\n\n\n- bread", updated_at: ago(5) },
  { id: "b", title: "", body: "call the roofer\nabout the gutter", updated_at: ago(60), color: "brass", pinned: true },
  { id: "c", title: "Long list", body: "one\ntwo", updated_at: ago(120), brief_hidden: true },
  { id: "d", title: "Old idea", body: "x", updated_at: ago(600), archived: true },
  { id: "e", title: "Binned", body: "x", updated_at: ago(1), deleted_at: ago(1) },
  { id: "f", title: "Captured — Oct 22", body: "- 9:14 AM · grout sealer", updated_at: ago(30) },
  { id: "g", title: "Captured — Oct 21", body: "- 8:00 PM · return the drill", updated_at: ago(1000) },
  { id: "h", title: "groceries list", body: "y", updated_at: ago(2) },
  { id: "i", title: "Groceries", body: "an archived older copy", updated_at: ago(1), archived: true },
  { id: "j", title: "Seal test", body: "z", updated_at: ago(3), color: "purple" },
];
// A deleted id, an id twice, and notes left out of it entirely — the three ways
// a saved order disagrees with the table it orders.
const ORDER = ["f", "zz-gone", "b", "a", "b", "c", "d"];

// ─── 1. the copies agree with the app ────────────────────────────────────────
for (const [name, order] of [["the saved order", ORDER], ["no saved order", null], ["an empty order", []], ["an order of only unknown ids", ["x", "y"]]]) {
  check(`orderNotes is applyNotesOrder — ${name}`, same(ids(fn.orderNotes(ROWS, order)), ids(applyNotesOrder(ROWS, order))),
    `${ids(fn.orderNotes(ROWS, order))} vs ${ids(applyNotesOrder(ROWS, order))}`);
}
{
  let agree = true;
  for (const deleted_at of [null, ago(1)]) for (const archived of [false, true]) for (const brief_hidden of [false, true]) {
    const n = { id: "x", deleted_at, archived, brief_hidden };
    if (fn.onBriefNote(n) !== onBrief(n)) agree = false;
  }
  // A pre-0036 row has none of the three columns at all.
  if (fn.onBriefNote({ id: "x" }) !== onBrief({ id: "x" })) agree = false;
  check("onBriefNote is onBrief, over every combination of the three flags and none", agree);
}
{
  const instants = [
    ["a Chicago late evening that is already tomorrow in UTC", Date.parse("2026-08-08T04:40:00Z")],
    ["a CST morning", Date.parse("2027-01-04T14:00:00Z")],
    ["NOW", NOW],
  ];
  const templates = ["Captured — {date}", "{weekday} list", "{month} {day}, {year}", "Errands {TODAY}", "plain title"];
  let agree = true, detail = "";
  for (const [, t] of instants) for (const tpl of templates) {
    if (fn.resolveNoteTitle(tpl, t) !== resolveTitle(tpl, t)) { agree = false; detail = `${tpl}: ${fn.resolveNoteTitle(tpl, t)} vs ${resolveTitle(tpl, t)}`; }
  }
  check("resolveNoteTitle is note-capture's resolveTitle, so a widget and the watch name the same day's note", agree, detail);
}

// ─── 2. the Brief's notes ────────────────────────────────────────────────────
{
  const out = fn.renderNotes({ notes: ROWS, order: ORDER }, { now: NOW });
  const want = homescreenNotes(applyNotesOrder(ROWS, ORDER));
  check("brief mode draws exactly the Brief tile's notes, in its order", same(ids(out.notes), ids(want)), `${ids(out.notes)} vs ${ids(want)}`);
  check("…and counts the same set", out.total === want.length && out.mode === "brief");
  check("…never the bin, the archive, or a note taken Off the Brief",
    !ids(out.notes).some((id) => ["e", "d", "i", "c"].includes(id)));
  const b = out.notes.find((n) => n.id === "b");
  check("a sealed, pinned note keeps its seal and pin", b?.seal === "brass" && b?.pinned === true);
  check("a color that is not one of the four seals is sent as no seal", out.notes.find((n) => n.id === "j")?.seal === null);
  check("bodies and titles arrive trimmed", out.notes.every((n) => n.body === n.body.trim() && n.title === n.title.trim()));

  const many = Array.from({ length: 30 }, (_, k) => ({ id: `n${k}`, title: `N${k}`, body: "", updated_at: ago(k) }));
  const capped = fn.renderNotes({ notes: many }, { now: NOW });
  check("the list is capped, and the total still counts all of them", capped.notes.length === 12 && capped.total === 30);
  check("no notes is an empty list, not an error", same(fn.renderNotes({ notes: [] }, { now: NOW }).notes, []));
}
{
  const long = "a".repeat(599) + "😀😀😀";
  const n = fn.renderNotes({ notes: [{ id: "x", title: "", body: long, updated_at: ago(1) }] }, { now: NOW }).notes[0];
  check("a long body is cut to the list cap and says so", Array.from(n.body).length === 600 && n.clipped === true);
  check("…on a code point, never through the middle of an emoji", !/[\uD800-\uDBFF]$/.test(n.body) && n.body.endsWith("😀"));
  const one = fn.renderNotes({ notes: [{ id: "x", title: "Big", body: "b".repeat(5000), updated_at: ago(1) }] }, { note: "Big", now: NOW }).notes[0];
  check("one note by name gets the larger cap", one.body.length === 4000 && one.clipped === true);
}

// ─── 3. one note, by name ────────────────────────────────────────────────────
{
  const pick = (note, now = NOW, rows = ROWS) => fn.renderNotes({ notes: rows, order: ORDER }, { note, now });
  check("an exact title wins over a newer note whose title merely starts with it", pick("groceries").notes[0]?.id === "a");
  check("…and over a newer ARCHIVED note with the same title", pick("Groceries").notes[0]?.id === "a");
  check("an exact archived title still beats a prefix match",
    pick("Groceries", NOW, ROWS.filter((n) => n.id !== "a")).notes[0]?.id === "i");
  check("a prefix picks the newest daily list", pick("Captured").notes[0]?.id === "f");
  check("{date} names today's list, in Chicago", pick("Captured — {date}").notes[0]?.id === "f" && pick("Captured — {date}").match === "Captured — Oct 22");
  check("…still today's at 11:30pm Central, when UTC has moved on",
    pick("Captured — {date}", Date.parse("2026-10-23T04:30:00Z")).notes[0]?.id === "f");
  const tomorrow = pick("Captured — {date}", Date.parse("2026-10-23T05:30:00Z"));
  check("…and nothing just after midnight, until the watch starts one", tomorrow.notes.length === 0 && tomorrow.total === 0 && tomorrow.match === "Captured — Oct 23" && tomorrow.mode === "note");
  check("a note taken Off the Brief can still have a widget of its own", pick("long list").notes[0]?.id === "c");
  check("the bin is never a match", pick("Binned").notes.length === 0);
  check("an untitled note is never a match for its words", pick("call").notes.length === 0);
  check("whitespace around a name is ignored", pick("  Long list  ").notes[0]?.id === "c");
}

// ─── 4. the read, against a recorded client ──────────────────────────────────
const UID = "00000000-0000-4000-8000-000000000001";
function fakeClient(answer) {
  const queries = [];
  const client = {
    from(table) {
      const q = { table, ops: [] };
      const b = {};
      for (const op of ["select", "eq", "is", "not", "in", "order", "limit", "maybeSingle"]) b[op] = (...a) => { q.ops.push([op, ...a]); return b; };
      b.then = (ok, bad) => { queries.push(q); return Promise.resolve(answer(q, queries)).then(ok, bad); };
      return b;
    },
  };
  return { client, queries };
}
const has = (q, ...op) => q.ops.some((o) => same(o, op));
const colsOf = (q) => (q.ops.find((o) => o[0] === "select") || [])[1] || "";
const missing = (col) => ({ data: null, error: { code: "42703", message: `column personal_notes.${col} does not exist` } });
const notesAnswer = (gate) => (q) => (q.table === "app_settings" ? { data: { setting_value: ORDER }, error: null } : gate(q));
{
  const { client, queries } = fakeClient(notesAnswer(() => ({ data: ROWS, error: null })));
  const r = await fn.loadNotes(client, UID);
  const notes = queries.filter((q) => q.table === "personal_notes");
  const settings = queries.find((q) => q.table === "app_settings");
  check("a current database is one read, with every column the Brief filters on",
    notes.length === 1 && /brief_hidden/.test(colsOf(notes[0])) && /archived/.test(colsOf(notes[0])) && !r.errors.length);
  check("…which excludes the bin in the query itself", has(notes[0], "is", "deleted_at", null));
  check("…and is scoped to the owner", has(notes[0], "eq", "user_id", UID) && has(settings, "eq", "user_id", UID));
  check("the saved order is read from app_settings.notes_order", has(settings, "eq", "setting_key", "notes_order") && same(r.order, ORDER));
}
{
  const { client, queries } = fakeClient(notesAnswer((q) => (/brief_hidden/.test(colsOf(q)) ? missing("brief_hidden") : { data: ROWS, error: null })));
  const r = await fn.loadNotes(client, UID);
  const notes = queries.filter((q) => q.table === "personal_notes");
  check("before 0042, the read steps down one rung and keeps the bin filter",
    notes.length === 2 && !/brief_hidden/.test(colsOf(notes[1])) && has(notes[1], "is", "deleted_at", null) && !r.errors.length);
}
{
  const { client, queries } = fakeClient(notesAnswer((q) => (/archived|deleted_at/.test(colsOf(q)) || q.ops.some((o) => o[1] === "deleted_at") ? missing("deleted_at") : { data: ROWS, error: null })));
  const r = await fn.loadNotes(client, UID);
  const notes = queries.filter((q) => q.table === "personal_notes");
  check("before 0036, it reaches the seals-only read, which has no bin to filter",
    notes.length === 3 && !has(notes[2], "is", "deleted_at", null) && /color/.test(colsOf(notes[2])) && !r.errors.length);
}
{
  const { client, queries } = fakeClient(notesAnswer(() => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })));
  const r = await fn.loadNotes(client, UID);
  check("a failure that is not a missing column is reported, never stepped past to a narrower read",
    queries.filter((q) => q.table === "personal_notes").length === 1 && r.errors.some((e) => /personal_notes: canceling/.test(e)));
}
{
  const { client } = fakeClient((q) => (q.table === "app_settings" ? { data: null, error: { message: "boom" } } : { data: ROWS, error: null }));
  const r = await fn.loadNotes(client, UID);
  check("a failed order read is an error too, not a silent newest-first", r.errors.some((e) => /app_settings: boom/.test(e)));
}
{
  const { client } = fakeClient((q) => (q.table === "app_settings" ? { data: { setting_value: { not: "an array" } }, error: null } : { data: ROWS, error: null }));
  check("an order that is not an array is no order", (await fn.loadNotes(client, UID)).order === null);
}

// ─── 5. the handler ──────────────────────────────────────────────────────────
const ENV = { TRMNL_TOKEN: "smoke-trmnl-token-0123456789", SUPABASE_URL: "https://smoke.invalid", SUPABASE_SERVICE_ROLE_KEY: "smoke-service", BOARD_USER_ID: UID };
const ENV_KEYS = [...Object.keys(ENV), "TRMNL_USER_ID", "MINER_USER_ID"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of ENV_KEYS) delete process.env[k];
Object.assign(process.env, ENV);
const call = async (qs, answer = notesAnswer(() => ({ data: ROWS, error: null }))) => {
  globalThis.__fakeSupabase = { queries: [], answer };
  const res = await fn.handler({ httpMethod: "GET", queryStringParameters: qs, headers: {} });
  return { res, body: (() => { try { return JSON.parse(res.body); } catch { return null; } })(), queries: globalThis.__fakeSupabase.queries };
};
try {
  {
    const { res, queries } = await call({ view: "notes" });
    check("the notes view refuses a caller with no token, before any read", res.statusCode === 401 && queries.length === 0);
    const wrong = await call({ view: "notes", token: "x".repeat(ENV.TRMNL_TOKEN.length) });
    check("…and one with a wrong token of the right length", wrong.res.statusCode === 401 && wrong.queries.length === 0);
  }
  {
    const { res, body, queries } = await call({ view: "notes", token: ENV.TRMNL_TOKEN });
    check("with the token it answers the Brief's notes", res.statusCode === 200 && body?.mode === "brief" && Array.isArray(body?.notes) && body.notes.length > 0);
    check("…reading only the notes and their order — no calendar table",
      queries.length >= 2 && queries.every((q) => ["personal_notes", "app_settings"].includes(q.table)));
    check("…and is never cached: an edited note must not show its old words", /no-store/.test(res.headers?.["Cache-Control"] || ""));
  }
  {
    const { body } = await call({ view: "NOTES", token: ENV.TRMNL_TOKEN, note: "Groceries" });
    check("&note= answers one note by name (and the view name is case-blind, like the others)", body?.mode === "note" && body?.notes?.[0]?.id === "a");
  }
  {
    const { res, body } = await call({ view: "notes", token: ENV.TRMNL_TOKEN }, notesAnswer(() => ({ data: null, error: { code: "XX000", message: "db down" } })));
    check("a failed read is a 502 saying why, not an empty list", res.statusCode === 502 && /db down/.test(body?.error || "") && /no-store/.test(res.headers?.["Cache-Control"] || ""));
  }
  {
    const { body, queries } = await call({ token: ENV.TRMNL_TOKEN }, () => ({ data: [], error: null }));
    check("the default view is still the calendar brief, unchanged", Array.isArray(body?.events) && !("notes" in (body || {})) && queries.some((q) => q.table === "personal_events"));
  }
} finally {
  for (const k of ENV_KEYS) { if (savedEnv[k] == null) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  delete globalThis.__fakeSupabase;
}

// ─── 6. the widget, run ──────────────────────────────────────────────────────
const WIDGET = "scriptable/board-room-notes.js";
const SITE = "https://board-room.netlify.app";
const KEY = "boardroom.trmnl.token";
const TOKEN = "phone-token-0123456789";
// What the deployed endpoint would answer for this request, from the real
// renderer over the fixture rows. (Times are relative to the real clock here,
// because the widget's "3h" is computed against it.)
const LIVE_ROWS = ROWS.map((n, k) => ({ ...n, updated_at: new Date(Date.now() - (k + 1) * 7 * 60000).toISOString() }));
// A complete order, so which note is on top is this list's first live id and
// not a question about newest-first among the unordered (section 1 covers that).
const WIDGET_ORDER = ["f", "b", "a", "c", "d", "g", "h", "i", "j"];
const feed = (rows = LIVE_ROWS) => (url) => {
  const u = new URL(url);
  if (u.searchParams.get("token") !== TOKEN) return { success: false, error: "Missing or incorrect token." };
  return fn.renderNotes({ notes: rows, order: WIDGET_ORDER }, { note: u.searchParams.get("note") || "" });
};
const offline = () => { throw new Error("The Internet connection appears to be offline."); };
const FAMILIES = ["small", "medium", "large", "extraLarge", "accessoryRectangular", "accessoryInline", "accessoryCircular"];
const PARAMS = ["", "Groceries", "Captured — {date}", "Nope"];

{
  let crashed = "";
  for (const family of FAMILIES) for (const param of PARAMS) {
    try {
      const r = await runWidget(WIDGET, { family, param, keychain: { [KEY]: TOKEN }, respond: feed() });
      if (!r.widget || !r.completed) crashed ||= `${family}/${param || "brief"}: no widget set`;
      else if (!(r.widget.refreshAfterDate instanceof Date)) crashed ||= `${family}/${param || "brief"}: no refresh date`;
      else if (!texts(r.widget).length) crashed ||= `${family}/${param || "brief"}: drew nothing`;
    } catch (e) {
      crashed ||= `${family}/${param || "brief"}: ${e.message}`;
    }
  }
  check(`the widget builds at every size (${FAMILIES.length}) for every kind of parameter (${PARAMS.length})`, !crashed, crashed);
}
{
  const r = await runWidget(WIDGET, { family: "medium", keychain: { [KEY]: TOKEN }, respond: feed() });
  const u = new URL(r.requests[0] || "about:blank");
  check("it asks for the notes view with the stored token", u.pathname === "/.netlify/functions/trmnl" && u.searchParams.get("view") === "notes" && u.searchParams.get("token") === TOKEN && !u.searchParams.has("note"));
  const top = homescreenNotes(applyNotesOrder(LIVE_ROWS, WIDGET_ORDER)).slice(0, 2);
  const t = texts(r.widget);
  check("medium draws the Brief's top two notes", t.includes("Captured — Oct 22") && t.some((s) => s.startsWith("call the roofer")) && top.length === 2);
  check("…each row opens its own note, and the rest of the widget opens the Notes tab",
    top.every((n) => urls(r.widget).includes(`${SITE}/?note=${n.id}`)) && r.widget.url === `${SITE}/?note`);
  check("…with a count of what isn't shown", t.some((s) => /^\+\d+ more$/.test(s)));
}
{
  const r = await runWidget(WIDGET, { family: "small", keychain: { [KEY]: TOKEN }, respond: feed() });
  check("small points its one tap target at the note it shows", r.widget.url === `${SITE}/?note=f`);
}
{
  const r = await runWidget(WIDGET, { family: "large", param: "Groceries", keychain: { [KEY]: TOKEN }, respond: feed() });
  const u = new URL(r.requests[0] || "about:blank");
  check("a parameter is sent as &note=", u.searchParams.get("note") === "Groceries");
  const t = texts(r.widget);
  check("one note by name draws its title and body, with the editor's bullets as bullets",
    t.includes("Groceries") && t.some((s) => s === "• eggs\n• milk\n\n• bread") && r.widget.url === `${SITE}/?note=a`);
}
{
  const r = await runWidget(WIDGET, { family: "medium", param: "Nope", keychain: { [KEY]: TOKEN }, respond: feed() });
  check("a name with no note says so, by name", texts(r.widget).includes("No note titled “Nope” yet."));
}
{
  const r = await runWidget(WIDGET, { family: "medium", keychain: { [KEY]: TOKEN }, respond: feed([]) });
  check("an empty Brief is the Brief's own empty state", texts(r.widget).includes("A blank ledger."));
}
{
  const r = await runWidget(WIDGET, { family: "medium", respond: feed() });
  check("with no token, the widget says how to add one — and asks nothing it can't show",
    texts(r.widget).some((s) => /run this script once to add your token/.test(s)) && r.alerts.length === 0 && r.requests.length === 0);
}
{
  const r = await runWidget(WIDGET, { family: "medium", inApp: true, respond: feed(), alertAnswers: [{ action: 0, value: `  ${TOKEN}  ` }] });
  check("in the app, it asks once and keeps the token in the keychain the calendar widget reads",
    r.alerts.length === 1 && r.keychain.get(KEY) === TOKEN && texts(r.widget).includes("Captured — Oct 22"));
  check("…the same keychain entry, by name, as scriptable/board-room-calendar.js",
    read("scriptable/board-room-calendar.js").includes(`const KEYCHAIN_KEY = "${KEY}";`));
}
{
  const r = await runWidget(WIDGET, { family: "medium", keychain: { [KEY]: "wrong" }, respond: feed() });
  check("a wrong token on the Home Screen shows the function's own words and keeps the entry (it can't reprompt there)",
    texts(r.widget).includes("Missing or incorrect token.") && r.keychain.get(KEY) === "wrong");
  const app = await runWidget(WIDGET, { family: "medium", inApp: true, keychain: { [KEY]: "wrong" }, respond: feed(), alertAnswers: [{ action: 0, value: TOKEN }] });
  check("…and in the app it clears the bad one, asks again, and uses the new one",
    app.alerts.length === 1 && app.keychain.get(KEY) === TOKEN && app.requests.length === 2 && texts(app.widget).includes("Captured — Oct 22"));
}
{
  const first = await runWidget(WIDGET, { family: "medium", keychain: { [KEY]: TOKEN }, respond: feed() });
  const files = Object.fromEntries(first.files);
  const cached = await runWidget(WIDGET, { family: "medium", keychain: { [KEY]: TOKEN }, files, respond: offline });
  check("offline, it draws the last good notes with a cached marker",
    texts(cached.widget).includes("Captured — Oct 22") && texts(cached.widget).some((s) => /^cached /.test(s)));
  const other = await runWidget(WIDGET, { family: "medium", param: "Groceries", keychain: { [KEY]: TOKEN }, files, respond: offline });
  check("…but never another widget's notes: each parameter has its own cache",
    !texts(other.widget).includes("Captured — Oct 22") && texts(other.widget).includes("Notes unavailable"));
  const old = Object.fromEntries(Object.entries(files).map(([p, s]) => [p, JSON.stringify({ ...JSON.parse(s), at: Date.now() - 25 * 3600000 })]));
  const expired = await runWidget(WIDGET, { family: "medium", keychain: { [KEY]: TOKEN }, files: old, respond: offline });
  check("…and past a day the cache is too old to pass off as your notes", texts(expired.widget).includes("Notes unavailable"));
}
{
  const r = await runWidget(WIDGET, { family: "medium", keychain: { [KEY]: TOKEN }, respond: () => ({ generated_at: "x", events: [], birthdays: [] }) });
  check("a site still on the previous function is named as that, not as a bad response",
    texts(r.widget).some((s) => /doesn't serve notes yet/.test(s)));
}
{
  const r = await runWidget(WIDGET, { family: null, inApp: true, keychain: { [KEY]: TOKEN }, respond: feed() });
  check("run in the app with no family, it previews at its own default size", r.presented === "medium" && r.completed);
}
{
  const src = read(WIDGET);
  // This repo is public. The token goes in the keychain; the file ships empty.
  check("the committed widget carries no token", /^const TOKEN = "";/m.test(src));
  check("…and talks to the production site", src.includes(`const SITE = "${SITE}";`));
}

// ─── 7. the tap lands ────────────────────────────────────────────────────────
{
  const app = code(read("src/App.jsx"));
  check("App reads ?note once there is a session AND settings — after the hidden-tab bounce, not before it",
    /if \(!session \|\| PREVIEW \|\| settings == null\) return;\s*const url = new URL\(window\.location\.href\);\s*if \(!url\.searchParams\.has\("note"\)\) return;/.test(app)
    && /\}, \[!!session, settings != null\]\);/.test(app));
  check("…jumps to the Notes tab, and to the note when there is an id",
    /jumpTo\(\{ page: "personal", sub: "notes", \.\.\.\(id \? \{ noteId: id \} : \{\}\) \}\)/.test(app));
  check("…and takes the parameter back out, so a reload doesn't reopen it",
    /url\.searchParams\.delete\("note"\);\s*window\.history\.replaceState\(/.test(app));
  check("Personal maps the notes jump onto the tab that holds them",
    /notes: "notescal"/.test(code(read("src/pages/personal/PersonalPage.jsx"))));
  check("the service worker answers /?note=… with the app shell, offline too",
    /req\.mode === "navigate" && url\.pathname === "\/"/.test(code(read("public/sw.js"))));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nNOTES WIDGET SMOKE: ALL CLEAN");
process.exit(failed ? 1 : 0);
