import { useEffect, useState } from "react";

// ─── the clock the plan reads ─────────────────────────────────────────────────
// "Now" on the Plan tab and the Brief card has to be right the moment the app
// comes back to the front — which, for a PWA on iOS, is exactly when a plain
// setInterval is wrong. iOS suspends timers while the app is backgrounded, so
// a phone picked up at 7:02 after sitting since 10:30 last night would still be
// rendering "Sleep · 7h 30m left" until the next tick happened to fire. That is
// the one minute of the day this whole feature exists for.
//
// So the clock re-reads the time on every return to the foreground (visibility
// and pageshow, which covers a restore from the back-forward cache), and ticks
// every 30 seconds while visible. A Date, not a number, because every consumer
// wants local hours and the day of the week.
export function usePlanClock(everyMs = 30 * 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const iv = setInterval(tick, everyMs);
    const onShow = () => { if (document.visibilityState !== "hidden") tick(); };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("pageshow", onShow);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("pageshow", onShow);
    };
  }, [everyMs]);
  return now;
}
