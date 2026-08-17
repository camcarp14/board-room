// ─── Live site snapshot ────────────────────────────────────────────────────
// Board seats previously only ever saw their static charter + whatever you
// typed — no live BTC price, stocks, calendar, nothing from the rest of the
// app. Pages write their data in here as it loads; convene()/consultSeat()
// read it back out into a compact context block. Module-level on purpose —
// this is a single-instance app, and it avoids threading every page's state
// through the whole component tree just so the chat can see it.
const siteSnapshot = { btc: null, stocks: null, wire: null, todayEvents: null, todayBirthdays: null, clarify: null, zts: null, shopify: null, gsc: null, updatedAt: null };

// Persisted so the Brief can paint last-known market/pipeline data instantly on
// reopen (instead of skeletons), and so the board seats have real numbers even
// before the Brief tab has been opened this session. Hydrated once on load.
const SNAP_LS = "br_snapshot";
try {
  const saved = JSON.parse(localStorage.getItem(SNAP_LS) || "null");
  if (saved && typeof saved === "object") Object.assign(siteSnapshot, saved);
} catch { /* ignore */ }

export function getSnapshot() { return { ...siteSnapshot }; }

export function updateSnapshot(patch) {
  Object.assign(siteSnapshot, patch, { updatedAt: Date.now() });
  try { localStorage.setItem(SNAP_LS, JSON.stringify(siteSnapshot)); } catch { /* storage full/unavailable */ }
}

// Which live venture numbers each board seat should automatically see, so an
// advisor speaks to current reality instead of asking Cameron to paste figures.
// Macro/career lean on the general markets block already in every seat prompt.
const SEAT_VENTURE = {
  clarify: ["clarify"],
  zts: ["zts", "shopify", "gsc"],
  ops: ["clarify", "zts", "shopify", "gsc"],
  macro: [],
  career: [],
};
export function formatSnapshotForSeat(seatKey) {
  const general = formatSnapshotForChat();
  const wants = SEAT_VENTURE[seatKey] || [];
  const lines = [];
  const c = siteSnapshot.clarify;
  if (wants.includes("clarify") && c) lines.push(`Clarify outreach pipeline: ${c.prospected ?? "—"} prospected, ${c.drafts ?? "—"} drafts, ${c.sent ?? "—"} sent, ${c.replied ?? "—"} replied`);
  const z = siteSnapshot.zts;
  if (wants.includes("zts") && z) lines.push(`Zero To Secure creator pipeline: ${z.prospected ?? "—"} prospected, ${z.sent ?? "—"} sent, ${z.replied ?? "—"} replied, ${z.collab ?? "—"} collabs`);
  const s = siteSnapshot.shopify;
  if (wants.includes("shopify") && s) lines.push(`ZTS Shopify store (last 14d): ${s.orders ?? "—"} orders, ${s.visits ?? "—"} visits`);
  const g = siteSnapshot.gsc;
  if (wants.includes("gsc") && g) lines.push(`ZTS Search Console (last 14d): ${g.impressions ?? "—"} impressions, ${g.clicks ?? "—"} clicks, avg position ${g.pos ?? "—"}`);
  if (!lines.length) return general;
  return `${general}\n\nYour venture's live numbers (as of the last Brief refresh — treat as current):\n${lines.join("\n")}`;
}
// ─── nothing in this block may invent a reading ──────────────────────────────
// What this function builds is not a card, it is the "Live site data … treat as
// current, not something to caveat" paragraph pasted into the system prompt of
// every seat and every convene. So a placeholder here does not render as an
// em-dash a reader can discount — it is stated to a model as fact, and the model
// reasons from it and says it back with confidence. Two of them were being
// stated, and both are the same failure the panels are careful about everywhere
// else: printing a number for a thing that was never measured.
export function formatSnapshotForChat() {
  const parts = [];
  const b = siteSnapshot.btc;
  if (b && b.price) {
    // `b.changePct >= 0` is TRUE FOR NULL — null coerces to 0 — so an unknown 24h
    // move took the "+" branch and `(null || 0).toFixed(1)` printed "0.0". The
    // board was told bitcoin was exactly flat on the day, which is a claim, not a
    // gap. The price is known on this path and the change may not be; they are
    // reported separately now, and the unknown one is simply not reported.
    const chg = typeof b.changePct === "number" && Number.isFinite(b.changePct) ? b.changePct : null;
    parts.push(`Bitcoin: $${Math.round(b.price).toLocaleString()}`
      + (chg == null ? " (24h change not available)" : `, ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% 24h`));
  }
  const s = siteSnapshot.stocks;
  if (s) {
    // GOLD WAS THE GATE FOR ALL FOUR TICKERS. One `if` on gold's value, then a
    // line that interpolated `s.nvda?.value` and two more with no test of their
    // own — so a pass where gold resolved and NVDA did not sent the string
    // "NVDA undefined" into the prompt. Each ticker now stands or falls on its
    // own reading, and the line is dropped entirely when none of them has one.
    const named = [["Gold", s.gold], ["NVDA", s.nvda], ["MSTR", s.mstr], ["STRC", s.strc]]
      .filter(([, q]) => q && q.value != null && q.value !== "—" && q.value !== "")
      .map(([name, q]) => `${name} ${q.value}`);
    if (named.length) parts.push(`Markets: ${named.join(", ")}`);
  }
  const w = siteSnapshot.wire;
  if (w && w.length) parts.push(`Recent wire headlines: ${w.slice(0, 3).map(x => x.text).join(" / ")}`);
  const ev = siteSnapshot.todayEvents;
  if (ev && ev.length) parts.push(`On the calendar soon: ${ev.slice(0, 3).map(e => e.title).join(", ")}`);
  const bd = siteSnapshot.todayBirthdays;
  if (bd && bd.length) parts.push(`Birthdays coming up: ${bd.slice(0, 3).map(x => x.name).join(", ")}`);
  if (!parts.length) return "";
  const ageMin = siteSnapshot.updatedAt ? Math.round((Date.now() - siteSnapshot.updatedAt) / 60000) : null;
  return `\n\nLive site data (as of ${ageMin != null ? ageMin + " min ago" : "just now"} — treat as current, not something to caveat):\n${parts.join("\n")}`;
}
