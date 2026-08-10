import { defineConfig } from "vite";
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

export default defineConfig({
  plugins: [react()],
  // Build stamp — shown in the ViewportDiag overlay and on Systems → Status, so
  // "which build is this phone actually running, and from which commit?" is
  // answerable from a screenshot. One string on purpose: every surface that
  // shows it prints it whole, so the sha can never drift away from its
  // timestamp or get dropped by a display that only knew about the old shape.
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + "Z · " + commitSha) },
  // Respect an externally assigned port (preview harnesses set PORT); vite
  // otherwise ignores the env var and always grabs 5173.
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
});
