// ─── Plaid, from the browser's side ──────────────────────────────────────────
// Everything secret is in netlify/functions/plaid.js. This file only ever holds
// a link_token (single-use, expires in hours) and calls the function with the
// signed-in user's own Supabase JWT, which is what scopes every request to them.

import { supabase } from "../../lib/supabase.js";

const LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

/** Plaid Link, loaded on demand. It is ~200 kB of third-party script and most
 *  launches never connect a bank, so it is not in the bundle and not in the
 *  <head> — it arrives the moment you tap Connect, and only then. */
let linkPromise = null;
export function loadLink() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (linkPromise) return linkPromise;
  linkPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LINK_SRC;
    s.async = true;
    s.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error("Plaid Link didn't initialise.")));
    s.onerror = () => { linkPromise = null; reject(new Error("Couldn't reach Plaid. Check your connection.")); };
    document.head.appendChild(s);
  });
  return linkPromise;
}

/** One call to the function, always with the caller's own session. */
export async function callPlaid(action, body = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("Sign in first.");
  const r = await fetch("/.netlify/functions/plaid", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(out?.error || `Request failed (${r.status})`);
    e.code = out?.code;
    throw e;
  }
  return out;
}

/**
 * Connect a bank, end to end.
 *
 * The redirect_uri is sent as this app's own origin because Chase is OAuth-only:
 * Plaid hands the browser to Chase and Chase hands it back here. It must match
 * an entry in the Plaid dashboard's Allowed Redirect URIs exactly, or Link will
 * simply refuse to open Chase at all — with no error that names the cause, which
 * is why it's stated here and in the connect card.
 *
 * `onEvent` is called with short human strings rather than Plaid's event codes:
 * this runs for ten to sixty seconds through a bank's own login, and silence
 * during it reads as a hang.
 */
export async function connectBank({ onEvent } = {}) {
  onEvent?.("Getting ready…");
  const Plaid = await loadLink();
  const { link_token } = await callPlaid("link_token", { origin: window.location.origin });
  if (!link_token) throw new Error("Plaid didn't return a link token.");

  const public_token = await new Promise((resolve, reject) => {
    const handler = Plaid.create({
      token: link_token,
      // Not an error: closing the sheet is a decision, and throwing here would
      // put a red banner on the screen for someone who simply changed their mind.
      onSuccess: (pt) => resolve(pt),
      onExit: (err) => reject(err ? new Error(err.display_message || err.error_message || "Couldn't connect that bank.") : null),
    });
    handler.open();
  });
  if (!public_token) return null;

  onEvent?.("Linking the account…");
  const ex = await callPlaid("exchange", { public_token });
  onEvent?.("Pulling transactions…");
  const sync = await callPlaid("sync");
  return { ...ex, ...sync };
}

/**
 * The extra table Plaid needs, in the schema the client reads.
 *
 * SEPARATE from the Finances setup because that one has already been run: this
 * is the delta, so it can be pasted without re-reading a block you've seen.
 *
 * NO POLICY, deliberately. Every other table in this app grants the signed-in
 * role its own rows; this one grants nothing to anybody. It holds long-lived
 * bank access tokens, and the only thing that should ever read them is the
 * Netlify function, which uses the service role and bypasses RLS. RLS on with no
 * policy means the browser cannot read this table even with a valid session —
 * which is the correct blast radius for a credential store.
 */
export const PLAID_SQL = `-- Board Room · Plaid — one more table
-- Safe to run as many times as you like.
create table if not exists boardroom.plaid_items (
  user_id      uuid not null references auth.users(id) on delete cascade,
  item_id      text not null,
  access_token text not null,
  institution  text not null default 'Bank',
  cursor       text,
  synced_at    timestamptz,
  created_at   timestamptz not null default now(),
  primary key (user_id, item_id)
);

-- RLS ON, and NO policy: this holds bank access tokens. Only the Netlify
-- function touches it, and it uses the service role, which bypasses RLS.
-- Granting nothing to anon/authenticated means a stolen session still cannot
-- read a token.
alter table boardroom.plaid_items enable row level security;
revoke all on boardroom.plaid_items from anon, authenticated;`;
