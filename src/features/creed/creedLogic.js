// ─── Creed intelligence ───────────────────────────────────────────────────────
// Everything that makes the Creed more than a list of strings, as pure
// functions — same discipline as groceryLogic.js, and for the same reason:
// every way this can be wrong is a wrong-but-plausible answer (the day's line
// changing when you reload, a quote's attribution swallowed into its body)
// rather than a crash. Asserted end-to-end by scripts/creed-smoke.mjs.
//
// THE CONSTRAINT THAT SHAPED THIS: `affirmations` has id, user_id, text, kind,
// created_at, updated_at, and this repo applies SQL by hand. But `kind` is a
// free-text column with a default — so adding a whole new sort of entry costs
// nothing. Every kind below is a value that column can already hold, today,
// with no migration and no backfill. An old row whose kind this file has never
// heard of falls back to Creed rather than vanishing from the list.

/**
 * What you can put in this room.
 *
 * Five kinds, because they answer five different questions and the answers
 * motivate differently. A creed is what you hold when the week says otherwise;
 * a proof is the receipt that stops the creed being a slogan; a goal is the
 * direction; a quote is someone else's words doing work yours can't today; a
 * why is the person it's all for. Collapsing them into "notes" is how a wall
 * of inspiration becomes a wall of text.
 *
 * `tone` drives the dot, the plate's seal and the filter pill, so a glance down
 * the list reads as categories rather than one column of sentences.
 */
export const KINDS = [
  {
    key: "creed", label: "Creed", blurb: "what I hold true", tone: "var(--accent)",
    plate: "Creed",
    prompt: "Something you hold true — present tense, and yours.",
    hint: "Present tense. \"I build things that outlive the hours.\"",
  },
  {
    key: "proof", label: "Proof", blurb: "what I've actually done", tone: "var(--green)",
    plate: "Proof",
    prompt: "Something real you built or did — a receipt.",
    hint: "A fact, not a feeling. Worth grounded in evidence holds better.",
  },
  {
    key: "goal", label: "Goal", blurb: "what I'm going for", tone: "var(--amber)",
    plate: "Goal",
    prompt: "Where you're headed. Concrete beats grand.",
    hint: "Something you'd know you'd hit. Dates and numbers are allowed.",
  },
  {
    key: "quote", label: "Quote", blurb: "someone else's words", tone: "var(--purple)",
    plate: "Quote",
    prompt: "The line — then a new line starting with — for who said it.",
    hint: "End with a line like \"— Marcus Aurelius\" and it renders as an attribution.",
  },
  {
    key: "why", label: "Why", blurb: "who this is for", tone: "var(--pink)",
    plate: "Why",
    prompt: "Who or what this is all in service of.",
    hint: "The answer to \"why keep going\" on the day it stops being obvious.",
  },
];

const BY_KEY = Object.fromEntries(KINDS.map((k) => [k.key, k]));
/** Unknown kinds degrade to Creed. A row written by an older build — or by
 *  hand in the SQL editor — must still render, not disappear. */
export const kindMeta = (key) => BY_KEY[key] || BY_KEY.creed;

/**
 * A quote split into its words and who said them.
 *
 * The attribution is the LAST line beginning with an em/en dash or a hyphen,
 * which is how people already type one — no column, no second field, and a
 * quote typed without one just comes back with author: "". Anchored to the
 * last LINE rather than the last dash so a line that merely contains a dash
 * ("work — then rest — then work") keeps all of itself.
 *
 * Only meaningful for kind "quote"; everything else passes through untouched,
 * because a creed that happens to end in a dashed clause is not an attribution.
 */
export function splitQuote(text) {
  const raw = String(text ?? "").trim();
  const lines = raw.split("\n");
  if (lines.length < 2) return { body: raw, author: "" };
  const last = lines[lines.length - 1].trim();
  const m = last.match(/^[—–-]\s*(.+)$/);
  if (!m || !m[1].trim()) return { body: raw, author: "" };
  return { body: lines.slice(0, -1).join("\n").trim(), author: m[1].trim() };
}

/**
 * The line for today — the same one all day, a different one tomorrow.
 *
 * A room you open for grounding should not reshuffle every time you glance at
 * it: "today's line" is only a thing if it holds still for a day. So the index
 * is derived from the date rather than from a clock or a random, which also
 * makes it identical on your phone and your laptop without storing anything.
 *
 * The hash is deliberately trivial — it only has to spread consecutive days
 * across the list, and a date string is the least adversarial input there is.
 * `dateKey` is passed in rather than read from the clock so this stays pure.
 */
export function dailyIndex(count, dateKey) {
  const n = Math.max(0, count | 0);
  if (n < 2) return 0;
  const s = String(dateKey ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % n;
}

/** Local calendar day as a stable key. Local, not UTC: "today's line" should
 *  change when your day does, not at 6pm. */
export const dayKey = (d) => {
  const x = d instanceof Date ? d : new Date();
  return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
};

/** How many of each kind — the numbers on the filter pills. `""` is the total. */
export function countsByKind(rows) {
  const out = { "": 0 };
  for (const k of KINDS) out[k.key] = 0;
  for (const r of rows || []) {
    out[""] += 1;
    const key = kindMeta(r.kind).key;
    out[key] += 1;
  }
  return out;
}

/** The list as filtered by the pills. "" means everything. */
export const filterByKind = (rows, kind) =>
  (rows || []).filter((r) => !kind || kindMeta(r.kind).key === kind);

/**
 * Starters, per kind — what the room offers when it's empty.
 *
 * Deliberately specific rather than generic inspiration: a starter you'd
 * actually keep beats one you'd delete, and a blank textarea under the words
 * "carve your own" is where most of these rooms die.
 */
export const STARTERS = {
  creed: [
    "My worth is not this week's output.",
    "I build things that outlive the hours I put into them.",
    "Pressure means I'm playing a real game, with real stakes, by choice.",
    "I would rather be early and wrong than late and certain.",
  ],
  proof: [
    "Built Zero To Secure from an idea into a real product with real customers.",
    "Shipped something I was afraid to ship, and it held.",
  ],
  goal: [
    "One venture profitable enough that the others are a choice.",
    "Ship something every week I'd be happy to show a stranger.",
  ],
  quote: [
    "The impediment to action advances action. What stands in the way becomes the way.\n— Marcus Aurelius",
    "It is not the critic who counts.\n— Theodore Roosevelt",
  ],
  why: [
    "So the people who count on me never have to wonder whether I'll be there.",
    "So the work I leave behind is worth having my name on.",
  ],
};
