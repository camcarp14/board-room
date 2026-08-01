// ─── Plaid — the live bank connection ────────────────────────────────────────
// Replaces the monthly CSV export with a sync. Three actions, one function:
//
//   link_token  → a short-lived token the browser hands to Plaid Link
//   exchange    → Link's public_token becomes a long-lived access_token, stored
//   sync        → /transactions/sync from the saved cursor, into boardroom.transactions
//
// WHY THE SECRET LIVES HERE. Board Room is a static PWA; anything the browser
// can read, anyone can read. PLAID_SECRET and the access_token it buys are the
// keys to a bank feed, so neither is ever sent to the client — the browser only
// ever sees a link_token (single-use, ~4 hours) and, afterwards, rows.
//
// Needs, in Netlify env:
//   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox | production)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already set for db-admin et al)
//
// Deliberately self-contained — no require of _shared/response. With this repo's
// "type":"module" + esbuild bundling, a required helper's module.exports
// clobbers the bundle's exports object before exports.handler is assigned and
// the function deploys with NO handler. See the note in workout-import.js.

const json = (statusCode, data) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const error = (statusCode, message) => json(statusCode, { error: message });

const PLAID_HOST = () =>
  (process.env.PLAID_ENV || "sandbox") === "production"
    ? "https://production.plaid.com"
    : "https://sandbox.plaid.com";

function cfg() {
  return {
    id: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
    url: process.env.SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/** Who is asking. Same shape as calendar-events: the browser's Supabase JWT is
 *  verified against Supabase itself, so this function can never be used to read
 *  someone else's bank feed by guessing a user id. */
async function whoami(event, c) {
  const h = event.headers || {};
  const token = String(h.authorization || h.Authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { err: json(401, { error: "sign in first" }) };
  try {
    const r = await fetch(`${c.url}/auth/v1/user`, { headers: { apikey: c.service, Authorization: `Bearer ${token}` } });
    if (!r.ok) return { err: json(401, { error: "session expired — refresh and try again" }) };
    const u = await r.json();
    if (!u?.id) return { err: json(401, { error: "session expired — refresh and try again" }) };
    return { uid: u.id };
  } catch {
    return { err: json(503, { error: "couldn't verify your session — try again in a moment" }) };
  }
}

async function plaid(path, body, c) {
  const r = await fetch(`${PLAID_HOST()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: c.id, secret: c.secret, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Plaid's error_message is written for developers but is the most useful
    // thing available, and swallowing it leaves "sync failed" and nothing else.
    const e = new Error(data?.error_message || data?.error_code || `Plaid ${r.status}`);
    e.code = data?.error_code;
    e.status = r.status;
    throw e;
  }
  return data;
}

// ─── Supabase, over PostgREST ────────────────────────────────────────────────
// Service role, so RLS is bypassed — which is why every query below filters on
// the user id resolved from the caller's own JWT and never on anything they sent.
const sbHeaders = (c, extra = {}) => ({
  apikey: c.service, Authorization: `Bearer ${c.service}`,
  "Content-Type": "application/json", "Accept-Profile": "boardroom", "Content-Profile": "boardroom",
  ...extra,
});
async function sb(path, init, c) {
  const r = await fetch(`${c.url}/rest/v1/${path}`, { ...init, headers: sbHeaders(c, init?.headers) });
  if (!r.ok) throw new Error(`db: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ─── The mapping. Kept in step with src/features/finances/financeLogic.js ────
// Duplicated rather than imported for the bundling reason at the top of this
// file. THE SIGN IS THE WHOLE POINT: Plaid documents `amount` as POSITIVE when
// money moves OUT, the opposite of every Chase export, so it is negated exactly
// once, here. finance-smoke.mjs asserts the client-side twin of this.
const toCents = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
function mapTx(t, account) {
  const id = String(t?.transaction_id || "").trim();
  const date = String(t?.date || t?.authorized_date || "").slice(0, 10);
  const cents = toCents(t?.amount);
  const description = String(t?.merchant_name || t?.name || "").trim();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || cents === null || !description) return null;
  return {
    id: `plaid:${id}`, account, date,
    amount_cents: -cents,
    description,
    merchant: String(t?.merchant_name || description).trim(),
    // Left as "other" on purpose: the client re-categorises with the same
    // lexicon the CSV path uses, so one vocabulary covers both, and a
    // category_override you set is never touched by a sync.
    category: "other",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return error(405, "POST only");
  const c = cfg();
  if (!c.id || !c.secret) return error(503, "Plaid isn't configured — PLAID_CLIENT_ID and PLAID_SECRET are missing.");
  if (!c.url || !c.service) return error(500, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");

  const who = await whoami(event, c);
  if (who.err) return who.err;
  const uid = who.uid;

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return error(400, "bad JSON"); }
  const action = String(body.action || "");

  try {
    // ── 1. a token for Link ────────────────────────────────────────────────
    if (action === "link_token") {
      const origin = String(body.origin || "").replace(/\/$/, "");
      const out = await plaid("/link/token/create", {
        user: { client_user_id: uid },
        client_name: "Board Room",
        products: ["transactions"],
        country_codes: ["US"],
        language: "en",
        // Chase is OAuth-only. Plaid sends the browser to Chase and back here,
        // and it MUST match an entry in Dashboard → Developers → API → Allowed
        // Redirect URIs or Link refuses to open the institution at all.
        ...(origin ? { redirect_uri: `${origin}/` } : {}),
      }, c);
      return json(200, { link_token: out.link_token, expiration: out.expiration });
    }

    // ── 2. Link's public_token → a stored access_token ─────────────────────
    if (action === "exchange") {
      if (!body.public_token) return error(400, "public_token missing");
      const ex = await plaid("/item/public_token/exchange", { public_token: body.public_token }, c);
      let institution = String(body.institution || "").trim();
      if (!institution) {
        try {
          const item = await plaid("/item/get", { access_token: ex.access_token }, c);
          if (item?.item?.institution_id) {
            const inst = await plaid("/institutions/get_by_id", {
              institution_id: item.item.institution_id, country_codes: ["US"],
            }, c);
            institution = inst?.institution?.name || "";
          }
        } catch { /* a nameless item still syncs — don't fail the connect over a label */ }
      }
      await sb("plaid_items", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify([{
          user_id: uid, item_id: ex.item_id, access_token: ex.access_token,
          institution: institution || "Bank", cursor: null,
        }]),
      }, c);
      return json(200, { ok: true, item_id: ex.item_id, institution });
    }

    // ── 3. sync ────────────────────────────────────────────────────────────
    if (action === "sync") {
      const items = await sb(`plaid_items?user_id=eq.${uid}&select=item_id,access_token,institution,cursor`, {}, c) || [];
      if (!items.length) return json(200, { ok: true, connected: 0, added: 0, removed: 0, accounts: [] });

      let added = 0, removed = 0;
      const accounts = [];
      for (const item of items) {
        const account = item.institution || "Bank";
        let cursor = item.cursor || undefined;
        let more = true, guard = 0;
        // /transactions/sync pages. The guard is a backstop, not a limit: a
        // cursor that never advances would otherwise loop until the function
        // times out and nothing would be written at all.
        while (more && guard++ < 40) {
          const page = await plaid("/transactions/sync", {
            access_token: item.access_token, cursor, count: 500,
          }, c);
          const rows = [...(page.added || []), ...(page.modified || [])]
            .map((t) => mapTx(t, account)).filter(Boolean)
            .map((r) => ({ ...r, user_id: uid }));
          if (rows.length) {
            for (let i = 0; i < rows.length; i += 400) {
              await sb("transactions", {
                method: "POST",
                headers: { Prefer: "resolution=merge-duplicates" },
                body: JSON.stringify(rows.slice(i, i + 400)),
              }, c);
            }
            added += rows.length;
          }
          const gone = (page.removed || []).map((r) => `plaid:${r.transaction_id}`).filter((s) => s !== "plaid:undefined");
          if (gone.length) {
            await sb(`transactions?user_id=eq.${uid}&id=in.(${gone.map((g) => `"${g}"`).join(",")})`, { method: "DELETE" }, c);
            removed += gone.length;
          }
          cursor = page.next_cursor;
          more = !!page.has_more;
          // The cursor is saved after EVERY page, not at the end. A timeout
          // halfway through a first sync would otherwise replay from zero on
          // the next run, forever, for an account with enough history.
          await sb(`plaid_items?user_id=eq.${uid}&item_id=eq.${item.item_id}`, {
            method: "PATCH", body: JSON.stringify({ cursor, synced_at: new Date().toISOString() }),
          }, c);
        }
        accounts.push(account);
      }
      return json(200, { ok: true, connected: items.length, added, removed, accounts });
    }

    // ── 4. what's connected ────────────────────────────────────────────────
    if (action === "status") {
      const items = await sb(`plaid_items?user_id=eq.${uid}&select=item_id,institution,synced_at`, {}, c) || [];
      return json(200, { ok: true, items, env: process.env.PLAID_ENV || "sandbox" });
    }

    // ── 5. disconnect ──────────────────────────────────────────────────────
    if (action === "disconnect") {
      const id = String(body.item_id || "");
      if (!id) return error(400, "item_id missing");
      const rows = await sb(`plaid_items?user_id=eq.${uid}&item_id=eq.${id}&select=access_token`, {}, c) || [];
      // Told to Plaid as well as forgotten here — an item left live keeps
      // pulling from the bank and, on a metered plan, keeps billing.
      if (rows[0]?.access_token) {
        try { await plaid("/item/remove", { access_token: rows[0].access_token }, c); } catch { /* forget it locally regardless */ }
      }
      await sb(`plaid_items?user_id=eq.${uid}&item_id=eq.${id}`, { method: "DELETE" }, c);
      return json(200, { ok: true });
    }

    return error(400, `unknown action "${action}"`);
  } catch (e) {
    // ITEM_LOGIN_REQUIRED is the one every long-lived connection eventually
    // hits (a password change, an MFA prompt) and it is fixed by re-running
    // Link, not by retrying — so it gets its own message rather than "failed".
    if (e.code === "ITEM_LOGIN_REQUIRED") {
      return json(409, { error: "Your bank needs you to sign in again. Reconnect the account.", code: e.code });
    }
    return json(e.status && e.status < 500 ? 400 : 502, { error: e.message || "Plaid request failed", code: e.code });
  }
};
