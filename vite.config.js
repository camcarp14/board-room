import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Build stamp — shown in the ViewportDiag overlay and Systems, so "which
  // build is this phone actually running?" is answerable from a screenshot.
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + "Z") },
  // Respect an externally assigned port (preview harnesses set PORT); vite
  // otherwise ignores the env var and always grabs 5173.
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
});
