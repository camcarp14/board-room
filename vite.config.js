import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// The commit this bundle was built from. The stamp used to be a timestamp
// alone, which answers "when" — and "when" is the wrong question at 11pm with a
// phone in your hand showing a bug that is not in the working tree. What you
// need then is the sha to check out.
//
// Netlify sets COMMIT_REF on every build, so that is the truth when it exists.
// A local `vite build` doesn't, so fall back to asking git. Both can be absent —
// a tarball checkout, or a sandbox with no .git — and a missing build stamp is
// never worth failing a deploy over, so the last fallback is the honest word
// "unknown" rather than a throw. execSync's stderr is silenced because git
// printing "not a git repository" into a build log looks like the build broke.
const commitSha = (() => {
  const fromCI = String(process.env.COMMIT_REF || "").trim();
  if (fromCI) return fromCI.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
})();

// ─── one vendor chunk, for the reload that follows every deploy ──────────────
// src/main.jsx forces a reload as soon as it notices that the shell the server
// is serving names a different entry script than the one this document is
// running. That is the fix for deploys being invisible until the second launch,
// and its cost is paid on a phone: the entry chunk is one file, its hash moves
// when any byte of it moves, so a one-line change to a card means re-downloading
// the whole 600 kB of it over LTE before the app is usable again.
//
// Most of that chunk is not his code. react + react-dom, @supabase/supabase-js
// and @tanstack/react-query are the better half of it and they change only when
// a dependency is deliberately bumped. Splitting them out saves nothing on a
// cold first load — same total bytes, one more request on an already-warm
// HTTP/2 connection — but it means the post-deploy reload fetches the app chunk
// and reads the vendor chunk straight out of the service worker's cache-first
// /assets/ store (public/sw.js), because its filename genuinely did not change.
//
// ONE chunk rather than three, on purpose. Three files would each pay a request
// and a cache entry to isolate three hashes that in practice move together (a
// dependency bump here is `npm update`, not surgery), and react-dom alone is
// most of the weight anyway.
//
// lightweight-charts and @anthropic-ai/sdk are deliberately NOT listed. Both are
// only reachable through a dynamic import — BtcChartModal for the first, nothing
// at all on the client for the second — so rollup already keeps them out of the
// eager graph. Naming them here would drag them INTO the vendor chunk and undo
// the lazy split that keeps 168 kB of charting off the landing page.
const VENDOR = /\/node_modules\/(?:react|react-dom|scheduler|@supabase|@tanstack)\//;
const manualChunks = (id) => {
  // Windows ids arrive with backslashes; the app runs on a Mac and deploys from
  // Linux, and a chunking rule that silently stops matching on one machine is
  // exactly the kind of difference that shows up as "why is the bundle bigger
  // when I build it".
  if (VENDOR.test(id.replace(/\\/g, "/"))) return "vendor";
  return undefined; // everything else keeps rollup's own answer
};

// ─── the local build was under-reporting itself by a third ───────────────────
// `npm run build` on this machine printed a 411 kB entry chunk. The deployed one
// was 630 kB. Neither number was wrong: src/lib/supabase.js reads its URL and key
// from import.meta.env, Vite inlines those as string literals, and with both
// empty the ternary
//
//     SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(…) : null
//
// constant-folds to `null`. createClient becomes unreachable, @supabase/supabase-js
// is tree-shaken out whole, and the report describes a bundle with no database
// client in it — 219 kB raw / 56 kB gzipped of the shipped app measuring as zero,
// locally, on every build, with nothing on screen to say so. The gap only exists
// where you cannot see it, which is how it survived: you find out about the real
// number from a phone on LTE.
//
// THE PLACEHOLDER APPROACH WAS TRIED FIRST AND REJECTED. Committing a .env with a
// fake URL does make the ternary survive, and it is safe from Netlify's point of
// view — loadEnv applies real process.env VITE_* keys last, verified against
// vite/dist/node's own source and by experiment, so a value set in the Netlify UI
// always beats a file. But it would also mean a local build produced a client
// pointed at a host that does not exist, and the honest "Supabase not configured"
// screen (shell/Boot.jsx) would be unreachable for anyone building or previewing
// here. A build that lies about its configuration in order to tell the truth
// about its size is a bad trade in this house.
//
// So the reference is kept ALIVE without being USABLE: one assignment to a global,
// appended to src/lib/supabase.js at build time, that rollup cannot prove is dead
// and that therefore drags @supabase back into the graph. `supabase` still exports
// null, the setup notice still shows, `npm run preview` behaves exactly as it did,
// and the printed size is the deployed size give or take the forty bytes of the
// assignment.
//
// THE PLUGIN IS NOT REGISTERED AT ALL WHEN THE ENV VARS ARE PRESENT. That is the
// property that matters and it is structural, not a guard someone can forget: a
// Netlify build — or any local build with real credentials — never runs a line of
// this, so it cannot affect the deployed bundle even in principle.
const sizeTruth = {
  name: "br-size-truth",
  apply: "build",
  // After every other transform, so the appended line is the last thing in the
  // module and cannot be re-parsed or re-ordered by a plugin that runs later.
  enforce: "post",
  transform(code, id) {
    if (!id.replace(/\\/g, "/").endsWith("/src/lib/supabase.js")) return null;
    return `${code}
// ── appended by vite.config.js (br-size-truth); NOT in any deployed build ──
// This exists so the size printed below matches what Netlify ships. Without a
// real VITE_SUPABASE_URL the client above folds to null and @supabase vanishes
// from the measurement. Assigning createClient to a global is a side effect
// rollup must keep, which keeps the library in the graph — and changes nothing
// at runtime: the export above is still null, and nothing anywhere reads this.
globalThis.__brSizeProbe = createClient;
`;
  },
};

export default defineConfig(({ mode, command }) => {
  // The same resolution order Vite itself will use for import.meta.env — .env
  // files first, real process.env VITE_* keys last and winning. Read here only to
  // answer one question: will src/lib/supabase.js's ternary survive this build?
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const supabaseConfigured = !!(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY);
  // Said out loud, every time, because the whole failure was silence. A build
  // that measures a different bundle than it ships should never again be able to
  // do it quietly.
  if (command === "build" && !supabaseConfigured) {
    console.log(
      "\n  ⓘ  No VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in this environment.\n"
      + "     @supabase/supabase-js would tree-shake out entirely and the sizes below\n"
      + "     would under-report the deployed bundle by ~219 kB raw / ~56 kB gzip, so\n"
      + "     this build keeps the reference alive on purpose (see vite.config.js).\n"
      + "     The output is size-accurate. It is NOT runnable — `supabase` is null and\n"
      + "     the app will show the setup notice, exactly as an unconfigured build should.\n"
    );
  }
  return {
    plugins: [react(), ...(supabaseConfigured ? [] : [sizeTruth])],
    // Build stamp — shown in the ViewportDiag overlay and on Systems → Status, so
    // "which build is this phone actually running, and from which commit?" is
    // answerable from a screenshot. One string on purpose: every surface that
    // shows it prints it whole, so the sha can never drift away from its
    // timestamp or get dropped by a display that only knew about the old shape.
    define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + "Z · " + commitSha) },
    // Respect an externally assigned port (preview harnesses set PORT); vite
    // otherwise ignores the env var and always grabs 5173.
    server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
    build: { rollupOptions: { output: { manualChunks } } },
  };
});
