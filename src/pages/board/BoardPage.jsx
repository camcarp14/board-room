// ─── Page: Board Room (chat + seats + Mini Me + Learn) ───────────────────────
// Desktop: split view — chat and the board are both visible, always, no
// switching needed. Mobile (and desktop windows too narrow for the split): a
// sub-tab toggle, since there's no room for both.
import { useState, useEffect } from "react";
import { Card, SectionHeader, Segmented, Button, Dot } from "../../ui/kit.jsx";
import { IcCheck, IcChevronRight, IcSeal } from "../../ui/icons.jsx";
import { BOARD, callClaude } from "../../lib/claude.js";
import { supabase } from "../../lib/supabase.js";
import { tint } from "../../ui/styles.js";
import LearnPanel from "../../LearnPanel.jsx";
import { ChatRoom } from "./ChatRoom.jsx";
import { MiniMePage } from "./MiniMePage.jsx";

// The two modals stay importable from here as well as from their own files
// (the Brief mounts SportsSettingsModal from ./SportsSettingsModal.jsx).
export { SeatNotesModal } from "./SeatNotesModal.jsx";
export { SportsSettingsModal } from "./SportsSettingsModal.jsx";

/* ── seat identity — one mark, no emoji: a tinted well carrying the seat's
      color dot (the same dot the chat's consulted-chips wear) ─────────────── */
function SeatMark({ color, size = 34 }) {
  return (
    <span style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), background: tint(color, 14), display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
      <Dot tone={color} size={Math.max(8, Math.round(size * 0.27))} />
    </span>
  );
}

/* Context state — keyed off truthiness of seatNotes[key] (empty string = no
   context). Check + text, not color alone. */
function SeatStatus({ has }) {
  return has ? (
    <span className="t-cap" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--green)", fontWeight: 600, flex: "none" }}>
      <IcCheck size={11} /> Context loaded
    </span>
  ) : (
    <span className="t-cap" style={{ color: "var(--faint)", flex: "none" }}>Tap to add context</span>
  );
}

/* One SeatCard for every surface that shows a seat (page grid + desktop rail —
   the three old treatments, unified). The whole card is the tap target. */
function SeatCard({ seat, has, onClick, compact }) {
  if (compact) {
    return (
      <Card pressable pad="sm" onClick={onClick} aria-label={`${seat.name} — edit context`}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <SeatMark color={seat.color} size={30} />
          <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seat.name}</span>
            <SeatStatus has={has} />
          </span>
          <IcChevronRight size={13} style={{ color: "var(--faint)", flex: "none" }} />
        </div>
        <div className="t-cap" style={{ color: "var(--sub)", fontWeight: 400, lineHeight: 1.5, marginTop: 8 }}>{seat.blurb}</div>
      </Card>
    );
  }
  return (
    <Card pressable pad="md" onClick={onClick} aria-label={`${seat.name} — edit context`} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <SeatMark color={seat.color} />
        <SeatStatus has={has} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="t-head">{seat.name}</div>
        <div className="t-foot" style={{ marginTop: 3, lineHeight: 1.55 }}>{seat.blurb}</div>
      </div>
    </Card>
  );
}

/* The full seats page — the mobile "Seats" tab, and the standalone roster
   when the desktop window is too narrow for the split view. */
function BoardSeatsPage({ seatNotes, onEditSeat, onEnterRoom, isMobile }) {
  return (
    <div style={{ width: "100%", maxWidth: 920, margin: "0 auto", padding: isMobile ? "8px 16px 0" : "4px 0 0", display: "flex", flexDirection: "column", gap: isMobile ? 10 : 14 }}>
      {!isMobile && (
        <Card pad="md" style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: "var(--accent-a12)", color: "var(--accent)", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
            <IcSeal size={22} />
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
            <span className="t-head">Chief of Staff</span>
            <span className="t-foot" style={{ lineHeight: 1.5 }}>Your single point of contact. Routes every question to the seats below, synthesizes, and keeps the disagreements visible.</span>
          </span>
          <Button kind="tinted" size="md" onClick={onEnterRoom} style={{ flex: "none" }}>Enter the room</Button>
        </Card>
      )}
      {isMobile && <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.55 }}>Each seat treats its context as ground truth. Tap a seat to update what it knows.</div>}
      <div className="stagger" style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fill, minmax(min(300px, 100%), 1fr))", gap: isMobile ? 10 : 14, alignItems: "stretch" }}>
        {BOARD.map(b => (
          <SeatCard key={b.key} seat={b} has={!!seatNotes[b.key]} onClick={() => onEditSeat(b.key)} />
        ))}
      </div>
    </div>
  );
}

// Compact single-column seat list for the desktop split view — the full
// BoardSeatsPage (banner + card grid) is built for standalone/mobile use.
function BoardSeatsRail({ seatNotes, onEditSeat }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="The Board" />
      {BOARD.map(b => (
        <SeatCard key={b.key} compact seat={b} has={!!seatNotes[b.key]} onClick={() => onEditSeat(b.key)} />
      ))}
    </div>
  );
}

/* ── sub-navigation ─────────────────────────────────────────────────────────── */
// Keys are wired to jump.sub deep links (Summon, Brief) — never rename them.
const BOARDROOM_SUBTABS = [{ key: "chat", label: "Chat" }, { key: "mini", label: "Mini Me" }, { key: "learn", label: "Learn" }, { key: "seats", label: "Seats" }];
const SPLIT_SUBTABS = BOARDROOM_SUBTABS.filter(t => t.key !== "seats"); // seats live in the rail

// The split view needs ~1160px of window for a usable chat column beside the
// 300px seats rail (sidebar 300 + gutters + rail). Below that — iPad portrait,
// narrow desktop windows — the rail folds into a fourth "Seats" tab, the same
// grammar the phone uses, so the roster is never unreachable.
function useSplitLayout() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1160px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1160px)");
    const fn = (e) => setWide(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return wide;
}

export function BoardRoomPage({ messages, thinking, loadingData, input, setInput, onSend, onClearChat, endRef, seatNotes, onEditSeat, settings, updateSetting, session, onWorkerRun, onSkillsChanged, jump, isMobile }) {
  const [sub, setSub] = useState("chat"); // chat IS the room — the board convenes here; Mini Me and Learn are one tap away
  const wide = useSplitLayout();
  const split = !isMobile && wide;
  useEffect(() => {
    if (jump?.page === "boardroom" && jump.sub) setSub(jump.sub);
  }, [jump?.t]); // eslint-disable-line react-hooks/exhaustive-deps
  const skillSpotlight = jump?.page === "boardroom" && jump.skillId ? { id: jump.skillId, t: jump.t } : null;

  const learnPanel = (
    <div style={{ width: "100%", maxWidth: 760, margin: "0 auto", padding: isMobile ? "8px 16px 0" : "4px 0 0" }}>
      <LearnPanel isMobile={isMobile} supabase={supabase} callClaude={callClaude} session={session}
        modelKey={(settings?.mini || {}).model || "haiku"} onSkillsChanged={onSkillsChanged} spotlight={skillSpotlight} />
    </div>
  );

  const panel = (key) => (
    key === "mini" ? (
      <MiniMePage settings={settings} updateSetting={updateSetting} session={session} onWorkerRun={onWorkerRun} onOpenLearn={() => setSub("learn")} isMobile={isMobile} />
    ) : key === "learn" ? (
      learnPanel
    ) : key === "chat" ? (
      <ChatRoom messages={messages} thinking={thinking} loadingData={loadingData} input={input} setInput={setInput} onSend={onSend} onClearChat={onClearChat} endRef={endRef} isMobile={isMobile} />
    ) : (
      <BoardSeatsPage seatNotes={seatNotes} onEditSeat={onEditSeat} onEnterRoom={() => setSub("chat")} isMobile={isMobile} />
    )
  );

  if (split) {
    // sub "seats" falls through to chat here — a mobile- or narrow-set "seats"
    // must never break the split layout, where seats are always on screen.
    const value = sub === "seats" ? "chat" : sub;
    return (
      <div style={{ display: "flex", flex: 1, minHeight: 0, alignItems: "stretch" }}>
        <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: "none", paddingBottom: 16 }}>
            <Segmented options={SPLIT_SUBTABS} value={value} onChange={setSub} style={{ maxWidth: 420 }} />
          </div>
          {panel(value)}
        </div>
        <div style={{ flex: "0 0 320px", marginLeft: 20, paddingLeft: 20, borderLeft: "0.5px solid var(--line)" }}>
          <div style={{ position: "sticky", top: 12 }}>
            <BoardSeatsRail seatNotes={seatNotes} onEditSeat={onEditSeat} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ flex: "none", padding: isMobile ? "2px 16px 12px" : "0 0 14px" }}>
        <Segmented options={BOARDROOM_SUBTABS} value={sub} onChange={setSub} style={isMobile ? undefined : { maxWidth: 520 }} />
      </div>
      {/* key={sub} restarts the fade on tab change — do not lose the key */}
      <div key={sub} className="pagefade" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {panel(sub)}
      </div>
    </div>
  );
}

export default BoardRoomPage;
