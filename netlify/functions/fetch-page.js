// Fetches a public web page server-side for the Learn tab (browser CORS makes
// this impossible client-side). Returns { title, text } with tags stripped.
// Guards: http(s) only, no private/loopback hosts, 10s timeout, 1.5MB cap.
// Auth mirrors mini-worker: requires the user's Supabase session token when
// the service key is configured; degrades to open in local dev without it.
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Also catches hex (0x7f...), octal (0177...), bare-integer, and IPv6-mapped
// (::ffff:127.0.0.1) spellings of private/loopback addresses. Keep in sync
// with the inlined copies in audit.js / calendar-events.js (inlined, not
// shared — see tmdb.js's esbuild/exports landmine comment).
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|0x[0-9a-f]+$|0\d+\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.|::ffff:169\.254\.)/i;

function badUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return "that's not a valid URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) URLs";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOST.test(host) || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") || /^\d+$/.test(host)) return "that host isn't reachable from here";
  return null;
}

// fetch that follows redirects MANUALLY, re-validating every hop against
// badUrl — `redirect: "follow"` would happily follow a public URL that 302s
// to 169.254.169.254 (cloud metadata) or an internal host.
async function fetchGuarded(url, opts, maxHops = 5) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(current, { ...opts, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      const next = new URL(loc, current).href;
      if (badUrl(next)) throw new Error("redirected to a host that isn't reachable from here");
      current = next;
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

// Cheap but effective HTML → text: drop non-content blocks, prefer
// <article>/<main> when present, strip tags, decode common entities.
function extractText(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const article = /<article[\s\S]*?<\/article>/i.exec(h) || /<main[\s\S]*?<\/main>/i.exec(h);
  if (article && article[0].length > 800) h = article[0];
  const text = h
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
  return text;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "invalid JSON" }); }

  if (body.ping) return json(200, { success: true, service: "fetch-page", configured: true });

  // Same auth posture as mini-worker, but fail-closed: this endpoint fetches
  // arbitrary URLs server-side, so if the verification pair isn't configured
  // it refuses rather than running open on a public domain.
  const supaUrl = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !service) return json(500, { error: "auth backend not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });
  {
    const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "sign in first" });
    const res = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!res.ok) return json(401, { error: "session expired — refresh and try again" });
    const owner = process.env.OWNER_USER_ID;
    if (owner) {
      const u = await res.json().catch(() => null);
      if (u?.id !== owner) return json(403, { error: "this deployment is single-user" });
    }
  }

  const url = String(body.url || "").trim();
  const problem = badUrl(url);
  if (problem) return json(400, { error: problem });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchGuarded(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BoardRoomLearn/1.0)", Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
    });
    clearTimeout(timer);
    if (!res.ok) return json(502, { error: `page returned ${res.status}` });
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (!/text\/html|text\/plain|application\/xhtml/.test(ctype)) return json(415, { error: `that's ${ctype.split(";")[0] || "not a page"} — paste the content in directly instead` });

    // stream with a hard byte cap so a huge page can't blow the function
    const reader = res.body.getReader();
    const chunks = []; let bytes = 0;
    while (bytes < 1500000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); bytes += value.length;
    }
    try { await reader.cancel(); } catch { /* already done */ }
    const html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");

    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const text = ctype.includes("text/plain") ? html.trim() : extractText(html);
    if (!text || text.length < 80) return json(422, { error: "couldn't pull readable text from that page — paste the content in directly instead" });
    return json(200, { title, text: text.slice(0, 16000), truncated: text.length > 16000 });
  } catch (e) {
    clearTimeout(timer);
    return json(504, { error: e.name === "AbortError" ? "page took too long to respond" : `couldn't reach that page: ${e.message}` });
  }
};
