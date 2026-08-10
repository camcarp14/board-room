import React from "react";
import { createRoot } from "react-dom/client";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import "./styles.css";
import App from "./App.jsx";
import { queryClient, shouldPersistMutation, dropStaleOutboxMutations } from "./lib/queryClient.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.jsx";

// Persist the query cache to localStorage so a relaunch (iOS evicts backgrounded
// PWAs constantly) paints last-known data immediately, then revalidates in the
// background — instead of an empty screen while every fetch round-trips.
const persister = createSyncStoragePersister({ storage: window.localStorage, key: "br_rq_cache" });

// What is persisted was never only reads. An optimistic write goes into the same
// cache, so before the three options below existed you could tick a grocery item
// off in a dead zone, relaunch the next morning to a still-ticked box, and watch
// it un-tick itself the moment the first good read landed. Nothing had been sent
// and nothing ever would be: the restored mutation had no function to run (see
// lib/queryClient.js) and nothing asked it to run. The box was a claim about the
// database that the database had never agreed to.
//
// shouldDehydrateMutation decides what is worth writing down. shouldDehydrateQuery
// is deliberately NOT passed, so the read half persists exactly as it did before —
// successful queries and nothing else.
//
// The hydrate scope is what makes the replay SEQUENTIAL, and it is not optional.
// resumePausedMutations starts every paused write at once, and these writes send
// absolute values — "3x Milk", checked=false — so two of them queued against the
// same row in the same dead zone (type milk, tap +, tap +) race on the way out,
// and whichever answers last wins even when it carries the oldest thing you
// meant. That lands the row on a value you had already moved past: the reverting
// lie again, one layer down. A shared scope makes the mutation cache run them one
// at a time in the order they were made. It is set here rather than on the
// mutations themselves so it applies ONLY to what came back off the disk — live
// writes keep firing in parallel exactly as they do today.
const persistOptions = {
  persister,
  maxAge: 1000 * 60 * 60 * 24,
  buster: "br-rq-1",
  dehydrateOptions: { shouldDehydrateMutation: shouldPersistMutation },
  hydrateOptions: { defaultOptions: { mutations: { scope: { id: "br-outbox" } } } },
};

// The restore finishing is the only moment the resume can happen — the restored
// mutations do not exist before it. Stale ones go first (lib/queryClient.js says
// why a day is the limit), and the resume is deliberately NOT returned: this
// callback is awaited before isRestoring flips, which gates every query in the
// app, so returning the promise would hold the whole UI behind the outbox
// draining. It cannot reject, and it no-ops while still offline — the client's
// own onlineManager subscription picks the writes up when the signal returns.
const drainOutbox = () => {
  dropStaleOutboxMutations();
  queryClient.resumePausedMutations();
};

createRoot(document.getElementById("root")).render(
  <ErrorBoundary full>
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions} onSuccess={drainOutbox}>
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
  // When a new SW takes control (VERSION bump → skipWaiting + clients.claim),
  // reload once so this tab moves onto the fresh shell. Without it the running
  // page keeps its old HTML while the new SW has already purged the old hashed
  // chunks, so any not-yet-loaded lazy chunk 404s ("Failed to load module").
  // Guard on hadController so the FIRST install's claim (no prior controller)
  // doesn't bounce a first-time visitor.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded || !hadController) return;
    reloaded = true;
    window.location.reload();
  });

  // …but controllerchange ONLY fires when sw.js itself changes, and a normal
  // deploy doesn't touch it. Navigations are stale-while-revalidate, so the
  // worker served the shell it had, cached the fresh one for next time, and
  // nothing told this tab it was running last week's build. Every deploy was
  // invisible until you happened to open the app a second time — from the phone,
  // indistinguishable from the deploy never having happened.
  //
  // So the PAGE asks. Vite hashes the entry script per build, which makes its
  // filename a build id with nothing to stamp or remember to bump: fetch the
  // shell the server has and compare its entry script to the one this document
  // is running. A plain fetch() isn't a navigation, so it takes the worker's
  // network-first branch and sees the real answer.
  //
  // The worker CAN'T do this itself, though the obvious version looks like it
  // can: a postMessage from the navigate handler runs before the new document
  // exists, so clients.matchAll finds the outgoing page or nothing, and the
  // message lands on a document being torn down. Asking from here needs no
  // cooperation from the worker and works whatever it's caching.
  const BUILD = /assets\/index-[A-Za-z0-9_-]+\.js/;
  const runningBuild = () =>
    ([...document.scripts].map((s) => s.src).find((s) => BUILD.test(s)) || "").match(BUILD)?.[0] || "";
  // Never reload out from under a half-typed grocery item. That's the whole
  // reason this isn't an unconditional reload the moment a change is seen.
  const typing = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  };
  const checkBuild = async () => {
    if (reloaded) return;
    try {
      const res = await fetch("/", { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.text()).match(BUILD)?.[0];
      const now = runningBuild();
      // Both must be known: an unparseable shell must mean "do nothing", never
      // "reload", or a bad response would put the app in a refresh loop.
      if (!next || !now || next === now) return;
      if (typing()) return;   // catch it at the next foreground instead
      reloaded = true;
      window.location.reload();
    } catch { /* offline — the running build is the right one to keep */ }
  };
  // At launch, because that's the case that matters: open the app after a
  // deploy and land on the new build on THIS launch. Then on every return to
  // the foreground, which is the natural boundary mid-session.
  window.addEventListener("load", () => { checkBuild(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkBuild(); });
}
