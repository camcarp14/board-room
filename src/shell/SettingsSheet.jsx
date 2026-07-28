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
import { useState } from "react";
import { supabase } from "../lib/supabase.js";
import { Sheet, Cell, CellGroup, Button, Field, SectionHeader, SwitchRow, useConfirm } from "../ui/kit.jsx";
import { IcSun, IcMoon, IcAutoTheme, IcCheck } from "../ui/icons.jsx";
import { PALETTES } from "../design/palettes.js";

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

export function SettingsSheet({ onClose, session, theme, calUrl, onSaveCalUrl, isMobile }) {
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

  return (
    <>
      <Sheet title="Settings" onClose={onClose} z={420}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 4 }}>

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

          <SectionHeader title="Business Meetings" style={{ marginTop: 14 }} />
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
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
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

          {!isMobile && (
            <div className="t-cap" style={{ color: "var(--faint)", padding: "16px 4px 0", lineHeight: 1.5 }}>
              ⌘K opens Summon from anywhere.
            </div>
          )}
        </div>
      </Sheet>
      {confirmEl}
    </>
  );
}
