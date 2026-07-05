import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// ════════════════════════════════════════════════════════════════════════════
// THE BOARD ROOM — supercomputer edition.
// Nav pages: The Room (chat) · Morning Brief · The Board · Your Properties ·
// IT Department (deploys / Supabase console / model control / auditor) ·
// Mini Me (growing sidekick: looping, skills, overnight queue, oversight).
// Desktop: nav rail + full-width page. Mobile: bottom tabs + collapsible chat
// pill that expands into a sheet. Supabase remains the shared brain.
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
  { key: "macro", name: "Macro Strategist", emoji: "📈", color: "#3B82F6",
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
  const system = `${seat.charter}${notes ? `\n\nCurrent context from Cameron (treat as ground truth):\n${notes}` : ""}\n\nYou are giving your seat's perspective to the Chief of Staff, who will synthesize. Be concise: 2-4 sentences of your genuine take, including any disagreement or risk you see. No preamble.`;
  const text = await callClaude({ system, messages: [{ role: "user", content: question }], modelKey: models.seats, maxTokens: 300, fn: `seat_${seatKey}` });
  return text ? { seat: seat.key, name: seat.name, emoji: seat.emoji, color: seat.color, take: text } : null;
}

async function convene(question, history, { models = DEFAULT_MODELS, seatNotes } = {}) {
  const routing = await routeQuestion(question, models);
  const takes = routing.seats.length
    ? (await Promise.all(routing.seats.map(k => consultSeat(k, question, seatNotes, models)))).filter(Boolean)
    : [];
  const historyMsgs = (history || []).slice(-8).map(m => ({ role: m.role, content: m.content }));
  const boardBlock = takes.length
    ? `\n\nThe board seats you consulted returned these takes:\n${takes.map(t => `[${t.name}]: ${t.take}`).join("\n\n")}\n\nSynthesize into one answer. Attribute perspectives naturally ("Clarify's lead thinks..."). If seats conflict, surface the conflict and give YOUR recommendation.`
    : "";
  const answer = await callClaude({
    system: CHIEF_SYSTEM + boardBlock,
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
const syne = "'Syne', system-ui", mono = "'DM Mono', monospace";
const T = {
  bg: "#0A0F1C", ink: "#EDF1F7", sub: "#9AA6BC", faint: "#5B6778",
  brass: "#D9B15E", brassDeep: "#8A6420", line: "rgba(255,255,255,0.08)",
  green: "#34D399", red: "#F87171", amber: "#F59E0B", blue: "#3B82F6",
};
const S = {
  card: { padding: "19px 21px", background: "linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))", border: `1px solid ${T.line}`, borderRadius: 16, boxShadow: "0 12px 32px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06)" },
  cardM: { padding: 17, background: "linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))", border: `1px solid ${T.line}`, borderRadius: 15, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)" },
  inner: { background: "rgba(0,0,0,0.22)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 11 },
  title: { fontSize: 12.5, fontWeight: 700, fontFamily: syne, color: T.ink },
  microLabel: { fontSize: 8.5, color: T.faint, fontFamily: mono, letterSpacing: "0.08em" },
  brassBtn: { background: `linear-gradient(135deg, ${T.brass}, ${T.brassDeep})`, border: "none", borderRadius: 10, color: T.bg, fontWeight: 800, fontFamily: syne, cursor: "pointer", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35)" },
  ghostBtn: { background: "rgba(200,160,74,0.1)", border: "1px solid rgba(200,160,74,0.28)", borderRadius: 8, color: T.brass, fontWeight: 700, fontFamily: syne, cursor: "pointer" },
  input: { background: "rgba(255,255,255,0.04)", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: 10, color: T.ink },
};

function useGlobalStyles() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&family=Syne:wght@600;700;800&display=swap";
    document.head.appendChild(link);
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      * { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
      html, body { margin: 0; font-family: 'Inter', system-ui, sans-serif; overscroll-behavior-y: none; }
      body { background-color: #0A0F1C; background-image: radial-gradient(1200px 600px at 12% -8%, rgba(200,160,74,0.10), transparent 60%), radial-gradient(900px 600px at 100% 0%, rgba(59,130,246,0.05), transparent 55%), linear-gradient(180deg,#0B101E 0%,#090E1A 100%); background-attachment: fixed; }
      ::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 10px; }
      textarea, input, select, button { font-family: 'Inter', system-ui, sans-serif; }
      ::selection { background: rgba(200,160,74,0.35); color: #FFF; }
      button, a, input, textarea { transition: all 0.16s ease; }
      button:focus-visible, input:focus-visible, textarea:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(200,160,74,0.4); }
      input::placeholder, textarea::placeholder { color: #5B6778; }
      textarea:focus, input:focus { outline: none; }
      @media (max-width: 760px) { input, textarea, select { font-size: 16px !important; } }
      @keyframes fadein { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      @keyframes sheetup { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } }
      @keyframes breathe { 0%,100% { box-shadow: 0 0 18px rgba(200,160,74,0.35), inset 0 1px 0 rgba(255,255,255,0.4); } 50% { box-shadow: 0 0 34px rgba(200,160,74,0.6), inset 0 1px 0 rgba(255,255,255,0.4); } }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
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
  { name: "Clarify Paid Search", desc: "Boutique Google Ads agency", url: "https://clarifypaidsearch.com", appUrl: "https://coruscating-sundae-f0def3.netlify.app", color: "#B68A2E", repo: "camcarp14/clarify-outreach", site: "clarify-paid-search" },
  { name: "Clarify SaaS", desc: "Google Ads auditing tool", url: "https://clarify-saas.netlify.app/", appUrl: "https://clarify-saas.netlify.app/", color: "#B68A2E", repo: "camcarp14/clarify-saas", site: "clarify-saas" },
  { name: "Zero To Secure", desc: "Premium seed phrase backup", url: "https://zerotosecure.com", appUrl: "https://zts-command-center.netlify.app", color: "#0E9F6E", repo: "camcarp14/zts-command-center", site: "zero-to-secure" },
  { name: "Macro Command Center", desc: "Markets, portfolio, thesis", url: null, appUrl: "https://macro-command-center.netlify.app/", color: "#3B82F6", repo: "camcarp14/macro-command-center", site: "macro-command-center" },
  { name: "Board Room", desc: "This app", url: null, appUrl: "https://board-room.netlify.app", color: "#C8A04A", repo: "camcarp14/board-room", site: "board-room" },
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
          if (data?.success && alive) { setState({ price: data.price, changePct: data.changePct, points: data.points || [], high24: data.high24 ?? null, low24: data.low24 ?? null, loading: false, error: null, fetchedAt: Date.now() }); return; }
        }
        if (res.status !== 404) throw new Error(`proxy ${res.status}`);
      } catch { /* fall through to direct fetch below */ }
      // Function not deployed yet (e.g. plain `vite dev`) or the proxy failed — try direct.
      try {
        const direct = await fetchDirect();
        if (alive) setState({ ...direct, loading: false, error: null, fetchedAt: Date.now() });
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
    <span onClick={onToggle} style={{ width: w, height: size, borderRadius: size / 2 + 1, background: on ? "linear-gradient(135deg, #2BB786, #1E8F68)" : "rgba(255,255,255,0.12)", position: "relative", cursor: "pointer", display: "inline-block", flex: "none", transition: "background 0.15s", boxShadow: "inset 0 1px 2px rgba(0,0,0,0.3)" }}>
      <span style={{ position: "absolute", top: 2, left: on ? w - knob - 2 : 2, width: knob, height: knob, borderRadius: "50%", background: T.ink, transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }} />
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
    <div style={{ display: "flex", gap: 4, background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 11, padding: 3 }}>
      {MODEL_META.map(m => {
        const active = value === m.key;
        return (
          <button key={m.key} onClick={() => onChange(m.key)} style={{ flex: 1, padding: "7px 0 6px", background: active ? `linear-gradient(135deg, ${T.brass}, ${T.brassDeep})` : "transparent", border: "none", borderRadius: 8, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 1, boxShadow: active ? "inset 0 1px 0 rgba(255,255,255,0.35), 0 2px 8px rgba(200,160,74,0.3)" : "none" }}>
            <span style={{ fontSize: 10, fontWeight: 800, fontFamily: syne, color: active ? T.bg : T.sub }}>{m.label}</span>
            <span style={{ fontSize: 7.5, fontFamily: mono, color: active ? "rgba(10,15,28,0.7)" : T.faint }}>{m.price}</span>
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
          <button key={o} onClick={() => onChange(o)} style={{ flex: 1, padding: "9px 0", background: active ? "rgba(200,160,74,0.14)" : "rgba(0,0,0,0.22)", border: `1px solid ${active ? "rgba(200,160,74,0.4)" : "rgba(255,255,255,0.06)"}`, borderRadius: 10, color: active ? T.brass : T.sub, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>{fmt(o)}</button>
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

function StatBox({ value, label, delta, deltaColor = T.green, valueColor = T.ink }) {
  return (
    <div style={{ ...S.inner, padding: "10px 8px", textAlign: "center", borderRadius: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: mono, color: valueColor }}>{value}</div>
      <div style={{ fontSize: 8, color: T.faint, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 }}>{label}</div>
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
          <div style={{ fontSize: compact ? 23 : 34, fontWeight: 800, fontFamily: syne, color: T.ink, letterSpacing: "-0.01em" }}>The room is yours.</div>
          <div style={{ fontSize: compact ? 12.5 : 13, color: T.sub, lineHeight: 1.7 }}>Ask the Chief of Staff anything. It routes each question to the seats that matter and brings back one synthesized answer — with the disagreements left in.</div>
          <div style={{ display: "flex", flexDirection: compact ? "column" : "row", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 8, width: "100%" }}>
            {SUGGESTIONS.map((s, i) => (
              <button key={i} onClick={() => setInput(s)} style={{ padding: compact ? "12px 15px" : "10px 16px", background: "rgba(255,255,255,0.035)", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: compact ? 12 : 20, color: T.sub, fontSize: 11.5, cursor: "pointer", textAlign: compact ? "left" : "center" }}>{s}</button>
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
            <div style={{ padding: compact ? "11px 14px" : "13px 17px", borderRadius: user ? "16px 16px 5px 16px" : "16px 16px 16px 5px", background: user ? "linear-gradient(135deg, rgba(200,160,74,0.16), rgba(182,138,46,0.08))" : "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.025))", border: `1px solid ${user ? "rgba(200,160,74,0.32)" : T.line}`, fontSize: 13.5, lineHeight: 1.68, whiteSpace: "pre-wrap", color: T.ink, boxShadow: "0 8px 24px rgba(0,0,0,0.22)" }}>{m.content}</div>
            {m.source === "discord" && <div style={{ fontSize: 8.5, color: T.faint, fontFamily: mono, letterSpacing: "0.06em" }}>VIA DISCORD</div>}
          </div>
        );
      })}
      {thinking && (
        <div style={{ alignSelf: "flex-start", padding: "12px 16px", borderRadius: "16px 16px 16px 5px", background: "rgba(255,255,255,0.04)", border: `1px solid ${T.line}`, fontSize: 12, color: T.sub }}>
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
    <div style={{ display: "flex", gap: compact ? 8 : 10, background: "linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.03))", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 16, padding: compact ? "5px 5px 5px 16px" : "6px 6px 6px 20px", boxShadow: compact ? "inset 0 1px 0 rgba(255,255,255,0.07)" : "0 20px 50px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.07)" }}>
      <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
        placeholder={compact ? "Ask the Chief…" : "Ask the Chief of Staff…"} rows={1}
        style={{ flex: 1, background: "transparent", border: "none", color: T.ink, fontSize: 13.5, resize: "none", padding: compact ? "11px 0" : "12px 0", lineHeight: 1.5, outline: "none" }} />
      <button onClick={onSend} disabled={!canSend} style={{ padding: compact ? "0 18px" : "0 26px", minHeight: compact ? 44 : undefined, background: canSend ? `linear-gradient(135deg, ${T.brass}, ${T.brassDeep})` : "rgba(255,255,255,0.05)", border: "none", borderRadius: 11, color: canSend ? T.bg : T.faint, fontSize: 12, fontWeight: 800, cursor: canSend ? "pointer" : "default", fontFamily: syne, boxShadow: canSend ? "0 4px 14px rgba(200,160,74,0.35), inset 0 1px 0 rgba(255,255,255,0.35)" : "none" }}>Ask</button>
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
        style={{ width: compact ? 34 : 30, height: compact ? 34 : 30, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "rgba(200,160,74,0.1)", border: "1px solid rgba(200,160,74,0.3)", borderRadius: 9, cursor: refreshing ? "default" : "pointer", flex: "none", padding: 0 }}>
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
function RoomPage({ messages, thinking, loadingData, input, setInput, onSend, endRef, isMobile }) {
  return (
    <>
      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "16px 14px 8px" : "32px 34px 10px", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: "100%", maxWidth: 780, display: "flex", flexDirection: "column", gap: 18, flex: 1 }}>
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
// Static analysis below is placeholder copy; wire /.netlify/functions/brief to
// have the Chief regenerate it at 6:00 AM (markets APIs + X-list summarizer).
// No fabricated fallback numbers anywhere on this page. Each card is either
// LIVE (real data), NOT CONNECTED (with exact setup instructions), or ERROR
// (with the actual failure). Empty dashes beat plausible-looking fake data.
const GSC_EMPTY = { impressions: "—", impressionsD: "", clicks: "—", clicksD: "", pos: "—", posD: "", series: Array(14).fill(0), note: "" };
const SHOP_EMPTY = { visits: "—", visitsD: "", conv: "—", convD: "", orders: "—", ordersD: "", series: Array(14).fill(0), note: "" };
const STOCKS_EMPTY = { spx: { value: "—", up: true }, ndq: { value: "—", up: true }, tnx: { value: "—", up: true }, dxy: { value: "—", up: true } };

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

function MorningBriefPage({ btc, isMobile }) {
  const [gsc, setGsc] = useState(GSC_EMPTY);
  const [gscStatus, setGscStatus] = useState({ state: "loading" });
  const [shop, setShop] = useState(SHOP_EMPTY);
  const [shopStatus, setShopStatus] = useState({ state: "loading" });
  const [stocks, setStocks] = useState(STOCKS_EMPTY);
  const [stocksStatus, setStocksStatus] = useState({ state: "loading" });
  const [events, setEvents] = useState([]);
  const [eventsStatus, setEventsStatus] = useState({ state: "loading" });
  const [wire, setWire] = useState([]);
  const [wireStatus, setWireStatus] = useState({ state: "loading" });

  useEffect(() => {
    let alive = true;
    // Credentialed cards: ping first so a missing key shows setup instructions, not an error.
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
    // Keyless cards: just try, report the real failure if any.
    const loadOpen = async (fn, apply, setStatus) => {
      const res = await callFnFull(fn, {});
      if (!alive) return;
      if (res.status === 404) return setStatus({ state: "nofn", detail: `push netlify/functions/${fn}.js and redeploy` });
      if (res.ok && res.data?.success) { apply(res.data); setStatus({ state: "live" }); }
      else setStatus({ state: "error", detail: res.data?.error || (res.status ? `HTTP ${res.status}` : "unreachable") });
    };
    loadCredentialed("gsc", { site: "zerotosecure.com", days: 14 }, setGsc, setGscStatus,
      (m) => `Add ${m || "GSC_CLIENT_EMAIL + GSC_PRIVATE_KEY"} in Netlify env vars, share the Search Console property with the service account, then redeploy.`);
    loadCredentialed("shopify", { days: 14 }, setShop, setShopStatus,
      (m) => `Add ${m || "SHOPIFY_SHOP + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET"} in Netlify env vars, then redeploy.`);
    loadOpen("markets", (d) => setStocks(d), setStocksStatus);
    loadOpen("calendar", (d) => setEvents(d.events || []), setEventsStatus);
    loadOpen("wire", (d) => setWire(d.wire || []), setWireStatus);
    return () => { alive = false; };
  }, []);

  const price = btc.loading ? "…" : btc.error || btc.price == null ? "—" : "$" + btc.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const hasChange = !btc.loading && !btc.error && btc.changePct !== null && btc.changePct !== undefined;
  const up = (btc.changePct || 0) >= 0;
  const hasRange = !btc.loading && !btc.error && btc.high24 != null && btc.low24 != null;
  const fmtK = (n) => "$" + (n / 1000).toFixed(1) + "K";
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
  const grid = { maxWidth: 1020, margin: "0 auto", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: isMobile ? 12 : 14, alignItems: "start" };
  const card = isMobile ? S.cardM : S.card;
  const FeedFallbackRow = ({ status }) => (
    <div style={{ ...S.inner, display: "flex", alignItems: "center", gap: 11, padding: "11px 13px" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: CARD_STATES[status.state]?.color || T.faint, flex: "none" }} />
      <span style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, flex: 1 }}>{status.state === "loading" ? "Loading…" : status.detail || "Feed unavailable."}</span>
    </div>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "18px 16px 24px" : "30px 34px 40px" }}>
      <div style={grid}>
        {/* Bitcoin outlook */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 18, height: 18, borderRadius: "50%", background: "linear-gradient(135deg,#F7931A,#C77416)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: "#1A0F00" }}>₿</span>
              <span style={S.title}>Bitcoin · Day Outlook</span>
            </div>
            <StancePill text={stance} color={stanceColor} />
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 13 }}>
            <span style={{ fontSize: 26, fontWeight: 500, fontFamily: mono, color: T.ink }}>{price}</span>
            {hasChange && <span style={{ fontSize: 12, fontWeight: 700, color: up ? T.green : T.red, fontFamily: mono }}>{up ? "▲" : "▼"} {Math.abs(btc.changePct || 0).toFixed(2)}%</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 13 }}>
            <StatBox value={dayTarget} label="Day target" valueColor={T.brass} />
            <StatBox value={support} label="Support (24h low)" valueColor={T.green} />
            <StatBox value={invalidation} label="Invalidation" valueColor={T.red} />
          </div>
          <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.65 }}>{narrative}</div>
          <div style={{ marginTop: 9, ...S.microLabel, letterSpacing: "0.04em" }}>LEVELS DERIVED FROM LIVE 24H RANGE · NOT FINANCIAL ADVICE</div>
        </div>

        {/* Stocks outlook */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={S.title}>Stocks · Day Outlook</span>
            <StatusTag status={stocksStatus} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 13 }}>
            {[["S&P FUT", stocks.spx], ["NASDAQ FUT", stocks.ndq], ["10Y YIELD", stocks.tnx], ["DXY", stocks.dxy]].map(([l, s], i) => (
              <div key={i} style={{ ...S.inner, padding: "10px 12px", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 9, color: T.faint, letterSpacing: "0.06em" }}>{l}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: s.value === "—" ? T.faint : s.up ? T.green : T.red, fontFamily: mono }}>{s.value}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.65 }}>{stocksStatus.state === "live" ? "Futures and yield pulled live via Yahoo Finance's public endpoint — unofficial, no key, refreshes on page load." : stocksStatus.state === "loading" ? "Loading live data…" : stocksStatus.detail}</div>
        </div>

        {/* Events */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={S.title}>Watch Today</span>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={S.microLabel}>CT TIME</span>
              <StatusTag status={eventsStatus} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
            {eventsStatus.state === "live" ? (
              events.length ? events.map((e, i) => (
                <div key={i} style={{ ...S.inner, display: "flex", alignItems: "center", gap: 11, padding: "11px 13px" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: e.color, flex: "none", boxShadow: `0 0 8px ${e.color}80` }} />
                  <span style={{ fontSize: 9, color: T.faint, fontFamily: mono, flex: "none", width: 52 }}>{e.time}</span>
                  <span style={{ fontSize: 11, color: "#C6CFDE", lineHeight: 1.5, flex: 1 }}>{e.text}</span>
                </div>
              )) : <div style={{ fontSize: 10.5, color: T.faint, padding: "6px 0" }}>No high/medium-impact US events scheduled today.</div>
            ) : <FeedFallbackRow status={eventsStatus} />}
          </div>
        </div>

        {/* The Wire */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={S.title}>The Wire</span>
            <StatusTag status={wireStatus} />
          </div>
          <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "6px 0 12px" }}>{wireStatus.state === "live" ? "Latest crypto/macro headlines, auto-tagged." : "Real headlines only — nothing shown until the feed responds."}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {wireStatus.state === "live" ? wire.map((w, i) => (
              w.link ? (
                <a key={i} href={w.link} target="_blank" rel="noopener" style={{ ...S.inner, display: "flex", gap: 10, padding: "10px 12px", textDecoration: "none", cursor: "pointer" }}>
                  <span style={{ fontSize: 8.5, color: T.faint, fontFamily: mono, flex: "none", paddingTop: 2, width: 36 }}>{w.time}</span>
                  <span style={{ fontSize: 11, color: "#C6CFDE", lineHeight: 1.55, flex: 1 }}>
                    <span style={{ color: w.tagColor, fontWeight: 700, fontSize: 8.5, letterSpacing: "0.06em" }}>{w.tag} </span> {w.text}
                  </span>
                  <span style={{ color: T.faint, fontSize: 12, flex: "none", paddingTop: 1 }}>›</span>
                </a>
              ) : (
                <div key={i} style={{ ...S.inner, display: "flex", gap: 10, padding: "10px 12px" }}>
                  <span style={{ fontSize: 8.5, color: T.faint, fontFamily: mono, flex: "none", paddingTop: 2, width: 36 }}>{w.time}</span>
                  <span style={{ fontSize: 11, color: "#C6CFDE", lineHeight: 1.55, flex: 1 }}>
                    <span style={{ color: w.tagColor, fontWeight: 700, fontSize: 8.5, letterSpacing: "0.06em" }}>{w.tag} </span> {w.text}
                  </span>
                </div>
              )
            )) : <FeedFallbackRow status={wireStatus} />}
          </div>
          {wireStatus.state === "live" && <div style={{ marginTop: 10, ...S.microLabel, letterSpacing: "0.05em" }}>SOURCES · COINDESK · COINTELEGRAPH</div>}
        </div>

        {/* ZTS Search Console */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#0E9F6E", boxShadow: "0 0 8px rgba(14,159,110,0.5)" }} />
              <span style={S.title}>Zero To Secure · Search Console</span>
            </div>
            <StatusTag status={gscStatus} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 13 }}>
            <StatBox value={gsc.impressions} label="Impressions" delta={gsc.impressionsD} />
            <StatBox value={gsc.clicks} label="Clicks" delta={gsc.clicksD} />
            <StatBox value={gsc.pos} label="Avg position" delta={gsc.posD} />
          </div>
          <Bars data={gsc.series} from="#17B888" to="#0E9F6E" />
          <div style={{ marginTop: 8, fontSize: 10.5, color: gscStatus.state === "live" ? T.sub : T.faint, lineHeight: 1.55 }}>{gscStatus.state === "live" ? gsc.note : gscStatus.state === "loading" ? "Loading…" : gscStatus.detail}</div>
        </div>

        {/* ZTS Shopify */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.brass, boxShadow: "0 0 8px rgba(217,177,94,0.5)" }} />
              <span style={S.title}>Zero To Secure · Shopify</span>
            </div>
            <StatusTag status={shopStatus} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 13 }}>
            <StatBox value={shop.visits} label="Visits" delta={shop.visitsD} />
            <StatBox value={shop.conv} label="Conversion" delta={shop.convD} />
            <StatBox value={shop.orders} label="Orders" delta={shop.ordersD} />
          </div>
          <Bars data={shop.series} from="#D9B15E" to="#A87B2C" />
          <div style={{ marginTop: 8, fontSize: 10.5, color: shopStatus.state === "live" ? T.sub : T.faint, lineHeight: 1.55 }}>{shopStatus.state === "live" ? shop.note : shopStatus.state === "loading" ? "Loading…" : shopStatus.detail}</div>
        </div>
      </div>
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
          <div style={{ padding: "20px 24px", background: "linear-gradient(135deg,rgba(200,160,74,0.10),rgba(200,160,74,0.03))", border: "1px solid rgba(200,160,74,0.22)", borderRadius: 18, display: "flex", alignItems: "center", gap: 18, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)" }}>
            <span style={{ width: 44, height: 44, borderRadius: 13, background: `linear-gradient(135deg, ${T.brass}, ${T.brassDeep})`, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 20, flex: "none", boxShadow: "0 4px 16px rgba(200,160,74,0.4), inset 0 1px 0 rgba(255,255,255,0.4)" }}>♛</span>
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

// ─── Page: Properties ────────────────────────────────────────────────────────
function PropertiesPage({ isMobile, btc }) {
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
              {p.url && <a href={p.url} target="_blank" rel="noopener" style={{ flex: 1, padding: 10, textAlign: "center", background: "rgba(255,255,255,0.05)", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: 10, color: p.color, fontSize: 11, fontWeight: 700, textDecoration: "none" }}>Site ›</a>}
              <a href={p.appUrl} target="_blank" rel="noopener" style={{ flex: 1, padding: 10, textAlign: "center", background: "rgba(255,255,255,0.05)", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: 10, color: T.sub, fontSize: 11, fontWeight: 600, textDecoration: "none" }}>Command Center ›</a>
            </div>
          </div>
          );
        })}
        {isMobile && btc && !btc.loading && !btc.error && (
          <div style={S.cardM}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 16, height: 16, borderRadius: "50%", background: "linear-gradient(135deg,#F7931A,#C77416)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: "#1A0F00" }}>₿</span>
                <span style={{ fontSize: 14, fontWeight: 500, fontFamily: mono, color: T.ink }}>${btc.price?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: (btc.changePct || 0) >= 0 ? T.green : T.red, fontFamily: mono }}>{(btc.changePct || 0) >= 0 ? "▲" : "▼"} {Math.abs(btc.changePct || 0).toFixed(2)}%</span>
            </div>
            <Sparkline points={btc.points} color={(btc.changePct || 0) >= 0 ? T.green : T.red} height={34} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page: Systems (deploy, database, status, auditor, usage) ────────────────
async function auditProperty(p, token) {
  const data = await callFn("audit", { name: p.name, url: p.url || p.appUrl, repo: p.repo }, token ? { Authorization: `Bearer ${token}` } : undefined);
  return data?.success ? data.findings : [];
}

function AuditorCard({ settings, updateSetting, session, isMobile }) {
  const [findings, setFindings] = useState([]);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const enabled = !!settings?.auditor_enabled;
  const lastRun = settings?.auditor_last_run || null;

  useEffect(() => {
    let alive = true;
    db.loadFindings().then(f => { if (alive) setFindings(f); });
    return () => { alive = false; };
  }, []);

  const runAll = async () => {
    setRunning(true);
    const results = [];
    for (const p of PROPERTIES) {
      const fs = await auditProperty(p, session?.access_token);
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

  const propColor = (name) => (PROPERTIES.find(p => p.name === name) || {}).color || T.sub;
  const sevColor = { high: T.red, medium: T.amber, low: T.sub };
  const ago = (ts) => { if (!ts) return "NEVER"; const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? "JUST NOW" : m < 60 ? `${m}M AGO` : `${Math.floor(m / 60)}H AGO`; };

  return (
    <div style={isMobile ? S.cardM : S.card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
        <span style={S.title}>Site Auditor</span>
        <Toggle on={enabled} onToggle={() => updateSetting("auditor_enabled", !enabled)} size={isMobile ? 24 : 20} />
      </div>
      <button onClick={runAll} disabled={running} style={{ width: "100%", padding: isMobile ? 12 : 10, background: running ? "rgba(255,255,255,0.05)" : "rgba(200,160,74,0.12)", border: `1px solid ${running ? T.line : "rgba(200,160,74,0.3)"}`, borderRadius: 10, color: running ? T.faint : T.brass, fontSize: 11, fontWeight: 700, cursor: running ? "default" : "pointer", fontFamily: syne, marginBottom: 9 }}>
        {running ? "Auditing all properties…" : "Run audit now"}
      </button>
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
            <div key={i} style={{ padding: "10px 12px", background: "rgba(0,0,0,0.22)", borderRadius: 10, border: "1px solid rgba(255,255,255,0.05)", borderLeft: `2px solid ${sevColor[f.severity] || T.sub}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: propColor(f.property), fontFamily: syne }}>{f.property}</span>
                <span style={{ fontSize: 8, color: sevColor[f.severity] || T.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>{f.severity}</span>
              </div>
              <div style={{ fontSize: 10.5, color: T.ink, lineHeight: 1.5 }}>{f.finding}</div>
              <div style={{ fontSize: 10, color: T.sub, lineHeight: 1.5, marginTop: 3, fontStyle: "italic" }}>→ {f.suggestion}</div>
            </div>
          ))}
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
  const [rows, setRows] = useState(null); // null = loading
  const [err, setErr] = useState(null);
  const [windowIdx, setWindowIdx] = useState(1);
  const [showLog, setShowLog] = useState(false);

  const load = async () => {
    setRows(null); setErr(null);
    try {
      const since = new Date(Date.now() - USAGE_WINDOWS[windowIdx][1] * 86400000).toISOString();
      const { data, error } = await supabase.from("usage_log").select("fn,kind,model,in_tokens,out_tokens,cost_usd,ms,ok,detail,created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(1000);
      if (error) { setErr(error.message.includes("usage_log") ? "Run supabase-usage.sql in the Supabase SQL editor to enable this." : error.message); setRows([]); return; }
      setRows(data || []);
    } catch { setErr("usage log unavailable"); setRows([]); }
  };
  useEffect(() => { load(); }, [windowIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  const card = isMobile ? S.cardM : S.card;
  const totalCalls = rows?.length || 0;
  const failed = rows?.filter(r => !r.ok).length || 0;
  const anthropicRows = rows?.filter(r => r.kind === "anthropic") || [];
  const totalCost = anthropicRows.reduce((s, r) => s + (r.cost_usd || 0), 0);
  const totalIn = anthropicRows.reduce((s, r) => s + (r.in_tokens || 0), 0);
  const totalOut = anthropicRows.reduce((s, r) => s + (r.out_tokens || 0), 0);
  const byFn = {};
  (rows || []).forEach(r => {
    byFn[r.fn] = byFn[r.fn] || { calls: 0, cost: 0, failed: 0 };
    byFn[r.fn].calls++;
    byFn[r.fn].cost += r.cost_usd || 0;
    if (!r.ok) byFn[r.fn].failed++;
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
            <button key={label} onClick={() => setWindowIdx(i)} style={{ padding: "4px 9px", background: windowIdx === i ? "rgba(200,160,74,0.16)" : "transparent", border: `1px solid ${windowIdx === i ? "rgba(200,160,74,0.4)" : "rgba(255,255,255,0.1)"}`, borderRadius: 8, color: windowIdx === i ? T.brass : T.faint, fontSize: 9.5, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>{label}</button>
          ))}
        </div>
      </div>

      {err && <div style={{ fontSize: 10.5, color: T.amber, lineHeight: 1.5, padding: "8px 0" }}>{err}</div>}

      {!err && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 7, marginBottom: 13 }}>
            <StatBox value={rows === null ? "…" : "$" + totalCost.toFixed(3)} label="Anthropic spend" valueColor={T.brass} />
            <StatBox value={rows === null ? "…" : String(totalCalls)} label="total calls" />
            <StatBox value={rows === null ? "…" : `${fmtK(totalIn)}/${fmtK(totalOut)}`} label="tokens in/out" />
            <StatBox value={rows === null ? "…" : String(failed)} label="failed calls" valueColor={failed ? T.red : T.green} />
          </div>

          <div style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(200,160,74,0.8)", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: syne, marginBottom: 8 }}>By feature</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 13 }}>
            {rows === null && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "8px 0" }}>Loading…</div>}
            {rows !== null && topFns.length === 0 && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "8px 0" }}>No calls logged in this window yet.</div>}
            {topFns.map(([fn, s]) => (
              <div key={fn} style={{ ...S.inner, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px" }}>
                <span style={{ fontSize: 10.5, color: "#C6CFDE", fontFamily: mono, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fn}</span>
                {s.failed > 0 && <span style={{ fontSize: 8.5, color: T.red, fontFamily: mono, flex: "none" }}>{s.failed} FAILED</span>}
                <span style={{ fontSize: 9.5, color: T.faint, fontFamily: mono, flex: "none" }}>{s.calls} calls</span>
                <span style={{ fontSize: 10.5, color: T.brass, fontFamily: mono, fontWeight: 700, flex: "none", width: 56, textAlign: "right" }}>{s.cost > 0 ? "$" + s.cost.toFixed(3) : "—"}</span>
              </div>
            ))}
          </div>

          <button onClick={() => setShowLog(!showLog)} style={{ width: "100%", padding: 9, background: "rgba(255,255,255,0.03)", border: `1px solid rgba(255,255,255,0.08)`, borderRadius: 9, color: T.sub, fontSize: 10.5, fontWeight: 600, cursor: "pointer", marginBottom: showLog ? 9 : 0 }}>
            {showLog ? "Hide raw log ▲" : `Show raw log (${totalCalls}) ▼`}
          </button>
          {showLog && (
            <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10, maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column" }}>
              {(rows || []).slice(0, 150).map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 11px", borderBottom: i < rows.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: r.ok ? T.green : T.red, flex: "none" }} />
                  <span style={{ fontSize: 9, color: T.faint, fontFamily: mono, flex: "none", width: 32 }}>{ago(r.created_at)}</span>
                  <span style={{ fontSize: 10, color: "#C6CFDE", fontFamily: mono, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.fn}{r.model ? ` · ${r.model}` : ""}{!r.ok && r.detail ? ` · ${r.detail}` : ""}</span>
                  <span style={{ fontSize: 9, color: T.faint, fontFamily: mono, flex: "none" }}>{r.ms ? `${r.ms}ms` : ""}</span>
                  <span style={{ fontSize: 9.5, color: T.brass, fontFamily: mono, flex: "none", width: 48, textAlign: "right" }}>{r.cost_usd ? "$" + r.cost_usd.toFixed(4) : ""}</span>
                </div>
              ))}
              {rows?.length === 0 && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "14px 0" }}>Nothing logged yet.</div>}
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
  { title: "Netlify Functions", keys: ["fn_health", "fn_mini", "fn_btc", "fn_markets", "fn_calendar", "fn_wire", "fn_site_status", "fn_gsc", "fn_shopify", "fn_deploy", "fn_dbadmin", "fn_audit"] },
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
  fn_markets: { name: "markets", desc: "S&P/Nasdaq futures, 10Y yield, DXY via Yahoo's public endpoint (unofficial)" },
  fn_calendar: { name: "calendar", desc: "today's US econ calendar (unofficial free feed)" },
  fn_wire: { name: "wire", desc: "live crypto/macro headlines from CoinDesk + Cointelegraph RSS" },
  fn_site_status: { name: "site-status", desc: "uptime check behind the Properties page's live/down pill" },
  fn_gsc: { name: "gsc", desc: "Search Console · zerotosecure.com last 14d" },
  fn_shopify: { name: "shopify", desc: "Shopify Admin API · orders last 14d" },
  fn_deploy: { name: "deploy", desc: "Netlify API · trigger builds per property" },
  fn_dbadmin: { name: "db-admin", desc: "service-role maintenance, allowlisted commands" },
  fn_audit: { name: "audit", desc: "AI site auditor across all five properties" },
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
    const fns = [["fn_health", "health"], ["fn_mini", "mini-worker"], ["fn_btc", "btc"], ["fn_markets", "markets"], ["fn_calendar", "calendar"], ["fn_wire", "wire"], ["fn_site_status", "site-status"], ["fn_gsc", "gsc"], ["fn_shopify", "shopify"], ["fn_deploy", "deploy"], ["fn_dbadmin", "db-admin"], ["fn_audit", "audit"]];
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

function SubTabs({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)} style={{ padding: "7px 13px", background: value === o.key ? "linear-gradient(135deg, rgba(200,160,74,0.22), rgba(200,160,74,0.1))" : "rgba(255,255,255,0.03)", border: `1px solid ${value === o.key ? "rgba(200,160,74,0.4)" : "rgba(255,255,255,0.09)"}`, borderRadius: 10, color: value === o.key ? T.brass : T.sub, fontSize: 11, fontWeight: 700, fontFamily: syne, cursor: "pointer" }}>{o.label}</button>
      ))}
    </div>
  );
}

const SYSTEMS_SUBTABS = [
  { key: "status", label: "Status" },
  { key: "deploy", label: "Deploy" },
  { key: "database", label: "Database" },
  { key: "auditor", label: "Auditor" },
  { key: "usage", label: "Usage" },
];

// Systems — everything technical in one place, behind sub-tabs so mobile
// isn't a wall of unrelated cards: live status of every data pipe, deploy
// triggers, the Supabase console, the site auditor, and spend/usage.
function SystemsPage({ settings, updateSetting, session, btc, isMobile }) {
  const [sub, setSub] = useState("status");
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

  // ── Deploy ──
  const [deploys, setDeploys] = useState({});
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadTarget, setUploadTarget] = useState(PROPERTIES[0].name);
  const [uploadBusy, setUploadBusy] = useState(false);
  const redeploy = async (p) => {
    setDeploys(d => ({ ...d, [p.name]: { busy: true } }));
    await callFn("deploy", { site: p.site, action: "build" });
    setTimeout(() => setDeploys(d => ({ ...d, [p.name]: { busy: false, when: "JUST NOW" } })), 2000);
  };
  const deployUpload = async () => {
    if (!uploadFile || uploadBusy) return;
    setUploadBusy(true);
    const target = PROPERTIES.find(p => p.name === uploadTarget);
    const form = new FormData();
    form.append("site", target?.site || "");
    form.append("zip", uploadFile);
    try { await fetch("/.netlify/functions/deploy", { method: "POST", body: form }); } catch {}
    setTimeout(() => {
      setUploadBusy(false); setUploadFile(null);
      setDeploys(d => ({ ...d, [uploadTarget]: { busy: false, when: "JUST NOW" } }));
    }, 2200);
  };

  // ── Database ──
  const [sqlInput, setSqlInput] = useState("");
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlLog, setSqlLog] = useState([{ kind: "ok", text: "✓ connected — guardrails on" }]);
  const runSql = async () => {
    const q = sqlInput.trim();
    if (!q || sqlBusy) return;
    setSqlLog(l => [...l, { kind: "cmd", text: "> " + q }]);
    setSqlInput(""); setSqlBusy(true);
    const data = await callFn("db-admin", { command: q });
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
          <div style={card}>
            <CardHeader title="Deployments" tag="NETLIFY" />
            <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 13px" }}>Push a fresh build or redeploy any property without leaving the room.</div>
            <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: 18, background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(200,160,74,0.35)", borderRadius: 12, cursor: "pointer", marginBottom: 8 }}>
              <input type="file" accept=".zip" onChange={e => setUploadFile(e.target.files?.[0] || null)} style={{ display: "none" }} />
              <span style={{ fontSize: 11.5, fontWeight: 700, color: T.brass, fontFamily: syne }}>{uploadFile ? "✓ " + uploadFile.name : "Drop a build .zip — or click to browse"}</span>
              <span style={{ fontSize: 9.5, color: T.faint }}>{uploadFile ? "ready to deploy · pick a target below" : "uploads straight to Netlify, atomic swap on success"}</span>
            </label>
            {uploadFile && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <select value={uploadTarget} onChange={e => setUploadTarget(e.target.value)} style={{ flex: 1, padding: "10px 11px", background: "#141C2E", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: 9, color: T.ink, fontSize: 11 }}>
                  {PROPERTIES.map(p => <option key={p.name}>{p.name}</option>)}
                </select>
                <button onClick={deployUpload} disabled={uploadBusy} style={{ ...S.brassBtn, padding: "10px 18px", fontSize: 11, opacity: uploadBusy ? 0.5 : 1 }}>{uploadBusy ? "Deploying…" : "Deploy"}</button>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {PROPERTIES.map(p => {
                const d = deploys[p.name] || {};
                return (
                  <div key={p.name} style={{ ...S.inner, display: "flex", alignItems: "center", gap: 11, padding: "11px 13px" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: d.busy ? T.amber : T.green, flex: "none", boxShadow: `0 0 8px ${d.busy ? "rgba(245,158,11,0.5)" : "rgba(52,211,153,0.5)"}` }} />
                    <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: "#C6CFDE", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                      <span style={{ fontSize: 9, color: d.busy ? T.amber : T.faint, fontFamily: mono, letterSpacing: "0.04em" }}>{d.busy ? "BUILDING…" : `LIVE${d.when ? " · DEPLOYED " + d.when : ""}`}</span>
                    </span>
                    <button onClick={() => redeploy(p)} style={{ ...S.ghostBtn, padding: "7px 13px", fontSize: 9.5, flex: "none" }}>{d.busy ? "Deploying…" : "Redeploy"}</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {sub === "database" && (
          <div style={card}>
            <CardHeader title="Supabase Console" tag="● CONNECTED" tagColor={T.green} />
            <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 12px" }}>Run maintenance against the shared memory. Guardrails on — destructive ops ask twice.</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {["backup chat_messages", "vacuum seat_notes", "clear findings > 30d"].map(q => (
                <button key={q} onClick={() => setSqlInput(q)} style={{ padding: "6px 11px", background: "rgba(255,255,255,0.035)", border: `1px solid rgba(255,255,255,0.09)`, borderRadius: 14, color: T.sub, fontSize: 9.5, cursor: "pointer", fontFamily: mono }}>{q}</button>
              ))}
            </div>
            <div style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 11, padding: "12px 14px", minHeight: 110, maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5, marginBottom: 9 }}>
              {sqlLog.map((l, i) => (
                <div key={i} style={{ fontSize: 10, fontFamily: mono, color: l.kind === "cmd" ? T.sub : l.kind === "err" ? T.red : T.green, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{l.text}</div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={sqlInput} onChange={e => setSqlInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); runSql(); } }} placeholder="update seat_notes set …"
                style={{ ...S.input, flex: 1, padding: "11px 13px", fontSize: 11, fontFamily: mono }} />
              <button onClick={runSql} style={{ ...S.ghostBtn, padding: "0 18px", minHeight: 44, borderRadius: 10, fontSize: 11, fontWeight: 800 }}>Run</button>
            </div>
          </div>
        )}

        {sub === "auditor" && <AuditorCard settings={settings} updateSetting={updateSetting} session={session} isMobile={isMobile} />}

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
  model: "haiku", enabled: true, night: true, budget: "$3", oversight: true,
  reflectOn: true, loopOn: true, loopMax: "5", approvalOn: true,
};
const TASK_COLORS = { delivered: T.green, review: T.brass, queued: T.faint, failed: T.red };
const MINI_LEVELS = ["Rookie", "Apprentice", "Operator", "Right Hand", "Shadow Chief"];

// Mini Me is now real: a scheduled Netlify worker (mini-worker) runs the
// queue through Claude nightly (or on demand), writes deliverables onto
// tasks, and logs to mini_feed. Everything below reads actual activity.
function MiniMePage({ settings, updateSetting, session, onWorkerRun, isMobile }) {
  const mini = { ...MINI_DEFAULTS, ...(settings?.mini || {}) };
  const setMini = (patch) => updateSetting("mini", { ...mini, ...patch });
  const skills = settings?.mini_skills || [];
  const setSkills = (list) => updateSetting("mini_skills", list);
  const tasks = settings?.mini_tasks || [];
  const setTasks = (list) => updateSetting("mini_tasks", list);

  const [taskInput, setTaskInput] = useState("");
  const [skillInput, setSkillInput] = useState("");
  const [tuneIdx, setTuneIdx] = useState(null);
  const [tuneDraft, setTuneDraft] = useState("");
  const [feed, setFeed] = useState(null); // null = loading
  const [memCount, setMemCount] = useState(null);
  const [worker, setWorker] = useState({ state: "checking" });
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [openTask, setOpenTask] = useState(null);

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
    supabase.from("chat_messages").select("*", { count: "exact", head: true }).then(({ count }) => { if (alive) setMemCount(count ?? 0); });
    pingFn("mini-worker").then(p => {
      if (!alive) return;
      setWorker(p.status === "ok" ? { state: "ok" } : p.status === "warn" ? { state: "noenv", detail: p.detail } : { state: "off", detail: p.detail });
    });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const delivered = tasks.filter(t => t.status === "delivered").length;
  const xp = delivered * 40 + Math.min(memCount || 0, 600) + skills.filter(s => s.note).length * 15;
  const levelIdx = Math.min(MINI_LEVELS.length - 1, Math.floor(xp / 250));
  const xpInLevel = xp - levelIdx * 250;

  const addTask = () => { const t = taskInput.trim(); if (!t) return; setTasks([{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: t, status: "queued", queued_at: Date.now() }, ...tasks]); setTaskInput(""); };
  const addSkill = () => { const t = skillInput.trim(); if (!t) return; setSkills([{ name: t, note: "" }, ...skills]); setSkillInput(""); };
  const removeTask = (i) => setTasks(tasks.filter((_, j) => j !== i));

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

  const card = isMobile ? S.cardM : S.card;
  const toggleSize = isMobile ? 24 : 20;
  const queuedCount = tasks.filter(t => t.status === "queued").length;
  const [pillText, pillColor] = worker.state === "ok" ? ["● WORKER ONLINE", T.green]
    : worker.state === "noenv" ? ["◐ KEYS MISSING", T.amber]
    : worker.state === "off" ? ["○ WORKER NOT DEPLOYED", T.red]
    : ["…", T.faint];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "18px 16px 24px" : "30px 34px 40px" }}>
      <div style={{ maxWidth: 1020, margin: "0 auto", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1.3fr 1fr", gap: isMobile ? 12 : 14, alignItems: "start" }}>

        {/* Hero — real numbers */}
        <div style={{ ...card, background: "linear-gradient(135deg,rgba(200,160,74,0.10),rgba(124,58,237,0.06))", border: "1px solid rgba(200,160,74,0.22)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
            <span style={{ width: isMobile ? 48 : 56, height: isMobile ? 48 : 56, borderRadius: "50%", background: `linear-gradient(135deg, ${T.brass}, ${T.brassDeep})`, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", animation: "breathe 3.2s ease-in-out infinite" }}>
              <span style={{ width: 22, height: 22, borderRadius: "50%", background: T.bg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: T.brass, animation: "pulse 2.4s infinite" }} />
              </span>
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
              <span style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 19, fontWeight: 800, fontFamily: syne, color: T.ink }}>Mini Me</span>
                <span style={{ fontSize: 9, color: mini.enabled === false ? T.faint : pillColor, fontFamily: mono, letterSpacing: "0.08em" }}>{mini.enabled === false ? "○ OFF" : pillText}</span>
              </span>
              <span style={{ fontSize: 11, color: T.sub, lineHeight: 1.5 }}>Queue work below and it runs through Claude nightly around 3 AM CT — or hit Run now. Deliverables land back on each task.</span>
              {worker.state !== "ok" && worker.state !== "checking" && mini.enabled !== false && <span style={{ fontSize: 10, color: T.amber, lineHeight: 1.5 }}>{worker.detail}</span>}
            </span>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, flex: "none" }}>
              <Toggle on={mini.enabled !== false} onToggle={() => setMini({ enabled: mini.enabled === false })} size={isMobile ? 26 : 22} />
              <span style={{ fontSize: 8, fontWeight: 700, color: mini.enabled === false ? T.faint : T.green, fontFamily: mono, letterSpacing: "0.06em" }}>{mini.enabled === false ? "OFF" : "ON"}</span>
            </div>
          </div>
          {mini.enabled === false && <div style={{ ...S.inner, padding: "10px 13px", marginBottom: 14, fontSize: 10.5, color: T.faint, lineHeight: 1.5 }}>Mini Me is off — it won't touch your queue tonight or if you tap Run now. Flip it back on above when you want it working again.</div>}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, fontFamily: syne, color: T.brass, letterSpacing: "0.08em" }}>LEVEL {levelIdx + 1} · {MINI_LEVELS[levelIdx].toUpperCase()}</span>
            <span style={{ fontSize: 9, color: T.faint, fontFamily: mono }}>{xpInLevel} / 250 XP · FROM REAL ACTIVITY</span>
          </div>
          <div style={{ height: 7, background: "rgba(0,0,0,0.35)", borderRadius: 4, overflow: "hidden", marginBottom: 16, border: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ width: `${Math.max(2, Math.min(100, (xpInLevel / 250) * 100))}%`, height: "100%", background: `linear-gradient(90deg, ${T.brassDeep}, ${T.brass})`, borderRadius: 4, boxShadow: "0 0 12px rgba(200,160,74,0.5)" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 4 }}>
            <StatBox value={memCount === null ? "…" : memCount.toLocaleString()} label="memories (chat msgs)" />
            <StatBox value={String(skills.length)} label="skills" />
            <StatBox value={String(delivered)} label="tasks delivered" />
          </div>
        </div>

        {/* Controls */}
        <div style={card}>
          <div style={{ ...S.title, marginBottom: 13 }}>Controls</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, fontWeight: 700, fontFamily: syne, color: T.ink }}>Brain</span>
              <span style={{ fontSize: 9, color: T.faint }}>model used for queued tasks</span>
            </div>
            <Segmented value={mini.model} onChange={k => setMini({ model: k })} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            <ToggleRow title="Overnight autonomy" sub="include your queue in the nightly 3 AM run" on={mini.night} onToggle={() => setMini({ night: !mini.night })} size={toggleSize} />
            <ToggleRow title="Full oversight" sub="audits Chief chat answers for smoothed-over board dissent" on={mini.oversight} onToggle={() => setMini({ oversight: !mini.oversight })} size={toggleSize} />
          </div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 7 }}>
            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: syne, color: T.ink }}>Nightly budget</span>
            <span style={{ fontSize: 9, color: T.faint }}>caps tasks per run: $1→1 · $3→3 · $10→8</span>
          </div>
          <Chips options={["$1", "$3", "$10"]} value={mini.budget} onChange={b => setMini({ budget: b })} fmt={v => v + "/night"} />
          <button onClick={runNow} disabled={running || worker.state === "off" || mini.enabled === false} style={{ ...S.brassBtn, width: "100%", padding: 12, fontSize: 11.5, marginTop: 14, opacity: running || worker.state === "off" || mini.enabled === false ? 0.5 : 1 }}>
            {running ? "Working the queue…" : mini.enabled === false ? "Mini Me is off" : `Run queue now${queuedCount ? ` (${queuedCount} queued)` : ""}`}
          </button>
          {runMsg && <div style={{ marginTop: 8, fontSize: 10.5, color: runMsg.ok ? T.green : T.red, lineHeight: 1.5 }}>{runMsg.ok ? "✓ " : "✗ "}{runMsg.text}</div>}
        </div>

        {/* Agent Looping — real: controls how the worker self-critiques each task */}
        <div style={card}>
          <CardHeader title="Agent Looping" tag="RUNS INSIDE EVERY TASK" />
          <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 12px" }}>How hard Mini Me works a single task before calling it done. More loops means better drafts and more tokens spent.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 13 }}>
            <ToggleRow title="Self-critique" sub="review its own draft and revise if it finds gaps" on={mini.reflectOn} onToggle={() => setMini({ reflectOn: !mini.reflectOn })} size={toggleSize} />
            <ToggleRow title="Loop until done" sub="allow multiple critique/revise passes, not just one" on={mini.loopOn} onToggle={() => setMini({ loopOn: !mini.loopOn })} size={toggleSize} />
            <ToggleRow title="Approval gate" sub="finished drafts wait for your tap before counting as delivered" on={mini.approvalOn} onToggle={() => setMini({ approvalOn: !mini.approvalOn })} size={toggleSize} />
          </div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 7 }}>
            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: syne, color: T.ink }}>Max critique passes</span>
            <span style={{ fontSize: 9, color: T.faint }}>only applies if Loop until done is on</span>
          </div>
          <Chips options={["5", "15", "50"]} value={mini.loopMax} onChange={n => setMini({ loopMax: n })} fmt={v => v + "×"} />
          <div style={{ marginTop: 11, ...S.microLabel, letterSpacing: "0.04em", lineHeight: 1.6 }}>AUTO-STOPS EARLY IF THE CRITIQUE SAYS "DONE" OR TWO PASSES IN A ROW CHANGE NOTHING</div>
        </div>

        {/* Queue */}
        <div style={card}>
          <CardHeader title="Task Queue" tag={`NIGHTLY ~3AM CT · OR RUN NOW`} />
          <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 12px" }}>Hand it work. Tap a delivered task to read the output.</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input value={taskInput} onChange={e => setTaskInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTask(); } }} placeholder="e.g. Draft 5 outreach angles for the med-spa vertical"
              style={{ ...S.input, flex: 1, padding: "11px 13px", fontSize: 11.5 }} />
            <button onClick={addTask} style={{ ...S.brassBtn, padding: "0 18px", minHeight: 44, fontSize: 11 }}>Queue</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {tasks.length === 0 && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "10px 0" }}>Nothing queued yet — give it something to work on.</div>}
            {tasks.map((t, i) => {
              const c = TASK_COLORS[t.status] || T.faint;
              const rowKey = t.id || i;
              const open = openTask === rowKey;
              return (
                <div key={rowKey} style={{ ...S.inner, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
                  <div onClick={() => t.output && setOpenTask(open ? null : rowKey)} style={{ display: "flex", alignItems: "center", gap: 11, cursor: t.output ? "pointer" : "default" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, flex: "none", boxShadow: `0 0 8px ${c}80` }} />
                    <span style={{ flex: 1, fontSize: 11, color: "#C6CFDE", lineHeight: 1.5 }}>{t.text}</span>
                    <span style={{ fontSize: 8.5, color: c, fontFamily: mono, letterSpacing: "0.06em", flex: "none", textTransform: "uppercase" }}>{t.status}{t.output ? (open ? " ▲" : " ▼") : ""}</span>
                    <button onClick={(e) => { e.stopPropagation(); removeTask(i); }} title="Remove" style={{ width: 24, height: 24, background: "rgba(255,255,255,0.04)", border: `1px solid rgba(255,255,255,0.09)`, borderRadius: 7, color: T.faint, fontSize: 10, cursor: "pointer", flex: "none" }}>✕</button>
                  </div>
                  {open && t.output && (
                    <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 9, padding: "11px 13px", fontSize: 11, color: T.sub, lineHeight: 1.65, whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto" }}>{t.output}</div>
                  )}
                  {t.status === "review" && (
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => approveTask(t.id)} disabled={running} style={{ ...S.brassBtn, flex: 1, padding: "8px 0", fontSize: 10.5, opacity: running ? 0.5 : 1 }}>Approve</button>
                      <button onClick={() => rejectTask(t.id)} disabled={running} style={{ flex: 1, padding: "8px 0", background: "transparent", border: `1px solid rgba(255,255,255,0.12)`, borderRadius: 10, color: T.sub, fontSize: 10.5, fontWeight: 600, cursor: running ? "default" : "pointer" }}>Reject &amp; redo</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Skills / standing guidance */}
        <div style={card}>
          <CardHeader title="Standing Guidance" tag="FED TO EVERY RUN" />
          <div style={{ fontSize: 10.5, color: T.faint, lineHeight: 1.5, margin: "2px 0 12px" }}>Skills with guidance notes are injected into the worker's system prompt on every task.</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input value={skillInput} onChange={e => setSkillInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addSkill(); } }} placeholder="e.g. Outreach ghostwriting"
              style={{ ...S.input, flex: 1, padding: "11px 13px", fontSize: 11.5 }} />
            <button onClick={addSkill} style={{ ...S.brassBtn, padding: "0 18px", minHeight: 44, fontSize: 11 }}>Add</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {skills.length === 0 && <div style={{ fontSize: 10.5, color: T.faint, textAlign: "center", padding: "10px 0" }}>No skills yet — add one and tune it with your voice and priorities.</div>}
            {skills.map((sk, i) => (
              <div key={i} style={{ ...S.inner, padding: "11px 13px", display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#C6CFDE", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sk.name}</span>
                {!!sk.note && <span style={{ fontSize: 8, color: T.green, fontFamily: mono, letterSpacing: "0.06em", flex: "none" }}>✓ ACTIVE</span>}
                <button onClick={() => { setTuneIdx(i); setTuneDraft(sk.note || ""); }} style={{ ...S.ghostBtn, padding: "5px 11px", fontSize: 9, borderRadius: 7, flex: "none" }}>Tune</button>
                <button onClick={() => setSkills(skills.filter((_, j) => j !== i))} title="Remove skill" style={{ width: 26, height: 26, background: "rgba(255,255,255,0.04)", border: `1px solid rgba(255,255,255,0.09)`, borderRadius: 7, color: T.faint, fontSize: 10, cursor: "pointer", flex: "none" }}>✕</button>
              </div>
            ))}
          </div>
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

      {tuneIdx !== null && (
        <SkillTuneModal
          name={skills[tuneIdx]?.name || ""}
          draft={tuneDraft}
          setDraft={setTuneDraft}
          onSave={() => { setSkills(skills.map((s, j) => j === tuneIdx ? { ...s, note: tuneDraft.trim() } : s)); setTuneIdx(null); }}
          onClose={() => setTuneIdx(null)}
          isMobile={isMobile}
        />
      )}
    </div>
  );
}

// ─── Modals ──────────────────────────────────────────────────────────────────
function ModalShell({ onClose, children, isMobile, z = 300 }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4,7,14,0.72)", zIndex: z, display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "linear-gradient(180deg,#141C2E,#101726)", borderRadius: isMobile ? "20px 20px 0 0" : 18, padding: "24px 24px calc(24px + env(safe-area-inset-bottom))", width: isMobile ? "100%" : 560, maxWidth: 560, border: `1px solid rgba(255,255,255,0.1)`, boxShadow: "0 32px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07)", animation: "sheetup 0.2s ease both", color: T.ink }}>
        {children}
      </div>
    </div>
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
      <div style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(200,160,74,0.8)", textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: syne, marginBottom: 8 }}>Current context · treated as ground truth · synced everywhere</div>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Paste what's current — pipeline numbers, open questions, this week's state. The fresher this is, the sharper the seat's takes."
        style={{ ...S.input, width: "100%", minHeight: 150, padding: "12px 14px", fontSize: 13, resize: "vertical", lineHeight: 1.6 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button onClick={save} disabled={saving} style={{ ...S.brassBtn, flex: 1, padding: 13, fontSize: 12, opacity: saving ? 0.5 : 1 }}>{saving ? "Saving…" : "Save context"}</button>
        <button onClick={onClose} style={{ padding: "13px 18px", background: "transparent", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: 10, color: T.sub, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
      </div>
    </ModalShell>
  );
}

function SkillTuneModal({ name, draft, setDraft, onSave, onClose, isMobile }) {
  return (
    <ModalShell onClose={onClose} isMobile={isMobile} z={320}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(200,160,74,0.15)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: T.brass, fontWeight: 800, fontFamily: syne }}>⟡</span>
        <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: syne }}>Tune skill</span>
          <span style={{ fontSize: 11, color: T.brass, fontFamily: mono }}>{name}</span>
        </span>
      </div>
      <div style={{ fontSize: 11, color: T.faint, lineHeight: 1.6, margin: "10px 0 14px" }}>Your guidance steers how Mini Me practices this skill. It re-reads this before every rep — be specific about voice, priorities, and what "good" looks like.</div>
      <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="e.g. Match my tone — direct, no fluff. Prioritize legal + med-spa verticals. Never open with 'I hope this finds you well.'"
        style={{ ...S.input, width: "100%", minHeight: 130, padding: "12px 14px", fontSize: 13, resize: "vertical", lineHeight: 1.6 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button onClick={onSave} style={{ ...S.brassBtn, flex: 1, padding: 13, fontSize: 12 }}>Save guidance</button>
        <button onClick={onClose} style={{ padding: "13px 18px", background: "transparent", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: 10, color: T.sub, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
      </div>
    </ModalShell>
  );
}

function MigrationModal({ counts, onImport, onSkip, importing }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,16,0.75)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
      <div style={{ background: "linear-gradient(180deg,#141C2E,#101726)", borderRadius: 18, padding: "26px 28px", width: 440, maxWidth: "94vw", border: `1px solid rgba(255,255,255,0.1)`, boxShadow: "0 32px 80px rgba(0,0,0,0.5)", color: T.ink }}>
        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: syne, marginBottom: 8 }}>Import your existing memory?</div>
        <div style={{ fontSize: 12.5, color: T.sub, lineHeight: 1.7, marginBottom: 18 }}>
          This browser has data from before your account existed:{" "}
          <strong style={{ color: T.ink }}>{counts.chat} chat message{counts.chat !== 1 ? "s" : ""}</strong> and{" "}
          <strong style={{ color: T.ink }}>{counts.notes} seat note{counts.notes !== 1 ? "s" : ""}</strong>.
          Import them into your account so they're available on every device? Nothing is deleted either way.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onImport} disabled={importing} style={{ ...S.brassBtn, flex: 1, padding: 12, fontSize: 12, opacity: importing ? 0.5 : 1 }}>{importing ? "Importing…" : "Import"}</button>
          <button onClick={onSkip} disabled={importing} style={{ padding: "12px 18px", background: "transparent", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: 10, color: T.sub, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Skip</button>
        </div>
      </div>
    </div>
  );
}

// ─── Auth screens ────────────────────────────────────────────────────────────
function SetupNotice() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: T.ink, padding: 20 }}>
      <div style={{ maxWidth: 480, padding: "28px 30px", background: "#131A2B", border: `1px solid ${T.line}`, borderRadius: 18 }}>
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
      <div style={{ width: 380, maxWidth: "94vw", padding: "30px 32px", background: "linear-gradient(180deg,#141C2E,#101726)", border: `1px solid ${T.line}`, borderRadius: 18, boxShadow: "0 32px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span style={{ width: 22, height: 22, borderRadius: 7, background: `linear-gradient(135deg, ${T.brass} 0%, ${T.brassDeep} 100%)`, boxShadow: "0 2px 8px rgba(200,160,74,0.45), inset 0 1px 0 rgba(255,255,255,0.4)" }} />
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: syne }}>The Board Room</span>
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
          style={{ ...(disabled ? { background: "rgba(255,255,255,0.06)", color: T.faint, border: "none", borderRadius: 10, fontFamily: syne, fontWeight: 800 } : S.brassBtn), width: "100%", padding: 12, fontSize: 12, cursor: disabled ? "default" : "pointer" }}>
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
  { key: "room", label: "Room", sub: "Chief of Staff · ask anything", mark: T.brass },
  { key: "board", label: "Board", sub: "5 seats · charters & context", mark: "#7C3AED" },
  { key: "assets", label: "Assets", sub: "5 live properties", mark: T.blue },
  { key: "systems", label: "Systems", sub: "status · deploy · db · usage", mark: "#0E9F6E" },
  { key: "mini", label: "Mini Me", sub: "queue · loops · oversight", mark: "#EC4899" },
];
const HEADERS = {
  brief: ["Brief", "generated 6:00 AM · markets, wires, and your stores"],
  room: ["Room", "smart routing · 5 seats on call"],
  board: ["Board", "five specialist seats + one Chief"],
  assets: ["Assets", "everything you run, one click away"],
  systems: ["Systems", "status, deploys, database, auditor, and usage"],
  mini: ["Mini Me", "your sidekick — queue work and it delivers"],
};
const NAV_ICONS = {
  brief: (p) => ( // sunrise — the morning brief
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 18a5 5 0 0 0-10 0" /><line x1="12" y1="2" x2="12" y2="9" />
      <line x1="4.2" y1="10.2" x2="5.6" y2="11.6" /><line x1="19.8" y1="10.2" x2="18.4" y2="11.6" />
      <line x1="1" y1="18" x2="3" y2="18" /><line x1="21" y1="18" x2="23" y2="18" /><line x1="1" y1="22" x2="23" y2="22" />
    </svg>
  ),
  room: (p) => ( // chat bubble — the room
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.4 8.4 0 0 1-8.4 8.4H12a8.3 8.3 0 0 1-4-1L3 20l1.1-5a8.3 8.3 0 0 1-1-4 8.4 8.4 0 0 1 8.4-8.4h.1a8.4 8.4 0 0 1 8.4 8.4z" />
    </svg>
  ),
  board: (p) => ( // grid of seats — the board
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </svg>
  ),
  assets: (p) => ( // building — your properties
    <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21V9l9-6 9 6v12" /><path d="M9 21v-8h6v8" />
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

  const refreshData = async () => {
    if (refreshing || !supabase || !session?.user) return;
    setRefreshing(true);
    btc.refresh();
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

  const send = async () => {
    const q = input.trim();
    if (!q || thinking) return;
    setInput("");
    const userMsg = { role: "user", content: q, ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    db.saveMessage({ role: "user", content: q });
    setThinking(true);
    const models = { ...DEFAULT_MODELS, ...(settings?.models || {}) };
    const result = await convene(q, next, { models, seatNotes });
    setThinking(false);
    const asstMsg = { role: "assistant", content: result.answer, consulted: result.consulted, ts: Date.now() };
    setMessages([...next, asstMsg]);
    db.saveMessage({ role: "assistant", content: result.answer, consulted: result.consulted });
    runOversight(q, result); // fire-and-forget — never blocks the chat
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
      case "brief": return <MorningBriefPage btc={btc} isMobile={isMobile} />;
      case "room": return <RoomPage messages={messages} thinking={thinking} loadingData={loadingData} input={input} setInput={setInput} onSend={send} endRef={endRef} isMobile={isMobile} />;
      case "board": return <BoardPage seatNotes={seatNotes} onEditSeat={setEditSeat} onEnterRoom={() => setPage("room")} isMobile={isMobile} />;
      case "assets": return <PropertiesPage isMobile={isMobile} btc={btc} />;
      case "systems": return <SystemsPage settings={settings} updateSetting={updateSetting} session={session} btc={btc} isMobile={isMobile} />;
      case "mini": return <MiniMePage settings={settings} updateSetting={updateSetting} session={session} onWorkerRun={refreshData} isMobile={isMobile} />;
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
        <div style={{ flex: "none", height: 54, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", borderBottom: `1px solid ${T.line}`, background: "rgba(10,15,28,0.85)", backdropFilter: "blur(14px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ width: 20, height: 20, borderRadius: 6, background: `linear-gradient(135deg, ${T.brass} 0%, ${T.brassDeep} 100%)`, boxShadow: "0 2px 6px rgba(200,160,74,0.45), inset 0 1px 0 rgba(255,255,255,0.4)" }} />
            <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: syne }}>Board Room</span>
          </div>
          <TopStatus now={now} dataStamp={dataStamp} refreshing={refreshing} onRefresh={refreshData} compact />
        </div>

        {renderPage(page)}

        {/* Bottom nav — icon-only, same 6 destinations as the desktop rail */}
        <div style={{ flex: "none", display: "flex", borderTop: `1px solid ${T.line}`, background: "rgba(10,15,28,0.92)", backdropFilter: "blur(12px)", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {NAV.map(n => {
            const active = page === n.key;
            const Icon = NAV_ICONS[n.key];
            return (
              <button key={n.key} onClick={() => setPage(n.key)} title={n.label} aria-label={n.label} aria-current={active ? "page" : undefined}
                style={{ flex: 1, minHeight: 64, background: active ? "linear-gradient(180deg, rgba(200,160,74,0.10), transparent)" : "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 7, padding: "10px 0" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.brass, opacity: active ? 1 : 0, transition: "opacity 0.15s", boxShadow: "0 0 8px rgba(200,160,74,0.85)" }} />
                <Icon width={23} height={23} color={active ? T.ink : T.faint} style={{ transition: "color 0.15s" }} />
              </button>
            );
          })}
        </div>

        {editSeat && <SeatNotesModal seatKey={editSeat} initial={seatNotes[editSeat]} onSave={saveSeatNote} onClose={() => setEditSeat(null)} isMobile />}
        {migration && <MigrationModal counts={migration} onImport={runImport} onSkip={skipImport} importing={importing} />}
      </div>
    );
  }

  // ═══ DESKTOP SHELL ═══
  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "264px minmax(0,1fr)", color: T.ink }}>
      {/* Nav rail */}
      <div style={{ borderRight: `1px solid ${T.line}`, padding: "26px 16px 16px", display: "flex", flexDirection: "column", gap: 20, height: "100vh", position: "sticky", top: 0, overflowY: "auto", background: "linear-gradient(180deg,rgba(255,255,255,0.015),transparent 30%)" }}>
        <div style={{ padding: "0 6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <span style={{ width: 24, height: 24, borderRadius: 7, background: `linear-gradient(135deg, ${T.brass} 0%, ${T.brassDeep} 100%)`, boxShadow: "0 2px 8px rgba(200,160,74,0.45), inset 0 1px 0 rgba(255,255,255,0.4)" }} />
            <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: syne }}>Board Room</span>
          </div>
          <div style={{ height: 1, background: "linear-gradient(90deg,rgba(200,160,74,0.45),transparent)", marginTop: 16 }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {NAV.map(n => {
            const active = page === n.key;
            return (
              <div key={n.key} onClick={() => setPage(n.key)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 13px", borderRadius: 12, cursor: "pointer", background: active ? "linear-gradient(180deg, rgba(200,160,74,0.13), rgba(200,160,74,0.05))" : "transparent", border: `1px solid ${active ? "rgba(200,160,74,0.3)" : "transparent"}` }}>
                <span style={{ width: 8, height: 8, transform: "rotate(45deg)", background: active ? n.mark : "rgba(255,255,255,0.18)", boxShadow: active ? `0 0 10px ${n.mark}99` : "none", flex: "none", borderRadius: 2 }} />
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
          <div style={{ padding: "13px 14px", background: "linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))", border: `1px solid ${T.line}`, borderRadius: 14, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 15, height: 15, borderRadius: "50%", background: "linear-gradient(135deg,#F7931A,#C77416)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 800, color: "#1A0F00" }}>₿</span>
                <span style={{ fontSize: 13, fontWeight: 500, fontFamily: mono }}>{btc.loading ? "…" : btc.error ? "—" : "$" + btc.price?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </div>
              {!btc.loading && !btc.error && (
                <span style={{ fontSize: 10, fontWeight: 700, color: (btc.changePct || 0) >= 0 ? T.green : T.red, fontFamily: mono }}>{(btc.changePct || 0) >= 0 ? "▲" : "▼"} {Math.abs(btc.changePct || 0).toFixed(2)}%</span>
              )}
            </div>
            <Sparkline points={btc.points} color={(btc.changePct || 0) >= 0 ? T.green : T.red} height={30} />
          </div>

          {calUrl && !editingCal ? (
            <a href={calUrl} target="_blank" rel="noopener" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", background: "rgba(200,160,74,0.08)", border: "1px solid rgba(200,160,74,0.25)", borderRadius: 12, color: T.brass, fontSize: 11, fontWeight: 700, textDecoration: "none" }}>Open Calendar <span>›</span></a>
          ) : !editingCal ? (
            <button onClick={() => { setEditingCal(true); setCalDraft(calUrl); }} style={{ width: "100%", padding: "11px 14px", background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.14)", borderRadius: 12, color: T.sub, fontSize: 10.5, cursor: "pointer", textAlign: "left" }}>+ Link your calendar</button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <input value={calDraft} onChange={e => setCalDraft(e.target.value)} placeholder="calendar share URL" style={{ ...S.input, width: "100%", padding: "9px 11px", fontSize: 11, borderRadius: 9 }} />
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => { updateSetting("calendar_url", calDraft.trim()); setEditingCal(false); }} style={{ ...S.brassBtn, flex: 1, padding: 8, fontSize: 10.5, borderRadius: 8 }}>Save</button>
                <button onClick={() => setEditingCal(false)} style={{ padding: "8px 11px", background: "transparent", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: 8, color: T.sub, fontSize: 10.5, cursor: "pointer" }}>Cancel</button>
              </div>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderTop: `1px solid ${T.line}`, paddingTop: 12 }}>
            <span style={{ fontSize: 9.5, color: T.faint, fontFamily: mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.user?.email}</span>
            <button onClick={() => supabase.auth.signOut()} style={{ background: "none", border: `1px solid rgba(255,255,255,0.1)`, borderRadius: 7, color: T.sub, fontSize: 9, padding: "4px 9px", cursor: "pointer", fontWeight: 600 }}>Sign out</button>
          </div>
        </div>
      </div>

      {/* Main column */}
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", minWidth: 0 }}>
        <div style={{ height: 58, flex: "none", borderBottom: `1px solid ${T.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 34px", background: "linear-gradient(180deg,rgba(255,255,255,0.02),transparent)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: syne, letterSpacing: "0.02em" }}>{HEADERS[page][0]}</span>
            <span style={{ fontSize: 10.5, color: T.faint }}>{HEADERS[page][1]}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ fontSize: 9.5, color: T.faint, fontFamily: mono, letterSpacing: "0.05em" }}>SESSION ${totalSpend.toFixed(3)} · {obs.all().length} CALLS</span>
            <span style={{ width: 1, height: 22, background: T.line, flex: "none" }} />
            <TopStatus now={now} dataStamp={dataStamp} refreshing={refreshing} onRefresh={refreshData} />
          </div>
        </div>

        {renderPage(page)}
      </div>

      {editSeat && <SeatNotesModal seatKey={editSeat} initial={seatNotes[editSeat]} onSave={saveSeatNote} onClose={() => setEditSeat(null)} />}
      {migration && <MigrationModal counts={migration} onImport={runImport} onSkip={skipImport} importing={importing} />}
    </div>
  );
}
