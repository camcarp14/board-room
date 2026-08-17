import { logUsage } from "./telemetry.js";
import { supabase } from "./supabase.js";

// ─── nothing in this file may hang forever ───────────────────────────────────
// Every helper below awaits a fetch() with no signal, and a fetch with no signal
// has no ceiling. iOS keeps a request alive across a backgrounded PWA and a
// handover between cells, so a call started in a dead zone can sit unresolved for
// minutes — and the card that made it shows its loading skeleton for exactly as
// long as the promise takes. That is the one failure mode with no message and no
// Retry, in an app where every other one has both: not a wrong number, but a
// screen that never resolves into any state at all.
//
// THIRTY SECONDS IS NOT A GUESS. Netlify caps a synchronous function at 26s (10s
// unless configured otherwise) and answers with a 502 of its own when it hits
// that, so a response this ceiling cuts off is one the platform had already given
// up on. The timeout can therefore only fire on a wedged connection, never on a
// function that is merely slow — which matters because `audit` and `auto-fix` are
// Claude-backed and legitimately take tens of seconds, and a tidier-looking 10s
// would have started failing real work.
const FN_TIMEOUT_MS = 30_000;
// Probes are a different animal. {ping:true} is a config read that touches no
// upstream, Systems → Status fires roughly 25 of them at once, and a probe with
// no answer IS the answer — so it gets a much shorter leash. 10s is chosen to
// clear a cold start, not a round trip.
const PING_TIMEOUT_MS = 10_000;
// AbortSignal.timeout is Safari 16 / Node 18 and up, so it exists everywhere this
// app actually runs. The guard is for the smoke harnesses, which bundle this
// module for whatever Node is on the machine: a missing implementation has to
// degrade to the old unbounded behaviour rather than throw at the call site.
// Built at the fetch, never before it — the clock starts when the signal is
// created, so a signal made above an awaited authHeader() would spend part of its
// budget waiting for a token.
const timeoutSignal = (ms) =>
  (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
// AbortSignal.timeout rejects with a DOMException named TimeoutError. Worth
// telling apart from a genuine network error in the usage log: "timed out" and
// "unreachable" send you to different places when you are trying to work out why
// a card was empty an hour ago.
const timedOut = (e) => e?.name === "TimeoutError";

// The signed-in user's access token, best-effort. Attached to every function
// call so the credentialed/secret-wielding functions (claude, deploy, db-admin,
// auto-fix, fetch-page, mini-worker) can verify the caller instead of running
// open to the internet.
//
// getSession() IS A LOCAL READ, RIGHT UP UNTIL IT ISN'T. It resolves out of
// localStorage in a millisecond while the stored token is valid — but supabase-js
// serialises it behind an auth lock, and when the token has expired the call that
// holds that lock is a token refresh that retries with backoff for up to half a
// minute. Every helper in this file awaits this function before it opens a socket,
// so a stuck refresh wedged every card in the app at once, before a single request
// went out, and no per-fetch timeout could have helped: the fetch had not started.
//
// So it is raced, at the same 1.5s deadline lib/claude.js already uses for the
// same reason, and a slow answer means the call goes out without the header. The
// credentialed function then answers 401, the card says the call failed, and that
// is true — the call did fail. The alternative is a skeleton that resolves into
// nothing and explains nothing, which is the state this whole file is being
// bounded to avoid.
const AUTH_TIMEOUT_MS = 1500;
async function authHeader() {
  try {
    const r = await Promise.race([
      supabase?.auth?.getSession?.(),
      new Promise((resolve) => setTimeout(() => resolve(null), AUTH_TIMEOUT_MS)),
    ]);
    const t = r?.data?.session?.access_token;
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

// ─── Netlify function helpers (graceful fallback when a fn isn't built yet) ──
// Health probes are pure config reads — they cost nothing, tell you nothing
// after the fact, and used to account for a large share of usage_log's growth.
// Keep them out of the durable log; the Status tab shows their result live.
const isProbe = (payload) => !!payload && payload.ping === true;

export async function callFn(name, payload, extraHeaders) {
  const t0 = Date.now();
  let ok = false, detail;
  try {
    const auth = await authHeader();
    const res = await fetch(`/.netlify/functions/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...auth, ...(extraHeaders || {}) }, body: JSON.stringify(payload || {}),
      signal: timeoutSignal(FN_TIMEOUT_MS),
    });
    ok = res.ok;
    if (!ok) { detail = `HTTP ${res.status}`; throw new Error(detail); }
    const data = await res.json();
    // `ok` IS NOT `res.ok`, IT IS "DID THE CALLER GET AN ANSWER". Those came apart
    // on exactly one path and it was the quiet one: a 200 whose body is not JSON —
    // a proxy's HTML error page, a truncated response over a handover — threw out
    // of res.json() with `ok` already latched true. The caller received null and
    // drew its error state; the usage log recorded a successful call. So the one
    // record of what these functions actually do disagreed with the screen, in the
    // direction that hides a problem. Reassigned after the parse, which is the
    // first moment the answer is genuinely in hand.
    ok = true;
    return data;
  } catch (e) {
    ok = false;
    if (!detail) detail = timedOut(e) ? `no answer in ${FN_TIMEOUT_MS / 1000}s` : "network error";
    return null;
  } finally {
    if (!isProbe(payload)) logUsage({ fn: name, kind: "call", ms: Date.now() - t0, ok, detail });
  }
}
// Like callFn but keeps HTTP status + error body so the UI can say WHY a card isn't live.
export async function callFnFull(name, payload) {
  const t0 = Date.now();
  let ok = false, status = 0, data = null, detail;
  try {
    const auth = await authHeader();
    const res = await fetch(`/.netlify/functions/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(payload || {}),
      signal: timeoutSignal(FN_TIMEOUT_MS),
    });
    status = res.status; ok = res.ok;
    let unreadable = false;
    data = await res.json().catch(() => { unreadable = true; return null; });
    if (!ok) detail = data?.error || `HTTP ${status}`;
    // `ok` STAYS res.ok HERE, unlike callFn above, and the difference is the
    // contract rather than an inconsistency: this helper's whole reason to exist
    // is handing the UI the HTTP status alongside the body, and callers branch on
    // `ok` meaning "the function answered". Flipping it for an unreadable body
    // would change what a dozen call sites are reading.
    //
    // The log still must not be silent about it. A 200 that carried nothing
    // parseable is a real event — it is what a proxy's HTML error page looks like
    // from here — and a row saying only "ok" would leave no trace of the card that
    // went blank because `data` came back null.
    if (ok && unreadable) detail = "answered, body unreadable";
    return { ok, status, data };
  } catch (e) {
    detail = timedOut(e) ? `no answer in ${FN_TIMEOUT_MS / 1000}s` : "network error";
    return { ok: false, status: 0, data: null };
  } finally {
    if (!isProbe(payload)) logUsage({ fn: name, kind: "call", ms: Date.now() - t0, ok, detail });
  }
}

// Ping protocol: {ping:true} body; fns answer {configured:false, missing:"…"}
// for the PARTIAL state. 404 = not deployed. One copy for every health pill
// (Systems connections, Mini Me worker probe).
export async function pingFn(name) {
  const t0 = Date.now();
  try {
    const res = await fetch(`/.netlify/functions/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ping: true }),
      signal: timeoutSignal(PING_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    if (res.status === 404) return { status: "off", detail: "function not deployed", ms };
    const data = await res.json().catch(() => null);
    if (!res.ok) return { status: "down", detail: data?.error || `HTTP ${res.status}`, ms };
    if (data?.configured === false) return { status: "warn", detail: data?.missing ? `deployed — missing ${data.missing}` : "deployed — keys not set", ms };
    return { status: "ok", detail: "responding", ms };
  } catch (e) {
    // A probe that never came back used to leave its row on the status list
    // spinning, because there was nothing to time it out. "down" is the honest
    // verdict for a config read that couldn't answer inside ten seconds — and it
    // says which kind of silence it was, because "no answer in 10s" and
    // "unreachable" are different problems with different fixes.
    return { status: "down", detail: timedOut(e) ? `no answer in ${PING_TIMEOUT_MS / 1000}s` : "unreachable", ms: Date.now() - t0 };
  }
}
