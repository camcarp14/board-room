// ─── Grocery list — its own tab ───────────────────────────────────────────────
// Lifted out of FoodPanel, not copied: this is the only implementation, and Food
// no longer carries a list of its own. Duplicating it would have meant two
// consumers of the same grocery_items table drifting apart.
//
// It earns a top-level tab because of WHERE it's used — standing in a shop, one
// hand on a trolley. That changes the design brief from the version buried in
// Food: rows are taller, the checkbox is the whole row's target rather than a
// small circle, and "add" stays pinned at the top so you can keep typing without
// hunting. Everything else is the same data and the same optimistic mutations.

import { useState } from "react";
import { useGroceries, useAddGrocery, useToggleGrocery, useDeleteGrocery, useClearCheckedGroceries } from "../../data/food.js";
import { Card, CellGroup, Button, Field, EmptyState, useConfirm, IcCheck } from "../../ui/kit.jsx";
import { IcClose, IcGrocery } from "../../ui/icons.jsx";

// Lets a <button> wear the kit's .cell-body anatomy — rows keep a separate delete
// button, so the whole cell can't be one <button> itself.
const rowBtn = { background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", alignSelf: "stretch", justifyContent: "center" };
// Full-bleed list inside a pad-md card: the group sheds its own surface so row
// hairlines read like native inset cells.
const inCardGroup = { boxShadow: "none", background: "transparent", borderRadius: 0, margin: "0 -16px -10px" };

export function GroceryPanel({ isMobile }) {
  const { data: groceries = null } = useGroceries();
  const addMut = useAddGrocery();
  const toggleMut = useToggleGrocery();
  const delMut = useDeleteGrocery();
  const clearMut = useClearCheckedGroceries();
  const [newItem, setNewItem] = useState("");
  const [confirmEl, confirm] = useConfirm();

  const add = () => {
    const t = newItem.trim();
    if (!t) return;
    // Clear the field immediately, not in onSuccess — in a shop you're typing the
    // next item before the round trip lands, and waiting ate keystrokes.
    setNewItem("");
    addMut.mutate(t);
  };
  const toggle = (it) => toggleMut.mutate({ id: it.id, checked: !it.checked });
  const remove = (id) => delMut.mutate(id);

  const checked = (groceries || []).filter((g) => g.checked);
  const clearChecked = async () => {
    if (!checked.length) return;
    const ok = await confirm({
      title: `Clear ${checked.length} checked item${checked.length === 1 ? "" : "s"}?`,
      message: "They come off the list for good. Unchecked items stay.",
      confirmLabel: "Clear",
      destructive: true,
    });
    if (ok) clearMut.mutate(checked);
  };

  const remaining = (groceries || []).length - checked.length;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span className="t-head">
            {groceries === null ? "Grocery list" : remaining > 0 ? `${remaining} to get` : "Grocery list"}
          </span>
          {checked.length > 0 && (
            <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -8px" }} onClick={clearChecked}>
              Clear {checked.length} checked
            </button>
          )}
        </div>

        {/* Capture first, always in the same place. Enter files it and keeps focus,
            so a whole list goes in without touching anything else. */}
        <div style={{ display: "flex", gap: 8 }}>
          <Field value={newItem} onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Add an item…" enterKeyHint="done"
            style={{ flex: 1, minWidth: 0 }} />
          <Button kind={newItem.trim() ? "primary" : "quiet"} size="md" onClick={add} disabled={!newItem.trim()} style={{ flex: "none" }}>Add</Button>
        </div>

        {groceries === null ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[0, 1, 2].map((i) => <div key={i} className="sk sk-line w60" style={{ margin: 0, height: 30, borderRadius: 8 }} />)}
          </div>
        ) : groceries.length ? (
          <CellGroup style={inCardGroup}>
            {groceries.map((it) => (
              // minHeight 54, not 48: this gets tapped one-handed while walking.
              <div key={it.id} className="cell" style={{ paddingRight: 8, minHeight: 54 }}>
                <button className="cell-body" onClick={() => toggle(it)} role="checkbox" aria-checked={!!it.checked}
                  style={{ ...rowBtn, flexDirection: "row", alignItems: "center", gap: 13 }}>
                  <span aria-hidden style={{
                    width: 24, height: 24, borderRadius: "50%", flex: "none",
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    ...(it.checked ? { background: "var(--green)", color: "#FFFFFF" } : { boxShadow: "inset 0 0 0 1.5px var(--line-strong)" }),
                  }}>
                    {it.checked && <IcCheck size={13} />}
                  </span>
                  <span className="t-body" style={{
                    flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    ...(it.checked ? { color: "var(--faint)", textDecoration: "line-through" } : null),
                  }}>{it.item}</span>
                </button>
                <button className="icon-btn" aria-label={`Delete ${it.item}`} onClick={() => remove(it.id)}><IcClose size={15} /></button>
              </div>
            ))}
          </CellGroup>
        ) : (
          <EmptyState icon={<IcGrocery size={26} />} title="Nothing on the list"
            sub="Add what you need above. It syncs to every device, so you can build it at home and shop from your phone."
            style={{ padding: "22px 12px" }} />
        )}
      </Card>
      {confirmEl}
    </section>
  );
}

export default GroceryPanel;
