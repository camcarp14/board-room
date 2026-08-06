// ─── Alt coin sheet — one coin, the levels you'd act on ──────────────────────
// Opened from the radar, the movers and the board, so it renders from whichever
// shape it was handed: a screened board row (score, band, facts, hourly
// targets), an open flag episode (FROZEN targets — the ones the log is graded
// against), or both. When both exist the episode's targets win: a fresher
// hourly pass does not move the levels a flag is being judged by.
//
// THE SHEET USED TO SAY LESS THAN THE ROW YOU TAPPED. The board row carries
// five change windows and a spark; opening the coin threw both away and showed
// a 24h delta and a table of four prices. Tapping in should never lose
// information, so the windows and the spark come with it, and the levels are
// drawn on a track as well as listed — "T1 −6.1%" is a true statement that
// reads like a loss, when what it means is the target is already behind you.
import { Sheet, Button, Delta } from "../../ui/kit.jsx";
import { NumTween, Sparkline } from "../../ui/primitives.jsx";
import ScoreCard from "./ScoreCard.jsx";
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
// The entry verdict — alt-scan's entryRead names the state, this names it in
// the two words the sheet leads with. Kept beside the other tone vocabulary so
// the panel and the sheet cannot drift into two different colour schemes for
// the same word.
export const ENTRY_TONE = { entry: T.green, watch: T.amber, late: T.faint };
export const ENTRY_LABEL = { entry: "Entry", watch: "Watch", late: "Late" };
// Where the move is, in the same words the panel uses. Kept here with the rest
// of the shared vocabulary for the reason this block already exists: the list
// and the sheet must not drift into two names for one state.
export const STAGE_LABEL = {
  base: "In its base",
  atLevel: "At its level",
  breaking: "Breaking out",
  extending: "Extending",
  spent: "Move spent",
  broken: "Structure lost",
  none: "No level drawn",
  offboard: "Off the board",
};
export const MOTION_LABEL = { up: "pace picking up", flat: "pace holding", down: "pace easing off" };
// Text, not emoji — the check is part of the type, not a sticker on it.
export const HIT_LABEL = { hit_t1: "T1 ✓", hit_t2: "T2 ✓", hit_t3: "T3 ✓" };

// A tinted read-only tag. Not the kit's Pill — that one is a filter control
// (a <button>), and these sit inside rows that are already buttons.
/* ── the score, as five blocks — the equity sheet's twin ──────────────────────
   alt-cron's parts[] and stock-settle's parts[] have the identical shape and
   the identical weights: 25 trend, 30 pace, 15 volume, 20 structure, 10
   headroom. Only the KEYS and the words differ, which is why one ScoreCard
   serves both and only this table is per-tab.

   "Range & break" rather than "Structure", because STAGE_LABEL.broken above is
   already "Structure lost". */
const CRYPTO_BLOCKS = [
  {
    key: "trend", label: "Trend vs BTC", keys: ["rs7", "rs30"],
    sub: (r) => join(num(r?.rsVsBtc7d) && `7d ${sgn(r.rsVsBtc7d)}`, num(r?.rsVsBtc30d) && `30d ${sgn(r.rsVsBtc30d)}`),
  },
  {
    key: "pace", label: "Pace", keys: ["accel24", "accel7v30"],
    sub: (r) => join(
      num(r?.accel?.d24VsWeek) && `24h ${sgn(r.accel.d24VsWeek)} vs its week`,
      num(r?.accel?.weekVsMonth) && `week ${sgn(r.accel.weekVsMonth)}/day`,
    ),
  },
  {
    key: "turnover", label: "Turnover", keys: ["turnover"],
    sub: (r) => (num(r?.turnover) ? `${(r.turnover * 100).toFixed(1)}% of its cap in a day` : null),
  },
  {
    key: "break", label: "Range & break", keys: ["range", "break"],
    sub: (r) => join(
      num(r?.range7d?.pos) && `${Math.round(r.range7d.pos * 100)}% up its range`,
      num(r?.range7d?.priorHigh) && `level ${px(r.range7d.priorHigh)}`,
    ),
  },
  {
    key: "room", label: "Room from its high", keys: ["room"],
    sub: (r) => (num(r?.athChangePct) ? `${Math.abs(Math.round(r.athChangePct))}% below the all-time high` : null),
  },
];
const num = (v) => Number.isFinite(v);
const sgn = (n, d = 1) => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(d)}` : null);
const join = (...xs) => xs.filter(Boolean).join(" · ") || null;

/** A labelled read: one short phrase over one number. Twin of the stock sheet's. */
function Read({ label, value, tone, big }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="t-cap" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--faint)" }}>
        {label}
      </div>
      <div className="t-num" style={{
        fontSize: big ? 17 : 13, fontWeight: big ? 600 : 500, marginTop: 2,
        color: tone || (big ? "var(--ink)" : "var(--sub)"),
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{value}</div>
    </div>
  );
}

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
function usd(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1e12) return `$${(x / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `$${Math.round(x / 1e3)}k`;
  return `$${Math.round(x)}`;
}

const STATUS_RANK = { active: 0, hit_t1: 1, hit_t2: 2, hit_t3: 3 };
const WINDOWS = [
  { key: "chg4h", label: "4H" }, { key: "chg12h", label: "12H" }, { key: "chg24h", label: "24H" },
  { key: "chg7d", label: "7D" }, { key: "chg30d", label: "30D" },
];

export default function AltCoinSheet({ sel, row, episode, onClose, onChart }) {
  const price = row?.price ?? episode?.lastPrice ?? null;
  // Frozen episode targets beat the board's hourly recompute — see header.
  const targets = episode?.targets || row?.targets || null;
  const score = row?.score ?? episode?.score ?? null;
  const band = row?.band || null;
  const facts = Array.isArray(row?.facts) ? row.facts : [];
  const spark = Array.isArray(row?.spark) && row.spark.length > 1 ? row.spark : null;
  const reached = STATUS_RANK[episode?.status] || 0;

  // The verdict, same source as the panel's sections. Episode first: a flag's
  // read is judged against the levels it was flagged on, which is the trade
  // you'd actually be taking.
  const entry = episode?.entry || row?.entry || null;
  const move = episode?.move || row?.move || null;

  const days = episode?.firstFlaggedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(episode.firstFlaggedAt)) / 86400000)) : null;
  const flaggedWord = days == null ? null : days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  const tier = episode ? (TIER_META[episode.tier] || TIER_META.building) : null;

  // TWO DIFFERENT TRUTHS PER LEVEL, and the first build conflated them.
  //   `hit`     — the LOG graded it: peak price reached this target, judged
  //               hourly against the frozen levels. Historical, never revoked.
  //   `cleared` — price is at or above it RIGHT NOW. Live, and it can go away.
  // They usually agree, and the two cases where they don't are exactly the
  // ones worth seeing: price above a target the hourly pass hasn't graded yet
  // (hit false, cleared true — this is what printed the nonsense "−1.5%
  // away"), and a target that was tagged and then given back (hit true,
  // cleared false). So the row shows a ✓ for the grade and separately says
  // where price is now.
  const targetRows = targets ? [
    { key: "t1", label: "T1", p: targets.t1, pct: targets.t1Pct, hit: reached >= 1 },
    { key: "t2", label: "T2", p: targets.t2, pct: targets.t2Pct, hit: reached >= 2 },
    { key: "t3", label: "T3", p: targets.t3, pct: targets.t3Pct, hit: reached >= 3 },
  ].map((t) => ({ ...t, cleared: Number.isFinite(t.pct) ? t.pct <= 0 : Number.isFinite(price) && Number.isFinite(t.p) && price >= t.p })) : null;

  // The track runs invalidation → T3, the full width of the trade as it was
  // written. `pos` is clamped because live price legitimately travels outside
  // that range — past T3 on a winner, under invalidation on a loser — and an
  // unclamped marker would leave the rail entirely rather than pinning to the
  // end it blew through.
  const lo = targets?.invalidation, hi = targets?.t3;
  const spanOk = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo && Number.isFinite(price);
  const pos = (p) => (spanOk && Number.isFinite(p) ? Math.max(0, Math.min(100, ((p - lo) / (hi - lo)) * 100)) : null);
  const pricePos = pos(price);

  // Up is the direction the trade needs; the sheet's greens all mean "toward
  // the thesis", never "number went up".
  const up = (row?.chg24h ?? 0) >= 0;

  return (
    <Sheet
      onClose={onClose}
      title={`${sel.symbol} · ${sel.name}`}
      footer={<Button kind="tinted" size="lg" full onClick={onChart}>Open chart</Button>}
    >
      {/* price line — live via the 60s poll; the sheet resolves its rows from
          the current payload on every render, so this tweens as prices move */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: spark ? 8 : 12 }}>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span className="t-title1 t-num">{price != null ? <NumTween v={price} f={px} /> : "—"}</span>
          {row && <Delta pct={row.chg24h} digits={1} />}
        </span>
        {/* The tier pill used to sit here, and on CYS it rendered a green
            "Igniting" one line above a verdict of LATE — the flag's expected
            pace arguing with the read of the same coin. Pace only matters
            while the move can still happen, so it moved down to the flag
            line, where it reads as part of the episode's history. */}
      </div>

      {/* THE VERDICT, ABOVE EVERYTHING IT IS DERIVED FROM. CYS opened on a
          68/100 score, three targets 5–9% away and a level rail — all of which
          read like a trade — with "PARABOLIC: +160.4% in 7d, this is a chase"
          as the last line of the sheet, under the fold. The judgment goes
          first now, and the numbers under it are its evidence. */}
      {entry && (
        <div style={{
          background: `color-mix(in srgb, ${ENTRY_TONE[entry.state] || T.faint} 10%, transparent)`,
          borderRadius: 12, padding: "9px 12px", marginBottom: 12,
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
            {/* 'late' is deliberately the quiet tone in a list — one grey
                heading over rows you're meant to skip. As the headline of a
                sheet it has to be READ, and faint-on-faint-tint is not a
                readable word, so the banner promotes it to body ink. */}
            <span className="t-label" style={{ color: entry.state === "late" ? "var(--sub)" : (ENTRY_TONE[entry.state] || T.faint), letterSpacing: "0.04em" }}>
              {ENTRY_LABEL[entry.state] || "—"}
            </span>
            <span className="t-foot" style={{ color: "var(--sub)", minWidth: 0, lineHeight: 1.45 }}>{entry.why}</span>
          </div>
          {/* how far it goes, what being wrong costs, and the ratio between
              them — the three numbers that decide size, on one line */}
          {(Number.isFinite(entry.roomPct) || Number.isFinite(entry.riskPct)) && (
            <div className="t-cap t-num" style={{ color: "var(--faint)", marginTop: 4 }}>
              {Number.isFinite(entry.roomPct) && <>room to T3 <span style={{ color: entry.roomPct >= 0 ? T.green : "var(--faint)" }}>{signedPct(entry.roomPct)}</span></>}
              {Number.isFinite(entry.riskPct) && <> · risk <span style={{ color: T.red }}>{signedPct(entry.riskPct)}</span></>}
              {entry.rr != null && <> · pays {entry.rr}×</>}
            </div>
          )}
        </div>
      )}

      {/* THE STAGE, SPELLED OUT. The list says "In its base · 8.1% under" in
          the width a row has; here there is room to say what the level is and
          to show both clauses instead of the one the row had to choose. Same
          vocabulary as the panel — a coin that reads one way on the list and
          another way in the sheet is worse than either. */}
      {move && STAGE_LABEL[move.stage] && (
        <div style={{ marginBottom: 12 }}>
          <div className="t-foot" style={{ color: "var(--ink)", lineHeight: 1.5 }}>
            {STAGE_LABEL[move.stage]}{move.thin && <span style={{ color: T.red }}> · too thin to exit</span>}
          </div>
          <div className="t-cap t-num" style={{ color: "var(--faint)", marginTop: 2, lineHeight: 1.5 }}>
            {[
              Number.isFinite(move.toLevelPct)
                ? `${Math.abs(move.toLevelPct).toFixed(1)}% ${move.toLevelPct < 0 ? "under" : "over"} its level${row?.range7d?.priorHigh ? ` ${px(row.range7d.priorHigh)}` : ""}`
                : null,
              move.motion ? `12h ${MOTION_LABEL[move.motion]}` : null,
              Number.isFinite(move.offPeakPct) ? `${Math.abs(move.offPeakPct).toFixed(1)}% off its own high` : null,
            ].filter(Boolean).join(" · ") || "no level drawn yet"}
          </div>
        </div>
      )}

      {/* the week, at a glance — the same series the board row draws */}
      {spark && (
        <div style={{ marginBottom: 10 }}>
          <Sparkline points={spark} color={up ? T.green : T.red} height={44} />
          {row?.range7d?.low != null && row?.range7d?.high != null && (
            <div className="t-cap" style={{ color: "var(--faint)", marginTop: 4 }}>
              7-day range {px(row.range7d.low)}–{px(row.range7d.high)}
              {row.range7d.pos != null && ` · ${Math.round(row.range7d.pos * 100)}% up it`}
            </div>
          )}
        </div>
      )}

      {/* every window the row had — tapping in must not lose information */}
      {row && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 4, marginBottom: 14 }}>
          {WINDOWS.map((w) => {
            const v = row[w.key];
            const has = Number.isFinite(v);
            return (
              <div key={w.key} style={{ minWidth: 0 }}>
                <div className="t-cap" style={{ color: "var(--faint)", fontSize: 10 }}>{w.label}</div>
                <div className="t-num" style={{ fontSize: 12.5, color: has ? (v >= 0 ? T.green : T.red) : "var(--faint)" }}>
                  {has ? signedPct(v) : "—"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {targetRows ? (
        <>
          {/* the trade on one rail: where price sits between the level that
              kills it and the last target it's aiming at */}
          {spanOk && (
            <div style={{ padding: "0 2px 14px" }}>
              <div style={{ position: "relative", height: 6, background: "var(--surface-2)", borderRadius: 999 }}>
                {/* filled from invalidation up to the live price */}
                <div style={{
                  position: "absolute", left: 0, top: 0, bottom: 0, width: `${pricePos}%`,
                  background: `color-mix(in srgb, ${up ? T.green : T.red} 55%, transparent)`, borderRadius: 999,
                }} />
                {targetRows.map((t) => {
                  const p = pos(t.p);
                  return p == null ? null : (
                    <span key={t.key} style={{
                      position: "absolute", left: `${p}%`, top: -3, width: 2, height: 12, marginLeft: -1,
                      background: t.hit || t.cleared ? T.green : "var(--line-strong)", borderRadius: 1,
                    }} />
                  );
                })}
                {/* the live price, drawn last so it sits above every mark */}
                <span style={{
                  position: "absolute", left: `${pricePos}%`, top: -5, width: 10, height: 16, marginLeft: -5,
                  borderRadius: 3, background: "var(--ink)", border: "2px solid var(--surface)",
                }} />
              </div>
              <div className="t-cap" style={{ display: "flex", justifyContent: "space-between", color: "var(--faint)", marginTop: 5 }}>
                <span>{px(lo)} invalid</span>
                <span>{px(hi)} T3</span>
              </div>
            </div>
          )}

          <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "2px 12px", marginBottom: 12 }}>
            {targetRows.map((t, i) => {
              const on = t.hit || t.cleared;
              return (
                <div key={t.key} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 40, borderTop: i ? "0.5px solid var(--line)" : "none" }}>
                  <span className="t-cap" style={{ color: on ? T.green : "var(--faint)", fontWeight: 600, width: 30, flex: "none" }}>{t.label}</span>
                  <span className="t-num" style={{ fontSize: 14, color: on ? T.green : "var(--ink)", flex: 1, minWidth: 0 }}>{px(t.p)}</span>
                  {/* A target price sits BELOW the live price gave "−6.1% away",
                      which is arithmetically true and reads like a loss. */}
                  {/* "✓ +6.4% away" was true and unreadable — the tick said
                      the log counted it, the number said price is below it,
                      and nothing said those were two different statements.
                      Spell the round-trip out instead. */}
                  <span className="t-cap t-num" style={{ color: on ? T.green : "var(--sub)", flex: "none" }}>
                    {t.cleared ? (t.hit ? "✓ cleared" : "cleared")
                      : t.pct == null ? "—"
                      : t.hit ? `hit · back ${signedPct(-t.pct)}`
                      : `${signedPct(t.pct)} away`}
                  </span>
                </div>
              );
            })}
            <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 40, borderTop: "0.5px solid var(--line)" }}>
              <span className="t-cap" style={{ color: T.red, fontWeight: 600, width: 30, flex: "none" }}>Inv</span>
              <span className="t-num" style={{ fontSize: 14, color: T.red, flex: 1, minWidth: 0 }}>{px(targets.invalidation)}</span>
              <span className="t-cap t-num" style={{ color: T.red, flex: "none" }}>
                {targets.invPct == null ? "—" : `${signedPct(targets.invPct)} below`}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div className="t-foot" style={{ color: "var(--sub)", marginBottom: 12, lineHeight: 1.5 }}>
          No published levels — the 7-day structure is too flat to target.
        </div>
      )}

      {/* THE SIZE OF THE THING. A 90-score micro-cap and a 90-score major are
          not the same trade, and nothing above this line says which one it is.
          The equity twin puts ATR here for the same reason — it is the ruler
          the percentages above are denominated in. Crypto has no ATR and no
          200-day worth trusting off a 7-day sparkline, so the ruler is size and
          liquidity instead: the two facts that decide whether a target is
          reachable and whether you could get back out of it. */}
      {row && (Number.isFinite(row.mcap) || Number.isFinite(row.vol24h)) && (
        <div style={{ display: "grid", gridTemplateColumns: "1.25fr 1fr 1fr", gap: 10, marginBottom: 13 }}>
          <Read big label="Market cap" value={Number.isFinite(row.mcap) ? usd(row.mcap) : "—"} />
          <Read label="24h volume" value={Number.isFinite(row.vol24h) ? usd(row.vol24h) : "—"} />
          <Read label="Rank" value={Number.isFinite(row.rank) ? `#${row.rank}` : "—"} />
        </div>
      )}

      {/* THE FLAG, not the coin — its own line rather than middot-joined onto
          the score, which is about something else. Twin of the stock sheet. */}
      {episode && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, marginBottom: 11 }}>
          {tier && <TonePill tone={tier.tone}>{tier.label}</TonePill>}
          <span className="t-cap" style={{ color: "var(--sub)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Flagged {flaggedWord} at {px(episode.flagPrice)}
          </span>
          {episode.peakPct != null && (
            <span className="t-cap t-num" style={{ marginLeft: "auto", flex: "none", color: episode.peakPct >= 0 ? T.green : T.red }}>
              peak {signedPct(episode.peakPct)}
            </span>
          )}
        </div>
      )}

      <ScoreCard
        row={row} parts={row?.parts} score={score} band={band}
        bandTone={BAND_TONE[band] || T.faint} blocks={CRYPTO_BLOCKS} facts={facts}
      />
    </Sheet>
  );
}
