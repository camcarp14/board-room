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
import { mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, basename } from "node:path";

const FN_DIR = "netlify/functions";
const OUT_DIR = ".fn-smoke";
const require_ = createRequire(import.meta.url);

// tweetnacl is a real dependency of discord-board; keep it external so this
// check doesn't depend on bundling third-party trees.
const EXTERNALS = ["tweetnacl"];

// Board Room is a personal, owner-only console. These endpoints can read
// connected business data, spend API budget, or write through privileged
// credentials; a valid session for a second account must never be sufficient.
const OWNER_ONLY = [
  "audit", "auto-fix", "calendar-events", "claude", "clarify-pipeline",
  "db-admin", "deploy", "econ-resolve-background", "fetch-page", "gsc",
  "mini-worker", "plaid", "shopify", "site-status", "upstream-run-background",
  "workout-import", "zts-pipeline",
];

// ─── extra assertions on pure helpers a function exports for testing ─────────
// Netlify only reads `handler`, so a function may export a pure helper purely so
// it can be asserted here. Keep these to logic that would otherwise be
// untestable — anything richer belongs in src/ with its own smoke.
const EXTRA = {
  // The econ feed has no `actual` field, so the only thing calendar.js can say
  // about a released event is what KIND of event it was. Get that wrong and the
  // Brief shows "awaiting a number" for a press conference — forever, because no
  // number is coming. These are the rows that were actually on the card.
  calendar: (mod) => {
    const { isNumericRow, windowRows, toEvent } = mod;
    if (typeof isNumericRow !== "function" || typeof windowRows !== "function" || typeof toEvent !== "function") {
      return [["calendar exports isNumericRow + windowRows + toEvent", false, "not exported"]];
    }
    const NOW = Date.parse("2026-07-29T23:37:00-05:00");
    const hrs = (n) => new Date(NOW + n * 3600000).toISOString();
    const row = (title, extra = {}) => ({ title, country: "USD", impact: "High", date: hrs(-1), forecast: null, previous: null, ...extra });
    const ids = (rows) => windowRows(rows, NOW).map((x) => x.r.title).join(",");
    return [
      ["a figure is expected when the feed quotes one", isNumericRow(row("Federal Funds Rate", { forecast: "3.75%", previous: "3.75%" }))],
      ["no forecast and no prior ⇒ no figure is coming", !isNumericRow(row("FOMC Statement"))],
      ["a press conference never carries a figure", !isNumericRow(row("FOMC Press Conference"))],
      ["meeting minutes never carry a figure", !isNumericRow(row("FOMC Meeting Minutes", { previous: "0.2%" }))],
      ["a speech never carries a figure", !isNumericRow(row("FOMC Member Waller Speaks"))],
      ["a bond auction never carries a figure", !isNumericRow(row("10-y Bond Auction", { previous: "4.21|2.5" }))],
      ["an ordinary release still expects a figure", isNumericRow(row("Core CPI m/m", { forecast: "0.3%", previous: "0.2%" }))],
      ["non-USD rows are dropped", ids([row("Keep", { forecast: "1" }), { ...row("Drop"), country: "EUR" }]) === "Keep"],
      ["low-impact rows are dropped", ids([row("Keep"), { ...row("Drop"), impact: "Low" }]) === "Keep"],
      ["rows before the look-back are dropped", ids([row("Keep"), { ...row("Drop"), date: hrs(-19) }]) === "Keep"],
      ["rows past +7 days are dropped", ids([row("Keep"), { ...row("Drop"), date: hrs(24 * 8) }]) === "Keep"],
      ["an 18h-old release is still on the card", ids([{ ...row("Keep"), date: hrs(-17) }]) === "Keep"],
      ["an unparseable date is dropped, not NaN-sorted", ids([row("Keep"), { ...row("Drop"), date: "not a date" }]) === "Keep"],
      // The reason past rows get their own cap: an ascending sort under one
      // shared cap let a busy morning push the whole rest of the week off.
      ["a flood of past rows can't crowd out what's ahead", (() => {
        const past = Array.from({ length: 30 }, (_, i) => ({ ...row(`p${i}`), date: hrs(-1) }));
        const ahead = Array.from({ length: 10 }, (_, i) => ({ ...row(`a${i}`), date: hrs(24 + i) }));
        const out = windowRows([...past, ...ahead], NOW).map((x) => x.r.title);
        return out.filter((t) => t.startsWith("a")).length === 10 && out.filter((t) => t.startsWith("p")).length === 8;
      })()],
      ["events come back oldest-first", (() => {
        const out = windowRows([{ ...row("later"), date: hrs(5) }, { ...row("sooner"), date: hrs(2) }], NOW);
        return out.map((x) => x.r.title).join(",") === "sooner,later";
      })()],
      ["toEvent ships `at` so the client can re-derive isPast", (() => {
        const e = toEvent({ r: row("Core CPI m/m", { forecast: "0.3%", previous: "0.2%" }), t: NOW - 3600000 }, NOW);
        return e.at === new Date(NOW - 3600000).toISOString() && e.isPast === true && e.numeric === true
          && e.id === `${e.at}|Core CPI m/m` && e.text === "Core CPI m/m — forecast 0.3% — prior 0.2%";
      })()],
      // The bug in one assertion: nothing may claim to carry a released figure,
      // because this feed has never had one.
      ["no row ever claims an actual", (() => {
        const e = toEvent({ r: { ...row("Federal Funds Rate", { forecast: "3.75%", previous: "3.75%" }), actual: "3.75%" }, t: NOW - 3600000 }, NOW);
        return e.actual === undefined && !/actual/.test(e.text);
      })()],
    ];
  },
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
  "calendar-events": (mod) => {
    const badUrl = mod.badUrl;
    if (typeof badUrl !== "function") return [["calendar-events exports badUrl", false, "not exported"]];
    return [
      ["calendar events allow a public HTTPS host", !badUrl("https://calendar.google.com/calendar/ical/example/basic.ics")],
      ["calendar events reject loopback hosts", !!badUrl("http://127.0.0.1:8080/private.ics")],
      ["calendar events reject IPv6 loopback", !!badUrl("http://[::1]/private.ics")],
      ["calendar events reject metadata hosts", !!badUrl("http://169.254.169.254/latest/meta-data/")],
      ["calendar events reject embedded credentials", !!badUrl("https://user:pass@example.com/feed.ics")],
    ];
  },
  "site-status": (mod) => {
    const badUrl = mod.badUrl;
    if (typeof badUrl !== "function") return [["site-status exports badUrl", false, "not exported"]];
    return [
      ["site status allows a public HTTPS host", !badUrl("https://zerotosecure.com")],
      ["site status rejects loopback hosts", !!badUrl("http://localhost:3000")],
      ["site status rejects private networks", !!badUrl("http://10.0.0.8/admin")],
      ["site status rejects IPv6 local networks", !!badUrl("http://[fe80::1]/")],
      ["site status rejects non-web schemes", !!badUrl("file:///etc/passwd")],
    ];
  },
  "fetch-page": (mod) => {
    const badUrl = mod.badUrl;
    if (typeof badUrl !== "function") return [["fetch-page exports badUrl", false, "not exported"]];
    return [
      ["page fetch allows a public HTTPS host", !badUrl("https://developers.openai.com" )],
      ["page fetch rejects local IPv6", !!badUrl("http://[::1]/" )],
      ["page fetch rejects private IPv4", !!badUrl("http://192.168.1.1/" )],
      ["page fetch rejects embedded credentials", !!badUrl("https://user:pass@example.com/" )],
    ];
  },
  audit: (mod) => {
    const badUrl = mod.badUrl;
    if (typeof badUrl !== "function") return [["audit exports badUrl", false, "not exported"]];
    return [
      ["site auditor allows a public HTTPS host", !badUrl("https://zerotosecure.com" )],
      ["site auditor rejects metadata hosts", !!badUrl("http://169.254.169.254/latest/meta-data/" )],
      ["site auditor rejects IPv6 local networks", !!badUrl("http://[fd00::1]/" )],
      ["site auditor rejects local hostnames", !!badUrl("http://app.internal/" )],
    ];
  },
};

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const fns = readdirSync(FN_DIR).filter(f => f.endsWith(".js")).sort();
let pass = 0;
const failures = [];

for (const name of OWNER_ONLY) {
  const source = readFileSync(join(FN_DIR, `${name}.js`), "utf8");
  if (!source.includes("BOARD_USER_ID")) {
    failures.push([`${name} · owner gate`, "missing BOARD_USER_ID authorization"]);
  }
}

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
// ─── every outbound fetch carries a deadline ─────────────────────────────────
// A fetch with no timeout in a Netlify function does not fail — it HANGS, until
// the platform kills the invocation. On a synchronous function that is ~10
// seconds of a spinner and then a 502 with nothing readable in it; on a
// background one it burns the 15-minute budget doing nothing. Twenty of these
// shipped without one, against CoinGecko, Yahoo, Plaid, Shopify, TMDB, the
// Forex calendar and Anthropic — every upstream the app has.
//
// The deadline is sized to the work: a JSON API that has not answered in eight
// seconds is not going to, and an LLM generation legitimately takes minutes.
{
  const { readdirSync, readFileSync: rf } = await import("node:fs");
  const files = readdirSync("netlify/functions").filter((f) => f.endsWith(".js"));
  const naked = [], tooShortForAnLLM = [];
  for (const f of files) {
    const src = rf(`netlify/functions/${f}`, "utf8");
    if (!/\bfetch\(/.test(src)) continue;
    if (!/AbortSignal\.timeout|AbortController/.test(src)) { naked.push(f); continue; }
    // An Anthropic call on a short deadline is worse than none: it fails every
    // time the model thinks for longer than a page load.
    for (const line of src.split("\n")) {
      const m = line.match(/api\.anthropic\.com[\s\S]*?AbortSignal\.timeout\((\d+)\)/);
      if (m && Number(m[1]) < 60000) tooShortForAnLLM.push(`${f} (${m[1]}ms)`);
    }
  }
  if (naked.length) failures.push(["outbound timeouts", `these fetch with no deadline: ${naked.join(", ")}`]);
  else console.log(`ok:   every function that fetches carries a deadline`);
  if (tooShortForAnLLM.length) failures.push(["LLM deadlines", `sized for a page load, not a generation: ${tooShortForAnLLM.join(", ")}`]);
  else console.log(`ok:   LLM calls get generation-sized deadlines`);
}

if (failures.length) {
  for (const [name, why] of failures) console.error(`FAIL: ${name}\n      ${why}`);
  console.error("FUNCTION SMOKE FAILED");
  process.exit(1);
}

console.log("FUNCTION SMOKE PASS");
