// ─── The Room — chat with the Chief of Staff ─────────────────────────────────
// A real page now, same on both platforms — replaces the old mobile-only
// floating-pill-that-expands-to-a-sheet mechanic. One layout to learn.
// SESSION anatomy: the thread flows in the page scroll (never a nested scroll
// region); the composer is a raised bar stuck to the bottom of the scroller,
// which on the phone means it rides above the in-flow tab bar and — because
// the shell pins itself to the visual viewport and hides the dock — above the
// keyboard when it opens.

import { Button, Dot } from "../../ui/kit.jsx";
import { IcSend } from "../../ui/icons.jsx";

const SUGGESTIONS = ["What should I prioritize this week?", "Is ZTS or Clarify closer to recurring revenue?", "Pressure-test my BTC leverage right now"];

function ChatThread({ messages, thinking, loadingData, setInput, endRef, isMobile }) {
  return (
    <>
      {loadingData && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "6px 0" }}>
          <div className="sk" style={{ alignSelf: "flex-end", width: "52%", height: 38, borderRadius: "16px 16px 5px 16px" }} />
          <div className="sk" style={{ alignSelf: "flex-start", width: "68%", height: 58, borderRadius: "16px 16px 16px 5px" }} />
          <div className="sk" style={{ alignSelf: "flex-end", width: "40%", height: 34, borderRadius: "16px 16px 5px 16px" }} />
        </div>
      )}

      {!loadingData && messages.length === 0 && !thinking && (
        <div style={{ margin: "auto", width: "100%", maxWidth: 460, textAlign: "center", padding: "28px 0 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div className="t-title1">The room is yours.</div>
          <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.65 }}>
            Ask the Chief of Staff anything. It routes each question to the seats that matter and brings back one synthesized answer — with the disagreements left in.
          </div>
          <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 8, width: "100%" }}>
            {SUGGESTIONS.map((s, i) => (
              <Button key={i} kind="quiet" size="md" full={isMobile} onClick={() => setInput(s)}
                style={{ height: "auto", minHeight: 44, paddingTop: 9, paddingBottom: 9, fontWeight: 500, color: "var(--sub)", whiteSpace: "normal", lineHeight: 1.4, justifyContent: isMobile ? "flex-start" : "center", textAlign: "left" }}>
                {s}
              </Button>
            ))}
          </div>
        </div>
      )}

      {messages.map((m, i) => {
        const user = m.role === "user";
        return (
          <div key={i} style={{ alignSelf: user ? "flex-end" : "flex-start", maxWidth: isMobile ? "88%" : "76%", animation: "fadein var(--dur-2) ease both", display: "flex", flexDirection: "column", gap: 7, alignItems: user ? "flex-end" : "flex-start" }}>
            {/* consulted-seat chips — dot in the seat's color, quiet capsule, take on hover */}
            {!user && (m.consulted || []).length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {m.consulted.map((c, j) => (
                  <span key={j} title={c.take}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--ink-a05)", borderRadius: 999, padding: "4px 10px", cursor: "help" }}>
                    <Dot tone={c.color} size={6} />
                    <span className="t-cap" style={{ color: "var(--sub)", fontWeight: 600 }}>{c.name}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="t-body" style={{
              padding: isMobile ? "11px 14px" : "12px 16px",
              borderRadius: user ? "16px 16px 5px 16px" : "16px 16px 16px 5px",
              background: user ? "var(--accent-a10)" : "var(--surface)",
              boxShadow: user ? "none" : "var(--shadow-card)",
              lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "break-word", minWidth: 0,
            }}>{m.content}</div>
            {m.source === "discord" && <span className="t-cap t-num" style={{ color: "var(--faint)" }}>via Discord</span>}
          </div>
        );
      })}

      {thinking && (
        <div style={{ alignSelf: "flex-start", padding: "13px 16px", borderRadius: "16px 16px 16px 5px", background: "var(--surface)", boxShadow: "var(--shadow-card)" }}>
          <span className="convene" aria-label="Convening the room">
            <span className="cd" /><span className="cd" /><span className="cd" />
            <span className="t-foot" style={{ marginLeft: 2 }}>Convening the room…</span>
          </span>
        </div>
      )}
      <div ref={endRef} />
    </>
  );
}

function Composer({ input, setInput, onSend, thinking, isMobile }) {
  const canSend = !!input.trim() && !thinking;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8, background: "var(--surface)", borderRadius: 16, boxShadow: "var(--shadow-float)", padding: "5px 5px 5px 16px" }}>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
        placeholder={isMobile ? "Ask the Chief…" : "Ask the Chief of Staff…"}
        rows={1}
        aria-label="Message the Chief of Staff"
        style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", color: "var(--ink)", fontSize: 15, fontFamily: "var(--font-body)", resize: "none", padding: "12px 0", lineHeight: 1.45, outline: "none", minHeight: 44 }}
      />
      <button onClick={onSend} disabled={!canSend} aria-label="Send" title="Send"
        style={{ width: 44, height: 44, flex: "none", borderRadius: "50%", border: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: canSend ? "pointer" : "default", background: canSend ? "var(--accent)" : "var(--ink-a06)", color: canSend ? "var(--on-accent)" : "var(--faint)" }}>
        <IcSend size={20} />
      </button>
    </div>
  );
}

export function ChatRoom({ messages, thinking, loadingData, input, setInput, onSend, onClearChat, endRef, isMobile }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ flex: 1, width: "100%", maxWidth: 780, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14, padding: isMobile ? "8px 16px 6px" : "2px 0 6px" }}>
        {messages.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button kind="plain" size="sm" onClick={onClearChat} style={{ color: "var(--sub)", minHeight: 44 }}>Clear chat</Button>
          </div>
        )}
        <ChatThread messages={messages} thinking={thinking} loadingData={loadingData} setInput={setInput} endRef={endRef} isMobile={isMobile} />
      </div>

      {/* Raised composer bar — sticky to the bottom of whichever scroller hosts
          the page. The soft canvas fade underneath keeps scrolled-past text from
          colliding with the bar's shadow. Safe areas are handled by the shell:
          the in-flow dock sits below this scroller (and hides for the keyboard),
          so bottom:0 here is always the true usable edge. */}
      <div style={{ position: "sticky", bottom: 0, zIndex: 5, padding: isMobile ? "8px 12px 10px" : "10px 0 16px", background: "linear-gradient(to top, var(--bg) 62%, transparent)" }}>
        <div style={{ width: "100%", maxWidth: 780, margin: "0 auto", display: "flex", flexDirection: "column", gap: 8 }}>
          <Composer input={input} setInput={setInput} onSend={onSend} thinking={thinking} isMobile={isMobile} />
          {!isMobile && (
            <div className="t-cap" style={{ color: "var(--faint)", textAlign: "center", fontWeight: 400 }}>
              Quick questions stay Chief-only · cross-cutting ones convene seats in parallel
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
