import { useState, useRef } from "react";
import { tint } from "../../ui/styles.js";
import { callClaude } from "../../lib/claude.js";
import { useSavedRecipes, useSaveRecipe, useDeleteRecipe } from "../../data/food.js";
import { Card, CellGroup, Button, Field, Pill, Grid, Sheet, useConfirm, closeSheet } from "../../ui/kit.jsx";
import { IcClose, IcSpark } from "../../ui/icons.jsx";

// Full-bleed list inside a pad-md card: the group sheds its own surface and
// stretches to the card edges so row hairlines read like native inset cells.
const inCardGroup = { boxShadow: "none", background: "transparent", borderRadius: 0, margin: "0 -16px -10px" };
// Reset that lets a <button> wear the kit's .cell-body anatomy (rows keep a
// separate delete button, so the whole cell can't be one <button> itself).
const rowBtn = { background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", alignSelf: "stretch", justifyContent: "center" };

export function FoodPanel({ isMobile, settings, updateSetting }) {
  const prefs = settings?.food_preferences || { likes: [], dislikes: [] };
  const [newLike, setNewLike] = useState("");
  const [newDislike, setNewDislike] = useState("");
  // `error` is read here because the recipes query used to carry a
  // `.catch(() => [])`, which turned a failed read into an empty list and then
  // CACHED that empty list — into a cache persisted for 24 hours. The read is
  // honest now and lands in `error`, so this panel has to draw it: otherwise a
  // failure and "you have saved nothing" are the same blank space, which is the
  // costume the bug was wearing in the first place.
  const { data: savedRecipes = null, error: recipesError, refetch: refetchRecipes } = useSavedRecipes();
  const saveRecipeMut = useSaveRecipe();
  const delRecipeMut = useDeleteRecipe();
  const [generating, setGenerating] = useState(false);
  const [idea, setIdea] = useState(null);
  const [ideaErr, setIdeaErr] = useState(null);
  const [reasonOpen, setReasonOpen] = useState(false); // inline "not my taste" flow (replaces window.prompt)
  const [reason, setReason] = useState("");
  const [confirmEl, confirm] = useConfirm();
  // The saved recipe you have open. Saving used to be write-only: the idea card
  // vanished on save and the list drew a title with an X, so the ingredients and
  // steps went into the table and no screen ever read them back out. A row opens
  // a sheet now, and that sheet is where Delete lives too — the same tap that
  // finds the recipe is the one that can bin it.
  const [open, setOpen] = useState(null);
  // Populated by the Sheet while it is mounted. See closeSheet in ui/kit.jsx.
  const sheetClose = useRef(null);

  const addLike = () => { if (!newLike.trim()) return; updateSetting("food_preferences", { ...prefs, likes: [...prefs.likes, newLike.trim()] }); setNewLike(""); };
  const addDislike = () => { if (!newDislike.trim()) return; updateSetting("food_preferences", { ...prefs, dislikes: [...prefs.dislikes, newDislike.trim()] }); setNewDislike(""); };
  const removeLike = (i) => updateSetting("food_preferences", { ...prefs, likes: prefs.likes.filter((_, idx) => idx !== i) });
  const removeDislike = (i) => updateSetting("food_preferences", { ...prefs, dislikes: prefs.dislikes.filter((_, idx) => idx !== i) });


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
    saveRecipeMut.mutate({ title, body: idea }, { onSuccess: () => setIdea(null) });
  };
  // Optionally files the reason under dislikes, then clears the idea —
  // same semantics as the old window.prompt (blank/skip adds nothing).
  const dismissIdea = (addReason) => {
    if (addReason && reason.trim()) updateSetting("food_preferences", { ...prefs, dislikes: [...prefs.dislikes, reason.trim()] });
    setIdea(null); setReasonOpen(false); setReason("");
  };
  // "Gone for good" is still true here — this is a hard delete, unlike the Creed
  // and Dream soft deletes. From the sheet, the sheet leaves once the row has.
  const removeRecipe = async (r) => {
    if (!(await confirm({ title: `Delete "${r.title}"?`, message: "The saved recipe is gone for good.", confirmLabel: "Delete", destructive: true }))) return;
    delRecipeMut.mutate(r.id, { onSuccess: () => { if (open?.id === r.id) closeSheet(sheetClose, () => setOpen(null)); } });
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

      {/* The grocery list moved to its own top-level tab (pages/grocery). It
          gets used standing in a shop, one-handed — two taps deep in here was
          the wrong depth for that, whatever its topical home. This panel keeps
          tastes, meal ideas and saved recipes. */}


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
        {recipesError && (
          <div>
            <span className="t-label" style={{ display: "block", padding: "2px 0 8px" }}>Saved</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 4px" }}>
              <span className="t-foot" style={{ color: "var(--red)", flex: 1 }}>Couldn't load your saved recipes.</span>
              <Button kind="tinted" size="sm" style={{ flex: "none" }} onClick={() => refetchRecipes()}>Retry</Button>
            </div>
          </div>
        )}
        {!recipesError && (savedRecipes || []).length > 0 && (
          <div>
            <span className="t-label" style={{ display: "block", padding: "2px 0 8px" }}>Saved</span>
            <CellGroup style={inCardGroup}>
              {savedRecipes.map(r => (
                <div key={r.id} className="cell" style={{ paddingRight: 8, minHeight: 48 }}>
                  <button className="cell-body" onClick={() => setOpen(r)} style={rowBtn}><span className="cell-title" style={{ fontSize: 14.5 }}>{r.title}</span></button>
                  <button className="icon-btn" aria-label={`Delete ${r.title}`} onClick={() => removeRecipe(r)}><IcClose size={15} /></button>
                </div>
              ))}
            </CellGroup>
          </div>
        )}
      </Card>

      {/* ── a saved recipe, read back — the same pre-wrap block the idea card uses ── */}
      {open && (
        <Sheet closeRef={sheetClose} onClose={() => setOpen(null)} title={open.title}
          footer={<Button kind="danger" size="lg" disabled={delRecipeMut.isPending} onClick={() => removeRecipe(open)} style={{ flex: 1 }}>Delete</Button>}>
          <div className="t-call" style={{ lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "break-word", paddingTop: 4 }}>{open.content}</div>
        </Sheet>
      )}
      {confirmEl}
    </Grid>
  );
}
