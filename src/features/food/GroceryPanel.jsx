// ─── Grocery list — its own tab ───────────────────────────────────────────────
// Lifted out of FoodPanel, not copied: this is the only implementation, and Food
// no longer carries a list of its own.
//
// It earns a top-level tab because of WHERE it's used — standing in a shop, one
// hand on a trolley — and that setting drives every decision here:
//
//   ORDERED BY THE WALK, not by when you typed. Items group into aisles in the
//   order you reach them (groceryLogic.js owns the lexicon and the ordering), so
//   the list stops sending you back across the shop for the milk you added last.
//   Nothing about this is stored: aisle is derived from the item text, because
//   grocery_items has no column for it.
//
//   QUANTITIES, without a column for those either. "2x milk" is parsed out of the
//   text and shown as a stepper; adding something already on the list bumps that
//   row instead of opening a second line saying the same word.
//
//   INSTANT. Every mutation is optimistic (see data/food.js) — a tap moves the
//   row now, not when Supabase answers, because in a shop with one bar the old
//   invalidate-on-success behaviour read as an unresponsive app and got tapped
//   twice.
//
//   WHAT YOU ACTUALLY BUY. Clearing the cart is the only trustworthy signal of a
//   real purchase, so that's what feeds the "Often" chips — not what got typed
//   and later deleted.

import { useMemo, useState } from "react";
import {
  useGroceries, useAddGrocery, useToggleGrocery, useDeleteGrocery,
  useClearCheckedGroceries, useSetGroceryQty, useGroceryFrequency,
} from "../../data/food.js";
import { Card, Button, Field, EmptyState, Pill, Dot, useConfirm, IcCheck } from "../../ui/kit.jsx";
import { IcClose, IcGrocery, IcChevronDown } from "../../ui/icons.jsx";
import { NumTween } from "../../ui/primitives.jsx";
import { groupList, parseItem, frequentSuggestions } from "./groceryLogic.js";

// Lets a <button> wear the kit's .cell-body anatomy — rows keep separate stepper
// and delete controls, so the whole cell can't be one <button> itself.
const rowBtn = { background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", alignSelf: "stretch", justifyContent: "center" };

/* One row. Checkbox is the row body (the big target); stepper and delete sit
   outside it so a tap on either can't also toggle the item. */
function Row({ it, onToggle, onQty, onDelete }) {
  const { qty, name } = parseItem(it.item);
  return (
    <div className="cell tappable" style={{ paddingRight: 6, minHeight: 54, gap: 8 }}>
      <button className="cell-body" onClick={onToggle} role="checkbox" aria-checked={!!it.checked}
        style={{ ...rowBtn, flexDirection: "row", alignItems: "center", gap: 13 }}>
        <span aria-hidden style={{
          width: 24, height: 24, borderRadius: "50%", flex: "none",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          transition: "background var(--dur-1) ease, box-shadow var(--dur-1) ease",
          ...(it.checked ? { background: "var(--green)", color: "#FFFFFF" } : { boxShadow: "inset 0 0 0 1.5px var(--line-strong)" }),
        }}>
          {/* Wrapped, not classed directly: the icon factory in icons.jsx builds
              its own attribute set and drops className, so the animation has to
              live on an element it doesn't own. */}
          {it.checked && <span className="gro-tick" style={{ display: "inline-flex" }}><IcCheck size={13} /></span>}
        </span>
        <span className="t-body" style={{
          flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          ...(it.checked ? { color: "var(--faint)", textDecoration: "line-through" } : null),
        }}>{name}</span>
      </button>

      {/* Steppers are for the list you're still shopping — a checked row is
          settled, and four controls on it would be noise. */}
      {!it.checked && (
        <span className="gro-step">
          {qty > 1 && (
            <button aria-label={`One fewer ${name}`} onClick={() => onQty(qty - 1)}>−</button>
          )}
          <span className="gro-qty" aria-label={`Quantity ${qty}`}>{qty}</span>
          <button aria-label={`One more ${name}`} onClick={() => onQty(qty + 1)}>+</button>
        </span>
      )}
      <button className="icon-btn" aria-label={`Delete ${name}`} onClick={onDelete}><IcClose size={15} /></button>
    </div>
  );
}

/* Aisle heading. The dot carries the aisle's tone so a glance down the list reads
   as sections rather than one long column of text. */
function AisleHead({ label, tone, count }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 2px 5px" }}>
      <Dot tone={tone} size={6} />
      <span className="t-label">{label}</span>
      <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{count}</span>
    </div>
  );
}

/* Skeleton shaped like the list it resolves into — two aisle headings with rows
   under them, not a spinner and not three generic bars. */
function ListSkeleton() {
  return (
    <div>
      {[0, 1].map((s) => (
        <div key={s}>
          <div className="sk sk-line w40" style={{ height: 9, margin: "14px 2px 8px" }} />
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 13, minHeight: 54 }}>
              <div className="sk" style={{ width: 24, height: 24, borderRadius: "50%", flex: "none" }} />
              <div className="sk sk-line" style={{ margin: 0, flex: 1, maxWidth: i === 1 ? "45%" : "62%" }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function GroceryPanel({ isMobile }) {
  const { data: groceries = null, isError, refetch } = useGroceries();
  const { data: frequency } = useGroceryFrequency();
  const addMut = useAddGrocery();
  const toggleMut = useToggleGrocery();
  const delMut = useDeleteGrocery();
  const qtyMut = useSetGroceryQty();
  const clearMut = useClearCheckedGroceries();
  const [newItem, setNewItem] = useState("");
  const [cartOpen, setCartOpen] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const { sections, cart, remaining, total } = useMemo(() => groupList(groceries || []), [groceries]);
  const suggestions = useMemo(() => frequentSuggestions(frequency, groceries || []), [frequency, groceries]);

  const add = (text) => {
    const t = String(text ?? newItem).trim();
    if (!t) return;
    // Clear the field immediately, not in onSuccess — in a shop you're typing the
    // next item before the round trip lands, and waiting ate keystrokes.
    if (text == null) setNewItem("");
    addMut.mutate(t);
  };
  const toggle = (it) => toggleMut.mutate({ id: it.id, checked: !it.checked });
  const setQty = (it, qty) => {
    // Stepping below one is a delete in disguise; make it the real thing rather
    // than leaving a "0x milk" row on the list.
    if (qty < 1) return delMut.mutate(it.id);
    qtyMut.mutate({ id: it.id, qty, item: it.item });
  };

  const clearChecked = async () => {
    if (!cart.length) return;
    const ok = await confirm({
      title: `Clear ${cart.length} checked item${cart.length === 1 ? "" : "s"}?`,
      message: "They come off the list for good, and count towards what shows up under Often. Unchecked items stay.",
      confirmLabel: "Clear",
      destructive: true,
    });
    if (ok) clearMut.mutate(cart);
  };

  const pct = total ? Math.round((cart.length / total) * 100) : 0;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span className="t-head">
              {groceries === null ? "Grocery list"
                : remaining > 0 ? <><NumTween v={remaining} f={(n) => String(Math.round(n))} /> to get</>
                : total > 0 ? "All in the cart" : "Grocery list"}
            </span>
            {cart.length > 0 && (
              <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{cart.length} of {total} in the cart</span>
            )}
          </div>
          {/* Progress only exists once there's something to be partway through. */}
          {total > 0 && cart.length > 0 && (
            <div className="gro-rail" style={{ marginTop: 8 }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>

        {/* Capture first, always in the same place. Enter files it and keeps focus,
            so a whole list goes in without touching anything else. */}
        <div style={{ display: "flex", gap: 8 }}>
          <Field value={newItem} onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Add an item — or “2x milk”" enterKeyHint="done"
            style={{ flex: 1, minWidth: 0 }} />
          <Button kind={newItem.trim() ? "primary" : "quiet"} size="md" onClick={() => add()} disabled={!newItem.trim()} style={{ flex: "none" }}>Add</Button>
        </div>

        {/* Learned from cleared carts, so it stays empty until you've actually
            shopped twice — no cold-start guesses about what you buy. */}
        {suggestions.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="t-cap" style={{ color: "var(--faint)", flex: "none" }}>Often</span>
            {suggestions.map((s) => (
              <Pill key={s.key} onClick={() => add(s.label)}>{s.label}</Pill>
            ))}
          </div>
        )}

        {/* Unreachable list with nothing cached: say so and offer the retry,
            rather than a skeleton that shimmers forever. Once there IS a cached
            list, a failed refresh leaves it on screen and says nothing — the
            last known list is more use in a shop than an error about it. */}
        {groceries === null && isError ? (
          <EmptyState icon={<IcGrocery size={26} />} title="Couldn't reach the list"
            sub="The connection dropped before the list came back. Nothing has been lost — try again."
            action={<Button kind="tinted" size="sm" onClick={() => refetch()}>Retry</Button>}
            style={{ padding: "22px 12px" }} />
        ) : groceries === null ? <ListSkeleton /> : total === 0 ? (
          <EmptyState icon={<IcGrocery size={26} />} title="Nothing on the list"
            sub="Add what you need above and it sorts itself into aisles. It syncs to every device, so you can build it at home and shop from your phone."
            style={{ padding: "22px 12px" }} />
        ) : (
          <div style={{ margin: "0 -16px -10px" }}>
            {/* Aisles rise in on load; the inline --i keeps the stagger correct
                past the stylesheet's nth-child ceiling. */}
            <div className="stagger">
              {sections.map((sec, i) => (
                <div key={sec.key} style={{ "--i": String(Math.min(i, 5)) }}>
                  <div style={{ padding: "0 16px" }}>
                    <AisleHead label={sec.label} tone={sec.tone} count={sec.items.length} />
                  </div>
                  {sec.items.map((it) => (
                    <Row key={it.id} it={it}
                      onToggle={() => toggle(it)}
                      onQty={(q) => setQty(it, q)}
                      onDelete={() => delMut.mutate(it.id)} />
                  ))}
                </div>
              ))}
            </div>

            {/* The cart, folded away. What's already in the trolley is reference,
                not the thing you're working from — but it has to stay reachable,
                because unchecking a mis-tap is the most common correction here. */}
            {cart.length > 0 && (
              <div style={{ padding: "0 16px", marginTop: sections.length ? 6 : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "0.5px solid var(--line)", paddingTop: 4 }}>
                  <button className="sec-link press" onClick={() => setCartOpen((o) => !o)}
                    aria-expanded={cartOpen}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "12px 8px 12px 0", margin: 0, flex: 1, justifyContent: "flex-start" }}>
                    In the cart · {cart.length}
                    <IcChevronDown size={13} style={{ transform: cartOpen ? "rotate(180deg)" : "none", transition: "transform var(--dur-2) var(--ease-out)" }} />
                  </button>
                  <button className="sec-link" style={{ padding: "12px 0" }} onClick={clearChecked}>Clear</button>
                </div>
                <div className={`expand${cartOpen ? " open" : ""}`} style={{ margin: "0 -16px" }}>
                  <div>
                    {cart.map((it) => (
                      <Row key={it.id} it={it}
                        onToggle={() => toggle(it)}
                        onQty={(q) => setQty(it, q)}
                        onDelete={() => delMut.mutate(it.id)} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
      {confirmEl}
    </section>
  );
}

export default GroceryPanel;
