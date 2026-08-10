// ─── Top status: data freshness · unsaved writes · manual refresh (· clock) ───
// The phone keeps only what its own status bar doesn't already say: how fresh
// the data is, whether anything he changed failed to reach the database, and the
// one button that refreshes it.
import { createContext, useContext } from "react";
import { IcRefresh } from "../ui/icons.jsx";
import { Dot } from "../ui/kit.jsx";

// Writes that did not land, handed down from App (which subscribes to
// data/db.js's writeFailures store). A context rather than a prop because both
// shells sit between App and this component and neither of them has any business
// knowing about failed writes — and Context.Provider renders no DOM, so it can't
// become the containing block for the fixed chrome the way a wrapper element
// would. The default is the honest empty state, so TopStatus renders exactly as
// it always did anywhere the provider isn't mounted.
export const WriteFailures = createContext({ failed: [], retrying: false, onRetry: null });

export function TopStatus({ now, dataStamp, refreshing, onRefresh, compact }) {
  const d = new Date(now);
  const ageMin = dataStamp ? Math.floor((now - dataStamp) / 60000) : null;
  const fresh = ageMin === null ? "—" : ageMin < 1 ? "Live" : ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin / 60)}h`;
  const tone = ageMin === null ? "var(--faint)" : ageMin < 5 ? "var(--green)" : ageMin < 30 ? "var(--amber)" : "var(--red)";

  // ─── the unsaved chip ──────────────────────────────────────────────────────
  // The freshness pill answers "is what I'm reading current". This answers the
  // other half — "did what I just typed actually get stored" — and until now
  // nothing in the app answered it at all: every failed write went out silently
  // while the UI kept showing the change as saved.
  //
  // Same grammar as the pill beside it: a Dot plus .t-cap, no filled badge
  // (DESIGN.md §8), because it is the same kind of statement about the same
  // data. Red rather than amber — an amber "degraded" reading would be generous
  // about a change that is simply not in the database. It draws ONLY when there
  // is a real recorded failure, and it leaves on its own the moment the retry
  // (or any later write to the same key) succeeds.
  const { failed = [], retrying, onRetry } = useContext(WriteFailures);
  const n = failed.length;
  // The labels are what actually didn't save, which is the useful half of this —
  // "3 unsaved" is a count, "budgets, finance rules" is a thing to go and check.
  // Capped at three so a full outage doesn't produce a paragraph of tooltip.
  const all = [...new Set(failed.map(f => f.label).filter(Boolean))];
  const names = all.length > 3 ? [...all.slice(0, 3), `+${all.length - 3} more`] : all;
  const chipLabel = `${n} change${n === 1 ? "" : "s"} didn't save${names.length ? ` — ${names.join(", ")}` : ""}.`
    + (retrying ? " Retrying…" : onRetry ? " Tap to retry." : "");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: compact ? 2 : 12, flex: "none" }}>
      {!compact && (
        <span className="t-num" style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1 }}>
          {d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </span>
      )}
      {!compact && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={ageMin === null ? "No data yet" : `Data ${fresh === "Live" ? "live" : fresh + " old"}`}>
          <Dot tone={tone} size={6} pulse={ageMin !== null && ageMin < 1} />
          <span className="t-cap" style={{ color: tone, fontWeight: 600 }}>{fresh}</span>
        </span>
      )}
      {n > 0 && (
        <button
          onClick={onRetry}
          disabled={retrying || !onRetry}
          title={chipLabel}
          aria-label={chipLabel}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, flex: "none",
            background: "none", border: "none", padding: 0, margin: 0,
            marginRight: compact ? 4 : 0,
            cursor: retrying || !onRetry ? "default" : "pointer",
          }}
        >
          <Dot tone="var(--red)" size={6} />
          <span className="t-cap" style={{ color: "var(--red)", fontWeight: 600, whiteSpace: "nowrap" }}>
            {retrying ? "Retrying…" : `${n} unsaved`}
          </span>
        </button>
      )}
      <button className="icon-btn" onClick={onRefresh} disabled={refreshing} title="Refresh data" aria-label="Refresh data" style={{ position: "relative" }}>
        <IcRefresh size={19} style={{ animation: refreshing ? "spin 0.9s linear infinite" : "none", opacity: refreshing ? 0.6 : 1 }} />
        {compact && <span style={{ position: "absolute", top: 6, right: 5 }}><Dot tone={tone} size={5} pulse={ageMin !== null && ageMin < 1} /></span>}
      </button>
    </div>
  );
}
