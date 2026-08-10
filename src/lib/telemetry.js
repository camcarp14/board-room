import { supabase } from "./supabase.js";

// Durable, cross-device usage log (Supabase) — separate from the
// localStorage-only `obs` tracker below, which resets per-browser. Every
// Anthropic call and every Netlify function hit gets a row here, powering
// the Usage section in IT Department. Fire-and-forget; never blocks or
// throws into the caller.
//
// The catch below used to be decorative, and for the same reason the four writes
// in data/db.js were: supabase-js RESOLVES with { data, error } on a PostgREST
// rejection or an RLS denial rather than rejecting, so an insert this table
// refused never reached it. That is quieter than it sounds — usage_log is the
// only record of what the models cost, so a refused write means Systems → Usage
// reports a smaller bill than the one Anthropic will send, with nothing anywhere
// saying a row went missing. Reading .error and console.warn-ing is the whole
// fix: this stays fire-and-forget by design (a metering write must never break
// the call it is metering), but it is no longer SILENT, and a run of these in
// the console is the thread to pull when the numbers look low.
export async function logUsage(row) {
  if (!supabase) return;
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    if (!uid) return;
    const { error } = await supabase.from("usage_log").insert({ user_id: uid, ...row });
    if (error) throw error;
  } catch (e) {
    // Named, not swallowed. Still never rethrown — see above.
    console.warn(`[telemetry] usage_log write failed for fn=${row?.fn ?? "?"}: ${e?.message || e}`);
  }
}

// ─── crashes ─────────────────────────────────────────────────────────────────
// The second thing this app writes down about itself, and it lives next to
// logUsage on purpose: one module owns every telemetry write, so there is one
// place to look when the numbers or the crash count go quiet.
//
// What it replaces. ErrorBoundary caught render crashes and wrote them into
// localStorage.br_crashes — a key nothing in src/ ever read back. So a crash on
// the phone was recorded on the phone, for nobody, until Safari evicted the
// origin's storage and it was gone. Anything thrown OUTSIDE a React render was
// not recorded anywhere at all: a rejected promise, an async click handler, a
// listener on window. Those are most of the interesting failures in a PWA that
// spends its life going in and out of a network. The boundary and the two global
// handlers in main.jsx all come through here now, and __BUILD__ rides on every
// row, so a crash can finally be pinned to the deploy that shipped it.
//
// The local log is still written by the boundary and has not been touched. It is
// the only record that survives with no network, and Systems → Status shows it.
const BUILD = typeof __BUILD__ !== "undefined" ? __BUILD__ : "dev";

// A digest of message+stack, not a UUID: two reports of the same fault have to
// collide, which is the entire defence below. djb2 because it needs to be
// synchronous and free — crypto.subtle.digest is a promise, and a promise here
// would put an await in front of the gate that must not have one (see the next
// note). Collisions between genuinely different crashes cost one lost report,
// which is the cheap direction to be wrong in.
const digest = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

// THE CAPS, AND WHY THERE ARE TWO. A render loop throws hundreds of times a
// second, and every throw would be an insert — a crash reporter that DDoSes the
// database it reports to. Deduping by hash handles the common loop, where the
// same component throws the same message forever. It does not handle a loop
// whose message carries a changing number ("index 4127 of undefined"), because
// every one of those hashes differently, so a hard ceiling sits behind the
// dedupe.
//
// Per session, in memory: the ceiling for one page life. Per build, in
// localStorage: the ceiling that survives a reload, which is the case the
// in-memory set cannot see. A crash during first render means a reload, and a
// reload is a fresh session with an empty Set — twenty reloads of a broken build
// would be twenty rounds of inserts. Keyed by build so the next deploy starts
// clean: a fresh build's crashes are exactly what this table is for, and
// carrying an old build's spent budget into it would hide them.
const PER_SESSION_CAP = 8;
const PER_BUILD_CAP = 24;
const SENT_KEY = "br_err_sent";
const sentThisSession = new Set();

// localStorage throws outright in Safari's private mode and when the origin is
// over quota, and it can hold anything a previous version of this code left
// behind, so both directions are guarded and a bad value reads as "nothing sent
// yet" rather than taking the reporter down with it.
const loadSent = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(SENT_KEY) || "null");
    if (!raw || raw.build !== BUILD || !Array.isArray(raw.hashes)) return [];
    return raw.hashes;
  } catch { return []; }
};
const saveSent = (hashes) => {
  try { localStorage.setItem(SENT_KEY, JSON.stringify({ build: BUILD, hashes })); } catch {}
};

// A crash report is not worth a megabyte. Stacks are the long field and the top
// of one is the part that identifies the fault, so it is the tail that goes.
const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) : t; };

/**
 * File one crash. Fire-and-forget, exactly like logUsage: it never rejects and
 * never throws, because every caller is a crash path and a reporter that can
 * itself fail is a joke — and worse than a joke here, since a rejection out of
 * this function would land in the unhandledrejection handler that called it and
 * loop.
 *
 * THE GATE IS SYNCHRONOUS AND IT HAS TO BE. Everything that decides whether this
 * report is sent — the hash, both caps, marking the hash as spent — happens
 * before the first await. Put any of it after one and a burst of two hundred
 * throws in a single tick all read an empty `sentThisSession`, all decide they
 * are the first, and all two hundred inserts go out: the dedupe would be
 * correct and useless, because nothing had been recorded yet when they checked.
 */
export async function reportClientError({ kind, message, stack, url } = {}) {
  let hash;
  try {
    const msg = clip(message, 400) || "(no message)";
    const trace = clip(stack, 4000);
    hash = digest(`${kind}\n${msg}\n${trace}`);
    if (sentThisSession.has(hash)) return;
    if (sentThisSession.size >= PER_SESSION_CAP) return;
    const sentThisBuild = loadSent();
    if (sentThisBuild.includes(hash)) return;
    if (sentThisBuild.length >= PER_BUILD_CAP) return;
    // Marked BEFORE the insert is attempted, and deliberately left marked if the
    // insert fails. Clearing it on failure would mean a build whose writes are
    // being refused (RLS, a missing grant, no network) retries forever at
    // whatever rate the crash is happening — the runaway this whole section
    // exists to prevent, arriving through the error path instead of the happy
    // one. One lost report is the right price.
    sentThisSession.add(hash);
    saveSent([...sentThisBuild, hash]);

    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    if (!uid) return;   // signed out — the row has nowhere to belong
    const { error } = await supabase.from("client_errors").insert({
      user_id: uid,
      kind: kind || "window",
      message: msg,
      stack: trace || null,
      build: BUILD,
      url: clip(url || (typeof location !== "undefined" ? location.href : ""), 500) || null,
      hash,
    });
    if (error) throw error;
  } catch (e) {
    // Named, not swallowed, and never rethrown — same contract as logUsage. The
    // console is the fallback record when the durable one is refused, and the
    // boundary has already put the message on screen anyway.
    console.warn(`[telemetry] client_errors write failed for kind=${kind ?? "?"} hash=${hash ?? "?"}: ${e?.message || e}`);
  }
}

