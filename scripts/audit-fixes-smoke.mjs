// The 2026-09-28 audit's smaller fixes, each pinned where it lives.
//
// Every item here was confirmed against production (usage_log, the live bundle,
// the shared Supabase project) or by reading the whole code path, and each is the
// kind of one-line guard a later edit removes without noticing. The CSV re-import
// is RUN against a stubbed client; the rest are text pins, the house default for
// wiring that has no behaviour to exercise offline.
import { build } from "esbuild";
import path from "node:path";
import { readFile, rm as rmFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`ok: ${name}`);
  else { failures++; console.log(`FAIL: ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); }
};
const read = (p) => readFile(p, "utf8");

// ── 1. a CSV re-import leaves your category corrections alone (RUN) ──────────
{
  const stub = `
    export const ANTHROPIC_API_KEY = "";
    export const supabase = {
      auth: { getSession: async () => ({ data: { session: { user: { id: "smoke-user" } } } }) },
      from: (t) => ({ upsert: async (rows, opts) => { globalThis.__tx.push({ t, rows, opts }); return { error: null }; } }),
      rpc: async () => ({ data: null, error: null }),
    };
  `;
  const out = path.resolve(".audit-fixes-smoke.tmp.mjs");
  await build({
    entryPoints: ["src/data/db.js"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error",
    plugins: [{ name: "stub", setup(b) {
      b.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "s", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }));
    } }],
  });
  let db;
  try { ({ db } = await import(pathToFileURL(out).href)); } finally { await rmFile(out, { force: true }); }
  globalThis.__tx = [];
  const parsed = [
    { id: "a", account: "card", date: "2026-09-01", amount: -1200, description: "TRADER JOES", category: "groceries" },
    { id: "b", account: "card", date: "2026-09-02", amount: -800, description: "SHELL", category: "gas" },
  ];
  await db.saveTransactions(parsed);
  const sent = globalThis.__tx.flatMap((c) => c.rows);
  check("a parsed CSV row never sends category_override, so a re-import cannot null a correction",
    sent.length === 2 && sent.every((r) => !("category_override" in r)));
  globalThis.__tx = [];
  await db.saveTransactions([...parsed, { ...parsed[0], id: "c", category_override: "dining" }]);
  check("rows that DO carry an override go out in their own batch",
    globalThis.__tx.length === 2 && globalThis.__tx.every((c) => c.rows.every((r) => ("category_override" in r) === ("category_override" in c.rows[0]))));
}

const [functions, wire, briefPage, upstream, trmnl, clarify, zts, kit, main, db, app, boot] = await Promise.all([
  read("src/lib/functions.js"), read("netlify/functions/wire.js"), read("src/pages/brief/BriefPage.jsx"),
  read("src/pages/upstream/UpstreamPage.jsx"), read("netlify/functions/trmnl.js"),
  read("netlify/functions/clarify-pipeline.js"), read("netlify/functions/zts-pipeline.js"),
  read("src/ui/kit.jsx"), read("src/main.jsx"), read("src/data/db.js"), read("src/App.jsx"), read("src/shell/Boot.jsx"),
]);

// ── 2. a background function's 202 is a success ──────────────────────────────
// Production usage_log: econ-resolve-background, 16 calls, 16 "network error" —
// every one of them a run that had worked. res.json() on Netlify's empty 202.
check("callFn answers a 202 before it tries to parse a body",
  functions.indexOf("if (res.status === 202)") > 0 && functions.indexOf("if (res.status === 202)") < functions.indexOf("const data = await res.json();"));

// ── 3. links from feeds and models are http(s) or nothing ────────────────────
check("the Wire keeps an RSS link only if it is http(s)", /const link = \/\^https\?:\\\/\\\/\/i\.test\(/.test(wire));
check("…and the Brief draws no <a> at all for a dropped link", /\{w\.link \? \(\s*\n\s*<a className="wire-open" href=\{w\.link\}/.test(briefPage));
check("Upstream's SourceLink renders a non-http(s) URL as text", /function SourceLink\([\s\S]{0,300}\^https\?:/.test(upstream));

// ── 4. the TRMNL feed ────────────────────────────────────────────────────────
check("the TRMNL token is compared in constant time", /timingSafeEqual\(a, b\)/.test(trmnl) && !/token !== process\.env\.TRMNL_TOKEN/.test(trmnl));
check("…personal data is never cached as public", !/"Cache-Control": "public/.test(trmnl) && /"Cache-Control": "private, max-age=300"/.test(trmnl));
check("…and the reader is scoped to the owner even with no TRMNL_USER_ID", /process\.env\.BOARD_USER_ID/.test(trmnl.slice(trmnl.indexOf("const userId ="), trmnl.indexOf("const userId =") + 200)));

// ── 5. the Pentagon pipeline cards read with a key the tables admit ──────────
// Production: clarify-pipeline 349/349 failed (anon key, 401); zts-pipeline read
// zts.creators with the anon key, which RLS answers with zero rows, always.
for (const [name, src] of [["clarify-pipeline", clarify], ["zts-pipeline", zts]]) {
  check(`${name} falls back to Board Room's own service key on the same project`,
    /const sameProject = /.test(src) && /sameProject\(url, process\.env\.SUPABASE_URL\) \? process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(src));
}
check("clarify-pipeline pins the schema outreach lives in", /"Accept-Profile": "public"/.test(clarify));
check("zts-pipeline scopes a service-key read back to the owner", /user_id=eq\.\$\{encodeURIComponent\(owner\)\}/.test(zts));

// ── 6. a sheet does not steal focus from its own field ───────────────────────
check("Sheet leaves focus where autoFocus put it",
  /if \(dialog\.contains\(document\.activeElement\) && document\.activeElement !== dialog\) return;/.test(kit));

// ── 7. a new service worker waits for you to stop typing ─────────────────────
check("controllerchange reloads through the typing guard",
  /addEventListener\("controllerchange", \(\) => \{\s*\n\s*if \(reloaded \|\| !hadController\) return;\s*\n\s*reloadWhenIdle\(\);/.test(main));

// ── 8. identity for a write is the local session, not a round trip ──────────
check("db.uid() reads the session, not GET /auth/v1/user",
  /async uid\(\) \{\s*\n\s*const \{ data \} = await supabase\.auth\.getSession\(\);/.test(db));

// ── 9. sign-out on a dead link still tells the truth on the login screen ─────
check("the offline sign-out notice is set by App and read once by the login screen",
  /br_signout_offline/.test(app) && /sessionStorage\.removeItem\("br_signout_offline"\)/.test(boot));

if (failures) { console.log(`\n${failures} FAILURE(S)\nAUDIT FIXES SMOKE FAILED`); process.exit(1); }
console.log("\nAUDIT FIXES SMOKE PASS");
