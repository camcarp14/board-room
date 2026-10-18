import { Dot } from "../../ui/kit.jsx";
import { kindMeta, fmtTime, fmtDur } from "./planLogic.js";

// ─── "Now" and "Next", drawn once ─────────────────────────────────────────────
// The Plan tab and the Brief's plan card both answer the same question — where
// should I be right now — and they must not answer it in two voices. So both
// render this, from the same whereAmI() result; `compact` only trims the type
// scale for the Brief, never what is said.
//
// Gold appears once here, on the live dot, which is a live indicator by
// DESIGN.md §1.4's own list. The block's own colour is its kind, and it marks
// the dot beside the title and the progress fill — identity, not status.

const diamond = (size, color) => ({ width: size, height: size, flex: "none", transform: "rotate(45deg)", borderRadius: 1.5, background: color });

/** "6:15 AM" → ["6:15", "AM"], so the meridiem can step back a size. */
export const splitTime = (mins) => {
  const s = fmtTime(mins);
  const i = s.lastIndexOf(" ");
  return [s.slice(0, i), s.slice(i + 1)];
};

export function PlanNow({ where, compact }) {
  const { current, next, minutesLeft, progress } = where || {};
  if (!current && !next) return null;

  // Before the day starts with nothing carried over from last night — a fresh
  // template, or a weekend plan with no late block. Say when the day begins
  // rather than inventing a block to be "in".
  if (!current) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="t-label">Before your day</span>
        <span className={compact ? "t-head" : "t-title2"} style={{ textWrap: "balance" }}>
          Starts at {fmtTime(next.startMin)} with {next.title}
        </span>
        <span className="t-cap t-num" style={{ color: "var(--faint)" }}>in {fmtDur(minutesLeft)}</span>
      </div>
    );
  }

  const k = kindMeta(current.kind);
  const pct = Math.round(Math.max(0, Math.min(1, progress ?? 0)) * 100);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 6 : 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Dot tone="var(--accent)" pulse size={7} />
        <span className="t-label" style={{ color: "var(--ink)" }}>Now</span>
        <span className="t-cap t-num" style={{ color: "var(--faint)", marginLeft: "auto", whiteSpace: "nowrap" }}>
          until {fmtTime(current.endMin)}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
        <span aria-hidden style={{ ...diamond(compact ? 7 : 8, k.tone), alignSelf: "center" }} />
        <span className={compact ? "t-head" : "t-title2"} style={{ minWidth: 0, textWrap: "balance" }}>{current.title}</span>
      </div>
      {current.note && (
        <span className="t-foot" style={{ lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: compact ? 2 : 4, WebkitBoxOrient: "vertical" }}>
          {current.note}
        </span>
      )}
      {current.protected && (
        // Words, not a padlock: "locked" would read as something the app is
        // enforcing, and nothing here can stop a laptop opening. It is a promise
        // he wrote, said back at the moment he's deciding whether to keep it.
        <span className="t-cap" style={{ color: "var(--ink)", display: "inline-flex", alignItems: "center", gap: 7 }}>
          <span aria-hidden style={diamond(6, k.tone)} />
          Protected — nothing gets scheduled over this.
        </span>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
        <div aria-hidden style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--ink-a05)", overflow: "hidden" }}>
          {/* transform, not width — DESIGN.md §5 animates transforms only. */}
          <div style={{ height: "100%", width: "100%", borderRadius: 999, background: k.tone, transformOrigin: "left center", transform: `scaleX(${pct / 100})`, transition: "transform var(--dur-3) var(--ease-out)" }} />
        </div>
        <span className="t-cap t-num" style={{ color: "var(--sub)", flex: "none" }}>{fmtDur(minutesLeft)} left</span>
      </div>
      {next && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, paddingTop: compact ? 2 : 4 }}>
          <span className="t-cap" style={{ color: "var(--faint)", flex: "none" }}>Next</span>
          <span className="t-cap t-num" style={{ color: "var(--sub)", flex: "none" }}>
            {next.tomorrow ? "tomorrow " : ""}{fmtTime(next.startMin)}
          </span>
          <span aria-hidden style={diamond(5, kindMeta(next.kind).tone)} />
          <span className="t-call" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{next.title}</span>
        </div>
      )}
    </div>
  );
}
