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
//   STORES AND SECTIONS, on the same terms. A store is a trailing "@Costco" and a
//   pinned section a trailing "#Freezer" — no migration, no new columns, and the
//   syntax is typeable, so "milk @costco" in the add field does what the pills do.
//   Picking a store filters the list to that shop AND tags everything you add
//   next, which is the whole gesture: choose the shop once, then just type.
//
//   YOUR ORDER WITHIN THE WALK. Hold a row and drag it. The aisle grouping still
//   decides which section you're in — that's the part that saves you walking —
//   and the drag decides the sequence inside it, saved per-account in
//   app_settings.grocery_order exactly like the Brief's card order.
//
//   TITLE CASE, ALWAYS. Applied on the way in and on the way out (see titleCase),
//   so rows typed months ago read the same as the one you just added.
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
  useClearCheckedGroceries, useSetGroceryQty, useGroceryFrequency, useEditGrocery,
  useRetagGroceryStore,
} from "../../data/food.js";
import { Card, Button, Field, EmptyState, Pill, PillRow, Segmented, Dot, useConfirm, IcCheck } from "../../ui/kit.jsx";
import { IcClose, IcGrocery, IcChevronDown } from "../../ui/icons.jsx";
import { NumTween } from "../../ui/primitives.jsx";
import { SortableList } from "../../ui/SortableList.jsx";
import { StoreRoute } from "./StoreRoute.jsx";
import {
  groupList, parseItem, formatItem, frequentSuggestions, isTempId,
  storesOf, aisleOf, aisleMeta, titleCase, planRetag, storeCounts, isStore, ANY_STORE,
} from "./groceryLogic.js";

// Lets a <button> wear the kit's .cell-body anatomy — rows keep separate stepper
// and delete controls, so the whole cell can't be one <button> itself.
const rowBtn = { background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", alignSelf: "stretch", justifyContent: "center" };

// Sentinel key for the "+ Store" pill. Angle brackets can't collide with a
// real store: names are trimmed and Title Cased before they are saved, so
// nothing that reaches the picker ever looks like this.
const NEW_STORE = "<new-store>";

/* The store indicator. A tinted pill rather than a word in accent text: at
   11px, coloured text beside a white item name reads as a typo, whereas a
   filled chip reads as a tag. Muted is the "any store" variant — present, but
   never louder than the item it qualifies. */
function StoreBadge({ label, muted }) {
  return (
    <span className="t-cap" style={{
      flex: "none", padding: "2px 7px", borderRadius: 999, lineHeight: 1.35,
      whiteSpace: "nowrap", fontWeight: 600,
      background: muted ? "var(--ink-a05)" : "var(--accent-a12)",
      color: muted ? "var(--faint)" : "var(--accent)",
    }}>{label}</span>
  );
}

/* One row. The circle checks the item off; the NAME opens the editor.
   That split is deliberate and borrowed from Reminders: checking off is the
   thing you do fifty times in a shop, so it keeps the unmissable target, while
   editing — rare, and destructive if it fires by accident — needs an aim. The
   old row made the entire body one checkbox, which left nowhere to put an edit
   gesture that wasn't also a mis-tap waiting to happen.

   `pending` is a row whose insert is still in flight: it has a temporary id, so
   there is no server row to check off, renumber or delete yet, and every request
   built from that id comes back 400. It reads as slightly faded and ignores taps
   for the one round trip it takes to become real. */
function Row({ it, pending, anyStore, onToggle, onQty, onDelete, onEdit }) {
  const { qty, name, store } = parseItem(it.item);
  return (
    <div className="cell tappable" style={{ paddingRight: 6, minHeight: 54, gap: 4, ...(pending ? { opacity: 0.5 } : null) }}
      aria-busy={pending || undefined}>
      <button onClick={onToggle} role="checkbox" aria-checked={!!it.checked} disabled={pending}
        aria-label={`${it.checked ? "Uncheck" : "Check off"} ${name}`}
        style={{ ...rowBtn, display: "flex", alignItems: "center", flex: "none", width: 44, marginLeft: -6, justifyContent: "flex-start" }}>
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
      </button>

      {/* justifyContent must be overridden, not inherited: rowBtn centres its
          content (it was written for the old column-stacked body), and left at
          centre the item name floats into the middle of the row with a gulf
          between it and its own checkbox. */}
      <button className="cell-body" onClick={onEdit} disabled={pending} aria-label={`Edit ${name}`}
        style={{ ...rowBtn, flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 7, flex: 1, minWidth: 0 }}>
        <span className="t-body" style={{
          minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          ...(it.checked ? { color: "var(--faint)", textDecoration: "line-through" } : null),
        }}>{name}</span>
        {/* The badge is the answer to "which shop is this for", so it is always
            on the row that has one. It used to hide itself under a store filter
            as redundant — but that made the store invisible everywhere you were
            actually working, and an item you'd just tagged looked no different
            from one you hadn't. Under a store view the interesting badge is the
            opposite one: `anyStore` marks the staples that follow you into every
            shop, so a Costco list reads as Costco plus clearly-marked strays. */}
        {store && <StoreBadge label={store} />}
        {anyStore && <StoreBadge label="any store" muted />}
      </button>

      {/* Steppers are for the list you're still shopping — a checked row is
          settled, and four controls on it would be noise. */}
      {!it.checked && (
        <span className="gro-step">
          {qty > 1 && (
            <button aria-label={`One fewer ${name}`} onClick={() => onQty(qty - 1)} disabled={pending}>−</button>
          )}
          <span className="gro-qty" aria-label={`Quantity ${qty}`}>{qty}</span>
          <button aria-label={`One more ${name}`} onClick={() => onQty(qty + 1)} disabled={pending}>+</button>
        </span>
      )}
      <button className="icon-btn" aria-label={`Delete ${name}`} onClick={onDelete} disabled={pending}><IcClose size={15} /></button>
    </div>
  );
}

/* The editor, opened by tapping a row's name. Everything a row can be is here in
   one place — its words, how many, which shop, which heading — because the four
   are one string in the database and editing them one at a time would mean four
   round trips to change "milk" into "2x Whole Milk @Costco".

   The section field shows the aisle the lexicon would pick as its placeholder,
   so leaving it empty visibly means "keep guessing" rather than "no section". */
function RowEditor({ it, stores, onSave, onCancel }) {
  const parsed = parseItem(it.item);
  const [name, setName] = useState(parsed.name);
  const [store, setStore] = useState(parsed.store);
  const [section, setSection] = useState(parsed.section);
  const autoAisle = aisleMeta(aisleOf(it.item)).label;

  const save = () => {
    const n = name.trim();
    if (!n) return; // an empty name would render an unreachable, untappable row
    onSave(formatItem(parsed.qty, n, { store, section }));
  };

  return (
    <div style={{ padding: "10px 16px 14px", display: "flex", flexDirection: "column", gap: 10, background: "var(--surface-2)" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Field value={name} onChange={(e) => setName(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") onCancel(); }}
          placeholder="Item name" enterKeyHint="done" style={{ flex: 1, minWidth: 0 }} />
        <Button kind="primary" size="md" onClick={save} disabled={!name.trim()} style={{ flex: "none" }}>Save</Button>
        <Button kind="quiet" size="md" onClick={onCancel} style={{ flex: "none" }}>Cancel</Button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="t-cap" style={{ color: "var(--faint)", flex: "none", width: 46 }}>Store</span>
        <Pill active={!store} onClick={() => setStore("")}>Any</Pill>
        {stores.map((s) => (
          <Pill key={s} active={store.toLowerCase() === s.toLowerCase()} onClick={() => setStore(s)}>{s}</Pill>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="t-cap" style={{ color: "var(--faint)", flex: "none", width: 46 }}>Section</span>
        <Field value={section} onChange={(e) => setSection(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") onCancel(); }}
          placeholder={`Auto · ${autoAisle}`} style={{ flex: 1, minWidth: 0 }} />
        {section && <Button kind="quiet" size="md" onClick={() => setSection("")} style={{ flex: "none" }}>Auto</Button>}
      </div>
    </div>
  );
}

/* Aisle heading. The dot carries the aisle's tone so a glance down the list reads
   as sections rather than one long column of text. A section you named yourself
   is marked, so it's obvious which headings are yours and which are guesses. */
function AisleHead({ label, tone, count, pinned, note }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 2px 5px" }}>
      <Dot tone={tone} size={6} />
      <span className="t-label">{label}</span>
      {pinned && <span className="t-cap" style={{ color: "var(--faint)" }}>pinned</span>}
      <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{count}</span>
      {note && <span className="t-cap" style={{ color: "var(--faint)" }}>· {note}</span>}
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

export function GroceryPanel({ isMobile, settings, updateSetting }) {
  const { data: groceries = null, isError, refetch } = useGroceries();
  const { data: frequency } = useGroceryFrequency();
  const addMut = useAddGrocery();
  const toggleMut = useToggleGrocery();
  const delMut = useDeleteGrocery();
  const qtyMut = useSetGroceryQty();
  const editMut = useEditGrocery();
  const retagMut = useRetagGroceryStore();
  const clearMut = useClearCheckedGroceries();
  const [newItem, setNewItem] = useState("");
  const [cartOpen, setCartOpen] = useState(false);
  const [view, setView] = useState("list");   // "list" | "route" — see below
  const [store, setStore] = useState("");     // "" = every store
  // null | { mode: "new" } | { mode: "edit", original } — one form, because
  // naming a store and renaming one are the same field with a different verb.
  const [storeForm, setStoreForm] = useState(null);
  const [storeDraft, setStoreDraft] = useState("");
  const [editing, setEditing] = useState(null); // row id whose editor is open
  // { name, store } — the receipt for an edit that moved a row out of the view
  // you were looking at. See saveEdit.
  const [moved, setMoved] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const savedStores = settings?.grocery_stores;
  const order = settings?.grocery_order;
  const savedRoutes = settings?.store_routes;
  const stores = useMemo(() => storesOf(groceries || [], savedStores), [groceries, savedStores]);
  // The filter must not survive its store: delete the last Costco item and an
  // invisible filter would leave you staring at an empty list you can't explain.
  const activeStore = stores.some((s) => s.toLowerCase() === store.toLowerCase()) ? store : "";
  const { sections, anywhere, cart, remaining, total } = useMemo(
    () => groupList(groceries || [], { store: activeStore, order }), [groceries, activeStore, order]);
  const counts = useMemo(() => storeCounts(groceries || []), [groceries]);
  const suggestions = useMemo(() => frequentSuggestions(frequency, groceries || []), [frequency, groceries]);

  // One composer for every entry point — the field, the Often chips, a retry —
  // so "which store does this land in" has exactly one answer.
  const compose = (text) => {
    const p = parseItem(text);
    if (!p.name) return "";
    return formatItem(p.qty, p.name, { store: p.store || activeStore, section: p.section });
  };
  const add = (text) => {
    const t = compose(String(text ?? newItem));
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
  const saveEdit = (it, item) => {
    setEditing(null);
    if (item === it.item) return;
    editMut.mutate({ id: it.id, item });
    // Tagging a row to another shop while you're looking at THIS one makes it
    // vanish, which is correct and reads exactly like a delete. So say where it
    // went and offer the trip — the single most confusing thing about a
    // filtered list, answered in one line instead of a support question.
    const next = parseItem(item);
    setMoved(activeStore && !isStore(item, activeStore) && next.store
      ? { name: next.name, store: next.store } : null);
  };

  /* Stores: add, rename, remove.
     Rename and remove are the same operation with a different destination —
     see planRetag, which also merges rather than colliding when a rename lands
     a row on top of one that already exists at the target. */
  const pickStore = (k) => { setMoved(null); setStore(k); };
  const openNewStore = () => { setStoreDraft(""); setStoreForm({ mode: "new" }); };
  const openEditStore = () => { setStoreDraft(activeStore); setStoreForm({ mode: "edit", original: activeStore }); };
  const closeStoreForm = () => { setStoreDraft(""); setStoreForm(null); };
  // Rows whose insert is still in flight have no server row to rewrite, so they
  // are excluded from the plan rather than sent — one temporary id inside the
  // bulk write is a 400 that takes the whole rename with it.
  const settled = () => (groceries || []).filter((it) => !isTempId(it.id));
  const taggedCount = (name) =>
    (groceries || []).filter((it) => parseItem(it.item).store.toLowerCase() === String(name).toLowerCase()).length;

  const saveStore = () => {
    const name = titleCase(storeDraft.trim());
    if (!name) return;
    const original = storeForm?.mode === "edit" ? storeForm.original : "";
    closeStoreForm();
    if (original && original.toLowerCase() === name.toLowerCase() && original === name) return;
    if (original) {
      // The items carry the store, so a rename is a rewrite of all of them —
      // and the saved list is only rewritten if that SUCCEEDS. Writing the
      // setting eagerly meant a failed retag left the new name saved while
      // every item still carried the old one, so storesOf derived both and the
      // picker showed two shops where you had renamed one.
      //
      // Nothing is lost by waiting: the optimistic retag has already changed
      // the items, and the picker reads the new name off them immediately. The
      // setting only has to persist a store that owns no items.
      retagMut.mutate(planRetag(settled(), original, name), {
        onSuccess: () => updateSetting?.("grocery_stores", storesOf([], [...(savedStores || []).filter((s) => s !== original), name])),
      });
    } else {
      // Saved separately from the items so a store you just named survives
      // having nothing in it yet — otherwise it would vanish between naming it
      // and adding the first thing to it.
      updateSetting?.("grocery_stores", storesOf([], [...(savedStores || []), name]));
    }
    setStore(name);
  };

  const removeStore = async () => {
    const name = storeForm?.original;
    if (!name) return;
    const n = taggedCount(name);
    const ok = await confirm({
      title: `Remove ${name}?`,
      // Say what happens to the items, because "remove" next to a list of
      // groceries reads like it might take them with it. It doesn't.
      message: n
        ? `The ${n} item${n === 1 ? "" : "s"} tagged ${name} stay on the list — they just lose the tag, so they'll show under every shop. Nothing is deleted.`
        : `Nothing is tagged ${name}, so this only removes the shop from the picker.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    closeStoreForm();
    const drop = () => updateSetting?.("grocery_stores", (savedStores || []).filter((s) => s !== name));
    // Same ordering rule as the rename: forget the store only once its items
    // have actually let go of it, or a failed untag leaves rows pointing at a
    // shop the picker no longer lists.
    if (n) retagMut.mutate(planRetag(settled(), name, ""), { onSuccess: drop });
    else drop();
    setStore("");
  };

  /* A drag reports the new sequence for ONE section. Persist the whole visible
     order anyway — every row that was only implicitly ordered becomes explicit,
     so a later add can't shuffle rows you deliberately placed. Same reasoning as
     orderOf() in lib/brief-order.js. */
  const reorder = (sectionKey, ids) => {
    const next = [];
    for (const s of sections) next.push(...(s.key === sectionKey ? ids : s.items.map((i) => i.id)));
    // The "Any store" group is sortable too, and it is NOT in `sections` — leave
    // it out here and a drag anywhere on the page would write an order that
    // omits every staple, which applyOrder then treats as unranked.
    next.push(...(sectionKey === "anywhere" ? ids : anywhere.map((i) => i.id)));
    next.push(...cart.map((i) => i.id));
    updateSetting?.("grocery_order", next);
  };

  /* The walk order for one shop. Kept per route key rather than per store name so
     renaming "Costco" to "Costco LP" doesn't lose the order you arranged — the
     route is matched on the name, and the same warehouse gets the same key. A
     null order removes the entry entirely instead of saving an empty array,
     because "no saved order" and "an order that happens to be empty" have to stay
     distinguishable for applyZoneOrder to fall back to the default. */
  const saveRoute = (key, zones) => {
    const next = { ...(savedRoutes || {}) };
    if (zones && zones.length) next[key] = zones;
    else delete next[key];
    updateSetting?.("store_routes", next);
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

  // Rows and their editors are rendered together so the editor opens where the
  // row is, inside whichever section it belongs to.
  const renderRow = (it) => (
    <div>
      <Row it={it} pending={isTempId(it.id)} anyStore={!!activeStore && !parseItem(it.item).store}
        onToggle={() => toggle(it)}
        onQty={(q) => setQty(it, q)}
        onEdit={() => setEditing(editing === it.id ? null : it.id)}
        onDelete={() => delMut.mutate(it.id)} />
      {editing === it.id && (
        <RowEditor it={it} stores={stores} onSave={(item) => saveEdit(it, item)} onCancel={() => setEditing(null)} />
      )}
    </div>
  );

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

        {/* Which shop you're standing in. It's a filter and a default in one
            gesture — pick Costco and the list narrows AND everything you type
            next is tagged Costco, which is the only way this is worth using
            while pushing a trolley. A scrolling pill row rather than wrapping
            chips: five stores must not cost three lines of a phone screen. */}
        {(stores.length > 0 || storeForm) && (
          /* Each pill carries what's still to get there. Without the counts a
             filtered list can only ever say "nothing here" — it can't say "and
             there are nine at Costco", which is the thing you actually want to
             know when a shop looks empty. */
          <PillRow
            options={[
              { key: "", label: `All stores${counts[""] ? ` ${counts[""]}` : ""}` },
              ...stores.map((s) => ({ key: s, label: `${s}${counts[s] ? ` ${counts[s]}` : ""}` })),
              { key: NEW_STORE, label: "+ Store" },
            ]}
            value={activeStore}
            onChange={(k) => (k === NEW_STORE ? openNewStore() : pickStore(k))}
          />
        )}
        {/* Where it went. An edit that retags a row to another shop removes it
            from this view, and silence there is indistinguishable from a delete. */}
        {moved && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface-2)", borderRadius: 12, padding: "9px 12px" }}>
            <span className="t-cap" style={{ color: "var(--sub)", flex: 1, minWidth: 0 }}>
              {moved.name} moved to {moved.store}
            </span>
            <Button kind="tinted" size="sm" onClick={() => pickStore(moved.store)} style={{ flex: "none" }}>View</Button>
            <Button kind="plain" size="sm" onClick={() => setMoved(null)} style={{ flex: "none" }}>Dismiss</Button>
          </div>
        )}
        {stores.length === 0 && !storeForm && (
          <Button kind="quiet" size="sm" onClick={openNewStore} style={{ alignSelf: "flex-start" }}>+ Add a store</Button>
        )}
        {/* Editing a store is only offered while you're looking at it — there's
            no ambiguity then about which one "Edit" means, and the count tells
            you what a rename or a removal is about to touch. */}
        {activeStore && !storeForm && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: -4 }}>
            <span className="t-cap" style={{ color: "var(--faint)", flex: 1, minWidth: 0 }}>
              {(() => { const n = taggedCount(activeStore); return `${n} item${n === 1 ? "" : "s"} tagged ${activeStore}`; })()}
            </span>
            <Button kind="plain" size="sm" onClick={openEditStore} style={{ flex: "none", paddingRight: 0 }}>Edit store</Button>
          </div>
        )}
        {storeForm && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Field value={storeDraft} onChange={(e) => setStoreDraft(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveStore(); if (e.key === "Escape") closeStoreForm(); }}
                placeholder="Store name — e.g. Costco" enterKeyHint="done" style={{ flex: 1, minWidth: 0 }} />
              <Button kind="primary" size="md" onClick={saveStore} disabled={!storeDraft.trim()} style={{ flex: "none" }}>
                {storeForm.mode === "edit" ? "Save" : "Add"}
              </Button>
              <Button kind="quiet" size="md" onClick={closeStoreForm} style={{ flex: "none" }}>Cancel</Button>
            </div>
            {storeForm.mode === "edit" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="t-cap" style={{ color: "var(--faint)", flex: 1, minWidth: 0, lineHeight: 1.4 }}>
                  Renaming retags every item at {storeForm.original}.
                </span>
                <Button kind="quiet" size="sm" onClick={removeStore} style={{ flex: "none" }}>Remove</Button>
              </div>
            )}
          </div>
        )}

        {/* Capture first, always in the same place. Enter files it and keeps focus,
            so a whole list goes in without touching anything else. */}
        <div style={{ display: "flex", gap: 8 }}>
          <Field value={newItem} onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder={activeStore ? `Add to ${activeStore} — or “2x milk”` : "Add an item — or “2x milk”"}
            enterKeyHint="done" style={{ flex: 1, minWidth: 0 }} />
          <Button kind={newItem.trim() ? "primary" : "quiet"} size="md" onClick={() => add()} disabled={!newItem.trim()} style={{ flex: "none" }}>Add</Button>
        </div>

        {/* A rejected add rolls the row back off the list, which on its own looks
            identical to never having typed it — that is precisely how the list
            managed to refuse every item for four days without anyone seeing an
            error. So say what failed, keep the text so it isn't retyped, and
            offer the retry. */}
        {addMut.isError && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="t-cap" style={{ color: "var(--red)", flex: 1, minWidth: 0 }}>
              “{addMut.variables?.typed}” didn’t save
              {addMut.error?.message ? ` — ${addMut.error.message}` : ""}
            </span>
            <Button kind="tinted" size="sm" onClick={() => add(addMut.variables?.typed)} style={{ flex: "none" }}>Retry</Button>
          </div>
        )}

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

        {/* Two ways to read the same list: as a list, or as the walk through the
            shop it implies. The toggle only appears once there's something to
            walk — an empty route is a diagram of nothing — and it sits directly
            above the thing it swaps rather than up in the header, so on a phone
            your thumb is already there. */}
        {groceries !== null && total > 0 && (
          <Segmented
            options={[{ key: "list", label: "List" }, { key: "route", label: "Route" }]}
            value={view} onChange={setView}
          />
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
          <EmptyState icon={<IcGrocery size={26} />} title={activeStore ? `Nothing for ${activeStore}` : "Nothing on the list"}
            sub={activeStore
              ? `Anything you add while ${activeStore} is selected is tagged to it. Items with no store show up under every shop.`
              : "Add what you need above and it sorts itself into aisles. It syncs to every device, so you can build it at home and shop from your phone."}
            action={activeStore ? <Button kind="tinted" size="sm" onClick={() => setStore("")}>Show all stores</Button> : undefined}
            style={{ padding: "22px 12px" }} />
        ) : view === "route" ? (
          /* Given the WHOLE list, not the grouped one: the route applies the same
             store rule itself (this shop's items plus the staples that follow you
             everywhere) and needs the ungrouped items to zone them its own way.
             renderRow is handed over so the rows here are literally the list's
             rows — same tap, same stepper, same editor. */
          <StoreRoute items={groceries} store={activeStore} savedRoutes={savedRoutes}
            onSaveRoute={saveRoute} renderRow={renderRow} />
        ) : (
          <div style={{ margin: "0 -16px -10px" }}>
            {/* Aisles rise in on load; the inline --i keeps the stagger correct
                past the stylesheet's nth-child ceiling. */}
            <div className="stagger">
              {sections.map((sec, i) => (
                <div key={sec.key} style={{ "--i": String(Math.min(i, 5)) }}>
                  <div style={{ padding: "0 16px" }}>
                    <AisleHead label={sec.label} tone={sec.tone} count={sec.items.length} pinned={sec.pinned} />
                  </div>
                  {/* One sortable per section: a drag rearranges the sequence
                      inside the aisle you're standing in. Moving an item to a
                      DIFFERENT section is a change of meaning, not of position,
                      so that lives in the editor where it can be deliberate. */}
                  <SortableList items={sec.items} onReorder={(ids) => reorder(sec.key, ids)} keyOf={(it) => it.id}>
                    {renderRow}
                  </SortableList>
                </div>
              ))}

              {/* The staples, annexed rather than mixed in. These have no store,
                  so they're true wherever you are — but scattering them through
                  a shop's aisles is what made "Costco" stop reading as Costco.
                  One group, one label, at the bottom where you'll still see it
                  before you leave. */}
              {anywhere.length > 0 && (
                <div style={{ "--i": String(Math.min(sections.length, 5)) }}>
                  <div style={{ padding: "0 16px" }}>
                    <AisleHead label="Any store" tone="var(--faint)" count={anywhere.length} note="buy these anywhere" />
                  </div>
                  <SortableList items={anywhere} onReorder={(ids) => reorder("anywhere", ids)} keyOf={(it) => it.id}>
                    {renderRow}
                  </SortableList>
                </div>
              )}
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
                    {cart.map((it) => <div key={it.id}>{renderRow(it)}</div>)}
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
