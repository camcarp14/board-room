// ─── Error boundary ───────────────────────────────────────────────────────────
// A single throwing component must never blank the whole app. Two uses:
//   • root — last line of defense; a full-screen recover card.
//   • per-page — a crashing panel shows a card, the shell + nav keep working,
//     so the other tabs are still reachable.
// The message is shown on screen ON PURPOSE: on a phone there's no console, so
// surfacing the error text turns a black screen into something screenshottable.
import { Component } from "react";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Best-effort breadcrumb; never throws itself.
    try {
      console.error("[boundary]", this.props.label || "root", error, info?.componentStack);
      const log = JSON.parse(localStorage.getItem("br_crashes") || "[]");
      log.unshift({ at: new Date().toISOString(), where: this.props.label || "root", msg: String(error?.message || error), stack: (info?.componentStack || "").slice(0, 800) });
      localStorage.setItem("br_crashes", JSON.stringify(log.slice(0, 20)));
    } catch {}
  }
  reset = () => this.setState({ error: null });
  render() {
    if (!this.state.error) return this.props.children;
    const msg = String(this.state.error?.message || this.state.error);
    const full = !!this.props.full;
    const card = (
      <div style={{ background: "var(--surface)", borderRadius: 18, boxShadow: "var(--shadow-card)", padding: 20, maxWidth: 440, width: "100%", color: "var(--ink)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--red)", flex: "none" }} />
          <span className="t-head">{full ? "Something broke" : `The ${this.props.label || "panel"} hit an error`}</span>
        </div>
        <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.5, marginBottom: 12 }}>
          {full
            ? "The app caught an error before it could show a blank screen. Reload usually clears it — if not, screenshot the detail below and send it over."
            : "The rest of the app still works — the other tabs are fine. Screenshot this and send it over so it can be fixed."}
        </div>
        <div className="t-num" style={{ fontSize: 11.5, color: "var(--red)", background: "var(--surface-2)", borderRadius: 10, padding: "10px 12px", lineHeight: 1.5, wordBreak: "break-word", marginBottom: 14, maxHeight: 160, overflow: "auto" }}>
          {msg}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn quiet md" style={{ flex: 1 }} onClick={this.reset}>Try again</button>
          <button className="btn primary md" style={{ flex: 1 }} onClick={() => window.location.reload()}>Reload app</button>
        </div>
      </div>
    );
    if (full) {
      return (
        <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "var(--bg)" }}>
          {card}
        </div>
      );
    }
    return <div style={{ padding: "16px" }}>{card}</div>;
  }
}
