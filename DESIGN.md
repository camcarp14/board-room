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
new values. The `--brass*` aliases are gone — every call site is migrated, so the
palette has one name per colour again.

The two blocks below are the authored rooms. `scripts/gen-themes.mjs` parses the
seven semantic colours straight out of tokens.css rather than restating them: it
pins these hexes verbatim for Porcelain and Graphite, and re-solves them for the
other eighteen palettes against the grounds it builds from its own theme table
(see "the semantic seven" below). tokens.css stays the source of truth for what
each colour *means*; `src/design/themes.css` is generated and must never be edited
by hand.

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
--shadow-lift: 0 2px 3px rgba(26,22,14,0.04), 0 10px 30px rgba(26,22,14,0.09);  /* pressable card, hovered */
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
--shadow-lift: 0 2px 3px rgba(0,0,0,0.34), 0 10px 30px rgba(0,0,0,0.48);
```

### The semantic seven — solved per palette, not authored per mode

`--green --red --amber --blue --purple --pink --btc` used to be the exception to
everything above: authored once per mode in the blocks above and inherited
unchanged by all twenty palettes, on the grounds that they mean something fixed
(good / bad / warning) and re-tinting them would spend meaning on decoration. That
argument holds for **hue**, and only for hue — it was quietly holding *lightness*
fixed too, against two surfaces that eighteen of the twenty palettes never show.
`scripts/gen-themes.mjs` now solves each one against its own palette's
`--bg` / `--surface` / `--surface-2`:

- **Hue is held exactly** — under half a degree, which is round-trip slop through
  8-bit RGB and nothing more. A solver allowed to rotate red toward orange would
  clear every floor below and quietly turn "overdue" into "warning".
- **Chroma is held or raised, never dropped**, and capped 30 points of saturation
  above the authored value so nothing solves its way into neon. Pink is not a hue —
  it is a light red with the chroma taken out of it — so lifting lightness without
  re-solving saturation is exactly how a lightened `--red` reads as `--pink`.
- **Only lightness searches.** It walks from the authored value in one direction
  (darker on a light ground, lighter on a dark one, which is what lets one walk
  satisfy all three surfaces at once) and stops at the first half-point step that
  clears every floor, so a colour moves as little as its palette demands. One that
  already clears is returned as the authored hex, untouched.
- **Two real WCAG floors, not one comfortable one.** 4.5:1 on `--bg` and
  `--surface`, where these colours dress text (Docket tags and Status labels at
  11.5px, destructive cell titles at 15.5px); 3:1 on `--surface-2`, where they
  dress `.stattile-value` at 19/600, which is AA large text. `--btc` is a brand
  fill and never text — both call sites are a filled disc carrying its own glyph —
  so it is held to 1.4.11's 3:1 on all three and no more, which keeps it
  recognisably Bitcoin orange instead of solving it into a passing brown.

**Porcelain and Graphite are pinned byte-exact**, and the generator checks the
pins for *identity* rather than for contrast. They are the two designed rooms, and
a generator that "improved" the default palette's red would restyle the room
Cameron looks at every day out from under him. The caveat is real and one-sided:
Graphite as authored happens to clear all three floors, and **Porcelain does not.**
Measured on its own surfaces, `--green` (3.85:1 on `--bg`, 4.35:1 on `--surface`),
`--amber` (3.88 / 4.39), `--pink` (4.07 on `--bg`) and `--red` (4.47 on `--bg`)
sit under the 4.5:1 that the other eighteen palettes all meet, and `--btc` is
2.03–2.30:1 against its 3:1 mark floor. So Porcelain — the house default — is the
one place these numbers go unmet, by decision rather than by accident. If they are
ever to be met, the fix is a new authored hex in tokens.css, chosen deliberately —
never a loosened floor in the generator.

### The canvas — one wash, and only one (`design/ambient.css`)

The old rule said the canvas is honest: no gradients, `--canvas-wash: none`. It
now has exactly one exception, and the exception is the reason the rule can
stay everywhere else. **`.ambient`** is a single fixed layer at `z-index: -1`
carrying three enormous, very soft pools of accent light that drift on 54s /
63s / 78s cycles. Nothing else in the building may use a gradient.

It earns the exemption by never touching content: cards, cells and sheets stay
opaque, so the wash reads only in the gutters, above the large title, and
through the glass of the tab bar. Content legibility is untouched by
construction, not by tuning.

- **Recipe is token-derived, never authored per palette.** Day *lifts* the
  accent toward `--surface` first (`--amb-lift-*`) and then applies alpha —
  every day-mode accent is dark by construction (4.6:1 on white), so a raw tint
  reads as a stain, not as light. Night uses the accent unlifted; it is already
  the bright end of its palette. All 20 schemes × 2 modes work with no per-
  palette code, and a 21st would too.
- **Transform only.** No `filter: blur()` (a per-frame repaint iOS charges
  dearly for) — the soft edge is the radial gradient's own falloff. Three
  composited layers, ~1.2px/s of travel: you should notice the room looks
  different, never that something moved.
- **Grain is load-bearing, not texture.** An 11%-alpha gradient across a phone
  screen crosses barely a dozen 8-bit steps, which on OLED black are visible
  rings. Static desaturated noise dithers them away.
- **`z-index: -1` is fragile on purpose.** In the root stacking context it
  paints after html's ground but *before* any in-flow block's background — so
  an opaque `body` or `#root` hides the whole layer, silently. `html` keeps the
  ground; nothing below it may paint one. `scripts/ambient-smoke.mjs` asserts
  this, along with the reduced-motion gate and the token-only palette.
- **Two off switches.** Settings → Ambience (`br_ambient`, device-local,
  defaults on) removes the layer entirely. `prefers-reduced-motion` keeps the
  light and freezes the drift at mid-cycle — those users get the same room
  standing still, not a flatter app.

Alpha ladders (`--ink-a02…a25`, `--accent-a06…a55`) are generated from the
ink/accent above — see tokens.css; use the ladder, never ad-hoc rgba. The
`--red-a* / --amber-a* / --green-a*` steps `color-mix` off the semantic seven, so
they follow whatever a palette solved for itself.

**Data palette:** adjacency order for multi-series/legends is
`green, blue, red, purple, amber, pink`. The dataviz six-checks validator pass on
2026-07-15 was against `#FFFFFF` and `#1C1C1E` — the Porcelain and Graphite cards,
which is now the pinned pair and nothing else; every other palette's seven are
solved and contrast-checked by the generator on every run, and `theme-smoke.mjs`
re-checks them with its own copy of the floors. Charts: single series needs no legend;
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
  `:focus-visible` only — and it applies to `[role="button"]` / `[tabindex]`
  too, not just `<button>`. A Card with `onClick` is a focusable div; it showed
  nothing for it until that rule existed.

## 5. Motion

Keep the existing token set — it's already right:
`--dur-1:140ms --dur-2:240ms --dur-3:420ms --dur-4:700ms`, eases unchanged.
Rules: press = scale(0.97); entrances = opacity + 4px rise (no blur, no filter);
page slide ±16px; sheet spring `--ease-spring`; stagger 30ms, cap 6 children,
**first mount of a page only**. Reduced motion kills everything (already wired —
keep the block). **Never animate color properties** (Chromium wedge — see the
comment in styles.css; the theme flips via the veil in theme.js).

Every interactive thing owes all four states. The pattern, applied across the
kit: **hover** lifts (`translateY(-1px)` + `--shadow-lift` on cards, a step up
within its own material on buttons), **press** sinks (`scale(0.97)`, cards
`0.985`, dock icons `0.88`), **focus-visible** rings, **disabled** drops to
0.45. Hover rules live behind `@media (hover: hover)` so touch never sticks in
one, and the background half of a hover swaps *instantly* — only the lift is
animated, because a colour transition with a `var()` endpoint is the Chromium
wedge above. Order matters: the `:active` rule must follow the `:hover` rule at
equal specificity, or a hovered button stays lifted while you press it.

Two motions above the token set, both once-only: the tab bar icon springs
(`--ease-spring`, 420ms) as it takes over — the animation re-fires for free
because `.active` moves between elements — and the ambient canvas drifts on
54–78s cycles (§3), which is the one continuous animation in the app.

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
- `<Sheet onClose title headTrailing footer detent dismissible>` — phone: bottom
  sheet, grabber, spring, safe-area padding; ≥761px: centered modal. (ModalShell
  shims to this.) **There is no `open` prop, and there must not be one:** all 28
  call sites render it conditionally — `{open && <Sheet …/>}`, `{tile && <Sheet …/>}` —
  and the sheet owns its own exit (below), which an `open` prop would take back.
  `detent` is the resting height, chosen when the sheet opens: `auto` (default,
  content-sized — what every call site gets today), `medium` (56% of the same
  envelope that caps `max-height`) or `large` (that whole envelope). **One** resting
  height, not iOS's drag-between-detents: nothing here wants two resting positions,
  and a drag-between would have to re-decide the scroll behaviour of all 28 sheets.
  Expressing both named heights against the `max-height` envelope keeps the
  safe-area geometry in one place and means a detent can never exceed it. A modal
  (≥761px) is sized by its content, so detents are ignored up there.
- `<Field>` / `<TextArea>` — 44pt, `--surface-2`, focus ring. 16px font on
  mobile (iOS zoom rule — keep the CSS guard).
- `<Switch on onToggle>` — 51×31 iOS proportions. (Toggle shims to this.)
- `<EmptyState icon title sub action>` — every empty/error/not-connected state.
- `<Spinner>`, `<Dot tone>` (status dot), `<Delta value>` (▲/▼ + tone).
- Icons: `src/ui/icons.jsx` — 24×24 grid, 1.8 stroke, round caps/joins,
  SF-Symbols-adjacent geometry. No emoji in chrome.

### Sheets own their exit, and their gesture

The exit had to become the sheet's own business. Because every call site renders it
conditionally, the portal's node is already gone in the frame the parent's flag
flips, and no CSS can animate an element that isn't there. So `Sheet` swallows the
`onClose` it was handed, spends `--dur-2` playing `.sheet.out`, and tells the
parent afterwards — the same thing `.toast.out` has always done.

- **The children are frozen for the closing window.** Title, header, footer, body
  style and children are cached on every open render and replayed while closing,
  because most of these sheets read the very state the close clears (a footer that
  saves and then clears the thing the body is printing is the crashing case). The
  sheet that leaves is the sheet you were looking at.
- **`useSheetClose()`** is how something *inside* the sheet asks for that same
  animated exit — a `footer` element is created at the call site but mounts in the
  sheet's tree, so context reaches it from there. It returns null outside a sheet
  (so a caller can tell rather than silently no-op), ignores `dismissible` (that
  flag guards the scrim, Escape and the X, not the sheet's own logic), and takes an
  optional callback to run once the sheet has finished leaving.
- **Drag to dismiss** is bound to the grab handle, and to the sheet body only at
  `scrollTop: 0` — anywhere else the gesture belongs to the scroller. 120px of
  travel **or** a flick (0.55px/ms, past 20px) commits; anything less springs home,
  and a pointercancel snaps back rather than leaving the sheet mid-pull. Horizontal
  wins ties for good, buttons/fields/`[data-no-drag]`/`[data-sortable]` are not drag
  origins, and a `dismissible={false}` sheet gets a rubber band instead of an exit.
- The drag is refused above 760px, where a centred modal has no bottom edge to
  leave by and its `translate(-50%,-50%)` is load-bearing — up there the exit
  mirrors the modal's own entrance instead. `prefers-reduced-motion` refuses the
  drag *and* takes the exit window away entirely rather than shortening it: a held
  frame is the animation's whole cost with none of its benefit, and dragging a
  sheet around by hand is animation performed by hand.

## 7. Structure (the shells)

**Breakpoint stays 760px** (`useIsMobile`). Preserve every iOS standalone
workaround verbatim: vvh-pinned shell, in-flow dock, `.lbx` letterbox rule,
keyboard-open dock hide, focusin re-center, swipe navigation, 5-tap title
diagnostics, theme pre-paint script, meta theme-color sync (update its two hex
values to `#F2F1EB` / `#000000` — also in manifest + index.html).

### Phone
- **No nav bar.** The top of the window is `.statuscap` — a notch reservation and
  nothing else, `height: env(safe-area-inset-top)` and deliberately transparent so
  the ambient wash paints that strip rather than a flat `--bg` swapping iOS's grey
  cap for one of our own. The title and its controls live in the scroller.
- **Large title block** at the top of every page: `.t-ltitle` + one-line
  `.t-foot` sub in `--sub` (the old HEADERS subtitles, rewritten sentence-case),
  the house mark leading it, and the control cluster trailing it — Settings, then
  `TopStatus` (freshness pill + refresh). Theme lives inside Settings now, where it
  is three labelled choices instead of a cycling icon whose state you had to infer.
  Icon buttons are a 38px visual box with the touch target pushed to 44pt by an
  `::after` inset.
- **Compact scrolled header** — specified here for a long time before it existed,
  and what shipped is a `position: sticky; top: 0; height: 0` perch that is the
  *first* child of `#page-scroll`, with a 48px glass bar overflowing downward out of
  it. Sticky inside the scroller, never `fixed`: every other piece of this shell's
  vertical geometry was won by getting out of the coordinate systems iOS standalone
  misreports, and the scroller cannot be lied to. Zero height is what keeps every
  page's layout byte-for-byte what it was before the bar existed.
  - It carries `head.title` at 16/600, centred by `.cbar-mirror` — an empty cell
    exactly as wide as the control cluster opposite (38 + 6 + 38 = 82px). Absolute
    centring collides with the unsaved chip on a 360px phone; this way the title is
    dead centre in the ordinary case and slides left by half the chip only when
    there is a failed write to report. If a control joins that cluster, the mirror
    moves with it.
  - The controls in it are *the same node* as the large title's — one `controls`
    definition rendered twice — so "the same buttons as the top of the page" stays
    true with nothing to keep in sync.
  - Driven by an `IntersectionObserver` on the `data-lt-sentinel` that kit's
    `LargeTitle` puts on the `h1`, rooted on the scroller (nothing else scrolls
    here, so a viewport-relative observation would never fire) and re-attached on
    every `page` change, because the large title lives inside the keyed page
    wrapper and each navigation builds a new sentinel. No scroll listener anywhere
    in the shell. No `rootMargin` either — insetting the root by the bar's own 48px
    lands 0.8px from firing while the page sits at rest, so it waits for the title
    to leave completely instead.
  - Hidden it is `opacity: 0; visibility: hidden; pointer-events: none` — not
    opacity alone, which would leave a second Settings and a second Refresh in the
    tab order and the accessibility tree on every page. Fades over `--dur-2`;
    reduced motion gets it without the fade. A page with no large title keeps the
    bar off rather than inventing a title it never read.
- **Pull to refresh** on the same scroller, and wired to the same `onRefresh` the
  button in that cluster calls — one refresh path, one thing that could lie about
  it. A second zero-height sticky perch holds a gap the gauge is centred in; JS
  writes the gap's height (that height *is* the pull) and travels `.ptr-wrap` the
  same distance, writing the DOM directly because the offset tracks a finger and
  React state carries only the four discrete phases.
  - Arms at 44px of gap, which is 68px of finger at 0.65 damping — comfortably more
    travel than the 64px a horizontal tab swipe wants. Past the arm point the page
    follows at a quarter rate and stops dead at 72px. The arming threshold and the
    height the gauge rests at while the refresh runs are the same number, so
    letting go does not move the gap at all: only the thing inside it changes, arc
    → spinner.
  - Only from `scrollTop: 0`, one finger, and never from inside a field or a
    scroller of its own. It refuses on the exact complement of App.jsx's swipe test
    (|dx| ≥ 2.2·|dy|), checked on every move and again at the release, so no
    gesture can both change tabs and fire a refresh.
  - **It never claims success.** The gauge says how far you have pulled, and that a
    refresh is in flight for exactly as long as `onRefresh`'s promise is unsettled.
    Whether data actually landed is the freshness pill's to say, because it is the
    only thing that knows. No tick, no green, no "Updated".
  - Reduced motion keeps the gesture, the gauge and the real progress and loses
    only the rubber band: the page never travels, which is why the gauge wears
    glass and a shadow in both modes.
- **Tab bar:** true iOS grammar — glass, 49pt + `env(safe-area-inset-bottom)`
  *inside* the bar, icon 24 + 10px/600 label, active = `--accent` (icon fills),
  inactive = `--faint`. No ember, no pill behind the icon. `NAV` carries seven
  destinations now and seven is the measured ceiling (see the note in `nav.js`);
  the shell renders whatever `nav` it is handed, since the order and which tabs
  are hidden are the account's settings.
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
  design/ambient.css           (the one wash — §3; shell/Ambient.jsx renders it)
  ui/kit.jsx  ui/icons.jsx  ui/primitives.jsx  ui/styles.js (S → new values)
  shell/MobileShell.jsx  shell/SidebarShell.jsx  (chrome, nav, diag)
  shell/Boot.jsx  shell/Login.jsx  (seal, entrance, setup notice)
  shell/Ambient.jsx            (the canvas wash — mounted once, above the auth gate)
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
