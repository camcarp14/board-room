import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";
import { Cell, Button, Field, Sheet, useConfirm } from "../ui/kit.jsx";

// ─── Two-factor sign-in (TOTP) — Settings → Account ─────────────────────────
//
// One password guarded everything: the notes, the calendar, the bank sync, and
// the four other apps that share this Supabase project and this one account —
// with the account's email printed in the privacy policy. A second factor means
// a password that leaks or is guessed opens nothing on its own.
//
// Where it is enforced, so the switch is not decoration:
//  - the app: a session that has not passed the code step (aal1) gets the code
//    screen instead of the app (App.jsx's gate, TwoFactorScreen in Boot.jsx);
//  - the database: every boardroom table carries a restrictive policy that asks
//    for aal2 once a verified factor exists (0043_mfa_enforce.sql) — which is what
//    stops a password-only session from one of the other apps reading this one;
//  - the functions: every owner gate refuses an aal1 token once a factor exists.
// With no factor enrolled, all three are exactly as they were.
//
// LOST THE AUTHENTICATOR? Supabase dashboard → Authentication → Users → this
// user → delete the factor. That is the one recovery path; there are no backup
// codes, so say so on the way in.

export function TwoFactorRow() {
  const [factors, setFactors] = useState(null); // null = loading
  const [err, setErr] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = async () => {
    setErr(null);
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) { setErr(error.message); setFactors([]); return; }
    setFactors(data?.totp || []); // verified TOTP factors only
  };
  useEffect(() => { load(); }, []);

  const on = (factors || []).length > 0;
  const turnOff = async () => {
    const ok = await confirm({
      title: "Turn off two-factor?",
      message: "Signing in will need only your password again, on every app that uses this account.",
      confirmLabel: "Turn off", destructive: true,
    });
    if (!ok) return;
    for (const f of factors) {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (error) { setErr(error.message); break; }
    }
    // Unenrolling drops the session back to aal1; refresh it so the rest of the
    // app (and RLS) sees the account without a factor.
    await supabase.auth.refreshSession().catch(() => {});
    load();
  };

  return (
    <>
      <Cell
        title="Two-factor sign-in"
        sub={factors === null ? "Checking…"
          : err ? `Couldn't read it: ${err}`
          : on ? "On — sign-in asks for a code from your authenticator app"
          : "Off — your password alone signs in"}
        trailing={factors === null ? null : on
          ? <Button kind="plain" size="sm" onClick={turnOff}>Turn off</Button>
          : <Button kind="tinted" size="sm" onClick={() => setSetupOpen(true)}>Set up</Button>}
      />
      {setupOpen && <TwoFactorSetup onClose={() => setSetupOpen(false)} onDone={() => { setSetupOpen(false); load(); }} />}
      {confirmEl}
    </>
  );
}

function TwoFactorSetup({ onClose, onDone }) {
  const [enrolment, setEnrolment] = useState(null); // { id, qr, secret }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A setup abandoned half-way leaves an unverified factor behind, and a
      // second enroll under the same name is refused — clear those first.
      const listed = await supabase.auth.mfa.listFactors();
      for (const f of listed.data?.all || []) {
        if (f.factor_type === "totp" && f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Board Room" });
      if (cancelled) return;
      if (error) { setErr(error.message); return; }
      setEnrolment({ id: data.id, qr: data.totp?.qr_code, secret: data.totp?.secret });
    })();
    return () => { cancelled = true; };
  }, []);

  const verify = async () => {
    if (!enrolment || busy || code.trim().length < 6) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolment.id, code: code.trim() });
    setBusy(false);
    if (error) { setErr(/invalid|expired/i.test(error.message) ? "That code didn't match — check the app and try the current one." : error.message); return; }
    onDone();
  };

  return (
    <Sheet title="Set up two-factor" onClose={onClose} z={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="t-call" style={{ color: "var(--sub)" }}>
          Scan this with an authenticator app (1Password, Google Authenticator, Authy), then enter the 6-digit code it shows.
        </div>
        {!enrolment && !err && <div className="sk sk-card" style={{ height: 200 }} />}
        {enrolment?.qr && (
          <div style={{ display: "flex", justifyContent: "center", background: "#FFFFFF", borderRadius: 12, padding: 12 }}>
            <img src={enrolment.qr} alt="Two-factor QR code" width={180} height={180} />
          </div>
        )}
        {enrolment?.secret && (
          <div className="t-foot" style={{ color: "var(--faint)", wordBreak: "break-all" }}>
            Can't scan? Enter this key: <span className="t-num" style={{ color: "var(--sub)" }}>{enrolment.secret}</span>
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); verify(); }} style={{ display: "flex", gap: 8 }}>
          <Field value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric" autoComplete="one-time-code" placeholder="123456" style={{ flex: 1 }} />
          <Button kind="primary" size="md" disabled={!enrolment || busy || code.length < 6}>{busy ? "Checking…" : "Turn on"}</Button>
        </form>
        {err && <div className="t-foot" role="alert" style={{ color: "var(--red)" }}>{err}</div>}
        <div className="t-foot" style={{ color: "var(--faint)" }}>
          There are no backup codes. If you lose the authenticator, the factor can be removed in the Supabase dashboard (Authentication → Users).
        </div>
      </div>
    </Sheet>
  );
}

/** Is this session short of the second factor it is required to have? */
export async function needsSecondFactor() {
  if (!supabase) return false;
  try {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return data?.nextLevel === "aal2" && data?.currentLevel !== "aal2";
  } catch { return false; }
}
