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
import { Card, CellGroup, SectionHeader, Button, Field, TextArea, Switch, Spinner, EmptyState, Dot, useConfirm, IcCheck } from "./ui/kit.jsx";
import { IcBook, IcExternal, IcChevronDown, IcChevronRight } from "./ui/icons.jsx";

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
// Reset that lets a <button> wear the kit's .cell-body anatomy (rows keep a
// separate Switch, so the whole cell can't be one <button> itself).
const rowBtn = { background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", alignSelf: "stretch", justifyContent: "center" };
// Cross-nav affordance → jumps to the neural canvas focused on this skill's neuron.
// Typography comes from .t-cap; this only resets the button chrome + sets the link tone.
const jumpLink = { background: "none", border: 0, margin: 0, padding: "10px 2px", color: "var(--blue)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3 };
const sqlPre = { background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", fontSize: 11, fontFamily: "var(--font-mono)", lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre", color: "var(--sub)", margin: 0 };

function SetupCard({ isMobile }) {
  const [copied, setCopied] = useState(false);
  return (
    <Card pad={isMobile ? "md" : "lg"} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="t-head">One-time setup</span>
      <span className="t-foot" style={{ lineHeight: 1.6 }}>
        The skills table doesn't exist yet. Run this once in Supabase → SQL Editor, then come back — nothing else to configure.
      </span>
      <pre style={sqlPre}>{SKILLS_SETUP_SQL}</pre>
      <div style={{ marginTop: 2 }}>
        <Button kind="primary" size="md" onClick={() => { navigator.clipboard?.writeText(SKILLS_SETUP_SQL); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
          {copied ? <><IcCheck size={15} /> Copied</> : "Copy SQL"}
        </Button>
      </div>
    </Card>
  );
}

function SkillCard({ skill, isMobile, onToggle, onSave, onDelete, onJump, spotlight, first }) {
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
    <div ref={cardRef} style={{ opacity: skill.enabled ? 1 : 0.55, transition: "opacity var(--dur-1) ease", boxShadow: spotlight ? "inset 0 0 0 1.5px var(--accent)" : "none" }}>
      {/* CellGroup separators key off .cell adjacency; the expander breaks it, so rows draw their own */}
      {!first && <div aria-hidden style={{ height: 0.5, background: "var(--line)", marginLeft: 16 }} />}
      <div className="cell" style={{ paddingRight: 12, minHeight: 56 }}>
        <button className="cell-body" onClick={() => !editing && setOpen(o => !o)} aria-expanded={open} style={rowBtn}>
          <span className="cell-title">{skill.title}</span>
          {skill.description && <span className="cell-sub">{skill.description}</span>}
          <span className="t-num" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 1 }}>{fmtDate(skill.created_at)} · ~{approxTokens(skill.content)} tok</span>
        </button>
        <span className="cell-chevron" aria-hidden style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)", marginRight: 0 }}>
          <IcChevronDown size={13} />
        </span>
        <Switch on={skill.enabled} onToggle={() => onToggle(skill)} aria-label={`Toggle skill: ${skill.title}`} />
      </div>

      <div className={`expand${open ? " open" : ""}`}>
        <div>
          <div style={{ padding: "0 16px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {!editing ? (
              <>
                <div className="t-call" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", color: "var(--sub)", lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "break-word" }}>{skill.content}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <Button kind="quiet" size="sm" onClick={startEdit} style={{ height: 38 }}>Edit</Button>
                  {onJump && (
                    <button type="button" className="t-cap" style={jumpLink}
                      onClick={e => { e.stopPropagation(); onJump({ page: "boardroom", sub: "neural", skillId: skill.id }); }}
                      title="See this skill's neuron on the canvas">
                      in Neurons <IcChevronRight size={12} />
                    </button>
                  )}
                  {skill.source_url && (
                    <a href={skill.source_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                      className="t-cap" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--blue)", textDecoration: "none", padding: "10px 2px" }}>
                      {hostOf(skill.source_url)} <IcExternal size={11} />
                    </a>
                  )}
                  <Button kind="danger" size="sm" onClick={() => onDelete(skill)} style={{ height: 38, marginLeft: "auto" }}>Forget</Button>
                </div>
              </>
            ) : draft && (
              <>
                <Field value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} aria-label="Skill title" style={{ fontWeight: 600 }} />
                <Field value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} placeholder="Use when…" aria-label="When to use it" />
                <TextArea value={draft.content} onChange={e => setDraft(d => ({ ...d, content: e.target.value }))} rows={isMobile ? 9 : 12} aria-label="Skill content"
                  style={{ lineHeight: 1.6, resize: "vertical" }} />
                <div style={{ display: "flex", gap: 10 }}>
                  <Button kind="primary" size="md" onClick={commit}>Save</Button>
                  <Button kind="quiet" size="md" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── the tab ──────────────────────────────────────────────────────────────────
export default function LearnPanel({ isMobile, supabase, callClaude, session, modelKey = "haiku", onSkillsChanged, onJump, spotlight }) {
  const sdb = useMemo(() => makeSdb(supabase), [supabase]);
  const [skills, setSkills] = useState(null); // null = loading
  const [missingTable, setMissingTable] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState(null);   // string while learning
  const [notice, setNotice] = useState(null); // { ok, text }
  const [query, setQuery] = useState("");
  const [confirmEl, confirm] = useConfirm();

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
    setNotice({ ok: true, text: `Learned "${result.skill.title}" — it's now a neuron${skippedNote}`, skillId: result.skill.id });
    refresh();
  };

  const toggleSkill = (s) => {
    const next = { ...s, enabled: !s.enabled };
    setSkills(list => list.map(x => x.id === s.id ? next : x)); // optimistic
    sdb.save(next).then(() => onSkillsChanged?.()).catch(() => refresh());
  };
  const saveSkill = (s) => { sdb.save(s).then(() => refresh()).catch(e => setNotice({ ok: false, text: e.message })); };
  const deleteSkill = async (skill) => {
    if (!(await confirm({ title: `Forget "${skill.title}"?`, message: "This can't be undone.", confirmLabel: "Forget", destructive: true }))) return;
    sdb.remove(skill.id).then(() => refresh()).catch(e => setNotice({ ok: false, text: e.message }));
  };
  const retryLoad = () => { setLoadErr(null); setSkills(null); refresh(); };

  const filtered = useMemo(() => {
    if (!skills) return null;
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(s => `${s.title} ${s.description} ${s.content}`.toLowerCase().includes(q));
  }, [skills, query]);
  const enabledCount = (skills || []).filter(s => s.enabled).length;

  if (missingTable) return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}><SetupCard isMobile={isMobile} /></div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 12 : 14, minWidth: 0 }}>

      {/* teach it */}
      <Card pad={isMobile ? "md" : "lg"} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <span className="t-head">Teach your mind</span>
          <span className="t-cap" style={{ color: "var(--faint)" }}>Also works as /learn in chat</span>
        </div>
        <span className="t-foot" style={{ lineHeight: 1.6 }}>
          Drop in a URL, an article, a process, numbers that matter — it's distilled into a skill. Every skill becomes a neuron and feeds the delegate.
        </span>
        <TextArea value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") learn(); }}
          placeholder={"https://…  — or paste the thing itself\nAdd a line about what you want learned from it, if it helps."}
          rows={isMobile ? 4 : 3} disabled={!!phase}
          style={{ lineHeight: 1.6, resize: "vertical", opacity: phase ? 0.6 : 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Button kind="primary" size="md" onClick={learn} disabled={!!phase || !text.trim()}>
            {phase ? "Learning…" : "Learn it"}
          </Button>
          {phase && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Spinner size={14} />
              <span className="t-cap" style={{ color: "var(--accent)", animation: "pulse 1.4s infinite" }}>{phase}</span>
            </span>
          )}
          {!phase && notice && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0, flexWrap: "wrap" }}>
              <Dot tone={notice.ok ? "var(--green)" : "var(--red)"} size={6} />
              <span className="t-foot" style={{ color: notice.ok ? "var(--green)" : "var(--red)", lineHeight: 1.5 }}>{notice.text}</span>
              {notice.ok && notice.skillId && onJump && (
                <button type="button" className="t-cap" style={{ ...jumpLink, padding: "2px 2px" }}
                  onClick={() => onJump({ page: "boardroom", sub: "neural", skillId: notice.skillId })}>
                  See in Neurons <IcChevronRight size={12} />
                </button>
              )}
            </span>
          )}
        </div>
      </Card>

      {/* the library — "somewhere I can see the skills built" */}
      <div>
        <SectionHeader title="Skill library" trailing={skills ? `${enabledCount} loaded · ${skills.length} total` : undefined} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {skills && skills.length > 4 && (
            <Field className="on-well" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search skills…" aria-label="Search skills" />
          )}
          {loadErr && (
            <Card pad="md">
              <EmptyState icon={<IcBook size={24} />} title="Couldn't load skills" sub={loadErr}
                action={<Button kind="quiet" size="md" onClick={retryLoad}>Retry</Button>} />
            </Card>
          )}
          {!loadErr && skills === null && (
            <Card pad="md">
              <div className="sk sk-line w60" /><div className="sk sk-line w80" style={{ marginBottom: 0 }} />
            </Card>
          )}
          {!loadErr && skills && skills.length === 0 && (
            <Card pad="md">
              <EmptyState icon={<IcBook size={24} />} title="Nothing learned yet" sub="Teach it something above — a URL is the fastest start." />
            </Card>
          )}
          {!loadErr && filtered && filtered.length > 0 && (
            <CellGroup>
              {filtered.map((s, i) => (
                <SkillCard key={s.id} skill={s} isMobile={isMobile} first={i === 0}
                  onToggle={toggleSkill} onSave={saveSkill} onDelete={deleteSkill} onJump={onJump}
                  spotlight={spotlight?.id === s.id ? spotlight.t : null} />
              ))}
            </CellGroup>
          )}
          {!loadErr && skills && skills.length > 0 && filtered && filtered.length === 0 && (
            <Card pad="md">
              <EmptyState title="No matches" sub={`No skills match "${query}".`} />
            </Card>
          )}
        </div>
      </div>
      {confirmEl}
    </div>
  );
}
