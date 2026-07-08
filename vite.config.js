import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Respect an externally assigned port (preview harnesses set PORT); vite
  // otherwise ignores the env var and always grabs 5173.
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
});
