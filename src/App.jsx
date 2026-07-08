import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import GscLineChart from "./GscLineChart.jsx";
import BtcChartModal from "./BtcChartModal.jsx";
import WorkoutPanel from "./WorkoutPanel.jsx";
import LearnPanel, { parseLearnCommand, learnFromInput, buildSkillsBlock, makeSdb as makeSkillsDb } from "./LearnPanel.jsx";

// ════════════════════════════════════════════════════════════════════════════
// THE BOARD ROOM — modern roman edition.
// One NAV drives both platforms: Brief · Room · Board · Assets · Systems ·
// Mini Me. Desktop shows a labeled rail; mobile shows the same six as icons.
// Systems folds status/deploy/database/auditor/usage behind sub-tabs.
// Supabase remains the shared brain; no page shows fabricated data.
// ════════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

// ─── Model registry — every layer starts on the cheapest model ───────────────
const MODEL_IDS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-1",
};
const MODEL_META = [
  { key: "haiku", label: "Haiku", price: "$1/$5", mult: 1 },
  { key: "sonnet", label: "Sonnet", price: "$3/$15", mult: 3 },
  { key: "opus", label: "Opus", price: "$15/$75", mult: 15 },
];
const PRICING = { haiku: { in: 1, out: 5 }, sonnet: { in: 3, out: 15 }, opus: { in: 15, out: 75 } };
const estCost = (mk, i, o) => (i / 1e6) * (PRICING[mk]?.in || 1) + (o / 1e6) * (PRICING[mk]?.out || 5);
const DEFAULT_MODELS = { router: "haiku", seats: "haiku", chief: "haiku" };

// localStorage — telemetry/cache only, never the brain.
const sm = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(`br_${k}`)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`br_${k}`, JSON.stringify(v)); } catch {} },
};
const obs = {
  all: () => sm.get("obs") || [],
  log: (e) => sm.set("obs", [{ ts: new Date().toISOString(), ...e }, ...(sm.get("obs") || [])].slice(0, 300)),
};

// ─── db — Supabase-backed memory layer (unchanged contract) ──────────────────
const db = {
  async uid() {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id || null;
  },
  async loadChat(limit = 200) {
    const { data, error } = await supabase.from("chat_messages")
      .select("role,content,consulted_seats,created_at,source")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) return [];
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
    if (error) return {};
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
    if (error) return {};
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
    try { await supabase.from("personal_notes").delete().eq("id", id); } catch {}
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
    try { await supabase.from("personal_events").delete().eq("id", id); } catch {}
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
    const row = { user_id, title: m.title, year: m.year || null, poster_url: m.poster_url || null, true_quality_score: m.true_quality_score ?? null, cameron_score: m.cameron_score ?? null, note: m.note || "", watched_date: m.watched_date || new Date().toISOString().slice(0, 10) };
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
  async deleteBirthday(id) {
    try { await supabase.from("personal_birthdays").delete().eq("id", id); } catch {}
  },
};

// Durable, cross-device usage log (Supabase) — separate from the
// localStorage-only `obs` tracker below, which resets per-browser. Every
// Anthropic call and every Netlify function hit gets a row here, powering
// the Usage section in IT Department. Fire-and-forget; never blocks or
// throws into the caller.
async function logUsage(row) {
  if (!supabase) return;
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    if (!uid) return;
    await supabase.from("usage_log").insert({ user_id: uid, ...row });
  } catch { /* table may not exist yet, or offline — never break the caller */ }
}

async function callClaude({ system, messages, modelKey = "haiku", maxTokens = 800, fn = "call" }) {
  const t0 = Date.now();
  const model = MODEL_IDS[modelKey] || MODEL_IDS.haiku;
  try {
    const isDeployed = window.location.hostname !== "localhost";
    const url = isDeployed ? "/.netlify/functions/claude" : "https://api.anthropic.com/v1/messages";
    const headers = isDeployed ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json();
    const text = data.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
    const inTok = data.usage?.input_tokens || 0, outTok = data.usage?.output_tokens || 0;
    const cost = estCost(modelKey, inTok, outTok);
    const ms = Date.now() - t0;
    obs.log({ fn, model, inTok, outTok, cost, ms, ok: !!text });
    logUsage({ fn, kind: "anthropic", model: modelKey, in_tokens: inTok, out_tokens: outTok, cost_usd: cost, ms, ok: !!text });
    return text;
  } catch {
    const ms = Date.now() - t0;
    obs.log({ fn, model, ok: false, ms });
    logUsage({ fn, kind: "anthropic", model: modelKey, ms, ok: false, detail: "request failed" });
    return null;
  }
}

// ─── The Board ────────────────────────────────────────────────────────────────
const BOARD = [
  { key: "clarify", name: "Clarify Lead", emoji: "🎯", color: "#B68A2E",
    charter: "You run Clarify Paid Search — a boutique Google Ads agency targeting high-value local service verticals (legal, med spa, dental, home services). You own the outreach pipeline, client delivery, and agency growth. You think in pipeline value, reply rates, and retainer economics. You are direct about what will and won't move revenue.",
    blurb: "Owns the outreach pipeline, client delivery, and agency growth. Thinks in pipeline value, reply rates, retainer economics.",
    domains: "agency, outreach, paid search, Google Ads, clients, prospecting, Clarify" },
  { key: "zts", name: "ZTS Lead", emoji: "🔐", color: "#0E9F6E",
    charter: "You run Zero To Secure — a premium stainless-steel seed phrase backup kit ($150, DTC Shopify). You own creator collabs, YouTube Shorts production, SEO content, and conversion. You think in audience-fit reach, content cadence, and DTC unit economics. Bitcoin self-custody conviction, empowerment over fear.",
    blurb: "Owns creator collabs, Shorts production, SEO, and conversion for Zero To Secure. Empowerment over fear.",
    domains: "ZTS, Zero To Secure, creators, YouTube, Shorts, SEO, Shopify, ecommerce, Bitcoin product" },
  { key: "macro", name: "Macro Strategist", emoji: "📈", color: "#31589C",
    charter: "You are the markets and macro seat. Cameron holds long-term Bitcoin conviction with a leveraged WBTC position on Aave he manages carefully, and has a developed thesis about an AI investment bubble (circular hyperscaler financing, private credit exposure). Your job is honest pressure-testing, never validation. Flag risk asymmetries. He has explicitly asked you not to glaze over weaknesses.",
    blurb: "Markets and macro. Honest pressure-testing, never validation — flags risk asymmetries in the BTC position and AI-bubble thesis.",
    domains: "markets, macro, Bitcoin, BTC, crypto, investing, trading, Fed, positions, portfolio" },
  { key: "ops", name: "Ops & Finance", emoji: "⚙️", color: "#7C3AED",
    charter: "You are the operations and finance seat across all ventures. You watch time allocation, AI/tool spend, and whether effort matches expected return. Cameron's stated goal: decouple income from hours sold; near-term success = meaningful recurring revenue from either venture. You are the one who asks 'is this the best use of the next 10 hours?'",
    blurb: "Watches time allocation and spend across ventures. The one who asks: is this the best use of the next 10 hours?",
    domains: "operations, priorities, time, spend, budget, focus, tradeoffs, planning, week" },
  { key: "career", name: "Career Advisor", emoji: "🧭", color: "#EC4899",
    charter: "You are the career seat. Cameron is a Senior Analyst in paid search at Ovative Group (Chicago, healthcare portfolio) with limited upward mobility due to tenure-weighted promotions. Identified path: RevOps Manager at a mid-size SaaS company within ~2 years for significantly higher compensation; Salesforce-adjacent skills matter. You weigh day-job moves against the ventures without romanticizing either.",
    blurb: "Weighs day-job moves against the ventures — the RevOps path, Salesforce-adjacent skills — without romanticizing either.",
    domains: "career, Ovative, job, RevOps, Salesforce, promotion, resume, interviews, work" },
];

const CHIEF_SYSTEM = `You are the Chief of Staff for Cameron's board room — the single point of contact above five specialist seats (Clarify Lead, ZTS Lead, Macro Strategist, Ops & Finance, Career Advisor). Cameron is a builder running two ventures alongside a day job, with a stated goal of decoupling income from hours sold. You are direct, synthesizing, and honest — he has explicitly asked for pressure-testing over validation. When board perspectives conflict, name the conflict rather than smoothing it over.`;

async function routeQuestion(question, models) {
  const system = `You are a router. Given a question, decide which board seats should be consulted. Seats and their domains:
${BOARD.map(b => `- ${b.key}: ${b.domains}`).join("\n")}

Respond ONLY with JSON: {"seats": ["key1", ...], "reason": "5 words max"}
Rules: 0 seats if the Chief can answer alone (greetings, simple facts, followups). 1-2 seats for domain questions. 3+ only for genuinely cross-cutting strategy. Fewer is better.`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: question }], modelKey: models.router, maxTokens: 120, fn: "route" });
  try { const p = JSON.parse((raw || "").replace(/```json|```/g, "").trim()); return { seats: (p.seats || []).filter(k => BOARD.some(b => b.key === k)), reason: p.reason || "" }; } catch { return { seats: [], reason: "routing failed — chief only" }; }
}

async function consultSeat(seatKey, question, seatNotes, models) {
  const seat = BOARD.find(b => b.key === seatKey);
  if (!seat) return null;
  const notes = (seatNotes || {})[seatKey] || "";
  const system = `${seat.charter}${notes ? `\n\nCurrent context from Cameron (treat as ground truth):\n${notes}` : ""}${formatSnapshotForChat()}\n\nYou are giving your seat's perspective to the Chief of Staff, who will synthesize. Be concise: 2-4 sentences of your genuine take, including any disagreement or risk you see. No preamble.`;
  const text = await callClaude({ system, messages: [{ role: "user", content: question }], modelKey: models.seats, maxTokens: 300, fn: `seat_${seatKey}` });
  return text ? { seat: seat.key, name: seat.name, emoji: seat.emoji, color: seat.color, take: text } : null;
}

async function convene(question, history, { models = DEFAULT_MODELS, seatNotes, skills } = {}) {
  const routing = await routeQuestion(question, models);
  const takes = routing.seats.length
    ? (await Promise.all(routing.seats.map(k => consultSeat(k, question, seatNotes, models)))).filter(Boolean)
    : [];
  const historyMsgs = (history || []).slice(-8).map(m => ({ role: m.role, content: m.content }));
  const boardBlock = takes.length
    ? `\n\nThe board seats you consulted returned these takes:\n${takes.map(t => `[${t.name}]: ${t.take}`).join("\n\n")}\n\nSynthesize into one answer. Attribute perspectives naturally ("Clarify's lead thinks..."). If seats conflict, surface the conflict and give YOUR recommendation.`
    : "";
  const answer = await callClaude({
    system: CHIEF_SYSTEM + formatSnapshotForChat() + buildSkillsBlock(skills) + boardBlock,
    messages: [...historyMsgs, { role: "user", content: question }],
    modelKey: models.chief, maxTokens: 900, fn: "chief",
  });
  return { answer: answer || "The board couldn't be reached — check your API key.", consulted: takes, routing };
}

// ─── Netlify function helpers (graceful fallback when a fn isn't built yet) ──
async function callFn(name, payload, extraHeaders) {
  const t0 = Date.now();
  let ok = false, detail;
  try {
    const res = await fetch(`/.netlify/functions/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(extraHeaders || {}) }, body: JSON.stringify(payload || {}),
    });
    ok = res.ok;
    if (!ok) { detail = `HTTP ${res.status}`; throw new Error(detail); }
    return await res.json();
  } catch {
    if (!detail) detail = "network error";
    return null;
  } finally {
    logUsage({ fn: name, kind: "call", ms: Date.now() - t0, ok, detail });
  }
}
// Like callFn but keeps HTTP status + error body so the UI can say WHY a card isn't live.
async function callFnFull(name, payload) {
  const t0 = Date.now();
  let ok = false, status = 0, data = null, detail;
  try {
    const res = await fetch(`/.netlify/functions/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}),
    });
    status = res.status; ok = res.ok;
    data = await res.json().catch(() => null);
    if (!ok) detail = data?.error || `HTTP ${status}`;
    return { ok, status, data };
  } catch {
    detail = "network error";
    return { ok: false, status: 0, data: null };
  } finally {
    logUsage({ fn: name, kind: "call", ms: Date.now() - t0, ok, detail });
  }
}

// ─── Design system ────────────────────────────────────────────────────────────
// Modern Roman, light: marble surfaces, bronze accents, inscription capitals.
// `syne` keeps its name (100+ call sites) but now carries Cinzel.
const syne = "'Cinzel', 'Times New Roman', serif", mono = "'DM Mono', monospace";
const T = {
  bg: "#F4F2ED", surface: "#FBFAF8", ink: "#201B12", sub: "#635C4C", faint: "#99917E",
  brass: "#8A671C", brassDeep: "#6A4D12", line: "rgba(32,27,18,0.09)", lineStrong: "rgba(32,27,18,0.18)",
  green: "#1F7A55", red: "#B23A2E", amber: "#A2700E", blue: "#31589C",
};
// The plate system: every card is a quiet paper plate with a hairline edge —
// no stripes, no glow. Titles are engraved (Cinzel small caps, wide tracking).
// Brass is spent in exactly three places: the active mark, the primary
// action, and live data. Shadows exist only on things that float.
const S = {
  card: { padding: "20px 22px", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 14, boxShadow: "none" },
  cardM: { padding: "17px 16px", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 13, boxShadow: "none" },
  inner: { background: "transparent", border: `1px solid ${T.line}`, borderRadius: 10 },
  title: { fontSize: 11, fontWeight: 600, fontFamily: syne, color: T.ink, letterSpacing: "0.18em", textTransform: "uppercase" },
  microLabel: { fontSize: 9, color: T.faint, fontFamily: mono, letterSpacing: "0.14em", textTransform: "uppercase" },
  brassBtn: { background: T.brass, border: "none", borderRadius: 9, color: "#FCFBF8", fontWeight: 700, fontFamily: syne, letterSpacing: "0.04em", cursor: "pointer", boxShadow: "none" },
  ghostBtn: { background: "transparent", border: `1px solid ${T.lineStrong}`, borderRadius: 9, color: T.sub, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" },
  input: { background: "#FFFFFF", border: `1px solid ${T.lineStrong}`, borderRadius: 9, color: T.ink },
};

function useGlobalStyles() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&family=Cinzel:wght@500;600;700;800&display=swap";
    document.head.appendChild(link);
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      * { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
      html, body { margin: 0; font-family: 'Inter', system-ui, sans-serif; overscroll-behavior-y: none; }
      body { color: #201B12; background-color: #F4F2ED; }
      ::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(34,29,20,0.18); border-radius: 10px; }
      textarea, input, select, button { font-family: 'Inter', system-ui, sans-serif; }
      ::selection { background: rgba(143,107,30,0.22); color: #221D14; }
      button, a, input, textarea { transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease; }
      button:focus-visible, input:focus-visible, textarea:focus-visible { outline: none; box-shadow: 0 0 0 2px #F4F2ED, 0 0 0 4px rgba(138,103,28,0.55); }
      input::placeholder, textarea::placeholder { color: #9A9280; }
      textarea:focus, input:focus { outline: none; }
      @media (max-width: 760px) { input, textarea, select { font-size: 16px !important; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
      @keyframes fadein { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      @keyframes sheetup { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } }
      @keyframes breathe { 0%,100% { box-shadow: 0 0 10px rgba(143,107,30,0.25), inset 0 1px 0 rgba(255,255,255,0.3); } 50% { box-shadow: 0 0 22px rgba(143,107,30,0.4), inset 0 1px 0 rgba(255,255,255,0.3); } }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes shake { 10%,90% { transform: translateX(-2px); } 20%,80% { transform: translateX(4px); } 30%,50%,70% { transform: translateX(-8px); } 40%,60% { transform: translateX(8px); } }
      input[type=range].scoreSlider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; border-radius: 999px; background: linear-gradient(to right, var(--slider-color, #9A9280) 0%, var(--slider-color, #9A9280) var(--slider-fill, 50%), rgba(34,29,20,0.12) var(--slider-fill, 50%), rgba(34,29,20,0.12) 100%); outline: none; cursor: pointer; margin: 0; }
      input[type=range].scoreSlider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border-radius: 50%; background: var(--slider-color, #9A9280); border: 2px solid #F3F1EC; box-shadow: 0 1px 4px rgba(0,0,0,0.3); cursor: pointer; }
      input[type=range].scoreSlider::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: var(--slider-color, #9A9280); border: 2px solid #F3F1EC; box-shadow: 0 1px 4px rgba(0,0,0,0.3); cursor: pointer; }
      input[type=range].scoreSlider::-moz-range-track { height: 6px; border-radius: 999px; background: rgba(34,29,20,0.12); }
      input[type=range].scoreSlider::-moz-range-progress { height: 6px; border-radius: 999px; background: var(--slider-color, #9A9280); }
    `;
    document.head.appendChild(style);
  }, []);
}

function useIsMobile() {
  const [is, setIs] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const fn = (e) => setIs(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return is;
}

const PROPERTIES = [
  { name: "Zero To Secure", desc: "Premium seed phrase backup", url: "https://zerotosecure.com", appUrl: "https://zts-command-center.netlify.app", color: "#0E9F6E", repo: "camcarp14/zts-command-center", site: "zero-to-secure" },
  { name: "Clarify Paid Search", desc: "Boutique Google Ads agency", url: "https://clarifypaidsearch.com", appUrl: "https://clarify-outreach.netlify.app/", color: "#B68A2E", repo: "camcarp14/clarify-outreach", site: "clarify-paid-search" },
  { name: "Clarify SaaS", desc: "Google Ads auditing tool", url: null, appUrl: "https://clarify-saas.netlify.app/", color: "#B68A2E", repo: "camcarp14/clarify-saas", site: "clarify-saas" },
  { name: "Macro Command Center", desc: "Markets, portfolio, thesis", url: null, appUrl: "https://macro-command-center.netlify.app/", color: "#31589C", repo: "camcarp14/macro-command-center", site: "macro-command-center" },
];

// ─── Bitcoin ──────────────────────────────────────────────────────────────────
function useBitcoinPrice() {
  const [state, setState] = useState({ price: null, changePct: null, points: [], high24: null, low24: null, loading: true, error: null, fetchedAt: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const fetchDirect = async () => {
      const [priceRes, chartRes] = await Promise.all([
        fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true"),
        fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1"),
      ]);
      const priceData = await priceRes.json();
      const chartData = await chartRes.json();
      const raw = (chartData.prices || []).map(([, p]) => p);
      const step = Math.max(1, Math.floor(raw.length / 48));
      return { price: priceData.bitcoin?.usd ?? null, changePct: priceData.bitcoin?.usd_24h_change ?? null, points: raw.filter((_, i) => i % step === 0), high24: raw.length ? Math.max(...raw) : null, low24: raw.length ? Math.min(...raw) : null };
    };
    const load = async () => {
      // Prefer the server-side proxy — same-origin, immune to the visitor's
      // own IP being rate-limited by CoinGecko (a common mobile-carrier issue).
      try {
        const res = await fetch("/.netlify/functions/btc");
        if (res.ok) {
          const data = await res.json();
          if (data?.success && alive) { const next = { price: data.price, changePct: data.changePct, points: data.points || [], high24: data.high24 ?? null, low24: data.low24 ?? null, loading: false, error: null, fetchedAt: Date.now() }; setState(next); updateSnapshot({ btc: next }); return; }
        }
        if (res.status !== 404) throw new Error(`proxy ${res.status}`);
      } catch { /* fall through to direct fetch below */ }
      // Function not deployed yet (e.g. plain `vite dev`) or the proxy failed — try direct.
      try {
        const direct = await fetchDirect();
        if (alive) { const next = { ...direct, loading: false, error: null, fetchedAt: Date.now() }; setState(next); updateSnapshot({ btc: next }); }
      } catch { if (alive) setState(s => ({ ...s, loading: false, error: "price feed unavailable" })); }
    };
    load();
    const iv = setInterval(load, 5 * 60 * 1000); // cheap now that it's proxied+cached
    return () => { alive = false; clearInterval(iv); };
  }, [nonce]);
  return { ...state, refresh: () => setNonce(n => n + 1) };
}

function Sparkline({ points, color, height = 44 }) {
  if (!points || points.length < 2) return <div style={{ height }} />;
  const min = Math.min(...points), max = Math.max(...points);
  const range = max - min || 1;
  const w = 260;
  const step = w / (points.length - 1);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(height - 3 - ((p - min) / range) * (height - 6)).toFixed(1)}`).join(" ");
  const areaPath = `${path} L ${w} ${height} L 0 ${height} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      <path d={areaPath} fill={color} opacity="0.12" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Bars({ data, from, to, height = 54 }) {
  const max = Math.max(...data, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height, padding: "0 2px" }}>
      {data.map((v, i) => (
        <div key={i} style={{ flex: 1, height: `${Math.max(4, (v / max) * 100)}%`, background: `linear-gradient(180deg, ${from}, ${to})`, borderRadius: "2px 2px 0 0", opacity: i >= data.length - 2 ? 1 : 0.72 }} />
      ))}
    </div>
  );
}

// ─── Reusable premium controls ────────────────────────────────────────────────
function Toggle({ on, onToggle, size = 20 }) {
  const w = size * 1.7, knob = size - 4;
  return (
    <span onClick={onToggle} style={{ width: w, height: size, borderRadius: size / 2 + 1, background: on ? T.green : "rgba(32,27,18,0.16)", position: "relative", cursor: "pointer", display: "inline-block", flex: "none", transition: "background 0.15s", boxShadow: "inset 0 1px 2px rgba(34,29,20,0.12)" }}>
      <span style={{ position: "absolute", top: 2, left: on ? w - knob - 2 : 2, width: knob, height: knob, borderRadius: "50%", background: "#FFFFFF", transition: "left 0.15s", boxShadow: "0 1px 3px rgba(34,29,20,0.18)" }} />
    </span>
  );
}

function ToggleRow({ title, sub, on, onToggle, size }) {
  return (
    <div style={{ ...S.inner, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 13px" }}>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: syne, color: T.ink }}>{title}</span>
        <span style={{ fontSize: 9, color: T.faint }}>{sub}</span>
      </span>
      <Toggle on={on} onToggle={onToggle} size={size} />
    </div>
  );
}

function Segmented({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, background: "rgba(34,29,20,0.05)", border: "1px solid rgba(34,29,20,0.06)", borderRadius: 11, padding: 3 }}>
      {MODEL_META.map(m => {
        const active = value === m.key;
        return (
          <button key={m.key} onClick={() => onChange(m.key)} style={{ flex: 1, padding: "7px 0 6px", background: active ? T.brass : "transparent", border: "none", borderRadius: 8, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 1, boxShadow: active ? "inset 0 1px 0 rgba(255,255,255,0.35), 0 2px 8px rgba(143,107,30,0.3)" : "none" }}>
            <span style={{ fontSize: 10, fontWeight: 700, fontFamily: syne, color: active ? T.bg : T.sub }}>{m.label}</span>
            <span style={{ fontSize: 7.5, fontFamily: mono, color: active ? "rgba(252,251,249,0.78)" : T.faint }}>{m.price}</span>
          </button>
        );
      })}
    </div>
  );
}

function Chips({ options, value, onChange, fmt = (v) => v }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {options.map(o => {
        const active = value === o;
        return (
          <button key={o} onClick={() => onChange(o)} style={{ flex: 1, padding: "9px 0", background: active ? "rgba(143,107,30,0.14)" : "rgba(34,29,20,0.045)", border: `1px solid ${active ? "rgba(143,107,30,0.4)" : "rgba(34,29,20,0.06)"}`, borderRadius: 10, color: active ? T.brass : T.sub, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>{fmt(o)}</button>
        );
      })}
    </div>
  );
}

function CardHeader({ title, tag, tagColor = T.faint }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
      <span style={S.title}>{title}</span>
      <span style={{ ...S.microLabel, color: tagColor }}>{tag}</span>
    </div>
  );
}

function StatBox({ value, label, delta, deltaColor = T.green, valueColor = T.ink, onClick, selected }) {
  return (
    <div
      onClick={onClick}
      style={{
        ...S.inner, padding: "10px 8px", textAlign: "center", borderRadius: 10,
        ...(onClick ? { cursor: "pointer", transition: "border-color 120ms ease, box-shadow 120ms ease" } : {}),
        ...(selected ? { border: "1px solid #9a7b4f", boxShadow: "0 0 0 1px #9a7b4f33" } : {}),
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: mono, color: valueColor }}>{value}</div>
      <div style={{ fontSize: 8, color: selected ? "#9a7b4f" : T.faint, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 }}>{label}</div>
      {delta && <div style={{ fontSize: 9, color: deltaColor, fontFamily: mono, marginTop: 2 }}>{delta}</div>}
    </div>
  );
}

// ─── Chat (shared by desktop Room page and mobile sheet) ─────────────────────
const SUGGESTIONS = ["What should I prioritize this week?", "Is ZTS or Clarify closer to recurring revenue?", "Pressure-test my BTC leverage right now"];

function ChatThread({ messages, thinking, loadingData, setInput, endRef, compact }) {
  return (
    <>
      {loadingData && <div style={{ fontSize: 11, color: T.faint, textAlign: "center", animation: "pulse 1.4s infinite" }}>Loading your memory…</div>}
      {!loadingData && messages.length === 0 && !thinking && (
        <div style={{ margin: "auto", textAlign: "center", maxWidth: 460, paddingTop: compact ? "7vh" : "14vh", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: compact ? 22 : 32, fontWeight: 700, fontFamily: syne, color: T.ink, letterSpacing: "0.03em" }}>The room is yours.</div>
          <div style={{ fontSize: compact ? 12.5 : 13, color: T.sub, lineHeight: 1.7 }}>Ask the Chief of Staff anything. It routes each question to the seats that matter and brings back one synthesized answer — with the disagreements left in.</div>
          <div style={{ display: "flex", flexDirection: compact ? "column" : "row", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 8, width: "100%" }}>
            {SUGGESTIONS.map((s, i) => (
              <button key={i} onClick={() => setInput(s)} style={{ padding: compact ? "12px 15px" : "10px 16px", background: "rgba(34,29,20,0.035)", border: `1px solid rgba(34,29,20,0.1)`, borderRadius: compact ? 12 : 20, color: T.sub, fontSize: 11.5, cursor: "pointer", textAlign: compact ? "left" : "center" }}>{s}</button>
            ))}
          </div>
        </div>
      )}
      {messages.map((m, i) => {
        const user = m.role === "user";
        return (
          <div key={i} style={{ alignSelf: user ? "flex-end" : "flex-start", maxWidth: compact ? "88%" : "76%", animation: "fadein 0.2s ease both", display: "flex", flexDirection: "column", gap: 7 }}>
            {!user && (m.consulted || []).length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {m.consulted.map((c, j) => (
                  <span key={j} title={c.take} style={{ fontSize: 9, fontWeight: 700, color: c.color, background: c.color + "1A", border: `1px solid ${c.color}40`, padding: "3.5px 10px", borderRadius: 14, fontFamily: syne, cursor: "help", letterSpacing: "0.03em" }}>{c.emoji} {c.name}</span>
                ))}
              </div>
            )}
            <div style={{ padding: compact ? "11px 14px" : "13px 17px", borderRadius: user ? "16px 16px 5px 16px" : "16px 16px 16px 5px", background: user ? "rgba(138,103,28,0.08)" : T.surface, border: `1px solid ${user ? "rgba(143,107,30,0.32)" : T.line}`, fontSize: 13.5, lineHeight: 1.68, whiteSpace: "pre-wrap", color: T.ink, boxShadow: "0 8px 24px rgba(34,29,20,0.045)" }}>{m.content}</div>
            {m.source === "discord" && <div style={{ fontSize: 8.5, color: T.faint, fontFamily: mono, letterSpacing: "0.06em" }}>VIA DISCORD</div>}
          </div>
        );
      })}
      {thinking && (
        <div style={{ alignSelf: "flex-start", padding: "12px 16px", borderRadius: "16px 16px 16px 5px", background: "rgba(34,29,20,0.04)", border: `1px solid ${T.line}`, fontSize: 12, color: T.sub }}>
          <span style={{ animation: "pulse 1.4s infinite" }}>Convening the room…</span>
        </div>
      )}
      <div ref={endRef} />
    </>
  );
}

function Composer({ input, setInput, onSend, thinking, compact }) {
  const canSend = !!input.trim() && !thinking;
  return (
    <div style={{ display: "flex", gap: compact ? 8 : 10, background: "#FFFFFF", border: "1px solid rgba(34,29,20,0.12)", borderRadius: 16, padding: compact ? "5px 5px 5px 16px" : "6px 6px 6px 20px", boxShadow: compact ? "0 1px 3px rgba(34,29,20,0.06)" : "0 2px 6px rgba(34,29,20,0.05), 0 14px 36px rgba(34,29,20,0.08)" }}>
      <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
        placeholder={compact ? "Ask the Chief…" : "Ask the Chief of Staff…"} rows={1}
        style={{ flex: 1, background: "transparent", border: "none", color: T.ink, fontSize: 13.5, resize: "none", padding: compact ? "11px 0" : "12px 0", lineHeight: 1.5, outline: "none" }} />
      <button onClick={onSend} disabled={!canSend} style={{ padding: compact ? "0 18px" : "0 26px", minHeight: compact ? 44 : undefined, background: canSend ? T.brass : "rgba(32,27,18,0.06)", border: "none", borderRadius: 11, color: canSend ? T.bg : T.faint, fontSize: 12, fontWeight: 700, cursor: canSend ? "pointer" : "default", fontFamily: syne, boxShadow: canSend ? "0 4px 14px rgba(143,107,30,0.35), inset 0 1px 0 rgba(255,255,255,0.35)" : "none" }}>Ask</button>
    </div>
  );
}

// ─── Top bar status: clock · data freshness · manual refresh ────────────────
function TopStatus({ now, dataStamp, refreshing, onRefresh, compact }) {
  const d = new Date(now);
  const date = d.toLocaleDateString(undefined, compact ? { month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const ageMin = dataStamp ? Math.floor((now - dataStamp) / 60000) : null;
  const fresh = ageMin === null ? "—" : ageMin < 1 ? "LIVE" : ageMin < 60 ? `${ageMin}M OLD` : `${Math.floor(ageMin / 60)}H OLD`;
  const freshColor = ageMin === null ? T.faint : ageMin < 5 ? T.green : ageMin < 30 ? T.amber : T.red;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: compact ? 8 : 12, flex: "none" }}>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
        <span style={{ fontSize: compact ? 10 : 11, fontWeight: 600, color: T.ink, fontFamily: mono, lineHeight: 1 }}>{time}</span>
        <span style={{ fontSize: compact ? 8 : 8.5, color: T.faint, fontFamily: mono, letterSpacing: "0.06em", lineHeight: 1.3, textTransform: "uppercase" }}>{date}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 5, padding: compact ? "4px 8px" : "5px 10px", background: freshColor + "14", border: `1px solid ${freshColor}35`, borderRadius: 11 }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: freshColor, boxShadow: `0 0 6px ${freshColor}90`, animation: ageMin !== null && ageMin < 1 ? "pulse 2s infinite" : "none" }} />
        <span style={{ fontSize: 8, fontWeight: 700, color: freshColor, fontFamily: mono, letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{compact ? fresh : `DATA ${fresh}`}</span>
      </span>
      <button onClick={onRefresh} disabled={refreshing} title="Refresh data" aria-label="Refresh data"
        style={{ width: compact ? 34 : 30, height: compact ? 34 : 30, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "rgba(143,107,30,0.1)", border: "1px solid rgba(143,107,30,0.3)", borderRadius: 9, cursor: refreshing ? "default" : "pointer", flex: "none", padding: 0 }}>
        <svg width={compact ? 15 : 14} height={compact ? 15 : 14} viewBox="0 0 24 24" fill="none" stroke={T.brass} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          style={{ animation: refreshing ? "spin 0.9s linear infinite" : "none", opacity: refreshing ? 0.7 : 1 }}>
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>
    </div>
  );
}

// ─── Page: The Room ─────────────────────────────────────────────────────────
// A real page now, same on both platforms — replaces the old mobile-only
// floating-pill-that-expands-to-a-sheet mechanic. One layout to learn.
function RoomPage({ messages, thinking, loadingData, input, setInput, onSend, onClearChat, endRef, isMobile }) {
  return (
    <>
      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "16px 14px 8px" : "32px 34px 10px", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: "100%", maxWidth: 780, display: "flex", flexDirection: "column", gap: 18, flex: 1 }}>
          {messages.length > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={onClearChat} style={{ background: "none", border: `1px solid ${T.line}`, borderRadius: 7, color: T.faint, fontSize: 10.5, padding: "4px 10px", cursor: "pointer", fontFamily: syne, fontWeight: 600 }}>Clear chat</button>
            </div>
          )}
          <ChatThread messages={messages} thinking={thinking} loadingData={loadingData} setInput={setInput} endRef={endRef} compact={isMobile} />
        </div>
      </div>
      <div style={{ flex: "none", padding: isMobile ? "10px 12px calc(12px + env(safe-area-inset-bottom))" : "14px 34px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 9 }}>
        <div style={{ width: "100%", maxWidth: 780 }}>
          <Composer input={input} setInput={setInput} onSend={onSend} thinking={thinking} compact={isMobile} />
        </div>
        {!isMobile && <div style={{ fontSize: 10, color: T.faint }}>Quick questions stay Chief-only · cross-cutting ones convene seats in parallel</div>}
      </div>
    </>
  );
}

// ─── Page: Morning Brief ──────────────────────────────────────────────────────
// Everything on this page is fetched live on load through Netlify functions.
// No fabricated fallback numbers anywhere on this page. Each card is either
// LIVE (real data), NOT CONNECTED (with exact setup instructions), or ERROR
// (with the actual failure). Empty dashes beat plausible-looking fake data.
const GSC_EMPTY = { impressions: "—", impressionsD: "", clicks: "—", clicksD: "", pos: "—", posD: "", series: Array(14).fill(0), daily: [], note: "" };
const STOCKS_EMPTY = { spx: { value: "—", price: "—", up: true }, ndq: { value: "—", price: "—", up: true }, tnx: { value: "—", price: "—", up: true }, dxy: { value: "—", price: "—", up: true } };

// ─── Live site snapshot ────────────────────────────────────────────────────
// Board seats previously only ever saw their static charter + whatever you
// typed — no live BTC price, stocks, calendar, nothing from the rest of the
// app. Pages write their data in here as it loads; convene()/consultSeat()
// read it back out into a compact context block. Module-level on purpose —
// this is a single-instance app, and it avoids threading every page's state
// through the whole component tree just so the chat can see it.
const siteSnapshot = { btc: null, stocks: null, wire: null, todayEvents: null, todayBirthdays: null, updatedAt: null };
function updateSnapshot(patch) {
  Object.assign(siteSnapshot, patch, { updatedAt: Date.now() });
}
function formatSnapshotForChat() {
  const parts = [];
  const b = siteSnapshot.btc;
  if (b && b.price) parts.push(`Bitcoin: $${Math.round(b.price).toLocaleString()}, ${b.changePct >= 0 ? "+" : ""}${(b.changePct || 0).toFixed(1)}% 24h`);
  const s = siteSnapshot.stocks;
  if (s && s.spx?.value !== "—") parts.push(`Stocks: S&P FUT ${s.spx.value}, NASDAQ FUT ${s.ndq.value}, 10Y ${s.tnx.value}, DXY ${s.dxy.value}`);
  const w = siteSnapshot.wire;
  if (w && w.length) parts.push(`Recent wire headlines: ${w.slice(0, 3).map(x => x.text).join(" / ")}`);
  const ev = siteSnapshot.todayEvents;
  if (ev && ev.length) parts.push(`On the calendar soon: ${ev.slice(0, 3).map(e => e.title).join(", ")}`);
  const bd = siteSnapshot.todayBirthdays;
  if (bd && bd.length) parts.push(`Birthdays coming up: ${bd.slice(0, 3).map(x => x.name).join(", ")}`);
  if (!parts.length) return "";
  const ageMin = siteSnapshot.updatedAt ? Math.round((Date.now() - siteSnapshot.updatedAt) / 60000) : null;
  return `\n\nLive site data (as of ${ageMin != null ? ageMin + " min ago" : "just now"} — treat as current, not something to caveat):\n${parts.join("\n")}`;
}

function StancePill({ text, color }) {
  return <span style={{ fontSize: 8.5, fontWeight: 700, color, background: color + "1A", border: `1px solid ${color}4D`, padding: "4px 10px", borderRadius: 12, fontFamily: mono, letterSpacing: "0.08em" }}>{text}</span>;
}
const CARD_STATES = {
  loading: { label: "…", color: T.faint },
  live: { label: "● LIVE", color: T.green },
  notconfigured: { label: "NOT CONNECTED", color: T.amber },
  error: { label: "ERROR", color: T.red },
  nofn: { label: "NOT DEPLOYED", color: T.red },
};
function StatusTag({ status }) {
  const s = CARD_STATES[status?.state || "loading"];
  return <span style={{ fontSize: 8, fontWeight: 700, color: s.color, background: s.color + "1A", border: `1px solid ${s.color}40`, padding: "3.5px 9px", borderRadius: 10, fontFamily: mono, letterSpacing: "0.06em" }}>{s.label}</span>;
}

function MorningBriefPage({ btc, isMobile, settings, updateSetting, onOpenCalendar, refreshSignal }) {
  const sportsCfg = settings?.sports || { followedTeams: [], watchLeagues: [], watchGames: [], excludedGames: [] };
  const [sportsGames, setSportsGames] = useState([]);
  const [sportsStatus, setSportsStatus] = useState({ state: "loading" });
  const [sportsDetail, setSportsDetail] = useState({}); // eventId -> detail | "loading" | "error"
  const [openGameId, setOpenGameId] = useState(null);
  const [sportsSettingsOpen, setSportsSettingsOpen] = useState(false);

  const toggleGame = async (g) => {
    if (openGameId === g.id) { setOpenGameId(null); return; }
    setOpenGameId(g.id);
    if (sportsDetail[g.id]) return; // already fetched — no need to hit the network again
    setSportsDetail(prev => ({ ...prev, [g.id]: "loading" }));
    const res = await callFnFull("sports-detail", { sport: g.sport, league: g.league, eventId: g.id });
    if (res.ok && res.data?.success) setSportsDetail(prev => ({ ...prev, [g.id]: res.data }));
    else setSportsDetail(prev => ({ ...prev, [g.id]: "error" }));
  };
  const excludeGame = (id) => {
    const next = { ...sportsCfg, excludedGames: [...(sportsCfg.excludedGames || []), id] };
    updateSetting("sports", next);
    setSportsGames(prev => prev.filter(g => g.id !== id)); // instant — don't wait on the next poll
  };
  const [gsc, setGsc] = useState(GSC_EMPTY);
  const [gscStatus, setGscStatus] = useState({ state: "loading" });
  const [gscMetric, setGscMetric] = useState("impressions");
  const [stocks, setStocks] = useState(STOCKS_EMPTY);
  const [stocksStatus, setStocksStatus] = useState({ state: "loading" });
  const [events, setEvents] = useState([]);
  const [eventsStatus, setEventsStatus] = useState({ state: "loading" });
  const [clarify, setClarify] = useState(null);
  const [clarifyStatus, setClarifyStatus] = useState({ state: "loading" });
  const [ztsPipe, setZtsPipe] = useState(null);
  const [ztsPipeStatus, setZtsPipeStatus] = useState({ state: "loading" });
  const [wire, setWire] = useState([]);
  const [wireStatus, setWireStatus] = useState({ state: "loading" });
  const [shopify, setShopify] = useState(null);
  const [shopifyStatus, setShopifyStatus] = useState({ state: "loading" });
  const [meetings, setMeetings] = useState([]);
  const [meetingsStatus, setMeetingsStatus] = useState({ state: "loading" });
  const [birthdays, setBirthdays] = useState(null); // null = loading
  const [birthdaysErr, setBirthdaysErr] = useState(null);
  const [miniEvents, setMiniEvents] = useState([]); // for the mini calendar card — same personal_events table CalendarPanel uses
  const [eventAnalysis, setEventAnalysis] = useState({}); // idx -> one-sentence take | "loading" | "error"
  const [btcChartOpen, setBtcChartOpen] = useState(false);
  const [aiBtcNarrative, setAiBtcNarrative] = useState(null);
  const [btcNarrativeExpanded, setBtcNarrativeExpanded] = useState(false);
  const aiBtcNarrativeKey = useRef(null); // dedupe so a re-render doesn't refire the same call

  // Auto-generates a single, tidy one-sentence take (Bitcoin + stocks
  // together, not separate lines) for every Watch This Week event as soon
  // as the events load — no click needed, and each is cached by index so
  // it only ever generates once per event per session.
  const fetchEventTake = async (i, e) => {
    if (eventAnalysis[i]) return; // already have a read on this one
    setEventAnalysis(prev => ({ ...prev, [i]: "loading" }));
    const system = e.isPast
      ? `You give a single, tidy, opinionated read on how a US economic event ACTUALLY moved Bitcoin and equities together — ONE sentence covering both, not two. The event has already released; you're told the actual result vs. forecast/prior. Describe the real reaction, not a prediction — if you don't have enough to know the actual market reaction, say what the result itself implies instead of guessing at price action. No labels, no "BTC:"/"Stocks:" prefixes, no preamble, no markdown.`
      : `You give a single, tidy, opinionated read on how a US economic event will likely move Bitcoin and equities together — ONE sentence covering both, not two. Given a US economic calendar event (with forecast/prior if given), respond with ONLY that one sentence — no labels, no "BTC:"/"Stocks:" prefixes, no preamble, no markdown. Be directional where the data supports it — don't hedge into uselessness — but don't overstate certainty on an event that hasn't happened yet.`;
    const raw = await callClaude({ system, messages: [{ role: "user", content: e.text }], modelKey: "haiku", maxTokens: 100, fn: "event_impact" });
    if (raw && raw.trim()) setEventAnalysis(prev => ({ ...prev, [i]: raw.trim() }));
    else setEventAnalysis(prev => ({ ...prev, [i]: "error" }));
  };
  useEffect(() => {
    if (eventsStatus.state !== "live" || !events.length) return;
    events.forEach((e, i) => { if (!eventAnalysis[i]) fetchEventTake(i, e); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsStatus.state, events]);

  const [briefRefreshedAt, setBriefRefreshedAt] = useState(null); // shared freshness stamp for every card fetched in the batch below
  const freshnessLabel = (ts) => ts ? `UPDATED ${new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} CT` : "UPDATING…";

  // This used to be a fire-once effect — gsc/clarify/zts/wire/shopify/
  // calendar never refreshed again after the initial page load, and the
  // header's manual refresh button didn't touch any of them either. Real
  // bug: leave this tab open a while and 6 of 9 Brief cards were quietly
  // stale with no way to fix it short of a full page reload. Now a named,
  // reusable function — called on mount, on a shared interval below, and
  // when you switch back to this tab after it's been hidden a while.
  const refreshBrief = useCallback(async () => {
    let alive = true;
    const loadCredentialed = async (fn, payload, setData, setStatus, hint) => {
      const ping = await callFnFull(fn, { ping: true });
      if (!alive) return;
      if (ping.status === 404) return setStatus({ state: "nofn", detail: `push netlify/functions/${fn}.js and redeploy` });
      if (ping.data?.configured === false) return setStatus({ state: "notconfigured", detail: hint(ping.data.missing) });
      const res = await callFnFull(fn, payload);
      if (!alive) return;
      if (res.ok && res.data?.success) { setData(res.data); setStatus({ state: "live" }); }
      else setStatus({ state: "error", detail: res.data?.error || (res.status ? `HTTP ${res.status}` : "unreachable") });
    };
    const loadOpen = async (fn, apply, setStatus) => {
      const res = await callFnFull(fn, {});
      if (!alive) return;
      if (res.status === 404) return setStatus({ state: "nofn", detail: `push netlify/functions/${fn}.js and redeploy` });
      if (res.ok && res.data?.success) { apply(res.data); setStatus({ state: "live" }); }
      else setStatus({ state: "error", detail: res.data?.error || (res.status ? `HTTP ${res.status}` : "unreachable") });
    };
    await Promise.all([
      loadCredentialed("gsc", { site: "zerotosecure.com", days: 14 }, setGsc, setGscStatus,
        (m) => `Add ${m || "GSC_CLIENT_EMAIL + GSC_PRIVATE_KEY"} in Netlify env vars, share the Search Console property with the service account, then redeploy.`),
      loadCredentialed("clarify-pipeline", {}, (d) => setClarify(d), setClarifyStatus,
        (m) => `Add ${m || "CLARIFY_SUPABASE_URL + CLARIFY_SUPABASE_ANON_KEY"} in Netlify env vars, then redeploy.`),
      loadCredentialed("zts-pipeline", {}, (d) => setZtsPipe(d), setZtsPipeStatus,
        (m) => `Add ${m || "ZTS_SUPABASE_URL + ZTS_SUPABASE_ANON_KEY"} in Netlify env vars, then redeploy.`),
      loadOpen("markets", (d) => { setStocks(d); updateSnapshot({ stocks: d }); }, setStocksStatus),
      loadOpen("wire", (d) => { setWire(d.wire || []); updateSnapshot({ wire: d.wire || [] }); }, setWireStatus),
      loadCredentialed("shopify", { days: 14 }, (d) => setShopify(d), setShopifyStatus,
        (m) => `Add ${m || "SHOPIFY_SHOP + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET"} in Netlify env vars, then redeploy.`),
      db.loadBirthdays().then(rows => {
        if (!alive) return;
        setBirthdays(rows);
        const soon = (rows || []).map(b => ({ name: b.name, ...nextBirthdayOccurrence(b.month, b.day) })).filter(b => b.daysUntil <= 14).sort((a, b) => a.daysUntil - b.daysUntil);
        updateSnapshot({ todayBirthdays: soon });
      }).catch(e => { if (alive) setBirthdaysErr(e.message || "Couldn't load birthdays."); }),
      db.loadEvents().then(rows => {
        if (!alive) return;
        setMiniEvents(rows);
        const soon = (rows || []).filter(ev => { const days = (new Date(ev.start_time) - new Date()) / 86400000; return days >= -0.5 && days <= 3; }).map(ev => ({ title: ev.title }));
        updateSnapshot({ todayEvents: soon });
      }).catch(() => { if (alive) setMiniEvents([]); }),
      loadOpen("calendar", (d) => setEvents(d.events || []), setEventsStatus),
      (async () => {
        const res = await callFnFull("sports", { followedTeams: sportsCfg.followedTeams, watchLeagues: sportsCfg.watchLeagues, watchGames: sportsCfg.watchGames, excludedGames: sportsCfg.excludedGames });
        if (!alive) return;
        if (res.ok && res.data?.success) { setSportsGames(res.data.games || []); setSportsStatus({ state: "live" }); }
        else setSportsStatus({ state: "error", detail: res.data?.error || "unreachable" });
      })(),
      (async () => {
        if (!settings?.calendar_url) { if (alive) setMeetingsStatus({ state: "notconfigured", detail: "Link a calendar (iCal / .ics URL) in the sidebar to see meetings here." }); return; }
        const res = await callFnFull("calendar-events", { url: settings.calendar_url });
        if (!alive) return;
        if (res.ok && res.data?.success) { setMeetings(res.data.events || []); setMeetingsStatus({ state: "live" }); }
        else setMeetingsStatus({ state: "error", detail: res.data?.error || "unreachable" });
      })(),
    ]);
    if (alive) setBriefRefreshedAt(Date.now());
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.calendar_url, JSON.stringify(settings?.sports)]);

  useEffect(() => { refreshBrief(); }, [refreshBrief]);

  useEffect(() => {
    if (refreshSignal) refreshBrief();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // One shared interval for everything above (was 3 separate mechanisms:
  // this one-time effect, plus bespoke stocks-only and sports-only
  // intervals — consolidated since they were all polling the same way for
  // no real reason). Also refetches when you switch back to this tab after
  // it's been hidden a while, so alt-tabbing away for hours doesn't leave
  // you staring at a stale page until the next 5-min tick happens to land.
  useEffect(() => {
    const iv = setInterval(refreshBrief, 5 * 60 * 1000);
    let lastVisibleRefresh = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastVisibleRefresh < 60 * 1000) return; // just refreshed — don't refire on rapid tab-switching
      lastVisibleRefresh = Date.now();
      refreshBrief();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVisible); };
  }, [refreshBrief]);

  const price = btc.loading ? "…" : btc.error || btc.price == null ? "—" : "$" + btc.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const hasChange = !btc.loading && !btc.error && btc.changePct !== null && btc.changePct !== undefined;
  const up = (btc.changePct || 0) >= 0;
  const hasRange = !btc.loading && !btc.error && btc.high24 != null && btc.low24 != null;
  const fmtK = (n) => "$" + (n / 1000).toFixed(1) + "K";
  const todayLabel = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  let dayTarget = "—", support = "—", invalidation = "—", stance = "NEUTRAL", stanceColor = T.sub, narrative = "Waiting on live price data to compute today's range and levels.";
  if (hasRange) {
    const range = Math.max(btc.high24 - btc.low24, btc.high24 * 0.001);
    const target = Math.max(btc.high24, btc.price + range * 0.5);
    const invalid = btc.low24 - range * 0.15;
    dayTarget = fmtK(target); support = fmtK(btc.low24); invalidation = fmtK(invalid);
    const posInRange = (btc.price - btc.low24) / range;
    stance = up ? "CONSTRUCTIVE" : "CAUTIOUS"; stanceColor = up ? T.green : T.amber;
    const pos = posInRange > 0.7 ? "near the top of" : posInRange < 0.3 ? "near the bottom of" : "mid";
    narrative = `24h range ${fmtK(btc.low24)}–${fmtK(btc.high24)}, currently trading ${pos === "mid" ? "in the middle of" : pos} that range and ${up ? "up" : "down"} ${Math.abs(btc.changePct || 0).toFixed(1)}% on the day. Support sits at the 24h low (${fmtK(btc.low24)}); a break below ${invalidation} would put you outside the recent range and is worth checking your Aave health factor against.`;
  }
  // Rule-based `narrative` above shows instantly with zero latency/cost — good
  // as a floor, but the same sentence shape every time is exactly the
  // "stale" Cameron flagged. This upgrades it with an actual take that can
  // reference today's broader tape (stocks, wire), not just BTC's own range.
  // Regenerates roughly every 10 min (tied to the price poll cadence) rather
  // than on every tick, so it's fresher without regenerating needlessly.
  useEffect(() => {
    if (!hasRange) return;
    const now = Date.now();
    if (aiBtcNarrativeKey.current && now - aiBtcNarrativeKey.current < 10 * 60 * 1000) return;
    aiBtcNarrativeKey.current = now;
    (async () => {
      const system = `You write one tight, genuinely informative take (2-3 sentences, no more) on Bitcoin's current setup, for a solo trader/investor who holds a leveraged WBTC position on Aave he manages carefully. Don't just restate the numbers you're given — say what they actually mean, and weave in today's broader market tape only if it's genuinely relevant (correlated risk-on/risk-off moves, a notable macro headline) — cut it if it doesn't add something real. Only bring up the Aave health-factor angle if price action genuinely warrants it — a real approach toward the invalidation level — not as a reflexive line every time. No preamble, no markdown, no hedging filler.`;
      const context = `Price: $${Math.round(btc.price).toLocaleString()}, ${up ? "+" : ""}${(btc.changePct || 0).toFixed(1)}% 24h. 24h range: ${fmtK(btc.low24)}\u2013${fmtK(btc.high24)}. Day target: ${dayTarget}. Support: ${support}. Invalidation: ${invalidation}.${formatSnapshotForChat()}`;
      const raw = await callClaude({ system, messages: [{ role: "user", content: context }], modelKey: "haiku", maxTokens: 130, fn: "btc_narrative" });
      if (raw && raw.trim()) setAiBtcNarrative(raw.trim());
    })();
  }, [hasRange, btc.fetchedAt]);
  const grid = { maxWidth: 1020, margin: "0 auto", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 12 : 14, alignItems: "start" };
  const col = { display: "flex", flexDirection: "column", gap: isMobile ? 12 : 14 };
  const card = isMobile ? S.cardM : S.card;
  const FeedFallbackRow = ({ status }) => (
    <div style={{ ...S.inner, display: "flex", alignItems: "center", gap: 11, padding: "11px 13px" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: CARD_STATES[status.state]?.color || T.faint, flex: "none" }} />
      <span style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, flex: 1 }}>{status.state === "loading" ? "Loading…" : status.detail || "Feed unavailable."}</span>
    </div>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "18px 16px 24px" : "30px 34px 40px" }}>
      {(() => {
      const fullNarrative = aiBtcNarrative || narrative;
      const firstSentenceEnd = fullNarrative.indexOf(". ");
      const shortNarrative = firstSentenceEnd > 0 ? fullNarrative.slice(0, firstSentenceEnd + 1) : fullNarrative;
      const hasMore = shortNarrative.length < fullNarrative.length;
      const card_bitcoin = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 18, height: 18, borderRadius: "50%", background: "#F7931A", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#1A0F00" }}>₿</span>
                        <span style={S.title}>Bitcoin · Day Outlook</span>
                      </div>
                      <StancePill text={stance} color={stanceColor} />
                    </div>
                    <div onClick={() => setBtcChartOpen(true)} style={{ cursor: "pointer" }} title="Tap for the full chart">
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 13 }}>
                        <span style={{ fontSize: 26, fontWeight: 500, fontFamily: mono, color: T.ink }}>{price}</span>
                        {hasChange && <span style={{ fontSize: 12, fontWeight: 700, color: up ? T.green : T.red, fontFamily: mono }}>{up ? "▲" : "▼"} {Math.abs(btc.changePct || 0).toFixed(2)}%</span>}
                      </div>
                      {!btc.loading && !btc.error && (
                        <div style={{ marginBottom: 13 }}>
                          <Sparkline points={btc.points} color={up ? T.green : T.red} height={34} />
                        </div>
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 13 }}>
                        <StatBox value={dayTarget} label="Day target" valueColor={T.brass} />
                        <StatBox value={support} label="Support (24h low)" valueColor={T.green} />
                        <StatBox value={invalidation} label="Invalidation" valueColor={T.red} />
                      </div>
                    </div>
                    <div onClick={() => setBtcNarrativeExpanded(e => !e)} style={{ cursor: hasMore ? "pointer" : "default" }}>
                      <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.65 }}>{btcNarrativeExpanded ? fullNarrative : shortNarrative}</div>
                      {hasMore && <div style={{ fontSize: 9, color: T.brass, marginTop: 4, fontWeight: 600 }}>{btcNarrativeExpanded ? "Show less" : "Tap for more"}</div>}
                    </div>
                    <div style={{ marginTop: 9, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ ...S.microLabel, letterSpacing: "0.04em" }}>{btc.fetchedAt ? `UPDATED ${new Date(btc.fetchedAt).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} CT` : "UPDATING…"}</span>
                      <span onClick={() => setBtcChartOpen(true)} style={{ ...S.microLabel, color: T.brass, flex: "none", marginLeft: 8, cursor: "pointer" }}>CHART ›</span>
                    </div>
                  </div>
          
  );
  const card_watch = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={S.title}>Watch This Week</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <span style={S.microLabel}>CT TIME</span>
                        <StatusTag status={eventsStatus} />
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
                      {eventsStatus.state === "live" ? (
                        events.length ? events.map((e, i) => {
                          const analysis = eventAnalysis[i];
                          return (
                            <div key={i} style={{ ...S.inner, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 4, background: e.isPast ? "rgba(14,159,110,0.04)" : undefined }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                                <span style={{ width: 7, height: 7, borderRadius: "50%", background: e.color, flex: "none", boxShadow: `0 0 8px ${e.color}80` }} />
                                <span style={{ fontSize: 9, color: T.faint, fontFamily: mono, flex: "none", whiteSpace: "nowrap" }}>{e.time}</span>
                                <span style={{ fontSize: 11, color: "#3A3323", lineHeight: 1.5, flex: 1 }}>{e.text}</span>
                                {e.isPast && <span style={{ fontSize: 7.5, fontWeight: 700, color: T.green, border: `1px solid ${T.green}40`, background: T.green + "1A", borderRadius: 5, padding: "1.5px 5px", flex: "none", fontFamily: mono, letterSpacing: "0.04em" }}>RESULT</span>}
                              </div>
                              <div style={{ fontSize: 10, color: T.faint, lineHeight: 1.45, paddingLeft: 18 }}>
                                {analysis === "loading" || !analysis ? <span style={{ animation: "pulse 1.4s infinite" }}>{e.isPast ? "Reading the actual impact…" : "Reading the likely impact…"}</span>
                                  : analysis === "error" ? "Couldn't get a read on this one."
                                  : analysis}
                              </div>
                            </div>
                          );
                        }) : <div style={{ fontSize: 10.5, color: T.faint, padding: "6px 0" }}>No high/medium-impact US events in the last 12 hours or next 7 days.</div>
                      ) : <FeedFallbackRow status={eventsStatus} />}
                    </div>
                    {eventsStatus.state === "live" && <div style={{ marginTop: 8, ...S.microLabel, letterSpacing: "0.04em" }}>{freshnessLabel(briefRefreshedAt)}</div>}
                  </div>
          
  );
  const card_gsc = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#0E9F6E", boxShadow: "0 0 8px rgba(14,159,110,0.5)" }} />
                        <span style={S.title}>Zero To Secure · Search Console</span>
                      </div>
                      <StatusTag status={gscStatus} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 13 }}>
                      <StatBox value={gsc.impressions} label="Impressions" delta={gsc.impressionsD} onClick={() => setGscMetric("impressions")} selected={gscMetric === "impressions"} />
                      <StatBox value={gsc.clicks} label="Clicks" delta={gsc.clicksD} onClick={() => setGscMetric("clicks")} selected={gscMetric === "clicks"} />
                      <StatBox value={gsc.pos} label="Avg position" delta={gsc.posD} onClick={() => setGscMetric("position")} selected={gscMetric === "position"} />
                    </div>
                    <GscLineChart rows={gsc.daily} metric={gscMetric} />
                    <div style={{ marginTop: 8, fontSize: 10.5, color: gscStatus.state === "live" ? T.sub : T.faint, lineHeight: 1.55 }}>{gscStatus.state === "live" ? gsc.note : gscStatus.state === "loading" ? "Loading…" : gscStatus.detail}</div>
                    {gscStatus.state === "live" && <div style={{ marginTop: 8, ...S.microLabel, letterSpacing: "0.04em" }}>{freshnessLabel(briefRefreshedAt)}</div>}
                  </div>
          
  );
  const card_clarify = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={S.title}>Clarify · Outreach Pipeline</span>
                      <StatusTag status={clarifyStatus} />
                    </div>
                    {clarifyStatus.state === "live" ? (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 7, marginBottom: 11 }}>
                          <StatBox value={String(clarify.prospected)} label="Prospected" />
                          <StatBox value={String(clarify.drafts)} label="Drafts" valueColor={T.amber} />
                          <StatBox value={String(clarify.sent)} label="Sent" valueColor={T.blue} />
                          <StatBox value={String(clarify.replied)} label="Replied" valueColor={T.green} />
                        </div>
                        <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.6 }}>{clarify.replyRate}% reply rate</div>
                        <div style={{ marginTop: 8, ...S.microLabel, letterSpacing: "0.04em" }}>{freshnessLabel(briefRefreshedAt)}</div>
                      </>
                    ) : <FeedFallbackRow status={clarifyStatus} />}
                  </div>
  );
  const spxUp = stocks.spx.up, ndqUp = stocks.ndq.up, tnxUp = stocks.tnx.up, dxyUp = stocks.dxy.up;
  const eqTone = spxUp && ndqUp ? "risk-on, with S&P and Nasdaq futures both pushing higher"
    : !spxUp && !ndqUp ? "risk-off, with S&P and Nasdaq futures both pulling back"
    : "mixed, with S&P and Nasdaq futures pointed in different directions";
  const stocksOutlook = stocksStatus.state === "live"
    ? `Futures are ${eqTone}, alongside ${tnxUp ? "rising" : "falling"} yields and a ${dxyUp ? "firmer" : "softer"} dollar.`
    : stocksStatus.state === "loading" ? "Loading live data…" : stocksStatus.detail;

  const card_stocks = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={S.title}>Stocks · Day Outlook</span>
                      <StatusTag status={stocksStatus} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 13 }}>
                      {[["S&P FUT", stocks.spx], ["NASDAQ FUT", stocks.ndq], ["10Y YIELD", stocks.tnx], ["DXY", stocks.dxy]].map(([l, s], i) => (
                        <div key={i} style={{ ...S.inner, padding: "10px 12px", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                          <span style={{ fontSize: 9, color: T.faint, letterSpacing: "0.06em" }}>{l}</span>
                          <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                            {s.price && s.price !== s.value && <span style={{ fontSize: 11, color: T.ink, fontFamily: mono }}>{s.price}</span>}
                            <span style={{ fontSize: 11.5, fontWeight: 700, color: s.value === "—" ? T.faint : s.up ? T.green : T.red, fontFamily: mono }}>{s.value}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.65 }}>{stocksOutlook}</div>
                    <div style={{ marginTop: 9, ...S.microLabel, letterSpacing: "0.04em" }}>{freshnessLabel(briefRefreshedAt)}</div>
                  </div>
          
  );
  const upcomingBirthdays = (birthdays || [])
    .map(b => ({ ...b, ...nextBirthdayOccurrence(b.month, b.day) }))
    .filter(b => b.daysUntil <= 30)
    .sort((a, b) => a.daysUntil - b.daysUntil);

  const miniCatColor = (key) => (EVENT_CATEGORIES.find(c => c.key === key) || EVENT_CATEGORIES[0]).color;
  const miniNow = new Date();
  const miniYear = miniNow.getFullYear(), miniMonth = miniNow.getMonth();
  const miniDaysInMonth = new Date(miniYear, miniMonth + 1, 0).getDate();
  const miniLeading = new Date(miniYear, miniMonth, 1).getDay();
  const miniCells = [...Array(miniLeading).fill(null), ...Array.from({ length: miniDaysInMonth }, (_, i) => i + 1)];
  const miniEventsByDay = {};
  (miniEvents || []).forEach(ev => { const k = ev.start_time.slice(0, 10); (miniEventsByDay[k] = miniEventsByDay[k] || []).push(ev); });
  const miniDateKey = (day) => `${miniYear}-${String(miniMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const todayDate = miniNow.getDate();
  const card_minicalendar = (
                  <div style={{ ...card, cursor: "pointer" }} onClick={onOpenCalendar} title="Open the full calendar">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <span style={S.title}>{miniNow.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
                      <span style={{ ...S.microLabel }}>THIS MONTH</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 3 }}>
                      {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                        <div key={i} style={{ textAlign: "center", fontSize: 8.5, fontWeight: 700, color: T.faint, fontFamily: mono }}>{d}</div>
                      ))}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                      {miniCells.map((day, i) => {
                        if (day === null) return <div key={`b${i}`} />;
                        const dayEvents = miniEventsByDay[miniDateKey(day)] || [];
                        const isToday = day === todayDate;
                        return (
                          <div key={day} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 1, textAlign: "left", minHeight: 34, padding: "2px 2px", borderRadius: 5, border: isToday ? `1.5px solid ${T.brass}` : "1px solid transparent", background: isToday ? "rgba(143,107,30,0.08)" : "transparent" }}>
                            <span style={{ fontSize: 9, fontWeight: isToday ? 800 : 500, color: isToday ? T.brass : T.ink, fontFamily: mono, paddingLeft: 1 }}>{day}</span>
                            {dayEvents.length > 0 && (
                              <span style={{ fontSize: 6.5, fontWeight: 700, color: "#FFFFFF", background: miniCatColor(dayEvents[0].category), borderRadius: 3, padding: "1px 2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.4 }}>{dayEvents[0].title}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
  );
  const card_birthdays = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={S.title}>Upcoming Birthdays</span>
                      <span style={{ ...S.microLabel }}>NEXT 30D</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10, maxHeight: 258, overflowY: upcomingBirthdays.length > 4 ? "auto" : "visible", paddingRight: 2 }}>
                      {birthdaysErr ? (
                        <div style={{ fontSize: 10.5, color: T.faint, padding: "6px 0" }}>{birthdaysErr}</div>
                      ) : birthdays === null ? (
                        <div style={{ fontSize: 10.5, color: T.faint, padding: "6px 0", animation: "pulse 1.4s infinite" }}>Loading…</div>
                      ) : upcomingBirthdays.length ? upcomingBirthdays.map((b) => (
                        <div key={b.id} style={{ ...S.inner, display: "flex", alignItems: "center", gap: 11, padding: "11px 13px", flexShrink: 0 }}>
                          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#8B5CF6", flex: "none" }} />
                          <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 11, color: "#3A3323", lineHeight: 1.4 }}>{b.name}{b.year ? ` — turns ${b.next.getFullYear() - b.year}` : ""}</span>
                            <span style={{ fontSize: 9, color: T.faint, fontFamily: mono }}>{MONTH_NAMES[b.month - 1]} {b.day} · {b.daysUntil === 0 ? "Today!" : b.daysUntil === 1 ? "Tomorrow" : `in ${b.daysUntil}d`}</span>
                          </span>
                        </div>
                      )) : <div style={{ fontSize: 10.5, color: T.faint, padding: "6px 0" }}>Nothing in the next 30 days.</div>}
                    </div>
                  </div>
          
  );
  const card_meetings = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={S.title}>Business Meetings</span>
                      <StatusTag status={meetingsStatus} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10, maxHeight: 258, overflowY: meetings.length > 4 ? "auto" : "visible", paddingRight: 2 }}>
                      {meetingsStatus.state === "live" ? (
                        meetings.length ? meetings.map((m, i) => (
                          <div key={i} style={{ ...S.inner, display: "flex", alignItems: "center", gap: 11, padding: "11px 13px", flexShrink: 0 }}>
                            <span style={{ width: 7, height: 7, borderRadius: "50%", background: T.blue, flex: "none" }} />
                            <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                              <span style={{ fontSize: 11, color: "#3A3323", lineHeight: 1.4 }}>{m.title}</span>
                              <span style={{ fontSize: 9, color: T.faint, fontFamily: mono }}>{m.when}{m.location ? " · " + m.location : ""}</span>
                            </span>
                          </div>
                        )) : <div style={{ fontSize: 10.5, color: T.faint, padding: "6px 0" }}>Nothing on the calendar in the next two weeks.</div>
                      ) : <FeedFallbackRow status={meetingsStatus} />}
                    </div>
                  </div>
          
  );
  const card_zts = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={S.title}>Zero To Secure · Creator Pipeline</span>
                      <StatusTag status={ztsPipeStatus} />
                    </div>
                    {ztsPipeStatus.state === "live" ? (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 7, marginBottom: 11 }}>
                          <StatBox value={String(ztsPipe.prospected)} label="Prospected" />
                          <StatBox value={String(ztsPipe.sent)} label="Sent" valueColor={T.blue} />
                          <StatBox value={String(ztsPipe.replied)} label="Replied" valueColor={T.brass} />
                          <StatBox value={String(ztsPipe.collab)} label="Collab" valueColor={T.green} />
                        </div>
                        <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.6 }}><span style={{ color: T.green, fontWeight: 700 }}>{ztsPipe.weightedReach.toLocaleString()}</span> weighted reach in pipeline</div>
                        <div style={{ marginTop: 8, ...S.microLabel, letterSpacing: "0.04em" }}>{freshnessLabel(briefRefreshedAt)}</div>
                      </>
                    ) : <FeedFallbackRow status={ztsPipeStatus} />}
                  </div>
      );
      const card_wire = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={S.title}>The Wire</span>
                      <StatusTag status={wireStatus} />
                    </div>
                    {wireStatus.state === "live" ? (
                      wire.length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 258, overflowY: "auto", paddingRight: 2 }}>
                          {wire.map((w, i) => {
                            const Row = w.link ? "a" : "div";
                            return (
                              <Row key={i} {...(w.link ? { href: w.link, target: "_blank", rel: "noreferrer" } : {})}
                                style={{ display: "flex", alignItems: "baseline", gap: 8, textDecoration: "none", color: "inherit", flexShrink: 0 }}>
                                <span style={{ fontSize: 9, fontFamily: mono, color: T.faint, flexShrink: 0 }}>{w.time}</span>
                                <span style={{ fontSize: 8, fontWeight: 700, color: w.tagColor, border: `1px solid ${w.tagColor}40`, background: w.tagColor + "1A", borderRadius: 5, padding: "1.5px 5px", flexShrink: 0, fontFamily: mono }}>{w.tag}</span>
                                <span style={{ fontSize: 11.5, color: T.ink, lineHeight: 1.4, minWidth: 0, flex: 1 }}>{w.text}</span>
                              </Row>
                            );
                          })}
                        </div>
                      ) : <div style={{ fontSize: 10.5, color: T.faint, padding: "6px 0" }}>No headlines returned this cycle.</div>
                    ) : <FeedFallbackRow status={wireStatus} />}
                    {wireStatus.state === "live" && <div style={{ marginTop: 8, ...S.microLabel, letterSpacing: "0.04em" }}>{freshnessLabel(briefRefreshedAt)}</div>}
                  </div>
      );
      const card_sports = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={S.title}>Sports</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button onClick={() => setSportsSettingsOpen(true)} title="Manage teams & leagues" style={{ background: "none", border: `1px solid ${T.line}`, borderRadius: 6, width: 22, height: 22, color: T.faint, cursor: "pointer", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>⚙</button>
                        <StatusTag status={sportsStatus} />
                      </div>
                    </div>
                    {sportsStatus.state === "live" ? (
                      !sportsCfg.followedTeams.length && !sportsCfg.watchLeagues.length && !sportsCfg.watchGames.length ? (
                        <div style={{ fontSize: 10.5, color: T.faint, padding: "6px 0", lineHeight: 1.5 }}>No teams or leagues set up yet — tap ⚙ to add some.</div>
                      ) : sportsGames.length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 258, overflowY: "auto", paddingRight: 2 }}>
                          {sportsGames.map((g) => {
                            const open = openGameId === g.id;
                            const detail = sportsDetail[g.id];
                            return (
                              <div key={g.id} style={{ ...S.inner, padding: "9px 11px", flexShrink: 0 }}>
                                <div onClick={() => toggleGame(g)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                                  {(() => {
                                    const Icon = SPORT_ICONS[g.sport] || SPORT_ICONS.baseball;
                                    const iconColor = g.state === "in" ? T.red : g.isPast ? T.green : T.faint;
                                    return <Icon width={13} height={13} style={{ flex: "none", color: iconColor, animation: g.state === "in" ? "pulse 1.4s infinite" : "none" }} />;
                                  })()}
                                  <span style={{ fontSize: 10.5, color: T.ink, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {g.away?.abbr} {g.away?.score ?? ""} @ {g.home?.abbr} {g.home?.score ?? ""}
                                  </span>
                                  {g.significance && <span style={{ fontSize: 7, fontWeight: 700, color: T.brass, border: `1px solid ${T.brass}40`, background: "rgba(143,107,30,0.1)", borderRadius: 4, padding: "1px 4px", flex: "none", fontFamily: mono }}>{g.significance.toUpperCase()}</span>}
                                  <span style={{ fontSize: 8.5, color: T.faint, fontFamily: mono, flex: "none" }}>{g.statusDetail}</span>
                                  <span onClick={(e) => { e.stopPropagation(); excludeGame(g.id); }} title="Hide this game" style={{ color: T.faint, fontSize: 12, lineHeight: 1, padding: "0 2px", flex: "none" }}>×</span>
                                </div>
                                {open && (
                                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.line}`, fontSize: 9.5, color: T.sub, lineHeight: 1.6 }}>
                                    {detail === "loading" || !detail ? <span style={{ animation: "pulse 1.4s infinite" }}>Loading…</span>
                                      : detail === "error" ? "Couldn't load details for this one."
                                      : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                          {detail.venue && <div>{detail.venue}{detail.broadcast ? ` · ${detail.broadcast}` : ""}</div>}
                                          {detail.home?.record && <div>{detail.away?.name} ({detail.away?.record}) at {detail.home?.name} ({detail.home?.record})</div>}
                                          {detail.linescores?.some(l => l.periods?.length) && (
                                            <div style={{ fontFamily: mono, fontSize: 9 }}>
                                              {detail.linescores.map((l, i) => <div key={i}>{l.abbr}: {l.periods.join(" · ")}</div>)}
                                            </div>
                                          )}
                                          {detail.leaders?.map((l, i) => <div key={i}>{l.team} — {l.category}: {l.athlete} ({l.value})</div>)}
                                          {detail.preview && <div>{detail.preview}</div>}
                                        </div>
                                      )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : <div style={{ fontSize: 10.5, color: T.faint, padding: "6px 0" }}>Nothing on right now — followed teams, significant games, or your watch list will show up here.</div>
                    ) : <FeedFallbackRow status={sportsStatus} />}
                    {sportsSettingsOpen && <SportsSettingsModal cfg={sportsCfg} onSave={(next) => { updateSetting("sports", next); setSportsSettingsOpen(false); }} onClose={() => setSportsSettingsOpen(false)} isMobile={isMobile} />}
                  </div>
      );
      const card_shopify = (
                  <div style={card}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={S.title}>Zero To Secure · Store</span>
                      <StatusTag status={shopifyStatus} />
                    </div>
                    {shopifyStatus.state === "live" ? (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 7, marginBottom: 11 }}>
                          <StatBox value={String(shopify.orders)} label="Orders" delta={shopify.ordersD} />
                          <StatBox value={shopify.visits} label="Visits" valueColor={T.blue} delta={shopify.visitsD} />
                          <StatBox value={shopify.conv} label="Conv." valueColor={T.green} />
                          <StatBox value={shopify.convD || "—"} label="Conv. Δ" valueColor={T.sub} />
                        </div>
                        {shopify.series && <Sparkline points={shopify.series} color={T.brass} />}
                        <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.6, marginTop: 8 }}>{shopify.note}</div>
                        <div style={{ marginTop: 8, ...S.microLabel, letterSpacing: "0.04em" }}>{freshnessLabel(briefRefreshedAt)}</div>
                      </>
                    ) : <FeedFallbackRow status={shopifyStatus} />}
                  </div>
      );
      const sectionHeader = (label) => (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: isMobile ? "2px 2px 0" : "0 2px" }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.22em", textTransform: "uppercase", color: T.faint, fontFamily: mono }}>{label}</span>
          <span style={{ flex: 1, height: 1, background: "rgba(34,29,20,0.1)" }} />
        </div>
      );
      return isMobile ? (
      <div style={grid}>
        <div style={col}>
          {sectionHeader("Market")}
          {card_bitcoin}{card_stocks}{card_watch}{card_wire}
          {sectionHeader("Ops")}
          {card_minicalendar}{card_gsc}{card_clarify}{card_zts}{card_shopify}{card_birthdays}{card_meetings}{card_sports}
        </div>
        {btcChartOpen && <BtcChartModal isMobile onClose={() => setBtcChartOpen(false)} callFnFull={callFnFull} />}
      </div>
      ) : (
      <div style={grid}>
        <div style={col}>
          {sectionHeader("Market")}
          {card_bitcoin}{card_stocks}{card_watch}{card_wire}
        </div>
        <div style={col}>
          {sectionHeader("Ops")}
          {card_minicalendar}{card_gsc}{card_clarify}{card_zts}{card_shopify}{card_birthdays}{card_meetings}{card_sports}
        </div>
        {btcChartOpen && <BtcChartModal isMobile={false} onClose={() => setBtcChartOpen(false)} callFnFull={callFnFull} />}
      </div>
      );
      })()}
    </div>
  );
}

// ─── Page: The Board ─────────────────────────────────────────────────────────
function BoardPage({ seatNotes, onEditSeat, onEnterRoom, isMobile }) {
  const card = isMobile ? S.cardM : S.card;
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "18px 16px 24px" : "30px 34px 40px" }}>
      <div style={{ maxWidth: 920, margin: "0 auto", display: "flex", flexDirection: "column", gap: isMobile ? 10 : 14 }}>
        {!isMobile && (
          <div style={{ padding: "20px 24px", background: "rgba(138,103,28,0.05)", border: "1px solid rgba(143,107,30,0.22)", borderRadius: 18, display: "flex", alignItems: "center", gap: 18, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)" }}>
            <span style={{ width: 44, height: 44, borderRadius: 13, background: T.brass, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 20, flex: "none", boxShadow: "0 4px 16px rgba(143,107,30,0.4), inset 0 1px 0 rgba(255,255,255,0.4)" }}>♛</span>
            <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
              <span style={{ fontSize: 15, fontWeight: 700, fontFamily: syne, color: T.ink }}>Chief of Staff</span>
              <span style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.5 }}>Your single point of contact. Routes every question to the seats below, synthesizes, and keeps the disagreements visible.</span>
            </span>
            <button onClick={onEnterRoom} style={{ ...S.brassBtn, padding: "11px 20px", fontSize: 11.5, flex: "none" }}>Enter the Room ›</button>
          </div>
        )}
        {isMobile && <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.55 }}>Each seat treats its context as ground truth. Tap a seat to update what it knows.</div>}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 10 : 14 }}>
          {BOARD.map(b => {
            const has = !!seatNotes[b.key];
            return (
              <div key={b.key} onClick={() => onEditSeat(b.key)} style={{ ...card, cursor: "pointer", display: "flex", flexDirection: "column", gap: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 40, height: 40, borderRadius: 12, background: b.color + "1F", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18, flex: "none" }}>{b.emoji}</span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, fontFamily: syne, color: T.ink }}>{b.name}</span>
                    <span style={{ fontSize: 10, color: has ? T.green : T.faint }}>{has ? "✓ context loaded" : "tap to add context"}</span>
                  </span>
                  {isMobile && <span style={{ marginLeft: "auto", color: T.faint, fontSize: 15 }}>›</span>}
                </div>
                <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.6 }}>{b.blurb}</div>
                {!isMobile && <div style={{ fontSize: 10.5, color: T.brass, fontWeight: 700, fontFamily: syne }}>Edit context ›</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Compact single-column seat list for the desktop split view — the full
// BoardPage (banner + 2-col grid) is built for standalone/mobile use.
function BoardSeatsSidebar({ seatNotes, onEditSeat }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 14px", height: "100%", overflowY: "auto" }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: T.brass, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: syne, marginBottom: 2 }}>The Board</div>
      {BOARD.map(b => {
        const has = !!seatNotes[b.key];
        return (
          <div key={b.key} onClick={() => onEditSeat(b.key)} style={{ ...S.card, padding: "12px 13px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 30, height: 30, borderRadius: 9, background: b.color + "1F", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 14, flex: "none" }}>{b.emoji}</span>
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: syne, color: T.ink }}>{b.name}</span>
                <span style={{ fontSize: 9, color: has ? T.green : T.faint }}>{has ? "✓ context loaded" : "tap to add context"}</span>
              </span>
            </div>
            <div style={{ fontSize: 10, color: T.sub, lineHeight: 1.55 }}>{b.blurb}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Page: Board Room (chat + seat roster) ────────────────────────────────────
// Desktop: split view — chat and the board are both visible, always, no
// switching needed. Mobile: a sub-tab toggle, since there's no room for both.
const BOARDROOM_SUBTABS = [{ key: "mini", label: "Mini Me" }, { key: "learn", label: "Learn" }, { key: "chat", label: "Chat" }, { key: "seats", label: "Seats" }];
function BoardRoomPage({ messages, thinking, loadingData, input, setInput, onSend, onClearChat, endRef, seatNotes, onEditSeat, settings, updateSetting, session, onWorkerRun, onSkillsChanged, jump, isMobile }) {
  const [sub, setSub] = useState("mini"); // Mini Me first — it's the "what did my background worker do" check, the natural first stop
  useEffect(() => {
    if (jump?.page === "boardroom" && jump.sub) setSub(jump.sub);
  }, [jump?.t]); // eslint-disable-line react-hooks/exhaustive-deps
  const skillSpotlight = jump?.page === "boardroom" && jump.skillId ? { id: jump.skillId, t: jump.t } : null;
  const learnPanel = (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "14px 14px 24px" : "22px 24px 32px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <LearnPanel isMobile={isMobile} supabase={supabase} callClaude={callClaude} session={session}
          modelKey={(settings?.mini || {}).model || "haiku"} onSkillsChanged={onSkillsChanged} spotlight={skillSpotlight} />
      </div>
    </div>
  );

  if (!isMobile) {
    return (
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${T.line}` }}>
          <div style={{ flex: "none", padding: "12px 20px 0" }}>
            <SubTabs options={[{ key: "mini", label: "Mini Me" }, { key: "learn", label: "Learn" }, { key: "chat", label: "Chat" }]} value={sub === "seats" ? "chat" : sub} onChange={setSub} />
          </div>
          {sub === "mini" && <MiniMePage settings={settings} updateSetting={updateSetting} session={session} onWorkerRun={onWorkerRun} onOpenLearn={() => setSub("learn")} isMobile={false} />}
          {sub === "learn" && learnPanel}
          {(sub === "chat" || sub === "seats") && <RoomPage messages={messages} thinking={thinking} loadingData={loadingData} input={input} setInput={setInput} onSend={onSend} onClearChat={onClearChat} endRef={endRef} isMobile={false} />}
        </div>
        <div style={{ flex: "0 0 300px", minHeight: 0 }}>
          <BoardSeatsSidebar seatNotes={seatNotes} onEditSeat={onEditSeat} />
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{ flex: "none", padding: "10px 14px 0" }}>
        <SubTabs options={BOARDROOM_SUBTABS} value={sub} onChange={setSub} />
      </div>
      {sub === "mini" && <MiniMePage settings={settings} updateSetting={updateSetting} session={session} onWorkerRun={onWorkerRun} onOpenLearn={() => setSub("learn")} isMobile={true} />}
      {sub === "learn" && learnPanel}
      {sub === "chat" && <RoomPage messages={messages} thinking={thinking} loadingData={loadingData} input={input} setInput={setInput} onSend={onSend} onClearChat={onClearChat} endRef={endRef} isMobile={true} />}
      {sub === "seats" && <BoardPage seatNotes={seatNotes} onEditSeat={onEditSeat} onEnterRoom={() => setSub("chat")} isMobile={true} />}
    </>
  );
}

// ─── Shared birthday date math ────────────────────────────────────────────────
// Handles the Feb 29 edge case by falling back to Feb 28 in non-leap years —
// a reasonable convention, not a perfect one, but birthdays don't need to be.
function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function nextBirthdayOccurrence(month, day, fromDate = new Date()) {
  const today = new Date(fromDate); today.setHours(0, 0, 0, 0);
  const tryDate = (y) => {
    const d = (month === 2 && day === 29 && !isLeapYear(y)) ? 28 : day;
    return new Date(y, month - 1, d);
  };
  let next = tryDate(today.getFullYear());
  if (next < today) next = tryDate(today.getFullYear() + 1);
  const daysUntil = Math.round((next - today) / 86400000);
  return { next, daysUntil };
}

// ─── Page: Personal (Notes + Calendar + Birthdays) ────────────────────────────
const PERSONAL_SUBTABS = [{ key: "notes", label: "Notes" }, { key: "calendar", label: "Calendar" }, { key: "workout", label: "Workout" }, { key: "birthdays", label: "Birthdays" }, { key: "movies", label: "Movies" }, { key: "food", label: "Food" }];
const PERSONAL_SUBTABS_MOBILE = [{ key: "notescal", label: "Notes & Calendar" }, { key: "workout", label: "Workout" }, { key: "birthdays", label: "Birthdays" }, { key: "movies", label: "Movies" }, { key: "food", label: "Food" }];

function PersonalPage({ isMobile, jumpSignal, jump, settings, updateSetting }) {
  const [sub, setSub] = useState(isMobile ? "notescal" : "notes");
  useEffect(() => {
    if (jumpSignal) setSub(isMobile ? "notescal" : "calendar");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSignal]);
  useEffect(() => {
    if (jump?.page !== "personal" || !jump.sub) return;
    const mobileMap = { notes: "notescal", calendar: "notescal" };
    setSub(isMobile ? (mobileMap[jump.sub] || jump.sub) : jump.sub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.t]);
  const noteSignal = jump?.page === "personal" && jump.noteId ? { id: jump.noteId, t: jump.t } : null;
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "18px 16px 24px" : "30px 34px 40px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <SubTabs options={isMobile ? PERSONAL_SUBTABS_MOBILE : PERSONAL_SUBTABS} value={sub} onChange={setSub} />
        {isMobile ? (
          <>
            {sub === "notescal" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <CalendarPanel isMobile={isMobile} />
                <NotesPanel isMobile={isMobile} openSignal={noteSignal} />
              </div>
            )}
            {sub === "workout" && <WorkoutPanel isMobile={isMobile} supabase={supabase} settings={settings} updateSetting={updateSetting} />}
            {sub === "birthdays" && <BirthdaysPanel isMobile={isMobile} />}
            {sub === "movies" && <MoviesPanel isMobile={isMobile} />}
            {sub === "food" && <FoodPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} />}
          </>
        ) : (
          <>
            {sub === "notes" && <NotesPanel isMobile={isMobile} openSignal={noteSignal} />}
            {sub === "calendar" && <CalendarPanel isMobile={isMobile} />}
            {sub === "workout" && <WorkoutPanel isMobile={isMobile} supabase={supabase} settings={settings} updateSetting={updateSetting} />}
            {sub === "birthdays" && <BirthdaysPanel isMobile={isMobile} />}
            {sub === "movies" && <MoviesPanel isMobile={isMobile} />}
            {sub === "food" && <FoodPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} />}
          </>
        )}
      </div>
    </div>
  );
}

const NOTES_UPGRADE_SQL = `-- Notes upgrade — pins + color seals (safe to re-run)
alter table public.personal_notes add column if not exists pinned boolean not null default false;
alter table public.personal_notes add column if not exists color text;`;

const NOTE_SEALS = [
  { key: "brass", c: T.brass }, { key: "green", c: T.green },
  { key: "blue", c: T.blue }, { key: "red", c: T.red },
];
const sealColor = (key) => NOTE_SEALS.find(s => s.key === key)?.c || null;

// Notes — quick capture, search, pins, color seals, and a select mode for
// bulk pin/seal/merge/delete. Deletes and merges are undoable for a few
// seconds (the toast re-upserts the cached rows). Works on the pre-upgrade
// schema too: pins/seals hide behind a one-line SQL banner until added.
function NotesPanel({ isMobile, openSignal }) {
  const card = isMobile ? S.cardM : S.card;
  const [notes, setNotes] = useState(null); // null = loading
  const [legacy, setLegacy] = useState(false); // true until pinned/color columns exist
  const [loadErr, setLoadErr] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [draft, setDraft] = useState({ title: "", body: "", pinned: false, color: null });
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [quick, setQuick] = useState("");
  const [query, setQuery] = useState("");
  const [sealFilter, setSealFilter] = useState(null); // null = all, "none" = unsealed, or a seal key
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [sealMenu, setSealMenu] = useState(false);
  const [undo, setUndo] = useState(null); // { label, rows, extraDeleteId? }
  const [copied, setCopied] = useState(false);
  const saveTimer = useRef(null);
  const undoTimer = useRef(null);
  const skipNextAutosave = useRef(false);
  const quickRef = useRef(null);

  const refresh = () => {
    db.loadNotes()
      .then(({ rows, legacy: leg }) => { setNotes(rows); setLegacy(leg); })
      .catch(e => setLoadErr(e.message || "Couldn't load notes."));
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => () => { clearTimeout(saveTimer.current); clearTimeout(undoTimer.current); }, []);

  // Summon jump → open the named note as soon as it's in hand (consume once)
  const consumedSignal = useRef(null);
  useEffect(() => {
    if (!openSignal || !notes || consumedSignal.current === openSignal.t) return;
    const n = notes.find(x => x.id === openSignal.id);
    if (!n) return;
    consumedSignal.current = openSignal.t;
    openNote(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal?.t, notes]);

  // ─── derived ───
  const firstLine = (body) => (body || "").split("\n").map(l => l.trim()).find(Boolean) || "";
  const displayTitle = (n) => n.title?.trim() || firstLine(n.body).slice(0, 64) || "Untitled note";
  const snippet = (n) => {
    const body = (n.body || "").replace(/\s+/g, " ").trim();
    if (n.title?.trim()) return body.slice(0, 90);
    return body.slice(firstLine(n.body).length).replace(/^\s+/, "").slice(0, 90); // don't repeat the derived title
  };
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const sorted = useMemo(() => {
    if (!notes) return null;
    return [...notes].sort((a, b) => (b.pinned === true) - (a.pinned === true) || new Date(b.updated_at) - new Date(a.updated_at));
  }, [notes]);
  const visible = useMemo(() => {
    if (!sorted) return null;
    const q = query.trim().toLowerCase();
    return sorted.filter(n =>
      (!q || `${n.title || ""} ${n.body || ""}`.toLowerCase().includes(q)) &&
      (sealFilter === null || (sealFilter === "none" ? !n.color : n.color === sealFilter)));
  }, [sorted, query, sealFilter]);
  const usedSeals = useMemo(() => NOTE_SEALS.filter(s => (notes || []).some(n => n.color === s.key)), [notes]);
  const selectedNotes = (notes || []).filter(n => selected.has(n.id));

  // ─── undo plumbing ───
  const armUndo = (label, rows, extraDeleteId = null) => {
    clearTimeout(undoTimer.current);
    setUndo({ label, rows, extraDeleteId });
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  };
  const runUndo = async () => {
    const u = undo; setUndo(null); clearTimeout(undoTimer.current);
    if (!u) return;
    try {
      if (u.extraDeleteId) await db.bulkDeleteNotes([u.extraDeleteId]);
      await db.restoreNotes(u.rows);
      refresh();
    } catch (e) { alert(e.message || "Couldn't undo."); }
  };

  // ─── quick capture ───
  const quickAdd = async (openEditor = false) => {
    const t = quick.trim();
    if (!t) return;
    const id = crypto.randomUUID();
    if (openEditor) {
      setQuick("");
      skipNextAutosave.current = true;
      setActiveId(id);
      setDraft({ title: "", body: t, pinned: false, color: null });
      return;
    }
    setQuick("");
    const optimistic = { id, title: "", body: t, pinned: false, color: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    setNotes(list => [optimistic, ...(list || [])]);
    try { await db.saveNote({ id, title: "", body: t }); refresh(); }
    catch (e) { setNotes(list => (list || []).filter(n => n.id !== id)); alert(e.message || "Couldn't save."); }
    quickRef.current?.focus();
  };

  // ─── editor open/close ───
  const openNote = (n) => {
    skipNextAutosave.current = true;
    setActiveId(n.id);
    setDraft({ title: n.title || "", body: n.body || "", pinned: !!n.pinned, color: n.color || null });
    setSaveState("idle");
  };
  const newNote = () => {
    skipNextAutosave.current = true;
    setActiveId(crypto.randomUUID());
    setDraft({ title: "", body: "", pinned: false, color: null });
    setSaveState("idle");
  };
  const flushSave = () => {
    if (!activeId) return;
    clearTimeout(saveTimer.current);
    if (saveState === "saving" && (draft.title.trim() || draft.body.trim()))
      db.saveNote(noteRow()).then(refresh).catch(() => {});
  };
  const closeEditor = () => { flushSave(); setActiveId(null); setDraft({ title: "", body: "", pinned: false, color: null }); };
  const noteRow = () => ({ id: activeId, title: draft.title, body: draft.body, ...(legacy ? {} : { pinned: draft.pinned, color: draft.color }) });

  // autosave — 800ms after typing stops, only once there's something to save
  useEffect(() => {
    if (!activeId) return;
    if (skipNextAutosave.current) { skipNextAutosave.current = false; return; }
    if (!draft.title.trim() && !draft.body.trim()) return;
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      db.saveNote(noteRow())
        .then(() => { setSaveState("saved"); refresh(); })
        .catch(() => setSaveState("error"));
    }, 800);
    return () => clearTimeout(saveTimer.current);
  }, [draft, activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeId) return;
    const onKey = (e) => {
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) closeEditor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, draft, saveState]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── single + bulk operations ───
  const deleteOne = async (n) => {
    if (!window.confirm("Delete this note?")) return;
    try {
      await db.bulkDeleteNotes([n.id]);
      if (activeId === n.id) { setActiveId(null); setDraft({ title: "", body: "", pinned: false, color: null }); }
      armUndo("Note deleted", [n]);
      refresh();
    } catch (e) { alert(e.message || "Couldn't delete."); }
  };
  const clearSelection = () => { setSelected(new Set()); setSelectMode(false); setSealMenu(false); };
  const toggleSelected = (id) => setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const bulkDelete = async () => {
    if (!selected.size || !window.confirm(`Delete ${selected.size} note${selected.size > 1 ? "s" : ""}?`)) return;
    const rows = selectedNotes;
    try { await db.bulkDeleteNotes([...selected]); armUndo(`${rows.length} deleted`, rows); clearSelection(); refresh(); }
    catch (e) { alert(e.message || "Couldn't delete."); }
  };
  const bulkPin = async () => {
    const pin = !selectedNotes.every(n => n.pinned);
    try { await db.bulkUpdateNotes([...selected], { pinned: pin }); clearSelection(); refresh(); }
    catch (e) { alert(e.message || "Couldn't update."); }
  };
  const bulkSeal = async (colorKey) => {
    try { await db.bulkUpdateNotes([...selected], { color: colorKey }); clearSelection(); refresh(); }
    catch (e) { alert(e.message || "Couldn't update."); }
  };
  const bulkMerge = async () => {
    if (selected.size < 2) return;
    const picks = sorted.filter(n => selected.has(n.id)); // pinned/newest first — target is the top one
    if (!window.confirm(`Merge ${picks.length} notes into "${displayTitle(picks[0])}"? The other ${picks.length - 1} will fold in (undoable for a few seconds).`)) return;
    const target = picks[0];
    const rest = picks.slice(1).sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at)); // read oldest→newest
    const mergedBody = [target.body, ...rest.map(n => (n.title?.trim() ? `${n.title.trim()}\n${n.body || ""}` : n.body || ""))]
      .map(s => (s || "").trim()).filter(Boolean).join("\n\n⸻\n\n");
    try {
      const originals = picks.map(n => ({ ...n }));
      await db.saveNote({ id: target.id, title: target.title, body: mergedBody, ...(legacy ? {} : { pinned: target.pinned, color: target.color }) });
      await db.bulkDeleteNotes(rest.map(n => n.id));
      armUndo(`Merged ${picks.length} notes`, originals);
      clearSelection(); refresh();
    } catch (e) { alert(e.message || "Couldn't merge."); }
  };

  const words = draft.body.trim() ? draft.body.trim().split(/\s+/).length : 0;
  const activeNote = (notes || []).find(n => n.id === activeId);

  const sealDots = (value, onPick, size = 16) => (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      {NOTE_SEALS.map(s => (
        <button key={s.key} onClick={() => onPick(value === s.key ? null : s.key)} aria-label={`Seal ${s.key}`}
          style={{ width: size, height: size, borderRadius: "50%", border: value === s.key ? `2px solid ${T.ink}` : `1px solid rgba(34,29,20,0.2)`, background: s.c, cursor: "pointer", padding: 0, opacity: value && value !== s.key ? 0.45 : 1 }} />
      ))}
    </span>
  );

  // ─── editor view ───
  if (activeId) {
    return (
      <div style={{ ...card }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <button onClick={closeEditor} style={{ background: "none", border: "none", color: T.brass, fontFamily: syne, fontWeight: 700, fontSize: 12, cursor: "pointer", padding: 0 }}>‹ All notes</button>
          <span style={{ flex: 1 }} />
          {!legacy && (
            <>
              <button onClick={() => setDraft(d => ({ ...d, pinned: !d.pinned }))} title={draft.pinned ? "Unpin" : "Pin to top"}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, fontSize: 13, color: draft.pinned ? T.brass : T.faint, lineHeight: 1 }}>◆</button>
              {sealDots(draft.color, (c) => setDraft(d => ({ ...d, color: c })), 14)}
              <span style={{ width: 1, height: 14, background: T.line }} />
            </>
          )}
          <button onClick={() => { navigator.clipboard?.writeText(draft.title.trim() ? `${draft.title.trim()}\n\n${draft.body}` : draft.body); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 2, fontSize: 10, fontFamily: mono, color: copied ? T.green : T.faint, letterSpacing: "0.08em" }}>{copied ? "COPIED ✓" : "COPY"}</button>
          <button onClick={() => deleteOne(activeNote || { id: activeId, title: draft.title, body: draft.body })}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 2, fontSize: 10, fontFamily: mono, color: T.faint, letterSpacing: "0.08em" }}>DELETE</button>
          <span style={{ ...S.microLabel, minWidth: 52, textAlign: "right" }}>
            {saveState === "saving" && "Saving…"}
            {saveState === "saved" && "Saved"}
            {saveState === "error" && <span style={{ color: T.red }}>Not saved</span>}
          </span>
        </div>
        <input
          value={draft.title}
          onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
          placeholder="Untitled note"
          style={{ ...S.input, width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 15, fontWeight: 700, fontFamily: syne, marginBottom: 8, borderLeft: draft.color ? `3px solid ${sealColor(draft.color)}` : undefined }}
        />
        <textarea
          value={draft.body}
          onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
          placeholder="Start typing — this saves automatically."
          rows={isMobile ? 14 : 18}
          autoFocus
          style={{ ...S.input, width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 13.5, lineHeight: 1.6, resize: "vertical" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, flexWrap: "wrap", gap: 6 }}>
          <span style={S.microLabel}>{words} words · {draft.body.length} chars</span>
          {activeNote && <span style={S.microLabel}>edited {fmtWhen(activeNote.updated_at)}</span>}
        </div>
      </div>
    );
  }

  // ─── list view ───
  return (
    <div style={{ ...card }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={S.title}>Notes{notes?.length ? <span style={{ ...S.microLabel, marginLeft: 8 }}>{notes.length}</span> : null}</span>
        <span style={{ display: "flex", gap: 8 }}>
          {notes?.length > 1 && (
            <button onClick={() => (selectMode ? clearSelection() : setSelectMode(true))}
              style={{ ...S.ghostBtn, padding: "7px 13px", fontSize: 11, ...(selectMode ? { borderColor: T.brass, color: T.brass } : {}) }}>
              {selectMode ? "Done" : "Select"}
            </button>
          )}
          <button onClick={newNote} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11.5 }}>+ New note</button>
        </span>
      </div>

      {legacy && notes !== null && (
        <div style={{ ...S.inner, border: "1px solid rgba(162,112,14,0.3)", background: "rgba(162,112,14,0.06)", padding: "10px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10.5, color: T.amber, lineHeight: 1.5, flex: 1, minWidth: 180 }}>Pins &amp; color seals need two columns — one paste in Supabase → SQL Editor unlocks them.</span>
          <button onClick={(e) => { navigator.clipboard?.writeText(NOTES_UPGRADE_SQL); e.target.textContent = "Copied ✓"; }}
            style={{ ...S.ghostBtn, padding: "6px 12px", fontSize: 10, fontFamily: mono, color: T.amber, borderColor: "rgba(162,112,14,0.4)" }}>COPY SQL</button>
        </div>
      )}

      {/* quick capture — Enter saves and keeps focus for the next one; ⇧Enter opens the full editor */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          ref={quickRef}
          value={quick}
          onChange={e => setQuick(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); quickAdd(e.shiftKey); } }}
          placeholder="Jot something — Enter saves it, ⇧Enter opens the editor"
          style={{ ...S.input, flex: 1, minWidth: 0, padding: "10px 12px", fontSize: 12.5 }}
        />
        <button onClick={() => quickAdd(false)} disabled={!quick.trim()}
          style={{ ...S.brassBtn, padding: "0 16px", fontSize: 13, opacity: quick.trim() ? 1 : 0.45 }}>↵</button>
      </div>

      {notes?.length > 4 && (
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search notes…"
          style={{ ...S.input, width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 12, marginBottom: 10 }} />
      )}

      {usedSeals.length > 0 && !legacy && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setSealFilter(null)} style={{ ...S.ghostBtn, padding: "4px 10px", fontSize: 10, ...(sealFilter === null ? { borderColor: T.brass, color: T.brass } : {}) }}>All</button>
          {usedSeals.map(s => (
            <button key={s.key} onClick={() => setSealFilter(f => f === s.key ? null : s.key)} aria-label={`Filter ${s.key}`}
              style={{ width: 18, height: 18, borderRadius: "50%", background: s.c, border: sealFilter === s.key ? `2px solid ${T.ink}` : "1px solid rgba(34,29,20,0.2)", cursor: "pointer", padding: 0 }} />
          ))}
          <button onClick={() => setSealFilter(f => f === "none" ? null : "none")} style={{ ...S.ghostBtn, padding: "4px 10px", fontSize: 10, ...(sealFilter === "none" ? { borderColor: T.brass, color: T.brass } : {}) }}>Unsealed</button>
        </div>
      )}

      {loadErr && <div style={{ fontSize: 11.5, color: T.faint, padding: "20px 0", textAlign: "center" }}>{loadErr}</div>}
      {!loadErr && notes === null && <div style={{ fontSize: 11.5, color: T.faint, padding: "20px 0", textAlign: "center", animation: "pulse 1.4s infinite" }}>Loading notes…</div>}
      {!loadErr && notes && notes.length === 0 && (
        <div style={{ fontSize: 11.5, color: T.faint, padding: "24px 0", textAlign: "center" }}>No notes yet — jot the first one above.</div>
      )}
      {!loadErr && visible && notes?.length > 0 && visible.length === 0 && (
        <div style={{ fontSize: 11.5, color: T.faint, padding: "18px 0", textAlign: "center" }}>Nothing matches{query ? ` "${query}"` : ""}.</div>
      )}
      {!loadErr && visible && visible.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {visible.map(n => {
            const isSel = selected.has(n.id);
            return (
              <div key={n.id} onClick={() => (selectMode ? toggleSelected(n.id) : openNote(n))}
                style={{ ...S.inner, padding: "10px 12px", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 10, borderLeft: n.color ? `3px solid ${sealColor(n.color)}` : undefined, ...(isSel ? { border: `1px solid ${T.brass}`, background: "rgba(143,107,30,0.06)" } : {}) }}>
                {selectMode && (
                  <span style={{ marginTop: 2, width: 16, height: 16, borderRadius: 5, flex: "none", border: `1.5px solid ${isSel ? T.brass : "rgba(34,29,20,0.25)"}`, background: isSel ? T.brass : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#FDFCF9", fontSize: 10, fontWeight: 700 }}>{isSel ? "✓" : ""}</span>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, color: T.ink, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {n.pinned && <span style={{ color: T.brass, marginRight: 5, fontSize: 10 }}>◆</span>}{displayTitle(n)}
                  </div>
                  <div style={{ fontSize: 11, color: T.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {snippet(n) || "No additional text"}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                  <span style={{ ...S.microLabel }}>{fmtWhen(n.updated_at)}</span>
                  {!selectMode && (
                    <button onClick={(e) => { e.stopPropagation(); deleteOne(n); }} aria-label="Delete note"
                      style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 14, padding: 2, lineHeight: 1 }}>×</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* select-mode action bar */}
      {selectMode && (
        <div style={{ position: "sticky", bottom: isMobile ? 8 : 12, marginTop: 12, background: T.surface, border: `1px solid ${T.brass}`, borderRadius: 14, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", boxShadow: "0 4px 18px rgba(34,29,20,0.12)", zIndex: 5 }}>
          <span style={{ fontSize: 11, fontFamily: mono, color: T.brass, fontWeight: 700, marginRight: 2 }}>{selected.size} selected</span>
          <button onClick={() => setSelected(new Set((visible || []).map(n => n.id)))} style={{ ...S.ghostBtn, padding: "6px 10px", fontSize: 10 }}>All</button>
          <button onClick={() => setSelected(new Set())} style={{ ...S.ghostBtn, padding: "6px 10px", fontSize: 10 }}>None</button>
          <span style={{ flex: 1 }} />
          {selected.size > 0 && (
            <>
              {!legacy && (
                <button onClick={bulkPin} style={{ ...S.ghostBtn, padding: "7px 12px", fontSize: 10.5 }}>
                  {selectedNotes.every(n => n.pinned) ? "Unpin" : "◆ Pin"}
                </button>
              )}
              {!legacy && (
                <span style={{ position: "relative" }}>
                  <button onClick={() => setSealMenu(m => !m)} style={{ ...S.ghostBtn, padding: "7px 12px", fontSize: 10.5 }}>Seal ▾</button>
                  {sealMenu && (
                    <span style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, padding: "8px 10px", display: "flex", gap: 7, alignItems: "center", boxShadow: "0 4px 14px rgba(34,29,20,0.14)" }}>
                      {sealDots(null, bulkSeal, 16)}
                      <button onClick={() => bulkSeal(null)} style={{ ...S.ghostBtn, padding: "3px 8px", fontSize: 9.5 }}>Clear</button>
                    </span>
                  )}
                </span>
              )}
              {selected.size > 1 && <button onClick={bulkMerge} style={{ ...S.ghostBtn, padding: "7px 12px", fontSize: 10.5 }}>Merge</button>}
              <button onClick={bulkDelete} style={{ ...S.ghostBtn, padding: "7px 12px", fontSize: 10.5, color: T.red, borderColor: "rgba(178,58,46,0.35)" }}>Delete</button>
            </>
          )}
        </div>
      )}

      {/* undo toast */}
      {undo && (
        <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: isMobile ? 88 : 26, background: T.ink, color: "#F3F1EC", borderRadius: 12, padding: "10px 16px", display: "flex", alignItems: "center", gap: 14, fontSize: 12, boxShadow: "0 6px 22px rgba(34,29,20,0.35)", zIndex: 60, animation: "fadein 0.2s ease" }}>
          <span>{undo.label}</span>
          <button onClick={runUndo} style={{ background: "none", border: "none", color: "#D9B45B", fontWeight: 700, fontFamily: syne, fontSize: 12, cursor: "pointer", letterSpacing: "0.04em", padding: 0 }}>Undo</button>
        </div>
      )}
    </div>
  );
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function BirthdaysPanel({ isMobile }) {
  const card = isMobile ? S.cardM : S.card;
  const [rows, setRows] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState(null);
  const [form, setForm] = useState(null); // single add/edit
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkParsing, setBulkParsing] = useState(false);
  const [bulkErr, setBulkErr] = useState(null);
  const [bulkPreview, setBulkPreview] = useState(null); // array of parsed rows awaiting confirmation
  const [bulkSaving, setBulkSaving] = useState(false);

  const refresh = () => {
    db.loadBirthdays().then(setRows).catch(e => setLoadErr(e.message || "Couldn't load birthdays."));
  };
  useEffect(() => { refresh(); }, []);

  // ─── Single add/edit ───
  const openNew = () => {
    setSaveErr(null);
    const today = new Date();
    setForm({ id: crypto.randomUUID(), name: "", date: today.toISOString().slice(0, 10), unknownYear: true, notes: "" });
  };
  const openEdit = (b) => {
    setSaveErr(null);
    const y = b.year || new Date().getFullYear();
    const mm = String(b.month).padStart(2, "0"), dd = String(b.day).padStart(2, "0");
    setForm({ id: b.id, name: b.name, date: `${y}-${mm}-${dd}`, unknownYear: !b.year, notes: b.notes || "" });
  };
  const closeForm = () => setForm(null);

  const save = () => {
    if (!form.name.trim()) { setSaveErr("Give them a name."); return; }
    if (!form.date) { setSaveErr("Pick a date."); return; }
    const [y, m, d] = form.date.split("-").map(Number);
    setSaving(true); setSaveErr(null);
    db.saveBirthday({ id: form.id, name: form.name.trim(), month: m, day: d, year: form.unknownYear ? null : y, notes: form.notes })
      .then(() => { setSaving(false); closeForm(); refresh(); })
      .catch(e => { setSaving(false); setSaveErr(e.message || "Couldn't save."); });
  };
  const removeBirthday = (id, e) => {
    e.stopPropagation();
    if (!window.confirm("Delete this birthday?")) return;
    db.deleteBirthday(id).then(() => { if (form?.id === id) closeForm(); refresh(); });
  };

  // ─── Bulk parse via Claude ───
  const parseBulk = async () => {
    if (!bulkText.trim()) return;
    setBulkParsing(true); setBulkErr(null); setBulkPreview(null);
    const system = `Extract birthdays from the text the user pastes. Respond with ONLY a JSON array, no markdown fences, no commentary — just the raw array. Each item: {"name": string, "month": 1-12, "day": 1-31, "year": number or null}. If a birth year isn't given or isn't confidently inferable, use null for year — never guess one. If a line doesn't look like a name+date, skip it rather than inventing data. If you truly cannot find any valid entries, respond with []`;
    const text = await callClaude({ system, messages: [{ role: "user", content: bulkText }], modelKey: "haiku", maxTokens: 2000, fn: "parse_birthdays" });
    setBulkParsing(false);
    if (!text) { setBulkErr("Couldn't reach Claude — try again in a moment."); return; }
    try {
      const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      const valid = parsed.filter(r => r && typeof r.name === "string" && r.name.trim() && Number(r.month) >= 1 && Number(r.month) <= 12 && Number(r.day) >= 1 && Number(r.day) <= 31);
      if (!valid.length) { setBulkErr("Didn't find any birthdays in that text — try a clearer format, e.g. one per line: \"Name — Month Day\"."); return; }
      setBulkPreview(valid.map(r => ({ tempId: crypto.randomUUID(), name: r.name.trim(), month: Number(r.month), day: Number(r.day), year: r.year ? Number(r.year) : null })));
    } catch {
      setBulkErr("Got an unexpected response back — try again, or simplify the text.");
    }
  };
  const removeFromPreview = (tempId) => setBulkPreview(rows => rows.filter(r => r.tempId !== tempId));
  const confirmBulk = () => {
    if (!bulkPreview?.length) return;
    setBulkSaving(true);
    db.saveBirthdaysBulk(bulkPreview.map(r => ({ id: crypto.randomUUID(), name: r.name, month: r.month, day: r.day, year: r.year })))
      .then(() => { setBulkSaving(false); setBulkPreview(null); setBulkText(""); setBulkOpen(false); refresh(); })
      .catch(e => { setBulkSaving(false); setBulkErr(e.message || "Couldn't save the batch."); });
  };

  // ─── Form view ───
  if (form) {
    return (
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <button onClick={closeForm} style={{ background: "none", border: "none", color: T.brass, fontFamily: syne, fontWeight: 700, fontSize: 12, cursor: "pointer", padding: 0 }}>‹ Cancel</button>
          <span style={S.title}>{rows?.some(b => b.id === form.id) ? "Edit birthday" : "New birthday"}</span>
          <span style={{ width: 50 }} />
        </div>

        <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Name"
          style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 14, fontWeight: 700, fontFamily: syne, marginBottom: 10 }} />

        <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
          style={{ ...S.input, width: "100%", padding: "9px 10px", fontSize: 13, fontFamily: mono, marginBottom: 10 }} />

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 11.5, color: T.sub, cursor: "pointer" }}>
          <input type="checkbox" checked={form.unknownYear} onChange={e => setForm(f => ({ ...f, unknownYear: e.target.checked }))} />
          Don't track birth year (just month + day)
        </label>

        <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes (optional)" rows={3}
          style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 13, lineHeight: 1.6, resize: "vertical", marginBottom: 10 }} />

        {saveErr && <div style={{ fontSize: 11, color: "#B23A2E", marginBottom: 8 }}>{saveErr}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...S.brassBtn, padding: "9px 18px", fontSize: 12, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save"}</button>
          {rows?.some(b => b.id === form.id) && (
            <button onClick={(e) => removeBirthday(form.id, e)} style={{ ...S.ghostBtn, padding: "9px 14px", fontSize: 12 }}>Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ─── List view ───
  const sorted = (rows || []).map(b => ({ ...b, ...nextBirthdayOccurrence(b.month, b.day) })).sort((a, b) => a.daysUntil - b.daysUntil);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <span style={S.title}>Birthdays</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setBulkOpen(o => !o)} style={{ ...S.ghostBtn, padding: "7px 14px", fontSize: 11.5 }}>{bulkOpen ? "Close bulk add" : "Bulk add"}</button>
            <button onClick={openNew} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11.5 }}>+ Add birthday</button>
          </div>
        </div>

        {bulkOpen && (
          <div style={{ ...S.inner, padding: 12, marginBottom: 12 }}>
            {!bulkPreview ? (
              <>
                <div style={{ fontSize: 10.5, color: T.sub, lineHeight: 1.6, marginBottom: 8 }}>
                  Paste anything — a list, a few sentences, whatever you've got. Claude will pull out names and dates; you'll get a chance to review before anything's saved.
                </div>
                <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} rows={6} placeholder={"e.g.\nMom - March 3\nJohn Smith 12/25/1990\nSarah's birthday is June 1st"}
                  style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 13, lineHeight: 1.6, resize: "vertical", marginBottom: 8 }} />
                {bulkErr && <div style={{ fontSize: 11, color: "#B23A2E", marginBottom: 8 }}>{bulkErr}</div>}
                <button onClick={parseBulk} disabled={bulkParsing || !bulkText.trim()} style={{ ...S.brassBtn, padding: "8px 16px", fontSize: 11.5, opacity: (bulkParsing || !bulkText.trim()) ? 0.55 : 1 }}>
                  {bulkParsing ? "Parsing…" : "Parse with Claude"}
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 10.5, color: T.sub, marginBottom: 8 }}>Found {bulkPreview.length} — review, then add.</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10, maxHeight: 240, overflowY: "auto" }}>
                  {bulkPreview.map(r => (
                    <div key={r.tempId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: "7px 10px" }}>
                      <span style={{ fontSize: 12, fontFamily: syne, fontWeight: 700, color: T.ink }}>{r.name}</span>
                      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 11, color: T.sub, fontFamily: mono }}>{MONTH_NAMES[r.month - 1]} {r.day}{r.year ? `, ${r.year}` : ""}</span>
                        <button onClick={() => removeFromPreview(r.tempId)} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
                      </span>
                    </div>
                  ))}
                </div>
                {bulkErr && <div style={{ fontSize: 11, color: "#B23A2E", marginBottom: 8 }}>{bulkErr}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={confirmBulk} disabled={bulkSaving || !bulkPreview.length} style={{ ...S.brassBtn, padding: "8px 16px", fontSize: 11.5, opacity: bulkSaving ? 0.6 : 1 }}>
                    {bulkSaving ? "Adding…" : `Add all (${bulkPreview.length})`}
                  </button>
                  <button onClick={() => { setBulkPreview(null); setBulkErr(null); }} style={{ ...S.ghostBtn, padding: "8px 14px", fontSize: 11.5 }}>Start over</button>
                </div>
              </>
            )}
          </div>
        )}

        {loadErr && <div style={{ fontSize: 11.5, color: T.faint, padding: "20px 0", textAlign: "center" }}>{loadErr}</div>}
        {!loadErr && rows === null && <div style={{ fontSize: 11.5, color: T.faint, padding: "20px 0", textAlign: "center", animation: "pulse 1.4s infinite" }}>Loading birthdays…</div>}
        {!loadErr && rows && rows.length === 0 && !bulkOpen && (
          <div style={{ fontSize: 11.5, color: T.faint, padding: "24px 0", textAlign: "center" }}>No birthdays yet — add one, or bulk-add a whole list at once.</div>
        )}
        {!loadErr && sorted.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {sorted.map(b => (
              <div key={b.id} onClick={() => openEdit(b)}
                style={{ ...S.inner, padding: "10px 12px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, color: T.ink }}>{b.name}</div>
                  <div style={{ fontSize: 11, color: T.sub }}>
                    {MONTH_NAMES[b.month - 1]} {b.day}{b.year ? ` · turns ${b.next.getFullYear() - b.year}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                  <span style={{ ...S.microLabel, color: b.daysUntil <= 7 ? T.brass : T.faint }}>
                    {b.daysUntil === 0 ? "Today!" : b.daysUntil === 1 ? "Tomorrow" : `in ${b.daysUntil}d`}
                  </span>
                  <button onClick={(e) => removeBirthday(b.id, e)} aria-label="Delete" style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 14, padding: 2, lineHeight: 1 }}>×</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MoviesPanel({ isMobile }) {
  const card = isMobile ? S.cardM : S.card;
  const [movies, setMovies] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [editingId, setEditingId] = useState(null); // null = adding new, otherwise editing this movie
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [posterUrl, setPosterUrl] = useState(null);
  const [trueScore, setTrueScore] = useState("");
  const [cameronScore, setCameronScore] = useState("");
  const [note, setNote] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  const refresh = () => { db.loadMovies().then(setMovies).catch(e => setLoadErr(e.message || "Couldn't load movies.")); };
  useEffect(() => { refresh(); }, []);

  // Purely optional — just fills in a poster + confirms the year/title
  // spelling. Your two scores are always typed by you; this never sets them.
  const findPoster = async () => {
    if (!title.trim()) return;
    setSearching(true); setSearchResults(null);
    const res = await callFnFull("tmdb", { title: title.trim() });
    setSearching(false);
    setSearchResults(res.ok && res.data?.success ? res.data.results : []);
  };
  const pickPoster = (r) => { setTitle(r.title); setYear(r.year ? String(r.year) : ""); setPosterUrl(r.poster_url); setSearchResults(null); };

  const resetForm = () => { setEditingId(null); setTitle(""); setYear(""); setPosterUrl(null); setTrueScore(""); setCameronScore(""); setNote(""); setSaveErr(null); setSearchResults(null); };
  const startEdit = (m) => {
    setEditingId(m.id); setTitle(m.title); setYear(m.year ? String(m.year) : ""); setPosterUrl(m.poster_url);
    setTrueScore(m.true_quality_score != null ? String(m.true_quality_score) : "");
    setCameronScore(m.cameron_score != null ? String(m.cameron_score) : "");
    setNote(m.note || ""); setSearchResults(null); setSaveErr(null);
  };
  const saveMovie = () => {
    if (!title.trim()) return;
    setSaving(true); setSaveErr(null);
    const payload = { title: title.trim(), year: year ? Number(year) : null, poster_url: posterUrl, true_quality_score: trueScore === "" ? null : Number(trueScore), cameron_score: cameronScore === "" ? null : Number(cameronScore), note };
    const op = editingId ? db.updateMovie(editingId, payload) : db.saveMovie(payload);
    op.then(() => { setSaving(false); resetForm(); refresh(); })
      .catch(e => { setSaving(false); setSaveErr(e.message || "Couldn't save."); });
  };
  const removeMovie = (id, e) => { e.stopPropagation(); if (!window.confirm("Delete this movie?")) return; db.deleteMovie(id).then(refresh); };
  const scoreColor = (s) => s == null ? T.faint : s >= 70 ? T.green : s >= 40 ? T.amber : T.red;
  const hasBothScores = trueScore !== "" && cameronScore !== "";
  const saveLabel = editingId ? "Save changes" : hasBothScores ? "Log it" : "Add to watchlist";

  const watchlist = (movies || []).filter(m => m.true_quality_score == null && m.cameron_score == null);
  const reviewed = (movies || []).filter(m => m.true_quality_score != null || m.cameron_score != null);

  const MovieRow = ({ m }) => (
    <div onClick={() => startEdit(m)} style={{ ...S.inner, padding: "10px 13px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
      {m.poster_url && <img src={m.poster_url} style={{ width: 32, height: 48, borderRadius: 4, objectFit: "cover", flex: "none" }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne }}>{m.title}{m.year ? ` (${m.year})` : ""}</div>
        {m.true_quality_score != null || m.cameron_score != null ? (
          <div style={{ display: "flex", gap: 12, marginTop: 2 }}>
            <span style={{ fontSize: 10, color: scoreColor(m.true_quality_score) }}>True: {m.true_quality_score != null ? `${m.true_quality_score}%` : "—"}</span>
            <span style={{ fontSize: 10, color: scoreColor(m.cameron_score), fontWeight: 700 }}>Cameron: {m.cameron_score != null ? `${m.cameron_score}%` : "—"}</span>
          </div>
        ) : <div style={{ fontSize: 10, color: T.faint, marginTop: 2 }}>Tap to add your scores once watched</div>}
        {m.note && <div style={{ fontSize: 10, color: T.faint, marginTop: 2 }}>{m.note}</div>}
      </div>
      <button onClick={(e) => removeMovie(m.id, e)} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 14, flex: "none" }}>×</button>
    </div>
  );

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={S.title}>Movies</span>
      </div>

      <div style={{ ...S.inner, padding: "12px 14px", marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {editingId && <div style={{ fontSize: 10, color: T.brass, fontWeight: 700, letterSpacing: "0.04em" }}>EDITING</div>}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {posterUrl && <img src={posterUrl} style={{ width: 30, height: 45, borderRadius: 4, objectFit: "cover", flex: "none" }} />}
          <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter") findPoster(); }} placeholder="Movie title…" style={{ ...S.input, flex: 1, padding: "9px 12px", fontSize: 13 }} />
          <button onClick={findPoster} disabled={searching || !title.trim()} title="Optional — just fills in a poster/year" style={{ ...S.ghostBtn, padding: "9px 12px", fontSize: 11 }}>{searching ? "…" : "🔍"}</button>
        </div>

        {searchResults && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {searchResults.length ? searchResults.map(r => (
              <div key={r.id} onClick={() => pickPoster(r)} style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", padding: "5px 6px", borderRadius: 6 }}>
                {r.poster_url && <img src={r.poster_url} style={{ width: 24, height: 36, borderRadius: 3, objectFit: "cover" }} />}
                <span style={{ fontSize: 11.5 }}>{r.title}{r.year ? ` (${r.year})` : ""}</span>
              </div>
            )) : <div style={{ fontSize: 10.5, color: T.faint }}>No matches — no problem, just fill in the fields below by hand.</div>}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
              <span style={{ fontSize: 9.5, color: T.faint }}>True quality — optional until watched</span>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: mono, color: trueScore === "" ? T.faint : scoreColor(Number(trueScore)) }}>{trueScore === "" ? "—" : `${trueScore}%`}</span>
            </div>
            <input type="range" min="0" max="100" className="scoreSlider" value={trueScore === "" ? 50 : trueScore} onChange={e => setTrueScore(e.target.value)}
              style={{ "--slider-color": trueScore === "" ? T.faint : scoreColor(Number(trueScore)), "--slider-fill": `${trueScore === "" ? 50 : trueScore}%` }} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
              <span style={{ fontSize: 9.5, color: T.faint }}>Cameron score — optional until watched</span>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: mono, color: cameronScore === "" ? T.faint : scoreColor(Number(cameronScore)) }}>{cameronScore === "" ? "—" : `${cameronScore}%`}</span>
            </div>
            <input type="range" min="0" max="100" className="scoreSlider" value={cameronScore === "" ? 50 : cameronScore} onChange={e => setCameronScore(e.target.value)}
              style={{ "--slider-color": cameronScore === "" ? T.faint : scoreColor(Number(cameronScore)), "--slider-fill": `${cameronScore === "" ? 50 : cameronScore}%` }} />
          </div>
        </div>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Quick note (optional)" style={{ ...S.input, padding: "8px 10px", fontSize: 12 }} />
        {saveErr && <div style={{ fontSize: 10.5, color: T.red }}>{saveErr}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={saveMovie} disabled={saving || !title.trim()} style={{ ...S.brassBtn, padding: "8px 16px", fontSize: 11.5, opacity: title.trim() ? 1 : 0.5 }}>{saving ? "Saving…" : saveLabel}</button>
          {(title || editingId) && <button onClick={resetForm} style={{ ...S.ghostBtn, padding: "8px 16px", fontSize: 11.5 }}>{editingId ? "Cancel" : "Clear"}</button>}
        </div>
      </div>

      {loadErr ? <div style={{ fontSize: 11, color: T.faint }}>{loadErr}</div>
        : movies === null ? <div style={{ fontSize: 11, color: T.faint, animation: "pulse 1.4s infinite" }}>Loading…</div>
        : (
          <>
            {watchlist.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 8 }}>WATCHLIST ({watchlist.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {watchlist.map(m => <MovieRow key={m.id} m={m} />)}
                </div>
              </div>
            )}
            <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 8 }}>REVIEWED ({reviewed.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {reviewed.length ? reviewed.map(m => <MovieRow key={m.id} m={m} />) : <div style={{ fontSize: 11, color: T.faint, padding: "6px 0" }}>Nothing reviewed yet.</div>}
            </div>
          </>
        )}
    </div>
  );
}

function FoodPanel({ isMobile, settings, updateSetting }) {
  const card = isMobile ? S.cardM : S.card;
  const prefs = settings?.food_preferences || { likes: [], dislikes: [] };
  const [newLike, setNewLike] = useState("");
  const [newDislike, setNewDislike] = useState("");
  const [groceries, setGroceries] = useState(null);
  const [newItem, setNewItem] = useState("");
  const [savedRecipes, setSavedRecipes] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [idea, setIdea] = useState(null);
  const [ideaErr, setIdeaErr] = useState(null);

  const refreshGroceries = () => db.loadGroceryItems().then(setGroceries).catch(() => setGroceries([]));
  const refreshRecipes = () => db.loadSavedRecipes().then(setSavedRecipes).catch(() => setSavedRecipes([]));
  useEffect(() => { refreshGroceries(); refreshRecipes(); }, []);

  const addLike = () => { if (!newLike.trim()) return; updateSetting("food_preferences", { ...prefs, likes: [...prefs.likes, newLike.trim()] }); setNewLike(""); };
  const addDislike = () => { if (!newDislike.trim()) return; updateSetting("food_preferences", { ...prefs, dislikes: [...prefs.dislikes, newDislike.trim()] }); setNewDislike(""); };
  const removeLike = (i) => updateSetting("food_preferences", { ...prefs, likes: prefs.likes.filter((_, idx) => idx !== i) });
  const removeDislike = (i) => updateSetting("food_preferences", { ...prefs, dislikes: prefs.dislikes.filter((_, idx) => idx !== i) });

  const addGroceryItem = () => { if (!newItem.trim()) return; db.addGroceryItem(newItem.trim()).then(() => { setNewItem(""); refreshGroceries(); }); };
  const toggleItem = (it) => { db.toggleGroceryItem(it.id, !it.checked).then(refreshGroceries); };
  const removeItem = (id) => db.deleteGroceryItem(id).then(refreshGroceries);
  const clearChecked = () => { (groceries || []).filter(g => g.checked).forEach(g => db.deleteGroceryItem(g.id)); setTimeout(refreshGroceries, 300); };

  const generateIdea = async () => {
    setGenerating(true); setIdeaErr(null); setIdea(null);
    const system = `You generate one meal idea with a full, cookable recipe for someone with specific tastes. Likes: ${prefs.likes.join(", ") || "no strong likes recorded yet"}. Dislikes — never suggest anything built around these: ${prefs.dislikes.join(", ") || "none recorded yet"}. Give a real recipe: a short title, ingredient list with rough quantities, and clear numbered steps. Keep it practical for a home cook on a weeknight unless asked otherwise. No preamble, start straight with the title.`;
    const raw = await callClaude({ system, messages: [{ role: "user", content: "Give me a meal idea for tonight." }], modelKey: "haiku", maxTokens: 600, fn: "meal_idea" });
    setGenerating(false);
    if (raw && raw.trim()) setIdea(raw.trim());
    else setIdeaErr("Couldn't get an idea — try again.");
  };
  const saveIdea = () => {
    if (!idea) return;
    const title = idea.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80);
    db.saveRecipe(title, idea).then(() => { setIdea(null); refreshRecipes(); });
  };
  const notForMe = () => {
    const key = window.prompt("What didn't work about it? (adds to your dislikes so future ideas avoid it — leave blank to skip)");
    if (key && key.trim()) updateSetting("food_preferences", { ...prefs, dislikes: [...prefs.dislikes, key.trim()] });
    setIdea(null);
  };
  const removeRecipe = (id) => { if (!window.confirm("Delete this saved recipe?")) return; db.deleteRecipe(id).then(refreshRecipes); };

  const tag = (text, onRemove, color) => (
    <span onClick={onRemove} style={{ fontSize: 10.5, color, border: `1px solid ${color}40`, background: color + "14", borderRadius: 999, padding: "4px 10px", cursor: "pointer" }}>{text} ×</span>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={card}>
        <div style={{ ...S.title, marginBottom: 10 }}>Tastes</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 6 }}>LIKES</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {prefs.likes.map((l, i) => tag(l, () => removeLike(i), T.green))}
          {!prefs.likes.length && <span style={{ fontSize: 10.5, color: T.faint }}>None yet.</span>}
        </div>
        <div style={{ display: "flex", gap: 7, marginBottom: 16 }}>
          <input value={newLike} onChange={e => setNewLike(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addLike(); }} placeholder="Add something you like…" style={{ ...S.input, flex: 1, padding: "8px 10px", fontSize: 12 }} />
          <button onClick={addLike} style={{ ...S.ghostBtn, padding: "8px 14px", fontSize: 11.5 }}>Add</button>
        </div>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 6 }}>DISLIKES</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {prefs.dislikes.map((d, i) => tag(d, () => removeDislike(i), T.red))}
          {!prefs.dislikes.length && <span style={{ fontSize: 10.5, color: T.faint }}>None yet.</span>}
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <input value={newDislike} onChange={e => setNewDislike(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addDislike(); }} placeholder="Add something you don't like…" style={{ ...S.input, flex: 1, padding: "8px 10px", fontSize: 12 }} />
          <button onClick={addDislike} style={{ ...S.ghostBtn, padding: "8px 14px", fontSize: 11.5 }}>Add</button>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={S.title}>Grocery List</span>
          {(groceries || []).some(g => g.checked) && <span onClick={clearChecked} style={{ fontSize: 10, color: T.brass, cursor: "pointer", fontWeight: 600 }}>Clear checked</span>}
        </div>
        <div style={{ display: "flex", gap: 7, marginBottom: 12 }}>
          <input value={newItem} onChange={e => setNewItem(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addGroceryItem(); }} placeholder="Add an item…" style={{ ...S.input, flex: 1, padding: "8px 10px", fontSize: 12 }} />
          <button onClick={addGroceryItem} style={{ ...S.brassBtn, padding: "8px 14px", fontSize: 11.5 }}>Add</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {groceries === null ? <div style={{ fontSize: 11, color: T.faint, animation: "pulse 1.4s infinite" }}>Loading…</div>
            : groceries.length ? groceries.map(it => (
              <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 2px" }}>
                <input type="checkbox" checked={it.checked} onChange={() => toggleItem(it)} />
                <span style={{ fontSize: 12, color: it.checked ? T.faint : T.ink, textDecoration: it.checked ? "line-through" : "none", flex: 1 }}>{it.item}</span>
                <button onClick={() => removeItem(it.id)} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 13 }}>×</button>
              </div>
            )) : <div style={{ fontSize: 11, color: T.faint }}>List's empty.</div>}
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={S.title}>Meal Ideas</span>
          <button onClick={generateIdea} disabled={generating} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11.5 }}>{generating ? "Thinking…" : "✦ Generate idea"}</button>
        </div>
        {ideaErr && <div style={{ fontSize: 11, color: T.red, marginBottom: 8 }}>{ideaErr}</div>}
        {idea && (
          <div style={{ ...S.inner, padding: "13px 15px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: T.ink, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{idea}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={saveIdea} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11 }}>👍 Save recipe</button>
              <button onClick={notForMe} style={{ ...S.ghostBtn, padding: "7px 14px", fontSize: 11 }}>👎 Not my taste</button>
            </div>
          </div>
        )}
        {(savedRecipes || []).length > 0 && (
          <>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 8 }}>SAVED</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {savedRecipes.map(r => (
                <div key={r.id} style={{ ...S.inner, padding: "9px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{r.title}</span>
                  <button onClick={() => removeRecipe(r.id)} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 13 }}>×</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Shared between the full Calendar tab and the Ops mini-calendar card.
const EVENT_CATEGORIES = [
  { key: "personal", label: "Personal", color: T.blue },
  { key: "work", label: "Work", color: T.amber },
  { key: "health", label: "Health", color: T.green },
  { key: "bills", label: "Bills / Finance", color: T.red },
];

function CalendarPanel({ isMobile }) {
  const card = isMobile ? S.cardM : S.card;
  const [events, setEvents] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState(null);
  const [form, setForm] = useState(null); // null = closed; object = open (new or editing)
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const [viewMonth, setViewMonth] = useState(() => new Date(today0.getFullYear(), today0.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(null); // "YYYY-MM-DD" or null — grid shows when null

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkImages, setBulkImages] = useState([]); // {id, name, dataUrl, base64, mediaType}
  const [bulkParsing, setBulkParsing] = useState(false);
  const [bulkErr, setBulkErr] = useState(null);
  const [bulkPreview, setBulkPreview] = useState(null); // parsed rows awaiting review
  const [bulkSaving, setBulkSaving] = useState(false);

  const refresh = () => {
    db.loadEvents()
      .then(rows => setEvents(rows))
      .catch(e => setLoadErr(e.message || "Couldn't load your calendar."));
  };
  useEffect(() => { refresh(); }, []);

  // ─── Bulk import from calendar screenshots ───
  const normName = (s) => (s || "").toLowerCase().replace(/'s birthday|birthday|bday|born/gi, "").replace(/[^a-z0-9]/g, "").trim();

  const addImages = (fileList) => {
    Array.from(fileList).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(",")[1];
        setBulkImages(prev => [...prev, { id: crypto.randomUUID(), name: file.name, dataUrl, base64, mediaType: file.type || "image/png" }]);
      };
      reader.readAsDataURL(file);
    });
  };
  const removeImage = (id) => setBulkImages(prev => prev.filter(i => i.id !== id));

  const parseBulkImages = async () => {
    if (!bulkImages.length) return;
    setBulkParsing(true); setBulkErr(null); setBulkPreview(null);

    const [birthdaysList, eventsList] = await Promise.all([
      db.loadBirthdays().catch(() => []),
      db.loadEvents().catch(() => []),
    ]);

    const system = `You are extracting events from a screenshot of a calendar app's month view. Look at the month/year shown in the screenshot's header to anchor the dates. Respond with ONLY a JSON array, no markdown fences, no commentary.
Each item: {"title": string, "date": "YYYY-MM-DD", "time": "HH:MM" or null, "all_day": boolean, "kind": "event" or "possible_birthday"}.
Use kind "possible_birthday" if the title clearly reads as someone's birthday (contains "birthday", "bday", a cake emoji, or is just a name in a way that strongly implies it). Otherwise use "event".
Only extract entries you can read with real confidence — skip anything blurry, cut off, or ambiguous rather than guessing. If you find nothing legible, respond with []`;

    const merged = [];
    const errors = [];
    for (const img of bulkImages) {
      try {
        const text = await callClaude({
          system,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
            { type: "text", text: "Extract every event from this calendar screenshot as instructed." },
          ] }],
          modelKey: "sonnet", maxTokens: 2500, fn: "parse_calendar_image",
        });
        if (!text) { errors.push(`${img.name}: no response`); continue; }
        const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) { errors.push(`${img.name}: unexpected response shape`); continue; }
        parsed.forEach(item => {
          if (item && typeof item.title === "string" && item.date) merged.push(item);
        });
      } catch (e) {
        errors.push(`${img.name}: ${e.message || "couldn't parse"}`);
      }
    }

    setBulkParsing(false);
    if (!merged.length) {
      setBulkErr(errors.length ? `Couldn't extract anything. ${errors.join("; ")}` : "No events found in those screenshots.");
      return;
    }

    // Cross-reference against what's already tracked, so re-importing your
    // old calendar doesn't create duplicate birthdays or duplicate events.
    const reviewed = merged.map(item => {
      const [y, m, d] = item.date.split("-").map(Number);
      if (item.kind === "possible_birthday") {
        const match = birthdaysList.find(b => normName(b.name) === normName(item.title) && b.month === m && b.day === d);
        return {
          tempId: crypto.randomUUID(), title: item.title, date: item.date, time: item.time, allDay: !!item.all_day,
          kind: match ? "duplicate_birthday" : "new_birthday",
          matchedName: match?.name,
          action: match ? "skip" : "birthday",
          month: m, day: d, year: y,
        };
      }
      const dupEvent = eventsList.find(e => normName(e.title) === normName(item.title) && e.start_time.slice(0, 10) === item.date);
      return {
        tempId: crypto.randomUUID(), title: item.title, date: item.date, time: item.time, allDay: !!item.all_day,
        kind: dupEvent ? "duplicate_event" : "event",
        action: dupEvent ? "skip" : "calendar",
      };
    });

    if (errors.length) setBulkErr(`Imported what I could. Skipped: ${errors.join("; ")}`);
    setBulkPreview(reviewed);
  };

  const updateRowAction = (tempId, action) => setBulkPreview(rows => rows.map(r => r.tempId === tempId ? { ...r, action } : r));

  const confirmBulkImport = () => {
    if (!bulkPreview?.length) return;
    setBulkSaving(true);
    const toCalendar = bulkPreview.filter(r => r.action === "calendar").map(r => ({
      id: crypto.randomUUID(), title: r.title, notes: "Imported from calendar screenshot",
      start_time: r.allDay || !r.time ? new Date(`${r.date}T00:00:00`).toISOString() : new Date(`${r.date}T${r.time}:00`).toISOString(),
      all_day: r.allDay || !r.time,
    }));
    const toBirthdays = bulkPreview.filter(r => r.action === "birthday").map(r => ({
      id: crypto.randomUUID(), name: r.title.replace(/'s birthday|birthday|bday/gi, "").trim() || r.title, month: r.month, day: r.day, year: r.year || null,
    }));
    Promise.all([
      toCalendar.length ? db.saveEventsBulk(toCalendar) : Promise.resolve(),
      toBirthdays.length ? db.saveBirthdaysBulk(toBirthdays) : Promise.resolve(),
    ]).then(() => {
      setBulkSaving(false); setBulkPreview(null); setBulkImages([]); setBulkOpen(false); refresh();
    }).catch(e => { setBulkSaving(false); setBulkErr(e.message || "Couldn't save the batch."); });
  };

  const todayStr = new Date().toISOString().slice(0, 10);

  const catColor = (key) => (EVENT_CATEGORIES.find(c => c.key === key) || EVENT_CATEGORIES[0]).color;

  const blankDraft = (presetDate) => ({
    id: crypto.randomUUID(), title: "", notes: "", location: "", category: "personal",
    date: presetDate || todayStr, time: "09:00", endTime: "", allDay: false,
  });

  const openNew = (presetDate) => { setSaveErr(null); setForm(blankDraft(presetDate)); };
  const openEdit = (ev) => {
    setSaveErr(null);
    const d = new Date(ev.start_time);
    setForm({
      id: ev.id, title: ev.title, notes: ev.notes || "", allDay: ev.all_day,
      location: ev.location || "", category: ev.category || "personal",
      date: d.toISOString().slice(0, 10),
      time: ev.all_day ? "09:00" : d.toTimeString().slice(0, 5),
      endTime: ev.end_time ? new Date(ev.end_time).toTimeString().slice(0, 5) : "",
    });
  };
  const closeForm = () => setForm(null);

  const save = () => {
    if (!form.title.trim()) { setSaveErr("Give it a title."); return; }
    const start_time = form.allDay
      ? new Date(`${form.date}T00:00:00`).toISOString()
      : new Date(`${form.date}T${form.time}:00`).toISOString();
    const end_time = (!form.allDay && form.endTime) ? new Date(`${form.date}T${form.endTime}:00`).toISOString() : null;
    setSaving(true);
    setSaveErr(null);
    db.saveEvent({ id: form.id, title: form.title.trim(), notes: form.notes, start_time, end_time, all_day: form.allDay, location: form.location, category: form.category })
      .then(() => { setSaving(false); closeForm(); refresh(); })
      .catch(e => { setSaving(false); setSaveErr(e.message || "Couldn't save."); });
  };

  const removeEvent = (id, e) => {
    e.stopPropagation();
    if (!window.confirm("Delete this event?")) return;
    db.deleteEvent(id).then(() => { if (form?.id === id) closeForm(); refresh(); });
  };

  const dayLabel = (iso) => {
    const d = new Date(iso);
    const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dayStart - today) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays === -1) return "Yesterday";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };
  const timeLabel = (iso, allDay) => allDay ? "All day" : new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  // ─── Form (add/edit) ───
  if (form) {
    return (
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <button onClick={closeForm} style={{ background: "none", border: "none", color: T.brass, fontFamily: syne, fontWeight: 700, fontSize: 12, cursor: "pointer", padding: 0 }}>‹ Cancel</button>
          <span style={S.title}>{events?.some(e => e.id === form.id) ? "Edit event" : "New event"}</span>
          <span style={{ width: 50 }} />
        </div>

        <input
          value={form.title}
          onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          placeholder="Event title"
          style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 14, fontWeight: 700, fontFamily: syne, marginBottom: 10 }}
        />

        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          {EVENT_CATEGORIES.map(c => (
            <button key={c.key} onClick={() => setForm(f => ({ ...f, category: c.key }))}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 999, fontSize: 10.5, fontWeight: 700, fontFamily: syne, cursor: "pointer",
                border: `1px solid ${form.category === c.key ? c.color : T.line}`, background: form.category === c.key ? c.color + "1A" : "transparent", color: form.category === c.key ? c.color : T.sub }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.color }} />
              {c.label}
            </button>
          ))}
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 11.5, color: T.sub, cursor: "pointer" }}>
          <input type="checkbox" checked={form.allDay} onChange={e => setForm(f => ({ ...f, allDay: e.target.checked }))} />
          All-day
        </label>

        <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            style={{ ...S.input, flex: "1 1 130px", padding: "9px 10px", fontSize: 13, fontFamily: mono }} />
          {!form.allDay && (
            <>
              <input type="time" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))}
                style={{ ...S.input, flex: "1 1 90px", padding: "9px 10px", fontSize: 13, fontFamily: mono }} />
              <input type="time" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                placeholder="End (optional)" title="End time (optional)"
                style={{ ...S.input, flex: "1 1 90px", padding: "9px 10px", fontSize: 13, fontFamily: mono }} />
            </>
          )}
        </div>

        <input
          value={form.location}
          onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
          placeholder="Location (optional)"
          style={{ ...S.input, width: "100%", padding: "9px 12px", fontSize: 13, marginBottom: 10 }}
        />

        <textarea
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          placeholder="Notes (optional)"
          rows={4}
          style={{ ...S.input, width: "100%", padding: "10px 12px", fontSize: 13, lineHeight: 1.6, resize: "vertical", marginBottom: 10 }}
        />

        {saveErr && <div style={{ fontSize: 11, color: "#B23A2E", marginBottom: 8 }}>{saveErr}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...S.brassBtn, padding: "9px 18px", fontSize: 12, opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save"}
          </button>
          {events?.some(e => e.id === form.id) && (
            <button onClick={(e) => removeEvent(form.id, e)} style={{ ...S.ghostBtn, padding: "9px 14px", fontSize: 12 }}>Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ─── Agenda list ───

  const renderEvent = (ev) => (
    <div key={ev.id} onClick={() => openEdit(ev)}
      style={{ ...S.inner, padding: "10px 12px", cursor: "pointer", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: catColor(ev.category), flex: "none" }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, color: T.ink }}>{ev.title}</span>
        </div>
        <div style={{ fontSize: 11, color: T.sub }}>
          {dayLabel(ev.start_time)} · {timeLabel(ev.start_time, ev.all_day)}{ev.end_time && !ev.all_day ? `–${new Date(ev.end_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
          {ev.location ? ` · ${ev.location}` : ""}
        </div>
        {ev.notes && <div style={{ fontSize: 10.5, color: T.faint, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ev.notes}</div>}
      </div>
      <button onClick={(e) => removeEvent(ev.id, e)} aria-label="Delete event" style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 14, padding: 2, lineHeight: 1, flex: "none" }}>×</button>
    </div>
  );

  // ─── Month grid ───
  const gridYear = viewMonth.getFullYear(), gridMonth = viewMonth.getMonth();
  const firstOfMonth = new Date(gridYear, gridMonth, 1);
  const daysInMonth = new Date(gridYear, gridMonth + 1, 0).getDate();
  const leadingBlanks = firstOfMonth.getDay(); // 0 = Sunday
  const cells = [...Array(leadingBlanks).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const eventsByDay = {}; // "YYYY-MM-DD" -> [events]
  (events || []).forEach(ev => {
    const key = ev.start_time.slice(0, 10);
    (eventsByDay[key] = eventsByDay[key] || []).push(ev);
  });
  const dateKey = (day) => `${gridYear}-${String(gridMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const isToday = (day) => dateKey(day) === todayStr;
  const monthLabel = viewMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const changeMonth = (delta) => setViewMonth(new Date(gridYear, gridMonth + delta, 1));

  const selectedDayEvents = selectedDay ? (eventsByDay[selectedDay] || []).sort((a, b) => new Date(a.start_time) - new Date(b.start_time)) : [];
  const selectedDayLabel = selectedDay ? new Date(`${selectedDay}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "";

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <span style={S.title}>Calendar</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setBulkOpen(o => !o)} style={{ ...S.ghostBtn, padding: "7px 14px", fontSize: 11.5 }}>{bulkOpen ? "Close import" : "Import screenshots"}</button>
          <button onClick={() => openNew(selectedDay)} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11.5 }}>+ Add event</button>
        </div>
      </div>

      {bulkOpen && (
        <div style={{ ...S.inner, padding: 12, marginBottom: 12 }}>
          {!bulkPreview ? (
            <>
              <div style={{ fontSize: 10.5, color: T.sub, lineHeight: 1.6, marginBottom: 10 }}>
                Upload screenshots of your old calendar — one per month works well. Claude reads each one, and anything
                that looks like a birthday gets checked against your Birthdays list automatically so you don't end up
                with duplicates. You'll review everything before it's saved.
              </div>

              <label style={{ display: "inline-block", ...S.ghostBtn, padding: "8px 16px", fontSize: 11.5, marginBottom: 10, cursor: "pointer" }}>
                Choose images
                <input type="file" accept="image/*" multiple onChange={e => { addImages(e.target.files); e.target.value = ""; }} style={{ display: "none" }} />
              </label>

              {bulkImages.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                  {bulkImages.map(img => (
                    <div key={img.id} style={{ position: "relative", width: 64, height: 64, borderRadius: 8, overflow: "hidden", border: `1px solid ${T.line}` }}>
                      <img src={img.dataUrl} alt={img.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      <button onClick={() => removeImage(img.id)} aria-label="Remove"
                        style={{ position: "absolute", top: 2, right: 2, width: 18, height: 18, borderRadius: "50%", border: "none", background: "rgba(34,29,20,0.75)", color: "#fff", fontSize: 11, cursor: "pointer", lineHeight: 1 }}>×</button>
                    </div>
                  ))}
                </div>
              )}

              {bulkErr && <div style={{ fontSize: 11, color: "#B23A2E", marginBottom: 8 }}>{bulkErr}</div>}

              <button onClick={parseBulkImages} disabled={bulkParsing || !bulkImages.length} style={{ ...S.brassBtn, padding: "8px 16px", fontSize: 11.5, opacity: (bulkParsing || !bulkImages.length) ? 0.55 : 1 }}>
                {bulkParsing ? `Reading ${bulkImages.length} image${bulkImages.length === 1 ? "" : "s"}…` : `Parse ${bulkImages.length || ""} image${bulkImages.length === 1 ? "" : "s"}`}
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 10.5, color: T.sub, marginBottom: 8 }}>Found {bulkPreview.length} — review the action for each, then confirm.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10, maxHeight: 320, overflowY: "auto" }}>
                {bulkPreview.map(r => (
                  <div key={r.tempId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontFamily: syne, fontWeight: 700, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                      <div style={{ fontSize: 10, color: T.sub, fontFamily: mono }}>
                        {r.date}{r.time ? ` · ${r.time}` : ""}
                        {r.kind === "duplicate_birthday" && ` · already in Birthdays as "${r.matchedName}"`}
                        {r.kind === "new_birthday" && " · looks like a new birthday"}
                        {r.kind === "duplicate_event" && " · looks like it's already on your calendar"}
                      </div>
                    </div>
                    <select value={r.action} onChange={e => updateRowAction(r.tempId, e.target.value)}
                      style={{ ...S.input, fontSize: 11, padding: "5px 8px", flex: "none" }}>
                      <option value="calendar">Add to Calendar</option>
                      <option value="birthday">Add to Birthdays</option>
                      <option value="skip">Skip</option>
                    </select>
                  </div>
                ))}
              </div>
              {bulkErr && <div style={{ fontSize: 11, color: "#B23A2E", marginBottom: 8 }}>{bulkErr}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={confirmBulkImport} disabled={bulkSaving} style={{ ...S.brassBtn, padding: "8px 16px", fontSize: 11.5, opacity: bulkSaving ? 0.6 : 1 }}>
                  {bulkSaving ? "Saving…" : `Confirm (${bulkPreview.filter(r => r.action !== "skip").length})`}
                </button>
                <button onClick={() => { setBulkPreview(null); setBulkErr(null); }} style={{ ...S.ghostBtn, padding: "8px 14px", fontSize: 11.5 }}>Start over</button>
              </div>
            </>
          )}
        </div>
      )}

      {loadErr && <div style={{ fontSize: 11.5, color: T.faint, padding: "20px 0", textAlign: "center" }}>{loadErr}</div>}
      {!loadErr && events === null && <div style={{ fontSize: 11.5, color: T.faint, padding: "20px 0", textAlign: "center", animation: "pulse 1.4s infinite" }}>Loading calendar…</div>}

      {!loadErr && events !== null && !bulkOpen && selectedDay === null && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <button onClick={() => changeMonth(-1)} aria-label="Previous month" style={{ background: "none", border: `1px solid ${T.line}`, borderRadius: 8, width: 30, height: 30, color: T.sub, cursor: "pointer", fontSize: 14 }}>‹</button>
            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: syne, color: T.ink }}>{monthLabel}</span>
            <button onClick={() => changeMonth(1)} aria-label="Next month" style={{ background: "none", border: `1px solid ${T.line}`, borderRadius: 8, width: 30, height: 30, color: T.sub, cursor: "pointer", fontSize: 14 }}>›</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, marginBottom: 4 }}>
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <div key={i} style={{ textAlign: "center", fontSize: 9.5, fontWeight: 700, color: T.faint, fontFamily: mono, padding: "2px 0" }}>{d}</div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
            {cells.map((day, i) => {
              if (day === null) return <div key={`b${i}`} />;
              const key = dateKey(day);
              const dayEvents = eventsByDay[key] || [];
              const todayFlag = isToday(day);
              return (
                <div key={key} onClick={() => openNew(key)}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2, textAlign: "left",
                    borderRadius: 8, cursor: "pointer", padding: "4px 3px", minHeight: 56,
                    border: todayFlag ? `1.5px solid ${T.brass}` : "1px solid transparent",
                    background: todayFlag ? "rgba(143,107,30,0.08)" : "transparent",
                  }}>
                  <span style={{ fontSize: 10.5, fontWeight: todayFlag ? 800 : 500, color: todayFlag ? T.brass : T.ink, fontFamily: mono, paddingLeft: 2, marginBottom: 1 }}>{day}</span>
                  {dayEvents.slice(0, 2).map((ev, j) => (
                    <span key={j} onClick={(e) => { e.stopPropagation(); openEdit(ev); }}
                      style={{ fontSize: 8, fontWeight: 700, color: "#FFFFFF", background: catColor(ev.category), borderRadius: 4, padding: "1.5px 4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.5, marginBottom: 1, cursor: "pointer" }}>{ev.title}</span>
                  ))}
                  {dayEvents.length > 2 && (
                    <span onClick={(e) => { e.stopPropagation(); setSelectedDay(key); }}
                      style={{ fontSize: 7.5, color: T.faint, paddingLeft: 2, fontFamily: mono, cursor: "pointer" }}>+{dayEvents.length - 2} more</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!loadErr && events !== null && !bulkOpen && selectedDay !== null && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <button onClick={() => setSelectedDay(null)} style={{ background: "none", border: "none", color: T.brass, fontFamily: syne, fontWeight: 700, fontSize: 12, cursor: "pointer", padding: 0 }}>‹ {monthLabel}</button>
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, color: T.ink, marginBottom: 10 }}>{selectedDayLabel}</div>
          {selectedDayEvents.length === 0 ? (
            <div style={{ fontSize: 11.5, color: T.faint, padding: "16px 0", textAlign: "center" }}>Nothing yet — tap "+ Add event" to add something.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {selectedDayEvents.map(renderEvent)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page: Properties ────────────────────────────────────────────────────────
function PropertiesPage({ isMobile, settings, updateSetting, session }) {
  const [status, setStatus] = useState({});
  useEffect(() => {
    let alive = true;
    const urls = PROPERTIES.map(p => p.url || p.appUrl).filter(Boolean);
    callFn("site-status", { urls }).then(d => {
      if (!alive || !d?.success) return;
      const map = {};
      d.results.forEach(r => { map[r.url] = r; });
      setStatus(map);
    });
    return () => { alive = false; };
  }, []);
  const card = isMobile ? S.cardM : S.card;
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "18px 16px 24px" : "30px 34px 40px" }}>
      <div style={{ maxWidth: 920, margin: "0 auto", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 10 : 14 }}>
        {PROPERTIES.map((p, i) => {
          const key = p.url || p.appUrl;
          const s = status[key];
          const pillColor = !s ? T.faint : s.up ? T.green : T.red;
          const pillText = !s ? "CHECKING…" : s.up ? "● LIVE" : `● DOWN (${s.status || "unreachable"})`;
          return (
          <div key={i} style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: p.color, flex: "none", boxShadow: `0 0 10px ${p.color}66` }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, fontFamily: syne, color: T.ink }}>{p.name}</span>
                <span style={{ fontSize: 10.5, color: T.faint }}>{p.desc}</span>
              </span>
              <span style={{ marginLeft: "auto", fontSize: 8.5, color: pillColor, fontFamily: mono, letterSpacing: "0.06em", flex: "none", whiteSpace: "nowrap" }}>{pillText}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {p.url && <a href={p.url} target="_blank" rel="noopener" style={{ flex: 1, padding: 10, textAlign: "center", background: "rgba(34,29,20,0.05)", border: `1px solid rgba(34,29,20,0.1)`, borderRadius: 10, color: p.color, fontSize: 11, fontWeight: 700, textDecoration: "none" }}>Site ›</a>}
              <a href={p.appUrl} target="_blank" rel="noopener" style={{ flex: 1, padding: 10, textAlign: "center", background: "rgba(34,29,20,0.05)", border: `1px solid rgba(34,29,20,0.1)`, borderRadius: 10, color: T.sub, fontSize: 11, fontWeight: 600, textDecoration: "none" }}>Command Center ›</a>
            </div>
          </div>
          );
        })}
        <div style={{ gridColumn: isMobile ? "auto" : "1 / -1" }}>
          <AuditorCard settings={settings} updateSetting={updateSetting} session={session} isMobile={isMobile} />
        </div>
      </div>
    </div>
  );
}

// ─── Page: Systems (deploy, database, status, usage) ──────────────────────────
async function auditProperty(p, token, ask) {
  const data = await callFn("audit", { name: p.name, url: p.url || p.appUrl, repo: p.repo, ask }, token ? { Authorization: `Bearer ${token}` } : undefined);
  return data?.success ? data.findings : [];
}

function AuditorCard({ settings, updateSetting, session, isMobile }) {
  const [findings, setFindings] = useState([]);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState("");
  const enabled = !!settings?.auditor_enabled;
  const lastRun = settings?.auditor_last_run || null;

  // Fix proposals — read-only until Approve & Commit is clicked explicitly.
  const [fixProp, setFixProp] = useState(PROPERTIES[0]?.name || "");
  const [fixInstruction, setFixInstruction] = useState("");
  const [fixBusy, setFixBusy] = useState(false);
  const [fixProposal, setFixProposal] = useState(null);
  const [fixExpanded, setFixExpanded] = useState(false);
  const [fixError, setFixError] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(null);

  useEffect(() => {
    let alive = true;
    db.loadFindings().then(f => { if (alive) setFindings(f); });
    return () => { alive = false; };
  }, []);

  const runAll = async (customAsk) => {
    setRunning(true);
    const results = [];
    for (const p of PROPERTIES) {
      const fs = await auditProperty(p, session?.access_token, customAsk);
      fs.forEach(f => results.push({ ...f, property: p.name, ts: Date.now() }));
    }
    await db.saveFindings(results);
    setFindings(prev => [...results, ...prev].slice(0, 40));
    updateSetting("auditor_last_run", Date.now());
    setRunning(false);
    setOpen(true);
  };

  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(() => {
      const last = settings?.auditor_last_run || 0;
      if (Date.now() - last > 6 * 3600 * 1000) runAll();
    }, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [enabled, settings?.auditor_last_run]);

  const proposeFix = async () => {
    const instruction = fixInstruction.trim();
    const p = PROPERTIES.find(x => x.name === fixProp);
    if (!instruction || !p?.repo || fixBusy) return;
    setFixBusy(true); setFixError(null); setFixProposal(null); setCommitted(null);
    const data = await callFn("auto-fix", { action: "propose", repo: p.repo, instruction });
    if (data?.success) setFixProposal({ ...data, repo: p.repo, site: p.name });
    else setFixError(data?.error || "couldn't propose a fix");
    setFixBusy(false);
  };
  const commitFix = async () => {
    if (!fixProposal || committing) return;
    setCommitting(true); setFixError(null);
    const data = await callFn("auto-fix", { action: "commit", repo: fixProposal.repo, path: fixProposal.path, content: fixProposal.after, message: `Fix via Board Room auditor: ${fixInstruction.trim().slice(0, 60)}` });
    if (data?.success) { setCommitted(data); setFixProposal(null); setFixInstruction(""); setFixExpanded(false); }
    else setFixError(data?.error || "commit failed");
    setCommitting(false);
  };
  const discardFix = () => { setFixProposal(null); setFixExpanded(false); };

  const propColor = (name) => (PROPERTIES.find(p => p.name === name) || {}).color || T.sub;
  const sevColor = { high: T.red, medium: T.amber, low: T.sub };
  const ago = (ts) => { if (!ts) return "NEVER"; const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? "JUST NOW" : m < 60 ? `${m}M AGO` : `${Math.floor(m / 60)}H AGO`; };

  return (
    <div style={isMobile ? S.cardM : S.card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
        <span style={S.title}>Site Auditor</span>
        <Toggle on={enabled} onToggle={() => updateSetting("auditor_enabled", !enabled)} size={isMobile ? 24 : 20} />
      </div>
      <button onClick={() => runAll()} disabled={running} style={{ width: "100%", padding: isMobile ? 12 : 10, background: running ? "rgba(34,29,20,0.05)" : "rgba(143,107,30,0.12)", border: `1px solid ${running ? T.line : "rgba(143,107,30,0.3)"}`, borderRadius: 10, color: running ? T.faint : T.brass, fontSize: 11, fontWeight: 700, cursor: running ? "default" : "pointer", fontFamily: syne, marginBottom: 9 }}>
        {running ? "Auditing all properties…" : "Run audit now"}
      </button>
      <div style={{ display: "flex", gap: 8, marginBottom: 9 }}>
        <input value={ask} onChange={e => setAsk(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (ask.trim() && !running) runAll(ask.trim()); } }} placeholder="Ask something specific (optional) — e.g. check for broken nav links"
          style={{ ...S.input, flex: 1, padding: "9px 11px", fontSize: 10.5 }} disabled={running} />
        <button onClick={() => ask.trim() && runAll(ask.trim())} disabled={running || !ask.trim()} style={{ ...S.ghostBtn, padding: "0 14px", minHeight: 38, fontSize: 10, opacity: running || !ask.trim() ? 0.5 : 1 }}>Ask</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={S.microLabel}>LAST RUN {ago(lastRun)}</span>
        <button onClick={() => setOpen(!open)} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, padding: "2px 0", color: T.sub, fontSize: 10, fontWeight: 600 }}>
          {findings.length} findings <span style={{ color: T.brass, fontSize: 9 }}>{open ? "▲" : "▼"}</span>
        </button>
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10, maxHeight: 230, overflowY: "auto" }}>
          {findings.length === 0 && <div style={{ fontSize: 10, color: T.faint, textAlign: "center", padding: "8px 0" }}>No findings yet.</div>}
          {findings.slice(0, 12).map((f, i) => (
            <div key={i} style={{ padding: "10px 12px", background: "rgba(34,29,20,0.045)", borderRadius: 10, border: "1px solid rgba(34,29,20,0.05)", borderLeft: `2px solid ${sevColor[f.severity] || T.sub}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: propColor(f.property), fontFamily: syne }}>{f.property}</span>
                <span style={{ fontSize: 8, color: sevColor[f.severity] || T.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>{f.severity}</span>
              </div>
              <div style={{ fontSize: 10.5, color: T.ink, lineHeight: 1.5 }}>{f.finding}</div>
              <div style={{ fontSize: 10, color: T.sub, lineHeight: 1.5, marginTop: 3, fontStyle: "italic" }}>→ {f.suggestion}</div>
              <button onClick={() => { setFixProp(f.property); setFixInstruction(`${f.finding} ${f.suggestion}`); setFixProposal(null); setFixError(null); setCommitted(null); }} style={{ background: "none", border: "none", color: T.brass, fontSize: 9, fontWeight: 700, cursor: "pointer", padding: "5px 0 0" }}>Propose fix →</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ height: 1, background: T.line, margin: "13px 0 11px" }} />

      <div style={{ fontSize: 9.5, fontWeight: 700, color: T.brass, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: syne, marginBottom: 7 }}>Propose a Fix</div>
      <div style={{ fontSize: 9.5, color: T.faint, lineHeight: 1.5, marginBottom: 9 }}>Commits straight to the site's repo — nothing goes live until you approve. Works for the static template (meta tags, title, robots.txt, sitemap) — not page content rendered by app code yet.</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {PROPERTIES.filter(p => p.repo).map(p => (
          <button key={p.name} onClick={() => setFixProp(p.name)} style={{ padding: "6px 11px", background: fixProp === p.name ? "rgba(143,107,30,0.14)" : "rgba(34,29,20,0.035)", border: `1px solid ${fixProp === p.name ? "rgba(143,107,30,0.4)" : "rgba(34,29,20,0.09)"}`, borderRadius: 12, color: fixProp === p.name ? T.brass : T.sub, fontSize: 9.5, fontWeight: 700, cursor: "pointer", fontFamily: syne }}>{p.name}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={fixInstruction} onChange={e => setFixInstruction(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); proposeFix(); } }} placeholder="e.g. add a meta description mentioning steel seed phrase backup"
          style={{ ...S.input, flex: 1, padding: "9px 11px", fontSize: 10.5 }} disabled={fixBusy} />
        <button onClick={proposeFix} disabled={fixBusy || !fixInstruction.trim()} style={{ ...S.ghostBtn, padding: "0 14px", minHeight: 38, fontSize: 10, opacity: fixBusy || !fixInstruction.trim() ? 0.5 : 1 }}>{fixBusy ? "…" : "Propose"}</button>
      </div>
      {fixError && <div style={{ fontSize: 10.5, color: T.red, lineHeight: 1.5, marginTop: 9 }}>{fixError}</div>}
      {committed && <div style={{ fontSize: 10.5, color: T.green, lineHeight: 1.5, marginTop: 9 }}>✓ {committed.message}</div>}
      {fixProposal && (
        <div style={{ background: "rgba(34,29,20,0.045)", border: "1px solid rgba(34,29,20,0.08)", borderRadius: 10, padding: "11px 13px", marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ fontSize: 10.5, color: T.ink, fontWeight: 700, fontFamily: mono }}>{fixProposal.path}</span>
            <span style={{ fontSize: 9, color: propColor(fixProposal.site), fontFamily: syne, fontWeight: 700 }}>{fixProposal.site}</span>
          </div>
          <div style={{ fontSize: 10.5, color: T.sub, lineHeight: 1.5, marginBottom: 8 }}>{fixProposal.note}</div>
          <button onClick={() => setFixExpanded(!fixExpanded)} style={{ background: "none", border: "none", color: T.brass, fontSize: 9.5, cursor: "pointer", padding: 0, marginBottom: fixExpanded ? 8 : 0 }}>{fixExpanded ? "Hide full file ▲" : "Show full file ▼"}</button>
          {fixExpanded && <pre style={{ background: "rgba(34,29,20,0.05)", border: "1px solid rgba(34,29,20,0.06)", borderRadius: 9, padding: "10px 12px", fontSize: 9.5, fontFamily: mono, color: T.sub, lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", marginBottom: 8 }}>{fixProposal.after}</pre>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={commitFix} disabled={committing} style={{ ...S.brassBtn, flex: 1, padding: "9px 0", fontSize: 10.5, opacity: committing ? 0.6 : 1 }}>{committing ? "Committing…" : "Approve & Commit"}</button>
            <button onClick={discardFix} disabled={committing} style={{ flex: "none", padding: "9px 16px", background: "transparent", border: `1px solid rgba(34,29,20,0.12)`, borderRadius: 10, color: T.sub, fontSize: 10.5, fontWeight: 600, cursor: "pointer" }}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Usage — durable, cross-device log of every Anthropic call and every
// Netlify function hit, read from usage_log (populated by callClaude/callFn
// client-side, plus mini-worker and audit server-side for scheduled/
// cost-bearing calls those make outside a browser session).
const USAGE_WINDOWS = [["24h", 1], ["7d", 7], ["30d", 30], ["All", 3650]];
function UsageCard({ isMobile }) {
  const [summary, setSummary] = useState(null); // null = loading; accurate totals via server-side aggregation, not capped by row count
  const [recentRows, setRecentRows] = useState(null); // separate, smaller fetch — only for the raw log detail view below
  const [err, setErr] = useState(null);
  const [windowIdx, setWindowIdx] = useState(1);
  const [showLog, setShowLog] = useState(false);

  const load = async () => {
    setSummary(null); setRecentRows(null); setErr(null);
    const since = new Date(Date.now() - USAGE_WINDOWS[windowIdx][1] * 86400000).toISOString();
    try {
      // Real fix: this used to be one row-capped select that both summed
      // totals AND fed the log view. At this app's actual call volume, the
      // cap meant 7d/30d/All silently showed the same few hours of data as
      // 24h. Aggregating in Postgres removes the row-count ceiling from the
      // numbers that matter (spend, calls, tokens); the raw log below is
      // still capped, but that's fine — nobody needs to scroll thousands of
      // individual lines, only the totals needed to be exact.
      const { data, error } = await supabase.rpc("usage_summary", { since_ts: since });
      if (error) { setErr(error.message.includes("usage_summary") ? "Run supabase-usage-fix.sql in the Supabase SQL editor to enable accurate totals." : error.message); setSummary([]); return; }
      setSummary(data || []);
    } catch { setErr("usage log unavailable"); setSummary([]); }
    supabase.from("usage_log").select("fn,kind,model,in_tokens,out_tokens,cost_usd,ms,ok,detail,created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(300)
      .then(({ data }) => setRecentRows(data || []));
  };
  useEffect(() => { load(); }, [windowIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  const card = isMobile ? S.cardM : S.card;
  const totalCalls = summary?.reduce((s, r) => s + Number(r.calls), 0) || 0;
  const failed = summary?.reduce((s, r) => s + Number(r.failed), 0) || 0;
  const anthropicRows = summary?.filter(r => r.kind === "anthropic") || [];
  const totalCost = anthropicRows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  const totalIn = anthropicRows.reduce((s, r) => s + Number(r.in_tokens || 0), 0);
  const totalOut = anthropicRows.reduce((s, r) => s + Number(r.out_tokens || 0), 0);
  const byFn = {};
  (summary || []).forEach(r => {
    byFn[r.fn] = byFn[r.fn] || { calls: 0, cost: 0, failed: 0 };
    byFn[r.fn].calls += Number(r.calls);
    byFn[r.fn].cost += Number(r.cost_usd || 0);
    byFn[r.fn].failed += Number(r.failed);
  });
  const topFns = Object.entries(byFn).sort((a, b) => (b[1].cost - a[1].cost) || (b[1].calls - a[1].calls)).slice(0, 8);
  const fmtK = (n) => n > 999 ? (n / 1000).toFixed(1) + "K" : String(n);
  const ago = (ts) => { const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000); if (s < 60) return `${s}S`; if (s < 3600) return `${Math.floor(s / 60)}M`; if (s < 86400) return `${Math.floor(s / 3600)}H`; return `${Math.floor(s / 86400)}D`; };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={S.title}>Usage</span>
        <div style={{ display: "flex", gap: 4 }}>
          {USAGE_WINDOWS.map(([label], i) => (
            <button key={label} onClick={() => setWindowIdx(i)} style={{ padding: "4px 9px", background: windowIdx === i ? "rgba(143,107,30,0.16)" : "transparent", border: `1px solid ${windowIdx === i ? "rgba(143,107,30,0.4)" : "rgba(34,29,20,0.1)"}`, borderRadius: 8, color: windowIdx === i ? T.brass : T.faint, fontSize: 9.5, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>{label}</button>
          ))}
        </div>
      </div>

      {err && <div style={{ fontSize: 10.5, color: T.amber, lineHeight: 1.5, padding: "8px 0" }}>{err}</div>}

      {!err && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 7, marginBottom: 13 }}>
            <StatBox value={summary === null ? "…" : "$" + totalCost.toFixed(3)} label="Anthropic spend" valueColor={T.brass} />
            <StatBox value={summary === null ? "…" : String(totalCalls)} label="total calls" />
            <StatBox value={summary === null ? "…" : `${fmtK(totalIn)}/${fmtK(totalOut)}`} label="tokens in/out" />
            <StatBox value={summary === null ? "…" : String(failed)} label="failed calls" valueColor={failed ? T.red : T.green} />
          </div>

          <div style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(143,107,30,0.8)", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: syne, marginBottom: 8 }}>By feature</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 13 }}>
            {summary === null && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "8px 0" }}>Loading…</div>}
            {summary !== null && topFns.length === 0 && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "8px 0" }}>No calls logged in this window yet.</div>}
            {topFns.map(([fn, s]) => (
              <div key={fn} style={{ ...S.inner, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px" }}>
                <span style={{ fontSize: 10.5, color: "#3A3323", fontFamily: mono, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fn}</span>
                {s.failed > 0 && <span style={{ fontSize: 8.5, color: T.red, fontFamily: mono, flex: "none" }}>{s.failed} FAILED</span>}
                <span style={{ fontSize: 9.5, color: T.faint, fontFamily: mono, flex: "none" }}>{s.calls} calls</span>
                <span style={{ fontSize: 10.5, color: T.brass, fontFamily: mono, fontWeight: 700, flex: "none", width: 56, textAlign: "right" }}>{s.cost > 0 ? "$" + s.cost.toFixed(3) : "—"}</span>
              </div>
            ))}
          </div>

          <button onClick={() => setShowLog(!showLog)} style={{ width: "100%", padding: 9, background: "rgba(34,29,20,0.03)", border: `1px solid rgba(34,29,20,0.08)`, borderRadius: 9, color: T.sub, fontSize: 10.5, fontWeight: 600, cursor: "pointer", marginBottom: showLog ? 9 : 0 }}>
            {showLog ? "Hide recent log ▲" : `Show recent log (up to 300) ▼`}
          </button>
          {showLog && (
            <div style={{ background: "rgba(34,29,20,0.045)", border: "1px solid rgba(34,29,20,0.05)", borderRadius: 10, maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column" }}>
              {recentRows === null && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "14px 0" }}>Loading…</div>}
              {(recentRows || []).map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 11px", borderBottom: i < recentRows.length - 1 ? "1px solid rgba(34,29,20,0.04)" : "none" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: r.ok ? T.green : T.red, flex: "none" }} />
                  <span style={{ fontSize: 9, color: T.faint, fontFamily: mono, flex: "none", width: 32 }}>{ago(r.created_at)}</span>
                  <span style={{ fontSize: 10, color: "#3A3323", fontFamily: mono, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.fn}{r.model ? ` · ${r.model}` : ""}{!r.ok && r.detail ? ` · ${r.detail}` : ""}</span>
                  <span style={{ fontSize: 9, color: T.faint, fontFamily: mono, flex: "none" }}>{r.ms ? `${r.ms}ms` : ""}</span>
                  <span style={{ fontSize: 9.5, color: T.brass, fontFamily: mono, flex: "none", width: 48, textAlign: "right" }}>{r.cost_usd ? "$" + r.cost_usd.toFixed(4) : ""}</span>
                </div>
              ))}
              {recentRows?.length === 0 && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "14px 0" }}>Nothing logged yet.</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const IS_DEPLOYED = typeof window !== "undefined" && window.location.hostname !== "localhost";

const CONN_GROUPS = [
  { title: "Core", keys: ["supabase_env", "supabase_auth", "supabase_db"] },
  { title: "AI", keys: ["anthropic"] },
  { title: "Market Data", keys: ["coingecko"] },
  { title: "Netlify Functions", keys: ["fn_health", "fn_mini", "fn_btc", "fn_btc_candles", "fn_markets", "fn_wire", "fn_sports", "fn_sports_detail", "fn_tmdb", "fn_export_data", "fn_calendar", "fn_calendar_events", "fn_site_status", "fn_gsc", "fn_shopify", "fn_clarify_pipeline", "fn_zts_pipeline", "fn_deploy", "fn_dbadmin", "fn_audit", "fn_autofix"] },
];
const CONN_META = {
  supabase_env: { name: "Supabase · config", desc: "VITE_SUPABASE_URL + anon key present at build time" },
  supabase_auth: { name: "Supabase · auth", desc: "active session for this device" },
  supabase_db: { name: "Supabase · database", desc: "read against chat_messages (tables + RLS)" },
  anthropic: { name: "Anthropic API", desc: IS_DEPLOYED ? "via /.netlify/functions/claude proxy" : "direct from localhost with VITE_ANTHROPIC_API_KEY" },
  coingecko: { name: "CoinGecko", desc: "upstream BTC source — reached via the btc proxy, not directly from the browser" },
  fn_health: { name: "health", desc: "reports which server-side keys are configured" },
  fn_mini: { name: "mini-worker", desc: "Mini Me engine — nightly at ~3 AM CT + on-demand runs" },
  fn_btc: { name: "btc", desc: "proxies BTC price + sparkline — avoids mobile-carrier IP rate limiting" },
  fn_btc_candles: { name: "btc-candles", desc: "BTC/USD candles via Kraken public API (5m/15m/30m/1d/1w) — no key needed" },
  fn_markets: { name: "markets", desc: "S&P/Nasdaq futures, 10Y yield, DXY via Yahoo's public endpoint (unofficial)" },
  fn_calendar: { name: "calendar", desc: "US econ calendar, today through +7 days (unofficial free feed)" },
  fn_calendar_events: { name: "calendar-events", desc: "upcoming meetings — parses the linked iCal URL" },
  fn_clarify_pipeline: { name: "clarify-pipeline", desc: "Clarify Outreach pipeline stats (own Supabase project)" },
  fn_zts_pipeline: { name: "zts-pipeline", desc: "ZTS creator pipeline stats (own Supabase project)" },
  fn_site_status: { name: "site-status", desc: "uptime check behind the Properties page's live/down pill" },
  fn_gsc: { name: "gsc", desc: "Search Console · zerotosecure.com last 14d" },
  fn_shopify: { name: "shopify", desc: "Shopify Admin API · orders last 14d" },
  fn_wire: { name: "wire", desc: "CoinDesk + Cointelegraph RSS · tagged headlines" },
  fn_sports: { name: "sports", desc: "ESPN scoreboard · followed teams, significant games, watch list" },
  fn_sports_detail: { name: "sports-detail", desc: "on-demand per-game detail, only called on tap" },
  fn_tmdb: { name: "tmdb", desc: "movie search for poster/year lookup — optional, not required for Movies tab" },
  fn_export_data: { name: "export-data", desc: "local backup export — service-role read of all personal tables" },
  fn_deploy: { name: "deploy", desc: "Netlify API · trigger builds per property" },
  fn_dbadmin: { name: "db-admin", desc: "service-role maintenance, allowlisted commands" },
  fn_audit: { name: "audit", desc: "AI site auditor across all five properties" },
  fn_autofix: { name: "auto-fix", desc: "proposes fixes to a site's static template files, commits only on approval" },
};
const CONN_STATUS = {
  ok: { label: "LIVE", color: T.green },
  warn: { label: "PARTIAL", color: T.amber },
  down: { label: "DOWN", color: T.red },
  off: { label: "NOT CONFIGURED", color: T.faint },
  local: { label: "DEPLOY TO TEST", color: T.blue },
  checking: { label: "CHECKING", color: T.sub },
};

async function pingFn(name) {
  const t0 = Date.now();
  try {
    const res = await fetch(`/.netlify/functions/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ping: true }) });
    const ms = Date.now() - t0;
    if (res.status === 404) return { status: "off", detail: "function not deployed", ms };
    const data = await res.json().catch(() => null);
    if (!res.ok) return { status: "down", detail: data?.error || `HTTP ${res.status}`, ms };
    if (data?.configured === false) return { status: "warn", detail: data?.missing ? `deployed — missing ${data.missing}` : "deployed — keys not set", ms };
    return { status: "ok", detail: "responding", ms };
  } catch { return { status: "down", detail: "unreachable", ms: Date.now() - t0 }; }
}

function useConnections({ session, btc }) {
  const [checks, setChecks] = useState({});
  const [lastRun, setLastRun] = useState(null);
  const [running, setRunning] = useState(false);

  const set = (key, val) => setChecks(prev => ({ ...prev, [key]: val }));

  const runAll = async () => {
    if (running) return;
    setRunning(true);
    const all = Object.keys(CONN_META);
    setChecks(Object.fromEntries(all.map(k => [k, { status: "checking" }])));

    // Supabase — config
    set("supabase_env", supabase ? { status: "ok", detail: "url + anon key baked into build" } : { status: "off", detail: "env vars missing — see setup notice" });
    // Supabase — auth
    set("supabase_auth", session?.user ? { status: "ok", detail: session.user.email } : { status: "down", detail: "no session" });
    // Supabase — db round trip
    if (supabase) {
      const t0 = Date.now();
      try {
        const { error, count } = await supabase.from("chat_messages").select("*", { count: "exact", head: true });
        set("supabase_db", error
          ? { status: "down", detail: error.message, ms: Date.now() - t0 }
          : { status: "ok", detail: `${count ?? 0} messages readable`, ms: Date.now() - t0 });
      } catch { set("supabase_db", { status: "down", detail: "query failed", ms: Date.now() - t0 }); }
    } else set("supabase_db", { status: "off", detail: "supabase not configured" });

    // Anthropic — tiny live call through whichever path this build uses
    {
      const t0 = Date.now();
      if (!IS_DEPLOYED && !ANTHROPIC_API_KEY) {
        set("anthropic", { status: "off", detail: "VITE_ANTHROPIC_API_KEY not set for local dev" });
      } else {
        const text = await callClaude({ messages: [{ role: "user", content: "ping" }], modelKey: "haiku", maxTokens: 1, fn: "conn_check" });
        set("anthropic", text !== null
          ? { status: "ok", detail: IS_DEPLOYED ? "proxy → Claude responding" : "direct → Claude responding", ms: Date.now() - t0 }
          : { status: "down", detail: IS_DEPLOYED ? "proxy failed — check claude function + ANTHROPIC_API_KEY" : "call failed — check key", ms: Date.now() - t0 });
      }
    }

    // CoinGecko — reuse the hook's state, verify with a light ping
    if (btc?.error) set("coingecko", { status: "down", detail: btc.error });
    else if (btc?.price) set("coingecko", { status: "ok", detail: `BTC $${btc.price.toLocaleString(undefined, { maximumFractionDigits: 0 })} · ${btc.points?.length || 0} chart points` });
    else {
      const t0 = Date.now();
      try {
        const r = await fetch("https://api.coingecko.com/api/v3/ping");
        set("coingecko", r.ok ? { status: "ok", detail: "API reachable", ms: Date.now() - t0 } : { status: "down", detail: `HTTP ${r.status}`, ms: Date.now() - t0 });
      } catch { set("coingecko", { status: "down", detail: "unreachable", ms: Date.now() - t0 }); }
    }

    // Netlify functions
    const fns = [["fn_health", "health"], ["fn_mini", "mini-worker"], ["fn_btc", "btc"], ["fn_markets", "markets"], ["fn_wire", "wire"], ["fn_sports", "sports"], ["fn_sports_detail", "sports-detail"], ["fn_tmdb", "tmdb"], ["fn_export_data", "export-data"], ["fn_calendar", "calendar"], ["fn_calendar_events", "calendar-events"], ["fn_site_status", "site-status"], ["fn_gsc", "gsc"], ["fn_shopify", "shopify"], ["fn_clarify_pipeline", "clarify-pipeline"], ["fn_zts_pipeline", "zts-pipeline"], ["fn_deploy", "deploy"], ["fn_dbadmin", "db-admin"], ["fn_audit", "audit"], ["fn_autofix", "auto-fix"]];
    if (!IS_DEPLOYED) {
      // netlify dev serves functions locally; try health first to decide
      const probe = await pingFn("health");
      if (probe.status === "down" || probe.status === "off") {
        fns.forEach(([k]) => set(k, { status: "local", detail: "run `netlify dev` or deploy to test functions" }));
      } else {
        await Promise.all(fns.map(async ([k, n]) => set(k, await pingFn(n))));
      }
    } else {
      await Promise.all(fns.map(async ([k, n]) => set(k, await pingFn(n))));
    }

    setLastRun(Date.now());
    setRunning(false);
  };

  return { checks, lastRun, running, runAll };
}

function ConnRow({ meta, check }) {
  const st = CONN_STATUS[check?.status || "checking"];
  return (
    <div style={{ ...S.inner, display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: st.color, flex: "none", boxShadow: `0 0 9px ${st.color}80`, animation: check?.status === "checking" ? "pulse 1.2s infinite" : "none" }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: syne, color: T.ink }}>{meta.name}</span>
        <span style={{ fontSize: 9.5, color: T.faint, lineHeight: 1.45 }}>{check?.detail || meta.desc}</span>
      </span>
      {typeof check?.ms === "number" && <span style={{ fontSize: 9, color: T.faint, fontFamily: mono, flex: "none" }}>{check.ms}ms</span>}
      <span style={{ fontSize: 8, fontWeight: 700, color: st.color, background: st.color + "1A", border: `1px solid ${st.color}40`, padding: "4px 9px", borderRadius: 11, fontFamily: mono, letterSpacing: "0.08em", flex: "none" }}>{st.label}</span>
    </div>
  );
}


// ─── Summon (⌘K) ──────────────────────────────────────────────────────────────
// One keystroke to anywhere: pages, notes, skills, and quick actions (jot a
// note, queue a Mini Me task) — without leaving what you're doing. The whole
// app behind a single search field.
const SUMMON_PLACES = [
  { label: "Brief", page: "brief", hint: "markets · wires · stores" },
  { label: "Notes", page: "personal", sub: "notes", hint: "personal" },
  { label: "Calendar", page: "personal", sub: "calendar", hint: "personal" },
  { label: "Workout", page: "personal", sub: "workout", hint: "training" },
  { label: "Birthdays", page: "personal", sub: "birthdays", hint: "personal" },
  { label: "Movies", page: "personal", sub: "movies", hint: "watchlist" },
  { label: "Food", page: "personal", sub: "food", hint: "meals" },
  { label: "Mini Me", page: "boardroom", sub: "mini", hint: "queue · run" },
  { label: "Learn", page: "boardroom", sub: "learn", hint: "skills" },
  { label: "Board chat", page: "boardroom", sub: "chat", hint: "ask the seats" },
  { label: "Seats", page: "boardroom", sub: "seats", hint: "the five" },
  { label: "Assets", page: "assets", hint: "properties · auditor" },
  { label: "Systems", page: "systems", hint: "usage · status · deploy" },
];

function Summon({ onClose, onGo, onJot, onQueueTask, isMobile }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState(null); // null | "jot" | "task"
  const [modeText, setModeText] = useState("");
  const [flash, setFlash] = useState(null); // confirmation line before close
  const [notes, setNotes] = useState([]);
  const [skills, setSkills] = useState([]);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const closeTimer = useRef(null);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    db.loadNotes().then(({ rows }) => setNotes(rows || [])).catch(() => {});
    makeSkillsDb(supabase).load().then(setSkills).catch(() => {});
  }, []);
  useEffect(() => { inputRef.current?.focus(); }, [mode]);

  const needle = q.trim().toLowerCase();
  const hit = (s) => (s || "").toLowerCase().includes(needle);
  const noteTitle = (n) => n.title?.trim() || (n.body || "").split("\n").map(l => l.trim()).find(Boolean)?.slice(0, 60) || "Untitled note";

  const rows = useMemo(() => {
    const actions = [
      { kind: "act", label: "Jot a note", hint: "saved straight to Notes", run: () => { setMode("jot"); setQ(""); } },
      { kind: "act", label: "Queue a task for Mini Me", hint: "lands in the queue", run: () => { setMode("task"); setQ(""); } },
      { kind: "act", label: "Teach a skill", hint: "/learn", go: { page: "boardroom", sub: "learn" } },
      { kind: "act", label: "Ask the board", hint: "open the chat", go: { page: "boardroom", sub: "chat" } },
    ].filter(a => !needle || hit(a.label) || hit(a.hint));
    const places = SUMMON_PLACES.filter(p => !needle || hit(p.label) || hit(p.hint))
      .map(p => ({ kind: "go", label: p.label, hint: p.hint, go: p }));
    const noteRows = (needle ? notes.filter(n => hit(n.title) || hit(n.body)) : notes.slice(0, 3))
      .slice(0, 5).map(n => ({ kind: "note", label: noteTitle(n), hint: "note", go: { page: "personal", sub: "notes", noteId: n.id } }));
    const skillRows = (needle ? skills.filter(s => hit(s.title) || hit(s.description) || hit(s.content)) : [])
      .slice(0, 5).map(s => ({ kind: "skill", label: s.title, hint: "skill", go: { page: "boardroom", sub: "learn", skillId: s.id } }));
    return [...actions, ...places, ...noteRows, ...skillRows];
  }, [needle, notes, skills]);

  useEffect(() => { setIdx(0); }, [needle]);
  useEffect(() => {
    listRef.current?.children[idx]?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const choose = (r) => {
    if (!r) return;
    if (r.run) return r.run();
    if (r.go) onGo(r.go);
  };

  const commitMode = async () => {
    const t = modeText.trim();
    if (!t) return;
    try {
      if (mode === "jot") { await onJot(t); setFlash("Saved to Notes ◆"); }
      else { await onQueueTask(t); setFlash("Queued for Mini Me ◆"); }
      setModeText("");
      closeTimer.current = setTimeout(onClose, 650);
    } catch (e) { setFlash(e.message || "Couldn't save — try again."); }
  };

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); mode ? (setMode(null), setFlash(null)) : onClose(); return; }
    if (mode) { if (e.key === "Enter") { e.preventDefault(); commitMode(); } return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(rows[idx]); }
  };

  const sectionOf = (r) => r.kind === "act" ? "Actions" : r.kind === "go" ? "Go to" : r.kind === "note" ? "Notes" : "Skills";

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(28,24,16,0.34)", backdropFilter: "blur(3px)", zIndex: 120, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: isMobile ? "12vh 14px 0" : "16vh 20px 0", animation: "fadein 0.14s ease" }}>
      <div onClick={e => e.stopPropagation()} onKeyDown={onKey}
        style={{ width: "100%", maxWidth: 560, background: T.surface, border: `1px solid ${T.lineStrong}`, borderRadius: 16, boxShadow: "0 30px 90px rgba(28,24,16,0.35)", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: isMobile ? "70dvh" : "62vh" }}>

        {/* the diamond rule */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 18px", height: 34, borderBottom: `1px solid ${T.line}`, flex: "none" }}>
          <span style={{ width: 6, height: 6, transform: "rotate(45deg)", background: T.brass, borderRadius: 1 }} />
          <span style={{ ...S.microLabel, color: T.sub }}>{mode === "jot" ? "Jot a note" : mode === "task" ? "Queue a task" : "Summon"}</span>
          <span style={{ flex: 1 }} />
          <span style={{ ...S.microLabel }}>{mode ? "↵ save · esc back" : "↑↓ · ↵ · esc"}</span>
        </div>

        {mode ? (
          <div style={{ padding: 18 }}>
            <textarea ref={inputRef} value={modeText} onChange={e => setModeText(e.target.value)} rows={3}
              placeholder={mode === "jot" ? "The thought, as it comes — Enter saves it." : "What should Mini Me take on?"}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitMode(); } }}
              style={{ ...S.input, width: "100%", boxSizing: "border-box", padding: "12px 13px", fontSize: 13.5, lineHeight: 1.6, resize: "none" }} />
            {flash && <div style={{ marginTop: 10, fontSize: 11.5, color: flash.includes("◆") ? T.green : T.red, fontFamily: mono }}>{flash}</div>}
          </div>
        ) : (
          <>
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search everything…"
              style={{ border: "none", outline: "none", background: "transparent", padding: "15px 18px", fontSize: 15, color: T.ink, fontFamily: "inherit", flex: "none" }} />
            <div ref={listRef} style={{ overflowY: "auto", padding: "0 8px 10px" }}>
              {rows.length === 0 && <div style={{ padding: "22px 12px", fontSize: 12, color: T.faint, textAlign: "center" }}>Nothing matches "{q}".</div>}
              {rows.map((r, i) => {
                const showSection = i === 0 || sectionOf(rows[i - 1]) !== sectionOf(r);
                return (
                  <div key={`${r.kind}-${r.label}-${i}`}>
                    {showSection && <div style={{ ...S.microLabel, padding: "12px 12px 5px" }}>{sectionOf(r)}</div>}
                    <div onClick={() => choose(r)} onMouseEnter={() => setIdx(i)}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9, cursor: "pointer", background: i === idx ? "rgba(138,103,28,0.09)" : "transparent" }}>
                      <span style={{ width: 5, height: 5, transform: "rotate(45deg)", background: i === idx ? T.brass : "rgba(32,27,18,0.16)", borderRadius: 1, flex: "none" }} />
                      <span style={{ fontSize: 13, color: T.ink, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
                      {r.hint && <span style={{ fontSize: 9.5, color: T.faint, fontFamily: mono, flex: "none" }}>{r.hint}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SubTabs({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 22, flexWrap: "wrap", borderBottom: `1px solid ${T.line}` }}>
      {options.map(o => {
        const active = value === o.key;
        return (
          <button key={o.key} onClick={() => onChange(o.key)}
            style={{ padding: "6px 1px 9px", background: "none", border: "none", borderBottom: `2px solid ${active ? T.brass : "transparent"}`, marginBottom: -1, color: active ? T.ink : T.faint, fontSize: 10.5, fontWeight: 600, fontFamily: syne, letterSpacing: "0.14em", textTransform: "uppercase", cursor: "pointer", borderRadius: 0 }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const SYSTEMS_SUBTABS = [
  { key: "usage", label: "Usage" },
  { key: "status", label: "Status" },
  { key: "deploy", label: "Deploy" },
  { key: "supabase", label: "Supabase" },
];

// Systems — everything technical in one place, behind sub-tabs so mobile
// isn't a wall of unrelated cards: spend/usage, live status of every data
// pipe, deploy triggers, and the Supabase console. The site auditor lives
// on Assets now, next to the properties it actually audits.
function SystemsPage({ settings, updateSetting, session, btc, isMobile }) {
  const [sub, setSub] = useState("usage");
  const card = isMobile ? S.cardM : S.card;

  // ── Status (formerly the standalone Connections page) ──
  const { checks, lastRun, running, runAll } = useConnections({ session, btc });
  useEffect(() => { runAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const vals = Object.values(checks);
  const counts = {
    ok: vals.filter(c => c?.status === "ok").length,
    warn: vals.filter(c => c?.status === "warn").length,
    down: vals.filter(c => c?.status === "down").length,
    off: vals.filter(c => c?.status === "off" || c?.status === "local").length,
  };
  const ago = (ts) => { if (!ts) return "—"; const s = Math.floor((Date.now() - ts) / 1000); return s < 60 ? `${s}S AGO` : `${Math.floor(s / 60)}M AGO`; };

  // ── Deploy — build triggers, plus a safe single-file replace ──
  const [deploys, setDeploys] = useState({});
  const redeploy = async (p) => {
    setDeploys(d => ({ ...d, [p.name]: { busy: true } }));
    const res = await callFn("deploy", { site: p.site, action: "build" });
    setDeploys(d => ({ ...d, [p.name]: { busy: false, ok: !!res?.success, when: "just now" } }));
  };
  const [replaceFile, setReplaceFile] = useState(null);
  const [replacePath, setReplacePath] = useState("");
  const [replaceTargets, setReplaceTargets] = useState([]);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [replaceResults, setReplaceResults] = useState({});
  const toggleTarget = (name) => setReplaceTargets(t => t.includes(name) ? t.filter(x => x !== name) : [...t, name]);
  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const runReplace = async () => {
    if (!replaceFile || !replacePath.trim() || !replaceTargets.length || replaceBusy) return;
    setReplaceBusy(true);
    setReplaceResults({});
    const contentBase64 = await fileToBase64(replaceFile);
    const results = {};
    for (const name of replaceTargets) {
      const p = PROPERTIES.find(x => x.name === name);
      const res = await callFn("deploy", { site: p.site, action: "replace-file", path: replacePath.trim(), contentBase64 });
      results[name] = { ok: !!res?.success, detail: res?.success ? res.message : (res?.error || "failed — see Netlify deploy log") };
      setReplaceResults({ ...results });
    }
    setReplaceBusy(false);
  };

  // ── Supabase — which project the console commands target ──
  const [projects, setProjects] = useState(["Board Room"]);
  const [project, setProject] = useState("Board Room");
  useEffect(() => {
    let alive = true;
    callFn("db-admin", { ping: true }).then(d => {
      if (!alive || !d?.projects?.length) return;
      setProjects(d.projects);
      setProject(p => d.projects.includes(p) ? p : d.projects[0]);
    });
    return () => { alive = false; };
  }, []);
  const [sqlInput, setSqlInput] = useState("");
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlLog, setSqlLog] = useState([{ kind: "ok", text: "ready — allowlisted commands only" }]);
  const runSql = async () => {
    const q = sqlInput.trim();
    if (!q || sqlBusy) return;
    setSqlLog(l => [...l, { kind: "cmd", text: `> [${project}] ${q}` }]);
    setSqlInput(""); setSqlBusy(true);
    const data = await callFn("db-admin", { command: q, project });
    setSqlLog(l => [...l, { kind: data?.success ? "ok" : "err", text: data?.success ? "✓ " + (data.message || "done") : "✗ " + (data?.error || "db-admin function not deployed yet") }]);
    setSqlBusy(false);
  };

  // ── Usage / Models ──
  const models = { ...DEFAULT_MODELS, ...(settings?.models || {}) };
  const setModel = (layer, key) => updateSetting("models", { ...models, [layer]: key });
  const mult = k => (MODEL_META.find(m => m.key === k) || {}).mult || 1;
  const est = 0.006 * mult(models.router) + 0.018 * mult(models.seats) + 0.012 * mult(models.chief);
  const spendToday = obs.all().filter(l => new Date(l.ts).toDateString() === new Date().toDateString());
  const inTok = spendToday.reduce((s, l) => s + (l.inTok || 0), 0), outTok = spendToday.reduce((s, l) => s + (l.outTok || 0), 0);
  const cost = spendToday.reduce((s, l) => s + (l.cost || 0), 0);
  const fmtK = n => n > 999 ? Math.round(n / 1000) + "K" : String(n);
  const layers = [
    { key: "router", name: "Router", desc: "picks which seats to wake" },
    { key: "seats", name: "Board Seats", desc: "the five specialist takes" },
    { key: "chief", name: "Chief of Staff", desc: "final synthesis" },
  ];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "18px 16px 24px" : "30px 34px 40px" }}>
      <div style={{ maxWidth: 1020, margin: "0 auto", display: "flex", flexDirection: "column", gap: isMobile ? 12 : 14 }}>
        <SubTabs options={SYSTEMS_SUBTABS} value={sub} onChange={setSub} />

        {sub === "status" && (
          <>
            <div style={{ ...card, display: "flex", alignItems: "center", gap: isMobile ? 12 : 18, flexWrap: "wrap" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, auto)", gap: isMobile ? 10 : 16, flex: 1 }}>
                {[["LIVE", counts.ok, T.green], ["PARTIAL", counts.warn, T.amber], ["DOWN", counts.down, T.red], ["NOT SET", counts.off, T.faint]].map(([l, v, c]) => (
                  <span key={l} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontSize: 18, fontWeight: 700, fontFamily: mono, color: c }}>{v}</span>
                    <span style={{ ...S.microLabel }}>{l}</span>
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 7 }}>
                <button onClick={runAll} disabled={running} style={{ ...S.brassBtn, padding: "10px 20px", fontSize: 11, opacity: running ? 0.55 : 1 }}>{running ? "Checking…" : "Run checks"}</button>
                <span style={S.microLabel}>LAST CHECK {ago(lastRun)}</span>
              </div>
            </div>
            {CONN_GROUPS.map(g => (
              <div key={g.title} style={card}>
                <div style={{ ...S.title, marginBottom: 11 }}>{g.title}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {g.keys.map(k => <ConnRow key={k} meta={CONN_META[k]} check={checks[k]} />)}
                </div>
              </div>
            ))}
          </>
        )}

        {sub === "deploy" && (
          <>
            <div style={card}>
              <CardHeader title="Deployments" tag="NETLIFY" />
              <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 13px" }}>Each redeploy triggers a fresh Netlify build from the site's connected repo. Live/down state lives under the Status tab.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                {PROPERTIES.map(p => {
                  const d = deploys[p.name] || {};
                  return (
                    <div key={p.name} style={{ ...S.inner, display: "flex", alignItems: "center", gap: 11, padding: "11px 13px" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: d.busy ? T.amber : d.when ? (d.ok ? T.green : T.red) : T.faint, flex: "none" }} />
                      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                        <span style={{ fontSize: 9, color: d.busy ? T.amber : T.faint, fontFamily: mono, letterSpacing: "0.04em" }}>{d.busy ? "TRIGGERING BUILD…" : d.when ? (d.ok ? "BUILD TRIGGERED · " + d.when : "TRIGGER FAILED — check deploy function") : "netlify · " + p.site}</span>
                      </span>
                      <button onClick={() => redeploy(p)} style={{ ...S.ghostBtn, padding: "7px 13px", fontSize: 9.5, flex: "none" }}>{d.busy ? "Deploying…" : "Redeploy"}</button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={card}>
              <CardHeader title="Replace a File" tag="SINGLE-FILE SWAP" />
              <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 13px" }}>Swaps one file on the sites you pick — every other file on the live site is left exactly as it is. For a full rebuild, use Deployments above instead.</div>
              <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: 16, background: "rgba(34,29,20,0.02)", border: "1px dashed rgba(143,107,30,0.35)", borderRadius: 12, cursor: "pointer", marginBottom: 10 }}>
                <input type="file" onChange={e => { const f = e.target.files?.[0] || null; setReplaceFile(f); setReplaceResults({}); if (f && !replacePath) setReplacePath("/" + f.name); }} style={{ display: "none" }} />
                <span style={{ fontSize: 11.5, fontWeight: 700, color: T.brass, fontFamily: syne }}>{replaceFile ? "✓ " + replaceFile.name : "Choose a file"}</span>
                <span style={{ fontSize: 9.5, color: T.faint }}>{replaceFile ? "set the path below, pick sites, then replace" : "HTML, JS, CSS, images — keep it under 4MB"}</span>
              </label>
              {replaceFile && (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 9.5, color: T.faint, marginBottom: 5 }}>Path on the site (exact, case-sensitive)</div>
                    <input value={replacePath} onChange={e => setReplacePath(e.target.value)} placeholder="/index.html"
                      style={{ ...S.input, width: "100%", padding: "9px 11px", fontSize: 11, fontFamily: mono }} />
                  </div>
                  <div style={{ fontSize: 9.5, color: T.faint, marginBottom: 6 }}>Replace on:</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                    {PROPERTIES.map(p => {
                      const sel = replaceTargets.includes(p.name);
                      return (
                        <button key={p.name} onClick={() => toggleTarget(p.name)} style={{ padding: "7px 12px", background: sel ? "rgba(143,107,30,0.14)" : "rgba(34,29,20,0.035)", border: `1px solid ${sel ? "rgba(143,107,30,0.4)" : "rgba(34,29,20,0.09)"}`, borderRadius: 12, color: sel ? T.brass : T.sub, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: syne }}>{sel ? "✓ " : ""}{p.name}</button>
                      );
                    })}
                  </div>
                  <button onClick={runReplace} disabled={replaceBusy || !replacePath.trim() || !replaceTargets.length} style={{ ...S.brassBtn, width: "100%", padding: 12, fontSize: 11.5, opacity: replaceBusy || !replacePath.trim() || !replaceTargets.length ? 0.5 : 1 }}>
                    {replaceBusy ? "Replacing…" : `Replace on ${replaceTargets.length || 0} site${replaceTargets.length === 1 ? "" : "s"}`}
                  </button>
                  {Object.keys(replaceResults).length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 10 }}>
                      {Object.entries(replaceResults).map(([name, r]) => (
                        <div key={name} style={{ fontSize: 10.5, color: r.ok ? T.green : T.red, lineHeight: 1.5 }}>{r.ok ? "✓" : "✗"} {name}: {r.detail}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {sub === "supabase" && (
          <div style={card}>
            <CardHeader title="Supabase Console" tag="ALLOWLISTED OPS" />
            <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 12px" }}>Run maintenance against a project's shared memory. Guardrails on — destructive ops ask twice.</div>
            <div style={{ fontSize: 9.5, color: T.faint, marginBottom: 6 }}>Project</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {projects.map(p => (
                <button key={p} onClick={() => setProject(p)} style={{ padding: "7px 12px", background: project === p ? "rgba(143,107,30,0.14)" : "rgba(34,29,20,0.035)", border: `1px solid ${project === p ? "rgba(143,107,30,0.4)" : "rgba(34,29,20,0.09)"}`, borderRadius: 12, color: project === p ? T.brass : T.sub, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: syne }}>{p}</button>
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {["backup chat_messages", "vacuum seat_notes", "clear findings > 30d"].map(q => (
                <button key={q} onClick={() => setSqlInput(q)} style={{ padding: "6px 11px", background: "rgba(34,29,20,0.035)", border: `1px solid rgba(34,29,20,0.09)`, borderRadius: 14, color: T.sub, fontSize: 9.5, cursor: "pointer", fontFamily: mono }}>{q}</button>
              ))}
            </div>
            <div style={{ background: "rgba(34,29,20,0.05)", border: "1px solid rgba(34,29,20,0.06)", borderRadius: 11, padding: "12px 14px", minHeight: 110, maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5, marginBottom: 9 }}>
              {sqlLog.map((l, i) => (
                <div key={i} style={{ fontSize: 10, fontFamily: mono, color: l.kind === "cmd" ? T.sub : l.kind === "err" ? T.red : T.green, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{l.text}</div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={sqlInput} onChange={e => setSqlInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); runSql(); } }} placeholder="update seat_notes set …"
                style={{ ...S.input, flex: 1, padding: "11px 13px", fontSize: 11, fontFamily: mono }} />
              <button onClick={runSql} style={{ ...S.ghostBtn, padding: "0 18px", minHeight: 44, borderRadius: 10, fontSize: 11, fontWeight: 700 }}>Run</button>
            </div>
          </div>
        )}

        {sub === "usage" && (
          <>
            <div style={card}>
              <CardHeader title="Model Control" tag="TOKENS" />
              <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 14px" }}>Start cheap. Escalate a layer only when the answers need it.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
                {layers.map(r => (
                  <div key={r.key} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, fontFamily: syne, color: T.ink }}>{r.name}</span>
                      <span style={{ fontSize: 9, color: T.faint }}>{r.desc}</span>
                    </div>
                    <Segmented value={models[r.key]} onChange={k => setModel(r.key, k)} />
                  </div>
                ))}
              </div>
              <div style={{ ...S.inner, marginTop: 14, padding: "11px 13px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 9.5, color: T.sub }}>Est. per convened question</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: T.brass, fontFamily: mono }}>${est.toFixed(3)}</span>
              </div>
              <div style={{ marginTop: 7, ...S.microLabel, letterSpacing: "0.04em" }}>TODAY · {fmtK(inTok)} IN · {fmtK(outTok)} OUT · ${cost.toFixed(2)}</div>
            </div>
            <UsageCard isMobile={isMobile} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Page: Mini Me ───────────────────────────────────────────────────────────
const MINI_DEFAULTS = {
  model: "haiku", enabled: true, budget: "$3", oversight: true,
  directive: "", briefingLog: [], role: "",
  reflectOn: true, loopOn: true, loopMax: "5", approvalOn: true,
};
const TASK_COLORS = { delivered: T.green, review: T.brass, queued: T.faint, failed: T.red };
const EFFORT_LEVELS = [
  { key: "quick", label: "Quick", desc: "One shot, no self-review — fastest and cheapest." },
  { key: "careful", label: "Careful", desc: "Reviews its own draft once before delivering." },
  { key: "thorough", label: "Thorough", desc: "Keeps refining until satisfied, up to the pass limit — this is how you make it think longer on something." },
];

// Mini Me is now real: on-demand only — you queue work and hit Run, nothing
// fires on a schedule. The worker (mini-worker) runs Claude against the
// queue, writes deliverables onto tasks, and logs to mini_feed.
function MiniMePage({ settings, updateSetting, session, onWorkerRun, onOpenLearn, isMobile }) {
  const mini = { ...MINI_DEFAULTS, ...(settings?.mini || {}) };
  const setMini = (patch) => updateSetting("mini", { ...mini, ...patch });
  const tasks = settings?.mini_tasks || [];
  const setTasks = (list) => updateSetting("mini_tasks", list);

  const [taskInput, setTaskInput] = useState("");
  const [feed, setFeed] = useState(null); // null = loading
  const [worker, setWorker] = useState({ state: "checking" });
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [directiveInput, setDirectiveInput] = useState("");
  const [directiveSending, setDirectiveSending] = useState(false);
  const [skillCount, setSkillCount] = useState(null); // null loading · number · "teach" when table missing
  const directiveEndRef = useRef(null);

  const loadFeed = async () => {
    try {
      const { data, error } = await supabase.from("mini_feed").select("text,created_at").order("created_at", { ascending: false }).limit(8);
      if (error) { setFeed({ error: error.message.includes("mini_feed") ? "run supabase-mini-me.sql to create the feed table" : error.message }); return; }
      setFeed((data || []).map(r => ({ when: new Date(r.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }), text: r.text })));
    } catch { setFeed({ error: "feed unavailable" }); }
  };

  useEffect(() => {
    let alive = true;
    loadFeed();
    // enabled-skill count for the hero chip — silent on any failure
    supabase.from("mini_skills").select("id", { count: "exact", head: true }).eq("enabled", true)
      .then(({ count, error }) => { if (alive) setSkillCount(error ? "teach" : (count || 0)); })
      .catch(() => { if (alive) setSkillCount("teach"); });
    pingFn("mini-worker").then(p => {
      if (!alive) return;
      setWorker(p.status === "ok" ? { state: "ok" } : p.status === "warn" ? { state: "noenv", detail: p.detail } : { state: "off", detail: p.detail });
    });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { directiveEndRef.current?.scrollIntoView({ block: "nearest" }); }, [mini.briefingLog?.length]);

  const delivered = tasks.filter(t => t.status === "delivered");
  const active = tasks.filter(t => t.status !== "delivered");

  const addTask = () => { const t = taskInput.trim(); if (!t) return; setTasks([{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: t, status: "queued", queued_at: Date.now() }, ...tasks]); setTaskInput(""); };
  const removeTask = (id) => setTasks(tasks.filter(t => t.id !== id));

  const callWorker = async (payload) => {
    try {
      const res = await fetch("/.netlify/functions/mini-worker", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
        body: JSON.stringify(payload),
      });
      return { ok: res.ok, data: await res.json().catch(() => null), status: res.status };
    } catch { return { ok: false, data: null, status: 0 }; }
  };

  const runNow = async () => {
    if (running) return;
    setRunning(true); setRunMsg(null);
    const { ok, data, status } = await callWorker({ run: true });
    if (!ok || !data?.success) setRunMsg({ ok: false, text: data?.error || `worker failed (${status || "network"})` });
    else setRunMsg({ ok: true, text: data.message || `processed ${data.processed} task(s)` });
    await loadFeed();
    await onWorkerRun?.();
    setRunning(false);
  };

  const approveTask = async (id) => {
    setRunning(true);
    await callWorker({ approve: id });
    await loadFeed();
    await onWorkerRun?.();
    setRunning(false);
  };
  const rejectTask = async (id) => {
    setRunning(true);
    await callWorker({ reject: id });
    await loadFeed();
    await onWorkerRun?.();
    setRunning(false);
  };

  // Neither field is typed directly — you talk to it, and Claude decides
  // whether your message is about the mission (directive), the identity
  // (role), or both, updating only what you actually addressed.
  const sendDirectiveUpdate = async () => {
    const msg = directiveInput.trim();
    if (!msg || directiveSending) return;
    setDirectiveInput("");
    setDirectiveSending(true);
    const log = mini.briefingLog || [];
    const recent = log.slice(-6).map(l => `${l.role === "user" ? "Cameron" : l.field === "role" ? "Role" : "Directive"}: ${l.text}`).join("\n");
    const system = `You maintain two things for Cameron's autonomous assistant, Mini Me, from an ongoing conversation:
1. "directive" — a one-sentence overall mission that shapes every task.
2. "role" — the identity/expertise it should adopt when doing work.

Current directive: "${mini.directive || "none set"}"
Current role: "${mini.role || "none set"}"${recent ? `\n\nRecent conversation:\n${recent}` : ""}

Cameron just said: "${msg}"

Decide which of the two his message actually addresses — often just one. Output ONLY a JSON object with both fields, updating whichever he addressed and copying the other UNCHANGED if he didn't mention it: {"directive": "...", "role": "..."}. No markdown, no prose, no preamble — just the JSON object.`;
    const raw = await callClaude({ system, messages: [{ role: "user", content: msg }], modelKey: mini.model || "haiku", maxTokens: 150, fn: "briefing_update" });
    let parsed = null;
    try { parsed = JSON.parse((raw || "").replace(/```json|```/g, "").trim()); } catch {}
    const newDirective = (parsed?.directive || mini.directive || "").trim();
    const newRole = (parsed?.role || mini.role || "").trim();
    const entries = [{ role: "user", text: msg, ts: Date.now() }];
    if (newDirective && newDirective !== mini.directive) entries.push({ role: "system", field: "directive", text: newDirective, ts: Date.now() });
    if (newRole && newRole !== mini.role) entries.push({ role: "system", field: "role", text: newRole, ts: Date.now() });
    if (entries.length === 1) entries.push({ role: "system", field: "directive", text: "Couldn't parse an update — try rephrasing.", ts: Date.now() });
    setMini({ directive: newDirective, role: newRole, briefingLog: [...log, ...entries].slice(-24) });
    setDirectiveSending(false);
  };

  const card = isMobile ? S.cardM : S.card;
  const toggleSize = isMobile ? 24 : 20;
  const queuedCount = tasks.filter(t => t.status === "queued").length;
  const [pillText, pillColor] = worker.state === "ok" ? ["● WORKER ONLINE", T.green]
    : worker.state === "noenv" ? ["◐ KEYS MISSING", T.amber]
    : worker.state === "off" ? ["○ WORKER NOT DEPLOYED", T.red]
    : ["…", T.faint];

  // Effort is a single dial derived from the underlying reflectOn/loopOn
  // fields the worker already reads — no worker changes needed.
  const effort = mini.reflectOn === false ? "quick" : mini.loopOn === false ? "careful" : "thorough";
  const setEffort = (e) => {
    if (e === "quick") setMini({ reflectOn: false, loopOn: false });
    else if (e === "careful") setMini({ reflectOn: true, loopOn: false });
    else setMini({ reflectOn: true, loopOn: true, loopMax: mini.loopMax || "5" });
  };

  const TaskRow = ({ t }) => {
    const c = TASK_COLORS[t.status] || T.faint;
    const open = openTask === t.id;
    return (
      <div style={{ ...S.inner, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div onClick={() => t.output && setOpenTask(open ? null : t.id)} style={{ display: "flex", alignItems: "center", gap: 11, cursor: t.output ? "pointer" : "default" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, flex: "none", boxShadow: `0 0 8px ${c}80` }} />
          <span style={{ flex: 1, fontSize: 11, color: "#3A3323", lineHeight: 1.5 }}>{t.text}</span>
          <span style={{ fontSize: 8.5, color: c, fontFamily: mono, letterSpacing: "0.06em", flex: "none", textTransform: "uppercase" }}>{t.status}{t.output ? (open ? " ▲" : " ▼") : ""}</span>
          <button onClick={(e) => { e.stopPropagation(); removeTask(t.id); }} title="Remove" style={{ width: 24, height: 24, background: "rgba(34,29,20,0.04)", border: `1px solid rgba(34,29,20,0.09)`, borderRadius: 7, color: T.faint, fontSize: 10, cursor: "pointer", flex: "none" }}>✕</button>
        </div>
        {open && t.output && (
          <div style={{ background: "rgba(34,29,20,0.045)", border: "1px solid rgba(34,29,20,0.05)", borderRadius: 9, padding: "11px 13px", fontSize: 11, color: T.sub, lineHeight: 1.65, whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto" }}>{t.output}</div>
        )}
        {t.status === "review" && (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => approveTask(t.id)} disabled={running} style={{ ...S.brassBtn, flex: 1, padding: "8px 0", fontSize: 10.5, opacity: running ? 0.5 : 1 }}>Approve</button>
            <button onClick={() => rejectTask(t.id)} disabled={running} style={{ flex: 1, padding: "8px 0", background: "transparent", border: `1px solid rgba(34,29,20,0.12)`, borderRadius: 10, color: T.sub, fontSize: 10.5, fontWeight: 600, cursor: running ? "default" : "pointer" }}>Reject &amp; redo</button>
          </div>
        )}
      </div>
    );
  };

  const col = { display: "flex", flexDirection: "column", gap: isMobile ? 12 : 14 };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "18px 16px 24px" : "30px 34px 40px" }}>
      <div style={{ maxWidth: 1020, margin: "0 auto", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1.3fr 1fr", gap: isMobile ? 12 : 14, alignItems: "start" }}>

        {/* Left column: identity, then the actual work surface */}
        <div style={col}>

          {/* Hero — identity, directive, role. No XP/level — just what it is and what it's doing. */}
          <div style={{ ...card, background: "rgba(138,103,28,0.05)", border: "1px solid rgba(143,107,30,0.22)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
              <span style={{ width: isMobile ? 48 : 56, height: isMobile ? 48 : 56, borderRadius: "50%", background: T.brass, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", animation: "breathe 3.2s ease-in-out infinite" }}>
                <span style={{ width: 22, height: 22, borderRadius: "50%", background: T.bg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: T.brass, animation: "pulse 2.4s infinite" }} />
                </span>
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                <span style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 19, fontWeight: 700, fontFamily: syne, color: T.ink }}>Mini Me</span>
                  <span style={{ fontSize: 9, color: mini.enabled === false ? T.faint : pillColor, fontFamily: mono, letterSpacing: "0.08em" }}>{mini.enabled === false ? "○ OFF" : pillText}</span>
                </span>
                <span style={{ fontSize: 11, color: T.sub, lineHeight: 1.5 }}>Queue work below, set the dial, hit Run — nothing happens until you say so.</span>
                {onOpenLearn && skillCount !== null && (
                  <button onClick={onOpenLearn} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", fontSize: 10, fontFamily: mono, color: T.brass, letterSpacing: "0.05em" }}>
                    {typeof skillCount === "number" && skillCount > 0 ? `◈ ${skillCount} skill${skillCount > 1 ? "s" : ""} loaded →` : "◈ Teach it skills →"}
                  </button>
                )}
                {worker.state !== "ok" && worker.state !== "checking" && mini.enabled !== false && <span style={{ fontSize: 10, color: T.amber, lineHeight: 1.5 }}>{worker.detail}</span>}
              </span>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, flex: "none" }}>
                <Toggle on={mini.enabled !== false} onToggle={() => setMini({ enabled: mini.enabled === false })} size={isMobile ? 26 : 22} />
                <span style={{ fontSize: 8, fontWeight: 700, color: mini.enabled === false ? T.faint : T.green, fontFamily: mono, letterSpacing: "0.06em" }}>{mini.enabled === false ? "OFF" : "ON"}</span>
              </div>
            </div>
            {mini.enabled === false && <div style={{ ...S.inner, padding: "10px 13px", marginBottom: 14, fontSize: 10.5, color: T.faint, lineHeight: 1.5 }}>Mini Me is off — Run now won't do anything until you flip it back on above.</div>}

            {/* Prime Directive + Role — one conversation shapes both */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: T.brass, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: syne, marginBottom: 6 }}>Prime Directive</div>
                {mini.directive ? (
                  <div style={{ ...S.inner, padding: "11px 13px", fontSize: 11.5, color: T.ink, lineHeight: 1.5, fontStyle: "italic" }}>"{mini.directive}"</div>
                ) : (
                  <div style={{ ...S.inner, padding: "11px 13px", fontSize: 10, color: T.faint, lineHeight: 1.45, border: `1px dashed rgba(34,29,20,0.14)`, background: "transparent" }}>No directive yet — the mission that shapes every task.</div>
                )}
              </div>
              <div>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: T.brass, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: syne, marginBottom: 6 }}>Role</div>
                {mini.role ? (
                  <div style={{ ...S.inner, padding: "11px 13px", fontSize: 11.5, color: T.ink, lineHeight: 1.5 }}>{mini.role}</div>
                ) : (
                  <div style={{ ...S.inner, padding: "11px 13px", fontSize: 10, color: T.faint, lineHeight: 1.45, border: `1px dashed rgba(34,29,20,0.14)`, background: "transparent" }}>No role yet — the identity it works from.</div>
                )}
              </div>
            </div>

            {(mini.briefingLog || []).length > 0 && (
              <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, marginBottom: 8, padding: "2px 1px" }}>
                {mini.briefingLog.map((l, i) => (
                  <div key={i} style={{ fontSize: 10.5, lineHeight: 1.5, color: l.role === "user" ? T.sub : T.brass, fontStyle: l.role === "user" ? "normal" : "italic" }}>
                    {l.role === "user" ? l.text : `→ ${l.field === "role" ? "Role" : "Directive"}: ${l.text}`}
                  </div>
                ))}
                <div ref={directiveEndRef} />
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <input value={directiveInput} onChange={e => setDirectiveInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); sendDirectiveUpdate(); } }} placeholder="Tell it who it is and what matters right now…"
                style={{ ...S.input, flex: 1, padding: "10px 12px", fontSize: 11.5 }} disabled={directiveSending} />
              <button onClick={sendDirectiveUpdate} disabled={directiveSending || !directiveInput.trim()} style={{ ...S.brassBtn, padding: "0 16px", minHeight: 40, fontSize: 10.5, opacity: directiveSending || !directiveInput.trim() ? 0.5 : 1 }}>{directiveSending ? "…" : "Send"}</button>
            </div>
            {(mini.briefingLog || []).length > 0 && (
              <button onClick={() => setMini({ briefingLog: [] })} style={{ marginTop: 8, background: "none", border: "none", color: T.faint, fontSize: 9.5, cursor: "pointer", padding: 0, textDecoration: "underline" }}>Clear conversation (keeps the current directive &amp; role)</button>
            )}
          </div>

          {/* Task Queue — its own run controls, so you never have to leave this card to work the queue */}
          <div style={card}>
            <CardHeader title="Task Queue" tag="RUNS ONLY WHEN YOU HIT RUN" />
            <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 12px" }}>Hand it work. Tap a task with output to read it.</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <input value={taskInput} onChange={e => setTaskInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTask(); } }} placeholder="e.g. Draft 5 outreach angles for the med-spa vertical"
                style={{ ...S.input, flex: 1, padding: "11px 13px", fontSize: 11.5 }} />
              <button onClick={addTask} style={{ ...S.brassBtn, padding: "0 18px", minHeight: 44, fontSize: 11 }}>Queue</button>
            </div>

            <div style={{ ...S.inner, padding: "12px 13px", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: syne, color: T.ink }}>Daily budget</span>
                <span style={{ fontSize: 8.5, color: T.faint }}>caps tasks per run: $1→1 · $3→3 · $10→8</span>
              </div>
              <Chips options={["$1", "$3", "$10"]} value={mini.budget} onChange={b => setMini({ budget: b })} fmt={v => v + "/day"} />
              <button onClick={runNow} disabled={running || worker.state === "off" || mini.enabled === false} style={{ ...S.brassBtn, width: "100%", padding: 12, fontSize: 11.5, marginTop: 11, opacity: running || worker.state === "off" || mini.enabled === false ? 0.5 : 1 }}>
                {running ? "Working the queue…" : mini.enabled === false ? "Mini Me is off" : `Run queue now${queuedCount ? ` (${queuedCount} queued)` : ""}`}
              </button>
              {runMsg && <div style={{ marginTop: 8, fontSize: 10.5, color: runMsg.ok ? T.green : T.red, lineHeight: 1.5 }}>{runMsg.ok ? "✓ " : "✗ "}{runMsg.text}</div>}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {active.length === 0 && delivered.length === 0 && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "10px 0" }}>Nothing queued yet — give it something to work on.</div>}
              {active.length === 0 && delivered.length > 0 && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "10px 0" }}>Queue's clear — everything's been delivered. See Completed below.</div>}
              {active.map(t => <TaskRow key={t.id} t={t} />)}
            </div>

            {delivered.length > 0 && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.line}` }}>
                <button onClick={() => setShowCompleted(!showCompleted)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", cursor: "pointer", padding: "2px 0" }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: syne, color: T.sub }}>Completed ({delivered.length})</span>
                  <span style={{ fontSize: 10, color: T.faint }}>{showCompleted ? "hide ▲" : "show ▼"}</span>
                </button>
                {showCompleted && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                    {delivered.map(t => <TaskRow key={t.id} t={t} />)}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Activity feed — real */}
          <div style={card}>
            <div style={{ ...S.title, marginBottom: 4 }}>Activity Feed</div>
            <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, marginBottom: 12 }}>Real worker runs, oversight findings, and your approvals — most recent first.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {feed === null && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "8px 0" }}>Loading…</div>}
              {feed?.error && <div style={{ fontSize: 10.5, color: T.amber, lineHeight: 1.5 }}>{feed.error}</div>}
              {Array.isArray(feed) && feed.length === 0 && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "8px 0" }}>No runs yet — queue a task and hit Run now.</div>}
              {Array.isArray(feed) && feed.map((f, i) => (
                <div key={i} style={{ ...S.inner, display: "flex", gap: 11, padding: "10px 12px" }}>
                  <span style={{ fontSize: 8.5, color: T.faint, fontFamily: mono, flex: "none", paddingTop: 2, width: 76 }}>{f.when}</span>
                  <span style={{ fontSize: 10.5, color: T.sub, lineHeight: 1.55, flex: 1 }}>{f.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right column: ambient behavior settings — not tied to any one run */}
        <div style={col}>
          <div style={card}>
            <div style={{ ...S.title, marginBottom: 4 }}>Control Panel</div>
            <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, marginBottom: 15 }}>How it behaves in general — separate from what happens on any one run.</div>

            <div style={{ fontSize: 9, fontWeight: 700, color: T.brass, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: syne, marginBottom: 9 }}>Brain</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span style={{ fontSize: 9.5, color: T.faint }}>model used for queued tasks</span>
              </div>
              <Segmented value={mini.model} onChange={k => setMini({ model: k })} />
            </div>

            <div style={{ height: 1, background: T.line, margin: "16px 0 14px" }} />

            <div style={{ fontSize: 9, fontWeight: 700, color: T.brass, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: syne, marginBottom: 9 }}>Oversight</div>
            <ToggleRow title="Full oversight" sub="audits Chief chat answers for smoothed-over board dissent" on={mini.oversight} onToggle={() => setMini({ oversight: !mini.oversight })} size={toggleSize} />

            <div style={{ height: 1, background: T.line, margin: "16px 0 14px" }} />

            <div style={{ fontSize: 9, fontWeight: 700, color: T.brass, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: syne, marginBottom: 9 }}>Quality &amp; Review</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              {EFFORT_LEVELS.map(e => (
                <button key={e.key} onClick={() => setEffort(e.key)} style={{ flex: 1, padding: "9px 4px", background: effort === e.key ? T.brass : "rgba(34,29,20,0.04)", border: effort === e.key ? "none" : "1px solid rgba(34,29,20,0.08)", borderRadius: 9, color: effort === e.key ? T.surface : T.sub, fontSize: 10.5, fontWeight: 700, fontFamily: syne, cursor: "pointer" }}>{e.label}</button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: T.faint, lineHeight: 1.5, marginBottom: 13 }}>{EFFORT_LEVELS.find(e => e.key === effort)?.desc}</div>
            {effort === "thorough" && (
              <div style={{ marginBottom: 13 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 7 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, fontFamily: syne, color: T.ink }}>Max passes</span>
                  <span style={{ fontSize: 9, color: T.faint }}>auto-stops early if nothing's changing</span>
                </div>
                <Chips options={["5", "15", "50"]} value={mini.loopMax} onChange={n => setMini({ loopMax: n })} fmt={v => v + "×"} />
              </div>
            )}
            <ToggleRow title="Approval gate" sub="finished drafts wait for your tap before counting as delivered" on={mini.approvalOn} onToggle={() => setMini({ approvalOn: !mini.approvalOn })} size={toggleSize} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Modals ──────────────────────────────────────────────────────────────────
function ModalShell({ onClose, children, isMobile, z = 300 }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4,7,14,0.72)", zIndex: z, display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: T.surface, borderRadius: isMobile ? "20px 20px 0 0" : 18, padding: "24px 24px calc(24px + env(safe-area-inset-bottom))", width: isMobile ? "100%" : 560, maxWidth: 560, border: `1px solid rgba(34,29,20,0.1)`, boxShadow: "0 32px 80px rgba(30,25,17,0.42), inset 0 1px 0 rgba(255,255,255,0.07)", animation: "sheetup 0.2s ease both", color: T.ink }}>
        {children}
      </div>
    </div>
  );
}

// One line per entry, parsed on save — simpler to build reliably and just
// as easy to edit as a row-based form, and easy to bulk-edit/copy-paste.
const COMMON_LEAGUES = [
  { sport: "football", league: "nfl", name: "NFL" },
  { sport: "basketball", league: "nba", name: "NBA" },
  { sport: "baseball", league: "mlb", name: "MLB" },
  { sport: "hockey", league: "nhl", name: "NHL" },
  { sport: "basketball", league: "wnba", name: "WNBA" },
  { sport: "football", league: "college-football", name: "College Football" },
  { sport: "basketball", league: "mens-college-basketball", name: "Men's College BB" },
  { sport: "basketball", league: "womens-college-basketball", name: "Women's College BB" },
  { sport: "soccer", league: "eng.1", name: "Premier League" },
  { sport: "soccer", league: "usa.1", name: "MLS" },
  { sport: "soccer", league: "uefa.champions", name: "Champions League" },
];

function SportsSettingsModal({ cfg, onSave, onClose, isMobile }) {
  const [teamOptions, setTeamOptions] = useState({}); // "sport/league" -> [{abbr,name}] | "loading" | "error"
  const [addLeague, setAddLeague] = useState(COMMON_LEAGUES[0].league);
  const [addTeam, setAddTeam] = useState("");
  const [gameLeague, setGameLeague] = useState(COMMON_LEAGUES[0].league);
  const [gameTeam1, setGameTeam1] = useState("");
  const [gameTeam2, setGameTeam2] = useState("");

  const leagueByKey = (league) => COMMON_LEAGUES.find(l => l.league === league) || COMMON_LEAGUES[0];

  const ensureTeams = async (league, force) => {
    const { sport } = leagueByKey(league);
    const key = `${sport}/${league}`;
    if (!force && Array.isArray(teamOptions[key])) return; // only skip if we already have a real list — "error" should always be retryable
    setTeamOptions(prev => ({ ...prev, [key]: "loading" }));
    const res = await callFnFull("sports", { mode: "teams", sport, league });
    if (res.ok && res.data?.success && Array.isArray(res.data.teams)) setTeamOptions(prev => ({ ...prev, [key]: res.data.teams }));
    else setTeamOptions(prev => ({ ...prev, [key]: "error" }));
  };
  useEffect(() => { ensureTeams(addLeague); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLeague]);
  useEffect(() => { if (gameLeague !== addLeague) ensureTeams(gameLeague); // avoid firing the exact same fetch twice on mount when both pickers still point at the default league
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameLeague]);

  const toggleWatchLeague = (l) => {
    const exists = (cfg.watchLeagues || []).some(w => w.league === l.league);
    const next = exists ? (cfg.watchLeagues || []).filter(w => w.league !== l.league) : [...(cfg.watchLeagues || []), { sport: l.sport, league: l.league, displayName: l.name }];
    onSave({ ...cfg, watchLeagues: next });
  };
  const addFollowedTeam = () => {
    if (!addTeam) return;
    const { sport, name: leagueName } = leagueByKey(addLeague);
    const key = `${sport}/${addLeague}`;
    const teamInfo = (Array.isArray(teamOptions[key]) ? teamOptions[key] : []).find(t => t.abbr === addTeam);
    if (!teamInfo) return;
    const next = [...(cfg.followedTeams || []), { sport, league: addLeague, team: teamInfo.abbr, displayName: `${teamInfo.name} (${leagueName})` }];
    onSave({ ...cfg, followedTeams: next });
    setAddTeam("");
  };
  const removeFollowedTeam = (i) => onSave({ ...cfg, followedTeams: (cfg.followedTeams || []).filter((_, idx) => idx !== i) });
  const addWatchGame = () => {
    if (!gameTeam1 || !gameTeam2 || gameTeam1 === gameTeam2) return;
    const { sport } = leagueByKey(gameLeague);
    const next = [...(cfg.watchGames || []), { sport, league: gameLeague, team1: gameTeam1, team2: gameTeam2 }];
    onSave({ ...cfg, watchGames: next });
    setGameTeam1(""); setGameTeam2("");
  };
  const removeWatchGame = (i) => onSave({ ...cfg, watchGames: (cfg.watchGames || []).filter((_, idx) => idx !== i) });
  const removeExcluded = (id) => onSave({ ...cfg, excludedGames: (cfg.excludedGames || []).filter(x => x !== id) });

  const label = { fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 7, display: "block" };
  const sel = { padding: "8px 10px", fontSize: 11.5, border: `1px solid ${T.line}`, borderRadius: 8, background: T.bg, color: T.ink, flex: 1, minWidth: 0 };
  const chip = (active) => ({ fontSize: 10.5, fontWeight: 600, padding: "6px 11px", borderRadius: 999, cursor: "pointer", border: `1px solid ${active ? T.brass : T.line}`, background: active ? "rgba(143,107,30,0.12)" : "transparent", color: active ? T.brass : T.sub });
  const teamsFor = (league) => { const { sport } = leagueByKey(league); const t = teamOptions[`${sport}/${league}`]; return Array.isArray(t) ? t : []; };

  return (
    <ModalShell onClose={onClose} isMobile={isMobile}>
      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: syne, marginBottom: 16 }}>Sports settings</div>

      <label style={label}>WATCH LEAGUES — tap to toggle (significant games even without a followed team)</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
        {COMMON_LEAGUES.map(l => (
          <span key={l.league} onClick={() => toggleWatchLeague(l)} style={chip((cfg.watchLeagues || []).some(w => w.league === l.league))}>{l.name}</span>
        ))}
      </div>

      <label style={label}>FOLLOWED TEAMS</label>
      <div style={{ display: "flex", gap: 7, marginBottom: 4, flexWrap: "wrap" }}>
        <select value={addLeague} onChange={e => { setAddLeague(e.target.value); setAddTeam(""); }} style={sel}>
          {COMMON_LEAGUES.map(l => <option key={l.league} value={l.league}>{l.name}</option>)}
        </select>
        <select value={addTeam} onChange={e => setAddTeam(e.target.value)} style={{ ...sel, flex: 1.6 }}>
          <option value="">{teamOptions[`${leagueByKey(addLeague).sport}/${addLeague}`] === "loading" ? "Loading teams…" : "Choose a team…"}</option>
          {teamsFor(addLeague).map(t => <option key={t.abbr} value={t.abbr}>{t.name}</option>)}
        </select>
        <button onClick={addFollowedTeam} disabled={!addTeam} style={{ ...S.brassBtn, padding: "0 14px", fontSize: 11, opacity: addTeam ? 1 : 0.5 }}>Add</button>
      </div>
      {teamOptions[`${leagueByKey(addLeague).sport}/${addLeague}`] === "error" && (
        <div style={{ fontSize: 10, color: T.red, marginBottom: 9 }}>Couldn't load {leagueByKey(addLeague).name} teams. <span onClick={() => ensureTeams(addLeague, true)} style={{ textDecoration: "underline", cursor: "pointer" }}>Retry</span></div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18, marginTop: 5 }}>
        {(cfg.followedTeams || []).map((t, i) => (
          <span key={i} onClick={() => removeFollowedTeam(i)} title="Tap to remove" style={{ fontSize: 10.5, color: T.ink, border: `1px solid ${T.line}`, borderRadius: 999, padding: "5px 11px", cursor: "pointer" }}>{t.displayName || t.team} ×</span>
        ))}
        {!(cfg.followedTeams || []).length && <span style={{ fontSize: 10.5, color: T.faint }}>None yet.</span>}
      </div>

      <label style={label}>SPECIFIC GAMES TO WATCH</label>
      <div style={{ display: "flex", gap: 7, marginBottom: 4, flexWrap: "wrap" }}>
        <select value={gameLeague} onChange={e => { setGameLeague(e.target.value); setGameTeam1(""); setGameTeam2(""); }} style={{ ...sel, flexBasis: "100%" }}>
          {COMMON_LEAGUES.map(l => <option key={l.league} value={l.league}>{l.name}</option>)}
        </select>
        <select value={gameTeam1} onChange={e => setGameTeam1(e.target.value)} style={sel}>
          <option value="">{teamOptions[`${leagueByKey(gameLeague).sport}/${gameLeague}`] === "loading" ? "Loading…" : "Team 1…"}</option>
          {teamsFor(gameLeague).map(t => <option key={t.abbr} value={t.abbr}>{t.name}</option>)}
        </select>
        <select value={gameTeam2} onChange={e => setGameTeam2(e.target.value)} style={sel}>
          <option value="">{teamOptions[`${leagueByKey(gameLeague).sport}/${gameLeague}`] === "loading" ? "Loading…" : "Team 2…"}</option>
          {teamsFor(gameLeague).map(t => <option key={t.abbr} value={t.abbr}>{t.name}</option>)}
        </select>
        <button onClick={addWatchGame} disabled={!gameTeam1 || !gameTeam2} style={{ ...S.brassBtn, padding: "0 14px", fontSize: 11, opacity: gameTeam1 && gameTeam2 ? 1 : 0.5 }}>Add</button>
      </div>
      {teamOptions[`${leagueByKey(gameLeague).sport}/${gameLeague}`] === "error" && (
        <div style={{ fontSize: 10, color: T.red, marginBottom: 9 }}>Couldn't load {leagueByKey(gameLeague).name} teams. <span onClick={() => ensureTeams(gameLeague, true)} style={{ textDecoration: "underline", cursor: "pointer" }}>Retry</span></div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
        {(cfg.watchGames || []).map((g, i) => (
          <span key={i} onClick={() => removeWatchGame(i)} title="Tap to remove" style={{ fontSize: 10.5, color: T.ink, border: `1px solid ${T.line}`, borderRadius: 999, padding: "5px 11px", cursor: "pointer" }}>{g.team1} vs {g.team2} ×</span>
        ))}
        {!(cfg.watchGames || []).length && <span style={{ fontSize: 10.5, color: T.faint }}>None yet.</span>}
      </div>

      {(cfg.excludedGames || []).length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <label style={label}>HIDDEN GAMES ({(cfg.excludedGames || []).length}) — tap to unhide</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {(cfg.excludedGames || []).map(id => (
              <span key={id} onClick={() => removeExcluded(id)} style={{ fontSize: 9.5, color: T.faint, border: `1px solid ${T.line}`, borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontFamily: mono }}>{id} ×</span>
            ))}
          </div>
        </div>
      )}

      <button onClick={onClose} style={{ ...S.brassBtn, padding: "9px 22px", fontSize: 12 }}>Done</button>
    </ModalShell>
  );
}

function SeatNotesModal({ seatKey, initial, onSave, onClose, isMobile }) {
  const seat = BOARD.find(b => b.key === seatKey);
  const [notes, setNotes] = useState(initial || "");
  const [saving, setSaving] = useState(false);
  if (!seat) return null;
  const save = async () => { setSaving(true); await onSave(seatKey, notes); setSaving(false); onClose(); };
  return (
    <ModalShell onClose={onClose} isMobile={isMobile}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: seat.color + "1F", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>{seat.emoji}</span>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: syne }}>{seat.name}</span>
      </div>
      <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.6, marginBottom: 15 }}>{seat.charter.slice(0, 160)}…</div>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(143,107,30,0.8)", textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: syne, marginBottom: 8 }}>Current context · treated as ground truth · synced everywhere</div>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Paste what's current — pipeline numbers, open questions, this week's state. The fresher this is, the sharper the seat's takes."
        style={{ ...S.input, width: "100%", minHeight: 150, padding: "12px 14px", fontSize: 13, resize: "vertical", lineHeight: 1.6 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button onClick={save} disabled={saving} style={{ ...S.brassBtn, flex: 1, padding: 13, fontSize: 12, opacity: saving ? 0.5 : 1 }}>{saving ? "Saving…" : "Save context"}</button>
        <button onClick={onClose} style={{ padding: "13px 18px", background: "transparent", border: `1px solid rgba(34,29,20,0.1)`, borderRadius: 10, color: T.sub, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
      </div>
    </ModalShell>
  );
}

function MigrationModal({ counts, onImport, onSkip, importing }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,16,0.75)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
      <div style={{ background: T.surface, borderRadius: 18, padding: "26px 28px", width: 440, maxWidth: "94vw", border: `1px solid rgba(34,29,20,0.1)`, boxShadow: "0 32px 80px rgba(30,25,17,0.38)", color: T.ink }}>
        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: syne, marginBottom: 8 }}>Import your existing memory?</div>
        <div style={{ fontSize: 12.5, color: T.sub, lineHeight: 1.7, marginBottom: 18 }}>
          This browser has data from before your account existed:{" "}
          <strong style={{ color: T.ink }}>{counts.chat} chat message{counts.chat !== 1 ? "s" : ""}</strong> and{" "}
          <strong style={{ color: T.ink }}>{counts.notes} seat note{counts.notes !== 1 ? "s" : ""}</strong>.
          Import them into your account so they're available on every device? Nothing is deleted either way.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onImport} disabled={importing} style={{ ...S.brassBtn, flex: 1, padding: 12, fontSize: 12, opacity: importing ? 0.5 : 1 }}>{importing ? "Importing…" : "Import"}</button>
          <button onClick={onSkip} disabled={importing} style={{ padding: "12px 18px", background: "transparent", border: `1px solid rgba(34,29,20,0.1)`, borderRadius: 10, color: T.sub, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Skip</button>
        </div>
      </div>
    </div>
  );
}

// ─── Auth screens ────────────────────────────────────────────────────────────
function SetupNotice() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: T.ink, padding: 20 }}>
      <div style={{ maxWidth: 480, padding: "28px 30px", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 18 }}>
        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: syne, marginBottom: 10 }}>Supabase not configured</div>
        <div style={{ fontSize: 13, color: T.sub, lineHeight: 1.7 }}>
          This build expects two environment variables on the Netlify site:<br />
          <code style={{ fontFamily: mono, fontSize: 12, color: T.brass }}>VITE_SUPABASE_URL</code> and <code style={{ fontFamily: mono, fontSize: 12, color: T.brass }}>VITE_SUPABASE_ANON_KEY</code>.<br /><br />
          Add them (Site configuration → Environment variables), trigger a redeploy, and this screen becomes a login.
        </div>
      </div>
    </div>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("password");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(false);

  const signIn = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setErr(error.message);
    setBusy(false);
  };
  const sendMagic = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } });
    if (error) setErr(error.message); else setSent(true);
    setBusy(false);
  };
  const disabled = busy || !email || (mode === "password" && !password);

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: T.ink, padding: 20 }}>
      <div style={{ width: 380, maxWidth: "94vw", padding: "30px 32px", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 18, boxShadow: "0 32px 80px rgba(30,25,17,0.38), inset 0 1px 0 rgba(255,255,255,0.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span style={{ width: 15, height: 15, transform: "rotate(45deg)", borderRadius: 3, background: T.brass }} />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: syne }}>The Board Room</span>
        </div>
        <div style={{ fontSize: 12, color: T.faint, marginBottom: 22 }}>One mind, any device. Sign in to continue.</div>
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="email" type="email" autoComplete="email"
          style={{ ...S.input, width: "100%", padding: "11px 13px", fontSize: 13, marginBottom: 10 }} />
        {mode === "password" && (
          <input value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === "Enter") signIn(); }} placeholder="password" type="password" autoComplete="current-password"
            style={{ ...S.input, width: "100%", padding: "11px 13px", fontSize: 13, marginBottom: 10 }} />
        )}
        {err && <div style={{ fontSize: 11, color: T.red, marginBottom: 10 }}>{err}</div>}
        {sent && <div style={{ fontSize: 11, color: T.green, marginBottom: 10 }}>Login link sent — check your email.</div>}
        <button onClick={mode === "password" ? signIn : sendMagic} disabled={disabled}
          style={{ ...(disabled ? { background: "rgba(34,29,20,0.06)", color: T.faint, border: "none", borderRadius: 10, fontFamily: syne, fontWeight: 700 } : S.brassBtn), width: "100%", padding: 12, fontSize: 12, cursor: disabled ? "default" : "pointer" }}>
          {busy ? (mode === "password" ? "Signing in…" : "Sending…") : (mode === "password" ? "Sign in" : "Email me a login link")}
        </button>
        <div onClick={() => { setMode(mode === "password" ? "magic" : "password"); setErr(null); setSent(false); }}
          style={{ fontSize: 10, color: T.faint, textAlign: "center", marginTop: 12, cursor: "pointer" }}>
          {mode === "password" ? "Use a magic link instead" : "Use a password instead"}
        </div>
      </div>
    </div>
  );
}

// ─── Navigation config ────────────────────────────────────────────────────────
// One list drives both platforms — desktop shows label+sub, mobile shows the
// icon only (label lives in aria-label/title). Same order, same set, same
// keys: nothing to learn twice.
const NAV = [
  { key: "brief", label: "Brief", sub: "BTC · stocks · wires · ZTS", mark: T.amber },
  { key: "personal", label: "Personal", sub: "notes · calendar · workout", mark: "#8B5CF6" },
  { key: "boardroom", label: "Board Room", sub: "mini me · learn · 5 seats", mark: T.brass },
  { key: "assets", label: "Assets", sub: "4 live properties · site auditor", mark: T.blue },
  { key: "systems", label: "Systems", sub: "usage · status · deploy · supabase", mark: "#0E9F6E" },
];
const HEADERS = {
  brief: ["Brief", "live markets, wires, and your stores"],
  boardroom: ["Board Room", "mini me · learned skills · 5 seats on call"],
  personal: ["Personal", "notes, calendar, and training — just for you"],
  assets: ["Assets", "everything you run, one click away"],
  systems: ["Systems", "usage, status, deploys, and supabase"],
};
// Small sport-type icons for the Sports tile — same line-icon style as
// NAV_ICONS below, just simplified further since these render tiny (~12px)
// inside a compact list row. Colored by the caller to double as the
// live/final/upcoming state indicator, replacing a plain dot.
const SPORT_ICONS = {
  baseball: (p) => (
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6.3 6c1.8 2 2.7 3.9 2.7 6s-.9 4-2.7 6" />
      <path d="M17.7 6c-1.8 2-2.7 3.9-2.7 6s.9 4 2.7 6" />
    </svg>
  ),
  football: (p) => (
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <ellipse cx="12" cy="12" rx="8.5" ry="5.5" />
      <line x1="6" y1="12" x2="18" y2="12" />
      <line x1="10.5" y1="9.8" x2="10.5" y2="8.4" /><line x1="13.5" y1="9.8" x2="13.5" y2="8.4" />
      <line x1="10.5" y1="14.2" x2="10.5" y2="15.6" /><line x1="13.5" y1="14.2" x2="13.5" y2="15.6" />
    </svg>
  ),
  basketball: (p) => (
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" />
      <line x1="3.5" y1="12" x2="20.5" y2="12" />
      <line x1="12" y1="3.5" x2="12" y2="20.5" />
      <path d="M6 5.8c2.2 2.2 3.3 4.2 3.3 6.2s-1.1 4-3.3 6.2" />
      <path d="M18 5.8c-2.2 2.2-3.3 4.2-3.3 6.2s1.1 4 3.3 6.2" />
    </svg>
  ),
  hockey: (p) => (
    <svg {...p} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <ellipse cx="12" cy="12" rx="8.5" ry="4" />
    </svg>
  ),
  soccer: (p) => (
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <polygon points="12,8 14.6,9.9 13.6,13 10.4,13 9.4,9.9" fill="currentColor" stroke="none" />
      <line x1="12" y1="3.5" x2="12" y2="8" /><line x1="14.6" y1="9.9" x2="18.7" y2="8.6" />
      <line x1="13.6" y1="13" x2="15.5" y2="17.2" /><line x1="10.4" y1="13" x2="8.5" y2="17.2" />
      <line x1="9.4" y1="9.9" x2="5.3" y2="8.6" />
    </svg>
  ),
};
const NAV_ICONS = {
  brief: (p) => ( // sunrise — the morning brief
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 17.5a5.5 5.5 0 0 1 11 0" />
      <line x1="12" y1="3" x2="12" y2="8.5" />
      <line x1="5.8" y1="9.3" x2="7.4" y2="10.9" /><line x1="18.2" y1="9.3" x2="16.6" y2="10.9" />
      <line x1="2.5" y1="17.5" x2="4.7" y2="17.5" /><line x1="19.3" y1="17.5" x2="21.5" y2="17.5" />
      <line x1="2" y1="21.5" x2="22" y2="21.5" />
    </svg>
  ),
  personal: (p) => ( // calendar page, leading with what's first on mobile now — notes live below it
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
      <line x1="3" y1="9.5" x2="21" y2="9.5" />
      <line x1="8" y1="2.5" x2="8" y2="6.5" /><line x1="16" y1="2.5" x2="16" y2="6.5" />
      <circle cx="8" cy="14.2" r="1.05" fill="currentColor" stroke="none" /><circle cx="12" cy="14.2" r="1.05" fill="currentColor" stroke="none" />
    </svg>
  ),
  boardroom: (p) => ( // a table with seats around it — the board convening, not a generic chat bubble
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="6.4" />
      <circle cx="12" cy="3.8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19.4" cy="8.3" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19.4" cy="15.7" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="20.2" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="15.7" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="8.3" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  ),
  assets: (p) => ( // classical column — on brand with the Roman aesthetic, still reads as "properties"
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="20" y2="21" /><line x1="4.5" y1="18" x2="19.5" y2="18" />
      <line x1="5" y1="3" x2="19" y2="3" />
      <line x1="7" y1="6" x2="7" y2="18" /><line x1="12" y1="6" x2="12" y2="18" /><line x1="17" y1="6" x2="17" y2="18" />
    </svg>
  ),
  systems: (p) => ( // terminal — systems
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="4" width="19" height="16" rx="2" /><polyline points="6.5 9.5 10.5 12 6.5 14.5" /><line x1="12.5" y1="15" x2="17.5" y2="15" />
    </svg>
  ),
  mini: (p) => ( // sparkle — mini me
    <svg {...p} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M12 2.5c.5 3.4 1.2 5.4 2.4 6.6 1.2 1.2 3.2 1.9 6.6 2.4-3.4.5-5.4 1.2-6.6 2.4-1.2 1.2-1.9 3.2-2.4 6.6-.5-3.4-1.2-5.4-2.4-6.6C8.4 12.7 6.4 12 3 11.5c3.4-.5 5.4-1.2 6.6-2.4 1.2-1.2 1.9-3.2 2.4-6.6z" />
    </svg>
  ),
};

// ─── Main app ────────────────────────────────────────────────────────────────
export default function App() {
  useGlobalStyles();
  const isMobile = useIsMobile();
  const btc = useBitcoinPrice();

  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [messages, setMessages] = useState([]);
  const [seatNotes, setSeatNotes] = useState({});
  const [settings, setSettings] = useState(null);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [editSeat, setEditSeat] = useState(null);
  const [migration, setMigration] = useState(null);
  const [importing, setImporting] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [page, setPage] = useState("brief"); // single nav state — same source of truth on mobile and desktop
  const [editingCal, setEditingCal] = useState(false);
  const [calDraft, setCalDraft] = useState("");
  const [dataStamp, setDataStamp] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const endRef = useRef(null);

  // Tick every 30s so the clock and freshness pill stay current.
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(iv);
  }, []);

  const [briefRefreshSignal, setBriefRefreshSignal] = useState(null);
  const refreshData = async () => {
    if (refreshing || !supabase || !session?.user) return;
    setRefreshing(true);
    btc.refresh();
    setBriefRefreshSignal(Date.now()); // the header button previously only touched chat/notes/settings/btc — gsc/clarify/zts/wire/shopify/calendar never actually refreshed when tapped despite implying they would
    try {
      const [chat, notes, sets] = await Promise.all([db.loadChat(), db.loadSeatNotes(), db.loadSettings()]);
      setMessages(chat); setSeatNotes(notes); setSettings(sets);
    } catch {}
    setDataStamp(Date.now());
    setNow(Date.now());
    setRefreshing(false);
  };

  useEffect(() => {
    if (!supabase) { setAuthChecked(true); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session || null); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => { sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!supabase) return;
    if (!session?.user) { setMessages([]); setSeatNotes({}); setSettings(null); return; }
    let alive = true;
    setLoadingData(true);
    (async () => {
      const [chat, notes, sets] = await Promise.all([db.loadChat(), db.loadSeatNotes(), db.loadSettings()]);
      if (!alive) return;
      setMessages(chat); setSeatNotes(notes); setSettings(sets);
      setDataStamp(Date.now());
      setLoadingData(false);
      if (!sm.get("migrated")) {
        const localChat = sm.get("chat") || [];
        const localNotes = sm.get("seat_notes") || {};
        const nNotes = Object.keys(localNotes).filter(k => localNotes[k]).length;
        if (chat.length === 0 && (localChat.length > 0 || nNotes > 0)) setMigration({ chat: localChat.length, notes: nNotes });
        else sm.set("migrated", true);
      }
    })();
    return () => { alive = false; };
  }, [session?.user?.id]);

  useEffect(() => {
    const el = endRef.current;
    if (el && el.parentElement) el.parentElement.scrollTop = el.parentElement.scrollHeight;
  }, [messages, thinking, page]);

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...(prev || {}), [key]: value }));
    db.saveSetting(key, value);
  };
  const saveSeatNote = async (key, notes) => {
    setSeatNotes(prev => ({ ...prev, [key]: notes }));
    await db.saveSeatNote(key, notes);
  };

  const runImport = async () => {
    setImporting(true);
    try {
      const localChat = sm.get("chat") || [];
      if (localChat.length) {
        const rows = localChat.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || ""), consulted_seats: m.consulted || [], created_at: m.ts ? new Date(m.ts).toISOString() : new Date().toISOString(), source: "web" }));
        await supabase.from("chat_messages").insert(rows);
      }
      const localNotes = sm.get("seat_notes") || {};
      for (const [k, v] of Object.entries(localNotes)) { if (v) await db.saveSeatNote(k, v); }
      sm.set("migrated", true);
      const chat = await db.loadChat();
      setMessages(chat);
      setSeatNotes(prev => ({ ...prev, ...localNotes }));
    } catch {}
    setImporting(false);
    setMigration(null);
  };
  const skipImport = () => { sm.set("migrated", true); setMigration(null); };

  // Scroll the active page back to top on nav tap — smooth if there's
  // actually somewhere to scroll from, skipped entirely if already at top
  // so it's not a pointless animation on every tap.
  const goToPage = (key) => {
    setPage(key);
    requestAnimationFrame(() => {
      const el = document.getElementById("page-scroll");
      if (el && el.scrollTop > 0) el.scrollTo({ top: 0, behavior: "smooth" });
    });
  };
  const [personalJumpTo, setPersonalJumpTo] = useState(null); // tells PersonalPage which sub-tab to open on arrival

  // Learned skills — loaded once per session, refreshed whenever the Learn
  // tab or /learn command changes them; injected into the Chief's prompt.
  const [skills, setSkills] = useState([]);
  const refreshSkills = async () => {
    try { setSkills(await makeSkillsDb(supabase).loadEnabled()); }
    catch { setSkills([]); } // table not created yet — chat just runs without skills
  };
  useEffect(() => { if (session?.user?.id) refreshSkills(); }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Summon (⌘K) — global jump + quick capture
  const [summon, setSummon] = useState(false);
  const [jump, setJump] = useState(null); // { t, page, sub, noteId?, skillId? }
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSummon(s => !s); }
      if (e.key === "Escape") setSummon(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (!session) setSummon(false); }, [session]);
  const summonGo = (target) => { setSummon(false); goToPage(target.page); setJump({ t: Date.now(), ...target }); };
  const summonJot = async (text) => { await db.saveNote({ id: crypto.randomUUID(), title: "", body: text }); };
  const summonQueueTask = async (text) => {
    const t = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, status: "queued", queued_at: Date.now() };
    updateSetting("mini_tasks", [t, ...(settings?.mini_tasks || [])]);
  };
  const summonEl = summon ? <Summon onClose={() => setSummon(false)} onGo={summonGo} onJot={summonJot} onQueueTask={summonQueueTask} isMobile={isMobile} /> : null;
  const summonBtn = (compact) => (
    <button onClick={() => setSummon(true)} aria-label="Summon — search everything"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: compact ? "5px 9px" : "5px 11px", background: "transparent", border: `1px solid ${T.lineStrong}`, borderRadius: 8, color: T.sub, fontSize: 9.5, fontFamily: mono, letterSpacing: "0.08em", cursor: "pointer" }}>
      <span style={{ width: 5, height: 5, transform: "rotate(45deg)", background: T.brass, borderRadius: 1 }} />{compact ? "⌘K" : "SUMMON ⌘K"}
    </button>
  );
  const goToCalendar = () => { setPersonalJumpTo(Date.now()); goToPage("personal"); }; // timestamp so re-tapping still re-triggers even if already on Personal

  const send = async () => {
    const q = input.trim();
    if (!q || thinking) return;
    setInput("");
    const userMsg = { role: "user", content: q, ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    db.saveMessage({ role: "user", content: q });
    setThinking(true);

    // "/learn <url or anything>" — teach a skill right from the chat instead
    // of convening the board. Mirrors the Learn tab pipeline exactly.
    const learnCmd = parseLearnCommand(q);
    if (learnCmd) {
      let reply;
      if (learnCmd.open) {
        reply = "Give me something to learn — `/learn <url or pasted text>` — or use the Learn tab up top, which also shows everything I've been taught.";
      } else {
        const result = await learnFromInput({
          text: learnCmd.text, supabase, callClaude,
          modelKey: (settings?.mini || {}).model || "haiku",
          accessToken: session?.access_token || "",
        });
        if (result.error === "missing_table") reply = "The skills table isn't set up yet — open the Learn tab and it'll hand you the one-time SQL to paste into Supabase.";
        else if (result.error) reply = `Couldn't learn that: ${result.error}`;
        else {
          const skipped = result.failedUrls?.length ? `\n\n(Couldn't read ${result.failedUrls.map(f => f.url).join(", ")} — learned from the rest.)` : "";
          reply = `◆ Learned "${result.skill.title}" — ${result.skill.description}${skipped}\n\nIt's loaded into every chat and queue run from here on. It lives in the Learn tab if you want to edit or disable it.`;
          refreshSkills();
        }
      }
      setThinking(false);
      const asstMsg = { role: "assistant", content: reply, ts: Date.now() };
      setMessages([...next, asstMsg]);
      db.saveMessage({ role: "assistant", content: reply });
      return;
    }

    const models = { ...DEFAULT_MODELS, ...(settings?.models || {}) };
    const result = await convene(q, next, { models, seatNotes, skills });
    setThinking(false);
    const asstMsg = { role: "assistant", content: result.answer, consulted: result.consulted, ts: Date.now() };
    setMessages([...next, asstMsg]);
    db.saveMessage({ role: "assistant", content: result.answer, consulted: result.consulted });
    runOversight(q, result); // fire-and-forget — never blocks the chat
  };

  const clearChat = async () => {
    if (!window.confirm("Clear the whole chat history? This can't be undone.")) return;
    try { await db.clearChat(); setMessages([]); } catch (e) { alert(e.message || "Couldn't clear chat."); }
  };

  // Real oversight: if the user has it on and 2+ seats were consulted, ask a
  // fresh Claude call to actually check whether the Chief's synthesis
  // represented every seat's take fairly, or quietly smoothed over dissent.
  // Only writes to the feed when it finds something — silence otherwise.
  const runOversight = async (question, result) => {
    const mini = settings?.mini || {};
    if (mini.enabled === false || !mini.oversight) return;
    if (!result.consulted || result.consulted.length < 2) return;
    try {
      const seatBlock = result.consulted.map(c => `[${c.name}]: ${c.take}`).join("\n\n");
      const system = `You audit a "Chief of Staff" AI's synthesis for whether it fairly represented disagreement between specialist seats, or smoothed it over. Question: "${question}"\n\nSeat takes:\n${seatBlock}\n\nChief's synthesized answer:\n${result.answer}\n\nIf the seats meaningfully disagreed and the Chief's answer glossed over, hid, or flattened that disagreement, respond with ONLY a one-sentence description of what was smoothed over. If the Chief fairly represented any disagreement (or the seats didn't meaningfully disagree), respond with exactly: OK`;
      const verdict = await callClaude({ system, messages: [{ role: "user", content: "Audit this exchange." }], modelKey: mini.model || "haiku", maxTokens: 150, fn: "oversight" });
      if (verdict && verdict.trim() !== "OK" && !verdict.trim().startsWith("OK")) {
        await supabase.from("mini_feed").insert({ user_id: (await supabase.auth.getUser()).data?.user?.id, text: `Oversight: ${verdict.trim()}` });
      }
    } catch { /* best-effort — never surface oversight failures to the user */ }
  };

  if (!supabase) return <SetupNotice />;
  if (!authChecked) return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: T.faint, fontSize: 13 }}><span style={{ animation: "pulse 1.4s infinite" }}>Waking the room…</span></div>;
  if (!session) return <LoginScreen />;

  const calUrl = settings?.calendar_url || "";
  const totalSpend = obs.all().reduce((s, l) => s + (l.cost || 0), 0);

  const renderPage = (key) => {
    switch (key) {
      case "brief": return <MorningBriefPage btc={btc} isMobile={isMobile} settings={settings} updateSetting={updateSetting} onOpenCalendar={goToCalendar} refreshSignal={briefRefreshSignal} />;
      case "boardroom": return <BoardRoomPage messages={messages} thinking={thinking} loadingData={loadingData} input={input} setInput={setInput} onSend={send} onClearChat={clearChat} endRef={endRef} seatNotes={seatNotes} onEditSeat={setEditSeat} settings={settings} updateSetting={updateSetting} session={session} onWorkerRun={refreshData} onSkillsChanged={refreshSkills} jump={jump} isMobile={isMobile} />;
      case "personal": return <PersonalPage isMobile={isMobile} jumpSignal={personalJumpTo} jump={jump} settings={settings} updateSetting={updateSetting} />;
      case "assets": return <PropertiesPage isMobile={isMobile} settings={settings} updateSetting={updateSetting} session={session} />;
      case "systems": return <SystemsPage settings={settings} updateSetting={updateSetting} session={session} btc={btc} isMobile={isMobile} />;
      default: return null;
    }
  };

  // ═══ MOBILE SHELL ═══
  // Same NAV, same pages, same order as desktop — only the chrome differs
  // (icons instead of labels). Room used to be a special floating pill that
  // expanded into a sheet; it's now a normal tab like everything else.
  if (isMobile) {
    return (
      <div style={{ height: "100dvh", display: "flex", flexDirection: "column", color: T.ink, position: "relative", overflow: "hidden" }}>
        <div style={{ flex: "none", height: 54, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", borderBottom: `1px solid ${T.line}`, background: "rgba(243,241,236,0.9)", backdropFilter: "blur(14px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ width: 13, height: 13, transform: "rotate(45deg)", borderRadius: 2.5, background: T.brass }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", fontFamily: syne }}>{HEADERS[page][0]}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            {summonBtn(true)}
            <TopStatus now={now} dataStamp={dataStamp} refreshing={refreshing} onRefresh={refreshData} compact />
          </div>
        </div>

        <div id="page-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {renderPage(page)}
        </div>

        {/* Bottom nav — icon-only, same 6 destinations as the desktop rail */}
        <div style={{ flex: "none", display: "flex", borderTop: `1px solid ${T.line}`, background: "rgba(243,241,236,0.94)", backdropFilter: "blur(12px)" }}>
          {NAV.map(n => {
            const active = page === n.key;
            const Icon = NAV_ICONS[n.key];
            return (
              <button key={n.key} onClick={() => goToPage(n.key)} title={n.label} aria-label={n.label} aria-current={active ? "page" : undefined}
                style={{ flex: 1, minHeight: 66, position: "relative", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: "9px 0 calc(9px + env(safe-area-inset-bottom))" }}>
                <span style={{ position: "absolute", top: 7, left: "50%", transform: "translateX(-50%)", width: 6, height: 6, borderRadius: "50%", background: T.brass, opacity: active ? 1 : 0, transition: "opacity 0.15s", transform: "translateX(-50%) rotate(45deg)", borderRadius: 1.5 }} />
                <Icon width={23} height={23} color={active ? T.ink : T.faint} style={{ transition: "color 0.15s" }} />
              </button>
            );
          })}
        </div>

        {summonEl}
        {editSeat && <SeatNotesModal seatKey={editSeat} initial={seatNotes[editSeat]} onSave={saveSeatNote} onClose={() => setEditSeat(null)} isMobile />}
        {migration && <MigrationModal counts={migration} onImport={runImport} onSkip={skipImport} importing={importing} />}
      </div>
    );
  }

  // ═══ DESKTOP SHELL ═══
  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "264px minmax(0,1fr)", color: T.ink }}>
      {/* Nav rail */}
      <div style={{ borderRight: `1px solid ${T.line}`, padding: "26px 16px 16px", display: "flex", flexDirection: "column", gap: 20, height: "100vh", position: "sticky", top: 0, overflowY: "auto", background: "transparent" }}>
        <div style={{ padding: "0 6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <span style={{ width: 15, height: 15, transform: "rotate(45deg)", borderRadius: 3, background: T.brass }} />
            <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: syne }}>Board Room</span>
          </div>
          <div style={{ height: 1, background: T.line, marginTop: 16 }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {NAV.map(n => {
            const active = page === n.key;
            return (
              <div key={n.key} onClick={() => goToPage(n.key)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 13px", borderRadius: 12, cursor: "pointer", background: active ? "rgba(138,103,28,0.07)" : "transparent", border: "1px solid transparent" }}>
                <span style={{ width: 7, height: 7, transform: "rotate(45deg)", background: active ? n.mark : "rgba(32,27,18,0.18)", flex: "none", borderRadius: 1.5 }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, color: active ? T.ink : T.sub, letterSpacing: "0.02em" }}>{n.label}</span>
                  <span style={{ fontSize: 9.5, color: T.faint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.sub}</span>
                </span>
              </div>
            );
          })}
        </div>

        {/* Signals cluster */}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ padding: "13px 14px", background: "rgba(32,27,18,0.03)", border: `1px solid ${T.line}`, borderRadius: 12, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 15, height: 15, borderRadius: "50%", background: "#F7931A", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, color: "#1A0F00" }}>₿</span>
                <span style={{ fontSize: 13, fontWeight: 500, fontFamily: mono }}>{btc.loading ? "…" : btc.error ? "—" : "$" + btc.price?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </div>
              {!btc.loading && !btc.error && (
                <span style={{ fontSize: 10, fontWeight: 700, color: (btc.changePct || 0) >= 0 ? T.green : T.red, fontFamily: mono }}>{(btc.changePct || 0) >= 0 ? "▲" : "▼"} {Math.abs(btc.changePct || 0).toFixed(2)}%</span>
              )}
            </div>
            <Sparkline points={btc.points} color={(btc.changePct || 0) >= 0 ? T.green : T.red} height={30} />
          </div>

          {calUrl && !editingCal ? (
            <a href={calUrl} target="_blank" rel="noopener" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", background: "rgba(143,107,30,0.08)", border: "1px solid rgba(143,107,30,0.25)", borderRadius: 12, color: T.brass, fontSize: 11, fontWeight: 700, textDecoration: "none" }}>Open Calendar <span>›</span></a>
          ) : !editingCal ? (
            <button onClick={() => { setEditingCal(true); setCalDraft(calUrl); }} style={{ width: "100%", padding: "11px 14px", background: "rgba(34,29,20,0.02)", border: "1px dashed rgba(34,29,20,0.14)", borderRadius: 12, color: T.sub, fontSize: 10.5, cursor: "pointer", textAlign: "left" }}>+ Link your calendar</button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <input value={calDraft} onChange={e => setCalDraft(e.target.value)} placeholder="calendar share URL" style={{ ...S.input, width: "100%", padding: "9px 11px", fontSize: 11, borderRadius: 9 }} />
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => { updateSetting("calendar_url", calDraft.trim()); setEditingCal(false); }} style={{ ...S.brassBtn, flex: 1, padding: 8, fontSize: 10.5, borderRadius: 8 }}>Save</button>
                <button onClick={() => setEditingCal(false)} style={{ padding: "8px 11px", background: "transparent", border: `1px solid rgba(34,29,20,0.1)`, borderRadius: 8, color: T.sub, fontSize: 10.5, cursor: "pointer" }}>Cancel</button>
              </div>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderTop: `1px solid ${T.line}`, paddingTop: 12 }}>
            <span style={{ fontSize: 9.5, color: T.faint, fontFamily: mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.user?.email}</span>
            <button onClick={() => supabase.auth.signOut()} style={{ background: "none", border: `1px solid rgba(34,29,20,0.1)`, borderRadius: 7, color: T.sub, fontSize: 9, padding: "4px 9px", cursor: "pointer", fontWeight: 600 }}>Sign out</button>
          </div>
        </div>
      </div>

      {/* Main column */}
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", minWidth: 0 }}>
        <div style={{ height: 58, flex: "none", borderBottom: `1px solid ${T.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 34px", background: "transparent" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: syne, letterSpacing: "0.18em", textTransform: "uppercase" }}>{HEADERS[page][0]}</span>
            <span style={{ width: 5, height: 5, transform: "rotate(45deg)", background: "rgba(138,103,28,0.5)", borderRadius: 1, flex: "none" }} />
            <span style={{ fontSize: 9.5, color: T.faint, fontFamily: mono, letterSpacing: "0.08em" }}>{HEADERS[page][1]}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {summonBtn(false)}
            <span style={{ fontSize: 9.5, color: T.faint, fontFamily: mono, letterSpacing: "0.05em" }}>SESSION ${totalSpend.toFixed(3)} · {obs.all().length} CALLS</span>
            <TopStatus now={now} dataStamp={dataStamp} refreshing={refreshing} onRefresh={refreshData} />
          </div>
        </div>

        <div id="page-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {renderPage(page)}
        </div>
      </div>

      {summonEl}
      {editSeat && <SeatNotesModal seatKey={editSeat} initial={seatNotes[editSeat]} onSave={saveSeatNote} onClose={() => setEditSeat(null)} />}
      {migration && <MigrationModal counts={migration} onImport={runImport} onSkip={skipImport} importing={importing} />}
    </div>
  );
}
