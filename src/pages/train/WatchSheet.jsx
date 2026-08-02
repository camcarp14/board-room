// ─── Watch sheet — the honest Apple Watch hookup ─────────────────────────────
// A web app cannot touch HealthKit; the working path is an iOS Shortcuts
// automation ("When I finish a workout" → POST here). The only status shown is
// how many workouts actually arrived — no fake "connected" state.
//
// Lives in its own file because two screens open it: Train → Apple Watch, and
// Train → Rides, where an empty tab's one job is to get the data flowing.
import { useState } from "react";
import { Sheet, Button } from "../../ui/kit.jsx";

const uuid = () => crypto.randomUUID();

// The ride-shaped payload. Only type, start and duration are required; every
// other line is a metric the Rides tab will show if it arrives and quietly
// omit if it doesn't.
const PAYLOAD = `{ "token": "<your token>",
  "workouts": [{
    "type":         <Workout Type>,
    "start":        <Start Date (ISO 8601)>,
    "durationMin":  <Duration (minutes)>,
    "calories":     <Active Energy>,
    "avgHeartRate": <Average Heart Rate>,
    "maxHeartRate": <Maximum Heart Rate>,
    "distanceMi":   <Distance (miles)>,
    "elevationFt":  <Elevation Ascended (feet)>,
    "avgWatts":     <Average Power>,
    "avgCadence":   <Average Cadence>,
    "indoor":       <Is Indoor>
  }] }`;

export default function WatchSheet({ ws, setWs, watchCount, rideCount = 0, onClose }) {
  const [copied, setCopied] = useState(null);
  const endpoint = `${window.location.origin}/.netlify/functions/workout-import`;
  const token = ws.importToken || "";
  const copy = (label, text) => { navigator.clipboard?.writeText(text).then(() => { setCopied(label); setTimeout(() => setCopied(null), 1800); }); };
  const genToken = () => setWs({ importToken: uuid() });
  return (
    <Sheet onClose={onClose} title="Apple Watch · auto-import" z={320}>
      <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
        Finish a workout on the watch → an iPhone Shortcuts automation posts it here → it lands in
        History with calories and average heart rate, and rides land in <b>Rides</b> with distance,
        climbing, power and cadence. Re-sends are skipped, never duplicated.
        {watchCount > 0
          ? ` ${watchCount} imported so far${rideCount > 0 ? `, ${rideCount} of them rides` : ""}.`
          : " Nothing has arrived yet."}
      </div>

      <div className="t-label" style={{ margin: "16px 0 8px" }}>Your import token</div>
      {token ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <code className="t-num" style={{ flex: 1, minWidth: 0, background: "var(--surface-2)", borderRadius: 10, padding: "10px 12px", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{token}</code>
          <Button kind="quiet" size="md" onClick={() => copy("token", token)}>{copied === "token" ? "Copied" : "Copy"}</Button>
        </div>
      ) : (
        <Button kind="primary" size="md" onClick={genToken}>Generate token</Button>
      )}
      {token && (
        <div className="t-foot" style={{ color: "var(--faint)", marginTop: 6 }}>
          The token is the only key to this door — treat it like a password.{" "}
          <button className="sec-link" style={{ font: "inherit" }} onClick={genToken}>Regenerate</button> to revoke the old one.
        </div>
      )}

      <div className="t-label" style={{ margin: "16px 0 8px" }}>One-time setup (iPhone)</div>
      <ol className="t-call" style={{ color: "var(--sub)", lineHeight: 1.7, margin: 0, paddingLeft: 20 }}>
        <li>Shortcuts → Automation → <b>+</b> → <b>When I finish a workout</b> → Run Immediately.</li>
        <li>Add action <b>Get Contents of URL</b>:&nbsp;
          <code className="t-num" style={{ fontSize: 11.5, background: "var(--surface-2)", borderRadius: 6, padding: "2px 6px", wordBreak: "break-all" }}>{endpoint}</code>
          <Button kind="quiet" size="md" onClick={() => copy("url", endpoint)} style={{ marginLeft: 6, padding: "0 10px", height: 30, minHeight: 30 }}>{copied === "url" ? "Copied" : "Copy"}</Button>
        </li>
        <li>Method <b>POST</b> · Request Body <b>JSON</b> with fields from the automation's workout:
          <pre className="t-num" style={{ background: "var(--surface-2)", borderRadius: 10, padding: "10px 12px", fontSize: 11, lineHeight: 1.55, overflowX: "auto", margin: "8px 0 0" }}>
{PAYLOAD}</pre>
          Only type, start and duration are required — drop any line the automation doesn't offer.
          Kilometres and metres work too (<code className="t-num" style={{ fontSize: 11 }}>distanceKm</code>,{" "}
          <code className="t-num" style={{ fontSize: 11 }}>elevationM</code>). The <b>Health Auto Export</b> app's
          REST automation pointed at the same URL works as well.
        </li>
      </ol>
      <div className="t-foot" style={{ color: "var(--faint)", marginTop: 12, lineHeight: 1.55 }}>
        Apple Health is the source of truth on the phone; this copies finished workouts out of it.
        Nothing is read back, and a workout you delete in Health stays here until you delete it here.
      </div>
    </Sheet>
  );
}
