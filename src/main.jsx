import React from "react";
import { createRoot } from "react-dom/client";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import "./styles.css";
import App from "./App.jsx";
import { queryClient } from "./lib/queryClient.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.jsx";

// Persist the query cache to localStorage so a relaunch (iOS evicts backgrounded
// PWAs constantly) paints last-known data immediately, then revalidates in the
// background — instead of an empty screen while every fetch round-trips.
const persister = createSyncStoragePersister({ storage: window.localStorage, key: "br_rq_cache" });

createRoot(document.getElementById("root")).render(
  <ErrorBoundary full>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24, buster: "br-rq-1" }}
    >
      <App />
    </PersistQueryClientProvider>
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
