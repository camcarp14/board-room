// Discord interactions endpoint. Discord POSTs slash commands here.
// Must (1) verify the Ed25519 signature, (2) ACK within 3s. The real board work
// runs in the background function, which edits the deferred message when done.
// Env: DISCORD_PUBLIC_KEY (from your Discord app), plus URL below must match your site.
// The hand-off to board-work-background is HMAC-signed (x-board-sig) so that
// endpoint only accepts work dispatched from here — unauthenticated it would
// let anyone exfiltrate chat memory to their own webhook and spend the
// Anthropic key. Key: INTERNAL_FN_SECRET if set, else DISCORD_PUBLIC_KEY.
import nacl from "tweetnacl";
import { createHmac } from "node:crypto";

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
    const question = interaction.data?.options?.find(o => o.name === "question")?.value || "What should I know right now?";
    const base = process.env.URL || `https://${req.headers.get("host")}`;
    const payload = JSON.stringify({ question, application_id: interaction.application_id, token: interaction.token });
    const sig = createHmac("sha256", process.env.INTERNAL_FN_SECRET || DISCORD_PUBLIC_KEY).update(payload).digest("hex");
    // AWAIT the dispatch: a "-background" function ACKs with 202 in
    // milliseconds before doing the work, and NOT awaiting meant Lambda could
    // freeze this container the instant the type-5 response returned — the
    // outbound request was sometimes never sent and Discord showed
    // "thinking…" forever.
    const dispatched = await fetch(`${base}/.netlify/functions/board-work-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-board-sig": sig },
      body: payload,
    }).then(r => r.ok || r.status === 202).catch(() => false);
    if (!dispatched) return Response.json({ type: 4, data: { content: "The board couldn't be reached — try again in a moment." } });
    // Type 5 = deferred — Discord shows "thinking…" until the worker edits it
    return Response.json({ type: 5 });
  }

  return Response.json({ type: 4, data: { content: "Unsupported interaction." } });
};
