// Discord interactions endpoint. Discord POSTs slash commands here.
// Must (1) verify the Ed25519 signature, (2) ACK within 3s. The real board work
// runs in the background function, which edits the deferred message when done.
// Env: DISCORD_PUBLIC_KEY (from your Discord app), plus URL below must match your site.
//      INTERNAL_WORKER_SECRET — any long random string, set to the SAME value on
//      board-work-background. This front door is signed by Discord, but the hop
//      from here to the worker used to be open to the whole internet; see the
//      gate comment in board-work-background.js for what that exposed.
import nacl from "tweetnacl";

export default async (req) => {
  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  const body = await req.text();
  const { DISCORD_PUBLIC_KEY } = process.env;
  if (!DISCORD_PUBLIC_KEY) return new Response("Missing DISCORD_PUBLIC_KEY", { status: 500 });

  // Signature verification — Discord rejects endpoints that skip this.
  const valid = signature && timestamp && nacl.sign.detached.verify(
    Buffer.from(timestamp + body),
    Buffer.from(signature, "hex"),
    Buffer.from(DISCORD_PUBLIC_KEY, "hex")
  );
  if (!valid) return new Response("invalid request signature", { status: 401 });

  const interaction = JSON.parse(body);

  // PING → PONG (Discord's endpoint validation)
  if (interaction.type === 1) return Response.json({ type: 1 });

  // Slash command → defer, hand off to the background worker
  if (interaction.type === 2) {
    // The worker fails closed without the shared secret, and a deferred
    // interaction it never answers is a "thinking…" that hangs forever with
    // nothing anywhere saying why. Answer immediately instead and name the
    // variable — a missing config should be a sentence, not a spinner.
    const workerSecret = process.env.INTERNAL_WORKER_SECRET;
    if (!workerSecret) {
      return Response.json({ type: 4, data: { content: "The board worker isn't configured — set INTERNAL_WORKER_SECRET on the site (same value on discord-board and board-work-background)." } });
    }
    const question = interaction.data?.options?.find(o => o.name === "question")?.value || "What should I know right now?";
    // Same reasoning: the worker bounds the question at 2000 characters, and a
    // rejection over there is invisible over here. Say it now rather than defer
    // into a spinner that never resolves. Not truncated on purpose — answering
    // half of somebody's question is worse than declining it.
    if (typeof question !== "string" || question.length > 2000) {
      return Response.json({ type: 4, data: { content: "That question is too long for the board — keep it under 2000 characters." } });
    }
    // Fire the background function (don't await completion — it outlives this request)
    const base = process.env.URL || `https://${req.headers.get("host")}`;
    fetch(`${base}/.netlify/functions/board-work-background`, { signal: AbortSignal.timeout(8000),
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-worker-secret": workerSecret },
      body: JSON.stringify({ question, application_id: interaction.application_id, token: interaction.token }),
    }).catch(() => {});
    // Type 5 = deferred — Discord shows "thinking…" until the worker edits it
    return Response.json({ type: 5 });
  }

  return Response.json({ type: 4, data: { content: "Unsupported interaction." } });
};
