import { supabase } from "../lib/supabase.js";
import { todayISO } from "../lib/dates.js";

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
  async saveMessage({ role, content, consulted = [] }) {
    try { await supabase.from("chat_messages").insert({ role, content, consulted_seats: consulted }); } catch {}
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
  async saveSeatNote(seatKey, notes) {
    const user_id = await db.uid();
    if (!user_id) return;
    try { await supabase.from("seat_notes").upsert({ user_id, seat_key: seatKey, notes, updated_at: new Date().toISOString() }, { onConflict: "user_id,seat_key" }); } catch {}
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
  async saveSetting(key, value) {
    const user_id = await db.uid();
    if (!user_id) return;
    try { await supabase.from("app_settings").upsert({ user_id, setting_key: key, setting_value: value, updated_at: new Date().toISOString() }, { onConflict: "user_id,setting_key" }); } catch {}
  },
  async loadFindings(limit = 40) {
    const { data, error } = await supabase.from("auditor_findings")
      .select("property,severity,area,finding,suggestion,created_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) return [];
    return (data || []).map(r => ({ ...r, ts: new Date(r.created_at).getTime() }));
  },
  async saveFindings(rows) {
    if (!rows || !rows.length) return;
    try { await supabase.from("auditor_findings").insert(rows.map(r => ({ property: r.property, severity: r.severity, area: r.area || null, finding: r.finding, suggestion: r.suggestion }))); } catch {}
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
      .select("id,title,notes,start_time,end_time,all_day,location,category")
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
    };
    const { data, error } = await supabase.from("personal_events").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
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
    // todayISO(), never toISOString().slice(0,10) — the UTC day is tomorrow
    // every evening in the Americas (see lib/dates.js).
    const row = { user_id, title: m.title, year: m.year || null, poster_url: m.poster_url || null, true_quality_score: m.true_quality_score ?? null, cameron_score: m.cameron_score ?? null, note: m.note || "", watched_date: m.watched_date || todayISO() };
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
};

// Postgres says 42P01 ("relation does not exist"); PostgREST/supabase-js says
// PGRST205 ("Could not find the table ... in the schema cache"). Both mean
// the one-time SQL hasn't been run yet — show the setup card, not a raw error.
export const isMissingTable = (e, name) =>
  /42P01|PGRST205/.test(e?.code || "") ||
  new RegExp(`relation .*${name}.* does not exist`, "i").test(e?.message || "") ||
  (/schema cache|could not find the table/i.test(e?.message || "") && (e?.message || "").includes(name));
