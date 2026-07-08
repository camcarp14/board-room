// ─── Learn — teach Mini Me skills from URLs and pasted text ──────────────────
// The Learn tab lives in the Board Room section. Paste a URL, an article, a
// process, a prompt that worked — anything — and it gets distilled into a
// compact "skill": title + when-to-use + dense content. Skills are stored in
// Supabase (mini_skills) and injected into (1) the Chief's system prompt in
// the Room chat and (2) the mini-worker's system prompt when it runs the
// queue. Same mechanic as Claude's own skill files: a small index is always
// present; full content is loaded under a character budget, newest first.
//
// Also exports:
//   parseLearnCommand(q)  — lets the Room chat treat "/learn <stuff>" as a
//                           learn action instead of a question.
//   learnFromInput(...)   — the whole pipeline (fetch → distill → save),
//                           shared by the tab and the slash command.
//   buildSkillsBlock(...) — prompt-injection text used by App.jsx; the
//                           worker has a mirrored copy (keep in sync).
//   SKILLS_SETUP_SQL      — one-time table + RLS, shown in-app if missing.
import { useState, useEffect, useMemo, useRef } from "react";
import { T, syne, mono } from "./theme.js";

// Palette tokens come from theme.js (CSS variables — Daylight/Nocturne aware).
// S keeps this panel's plate shapes, pixel-identical to its siblings.
const S = {
  card: { background: T.surface, border: `1px solid ${T.line}`, borderRadius: 14, padding: "20px 22px", boxShadow: "none" },
  cardM: { background: T.surface, border: `1px solid ${T.line}`, borderRadius: 13, padding: "17px 16px", boxShadow: "none" },
  inner: { background: "transparent", border: `1px solid ${T.line}`, borderRadius: 10 },
  title: { fontSize: 11, fontWeight: 600, fontFamily: syne, color: T.ink, letterSpacing: "0.18em", textTransform: "uppercase" },
  microLabel: { fontSize: 9, color: T.faint, fontFamily: mono, letterSpacing: "0.14em", textTransform: "uppercase" },
  brassBtn: { background: T.brass, color: T.onBrass, border: "none", borderRadius: 9, fontWeight: 700, fontFamily: syne, letterSpacing: "0.04em", cursor: "pointer" },
  ghostBtn: { background: "transparent", border: `1px solid ${T.lineStrong}`, borderRadius: 9, color: T.sub, fontWeight: 600, cursor: "pointer" },
  input: { background: T.surface2, border: `1px solid ${T.lineStrong}`, borderRadius: 9, color: T.ink, outline: "none", fontSize: 13, fontFamily: "inherit" },
};

// ─── one-time setup SQL ───────────────────────────────────────────────────────
export const SKILLS_SETUP_SQL = `-- Board Room · Learn — one-time setup
create table if not exists public.mini_skills (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  content text not null default '',
  source_url text,
  source_kind text not null default 'text',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.mini_skills enable row level security;
drop policy if exists "own mini_skills" on public.mini_skills;
create policy "own mini_skills" on public.mini_skills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`;

// ─── small helpers ────────────────────────────────────────────────────────────
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const isMissingTable = (msg) => /does not exist|relation|schema cache|42P01/i.test(msg || "");
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u.slice(0, 30); } };
const approxTokens = (s) => Math.round((s || "").length / 4);
const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function extractUrls(text) {
  const found = (text.match(/https?:\/\/[^\s<>"')\]]+/g) || []).map(u => u.replace(/[.,;:!?]+$/, ""));
  return [...new Set(found)].slice(0, 3); // at most 3 pages per learn — keeps distillation focused
}

// "/learn <anything>" in the Room chat → learn it instead of asking the board.
// Bare "/learn" → { open: true } so the chat can point at the tab.
export function parseLearnCommand(q) {
  const m = /^\/learn\b\s*([\s\S]*)$/i.exec((q || "").trim());
  if (!m) return null;
  const rest = m[1].trim();
  return rest ? { text: rest } : { open: true };
}

// ─── data layer ───────────────────────────────────────────────────────────────
export function makeSdb(sb) {
  return {
    async load() {
      const { data, error } = await sb.from("mini_skills")
        .select("id,title,description,content,source_url,source_kind,enabled,created_at,updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async loadEnabled() {
      const { data, error } = await sb.from("mini_skills")
        .select("title,description,content")
        .eq("enabled", true)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async save(skill) {
      const { data: u } = await sb.auth.getUser();
      const user_id = u?.user?.id;
      if (!user_id) throw new Error("Not signed in");
      const row = { ...skill, user_id, updated_at: new Date().toISOString() };
      const { error } = await sb.from("mini_skills").upsert(row, { onConflict: "id" });
      if (error) throw error;
      return row;
    },
    async remove(id) {
      const { error } = await sb.from("mini_skills").delete().eq("id", id);
      if (error) throw error;
    },
  };
}

// ─── the learn pipeline — fetch pages, distill, save ─────────────────────────
// onPhase(label) is optional progress reporting for the UI.
export async function learnFromInput({ text, supabase, callClaude, modelKey = "haiku", accessToken = "", onPhase = () => {} }) {
  const urls = extractUrls(text);
  const pasted = urls.reduce((t, u) => t.split(u).join(" "), text).trim();

  // 1 — fetch any URLs server-side (CORS + key safety live in the function)
  const pages = [];
  for (const url of urls) {
    onPhase(`Fetching ${hostOf(url)}…`);
    try {
      const res = await fetch("/.netlify/functions/fetch-page", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.text) pages.push({ url, title: data.title || hostOf(url), text: data.text });
      else pages.push({ url, error: data?.error || `fetch failed (${res.status})` });
    } catch {
      pages.push({ url, error: "network error" });
    }
  }
  const fetched = pages.filter(p => p.text);
  const failed = pages.filter(p => p.error);
  if (!pasted && urls.length && !fetched.length) {
    return { error: `Couldn't read ${failed.length > 1 ? "those pages" : "that page"} — ${failed[0].error}. Paste the content in directly and I'll learn from that.` };
  }

  // 2 — distill into a skill
  onPhase("Distilling into a skill…");
  const sourceBlock = [
    ...fetched.map(p => `SOURCE (${p.url}) — "${p.title}":\n${p.text.slice(0, 14000)}`),
    pasted ? `PASTED BY CAMERON:\n${pasted.slice(0, 14000)}` : "",
  ].filter(Boolean).join("\n\n---\n\n");
  const system = `You turn raw material into a reusable SKILL for Cameron's autonomous assistant. A skill is dense, factual, and immediately usable — the distilled capability, not a summary of the source.

Output ONLY a JSON object, no markdown fences, no prose:
{"title": "3-6 words, specific", "description": "one sentence starting with 'Use when' — the trigger for loading this skill", "content": "the skill itself: 120-350 words of plain text. Key facts, steps, numbers, heuristics, gotchas. Use short dash lines for lists. No fluff, no 'this article discusses'. Write it as operating knowledge."}`;
  const raw = await callClaude({ system, messages: [{ role: "user", content: sourceBlock }], modelKey, maxTokens: 900, fn: "learn_skill" });
  if (raw == null) return { error: "Claude call failed — check the API key on Systems → Usage." };
  let parsed = null;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { /* fall through */ }
  if (!parsed?.title || !parsed?.content) return { error: "Couldn't distill that into a skill — try adding a line about what you want learned from it." };

  // 3 — save
  onPhase("Saving…");
  const skill = {
    id: uuid(),
    title: String(parsed.title).slice(0, 80),
    description: String(parsed.description || "").slice(0, 200),
    content: String(parsed.content).slice(0, 6000),
    source_url: fetched[0]?.url || urls[0] || null,
    source_kind: fetched.length && pasted ? "mixed" : fetched.length ? "url" : "text",
    enabled: true,
    created_at: new Date().toISOString(),
  };
  try {
    await makeSdb(supabase).save(skill);
  } catch (e) {
    if (isMissingTable(e.message)) return { error: "missing_table" };
    return { error: e.message || "Couldn't save the skill." };
  }
  return { skill, failedUrls: failed };
}

// ─── prompt injection ─────────────────────────────────────────────────────────
// Index of every enabled skill + full content newest-first under a char
// budget. Mirrored in netlify/functions/mini-worker.js — keep in sync.
export function buildSkillsBlock(skills, budget = 9000) {
  if (!skills?.length) return "";
  const index = skills.map(s => `• ${s.title} — ${s.description}`).join("\n");
  let out = `\n\nLEARNED SKILLS — knowledge Cameron has explicitly taught you. Apply when relevant; cite the skill by name when you lean on one.\nIndex:\n${index}\n`;
  let used = out.length, loaded = 0;
  for (const s of skills) {
    const block = `\n[SKILL: ${s.title}]\n${s.content}\n`;
    if (used + block.length > budget) break;
    out += block; used += block.length; loaded++;
  }
  if (loaded < skills.length) out += `\n(${skills.length - loaded} more skill${skills.length - loaded > 1 ? "s" : ""} known by title only — ask Cameron to trim or disable skills if you need their full content.)`;
  return out;
}

// ─── UI bits ──────────────────────────────────────────────────────────────────
function SetupCard({ isMobile }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ ...(isMobile ? S.cardM : S.card) }}>
      <div style={{ ...S.title, marginBottom: 8 }}>One-time setup</div>
      <div style={{ fontSize: 12, color: T.sub, lineHeight: 1.65, marginBottom: 12 }}>
        The skills table doesn't exist yet. Run this once in Supabase → SQL Editor, then come back — nothing else to configure.
      </div>
      <pre style={{ ...S.inner, padding: "12px 14px", fontSize: 10.5, fontFamily: mono, lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre", color: T.sub, margin: 0 }}>{SKILLS_SETUP_SQL}</pre>
      <button onClick={() => { navigator.clipboard?.writeText(SKILLS_SETUP_SQL); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        style={{ ...S.brassBtn, marginTop: 12, padding: "9px 18px", fontSize: 11.5 }}>{copied ? "Copied ✓" : "Copy SQL"}</button>
    </div>
  );
}

function Toggle({ on, onChange, label }) {
  return (
    <button onClick={onChange} aria-label={label}
      style={{ width: 34, height: 20, borderRadius: 12, border: `1px solid ${on ? T.brass : T.lineStrong}`, background: on ? T.brass : "var(--ink-a06)", position: "relative", cursor: "pointer", flex: "none", padding: 0 }}>
      <span style={{ position: "absolute", top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "var(--on-brass)", boxShadow: "0 1px 2px rgba(0,0,0,0.3)", transition: "left 0.15s ease" }} />
    </button>
  );
}

function SkillCard({ skill, isMobile, onToggle, onSave, onDelete, spotlight }) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef(null);
  useEffect(() => {
    if (!spotlight) return;
    setOpen(true);
    cardRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [spotlight]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const startEdit = () => { setDraft({ title: skill.title, description: skill.description, content: skill.content }); setEditing(true); setOpen(true); };
  const commit = () => { onSave({ ...skill, ...draft }); setEditing(false); };

  return (
    <div ref={cardRef} style={{ ...S.inner, padding: "12px 14px", opacity: skill.enabled ? 1 : 0.55, transition: "opacity 0.15s ease", ...(spotlight ? { borderColor: "var(--brass-a40)" } : {}) }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{ marginTop: 3, width: 8, height: 8, borderRadius: 2, transform: "rotate(45deg)", background: skill.enabled ? T.brass : T.faint, flex: "none" }} />
        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => !editing && setOpen(o => !o)}>
          <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: syne, color: T.ink, lineHeight: 1.35 }}>{skill.title}</div>
          <div style={{ fontSize: 11, color: T.sub, lineHeight: 1.5, marginTop: 2 }}>{skill.description}</div>
          <div style={{ display: "flex", gap: 10, marginTop: 5, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ ...S.microLabel }}>{fmtDate(skill.created_at)} · ~{approxTokens(skill.content)} tok</span>
            {skill.source_url && <a href={skill.source_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: 9.5, fontFamily: mono, color: T.blue, textDecoration: "none", letterSpacing: "0.04em" }}>{hostOf(skill.source_url)} ↗</a>}
            <span style={{ fontSize: 9.5, fontFamily: mono, color: T.faint }}>{open ? "▲" : "▼"}</span>
          </div>
        </div>
        <Toggle on={skill.enabled} onChange={() => onToggle(skill)} label="Toggle skill" />
      </div>

      {open && !editing && (
        <div style={{ marginTop: 10 }}>
          <div style={{ background: "var(--ink-a04)", border: "1px solid var(--ink-a05)", borderRadius: 9, padding: "11px 13px", fontSize: 11.5, color: T.sub, lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 300, overflowY: "auto" }}>{skill.content}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
            <button onClick={startEdit} style={{ ...S.ghostBtn, padding: "7px 14px", fontSize: 10.5 }}>Edit</button>
            <button onClick={() => { if (window.confirm(`Forget "${skill.title}"? This can't be undone.`)) onDelete(skill.id); }}
              style={{ ...S.ghostBtn, padding: "7px 14px", fontSize: 10.5, color: T.red, borderColor: "var(--red-a32)" }}>Forget</button>
          </div>
        </div>
      )}

      {open && editing && draft && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <input value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} style={{ ...S.input, padding: "9px 11px", fontWeight: 700, fontFamily: syne }} />
          <input value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} placeholder="Use when…" style={{ ...S.input, padding: "9px 11px", fontSize: 12 }} />
          <textarea value={draft.content} onChange={e => setDraft(d => ({ ...d, content: e.target.value }))} rows={isMobile ? 9 : 12}
            style={{ ...S.input, padding: "10px 11px", fontSize: 12, lineHeight: 1.65, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={commit} style={{ ...S.brassBtn, padding: "8px 18px", fontSize: 11 }}>Save</button>
            <button onClick={() => setEditing(false)} style={{ ...S.ghostBtn, padding: "8px 14px", fontSize: 11 }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── the tab ──────────────────────────────────────────────────────────────────
export default function LearnPanel({ isMobile, supabase, callClaude, session, modelKey = "haiku", onSkillsChanged, spotlight }) {
  const card = isMobile ? S.cardM : S.card;
  const sdb = useMemo(() => makeSdb(supabase), [supabase]);
  const [skills, setSkills] = useState(null); // null = loading
  const [missingTable, setMissingTable] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState(null);   // string while learning
  const [notice, setNotice] = useState(null); // { ok, text }
  const [query, setQuery] = useState("");

  const refresh = () => {
    sdb.load().then(rows => { setSkills(rows); setMissingTable(false); onSkillsChanged?.(); })
      .catch(e => { if (isMissingTable(e.message)) setMissingTable(true); else setLoadErr(e.message || "Couldn't load skills."); });
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const learn = async () => {
    const t = text.trim();
    if (!t || phase) return;
    setNotice(null);
    setPhase("Starting…");
    const result = await learnFromInput({ text: t, supabase, callClaude, modelKey, accessToken: session?.access_token || "", onPhase: setPhase });
    setPhase(null);
    if (result.error === "missing_table") { setMissingTable(true); return; }
    if (result.error) { setNotice({ ok: false, text: result.error }); return; }
    setText("");
    const skippedNote = result.failedUrls?.length ? ` (couldn't read ${result.failedUrls.map(f => hostOf(f.url)).join(", ")} — learned from the rest)` : "";
    setNotice({ ok: true, text: `Learned "${result.skill.title}"${skippedNote}` });
    refresh();
  };

  const toggleSkill = (s) => {
    const next = { ...s, enabled: !s.enabled };
    setSkills(list => list.map(x => x.id === s.id ? next : x)); // optimistic
    sdb.save(next).then(() => onSkillsChanged?.()).catch(() => refresh());
  };
  const saveSkill = (s) => { sdb.save(s).then(() => refresh()).catch(e => setNotice({ ok: false, text: e.message })); };
  const deleteSkill = (id) => { sdb.remove(id).then(() => refresh()).catch(e => setNotice({ ok: false, text: e.message })); };

  const filtered = useMemo(() => {
    if (!skills) return null;
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(s => `${s.title} ${s.description} ${s.content}`.toLowerCase().includes(q));
  }, [skills, query]);
  const enabledCount = (skills || []).filter(s => s.enabled).length;

  if (missingTable) return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}><SetupCard isMobile={isMobile} /></div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 12 : 14 }}>

      {/* teach it */}
      <div style={{ ...card, background: "var(--brass-a06)", border: "1px solid var(--brass-a20)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 4 }}>
          <span style={S.title}>Teach Mini Me</span>
          <span style={S.microLabel}>also works as /learn in chat</span>
        </div>
        <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.6, marginBottom: 10 }}>
          Drop in a URL, an article, a process, numbers that matter — it gets distilled into a skill and loaded into every chat and queue run.
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") learn(); }}
          placeholder={"https://…  — or paste the thing itself\nAdd a line about what you want learned from it, if it helps."}
          rows={isMobile ? 4 : 3} disabled={!!phase}
          style={{ ...S.input, width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 12.5, lineHeight: 1.6, resize: "vertical", opacity: phase ? 0.6 : 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
          <button onClick={learn} disabled={!!phase || !text.trim()}
            style={{ ...S.brassBtn, padding: "10px 22px", fontSize: 12, opacity: phase || !text.trim() ? 0.55 : 1 }}>
            {phase ? "Learning…" : "Learn it"}
          </button>
          {phase && <span style={{ fontSize: 11, fontFamily: mono, color: T.brass, animation: "pulse 1.4s infinite" }}>{phase}</span>}
          {!phase && notice && <span style={{ fontSize: 11, color: notice.ok ? T.green : T.red, lineHeight: 1.5 }}>{notice.ok ? "◆ " : ""}{notice.text}</span>}
        </div>
      </div>

      {/* the library — "somewhere I can see the skills built" */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <span style={S.title}>Skill library</span>
          <span style={S.microLabel}>{skills ? `${enabledCount} loaded · ${skills.length} total` : " "}</span>
        </div>
        {skills && skills.length > 4 && (
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search skills…"
            style={{ ...S.input, width: "100%", boxSizing: "border-box", padding: "9px 12px", fontSize: 12, marginBottom: 10 }} />
        )}
        {loadErr && <div style={{ fontSize: 11.5, color: T.faint, padding: "18px 0", textAlign: "center" }}>{loadErr}</div>}
        {!loadErr && skills === null && <div style={{ fontSize: 11.5, color: T.faint, padding: "18px 0", textAlign: "center", animation: "pulse 1.4s infinite" }}>Loading skills…</div>}
        {!loadErr && skills && skills.length === 0 && (
          <div style={{ fontSize: 11.5, color: T.faint, padding: "22px 0", textAlign: "center", lineHeight: 1.7 }}>
            Nothing learned yet.<br />Teach it something above — a URL is the fastest start.
          </div>
        )}
        {!loadErr && filtered && filtered.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map(s => <SkillCard key={s.id} skill={s} isMobile={isMobile} onToggle={toggleSkill} onSave={saveSkill} onDelete={deleteSkill} spotlight={spotlight?.id === s.id ? spotlight.t : null} />)}
          </div>
        )}
        {!loadErr && skills && skills.length > 0 && filtered && filtered.length === 0 && (
          <div style={{ fontSize: 11.5, color: T.faint, padding: "16px 0", textAlign: "center" }}>No skills match "{query}".</div>
        )}
      </div>
    </div>
  );
}
