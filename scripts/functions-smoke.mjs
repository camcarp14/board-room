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

// ─── extra assertions on pure helpers a function exports for testing ─────────
// Netlify only reads `handler`, so a function may export a pure helper purely so
// it can be asserted here. Keep these to logic that would otherwise be
// untestable — anything richer belongs in src/ with its own smoke.
const EXTRA = {
  "mini-worker": (mod) => {
    const m = mod.mergeTasks;
    if (typeof m !== "function") return [["mini-worker exports mergeTasks", false, "not exported"]];
    const A = { id: "a", status: "delivered", output: "done" };   // ours, finished this run
    const B = { id: "b", status: "queued" };                      // ours, untouched
    const C = { id: "c", status: "queued" };                      // queued by the CLIENT mid-run
    return [
      // the bug this fixes: a task the client queued during a run must survive our write
      ["mergeTasks keeps a task queued mid-run", m([A, B], [C, { ...A, status: "queued" }, B]).some(t => t.id === "c")],
      ["mergeTasks lets our version win for ids we touched",
        m([A, B], [C, { ...A, status: "queued", output: null }, B]).find(t => t.id === "a")?.output === "done"],
      ["mergeTasks preserves live order (client prepends, so new stays on top)",
        m([A, B], [C, A, B]).map(t => t.id).join() === "c,a,b"],
      ["mergeTasks appends ours when the live row hasn't seen it",
        m([A, B], [A]).map(t => t.id).join() === "a,b"],
      ["mergeTasks falls back to ours when live is absent/garbage",
        m([A, B], null).length === 2 && m([A, B], "nope").length === 2],
      ["mergeTasks tolerates empty/idless input",
        m([], []).length === 0 && m(null, null).length === 0 && m([{ status: "queued" }], []).length === 0],
    ];
  },
  // btc-reserve reads three providers whose payload shapes have nothing in
  // common, and none of them can be reached from a test run — so the parser is
  // the only part that CAN be checked here, and it's the part most likely to
  // silently return [] after a provider tweaks a key name.
  "btc-reserve": (mod) => {
    const n = mod.normalizeSeries;
    if (typeof n !== "function") return [["btc-reserve exports normalizeSeries", false, "not exported"]];
    const DAY = 86400000;
    const cq = { status: { code: 200 }, result: { window: "day", data: [ // CryptoQuant: newest first, date strings
      { date: "2026-07-03", reserve: 2400300, reserve_usd: 1 },
      { date: "2026-07-02", reserve: 2400200, reserve_usd: 1 },
      { date: "2026-07-01", reserve: 2400100, reserve_usd: 1 },
    ] } };
    const cg = { code: "0", data: { // CoinGlass: parallel arrays, one per exchange, unix seconds
      timeList: [Date.UTC(2026, 6, 1) / 1000, Date.UTC(2026, 6, 2) / 1000],
      dataMap: { Binance: [500, 510], Coinbase: [300, null] },
    } };
    const pairs = [[Date.UTC(2026, 6, 1), 10], [Date.UTC(2026, 6, 2), 20]]; // bare [t, v] rows
    const cqOut = n(cq), cgOut = n(cg);
    return [
      ["normalizeSeries reads the CryptoQuant shape", cqOut.length === 3 && cqOut[2].v === 2400300],
      ["normalizeSeries sorts ascending regardless of source order",
        cqOut[0].t < cqOut[1].t && cqOut[1].t < cqOut[2].t],
      ["normalizeSeries snaps timestamps to UTC day boundaries", cqOut.every(p => p.t % DAY === 0)],
      // The bug this guards: summing a missing exchange as 0 would print a
      // cliff on the chart the day a provider drops one exchange's history.
      ["normalizeSeries sums CoinGlass exchanges and skips holes",
        cgOut.length === 2 && cgOut[0].v === 800 && cgOut[1].v === 510],
      ["normalizeSeries reads unix seconds and [t,v] pairs", n(pairs).length === 2 && n(pairs)[1].v === 20],
      ["normalizeSeries collapses intraday rows to one point per day",
        n([{ time: Date.UTC(2026, 6, 1), value: 1 }, { time: Date.UTC(2026, 6, 1) + 3600000, value: 2 }]).length === 1],
      ["normalizeSeries returns [] rather than throwing on garbage",
        n(null).length === 0 && n({}).length === 0 && n("nope").length === 0
        && n({ result: { data: [{ nope: 1 }] } }).length === 0],
    ];
  },
};

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
      for (const [label, cond, detail = ""] of (EXTRA[name]?.(mod) || [])) {
        if (cond) console.log(`ok:     ${label}`);
        else failures.push([`${name} · ${label}`, detail || "assertion failed"]);
      }
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
