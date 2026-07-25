// ─── Grocery — the list, promoted to its own tab ──────────────────────────────
// Thin page shell, same well and padding grammar as Train and Personal. The list
// itself lives in features/food/GroceryPanel.jsx, which is now its ONLY home —
// Food no longer carries a copy.
//
// Narrower well than the other pages (620 vs 900): a shopping list is one column
// of short rows, and stretching it across a desktop monitor just puts the delete
// button a mouse-journey away from the item it belongs to.
import { GroceryPanel } from "../../features/food/GroceryPanel.jsx";

export function GroceryPage({ isMobile }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 620, margin: "0 auto", display: "flex", flexDirection: "column", minWidth: 0, padding: isMobile ? "0 16px" : 0 }}>
        <GroceryPanel isMobile={isMobile} />
      </div>
    </div>
  );
}

export default GroceryPage;
