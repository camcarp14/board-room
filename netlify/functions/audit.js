// Site + code auditor. Fetches a property's live site (server-side, avoids CORS)
// and, if a repo is known and GITHUB_TOKEN is set, pulls its README + package.json
// for light code-context review. One Claude call turns it into concrete findings.
// Env: ANTHROPIC_API_KEY (required), GITHUB_TOKEN (optional, unlocks repo context).
export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const { name, url, repo } = await req.json();
  const { ANTHROPIC_API_KEY, GITHUB_TOKEN } = process.env;
  if (!ANTHROPIC_API_KEY) return Response.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 500 });

  let siteText = "(no public URL to check)";
  if (url) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (BoardRoomAuditor)" } });
      const html = await res.text();
      siteText = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
    } catch (e) { siteText = `(could not fetch site: ${e.message})`; }
  }

  let repoText = "";
  if (repo && GITHUB_TOKEN) {
    try {
      const readmeRes = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.raw" } });
      const readme = readmeRes.ok ? await readmeRes.text() : "";
      const pkgRes = await fetch(`https://raw.githubusercontent.com/${repo}/main/package.json`);
      const pkg = pkgRes.ok ? await pkgRes.text() : "";
      repoText = `README (truncated):\n${readme.slice(0, 1500)}\n\npackage.json:\n${pkg.slice(0, 800)}`;
    } catch (e) { repoText = `(could not fetch repo: ${e.message})`; }
  } else if (repo) {
    repoText = "(repo known but GITHUB_TOKEN not set — code-level review skipped, site-only review below)";
  }

  const system = `You are a sharp, senior product + growth + code reviewer auditing one of Cameron's live business tools. Be specific and concrete — no generic advice. Look for: conversion or UX issues on the live page, obvious risks or gaps if repo context is present, and the single highest-leverage improvement. Respond ONLY with valid JSON, no preamble: {"findings":[{"severity":"high|medium|low","area":"short label","finding":"what you noticed","suggestion":"the concrete fix"}]} Max 5 findings, fewer is fine if there's little to flag.`;
  const userMsg = `Property: ${name}\nURL: ${url || "none"}\n\nSite content (HTML stripped):\n${siteText}\n\n${repoText}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 900, system, messages: [{ role: "user", content: userMsg }] }),
    });
    const data = await res.json();
    const text = data.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
    let parsed;
    try { parsed = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch { parsed = { findings: [] }; }
    return Response.json({ success: true, findings: parsed.findings || [], hadRepoContext: !!(repo && GITHUB_TOKEN) });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
};
