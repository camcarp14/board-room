// Reports which server-side keys are configured — names only, never values.
exports.handler = async () => {
  const has = (k) => !!process.env[k];
  const services = {
    claude: { configured: has("ANTHROPIC_API_KEY"), needs: ["ANTHROPIC_API_KEY"] },
    // Keep in sync with shopify.js — it moved to the Client Credentials grant
    // (SHOPIFY_SHOP + CLIENT_ID/SECRET) when Shopify retired static admin
    // tokens; checking the old names reported "unconfigured" forever.
    shopify: { configured: has("SHOPIFY_SHOP") && has("SHOPIFY_CLIENT_ID") && has("SHOPIFY_CLIENT_SECRET"), needs: ["SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"] },
    gsc: { configured: has("GSC_CLIENT_EMAIL") && has("GSC_PRIVATE_KEY"), needs: ["GSC_CLIENT_EMAIL", "GSC_PRIVATE_KEY"] },
    deploy: { configured: has("NETLIFY_API_TOKEN"), needs: ["NETLIFY_API_TOKEN"] },
    "db-admin": { configured: has("SUPABASE_URL") && has("SUPABASE_SERVICE_ROLE_KEY"), needs: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] },
    audit: { configured: has("ANTHROPIC_API_KEY"), needs: ["ANTHROPIC_API_KEY"] },
  };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, configured: true, service: "health", services, ts: Date.now() }),
  };
};
