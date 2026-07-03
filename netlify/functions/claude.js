// Generic Claude proxy — the web app calls this instead of hitting Anthropic
// directly, so the API key stays server-side. Env: ANTHROPIC_API_KEY.
export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const { ANTHROPIC_API_KEY } = process.env;
  if (!ANTHROPIC_API_KEY) return Response.json({ error: "Missing ANTHROPIC_API_KEY env var on this site" }, { status: 500 });
  try {
    const body = await req.text();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body,
    });
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};
