// ─── The book — what you own, and what the next action is ───────────────────
//
// alt_flags is the screener's log: ideas it had, graded honestly whether or not
// a dollar was ever put behind one. This is the other half, and until it shipped
// the tab had no representation of the thing that actually decides the outcome.
//
// THE EXIT LADDER IS THE STRATEGY. Everyone catches some of a bull market;
// almost nobody sells one. The difference between a position that printed 10×
// and one that BANKED 10× is a set of rungs written down before there was
// anything to feel about them — so the row's job is not to show a profit, it is
// to state the next action in full: sell 25% at 8×, which is $604, 31% away.
// A rung you have to compute is a rung you will skip in the exact moment you
// most need it, which is the middle of a vertical green candle.
//
// The ladder itself lives in src/lib/altLadder.js — pure, shared with the data
// layer and the smoke, so the rungs this card draws and the rungs db.js
// advances can never be two different ladders.
import { useState } from "react";
import { T } from "../../theme.js";
import { Card, CellGroup, Cell, Button, Field, Sheet, EmptyState, Dot, Segmented } from "../../ui/kit.jsx";
import {
  ALT_LADDER, ALT_LADDER_PIPS, ALT_SLEEVES, ALT_TRAIL_PCT, ALT_TRAIL_STOP_PCT,
  OVERRIDE_SCORE, OVERRIDE_GREED, OVERRIDE_DOM_DAYS,
  ladderState, regimeOverride,
} from "../../lib/altLadder.js";
import { useSaveAltPosition, useSellAltRung, useCloseAltPosition } from "../../data/altseason.js";
import { isMissingTable } from "../../data/db.js";
import { CARD_STATES } from "../../ui/shared.jsx";

function px(x) {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1000) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (a >= 1) return `$${(Math.round(x * 100) / 100).toFixed(2)}`;
  if (a === 0) return "$0";
  return `$${x.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}

/* The whole plan as pips — four rungs plus the trailing slice, so the widget
   shows what is LEFT as well as what is done. A widget that only drew the rungs
   already sold would be a progress bar for a plan whose last step has no
   target price and never completes. */
function LadderPips({ rungsHit }) {
  return (
    <span style={{ display: "flex", gap: 3, height: 6 }}>
      {Array.from({ length: ALT_LADDER_PIPS }, (_, i) => (
        <span key={i} style={{
          flex: 1, borderRadius: 2,
          background: i < rungsHit ? "var(--accent)"
            : i === rungsHit ? "color-mix(in srgb, var(--accent) 34%, transparent)"
              : "var(--surface-2)",
        }} />
      ))}
    </span>
  );
}

function PositionRow({ pos, price, onSell, onOpen }) {
  const st = ladderState(pos, price);
  const due = st.due;

  let line;
  if (st.trailing) {
    line = `Trailing the last ${ALT_TRAIL_PCT}% behind a ${ALT_TRAIL_STOP_PCT}% stop`;
  } else if (st.next == null) {
    line = "No ladder — set a cost basis";
  } else if (st.awayPct == null) {
    line = `Next: sell ${st.next.sell}% at ${st.next.mult}× — ${px(st.targetPrice)}`;
  } else if (due) {
    line = `DUE: sell ${st.next.sell}% at ${st.next.mult}× — ${px(st.targetPrice)}`;
  } else {
    line = `Next: sell ${st.next.sell}% at ${st.next.mult}× — ${px(st.targetPrice)}, ${Math.round(st.awayPct)}% away`;
  }

  return (
    <Cell
      onClick={() => onOpen(pos)}
      title={
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.04em", color: "var(--ink)" }}>{pos.symbol}</span>
          {due && <span className="t-cap t-num" style={{ color: T.amber, fontWeight: 600 }}>rung due</span>}
        </span>
      }
      sub={
        <span style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, paddingTop: 3 }}>
          <LadderPips rungsHit={st.rungsHit} />
          <span style={{ color: due ? T.amber : "var(--sub)", fontWeight: due ? 600 : 400 }}>{line}</span>
        </span>
      }
      trailing={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
          {due && (
            <Button kind="quiet" size="sm" style={{ height: 44 }}
              onClick={(e) => { e.stopPropagation(); onSell(pos, st.rungsHit); }}>
              Sold
            </Button>
          )}
          <span className="t-num" style={{
            fontSize: 15, fontWeight: 600,
            color: st.mult == null ? "var(--faint)" : st.mult >= 1 ? T.green : T.red,
          }}>
            {st.mult == null ? "—" : `${st.mult.toFixed(st.mult >= 10 ? 0 : 1)}×`}
          </span>
        </span>
      }
    />
  );
}

/* The add/edit sheet. Deliberately four fields: a monitor, not accounting
   software. Units are optional on the first buy — they are only needed to
   weight a later tranche, and demanding them up front would stop someone
   writing down a position at all, which is the failure mode that matters. */
function PositionSheet({ pos, onClose, onSaved }) {
  const save = useSaveAltPosition();
  const close = useCloseAltPosition();
  const editing = !!(pos && pos.id);
  const [symbol, setSymbol] = useState(pos?.symbol || "");
  const [basis, setBasis] = useState(pos?.cost_basis != null ? String(pos.cost_basis) : "");
  const [units, setUnits] = useState(pos?.units != null ? String(pos.units) : "");
  const [sleeve, setSleeve] = useState(pos?.sleeve || "tail");
  const [err, setErr] = useState(null);

  const submit = async () => {
    setErr(null);
    const b = Number(basis);
    if (!symbol.trim()) return setErr("Which coin?");
    if (!Number.isFinite(b) || b <= 0) return setErr("Cost basis has to be a price above zero.");
    try {
      await save.mutateAsync({
        id: pos?.id,
        // coin_id is what joins this row to the live board. Falling back to the
        // lowercased symbol is a genuine guess and only right for the coins
        // whose CoinGecko id happens to match — it is here so a position can be
        // recorded from memory, and the sheet says so rather than pretending.
        coin_id: pos?.coin_id || symbol.trim().toLowerCase(),
        symbol: symbol.trim().toUpperCase(),
        name: pos?.name || null,
        sleeve,
        cost_basis: b,
        units: units.trim() === "" ? null : Number(units),
        rungs_hit: pos?.rungs_hit || 0,
        opened_at: pos?.opened_at,
      });
      onSaved();
    } catch (e) { setErr(e.message || String(e)); }
  };

  return (
    <Sheet onClose={onClose} title={editing ? pos.symbol : "Add a position"}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          {editing && (
            <Button kind="quiet" full onClick={async () => { await close.mutateAsync(pos.id); onSaved(); }}>
              Close position
            </Button>
          )}
          <Button kind="primary" full onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!editing && (
          <Field value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Symbol — e.g. SOL"
            autoFocus autoCapitalize="characters" aria-label="Symbol" />
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="t-label">Average cost</span>
          <Field value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="0.00"
            inputMode="decimal" aria-label="Average cost per unit" />
          <span className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45 }}>
            Every rung is a multiple of this, so it is the one number that has to be right.
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="t-label">Units held</span>
          <Field value={units} onChange={(e) => setUnits(e.target.value)} placeholder="optional"
            inputMode="decimal" aria-label="Units held" />
          <span className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45 }}>
            Only needed to average a later tranche in — a buy with no unit count cannot be weighted.
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="t-label">Sleeve</span>
          <Segmented options={ALT_SLEEVES.map((s) => ({ key: s.key, label: s.label }))} value={sleeve} onChange={setSleeve} />
          <span className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45 }}>
            {(ALT_SLEEVES.find((s) => s.key === sleeve) || {}).sub}
          </span>
        </div>
        {/* The ladder, stated in the sheet where there is room to teach it. The
            row can only ever show the next rung. */}
        <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 7 }}>
          <span className="t-label">The ladder</span>
          {ALT_LADDER.map((r) => (
            <div key={r.mult} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span className="t-cap t-num" style={{ width: 34, flex: "none", color: "var(--ink)", fontWeight: 600 }}>{r.mult}×</span>
              <span className="t-cap t-num" style={{ width: 34, flex: "none", color: "var(--sub)" }}>{r.sell}%</span>
              <span className="t-cap" style={{ color: "var(--faint)", minWidth: 0, lineHeight: 1.4 }}>{r.why}</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span className="t-cap t-num" style={{ width: 34, flex: "none", color: "var(--faint)" }}>—</span>
            <span className="t-cap t-num" style={{ width: 34, flex: "none", color: "var(--sub)" }}>{ALT_TRAIL_PCT}%</span>
            <span className="t-cap" style={{ color: "var(--faint)", minWidth: 0, lineHeight: 1.4 }}>
              Trails behind a {ALT_TRAIL_STOP_PCT}% stop — the slice that catches a 50×
            </span>
          </div>
        </div>
        {err && <div className="t-foot" style={{ color: T.red, lineHeight: 1.5 }}>{err}</div>}
      </div>
    </Sheet>
  );
}

/**
 * @param positions rows from useAltPositions
 * @param priceOf   (coin_id, symbol) → live price, joined from the scan payload
 * @param season    for the regime override footer
 * @param isPending / isError / onRetry — the positions query's state, because
 *                  "no rows yet" and "no rows" are different sentences (below)
 */
export default function AltBookCard({ positions, priceOf, season, fearGreed, domTrend, domSpanDays, error, isPending, isError, onRetry }) {
  const [sheet, setSheet] = useState(null); // {pos} | {} for a new one
  const sellRung = useSellAltRung();
  const rows = Array.isArray(positions) ? positions : [];
  const needsSetup = !!error && isMissingTable(error, "alt_positions");
  // A READ THAT HAS NOT LANDED IS NOT AN EMPTY BOOK. `rows` is [] while the query
  // is pending and [] again when it fails, and both used to fall through to
  // "Nothing tracked yet" — a confident sentence about the database, printed
  // when the database had not answered. Offline on a cold cache (networkMode
  // offlineFirst lands that in `error`, not pending), an RLS or auth failure,
  // any 500 that is not a missing table: the same lie altseason.js throws to
  // avoid on the scan. A failed REFETCH keeps the last rows on screen, as the
  // scan does, so the fallback only replaces the list when there is no list.
  const unread = isError && !needsSetup && positions == null;

  const override = regimeOverride({
    score: season && season.score,
    fearGreed, domTrend, domSpanDays,
  });

  // Cost and value in one pass — the header number is the only place the book
  // is summarised, and summing units×price is the only honest version of it.
  // A position with no unit count contributes to neither side rather than
  // contributing a zero to one of them.
  let cost = 0, value = 0, valued = 0;
  for (const p of rows) {
    const price = priceOf(p);
    if (p.units == null || !Number.isFinite(p.units) || !Number.isFinite(price)) continue;
    cost += p.cost_basis * p.units;
    value += price * p.units;
    valued++;
  }

  return (
    <>
      <Card pad="md">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <span className="t-label">The book</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "none" }}>
            {valued > 0 && (
              <span className="t-cap t-num" style={{ color: "var(--sub)" }}>
                {px(cost)} → <span style={{ color: value >= cost ? T.green : T.red, fontWeight: 600 }}>{px(value)}</span>
              </span>
            )}
            {!needsSetup && (
              <Button kind="plain" size="sm" onClick={() => setSheet({})}
                style={{ height: 44, margin: "-11px -10px", padding: "0 10px", color: "var(--sub)", fontWeight: 500 }}>
                Add
              </Button>
            )}
          </span>
        </div>

        {needsSetup ? (
          <EmptyState title="One migration behind"
            sub="Run supabase/migrations/0035_alt_positions.sql and the book turns on — nothing else is waiting on it." />
        ) : isPending ? (
          /* two rows, the height of two positions, so nothing jumps when they land */
          <div style={{ paddingTop: 6 }}>
            <div className="sk sk-line w60" />
            <div className="sk sk-line w40" />
          </div>
        ) : unread ? (
          /* same anatomy as the panel's FallbackRow: a dot, the reason, a retry */
          <div style={{ background: "var(--surface-2)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 13px", minHeight: 52, marginTop: 8 }}>
            <Dot tone={CARD_STATES.error.color} />
            <span className="t-foot" style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>
              Couldn't read the book{error?.message ? ` — ${error.message}` : ""}. Nothing you hold has changed.
            </span>
            <Button kind="quiet" size="sm" style={{ height: 44, flex: "none" }} onClick={onRetry}>Retry</Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing tracked yet"
            sub="Add what you hold and the ladder does the rest — it tells you the next rung, and when price is already through one." />
        ) : (
          <CellGroup style={{ boxShadow: "none", background: "transparent", borderRadius: 0, margin: "0 -16px -8px" }}>
            {rows.map((p) => (
              <PositionRow key={p.id} pos={p} price={priceOf(p)}
                onOpen={(x) => setSheet({ pos: x })}
                onSell={(x, from) => sellRung.mutate({ id: x.id, from })} />
            ))}
          </CellGroup>
        )}

        {/* The override, armed and visible — and showing its count rather than
            staying silent until the day it fires. A switch nobody has ever seen
            move is a switch nobody believes when it finally does. */}
        {rows.length > 0 && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 7, paddingTop: 2 }}>
            <span style={{ paddingTop: 5, flex: "none" }}>
              <Dot tone={override.armed ? T.red : "var(--faint)"} size={6} pulse={override.armed} />
            </span>
            <span className="t-cap" style={{ color: override.armed ? T.red : "var(--sub)", lineHeight: 1.45, fontWeight: override.armed ? 600 : 400 }}>
              {override.armed
                ? "Regime override FIRED — sell half of everything, ladder position irrelevant."
                : `Regime override ${override.met}/${override.of} — fires at score ${OVERRIDE_SCORE}, greed ${OVERRIDE_GREED}, dominance falling ${OVERRIDE_DOM_DAYS}d.`}
            </span>
          </div>
        )}
      </Card>

      {sheet && (
        <PositionSheet pos={sheet.pos} onClose={() => setSheet(null)} onSaved={() => setSheet(null)} />
      )}
    </>
  );
}
