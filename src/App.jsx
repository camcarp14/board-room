import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { supabase } from "./lib/supabase.js";
import { sm } from "./lib/storage.js";
import { db, writeFailures, MERGING_SETTINGS } from "./data/db.js";
import { queryClient } from "./lib/queryClient.js";
import { callClaude, convene, DEFAULT_MODELS } from "./lib/claude.js";
import { parseLearnCommand, learnFromInput, makeSdb as makeSkillsDb } from "./LearnPanel.jsx";
import { useThemeController, useIsMobile, useBitcoinPrice } from "./hooks/index.js";
import { NAV } from "./shell/nav.js";
import { MobileShell } from "./shell/MobileShell.jsx";
import { SidebarShell } from "./shell/SidebarShell.jsx";
import { BootScreen, LoginScreen, SetupNotice } from "./shell/Boot.jsx";
import { WriteFailures } from "./shell/TopStatus.jsx";
import { Ambient } from "./shell/Ambient.jsx";
import { SettingsSheet } from "./shell/SettingsSheet.jsx";
import { useConnections } from "./pages/systems/connections.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.jsx";
import { Sheet, Button, useConfirm } from "./ui/kit.jsx";
// The Brief is the landing tab — keep it in the main chunk so first paint is
// immediate. The other four pages (and their heavier panels) split into their
// own chunks and load the first time you open that tab.
import { MorningBriefPage } from "./pages/brief/BriefPage.jsx";
import { SeatNotesModal } from "./pages/board/SeatNotesModal.jsx";
const PersonalPage = lazy(() => import("./pages/personal/PersonalPage.jsx").then(m => ({ default: m.PersonalPage })));
const TrainPage = lazy(() => import("./pages/train/TrainPage.jsx").then(m => ({ default: m.TrainPage })));
const GroceryPage = lazy(() => import("./pages/grocery/GroceryPage.jsx").then(m => ({ default: m.GroceryPage })));
// Lazy like the rest: the CSV parser, the category lexicon and the whole
// analyzer are dead weight on every launch that doesn't open the tab.
const FinancesPage = lazy(() => import("./pages/finances/FinancesPage.jsx").then(m => ({ default: m.FinancesPage })));
const CreedPage = lazy(() => import("./pages/creed/CreedPage.jsx").then(m => ({ default: m.CreedPage })));
const MarketsPage = lazy(() => import("./pages/markets/MarketsPage.jsx").then(m => ({ default: m.MarketsPage })));
const UpstreamPage = lazy(() => import("./pages/upstream/UpstreamPage.jsx").then(m => ({ default: m.UpstreamPage })));

// ════════════════════════════════════════════════════════════════════════════
// THE BOARD ROOM — SESSION edition.
// This file is the brain only: auth, data, chat/oversight, navigation state,
// and the deep-link primitive. Chrome lives in shell/, pages in pages/, the
// design system in design/ + ui/. Supabase remains the shared memory; no page
// shows fabricated data.
// ════════════════════════════════════════════════════════════════════════════

// Dev-only design preview: `vite` + VITE_PREVIEW=1 renders the shell with no
// session, so every card shows its designed empty/loading/error state.
// import.meta.env.DEV is compile-time false in production builds — this whole
// path is stripped from the deployed bundle.
const PREVIEW = import.meta.env.DEV && import.meta.env.VITE_PREVIEW === "1";
const previewParam = (k) => (PREVIEW ? new URLSearchParams(window.location.search).get(k) : null);

function MigrationModal({ counts, onImport, onSkip, importing }) {
  return (
    <Sheet title="Import your existing memory?" onClose={onSkip} dismissible={!importing} z={400}
      footer={
        <>
          <Button kind="quiet" size="lg" style={{ flex: 1 }} disabled={importing} onClick={onSkip}>Skip</Button>
          <Button kind="primary" size="lg" style={{ flex: 2 }} disabled={importing} onClick={onImport}>{importing ? "Importing…" : "Import"}</Button>
        </>
      }>
      <div className="t-body" style={{ color: "var(--sub)", lineHeight: 1.65, paddingBottom: 4 }}>
        This browser has data from before your account existed:{" "}
        <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{counts.chat} chat message{counts.chat !== 1 ? "s" : ""}</strong> and{" "}
        <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{counts.notes} seat note{counts.notes !== 1 ? "s" : ""}</strong>.
        Import them into your account so they're available on every device? Nothing is deleted either way.
      </div>
    </Sheet>
  );
}


// ─── Main app ────────────────────────────────────────────────────────────────
export default function App() {
  const theme = useThemeController();
  const isMobile = useIsMobile();
  const [navDir, setNavDir] = useState(null); // "l" | "r" | null — drives the page slide direction
  const [confirmEl, confirm] = useConfirm(); // the house confirm — replaces window.confirm
  const btc = useBitcoinPrice();

  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [messages, setMessages] = useState([]);
  const [seatNotes, setSeatNotes] = useState({});
  const [settings, setSettings] = useState(null);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [editSeat, setEditSeat] = useState(null);
  const [migration, setMigration] = useState(null);
  const [importing, setImporting] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [page, setPage] = useState(() => previewParam("p") || "brief"); // single nav state — Brief is the landing tab (same source of truth on mobile and desktop)
  const [dataStamp, setDataStamp] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const endRef = useRef(null);

  // WRITES THAT DID NOT LAND. Every save in data/db.js that can fail quietly
  // files itself in the writeFailures store (see the long note above write()
  // there); this is the shell's copy of it, and TopStatus draws the count with a
  // retry. It exists because the write path had no way at all to say "that
  // didn't happen": updateSetting painted the new value into state and dropped
  // the promise, so a refused upsert looked identical to a saved one until the
  // next reload took the change back.
  const [failedWrites, setFailedWrites] = useState([]);
  const [retryingWrites, setRetryingWrites] = useState(false);
  useEffect(() => {
    // Read once on mount as well as subscribing — a write can fail between this
    // component's first render and the effect running, and a failure the store
    // knows about but the shell doesn't is the same silence all over again.
    const already = writeFailures.list();
    if (already.length) setFailedWrites(already);
    return writeFailures.subscribe(() => setFailedWrites(writeFailures.list()));
  }, []);
  const retryWrites = async () => {
    if (retryingWrites) return;
    setRetryingWrites(true);
    // finally, not a bare await: retryAll doesn't reject, but a chip left stuck
    // on "Retrying…" would be its own small lie about what the app is doing.
    try { await writeFailures.retryAll(); } finally { setRetryingWrites(false); }
  };

  // Tick every 30s so the clock and freshness pill stay current.
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(iv);
  }, []);

  const [briefRefreshSignal, setBriefRefreshSignal] = useState(null);
  const refreshData = async () => {
    if (refreshing || !supabase || !session?.user) return;
    setRefreshing(true);
    btc.refresh();
    queryClient.invalidateQueries(); // one call refetches every cached query (Movies today; more as features migrate)
    setBriefRefreshSignal(Date.now()); // legacy per-page signal — retired as each card moves onto the query cache
    // THE STAMP IS THE FRESHNESS PILL, and it used to be set unconditionally
    // after a catch that swallowed everything — so a refresh with no signal, or
    // against a Supabase that was refusing reads, still turned the pill green
    // and said "Live". That is the one label on the app shell, visible on every
    // page, and its entire job is telling you whether what you are looking at
    // is current. Tapping Refresh and watching it go green is exactly the
    // moment you would stop doubting stale numbers.
    //
    // Per-slice, same as the initial load: a partial success is still progress
    // and should stamp, but a total failure must not.
    const [chatR, notesR, setsR] = await Promise.allSettled([
      db.loadChat(), db.loadSeatNotes(), db.loadSettings(),
    ]);
    if (chatR.status === "fulfilled") setMessages(chatR.value);
    if (notesR.status === "fulfilled") setSeatNotes(notesR.value);
    if (setsR.status === "fulfilled") setSettings(setsR.value);
    if ([chatR, notesR, setsR].some((r) => r.status === "fulfilled")) setDataStamp(Date.now());
    setNow(Date.now());
    setRefreshing(false);
  };

  useEffect(() => {
    if (!supabase) { setAuthChecked(true); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session || null); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // On sign-out, purge everything persisted to this device — the query
      // cache holds notes/events/birthdays/groceries and the query keys carry
      // no user id, so without this the next account to sign in on the same
      // device briefly rehydrates the previous user's private data.
      if (event === "SIGNED_OUT") {
        try {
          queryClient.clear();
          // The failed-write store belongs to the account too: each entry holds
          // a retry closure over whatever was being saved, so leaving them
          // behind would both show the next signed-in user someone else's
          // unsaved changes and, on a retry, try to write them.
          writeFailures.clearAll();
          // Same reasoning for the merging settings' revisions: they say which
          // version of this account's ponder_items and finance_rules this device
          // last saw, and the next account's first write diffs against whatever is
          // left here. loadSettings clears it too, but leaving it out of the purge
          // that enumerates everything else would be an omission to trip over.
          db.forgetSettings();
          ["br_rq_cache", "br_snapshot", "br_event_takes"].forEach(k => localStorage.removeItem(k));
        } catch { /* storage unavailable — nothing to leak anyway */ }
      }
    });
    return () => { sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!supabase) return;
    if (!session?.user) { setMessages([]); setSeatNotes({}); setSettings(null); return; }
    let alive = true;
    setLoadingData(true);
    (async () => {
      // ALL-OR-NOTHING WAS THE BUG. Every one of these readers throws on any
      // error (db.js does `if (error) throw error`), and Promise.all rejects on
      // the first — so a blip on the CHAT read discarded the settings too, and
      // `settings` stayed null for the whole session. Downstream that is not
      // merely a missing preference: the Tabs panel treats a null settings
      // object as "no saved nav" and writes the DEFAULT tab layout back over
      // his saved one the moment he opens it. One transient read failure could
      // permanently overwrite a configuration.
      //
      // allSettled applies each slice independently, so a failure costs exactly
      // its own slice and nothing else.
      const [chatR, notesR, setsR] = await Promise.allSettled([
        db.loadChat(), db.loadSeatNotes(), db.loadSettings(),
      ]);
      if (!alive) return;
      const chat = chatR.status === "fulfilled" ? chatR.value : null;
      if (chat) setMessages(chat);
      if (notesR.status === "fulfilled") setSeatNotes(notesR.value);
      // Only stamp the settings when they actually arrived. Leaving the prior
      // value in place is what stops a failed read reading as "unconfigured".
      if (setsR.status === "fulfilled") { setSettings(setsR.value); setDataStamp(Date.now()); }
      setLoadingData(false);
      // The migration prompt compares against the CHAT read, so it only gets to
      // run when that read is the one that succeeded.
      if (!chat) return;
      if (!sm.get("migrated")) {
        const localChat = sm.get("chat") || [];
        const localNotes = sm.get("seat_notes") || {};
        const nNotes = Object.keys(localNotes).filter(k => localNotes[k]).length;
        if (chat.length === 0 && (localChat.length > 0 || nNotes > 0)) setMigration({ chat: localChat.length, notes: nNotes });
        else sm.set("migrated", true);
      }
    })();
    return () => { alive = false; };
  }, [session?.user?.id]);

  useEffect(() => {
    // Pin the chat to the newest message. endRef's immediate parent is a
    // non-scrolling flex column — the real scroller is the shell's #page-scroll
    // (same id in both shells), so scrolling the parent did nothing. Only acts
    // when the chat is mounted (endRef attached), so other tabs are untouched.
    if (!endRef.current) return;
    const scroller = document.getElementById("page-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, thinking, page]);

  // AWAITED NOW, and the failure has somewhere to go. This was a bare
  // `db.saveSetting(key, value)` one line under the optimistic setState, promise
  // dropped on the floor — and app_settings is where the tab bar, budgets,
  // finance rules, grocery stores, the brief order, the notes order, ponder
  // items and the dream boards live. Several of those are things he typed, not
  // preferences, so a refused upsert wasn't a lost setting; it was lost content
  // that the screen went on showing as saved.
  //
  // saveSetting deliberately does NOT throw (data/db.js) and this must stay that
  // way: updateSetting is handed straight to onChange handlers all over the app,
  // most of which never await it, and a rejected promise from one of those is an
  // unhandled rejection at best and a dead panel at worst. The failure comes
  // back as { ok: false } and is already filed under this setting's key, which
  // is what puts the unsaved chip in the top bar.
  //
  // TWO OF THOSE KEYS DO NOT GO OUT AS A WHOLE VALUE ANY MORE. `settings` is
  // loaded once at sign-in and there is no realtime subscription anywhere in the
  // app, so the copy this function reads and rewrites goes out of date the moment
  // another device writes. For a preference that is fine — whoever set it last
  // meant it. For ponder_items and finance_rules it was silent deletion: park a
  // thought on the iPad, archive an item on the phone, and the phone upserts the
  // array it loaded this morning straight over the iPad's thought. No error, no
  // trace, and the thought is simply missing next time the iPad reloads.
  //
  // Those two keys route through db.mergeSetting, which does the read-modify-write
  // inside Postgres: finance_rules is merged key by key onto whatever is really
  // there, and ponder_items is only written onto the exact revision it was read
  // from and refused if that revision has moved. Everything else keeps the plain
  // upsert — the allowlist lives in data/db.js and is deliberately two keys long.
  //
  // ADOPTING IS THE OTHER HALF, and it is what keeps the screen honest. res.adopt
  // means the row was not where this device thought it was, so what came back is
  // news: a merged finance_rules carrying a rule the phone added while this tab sat
  // open, or — when the write was REFUSED — the ponder list that beat it. Both get
  // painted over the optimistic value, so the list on screen is the list the
  // database has, and the unsaved chip in the top bar says the edit that was
  // refused did not save. Watching an archive undo itself while the chip lights up
  // is a strange half-second, and it is the truth; the tap that follows it lands,
  // because it is finally built on the real list. When nothing moved there is
  // nothing to adopt: the value coming back is the one we just sent.
  const updateSetting = async (key, value) => {
    setSettings(prev => ({ ...(prev || {}), [key]: value }));
    if (MERGING_SETTINGS[key]) {
      const res = await db.mergeSetting(key, value);
      if (res?.adopt) setSettings(prev => ({ ...(prev || {}), [key]: res.value }));
      return res;
    }
    return await db.saveSetting(key, value);
  };

  // The bar the owner built (Settings → Tabs), stored as
  // app_settings.navigation = { order: [key…], hidden: [key…] } — THE SCHEMA
  // PREDATES THIS CODE (the restored production build wrote it), so both
  // halves are read as stored: unknown keys are ignored, keys the saved order
  // has never met append in default order, and `hidden_tabs` (a short-lived
  // interim key) is honored as a fallback. Brief cannot be hidden — it's the
  // landing page and the bar's one guaranteed way home. Hiding a tab removes
  // its BAR SLOT, not the destination: deep links still reach the page; the
  // bar just shows no active tab while you're there.
  const navSetting = settings?.navigation || {};
  const hiddenTabs = new Set(
    Array.isArray(navSetting.hidden) ? navSetting.hidden
      : Array.isArray(settings?.hidden_tabs) ? settings.hidden_tabs : []);
  const orderedNav = (() => {
    const order = Array.isArray(navSetting.order) ? navSetting.order : [];
    if (!order.length) return NAV;
    const byKey = new Map(NAV.map(n => [n.key, n]));
    const out = order.map(k => byKey.get(k)).filter(Boolean);
    for (const n of NAV) if (!out.includes(n)) out.push(n);
    return out;
  })();
  const visibleNav = orderedNav.filter(n => n.key === "brief" || !hiddenTabs.has(n.key));
  // Not strict, on purpose: SeatNotesModal does `await onSave(…)` and then closes,
  // with no catch of its own, so a throw here would leave the sheet stuck on
  // "Saving…" forever. The failure is recorded instead and shows in the top bar,
  // which is the one place that can outlive the sheet.
  const saveSeatNote = async (key, notes) => {
    setSeatNotes(prev => ({ ...prev, [key]: notes }));
    return await db.saveSeatNote(key, notes);
  };

  const runImport = async () => {
    setImporting(true);
    try {
      const localChat = sm.get("chat") || [];
      if (localChat.length) {
        const rows = localChat.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || ""), consulted_seats: m.consulted || [], created_at: m.ts ? new Date(m.ts).toISOString() : new Date().toISOString(), source: "web" }));
        const { error } = await supabase.from("chat_messages").insert(rows);
        // Same resolve-on-error shape the rest of the write path had to be fixed
        // for (see the note above write() in data/db.js): this insert never
        // rejected, so an import that landed nothing at all fell straight
        // through to sm.set("migrated", true) below and the offer never came
        // back. One tap, and the chat this browser had been holding since before
        // the account existed was unreachable from the app for good.
        if (error) throw error;
      }
      const localNotes = sm.get("seat_notes") || {};
      // strict: this is one of the few places with a real catch and something
      // real to say, so it takes the throw instead of the quiet chip — an import
      // that half happened must stop before it marks itself done.
      for (const [k, v] of Object.entries(localNotes)) { if (v) await db.saveSeatNote(k, v, { strict: true }); }
      sm.set("migrated", true);
      const chat = await db.loadChat();
      setMessages(chat);
      setSeatNotes(prev => ({ ...prev, ...localNotes }));
    } catch (e) {
      // Nothing was marked migrated on this path, so the local copy is still
      // there and the offer returns on the next launch. Say so rather than
      // closing the sheet as though it worked.
      await confirm({ title: "Couldn't import", message: `${e.message || "The import didn't finish."} Nothing was marked as imported — the offer will come back next time you open the app.`, confirmLabel: "OK", cancelLabel: false });
    }
    setImporting(false);
    setMigration(null);
  };
  const skipImport = () => { sm.set("migrated", true); setMigration(null); };

  // Scroll the active page back to top on nav tap — smooth if there's
  // actually somewhere to scroll from, skipped entirely if already at top
  // so it's not a pointless animation on every tap.
  const goToPage = (key) => {
    // Assets, Systems and Mind are all gone from the nav — the first two moved
    // into Settings → Systems, Mind was retired outright. A saved link to any of
    // them lands on the Brief rather than a blank page; there is no tab left to
    // honour, and silently opening the Settings sheet from a URL would be a
    // stranger answer than the app's home.
    if (key === "assets" || key === "systems" || key === "boardroom") key = "brief";
    // Dreams folded into Creed — a saved link opens the boards sub-tab (jumpTo
    // carries the sub; this bare-key path just needs the right page).
    if (key === "dreams") key = "creed";
    // Direction-aware: pages to the right slide in from the right, and vice
    // versa — the same physics whether the trigger was a tab tap or a swipe.
    // Measured on the VISIBLE bar: with tabs hidden, "next door" means the
    // next slot you can see, and a hidden destination (deep link) gets no
    // slide rather than a direction derived from a bar it isn't on.
    const from = visibleNav.findIndex(n => n.key === page);
    const to = visibleNav.findIndex(n => n.key === key);
    setNavDir(to > from ? "l" : to < from ? "r" : null);
    setPage(key);
    requestAnimationFrame(() => {
      const el = document.getElementById("page-scroll");
      if (el && el.scrollTop > 0) el.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  // Swipe between tabs (mobile): a quick, mostly-horizontal touch drag on the
  // page switches to the neighboring tab. Native listeners (not React
  // delegation) on the scroller; touch-action: pan-y leaves horizontal
  // gestures to us while the browser keeps vertical scrolling. Ignores
  // gestures that start on form controls, inside horizontally scrollable
  // regions, or at the screen edges (those belong to iOS's history gesture).
  const pageRef = useRef(page);
  pageRef.current = page;
  const goToPageRef = useRef(null);
  goToPageRef.current = goToPage;
  // The swipe handler is a native listener mounted once — it reads the
  // visible bar through a ref so a toggle in Settings takes effect without
  // re-binding the gesture.
  const visibleNavRef = useRef(visibleNav);
  visibleNavRef.current = visibleNav;

  // Hiding the tab you're standing on bounces you to the Brief — the sheet
  // stays open, the bar under it just updates. Keyed on the setting, not the
  // page, so a deep link INTO a hidden page later doesn't get bounced.
  useEffect(() => {
    if (page !== "brief" && hiddenTabs.has(page)) setPage("brief");
  }, [settings?.navigation, settings?.hidden_tabs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isMobile) return;
    // Document-level delegation: the shell (and #page-scroll) may not exist
    // yet when this runs (boot screen), and remounts must not shed listeners.
    let start = null;
    const onDown = (e) => {
      start = null;
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      const root = document.getElementById("page-scroll");
      if (!root || !root.contains(e.target)) return;
      let el = e.target, blocked = false;
      while (el && el !== root) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") { blocked = true; break; }
        if (el.scrollWidth > el.clientWidth + 8) {
          const ox = getComputedStyle(el).overflowX;
          if (ox === "auto" || ox === "scroll") { blocked = true; break; }
        }
        el = el.parentElement;
      }
      if (blocked || e.clientX < 24 || e.clientX > window.innerWidth - 24) return;
      start = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    const onUp = (e) => {
      const s = start;
      start = null;
      if (!s || e.pointerType !== "touch") return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (Date.now() - s.t > 600 || Math.abs(dx) < 64 || Math.abs(dx) < 2.2 * Math.abs(dy)) return;
      const bar = visibleNavRef.current;
      const idx = bar.findIndex(n => n.key === pageRef.current);
      if (idx === -1) return; // on a hidden page (deep link) — no neighbors to swipe to
      const next = dx < 0 ? idx + 1 : idx - 1;
      if (next >= 0 && next < bar.length) goToPageRef.current?.(bar[next].key);
    };
    const onCancel = () => { start = null; };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };
  }, [isMobile]);

  // Keyboard focus correction (mobile): iOS auto-scrolls the focused field
  // into view at the same moment the keyboard shrinks the shell — the two
  // fight and the page lands in a weird spot. Once both settle, re-center
  // the field ourselves.
  useEffect(() => {
    if (!isMobile) return;
    let t = 0;
    const onFocusIn = (e) => {
      const el = e.target;
      if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
      const root = document.getElementById("page-scroll");
      if (!root || !root.contains(el)) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (document.activeElement === el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 400);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => { window.clearTimeout(t); document.removeEventListener("focusin", onFocusIn); };
  }, [isMobile]);
  const [personalJumpTo, setPersonalJumpTo] = useState(null); // tells PersonalPage which sub-tab to open on arrival

  // Learned skills — loaded once per session, refreshed whenever the Learn
  // tab or /learn command changes them; injected into the Chief's prompt.
  const [skills, setSkills] = useState([]);
  const refreshSkills = async () => {
    try { setSkills(await makeSkillsDb(supabase).loadEnabled()); }
    catch { setSkills([]); } // table not created yet — chat just runs without skills
  };
  useEffect(() => { if (session?.user?.id) refreshSkills(); }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settings — theme, the calendar feed, account + sign-out. One sheet, both
  // shells; before this, sign-out was desktop-only and calendar_url had no UI.
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { if (!session) setSettingsOpen(false); }, [session]);
  // Hosted here, not inside the sheet, so a Status run survives closing and
  // reopening Settings — the checks take a few seconds and ~25 requests, and
  // losing them because you looked at Theme would mean paying for them twice.
  // Nothing fires until the Systems → Status panel is actually shown; the sheet
  // owns that trigger.
  const conn = useConnections({ session, btc });

  // Summon — the ⌘K overlay that searched every page and took a quick note —
  // has been removed, along with its search buttons in both shells and the ⌘K
  // hint in Settings. It was a second way to reach pages the nav already
  // reaches in one tap, and a second way to write a note the Notes tab already
  // writes; on a phone it was an icon in the top bar that never got used.
  //
  // What it drove STAYS, because it was never Summon's alone: `jump` and
  // `jumpTo` are the deep-link primitive the Brief, the Word's chips and the
  // page sub-tabs all point through. Only the overlay is gone.
  const [jump, setJump] = useState(null); // { t, page, sub, noteId?, skillId? }
  // One deep-link primitive: page + optional sub-tab/entity, used by anything
  // that wants to point somewhere else (e.g. the Word's chips, the Brief).
  const jumpTo = (target) => {
    // Three migrations honored here: Workout graduated from Personal to its own
    // Train tab; Systems folded into Assets; and Mind (boardroom) was removed
    // outright. A stale boardroom link can no longer be honored, so it lands on
    // Assets with no sub-tab — which means Usage. Dropping `sub` matters: an
    // unknown key would be ignored anyway, but carrying "mind" forward would
    // imply the tab still exists.
    // Two graduations, both remapped so old deep links still land: Workout became
    // Train, Creed became its own tab. Dropping `sub` matters — carrying it
    // forward would imply the section still exists inside Personal.
    let t = target.page === "personal" && target.sub === "workout" ? { ...target, page: "train", sub: undefined } : target;
    if (t.page === "personal" && t.sub === "creed") t = { ...t, page: "creed", sub: undefined };
    if (t.page === "dreams") t = { ...t, page: "creed", sub: "dreams" };
    if (t.page === "assets" || t.page === "systems" || t.page === "boardroom") t = { ...t, page: "brief", sub: undefined };
    goToPage(t.page);
    setJump({ t: Date.now(), ...t });
  };
  const goToCalendar = () => { setPersonalJumpTo(Date.now()); goToPage("personal"); }; // timestamp so re-tapping still re-triggers even if already on Personal

  const send = async (textOverride) => {
    // Composer passes a click/key event here — only a real string overrides the box.
    const q = (typeof textOverride === "string" ? textOverride : input).trim();
    if (!q || thinking) return;
    setInput("");
    const userMsg = { role: "user", content: q, ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    db.saveMessage({ role: "user", content: q });
    setThinking(true);

    // "/learn <url or anything>" — teach a skill right from the chat instead
    // of convening the board. Mirrors the Learn tab pipeline exactly.
    const learnCmd = parseLearnCommand(q);
    if (learnCmd) {
      let reply;
      if (learnCmd.open) {
        reply = "Give me something to learn — `/learn <url or pasted text>` — or use the Learn tab up top, which also shows everything I've been taught.";
      } else {
        const result = await learnFromInput({
          text: learnCmd.text, supabase, callClaude,
          modelKey: (settings?.mini || {}).model || "haiku",
          accessToken: session?.access_token || "",
        });
        if (result.error === "missing_table") reply = "The skills table isn't set up yet — open the Learn tab and it'll hand you the one-time SQL to paste into Supabase.";
        else if (result.error) reply = `Couldn't learn that: ${result.error}`;
        else {
          const skipped = result.failedUrls?.length ? `\n\n(Couldn't read ${result.failedUrls.map(f => f.url).join(", ")} — learned from the rest.)` : "";
          reply = `◆ Learned "${result.skill.title}" — ${result.skill.description}${skipped}\n\nIt's loaded into every chat and queue run from here on. It lives in the Learn tab if you want to edit or disable it.`;
          refreshSkills();
        }
      }
      setThinking(false);
      const asstMsg = { role: "assistant", content: reply, ts: Date.now() };
      setMessages([...next, asstMsg]);
      db.saveMessage({ role: "assistant", content: reply });
      return;
    }

    const models = { ...DEFAULT_MODELS, ...(settings?.models || {}) };
    const result = await convene(q, next, { models, seatNotes, skills });
    setThinking(false);
    const asstMsg = { role: "assistant", content: result.answer, consulted: result.consulted, ts: Date.now() };
    setMessages([...next, asstMsg]);
    db.saveMessage({ role: "assistant", content: result.answer, consulted: result.consulted });
    runOversight(q, result); // fire-and-forget — never blocks the chat
  };

  const clearChat = async () => {
    const ok = await confirm({ title: "Clear the whole chat?", message: "Every message in the room is deleted for good. This can't be undone.", confirmLabel: "Clear chat", destructive: true });
    if (!ok) return;
    try { await db.clearChat(); setMessages([]); }
    catch (e) { await confirm({ title: "Couldn't clear chat", message: e.message || "Try again in a moment.", confirmLabel: "OK", cancelLabel: false }); }
  };

  // Real oversight: if the user has it on and 2+ seats were consulted, ask a
  // fresh Claude call to actually check whether the Chief's synthesis
  // represented every seat's take fairly, or quietly smoothed over dissent.
  // Only writes to the feed when it finds something — silence otherwise.
  const runOversight = async (question, result) => {
    const mini = settings?.mini || {};
    if (mini.enabled === false || !mini.oversight) return;
    if (!result.consulted || result.consulted.length < 2) return;
    try {
      const seatBlock = result.consulted.map(c => `[${c.name}]: ${c.take}`).join("\n\n");
      const system = `You audit a "Chief of Staff" AI's synthesis for whether it fairly represented disagreement between specialist seats, or smoothed it over. Question: "${question}"\n\nSeat takes:\n${seatBlock}\n\nChief's synthesized answer:\n${result.answer}\n\nIf the seats meaningfully disagreed and the Chief's answer glossed over, hid, or flattened that disagreement, respond with ONLY a one-sentence description of what was smoothed over. If the Chief fairly represented any disagreement (or the seats didn't meaningfully disagree), respond with exactly: OK`;
      const verdict = await callClaude({ system, messages: [{ role: "user", content: "Audit this exchange." }], modelKey: mini.model || "haiku", maxTokens: 150, fn: "oversight" });
      if (verdict && verdict.trim() !== "OK" && !verdict.trim().startsWith("OK")) {
        const { error } = await supabase.from("mini_feed").insert({ user_id: (await supabase.auth.getUser()).data?.user?.id, text: `Oversight: ${verdict.trim()}` });
        // The catch below is meant to make this best-effort, and it could not:
        // this insert resolves with { error } rather than rejecting (data/db.js
        // explains why), so a refused feed write never reached the handler that
        // was written to absorb it. Reading .error is what makes "best-effort"
        // a true description of this function instead of a hopeful one.
        if (error) throw error;
      }
    } catch { /* best-effort — this stays quiet by design; a lost oversight note is not worth a chip in the top bar */ }
  };

  // One ambient canvas for the entire app, mounted above the auth gate so the
  // wash is already drifting behind the boot seal and the login card — the two
  // screens seen most often on a cold open. It is a sibling of everything, never
  // a wrapper: it must not become the containing block for any fixed-position
  // chrome (the tab bar, sheets), which a transformed ancestor would.
  const ambient = <Ambient on={theme.ambient} />;
  const gate =
    previewParam("view") === "setup" ? <SetupNotice /> :
    previewParam("view") === "login" ? <LoginScreen /> :
    previewParam("view") === "boot" ? <BootScreen /> :
    !supabase ? <SetupNotice /> :
    !authChecked && !PREVIEW ? <BootScreen /> :
    !session && !PREVIEW ? <LoginScreen /> :
    null;
  if (gate) return <>{ambient}{gate}</>;

  const calUrl = settings?.calendar_url || "";

  const renderPageInner = (key) => {
    switch (key) {
      case "brief": return <MorningBriefPage btc={btc} isMobile={isMobile} settings={settings} updateSetting={updateSetting} onOpenCalendar={goToCalendar} onAddEvent={(date) => jumpTo({ page: "personal", sub: "calendar", newEventDate: date })} onOpenNotes={(noteId) => jumpTo({ page: "personal", sub: "notes", noteId })} onOpenBirthdays={() => jumpTo({ page: "personal", sub: "birthdays" })} refreshSignal={briefRefreshSignal} />;
      case "personal": return <PersonalPage isMobile={isMobile} jumpSignal={personalJumpTo} jump={jump} settings={settings} updateSetting={updateSetting} />;
      case "train": return <TrainPage isMobile={isMobile} settings={settings} updateSetting={updateSetting} jump={jump} />;
      case "creed": return <CreedPage isMobile={isMobile} settings={settings} updateSetting={updateSetting} jump={jump} />;
      case "grocery": return <GroceryPage isMobile={isMobile} settings={settings} updateSetting={updateSetting} />;
      case "markets": return <MarketsPage isMobile={isMobile} btc={btc} jump={jump} settings={settings} updateSetting={updateSetting} />;
      case "finances": return <FinancesPage isMobile={isMobile} settings={settings} updateSetting={updateSetting} />;
      case "upstream": return <UpstreamPage isMobile={isMobile} />;
      default: return null;
    }
  };
  // A crashing panel shows an error card; the shell + nav stay alive so the
  // other tabs are still reachable. key={key} resets the boundary on nav.
  // Suspense catches the lazy page chunk on first open of a non-Brief tab.
  const renderPage = (key) => (
    <ErrorBoundary key={key} label={NAV.find(n => n.key === key)?.label || key}>
      {/* The chunk for a tab lands in a few hundred ms; what shows in the
          meantime should be the page's silhouette, not a lonely bar in the
          middle of the screen. Every page in the building is a column of cards,
          so that is the shape — and the tail fades, which reads as "there is
          more below" rather than "this is all there is". */}
      <Suspense fallback={
        <div style={{ flex: 1, padding: isMobile ? "6px 16px 0" : "6px 0 0", display: "flex", flexDirection: "column", gap: 12 }} aria-busy="true" aria-label={`Loading ${NAV.find(n => n.key === key)?.label || key}`}>
          <div className="sk sk-card" />
          <div className="sk sk-card" style={{ opacity: 0.7 }} />
          <div className="sk sk-card" style={{ opacity: 0.4 }} />
        </div>
      }>
        {renderPageInner(key)}
      </Suspense>
    </ErrorBoundary>
  );

  // ═══ SHELLS ═══
  // One nav state, two chromes: MobileShell (glass nav bar + tab bar, all the
  // iOS-standalone geometry) and SidebarShell (iPadOS sidebar + content well).
  const shellProps = { page, theme, nav: visibleNav, onNavigate: goToPage, onOpenSettings: () => setSettingsOpen(true), now, dataStamp, refreshing, onRefresh: refreshData };
  const overlays = (
    <>
      {confirmEl}
      {settingsOpen && (
        <SettingsSheet
          onClose={() => setSettingsOpen(false)}
          session={session}
          theme={theme}
          calUrl={calUrl}
          onSaveCalUrl={(v) => updateSetting("calendar_url", v)}
          isMobile={isMobile}
          conn={conn}
          settings={settings}
          updateSetting={updateSetting}
        />
      )}
      {editSeat && <SeatNotesModal seatKey={editSeat} initial={seatNotes[editSeat]} onSave={saveSeatNote} onClose={() => setEditSeat(null)} isMobile={isMobile} />}
      {migration && <MigrationModal counts={migration} onImport={runImport} onSkip={skipImport} importing={importing} />}
    </>
  );

  // The unsaved-writes chip lives in TopStatus, which both shells render — so it
  // comes down as context rather than as two more props threaded through chrome
  // that has no other reason to know about the write path. The Provider renders
  // no DOM of its own, so unlike a wrapper element it cannot become the
  // containing block for the fixed tab bar or a sheet (see the Ambient note).
  const writeFailureValue = { failed: failedWrites, retrying: retryingWrites, onRetry: retryWrites };

  if (isMobile) {
    return (
      <>
        {ambient}
        <WriteFailures.Provider value={writeFailureValue}>
          <MobileShell {...shellProps} navDir={navDir}>{renderPage(page)}</MobileShell>
        </WriteFailures.Provider>
        {overlays}
      </>
    );
  }
  return (
    <>
      {ambient}
      <WriteFailures.Provider value={writeFailureValue}>
        <SidebarShell
          {...shellProps}
          btc={btc}
          session={session}
        >
          {renderPage(page)}
        </SidebarShell>
      </WriteFailures.Provider>
      {overlays}
    </>
  );
}
