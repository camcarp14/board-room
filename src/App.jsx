import { useState, useEffect, lazy, Suspense } from "react";
import { supabase } from "./lib/supabase.js";
import { sm, obs } from "./lib/storage.js";
import { db } from "./data/db.js";
import { queryClient } from "./lib/queryClient.js";
import { makeSdb as makeSkillsDb } from "./LearnPanel.jsx";
import { useThemeController, useIsMobile, useBitcoinPrice } from "./hooks/index.js";
import { NAV } from "./shell/nav.js";
import { MobileShell } from "./shell/MobileShell.jsx";
import { SidebarShell } from "./shell/SidebarShell.jsx";
import { Summon } from "./shell/Summon.jsx";
import { BootScreen, LoginScreen, SetupNotice } from "./shell/Boot.jsx";
import { ErrorBoundary } from "./shell/ErrorBoundary.jsx";
import { Sheet, Button } from "./ui/kit.jsx";
// The Brief is the landing tab — keep it in the main chunk so first paint is
// immediate. The other four pages (and their heavier panels) split into their
// own chunks and load the first time you open that tab.
import { MorningBriefPage } from "./pages/brief/BriefPage.jsx";
const PersonalPage = lazy(() => import("./pages/personal/PersonalPage.jsx").then(m => ({ default: m.PersonalPage })));
const TrainPage = lazy(() => import("./pages/train/TrainPage.jsx").then(m => ({ default: m.TrainPage })));
const BoardRoomPage = lazy(() => import("./pages/board/BoardPage.jsx").then(m => ({ default: m.BoardRoomPage })));
const PropertiesPage = lazy(() => import("./pages/assets/AssetsPage.jsx").then(m => ({ default: m.PropertiesPage })));
const SystemsPage = lazy(() => import("./pages/systems/SystemsPage.jsx").then(m => ({ default: m.SystemsPage })));
const UpstreamPage = lazy(() => import("./pages/upstream/UpstreamPage.jsx").then(m => ({ default: m.UpstreamPage })));

// ════════════════════════════════════════════════════════════════════════════
// THE BOARD ROOM — SESSION edition.
// This file is the brain only: auth, settings, navigation state, and the
// deep-link primitive. Chrome lives in shell/, pages in pages/, the design
// system in design/ + ui/. Supabase remains the shared memory; no page shows
// fabricated data. (The retired board-chat pipeline — send/convene/oversight/
// seat-notes modal — was stripped once BoardPage stopped consuming it; the
// chat table itself stays live for the Discord /board flow and the one-time
// local→account migration below.)
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
  const btc = useBitcoinPrice();

  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [settings, setSettings] = useState(null);
  const [migration, setMigration] = useState(null);
  const [importing, setImporting] = useState(false);
  const [page, setPage] = useState(() => previewParam("p") || "brief"); // single nav state — same source of truth on mobile and desktop
  const [dataStamp, setDataStamp] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

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
    try {
      setSettings(await db.loadSettings());
    } catch {}
    setDataStamp(Date.now());
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
          ["br_rq_cache", "br_snapshot", "br_event_takes"].forEach(k => localStorage.removeItem(k));
        } catch { /* storage unavailable — nothing to leak anyway */ }
      }
    });
    return () => { sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!supabase) return;
    if (!session?.user) { setSettings(null); return; }
    let alive = true;
    (async () => {
      let sets;
      try {
        sets = await db.loadSettings();
      } catch {
        // Load failed (offline, RLS blip). Don't clobber whatever we already
        // have — the persisted query cache / prior state shows through.
        return;
      }
      if (!alive) return;
      setSettings(sets);
      setDataStamp(Date.now());
      // One-time local→account migration check. Chat is only loaded here, on
      // the unmigrated path — the retired board chat has no other reader, so
      // migrated accounts skip the round-trip entirely. The chat table itself
      // stays live: the Discord /board flow reads and writes it server-side.
      if (!sm.get("migrated")) {
        const localChat = sm.get("chat") || [];
        const localNotes = sm.get("seat_notes") || {};
        const nNotes = Object.keys(localNotes).filter(k => localNotes[k]).length;
        if (localChat.length > 0 || nNotes > 0) {
          try {
            const chat = await db.loadChat();
            if (!alive) return;
            if (chat.length === 0) setMigration({ chat: localChat.length, notes: nNotes });
            else sm.set("migrated", true);
          } catch { /* retry next launch */ }
        } else sm.set("migrated", true);
      }
    })();
    return () => { alive = false; };
  }, [session?.user?.id]);

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...(prev || {}), [key]: value }));
    db.saveSetting(key, value);
  };

  const runImport = async () => {
    setImporting(true);
    try {
      const localChat = sm.get("chat") || [];
      if (localChat.length) {
        const rows = localChat.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || ""), consulted_seats: m.consulted || [], created_at: m.ts ? new Date(m.ts).toISOString() : new Date().toISOString(), source: "web" }));
        await supabase.from("chat_messages").insert(rows);
      }
      const localNotes = sm.get("seat_notes") || {};
      for (const [k, v] of Object.entries(localNotes)) { if (v) await db.saveSeatNote(k, v); }
      sm.set("migrated", true);
    } catch {}
    setImporting(false);
    setMigration(null);
  };
  const skipImport = () => { sm.set("migrated", true); setMigration(null); };

  // Scroll the active page back to top on nav tap — smooth if there's
  // actually somewhere to scroll from, skipped entirely if already at top
  // so it's not a pointless animation on every tap.
  const goToPage = (key) => {
    // Direction-aware: pages to the right slide in from the right, and vice
    // versa — the same physics whether the trigger was a tab tap or a swipe.
    const from = NAV.findIndex(n => n.key === page);
    const to = NAV.findIndex(n => n.key === key);
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
      const idx = NAV.findIndex(n => n.key === pageRef.current);
      const next = dx < 0 ? idx + 1 : idx - 1;
      if (next >= 0 && next < NAV.length) goToPageRef.current?.(NAV[next].key);
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

  // Summon (⌘K) — global jump + quick capture
  const [summon, setSummon] = useState(false);
  const [jump, setJump] = useState(null); // { t, page, sub, noteId?, skillId? }
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSummon(s => !s); }
      if (e.key === "Escape") setSummon(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (!session) setSummon(false); }, [session]);
  // One deep-link primitive: page + optional sub-tab/entity, used by Summon and
  // by anything on a page that wants to point somewhere (e.g. the Word's chips).
  const jumpTo = (target) => {
    // Workout graduated from Personal to its own Train tab — old deep links
    // (Brief chips, saved Summon muscle memory) land on the new page.
    const t = target.page === "personal" && target.sub === "workout" ? { ...target, page: "train", sub: undefined } : target;
    goToPage(t.page);
    setJump({ t: Date.now(), ...t });
  };
  const summonGo = (target) => { setSummon(false); jumpTo(target); };
  // Summon's free-text "ask" goes to the Mind: open the neural canvas and
  // hand the question to its Pulse (MindPanel fires it once off jump.ask).
  const summonAsk = (q) => { setSummon(false); jumpTo({ page: "boardroom", sub: "neural", ask: q }); };
  const summonJot = async (text) => {
    await db.saveNote({ id: crypto.randomUUID(), title: "", body: text });
    queryClient.invalidateQueries({ queryKey: ["notes"] }); // jots show up in Notes surfaces immediately, not after the cache goes stale
  };
  const summonQueueTask = async (text) => {
    const t = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, status: "queued", queued_at: Date.now() };
    // Functional update — Summon can sit open across a settings reload, and a
    // read-modify-write from that stale closure would drop tasks queued in
    // between. The save runs inside the updater so it always writes the list
    // it just built (no StrictMode double-invoke here — see main.jsx).
    setSettings(prev => {
      const list = [t, ...(prev?.mini_tasks || [])];
      db.saveSetting("mini_tasks", list);
      return { ...(prev || {}), mini_tasks: list };
    });
  };
  const summonEl = summon ? <Summon onClose={() => setSummon(false)} onGo={summonGo} onJot={summonJot} onQueueTask={summonQueueTask} onAsk={summonAsk} isMobile={isMobile} /> : null;
  const goToCalendar = () => { setPersonalJumpTo(Date.now()); goToPage("personal"); }; // timestamp so re-tapping still re-triggers even if already on Personal

  if (previewParam("view") === "setup") return <SetupNotice />;
  if (previewParam("view") === "login") return <LoginScreen />;
  if (previewParam("view") === "boot") return <BootScreen />;
  if (!supabase) return <SetupNotice />;
  if (!authChecked && !PREVIEW) return <BootScreen />;
  if (!session && !PREVIEW) return <LoginScreen />;

  const totalSpend = obs.all().reduce((s, l) => s + (l.cost || 0), 0);

  const renderPageInner = (key) => {
    switch (key) {
      case "brief": return <MorningBriefPage btc={btc} isMobile={isMobile} settings={settings} updateSetting={updateSetting} onOpenCalendar={goToCalendar} onAddEvent={(date) => jumpTo({ page: "personal", sub: "calendar", newEventDate: date })} onOpenNotes={(noteId) => summonGo({ page: "personal", sub: "notes", noteId })} onOpenQueue={() => jumpTo({ page: "boardroom", sub: "mini" })} onOpenBirthdays={() => jumpTo({ page: "personal", sub: "birthdays" })} refreshSignal={briefRefreshSignal} />;
      case "boardroom": return <BoardRoomPage settings={settings} updateSetting={updateSetting} session={session} onWorkerRun={refreshData} onSkillsChanged={refreshSkills} jump={jump} isMobile={isMobile} skills={skills} />;
      case "personal": return <PersonalPage isMobile={isMobile} jumpSignal={personalJumpTo} jump={jump} settings={settings} updateSetting={updateSetting} />;
      case "train": return <TrainPage isMobile={isMobile} settings={settings} updateSetting={updateSetting} jump={jump} />;
      case "assets": return <PropertiesPage isMobile={isMobile} settings={settings} updateSetting={updateSetting} session={session} />;
      case "systems": return <SystemsPage settings={settings} updateSetting={updateSetting} session={session} btc={btc} isMobile={isMobile} />;
      case "upstream": return <UpstreamPage isMobile={isMobile} />;
      default: return null;
    }
  };
  // A crashing panel shows an error card; the shell + nav stay alive so the
  // other tabs are still reachable. key={key} resets the boundary on nav.
  // Suspense catches the lazy page chunk on first open of a non-Brief tab.
  const renderPage = (key) => (
    <ErrorBoundary key={key} label={NAV.find(n => n.key === key)?.label || key}>
      <Suspense fallback={<div style={{ flex: 1, minHeight: 220, display: "flex", alignItems: "center", justifyContent: "center" }}><div className="sk" style={{ width: 140, height: 12, borderRadius: 6 }} /></div>}>
        {renderPageInner(key)}
      </Suspense>
    </ErrorBoundary>
  );

  // ═══ SHELLS ═══
  // One nav state, two chromes: MobileShell (glass nav bar + tab bar, all the
  // iOS-standalone geometry) and SidebarShell (iPadOS sidebar + content well).
  const shellProps = { page, theme, onNavigate: goToPage, onSummon: () => setSummon(true), now, dataStamp, refreshing, onRefresh: refreshData };
  const overlays = (
    <>
      {summonEl}
      {migration && <MigrationModal counts={migration} onImport={runImport} onSkip={skipImport} importing={importing} />}
    </>
  );

  if (isMobile) {
    return (
      <>
        <MobileShell {...shellProps} navDir={navDir}>{renderPage(page)}</MobileShell>
        {overlays}
      </>
    );
  }
  return (
    <>
      <SidebarShell
        {...shellProps}
        btc={btc}
        session={session}
        totalSpend={totalSpend}
        callCount={obs.all().length}
      >
        {renderPage(page)}
      </SidebarShell>
      {overlays}
    </>
  );
}
