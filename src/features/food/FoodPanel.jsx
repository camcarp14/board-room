import { useState } from "react";
import { T } from "../../theme.js";
import { S, tint } from "../../ui/styles.js";
import { callClaude } from "../../lib/claude.js";
import { useGroceries, useSavedRecipes, useAddGrocery, useToggleGrocery, useDeleteGrocery, useClearCheckedGroceries, useSaveRecipe, useDeleteRecipe } from "../../data/food.js";

export function FoodPanel({ isMobile, settings, updateSetting }) {
  const card = isMobile ? S.cardM : S.card;
  const prefs = settings?.food_preferences || { likes: [], dislikes: [] };
  const [newLike, setNewLike] = useState("");
  const [newDislike, setNewDislike] = useState("");
  const { data: groceries = null } = useGroceries();
  const { data: savedRecipes = null } = useSavedRecipes();
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

  const addLike = () => { if (!newLike.trim()) return; updateSetting("food_preferences", { ...prefs, likes: [...prefs.likes, newLike.trim()] }); setNewLike(""); };
  const addDislike = () => { if (!newDislike.trim()) return; updateSetting("food_preferences", { ...prefs, dislikes: [...prefs.dislikes, newDislike.trim()] }); setNewDislike(""); };
  const removeLike = (i) => updateSetting("food_preferences", { ...prefs, likes: prefs.likes.filter((_, idx) => idx !== i) });
  const removeDislike = (i) => updateSetting("food_preferences", { ...prefs, dislikes: prefs.dislikes.filter((_, idx) => idx !== i) });

  const addGroceryItem = () => { if (!newItem.trim()) return; addGroceryMut.mutate(newItem.trim(), { onSuccess: () => setNewItem("") }); };
  const toggleItem = (it) => { toggleMut.mutate({ id: it.id, checked: !it.checked }); };
  const removeItem = (id) => delGroceryMut.mutate(id);
  const clearChecked = () => { clearMut.mutate((groceries || []).filter(g => g.checked)); };

  const generateIdea = async () => {
    setGenerating(true); setIdeaErr(null); setIdea(null);
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
  const notForMe = () => {
    const key = window.prompt("What didn't work about it? (adds to your dislikes so future ideas avoid it — leave blank to skip)");
    if (key && key.trim()) updateSetting("food_preferences", { ...prefs, dislikes: [...prefs.dislikes, key.trim()] });
    setIdea(null);
  };
  const removeRecipe = (id) => { if (!window.confirm("Delete this saved recipe?")) return; delRecipeMut.mutate(id); };

  const tag = (text, onRemove, color) => (
    <span onClick={onRemove} style={{ fontSize: 10.5, color, border: `1px solid ${tint(color, 25)}`, background: tint(color, 8), borderRadius: 999, padding: "4px 10px", cursor: "pointer" }}>{text} ×</span>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={card}>
        <div style={{ ...S.title, marginBottom: 10 }}>Tastes</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 6 }}>LIKES</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {prefs.likes.map((l, i) => tag(l, () => removeLike(i), T.green))}
          {!prefs.likes.length && <span style={{ fontSize: 10.5, color: T.faint }}>None yet.</span>}
        </div>
        <div style={{ display: "flex", gap: 7, marginBottom: 16 }}>
          <input value={newLike} onChange={e => setNewLike(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addLike(); }} placeholder="Add something you like…" style={{ ...S.input, flex: 1, padding: "8px 10px", fontSize: 12 }} />
          <button onClick={addLike} style={{ ...S.ghostBtn, padding: "8px 14px", fontSize: 11.5 }}>Add</button>
        </div>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 6 }}>DISLIKES</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {prefs.dislikes.map((d, i) => tag(d, () => removeDislike(i), T.red))}
          {!prefs.dislikes.length && <span style={{ fontSize: 10.5, color: T.faint }}>None yet.</span>}
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <input value={newDislike} onChange={e => setNewDislike(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addDislike(); }} placeholder="Add something you don't like…" style={{ ...S.input, flex: 1, padding: "8px 10px", fontSize: 12 }} />
          <button onClick={addDislike} style={{ ...S.ghostBtn, padding: "8px 14px", fontSize: 11.5 }}>Add</button>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={S.title}>Grocery List</span>
          {(groceries || []).some(g => g.checked) && <span onClick={clearChecked} style={{ fontSize: 10, color: T.brass, cursor: "pointer", fontWeight: 600 }}>Clear checked</span>}
        </div>
        <div style={{ display: "flex", gap: 7, marginBottom: 12 }}>
          <input value={newItem} onChange={e => setNewItem(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addGroceryItem(); }} placeholder="Add an item…" style={{ ...S.input, flex: 1, padding: "8px 10px", fontSize: 12 }} />
          <button onClick={addGroceryItem} style={{ ...S.brassBtn, padding: "8px 14px", fontSize: 11.5 }}>Add</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {groceries === null ? <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{[0, 1].map(i => <div key={i} className="sk sk-line w60" style={{ margin: 0, height: 26, borderRadius: 8 }} />)}</div>
            : groceries.length ? groceries.map(it => (
              <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 2px" }}>
                <input type="checkbox" checked={it.checked} onChange={() => toggleItem(it)} />
                <span style={{ fontSize: 12, color: it.checked ? T.faint : T.ink, textDecoration: it.checked ? "line-through" : "none", flex: 1 }}>{it.item}</span>
                <button onClick={() => removeItem(it.id)} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 13 }}>×</button>
              </div>
            )) : <div style={{ fontSize: 11, color: T.faint }}>List's empty.</div>}
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={S.title}>Meal Ideas</span>
          <button onClick={generateIdea} disabled={generating} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11.5 }}>{generating ? "Thinking…" : "✦ Generate idea"}</button>
        </div>
        {ideaErr && <div style={{ fontSize: 11, color: T.red, marginBottom: 8 }}>{ideaErr}</div>}
        {idea && (
          <div style={{ ...S.inner, padding: "13px 15px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: T.ink, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{idea}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={saveIdea} style={{ ...S.brassBtn, padding: "7px 14px", fontSize: 11 }}>👍 Save recipe</button>
              <button onClick={notForMe} style={{ ...S.ghostBtn, padding: "7px 14px", fontSize: 11 }}>👎 Not my taste</button>
            </div>
          </div>
        )}
        {(savedRecipes || []).length > 0 && (
          <>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, letterSpacing: "0.04em", marginBottom: 8 }}>SAVED</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {savedRecipes.map(r => (
                <div key={r.id} style={{ ...S.inner, padding: "9px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{r.title}</span>
                  <button onClick={() => removeRecipe(r.id)} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: 13 }}>×</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

