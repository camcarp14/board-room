// Proposes and (only on explicit approval) commits fixes to a site's GitHub
// repo. "propose" only reads and drafts — it never writes anything. Nothing
// reaches your repo until the user clicks Approve, which calls "commit"
// separately and explicitly.
//
// Scoped deliberately to what's reliably fixable without real codebase
// search: the site's static template files (index.html, robots.txt,
// sitemap.xml, manifest). These are exactly where most SEO/technical
// findings actually live for a Vite/React SPA — page content rendered by
// JS components isn't in scope here, since finding the right source file
// for that needs real code search, not a fetch-and-guess.
//
// Commits go through GitHub's normal API, so they trigger the repo's
// connected Netlify build like any other push, and are fully reversible
// with a normal git revert.
// Needs: ANTHROPIC_API_KEY, GITHUB_TOKEN (must have write access to the
// target repos — a fine-grained token needs "Contents: read and write").
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const GH = "https://api.github.com";
const CANDIDATE_FILES = ["index.html", "public/index.html", "robots.txt", "public/robots.txt", "sitemap.xml", "public/sitemap.xml", "manifest.json", "public/manifest.json", "site.webmanifest", "public/site.webmanifest"];

async function ghGet(repo, path, token) {
  const res = await fetch(`${GH}/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "board-room-auditor", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null; // 404 here can mean "doesn't exist" OR "token can't see this repo" — GitHub deliberately conflates these
  const data = await res.json();
  if (data.encoding !== "base64" || !data.content) return null;
  return { path: data.path, sha: data.sha, content: Buffer.from(data.content, "base64").toString("utf8") };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  const configured = !!(anthropicKey && githubToken);

  if (body.ping) return json(200, { success: true, service: "auto-fix", configured, missing: configured ? undefined : "ANTHROPIC_API_KEY / GITHUB_TOKEN" });
  if (!configured) return json(500, { error: "auto-fix env vars not set" });
  if (!body.repo) return json(400, { error: "repo is required" });

  try {
    if (body.action === "commit") {
      if (!body.path || body.content === undefined) return json(400, { error: "path and content are required to commit" });
      const current = await ghGet(body.repo, body.path, githubToken);
      const putRes = await fetch(`${GH}/repos/${body.repo}/contents/${body.path}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "board-room-auditor", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({
          message: body.message || `Fix via Board Room auditor: ${body.path}`,
          content: Buffer.from(body.content, "utf8").toString("base64"),
          sha: current?.sha, // omit when the file doesn't exist yet — GitHub creates it
        }),
      });
      const put = await putRes.json();
      if (!putRes.ok) return json(putRes.status, { error: put.message || "commit failed — check GITHUB_TOKEN has write access to this repo" });
      return json(200, { success: true, repo: body.repo, path: body.path, commit: put.commit?.sha, message: `committed to ${body.repo} — Netlify will build and deploy it like any other push` });
    }

    // action: "propose" (default) — read-only, drafts a fix, commits nothing
    if (!body.instruction) return json(400, { error: "instruction is required" });
    const found = [];
    for (const p of CANDIDATE_FILES) {
      const f = await ghGet(body.repo, p, githubToken);
      if (f && !found.some(x => x.path === f.path)) found.push(f);
    }
    if (!found.length) return json(200, { success: false, error: `couldn't read any static template files from ${body.repo} — either GITHUB_TOKEN doesn't have access to this repo, or the fix needs a source-code change this tool can't make yet` });

    const filesBlock = found.map(f => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const system = `You edit static web files for a solo founder's site. Given an instruction and the current content of candidate files from the repo, decide which ONE file should change to satisfy it. Respond ONLY with JSON: {"path":"<one of the given paths, exactly>","content":"<the COMPLETE corrected file content>","note":"one sentence on what changed"}. If the instruction can't be satisfied by editing one of these static files (e.g. it needs a change to page content rendered by application code), respond {"path":null,"note":"one sentence explaining why not"}. No markdown, no prose outside the JSON.`;
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 4000, system, messages: [{ role: "user", content: `Instruction: ${body.instruction}\n\nCandidate files:\n${filesBlock}` }] }),
    });
    const aiData = await aiRes.json();
    const text = (aiData.content || []).map(b => b.type === "text" ? b.text : "").join("");
    let parsed = null;
    try { parsed = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch {}
    if (!parsed?.path) return json(200, { success: false, error: parsed?.note || "couldn't determine a static-file fix for this — it may need a source-code change" });

    const original = found.find(f => f.path === parsed.path);
    if (!original) return json(200, { success: false, error: "model picked a file that wasn't in the candidate set — try rephrasing" });
    return json(200, { success: true, path: parsed.path, before: original.content, after: parsed.content, note: parsed.note || "" });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
