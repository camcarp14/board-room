// ─── Whose fault was that: the network's, or the account's? ───────────────────
// This predicate was written inside App.jsx, next to the boot's auth race, and it
// has to live out here now because the login screen needs the same answer and
// cannot ask App.jsx for it — App.jsx imports shell/Boot.jsx, so a Boot that
// imported App would close a cycle. A leaf module with no imports of its own is
// reachable from both ends of that edge, and from a smoke as well.
//
// Is an auth failure the network's fault, or the account's? That distinction picks
// the screen he lands on, so it is worth being explicit about rather than inferring
// from a null session. supabase-js labels a fetch that never landed
// AuthRetryableFetchError and gives it status 0; a refused refresh token arrives as
// an AuthApiError carrying a real HTTP status.
//
// UNRECOGNISED FAILURES COUNT AS THE ACCOUNT'S, deliberately. That path ends at the
// login screen, which is a screen you can act on — whereas guessing "network" about
// a genuinely dead session would leave the boot waiting forever on a retry that
// cannot succeed. The asymmetry is the point: one wrong guess costs a sign-in, the
// other costs the app.
//
// The same asymmetry reads the other way round on the login screen itself, which is
// why it uses this and not a looser test: a wrong password wrongly excused as "we
// couldn't reach the server" would send him back to a field that will keep refusing
// him with no idea why.
export const isNetworkAuthFailure = (e) => {
  if (!e) return false;
  if (e.name === "AuthRetryableFetchError") return true;
  if (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504) return true;
  return /failed to fetch|networkerror|load failed|timed? ?out|offline/i.test(String(e.message || ""));
};
