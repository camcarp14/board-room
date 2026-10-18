import { useMemo } from "react";
import { CollapsibleCard, Button } from "../../ui/kit.jsx";
import { IcChevronRight } from "../../ui/icons.jsx";
import { usePlanClock, useTakingLong } from "../../features/plan/usePlanClock.js";
import { PlanNow } from "../../features/plan/PlanNow.jsx";
import { PLAN_SETTING, DAY_TYPES, normalizePlan, whereAmI } from "../../features/plan/planLogic.js";

// ─── The Brief's plan card — the guardrail where you already look ─────────────
// The Plan tab is where the day gets written; this is where it gets READ. The
// morning this feature exists for is the one where you wake up feeling behind
// and open the laptop at 7 — and on that morning you open the Brief, not a tab
// whose whole message is the thing you're about to ignore. So the Brief leads
// with where you should be right now, what's next, and the lines you wrote for
// exactly this moment.
//
// It is FIRST in the catalogue (lib/brief-cards.js) on purpose, and that is the
// one exception to lib/brief-order.js's rule that a new card shouldn't shove
// itself to the top: a guardrail below the fold is not a guardrail. It can be
// moved or switched off like any other card.
//
// Reads app_settings.daily_plan straight off `settings` — nothing to fetch, so
// nothing to go stale and no network. Until settings arrive it is a skeleton,
// never "no plan yet": that sentence would be a claim about a row it hasn't read.

const RULES_SHOWN = 3;

export function PlanTile({ isMobile, settings, collapsed, onToggle, onOpenPlan }) {
  const now = usePlanClock();
  const loaded = settings != null;
  const stored = settings?.[PLAN_SETTING];
  const plan = useMemo(() => normalizePlan(stored), [stored]);
  const where = useMemo(() => whereAmI(plan, now), [plan, now]);
  const day = plan[where.type];
  const label = DAY_TYPES.find((d) => d.key === where.type);
  const rules = day.rules.slice(0, RULES_SHOWN);
  const slow = useTakingLong(!loaded);

  return (
    <CollapsibleCard collapsed={collapsed} onToggle={onToggle} pad={isMobile ? "md" : "lg"} tight title="Today's Plan"
      trailing={onOpenPlan && (
        <button className="sec-link" onClick={onOpenPlan} aria-label={`Open the ${label.short.toLowerCase()} plan`} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          {label.short}<IcChevronRight size={12} />
        </button>
      )}>
      {!loaded && slow ? (
        <div className="t-foot" style={{ color: "var(--faint)", padding: "4px 0", lineHeight: 1.5 }}>
          Your saved settings haven't loaded, so the plan can't be shown. Pull down to refresh.
        </div>
      ) : !loaded ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 2 }}>
          <div className="sk sk-line w60" style={{ margin: 0 }} />
          <div className="sk sk-line w80" style={{ margin: 0 }} />
          <div className="sk sk-line w40" style={{ margin: 0 }} />
        </div>
      ) : !day.blocks.length ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, padding: "2px 0" }}>
          <span className="t-foot" style={{ lineHeight: 1.55 }}>
            No {label.short.toLowerCase()} plan yet. Set how the day should go once, and this card keeps you to it every morning.
          </span>
          {onOpenPlan && <Button kind="tinted" size="sm" onClick={onOpenPlan}>Set the plan</Button>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <PlanNow where={where} compact />
          {rules.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 10, borderTop: "0.5px solid var(--line)" }}>
              {rules.map((r) => (
                <div key={r.id} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                  <span aria-hidden style={{ width: 5, height: 5, flex: "none", marginTop: 7, transform: "rotate(45deg)", borderRadius: 1, background: "var(--sub)" }} />
                  <span className="t-call" style={{ color: "var(--sub)", lineHeight: 1.5 }}>{r.text}</span>
                </div>
              ))}
              {day.rules.length > RULES_SHOWN && (
                <span className="t-cap" style={{ color: "var(--faint)", paddingLeft: 14 }}>
                  +{day.rules.length - RULES_SHOWN} more on the Plan tab
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </CollapsibleCard>
  );
}
