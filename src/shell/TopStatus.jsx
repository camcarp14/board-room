// ─── Top status: data freshness · manual refresh (· clock on wide) ───────────
// The phone keeps only what its own status bar doesn't already say: how fresh
// the data is, and the one button that refreshes it.
import { IcRefresh } from "../ui/icons.jsx";
import { Dot } from "../ui/kit.jsx";

export function TopStatus({ now, dataStamp, refreshing, onRefresh, compact }) {
  const d = new Date(now);
  const ageMin = dataStamp ? Math.floor((now - dataStamp) / 60000) : null;
  const fresh = ageMin === null ? "—" : ageMin < 1 ? "Live" : ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin / 60)}h`;
  const tone = ageMin === null ? "var(--faint)" : ageMin < 5 ? "var(--green)" : ageMin < 30 ? "var(--amber)" : "var(--red)";
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
      <button className="icon-btn" onClick={onRefresh} disabled={refreshing} title="Refresh data" aria-label="Refresh data" style={{ position: "relative" }}>
        <IcRefresh size={19} style={{ animation: refreshing ? "spin 0.9s linear infinite" : "none", opacity: refreshing ? 0.6 : 1 }} />
        {compact && <span style={{ position: "absolute", top: 6, right: 5 }}><Dot tone={tone} size={5} pulse={ageMin !== null && ageMin < 1} /></span>}
      </button>
    </div>
  );
}
