// ─── SortableList — hold, then drag to reorder ────────────────────────────────
// One implementation for both notes surfaces (the Brief tile and the Personal
// tab), so the gesture is identical in each.
//
// ── Why hold-then-drag, and not drag-immediately ─────────────────────────────
// These lists live inside a vertical scroller on a phone. A plain drag can't be
// told apart from a scroll at the moment the finger lands, so grabbing on
// pointerdown would either steal every scroll or need a horizontal-only gesture.
// A long press is unambiguous: LIFT_MS of stillness means "I want this one".
// Moving more than SLOP_PX before that fires cancels the lift and hands the
// gesture back to the scroller, which is what makes normal scrolling still work.
//
// ── Why the list re-renders on each swap instead of the item following the finger
// Notes have wildly different heights (a one-liner next to a five-row preview).
// The usual technique — translate the dragged node and shift the others by one
// item height — assumes uniform rows and drifts badly when they aren't. Swapping
// the actual order as the pointer crosses each neighbour's midpoint is exact at
// any height, and the drop always lands where the preview showed.
//
// Pointer events (not touch/mouse pairs) so one code path covers finger, mouse and
// stylus, with setPointerCapture keeping the moves coming if the finger strays
// outside the row.

import { useRef, useState, useCallback, useEffect } from "react";

const LIFT_MS = 300;  // hold this long to pick a row up
const SLOP_PX = 8;    // move more than this first and it's a scroll, not a grab

// Never arm a lift inside these — holding a text cursor still for 300ms while
// deciding what to type must not pick the row up. Callers extend it with
// `ignoreWithin` (the Brief adds its inner scrollers).
const NEVER_DRAG = "input, textarea, select, [contenteditable='true'], [data-no-drag]";

export function SortableList({
  items,
  onReorder,          // (idsInNewOrder) => void — fired once, on drop
  disabled = false,
  keyOf = (i) => i.id,
  children,           // (item, { dragging, anyDragging }) => node
  style,
  className,
  ignoreWithin,       // extra selector; a pointerdown inside it is not a grab
  // (itemNodes, items) => node. Default renders the sequence straight into the
  // container. The Brief passes a packer that deals the same sequence into
  // masonry columns — the nodes keep their identity and their measured boxes,
  // so the nearest-centre hit test below works across columns unchanged.
  layout,
}) {
  const [dragKey, setDragKey] = useState(null);
  const [live, setLive] = useState(null); // preview order of keys while dragging
  const nodes = useRef(new Map());        // key -> element, for midpoint tests
  const root = useRef(null);              // this instance's container, for nesting
  const lift = useRef(null);              // { timer, key, y, moved }
  const suppressClick = useRef(false);    // a drag must not also open the editor
  const committed = useRef(null);

  const keys = (live || items.map(keyOf));
  const ordered = live
    ? live.map((k) => items.find((i) => keyOf(i) === k)).filter(Boolean)
    : items;

  const clearLift = () => {
    if (lift.current?.timer) clearTimeout(lift.current.timer);
    lift.current = null;
  };

  const endDrag = useCallback((commit) => {
    const next = committed.current;
    setDragKey(null);
    setLive(null);
    committed.current = null;
    clearLift();
    // Disarm the click guard on a timer, NOT when a click finally arrives. A
    // pointerup only synthesises a click when the gesture stayed put, so after a
    // real drag no click ever comes — and the flag stayed armed, eating the next
    // genuine tap on any row. The browser fires the synthetic click immediately
    // after pointerup, so one frame is plenty.
    setTimeout(() => { suppressClick.current = false; }, 60);
    if (commit && next && onReorder) onReorder(next);
  }, [onReorder]);

  // A drag that ends anywhere but a clean pointerup still has to let go.
  useEffect(() => {
    if (!dragKey) return;
    const bail = () => endDrag(true);
    window.addEventListener("pointercancel", bail);
    window.addEventListener("blur", bail);
    return () => { window.removeEventListener("pointercancel", bail); window.removeEventListener("blur", bail); };
  }, [dragKey, endDrag]);

  const onPointerDown = (key) => (e) => {
    if (disabled || e.button > 0 || !e.isPrimary) return;
    // Nesting: the Brief's cards are draggable AND one of them (Notes) is itself
    // a SortableList. Both containers see the same bubbling pointerdown, so
    // without this a hold on a note lifted the note and the whole Notes card at
    // once. Whichever sortable is nearest the target owns the gesture, which
    // makes the inner list win — the behaviour you'd expect from grabbing the
    // thing you're actually pointing at.
    const owner = e.target?.closest?.("[data-sortable]");
    if (owner && owner !== root.current) return;
    if (e.target?.closest?.(ignoreWithin ? `${NEVER_DRAG}, ${ignoreWithin}` : NEVER_DRAG)) return;
    const el = e.currentTarget;
    lift.current = {
      key, y: e.clientY, moved: false,
      timer: setTimeout(() => {
        if (!lift.current || lift.current.moved) return;
        try { el.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
        setDragKey(key);
        setLive(items.map(keyOf));
        committed.current = items.map(keyOf);
        // A held row is a held row — don't let the tap-to-edit fire on release.
        suppressClick.current = true;
      }, LIFT_MS),
    };
  };

  const onPointerMove = (e) => {
    // Before the lift: any real movement means the user is scrolling. Give up.
    if (lift.current && !dragKey) {
      if (Math.abs(e.clientY - lift.current.y) > SLOP_PX) { lift.current.moved = true; clearLift(); }
      return;
    }
    if (!dragKey) return;
    e.preventDefault(); // touch-action:none is set below; this covers the rest

    const from = keys.indexOf(dragKey);
    if (from < 0) return;
    // Nearest CENTRE in two dimensions, not a vertical midpoint test. The Personal
    // tab lays notes out as a two-column masonry on desktop, where "the row above"
    // isn't a meaningful idea — the neighbour above you visually may be the item
    // two places back in DOM order. Distance to each candidate's centre is correct
    // for a single column and a grid alike, and DOM order still maps to index, so
    // the splice below stays valid either way.
    let to = from, best = Infinity;
    for (let i = 0; i < keys.length; i++) {
      const r = nodes.current.get(keys[i])?.getBoundingClientRect();
      if (!r) continue;
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; to = i; }
    }
    if (to === from) return;

    const next = keys.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    setLive(next);
    committed.current = next;
  };

  const onPointerUp = () => { if (dragKey) endDrag(true); else clearLift(); };

  // Keyboard path, so reordering isn't pointer-only: Alt+↑/↓ on a focused row.
  const onKeyDown = (key) => (e) => {
    if (disabled || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const cur = items.map(keyOf);
    const from = cur.indexOf(key);
    const to = e.key === "ArrowUp" ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= cur.length) return;
    e.preventDefault();
    cur.splice(to, 0, cur.splice(from, 1)[0]);
    onReorder?.(cur);
  };

  const itemNodes = ordered.map((item) => {
    const key = keyOf(item);
    const dragging = key === dragKey;
    return (
      <div
        key={key}
        ref={(el) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key); }}
        onPointerDown={onPointerDown(key)}
        onKeyDown={onKeyDown(key)}
        style={{
          minWidth: 0,
          // The lift: raised off the page, slightly larger, and above its
          // neighbours so it reads as held rather than merely highlighted.
          position: "relative",
          zIndex: dragging ? 2 : undefined,
          transform: dragging ? "scale(1.02)" : undefined,
          boxShadow: dragging ? "var(--shadow-float)" : undefined,
          borderRadius: dragging ? 12 : undefined,
          background: dragging ? "var(--surface)" : undefined,
          opacity: dragKey && !dragging ? 0.62 : 1,
          cursor: dragging ? "grabbing" : undefined,
          transition: "transform var(--dur-1) var(--ease-out), opacity var(--dur-1) ease, box-shadow var(--dur-2) var(--ease-out)",
        }}
      >
        {children(item, { dragging, anyDragging: !!dragKey })}
      </div>
    );
  });

  return (
    <div
      ref={root}
      data-sortable="1"
      className={className}
      style={{
        display: "flex", flexDirection: "column", minWidth: 0,
        // Only while dragging: the scroller must keep working the rest of the time.
        touchAction: dragKey ? "none" : undefined,
        ...style,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      // Capture phase: swallow the click a completed drag would otherwise deliver
      // to the row underneath, which would open the note you just moved.
      onClickCapture={(e) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {layout ? layout(itemNodes, ordered) : itemNodes}
    </div>
  );
}

export default SortableList;
