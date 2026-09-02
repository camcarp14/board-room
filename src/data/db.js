import { supabase } from "../lib/supabase.js";
import { todayISO } from "../lib/dates.js";
import { averageIn } from "../lib/altLadder.js";

// ─── writes: supabase-js does not reject when a write fails ──────────────────
// This is the thing to know before touching anything below it.
// `await supabase.from("t").insert(row)` RESOLVES on a PostgREST rejection, on
// an RLS denial, and on a 500 — it settles with { data: null, error: {…} } and
// execution carries straight on. It only rejects if fetch itself blows up.
//
// So the `try { await … } catch {}` that used to wrap saveMessage, saveSeatNote,
// saveSetting and saveFindings was not caution. It was an empty catch around a
// call that could not throw, sitting exactly where the one meaningful piece of
// information — `.error` — was being dropped on the floor. Every failed write
// through those four was invisible: no throw, no log, nothing on screen.
//
// saveSetting is the one that cost real things. app_settings is not a bag of
// preferences: navigation (the tab bar), finance_rules, budgets, grocery_stores,
// brief_order, notes_order, ponder_items and the dream boards all persist
// through it, and App's updateSetting paints the new value into React state
// before the write leaves the browser. A refused upsert therefore left the app
// showing a budget, a board or a tab layout the database had never accepted,
// still looking saved, right up until the next reload quietly handed back the
// old value.
//
// write() is the only path those four take out of the browser now. It awaits,
// reads .error, and throws it. The throw is the point, and it is also why
// reported() exists directly below.
async function write(query, what) {
  const { error } = await query;
  if (!error) return;
  // PostgREST errors are plain objects, not Errors — no stack, and `.message` is
  // often the only readable field. Wrapping means every caller can treat a
  // failure the same way, and that the message names what didn't save.
  const e = new Error(error.message || `Couldn't save ${what}.`);
  e.code = error.code || null;
  e.details = error.details || null;
  e.what = what;
  throw e;
}

// ─── failed writes, and who gets told ────────────────────────────────────────
// Returning a failure only helps when somebody looks at it, and the callers of
// these four writes are exactly the places that structurally cannot. Chat sends
// its messages fire-and-forget. The grocery staples tally writes from inside a
// TanStack mutationFn that must not roll back deletes which already landed. The
// auditor awaits with no catch and would hang its own spinner forever on a
// throw. So a failure is filed here as well as returned, and the app shell
// subscribes and shows the count.
//
// ONE ENTRY PER KEY. Dragging tabs into a new order fires saveSetting on every
// drop; twelve failures of the same write are one thing wrong, not twelve, and
// the newest attempt replaces the older one so a retry sends what you last
// meant. A later write to the same key that SUCCEEDS clears the entry, which is
// what lets the chip disappear on its own instead of needing to be dismissed.
//
// "THE NEWEST ATTEMPT" USED TO MEAN "THE ATTEMPT WHOSE RESPONSE CAME BACK LAST",
// which is not the same sentence and cost an edit. failures.set() runs in the
// catch, so the store was written in response order; saveSetting has no per-key
// queue (only mergeSetting does), so two tab-bar drops in a burst on a flaky link
// are genuinely in flight together. Both fail, the FIRST one's response arrives
// LAST, and the entry left in the store carries the superseded layout — so the
// Retry saved the order you dragged away from and then cleared the chip. The
// screen and the database disagreed with nothing on screen to say so, which is
// the exact failure the store was built to end.
//
// So an attempt takes its number BEFORE it leaves, and only the newest attempt
// for a key may touch that key's entry. Nothing else needs the number, which is
// why it lives beside the failures rather than being threaded through callers.
const attempts = new Map();
const failures = new Map();
const failureListeners = new Set();
const announce = () => { for (const fn of failureListeners) fn(); };
// Chat messages and auditor batches get a fresh key each time rather than one
// per table: two messages that both failed are two things lost, and coalescing
// them would retry only the last one.
let writeSeq = 0;

export const writeFailures = {
  subscribe(fn) { failureListeners.add(fn); return () => { failureListeners.delete(fn); }; },
  list() { return [...failures.values()]; },
  clear(key) { if (failures.delete(key)) announce(); },
  clearAll() { if (failures.size) { failures.clear(); announce(); } },
  /**
   * Re-run every recorded write. Each retry goes back through reported(), so it
   * clears its own entry on success and refreshes it on failure — a partial
   * recovery leaves exactly what is still broken on screen and nothing else.
   * Never rejects: the retry button behind this has no catch.
   *
   * IT RETURNS NOTHING A CALLER HAS TO ACT ON, and that is a property worth
   * keeping. A retry can learn that a settings row has moved, and the screen has to
   * be repainted when it does — but routing that discovery back through this
   * function's return value would make the repaint something a caller could forget,
   * and the version that forgot it destroyed a thought parked on the phone. It
   * travels out of db.mergeSetting's adopted() over settingsNews instead, so a
   * retry repaints exactly like a direct write. See the note above lastSeen.
   */
  async retryAll() {
    for (const f of [...failures.values()]) await f.retry();
    return failures.size;
  },
};

/**
 * Run one write and report the outcome without letting it escape.
 *
 * Returns { ok: true } or { ok: false, error } and files a failure under `key`
 * for the shell to show. Callers that genuinely have a catch — and something
 * better to say than a chip in the top bar — pass { strict: true } and get
 * write()'s throw straight through instead. That is the opt-in, and the default
 * has to be the quiet one: a settings save that crashes the tab it was saved
 * from is not an improvement on one that lied about saving.
 */
async function reported(key, label, run, { strict = false } = {}) {
  // Claimed here, before the write leaves the browser: the order attempts START
  // in is the order the user meant them in, and the order they SETTLE in is
  // whatever the network felt like. See the note on coalescing above.
  const seq = (attempts.get(key) || 0) + 1;
  attempts.set(key, seq);
  // Answers "is this still the newest attempt at this key", and retires the
  // number when it is — so the map only ever holds keys with a write in flight. A
  // signed-in day files hundreds of `chat:<n>` keys and none of them is ever
  // asked about again.
  const isNewest = () => {
    if (attempts.get(key) !== seq) return false;
    attempts.delete(key);
    return true;
  };
  if (strict) {
    await run(); // throws on failure — the caller asked for that
    if (isNewest()) writeFailures.clear(key);
    return { ok: true };
  }
  try {
    await run();
    // A SUPERSEDED ATTEMPT THAT LANDS MUST NOT CLEAR A NEWER ONE'S CHIP. What is
    // on screen is the newer value, and it is the one that did not save; clearing
    // here would take the only sign of that away.
    if (isNewest()) writeFailures.clear(key);
    return { ok: true };
  } catch (error) {
    // …and by the same token a superseded attempt that fails must not file itself
    // over a newer attempt's entry, or the Retry sends the older value.
    if (isNewest()) {
      failures.set(key, { key, label, error, at: Date.now(), retry: () => reported(key, label, run) });
      announce();
    }
    return { ok: false, error };
  }
}

// ─── soft delete, for the two tables that had no undo ────────────────────────
// personal_notes has had one since a bulk delete took a note somebody wanted
// back: restoreNotes, below, re-upserts the rows a delete removed. It was the
// only undo in the app. Meanwhile deleteDreamBoard took every tile on a board in
// a single statement — a wall built over months, gone behind one confirm dialog —
// and deleteAffirmation took a line of the Creed the same way. Neither table was
// even in the backup until this week, so "undo" meant retyping it from memory.
//
// Those two stop losing rows here. A delete writes `deleted_at` and leaves the
// row where it is, the readers filter it out, and a restore clears the column
// again. The row is destroyed thirty days later by `purge deleted > 30d` in
// netlify/functions/db-admin.js, alongside the prunes that already live there for
// auditor_findings and usage_log: a deliberate, counted act rather than a cron
// nobody watches.
//
// THE FILTER LIVES IN THE READERS, NOT AT THE CALL SITES. readUndeleted() below
// is the only read path either table has, which leaves exactly one place to
// forget it — and forgetting it there fails loudly, because deleted tiles come
// back on the wall. Filter in the panels instead and every reader written after
// this one starts out wrong, silently, with no way to notice from the code.
//
// netlify/functions/export-data.js reads both tables whole, through the service
// role, and is deliberately left alone: a backup that dropped the rows you
// deleted last week would be the one copy that cannot hand them back.
//
// TRANSACTIONS ARE NOT PART OF THIS. See deleteTransactionsForAccount.

// ─── the window in which the column does not exist yet ───────────────────────
// deleted_at arrives by pasting supabase/migrations/0013_affirmations.sql and
// 0014_dream_items.sql into the SQL editor. The code that needs it arrives on a
// deploy. Those are two separate acts, in either order, and between them a filter
// on deleted_at is a filter on a column PostgREST has never heard of: 42703, and
// the Creed panel renders an error instead of your Creed. The in-app setup cards
// (dreamLogic.js's SETUP_SQL, CreedPanel.jsx's CREED_SETUP_SQL) do not create the
// column at all yet, so a table built from one of those lands in the same state.
//
// So the READ falls back to the unfiltered query, exactly the way loadNotes falls
// back for pinned/color. The fallback cannot hide anything: a row cannot be
// soft-deleted before the column it would be marked in exists.
//
// The DELETE does not fall back. Writing deleted_at IS the delete now, and the
// only other version of it destroys the row — the precise thing this code exists
// to prevent — so falling back would trade an inconvenience for the loss. Calling
// it done without writing anything would be worse still: a tile that vanishes
// from the sheet and is back on the wall after a refetch. It throws instead, and
// it names the file to run.
const RUN_THE_MIGRATION =
  "Deleting needs the deleted_at column. Run supabase/migrations/0013_affirmations.sql and supabase/migrations/0014_dream_items.sql in the Supabase SQL editor, then try again — nothing was deleted.";

const isMissingColumn = (e, col) =>
  /42703/.test(e?.code || "") ||
  new RegExp(`column .*${col}.* does not exist`, "i").test(e?.message || "");

/** A soft-delete failure, with the pre-migration case turned into instructions. */
function softDeleteError(error, what) {
  if (!isMissingColumn(error, "deleted_at")) return error;
  const e = new Error(RUN_THE_MIGRATION);
  e.code = error.code || "42703";
  e.what = what;
  return e;
}

/**
 * Read rows that have not been soft-deleted, and survive the column being absent.
 *
 * `build` must hand back a FRESH query each call: a PostgREST builder is a
 * one-shot thenable, so the fallback cannot re-await the one that already
 * resolved with an error.
 */
async function readUndeleted(build) {
  const live = await build().is("deleted_at", null);
  if (!live.error) return live.data || [];
  if (!isMissingColumn(live.error, "deleted_at")) throw live.error;
  const all = await build();
  if (all.error) throw all.error;
  return all.data || [];
}

// ─── settings two devices edit at the same time ──────────────────────────────
// saveSetting above is a whole-value upsert, and for most of app_settings that is
// the right shape: calendar_url is a string, theme is a string, whoever typed it
// last meant it. But several values are documents rather than preferences, and
// there the whole-value upsert loses work without saying a word.
//
// The mechanism, because it is worth stating exactly. loadSettings runs ONCE at
// sign-in and hands App one plain object; there is no realtime subscription
// anywhere in src/, so that object never learns that anything changed. Every
// panel writes by reading it, changing one thing inside, and upserting the whole
// value back. Park a thought in Ponder on the iPad and app_settings.ponder_items
// becomes [new, …old]. The phone, signed in since this morning, still holds the
// array from before that thought existed — so the moment it archives an item it
// upserts its own array over the top and the thought is gone. The upsert did
// exactly what it was told, so no error comes back; the only trace is the thought
// missing on the next reload, which reads as "I must not have saved it".
//
// boardroom.settings_merge (supabase/migrations/0033_settings_merge_rpc.sql) does
// the read-modify-write inside the database, and takes the updated_at this device
// believes the row has so a writer working from a superseded copy can be refused.
// Two strategies, because there are two shapes:
//
//   merge   — objects (finance_rules). The patch is applied key by key to
//             whatever the row holds at the instant of the write, so a rule the
//             other device added for a different merchant survives. A JSON null
//             means "remove this key", the RFC 7386 convention, because a key
//             absent from a patch has to mean "leave it alone".
//   replace — arrays (ponder_items). No merge is honest: union by id resurrects
//             what the other device deleted, per-element last-write drops edits,
//             and both throw away the order, which in a list IS the data. So the
//             array is written whole onto the exact revision it was read from, and
//             refused outright if that revision has moved.
//
// TWO KEYS, and that is the safety valve. Everything else keeps saveSetting's
// plain upsert. This list is the same list as the CASE in the migration; the
// systems smoke fails if they drift apart.
export const MERGING_SETTINGS = { finance_rules: "merge", ponder_items: "replace" };

// The revision of each merging key as this device last saw it, straight from the
// server: loadSettings fills it, and every merge response refreshes it. The stamp
// is kept as the STRING Postgres sent, never a Date — the comparison happens in
// SQL against a timestamptz with microsecond precision, and a round trip through
// JS's millisecond Date would round it off and make every write look stale.
//
// The value half is the base the object diff is computed against, which makes it
// a contract with the caller: whatever App is showing has to be what was last
// adopted from here, or a key it never adopted will read as a deletion on the
// next write. That is why every move of this map is announced.
const lastSeen = new Map();

// ─── the baseline cannot move without the screen being told ──────────────────
// THE CONTRACT ABOVE WAS BREAKABLE, AND THE CHIP'S RETRY BROKE IT. A failure
// record's retry re-enters reported() with the same runner, so a retry got its own
// response from the merge, moved lastSeen to whatever the server now holds — and
// then returned into retryAll, which throws the value away. mergeSetting's frame
// had returned long before, so its `outcome` was never updated either. Nothing
// reached App, so the baseline advanced while the screen did not, and the NEXT
// edit sent the screen's old array while claiming the revision it had never seen:
// the compare-and-set PASSED, the write landed, the chip cleared, and the other
// device's work was gone behind a clean "saved". finance_rules was worse, because
// there the retry itself succeeds — two green successes, no chip, one rule deleted
// on the following edit.
//
// THE FIX IS THAT THERE IS NOWHERE ELSE TO PUT IT. adopted() below is the only
// thing on the WRITE path that assigns lastSeen, and it announces in the same
// breath — one function, and no way to reach half of it. A retry (or any write path
// written after this one) cannot forget to deliver the adopt, because delivering it
// is not a step you remember; it is what moving the baseline IS. The alternative
// considered was returning the outcome out of retryAll for App to apply, which is a
// second thing to wire up and therefore a second thing to forget — and the state it
// would allow is the silent overwrite above.
//
// loadSettings is the one other place the baseline moves, and it needs no
// announcement for a reason that is not an exception to this: the row it seeds from
// IS its return value, so a caller cannot receive the new baseline without also
// receiving the settings it describes. THAT ARGUMENT ONLY HOLDS FOR A CALLER THAT
// KEEPS WHAT IT IS HANDED, which is why loadSettings has exactly one caller — App —
// and every other reader of a settings row goes through loadSetting, which never
// touches the map. Two hooks used to take one key out of loadSettings and drop the
// rest, and the baseline moved on every Brief return with App none the wiser; the
// note on loadSetting has the cost. The systems smoke pins all three.
const newsListeners = new Set();
export const settingsNews = {
  subscribe(fn) { newsListeners.add(fn); return () => { newsListeners.delete(fn); }; },
};
// A listener that throws is a repaint that failed. It must not also turn the write
// it was announcing into a rejected one, because the caller would file that as
// "didn't save" for a write that saved — but it is not swallowed either: the screen
// and the row have just gone out of step, which is the whole thing this channel
// exists to prevent, and the console is the only place left to say so.
const tell = (news) => {
  for (const fn of newsListeners) {
    try { fn(news); }
    catch (e) { console.warn(`[settings] a ${news.kind} listener threw for ${news.key}; the screen may be behind the row`, e); }
  }
};

/**
 * Move this device's baseline for `key` to what the server just said it holds, and
 * tell whoever can repaint, in one act. Answers whether there was anything to
 * adopt.
 *
 * `stale` false means nothing moved: the value coming back is the one we just
 * sent, and repainting it would only fight a newer local edit.
 */
function adopted(key, data) {
  lastSeen.set(key, { value: data.value, at: data.updated_at });
  if (!data.stale) return false;
  tell({ kind: "adopt", key, value: data.value });
  return true;
}

// The moves of a key this device has been REFUSED by: how many distinct ones, and
// the revision of the most recent. Both halves are load-bearing.
//
// "foreign" is as much as is known and no more — some writer that is not the write
// immediately ahead of this one in the queue. It may be the phone, and it may be one
// of the four Netlify functions that write app_settings with the service-role key.
// Nothing here can tell, which is why nothing here says.
//
// The count is what a queued write compares against. mergeSetting captures it when
// it is called and checks it again before sending, so a write built on a revision
// that has since been replaced refuses itself instead of landing.
//
// THE REVISION IS WHAT KEEPS THIS DEVICE'S OWN RETRY OUT OF THE COUNT. A refused
// write re-sends the same claim, so it is refused again — by the SAME revision.
// One move, discovered twice. Counting it twice armed the guard against the next
// perfectly good edit, which was then dropped WITHOUT BEING SENT, with an error
// blaming a device that had done nothing. A refusal carrying a revision already
// recorded here is news this device already has.
const foreignMoves = new Map(); // key -> { n, at }
const movesOf = (key) => foreignMoves.get(key)?.n || 0;
const countMove = (key, at) => {
  const seen = foreignMoves.get(key);
  if (seen && seen.at === at) return; // the same move, met a second time
  foreignMoves.set(key, { n: (seen?.n || 0) + 1, at });
};

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The smallest patch that turns `before` into `next`: changed and added keys with
 * their new values, removed keys as null. Sending only what moved is what lets
 * two devices edit different merchants without either one's copy of the rest
 * mattering — the whole object would carry a stale copy of every other key.
 *
 * Values are compared by identity, so a nested object is re-sent whenever it is
 * rebuilt even if it reads the same. That costs bytes and nothing else: the merge
 * is shallow, so a re-sent value replaces its own key and no other.
 *
 * With no base — a key written before anything was loaded — the patch is the
 * whole value and carries no deletions at all. That direction is the safe one:
 * nothing can be removed by a device that does not know what is there.
 */
const objectPatch = (next, before) => {
  if (!isPlainObject(next)) return next; // let the RPC refuse it by shape instead of guessing here
  const base = isPlainObject(before) ? before : {};
  const patch = {};
  for (const k of Object.keys(next)) if (next[k] !== base[k]) patch[k] = next[k];
  for (const k of Object.keys(base)) if (!(k in next)) patch[k] = null;
  return patch;
};

// ONE MERGE AT A TIME PER KEY, and this is not an optimisation. Ponder writes the
// whole array on every tap, so archiving two items quickly fires two writes; the
// second one reads its expected updated_at before the first one's response has
// landed, and would be refused as stale by this device's own previous write.
// Serialising per key means each attempt reads the stamp its predecessor just
// established, so a rejection is never caused by the write immediately in front of
// it. It does NOT prove a second device: the same account's own retry re-sends a
// claim the row has already moved past, and four Netlify functions write
// app_settings with the service-role key. That is why nothing thrown from the
// merge below names who moved the row — see the messages there.
const chains = new Map();
const shrug = () => {};
const queued = (key, run) => {
  const prev = chains.get(key) || Promise.resolve();
  // Runs whichever way the predecessor settled: a failed write must not strand
  // every later write to the same key behind it forever.
  const mine = prev.then(() => run(), () => run());
  chains.set(key, mine.then(shrug, shrug));
  return mine;
};

// ─── the window in which the FUNCTION does not exist yet ─────────────────────
// The same shape of gap as the deleted_at note further up, one level down: a
// function rather than a column. Postgres calls an unknown function 42883
// ("function … does not exist"); PostgREST answers PGRST202 first, because it
// resolves rpc names against its own schema cache and never gets as far as the
// database — the function-shaped twin of the PGRST205 isMissingTable looks for.
// Both are checked, because which one you get depends on whether the cache has
// been reloaded since the function was dropped.
//
// The NAME is part of the test on the message-matching branch for the same reason
// it is in isMissingTable: "does not exist" appears in errors about plenty of
// things that are not this function, and a fallback that fires on the wrong error
// is worse than no fallback at all.
const isMissingFunction = (e, name) =>
  /PGRST202|42883/.test(e?.code || "") ||
  (/could not find the function|function .* does not exist/i.test(e?.message || "") &&
    (e?.message || "").includes(name));

// 0036's pair, asked about together because they arrive together and a read that
// wants one wants both. Grouped alternation rather than passing "archived|
// deleted_at" to isMissingColumn: that builds `column .*archived|deleted_at.*
// does not exist`, where the | splits the WHOLE pattern and the second half
// matches any message containing "deleted_at" followed by "does not exist" —
// including errors about a different table. PGRST204 is here because PostgREST
// answers it for an unknown column in a select before Postgres ever sees 42703.
const isMissingShelf = (e) =>
  /42703|PGRST204/.test(e?.code || "") ||
  /column .*(?:archived|deleted_at).* does not exist/i.test(e?.message || "") ||
  (/could not find the .*column/i.test(e?.message || "") && /archived|deleted_at/i.test(e?.message || ""));

// ─── db — Supabase-backed memory layer (unchanged contract) ──────────────────
export const db = {
  async uid() {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id || null;
  },
  async loadChat(limit = 200) {
    const { data, error } = await supabase.from("chat_messages")
      .select("role,content,consulted_seats,created_at,source")
      .order("created_at", { ascending: false }).limit(limit);
    // Throw rather than return [] — a transient error must not read as "no
    // messages" and clobber the loaded chat; callers catch and keep prior state.
    if (error) throw error;
    return (data || []).reverse().map(r => ({ role: r.role, content: r.content, consulted: r.consulted_seats || [], ts: new Date(r.created_at).getTime(), source: r.source }));
  },
  async saveMessage({ role, content, consulted = [] }, opts) {
    return reported(`chat:${++writeSeq}`, "chat message", () =>
      write(supabase.from("chat_messages").insert({ role, content, consulted_seats: consulted }), "the chat message"), opts);
  },
  async clearChat() {
    // RLS (auth.uid() = user_id) already scopes this to the signed-in
    // user's own rows — the gte filter just satisfies Supabase's
    // requirement that delete() have some condition.
    const { error } = await supabase.from("chat_messages").delete().gte("created_at", "1970-01-01");
    if (error) throw error;
  },
  async loadSeatNotes() {
    const { data, error } = await supabase.from("seat_notes").select("seat_key,notes");
    if (error) throw error; // don't let a blip erase the loaded seat notes
    const out = {};
    (data || []).forEach(r => { out[r.seat_key] = r.notes; });
    return out;
  },
  async saveSeatNote(seatKey, notes, opts) {
    // The signed-in check lives INSIDE the runner so a retry re-reads the
    // session — which is the right answer when the reason a write failed was an
    // expired token. It also throws rather than returning early: text the user
    // typed into a seat did not reach the database, and "not signed in" is a
    // reason for that, not an excuse to call it a no-op.
    return reported(`seat_note:${seatKey}`, `${seatKey} seat notes`, async () => {
      const user_id = await db.uid();
      if (!user_id) throw new Error("Not signed in");
      await write(supabase.from("seat_notes").upsert({ user_id, seat_key: seatKey, notes, updated_at: new Date().toISOString() }, { onConflict: "user_id,seat_key" }), "the seat notes");
    }, opts);
  },
  async loadSettings() {
    // updated_at comes back for every row, not because callers want it — App's
    // settings object is still key → value — but because it is the revision a
    // merging write has to claim it read (see MERGING_SETTINGS above). Without it
    // every merge would arrive with no expectation, and an array write with no
    // expectation is exactly the blind overwrite this all exists to stop.
    const { data, error } = await supabase.from("app_settings").select("setting_key,setting_value,updated_at");
    // Throw, don't return {} — an error here previously looked like "no settings
    // saved" and one flaky refresh wiped calendar_url, model prefs, and the Mini
    // Me queue out of live state. Callers keep the previous settings on throw.
    if (error) throw error;
    const out = {};
    // Cleared, not merged into: a key that no longer has a row must not leave a
    // revision behind for the next write to claim. This also runs on every manual
    // Refresh, which makes the refresh button a way out of a stale baseline.
    lastSeen.clear();
    (data || []).forEach(r => {
      out[r.setting_key] = r.setting_value;
      if (MERGING_SETTINGS[r.setting_key]) lastSeen.set(r.setting_key, { value: r.setting_value, at: r.updated_at });
    });
    return out;
  },
  /**
   * One value, and NOT the baseline. The Brief's econ verdicts and the grocery
   * frequency tally each live in a single app_settings row and are refetched on
   * their own cadence — every Brief return after a minute, every grocery open
   * after five — and both used to take that row through loadSettings, which also
   * clears and re-seeds lastSeen from the server on every call. The whole reason
   * loadSettings may move the baseline unannounced is that App receives the
   * settings and the baseline in one hand; these readers kept one key and threw
   * the rest away, so on each of those refetches the baseline advanced to
   * whatever revision the other device had written while App's `settings` — the
   * value the next merge is built from and diffed against — stayed where sign-in
   * left it. The next Ponder archive then claimed a revision the screen had never
   * seen, the compare-and-set PASSED, and the thought parked on the iPad was gone
   * under a green save; finance_rules diffed the stale object against the fresh
   * base and sent the rule the iPad added as a null. Exactly the loss 0033 and
   * the whole lastSeen machinery exist to refuse, re-opened by a side read on the
   * two most common navigations in the app.
   *
   * So this reads one row and touches nothing. A missing row is undefined, which
   * both callers already treat as "nothing yet". It also stops those hooks
   * pulling the entire app_settings table to read one value.
   */
  async loadSetting(key) {
    const { data, error } = await supabase.from("app_settings").select("setting_value").eq("setting_key", key).maybeSingle();
    if (error) throw error;
    return data?.setting_value;
  },
  /** Forget which revision of each merging setting this device has seen. Called
   *  on sign-out: the revisions belong to the account, and a leftover base would
   *  have the next user's first write diff against a stranger's value. */
  forgetSettings() { lastSeen.clear(); foreignMoves.clear(); },
  async saveSetting(key, value, opts) {
    // Keyed on the setting, so a rapid burst — a tab drag, a slider — collapses
    // to one pending failure carrying the last value, and the label is the
    // setting's own name so the chip can say which one it was.
    return reported(`setting:${key}`, key.replace(/_/g, " "), async () => {
      const user_id = await db.uid();
      if (!user_id) throw new Error("Not signed in");
      await write(supabase.from("app_settings").upsert({ user_id, setting_key: key, setting_value: value, updated_at: new Date().toISOString() }, { onConflict: "user_id,setting_key" }), `the ${key} setting`);
    }, opts);
  },
  /**
   * Save one of the MERGING_SETTINGS through boardroom.settings_merge instead of
   * the whole-value upsert, so the other device's copy of the same key survives.
   *
   * Returns reported()'s { ok } plus what the server decided — applied, stale, the
   * value the row now holds, and `unprotected` when it had to fall back (below).
   *
   * ADOPTION IS NOT IN THAT RETURN VALUE, AND THAT IS DELIBERATE. "The row was not
   * where this device thought it was, so take this value" has to reach the screen
   * whether the write came from a panel or from the chip's Retry, and the Retry
   * returns to nobody — it is awaited by retryAll, which counts what is left. So
   * the adopt travels out of adopted() through settingsNews, which is the same act
   * as moving the baseline (the long version is above lastSeen). Handing a second
   * copy back here would invite a reader to drop that subscription and take this
   * field instead, and the retry would go quiet again — which is exactly the bug
   * that cost a thought parked on the phone.
   *
   * A REFUSAL IS A FAILURE AND IS FILED AS ONE, under `setting:<key>` — the same
   * entry saveSetting uses, so one setting can only ever put one chip in the top
   * bar, and a later write that lands through either path clears it. Nothing new
   * was invented to carry this: the whole point of the writeFailures store is that
   * a write which did not happen has somewhere to be seen.
   *
   * NOTHING IS RE-SENT ON ITS OWN, and a retry re-sends the SAME claim — the same
   * patch against the same revision it was built for, captured on the first
   * attempt. That is what makes retry honest in both directions. A write that
   * failed on the wire retries and lands, because the revision it claimed is still
   * the current one. A write that was REFUSED retries and is refused again, for as
   * long as the row has moved on — which is correct: an array edit computed
   * against a revision that no longer exists cannot be re-applied without throwing
   * away whatever replaced it, and the app does not get to make that call quietly.
   * The way out is the next real edit, made against the value that was adopted,
   * which lands and clears the chip.
   *
   * AND IT STILL SAVES BEFORE 0033 IS PASTED IN. The function arrives by hand in
   * the SQL editor and the code arrives on a deploy, so there is a window — of
   * whatever length the owner takes — where these two keys route exclusively at an
   * rpc PostgREST has never heard of. Both of them upserted perfectly well before
   * this branch, and a change that stops ponder_items saving until somebody runs a
   * migration is not a fix. On the errors that mean exactly "there is no such
   * function" — PGRST202 from PostgREST, 42883 from Postgres itself, see
   * isMissingFunction — and on nothing else, the write falls back to the old
   * whole-value upsert, reports `unprotected: true`, and SAYS SO through
   * settingsNews: the fallback is the unprotected write this whole mechanism exists
   * to replace, and a silent one would be the old bug with better paperwork.
   */
  async mergeSetting(key, value, opts) {
    const strategy = MERGING_SETTINGS[key];
    // Off the allowlist means the plain path, not an error. The allowlist is a
    // safety valve, and a caller reaching for a key that has never needed merging
    // should keep working exactly as every other setting does.
    if (!strategy) return db.saveSetting(key, value, opts);
    const label = key.replace(/_/g, " ");
    // How many moves of this row this device had watched when the CALLER built this
    // value. See the guard below.
    const gen = movesOf(key);
    let outcome = null;
    let sent = null; // { patch, at } — frozen on the first attempt so a retry re-claims it
    const res = await reported(`setting:${key}`, label, () => queued(key, async () => {
      // AN ARRAY BUILT ON A REVISION SOMETHING HAS ALREADY REPLACED IS NOT SENT AT
      // ALL. This fires for a write that was still in the queue when the one ahead
      // of it came back refused: the revision has since been rebased, so the server
      // would accept this array — and it carries content from before whatever
      // replaced it, which is exactly the overwrite all of this exists to prevent.
      // An object patch is safe in the same situation and is allowed through: it
      // only names keys the caller actually touched, and its deletions can only
      // name keys the caller had already seen.
      //
      // WHAT THE MESSAGE MAY SAY IS ONLY WHAT GOT US HERE: a write to this key came
      // back refused while this edit waited, so the revision this array was built
      // on is not the row any more, and nothing was sent. It used to read "changed
      // on another device", which was a cause nothing here verified — and was
      // simply false in the case that reached it most often, this device's own
      // Retry bumping the counter (see foreignMoves). An error that names a cause
      // it did not check is the worst kind, because it is acted on.
      if (strategy === "replace" && !sent && movesOf(key) !== gen) {
        const e = new Error(`This ${label} edit was built on a version that has since changed, so it wasn't saved — nothing was sent.`);
        e.what = `the ${key} setting`;
        e.stale = true;
        throw e;
      }
      if (!sent) {
        // Read AFTER the write ahead of this one settled — that is what the queue
        // is for. No revision at all means this device has never seen the row: the
        // function reads that as "there should be nothing there", so it inserts if
        // the key is absent and refuses an array write if it is not.
        const base = lastSeen.get(key);
        sent = { patch: strategy === "merge" ? objectPatch(value, base?.value) : value, at: base?.at ?? null };
      }
      // THE SIGNED-IN CHECK COMES AFTER THE CLAIM IS FROZEN, and the order is the
      // point. It used to come first, so a write refused here — the session had
      // expired under an open tab — retried with `sent` still null and built its
      // claim at RETRY time: after signing back in, after loadSettings had re-seeded
      // the baseline to whatever the other device wrote meanwhile. The value was
      // the old screen's, the revision was the new row's, the compare-and-set
      // passed. Frozen here, the retry claims the revision the value was actually
      // built on and is refused honestly if the row has moved. The check itself
      // still lives inside the runner so a retry re-reads the session, which is
      // the right answer when an expired token was the reason it failed.
      const user_id = await db.uid();
      if (!user_id) throw new Error("Not signed in");
      const { data, error } = await supabase.rpc("settings_merge", {
        p_key: key,
        p_patch: sent.patch,
        p_expected_updated_at: sent.at,
      });
      if (error) {
        // THE ONE ERROR THAT IS NOT A FAILED WRITE: the function is not there yet.
        // 0033 is pasted into the SQL editor by hand, and until it is, PostgREST
        // answers PGRST202 for this rpc — so without this branch the two keys that
        // most need protecting would be the only two that cannot be saved at all.
        //
        // A STALE-WRITE REFUSAL CANNOT REACH THIS BRANCH, and that is structural
        // rather than careful: a refusal is not an error. It comes back as a 200
        // carrying applied:false, handled below, and `error` is null for it. So
        // there is no path on which falling back here overwrites the row the
        // compare-and-set just protected — which would restore the very bug 0033
        // was written to fix. Every other error still throws, unchanged.
        if (isMissingFunction(error, "settings_merge")) {
          await write(supabase.from("app_settings").upsert(
            { user_id, setting_key: key, setting_value: value, updated_at: new Date().toISOString() },
            { onConflict: "user_id,setting_key" }), `the ${key} setting`);
          // NOT SILENT. This is the blind whole-value upsert the merge exists to
          // replace: it just wrote this device's copy of the value over whatever
          // was there, and if a second device had touched the key, that work is
          // gone. The write succeeded, so it must not be filed as a failure — a
          // chip saying "unsaved" over a row that saved is a lie in the other
          // direction — and it must not pass without a word either.
          tell({ kind: "unprotected", key, migration: "supabase/migrations/0033_settings_merge_rpc.sql" });
          // lastSeen is deliberately left where it is. Nothing came back to adopt,
          // and the base this device holds is still the base the screen is showing,
          // which is what the object diff needs. The revision is now behind the
          // row, so the first merge after 0033 lands will be refused once and
          // adopted — an honest one-time cost of the protection not being on yet.
          outcome = { applied: true, stale: false, value, unprotected: true };
          return;
        }
        // write() is the helper for this and cannot be used for the rpc: it drops
        // .data on purpose, and the merged value plus the new revision are the
        // reason for the call. Same shape as its throw, so a caller cannot tell the
        // two apart.
        const e = new Error(error.message || `Couldn't save ${label}.`);
        e.code = error.code || null;
        e.details = error.details || null;
        e.what = `the ${key} setting`;
        throw e;
      }
      // A 200 with nothing in it would otherwise become an adopted `undefined`,
      // which is how a settings row gets emptied by a success.
      if (!data || typeof data !== "object") throw new Error(`The ${label} merge returned nothing.`);
      // Whatever the verdict, the server just said what it holds. Taking that as
      // the base is the refetch: the refusal already carries the current row, so
      // there is no second read to make and nothing to poll for. adopted() is the
      // only way to say it, and it tells the screen in the same breath — which is
      // what makes this correct on the retry path too.
      adopted(key, data);
      outcome = { applied: !!data.applied, stale: !!data.stale, value: data.value };
      if (data.applied) return;
      // The row moved under a queue that may still have writes in it, all of them
      // built on what it used to hold. Counting the move is what lets those refuse
      // themselves at the guard above instead of landing — and it is counted BY
      // REVISION, so this device's own Retry re-meeting the same move does not
      // count it twice and arm the guard against an edit nobody has replaced.
      countMove(key, data.updated_at);
      // Refused. What is verified is that the row's revision was not the one this
      // write claimed; WHO moved it is not known here (the four Netlify functions
      // that write app_settings with the service-role key can move it too), so the
      // message does not guess.
      const e = new Error(`Your ${label} had changed since this device last read it, so this edit wasn't saved.`);
      e.what = `the ${key} setting`;
      e.stale = true;
      throw e;
    }), opts);
    return { ...res, ...(outcome || { applied: false, stale: false }) };
  },
  async loadFindings(limit = 40) {
    const { data, error } = await supabase.from("auditor_findings")
      .select("property,severity,area,finding,suggestion,created_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) return [];
    return (data || []).map(r => ({ ...r, ts: new Date(r.created_at).getTime() }));
  },
  async saveFindings(rows, opts) {
    if (!rows || !rows.length) return { ok: true };
    return reported(`findings:${++writeSeq}`, "auditor findings", () =>
      write(supabase.from("auditor_findings").insert(rows.map(r => ({ property: r.property, severity: r.severity, area: r.area || null, finding: r.finding, suggestion: r.suggestion }))), "the auditor findings"), opts);
  },
  // ─── notes: two column sets, and a fallback that has to cover both ────────
  // 0008 added pinned/color; 0036 added archived/deleted_at. Both arrive in the
  // SQL editor by hand while the code arrives on a deploy, so every reader here
  // survives either one being absent and reports `legacy` so the panel can show
  // its upgrade banner instead of an error. The probe order is newest-first:
  // ask for everything, and step down one column set at a time.
  //
  // THE FILTER IS IN THE READ, not at the call sites. Both note surfaces read
  // through loadNotes, and a deleted note that reappears on the Brief because
  // one of them forgot to filter is exactly the failure src/lib/notes-shelf.js
  // exists to prevent — this is the other half of it: the bin never arrives in
  // the first place unless something asks for it.
  async loadNotes() {
    const shelved = await supabase.from("personal_notes")
      .select("id,title,body,pinned,color,archived,deleted_at,updated_at,created_at")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });
    if (!shelved.error) return { rows: shelved.data || [], legacy: false };
    if (!isMissingShelf(shelved.error)) throw shelved.error;
    // 0036 not run yet. Everything below is the pre-0036 behaviour verbatim.
    const full = await supabase.from("personal_notes")
      .select("id,title,body,pinned,color,updated_at,created_at")
      .order("updated_at", { ascending: false });
    // legacy: "shelf" — the words and the seals work, the shelf and the bin do not.
    if (!full.error) return { rows: full.data || [], legacy: "shelf" };
    if (!/column|pinned|color|42703/i.test(full.error.message || "")) throw full.error;
    const base = await supabase.from("personal_notes")
      .select("id,title,body,updated_at,created_at")
      .order("updated_at", { ascending: false });
    if (base.error) throw base.error;
    return { rows: base.data || [], legacy: true };
  },
  /** The bin. Read on demand — the Notes panel asks when you open Recently
   *  deleted, so an ordinary launch never pays for rows nobody is looking at.
   *  Returns [] rather than throwing when 0036 is absent: an empty bin is the
   *  truth on a database that cannot mark anything deleted. */
  async loadDeletedNotes(limit = 100) {
    const { data, error } = await supabase.from("personal_notes")
      .select("id,title,body,pinned,color,archived,deleted_at,updated_at,created_at")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }).limit(limit);
    if (error) {
      if (isMissingColumn(error, "deleted_at")) return [];
      throw error;
    }
    return data || [];
  },
  async saveNote(note) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = { id: note.id, user_id, title: note.title, body: note.body, updated_at: new Date().toISOString() };
    if (note.pinned !== undefined) row.pinned = note.pinned;
    if (note.color !== undefined) row.color = note.color;
    // Sent only when the caller means it, like pinned/color above — an upsert
    // writes the columns it carries, so an unconditional `archived: false` here
    // would un-archive a note every time the editor autosaved a word.
    if (note.archived !== undefined) row.archived = note.archived;
    const { data, error } = await supabase.from("personal_notes").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  },
  /**
   * Delete notes — SOFT, and falling back to the hard delete when 0036 is not in
   * yet. That fallback is the one thing here that differs from deleteAffirmation
   * and deleteDreamItem, which throw instead, and the difference is argued in
   * the migration header: there, writing deleted_at IS the delete and the only
   * other version destroys the row, so refusing is the safe answer. Here the
   * other version is what notes have always done, so refusing would break
   * deleting to protect a column that does not exist. The panel's banner says
   * which mode it is in.
   *
   * Returns { soft } so the caller knows which undo it has: a soft delete is
   * undoable from the bin for thirty days, a hard one only from the rows still
   * in memory, which is the six-second toast.
   */
  async deleteNotes(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return { soft: true };
    const now = new Date().toISOString();
    // `is deleted_at null` so deleting a note twice cannot push its thirty-day
    // clock forward — deleted_at means when it was deleted. Same guard, same
    // reason, as the two tables that had this first.
    const soft = await supabase.from("personal_notes")
      .update({ deleted_at: now }).in("id", list).is("deleted_at", null);
    if (!soft.error) return { soft: true };
    if (!isMissingShelf(soft.error)) throw soft.error;
    const hard = await supabase.from("personal_notes").delete().in("id", list);
    if (hard.error) throw hard.error;
    return { soft: false };
  },
  async deleteNote(id) { return db.deleteNotes([id]); },
  async bulkDeleteNotes(ids) { return db.deleteNotes(ids); },
  /** Out of the bin, back onto whichever shelf it was on. Clearing deleted_at is
   *  the whole restore — `archived` was never touched by the delete, so a note
   *  archived before it was deleted comes back archived. */
  async undeleteNotes(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return [];
    const { data, error } = await supabase.from("personal_notes")
      .update({ deleted_at: null }).in("id", list).select();
    if (error) throw error;
    return data || [];
  },
  /** Destroy for good, from the bin only. `.not(deleted_at, is, null)` is the
   *  safety catch: this is the one call in the notes path that cannot be undone,
   *  and it must be unable to reach a live note even if handed its id. */
  async purgeNotes(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return;
    const { error } = await supabase.from("personal_notes")
      .delete().in("id", list).not("deleted_at", "is", null);
    if (error) throw error;
  },
  async bulkUpdateNotes(ids, patch) {
    if (!ids?.length) return;
    const { error } = await supabase.from("personal_notes")
      .update({ ...patch, updated_at: new Date().toISOString() }).in("id", ids);
    if (error) throw error;
  },
  async restoreNotes(rows) {
    // Undo path — re-upserts previously deleted/overwritten rows exactly as
    // they were, original timestamps included, so order comes back too.
    if (!rows?.length) return;
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const clean = rows.map(({ id, title, body, pinned, color, archived, created_at, updated_at }) => {
      const r = { id, user_id, title, body, created_at, updated_at };
      if (pinned !== undefined) r.pinned = pinned;
      if (color !== undefined) r.color = color;
      if (archived !== undefined) r.archived = archived;
      return r;
    });
    const { error } = await supabase.from("personal_notes").upsert(clean, { onConflict: "id" });
    if (error) throw error;
  },
  async loadEvents() {
    const { data, error } = await supabase.from("personal_events")
      .select("id,title,notes,start_time,end_time,all_day,location,category,rrule,exdates,series_id")
      .order("start_time", { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async saveEvent(ev) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = {
      id: ev.id, user_id, title: ev.title, notes: ev.notes || "",
      start_time: ev.start_time, end_time: ev.end_time || null, all_day: !!ev.all_day,
      location: ev.location || "", category: ev.category || "personal",
      // A one-off writes rrule null and an empty exdates rather than omitting
      // them: editing a repeating event down to "Does not repeat" has to CLEAR
      // the rule, and an omitted key in an upsert leaves the old one standing.
      rrule: ev.rrule || null,
      exdates: Array.isArray(ev.exdates) ? ev.exdates : [],
      series_id: ev.series_id || null,
    };
    const { data, error } = await supabase.from("personal_events").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  },
  /**
   * Apply one scoped edit/delete plan from lib/recurrence.js.
   *
   * Order is load-bearing: updates and inserts land BEFORE deletes, so a
   * failure part-way leaves a duplicate occurrence on screen (obvious, and
   * fixable by hand) rather than a deleted series and no replacement (silent,
   * and unrecoverable). `update` rows are partial patches by design — a scope
   * plan that only caps an rrule must not have to restate the whole event.
   */
  async applyEventPlan(plan) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const { update = [], insert = [], delete: del = [] } = plan || {};
    for (const patch of update) {
      const { id, ...fields } = patch;
      if (!id || !Object.keys(fields).length) continue;
      const { error } = await supabase.from("personal_events").update(fields).eq("id", id);
      if (error) throw error;
    }
    if (insert.length) {
      const rows = insert.map((e) => ({
        id: e.id, user_id, title: e.title, notes: e.notes || "",
        start_time: e.start_time, end_time: e.end_time || null, all_day: !!e.all_day,
        location: e.location || "", category: e.category || "personal",
        rrule: e.rrule || null, exdates: Array.isArray(e.exdates) ? e.exdates : [],
        series_id: e.series_id || null,
      }));
      const { error } = await supabase.from("personal_events").upsert(rows, { onConflict: "id" });
      if (error) throw error;
    }
    if (del.length) {
      const { error } = await supabase.from("personal_events").delete().in("id", del);
      if (error) throw error;
    }
  },
  async deleteEvent(id) {
    const { error } = await supabase.from("personal_events").delete().eq("id", id);
    if (error) throw error; // a failed delete must not report success — the row would silently return on refetch
  },
  async saveEventsBulk(rows) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const payload = rows.map(e => ({
      id: e.id, user_id, title: e.title, notes: e.notes || "",
      start_time: e.start_time, end_time: e.end_time || null, all_day: !!e.all_day,
      category: e.category || "personal",
    }));
    const { data, error } = await supabase.from("personal_events").insert(payload).select();
    if (error) throw error;
    return data;
  },
  async loadMovies() {
    const { data, error } = await supabase.from("movies").select("*").order("watched_date", { ascending: false });
    if (error) throw error;
    return data || [];
  },
  async saveMovie(m) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = { user_id, title: m.title, year: m.year || null, poster_url: m.poster_url || null, true_quality_score: m.true_quality_score ?? null, cameron_score: m.cameron_score ?? null, note: m.note || "",       // todayISO(), not toISOString().slice(0,10) — the latter is the UTC day,
      // so logging a movie any evening in CT stamped it with tomorrow's date.
      // This was the last holdout of the bug lib/dates.js opens by warning about.
      watched_date: m.watched_date || todayISO() };
    const { data, error } = await supabase.from("movies").insert(row).select().single();
    if (error) throw error;
    return data;
  },
  async deleteMovie(id) {
    const { error } = await supabase.from("movies").delete().eq("id", id);
    if (error) throw error;
  },
  async updateMovie(id, patch) {
    const { data, error } = await supabase.from("movies").update(patch).eq("id", id).select().single();
    if (error) throw error;
    return data;
  },
  async loadGroceryItems() {
    const { data, error } = await supabase.from("grocery_items").select("*").order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async addGroceryItem(item) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const { data, error } = await supabase.from("grocery_items").insert({ user_id, item }).select().single();
    if (error) throw error;
    return data;
  },
  async toggleGroceryItem(id, checked) {
    const { error } = await supabase.from("grocery_items").update({ checked }).eq("id", id);
    if (error) throw error;
  },
  // Quantity lives inside the item text ("2x milk") because grocery_items has no
  // qty column — so bumping a count is a text rewrite. This is also how an add
  // that matches an existing row merges instead of opening a duplicate line.
  async updateGroceryItem(id, patch) {
    const { error } = await supabase.from("grocery_items").update(patch).eq("id", id);
    if (error) throw error;
  },
  async deleteGroceryItem(id) {
    const { error } = await supabase.from("grocery_items").delete().eq("id", id);
    if (error) throw error;
  },
  async loadSavedRecipes() {
    const { data, error } = await supabase.from("saved_recipes").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  },
  async saveRecipe(title, content) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const { data, error } = await supabase.from("saved_recipes").insert({ user_id, title, content }).select().single();
    if (error) throw error;
    return data;
  },
  async deleteRecipe(id) {
    const { error } = await supabase.from("saved_recipes").delete().eq("id", id);
    if (error) throw error;
  },
  async loadBirthdays() {
    const { data, error } = await supabase.from("personal_birthdays")
      .select("id,name,month,day,year,notes");
    if (error) throw error;
    return data || [];
  },
  async saveBirthday(b) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = { id: b.id, user_id, name: b.name, month: b.month, day: b.day, year: b.year ?? null, notes: b.notes || "" };
    const { data, error } = await supabase.from("personal_birthdays").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  },
  async saveBirthdaysBulk(rows) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const payload = rows.map(b => ({ id: b.id, user_id, name: b.name, month: b.month, day: b.day, year: b.year ?? null, notes: "" }));
    const { data, error } = await supabase.from("personal_birthdays").insert(payload).select();
    if (error) throw error;
    return data;
  },
  // ─── Anniversaries ─────────────────────────────────────────────────────────
  // The same shape as birthdays one level up, and a separate table on purpose
  // (see 0040). `kind` is written as given; the client normalizes an unknown
  // one on read rather than here, so a row this release has never heard of is
  // still returned to whatever release can understand it.
  async loadAnniversaries() {
    const { data, error } = await supabase.from("personal_anniversaries")
      .select("id,name,kind,month,day,year,notes");
    if (error) throw error;
    return data || [];
  },
  async saveAnniversary(a) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = { id: a.id, user_id, name: a.name, kind: a.kind, month: a.month, day: a.day, year: a.year ?? null, notes: a.notes || "" };
    const { data, error } = await supabase.from("personal_anniversaries").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  },
  async deleteAnniversary(id) {
    const { error } = await supabase.from("personal_anniversaries").delete().eq("id", id);
    if (error) throw error;
  },
  async loadUpkeep() {
    const { data, error } = await supabase.from("upkeep_items")
      .select("id,name,interval_days,last_done,notes")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async saveUpkeepItem(item) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = { id: item.id, user_id, name: item.name, interval_days: item.interval_days, last_done: item.last_done || null, notes: item.notes || "", updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from("upkeep_items").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  },
  async deleteUpkeepItem(id) {
    const { error } = await supabase.from("upkeep_items").delete().eq("id", id);
    if (error) throw error;
  },
  // ─── Transactions ──────────────────────────────────────────────────────────
  // The id is DERIVED from the transaction itself (see financeLogic.txKey),
  // because a Chase CSV carries no transaction id. That is what makes an import
  // idempotent: upserting on (user_id, id) means re-importing an overlapping
  // export updates rows instead of doubling your month.
  /**
   * The ledger, and whether you are looking at all of it.
   *
   * loadTransactions(5000) handed back a slice with nothing on it to say it was
   * one. Every number in the Finances panel is a sum over whatever came back —
   * the month, the budget bars, the recurring detector's history — so a ledger
   * longer than the cap produced totals that were arithmetically perfect and
   * factually wrong, printed with no qualifier. "You have $312 left in Dining"
   * because the charges that spent it fell off the end of the read is exactly the
   * failure this app is not allowed to have.
   *
   * The count is what makes truncation visible, and it catches BOTH ways this
   * read can come back short: the `limit` above, and the project's own max-rows
   * ceiling, which PostgREST applies without telling you (export-data.js has the
   * long version of that scar). Where no count comes back — some configurations
   * return none — it falls back to the weaker test of whether the read came back
   * exactly full, which cannot tell a ledger of precisely 5,000 rows from one of
   * 6,000 and so errs toward saying it was capped. Overstating the doubt is the
   * safe direction; understating it is how you get the wrong number on screen.
   *
   * The rows kept are the NEWEST, because the order is date descending. So a
   * capped read usually still has this month intact and is short on history,
   * which is worth knowing when deciding what to warn about: the recurring
   * detector and any all-time total are the parts that go wrong first.
   */
  async readTransactions(limit = 5000) {
    const { data, count, error } = await supabase.from("transactions")
      .select("id,account,date,amount_cents,description,merchant,category,category_override", { count: "exact" })
      .order("date", { ascending: false }).limit(limit);
    // Throws rather than returning [] — a dropped request must not read as "you
    // have no transactions", which in a budgeting tool is a $0 month.
    if (error) throw error;
    const rows = (data || []).map((r) => ({ ...r, amount: r.amount_cents }));
    const total = typeof count === "number" ? count : null;
    return { rows, total, limit, capped: total != null ? rows.length < total : rows.length >= limit };
  },
  /* loadTransactions IS GONE, AND THE DEBT ITS COMMENT WAS HOLDING OPEN IS PAID.
     It returned readTransactions().rows — the same read with the cap state thrown
     away — and said so, promising that "a caller that can render the warning
     should move to readTransactions and say so on screen".
     Every caller did: data/finances.js:useTransactions returns the whole envelope
     and FinancesPanel draws `txCapped` from it. So what was left here was a
     shorter spelling of the unsafe read, exported, with a docstring justifying it
     by naming callers that no longer exist — and in a budgeting tool the thing it
     drops is the difference between "$312 left in Dining" and "$312 left in
     Dining, of the 5,000 most recent rows". Deleting it is what stops the next
     reader taking it because it hands back a plain array. */
  async saveTransactions(rows) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const payload = (rows || []).map((r) => ({
      id: r.id, user_id, account: r.account || "", date: r.date,
      amount_cents: r.amount, description: r.description || "",
      merchant: r.merchant || "", category: r.category || "other",
      category_override: r.category_override ?? null,
    }));
    // Chunked: a 3,000-row export in one statement is a request big enough for
    // PostgREST to reject, and the failure looks like "import did nothing".
    const CHUNK = 500;
    let saved = 0;
    for (let i = 0; i < payload.length; i += CHUNK) {
      const { error } = await supabase.from("transactions")
        .upsert(payload.slice(i, i + CHUNK), { onConflict: "user_id,id" });
      if (error) throw error;
      saved += Math.min(CHUNK, payload.length - i);
    }
    return saved;
  },
  async setTransactionCategory(id, category) {
    const { error } = await supabase.from("transactions")
      .update({ category_override: category }).eq("id", id);
    if (error) throw error;
  },
  /**
   * Forget an account — and this one is STILL A HARD DELETE, on purpose.
   *
   * It is the same shape of loss as deleteDreamBoard: a whole account's history in
   * one statement, no undo. It did not get soft-deleted with the dream boards
   * anyway, because the flow it exists for is "forget this account, then import
   * the file again", and that flow depends on the rows genuinely going away.
   *
   * A row's id is derived from the transaction itself (financeLogic.txKey), so the
   * re-import upserts onto whatever is still there. Mark the old rows deleted
   * instead of removing them and the re-import walks straight back onto those same
   * primary keys — with deleted_at still set, because an upsert only writes the
   * columns it sends. The import would report 900 rows written, every one of them
   * invisible. Send deleted_at: null on the way in and the opposite happens: rows
   * you deliberately forgot come back from the dead any time an overlapping export
   * is imported. Either way, a year of transactions is wrong and the receipt says
   * it worked.
   *
   * Doing this properly means making the import aware of the soft delete rather
   * than making the delete soft: the account's rows get deleted_at, the import
   * clears it for exactly the ids present in the file it just read, and the
   * Finances panel gets somewhere to show what is currently hidden. That is a
   * change to db.js, finances.js and FinancesPanel.jsx together, with the
   * idempotency of the import as the thing under test. It is not a line edit here,
   * and pretending otherwise is how the year gets duplicated.
   */
  async deleteTransactionsForAccount(account) {
    const { error } = await supabase.from("transactions").delete().eq("account", account);
    if (error) throw error;
  },
  // Soft-deleted lines are filtered out HERE, in the reader, which is the only
  // read of this table in the browser. See the block above the db object.
  async loadAffirmations() {
    return readUndeleted(() => supabase.from("affirmations")
      .select("id,text,kind,created_at")
      .order("created_at", { ascending: true }));
  },
  async saveAffirmation(a) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = { id: a.id, user_id, text: a.text, kind: a.kind || "creed", updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from("affirmations").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    // Saving a line asserts that the line exists, so a save onto a row that is
    // soft-deleted has to bring it back. Nothing in the panel can reach that on
    // purpose — you edit what you can see — but the editor holds an id across a
    // delete performed in another tab, and without this the sheet would close on
    // "saved" over a row that stays hidden. deleted_at is deliberately NOT part of
    // the upsert above: sending it would make every save fail with 42703 in the
    // window before the migration is run, which is a worse trade than this one
    // extra write in a case that almost never happens.
    if (data?.deleted_at) return db.restoreAffirmation(a.id);
    return data;
  },
  async deleteAffirmation(id) {
    const now = new Date().toISOString();
    const { error } = await supabase.from("affirmations")
      .update({ deleted_at: now, updated_at: now })
      // `is deleted_at null` so a second delete of the same line cannot push its
      // thirty-day clock forward. deleted_at means when it was deleted.
      .eq("id", id).is("deleted_at", null);
    if (error) throw softDeleteError(error, "the creed entry");
  },
  /** The undo. Restores by id, which is all the caller of a delete needs to keep. */
  async restoreAffirmation(id) {
    const { data, error } = await supabase.from("affirmations")
      .update({ deleted_at: null, updated_at: new Date().toISOString() })
      .eq("id", id).select().single();
    if (error) throw softDeleteError(error, "the creed entry");
    return data;
  },
  async deleteBirthday(id) {
    const { error } = await supabase.from("personal_birthdays").delete().eq("id", id);
    if (error) throw error;
  },
  // ── Dream board ──
  // ONE table, not two. A board is a text value on the tile rather than a row of
  // its own, so a board can never be orphaned, renamed halfway, or left holding
  // rows that point at a board that was deleted. The list of boards is derived
  // from the tiles (see dreamLogic.boardsOf) and unioned with the names saved in
  // app_settings, which is what lets a board you just created survive being
  // empty. Exactly the shape the grocery list's stores landed on.
  //
  // Soft-deleted tiles are filtered out HERE, in the reader, which is the only
  // read of this table in the browser. See the block above the db object.
  async loadDreamItems() {
    return readUndeleted(() => supabase.from("dream_items")
      .select("id,board,title,image_url,note,sort,created_at")
      .order("sort", { ascending: true }).order("created_at", { ascending: true }));
  },
  async saveDreamItem(it) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = {
      id: it.id, user_id, board: it.board, title: it.title || "",
      image_url: it.image_url || null, note: it.note || null,
      sort: Number.isFinite(it.sort) ? it.sort : 0,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from("dream_items").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    // Same reasoning as saveAffirmation: saving a tile asserts the tile exists, so
    // a save that lands on a soft-deleted row un-deletes it rather than reporting
    // success over something that stays off the wall.
    if (data?.deleted_at) { const [back] = await db.restoreDreamItems([it.id]); return back || data; }
    return data;
  },
  async deleteDreamItem(id) {
    const now = new Date().toISOString();
    const { error } = await supabase.from("dream_items")
      .update({ deleted_at: now, updated_at: now })
      // `is deleted_at null` so deleting the same tile twice cannot push its
      // thirty-day clock forward. deleted_at means when it was deleted.
      .eq("id", id).is("deleted_at", null);
    if (error) throw softDeleteError(error, "the tile");
  },
  /** Rename a board = rewrite every tile on it. See the note above on why the
   *  board name lives on the tile.
   *
   *  THIS ONE HAS NO deleted_at FILTER, AND THAT IS THE POINT. A rename has to
   *  reach the soft-deleted tiles too, because the board name is the only thing
   *  connecting a tile to a board: leave a deleted tile behind on "Health" after
   *  the board becomes "Wellness" and restoring it resurrects a board name nothing
   *  else uses — a tile back on the wall, on a board that is not in the strip.
   *  Renaming rows nobody can currently see costs nothing and keeps the undo
   *  landing where the tile belongs. */
  async renameDreamBoard(from, to) {
    const { error } = await supabase.from("dream_items").update({ board: to, updated_at: new Date().toISOString() }).eq("board", from);
    if (error) throw error;
  },
  /**
   * Delete a whole board — the call this soft delete was written for.
   *
   * Returns the ids it marked, and the panel should hold them for an undo. That is
   * the notes pattern (bulkDeleteNotes hands the caller what restoreNotes needs),
   * and it is more precise than restoring "the board" by name would be: a tile
   * deleted on its own three weeks ago is still sitting in this table with the same
   * board value, and a name-based restore would drag it back too, which is not what
   * "undo that" means.
   */
  async deleteDreamBoard(board) {
    const now = new Date().toISOString();
    const { data, error } = await supabase.from("dream_items")
      .update({ deleted_at: now, updated_at: now })
      .eq("board", board).is("deleted_at", null)
      .select("id");
    if (error) throw softDeleteError(error, "the board");
    return (data || []).map((r) => r.id);
  },
  /** The undo for either dream delete. Ids, because that is what the deletes hand back. */
  async restoreDreamItems(ids) {
    if (!ids?.length) return [];
    const { data, error } = await supabase.from("dream_items")
      .update({ deleted_at: null, updated_at: new Date().toISOString() })
      .in("id", ids).select();
    if (error) throw softDeleteError(error, "the tiles");
    return data || [];
  },

  /* ── alt positions — the book behind the Alt Season tab ──────────────────
     The screener's own log (alt_flags) is written by the cron and read-only
     here; this is the other table, the one holding what was actually bought.
     See supabase/migrations/0035_alt_positions.sql for why cost basis is
     averaged on write and why rungs_hit is a ratcheting count. */
  async loadAltPositions() {
    const { data, error } = await supabase.from("alt_positions")
      .select("id,coin_id,symbol,name,sleeve,cost_basis,units,rungs_hit,opened_at,closed_at,notes")
      .is("closed_at", null)
      .order("opened_at", { ascending: false });
    if (error) throw error;
    // numeric comes back as a STRING from PostgREST, every time. Left alone it
    // reaches ladderState, `price / "0.0034"` coerces to a number by luck, and
    // then `rungs_hit` in a >= comparison silently stops ratcheting — the exact
    // class of bug the cron's own fin() exists to prevent. Coerce at the edge.
    return (data || []).map((r) => ({
      ...r,
      cost_basis: Number(r.cost_basis),
      units: r.units == null ? null : Number(r.units),
      rungs_hit: Number(r.rungs_hit) || 0,
    }));
  },

  /** Create or replace a position outright. Averaging a tranche in is
   *  addAltTranche — this one is for the first buy and for corrections. */
  async saveAltPosition(pos) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const now = new Date().toISOString();
    const row = {
      id: pos.id || crypto.randomUUID(),
      user_id,
      coin_id: pos.coin_id,
      symbol: String(pos.symbol || "").toUpperCase(),
      name: pos.name || null,
      sleeve: pos.sleeve || "tail",
      cost_basis: Number(pos.cost_basis),
      units: pos.units == null ? null : Number(pos.units),
      rungs_hit: Math.max(0, Math.round(Number(pos.rungs_hit) || 0)),
      opened_at: pos.opened_at || now,
      updated_at: now,
    };
    if (!Number.isFinite(row.cost_basis) || row.cost_basis <= 0) throw new Error("Cost basis has to be a price above zero");
    const { data, error } = await supabase.from("alt_positions").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  },

  /** Add a tranche — the DCA path. The weighting is in altLadder.averageIn;
   *  this only reads the current row and writes the merged one back. */
  async addAltTranche(id, { price, units }) {
    const { data: cur, error: readErr } = await supabase.from("alt_positions")
      .select("cost_basis,units").eq("id", id).single();
    if (readErr) throw readErr;
    const merged = averageIn(
      { cost_basis: Number(cur.cost_basis), units: cur.units == null ? null : Number(cur.units) },
      price, units,
    );
    if (!merged) throw new Error("A tranche needs both a price and a unit count to average in");
    const { data, error } = await supabase.from("alt_positions")
      .update({ ...merged, updated_at: new Date().toISOString() })
      .eq("id", id).select().single();
    if (error) throw error;
    return data;
  },

  /** Mark the next rung sold. RATCHETS — see the migration header. The guard is
   *  `.eq("rungs_hit", from)`, so two taps on the same row (a double-tap on a
   *  phone, or the same page open twice) advance the ladder once, not twice. */
  async sellAltRung(id, from) {
    const { data, error } = await supabase.from("alt_positions")
      .update({ rungs_hit: from + 1, updated_at: new Date().toISOString() })
      .eq("id", id).eq("rungs_hit", from).select();
    if (error) throw error;
    return (data || [])[0] || null;
  },

  /** Close a position. Kept, not deleted — the point of writing the ladder down
   *  is being able to look back at whether it was followed. */
  async closeAltPosition(id) {
    const now = new Date().toISOString();
    const { error } = await supabase.from("alt_positions")
      .update({ closed_at: now, updated_at: now })
      .eq("id", id).is("closed_at", null);
    if (error) throw error;
  },

  // ─── Guitar ────────────────────────────────────────────────────────────────
  // Three tables and one principle: THE PRACTICE LOG IS THE ONE THING THIS TAB
  // CANNOT LOSE. Everything else in the Guitar tab is either reference data
  // (which is in the bundle) or a preference (which lives in app_settings). A
  // session is the only row that represents something that actually happened,
  // once, and cannot be reconstructed — so every write below reads its error and
  // throws, and the panel keeps a localStorage mirror of the session in progress
  // until the row lands.
  //
  // `day` is a LOCAL date string, not a timestamp, and the reason is in the
  // header of lib/guitar/practice.js: a session that starts at 23:50 and saves at
  // 00:10 is one sitting with a guitar, and filing it under two days would award
  // a streak nobody earned.

  /** The practice log, newest first. 400 rows is a bit over a year of daily
   *  practice — enough for every streak, heatmap and weekly-minutes read the tab
   *  makes, and small enough to hold in memory without thinking about it. */
  async loadGuitarSessions(limit = 400) {
    const { data, error } = await supabase.from("guitar_sessions")
      .select("id,day,started_at,ended_at,minutes,items,focus,drift_ms,note")
      .order("day", { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  },
  /** One finished session. Strict by nature — see the note above. */
  async saveGuitarSession(row) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const payload = {
      id: row.id || crypto.randomUUID(), user_id,
      day: row.day, started_at: row.startedAt || new Date().toISOString(),
      ended_at: row.endedAt || new Date().toISOString(),
      minutes: Math.max(0, Math.round(row.minutes || 0)),
      items: row.items || [], focus: row.focus || null,
      drift_ms: row.driftMs ?? null, note: row.note || "",
    };
    const { data, error } = await supabase.from("guitar_sessions").upsert(payload, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  },
  async deleteGuitarSession(id) {
    const { error } = await supabase.from("guitar_sessions").delete().eq("id", id);
    if (error) throw error;
  },

  /** Per-skill state — the thing the scheduler reads. Keyed by the skill id from
   *  lib/guitar/library.js, which is why those ids are permanent. */
  async loadGuitarSkills() {
    const { data, error } = await supabase.from("guitar_skills")
      .select("skill_id,strength,last_practiced,sessions,minutes,best_bpm,ceiling_bpm,history,updated_at");
    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.skill_id, strength: Number(r.strength) || 0, lastPracticed: r.last_practiced,
      sessions: r.sessions || 0, minutes: Number(r.minutes) || 0,
      bestBpm: r.best_bpm, ceilingBpm: r.ceiling_bpm, history: r.history || [],
    }));
  },
  /** Upsert a batch of skill states. One call per session rather than one per
   *  item: a session touches three or four skills and four round trips is four
   *  chances for half of them to land. */
  async saveGuitarSkills(rows) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const payload = (rows || []).map((r) => ({
      user_id, skill_id: r.id,
      strength: r.strength ?? 0, last_practiced: r.lastPracticed || null,
      sessions: r.sessions ?? 0, minutes: r.minutes ?? 0,
      best_bpm: r.bestBpm ?? null, ceiling_bpm: r.ceilingBpm ?? null,
      history: (r.history || []).slice(-20),
      updated_at: new Date().toISOString(),
    }));
    if (!payload.length) return [];
    const { data, error } = await supabase.from("guitar_skills")
      .upsert(payload, { onConflict: "user_id,skill_id" }).select();
    if (error) throw error;
    return data || [];
  },

  /** The repertoire. `chart` holds the sections; everything else is metadata a
   *  list needs to sort and filter by. */
  async loadGuitarSongs() {
    const { data, error } = await supabase.from("guitar_songs")
      .select("id,title,artist,song_key,bpm,capo,difficulty,status,chart,strum,clean_runs,last_played,note,updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.id, title: r.title, artist: r.artist, key: r.song_key, bpm: r.bpm,
      capo: r.capo || 0, difficulty: r.difficulty || 2, status: r.status || "learning",
      sections: r.chart?.sections || [], strum: r.strum, cleanRuns: r.clean_runs || 0,
      lastPlayed: r.last_played, note: r.note || "", source: "own",
    }));
  },
  async saveGuitarSong(song) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = {
      id: song.id || crypto.randomUUID(), user_id,
      title: song.title || "Untitled", artist: song.artist || "",
      song_key: song.key || null, bpm: song.bpm ?? null, capo: song.capo ?? 0,
      difficulty: song.difficulty ?? 2, status: song.status || "learning",
      chart: { sections: song.sections || [] }, strum: song.strum || null,
      clean_runs: song.cleanRuns ?? 0, last_played: song.lastPlayed || null,
      note: song.note || "", updated_at: new Date().toISOString(),
    };
    // "user_id,id" MATCHES THE TABLE'S KEY. guitar_songs is keyed by the pair (a
    // seed song's id is its slug, so id alone would be one row per slug for the
    // whole database — see the note in 0039), and an onConflict that names a
    // column set with no unique index behind it is an error, not a fallback.
    const { data, error } = await supabase.from("guitar_songs").upsert(row, { onConflict: "user_id,id" }).select().single();
    if (error) throw error;
    return data;
  },
  async deleteGuitarSong(id) {
    const { error } = await supabase.from("guitar_songs").delete().eq("id", id);
    if (error) throw error;
  },
};

// Postgres says 42P01 ("relation does not exist"); PostgREST/supabase-js says
// PGRST205 ("Could not find the table ... in the schema cache"). Both mean
// the one-time SQL hasn't been run yet — show the setup card, not a raw error.
export const isMissingTable = (e, name) =>
  /42P01|PGRST205/.test(e?.code || "") ||
  new RegExp(`relation .*${name}.* does not exist`, "i").test(e?.message || "") ||
  (/schema cache|could not find the table/i.test(e?.message || "") && (e?.message || "").includes(name));
