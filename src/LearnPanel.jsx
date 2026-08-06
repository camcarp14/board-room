// ─── Skills — the pipeline that teaches Mini Me, and the prompt it injects ───
// THE LEARN TAB IS GONE. It lived in the Board Room section, which was removed
// from the app's surface; this module kept its 240-line panel component long
// after the only thing that mounted it stopped being reachable, and that page
// has since been deleted too. The panel is deleted with it. Everything below is
// still load-bearing and stays:
//
//   parseLearnCommand(q)  — lets the Room chat treat "/learn <stuff>" as a
//                           learn action instead of a question.
//   learnFromInput(...)   — the whole pipeline (fetch → distill → save),
//                           now driven only by that slash command.
//   buildSkillsBlock(...) — prompt injection, used by src/lib/claude.js; the
//                           mini-worker has a mirrored copy (keep in sync).
//   makeSdb(sb)           — the skills data layer, used by App.jsx.
//   SKILLS_SETUP_SQL      — one-time table + RLS, shown in-app if missing.
//
// Skills still load from the database and still shape both the Chief's prompt
// and the worker's. Only the editor for them is gone.


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
