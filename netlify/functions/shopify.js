// Shopify Admin API → orders for the last N days, shaped for the Morning
// Brief card. Uses the Client Credentials grant — Shopify retired
// admin-issued static tokens (shpat_...) on Jan 1, 2026; apps created in the
// Dev Dashboard now only get a Client ID + Secret, exchanged programmatically
// for a 24h access token. See:
// https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens
//
// Needs: SHOPIFY_SHOP (just the *.myshopify.com subdomain, no suffix),
// SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET — all from the Dev Dashboard app's
// Settings page. The exchanged token is cached in memory across warm
// invocations and refreshed automatically once it's close to expiring.
//
// Note: sessions/visits/conversion need Shopify Analytics (Plus or the
// Analytics API), which isn't available via this grant — those fields
// return "—" until that's added. Orders and revenue are fully live.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken(shop, clientId, clientSecret) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const res = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const { access_token, expires_in } = await res.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + (expires_in || 86399) * 1000;
  return cachedToken;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const shop = process.env.SHOPIFY_SHOP;
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
    const res = await fetch(`https://${shop}.myshopify.com/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables: { q: `created_at:>=${prevSince.toISOString()}` } }),
    });
    if (!res.ok) return json(res.status, { error: `Shopify API ${res.status}` });
    const data = await res.json();
    if (data.errors?.length) return json(502, { error: data.errors.map(e => e.message).join("; ") });

    const orders = (data.data?.orders?.edges || []).map(e => e.node);
    const cur = orders.filter(o => new Date(o.createdAt) >= since);
    const prev = orders.filter(o => new Date(o.createdAt) < since);

    const series = Array.from({ length: days }, (_, i) => {
      const dayStart = new Date(Date.now() - (days - i) * 86400000);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      return cur.filter(o => { const t = new Date(o.createdAt); return t >= dayStart && t < dayEnd; }).length;
    });

    const rev = cur.reduce((s, o) => s + parseFloat(o.totalPriceSet?.shopMoney?.amount || 0), 0);
    const delta = cur.length - prev.length;

    return json(200, {
      success: true,
      visits: "—", visitsD: "",
      conv: "—", convD: "",
      orders: String(cur.length),
      ordersD: (delta >= 0 ? "▲ " : "▼ ") + Math.abs(delta),
      series,
      note: `${cur.length} orders / $${rev.toFixed(0)} revenue in the last ${days}d (${delta >= 0 ? "+" : ""}${delta} vs prior ${days}d). Visits/conversion need the Analytics API — orders are live.`,
    });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
