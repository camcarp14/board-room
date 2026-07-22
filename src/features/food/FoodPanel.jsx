import { useState } from "react";
import { tint } from "../../ui/styles.js";
import { callClaude } from "../../lib/claude.js";
import { useGroceries, useSavedRecipes, useAddGrocery, useToggleGrocery, useDeleteGrocery, useClearCheckedGroceries, useSaveRecipe, useDeleteRecipe } from "../../data/food.js";
import { Card, CellGroup, Button, Field, Pill, Grid, useConfirm, IcCheck } from "../../ui/kit.jsx";
import { IcClose, IcSpark } from "../../ui/icons.jsx";

// Reset that lets a <button> wear the kit's .cell-body anatomy (rows keep a
// separate delete button, so the whole cell can't be one <button> itself).
const rowBtn = { background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", alignSelf: "stretch", justifyContent: "center" };
// Full-bleed list inside a pad-md card: the group sheds its own surface and
// stretches to the card edges so row hairlines read like native inset cells.
const inCardGroup = { boxShadow: "none", background: "transparent", borderRadius: 0, margin: "0 -16px -10px" };

export function FoodPanel({ isMobile, settings, updateSetting }) {
  const prefs = settings?.food_preferences || { likes: [], dislikes: [] };
  const [newLike, setNewLike] = useState("");
  const [newDislike, setNewDislike] = useState("");
  const { data: groceries = null, error: groceriesErr, refetch: refetchGroceries } = useGroceries();
  const { data: savedRecipes = null, error: recipesErr, refetch: refetchRecipes } = useSavedRecipes();
  const addGroceryMut = useAddGrocery();
  const toggleMut = useToggleGrocery();
  const delGroceryMut = useDeleteGrocery();
  const clearMut = useClearCheckedGroceries();
  const saveRecipeMut = useSaveRecipe();
  const delRecipeMut = useDeleteRecipe();
  const [newItem, setNewItem] = useState("");
  const [generating, setGenerating] = useState(false);
  const [idea, setIdea] = useState(null);
  const [ideaErr, setIdeaErr] = useState(null);
  const [reasonOpen, setReasonOpen] = useState(false); // inline "not my taste" flow (replaces window.prompt)
  const [reason, setReason] = useState("");
  const [confirmEl, confirm] = useConfirm();
  // Mutations were silent on failure — the row just reappeared on the next
  // refetch with no explanation. One quiet complaint sheet for all of them.
  const complain = (e) => confirm({ title: "That didn't save", message: e?.message || "Check the connection and try again.", confirmLabel: "OK", cancelLabel: false });

  // Boot guard (same hazard WorkoutPanel documents for its key): before
  // settings resolve, `prefs` is the empty default — a write in that window
  // would upsert the whole value and clobber every stored taste with one row.
  const prefsReady = settings != null;
  const addLike = () => { if (!prefsReady || !newLike.trim()) return; updateSetting("food_preferences", { ...prefs, likes: [...prefs.likes, newLike.trim()] }); setNewLike(""); };
  const addDislike = () => { if (!prefsReady || !newDislike.trim()) return; updateSetting("food_preferences", { ...prefs, dislikes: [...prefs.dislikes, newDislike.trim()] }); setNewDislike(""); };
  const removeLike = (i) => { if (prefsReady) updateSetting("food_preferences", { ...prefs, likes: prefs.likes.filter((_, idx) => idx !== i) }); };
  const removeDislike = (i) => { if (prefsReady) updateSetting("food_preferences", { ...prefs, dislikes: prefs.dislikes.filter((_, idx) => idx !== i) }); };

  const addGroceryItem = () => { if (!newItem.trim()) return; addGroceryMut.mutate(newItem.trim(), { onSuccess: () => setNewItem(""), onError: complain }); };
  const toggleItem = (it) => { toggleMut.mutate({ id: it.id, checked: !it.checked }, { onError: complain }); };
  const removeItem = (id) => delGroceryMut.mutate(id, { onError: complain });
  const clearChecked = () => { clearMut.mutate((groceries || []).filter(g => g.checked), { onError: complain }); };

  const generateIdea = async () => {
    setGenerating(true); setIdeaErr(null); setIdea(null); setReasonOpen(false); setReason("");
    const system = `You generate one meal idea with a full, cookable recipe for someone with specific tastes. Likes: ${prefs.likes.join(", ") || "no strong likes recorded yet"}. Dislikes — never suggest anything built around these: ${prefs.dislikes.join(", ") || "none recorded yet"}. Give a real recipe: a short title, ingredient list with rough quantities, and clear numbered steps. Keep it practical for a home cook on a weeknight unless asked otherwise. No preamble, start straight with the title.`;
    const raw = await callClaude({ system, messages: [{ role: "user", content: "Give me a meal idea for tonight." }], modelKey: "haiku", maxTokens: 600, fn: "meal_idea" });
    setGenerating(false);
    if (raw && raw.trim()) setIdea(raw.trim());
    else setIdeaErr("Couldn't get an idea — try again.");
  };
  const saveIdea = () => {
    if (!idea) return;
    const title = idea.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80);
    saveRecipeMut.mutate({ title, body: idea }, { onSuccess: () => setIdea(null), onError: complain });
  };
  // Optionally files the reason under dislikes, then clears the idea —
  // same semantics as the old window.prompt (blank/skip adds nothing).
  const dismissIdea = (addReason) => {
    if (addReason && reason.trim() && prefsReady) updateSetting("food_preferences", { ...prefs, dislikes: [...prefs.dislikes, reason.trim()] });
    setIdea(null); setReasonOpen(false); setReason("");
  };
  const removeRecipe = async (r) => {
    if (!(await confirm({ title: `Delete "${r.title}"?`, message: "The saved recipe is gone for good.", confirmLabel: "Delete", destructive: true }))) return;
    delRecipeMut.mutate(r.id, { onError: complain });
  };

  const tagRow = (items, onRemove, color, emptyText) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {items.map((t, i) => (
        <Pill key={`${t}-${i}`} onClick={() => onRemove(i)} style={{ background: tint(color, 10), color }}>
          {t} <IcClose size={11} />
        </Pill>
      ))}
      {!items.length && <span className="t-foot" style={{ color: "var(--faint)", padding: "8px 0" }}>{emptyText}</span>}
    </div>
  );

  return (
    <Grid min={isMobile ? 320 : 360} gap={12} style={{ minWidth: 0 }}>

      {/* ── tastes ── */}
      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="t-head">Tastes</span>
        <span className="t-label">Likes</span>
        {tagRow(prefs.likes, removeLike, "var(--green)", "None yet.")}
        <div style={{ display: "flex", gap: 8 }}>
          <Field value={newLike} onChange={e => setNewLike(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addLike(); }} placeholder="Add something you like…" style={{ flex: 1, minWidth: 0 }} />
          <Button kind="quiet" size="md" onClick={addLike} style={{ flex: "none" }}>Add</Button>
        </div>
        <span className="t-label" style={{ marginTop: 6 }}>Dislikes</span>
        {tagRow(prefs.dislikes, removeDislike, "var(--red)", "None yet.")}
        <div style={{ display: "flex", gap: 8 }}>
          <Field value={newDislike} onChange={e => setNewDislike(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addDislike(); }} placeholder="Add something you don't like…" style={{ flex: 1, minWidth: 0 }} />
          <Button kind="quiet" size="md" onClick={addDislike} style={{ flex: "none" }}>Add</Button>
        </div>
      </Card>

      {/* ── grocery list ── */}
      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span className="t-head">Grocery list</span>
          {(groceries || []).some(g => g.checked) && (
            <button className="sec-link" style={{ padding: "10px 8px", margin: "-10px -8px" }} onClick={clearChecked}>Clear checked</button>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Field value={newItem} onChange={e => setNewItem(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addGroceryItem(); }} placeholder="Add an item…" style={{ flex: 1, minWidth: 0 }} />
          <Button kind="quiet" size="md" onClick={addGroceryItem} style={{ flex: "none" }}>Add</Button>
        </div>
        {groceriesErr ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
            <span className="t-foot" style={{ color: "var(--red)", flex: 1 }}>Couldn't load the list — your items are still there.</span>
            <Button kind="tinted" size="sm" onClick={() => refetchGroceries()} style={{ flex: "none" }}>Retry</Button>
          </div>
        ) : groceries === null ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[0, 1].map(i => <div key={i} className="sk sk-line w60" style={{ margin: 0, height: 26, borderRadius: 8 }} />)}
          </div>
        ) : groceries.length ? (
          <CellGroup style={inCardGroup}>
            {groceries.map(it => (
              <div key={it.id} className="cell" style={{ paddingRight: 8, minHeight: 48 }}>
                <button className="cell-body" onClick={() => toggleItem(it)} role="checkbox" aria-checked={!!it.checked}
                  style={{ ...rowBtn, flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <span aria-hidden style={{ width: 22, height: 22, borderRadius: "50%", flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", ...(it.checked ? { background: "var(--green)", color: "#FFFFFF" } : { boxShadow: "inset 0 0 0 1.5px var(--line-strong)" }) }}>
                    {it.checked && <IcCheck size={12} />}
                  </span>
                  <span className="t-call" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...(it.checked ? { color: "var(--faint)", textDecoration: "line-through" } : null) }}>{it.item}</span>
                </button>
                <button className="icon-btn" aria-label={`Delete ${it.item}`} onClick={() => removeItem(it.id)}><IcClose size={15} /></button>
              </div>
            ))}
          </CellGroup>
        ) : (
          <span className="t-foot" style={{ color: "var(--faint)", padding: "4px 0" }}>List's empty.</span>
        )}
      </Card>

      {/* ── meal ideas ── */}
      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span className="t-head">Meal ideas</span>
          <Button kind="primary" size="md" onClick={generateIdea} disabled={generating} style={{ flex: "none" }}>
            {generating ? "Thinking…" : <><IcSpark size={14} /> Generate idea</>}
          </Button>
        </div>
        {ideaErr && <div className="t-foot" style={{ color: "var(--red)" }}>{ideaErr}</div>}
        {idea && (
          <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="t-call" style={{ lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "break-word" }}>{idea}</div>
            {!reasonOpen ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button kind="tinted" size="md" onClick={saveIdea}>Save recipe</Button>
                <Button kind="quiet" size="md" onClick={() => setReasonOpen(true)}>Not my taste</Button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="t-foot" style={{ lineHeight: 1.55 }}>What didn't work about it? Adds to your dislikes so future ideas avoid it — skip if it was just meh.</span>
                <Field className="on-well" value={reason} onChange={e => setReason(e.target.value)} onKeyDown={e => { if (e.key === "Enter") dismissIdea(true); }} autoFocus placeholder="e.g. too much cilantro" />
                <div style={{ display: "flex", gap: 10 }}>
                  <Button kind="quiet" size="md" onClick={() => dismissIdea(true)}>Add to dislikes</Button>
                  <Button kind="plain" size="md" onClick={() => dismissIdea(false)}>Skip</Button>
                </div>
              </div>
            )}
          </div>
        )}
        {recipesErr && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="t-foot" style={{ color: "var(--red)", flex: 1 }}>Couldn't load saved recipes.</span>
            <Button kind="tinted" size="sm" onClick={() => refetchRecipes()} style={{ flex: "none" }}>Retry</Button>
          </div>
        )}
        {(savedRecipes || []).length > 0 && (
          <div>
            <span className="t-label" style={{ display: "block", padding: "2px 0 8px" }}>Saved</span>
            <CellGroup style={inCardGroup}>
              {savedRecipes.map(r => (
                <div key={r.id} className="cell" style={{ paddingRight: 8, minHeight: 48 }}>
                  <span className="cell-body"><span className="cell-title" style={{ fontSize: 14.5 }}>{r.title}</span></span>
                  <button className="icon-btn" aria-label={`Delete ${r.title}`} onClick={() => removeRecipe(r)}><IcClose size={15} /></button>
                </div>
              ))}
            </CellGroup>
          </div>
        )}
      </Card>
      {confirmEl}
    </Grid>
  );
}
