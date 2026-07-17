// ─── Upstream — the question engine + NOSTRADAMUS ledger ─────────────────────
// UPSTREAM is a LOCAL app: an 8-minute Fable pipeline with a SQLite prediction
// ledger, living in Command Center\upstream and serving on localhost:8790 —
// it can't run on Netlify. This tab embeds it when it's reachable (browsers
// exempt localhost from mixed-content blocking, so the https site may iframe
// it) and shows honest start instructions when it isn't — e.g. when Board
// Room is opened from a phone. Never a dead-end: retry + open-directly.
import { useState, useEffect, useCallback } from "react";
import { Card, Button, Dot } from "../../ui/kit.jsx";
import { IcExternal, IcRefresh } from "../../ui/icons.jsx";

const UPSTREAM_URL = "http://localhost:8790";

export function UpstreamPage({ isMobile }) {
  const [status, setStatus] = useState("checking"); // checking | up | down
  const [health, setHealth] = useState(null);

  const check = useCallback(async () => {
    setStatus("checking");
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3500);
      const res = await fetch(`${UPSTREAM_URL}/api/health`, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(String(res.status));
      setHealth(await res.json());
      setStatus("up");
    } catch {
      setHealth(null);
      setStatus("down");
    }
  }, []);
  useEffect(() => { check(); }, [check]);

  const pad = isMobile ? "0 14px 14px" : "0 4px 8px";

  if (status === "up") {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: pad, gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <Dot tone={health?.ok ? "var(--green)" : "var(--amber)"} pulse={!health?.ok} />
          <span className="t-caption" style={{ color: "var(--faint)" }}>
            engine {health?.ok ? "ready" : health?.hasKey === false ? "up — no API key set" : "degraded"} · localhost:8790
          </span>
          <span style={{ flex: 1 }} />
          <Button kind="quiet" size="md" onClick={() => window.open(UPSTREAM_URL, "_blank", "noopener")}>
            <IcExternal size={13} /> Open full window
          </Button>
        </div>
        <iframe
          src={UPSTREAM_URL}
          title="UPSTREAM — question engine"
          style={{ width: "100%", flex: 1, minHeight: isMobile ? "70vh" : 640, border: "1px solid var(--line)", borderRadius: 16, background: "#0d0e13" }}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: pad }}>
      <Card pad="lg" style={{ maxWidth: 620 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
          <Dot tone={status === "checking" ? "var(--amber)" : "var(--red)"} pulse={status === "checking"} />
          <span className="t-title3">{status === "checking" ? "Looking for the engine…" : "Upstream isn't running here"}</span>
        </div>
        {status === "down" && (
          <>
            <p className="t-body" style={{ color: "var(--sub)", lineHeight: 1.65, margin: "0 0 14px" }}>
              UPSTREAM runs locally on the desk machine — 8-minute Fable pipelines and the
              NOSTRADAMUS ledger don't live on Netlify. Start it there and this tab becomes
              the app:
            </p>
            <pre style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12, border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", overflowX: "auto", margin: "0 0 14px", color: "var(--ink)", background: "var(--well, transparent)" }}>
{`cd "C:\\Users\\camca\\Desktop\\Command Center\\upstream"
npm start`}
            </pre>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button kind="primary" size="md" onClick={check}><IcRefresh size={13} /> Check again</Button>
              <Button kind="quiet" size="md" onClick={() => window.open(UPSTREAM_URL, "_blank", "noopener")}>
                <IcExternal size={13} /> Try opening it directly
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
