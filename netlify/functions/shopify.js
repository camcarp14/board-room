// Shopify Admin API → orders + site sessions for the last N days, shaped
// for the Morning Brief card. Uses the Client Credentials grant — Shopify
// retired admin-issued static tokens (shpat_...) on Jan 1, 2026; apps
// created in the Dev Dashboard now only get a Client ID + Secret,
// exchanged programmatically for a 24h access token. See:
// https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens
//
// Needs: SHOPIFY_SHOP (just the *.myshopify.com subdomain, no suffix),
// SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET — all from the Dev Dashboard app's
// Settings page. The exchanged token is cached in memory across warm
// invocations and refreshed automatically once it's close to expiring.
//
// Visits/conversion use ShopifyQL (shopifyqlQuery), Shopify's own analytics
// engine exposed through the Admin API — this needs the app's scopes to
// include `read_reports`. If the app was authorized before that scope was
// added, you'll need to: Dev Dashboard → your app → add read_reports to a
// new version → release it → reinstall on the store (Home → Install app)
// so the client-credentials token actually carries the new scope. If
// Shopify's protected-customer-data review blocks this for your app, this
// falls back to showing orders/revenue only, with a clear reason why —
// not a fabricated number.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let cachedToken = null;
let tokenExpiresAt = 0;

function normalizeShop(raw) {
  return (raw || "").trim().replace(/^https?:\/\//, "").replace(/\.myshopify\.com\/?$/, "").replace(/\/$/, "");
}

async function getToken(shop, clientId, clientSecret) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const res = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = raw;
    try { const j = JSON.parse(raw); detail = j.error_description || j.error || raw; } catch {}
    throw new Error(`token exchange failed (${res.status}) for shop "${shop}": ${detail || "no detail returned — check SHOPIFY_SHOP is just the subdomain, and that the app is installed on this store"}`);
  }
  const { access_token, expires_in } = await res.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + (expires_in || 86399) * 1000;
  return cachedToken;
}

async function shopifyGraphQL(shop, token, query, variables) {
  const res = await fetch(`https://${shop}.myshopify.com/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify API ${res.status}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join("; "));
  return data.data;
}

// Runs a ShopifyQL query with no GROUP BY / TIMESERIES, so it returns a
// single totals row, and returns it as {metricName: value} using the
// response's own column metadata rather than assuming positional order.
async function shopifyqlTotals(shop, token, ql) {
  const data = await shopifyGraphQL(shop, token, `query($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }`, { q: ql });
  const r = data.shopifyqlQuery;
  if (r?.parseErrors?.length) throw new Error(`ShopifyQL: ${r.parseErrors.join("; ")}`);
  const row = r?.tableData?.rows?.[0];
  if (!row) return {};
  const cols = r.tableData.columns.map(c => c.name);
  return Object.fromEntries(cols.map((name, i) => [name, row[i]]));
}

const fmtDate = (d) => d.toISOString().slice(0, 10);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const shop = normalizeShop(process.env.SHOPIFY_SHOP);
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const configured = !!(shop && clientId && clientSecret);

  if (body.ping) return json(200, { success: true, service: "shopify", configured, missing: configured ? undefined : "SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET" });
  if (!configured) return json(500, { error: "Shopify env vars not set" });

  const days = Math.min(body.days || 14, 60);
  const since = new Date(Date.now() - days * 86400000);
  const prevSince = new Date(Date.now() - 2 * days * 86400000);

  try {
    const token = await getToken(shop, clientId, clientSecret);
    const query = `query Orders($q: String!) {
      orders(first: 250, query: $q, sortKey: CREATED_AT) {
        edges { node { createdAt totalPriceSet { shopMoney { amount } } } }
      }
    }`;
    const data = await shopifyGraphQL(shop, token, query, { q: `created_at:>='${prevSince.toISOString()}'` });

    const orders = (data.orders?.edges || []).map(e => e.node);
    const cur = orders.filter(o => new Date(o.createdAt) >= since);
    const prev = orders.filter(o => new Date(o.createdAt) < since);

    const series = Array.from({ length: days }, (_, i) => {
      const dayStart = new Date(Date.now() - (days - i) * 86400000);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      return cur.filter(o => { const t = new Date(o.createdAt); return t >= dayStart && t < dayEnd; }).length;
    });

    const rev = cur.reduce((s, o) => s + parseFloat(o.totalPriceSet?.shopMoney?.amount || 0), 0);
    const delta = cur.length - prev.length;

    // Visits/conversion via ShopifyQL — needs the read_reports scope. If
    // it's missing, or the account isn't approved for it, this fails
    // independently of the order data above, which stays live either way.
    let visits = "—", visitsD = "", conv = "—", convD = "", visitsNote = null;
    try {
      const curT = await shopifyqlTotals(shop, token, `FROM sessions SHOW online_store_visitors, conversion_rate WHERE human_or_bot_session = 'human' WITH TOTALS SINCE ${fmtDate(since)} UNTIL today`);
      const prevT = await shopifyqlTotals(shop, token, `FROM sessions SHOW online_store_visitors WHERE human_or_bot_session = 'human' WITH TOTALS SINCE ${fmtDate(prevSince)} UNTIL ${fmtDate(since)}`);
      const curVisits = Number(curT.online_store_visitors) || 0;
      const prevVisits = Number(prevT.online_store_visitors) || 0;
      visits = curVisits.toLocaleString();
      visitsD = prevVisits ? `${curVisits >= prevVisits ? "▲" : "▼"} ${Math.abs(Math.round(((curVisits - prevVisits) / prevVisits) * 100))}%` : "";
      const rate = Number(curT.conversion_rate);
      conv = isNaN(rate) ? "—" : (rate * (rate <= 1 ? 100 : 1)).toFixed(1) + "%"; // handle either fraction or already-percent
    } catch (e) {
      visitsNote = e.message.includes("access denied") || e.message.includes("scope")
        ? "needs the read_reports scope — add it in Dev Dashboard, release, and reinstall the app"
        : `visits unavailable: ${e.message}`;
    }

    return json(200, {
      success: true,
      visits, visitsD, conv, convD,
      orders: String(cur.length),
      ordersD: (delta >= 0 ? "▲ " : "▼ ") + Math.abs(delta),
      series,
      note: visitsNote
        ? `${cur.length} orders / $${rev.toFixed(0)} revenue in the last ${days}d (${delta >= 0 ? "+" : ""}${delta} vs prior ${days}d). ${visitsNote}.`
        : `${cur.length} orders / $${rev.toFixed(0)} revenue, ${visits} visits (${conv} conversion) in the last ${days}d.`,
    });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
