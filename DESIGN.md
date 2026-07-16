# SESSION — the Board Room design language

*(v2 · July 2026 · replaces "modern roman". One designer's hand, everywhere.)*

The room no longer announces itself. It defers. Typography is the platform's own
(San Francisco on the devices this app actually lives on — iPhone and iPad),
surfaces separate by tone instead of borders, and the single gold accent is
spent like real money: rarely, and only where it buys something. Every screen
should feel like it was machined from one piece of material.

**Codename:** SESSION. **Themes:** *Porcelain* (light) and *Graphite* (dark —
true-black, OLED). Theme storage keys stay `day` / `night` — never migrate
`br_theme`.

---

## 1. Principles (the taste test for every screen)

1. **Deference.** Chrome recedes; content — numbers, words, the day — leads.
   If an element doesn't help the user *right now*, it doesn't get ink.
2. **One material.** Cards are white (light) / elevated graphite (dark), no
   outlines. Separation comes from tone and soft shadow, never from borders.
   Hairlines exist only *inside* lists, inset, and on glass edges.
3. **Type does the work.** Sentence case. No decorative fonts. Hierarchy from
   size + weight + tone, not tracking theatrics. Uppercase survives in exactly
   one place: 12px section labels.
4. **One accent.** Gold appears on: the active tab, the primary action, live
   indicators, and selected states. Nowhere else. Data colors are semantic and
   validated (§4). If a screen shows gold more than three times, it's wrong.
5. **Numbers are instruments.** Tabular, monospaced, tweened. They never jiggle.
6. **Motion is physics, not decoration.** Everything answers touch in <100ms.
   Entrances are quiet (4px rise). Nothing blurs, nothing bounces except sheets.
7. **Flawless means the edges.** Safe areas, keyboard, landscape, empty states,
   loading, errors, reduced motion, focus rings — designed, not defaulted.

---

## 2. Type

System stack only — on iPhone/iPad this is San Francisco; no webfonts, no FOUT:

```css
--font-body: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-display: var(--font-body);           /* kept for compat — same family */
--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
```

Scale (utility classes in `src/design/components.css`; use them, don't restate):

| class | size/line | weight | tracking | use |
|---|---|---|---|---|
| `.t-ltitle` | 32/1.15 | 700 | -0.022em | page large title (one per page) |
| `.t-title1` | 26/1.2 | 700 | -0.02em | hero numbers' companions, sheet titles |
| `.t-title2` | 21/1.25 | 700 | -0.015em | card headlines that ARE content |
| `.t-head`   | 17/1.3 | 600 | -0.01em | cell titles, card titles |
| `.t-body`   | 15/1.5 | 400 | 0 | reading text, chat |
| `.t-call`   | 13.5/1.45 | 400 | 0 | secondary copy |
| `.t-foot`   | 12.5/1.4 | 400 | 0 | metadata under things |
| `.t-cap`    | 11.5/1.3 | 500 | 0 | smallest annotations |
| `.t-label`  | 12/1 | 600 | 0.05em, uppercase | section headers, `color: var(--sub)` |
| `.t-num`    | — | 500 | — | mono + tabular-nums; add a size class |

Hard floor: **10.5px**. Nothing smaller, ever (the old 7.5–9px labels are gone).
Body copy on cards is `--ink`; supporting copy `--sub`; annotations `--faint`.

## 3. Color

Same CSS-variable names as before (every legacy inline style keeps resolving);
new values. `--brass*` aliases `--accent*` during migration.

### Porcelain (light) — `:root, [data-theme="day"]`
```
--bg: #F2F1EB;        /* warm porcelain canvas */
--surface: #FFFFFF;   /* cards */
--surface-2: #F6F5F0; /* wells, inputs on cards, inner tiles */
--ink: #1D1C18;  --sub: #716E64;  --faint: #A3A099;
--line: rgba(29,28,24,0.08);  --line-strong: rgba(29,28,24,0.16);
--accent: #8A6A1E;  --accent-hi: #A5822A;  --accent-deep: #6E541A;  --on-accent: #FFFFFF;
--green: #278A4C; --red: #C93B32; --amber: #B36514; --blue: #3568D4;
--purple: #6B41C4; --pink: #C7447E; --btc: #F7931A;
--glass: rgba(242,241,235,0.82);  --glass-raised: rgba(255,255,255,0.88);
--scrim: rgba(22,20,14,0.42);
--shadow-card: 0 1px 1px rgba(26,22,14,0.03), 0 6px 24px rgba(26,22,14,0.05);
--shadow-float: 0 12px 40px rgba(26,22,14,0.16);
--shadow-deep: 0 24px 70px rgba(26,22,14,0.26);
--canvas-wash: none;  /* the canvas is honest — no gradients */
```

### Graphite (dark) — `[data-theme="night"]`
```
--bg: #000000;        /* OLED true black */
--surface: #1C1C1E;   /* elevated card (Apple secondary grouped) */
--surface-2: #2A2A2D; /* wells on cards */
--ink: #F3F2EE;  --sub: #A8A69F;  --faint: #6E6C66;
--line: rgba(243,242,238,0.09);  --line-strong: rgba(243,242,238,0.18);
--accent: #D9B45C;  --accent-hi: #EACC80;  --accent-deep: #B08F3E;  --on-accent: #1A1403;
--green: #34A56E; --red: #E05548; --amber: #BC7F24; --blue: #4C82E8;
--purple: #9673E6; --pink: #D95C93; --btc: #F7931A;
--glass: rgba(12,12,13,0.76);  --glass-raised: rgba(28,28,30,0.92);
--scrim: rgba(0,0,0,0.6);
--shadow-card: 0 1px 1px rgba(0,0,0,0.3), 0 6px 24px rgba(0,0,0,0.35);
--shadow-float: 0 12px 40px rgba(0,0,0,0.55);
--shadow-deep: 0 24px 70px rgba(0,0,0,0.7);
--canvas-wash: none;
```

Alpha ladders (`--ink-a02…a25`, `--accent-a06…a55` + `--brass-a*` aliases) are
generated from the ink/accent above — see tokens.css; use the ladder, never
ad-hoc rgba.

**Data palette (validated 2026-07-15 with the dataviz six-checks validator, both
modes PASS):** adjacency order for multi-series/legends is
`green, blue, red, purple, amber, pink`. Charts: single series needs no legend;
line weight 2px; area fills 8–10% alpha; grid lines off, baseline only
(`--line`); axis text `--faint` 10.5px mono. Status colors (green/red/amber)
never do series-identity work. Text never wears a series color — values sit in
ink with a colored mark beside them.

## 4. Shape, elevation, material

- Radii: **cards 18** · **inner tiles/wells 12** · **controls 10** · **pills/switches 999**. Sheets: 22 top corners (phone), 18 (tablet modal).
- Cards: `background: var(--surface); border: none; box-shadow: var(--shadow-card)`.
  **Never** a border + shadow together. Inner wells: `--surface-2`, no shadow.
- Hairlines: only as inset row separators inside CellGroups (`margin-left`
  aligned to text), and the 0.5px edge on glass chrome.
- Glass (header/tab bar/sheets): `backdrop-filter: blur(20px) saturate(1.8)`
  over `--glass`; hairline on the content side.
- Focus: `box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent-a55)` on
  `:focus-visible` only.

## 5. Motion

Keep the existing token set — it's already right:
`--dur-1:140ms --dur-2:240ms --dur-3:420ms --dur-4:700ms`, eases unchanged.
Rules: press = scale(0.97); entrances = opacity + 4px rise (no blur, no filter);
page slide ±16px; sheet spring `--ease-spring`; stagger 30ms, cap 6 children,
**first mount of a page only**. Reduced motion kills everything (already wired —
keep the block). **Never animate color properties** (Chromium wedge — see the
comment in styles.css; the theme flips via the veil in theme.js).

## 6. The kit (`src/ui/kit.jsx` + `src/design/components.css`)

Use these — do not hand-roll equivalents. (Signatures are final; read kit.jsx.)

- `<Card>` / `<Card pressable onClick pad="lg|md|sm">` — the only card.
- `<SectionHeader title trailing>` — `.t-label` + optional trailing link.
- `<CellGroup>` + `<Cell leading title sub value trailing chevron onClick destructive>` —
  inset-grouped lists (Settings/Health grammar). 44pt minimum row height.
- `<StatTile value label delta deltaTone tone selected onClick>` — hero numbers.
- `<Button kind="primary|tinted|ghost|plain" size="lg|md|sm" full disabled>` —
  primary = accent fill (one per screen).
- `<Segmented options value onChange>` (≤4, equal width) ·
  `<PillRow options value onChange>` (scrollable, snap, for 5+).
- `<Sheet open onClose title footer detent>` — phone: bottom sheet, grabber,
  spring, safe-area padding; ≥761px: centered modal. (ModalShell shims to this.)
- `<Field>` / `<TextArea>` — 44pt, `--surface-2`, focus ring. 16px font on
  mobile (iOS zoom rule — keep the CSS guard).
- `<Switch on onToggle>` — 51×31 iOS proportions. (Toggle shims to this.)
- `<EmptyState icon title sub action>` — every empty/error/not-connected state.
- `<Spinner>`, `<Dot tone>` (status dot), `<Delta value>` (▲/▼ + tone).
- Icons: `src/ui/icons.jsx` — 24×24 grid, 1.8 stroke, round caps/joins,
  SF-Symbols-adjacent geometry. No emoji in chrome.

## 7. Structure (the shells)

**Breakpoint stays 760px** (`useIsMobile`). Preserve every iOS standalone
workaround verbatim: vvh-pinned shell, in-flow dock, `.lbx` letterbox rule,
keyboard-open dock hide, focusin re-center, swipe navigation, 5-tap title
diagnostics, theme pre-paint script, meta theme-color sync (update its two hex
values to `#F2F1EB` / `#000000` — also in manifest + index.html).

### Phone
- **Nav bar:** glass, compact (48px + safe top). Centered page title 16/600
  that fades in only after the large title scrolls away (sentinel +
  IntersectionObserver). Left: nothing. Right: theme toggle + Summon + refresh —
  quiet 34pt icon buttons, no boxes.
- **Large title block** at the top of every page: `.t-ltitle` + one-line
  `.t-foot` sub in `--sub` (the old HEADERS subtitles, rewritten sentence-case).
- **Tab bar:** true iOS grammar — 5 tabs, glass, 49pt + `env(safe-area-inset-bottom)`
  *inside* the bar, icon 24 + 10px/600 label, active = `--accent` (icon fills),
  inactive = `--faint`. No ember, no pill behind the icon.
- Page gutter 16px; card gap 12px; section gap 28px.

### Tablet / desktop (≥761px)
- **Sidebar** 300px, canvas-colored (not a card): wordmark row (18/700 +
  gold mark), nav groups with `.t-label` headers — TODAY: Brief · Personal;
  THE FIRM: Board · Assets · Systems. Rows 44pt, icon + 15/600 label,
  active = accent tint wash `--accent-a10` + accent icon.
  Footer: BTC mini-tile, calendar link, account row (email · theme · sign out).
- **Content column:** header row (large title + sub, right-aligned status
  cluster), max-width 1120 centered, gutter 28px; cards flow in a 12-col grid —
  Brief uses 2 columns ≥1000px, panels define their own (see §8).
- Sheets become centered modals (max-width 560) with scrim.

## 8. Per-page notes

*(Layout intent; the panel's data/logic is untouchable — restyle, don't rewrite
behavior.)*

- **Brief** — the flagship. Large title is the greeting ("Tuesday, July 15" as
  sub). Docket card first (the Word reads as `.t-title2` serifless prose, quiet
  chips), Notes capture second, then MARKET section (BTC outlook card with
  levels as StatTiles, stocks, chart modal), then SIGNALS (GSC, wires,
  shops). Every card: `.t-head` title + optional `.t-cap` status at right —
  status text pills become `<Dot tone> + .t-cap`, not filled badges.
- **Personal** — PillRow of sections (Notes & Calendar first). Notes: capture
  field + 2-col masonry preview cards (phone 1-col), pinned = subtle accent
  hairline top. Calendar: month grid with 44pt targets, event dots in category
  colors (validated palette), agenda as CellGroup.
- **Board** — chat is the room: full-height thread, user bubbles = accent-tinted
  (`--accent-a10`, no border), assistant = surface card; consulted-seat chips =
  `<Dot>` + name in `.t-cap`; composer = floating glass field above tab
  bar/keyboard with accent send. Seats/Mini/Learn under a Segmented.
- **Assets** — property cards as CellGroup (favicon-ish leading mark, name,
  domain, trailing status Dot + chevron); auditor below.
- **Systems** — pure Settings grammar: CellGroups per subsystem, usage as
  StatTiles + one thin bar chart, connections as Cells with status Dots.
- **Login/Boot** — the seal survives, redrawn: a 1.5px gold ring that draws
  itself + a small solid gold square rotated 45° landing in the center; wordmark
  17/600, sub `.t-foot`. Login card: borderless white card, two Fields, one
  primary Button. Quietest screen in the app.

## 9. File structure (restructure target)

```
src/
  main.jsx                     (unchanged)
  App.jsx                      (≈300 lines: state, data, send/oversight, routing)
  theme.js                     (same API — THEME_COLORS updated)
  styles.css                   (imports design/*.css; base+utilities only)
  design/tokens.css            (all custom properties, both themes)
  design/components.css        (kit + shell styles, type classes)
  ui/kit.jsx  ui/icons.jsx  ui/primitives.jsx  ui/styles.js (S → new values)
  shell/MobileShell.jsx  shell/SidebarShell.jsx  (chrome, nav, diag)
  shell/Boot.jsx  shell/Login.jsx  (seal, entrance, setup notice)
  shell/Summon.jsx
  pages/brief/BriefPage.jsx    (+ pieces it needs)
  pages/personal/PersonalPage.jsx  pages/personal/NotesPanel.jsx  pages/personal/CalendarPanel.jsx
  pages/board/BoardPage.jsx    (room, seats, mini me, modals)
  pages/assets/AssetsPage.jsx
  pages/systems/SystemsPage.jsx
  WorkoutPanel.jsx  LearnPanel.jsx  features/*  (in place, restyled)
```

## 10. Untouchables (behavior-preservation contract)

- localStorage keys (`br_*`), settings keys, Supabase tables/columns, query
  keys, netlify function paths, PREVIEW mode semantics (`VITE_PREVIEW=1`, `?p=`,
  `?view=`), deep-link `jump` shape, Summon behaviors, oversight, migration
  modal, `.env` handling.
- All hard-won iOS comments/workarounds (§7) — move them, never delete.
- `useTween`/NumTween on metrics; `cssVar()` for canvas charts;
  lightweight-charts wiring (restyle options only: no vertical grid, `--line`
  horizontal grid, `--faint` mono axis text, 2px series).
- Feature parity is absolute: every control in the old UI exists in the new.
```
