// ─── The tablet / desktop shell ───────────────────────────────────────────────
// iPadOS grammar: a canvas-colored rail, a content column with its own header,
// and a centered max-width content well.
//
// The rail was 300px with two section headers over four destinations, which left
// a column of mostly empty canvas beside every page. It's 236px now, the section
// headers are gone (see nav.js), and the rows are tighter — the content well
// gets the difference back.
import { NAV, HEADERS } from "./nav.js";
import { TopStatus } from "./TopStatus.jsx";
import { NAV_ICONS, IcSearch, IcSettings } from "../ui/icons.jsx";
import { NumTween, Sparkline } from "../ui/primitives.jsx";
import { Delta } from "../ui/kit.jsx";

export function SidebarShell({ page, onNavigate, onSummon, onOpenSettings, btc, session, totalSpend, callCount, now, dataStamp, refreshing, onRefresh, children }) {
  const head = HEADERS[page];

  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "236px minmax(0,1fr)", color: "var(--ink)" }}>
      <aside className="sidebar">
        <div className="side-brand">
          <span style={{ width: 13, height: 13, transform: "rotate(45deg)", borderRadius: 3, background: "var(--accent)", flex: "none" }} />
          <span className="side-brand-name">Board Room</span>
        </div>

        {/* One flat list, ordered — Brief · Personal · Train · Assets. */}
        <nav className="side-nav" aria-label="Primary">
          {NAV.map(n => {
            const active = page === n.key;
            const Icon = active ? NAV_ICONS[n.key].fill : NAV_ICONS[n.key].line;
            return (
              <button key={n.key} className={`side-item${active ? " active" : ""}`} onClick={() => onNavigate(n.key)} aria-current={active ? "page" : undefined}>
                <span className="side-ic"><Icon size={20} /></span>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="side-foot">
          {/* live bitcoin — the one number that follows you around the firm */}
          <div className="card pad-sm" style={{ borderRadius: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 5 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <span style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--btc)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9.5, fontWeight: 700, color: "#1A0F00", flex: "none" }}>₿</span>
                <span className="t-num" style={{ fontSize: 13.5, color: "var(--ink)" }}>
                  {btc.loading ? "…" : btc.error ? "—" : <NumTween v={btc.price} f={n => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 })} />}
                </span>
              </div>
              {!btc.loading && !btc.error && <Delta pct={btc.changePct || 0} />}
            </div>
            {btc.error || (!btc.loading && !(btc.points || []).length) ? (
              <div className="t-cap" style={{ color: "var(--faint)", padding: "2px 0 1px" }}>Live price unavailable</div>
            ) : (
              <Sparkline points={btc.points} color={(btc.changePct || 0) >= 0 ? "var(--green)" : "var(--red)"} height={24} />
            )}
          </div>

          {/* Theme, sign-out, and the calendar feed all live in the Settings
              sheet now — one place on both platforms, and the only place the
              calendar_url field has ever existed. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, borderTop: "0.5px solid var(--line)", paddingTop: 8 }}>
            <span className="t-cap" style={{ color: "var(--faint)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session?.user?.email}</span>
            <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings" title="Settings" style={{ flex: "none", width: 34, height: 34 }}>
              <IcSettings size={18} />
            </button>
          </div>
        </div>
      </aside>

      <div style={{ display: "flex", flexDirection: "column", height: "100vh", minWidth: 0 }}>
        <div className="content-head">
          <div className="head-title">
            <h1 className="t-title1" style={{ margin: 0 }}>{head.title}</h1>
            <div className="t-foot" style={{ marginTop: 2 }}>{head.sub(new Date(now))}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "none", paddingBottom: 2 }}>
            <button onClick={onSummon} aria-label="Summon — search everything"
              style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 36, padding: "0 12px", background: "var(--ink-a05)", border: "none", borderRadius: 10, color: "var(--sub)", fontSize: 13, cursor: "pointer" }}>
              <IcSearch size={15} /> Summon <kbd>⌘K</kbd>
            </button>
            {/* Honest label: this reads the `obs` localStorage ring, which is
                capped at 300 entries and persists across launches — so it's
                neither "this session" nor complete. The durable cross-device
                numbers are on Systems → Usage. */}
            <span className="t-cap head-spend" style={{ color: "var(--faint)" }} title="Anthropic spend across the last 300 calls logged on this device. Systems → Usage has the durable, cross-device totals.">
              ${totalSpend.toFixed(3)} · last {callCount} calls
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
