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

const PLAID_ENV = () => (env("PLAID_ENV") || "sandbox").toLowerCase();
const PLAID_HOST = () =>
  PLAID_ENV() === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";

// .trim() is not cosmetic. A key pasted from a dashboard very often carries a
// trailing newline or a leading space, and Plaid rejects it with the same
// "invalid client_id or secret provided" you'd get from a genuinely wrong key —
// so an invisible character and a real mistake are indistinguishable from the
// outside. Trimming removes one of those two possibilities for free.
const env = (k) => String(process.env[k] ?? "").trim();
function cfg() {
  return {
    id: env("PLAID_CLIENT_ID"),
    secret: env("PLAID_SECRET"),
    url: env("SUPABASE_URL"),
    service: env("SUPABASE_SERVICE_ROLE_KEY"),
    owner: env("BOARD_USER_ID"),
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
    const r = await fetch(`${c.url}/auth/v1/user`, { signal: AbortSignal.timeout(8000), headers: { apikey: c.service, Authorization: `Bearer ${token}` } });
    if (!r.ok) return { err: json(401, { error: "session expired — refresh and try again" }) };
    const u = await r.json();
    if (!u?.id) return { err: json(401, { error: "session expired — refresh and try again" }) };
    if (u.id !== c.owner) return { err: json(403, { error: "this account is not allowed to use Board Room" }) };
    return { uid: u.id };
  } catch {
    return { err: json(503, { error: "couldn't verify your session — try again in a moment" }) };
  }
}

async function plaid(path, body, c) {
  const r = await fetch(`${PLAID_HOST()}${path}`, { signal: AbortSignal.timeout(8000),
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
  const r = await fetch(`${c.url}/rest/v1/${path}`, { signal: AbortSignal.timeout(8000), ...init, headers: sbHeaders(c, init?.headers) });
  if (!r.ok) throw new Error(`db: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ─── The mapping. Kept in step with src/features/finances/financeLogic.js ────
// Duplicated rather than imported for the bundling reason at the top of this
// file. THE SIGN IS THE WHOLE POINT: Plaid documents `amount` as POSITIVE when
// money moves OUT, the opposite of every Chase export, so it is negated exactly
// once, here. finance-smoke.mjs asserts the client-side twin of this.
// NULL IS NOT ZERO, and this is the money path. Number(null) is 0 and Number("")
// is 0, both finite, so the obvious version returned a real 0 for an absent
// figure — and every downstream "we don't have a balance for this account"
// guard tests for null, so all of them were dead. A bank that answers with no
// balance (a closed card, an account Plaid could not refresh, an unfunded
// brokerage sub-account) was published as holding exactly $0.00 and summed into
// net worth as a confident zero. `available` and `limit` are legitimately
// absent on most depository accounts, which is how routine this input is.
const toCents = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

// ─── Accounts ────────────────────────────────────────────────────────────────
// /accounts/get is included with Transactions — it is NOT the Balance product,
// which is the paid one that forces a live refresh at the bank. These figures
// are whatever the last transaction refresh saw, which for a personal budget is
// the right trade: free, and a few hours old at worst.
const accountLabel = (a) => {
  const name = String(a?.name || a?.official_name || "Account").trim() || "Account";
  const mask = String(a?.mask || "").trim();
  return mask ? `${name} ••${mask}` : name;
};
function mapAccount(a, institution) {
  const b = a?.balances || {};
  return {
    account_id: String(a?.account_id || ""),
    name: accountLabel(a),
    institution,
    type: String(a?.type || ""),
    subtype: String(a?.subtype || ""),
    // null, not 0, when the bank didn't say. netWorth() counts these as unknown
    // and says so, rather than folding a missing number into the total.
    current_cents: toCents(b.current),
    available_cents: toCents(b.available),
    limit_cents: toCents(b.limit),
    currency: b.iso_currency_code || b.unofficial_currency_code || "USD",
  };
}
/** Every account behind one item, with its balances. Never throws the caller's
 *  sync away: a bank that won't answer this still has transactions worth having. */
async function accountsFor(item, c) {
  const out = await plaid("/accounts/get", { access_token: item.access_token }, c);
  return (out?.accounts || []).map((a) => mapAccount(a, item.institution || "Bank"));
}

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
    // "other" here means UNFILED, not "filed as Other". The column is NOT NULL
    // DEFAULT 'other' and this function cannot run the client's lexicon (the
    // bundling note at the top), so the client's effectiveCategory treats a
    // stored "other" as absent and runs the lexicon at read time — one
    // vocabulary for CSV and sync rows alike. A category_override you set is
    // a separate column and is never touched by a sync.
    category: "other",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return error(405, "POST only");
  const c = cfg();
  if (!c.id || !c.secret) return error(503, "Plaid isn't configured — PLAID_CLIENT_ID and PLAID_SECRET are missing.");
  if (!c.url || !c.service || !c.owner) return error(503, "server owner is not configured");

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
      const balances = [];
      const failed = [];
      for (const item of items) {
        const bank = item.institution || "Bank";
        // ONE BANK'S FAILURE IS ONE BANK'S FAILURE. Without this try, an
        // ITEM_LOGIN_REQUIRED from the first item in PostgREST order threw
        // straight out of the loop, so every bank after it stopped syncing too —
        // and reconnecting after a password change creates a NEW item beside
        // the broken one, so the fresh connection was blocked by the stale row
        // until you found and disconnected it. Auto-sync is silent, so it read
        // as "the numbers stopped updating". The cursor is saved per page below,
        // so a bank that fails mid-way loses nothing; it is named in `failed`
        // and the others carry on, the same way `balances` already does it.
        try {
          // NAME THE ACCOUNT, NOT THE BANK. Every row used to be filed under
          // "Chase", so a card and a checking account at the same bank collapsed
          // into one column and per-account totals meant nothing. Plaid gives each
          // transaction an account_id; this resolves it to "Sapphire ••1234".
          // A bank that won't answer /accounts/get still syncs — it just falls
          // back to the institution name, which is what it did before.
          let byId = {};
          try {
            const mine = await accountsFor(item, c);
            balances.push(...mine);
            byId = Object.fromEntries(mine.map((a) => [a.account_id, a.name]));
          } catch { /* transactions are worth having without balances */ }
          const nameFor = (t) => byId[String(t?.account_id || "")] || bank;
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
              .map((t) => mapTx(t, nameFor(t))).filter(Boolean)
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
          accounts.push(bank);
        } catch (e) {
          failed.push({ institution: bank, code: e.code || null, message: e.message || "sync failed" });
        }
      }
      // Every bank failing is still an error, and the same one as before — the
      // rethrow keeps its code so ITEM_LOGIN_REQUIRED still reaches the 409
      // wording below, and a single-bank install sees exactly what it did.
      if (failed.length && failed.length === items.length) {
        throw Object.assign(new Error(failed[0].message), { code: failed[0].code, status: 400 });
      }
      return json(200, { ok: true, connected: items.length, added, removed, accounts, balances, failed });
    }

    // ── 3a. balances, without a sync ───────────────────────────────────────
    // Separate from sync because they are asked for at different rates: the
    // balance is the thing you check on the way out of the door, and pulling a
    // full transaction page every time you glance at it would be slow and, on a
    // metered plan, billed. This is one /accounts/get per bank and writes
    // nothing — the numbers live in the page and die with it.
    if (action === "balances") {
      const items = await sb(`plaid_items?user_id=eq.${uid}&select=item_id,access_token,institution`, {}, c) || [];
      if (!items.length) return json(200, { ok: true, accounts: [], connected: 0 });
      const out = [];
      const failed = [];
      for (const item of items) {
        try { out.push(...(await accountsFor(item, c))); }
        // One bank being unreachable must not blank the other's balances, so
        // it's named instead of thrown — a partial total that says which part
        // is missing beats an error page.
        catch { failed.push(item.institution || "Bank"); }
      }
      return json(200, { ok: true, connected: items.length, accounts: out, failed });
    }

    // ── 3b. what is actually configured ────────────────────────────────────
    // Shape only, never values: which environment we're talking to and how long
    // each key is. That is enough to spot a truncated paste, a stray newline or
    // a client_id and secret swapped round, and it leaks nothing — the whole
    // point of the keys living in here is that they never come back out.
    if (action === "diag") {
      // ASK BOTH ENVIRONMENTS. Shape alone can only say "well-formed", which is
      // where this got stuck: 24 and 30 characters, both correct, and still
      // rejected — leaving "probably the wrong environment" as a guess the user
      // has to act on. Plaid will answer the question directly, so ask it.
      //
      // /institutions/get is the cheapest call that authenticates: it needs the
      // client_id and secret, touches no Item, creates nothing and bills
      // nothing. A 200 from a host means the keys ARE that host's keys.
      const probe = async (host) => {
        try {
          const r = await fetch(`${host}/institutions/get`, { signal: AbortSignal.timeout(8000),
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: c.id, secret: c.secret, count: 1, offset: 0, country_codes: ["US"] }),
          });
          if (r.ok) return "accepted";
          const d = await r.json().catch(() => ({}));
          return d?.error_code || `HTTP ${r.status}`;
        } catch { return "unreachable"; }
      };
      const [production, sandbox] = await Promise.all([
        probe("https://production.plaid.com"),
        probe("https://sandbox.plaid.com"),
      ]);
      const worksIn = production === "accepted" ? "production" : sandbox === "accepted" ? "sandbox" : null;
      return json(200, {
        ok: true,
        env: PLAID_ENV(),
        host: PLAID_HOST(),
        clientIdLength: c.id.length,
        secretLength: c.secret.length,
        // Plaid's client_id is 24 hex characters; a secret is 30. Wrong lengths
        // are almost always a swap or a partial copy.
        looksLikeClientId: /^[a-f0-9]{24}$/i.test(c.id),
        looksLikeSecret: /^[a-f0-9]{30}$/i.test(c.secret),
        probe: { production, sandbox },
        worksIn,
        // The whole point: a fact, not a hypothesis.
        mismatch: !!worksIn && worksIn !== PLAID_ENV(),
      });
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
      // pulling from the bank and, on a metered plan, keeps billing. And the
      // order matters: PLAID FIRST, AND ONLY THEN THE ROW. This used to swallow
      // a failed /item/remove and delete the token anyway, so a timeout or a
      // Plaid 5xx left the connection live at the bank with the only copy of
      // the access_token gone — nothing left to retry the removal with, while
      // the app said "disconnected" and privacy.html promised revocation.
      // The one failure that IS safe to forget through is Plaid saying the
      // Item no longer exists: it has already been removed (or the bank pulled
      // access), so there is nothing to revoke and keeping the row would leave
      // a bank you can never disconnect.
      if (rows[0]?.access_token) {
        try {
          await plaid("/item/remove", { access_token: rows[0].access_token }, c);
        } catch (e) {
          const alreadyGone = e.code === "ITEM_NOT_FOUND" || e.code === "INVALID_ACCESS_TOKEN";
          if (!alreadyGone) {
            return json(502, { error: "Couldn't reach Plaid to revoke the connection — nothing was changed. Try disconnecting again.", code: e.code });
          }
        }
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
    // THE ONE EVERY FIRST SETUP HITS. Plaid issues a SEPARATE SECRET PER
    // ENVIRONMENT — the Keys page shows a Sandbox secret and a Production
    // secret, and they are not interchangeable. Using the sandbox one against
    // production.plaid.com returns exactly this, and Plaid's own message
    // ("invalid client_id or secret provided") names neither the environment
    // nor the mismatch, so it reads as "your keys are wrong" when the keys are
    // usually fine and only pointed at the wrong host.
    if (e.code === "INVALID_API_KEYS" || /invalid client_id or secret/i.test(e.message || "")) {
      return json(400, {
        error: `Plaid rejected the keys for the ${PLAID_ENV()} environment. Plaid issues a different secret for Sandbox and for Production — check PLAID_SECRET is the ${PLAID_ENV()} one, and that PLAID_ENV matches where your keys came from.`,
        code: "INVALID_API_KEYS", env: PLAID_ENV(),
      });
    }
    return json(e.status && e.status < 500 ? 400 : 502, { error: e.message || "Plaid request failed", code: e.code });
  }
};
