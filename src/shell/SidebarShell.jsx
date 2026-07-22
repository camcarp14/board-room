// ─── The tablet / desktop shell ───────────────────────────────────────────────
// iPadOS grammar: a canvas-colored sidebar with grouped navigation, a content
// column with its own header, and a centered max-width content well.
import { NAV, HEADERS } from "./nav.js";
import { TopStatus } from "./TopStatus.jsx";
import { ThemeToggle } from "./Boot.jsx";
import { NAV_ICONS, IcSearch } from "../ui/icons.jsx";
import { NumTween, Sparkline } from "../ui/primitives.jsx";
import { Button, Delta } from "../ui/kit.jsx";
import { supabase } from "../lib/supabase.js";

const GROUPS = [...new Set(NAV.map(n => n.group))];
// The binding is ⌘K on Apple platforms, Ctrl+K everywhere else — say the one
// that actually works on this machine.
const IS_APPLE = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || "");

export function SidebarShell({ page, theme, onNavigate, onSummon, btc, session, totalSpend, callCount, now, dataStamp, refreshing, onRefresh, children }) {
  const head = HEADERS[page];

  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "300px minmax(0,1fr)", color: "var(--ink)" }}>
      <aside className="sidebar">
        <div className="side-brand">
          <span style={{ width: 14, height: 14, transform: "rotate(45deg)", borderRadius: 3, background: "var(--accent)", flex: "none" }} />
          <span className="side-brand-name">Board Room</span>
        </div>

        <nav className="side-nav" style={{ display: "flex", flexDirection: "column", gap: 18 }} aria-label="Primary">
          {GROUPS.map(g => (
            <div className="side-group" key={g}>
              <div className="side-group-label t-label">{g}</div>
              {NAV.filter(n => n.group === g).map(n => {
                const active = page === n.key;
                const Icon = active ? NAV_ICONS[n.key].fill : NAV_ICONS[n.key].line;
                return (
                  <button key={n.key} className={`side-item${active ? " active" : ""}`} onClick={() => onNavigate(n.key)} aria-current={active ? "page" : undefined}>
                    <span className="side-ic"><Icon size={21} /></span>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="side-foot">
          {/* live bitcoin — the one number that follows you around the firm */}
          <div className="card pad-md" style={{ borderRadius: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--btc)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontWeight: 700, color: "#1A0F00", flex: "none" }}>₿</span>
                <span className="t-num" style={{ fontSize: 14, color: "var(--ink)" }}>
                  {btc.loading ? "…" : btc.error ? "—" : <NumTween v={btc.price} f={n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 })} />}
                </span>
              </div>
              {!btc.loading && !btc.error && <Delta pct={btc.changePct || 0} />}
            </div>
            {btc.error || (!btc.loading && !(btc.points || []).length) ? (
              <div className="t-cap" style={{ color: "var(--faint)", padding: "4px 0 2px" }}>Live price unavailable</div>
            ) : (
              <Sparkline points={btc.points} color={(btc.changePct || 0) >= 0 ? "var(--green)" : "var(--red)"} height={30} />
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderTop: "0.5px solid var(--line)", paddingTop: 12 }}>
            <span className="t-cap" style={{ color: "var(--faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session?.user?.email}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
              <ThemeToggle theme={theme} />
              <Button kind="plain" size="sm" style={{ color: "var(--sub)", fontWeight: 500 }} onClick={() => supabase.auth.signOut()}>Sign out</Button>
            </div>
          </div>
        </div>
      </aside>

      <div className="content-col" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="content-head">
          <div className="head-title">
            <h1 className="t-title1" style={{ margin: 0 }}>{head.title}</h1>
            <div className="t-foot" style={{ marginTop: 2 }}>{head.sub(new Date(now))}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "none", paddingBottom: 2 }}>
            <button onClick={onSummon} aria-label="Summon — search everything"
              style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 36, padding: "0 12px", background: "var(--ink-a05)", border: "none", borderRadius: 10, color: "var(--sub)", fontSize: 13, cursor: "pointer" }}>
              <IcSearch size={15} /> Summon <kbd>{IS_APPLE ? "⌘K" : "Ctrl K"}</kbd>
            </button>
            <span className="t-cap head-spend" style={{ color: "var(--faint)" }} title="Model spend this session">
              ${totalSpend.toFixed(3)} · {callCount} calls
            </span>
            <TopStatus now={now} dataStamp={dataStamp} refreshing={refreshing} onRefresh={onRefresh} />
          </div>
        </div>

        <div id="page-scroll" className="content-scroll">
          <div key={page} className="pagefade content-max" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
