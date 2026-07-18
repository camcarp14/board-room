#!/usr/bin/env node
// ─── miner-push — the bridge that makes miner stats reachable from anywhere ──
//
// The problem this solves: the NerdQaxe++ serves plain HTTP on a private LAN
// address (10.0.0.157). A browser on an HTTPS page — the deployed Board Room,
// your phone, your tablet — is blocked from fetching that, and no CORS header,
// proxy, or tunnel changes it, because the cloud has no route to a private IP.
//
// So we push instead of pull. This script runs on a machine that CAN reach the
// miner, reads it over HTTP (fine — it's a local process, not a browser), and
// writes the reading to Supabase. Every client then reads miner stats from
// Supabase over HTTPS, which already works everywhere, including off your WiFi.
//
// Nothing listens for inbound connections. The miner is never exposed to the
// internet — which matters, because its API accepts POST/PUT/PATCH/DELETE and
// has no authentication at all.
//
// Usage:
//   node scripts/miner-push.mjs            one reading, then exit (Task Scheduler)
//   node scripts/miner-push.mjs --watch    stay running, push every interval
//   node scripts/miner-push.mjs --once -v  one reading, verbose
//
// Config lives in .env.miner (gitignored). See .env.miner.example.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ── config ────────────────────────────────────────────────────────────────── */

// Tiny .env parser — avoids a dotenv dependency so this script can be copied to
// any machine with Node and run as-is.
function loadEnv(file) {
  try {
    const out = {};
    for (const raw of readFileSync(resolve(ROOT, file), "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch { return {}; }
}

const env = { ...loadEnv(".env.miner"), ...process.env };

const MINER_URL    = env.MINER_URL || "http://10.0.0.157/api/system/info";
const SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY || "";
const USER_ID      = env.MINER_USER_ID || "";
const INTERVAL_SEC = Number(env.MINER_PUSH_INTERVAL_SEC || 120);
const RETAIN_DAYS  = Number(env.MINER_RETAIN_DAYS || 14);
const TIMEOUT_MS   = 8000;

const WATCH   = process.argv.includes("--watch");
const VERBOSE = process.argv.includes("-v") || process.argv.includes("--verbose");
// Reads the miner and shows exactly what WOULD be written, touching nothing.
// Use it to confirm the miner is reachable before wiring up credentials.
const DRY     = process.argv.includes("--dry-run");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const vlog = (...a) => { if (VERBOSE) log(...a); };

function requireConfig() {
  if (DRY) return; // nothing is written, so credentials aren't needed yet
  const missing = [
    ["SUPABASE_URL", SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY],
    ["MINER_USER_ID", USER_ID],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`\nMissing config: ${missing.join(", ")}`);
    console.error(`Copy .env.miner.example to .env.miner and fill it in.\n`);
    process.exit(2);
  }
}

/* ── the work ──────────────────────────────────────────────────────────────── */

async function withTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const bail = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(bail); }
}

const sb = (path, opts = {}) => withTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
  ...opts,
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  },
});

async function readMiner() {
  const r = await withTimeout(MINER_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`miner HTTP ${r.status}`);
  return r.json();
}

async function push(payload) {
  // hashRate_10m is the steadier figure and the one the panel leads with, so
  // the denormalized column matches what you actually see on screen.
  const row = {
    user_id: USER_ID,
    payload,
    hash_rate: payload.hashRate_10m ?? payload.hashRate ?? null,
    temp: payload.temp ?? null,
    power: payload.power ?? null,
  };
  const r = await sb("miner_samples", { method: "POST", body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`supabase insert ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// Append-only would grow without bound (a 2-minute cadence is ~260k rows a
// year). An indexed delete that usually matches nothing is cheap, so just run
// it every push rather than tracking when it last happened.
async function prune() {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString();
  const r = await sb(`miner_samples?user_id=eq.${USER_ID}&created_at=lt.${cutoff}`, { method: "DELETE" });
  if (!r.ok) vlog(`prune failed ${r.status} (not fatal)`);
}

async function tick() {
  const t0 = Date.now();
  const payload = await readMiner();
  const summary = `${Math.round(payload.hashRate_10m ?? payload.hashRate)} GH/s · ${payload.temp?.toFixed(1)}°C · ${payload.power?.toFixed(1)}W`;
  if (DRY) {
    log(`dry run — miner reachable · ${summary} · ${Date.now() - t0}ms`);
    log(`would insert into miner_samples: ${JSON.stringify({
      user_id: USER_ID || "(unset)",
      hash_rate: payload.hashRate_10m ?? payload.hashRate,
      temp: payload.temp, power: payload.power,
      payload: `<${Object.keys(payload).length} fields>`,
    })}`);
    return;
  }
  await push(payload);
  await prune();
  log(`pushed · ${summary} · ${Date.now() - t0}ms`);
}

/* ── entry ─────────────────────────────────────────────────────────────────── */

requireConfig();

if (WATCH) {
  log(`watching — pushing every ${INTERVAL_SEC}s, retaining ${RETAIN_DAYS}d`);
  const run = async () => {
    // Never let one failure kill the loop: the desktop may sleep, the miner may
    // reboot, the WiFi may drop. Log it and try again next interval.
    try { await tick(); } catch (e) { log(`skip — ${e.message}`); }
  };
  await run();
  setInterval(run, INTERVAL_SEC * 1000);
} else {
  try {
    await tick();
  } catch (e) {
    // Non-zero so a scheduled run surfaces as failed instead of silently
    // "succeeding" while writing nothing.
    console.error(`failed — ${e.message}`);
    process.exit(1);
  }
}
