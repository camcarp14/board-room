// ─── Route view — the shop, in the order you walk it ──────────────────────────
// The other half of the grocery list. Same items, same rows, same checkbox; the
// only thing that changes is that they're arranged as a WALK instead of a list,
// with a schematic of that walk on top.
//
// Built for the one place it gets used: one hand, a trolley in the other,
// standing in a shop. That drives everything here —
//
//   IT'S THE SAME ROW. The stop list renders GroceryPanel's own row, passed in,
//   so checking something off on the route is the same tap, the same optimistic
//   write and the same editor as checking it off on the list. A route view with
//   its own read-only rows would be a picture of your list rather than your list,
//   and you'd have to leave it to use it.
//
//   IT UPDATES AS YOU SHOP. A stop holds what's LEFT. Check off the last thing in
//   Produce and the stop disappears, the map redraws with one fewer box, and the
//   remaining stops renumber — so the route always describes the rest of the trip
//   rather than the trip you planned at home.
//
//   THE MAP IS DRAWN FROM THE LIST, not stored. Both the schematic and the stops
//   come out of the same array (see storeRoute.js), so the picture cannot get out
//   of step with the list underneath it — the failure mode of every hand-drawn
//   store map.
//
//   AND IT'S HONEST. There is no public floor-plan data for these shops; the
//   header says which store the walk is for, and the order is yours to correct
//   with the arrows on every stop. See the note at the top of storeRoute.js.

import { useMemo, useRef } from "react";
import { Button } from "../../ui/kit.jsx";
import { IcChevronDown } from "../../ui/icons.jsx";
import { buildRoute, serpentine, serpentineHeight, moveZone } from "./storeRoute.js";

// Room above the first stop for the entrance and below the last for the till.
// The route has to enter and leave the building somewhere, and a walk that
// starts at a box floating in a rectangle reads as a diagram, not a shop.
const HEAD = 11;
const FOOT = 12;

/**
 * The schematic.
 *
 * A plan, deliberately: an outlined building with a marked way in, a dashed line
 * through the stops in order, and the tills at the end. The stops are laid out as
 * a serpentine — down one side, across, back up the other — which is both what
 * walking a shop actually feels like and the only layout that can be GENERATED
 * from an order rather than hand-placed per store.
 *
 * SVG at a 100-unit width so it scales to any card, capped in CSS so it can't
 * inflate to absurd type on a tablet. Everything is one <svg> and no images, so
 * it costs nothing to ship and follows the theme — the tones are the same CSS
 * variables the aisle dots use, so a zone is the same colour in both views.
 */
function RouteMap({ stops, onPick }) {
  const boxes = useMemo(() => serpentine(stops), [stops]);
  if (!boxes.length) return null;
  const H = HEAD + serpentineHeight(stops.length) + FOOT;
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  // Straight through every centre. Consecutive stops in a serpentine are always
  // neighbours — side by side within a row, one above the other between rows —
  // so joining the centres is already a right-angled path with nothing to solve.
  //
  // Drawn UNDER opaque boxes, which is what keeps it legible: routed through the
  // centres it crosses the labels, and dashes running through the word "Produce"
  // read as a mistake. Opaque departments clip it to the gaps between them, so
  // what you see is a connector in each gutter — the same path, showing only
  // where there's nothing to obscure.
  const path = [
    `M ${first.cx} 8`,
    ...boxes.map((b) => `L ${b.cx} ${b.cy + HEAD}`),
    `L ${last.cx} ${H - 9.5}`,
  ].join(" ");

  return (
    <svg viewBox={`0 0 100 ${H}`} role="img" aria-label={`Route map: ${stops.map((s) => s.label).join(", ")}`}
      style={{ width: "100%", maxWidth: 420, height: "auto", display: "block", margin: "0 auto" }}>
      <rect x="0.6" y="0.6" width="98.8" height={H - 1.2} rx="3.5"
        fill="var(--surface-2)" stroke="var(--line)" strokeWidth="0.5" />

      {/* The walk. Dashed because it's a suggested path, not a corridor — a
          solid line on a plan claims to be a wall. */}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="0.9"
        strokeDasharray="1.8 1.7" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />

      {/* Way in, on the top edge, and the tills on the bottom — the two fixed
          points of any shop, and the anchors that make the dashes read as a
          route rather than a join-the-dots. The path starts below these labels
          rather than at the edge, so the door is marked, named, and only then
          walked from. */}
      <rect x={first.cx - 6} y="0.2" width="12" height="1.4" rx="0.7" fill="var(--accent)" />
      <text x={first.cx} y="6.4" textAnchor="middle" fontSize="3.6" fill="var(--faint)" fontWeight="600">Way in</text>
      <rect x={last.cx - 6} y={H - 1.6} width="12" height="1.4" rx="0.7" fill="var(--green)" />
      <text x={last.cx} y={H - 5} textAnchor="middle" fontSize="3.6" fill="var(--faint)" fontWeight="600">Tills</text>

      <g transform={`translate(0 ${HEAD})`}>
        {boxes.map((b) => (
          <g key={b.zone} onClick={() => onPick?.(b.zone)} style={{ cursor: "pointer" }}>
            {/* Two rects, not one tinted one: the base has to be OPAQUE so it
                hides the route line crossing behind it (see `path`), and a single
                rect at 14% would let the dashes through the label. */}
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="2.2" fill="var(--surface)" />
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="2.2"
              fill={b.tone} fillOpacity="0.16" stroke={b.tone} strokeOpacity="0.55" strokeWidth="0.5" />
            <circle cx={b.x + 6} cy={b.cy} r="3.4" fill={b.tone} />
            <text x={b.x + 6} y={b.cy + 1.5} textAnchor="middle" fontSize="4" fontWeight="700" fill="var(--bg)">{b.n}</text>
            <text x={b.x + 11.5} y={b.cy + 1.6} fontSize="4.4" fontWeight="600" fill="var(--ink)">{b.short}</text>
            <text x={b.x + b.w - 3} y={b.cy + 1.5} textAnchor="end" fontSize="3.8" fill="var(--sub)">{b.items.length}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

/* One stop's heading: its number in the zone's colour, its full name, what's
   left there, and the two arrows that fix the order. The arrows are on every
   stop rather than behind an "edit route" mode, because the moment you learn the
   order is wrong is the moment you're standing in the wrong aisle. */
function StopHead({ stop, first, last, onMove }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 2px 5px" }}>
      <span aria-hidden style={{
        flex: "none", width: 20, height: 20, borderRadius: "50%", background: stop.tone, color: "var(--bg)",
        display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700,
      }}>{stop.n}</span>
      <span className="t-label" style={{ flex: 1, minWidth: 0 }}>{stop.label}</span>
      <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{stop.items.length}</span>
      <button className="icon-btn" aria-label={`Move ${stop.label} earlier in the walk`}
        onClick={() => onMove(-1)} disabled={first} style={first ? { opacity: 0.25 } : undefined}>
        <IcChevronDown size={14} style={{ transform: "rotate(180deg)" }} />
      </button>
      <button className="icon-btn" aria-label={`Move ${stop.label} later in the walk`}
        onClick={() => onMove(1)} disabled={last} style={last ? { opacity: 0.25 } : undefined}>
        <IcChevronDown size={14} />
      </button>
    </div>
  );
}

/**
 * @param items        the whole grocery list (unfiltered — buildRoute decides)
 * @param store        the store tag being shopped, "" for all
 * @param savedRoutes  app_settings.store_routes — { [routeKey]: [zoneKeys] }
 * @param onSaveRoute  (routeKey, zoneKeys) => void
 * @param renderRow    GroceryPanel's row renderer, so the rows here ARE the list's
 */
export function StoreRoute({ items, store, savedRoutes, onSaveRoute, renderRow }) {
  const { route, zones, stops, total } = useMemo(
    () => buildRoute(items || [], store, savedRoutes), [items, store, savedRoutes]);
  const listRef = useRef(null);

  const move = (zone, dir) => {
    const next = moveZone(zones, stops.map((s) => s.zone), zone, dir);
    if (next) onSaveRoute?.(route.key, next);
  };
  // Tapping a box on the map is a question — "where is that in the list?" — so
  // it answers by scrolling, not by filtering. Filtering to one stop would hide
  // the next one, which is the only other thing you want to see.
  const jump = (zone) => {
    const el = listRef.current?.querySelector(`[data-stop="${zone}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const custom = Array.isArray(savedRoutes?.[route.key]) && savedRoutes[route.key].length > 0;

  if (!stops.length) {
    return (
      <div style={{ padding: "26px 8px", textAlign: "center" }}>
        <div className="t-body" style={{ color: "var(--sub)" }}>
          {total === 0 && store ? `Nothing left for ${store}.` : "Everything's in the trolley."}
        </div>
        <div className="t-cap" style={{ color: "var(--faint)", marginTop: 5 }}>
          The route builds itself from what's still to get.
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Which shop this walk is for, and the one thing worth knowing before you
          go in. The note is short on purpose: it is read once, in a doorway. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
        <span className="t-label" style={{ flex: 1, minWidth: 0 }}>{route.name}</span>
        {route.where && <span className="t-cap" style={{ color: "var(--faint)", flex: "none" }}>{route.where}</span>}
      </div>
      <p className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.45, margin: "0 0 12px" }}>{route.note}</p>

      <RouteMap stops={stops} onPick={jump} />

      <div className="t-cap" style={{ color: "var(--faint)", textAlign: "center", margin: "10px 0 0" }}>
        {stops.length} stop{stops.length === 1 ? "" : "s"} · {total} item{total === 1 ? "" : "s"} left · tap a box to jump
      </div>

      <div ref={listRef} style={{ margin: "0 -16px -10px" }}>
        {stops.map((s, i) => (
          <div key={s.zone} data-stop={s.zone} style={{ scrollMarginTop: 8 }}>
            <div style={{ padding: "0 16px" }}>
              <StopHead stop={s} first={i === 0} last={i === stops.length - 1} onMove={(d) => move(s.zone, d)} />
            </div>
            {s.items.map((it) => <div key={it.id}>{renderRow(it)}</div>)}
          </div>
        ))}
      </div>

      {/* Said once, at the bottom, where it belongs: this is an informed default,
          not a survey of the building. The arrows above are the fix, and the fix
          sticks — so the honest thing is to point at them rather than to caveat
          every stop. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, borderTop: "0.5px solid var(--line)", marginTop: 14, paddingTop: 11 }}>
        <span className="t-cap" style={{ color: "var(--faint)", flex: 1, minWidth: 0, lineHeight: 1.45 }}>
          {custom
            ? "Your order for this shop. It's saved and syncs to every device."
            : "A typical walk for this kind of shop, not a floor plan — nudge any stop with the arrows and it stays put."}
        </span>
        {custom && (
          <Button kind="quiet" size="sm" onClick={() => onSaveRoute?.(route.key, null)} style={{ flex: "none" }}>Reset</Button>
        )}
      </div>
    </div>
  );
}

export default StoreRoute;
