// Wrapper: bundles the JSX render smoke (esbuild) and runs it. Keeps the quoting mess
// out of package.json so `npm run smoke:upstream` works the same on any shell.
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".render-smoke.tmp.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "upstream-render-smoke.mjs")],
  bundle: true, platform: "node", format: "esm", outfile: out,
  loader: { ".jsx": "jsx" }, jsx: "automatic",
  external: ["react", "react-dom", "react-dom/server"],
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", DEV: false }) },
  logLevel: "error",
});

try {
  await import(pathToFileURL(out).href);
} finally {
  await rm(out, { force: true });
}
