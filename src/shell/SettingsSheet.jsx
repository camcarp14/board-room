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
import { Sheet, Cell, CellGroup, Button, Field, SectionHeader, useConfirm } from "../ui/kit.jsx";
import { IcSun, IcMoon, IcAutoTheme, IcCheck } from "../ui/icons.jsx";

// Light/dark MODE only. Which of the 20 colour schemes is a separate axis, and it
// lives in Assets → Theme where there's room to show swatches.
const THEMES = [
  { key: "auto", label: "Auto", sub: "Follows your device", Icon: IcAutoTheme },
  { key: "day", label: "Light", sub: "Always light, whatever the device says", Icon: IcSun },
  { key: "night", label: "Dark", sub: "Always dark, whatever the device says", Icon: IcMoon },
];

// An iCal feed is the only shape calendar-events.js can parse. A Google
// "public HTML" link looks close enough to paste by mistake, so say so before
// the Brief card has to.
const looksLikeIcs = (v) => /^https?:\/\//i.test(v) && !/\/calendar\/(u\/\d+\/)?r($|\?)/i.test(v);

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
