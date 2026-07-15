import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import App from "./App.jsx";
import { queryClient } from "./lib/queryClient.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.jsx";
createRoot(document.getElementById("root")).render(
  <ErrorBoundary full>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </ErrorBoundary>
);

// Installed-app plumbing — production only, so dev never fights a stale cache.
// iOS standalone is lazy about service-worker updates; re-checking on every
// return-to-foreground keeps the installed app at most one launch behind.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}
