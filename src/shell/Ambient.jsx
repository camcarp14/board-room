// ─── The ambient canvas ───────────────────────────────────────────────────────
// One fixed layer, rendered once for the whole app — behind boot, behind login,
// behind both shells and every page inside them. It is decoration in the
// strictest sense: aria-hidden, pointer-events: none, no state, no measurement,
// no listeners. Everything it does lives in design/ambient.css.
//
// Rendered by App above the auth gate deliberately: the login card floating on
// a slow wash is the first thing anyone sees, and it is the cheapest good
// impression in the building.

export function Ambient({ on }) {
  if (!on) return null;
  return (
    <div className="ambient" aria-hidden="true">
      {/* Three pools and nothing else. The grain is .ambient::after, not a
          fourth element — as a child it pushed the layer stack past the point
          where the pools stayed composited and doubled frame time on desktop,
          for something that never moves. Profiled; don't add a box here. */}
      <span className="amb-pool amb-1" />
      <span className="amb-pool amb-2" />
      <span className="amb-pool amb-3" />
    </div>
  );
}
