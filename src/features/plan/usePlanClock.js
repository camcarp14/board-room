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
// and pageshow, which covers a restore from the back-forward cache), and while
// visible it wakes ON THE MINUTE rather than every 30 seconds from whenever it
// started. Blocks begin on a minute; an unaligned tick showed "Shower,
// breakfast · 0m left" for up to half a minute after the 8:30 block had begun.
// A Date, not a number, because every consumer wants local hours and the day
// of the week.
export function usePlanClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer;
    const tick = () => setNow(new Date());
    // 50ms past the boundary, so the Date it reads is unambiguously the new
    // minute. Seconds roll over at the same instant in every timezone.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { tick(); arm(); }, 60000 - (Date.now() % 60000) + 50);
    };
    const onShow = () => { if (document.visibilityState !== "hidden") { tick(); arm(); } };
    arm();
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("pageshow", onShow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
  return now;
}

// True once `active` has stayed true for `ms`. The plan surfaces wait for
// settings, and settings stay null for the whole session if the one read at
// sign-in failed — so a skeleton that never resolves would be a failed read
// dressed up as loading. After a few seconds the wait says what it's waiting on.
export function useTakingLong(active, ms = 8000) {
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!active) { setLong(false); return undefined; }
    const t = setTimeout(() => setLong(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return long;
}
