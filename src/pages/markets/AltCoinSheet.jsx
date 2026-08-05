// ─── Alt coin sheet — one coin, the levels you'd act on ──────────────────────
// Opened from the radar, the movers and the board, so it renders from whichever
// shape it was handed: a screened board row (score, band, facts, hourly
// targets), an open flag episode (FROZEN targets — the ones the log is graded
// against), or both. When both exist the episode's targets win: a fresher
// hourly pass does not move the levels a flag is being judged by.
import { Sheet, Button, Delta } from "../../ui/kit.jsx";
import { NumTween } from "../../ui/primitives.jsx";
import { T } from "../../theme.js";

/* ── tone vocabulary — lives in this leaf so AltSeasonPanel can import it
      without making the module graph circular ─────────────────────────────── */
export const BAND_TONE = {
  starting: T.green, underway: T.blue, warming: T.amber,
  quiet: T.faint, cold: T.faint, late: T.red,
};
export const TIER_META = {
  igniting: { label: "Igniting", tone: T.green },
  building: { label: "Building", tone: T.amber },
};
// Text, not emoji — the check is part of the type, not a sticker on it.
export const HIT_LABEL = { hit_t1: "T1 ✓", hit_t2: "T2 ✓", hit_t3: "T3 ✓" };

// A tinted read-only tag. Not the kit's Pill — that one is a filter control
// (a <button>), and these sit inside rows that are already buttons.
export function TonePill({ tone, children, style }) {
  return (
    <span className="t-cap" style={{
      background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone,
      borderRadius: 999, padding: "3px 9px", fontWeight: 600, whiteSpace: "nowrap", flex: "none", ...style,
    }}>{children}</span>
  );
}

/* Client-side duplicates of the panel's formatters — importing them from
   AltSeasonPanel.jsx would close the module cycle the tone exports avoid. */
// Sub-dollar prices get significant digits, not two decimals — "$0.00" is not
// a price, and the levels on this sheet are read straight off these strings.
function px(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1000) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`;
  if (a === 0) return "$0";
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}
const signedPct = (n, d = 1) => (n == null || !isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);

const STATUS_RANK = { active: 0, hit_t1: 1, hit_t2: 2, hit_t3: 3 };

export default function AltCoinSheet({ sel, row, episode, onClose, onChart }) {
  const price = row?.price ?? episode?.lastPrice ?? null;
  // Frozen episode targets beat the board's hourly recompute — see header.
  const targets = episode?.targets || row?.targets || null;
  const score = row?.score ?? episode?.score ?? null;
  const band = row?.band || null;
  const facts = Array.isArray(row?.facts) ? row.facts : [];
  const reached = STATUS_RANK[episode?.status] || 0;

  const days = episode?.firstFlaggedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(episode.firstFlaggedAt)) / 86400000)) : null;
  const flaggedWord = days == null ? null : days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  const tier = episode ? (TIER_META[episode.tier] || TIER_META.building) : null;

  const targetRows = targets ? [
    { key: "t1", label: "T1", p: targets.t1, pct: targets.t1Pct, hit: reached >= 1 },
    { key: "t2", label: "T2", p: targets.t2, pct: targets.t2Pct, hit: reached >= 2 },
    { key: "t3", label: "T3", p: targets.t3, pct: targets.t3Pct, hit: reached >= 3 },
    { key: "inv", label: "Invalidation", p: targets.invalidation, pct: targets.invPct, inv: true },
  ] : null;

  return (
    <Sheet
      onClose={onClose}
      title={`${sel.symbol} · ${sel.name}`}
      footer={<Button kind="tinted" size="lg" full onClick={onChart}>Chart</Button>}
    >
      {/* price line — live via the 60s poll; the sheet resolves its rows from
          the current payload on every render, so this tweens as prices move */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span className="t-title1 t-num">{price != null ? <NumTween v={price} f={px} /> : "—"}</span>
          {row && <Delta pct={row.chg24h} digits={1} />}
        </span>
        {tier && <TonePill tone={tier.tone} style={{ marginLeft: "auto" }}>{tier.label}</TonePill>}
      </div>

      {/* the levels — % is distance from the CURRENT price, so a crossed
          target reads green with a negative number: below where price is now */}
      {targetRows ? (
        <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "2px 12px", marginBottom: 12 }}>
          {targetRows.map((t, i) => {
            const tone = t.inv ? T.red : t.hit ? T.green : null;
            return (
              <div key={t.key} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 40, borderTop: i ? "0.5px solid var(--line)" : "none" }}>
                <span className="t-cap" style={{ color: tone || "var(--faint)", fontWeight: 600, width: 82, flex: "none" }}>{t.label}</span>
                <span className="t-num" style={{ fontSize: 14, color: tone || "var(--ink)", flex: 1, minWidth: 0 }}>{px(t.p)}</span>
                <span className="t-cap t-num" style={{ color: tone || "var(--sub)", flex: "none" }}>{t.pct == null ? "—" : signedPct(t.pct)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="t-foot" style={{ color: "var(--sub)", marginBottom: 12, lineHeight: 1.5 }}>
          No published levels — the 7-day structure is too flat to target.
        </div>
      )}

      {episode && (
        <div className="t-foot" style={{ color: "var(--sub)", marginBottom: 6, lineHeight: 1.5 }}>
          Flagged {flaggedWord} at {px(episode.flagPrice)}
          {episode.peakPct != null && <> · peak <span className="t-num" style={{ color: episode.peakPct >= 0 ? T.green : T.red }}>{signedPct(episode.peakPct)}</span></>}
        </div>
      )}

      {(score != null || band) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: facts.length ? 10 : 0 }}>
          {score != null && (
            <span className="t-foot" style={{ color: "var(--sub)" }}>
              Score <span className="t-num" style={{ color: "var(--ink)", fontWeight: 600 }}>{score}</span>/100
            </span>
          )}
          {band && <TonePill tone={BAND_TONE[band] || T.faint}>{band}</TonePill>}
        </div>
      )}

      {/* the screener's evidence, verbatim — plain English, one claim a line */}
      {facts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingBottom: 4 }}>
          {facts.map((f, i) => (
            <div key={i} className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.5, display: "flex", gap: 7 }}>
              <span style={{ color: "var(--faint)", flex: "none" }}>·</span>
              <span style={{ minWidth: 0 }}>{f}</span>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
