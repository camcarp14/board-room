// ─── Live site snapshot ────────────────────────────────────────────────────
// Board seats previously only ever saw their static charter + whatever you
// typed — no live BTC price, stocks, calendar, nothing from the rest of the
// app. Pages write their data in here as it loads; convene()/consultSeat()
// read it back out into a compact context block. Module-level on purpose —
// this is a single-instance app, and it avoids threading every page's state
// through the whole component tree just so the chat can see it.
const siteSnapshot = { btc: null, stocks: null, wire: null, todayEvents: null, todayBirthdays: null, updatedAt: null };
export function updateSnapshot(patch) {
  Object.assign(siteSnapshot, patch, { updatedAt: Date.now() });
}
export function formatSnapshotForChat() {
  const parts = [];
  const b = siteSnapshot.btc;
  if (b && b.price) parts.push(`Bitcoin: $${Math.round(b.price).toLocaleString()}, ${b.changePct >= 0 ? "+" : ""}${(b.changePct || 0).toFixed(1)}% 24h`);
  const s = siteSnapshot.stocks;
  if (s && s.spx?.value !== "—") parts.push(`Stocks: S&P FUT ${s.spx.value}, NASDAQ FUT ${s.ndq.value}, 10Y ${s.tnx.value}, DXY ${s.dxy.value}`);
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
