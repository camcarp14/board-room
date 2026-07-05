// Reports which server-side keys are configured — names only, never values.
exports.handler = async () => {
  const has = (k) => !!process.env[k];
  const services = {
    claude: { configured: has("ANTHROPIC_API_KEY"), needs: ["ANTHROPIC_API_KEY"] },
    shopify: { configured: has("SHOPIFY_STORE_DOMAIN") && has("SHOPIFY_ADMIN_TOKEN"), needs: ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN"] },
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
