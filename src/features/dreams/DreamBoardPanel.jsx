import { useState, useMemo } from "react";
import { isMissingTable } from "../../data/db.js";
import {
  useDreamItems, useSaveDreamItem, useDeleteDreamItem, useRenameDreamBoard, useDeleteDreamBoard,
} from "../../data/dreams.js";
import { Card, Button, Field, TextArea, Sheet, EmptyState, PillRow, Pill, useConfirm, IcCheck } from "../../ui/kit.jsx";
import { IcClose, IcChevronDown } from "../../ui/icons.jsx";
import {
  DEFAULT_BOARD, SETUP_SQL, DREAM_STARTERS,
  boardsOf, tilesOf, boardCounts, tileKind, toneFor, nextSort, moveTile, isImageUrl,
} from "./dreamLogic.js";

// ─── Dream boards — the wall you actually want to look at ────────────────────
// MANY boards, not one. Sub-boards on specific topics is the whole reason this
// isn't a single list: "Dreams" holds the life, "Health" and "Business" hold the
// arguments you're having with yourself this quarter, and mixing them makes both
// weaker. The board strip carries a + at the end for the next one.
//
// A tile is a picture or a sentence, and the sentence is a first-class outcome
// rather than a fallback — a board of bold type is a real vision board, and it's
// the only kind you can build without going hunting for images first. See
// dreamLogic.tileKind.
//
// THE COLLAGE. CSS multi-column, not a grid: tiles have wildly different heights
// (a photo, a four-word line, a paragraph), and a fixed grid either crops them
// all to one ratio or leaves ragged holes. Columns let each tile be its own
// height and still pack tight, which is what makes it read as a board rather
// than a table of cards.

const sqlPre = { background: "var(--surface-2)", borderRadius: 12, padding: "12px 14px", fontSize: 11, fontFamily: "var(--font-mono)", lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre", color: "var(--sub)", margin: 0 };
const NEW_BOARD = "<new-board>"; // sentinel; board names are trimmed, so no collision

/* One tile. Photo tiles put the title over the image behind a scrim — a caption
   below would break the collage's rhythm and double the tile's height for two
   words. Type tiles carry the weight themselves. */
function Tile({ it, onOpen }) {
  const kind = tileKind(it);
  const tone = toneFor(it.id);
  const [broken, setBroken] = useState(false);
  const showPhoto = kind === "photo" && !broken;

  return (
    <button onClick={onOpen} className="press"
      style={{
        display: "block", width: "100%", breakInside: "avoid", marginBottom: 10,
        border: 0, padding: 0, background: "none", font: "inherit", color: "inherit",
        textAlign: "left", cursor: "pointer", borderRadius: 14, overflow: "hidden",
        position: "relative", boxShadow: "var(--shadow-card)",
      }}>
      {showPhoto ? (
        <>
          <img src={it.image_url} alt={it.title || "Dream"} loading="lazy"
            // A URL that turns out to be a web page, a dead link, or a host that
            // blocks hotlinking must not leave a broken-image glyph on the wall:
            // it falls back to the type tile, which still says what you meant.
            onError={() => setBroken(true)}
            style={{ display: "block", width: "100%", height: "auto", background: "var(--surface-2)" }} />
          {it.title && (
            <span style={{
              position: "absolute", left: 0, right: 0, bottom: 0, padding: "26px 12px 11px",
              background: "linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0))",
              color: "#fff", fontSize: 14, fontWeight: 650, lineHeight: 1.35, letterSpacing: "-0.01em",
            }}>{it.title}</span>
          )}
        </>
      ) : (
        <span style={{
          display: "block", padding: "18px 16px 20px", minHeight: 96,
          background: `color-mix(in srgb, ${tone} 14%, var(--surface))`,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone} 22%, transparent)`,
        }}>
          <span aria-hidden style={{ display: "block", width: 22, height: 3, borderRadius: 2, background: tone, marginBottom: 12 }} />
          <span style={{
            display: "block", color: "var(--ink)", fontWeight: 650, letterSpacing: "-0.015em",
            lineHeight: 1.35, fontSize: (it.title || "").length > 90 ? 15 : (it.title || "").length > 44 ? 17 : 19,
          }}>{it.title || "Untitled"}</span>
          {it.note && (
            <span className="t-foot" style={{ display: "block", color: "var(--sub)", marginTop: 8, lineHeight: 1.5 }}>{it.note}</span>
          )}
        </span>
      )}
    </button>
  );
}

export function DreamBoardPanel({ isMobile, settings, updateSetting }) {
  const { data: rows = null, error, refetch } = useDreamItems();
  const needsSetup = !!error && isMissingTable(error, "dream_items");
  const loadErr = error && !needsSetup ? (error.message || "Couldn't load your boards.") : null;
  const saveMut = useSaveDreamItem();
  const delMut = useDeleteDreamItem();
  const renameMut = useRenameDreamBoard();
  const dropBoardMut = useDeleteDreamBoard();

  const [copied, setCopied] = useState(false);
  const [board, setBoard] = useState("");
  const [boardForm, setBoardForm] = useState(null);   // null | { mode, original }
  const [boardDraft, setBoardDraft] = useState("");
  const [tile, setTile] = useState(null);             // the open editor
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const all = rows || [];
  const savedBoards = settings?.dream_boards;
  const boards = useMemo(() => boardsOf(all, savedBoards), [all, savedBoards]);
  const counts = useMemo(() => boardCounts(all), [all]);
  // A board that no longer exists must not stay selected — you'd be looking at
  // an empty wall with no way to tell which board you were on.
  const active = boards.some((b) => b.toLowerCase() === board.toLowerCase()) ? board : (boards[0] || "");
  const tiles = useMemo(() => tilesOf(all, active), [all, active]);

  const saveBoardList = (list) => updateSetting?.("dream_boards", boardsOf([], list));

  const openNewBoard = () => { setBoardDraft(""); setBoardForm({ mode: "new" }); };
  const openEditBoard = () => { setBoardDraft(active); setBoardForm({ mode: "edit", original: active }); };
  const closeBoardForm = () => { setBoardDraft(""); setBoardForm(null); };

  const saveBoard = () => {
    const name = boardDraft.trim();
    if (!name) return;
    const original = boardForm?.mode === "edit" ? boardForm.original : "";
    closeBoardForm();
    if (original && original === name) return;
    if (original) {
      // The board name lives on every tile, so a rename is a rewrite of all of
      // them — and the saved list only follows once that lands, or a failure
      // would leave the new name listed with nothing under it.
      renameMut.mutate({ from: original, to: name }, {
        onSuccess: () => saveBoardList([...(savedBoards || []).filter((b) => b !== original), name]),
      });
    } else {
      saveBoardList([...(savedBoards || []), name]);
    }
    setBoard(name);
  };

  const removeBoard = async () => {
    const name = boardForm?.original;
    if (!name) return;
    const n = counts[name] || 0;
    const ok = await confirm({
      title: `Delete ${name}?`,
      message: n
        ? `The ${n} tile${n === 1 ? "" : "s"} on this board are deleted with it. This can't be undone.`
        : `This board is empty — nothing is lost.`,
      confirmLabel: "Delete board",
      destructive: true,
    });
    if (!ok) return;
    closeBoardForm();
    const drop = () => saveBoardList((savedBoards || []).filter((b) => b !== name));
    if (n) dropBoardMut.mutate(name, { onSuccess: drop });
    else drop();
    setBoard("");
  };

  const openNewTile = (seedTitle) => {
    setSaveErr(null);
    setTile({ id: crypto.randomUUID(), board: active || DEFAULT_BOARD, title: seedTitle || "", image_url: "", note: "", sort: nextSort(tiles), isNew: true });
  };
  const openTile = (t) => { setSaveErr(null); setTile({ ...t, image_url: t.image_url || "", note: t.note || "", isNew: false }); };

  const saveTile = () => {
    if (!tile.title.trim() && !tile.image_url.trim()) { setSaveErr("Give it a picture or a line — ideally both."); return; }
    setSaving(true); setSaveErr(null);
    saveMut.mutate({ ...tile, title: tile.title.trim(), image_url: tile.image_url.trim() || null, note: tile.note.trim() || null }, {
      onSuccess: () => { setSaving(false); setTile(null); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't save."); },
    });
  };
  const removeTile = async () => {
    if (!(await confirm({ title: "Remove this tile?", message: "It comes off the board for good.", confirmLabel: "Remove", destructive: true }))) return;
    setSaving(true);
    delMut.mutate(tile.id, {
      onSuccess: () => { setSaving(false); setTile(null); },
      onError: (e) => { setSaving(false); setSaveErr(e.message || "Couldn't remove."); },
    });
  };
  // Reorder writes only the tiles that actually moved — two rows, not the board.
  const nudge = (dir) => {
    const order = moveTile(tiles, tile.id, dir);
    if (!order) return;
    order.forEach((id, i) => {
      const t = tiles.find((x) => x.id === id);
      const sort = (i + 1) * 10;
      if (t && (t.sort ?? 0) !== sort) saveMut.mutate({ ...t, sort });
    });
    setTile((t) => ({ ...t, sort: (order.indexOf(tile.id) + 1) * 10 }));
  };

  if (needsSetup) return (
    <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="t-head">One-time setup</span>
      <span className="t-foot" style={{ lineHeight: 1.6 }}>
        The dream board table doesn't exist yet. Paste this into the Supabase SQL editor (safe to re-run), then come back — everything else is already wired.
      </span>
      <pre style={sqlPre}>{SETUP_SQL}</pre>
      <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
        <Button kind="primary" size="md" onClick={() => { navigator.clipboard?.writeText(SETUP_SQL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {}); }}>
          {copied ? <><IcCheck size={15} /> Copied</> : "Copy SQL"}
        </Button>
        <Button kind="quiet" size="md" onClick={() => refetch()}>I ran it — retry</Button>
      </div>
    </Card>
  );

  if (loadErr) return (
    <EmptyState title="Couldn't load your boards" sub={loadErr}
      action={<Button kind="tinted" size="sm" onClick={() => refetch()}>Retry</Button>} style={{ padding: "28px 16px" }} />
  );

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      {/* ── which board. The + is the last chip, so making another one is in the
            same place you switch between them rather than in a menu. ── */}
      {(boards.length > 0 || boardForm) && (
        <PillRow
          options={[
            ...boards.map((b) => ({ key: b, label: counts[b] ? `${b} ${counts[b]}` : b })),
            { key: NEW_BOARD, label: "+" },
          ]}
          value={active}
          onChange={(k) => (k === NEW_BOARD ? openNewBoard() : setBoard(k))}
        />
      )}

      {boardForm && (
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <Field value={boardDraft} onChange={(e) => setBoardDraft(e.target.value)} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") saveBoard(); if (e.key === "Escape") closeBoardForm(); }}
              placeholder="Board name — e.g. Health, Business, The House" enterKeyHint="done" style={{ flex: 1, minWidth: 0 }} />
            <Button kind="primary" size="md" onClick={saveBoard} disabled={!boardDraft.trim()} style={{ flex: "none" }}>
              {boardForm.mode === "edit" ? "Save" : "Create"}
            </Button>
            <Button kind="quiet" size="md" onClick={closeBoardForm} style={{ flex: "none" }}>Cancel</Button>
          </div>
          {boardForm.mode === "edit" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="t-cap" style={{ color: "var(--faint)", flex: 1, minWidth: 0, lineHeight: 1.45 }}>
                Renaming moves every tile on {boardForm.original}.
              </span>
              <Button kind="quiet" size="sm" onClick={removeBoard} style={{ flex: "none" }}>Delete board</Button>
            </div>
          )}
        </Card>
      )}

      {/* ── the board itself ── */}
      {rows === null ? (
        <div style={{ columnCount: isMobile ? 2 : 3, columnGap: 10 }}>
          {[190, 120, 150, 110, 170, 130].map((h, i) => (
            <div key={i} className="sk" style={{ height: h, borderRadius: 14, marginBottom: 10, breakInside: "avoid" }} />
          ))}
        </div>
      ) : !boards.length ? (
        <EmptyState
          title="No boards yet"
          sub="A dream board is the wall you keep the good version of your life on. Start with one — you can add more for specific things later."
          action={<Button kind="primary" size="md" onClick={openNewBoard}>Create your first board</Button>}
          style={{ padding: "34px 18px" }}
        />
      ) : !tiles.length ? (
        <Card pad="lg" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center", padding: "30px 22px" }}>
          <span className="t-head">{active} is empty</span>
          <span className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.6, maxWidth: 380 }}>
            Pin a picture by pasting its link, or just write the thing down — a wall of sentences works, and it's faster than hunting for images.
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginTop: 4 }}>
            {DREAM_STARTERS.map((t, i) => (
              <Pill key={i} onClick={() => openNewTile(t)} style={{ height: "auto", minHeight: 34, padding: "7px 12px", whiteSpace: "normal", lineHeight: 1.45, textAlign: "left" }}>{t}</Pill>
            ))}
          </div>
          <Button kind="primary" size="md" onClick={() => openNewTile()} style={{ marginTop: 6 }}>Add a tile</Button>
        </Card>
      ) : (
        <>
          <div style={{ columnCount: isMobile ? 2 : 3, columnGap: 10 }}>
            {tiles.map((t) => <Tile key={t.id} it={t} onOpen={() => openTile(t)} />)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Button kind="tinted" size="md" onClick={() => openNewTile()} style={{ flex: 1 }}>Add to {active}</Button>
            <Button kind="quiet" size="md" onClick={openEditBoard} style={{ flex: "none" }}>Edit board</Button>
          </div>
        </>
      )}

      {/* ── the tile editor ── */}
      {tile && (
        <Sheet onClose={() => setTile(null)} title={tile.isNew ? `Add to ${tile.board}` : "Edit tile"}
          footer={
            <>
              {!tile.isNew && <Button kind="danger" size="lg" disabled={saving} onClick={removeTile}>Remove</Button>}
              <Button kind="primary" size="lg" disabled={saving} onClick={saveTile} style={{ flex: 1 }}>{saving ? "Saving…" : tile.isNew ? "Pin it" : "Save"}</Button>
            </>
          }>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
            <TextArea value={tile.title} onChange={(e) => setTile((t) => ({ ...t, title: e.target.value }))} autoFocus rows={2}
              placeholder="The thing itself — say it like it's already true." style={{ lineHeight: 1.5, resize: "vertical" }} />
            <div>
              <Field value={tile.image_url} onChange={(e) => setTile((t) => ({ ...t, image_url: e.target.value }))}
                placeholder="Paste an image link (optional)" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck="false"
                aria-label="Image URL" />
              <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.5, padding: "6px 4px 0" }}>
                Right-click any image on the web → “Copy image address”. No link is fine — it becomes a type tile.
              </div>
            </div>
            {/* Shown before you commit, because a link that turns out to be a
                page rather than a picture is the single most likely mistake
                here, and finding out on the wall is worse than finding out now. */}
            {isImageUrl(tile.image_url) && (
              <img src={tile.image_url} alt="" style={{ width: "100%", borderRadius: 12, display: "block", background: "var(--surface-2)" }}
                onError={(e) => { e.currentTarget.style.display = "none"; }} />
            )}
            <TextArea value={tile.note} onChange={(e) => setTile((t) => ({ ...t, note: e.target.value }))} rows={2}
              placeholder="Why this one (optional)" style={{ lineHeight: 1.55, resize: "vertical" }} />
            {!tile.isNew && tiles.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="t-cap" style={{ color: "var(--faint)", flex: 1 }}>Position on the board</span>
                <Button kind="quiet" size="sm" onClick={() => nudge(-1)} aria-label="Move earlier">
                  <IcChevronDown size={13} style={{ transform: "rotate(180deg)" }} />
                </Button>
                <Button kind="quiet" size="sm" onClick={() => nudge(1)} aria-label="Move later"><IcChevronDown size={13} /></Button>
              </div>
            )}
            {saveErr && <div className="t-foot" style={{ color: "var(--red)" }}>{saveErr}</div>}
          </div>
        </Sheet>
      )}
      {confirmEl}
    </section>
  );
}

export default DreamBoardPanel;
