// ─── Stock sheet — one name, the levels you'd act on ─────────────────────────
// The AltCoinSheet's anatomy, because the vocabulary has to be identical across
// the two tabs: verdict first, then the stage spelled out, then the chart, the
// session windows, the level rail, the target table, and then — below all of it
// — the ruler, the catalyst, the flag, and the score broken into its blocks.
//
// EVERYTHING BELOW THE TARGET TABLE USED TO BE PROSE. A grey run-on that
// wrapped and ended on a bare sector word, then eight middot bullets, ~470px of
// a 1017px sheet, most of them restating something already drawn above: the
// sparkline caption, the stage line, the ATR clause. Meanwhile the row carried
// three things the sheet never rendered at all — parts[], catalyst, and news —
// and the score sat there as "70/100" with no account of where the other 30
// went. The fix was not to tidy the sentences; it was to draw the data that was
// already there and let the prose retire behind a disclosure.
//
// Three things are equity-specific and each earns its line:
//   · the windows are SESSION counts. There is no 4h return on a market that
//     shuts at 4pm, and labelling one is the failure this tab exists to avoid.
//   · ATR — "a normal day for this one is ±1.7%". It is the only unit that
//     means the same thing on a 1.2%-a-day utility and a 6%-a-day biotech, and
//     it is what makes a target distance legible without a dollar figure.
//   · `probing` — the session's HIGH cleared the level and the close did not.
//     A close-only series cannot produce it; Yahoo's true OHLC can.
import { Sheet, Button, Delta } from "../../ui/kit.jsx";
import { NumTween, Sparkline } from "../../ui/primitives.jsx";
import ScoreCard from "./ScoreCard.jsx";
import { T } from "../../theme.js";
import { calendarDaysBetween } from "../../lib/dates.js";

/* ── tone vocabulary — lives in this leaf so StocksPanel can import it without
      making the module graph circular ────────────────────────────────────── */
export const BAND_TONE = {
  starting: T.green, underway: T.blue, warming: T.amber,
  quiet: T.faint, cold: T.faint, late: T.red,
};
export const TIER_META = {
  igniting: { label: "Igniting", tone: T.green },
  building: { label: "Building", tone: T.amber },
};
export const ENTRY_TONE = { entry: T.green, watch: T.amber, late: T.faint };
export const ENTRY_LABEL = { entry: "Entry", watch: "Watch", late: "Late" };
// The SAME six words the Alt Season tab uses. A move that is "Breaking out" on
// one tab must not be called something else on the other — that is the whole
// reason this vocabulary is a shared export rather than a string literal.
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
export const HIT_LABEL = { hit_t1: "T1 ✓", hit_t2: "T2 ✓", hit_t3: "T3 ✓" };

export function TonePill({ tone, children, style }) {
  return (
    <span className="t-cap" style={{
      background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone,
      borderRadius: 999, padding: "3px 9px", fontWeight: 600, whiteSpace: "nowrap", flex: "none", ...style,
    }}>{children}</span>
  );
}

function px(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1000) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`;
  if (a === 0) return "$0";
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}
const signedPct = (n, d = 1) => (n == null || !isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);

/* ── the score, as five blocks ────────────────────────────────────────────────
   Keys map to the engine's parts[]; the MAX of each block is summed from its
   own members inside ScoreCard, never written here, so reweighting a part in
   the screener moves the picture without a client change.

   "Range & break", not "Structure" — STAGE_LABEL.broken is already "Structure
   lost", and a row reading "Structure 20/20" two inches beneath it is exactly
   the vocabulary collision the shared exports in this file exist to prevent. */
const SCORE_BLOCKS = [
  {
    key: "trend", label: "Trend vs SPY", keys: ["rs5", "rs21"],
    sub: (r) => join(num(r?.rs5) && `5 sess ${sgn(r.rs5)}`, num(r?.rs21) && `21 sess ${sgn(r.rs21)}`),
  },
  {
    key: "pace", label: "Pace", keys: ["accelSession", "accel5v21"],
    sub: (r) => join(
      num(r?.accel?.dSessionVsWeek) && `last sess ${sgn(r.accel.dSessionVsWeek)} vs its week`,
      num(r?.accel?.weekVsMonth) && `week ${sgn(r.accel.weekVsMonth)}/sess`,
    ),
  },
  {
    key: "volume", label: "Volume behind it", keys: ["rvol"],
    sub: (r) => (num(r?.rvol) ? `${r.rvol}× its 20-session median` : null),
  },
  {
    key: "break", label: "Range & break", keys: ["range", "break"],
    sub: (r) => join(
      num(r?.range20?.pos) && `${Math.round(r.range20.pos * 100)}% up its range`,
      num(r?.range20?.priorHigh) && `level ${px(r.range20.priorHigh)}`,
    ),
  },
  {
    key: "high", label: "Near its high", keys: ["high"],
    sub: (r) => (num(r?.fromHighPct) && num(r?.windowHigh)
      ? `${Math.abs(Math.round(r.fromHighPct))}% under ${px(r.windowHigh)}${r.windowSessions ? ` · ${r.windowSessions} sessions` : ""}`
      : null),
  },
];
const num = (v) => Number.isFinite(v);
const sgn = (n, d = 1) => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(d)}` : null);
const join = (...xs) => xs.filter(Boolean).join(" · ") || null;

/** A labelled read: one short phrase over one number. */
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

const STATUS_RANK = { active: 0, hit_t1: 1, hit_t2: 2, hit_t3: 3 };
// SESSION counts, never hours. "Overnight" is the equity-only window and it is
// where the gap lives — the thing a close-to-close series is blindest to.
const WINDOWS = [
  { key: "overnight", label: "O/N" },
  { key: "chgSession", label: "1 SESS" },
  { key: "chg5", label: "1 WK" },
  { key: "chg21", label: "1 MO" },
  { key: "chg63", label: "3 MO" },
];

export default function StockSheet({ sel, row, episode, session, onClose, onChart }) {
  const price = row?.price ?? episode?.lastPrice ?? null;
  // Frozen episode targets beat the board's recompute — a fresher settle does
  // not move the levels a flag is being judged by.
  const targets = episode?.targets || row?.targets || null;
  const score = row?.score ?? episode?.score ?? null;
  const band = row?.band || null;
  const facts = Array.isArray(row?.facts) ? row.facts : [];
  const spark = Array.isArray(row?.spark) && row.spark.length > 1 ? row.spark : null;
  const reached = STATUS_RANK[episode?.status] || 0;

  const entry = episode?.entry || row?.entry || null;
  const move = episode?.move || row?.move || null;
  // The episode carries its own copies once a flag is open (stock-scan rides
  // them along so a flag row needs no join back to the board); the board row
  // is the fallback for anything screened but not flagged.
  const catalyst = episode?.catalyst || row?.catalyst || null;
  const headline = (episode?.news || row?.news || [])[0] || null;
  // Whichever object supplied `price` above is the one that knows whether it
  // was live. Default FALSE: an unstamped payload (one written before the flag
  // shipped) must read as a close, because claiming live is the failure.
  const priceLive = row?.price != null ? row.priceLive === true : episode?.priceLive === true;

  const days = episode?.firstFlaggedAt ? Math.max(0, calendarDaysBetween(episode.firstFlaggedAt) ?? 0) : null;
  const flaggedWord = days == null ? null : days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  const tier = episode ? (TIER_META[episode.tier] || TIER_META.building) : null;

  // TWO DIFFERENT TRUTHS PER LEVEL.
  //   `hit`     — the LOG graded it: the session's real HIGH reached this
  //               target, against the frozen levels. Historical, never revoked.
  //   `cleared` — price is at or above it right now. Live, and it can go away.
  const targetRows = targets ? [
    { key: "t1", label: "T1", p: targets.t1, pct: targets.t1Pct, hit: reached >= 1 },
    { key: "t2", label: "T2", p: targets.t2, pct: targets.t2Pct, hit: reached >= 2 },
    { key: "t3", label: "T3", p: targets.t3, pct: targets.t3Pct, hit: reached >= 3 },
  ].map((t) => ({ ...t, cleared: Number.isFinite(t.pct) ? t.pct <= 0 : Number.isFinite(price) && Number.isFinite(t.p) && price >= t.p })) : null;

  const lo = targets?.invalidation, hi = targets?.t3;
  const spanOk = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo && Number.isFinite(price);
  const pos = (p) => (spanOk && Number.isFinite(p) ? Math.max(0, Math.min(100, ((p - lo) / (hi - lo)) * 100)) : null);
  const pricePos = pos(price);
  const up = (row?.chgSession ?? 0) >= 0;

  return (
    <Sheet
      onClose={onClose}
      title={`${sel.symbol} · ${sel.name}`}
      footer={<Button kind="tinted" size="lg" full onClick={onChart}>Open chart</Button>}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: spark ? 8 : 12 }}>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span className="t-title1 t-num">{price != null ? <NumTween v={price} f={px} /> : "—"}</span>
          {row && <Delta pct={row.chgSession} digits={1} />}
        </span>
        {/* WHEN THIS PRICE IS FROM — read off the price, never off the clock.
            This used to say "during the session" whenever the market was open,
            which is true of the MARKET and false of almost every price here:
            the tick only quotes names carrying an open flag, three of
            forty-nine on a normal board. So the largest number on the sheet,
            tweened as if it were ticking, was last session's close wearing a
            live caption for ~94% of the names you can tap. stock-scan now
            stamps each row with whether its price came from the tick. */}
        <span className="t-cap" style={{ marginLeft: "auto", color: "var(--faint)", flex: "none" }}>
          {priceLive ? "during the session"
            : session?.lastSessionLabel ? `${session.lastSessionLabel} close`
            : "last close"}
        </span>
      </div>

      {/* THE VERDICT, ABOVE EVERYTHING IT IS DERIVED FROM. */}
      {entry && (
        <div style={{
          background: `color-mix(in srgb, ${ENTRY_TONE[entry.state] || T.faint} 10%, transparent)`,
          borderRadius: 12, padding: "9px 12px", marginBottom: 12,
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
            <span className="t-label" style={{ color: entry.state === "late" ? "var(--sub)" : (ENTRY_TONE[entry.state] || T.faint), letterSpacing: "0.04em" }}>
              {ENTRY_LABEL[entry.state] || "—"}
            </span>
            <span className="t-foot" style={{ color: "var(--sub)", minWidth: 0, lineHeight: 1.45 }}>{entry.why}</span>
          </div>
          {(Number.isFinite(entry.roomPct) || Number.isFinite(entry.riskPct)) && (
            <div className="t-cap t-num" style={{ color: "var(--faint)", marginTop: 4 }}>
              {Number.isFinite(entry.roomPct) && <>room to T3 <span style={{ color: entry.roomPct >= 0 ? T.green : "var(--faint)" }}>{signedPct(entry.roomPct)}</span></>}
              {Number.isFinite(entry.riskPct) && <> · risk <span style={{ color: T.red }}>{signedPct(entry.riskPct)}</span></>}
              {entry.rr != null && <> · pays {entry.rr}×</>}
            </div>
          )}
        </div>
      )}

      {/* THE STAGE, SPELLED OUT — same vocabulary as the list. */}
      {move && STAGE_LABEL[move.stage] && (
        <div style={{ marginBottom: 12 }}>
          <div className="t-foot" style={{ color: "var(--ink)", lineHeight: 1.5 }}>
            {STAGE_LABEL[move.stage]}
            {move.probing && <span style={{ color: "var(--sub)" }}> · poked through intraday, closed back under</span>}
            {move.thin && <span style={{ color: T.red }}> · too thin to exit</span>}
          </div>
          <div className="t-cap t-num" style={{ color: "var(--faint)", marginTop: 2, lineHeight: 1.5 }}>
            {[
              Number.isFinite(move.toLevelPct)
                ? `${Math.abs(move.toLevelPct).toFixed(1)}% ${move.toLevelPct < 0 ? "under" : "over"} its level${row?.range20?.priorHigh ? ` ${px(row.range20.priorHigh)}` : ""}`
                : null,
              move.motion ? MOTION_LABEL[move.motion] : null,
              Number.isFinite(move.offPeakPct) ? `${Math.abs(move.offPeakPct).toFixed(1)}% off its own high` : null,
            ].filter(Boolean).join(" · ") || "no level drawn yet"}
          </div>
        </div>
      )}

      {spark && (
        <div style={{ marginBottom: 10 }}>
          <Sparkline points={spark} color={up ? T.green : T.red} height={44} />
          {row?.range20?.low != null && row?.range20?.high != null && (
            <div className="t-cap" style={{ color: "var(--faint)", marginTop: 4 }}>
              20-session range {px(row.range20.low)}–{px(row.range20.high)}
              {row.range20.pos != null && ` · ${Math.round(row.range20.pos * 100)}% up it`}
            </div>
          )}
        </div>
      )}

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
          {spanOk && (
            <div style={{ padding: "0 2px 14px" }}>
              <div style={{ position: "relative", height: 6, background: "var(--surface-2)", borderRadius: 999 }}>
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
          No published levels — the 20-session structure is too flat to target.
        </div>
      )}

      {/* THE RULER. Everything above this line is a percentage; this is what a
          percentage is WORTH on this name. It sits directly under the targets
          because that is what it calibrates — +6.4% to T1 is a session and a
          half on FCX at ±4.3% a day, and a fortnight on a utility at ±0.9%.
          The sheet does not do that division for you (the client formats, it
          never derives); it puts both numbers inside one glance.

          This replaces a grey run-on that wrapped to two lines and ended on a
          bare sector word reading like a typo. rvol left with it — "traded
          1.18× its normal volume" is a statistic, while the same fact scored
          as 4 out of a possible 15 is a verdict, and the score card says it. */}
      {row && (Number.isFinite(row.atrPct) || row.sector || row.aboveSma200 != null) && (
        <div style={{ display: "grid", gridTemplateColumns: "1.25fr 1fr 1fr", gap: 10, marginBottom: 13 }}>
          <Read big label="Normal day" value={Number.isFinite(row.atrPct) ? `±${row.atrPct.toFixed(1)}%` : "—"} />
          <Read label="200-day"
            value={row.aboveSma200 == null ? "—" : row.aboveSma200 ? "above" : "below"}
            tone={row.aboveSma200 == null ? "var(--faint)" : row.aboveSma200 ? T.green : T.red} />
          <Read label="Sector" value={row.sector || "—"} />
        </div>
      )}

      {/* WHY IT MIGHT MOVE. The row has carried `catalyst` since the engine
          shipped and this sheet has never rendered it once — the single
          highest-value thing already in the payload and not on screen. The
          headline underneath is relevance-filtered server-side, so what lands
          here is about this company rather than whatever the search matched. */}
      {(catalyst || headline) && (
        <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "10px 13px", marginBottom: 12 }}>
          <div className="t-cap" style={{ color: "var(--faint)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 3 }}>
            Why it might move
          </div>
          {catalyst?.note && (
            <div className="t-foot" style={{ color: "var(--ink)", lineHeight: 1.45 }}>{catalyst.note}</div>
          )}
          {headline && (
            <div className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.45, marginTop: catalyst?.note ? 5 : 0 }}>
              {headline.title}
              {headline.publisher && <span style={{ color: "var(--faint)" }}> · {headline.publisher}</span>}
            </div>
          )}
        </div>
      )}

      {/* THE FLAG, not the stock — so it gets its own line rather than being
          middot-joined onto the score, which is about something else. */}
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
        bandTone={BAND_TONE[band] || T.faint} blocks={SCORE_BLOCKS} facts={facts}
      />
    </Sheet>
  );
}
