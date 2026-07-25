// ─── Theme — pick one of the 20 colour schemes ────────────────────────────────
// Two independent axes, and the UI has to make that obvious or the picker feels
// broken ("I chose Lapis, why is it still light?"):
//   MODE    — light / dark / auto. Lives in Settings, mirrored read-only here.
//   PALETTE — which of the 20 schemes. Chosen here.
// Every swatch previews the palette in the mode CURRENTLY in force, so what you
// see in the grid is what tapping it gives you.
//
// Swatch colours come from design/palettes.js, which is generated from the same
// table as design/themes.css by scripts/gen-themes.mjs — so a swatch can never
// show a colour the theme doesn't actually use. scripts/theme-smoke.mjs fails the
// build if the two ever drift.

import { SectionHeader, Card, Cell, CellGroup } from "../../ui/kit.jsx";
import { IcCheck, IcSun, IcMoon, IcAutoTheme } from "../../ui/icons.jsx";
import { PALETTES } from "../../design/palettes.js";

/* A palette as a physical object: the page ground, a card lifted off it, the ink,
   and the one accent. Four values is enough to recognise a scheme at a glance and
   it's exactly the four the theme is built from. */
function Swatch({ p, mode, selected }) {
  const c = p[mode];
  return (
    <span aria-hidden style={{
      display: "block", height: 54, borderRadius: 12, overflow: "hidden",
      background: c.bg, position: "relative", flex: "none",
      // The ring is the selection signal. Drawn with box-shadow, not border, so
      // it can't change the box size and reflow the grid on selection.
      boxShadow: selected
        ? `inset 0 0 0 1px color-mix(in srgb, ${c.ink} 12%, transparent), 0 0 0 2px var(--accent)`
        : `inset 0 0 0 1px color-mix(in srgb, ${c.ink} 12%, transparent)`,
    }}>
      {/* the card */}
      <span style={{ position: "absolute", left: 7, right: 7, top: 9, bottom: 0, borderRadius: 8, background: c.surface }} />
      {/* two ink bars — body and secondary — then the accent chip */}
      <span style={{ position: "absolute", left: 14, top: 18, width: 26, height: 4, borderRadius: 2, background: c.ink }} />
      <span style={{ position: "absolute", left: 14, top: 27, width: 16, height: 4, borderRadius: 2, background: c.ink, opacity: 0.45 }} />
      <span style={{ position: "absolute", right: 13, top: 17, width: 14, height: 14, borderRadius: "50%", background: c.accent }} />
    </span>
  );
}

const MODE_META = {
  auto: { label: "Auto", Icon: IcAutoTheme },
  day: { label: "Light", Icon: IcSun },
  night: { label: "Dark", Icon: IcMoon },
};

export function ThemeTab({ theme, isMobile }) {
  // Preview in the mode actually on screen, so the grid never lies.
  const mode = theme.resolved === "night" ? "night" : "day";
  const current = theme.palette;
  const ModeIcon = (MODE_META[theme.pref] || MODE_META.auto).Icon;

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <SectionHeader title="Colour scheme" trailing={`${PALETTES.length} themes`} />

      {/* The mode axis, stated up front — otherwise picking a "dark" scheme while
          pinned to Light reads as the picker not working. Read-only on purpose:
          one control, one home (Settings), mirrored here for context. */}
      <CellGroup style={{ marginBottom: 12 }}>
        <Cell
          leading={<ModeIcon size={17} />}
          title={`Currently ${MODE_META[theme.pref]?.label.toLowerCase() || "auto"}${theme.pref === "auto" ? ` — showing ${mode === "night" ? "dark" : "light"}` : ""}`}
          sub="Light and dark is a separate setting, in Settings. Every scheme below has both."
        />
      </CellGroup>

      <div style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "repeat(2, minmax(0, 1fr))" : "repeat(auto-fill, minmax(min(168px, 100%), 1fr))",
        gap: 10,
      }}>
        {PALETTES.map((p) => {
          const selected = p.key === current;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => theme.setPalette(p.key)}
              aria-pressed={selected}
              aria-label={`${p.label} — ${p.blurb}`}
              title={p.blurb}
              className="press"
              style={{
                display: "flex", flexDirection: "column", gap: 7, minWidth: 0,
                padding: 10, borderRadius: 16, border: "none", cursor: "pointer",
                textAlign: "left", font: "inherit",
                background: selected ? "var(--accent-a10)" : "var(--surface)",
                boxShadow: "var(--shadow-card)",
              }}
            >
              <Swatch p={p} mode={mode} selected={selected} />
              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span className="t-call" style={{ fontWeight: 650, color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.label}
                </span>
                {selected && (
                  <span style={{ color: "var(--accent)", display: "inline-flex", flex: "none" }}><IcCheck size={13} /></span>
                )}
              </span>
              <span className="t-cap" style={{
                color: "var(--sub)", lineHeight: 1.35, minWidth: 0,
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
              }}>{p.blurb}</span>
            </button>
          );
        })}
      </div>

      <Card pad="md" style={{ marginTop: 14 }}>
        <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
          A scheme sets the page, the cards, the text and the one accent colour —
          everything else in the app derives from those four, so the whole surface
          moves together. Status colours stay put: green still means live and red
          still means broken in every scheme, because those carry meaning rather
          than taste. Every combination is contrast-checked against WCAG AA before
          it ships.
        </div>
      </Card>
    </div>
  );
}

export default ThemeTab;
