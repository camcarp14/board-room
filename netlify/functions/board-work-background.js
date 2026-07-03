// Background worker ("-background" suffix = Netlify gives it up to 15 minutes).
// Runs the full board convening server-side, then edits Discord's deferred message.
// Env: ANTHROPIC_API_KEY. Board charters are duplicated here so the function is
// self-contained (serverless functions can't import from src/).

const HAIKU = "claude-haiku-4-5-20251001";

const BOARD = [
  { key: "clarify", name: "Clarify Lead", charter: "You run Clarify Paid Search — a boutique Google Ads agency targeting high-value local service verticals (legal, med spa, dental, home services). You own the outreach pipeline, client delivery, and agency growth. You think in pipeline value, reply rates, and retainer economics. Direct about what will and won't move revenue.", domains: "agency, outreach, paid search, Google Ads, clients, prospecting, Clarify" },
  { key: "zts", name: "ZTS Lead", charter: "You run Zero To Secure — a premium stainless-steel seed phrase backup kit ($150, DTC Shopify). You own creator collabs, YouTube Shorts production, SEO content, and conversion. You think in audience-fit reach, content cadence, and DTC unit economics.", domains: "ZTS, Zero To Secure, creators, YouTube, Shorts, SEO, Shopify, ecommerce, Bitcoin product" },
  { key: "macro", name: "Macro Strategist", charter: "You are the markets and macro seat. Cameron holds long-term Bitcoin conviction with a leveraged WBTC position on Aave he manages carefully, and a developed AI-bubble thesis. Your job is honest pressure-testing, never validation. Flag risk asymmetries.", domains: "markets, macro, Bitcoin, BTC, crypto, investing, trading, Fed, positions, portfolio" },
  { key: "ops", name: "Ops & Finance", charter: "You are the operations and finance seat across all ventures. You watch time allocation, spend, and whether effort matches expected return. Cameron's goal: decouple income from hours sold. You ask 'is this the best use of the next 10 hours?'", domains: "operations, priorities, time, spend, budget, focus, tradeoffs, planning, week" },
  { key: "career", name: "Career Advisor", charter: "You are the career seat. Cameron is a Senior Analyst in paid search at Ovative Group with limited upward mobility; identified path is RevOps Manager at a mid-size SaaS company within ~2 years. You weigh day-job moves against the ventures without romanticizing either.", domains: "career, Ovative, job, RevOps, Salesforce, promotion, resume, interviews, work" },
];
const CHIEF = "You are the Chief of Staff for Cameron's board room — the single point above five specialist seats. Direct, synthesizing, honest — pressure-testing over validation. When seats conflict, name the conflict. You are replying inside Discord: keep it under 1800 characters, plain text.";

async function claude(system, userContent, maxTokens = 700) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: HAIKU, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] }),
  });
  const data = await res.json();
  return data.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
}

export default async (req) => {
  const { question, application_id, token } = await req.json();
  let answer;
  try {
    // 1. Route
    const routeRaw = await claude(
      `You are a router. Seats: ${BOARD.map(b => `${b.key}: ${b.domains}`).join("; ")}. Respond ONLY JSON: {"seats":["key",...]}. 0 seats if the Chief alone suffices; fewer is better.`,
      question, 100
    );
    let seats = [];
    try { seats = (JSON.parse(routeRaw.replace(/```json|```/g, "").trim()).seats || []).filter(k => BOARD.some(b => b.key === k)); } catch {}

    // 2. Fan out in parallel
    const takes = await Promise.all(seats.map(async (k) => {
      const seat = BOARD.find(b => b.key === k);
      const take = await claude(`${seat.charter}\nGive your seat's take to the Chief of Staff: 2-4 sentences, include disagreement or risk. No preamble.`, question, 250);
      return take ? `[${seat.name}]: ${take}` : null;
    }));
    const board = takes.filter(Boolean).join("\n\n");

    // 3. Synthesize
    answer = await claude(
      CHIEF + (board ? `\n\nBoard takes:\n${board}\n\nSynthesize with attribution; surface conflicts; end with YOUR recommendation.` : ""),
      question, 600
    );
    if (seats.length) answer = `*Consulted: ${seats.map(k => BOARD.find(b => b.key === k).name).join(", ")}*\n\n${answer}`;
  } catch (e) {
    answer = `The board couldn't convene: ${e.message}`;
  }

  // 4. Edit the deferred Discord message
  await fetch(`https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: (answer || "No answer produced.").slice(0, 1990) }),
  });
  return new Response("ok");
};
