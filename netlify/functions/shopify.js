// Shopify Admin API → orders for the last N days, shaped for the Morning Brief
// card. Needs: SHOPIFY_STORE_DOMAIN (e.g. zero-to-secure.myshopify.com) and
// SHOPIFY_ADMIN_TOKEN (Admin API access token with read_orders scope).
// Note: sessions/visits/conversion require Shopify Analytics (ShopifyQL, Plus
// or the new Analytics API) — those fields return "—" until you add that.
const json = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const configured = !!(domain && token);

  if (body.ping) return json(200, { success: true, service: "shopify", configured, missing: configured ? undefined : "SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN" });
  if (!configured) return json(500, { error: "Shopify env vars not set" });

  const days = Math.min(body.days || 14, 60);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const prevSince = new Date(Date.now() - 2 * days * 86400000).toISOString();

  try {
    // Pull up to 250 orders covering both windows (fine at current volume).
    const url = `https://${domain}/admin/api/2024-10/orders.json?status=any&created_at_min=${encodeURIComponent(prevSince)}&limit=250&fields=created_at,total_price`;
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (!res.ok) return json(res.status, { error: `Shopify API ${res.status}` });
    const data = await res.json();
    const orders = data.orders || [];

    const cur = orders.filter(o => o.created_at >= since);
    const prev = orders.filter(o => o.created_at < since);

    // Daily series for the bar chart
    const series = Array.from({ length: days }, (_, i) => {
      const dayStart = new Date(Date.now() - (days - i) * 86400000);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      return cur.filter(o => { const t = new Date(o.created_at); return t >= dayStart && t < dayEnd; }).length;
    });

    const rev = cur.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const delta = cur.length - prev.length;

    return json(200, {
      success: true,
      visits: "—", visitsD: "",           // needs Shopify Analytics API
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
