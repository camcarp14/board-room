// ─── The one check that builds the app twice, and is worth it ────────────────
//
// This repo is a PUBLIC GitHub repository deployed to a PUBLIC URL. Everything
// under src/ is served to anyone who opens the site, so a secret that reaches a
// chunk is not "exposed to attackers" in the abstract — it is published.
//
// src/lib/claude.js states the protection and states it correctly:
//
//     "Gate on DEV (compile-time constant) rather than hostname: production
//      builds always use the server proxy, which lets esbuild dead-code-eliminate
//      the direct branch — so VITE_ANTHROPIC_API_KEY is never inlined into the
//      shipped bundle."
//
// That was the intent. It was not what the build did, and the gap was invisible
// from every angle a reader has:
//
//   · Reading the source, the DEV gate is right there and looks sufficient.
//   · Reading a normal `npm run build`, the key genuinely is absent.
//   · Reading the deploy, Netlify's secret scan reports zero matches.
//
// All three of those were true while nothing structural was doing the work.
// src/lib/supabase.js exports the raw value at module scope, and
// src/pages/systems/connections.js reads it behind a RUNTIME hostname check —
// the exact alternative claude.js's comment warns against — so the reference is
// live code and Vite inlines the literal into the graph. What kept it out of the
// output was that the surviving read sits under a `!`, and esbuild's MINIFIER
// folds `!"non-empty"` to false and drops the string. Rollup's own DCE does not:
// `const isDeployed = true` leaves the ternary standing. Build the same tree with
// --minify false and the entry chunk contains, in plain text:
//
//     const ANTHROPIC_API_KEY = "sk-ant-…";
//
// So the guarantee rested on a minifier optimisation plus the accident that every
// consumer happened to use the value in boolean position. Either of those can
// change without anyone touching claude.js or its comment: turn minification off
// to debug a stack trace, or add one consumer that reads the value as a string.
//
// The fix is a define in vite.config.js, applied at build only, which substitutes
// the variable before a literal can be emitted. THIS FILE IS WHY THAT FIX CAN BE
// TRUSTED. A define is one line in a config that nobody reads twice; asserting it
// exists would be asserting the same kind of thing that was already believed.
// Instead this builds the real app with a canary in the environment and reads the
// bytes — and builds it UNMINIFIED, because minified is the configuration that
// was already passing while the hazard was live.
//
// ~4s, once, on a suite that gates the deploy. That is the correct price.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

// Distinctive enough that it cannot collide with anything the app legitimately
// contains, and shaped like the real thing so the test exercises the real path.
const CANARY = "sk-ant-canary-DO-NOT-SHIP-9f8e7d6c5b4a3210";
const OUT = ".key-exposure-smoke.tmp";

const readChunks = () => {
  const dir = join(OUT, "assets");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js") || f.endsWith(".css"))
    .map((f) => ({ name: f, body: readFileSync(join(dir, f), "utf8") }));
};

try {
  // --minify false ON PURPOSE. The minified build was passing this test for its
  // whole life while the literal was still being emitted into the module graph;
  // asserting the configuration that already looked clean would reproduce exactly
  // the blind spot this file exists to close.
  execFileSync("npx", ["vite", "build", "--minify", "false", "--outDir", OUT, "--emptyOutDir"], {
    stdio: "pipe",
    env: { ...process.env, VITE_ANTHROPIC_API_KEY: CANARY },
  });

  const chunks = readChunks();
  check("the canary build produced chunks to read", chunks.length > 0, `${chunks.length} files`);

  const leaked = chunks.filter((c) => c.body.includes(CANARY)).map((c) => c.name);
  check("a key in the build environment never reaches a shipped chunk", leaked.length === 0,
    `LEAKED IN: ${leaked.join(", ")} — vite.config.js's build-only define for VITE_ANTHROPIC_API_KEY is not doing its job.`);

  // The binding must still EXIST and be empty rather than vanish, because
  // src/pages/systems/connections.js reads it to decide whether local dev has a
  // key. A build where the name disappeared would mean the define had turned into
  // something else and this test had stopped describing the real module.
  const entry = chunks.find((c) => /ANTHROPIC_API_KEY\s*=/.test(c.body));
  check("…and the binding is still there, holding an empty string",
    !!entry && /ANTHROPIC_API_KEY\s*=\s*""/.test(entry.body),
    entry ? (entry.body.match(/ANTHROPIC_API_KEY\s*=\s*[^;,\n]{0,40}/) || [])[0] : "no binding found at all");

  // The direct-to-Anthropic path is a dev-only affordance. Its presence in a
  // shipped chunk would not leak the key by itself now, but it is the branch the
  // key was for — and a browser calling api.anthropic.com with no key is a
  // failure mode nobody should be able to reach from production.
  const direct = chunks.filter((c) => /x-api-key|anthropic-dangerous-direct-browser-access/.test(c.body)).map((c) => c.name);
  check("the direct-from-browser API path is not shipped", direct.length === 0, direct.join(", "));

  // The other two VITE_ vars are PUBLISHABLE and must keep working — the anon key
  // is designed to ship and RLS is what protects the data. Asserting they survive
  // stops a future "just strip every VITE_ var" from quietly breaking auth.
  const supa = chunks.some((c) => /createClient\(/.test(c.body));
  check("the Supabase client is still built (anon key is publishable by design)", supa);

  // The step before the build. Everything above is about a value reaching a
  // chunk; this is about the file reaching the repo, which on a public remote is
  // the same exposure arriving earlier and more permanently — git history keeps
  // it after the deploy is rolled back. .gitignore denies every .env by default
  // and names the two that are deliberately tracked, so a variant nobody has
  // thought of yet (.env.production and .env.development are both loaded by Vite
  // and were both committable) is covered the day it is created.
  const ignore = readFileSync(".gitignore", "utf8");
  check("every .env variant is ignored by default", /^\.env\*$/m.test(ignore));
  for (const keep of [".env.preview", ".env.miner.example"]) {
    check(`…with ${keep} deliberately exempted`, new RegExp(`^!${keep.replace(/\./g, "\\.")}$`, "m").test(ignore));
  }
} finally {
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${failed ? `${failed} FAILURE(S)` : "KEY EXPOSURE SMOKE: ALL CLEAN"}`);
if (failed) { console.error("KEY EXPOSURE SMOKE FAILED"); process.exit(1); }
