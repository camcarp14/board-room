import { supabase } from "../lib/supabase.js";
import { todayISO } from "../lib/dates.js";

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
  if (strict) {
    await run(); // throws on failure — the caller asked for that
    writeFailures.clear(key);
    return { ok: true };
  }
  try {
    await run();
    writeFailures.clear(key);
    return { ok: true };
  } catch (error) {
    failures.set(key, { key, label, error, at: Date.now(), retry: () => reported(key, label, run) });
    announce();
    return { ok: false, error };
  }
}

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
    const { data, error } = await supabase.from("app_settings").select("setting_key,setting_value");
    // Throw, don't return {} — an error here previously looked like "no settings
    // saved" and one flaky refresh wiped calendar_url, model prefs, and the Mini
    // Me queue out of live state. Callers keep the previous settings on throw.
    if (error) throw error;
    const out = {};
    (data || []).forEach(r => { out[r.setting_key] = r.setting_value; });
    return out;
  },
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
  async loadNotes() {
    // Try the upgraded schema first; fall back cleanly if the pinned/color
    // columns haven't been added yet so notes keep working pre-migration.
    const full = await supabase.from("personal_notes")
      .select("id,title,body,pinned,color,updated_at,created_at")
      .order("updated_at", { ascending: false });
    if (!full.error) return { rows: full.data || [], legacy: false };
    if (!/column|pinned|color|42703/i.test(full.error.message || "")) throw full.error;
    const base = await supabase.from("personal_notes")
      .select("id,title,body,updated_at,created_at")
      .order("updated_at", { ascending: false });
    if (base.error) throw base.error;
    return { rows: base.data || [], legacy: true };
  },
  async saveNote(note) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = { id: note.id, user_id, title: note.title, body: note.body, updated_at: new Date().toISOString() };
    if (note.pinned !== undefined) row.pinned = note.pinned;
    if (note.color !== undefined) row.color = note.color;
    const { data, error } = await supabase.from("personal_notes").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  },
  async deleteNote(id) {
    const { error } = await supabase.from("personal_notes").delete().eq("id", id);
    if (error) throw error;
  },
  async bulkDeleteNotes(ids) {
    if (!ids?.length) return;
    const { error } = await supabase.from("personal_notes").delete().in("id", ids);
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
    const clean = rows.map(({ id, title, body, pinned, color, created_at, updated_at }) => {
      const r = { id, user_id, title, body, created_at, updated_at };
      if (pinned !== undefined) r.pinned = pinned;
      if (color !== undefined) r.color = color;
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
  async loadTransactions(limit = 5000) {
    const { data, error } = await supabase.from("transactions")
      .select("id,account,date,amount_cents,description,merchant,category,category_override")
      .order("date", { ascending: false }).limit(limit);
    // Throws rather than returning [] — a dropped request must not read as "you
    // have no transactions", which in a budgeting tool is a $0 month.
    if (error) throw error;
    return (data || []).map((r) => ({ ...r, amount: r.amount_cents }));
  },
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
  async deleteTransactionsForAccount(account) {
    const { error } = await supabase.from("transactions").delete().eq("account", account);
    if (error) throw error;
  },
  async loadAffirmations() {
    const { data, error } = await supabase.from("affirmations")
      .select("id,text,kind,created_at")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async saveAffirmation(a) {
    const user_id = await db.uid();
    if (!user_id) throw new Error("Not signed in");
    const row = { id: a.id, user_id, text: a.text, kind: a.kind || "creed", updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from("affirmations").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  },
  async deleteAffirmation(id) {
    const { error } = await supabase.from("affirmations").delete().eq("id", id);
    if (error) throw error;
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
  async loadDreamItems() {
    const { data, error } = await supabase.from("dream_items")
      .select("id,board,title,image_url,note,sort,created_at")
      .order("sort", { ascending: true }).order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
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
    return data;
  },
  async deleteDreamItem(id) {
    const { error } = await supabase.from("dream_items").delete().eq("id", id);
    if (error) throw error;
  },
  /** Rename a board = rewrite every tile on it. See the note above on why the
   *  board name lives on the tile. */
  async renameDreamBoard(from, to) {
    const { error } = await supabase.from("dream_items").update({ board: to, updated_at: new Date().toISOString() }).eq("board", from);
    if (error) throw error;
  },
  async deleteDreamBoard(board) {
    const { error } = await supabase.from("dream_items").delete().eq("board", board);
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
