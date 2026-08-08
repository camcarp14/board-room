// ─── Capture sheet — the watch/Siri hookup for notes ─────────────────────────
// The mirror of Train's WatchSheet, for words instead of workouts. Same honesty
// rule: the only status shown is what actually arrived. There is no "connected"
// state to fake — the endpoint has no session, only a token, and the proof it
// works is a note in the list.
//
// The token lives in app_settings.notes_capture.captureToken, which is what
// netlify/functions/note-capture.js looks a request up by.
import { useState } from "react";
import { Sheet, Button, Dot } from "../../ui/kit.jsx";

const uuid = () => crypto.randomUUID();

// The three shortcuts worth building, in the order they earn their place on a
// watch face. Each is the exact JSON body to paste into "Get Contents of URL".
const RECIPES = [
  {
    key: "jot",
    name: "Board Note",
    blurb: "Dictate one thought → one note. The default, and the one to put on the watch face.",
    json: `{ "token": "<your token>",\n  "text": <Dictated Text> }`,
  },
  {
    key: "list",
    name: "Board List",
    blurb: "Dictate into ONE note per day instead of scattering fragments. Today's note is created on the first tap and a fresh one starts tomorrow — {date} does that, not you.",
    json: `{ "token": "<your token>",\n  "text": <Dictated Text>,\n  "into": "Captured — {date}" }`,
  },
  {
    key: "sealed",
    name: "Board Idea",
    blurb: "The same jot, pre-sealed so it filters out of the noise later. Seals: brass, green, blue, red.",
    json: `{ "token": "<your token>",\n  "text": <Dictated Text>,\n  "seal": "brass",\n  "title": "Idea" }`,
  },
];

export default function CaptureSheet({ token, onToken, onClose }) {
  const [copied, setCopied] = useState(null);
  const [recipe, setRecipe] = useState("jot");
  const endpoint = `${window.location.origin}/.netlify/functions/note-capture`;
  const copy = (label, text) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(label); setTimeout(() => setCopied(null), 1800); });
  };
  const active = RECIPES.find(r => r.key === recipe) || RECIPES[0];
  const payload = active.json.replace("<your token>", token || "<your token>");

  return (
    <Sheet onClose={onClose} title="Watch capture · dictate a note" z={320}>
      <div className="t-call" style={{ color: "var(--sub)", lineHeight: 1.6 }}>
        Raise your wrist → tap a complication → say the thing → it's in Notes before you've put your
        arm down. It's an iPhone Shortcut that also runs on the watch; watchOS can't reach this app
        directly, but it can reach this endpoint, which writes to the same table the Notes tab reads.
      </div>

      <div className="t-label" style={{ margin: "16px 0 8px" }}>Your capture token</div>
      {token ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <code className="t-num" style={{ flex: 1, minWidth: 0, background: "var(--surface-2)", borderRadius: 10, padding: "10px 12px", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{token}</code>
          <Button kind="quiet" size="md" onClick={() => copy("token", token)}>{copied === "token" ? "Copied" : "Copy"}</Button>
        </div>
      ) : (
        <Button kind="primary" size="md" onClick={() => onToken(uuid())}>Generate token</Button>
      )}
      {token && (
        <div className="t-foot" style={{ color: "var(--faint)", marginTop: 6 }}>
          The token is the only key to this door — treat it like a password.{" "}
          <button className="sec-link" style={{ font: "inherit" }} onClick={() => onToken(uuid())}>Regenerate</button> to revoke the old one.
        </div>
      )}

      <div className="t-label" style={{ margin: "16px 0 8px" }}>One-time setup (iPhone → Shortcuts)</div>
      <ol className="t-call" style={{ color: "var(--sub)", lineHeight: 1.7, margin: 0, paddingLeft: 20 }}>
        <li>Shortcuts → <b>+</b> → name it <b>{active.name}</b>. Name it something you'd happily say
          out loud — the name IS the Siri phrase.</li>
        <li>Add action <b>Dictate Text</b>. Set <i>Stop Listening</i> → <b>After Pause</b>.</li>
        <li>Add action <b>Get Contents of URL</b>:&nbsp;
          <code className="t-num" style={{ fontSize: 11.5, background: "var(--surface-2)", borderRadius: 6, padding: "2px 6px", wordBreak: "break-all" }}>{endpoint}</code>
          <Button kind="quiet" size="md" onClick={() => copy("url", endpoint)} style={{ marginLeft: 6, padding: "0 10px", height: 30, minHeight: 30 }}>{copied === "url" ? "Copied" : "Copy"}</Button>
        </li>
        <li>Method <b>POST</b> · Request Body <b>JSON</b>. <code className="t-num" style={{ fontSize: 11 }}>&lt;Dictated Text&gt;</code> is
          the magic variable from step 2 — pick it, don't type it:
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "10px 0 8px" }}>
            {RECIPES.map(r => (
              <button key={r.key} className={`pill${recipe === r.key ? " active" : ""}`} onClick={() => setRecipe(r.key)}>{r.name}</button>
            ))}
          </div>
          <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.5, marginBottom: 8 }}>{active.blurb}</div>
          <pre className="t-num" style={{ background: "var(--surface-2)", borderRadius: 10, padding: "10px 12px", fontSize: 11, lineHeight: 1.55, overflowX: "auto", margin: 0 }}>
{payload}</pre>
          <Button kind="quiet" size="md" onClick={() => copy("json", payload)} style={{ marginTop: 8 }}>
            {copied === "json" ? "Copied" : "Copy JSON"}
          </Button>
        </li>
        <li>Shortcut details (ⓘ) → turn <b>Show on Apple Watch</b> ON, and <b>Pin on Apple Watch</b> ON
          so it sits at the top of the watch's Shortcuts list.</li>
        <li>Run it once on the phone. A note appears here — that's the whole test.</li>
      </ol>

      <div className="t-label" style={{ margin: "18px 0 8px" }}>Getting it to one tap on the wrist</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {[
          ["Watch face complication", "Watch app → Face Gallery → edit a face → set a corner complication to Shortcuts → pick this shortcut. This is the one-tap path."],
          ["Action Button (Ultra)", "Watch → Settings → Action Button → Shortcut → pick it. Physical button, no screen needed."],
          ["Double Tap (Series 9+)", "Set the shortcut as a complication on the Smart Stack widget, then pinch to run without touching the screen."],
          ["Siri", "\"Hey Siri, Board Note\" — the shortcut's name is the phrase, which is why step 1 says to name it something sayable."],
        ].map(([label, how]) => (
          <div key={label} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
            {/* Dot takes no style prop — the spacer span carries the offset */}
            <span style={{ marginTop: 7, flex: "none", display: "inline-flex" }}><Dot tone="var(--accent)" size={7} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="t-call" style={{ fontWeight: 600 }}>{label}</div>
              <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.5 }}>{how}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="t-foot" style={{ color: "var(--faint)", marginTop: 14, lineHeight: 1.55 }}>
        Re-sends inside 90 seconds are answered with the original note, not written twice — a watch
        loses signal mid-request often enough that Shortcuts retrying it is normal. Dictation happens
        on Apple's side; this endpoint only ever sees the finished text. Full walkthrough, plus the
        calendar and grocery variants, in <b>WATCH.md</b>.
      </div>
    </Sheet>
  );
}
