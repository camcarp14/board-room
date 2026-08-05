// ─── The Brief's layout sheet ────────────────────────────────────────────────
// Profiles for how the Brief deals its cards into columns — "Mac" wants three
// columns with the calendar up top, "iPad" wants two. The default arrangement
// stays what it always was (glance order, greedy-packed) with one dial: the
// column count. Named profiles are EXPLICIT — each card is assigned to a
// column, moved here with arrow buttons rather than drag, because a drop
// target spanning three scrolling columns inside a sheet is a coin toss on
// a trackpad and worse on glass. Schema notes live in lib/brief-layouts.js.
import { useState } from "react";
import { Sheet, Button, Pill, PillRow, SectionHeader, Field, useConfirm } from "../../ui/kit.jsx";
import {
  activeLayout, layoutColumnCount, defaultColumnCount,
  dealExplicit, addLayout, renameLayout, removeLayout, moveCard, setLayoutColumns,
} from "../../lib/brief-layouts.js";

const ARROWS = [["up", "↑"], ["down", "↓"], ["left", "←"], ["right", "→"]];

export function BriefLayoutSheet({ settings, updateSetting, cards, screenColumns, autoCols, onClose }) {
  const [confirmEl, confirm] = useConfirm();
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");

  const layouts = Array.isArray(settings?.brief_layouts) ? settings.brief_layouts : [];
  const active = activeLayout(settings);
  const activeId = active ? active.id : "default";

  const pickerOptions = [
    { key: "default", label: "Default" },
    ...layouts.map((l) => ({ key: l.id, label: l.name || "Layout" })),
  ];

  const writeProfile = (next) => {
    updateSetting?.("brief_layouts", layouts.map((l) => (l && l.id === next.id ? next : l)));
  };

  const createFromScreen = () => {
    const name = draft.trim() || "Layout";
    const { layouts: next, id } = addLayout(layouts, { name, columns: screenColumns });
    updateSetting?.("brief_layouts", next);
    updateSetting?.("brief_active_layout", id);
    setNaming(false); setDraft("");
  };

  const nCols = active ? layoutColumnCount(active) : defaultColumnCount(settings, autoCols);
  const columns = active ? dealExplicit(cards, active, nCols) : null;
  const labelOf = (id) => cards.find((c) => c.id === id)?.label || id;

  return (
    <Sheet onClose={onClose} title="Brief layout" z={480}>
      <SectionHeader title="Profile" />
      <PillRow options={pickerOptions} value={activeId}
        onChange={(k) => updateSetting?.("brief_active_layout", k)} style={{ margin: "0 -16px 4px" }} />
      {!naming ? (
        <div style={{ display: "flex", gap: 8, padding: "4px 0 2px" }}>
          <Button kind="quiet" size="sm" style={{ height: 44 }} onClick={() => setNaming(true)}>New from current view</Button>
          {active && (
            <>
              <Button kind="quiet" size="sm" style={{ height: 44 }} onClick={async () => {
                const ok = await confirm({ title: `Delete “${active.name}”?`, body: "The profile goes; the cards stay." });
                if (!ok) return;
                updateSetting?.("brief_layouts", removeLayout(layouts, active.id));
                updateSetting?.("brief_active_layout", "default");
              }}>Delete</Button>
            </>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, padding: "4px 0 2px" }}>
          <Field value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Name — Mac, iPad…"
            onKeyDown={(e) => { if (e.key === "Enter") createFromScreen(); }} style={{ flex: 1, minWidth: 0 }} />
          <Button kind="tinted" size="md" onClick={createFromScreen} style={{ flex: "none" }}>Create</Button>
        </div>
      )}

      <SectionHeader title="Columns" style={{ marginTop: 12 }} />
      <div style={{ display: "flex", gap: 6, padding: "2px 0" }}>
        {[1, 2, 3, 4].map((n) => (
          <Pill key={n} active={n === nCols} onClick={() => {
            if (active) writeProfile(setLayoutColumns(active, n));
            else updateSetting?.("brief_columns", n);
          }}>{n}</Pill>
        ))}
      </div>
      {!active && (
        <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, padding: "6px 4px 0" }}>
          The default arrangement packs your glance order into these columns —
          hold and drag cards on the Brief itself to reorder. Named profiles pin
          each card to a column instead.
        </div>
      )}

      {active && columns && (
        <>
          <SectionHeader title="Arrangement" style={{ marginTop: 12 }} />
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            {columns.map((col, i) => (
              <div key={i} style={{ flex: 1, minWidth: 0, background: "var(--surface-2)", borderRadius: 12, padding: 8 }}>
                <div className="t-cap" style={{ color: "var(--faint)", marginBottom: 6 }}>Col {i + 1}</div>
                {col.length === 0 && <div className="t-cap" style={{ color: "var(--faint)", padding: "6px 0" }}>empty</div>}
                {col.map((card) => (
                  <div key={card.id} style={{ padding: "6px 0" }}>
                    <div className="t-foot" style={{ marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labelOf(card.id)}</div>
                    <div style={{ display: "flex", gap: 4 }}>
                      {ARROWS.map(([dir, glyph]) => (
                        <button key={dir} aria-label={`Move ${labelOf(card.id)} ${dir}`}
                          onClick={() => writeProfile(moveCard(active, card.id, dir))}
                          style={{
                            width: 30, height: 30, borderRadius: 8, border: "none", cursor: "pointer",
                            background: "var(--surface)", color: "var(--sub)", fontSize: 13, lineHeight: 1,
                          }}>{glyph}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, padding: "8px 4px 0" }}>
            Cards a profile has never met join the shortest column automatically —
            a new release can add a card, never lose one.
          </div>
        </>
      )}
      {confirmEl}
    </Sheet>
  );
}
