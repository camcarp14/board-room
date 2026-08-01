// ─── Finances — the money, its own tab ────────────────────────────────────────
// Thin shell, same well and padding grammar as the other pages. Everything lives
// in features/finances/FinancesPanel.jsx.
//
// 720 rather than Grocery's 620 or Personal's 900: a breakdown is a column of
// bars that reads best at a comfortable measure, and the ledger underneath has
// four things on a row (name, category, amount, date) that get cramped much
// below this. Wider than that and the amount column drifts a mouse-journey away
// from the merchant it belongs to.
//
// settings/updateSetting carry the one thing kept per-account rather than per
// device: app_settings.finance_budgets. Budgets you set at a desk have to be the
// budgets you're measured against on a phone, or the feature means nothing.
import { FinancesPanel } from "../../features/finances/FinancesPanel.jsx";

export function FinancesPage({ isMobile, settings, updateSetting }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0, padding: isMobile ? "0 16px" : 0 }}>
        <FinancesPanel isMobile={isMobile} settings={settings} updateSetting={updateSetting} />
      </div>
    </div>
  );
}

export default FinancesPage;
