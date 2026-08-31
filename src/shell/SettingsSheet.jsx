// ─── Settings — the sheet that finally exists ─────────────────────────────────
// Three things had no home before this:
//   · Sign out. supabase.auth.signOut() lived only in the desktop sidebar, so on
//     the phone — the surface actually used every day — there was no way out of
//     the session, and App's SIGNED_OUT purge (which clears the query cache and
//     the three br_* localStorage keys) could never fire.
//   · Which account you're in. Same story.
//   · calendar_url. App passed calUrl/onSaveCalUrl into SidebarShell, which
//     never destructured them — dead props. Meanwhile the Brief's Business
//     Meetings card told you to "link a calendar in the sidebar", pointing at a
//     control that did not exist anywhere in the app. This is that control.
// Opened from both shells so there's one place to look on either platform.
//
// ── It is now the machine room too ───────────────────────────────────────────
// Usage, Status and Miner used to be the Assets page; Assets has left the nav
// and they live here, behind the Systems tab. The reasoning is that none of the
// three is somewhere you GO — they're things you check, on the same footing as
// which theme you're in and which calendar feeds the Brief. Four nav tabs that
// are all daily surfaces beats five where the last one is a machine room.
//
// Two levels of picker, and both are shallow on purpose: the sheet chooses
// Theme or Systems, and Systems chooses which panel. Flattening them into one
// six-item row would put "Colour scheme" and "Miner" on the same shelf.
import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { supabase } from "../lib/supabase.js";
import { NAV } from "./nav.js";
import { Sheet, Cell, CellGroup, Button, Field, SectionHeader, Switch, SwitchRow, Segmented, Spinner, useConfirm } from "../ui/kit.jsx";
import { IcSun, IcMoon, IcAutoTheme, IcCheck } from "../ui/icons.jsx";
import { BriefWidgetList } from "../ui/BriefWidgetList.jsx";
import { PALETTES } from "../design/palettes.js";

// Lazy, and deliberately so: this sheet is imported eagerly by App (it has to be
// openable from anywhere), and SystemsPage carries the whole usage table with
// it. Static imports here would move all of that into the first-load bundle for
// a panel most sessions never open.
const UsageTab = lazy(() => import("../pages/systems/SystemsPage.jsx").then(m => ({ default: m.UsageTab })));
const StatusTab = lazy(() => import("../pages/systems/SystemsPage.jsx").then(m => ({ default: m.StatusTab })));
const MinerPanel = lazy(() => import("../pages/systems/MinerPanel.jsx").then(m => ({ default: m.MinerPanel })));
// Deploy was written and then stranded: DeployTab has lived in SystemsPage.jsx
// since Assets left the nav, exported and imported by nothing. It matters now
// because it is where Rollback lives, and a rollback you cannot reach from the
// phone is not a rollback — it is a Netlify dashboard login during whatever
// went wrong.
const DeployTab = lazy(() => import("../pages/systems/SystemsPage.jsx").then(m => ({ default: m.DeployTab })));
// SupabaseTab was stranded in exactly the same way and did not get picked up
// when Deploy was — same file, same cause (Assets left the nav and took the only
// route to both), exported and mounted nowhere ever since.
//
// It matters for a reason that is written down elsewhere in this repo as a
// design decision. src/data/db.js soft-deletes the two tables that used to lose
// rows outright — dream tiles and Creed lines — and says the row "is destroyed
// thirty days later by `purge deleted > 30d` in netlify/functions/db-admin.js …
// a deliberate, counted act rather than a cron nobody watches". The console
// below is the only thing in the app that issues that command, so with it
// unrouted the deliberate act had nowhere to be performed from: soft-deleted
// rows simply accumulated, and the sentence in db.js described a mechanism that
// existed at both ends and nowhere in the middle. Same for the two prunes beside
// it (auditor_findings, usage_log) and for backup chat_messages.
//
// The commands are allowlisted server-side and db-admin is owner-gated (the
// functions smoke knocks on it three ways), so routing it changes what is
// reachable, never what is permitted.
const SupabaseTab = lazy(() => import("../pages/systems/SystemsPage.jsx").then(m => ({ default: m.SupabaseTab })));

const SHEET_TABS = [{ key: "systems", label: "Systems" }, { key: "theme", label: "Theme" }, { key: "tabs", label: "Tabs" }];
// Account sits with the systems panels rather than in Theme: your calendar feed
// and your session are configuration, and Theme is strictly how it looks.
const SYS_TABS = [
  { key: "usage", label: "Usage" },
  { key: "status", label: "Status" },
  { key: "deploy", label: "Deploy" },
  // Between Deploy and Miner rather than appended, so the strip keeps reading
  // outward from the app: what it costs (Usage), whether it is up (Status), how
  // it ships (Deploy), the database under it (Supabase), the machine beside it
  // (Miner), and you (Account).
  { key: "supabase", label: "Supabase" },
  { key: "miner", label: "Miner" },
  { key: "account", label: "Account" },
];

// Two axes, both here: MODE (below) and PALETTE (the swatch grid). They live
// together because this sheet is what opens from the light/dark button — looking
// for "the colour settings" anywhere else is a detour.
const THEMES = [
  { key: "auto", label: "Auto", sub: "Follows your device", Icon: IcAutoTheme },
  { key: "day", label: "Light", sub: "Always light, whatever the device says", Icon: IcSun },
  { key: "night", label: "Dark", sub: "Always dark, whatever the device says", Icon: IcMoon },
];

// An iCal feed is the only shape calendar-events.js can parse. A Google
// "public HTML" link looks close enough to paste by mistake, so say so before
// the Brief card has to.
const looksLikeIcs = (v) => /^https?:\/\//i.test(v) && !/\/calendar\/(u\/\d+\/)?r($|\?)/i.test(v);

/* A palette rendered as what it actually is: the page ground, a card lifted off
   it, two ink bars, one accent chip. Compact enough for three-up inside a sheet.
   Colours come from design/palettes.js, generated from the same table as
   design/themes.css — so a swatch can't show a colour the theme doesn't use. */
function Swatch({ p, mode, selected }) {
  const c = p[mode];
  return (
    <span aria-hidden style={{
      display: "block", height: 38, borderRadius: 9, background: c.bg, position: "relative",
      // box-shadow, not border: a border would change the box size and reflow the
      // grid every time the selection moved.
      boxShadow: selected
        ? `inset 0 0 0 1px color-mix(in srgb, ${c.ink} 14%, transparent), 0 0 0 2px var(--accent)`
        : `inset 0 0 0 1px color-mix(in srgb, ${c.ink} 14%, transparent)`,
    }}>
      <span style={{ position: "absolute", left: 5, right: 5, top: 7, bottom: 0, borderRadius: 6, background: c.surface }} />
      <span style={{ position: "absolute", left: 10, top: 14, width: 18, height: 3, borderRadius: 2, background: c.ink }} />
      <span style={{ position: "absolute", left: 10, top: 21, width: 11, height: 3, borderRadius: 2, background: c.ink, opacity: 0.45 }} />
      <span style={{ position: "absolute", right: 9, top: 13, width: 11, height: 11, borderRadius: "50%", background: c.accent }} />
    </span>
  );
}

export function SettingsSheet({ onClose, session, theme, calUrl, onSaveCalUrl, isMobile, conn, settings, updateSetting }) {
  // Systems first, and Usage first within it. The sheet is opened from the
  // sun/moon button, so Theme was the obvious landing — but the theme is set
  // once and then never again, while "what has this been spending" is the thing
  // worth a look. The icon is the door, not the destination.
  const [tab, setTab] = useState("systems");
  const [sys, setSys] = useState("usage");
  const [draft, setDraft] = useState(calUrl || "");
  const [saved, setSaved] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const dirty = draft.trim() !== (calUrl || "").trim();
  const warn = draft.trim() && !looksLikeIcs(draft.trim());

  const save = () => {
    onSaveCalUrl(draft.trim());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  };

  const signOut = async () => {
    const ok = await confirm({
      title: "Sign out?",
      message: "This device's cached notes, events, and market data are cleared too. Nothing is deleted from your account.",
      confirmLabel: "Sign out",
      destructive: true,
    });
    if (ok) await supabase.auth.signOut();
  };

  // Status fires ~25 network calls including a paid Anthropic ping, so it must
  // not run because the SHEET opened — only when you actually land on it. That
  // guard matters more now that the sheet opens straight into Systems: without
  // it, every tap of the sun/moon button would bill you for a Claude ping. The
  // hook itself lives in App, so results survive closing and reopening.
  const started = useRef(false);
  useEffect(() => {
    if (tab !== "systems" || sys !== "status" || started.current || !conn) return;
    started.current = true;
    conn.runAll();
  }, [tab, sys]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Sheet title="Settings" onClose={onClose} z={420}>
        <Segmented options={SHEET_TABS} value={tab} onChange={setTab} style={{ marginBottom: 12 }} />

        {tab === "systems" && (
          <div key="systems" className="pagefade" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Segmented options={SYS_TABS} value={sys} onChange={setSys} style={{ marginBottom: 10 }} />
            <Suspense fallback={<div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}><Spinner /></div>}>
              {sys === "usage" && <UsageTab isMobile={isMobile} />}
              {sys === "status" && <StatusTab checks={conn?.checks || {}} lastRun={conn?.lastRun} running={conn?.running} runAll={conn?.runAll} isMobile={isMobile} />}
              {sys === "deploy" && <DeployTab isMobile={isMobile} />}
              {sys === "supabase" && <SupabaseTab />}
              {/* `active` gates the 5s poll — it stops the moment you leave. */}
              {sys === "miner" && <MinerPanel active isMobile={isMobile} />}
            </Suspense>

            {sys === "account" && (
              <>
                <SectionHeader title="Business Meetings" />
                <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.55, padding: "0 4px 10px" }}>
                  The Brief pulls upcoming meetings from a read-only calendar feed. In Google Calendar:
                  Settings → your calendar → <strong style={{ color: "var(--ink)", fontWeight: 600 }}>Secret address in iCal format</strong>.
                  It has to be the <code className="t-num" style={{ fontSize: 12 }}>.ics</code> link, not a shared web page.
                </div>
                <Field
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && dirty) { e.preventDefault(); save(); } }}
                  placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                  inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck="false"
                  aria-label="Calendar iCal URL"
                />
                {warn && (
                  <div className="t-foot" style={{ color: "var(--amber)", lineHeight: 1.5, padding: "8px 4px 0" }}>
                    That doesn't look like an iCal feed — it should end in <code className="t-num" style={{ fontSize: 12 }}>.ics</code>.
                    Saving it anyway is fine; the card will tell you if it can't be parsed.
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 10 }}>
                  <Button kind="tinted" size="md" disabled={!dirty} onClick={save} style={{ flex: "none" }}>
                    {draft.trim() ? "Save calendar" : "Clear calendar"}
                  </Button>
                  {saved && <span className="t-foot" style={{ color: "var(--green)" }}>Saved — the Brief picks it up on the next refresh.</span>}
                </div>

                <SectionHeader title="Account" style={{ marginTop: 20 }} />
                <CellGroup>
                  <Cell
                    title={session?.user?.email || "Signed in"}
                    sub="Synced across every device on this account"
                    titleStyle={{ fontSize: 14.5 }}
                  />
                  <Cell title="Sign out" destructive onClick={signOut} />
                </CellGroup>
              </>
            )}
          </div>
        )}

        {tab === "theme" && (
        <div key="theme" className="pagefade" style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 4 }}>

          <SectionHeader title="Appearance" />
          <CellGroup>
            {THEMES.map(({ key, label, sub, Icon }) => {
              const active = theme.pref === key;
              return (
                <Cell
                  key={key}
                  leading={<Icon size={17} />}
                  leadingTone={active ? "var(--accent)" : undefined}
                  title={label}
                  sub={key === "auto" ? `${sub} — currently ${theme.resolved === "night" ? "dark" : "light"}` : sub}
                  onClick={() => theme.setPref(key)}
                  trailing={active
                    ? <span style={{ color: "var(--accent)", display: "inline-flex", flex: "none" }}><IcCheck size={15} /></span>
                    : null}
                />
              );
            })}
          </CellGroup>

          {/* The palette grid previews every scheme in the mode CURRENTLY in force,
              so what you see is what tapping it gives you. Both axes on one screen
              is the point: choosing a "dark" scheme while pinned to Light would
              otherwise read as the picker being broken. */}
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, padding: "16px 4px 8px" }}>
            <span className="t-label">Colour scheme</span>
            <span className="t-cap" style={{ color: "var(--faint)" }}>
              {PALETTES.find(p => p.key === theme.palette)?.label || "Porcelain"}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            {PALETTES.map((p) => {
              const selected = p.key === theme.palette;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => theme.setPalette(p.key)}
                  aria-pressed={selected}
                  aria-label={`${p.label} — ${p.blurb}`}
                  title={p.blurb}
                  className="press"
                  style={{
                    display: "flex", flexDirection: "column", gap: 5, minWidth: 0,
                    padding: 7, borderRadius: 12, border: "none", cursor: "pointer",
                    textAlign: "left", font: "inherit",
                    background: selected ? "var(--accent-a12)" : "var(--surface-2)",
                  }}
                >
                  <Swatch p={p} mode={theme.resolved === "night" ? "night" : "day"} selected={selected} />
                  <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                    <span className="t-cap" style={{ fontWeight: 650, color: "var(--ink)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</span>
                    {selected && <span style={{ color: "var(--accent)", display: "inline-flex", flex: "none" }}><IcCheck size={11} /></span>}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, padding: "8px 4px 0" }}>
            Every scheme has a light and a dark version — the rows above choose which.
            Status colours stay put: green still means live in all twenty.
          </div>

          {/* The third appearance axis. Off is a real answer — on a small phone
              screen the wash is mostly hidden behind cards anyway, and some
              people simply don't want anything moving. Device-local (br_ambient),
              like the other two: appearance follows the screen, not the account. */}
          <SectionHeader title="Ambience" style={{ marginTop: 16 }} />
          <CellGroup>
            <SwitchRow
              title="Drifting light"
              sub="A slow wash of the accent colour behind the room"
              on={theme.ambient}
              onToggle={() => theme.setAmbient(!theme.ambient)}
            />
          </CellGroup>
          <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, padding: "8px 4px 0" }}>
            It never moves under text — cards and lists are solid. If your device asks
            for reduced motion, the light stays and the drifting stops.
          </div>

        </div>
        )}

        {tab === "tabs" && (() => {
          // The bar's shape lives in app_settings.navigation = {order, hidden}
          // (account-scoped, unlike the device-local theme prefs): which rooms
          // exist, and in what sequence, is a fact about the house, not about
          // the phone in your hand. The schema predates this panel — the
          // restored production build wrote it — so it is read and written
          // as stored. The bar updates live behind the sheet.
          const navSet = settings?.navigation || {};
          const hidden = new Set(
            Array.isArray(navSet.hidden) ? navSet.hidden
              : Array.isArray(settings?.hidden_tabs) ? settings.hidden_tabs : []);
          const byKey = new Map(NAV.map((n) => [n.key, n]));
          const saved = (Array.isArray(navSet.order) ? navSet.order : []).map((k) => byKey.get(k)).filter(Boolean);
          const ordered = saved.length ? [...saved, ...NAV.filter((n) => !saved.includes(n))] : [...NAV];
          const rows = ordered.filter((n) => n.key !== "brief");
          const write = (rowsNext, hiddenNext) =>
            updateSetting?.("navigation", { order: ["brief", ...rowsNext.map((n) => n.key)], hidden: [...hiddenNext] });
          const toggle = (key) => {
            const h = new Set(hidden);
            if (h.has(key)) h.delete(key); else h.add(key);
            write(rows, h);
          };
          const move = (i, d) => {
            const j = i + d;
            if (j < 0 || j >= rows.length) return;
            const next = rows.slice();
            [next[i], next[j]] = [next[j], next[i]];
            write(next, hidden);
          };
          const arrowStyle = {
            width: 34, height: 34, borderRadius: 9, border: "none", cursor: "pointer",
            background: "var(--surface-2)", color: "var(--sub)", fontSize: 14, lineHeight: 1, flex: "none",
          };
          return (
            <div key="tabs" className="pagefade" style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 4 }}>
              <SectionHeader title="The bar" />
              <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "2px 12px" }}>
                {rows.map((n, i) => (
                  <div key={n.key} style={{
                    display: "flex", alignItems: "center", gap: 8, minHeight: 52,
                    borderTop: i === 0 ? "none" : "1px solid var(--line)",
                    opacity: hidden.has(n.key) ? 0.55 : 1,
                  }}>
                    <span style={{ flex: 1, minWidth: 0 }}>{n.label}</span>
                    <button aria-label={`Move ${n.label} earlier`} style={arrowStyle} onClick={() => move(i, -1)}>↑</button>
                    <button aria-label={`Move ${n.label} later`} style={arrowStyle} onClick={() => move(i, 1)}>↓</button>
                    <Switch on={!hidden.has(n.key)} onToggle={() => toggle(n.key)} aria-label={n.label} />
                  </div>
                ))}
              </div>
              <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.5, padding: "8px 4px 0" }}>
                Arrows set the bar's order; the switch takes a tab out of the phone
                bar and the tablet rail — its page stays reachable from links inside
                the app. Brief isn't listed because it can't move or go: it's the
                front door, first on the bar, and the one tab that always leads home.
              </div>
              {/* The same act one level down. The bar decides which rooms exist;
                  this decides what's in the one you land in — and it is HERE, not
                  only in the desktop Brief's Layout sheet, because the phone has
                  no Layout button and the phone is where the Brief is read. */}
              <BriefWidgetList settings={settings} updateSetting={updateSetting} />
            </div>
          );
        })()}
      </Sheet>
      {confirmEl}
    </>
  );
}
