import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { supabase } from "./lib/supabase.js";
import { sm, obs } from "./lib/storage.js";
import { db } from "./data/db.js";
import { queryClient } from "./lib/queryClient.js";
import { callClaude, convene, DEFAULT_MODELS } from "./lib/claude.js";
import { parseLearnCommand, learnFromInput, makeSdb as makeSkillsDb } from "./LearnPanel.jsx";
import { useThemeController, useIsMobile, useBitcoinPrice } from "./hooks/index.js";
import { NAV } from "./shell/nav.js";
import { MobileShell } from "./shell/MobileShell.jsx";
import { SidebarShell } from "./shell/SidebarShell.jsx";
import { Summon } from "./shell/Summon.jsx";
import { BootScreen, LoginScreen, SetupNotice } from "./shell/Boot.jsx";
import { ErrorBoundary } from "./shell/ErrorBoundary.jsx";
import { Sheet, Button, useConfirm } from "./ui/kit.jsx";
// The Brief is the landing tab — keep it in the main chunk so first paint is
// immediate. The other four pages (and their heavier panels) split into their
// own chunks and load the first time you open that tab.
import { MorningBriefPage } from "./pages/brief/BriefPage.jsx";
import { SeatNotesModal } from "./pages/board/SeatNotesModal.jsx";
const PersonalPage = lazy(() => import("./pages/personal/PersonalPage.jsx").then(m => ({ default: m.PersonalPage })));
const TrainPage = lazy(() => import("./pages/train/TrainPage.jsx").then(m => ({ default: m.TrainPage })));
const BoardRoomPage = lazy(() => import("./pages/board/BoardPage.jsx").then(m => ({ default: m.BoardRoomPage })));
const PropertiesPage = lazy(() => import("./pages/assets/AssetsPage.jsx").then(m => ({ default: m.PropertiesPage })));
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
  const [page, setPage] = useState(() => previewParam("p") || "assets"); // single nav state — Assets is the landing tab (same source of truth on mobile and desktop)
  const [dataStamp, setDataStamp] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const endRef = useRef(null);

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
      const [chat, notes, sets] = await Promise.all([db.loadChat(), db.loadSeatNotes(), db.loadSettings()]);
      setMessages(chat); setSeatNotes(notes); setSettings(sets);
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
    if (!session?.user) { setMessages([]); setSeatNotes({}); setSettings(null); return; }
    let alive = true;
    setLoadingData(true);
    (async () => {
      let chat, notes, sets;
      try {
        [chat, notes, sets] = await Promise.all([db.loadChat(), db.loadSeatNotes(), db.loadSettings()]);
      } catch {
        // A load failed (offline, RLS blip). Don't clobber whatever we already
        // have, and don't get stuck on skeletons — just drop the loading state
        // so the persisted query cache / prior state shows through.
        if (alive) setLoadingData(false);
        return;
      }
      if (!alive) return;
      setMessages(chat); setSeatNotes(notes); setSettings(sets);
      setDataStamp(Date.now());
      setLoadingData(false);
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

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...(prev || {}), [key]: value }));
    db.saveSetting(key, value);
  };
  const saveSeatNote = async (key, notes) => {
    setSeatNotes(prev => ({ ...prev, [key]: notes }));
    await db.saveSeatNote(key, notes);
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
      const chat = await db.loadChat();
      setMessages(chat);
      setSeatNotes(prev => ({ ...prev, ...localNotes }));
    } catch {}
    setImporting(false);
    setMigration(null);
  };
  const skipImport = () => { sm.set("migrated", true); setMigration(null); };

  // Scroll the active page back to top on nav tap — smooth if there's
  // actually somewhere to scroll from, skipped entirely if already at top
  // so it's not a pointless animation on every tap.
  const goToPage = (key) => {
    // Systems folded into Assets — honor any stray "systems" deep link
    // (old Summon muscle memory, saved links) by landing on Assets.
    if (key === "systems") key = "assets";
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
    // Two migrations honored here: Workout graduated from Personal to its own
    // Train tab, and Systems folded into Assets (its panels are Assets sub-tabs).
    let t = target.page === "personal" && target.sub === "workout" ? { ...target, page: "train", sub: undefined } : target;
    if (t.page === "systems") t = { ...t, page: "assets", sub: t.sub || "status" };
    goToPage(t.page);
    setJump({ t: Date.now(), ...t });
  };
  const summonGo = (target) => { setSummon(false); jumpTo(target); };
  // Free text in Summon → the question lands in the Room already sent — the
  // board convenes while the page slides over. (send is defined below; it only
  // runs on click, well after initialization.)
  // Summon's free-text "ask" now goes to the Mind: open the neural canvas and
  // hand the question to its Pulse (MindPanel fires it once off jump.ask).
  const summonAsk = (q) => { setSummon(false); jumpTo({ page: "boardroom", sub: "neural", ask: q }); };
  const summonJot = async (text) => {
    await db.saveNote({ id: crypto.randomUUID(), title: "", body: text });
    queryClient.invalidateQueries({ queryKey: ["notes"] }); // jots show up in Notes surfaces immediately, not after the cache goes stale
  };
  const summonQueueTask = async (text) => {
    const t = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, status: "queued", queued_at: Date.now() };
    updateSetting("mini_tasks", [t, ...(settings?.mini_tasks || [])]);
  };
  const summonEl = summon ? <Summon onClose={() => setSummon(false)} onGo={summonGo} onJot={summonJot} onQueueTask={summonQueueTask} onAsk={summonAsk} isMobile={isMobile} /> : null;
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
        await supabase.from("mini_feed").insert({ user_id: (await supabase.auth.getUser()).data?.user?.id, text: `Oversight: ${verdict.trim()}` });
      }
    } catch { /* best-effort — never surface oversight failures to the user */ }
  };

  if (previewParam("view") === "setup") return <SetupNotice />;
  if (previewParam("view") === "login") return <LoginScreen />;
  if (previewParam("view") === "boot") return <BootScreen />;
  if (!supabase) return <SetupNotice />;
  if (!authChecked && !PREVIEW) return <BootScreen />;
  if (!session && !PREVIEW) return <LoginScreen />;

  const calUrl = settings?.calendar_url || "";
  const totalSpend = obs.all().reduce((s, l) => s + (l.cost || 0), 0);

  const renderPageInner = (key) => {
    switch (key) {
      case "brief": return <MorningBriefPage btc={btc} isMobile={isMobile} settings={settings} updateSetting={updateSetting} onOpenCalendar={goToCalendar} onAddEvent={(date) => jumpTo({ page: "personal", sub: "calendar", newEventDate: date })} onOpenNotes={(noteId) => summonGo({ page: "personal", sub: "notes", noteId })} onOpenQueue={() => jumpTo({ page: "boardroom", sub: "mini" })} onOpenBirthdays={() => jumpTo({ page: "personal", sub: "birthdays" })} refreshSignal={briefRefreshSignal} />;
      case "boardroom": return <BoardRoomPage settings={settings} updateSetting={updateSetting} session={session} onWorkerRun={refreshData} onSkillsChanged={refreshSkills} jump={jump} isMobile={isMobile} skills={skills} />;
      case "personal": return <PersonalPage isMobile={isMobile} jumpSignal={personalJumpTo} jump={jump} settings={settings} updateSetting={updateSetting} />;
      case "train": return <TrainPage isMobile={isMobile} settings={settings} updateSetting={updateSetting} jump={jump} />;
      case "assets": return <PropertiesPage isMobile={isMobile} settings={settings} updateSetting={updateSetting} session={session} btc={btc} jump={jump} />;
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
      {confirmEl}
      {summonEl}
      {editSeat && <SeatNotesModal seatKey={editSeat} initial={seatNotes[editSeat]} onSave={saveSeatNote} onClose={() => setEditSeat(null)} isMobile={isMobile} />}
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
        calUrl={calUrl}
        onSaveCalUrl={(v) => updateSetting("calendar_url", v)}
        totalSpend={totalSpend}
        callCount={obs.all().length}
      >
        {renderPage(page)}
      </SidebarShell>
      {overlays}
    </>
  );
}
