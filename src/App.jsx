import { useState, useEffect, useRef } from "react";

// ════════════════════════════════════════════════════════════════════════════
// THE BOARD ROOM — one Chief of Staff, five specialist seats, smart routing.
// You talk to the Chief; it decides which seats to consult, convenes them in
// parallel, and synthesizes attributed perspectives into one recommendation.
// ════════════════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const PRICING = { [HAIKU]: { in: 1, out: 5 }, [SONNET]: { in: 3, out: 15 } };
const estCost = (m, i, o) => (i / 1e6) * (PRICING[m]?.in || 1) + (o / 1e6) * (PRICING[m]?.out || 5);

const sm = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(`br_${k}`)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`br_${k}`, JSON.stringify(v)); } catch {} },
};
const obs = {
  all: () => sm.get("obs") || [],
  log: (e) => sm.set("obs", [{ ts: new Date().toISOString(), ...e }, ...(sm.get("obs") || [])].slice(0, 300)),
};

async function callClaude({ system, messages, model = HAIKU, maxTokens = 800, fn = "call" }) {
  const t0 = Date.now();
  try {
    const isDeployed = window.location.hostname !== "localhost";
    const url = isDeployed ? "/.netlify/functions/claude" : "https://api.anthropic.com/v1/messages";
    const headers = isDeployed ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json();
    const text = data.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
    obs.log({ fn, model, inTok: data.usage?.input_tokens || 0, outTok: data.usage?.output_tokens || 0, cost: estCost(model, data.usage?.input_tokens || 0, data.usage?.output_tokens || 0), ms: Date.now() - t0, ok: !!text });
    return text;
  } catch { obs.log({ fn, model, ok: false, ms: Date.now() - t0 }); return null; }
}

// ─── The Board — five seats, each with a charter. Context notes are editable
//     in the UI so each seat stays current with what's actually happening. ───
const BOARD = [
  { key: "clarify", name: "Clarify Lead", emoji: "🎯", color: "#B68A2E",
    charter: "You run Clarify Paid Search — a boutique Google Ads agency targeting high-value local service verticals (legal, med spa, dental, home services). You own the outreach pipeline, client delivery, and agency growth. You think in pipeline value, reply rates, and retainer economics. You are direct about what will and won't move revenue.",
    domains: "agency, outreach, paid search, Google Ads, clients, prospecting, Clarify" },
  { key: "zts", name: "ZTS Lead", emoji: "🔐", color: "#0E9F6E",
    charter: "You run Zero To Secure — a premium stainless-steel seed phrase backup kit ($150, DTC Shopify). You own creator collabs, YouTube Shorts production, SEO content, and conversion. You think in audience-fit reach, content cadence, and DTC unit economics. Bitcoin self-custody conviction, empowerment over fear.",
    domains: "ZTS, Zero To Secure, creators, YouTube, Shorts, SEO, Shopify, ecommerce, Bitcoin product" },
  { key: "macro", name: "Macro Strategist", emoji: "📈", color: "#3B82F6",
    charter: "You are the markets and macro seat. Cameron holds long-term Bitcoin conviction with a leveraged WBTC position on Aave he manages carefully, and has a developed thesis about an AI investment bubble (circular hyperscaler financing, private credit exposure). Your job is honest pressure-testing, never validation. Flag risk asymmetries. He has explicitly asked you not to glaze over weaknesses.",
    domains: "markets, macro, Bitcoin, BTC, crypto, investing, trading, Fed, positions, portfolio" },
  { key: "ops", name: "Ops & Finance", emoji: "⚙️", color: "#7C3AED",
    charter: "You are the operations and finance seat across all ventures. You watch time allocation, AI/tool spend, and whether effort matches expected return. Cameron's stated goal: decouple income from hours sold; near-term success = meaningful recurring revenue from either venture. You are the one who asks 'is this the best use of the next 10 hours?'",
    domains: "operations, priorities, time, spend, budget, focus, tradeoffs, planning, week" },
  { key: "career", name: "Career Advisor", emoji: "🧭", color: "#EC4899",
    charter: "You are the career seat. Cameron is a Senior Analyst in paid search at Ovative Group (Chicago, healthcare portfolio) with limited upward mobility due to tenure-weighted promotions. Identified path: RevOps Manager at a mid-size SaaS company within ~2 years for significantly higher compensation; Salesforce-adjacent skills matter. You weigh day-job moves against the ventures without romanticizing either.",
    domains: "career, Ovative, job, RevOps, Salesforce, promotion, resume, interviews, work" },
];

const CHIEF_SYSTEM = `You are the Chief of Staff for Cameron's board room — the single point of contact above five specialist seats (Clarify Lead, ZTS Lead, Macro Strategist, Ops & Finance, Career Advisor). Cameron is a builder running two ventures alongside a day job, with a stated goal of decoupling income from hours sold. You are direct, synthesizing, and honest — he has explicitly asked for pressure-testing over validation. When board perspectives conflict, name the conflict rather than smoothing it over.`;

// ─── Smart routing: a tiny Haiku call decides which seats this question needs ─
async function routeQuestion(question) {
  const system = `You are a router. Given a question, decide which board seats should be consulted. Seats and their domains:
${BOARD.map(b => `- ${b.key}: ${b.domains}`).join("\n")}

Respond ONLY with JSON: {"seats": ["key1", ...], "reason": "5 words max"}
Rules: 0 seats if the Chief can answer alone (greetings, simple facts, followups). 1-2 seats for domain questions. 3+ only for genuinely cross-cutting strategy. Fewer is better.`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: question }], model: HAIKU, maxTokens: 120, fn: "route" });
  try { const p = JSON.parse((raw || "").replace(/```json|```/g, "").trim()); return { seats: (p.seats || []).filter(k => BOARD.some(b => b.key === k)), reason: p.reason || "" }; } catch { return { seats: [], reason: "routing failed — chief only" }; }
}

// ─── Consult one seat (parallel-safe) ────────────────────────────────────────
async function consultSeat(seatKey, question, history) {
  const seat = BOARD.find(b => b.key === seatKey);
  if (!seat) return null;
  const notes = (sm.get("seat_notes") || {})[seatKey] || "";
  const system = `${seat.charter}${notes ? `\n\nCurrent context from Cameron (treat as ground truth):\n${notes}` : ""}\n\nYou are giving your seat's perspective to the Chief of Staff, who will synthesize. Be concise: 2-4 sentences of your genuine take, including any disagreement or risk you see. No preamble.`;
  const text = await callClaude({ system, messages: [{ role: "user", content: question }], model: HAIKU, maxTokens: 300, fn: `seat_${seatKey}` });
  return text ? { seat: seat.key, name: seat.name, emoji: seat.emoji, color: seat.color, take: text } : null;
}

// ─── The full convening: route → fan out in parallel → synthesize ────────────
async function convene(question, history, { useSonnet } = {}) {
  const routing = await routeQuestion(question);
  const takes = routing.seats.length
    ? (await Promise.all(routing.seats.map(k => consultSeat(k, question, history)))).filter(Boolean)
    : [];
  const historyMsgs = (history || []).slice(-8).map(m => ({ role: m.role, content: m.content }));
  const boardBlock = takes.length
    ? `\n\nThe board seats you consulted returned these takes:\n${takes.map(t => `[${t.name}]: ${t.take}`).join("\n\n")}\n\nSynthesize into one answer. Attribute perspectives naturally ("Clarify's lead thinks..."). If seats conflict, surface the conflict and give YOUR recommendation.`
    : "";
  const answer = await callClaude({
    system: CHIEF_SYSTEM + boardBlock,
    messages: [...historyMsgs, { role: "user", content: question }],
    model: useSonnet ? SONNET : HAIKU, maxTokens: 900, fn: "chief",
  });
  return { answer: answer || "The board couldn't be reached — check your API key.", consulted: takes, routing };
}
// ─── Design system (the premium foundation, boardroom palette: deep navy + brass) ─
function useGlobalStyles() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&family=Syne:wght@600;700;800&display=swap";
    document.head.appendChild(link);
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; }
      * { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
      html, body { margin: 0; font-family: 'Inter', system-ui, sans-serif; }
      body { background-color: #0D1322; background-image: radial-gradient(1100px 550px at 15% -5%, rgba(182,138,46,0.08), transparent 60%), radial-gradient(900px 600px at 100% 0%, rgba(59,130,246,0.06), transparent 55%); background-attachment: fixed; }
      ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 10px; }
      textarea, input, select, button { font-family: 'Inter', system-ui, sans-serif; }
      ::selection { background: rgba(182,138,46,0.35); color: #FFF; }
      button, a, input, textarea { transition: all 0.16s ease; }
      button:focus-visible, input:focus-visible, textarea:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(182,138,46,0.4); }
      input::placeholder, textarea::placeholder { color: #5B6778; }
      @keyframes fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    `;
    document.head.appendChild(style);
  }, []);
}
const syne = "'Syne', system-ui", mono = "'DM Mono', monospace";
const T = { ink: "#EDF1F7", sub: "#9AA6BC", faint: "#5B6778", brass: "#C8A04A", brassDeep: "#B68A2E", panel: "rgba(255,255,255,0.035)", line: "rgba(255,255,255,0.08)", green: "#34D399" };

// Your properties — the hub that links everything together.
const PROPERTIES = [
  { name: "Clarify Paid Search", desc: "Boutique Google Ads agency", url: "https://clarifypaidsearch.com", app: "Clarify Command Center", appUrl: "https://coruscating-sundae-f0def3.netlify.app", color: "#B68A2E", repo: "camcarp14/clarify-outreach" },
  { name: "Clarify SaaS", desc: "Multi-tenant Google Ads auditing tool", url: "https://clarify-saas.netlify.app/", app: "Clarify SaaS", appUrl: "https://clarify-saas.netlify.app/", color: "#B68A2E", repo: null },
  { name: "Zero To Secure", desc: "Premium seed phrase backup", url: "https://zerotosecure.com", app: "ZTS Command Center", appUrl: "https://zts-command-center.netlify.app", color: "#0E9F6E", repo: "camcarp14/zts-command-center" },
  { name: "Macro Command Center", desc: "Markets, portfolio, macro thesis", url: null, app: "Macro Command Center", appUrl: "https://macro-command-center.netlify.app/", color: "#3B82F6", repo: null },
  { name: "Board Room", desc: "This app", url: null, app: "Board Room", appUrl: "https://board-room.netlify.app", color: "#C8A04A", repo: "camcarp14/board-room" },
];


// ─── Right rail: Bitcoin ticker + calendar link ──────────────────────────────
// Bitcoin price + a lightweight 30-min-interval sparkline. Uses CoinGecko's free,
// no-key public API — market_chart with 1-day range returns ~5-min candles, which
// we downsample to roughly 30-min points for a clean, fast sparkline.
function useBitcoinPrice() {
  const [state, setState] = useState({ price: null, changePct: null, points: [], loading: true, error: null });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [priceRes, chartRes] = await Promise.all([
          fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true"),
          fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1"),
        ]);
        const priceData = await priceRes.json();
        const chartData = await chartRes.json();
        const raw = (chartData.prices || []).map(([ts, p]) => ({ ts, p }));
        // Downsample to ~30min spacing (raw is ~5min candles over 24h ≈ 288 points → keep every 6th)
        const step = Math.max(1, Math.floor(raw.length / 48));
        const points = raw.filter((_, i) => i % step === 0).map(r => r.p);
        if (alive) setState({ price: priceData.bitcoin?.usd ?? null, changePct: priceData.bitcoin?.usd_24h_change ?? null, points, loading: false, error: null });
      } catch (e) {
        if (alive) setState(s => ({ ...s, loading: false, error: "price feed unavailable" }));
      }
    };
    load();
    const iv = setInterval(load, 30 * 60 * 1000); // refresh on the same 30min cadence as the chart granularity
    return () => { alive = false; clearInterval(iv); };
  }, []);
  return state;
}

function Sparkline({ points, color }) {
  if (!points || points.length < 2) return <div style={{ height: "44px" }} />;
  const min = Math.min(...points), max = Math.max(...points);
  const range = max - min || 1;
  const w = 260, h = 44;
  const step = w / (points.length - 1);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(h - ((p - min) / range) * h).toFixed(1)}`).join(" ");
  const areaPath = `${path} L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
      <path d={areaPath} fill={color} opacity="0.12" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}


// ─── Site Auditor — toggleable cross-property review agent ───────────────────
// Checks each property's live site (and repo README/package.json if known) for
// concrete improvement opportunities. Manual "Run now" always works; the toggle
// only controls whether it also re-runs itself automatically every 6h while a
// tab is open (same browser-loop limitation as the other engines — not truly
// always-on unless moved server-side later).
async function auditProperty(p) {
  try {
    const res = await fetch("/.netlify/functions/audit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: p.name, url: p.url || p.appUrl, repo: p.repo }),
    });
    const data = await res.json();
    return data.success ? data.findings : [];
  } catch { return []; }
}

function AuditorPanel() {
  const [enabled, setEnabled] = useState(() => sm.get("auditor_enabled") || false);
  const [findings, setFindings] = useState(() => sm.get("auditor_findings") || []);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(() => sm.get("auditor_last_run") || null);

  const runAll = async () => {
    setRunning(true);
    const results = [];
    for (const p of PROPERTIES) {
      const fs = await auditProperty(p);
      fs.forEach(f => results.push({ ...f, property: p.name, color: p.color, ts: Date.now() }));
    }
    const next = [...results, ...findings].slice(0, 40);
    setFindings(next); sm.set("auditor_findings", next);
    const now = Date.now();
    setLastRun(now); sm.set("auditor_last_run", now);
    setRunning(false);
  };

  // Auto-cadence — only while enabled and a tab is open.
  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(() => {
      const last = sm.get("auditor_last_run") || 0;
      if (Date.now() - last > 6 * 3600 * 1000) runAll();
    }, 5 * 60 * 1000); // check every 5 min whether 6h has elapsed
    return () => clearInterval(iv);
  }, [enabled]);

  const toggle = () => { const v = !enabled; setEnabled(v); sm.set("auditor_enabled", v); };
  const sevColor = { high: "#F87171", medium: "#F59E0B", low: T.sub };
  const ago = (ts) => { if (!ts) return "never"; const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`; };

  return (
    <div style={{ padding: "16px 17px", background: T.panel, border: `1px solid ${T.line}`, borderRadius: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
        <div style={{ fontSize: "11px", fontWeight: 700, fontFamily: syne, color: T.ink }}>Site Auditor</div>
        <div onClick={toggle} style={{ width: "34px", height: "20px", borderRadius: "11px", background: enabled ? T.green : "rgba(255,255,255,0.12)", position: "relative", cursor: "pointer" }}>
          <div style={{ position: "absolute", top: "2px", left: enabled ? "16px" : "2px", width: "16px", height: "16px", borderRadius: "50%", background: "#0D1322", transition: "left 0.15s" }} />
        </div>
      </div>
      <div style={{ fontSize: "10px", color: T.faint, lineHeight: 1.5, marginBottom: "10px" }}>
        {enabled ? "Auto-reviews every 6h (while this tab is open)" : "Off — reviews only when you run it"} · reviews every property's live site, and code context where a repo + GitHub token is available.
      </div>
      <button onClick={runAll} disabled={running} style={{ width: "100%", padding: "9px", background: running ? "rgba(255,255,255,0.05)" : "rgba(200,160,74,0.12)", border: `1px solid ${running ? T.line : "rgba(200,160,74,0.3)"}`, borderRadius: "9px", color: running ? T.faint : T.brass, fontSize: "11px", fontWeight: 700, cursor: running ? "default" : "pointer", fontFamily: syne, marginBottom: "10px" }}>
        {running ? "Auditing all properties…" : "Run audit now"}
      </button>
      <div style={{ fontSize: "9px", color: T.faint, marginBottom: "10px" }}>Last run: {ago(lastRun)}</div>
      {findings.length === 0 ? (
        <div style={{ fontSize: "10px", color: T.faint, textAlign: "center", padding: "10px 0" }}>No findings yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "260px", overflowY: "auto" }}>
          {findings.slice(0, 12).map((f, i) => (
            <div key={i} style={{ padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", borderLeft: `2px solid ${sevColor[f.severity] || T.sub}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
                <span style={{ fontSize: "9px", fontWeight: 700, color: f.color, fontFamily: syne }}>{f.property}</span>
                <span style={{ fontSize: "8px", color: sevColor[f.severity] || T.sub, fontWeight: 700, textTransform: "uppercase" }}>{f.severity}</span>
              </div>
              <div style={{ fontSize: "10.5px", color: T.ink, lineHeight: 1.5 }}>{f.finding}</div>
              <div style={{ fontSize: "10px", color: T.sub, lineHeight: 1.5, marginTop: "3px", fontStyle: "italic" }}>→ {f.suggestion}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RightRail() {
  const btc = useBitcoinPrice();
  const [calUrl, setCalUrl] = useState(() => sm.get("calendar_url") || "");
  const [editingCal, setEditingCal] = useState(false);
  const [tempUrl, setTempUrl] = useState(calUrl);
  const up = (btc.changePct || 0) >= 0;
  const changeColor = up ? T.green : "#F87171";

  const saveCal = () => { sm.set("calendar_url", tempUrl.trim()); setCalUrl(tempUrl.trim()); setEditingCal(false); };

  return (
    <div style={{ borderLeft: `1px solid ${T.line}`, padding: "22px 18px", display: "flex", flexDirection: "column", gap: "18px", height: "100vh", position: "sticky", top: 0, overflowY: "auto" }}>
      {/* Bitcoin widget */}
      <div style={{ padding: "16px 17px", background: T.panel, border: `1px solid ${T.line}`, borderRadius: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
            <span style={{ width: "16px", height: "16px", borderRadius: "50%", background: "linear-gradient(135deg, #F7931A, #C77416)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "9px", fontWeight: 800, color: "#1A0F00" }}>₿</span>
            <span style={{ fontSize: "11px", fontWeight: 700, fontFamily: syne, color: T.ink }}>Bitcoin</span>
          </div>
          <span style={{ fontSize: "9px", color: T.faint, fontFamily: mono }}>30m</span>
        </div>
        {btc.loading ? (
          <div style={{ fontSize: "12px", color: T.faint, padding: "8px 0" }}>Loading price…</div>
        ) : btc.error ? (
          <div style={{ fontSize: "11px", color: T.faint, padding: "8px 0" }}>{btc.error}</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: "9px", marginBottom: "8px" }}>
              <span style={{ fontSize: "21px", fontWeight: 600, color: T.ink, fontFamily: mono }}>${btc.price?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              <span style={{ fontSize: "11px", fontWeight: 700, color: changeColor, fontFamily: mono }}>{up ? "▲" : "▼"} {Math.abs(btc.changePct || 0).toFixed(2)}%</span>
            </div>
            <Sparkline points={btc.points} color={changeColor} />
            <div style={{ fontSize: "9px", color: T.faint, marginTop: "6px" }}>24h · via CoinGecko</div>
          </>
        )}
      </div>

      {/* Calendar link */}
      <div style={{ padding: "16px 17px", background: T.panel, border: `1px solid ${T.line}`, borderRadius: "14px" }}>
        <div style={{ fontSize: "11px", fontWeight: 700, fontFamily: syne, color: T.ink, marginBottom: "10px" }}>Calendar</div>
        {!editingCal ? (
          calUrl ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <a href={calUrl} target="_blank" rel="noopener" style={{ display: "block", padding: "10px 12px", background: "rgba(255,255,255,0.05)", border: `1px solid ${T.line}`, borderRadius: "9px", color: T.brass, fontSize: "12px", fontWeight: 700, textDecoration: "none", textAlign: "center" }}>Open Calendar ›</a>
              <span onClick={() => { setTempUrl(calUrl); setEditingCal(true); }} style={{ fontSize: "10px", color: T.faint, cursor: "pointer", textAlign: "center" }}>change link</span>
            </div>
          ) : (
            <button onClick={() => setEditingCal(true)} style={{ width: "100%", padding: "10px 12px", background: "rgba(255,255,255,0.04)", border: `1px dashed ${T.line}`, borderRadius: "9px", color: T.sub, fontSize: "11px", cursor: "pointer" }}>+ Link your calendar</button>
          )
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <input value={tempUrl} onChange={e => setTempUrl(e.target.value)} placeholder="paste your calendar share/embed URL"
              style={{ width: "100%", padding: "9px 11px", background: "rgba(255,255,255,0.04)", border: `1px solid ${T.line}`, borderRadius: "8px", color: T.ink, fontSize: "11.5px" }} />
            <div style={{ display: "flex", gap: "6px" }}>
              <button onClick={saveCal} style={{ flex: 1, padding: "8px", background: "linear-gradient(135deg, #C8A04A, #8A6420)", border: "none", borderRadius: "8px", color: "#0D1322", fontSize: "11px", fontWeight: 800, cursor: "pointer", fontFamily: syne }}>Save</button>
              <button onClick={() => setEditingCal(false)} style={{ padding: "8px 12px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "8px", color: T.sub, fontSize: "11px", cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        )}
        <div style={{ fontSize: "9px", color: T.faint, marginTop: "8px", lineHeight: 1.5 }}>Works with any share link — Google Calendar, iCloud public link, or a OneCalendar share URL.</div>
      </div>

      <AuditorPanel />
    </div>
  );
}

// ─── Main app — the chat, the roster, the hub ────────────────────────────────
export default function App() {
  useGlobalStyles();
  const [messages, setMessages] = useState(() => sm.get("chat") || []);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(null); // { seats: [...] } while convening
  const [useSonnet, setUseSonnet] = useState(false);
  const [editSeat, setEditSeat] = useState(null);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, thinking]);

  const send = async () => {
    const q = input.trim();
    if (!q || thinking) return;
    setInput("");
    const next = [...messages, { role: "user", content: q, ts: Date.now() }];
    setMessages(next); sm.set("chat", next);
    setThinking({ seats: [] });
    const result = await convene(q, next, { useSonnet });
    setThinking(null);
    const final = [...next, { role: "assistant", content: result.answer, consulted: result.consulted, ts: Date.now() }];
    setMessages(final); sm.set("chat", final);
  };

  const totalSpend = obs.all().reduce((s, l) => s + (l.cost || 0), 0);

  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "300px 1fr 300px", color: T.ink }}>
      {/* ── Left rail: the board + the hub ── */}
      <div style={{ borderRight: `1px solid ${T.line}`, padding: "22px 18px", display: "flex", flexDirection: "column", gap: "20px", overflowY: "auto", height: "100vh", position: "sticky", top: 0 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
            <span style={{ width: "20px", height: "20px", borderRadius: "6px", background: "linear-gradient(135deg, #C8A04A 0%, #8A6420 100%)", boxShadow: "0 1px 4px rgba(200,160,74,0.5), inset 0 1px 0 rgba(255,255,255,0.3)" }} />
            <span style={{ fontSize: "13px", fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: syne, color: T.ink }}>The Board Room</span>
          </div>
          <div style={{ fontSize: "11px", color: T.faint, marginTop: "5px", lineHeight: 1.5 }}>One Chief of Staff. Five seats. You talk to the top; the top consults the room.</div>
        </div>

        <div>
          <div style={{ fontSize: "10px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: syne, marginBottom: "10px" }}>The Board</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
            {BOARD.map(b => {
              const notes = (sm.get("seat_notes") || {})[b.key];
              return (
                <div key={b.key} onClick={() => setEditSeat(b.key)} style={{ padding: "11px 13px", background: T.panel, border: `1px solid ${T.line}`, borderLeft: `3px solid ${b.color}`, borderRadius: "10px", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "14px" }}>{b.emoji}</span>
                    <span style={{ fontSize: "12px", fontWeight: 700, fontFamily: syne }}>{b.name}</span>
                  </div>
                  <div style={{ fontSize: "9px", color: notes ? T.green : T.faint, marginTop: "4px" }}>{notes ? "✓ context loaded" : "tap to add context"}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ fontSize: "10px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: syne, marginBottom: "10px" }}>Your Properties</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
            {PROPERTIES.map((p, i) => (
              <div key={i} style={{ padding: "11px 13px", background: T.panel, border: `1px solid ${T.line}`, borderRadius: "10px" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, fontFamily: syne, color: T.ink }}>{p.name}</div>
                <div style={{ fontSize: "10px", color: T.faint, margin: "2px 0 7px" }}>{p.desc}</div>
                <div style={{ display: "flex", gap: "10px" }}>
                  {p.url && <a href={p.url} target="_blank" rel="noopener" style={{ fontSize: "10px", color: p.color, fontWeight: 700, textDecoration: "none" }}>Site ›</a>}
                  <a href={p.appUrl} target="_blank" rel="noopener" style={{ fontSize: "10px", color: T.sub, fontWeight: 600, textDecoration: "none" }}>Command Center ›</a>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: "auto", fontSize: "10px", color: T.faint, fontFamily: mono }}>
          session spend ${totalSpend.toFixed(3)} · {obs.all().length} calls
          <label style={{ display: "flex", alignItems: "center", gap: "7px", marginTop: "8px", cursor: "pointer", fontFamily: "'Inter', system-ui" }}>
            <input type="checkbox" checked={useSonnet} onChange={e => setUseSonnet(e.target.checked)} style={{ accentColor: T.brass }} />
            <span style={{ fontSize: "10px", color: T.sub }}>Chief on Sonnet (better synthesis, ~3× cost)</span>
          </label>
        </div>
      </div>

      {/* ── Main: the conversation ── */}
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <div style={{ flex: 1, overflowY: "auto", padding: "28px 24px", display: "flex", flexDirection: "column", gap: "18px", alignItems: "center" }}>
          <div style={{ width: "100%", maxWidth: "480px", display: "flex", flexDirection: "column", gap: "14px" }}>
          {messages.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", maxWidth: "440px" }}>
              <div style={{ fontSize: "26px", fontWeight: 700, fontFamily: syne, marginBottom: "10px" }}>The room is yours.</div>
              <div style={{ fontSize: "13px", color: T.sub, lineHeight: 1.7 }}>Ask the Chief of Staff anything. It routes each question to the seats that matter — Clarify, ZTS, Macro, Ops, Career — and brings you back one synthesized answer with the disagreements left in.</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", marginTop: "20px" }}>
                {["What should I prioritize this week?", "Is ZTS or Clarify closer to recurring revenue?", "Pressure-test my BTC leverage right now"].map((s, i) => (
                  <button key={i} onClick={() => setInput(s)} style={{ padding: "8px 14px", background: T.panel, border: `1px solid ${T.line}`, borderRadius: "18px", color: T.sub, fontSize: "11px", cursor: "pointer" }}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%", animation: "fadein 0.2s ease both" }}>
              {m.role === "assistant" && (m.consulted || []).length > 0 && (
                <div style={{ display: "flex", gap: "6px", marginBottom: "7px", flexWrap: "wrap" }}>
                  {m.consulted.map((c, j) => (
                    <span key={j} title={c.take} style={{ fontSize: "9px", fontWeight: 700, color: c.color, background: c.color + "1A", border: `1px solid ${c.color}35`, padding: "3px 9px", borderRadius: "14px", fontFamily: syne, cursor: "help" }}>{c.emoji} {c.name}</span>
                  ))}
                </div>
              )}
              <div style={{ padding: "10px 14px", borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: m.role === "user" ? "linear-gradient(135deg, #C8A04A22, #B68A2E15)" : T.panel, border: `1px solid ${m.role === "user" ? "rgba(200,160,74,0.3)" : T.line}`, fontSize: "13px", lineHeight: 1.6, whiteSpace: "pre-wrap", color: T.ink }}>{m.content}</div>
            </div>
          ))}
          {thinking && (
            <div style={{ alignSelf: "flex-start", padding: "13px 17px", borderRadius: "16px 16px 16px 4px", background: T.panel, border: `1px solid ${T.line}`, fontSize: "12px", color: T.sub }}>
              <span style={{ animation: "pulse 1.4s infinite" }}>Convening the room…</span>
            </div>
          )}
          <div ref={endRef} />
          </div>
        </div>
        <div style={{ padding: "16px 24px 22px", borderTop: `1px solid ${T.line}`, display: "flex", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: "480px" }}>
          <div style={{ display: "flex", gap: "10px", background: T.panel, border: `1px solid ${T.line}`, borderRadius: "14px", padding: "6px 6px 6px 18px" }}>
            <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Ask the Chief of Staff…" rows={1}
              style={{ flex: 1, background: "transparent", border: "none", color: T.ink, fontSize: "13.5px", resize: "none", padding: "10px 0", lineHeight: 1.5, outline: "none" }} />
            <button onClick={send} disabled={!!thinking || !input.trim()} style={{ padding: "0 20px", background: thinking || !input.trim() ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg, #C8A04A, #8A6420)", border: "none", borderRadius: "10px", color: thinking || !input.trim() ? T.faint : "#0D1322", fontSize: "12px", fontWeight: 800, cursor: thinking ? "default" : "pointer", fontFamily: syne }}>Ask</button>
          </div>
          <div style={{ fontSize: "10px", color: T.faint, marginTop: "8px", textAlign: "center" }}>Smart routing: quick questions stay Chief-only (1 call); cross-cutting ones convene seats in parallel.</div>
          </div>
        </div>
      </div>

      <RightRail />

      {editSeat && <SeatNotesModal seatKey={editSeat} onClose={() => setEditSeat(null)} />}
    </div>
  );
}

// Editable per-seat context — how each board member stays current.
function SeatNotesModal({ seatKey, onClose }) {
  const seat = BOARD.find(b => b.key === seatKey);
  const [notes, setNotes] = useState(() => (sm.get("seat_notes") || {})[seatKey] || "");
  const save = () => { sm.set("seat_notes", { ...(sm.get("seat_notes") || {}), [seatKey]: notes }); onClose(); };
  if (!seat) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(5,8,16,0.7)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadein 0.15s ease both" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#131A2B", borderRadius: "18px", padding: "26px 28px", width: "560px", maxWidth: "94vw", border: `1px solid ${T.line}`, boxShadow: "0 32px 80px rgba(0,0,0,0.5)" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, fontFamily: syne, color: T.ink, marginBottom: "4px" }}>{seat.emoji} {seat.name}</div>
        <div style={{ fontSize: "11px", color: T.faint, lineHeight: 1.6, marginBottom: "16px" }}>{seat.charter.slice(0, 160)}…</div>
        <div style={{ fontSize: "10px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: syne, marginBottom: "8px" }}>Current context (this seat treats it as ground truth)</div>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder={"Paste what's current — pipeline numbers, open questions, this week's state. The fresher this is, the sharper the seat's takes."}
          style={{ width: "100%", minHeight: "160px", padding: "12px 14px", background: "rgba(255,255,255,0.04)", border: `1px solid ${T.line}`, borderRadius: "10px", fontSize: "12.5px", color: T.ink, resize: "vertical", lineHeight: 1.6 }} />
        <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
          <button onClick={save} style={{ flex: 1, padding: "12px", background: "linear-gradient(135deg, #C8A04A, #8A6420)", border: "none", borderRadius: "10px", color: "#0D1322", fontSize: "12px", fontWeight: 800, cursor: "pointer", fontFamily: syne }}>Save context</button>
          <button onClick={onClose} style={{ padding: "12px 18px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "10px", color: T.sub, fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
