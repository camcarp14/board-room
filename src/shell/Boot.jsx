// ─── Boot, entrance, and the theme control ────────────────────────────────────
// The seal survives the redesign — a fine gold ring that draws itself, a small
// gold square landing at its center. Quietest screens in the app.
import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";
import { isNetworkAuthFailure } from "../lib/authErrors.js";
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

// ─── the one screen with no way out, given one ───────────────────────────────
// This screen used to be a seal, a wordmark and the word "convening", forever.
// Every other surface in the building owes four states (DESIGN.md §1.7) and draws
// them; boot had exactly one, on the theory that it is only ever on screen for a
// few milliseconds. That held right up until the auth check behind it could hang:
// supabase's getSession() awaits a token refresh that retries with backoff for up
// to half a minute, so a cold LTE handshake left "convening" sitting there with no
// error state, no stale state, no explanation and nothing to tap. The most
// frightening thing the app can do is nothing, in silence, on launch.
//
// So it gets a deadline. App.jsx normally beats this timer to it — it knows the
// moment its own 2.5s auth race is lost and says so through `stalled` — and this
// one is the backstop: it covers a boot mounted by anything that doesn't pass the
// signal, and the general case of waiting on something nobody thought to time.
// Six seconds because a launch that has taken six seconds is not a slow launch,
// it is a launch that has gone wrong, and no honest reading of it needs a
// stopwatch to agree.
const STALL_AFTER_MS = 6000;

export function BootScreen({ stalled = false, onRetry }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), STALL_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  const stuck = stalled || late;
  return (
    <div className="boot">
      <Seal size={88} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7 }}>
        <div className="boot-title">Board Room</div>
        {/* Announced rather than merely repainted: the word in this slot is the
            only status the screen carries, and a launch that quietly stops
            progressing is precisely the moment a screen reader is owed an update.
            polite, so it waits for a pause instead of interrupting. */}
        <div className="boot-sub" aria-live="polite">{stuck ? "no answer yet" : "convening"}</div>
      </div>
      {stuck && (
        // WHAT THIS MAY AND MAY NOT SAY. It may not say "signed out" — nobody has
        // been — and it may not say the network is down, because at the 2.5s mark
        // all that is known is that nothing has come back yet. What is true in
        // both cases is that the session cannot be confirmed until something
        // answers, and that no credentials are needed to fix it. Saying only that
        // keeps Retry from reading as a login prompt, which would be the same lie
        // the fall-through to LoginScreen used to tell (see App.jsx).
        //
        // Entrance is the house's own: opacity plus a 4px rise, borrowed from the
        // `fadein` keyframes rather than a new one, and the global
        // prefers-reduced-motion block collapses its duration like every other
        // animation in the app.
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 14,
          animation: "fadein var(--dur-2) var(--ease-out) both",
        }}>
          <div className="t-foot" style={{ color: "var(--sub)", textAlign: "center", maxWidth: 268, lineHeight: 1.5 }}>
            Your session can't be checked until the network answers. Nothing has been signed out.
          </div>
          {/* size="md" is 44pt. This is the only tappable thing on a screen that
              has just admitted it is stuck, so it gets the full iOS target rather
              than the 34pt "sm" a secondary control would normally take. Quiet, not
              primary: the gold on this screen belongs to the seal, and a filled
              accent button would read as "sign in" — which is precisely what this
              is not. */}
          {onRetry && <Button kind="quiet" size="md" onClick={onRetry}>Retry</Button>}
        </div>
      )}
    </div>
  );
}

// Cycle auto → day → night → auto. Auto is the house default: follow the device.
// These label the MODE, not the palette — "Porcelain" and "Graphite" are two of
// the twenty colour schemes now (Assets → Theme), so using them here would say
// the wrong thing on the other eighteen.
const THEME_CYCLE = { auto: "day", day: "night", night: "auto" };
const THEME_LABEL = { auto: "Auto — matches your device", day: "Light", night: "Dark" };
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
  // THE ERROR IS NO LONGER A BARE STRING, because two completely different failures
  // were sharing one line of red text. supabase answers a request that never left
  // the phone with "Failed to fetch", and this screen printed that verbatim under
  // the password field — where the only thing a red sentence can mean is that the
  // password was refused. Being told your credentials are wrong when they are not
  // is worse here than anywhere else in the app: the reasonable next move is to
  // start doubting the account, on a launch where the account is perfectly fine and
  // only the signal isn't. So the branch is carried instead of flattened — `network`
  // picks the copy, `message` still holds supabase's own words for a real refusal.
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(false);

  // ONE ENTRY POINT FOR BOTH MODES, so the retry offered below is literally the
  // same attempt rather than a second path that can drift from this one.
  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      if (mode === "password") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } });
        if (error) throw error;
        setSent(true);
      }
    } catch (e) {
      // No fallback text baked in here: the two branches want different words for
      // a failure that arrived without a message, and the network one reads badly
      // with a stand-in sentence wrapped in its parentheses.
      setErr({ network: isNetworkAuthFailure(e), message: e?.message || "" });
    } finally {
      // finally, not a line after the await. supabase-js hands most auth failures
      // back in `error`, but a throw from anywhere inside that call had nothing to
      // clear this flag — so the button sat disabled reading "Signing in…" for the
      // rest of the session, which is the app claiming to still be working on
      // something it has already given up on.
      setBusy(false);
    }
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
            <Field value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === "Enter") submit(); }}
              placeholder="Password" type="password" autoComplete="current-password" />
          )}
          {err && (err.network ? (
            // WHAT THIS MAY SAY. The request never landed, so nothing about the
            // email or the password has been judged — and the second sentence has to
            // say that outright, because the reader's own first theory will be that
            // it has. Amber, not red: red on this screen means "refused", which is
            // the one thing this is not, and amber is already the house's word for
            // unresolved (the same treatment the calendar-feed warning in Settings
            // takes). supabase's own words stay, in parentheses, because "Failed to
            // fetch" is worth having when it is captioned rather than presented as a
            // verdict. The retry re-runs the attempt in place; a reload would be the
            // cruder version and would cost the warm connection it is waiting on.
            //
            // role="alert" rather than a live region wrapping this slot: an
            // aria-live container has to be in the DOM before its text arrives to be
            // announced, and an always-mounted one would add a 10px flex gap under
            // the password field on every launch where nothing went wrong. role
            // announces on insertion, which is exactly what this is.
            //
            // The sentence is mode-aware because magic-link mode has no password to
            // exonerate, and naming one that was never typed would be its own small
            // untruth. Toggling modes clears `err`, so the copy always describes the
            // attempt that produced it.
            <div className="t-foot" role="alert" style={{ color: "var(--amber)", lineHeight: 1.5 }}>
              Couldn't reach the server{err.message ? ` (${err.message})` : ""}. {mode === "password"
                ? "Your email and password were never checked, so nothing is wrong with them"
                : "Your email was never checked, so nothing is wrong with it"} — this attempt didn't get out.
              <div><button className="sec-link" style={{ padding: "6px 0 0" }} onClick={submit}>Try again</button></div>
            </div>
          ) : (
            <div className="t-foot" role="alert" style={{ color: "var(--red)" }}>{err.message || "That sign-in didn't go through."}</div>
          ))}
          {sent && <div className="t-foot" style={{ color: "var(--green)" }}>Login link sent — check your email.</div>}
          <Button kind="primary" size="lg" full disabled={disabled} onClick={submit}>
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
