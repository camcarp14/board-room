import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Segmented, Switch, Field, TextArea, Button, Sheet, useConfirm, Dot, SectionHeader } from "../../../ui/kit.jsx";
import { IcClose } from "../../../ui/icons.jsx";
import { callClaude, MODEL_META } from "../../../lib/claude.js";
import { MindCanvas } from "./MindCanvas.jsx";
import {
  compileGenome, loadGenome, saveGenome, resetGenome,
  addNode, updateNode, removeNode, addEdge, removeEdge,
  validateGenome, propagate, seedsForTask, dnaBus, genomeStats,
  displayGenome, setLearnedLayout,
  REGIONS, MIND_CHARTER,
} from "./mindGenome.js";
import { makeSdb } from "../../../LearnPanel.jsx";
import { supabase } from "../../../lib/supabase.js";

// ════════════════════════════════════════════════════════════════════════════
// MIND PANEL — the neural sub-tab inside the "Mind" tab. The canvas IS the page;
// everything else floats over it in glass: the header + stat pills, the region
// legend, the inspector, the ⚡ Pulse popover and the ⋯ menu. Ported from
// clarify-outreach's DnaView (its surfaces, recolored to SESSION tokens and made
// theme-aware) minus the Worker dock and suggestions tray — in Board Room the
// kept Mini Me delegate is the executor, so this panel is pure chrome around the
// genome. One rule holds everywhere, exactly as in the original: every genome
// edit routes through a mindGenome CRUD function → saveGenome() → setGenome, so
// the mutation history records it and the dnaBus "genome" event keeps every
// consumer (canvas, pills, delegate) in sync. The panel owns zero business logic.
//
// THEME: Porcelain (day) / Graphite (night) both live here. Not one hardcoded
// hex — every color is a CSS-var token (var(--surface)/--ink/--sub/--line/
// --accent/…) or a color-mix over one, so the whole overlay flips with the room.
// ════════════════════════════════════════════════════════════════════════════

// Glass recipe for every floating panel — spec'd once so the overlay layer reads
// as one material. All tokens: --glass-raised + --line + --shadow-float carry the
// light/dark pair, so this object needs no per-theme branch.
const glass = {
  background: "var(--glass-raised)",
  backdropFilter: "blur(20px) saturate(1.8)",
  WebkitBackdropFilter: "blur(20px) saturate(1.8)",
  border: "1px solid var(--line)",
  boxShadow: "var(--shadow-float)",
  borderRadius: 14,
};

// Panel-scoped CSS: hover affordances, the mobile chip-scroller's hidden
// scrollbar, and the accent-tinted range thumb. The app's global reduced-motion
// rule already zeroes transitions, so nothing here fights it.
const VIEW_CSS = `
.mind-scroll-x { scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.mind-scroll-x::-webkit-scrollbar { display: none; }
.mind-menuitem { transition: background var(--dur-1) var(--ease-out); }
.mind-menuitem:hover { background: var(--ink-a06); }
.mind-legendrow { transition: opacity var(--dur-1) var(--ease-out); border: none; background: transparent; }
.mind-legendrow:hover { background: var(--ink-a04); }
.mind-panel-root input[type="range"] { cursor: pointer; accent-color: var(--accent); width: 100%; display: block; }
.mind-conn { transition: background var(--dur-1) var(--ease-out); }
.mind-conn:hover { background: var(--ink-a08); }
/* Learned neurons wear a subtle dashed "taught" ring so they read distinct from
   seeded doctrine on the canvas — done from here (not MindCanvas) by targeting
   the stable learned_<skillId> data-id the canvas already stamps. stroke-dasharray
   is unset everywhere else, so this never fights the fire/selection/droptar strokes. */
.mind-panel-root .dna-canvas g[data-dna-node][data-id^="learned_"] .dna-core { stroke-dasharray: 3.2 2.4; stroke-width: 1.6px; }
/* Spotlight-learned filter — a toggle in the legend dims everything that is NOT a
   learned neuron, so the taught skills pop out of the doctrine. Tokens only. */
.mind-panel-root.mind-spotlight-learned .dna-canvas g[data-dna-node]:not([data-id^="learned_"]) { opacity: 0.16 !important; }
.mind-panel-root.mind-spotlight-learned .dna-canvas g[data-dna-edge] { opacity: 0.16 !important; }
`;

// The compile-level lens — a DISPLAY filter over compiled.sections for the pulse
// excerpt and the compiled-mind modal. The delegate always runs the full prompt;
// this only changes what the human reads. Primary = the commands (weight ≥0.75),
// Standing = commands + standing lines (≥0.4), Full = the verbatim artifact.
const LENS_OPTS = [
  { key: "primary", label: "Primary" },
  { key: "standing", label: "Standing" },
  { key: "full", label: "Full" },
];

// Weight bands mirror the compiler's own thresholds — a slider value narrates how
// the line will land in the prompt, so tuning weight is legible, not a mystery.
const bandNote = (w) =>
  w >= 75 ? "Compiles as PRIMARY — a command"
    : w >= 40 ? "Compiles as a standing line"
      : "Compiles as a minor consideration";

// A line already carries its band as a "PRIMARY — "/"Minor — " prefix (put there
// by compileGenome). The lens filters on that prefix — no re-deriving weights.
const lensLines = (lines, lens) =>
  lens === "full" ? lines
    : lens === "standing" ? lines.filter((l) => !l.startsWith("Minor"))
      : lines.filter((l) => l.startsWith("PRIMARY"));

// Reconstruct the compiled prompt under a lens. At "full" it returns the exact
// systemPrompt (byte-identical to what the delegate runs); narrower lenses
// rebuild the same shape the compiler emits — charter first, then each region's
// surviving lines, then the tensions block (dropped only in the commands-only
// Primary view). Kept format-identical to compileGenome so the modal never lies
// about the artifact.
function buildLensedPrompt(compiled, lens) {
  if (lens === "full") return compiled.systemPrompt;
  const parts = [MIND_CHARTER];
  compiled.sections.forEach((s) => {
    if (s.region === "tension") {
      if (lens === "primary") return;                 // commands-only view sheds the tensions narrative
      parts.push(`INTERNAL TENSIONS:\n${s.lines.map((l) => `- ${l}`).join("\n")}`);
      return;
    }
    if (s.region === "learned") {                     // the taught-skills subsection — its own header, no REGIONS entry
      const ls = lensLines(s.lines, lens);
      if (!ls.length) return;
      parts.push(`LEARNED SKILLS (taught via Learn):\n${ls.map((l) => `- ${l}`).join("\n")}`);
      return;
    }
    const ls = lensLines(s.lines, lens);
    if (!ls.length) return;
    const r = REGIONS[s.region];
    parts.push(`${(r ? r.label : s.region).toUpperCase()} — ${r ? r.desc : ""}:\n${ls.map((l) => `- ${l}`).join("\n")}`);
  });
  return parts.join("\n\n");
}

// Words too common to mean anything when the pulse matches a query to nodes.
const STOP = new Set("the a an and or but for nor with that this these those what when where how why who are is was were be been do does did should would could can our your their its from into then than about have has had not you they i we it if of on in to as at by is it".split(" "));

// Mutation-history accent per kind — a hairline that says added / changed /
// removed at a glance. Tokens only, so it re-tones with the room.
const KIND_COLOR = {
  add_node: "var(--green)", add_edge: "var(--green)",
  remove_node: "var(--red)", remove_edge: "var(--red)",
  update_node: "var(--blue)", update_edge: "var(--blue)",
  reset: "var(--amber)", import: "var(--purple)",
};

// Small shared styles.
const microLabel = { fontSize: 10.5, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--sub)", fontFamily: "var(--font-display)", marginBottom: 6 };
const selStyle = { width: "100%", background: "var(--surface-2)", border: "none", borderRadius: 10, color: "var(--ink)", padding: "9px 11px", fontSize: 13, fontFamily: "var(--font-body)", minHeight: 40 };
const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

// ─── Header stat pill (mono) ───────────────────────────────────────────────────
// Module scope so its function identity is stable — declared inside the panel it
// would remount all four pills' DOM on every Pulse keystroke.
function StatPill({ label, value, brass, title }) {
  return (
    <span title={title} style={{ ...glass, borderRadius: 999, padding: "4px 11px", display: "inline-flex", alignItems: "baseline", gap: 6, pointerEvents: "auto" }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--faint)", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "var(--font-display)" }}>{label}</span>
      <span className="t-num" style={{ fontSize: 12, color: brass ? "var(--accent)" : "var(--ink)", fontWeight: brass ? 700 : 500 }}>{value}</span>
    </span>
  );
}

// Directive textarea that grows with its content — a fixed row count either wastes
// panel space or hides half a principle. Built on the kit TextArea (44pt, wells,
// focus ring) so it stays native.
function AutoTextarea({ value, onChange, onBlur, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);
  return (
    <TextArea ref={ref} rows={2} value={value} onChange={onChange} onBlur={onBlur} placeholder={placeholder}
      style={{ resize: "none", overflow: "hidden", lineHeight: 1.55, minHeight: 62, fontSize: 13 }} />
  );
}

// ─── Inspector: node ──────────────────────────────────────────────────────────
// Text fields hold a local draft and commit on blur; the weight slider holds a
// draft while dragging and commits on release. Both exist so mindGenome records
// ONE mutation-history line per edit, not one per keystroke. The inspector is
// keyed by node.id upstream, so every draft resets when the selection changes.
function NodeInspector({ genome, node, apply, onSelect, onDeleted, onFireSkill }) {
  const [label, setLabel] = useState(node.label);
  const [text, setText] = useState(node.text || "");
  const [w, setW] = useState(null);
  const [maxTok, setMaxTok] = useState(node.maxTokens ?? 500);

  const conns = genome.edges.filter((e) => e.from === node.id || e.to === node.id);
  const wired = new Set(genome.edges.filter((e) => e.from === node.id).map((e) => e.to));
  const wireTargets = genome.nodes.filter((n) => n.id !== node.id && !wired.has(n.id));
  const liveW = w != null ? w : Math.round((node.weight || 0) * 100);
  const isSkill = node.region === "skill";
  const modelKey = node.modelKey || "haiku";
  // seedsForTask maps a KNOWN skill kind → its causal neighborhood; a user-added
  // skill simply won't match, and Fire falls back to lighting the node alone.
  const skillKind = isSkill ? node.id.replace(/^n_sk_/, "") : null;
  const canFire = isSkill;

  const commitLabel = () => { const v = label.trim(); if (v && v !== node.label) apply(updateNode(genome, node.id, { label: v })); else setLabel(node.label); };
  const commitText = () => { if (text !== (node.text || "")) apply(updateNode(genome, node.id, { text })); };
  const commitW = () => { if (w == null) return; if (w / 100 !== node.weight) apply(updateNode(genome, node.id, { weight: w / 100 })); setW(null); };
  const commitMax = () => { const v = Math.max(1, Math.min(4000, Number(maxTok) || 1)); if (v !== (node.maxTokens ?? 500)) apply(updateNode(genome, node.id, { maxTokens: v })); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div>
        <div style={microLabel}>Label</div>
        <Field value={label} maxLength={28} onChange={(e) => setLabel(e.target.value)} onBlur={commitLabel}
          onKeyDown={(e) => e.key === "Enter" && e.target.blur()} style={{ fontWeight: 600 }} />
      </div>

      <div>
        <div style={microLabel}>Region</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {Object.entries(REGIONS).map(([k, r]) => {
            const on = k === node.region;
            return (
              <button key={k} title={r.desc} onClick={() => !on && apply(updateNode(genome, node.id, { region: k }))}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 999, cursor: "pointer", fontSize: 10.5, fontWeight: 700, fontFamily: "var(--font-display)", background: on ? tint(r.color, 14) : "transparent", border: `1px solid ${on ? tint(r.color, 45) : "var(--line)"}`, color: on ? r.color : "var(--sub)" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: r.color }} />{r.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div style={{ ...microLabel, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Weight</span>
          <span className="t-num" style={{ fontSize: 12, color: "var(--accent)", letterSpacing: 0, textTransform: "none" }}>{liveW}%</span>
        </div>
        <input type="range" min={0} max={100} value={liveW} onChange={(e) => setW(Number(e.target.value))} onPointerUp={commitW} onKeyUp={commitW} onBlur={commitW} />
        <div style={{ fontSize: 10.5, color: "var(--sub)", marginTop: 4 }}>{bandNote(liveW)}</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>Awake</div>
          <div style={{ fontSize: 11, color: "var(--sub)" }}>{node.enabled !== false ? "Compiling into the mind" : "Silenced — omitted from the prompt"}</div>
        </div>
        <Switch on={node.enabled !== false} disabled={node.locked}
          onToggle={() => apply(updateNode(genome, node.id, { enabled: node.enabled === false }))}
          aria-label="Awake" />
      </div>

      <div>
        <div style={microLabel}>Directive</div>
        <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText} placeholder="What this node tells the mind…" />
      </div>

      {/* SKILL extras — the model + budget the mind (and the delegate) runs this
          move on, routed through updateNode so they ride on the genome. */}
      {isSkill && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "11px 12px", background: "var(--surface-2)", borderRadius: 12 }}>
          <div>
            <div style={microLabel}>Model</div>
            <Segmented value={modelKey} onChange={(k) => k !== modelKey && apply(updateNode(genome, node.id, { modelKey: k }))}
              options={MODEL_META.map((m) => ({ key: m.key, label: m.label, sub: m.price }))} />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontSize: 12, color: "var(--sub)" }}>Max tokens</span>
            <Field type="number" min={1} max={4000} value={maxTok}
              onChange={(e) => setMaxTok(e.target.value)} onBlur={commitMax}
              onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
              style={{ width: 96, textAlign: "center", fontFamily: "var(--font-mono)" }} />
          </div>
          {canFire && (
            <button onClick={() => onFireSkill(node)}
              style={{ width: "100%", padding: "8px", background: "var(--accent-a10)", border: "1px solid var(--accent-a40)", borderRadius: 10, color: "var(--accent)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-display)" }}>
              ⚡ Fire this skill on the canvas
            </button>
          )}
        </div>
      )}

      <div>
        <div style={{ ...microLabel, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Synapses</span>
          <span className="t-num" style={{ fontSize: 10.5, color: "var(--faint)", letterSpacing: 0, textTransform: "none" }}>{conns.length}</span>
        </div>
        {conns.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--sub)", lineHeight: 1.5 }}>No synapses yet — ⇧-drag from this node on the canvas, or wire one below.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {conns.map((e) => {
              const out = e.from === node.id;
              const otherId = out ? e.to : e.from;
              const other = genome.nodes.find((n) => n.id === otherId);
              return (
                <div key={e.id} className="mind-conn" style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px", background: "var(--surface-2)", borderRadius: 9 }}>
                  <span title={e.polarity === -1 ? "Tempers" : "Excites"} style={{ fontSize: 11, flexShrink: 0 }}>{e.polarity === -1 ? "⛔" : "⚡"}</span>
                  <button onClick={() => onSelect({ type: "node", id: otherId })} title={`Jump to "${other ? other.label : otherId}"`}
                    style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: "pointer", color: "var(--ink)", fontSize: 11.5, padding: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {out ? "→ " : "← "}{other ? other.label : otherId}
                  </button>
                  <span className="t-num" style={{ fontSize: 10.5, color: "var(--sub)", flexShrink: 0 }}>{(e.weight || 0).toFixed(2)}</span>
                  <button onClick={() => apply(removeEdge(genome, e.id))} title="Cut synapse"
                    style={{ background: "none", border: "none", color: "var(--faint)", fontSize: 13, cursor: "pointer", lineHeight: 1, padding: "0 2px", flexShrink: 0 }}>✕</button>
                </div>
              );
            })}
          </div>
        )}
        {/* Touch- and keyboard-reachable way to wire an edge (the canvas gesture
            needs a mouse). addEdge's own guards (self-loop, dupes) still apply. */}
        {wireTargets.length > 0 && (
          <select value="" aria-label="Wire a synapse to another node"
            onChange={(e) => { if (e.target.value) apply(addEdge(genome, { from: node.id, to: e.target.value })); }}
            style={{ ...selStyle, marginTop: 6, fontSize: 11.5 }}>
            <option value="">＋ Wire a synapse to…</option>
            {wireTargets.map((n) => (
              <option key={n.id} value={n.id}>{n.label} · {(REGIONS[n.region] || REGIONS.knowledge).label}</option>
            ))}
          </select>
        )}
      </div>

      {node.locked ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 11px", background: "var(--accent-a08)", border: "1px solid var(--accent-a20)", borderRadius: 10, fontSize: 11, color: "var(--accent)", lineHeight: 1.5 }}>
          <span>🔒</span><span>Core doctrine — cannot be removed. Weight is still yours to tune.</span>
        </div>
      ) : (
        <Button kind="danger" size="md" full onClick={() => { apply(removeNode(genome, node.id)); onDeleted(); }}>
          Delete node
        </Button>
      )}

      <div style={{ fontSize: 10.5, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>{node.source || "user"} · {node.id}</div>
    </div>
  );
}

// ─── Inspector: learned neuron ──────────────────────────────────────────────────
// A skill taught in Learn shows here as a VIRTUAL neuron: its CONTENT is owned by
// mini_skills (rendered READ-ONLY, "Taught in Learn"), while its weight, wiring, and
// enabled state are tunable from the canvas. Weight persists via setLearnedLayout and
// synapses via addEdge — both onto the RAW genome (never the merged display view, or
// the virtual nodes would leak into genome.nodes). Enable/disable flips the skill row
// itself via makeSdb, then bubbles onSkillsChanged so Learn and Neurons re-sync.
function LearnedNodeInspector({ genome, dispNodes, node, skill, apply, onSelect, onOpenInLearn, onToggleEnabled }) {
  const [w, setW] = useState(null);
  const liveW = w != null ? w : Math.round((node.weight || 0) * 100);
  const enabled = skill ? skill.enabled !== false : node.enabled !== false;

  const conns = genome.edges.filter((e) => e.from === node.id || e.to === node.id);
  const wired = new Set(genome.edges.filter((e) => e.from === node.id).map((e) => e.to));
  const wireTargets = genome.nodes.filter((n) => n.id !== node.id && !wired.has(n.id)); // wire the taught skill INTO doctrine
  const labelOf = (id) => (dispNodes.find((n) => n.id === id) || {}).label || id;

  const commitW = () => { if (w == null) return; const nw = w / 100; if (nw !== node.weight) apply(setLearnedLayout(genome, node.skillId, { weight: nw })); setW(null); };

  // Directive is READ-ONLY — content lives in Learn. node.text is
  // "Use when: <desc>\n<content>"; split so the trigger reads as its own line.
  const nlIdx = (node.text || "").indexOf("\n");
  const useWhen = (nlIdx >= 0 ? node.text.slice(0, nlIdx) : (node.text || "")).replace(/^Use when:\s*/i, "").trim();
  const content = nlIdx >= 0 ? node.text.slice(nlIdx + 1).trim() : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px", borderRadius: 999, background: tint("var(--blue)", 14), border: `1px solid ${tint("var(--blue)", 40)}`, color: "var(--blue)", fontSize: 10.5, fontWeight: 700, fontFamily: "var(--font-display)" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--blue)", boxShadow: `0 0 0 2px ${tint("var(--blue)", 30)}` }} />Learned neuron
        </span>
        <span style={{ fontSize: 10.5, color: "var(--faint)" }}>Taught in Learn</span>
      </div>

      <div>
        <div style={microLabel}>Skill</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", lineHeight: 1.4 }}>{node.label}</div>
      </div>

      {/* Weight — persists via setLearnedLayout into genome.learned. */}
      <div>
        <div style={{ ...microLabel, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Weight</span>
          <span className="t-num" style={{ fontSize: 12, color: "var(--accent)", letterSpacing: 0, textTransform: "none" }}>{liveW}%</span>
        </div>
        <input type="range" min={0} max={100} value={liveW} onChange={(e) => setW(Number(e.target.value))} onPointerUp={commitW} onKeyUp={commitW} onBlur={commitW} />
        <div style={{ fontSize: 10.5, color: "var(--sub)", marginTop: 4 }}>{bandNote(liveW)}</div>
      </div>

      {/* Enable / disable — flips the skill row itself, then Learn + Neurons re-sync. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>Awake</div>
          <div style={{ fontSize: 11, color: "var(--sub)" }}>{enabled ? "Compiling into the mind" : "Silenced — omitted from the prompt"}</div>
        </div>
        <Switch on={enabled} disabled={!skill} onToggle={() => skill && onToggleEnabled(skill)} aria-label="Awake" />
      </div>

      {/* Directive — READ-ONLY, owned by Learn. */}
      <div>
        <div style={microLabel}>Directive</div>
        <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "11px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          {useWhen && (
            <div style={{ fontSize: 11.5, color: "var(--sub)", lineHeight: 1.5 }}>
              <span style={{ color: "var(--faint)", fontWeight: 700 }}>Use when </span>{useWhen}
            </div>
          )}
          {content && <div style={{ fontSize: 12.5, color: "var(--ink)", lineHeight: 1.6, whiteSpace: "pre-wrap", maxHeight: 168, overflowY: "auto" }}>{content}</div>}
          <div style={{ fontSize: 10.5, color: "var(--faint)", lineHeight: 1.5 }}>Taught in Learn — edit the content there.</div>
        </div>
      </div>

      <Button kind="tinted" size="md" full onClick={onOpenInLearn}>Open in Learn →</Button>

      {/* Synapses — the same wiring model as any node; learned_<id> endpoints are allowed. */}
      <div>
        <div style={{ ...microLabel, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>Synapses</span>
          <span className="t-num" style={{ fontSize: 10.5, color: "var(--faint)", letterSpacing: 0, textTransform: "none" }}>{conns.length}</span>
        </div>
        {conns.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--sub)", lineHeight: 1.5 }}>No synapses yet — wire this taught skill into your doctrine below, or ⇧-drag from it on the canvas.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {conns.map((e) => {
              const out = e.from === node.id;
              const otherId = out ? e.to : e.from;
              return (
                <div key={e.id} className="mind-conn" style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px", background: "var(--surface-2)", borderRadius: 9 }}>
                  <span title={e.polarity === -1 ? "Tempers" : "Excites"} style={{ fontSize: 11, flexShrink: 0 }}>{e.polarity === -1 ? "⛔" : "⚡"}</span>
                  <button onClick={() => onSelect({ type: "node", id: otherId })} title={`Jump to "${labelOf(otherId)}"`}
                    style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: "pointer", color: "var(--ink)", fontSize: 11.5, padding: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {out ? "→ " : "← "}{labelOf(otherId)}
                  </button>
                  <span className="t-num" style={{ fontSize: 10.5, color: "var(--sub)", flexShrink: 0 }}>{(e.weight || 0).toFixed(2)}</span>
                  <button onClick={() => apply(removeEdge(genome, e.id))} title="Cut synapse"
                    style={{ background: "none", border: "none", color: "var(--faint)", fontSize: 13, cursor: "pointer", lineHeight: 1, padding: "0 2px", flexShrink: 0 }}>✕</button>
                </div>
              );
            })}
          </div>
        )}
        {wireTargets.length > 0 && (
          <select value="" aria-label="Wire a synapse to another node"
            onChange={(e) => { if (e.target.value) apply(addEdge(genome, { from: node.id, to: e.target.value })); }}
            style={{ ...selStyle, marginTop: 6, fontSize: 11.5 }}>
            <option value="">＋ Wire a synapse to…</option>
            {wireTargets.map((n) => (
              <option key={n.id} value={n.id}>{n.label} · {(REGIONS[n.region] || REGIONS.knowledge).label}</option>
            ))}
          </select>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 11px", background: tint("var(--blue)", 8), border: `1px solid ${tint("var(--blue)", 22)}`, borderRadius: 10, fontSize: 11, color: "var(--blue)", lineHeight: 1.5 }}>
        <span>◆</span><span>A taught skill — forget it in Learn to remove the neuron. Weight and wiring are yours to tune here.</span>
      </div>

      <div style={{ fontSize: 10.5, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>learned · {node.id}</div>
    </div>
  );
}

// ─── Inspector: edge ──────────────────────────────────────────────────────────
// Compact by design — the canvas can select a synapse, so the inspector answers
// with its two endpoints (each a jump-to-select) and a cut. Editing weight/
// polarity lives on the nodes' side of the model; this stays a read + remove.
function EdgeInspector({ genome, edge, apply, onSelect, onDeleted }) {
  const from = genome.nodes.find((n) => n.id === edge.from);
  const to = genome.nodes.find((n) => n.id === edge.to);
  const inhib = edge.polarity === -1;
  const jump = (id, lbl) => (
    <button onClick={() => onSelect({ type: "node", id })} title={`Jump to "${lbl}"`}
      style={{ flex: 1, minWidth: 0, background: "none", border: "none", cursor: "pointer", color: "var(--ink)", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-display)", padding: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {lbl}
    </button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "var(--surface-2)", borderRadius: 10 }}>
        {jump(edge.from, from ? from.label : edge.from)}
        <span style={{ fontSize: 13, color: inhib ? "var(--red)" : "var(--accent)", flexShrink: 0 }}>{inhib ? "⊣" : "→"}</span>
        {jump(edge.to, to ? to.label : edge.to)}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12, color: "var(--sub)" }}>{inhib ? "Tempering synapse" : "Excitatory synapse"}</span>
        <span className="t-num" style={{ fontSize: 12, color: "var(--accent)" }}>{(edge.weight || 0).toFixed(2)}</span>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--sub)", lineHeight: 1.5 }}>
        {inhib
          ? "Compiles into an INTERNAL TENSIONS line — when the two conflict, the source wins."
          : "Carries activation from source to target when the mind fires."}
      </div>
      <Button kind="danger" size="md" full onClick={() => { apply(removeEdge(genome, edge.id)); onDeleted(); }}>
        Cut synapse
      </Button>
      <div style={{ fontSize: 10.5, color: "var(--faint)", fontFamily: "var(--font-mono)" }}>{edge.id}</div>
    </div>
  );
}

// ─── The panel ─────────────────────────────────────────────────────────────────
export function MindPanel({ isMobile, settings, updateSetting, session, jump, onJump, skills = [], onSkillsChanged, focusSkillId }) { // eslint-disable-line no-unused-vars -- updateSetting/session flow per contract; the panel reads settings.models.mind and persists via mindGenome's own localStorage
  const [genome, setGenome] = useState(() => loadGenome());
  const [selection, setSelection] = useState(null);       // {type:"node"|"edge", id} | null
  const [regionFilter, setRegionFilter] = useState(null); // Set<regionKey> | null (null = all)
  const [learnedSpotlight, setLearnedSpotlight] = useState(false); // dim doctrine, light the taught skills
  const [lens, setLens] = useState("full");               // compile-level display lens
  const [panel, setPanel] = useState(null);               // desktop popover: "pulse" | "menu" | null
  const [modal, setModal] = useState(null);               // Sheet modal: "compiled" | "history" | null
  const [notice, setNotice] = useState(null);             // self-contained toast {kind:"ok"|"warn"|"err", text}

  // Pulse state
  const [pq, setPq] = useState("");
  const [pulseRes, setPulseRes] = useState(null);         // {q, seedLabels, excerpt}
  const [thinking, setThinking] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [answerErr, setAnswerErr] = useState(null);

  const [confirmEl, confirm] = useConfirm();
  const fileRef = useRef(null);
  const askRef = useRef(null);                            // last consumed Summon token — re-mounts don't re-fire

  const mindModel = settings?.models?.mind || "haiku";
  const mindModelLabel = (MODEL_META.find((m) => m.key === mindModel) || MODEL_META[0]).label;

  // The genome, readable from stable callbacks: MindCanvas is memo-friendly, so
  // its callback props must keep identity across renders.
  const genomeRef = useRef(genome);
  genomeRef.current = genome;
  // Live skills, readable from stable callbacks (pulse, focus flash) the same way
  // the genome is — so they never close over a stale skills array.
  const skillsRef = useRef(skills);
  skillsRef.current = skills;

  // THE seam: every edit is CRUD → saveGenome (history + bus) → state. mindGenome
  // refusals (locked delete, dupe edge…) return the same reference — a cheap no-op.
  // Learned-node edits (setLearnedLayout / addEdge on a learned_<id>) route through
  // here too, always mutating the RAW genome — never displayGen — so the virtual
  // learned nodes are never persisted into genome.nodes.
  const apply = useCallback((next) => { if (next && next !== genomeRef.current) setGenome(saveGenome(next)); }, []);

  const stats = genomeStats(genome, skills);
  // The render / propagate / compile VIEW — doctrine with the taught skills merged
  // in as virtual neurons. With no skills this returns the SAME genome reference,
  // so the canvas rebuilds nothing and behaves byte-identically to the pre-learned
  // panel. compile folds skills into the prompt (and the hash), so teaching a skill
  // visibly changes the mind here and downstream in the delegate.
  const displayGen = useMemo(() => displayGenome(genome, skills), [genome, skills]);
  const compiled = useMemo(() => compileGenome(genome, { skills }), [genome, skills]);
  const lensedPrompt = useMemo(() => buildLensedPrompt(compiled, lens), [compiled, lens]);

  const selNode = selection && selection.type === "node" ? displayGen.nodes.find((n) => n.id === selection.id) : null;
  const selEdge = selection && selection.type === "edge" ? genome.edges.find((e) => e.id === selection.id) : null;
  const inspectorOpen = !!(selNode || selEdge);

  // Subscribe to the genome bus — worker/grow/import side changes (and our own
  // saves) all arrive here so the panel stays live. Cleanup unsubscribes.
  useEffect(() => dnaBus.on((evt) => { if (evt.type === "genome") setGenome(evt.genome); }), []);

  // Self-dismissing toast.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice]);

  // Escape closes the desktop popover first, then clears a selection (Sheet
  // modals + mobile sheets handle their own Escape via the kit's stack).
  // Bail while a kit Sheet is open (modal set): the Sheet's stack handler
  // already consumes that Escape — without this guard one keypress closed the
  // sheet AND the inspector underneath (the exact layered-dismiss the stack
  // exists to prevent).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || modal) return;
      if (panel) setPanel(null);
      else if (!isMobile && inspectorOpen) setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, inspectorOpen, isMobile, modal]);

  // ── Canvas callbacks — identity-stable (genome via ref). ──
  // A learned neuron's position lives in genome.learned (not genome.nodes), so its
  // drag persists through setLearnedLayout; doctrine nodes go through updateNode.
  // Both are position-only: layout, not history.
  const handleNodeMove = useCallback((id, x, y) => {
    if (typeof id === "string" && id.startsWith("learned_")) {
      return apply(setLearnedLayout(genomeRef.current, id.slice("learned_".length), { x, y }));
    }
    return apply(updateNode(genomeRef.current, id, { x, y }));
  }, [apply]);
  const handleAddNodeAt = useCallback(({ x, y }) => {
    const res = addNode(genomeRef.current, { label: "New node", region: "knowledge", text: "", x, y });
    setGenome(saveGenome(res.genome));
    setSelection({ type: "node", id: res.node.id });
    setNotice({ kind: "ok", text: "Node grown — name it in the inspector." });
  }, []);
  const handleAddEdge = useCallback(({ from, to }) => {
    const g = genomeRef.current;
    const next = addEdge(g, { from, to });
    if (next === g) { setNotice({ kind: "warn", text: "Those nodes are already wired." }); return; }
    setGenome(saveGenome(next));
    setSelection({ type: "edge", id: next.edges[next.edges.length - 1].id });
  }, []);

  // "＋ Node" plants near the mind's center (identity/origin). Board Room's
  // MindCanvas exposes only the standard props — no viewport-center bridge — so
  // we scatter around origin, which the seed layout keeps on-screen after FIT.
  const growNode = () => handleAddNodeAt({
    x: Math.round((Math.random() - 0.5) * 180),
    y: Math.round((Math.random() - 0.5) * 180),
  });

  const toggleRegion = (r) => setRegionFilter((prev) => {
    if (!prev) return new Set([r]);                        // from "all" → isolate the clicked region
    const next = new Set(prev);
    next.has(r) ? next.delete(r) : next.add(r);
    return next.size === 0 || next.size === Object.keys(REGIONS).length ? null : next;
  });

  // ── Pulse — keyword-match the query to nodes, fire the wave, and show the
  //    compiled lines of the regions it lit. The demo that the graph IS the
  //    prompt: what fires on the canvas is what the delegate reads verbatim. ──
  const runPulse = (raw) => {
    const q = (raw || "").trim();
    if (!q) return;
    // Match + fire over the MERGED view so a query that lands on a taught skill
    // lights its learned neuron too (already merged → propagate needs no skills arg).
    const g = displayGenome(genomeRef.current, skillsRef.current);
    const words = [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP.has(word)))];
    const scored = [];
    g.nodes.forEach((n) => {
      if (n.enabled === false) return;
      const lab = n.label.toLowerCase(), txt = (n.text || "").toLowerCase();
      let s = 0;
      words.forEach((word) => { if (lab.includes(word)) s += 2; if (txt.includes(word)) s += 1; });
      if (s > 0) scored.push({ id: n.id, label: n.label, s, w: n.weight || 0 });
    });
    scored.sort((a, b) => (b.s - a.s) || (b.w - a.w));
    const seeds = scored.slice(0, 5);
    if (seeds.length === 0) {
      setPulseRes(null); setAnswer(null); setAnswerErr(null);
      setNotice({ kind: "warn", text: "No nodes matched — try words the mind actually knows." });
      return;
    }
    const seedIds = seeds.map((x) => x.id);
    const trace = propagate(g, seedIds);
    dnaBus.emit({ type: "activation", seeds: seedIds, trace, label: `Pulse — ${q.slice(0, 40)}` });
    const fired = new Set();
    g.nodes.forEach((n) => {
      if ((trace.levels[n.id] || 0) > 0.05) { fired.add(n.region); if (n.source === "learned") fired.add("learned"); }
    });
    const excerpt = compileGenome(genomeRef.current, { skills: skillsRef.current }).sections
      .filter((s) => s.region !== "tension" && fired.has(s.region))
      .flatMap((s) => lensLines(s.lines, lens))
      .slice(0, 6);
    setPulseRes({ q, seedLabels: seeds.map((x) => x.label), excerpt });
    setAnswer(null); setAnswerErr(null);
  };
  const firePulse = () => runPulse(pq);

  // Fire a skill node's causal neighborhood — seedsForTask lights the signals /
  // knowledge that argue FOR the move; propagate then adds the tempering
  // principles. A user-added skill (no known kind) just lights itself.
  const fireSkill = (node) => {
    const g = displayGenome(genomeRef.current, skillsRef.current);
    const kind = node.id.replace(/^n_sk_/, "");
    let seeds = seedsForTask(g, kind);
    if (!seeds.length) seeds = [node.id];
    dnaBus.emit({ type: "activation", seeds, trace: propagate(g, seeds), label: `Skill — ${node.label}` });
  };

  const think = async () => {
    if (!pulseRes || thinking) return;
    setThinking(true);
    setAnswer(null); setAnswerErr(null);
    // The compiled mind, verbatim — the exact string the delegate runs on, no
    // side prompt. Tweaking a node visibly changes the answer.
    const res = await callClaude({
      system: compileGenome(genomeRef.current, { skills: skillsRef.current }).systemPrompt,
      messages: [{ role: "user", content: pulseRes.q }],
      modelKey: mindModel,
      maxTokens: 400,
      fn: "mind_pulse",
    });
    if (res) setAnswer(res.trim());
    else setAnswerErr("The mind couldn't think it through — check the connection or API key.");
    setThinking(false);
  };

  // ── Summon handoff — a jump carrying an `ask` opens the Pulse with that
  //    question prefilled and fires it once. Consumed by token so a re-mount (or
  //    a later unrelated jump) never re-fires the same question. ──
  useEffect(() => {
    const ask = jump && jump.ask;
    if (!ask) return;
    const token = (jump && jump.t) || ask;
    if (askRef.current === token) return;
    askRef.current = token;
    setPanel("pulse");
    setPq(ask);
    runPulse(ask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump && jump.t, jump && jump.ask]);

  // ── Cross-nav to Learn — the learned-node inspector's "Open in Learn →". ──
  const openInLearn = useCallback((skillId) => {
    if (typeof onJump === "function") onJump({ page: "boardroom", sub: "learn", skillId });
  }, [onJump]);

  // Enable/disable a taught skill from the canvas — flips the skill row via makeSdb,
  // then bubbles onSkillsChanged so Learn and the (Agent-E-refreshed) skills prop
  // re-sync. Content stays owned by Learn; only the enabled flag is written here.
  const toggleLearnedEnabled = useCallback(async (skill) => {
    if (!skill) return;
    if (!supabase) { setNotice({ kind: "err", text: "Not connected — manage this skill in Learn." }); return; }
    try {
      await makeSdb(supabase).save({ ...skill, enabled: !skill.enabled });
      setNotice({ kind: "ok", text: `${skill.enabled ? "Silenced" : "Awakened"} "${skill.title}".` });
      onSkillsChanged?.();
    } catch (e) {
      setNotice({ kind: "err", text: e?.message || "Couldn't update the skill — try Learn." });
    }
  }, [onSkillsChanged]);

  // ── Focus handoff — a jump carrying a skillId (from Learn's "See in Neurons →")
  //    selects that taught skill's neuron and flashes it once. Keyed by the skillId
  //    value AND skills readiness: if the skill hasn't loaded into the merged view
  //    yet, the effect no-ops and re-runs when the skills prop arrives. focusRef
  //    guards against re-flashing on unrelated re-renders. ──
  const focusRef = useRef(null);
  useEffect(() => {
    if (!focusSkillId) return;
    if (focusRef.current === focusSkillId) return;
    const id = "learned_" + focusSkillId;
    const disp = displayGenome(genomeRef.current, skillsRef.current);
    const target = disp.nodes.find((n) => n.id === id);
    if (!target) return;                 // skill not merged in yet — wait for the skills prop
    focusRef.current = focusSkillId;
    setSelection({ type: "node", id });
    setPanel(null);
    dnaBus.emit({ type: "activation", seeds: [id], trace: propagate(disp, [id]), label: `Learned — ${target.label}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSkillId, skills]);

  // ── ⋯ menu actions ──
  const copyMind = async () => {
    try {
      await navigator.clipboard.writeText(lensedPrompt);
      setNotice({ kind: "ok", text: lens === "full" ? "Compiled mind copied." : `Compiled mind (${lens} lens) copied.` });
    } catch { setNotice({ kind: "err", text: "Couldn't copy — clipboard blocked." }); }
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(genome, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mind-${genome.genome_key || "genome"}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setPanel(null);
  };
  const importJson = async (file) => {
    try {
      const parsed = JSON.parse(await file.text());
      const v = validateGenome(parsed);
      if (!v.ok) {
        setNotice({ kind: "err", text: `Import rejected — ${v.errors[0]}${v.errors.length > 1 ? ` (+${v.errors.length - 1} more)` : ""}` });
        return;
      }
      // Normalize the envelope so loadGenome() accepts it next boot, and stamp an
      // import line into the history without needing recordMutation.
      const next = {
        ...parsed, version: 1,
        genome_key: parsed.genome_key || "cameron_mind",
        mutations: [
          { id: `mut_import_${Date.now().toString(36)}`, ts: new Date().toISOString(), kind: "import", summary: `Imported genome "${parsed.genome_key || "cameron_mind"}" — ${parsed.nodes.length} nodes / ${parsed.edges.length} synapses` },
          ...(Array.isArray(parsed.mutations) ? parsed.mutations : []),
        ].slice(0, 200),
      };
      setGenome(saveGenome(next));
      setSelection(null);
      setPanel(null);
      setNotice({ kind: "ok", text: "Genome imported — the mind has been replaced." });
    } catch {
      setNotice({ kind: "err", text: "Import rejected — not valid JSON." });
    }
  };
  const doReset = async () => {
    setPanel(null);
    const ok = await confirm({
      title: "Reset the mind to seed?",
      message: "Every node, synapse, and mutation you've made is discarded and the mind returns to its factory blend. This can't be undone.",
      confirmLabel: "Reset", destructive: true,
    });
    if (!ok) return;
    setGenome(resetGenome());
    setSelection(null);
    setNotice({ kind: "warn", text: "Mind reset to seed." });
  };

  const menuItems = [
    { icon: "🧠", label: "View compiled mind", run: () => { setModal("compiled"); setPanel(null); } },
    { icon: "⤓", label: "Export JSON", run: exportJson },
    { icon: "⤒", label: "Import JSON", run: () => fileRef.current && fileRef.current.click() },
    { icon: "≣", label: "Mutation history", run: () => { setModal("history"); setPanel(null); } },
    { icon: "↺", label: "Reset to seed", danger: true, run: doReset },
  ];

  // ── Shared render fragments ──
  const legendRow = (k) => {
    const r = REGIONS[k];
    const active = !regionFilter || regionFilter.has(k);
    return (
      <button key={k} className="mind-legendrow" onClick={() => toggleRegion(k)} title={r.desc}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "5px 7px", borderRadius: 8, cursor: "pointer", opacity: active ? 1 : 0.38 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.color, boxShadow: `0 0 6px ${tint(r.color, 45)}`, flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--ink)", fontFamily: "var(--font-display)" }}>{r.label}</span>
        <span className="t-num" style={{ fontSize: 10.5, color: "var(--faint)" }}>{stats.byRegion[k] || 0}</span>
      </button>
    );
  };

  const legendChip = (k) => {
    const r = REGIONS[k];
    const active = !regionFilter || regionFilter.has(k);
    return (
      <button key={k} onClick={() => toggleRegion(k)}
        style={{ ...glass, pointerEvents: "auto", display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px", borderRadius: 999, cursor: "pointer", flexShrink: 0, opacity: active ? 1 : 0.45, color: "var(--ink)", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-display)" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: r.color }} />{r.label}
        <span className="t-num" style={{ fontSize: 10.5, color: "var(--faint)" }}>{stats.byRegion[k] || 0}</span>
      </button>
    );
  };

  // Learned neurons aren't a REGION — they ride with Knowledge but are their own
  // family, so the legend gets a dedicated control that SPOTLIGHTS them (dims the
  // doctrine) rather than filtering by region. The dashed-ring dot mirrors the
  // learned-neuron treatment on the canvas.
  const learnedLegendRow = () => {
    const has = stats.learned > 0;
    return (
      <button className="mind-legendrow" onClick={() => has && setLearnedSpotlight((v) => !v)} disabled={!has}
        title={has ? "Skills taught in Learn — click to spotlight them" : "Teach a skill in Learn and it grows a neuron here"}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "5px 7px", borderRadius: 8, cursor: has ? "pointer" : "default", opacity: has ? 1 : 0.5, background: learnedSpotlight ? "var(--accent-a10)" : "transparent" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "transparent", border: "1.5px dashed var(--blue)", flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: "left", fontSize: 12, fontWeight: 600, color: learnedSpotlight ? "var(--accent)" : "var(--ink)", fontFamily: "var(--font-display)" }}>Learned</span>
        <span className="t-num" style={{ fontSize: 10.5, color: "var(--faint)" }}>{stats.learned}</span>
      </button>
    );
  };

  const learnedLegendChip = () => {
    if (stats.learned === 0) return null;
    return (
      <button onClick={() => setLearnedSpotlight((v) => !v)}
        style={{ ...glass, pointerEvents: "auto", display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px", borderRadius: 999, cursor: "pointer", flexShrink: 0, border: learnedSpotlight ? "1px solid var(--accent-a40)" : "1px solid var(--line)", color: learnedSpotlight ? "var(--accent)" : "var(--ink)", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-display)" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "transparent", border: "1.5px dashed var(--blue)" }} />Learned
        <span className="t-num" style={{ fontSize: 10.5, color: "var(--faint)" }}>{stats.learned}</span>
      </button>
    );
  };

  // A learned neuron gets its own inspector (read-only directive, weight, wiring,
  // enable/disable, Open-in-Learn); seeded and skill nodes keep the untouched
  // NodeInspector. The skill object is looked up so the toggle can flip its row.
  const selLearned = !!(selNode && selNode.source === "learned");
  const selSkill = selLearned ? skills.find((s) => String(s.id) === String(selNode.skillId)) : null;
  const inspectorTitle = selNode ? (selLearned ? "Learned neuron" : "Node") : "Synapse";
  const inspectorBody = selNode
    ? (selLearned
      ? <LearnedNodeInspector key={selNode.id} genome={genome} dispNodes={displayGen.nodes} node={selNode} skill={selSkill}
          apply={apply} onSelect={setSelection} onOpenInLearn={() => openInLearn(selNode.skillId)} onToggleEnabled={toggleLearnedEnabled} />
      : <NodeInspector key={selNode.id} genome={genome} node={selNode} apply={apply} onSelect={setSelection} onDeleted={() => setSelection(null)} onFireSkill={fireSkill} />)
    : selEdge
      ? <EdgeInspector key={selEdge.id} genome={genome} edge={selEdge} apply={apply} onSelect={setSelection} onDeleted={() => setSelection(null)} />
      : null;

  // The lens picker rides in the header and the compiled modal; one control, one
  // state, so the pulse excerpt and the modal never disagree.
  const lensPicker = (style) => (
    <Segmented options={LENS_OPTS} value={lens} onChange={setLens} style={style} />
  );

  // Pulse body — reused verbatim by the desktop popover and the mobile sheet.
  const pulseBody = (
    <>
      <div style={{ display: "flex", gap: 6 }}>
        <Field value={pq} onChange={(e) => setPq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && firePulse()} placeholder="Ask the mind…" aria-label="Ask the mind" style={{ flex: 1 }} />
        <Button kind="primary" size="md" onClick={firePulse} style={{ flexShrink: 0 }}>Fire</Button>
      </div>
      {pulseRes ? (
        <div style={{ marginTop: 11 }}>
          <div style={{ fontSize: 10.5, color: "var(--sub)", lineHeight: 1.5 }}>
            ⚡ Fired <span style={{ color: "var(--accent)", fontWeight: 600 }}>{pulseRes.seedLabels.join(" · ")}</span>
          </div>
          {pulseRes.excerpt.length > 0 && (
            <div style={{ marginTop: 9 }}>
              <div style={{ ...microLabel, fontSize: 10.5, marginBottom: 5 }}>From the compiled mind · {lens} lens</div>
              <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                {pulseRes.excerpt.map((l, i) => (
                  <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--sub)", lineHeight: 1.5, borderLeft: "2px solid var(--accent-a40)", paddingLeft: 8 }}>{l}</div>
                ))}
              </div>
            </div>
          )}
          <button onClick={think} disabled={thinking}
            style={{ marginTop: 10, width: "100%", padding: 9, background: thinking ? "var(--surface-2)" : "var(--accent-a10)", border: "1px solid var(--accent-a40)", borderRadius: 10, color: thinking ? "var(--faint)" : "var(--accent)", fontSize: 11.5, fontWeight: 700, cursor: thinking ? "wait" : "pointer", fontFamily: "var(--font-display)" }}>
            {thinking ? "Thinking…" : `✦ Think it through (${mindModelLabel})`}
          </button>
          {answer && (
            <div style={{ marginTop: 9, padding: "10px 11px", background: "var(--surface-2)", borderRadius: 10, fontSize: 13, color: "var(--ink)", lineHeight: 1.6, maxHeight: 200, overflowY: "auto", whiteSpace: "pre-wrap" }}>{answer}</div>
          )}
          {answerErr && (
            <div style={{ marginTop: 9, padding: "9px 11px", background: "var(--red-a32)", borderRadius: 10, fontSize: 11.5, color: "var(--red)", lineHeight: 1.5 }}>{answerErr}</div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--sub)", lineHeight: 1.55 }}>
          Ask a question — the mind lights the nodes it would think with, and shows the lines they compile into.
        </div>
      )}
    </>
  );

  // Close button for the desktop floating popovers.
  const closeBtn = (onClick) => (
    <button onClick={onClick} aria-label="Close" style={{ background: "none", border: "none", color: "var(--faint)", cursor: "pointer", display: "inline-flex", padding: 2 }}>
      <IcClose size={16} />
    </button>
  );

  const noticeDot = notice ? (notice.kind === "err" ? "var(--red)" : notice.kind === "warn" ? "var(--amber)" : "var(--green)") : null;

  const headPad = isMobile ? "10px 12px 0" : "12px 16px 0";

  return (
    <div className={`mind-panel-root${learnedSpotlight ? " mind-spotlight-learned" : ""}`} style={{ position: "relative", width: "100%", height: "100%", flex: 1, minHeight: isMobile ? 440 : 520, overflow: "hidden", borderRadius: isMobile ? 0 : 16 }}>
      <style>{VIEW_CSS}</style>

      {/* The mind itself — full-bleed beneath every overlay. displayGen merges the
          learned neurons in (doctrine untouched when there are no skills). */}
      <div style={{ position: "absolute", inset: 0 }}>
        <MindCanvas
          genome={displayGen}
          selection={selection}
          onSelect={setSelection}
          onNodeMove={handleNodeMove}
          onAddNode={handleAddNodeAt}
          onAddEdge={handleAddEdge}
          regionFilter={regionFilter}
          height="100%"
        />
      </div>

      {/* Top strip — header + (on mobile) the legend/pill scrollers. The center
          stays clear so the canvas can float its activation toast there. */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 6, pointerEvents: "none", display: "flex", flexDirection: "column", gap: 8, padding: headPad }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, pointerEvents: "auto" }}>
            <span aria-hidden style={{ display: "inline-flex", fontSize: 20, lineHeight: 1, color: "var(--accent)", textShadow: "0 0 14px var(--accent-a40)" }}>⌬</span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)", fontFamily: "var(--font-display)", letterSpacing: "-0.01em" }}>Neurons</div>
              {!isMobile && <div className="t-foot" style={{ color: "var(--sub)", marginTop: 1 }}>The wiring of your mind — doctrine plus everything you've taught it.</div>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", pointerEvents: "auto" }}>
            {!isMobile && (
              <>
                <StatPill label="nodes" value={displayGen.nodes.length} title={`${stats.enabled + stats.learnedEnabled} awake · ${stats.nodes} doctrine + ${stats.learned} learned`} />
                {stats.learned > 0 && <StatPill label="learned" value={stats.learned} title={`${stats.learnedEnabled} awake — skills taught in Learn`} />}
                <StatPill label="synapses" value={stats.edges} />
                <StatPill label="mind" value={`#${compiled.hash.slice(0, 6)}`} brass title="Hash of the compiled system prompt — changes when the mind does" />
                {lensPicker({ width: 210 })}
              </>
            )}
            <button onClick={() => setPanel(panel === "pulse" ? null : "pulse")}
              style={{ ...glass, borderRadius: 999, border: "1px solid var(--accent-a40)", padding: "6px 13px", color: "var(--accent)", fontFamily: "var(--font-display)", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
              ⚡ Pulse
            </button>
            <button onClick={() => setPanel(panel === "menu" ? null : "menu")} title="Neurons menu" aria-label="Neurons menu"
              style={{ ...glass, borderRadius: 999, padding: "6px 12px", color: "var(--sub)", fontSize: 14, fontWeight: 700, cursor: "pointer", lineHeight: 1 }}>
              ⋯
            </button>
          </div>
        </div>

        {/* Mobile: stat pills + lens on one scroller, legend chips on the next. */}
        {isMobile && (
          <>
            <div className="mind-scroll-x" style={{ display: "flex", gap: 6, overflowX: "auto", pointerEvents: "auto", paddingBottom: 2, alignItems: "center" }}>
              <StatPill label="nodes" value={displayGen.nodes.length} />
              {stats.learned > 0 && <StatPill label="learned" value={stats.learned} />}
              <StatPill label="synapses" value={stats.edges} />
              <StatPill label="mind" value={`#${compiled.hash.slice(0, 6)}`} brass />
              {lensPicker({ width: 200, flexShrink: 0 })}
            </div>
            <div className="mind-scroll-x" style={{ display: "flex", gap: 6, overflowX: "auto", pointerEvents: "auto", paddingBottom: 2 }}>
              {regionFilter && (
                <button onClick={() => setRegionFilter(null)} style={{ ...glass, pointerEvents: "auto", flexShrink: 0, padding: "5px 11px", borderRadius: 999, cursor: "pointer", color: "var(--accent)", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-display)" }}>All</button>
              )}
              {Object.keys(REGIONS).map(legendChip)}
              {learnedLegendChip()}
              <button onClick={growNode} style={{ ...glass, pointerEvents: "auto", flexShrink: 0, padding: "5px 11px", borderRadius: 999, border: "1px solid var(--accent-a40)", cursor: "pointer", color: "var(--accent)", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-display)" }}>＋ Node</button>
            </div>
          </>
        )}
      </div>

      {/* Desktop: floating region legend, top-left. */}
      {!isMobile && (
        <div style={{ ...glass, position: "absolute", top: 78, left: 14, zIndex: 6, padding: "10px 10px 9px", width: 182 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, padding: "0 7px" }}>
            <span className="t-label" style={{ color: "var(--sub)" }}>Regions</span>
            {regionFilter && (
              <button onClick={() => setRegionFilter(null)} style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 10.5, fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: "var(--font-display)" }}>all</button>
            )}
          </div>
          {Object.keys(REGIONS).map(legendRow)}
          <div style={{ height: 1, background: "var(--line)", margin: "7px 0" }} />
          {learnedLegendRow()}
          <div style={{ height: 1, background: "var(--line)", margin: "7px 0 8px" }} />
          <button onClick={growNode}
            style={{ width: "100%", padding: 8, background: "var(--accent-a10)", border: "1px solid var(--accent-a40)", borderRadius: 10, color: "var(--accent)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-display)" }}>
            ＋ Node
          </button>
          <div style={{ fontSize: 10.5, color: "var(--sub)", lineHeight: 1.6, marginTop: 8, padding: "0 2px" }}>
            dbl-click canvas — new node<br />⇧-drag node — wire synapse
          </div>
        </div>
      )}

      {/* Hidden import picker — shared by desktop + mobile menus. */}
      <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) importJson(f); }} />

      {/* ── Pulse — desktop popover / mobile sheet ── */}
      {panel === "pulse" && !isMobile && (
        <div style={{ ...glass, position: "absolute", top: 62, right: inspectorOpen ? 348 : 14, width: 348, zIndex: 30, padding: "13px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 9 }}>
            <span className="t-label" style={{ color: "var(--sub)" }}>Pulse the mind</span>
            {closeBtn(() => setPanel(null))}
          </div>
          {pulseBody}
        </div>
      )}
      {panel === "pulse" && isMobile && (
        <Sheet onClose={() => setPanel(null)} title="Pulse the mind">
          {pulseBody}
        </Sheet>
      )}

      {/* ── ⋯ menu — desktop dropdown / mobile sheet ── */}
      {panel === "menu" && !isMobile && (
        <div style={{ ...glass, position: "absolute", top: 62, right: 14, width: 240, zIndex: 30, padding: 5, borderRadius: 12 }}>
          {menuItems.map((it) => (
            <button key={it.label} className="mind-menuitem" onClick={it.run}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", background: "transparent", border: "none", borderRadius: 8, cursor: "pointer", color: it.danger ? "var(--red)" : "var(--ink)", fontSize: 13, fontWeight: 600, textAlign: "left" }}>
              <span style={{ width: 18, textAlign: "center", fontSize: 13, color: it.danger ? "var(--red)" : "var(--sub)", flexShrink: 0 }}>{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>
      )}
      {panel === "menu" && isMobile && (
        <Sheet onClose={() => setPanel(null)} title="Neurons">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {menuItems.map((it) => (
              <button key={it.label} className="mind-menuitem" onClick={it.run}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "13px 10px", background: "transparent", border: "none", borderRadius: 10, cursor: "pointer", color: it.danger ? "var(--red)" : "var(--ink)", fontSize: 15, fontWeight: 500, textAlign: "left" }}>
                <span style={{ width: 20, textAlign: "center", fontSize: 15, color: it.danger ? "var(--red)" : "var(--sub)", flexShrink: 0 }}>{it.icon}</span>
                {it.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {/* ── Inspector — desktop floating panel / mobile sheet ── */}
      {inspectorBody && !isMobile && (
        <div style={{ ...glass, position: "absolute", top: 78, right: 14, width: 322, maxHeight: "calc(100% - 104px)", zIndex: 9, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "12px 14px 0", flexShrink: 0 }}>
            <span className="t-label" style={{ color: "var(--sub)" }}>{inspectorTitle}</span>
            {closeBtn(() => setSelection(null))}
          </div>
          <div style={{ overflowY: "auto", padding: "9px 14px 14px" }}>{inspectorBody}</div>
        </div>
      )}
      {inspectorBody && isMobile && (
        <Sheet onClose={() => setSelection(null)} title={inspectorTitle}>
          {inspectorBody}
        </Sheet>
      )}

      {/* ── Compiled-mind modal — the deterministic artifact, under the lens. ── */}
      {modal === "compiled" && (
        <Sheet onClose={() => setModal(null)} title="Compiled mind"
          headTrailing={<Button kind="tinted" size="sm" onClick={copyMind}>Copy</Button>}
          bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <span className="t-num" style={{ fontSize: 11, color: "var(--faint)" }}>#{compiled.hash} · {lensedPrompt.length.toLocaleString()} chars</span>
            {lensPicker({ width: 210 })}
          </div>
          <div style={{ fontSize: 11, color: "var(--sub)", lineHeight: 1.5 }}>
            {lens === "full"
              ? "This exact string is the delegate's system prompt."
              : "A reading lens — the delegate always runs the full prompt."}
          </div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.7, color: "var(--sub)", background: "var(--surface-2)", borderRadius: 12, padding: "14px 16px", maxHeight: "58vh", overflowY: "auto" }}>{lensedPrompt}</pre>
        </Sheet>
      )}

      {/* ── Mutation history ── */}
      {modal === "history" && (
        <Sheet onClose={() => setModal(null)} title="Mutation history">
          <SectionHeader title={`${(genome.mutations || []).length} recorded · newest first · capped at 200`} />
          {(genome.mutations || []).length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--faint)", textAlign: "center", padding: "24px 0" }}>No mutations yet — the mind is untouched seed.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {(genome.mutations || []).map((m) => (
                <div key={m.id} style={{ display: "flex", gap: 10, padding: "9px 11px", background: "var(--surface-2)", borderRadius: 10, borderLeft: `3px solid ${KIND_COLOR[m.kind] || "var(--faint)"}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: "var(--ink)", lineHeight: 1.5 }}>{m.summary}</div>
                    <div className="t-num" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 3 }}>{m.kind} · {new Date(m.ts).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Sheet>
      )}

      {/* ── Self-contained toast — floats bottom-center, tokens only. ── */}
      {notice && (
        <div style={{ ...glass, position: "absolute", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 40, display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 15px", borderRadius: 999, maxWidth: "min(90%, 460px)", pointerEvents: "none", animation: "fadein var(--dur-2) var(--ease-out) both" }}>
          <Dot tone={noticeDot} size={7} />
          <span style={{ fontSize: 12, color: "var(--ink)", fontWeight: 500, lineHeight: 1.4 }}>{notice.text}</span>
        </div>
      )}

      {confirmEl}
    </div>
  );
}

export default MindPanel;
