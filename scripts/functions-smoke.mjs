// ─── Function smoke: does every Netlify function still export a handler? ──────
// This repo has a specific, silent, production-only failure mode that has now
// caused an outage three times:
//
//   package.json declares "type":"module", so a .js file under netlify/functions
//   is ESM by Node's rules. esbuild (which is what Netlify bundles with) then
//   treats `module`/`exports` inside a REQUIRED helper as the bundle's own CJS
//   wrapper — so `module.exports = { foo }` in that helper REPLACES the bundle's
//   exports, wiping the `exports.handler` the function assigned. The function
//   deploys successfully, reports no error, and 502s on every call.
//
// Nothing else catches this: the file lints, `vite build` never touches
// functions, and esbuild only emits a WARNING (commonjs-variable-in-esm) that is
// easy to wave off because the entry files trip it harmlessly too. tmdb.js and
// workout-import.js both carry comments about it. It still happened again.
//
// So: bundle every function the way Netlify does, load the output, and assert a
// callable handler survived. ~2s, and it fails loudly.
//
// If this fails, the fix is NOT a cleverer helper — inline what you need into the
// function. Self-contained is the house pattern here, deliberately.

import esbuild from "esbuild";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, basename } from "node:path";

const FN_DIR = "netlify/functions";
const OUT_DIR = ".fn-smoke";
const require_ = createRequire(import.meta.url);

// tweetnacl is a real dependency of discord-board; keep it external so this
// check doesn't depend on bundling third-party trees.
const EXTERNALS = ["tweetnacl"];

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const fns = readdirSync(FN_DIR).filter(f => f.endsWith(".js")).sort();
let pass = 0;
const failures = [];

for (const file of fns) {
  const name = basename(file, ".js");
  const out = resolve(OUT_DIR, `${name}.cjs`);
  try {
    esbuild.buildSync({
      entryPoints: [join(FN_DIR, file)],
      bundle: true, platform: "node", format: "cjs",
      external: EXTERNALS, outfile: out, logLevel: "silent",
    });
  } catch (e) {
    failures.push([name, `did not bundle: ${(e.message || String(e)).split("\n")[0]}`]);
    continue;
  }
  // The assertion that matters. A function with no handler is a 502.
  try {
    const mod = require_(out);
    if (typeof mod.handler === "function" || typeof mod.default === "function") {
      pass++;
      console.log(`ok:   ${name}`);
    } else {
      failures.push([name, `bundled with NO handler — exports are ${JSON.stringify(Object.keys(mod))}. `
        + `A required helper's module.exports has clobbered the bundle's exports; inline it into the function instead.`]);
    }
  } catch (e) {
    failures.push([name, `bundle threw on load: ${e.message}`]);
  }
}

rmSync(OUT_DIR, { recursive: true, force: true });

console.log(`\n${pass}/${fns.length} functions export a callable handler`);
if (failures.length) {
  for (const [name, why] of failures) console.error(`FAIL: ${name}\n      ${why}`);
  console.error("FUNCTION SMOKE FAILED");
  process.exit(1);
}
console.log("FUNCTION SMOKE PASS");
