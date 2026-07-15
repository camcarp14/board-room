// ─── Boot, entrance, and the theme control ────────────────────────────────────
// The seal survives the redesign — a fine gold ring that draws itself, a small
// gold square landing at its center. Quietest screens in the app.
import { useState } from "react";
import { supabase } from "../lib/supabase.js";
import { Button, Field } from "../ui/kit.jsx";
import { IcSun, IcMoon, IcAutoTheme } from "../ui/icons.jsx";

export function Seal({ size = 92 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 92 92" aria-hidden="true">
      <circle className="seal-ring" cx="46" cy="46" r="37" />
      <rect className="seal-diamond" x="36" y="36" width="20" height="20" rx="2.5" />
    </svg>
  );
}

export function BootScreen() {
  return (
    <div className="boot">
      <Seal size={88} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7 }}>
        <div className="boot-title">Board Room</div>
        <div className="boot-sub">convening</div>
      </div>
    </div>
  );
}

// Cycle auto → day → night → auto. Auto is the house default: the room
// follows the sun (Graphite 19:00–07:00).
const THEME_CYCLE = { auto: "day", day: "night", night: "auto" };
const THEME_LABEL = { auto: "Auto — follows the sun", day: "Porcelain", night: "Graphite" };
export function ThemeToggle({ theme }) {
  const icon = theme.pref === "auto" ? <IcAutoTheme size={19} /> : theme.pref === "day" ? <IcSun size={19} /> : <IcMoon size={19} />;
  return (
    <button className="icon-btn" onClick={() => theme.setPref(THEME_CYCLE[theme.pref])}
      aria-label={`Theme: ${THEME_LABEL[theme.pref]} — tap to change`} title={`Theme: ${THEME_LABEL[theme.pref]}`}>
      {icon}
    </button>
  );
}

export function SetupNotice() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink)", padding: 20 }}>
      <div className="card pad-lg" style={{ maxWidth: 460 }}>
        <div className="t-title2" style={{ marginBottom: 10 }}>Supabase not configured</div>
        <div className="t-body" style={{ color: "var(--sub)", lineHeight: 1.65 }}>
          This build expects two environment variables on the Netlify site:{" "}
          <code className="t-num" style={{ fontSize: 13, color: "var(--accent)" }}>VITE_SUPABASE_URL</code> and{" "}
          <code className="t-num" style={{ fontSize: 13, color: "var(--accent)" }}>VITE_SUPABASE_ANON_KEY</code>.
          <br /><br />
          Add them (Site configuration → Environment variables), trigger a redeploy, and this screen becomes a login.
        </div>
      </div>
    </div>
  );
}

export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("password");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(false);

  const signIn = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setErr(error.message);
    setBusy(false);
  };
  const sendMagic = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } });
    if (error) setErr(error.message); else setSent(true);
    setBusy(false);
  };
  const disabled = busy || !email || (mode === "password" && !password);

  return (
    <div className="entrance" style={{ color: "var(--ink)" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <Seal size={80} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <span className="boot-title">Board Room</span>
          <span className="boot-sub">one mind · any device</span>
        </div>
      </div>
      <div className="entrance-card">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" type="email" autoComplete="email" />
          {mode === "password" && (
            <Field value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === "Enter") signIn(); }}
              placeholder="Password" type="password" autoComplete="current-password" />
          )}
          {err && <div className="t-foot" style={{ color: "var(--red)" }}>{err}</div>}
          {sent && <div className="t-foot" style={{ color: "var(--green)" }}>Login link sent — check your email.</div>}
          <Button kind="primary" size="lg" full disabled={disabled} onClick={mode === "password" ? signIn : sendMagic}>
            {busy ? (mode === "password" ? "Signing in…" : "Sending…") : (mode === "password" ? "Enter the room" : "Email me a login link")}
          </Button>
        </div>
        <button onClick={() => { setMode(mode === "password" ? "magic" : "password"); setErr(null); setSent(false); }}
          style={{ display: "block", width: "100%", background: "none", border: "none", fontSize: 12.5, color: "var(--sub)", textAlign: "center", marginTop: 16, cursor: "pointer", padding: 6 }}>
          {mode === "password" ? "Use a magic link instead" : "Use a password instead"}
        </button>
      </div>
    </div>
  );
}
