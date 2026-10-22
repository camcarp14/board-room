// ─── Board Room · Notes ──────────────────────────────────────────────────────
// A Scriptable widget for iOS/iPadOS that puts your Board Room notes on the Home
// Screen and Lock Screen.
//
// It reads the same endpoint as the calendar widget, in its notes view:
//   /.netlify/functions/trmnl?view=notes&token=…
// Same token, same Supabase data, nothing new to configure in Netlify. See
// SCRIPTABLE.md for the whole story.
//
// WHICH NOTES. By default, exactly the ones the Brief's Notes tile shows, in the
// order it shows them: drag a note to the top of the Brief and it is the top of
// the widget; take a note Off the Brief and it leaves the widget too.
//
// SETUP — SITE is already correct, and if the Board Room Calendar widget is set
// up on this device there is nothing else to do: both read one keychain entry.
//   1. Install Scriptable from the App Store.
//   2. Scriptable → + (new script) → paste this whole file → name it
//      "Board Room Notes".
//   3. Tap ▶ to run it once inside Scriptable. If no token is stored yet it asks
//      for your TRMNL_TOKEN and keeps it in the iOS keychain, never in this
//      (iCloud-synced) file. A preview renders when the token is right.
//   4. Home Screen → long-press → + → Scriptable → pick a size → place it.
//      Long-press the placed widget → Edit Widget → Script: "Board Room Notes".
//      Leave "When Interacting" as Run Script.
//
// SIZES
//   small            the top note
//   medium           the top two notes
//   large            the top five
//   XL (iPad)        the top ten, in two columns
//   Lock Screen      inline / circular / rectangular all supported
//
// WIDGET PARAMETER (optional, Edit Widget → Parameter)
//   (blank)               the Brief's notes, as above
//   Groceries             one note, by title — as much of it as the size holds.
//                         Case doesn't matter, and a title that only STARTS with
//                         what you typed counts ("Captured" → the newest
//                         "Captured — Oct 22"). Notes you took Off the Brief work
//                         here, which is what a long running list wants.
//   Captured — {date}     the same title templates as a Watch capture's "into":
//                         {date} → "Oct 22", {weekday}, {month}, {day}, {year}.
//                         So a widget can follow the list your watch is filling
//                         today, and start clean tomorrow on its own.
//
// TAPPING a note opens it in Board Room; anywhere else opens the Notes tab.
// Small widgets have one tap target, so the whole widget opens its note.
//
// Colors are the app's Porcelain palette (src/design/themes.css), and a sealed
// note gets the same tinted paper and seal dot it has on the Brief.

// ── config ───────────────────────────────────────────────────────────────────
const SITE = "https://board-room.netlify.app"; // no trailing slash
const TOKEN = ""; // your TRMNL_TOKEN — or leave "" to be prompted once (keychain)

const CACHE_TTL_HOURS = 24; // how long a cached payload is still worth showing
const REFRESH_MINUTES = 20; // asked of iOS; it decides, and spaces it out anyway
const PREVIEW = "medium"; // size shown when you run the script inside the app

// ── palette ──────────────────────────────────────────────────────────────────
// Porcelain day and night, via Color.dynamic so iOS swaps them itself.
const dyn = (light, dark, alpha) =>
  Color.dynamic(new Color(light, alpha), new Color(dark, alpha));

const C = {
  bg: dyn("#F4F3F0", "#0F0E0B"),
  surface: dyn("#FEFEFE", "#211F19"),
  ink: dyn("#2B2922", "#D9D6CE"),
  sub: dyn("#706B5C", "#9F9989"),
  faint: dyn("#8E897B", "#7F7A6C"),
  accent: dyn("#87671D", "#D7AA42"),
  line: dyn("#2B2922", "#D9D6CE", 0.14),
  wash: dyn("#87671D", "#D7AA42", 0.13),
  idle: dyn("#2B2922", "#D9D6CE", 0.18), // --ink-a18, the unsealed note's dot
};

// The four seals (NOTE_SEALS in src/ui/shared.jsx): brass is the accent, the
// rest are the semantic colors. Each comes as the dot and as the card's tint.
const SEAL_HEX = {
  brass: ["#87671D", "#D7AA42"],
  green: ["#278A4C", "#34A56E"],
  blue: ["#3568D4", "#4C82E8"],
  red: ["#C93B32", "#E05548"],
};
const sealDot = (seal) => (SEAL_HEX[seal] ? dyn(SEAL_HEX[seal][0], SEAL_HEX[seal][1]) : null);
// The Brief mixes 9% of the seal into --surface. A 10% wash over this widget's
// surface-to-bg gradient lands in the same place.
const sealTint = (seal) => (SEAL_HEX[seal] ? dyn(SEAL_HEX[seal][0], SEAL_HEX[seal][1], 0.1) : null);

// ── token ────────────────────────────────────────────────────────────────────
// The calendar widget's keychain entry, on purpose: one token, stored once.
const KEYCHAIN_KEY = "boardroom.trmnl.token";

async function resolveToken() {
  if (TOKEN) return TOKEN;
  if (Keychain.contains(KEYCHAIN_KEY)) return Keychain.get(KEYCHAIN_KEY);
  // A widget can't show a prompt, so first-run setup has to happen in the app.
  if (!config.runsInApp) return null;

  const a = new Alert();
  a.title = "Board Room token";
  a.message =
    "Paste your TRMNL_TOKEN (Netlify → Site configuration → Environment " +
    "variables). It's stored in this device's keychain, not in the script, " +
    "and the Board Room Calendar widget uses it too.";
  a.addSecureTextField("TRMNL_TOKEN", "");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  if ((await a.present()) === -1) return null;

  const v = (a.textFieldValue(0) || "").trim();
  if (!v) return null;
  Keychain.set(KEYCHAIN_KEY, v);
  return v;
}

// ── data ─────────────────────────────────────────────────────────────────────
const PARAM = String(args.widgetParameter || "").trim();

// One cache per parameter: a Groceries widget and a Brief widget side by side
// must never fall back to each other's notes.
const fm = FileManager.local();
const cacheSlug = PARAM ? PARAM.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "note" : "brief";
const CACHE_PATH = fm.joinPath(fm.cacheDirectory(), `board-room-notes-${cacheSlug}.json`);

function cacheRead() {
  try {
    if (!fm.fileExists(CACHE_PATH)) return null;
    const raw = JSON.parse(fm.readString(CACHE_PATH));
    return raw && raw.data ? raw : null;
  } catch {
    return null;
  }
}

function cacheWrite(data) {
  try {
    fm.writeString(CACHE_PATH, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // A widget that can't write its cache should still render. Ignore.
  }
}

async function fetchNotes(token) {
  let url = `${SITE}/.netlify/functions/trmnl?view=notes&token=${encodeURIComponent(token)}`;
  if (PARAM) url += `&note=${encodeURIComponent(PARAM)}`;
  const req = new Request(url);
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  // A bad token is 401 + {success:false,error}. Surface the function's own
  // words — they're the actionable ones.
  if (data && data.success === false) {
    const err = new Error(data.error || "feed refused the request");
    err.isAuthError = /missing or incorrect token/i.test(data.error || "");
    throw err;
  }
  // A site still running the previous trmnl function ignores view=notes and
  // answers with the calendar brief. Say that, rather than "unexpected response".
  if (data && Array.isArray(data.events) && !Array.isArray(data.notes)) {
    throw new Error("This site doesn't serve notes yet — deploy the latest Board Room.");
  }
  if (!data || !Array.isArray(data.notes)) throw new Error("unexpected response from the feed");
  return data;
}

// Returns { data, stale, cachedAt, error } — network first, then a recent cache
// so a dropped connection doesn't blank the widget.
async function load() {
  const token = await resolveToken();
  if (!token) {
    return { data: null, error: "Open Scriptable and run this script once to add your token." };
  }
  try {
    const data = await fetchNotes(token);
    cacheWrite(data);
    return { data, stale: false };
  } catch (e) {
    // Wrong token, and we're in the app where it can be fixed: clear it and ask
    // again, rather than reusing whatever was typed wrong the first time.
    if (e.isAuthError && config.runsInApp && !TOKEN) {
      Keychain.remove(KEYCHAIN_KEY);
      const retryToken = await resolveToken();
      if (retryToken) {
        try {
          const data = await fetchNotes(retryToken);
          cacheWrite(data);
          return { data, stale: false };
        } catch (e2) {
          e = e2;
        }
      }
    }
    const cached = cacheRead();
    const fresh = cached && Date.now() - cached.at < CACHE_TTL_HOURS * 3600000;
    if (fresh) return { data: cached.data, stale: true, cachedAt: cached.at };
    return { data: null, error: String(e.message || e) };
  }
}

// ── text ─────────────────────────────────────────────────────────────────────
// Notes are written in the editor's list syntax ("- " is a bullet, and every
// Watch capture is one), so draw the bullet the editor means. Runs of blank lines
// fold to one: a widget has no room to spend on vertical space nobody typed.
function displayBody(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.replace(/^(\s*)[-*]\s+/, "$1• ").trimEnd());
  return lines
    .filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim()))
    .join("\n")
    .trim();
}

// One line that names a note, for the places that only have one line — the Lock
// Screen and the small widget's header. Same rule as the Notes tab's
// displayTitle: the title, else the first line of the body.
function headline(n) {
  if (n.title) return n.title;
  const first = displayBody(n.body).split("\n").find((l) => l.trim());
  return first ? first.replace(/^•\s*/, "") : "Untitled note";
}

// The Brief's relTime, computed here rather than shipped by the feed, so a
// cached payload still says "3h" three hours later instead of "now".
function ago(iso) {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  if (m < 60 * 24 * 7) return `${Math.round(m / 1440)}d`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Bare `?note` opens the Notes tab; `?note=<id>` opens that note (src/App.jsx).
const notesUrl = `${SITE}/?note`;
const noteUrl = (id) => (id ? `${SITE}/?note=${encodeURIComponent(id)}` : notesUrl);

// ── drawing primitives ───────────────────────────────────────────────────────
// Dots and hairlines are sized empty stacks rather than DrawContext images: an
// image would bake in one appearance, while a stack keeps Color.dynamic live.
function dot(row, color, size = 7) {
  const d = row.addStack();
  d.size = new Size(size, size);
  d.cornerRadius = size / 2;
  d.backgroundColor = color;
  return d;
}

function rule(container) {
  const r = container.addStack();
  r.size = new Size(0, 1);
  r.backgroundColor = C.line;
  r.addSpacer();
  return r;
}

function label(container, text, font, color, lines = 1) {
  const t = container.addText(text);
  t.font = font;
  t.textColor = color;
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.85;
  return t;
}

function chip(row, text) {
  const s = row.addStack();
  s.backgroundColor = C.wash;
  s.cornerRadius = 5;
  s.setPadding(2, 6, 2, 6);
  label(s, text, Font.semiboldSystemFont(9), C.accent);
  return s;
}

function pin(row, size = 9) {
  try {
    const sym = SFSymbol.named("pin.fill");
    sym.applyFont(Font.systemFont(size));
    const img = row.addImage(sym.image);
    img.imageSize = new Size(size, size);
    img.tintColor = C.faint;
  } catch {
    // An SF Symbol this iOS doesn't have is not worth an error card.
  }
}

const countLabel = (n) => `${n} note${n === 1 ? "" : "s"}`;

// ── widget pieces ────────────────────────────────────────────────────────────
// A note as the Brief draws it: seal dot, then either a title over quiet body
// text or — for an untitled note — the body itself in ink, nothing promoted to a
// headline. Sealed notes are tinted paper; the rest sit on the widget's surface.
function noteRow(container, n, spec) {
  const row = container.addStack();
  row.topAlignContent();
  const tint = sealTint(n.seal);
  if (tint) row.backgroundColor = tint;
  row.cornerRadius = 8;
  row.setPadding(spec.pad, 7, spec.pad, 7);
  if (spec.link) row.url = noteUrl(n.id);

  const dotWrap = row.addStack();
  dotWrap.setPadding(Math.round(spec.size * 0.38), 0, 0, 0);
  dot(dotWrap, sealDot(n.seal) || C.idle, 6);
  row.addSpacer(7);

  const col = row.addStack();
  col.layoutVertically();
  col.spacing = 1;
  const body = displayBody(n.body);
  if (n.title) {
    label(col, n.title, Font.semiboldSystemFont(spec.size), C.ink, 1);
    if (body && spec.bodyLines) label(col, body, Font.systemFont(spec.size - 2), C.sub, spec.bodyLines);
  } else {
    label(col, body || "Empty note", Font.systemFont(spec.size - 0.5), body ? C.ink : C.faint, spec.bodyLines + 1);
  }

  // Flexible: the time sits at the right edge, and a sealed row's tint runs the
  // full width of the widget instead of stopping where its text does.
  row.addSpacer();
  const meta = row.addStack();
  meta.centerAlignContent();
  meta.setPadding(2, 0, 0, 0);
  if (n.pinned) {
    pin(meta, 8);
    meta.addSpacer(3);
  }
  label(meta, ago(n.updated_at), Font.mediumSystemFont(9), C.faint);
  return row;
}

function header(w, left, right, asChip) {
  const h = w.addStack();
  h.centerAlignContent();
  label(h, left, Font.semiboldSystemFont(10), C.accent);
  h.addSpacer();
  if (right) {
    if (asChip) chip(h, right);
    else label(h, right, Font.mediumSystemFont(9), C.faint);
  }
  return h;
}

function emptyState(container, title, sub) {
  const s = container.addStack();
  s.layoutVertically();
  s.addSpacer(4);
  label(s, title, Font.semiboldSystemFont(13), C.ink, 2);
  if (sub) {
    s.addSpacer(2);
    label(s, sub, Font.systemFont(11), C.faint, 3);
  }
}

function moreLine(w, text) {
  const r = w.addStack();
  r.addSpacer();
  label(r, text, Font.mediumSystemFont(9), C.faint);
}

// ── the Brief's notes ────────────────────────────────────────────────────────
// Rows per family are set so the worst case — every note long — still fits the
// smallest phone's widget, rather than so the common case looks full.
const LIST = {
  medium: { rows: 2, size: 13, bodyLines: 2, pad: 4, link: true },
  large: { rows: 5, size: 13, bodyLines: 2, pad: 4, link: true },
  extraLarge: { rows: 5, size: 13, bodyLines: 2, pad: 4, link: true },
};

function briefEmpty(w) {
  emptyState(w, "A blank ledger.", "Nothing on the Brief — file a thought in Board Room and it lands here.");
}

function renderBriefSmall(w, data) {
  const notes = data.notes || [];
  header(w, "NOTES", data.total ? countLabel(data.total) : "");
  w.addSpacer(6);
  if (!notes.length) {
    briefEmpty(w);
    w.addSpacer();
    return;
  }
  const n = notes[0];
  w.url = noteUrl(n.id); // one tap target on a small widget: make it the note

  const top = w.addStack();
  top.centerAlignContent();
  dot(top, sealDot(n.seal) || C.idle, 6);
  top.addSpacer(6);
  label(top, headline(n), Font.semiboldSystemFont(13), C.ink);
  w.addSpacer(3);

  // The headline is either the title or the body's first line; the body below
  // continues from wherever the headline left off, so nothing is said twice.
  const body = displayBody(n.body).split("\n");
  const rest = (n.title ? body : body.slice(1)).join("\n").trim();
  if (rest) label(w, rest, Font.systemFont(11), C.sub, 5);

  w.addSpacer();
  const foot = w.addStack();
  label(foot, ago(n.updated_at), Font.mediumSystemFont(9), C.faint);
  foot.addSpacer();
  if (data.total > 1) label(foot, `+${data.total - 1} more`, Font.mediumSystemFont(9), C.faint);
}

function renderBriefList(w, data, family) {
  const spec = LIST[family] || LIST.medium;
  const notes = data.notes || [];
  const big = family !== "medium";
  if (big) header(w, "BOARD ROOM · NOTES", data.total ? countLabel(data.total) : "", true);
  else header(w, "NOTES", data.total ? countLabel(data.total) : "");
  w.addSpacer(big ? 8 : 5);

  if (!notes.length) {
    briefEmpty(w);
    w.addSpacer();
    return;
  }

  let shown = 0;
  if (family === "extraLarge") {
    // Two columns of rows. Each row carries a flexible spacer, so the two
    // columns are equally flexible and iOS splits the width between them evenly.
    const cols = w.addStack();
    cols.topAlignContent();
    for (let c = 0; c < 2; c++) {
      const col = cols.addStack();
      col.layoutVertically();
      col.spacing = 4;
      for (const n of notes.slice(c * spec.rows, (c + 1) * spec.rows)) {
        noteRow(col, n, spec);
        shown++;
      }
      if (c === 0) cols.addSpacer(14);
    }
  } else {
    const list = w.addStack();
    list.layoutVertically();
    list.spacing = big ? 4 : 3;
    for (const n of notes.slice(0, spec.rows)) {
      noteRow(list, n, spec);
      shown++;
    }
  }

  w.addSpacer();
  if (data.total > shown) moreLine(w, `+${data.total - shown} more`);
}

// ── one note, by name ────────────────────────────────────────────────────────
// Logical lines of the body that fit each family. A line that wraps uses two, so
// these are ceilings; iOS ellipsizes whatever still overflows.
const ONE = {
  small: { title: 13, body: 11, lines: 6 },
  medium: { title: 15, body: 12, lines: 5 },
  large: { title: 17, body: 13, lines: 15 },
  extraLarge: { title: 17, body: 13, lines: 15 },
};

function renderOne(w, data, family) {
  const spec = ONE[family] || ONE.medium;
  const n = (data.notes || [])[0];
  if (!n) {
    header(w, "NOTES", "");
    w.addSpacer(6);
    emptyState(w, `No note titled “${data.match || PARAM}” yet.`,
      family === "small" ? "" : "It shows up here as soon as there is one.");
    w.addSpacer();
    return;
  }
  w.url = noteUrl(n.id);

  const top = w.addStack();
  top.centerAlignContent();
  dot(top, sealDot(n.seal) || C.idle, 7);
  top.addSpacer(7);
  label(top, n.title || headline(n), Font.boldSystemFont(spec.title), C.ink);
  if (family !== "small") {
    top.addSpacer();
    if (n.pinned) {
      pin(top, 9);
      top.addSpacer(4);
    }
    label(top, ago(n.updated_at), Font.mediumSystemFont(10), C.faint);
  }
  w.addSpacer(family === "small" ? 5 : 7);
  rule(w);
  w.addSpacer(family === "small" ? 5 : 7);

  const lines = displayBody(n.body).split("\n");
  if (!lines.join("").trim()) {
    label(w, "Nothing in it yet.", Font.systemFont(spec.body), C.faint);
  } else {
    label(w, lines.slice(0, spec.lines).join("\n"), Font.systemFont(spec.body), C.ink, spec.lines);
  }

  w.addSpacer();
  const hidden = Math.max(0, lines.length - spec.lines);
  const foot = w.addStack();
  if (family === "small") label(foot, ago(n.updated_at), Font.mediumSystemFont(9), C.faint);
  foot.addSpacer();
  if (hidden) label(foot, `+${hidden} more line${hidden === 1 ? "" : "s"}`, Font.mediumSystemFont(9), C.faint);
  else if (n.clipped) label(foot, "continues in Board Room", Font.mediumSystemFont(9), C.faint);
}

// ── Lock Screen ──────────────────────────────────────────────────────────────
// Monochrome — iOS tints them — so hierarchy is weight, not color.
function renderAccessoryRectangular(w, data) {
  const n = (data.notes || [])[0];
  if (!n) {
    label(w, "NOTES", Font.semiboldSystemFont(11), Color.white());
    label(w, data.mode === "note" ? `No “${data.match || PARAM}” yet` : "Nothing on the Brief", Font.systemFont(13), Color.white(), 2);
    return;
  }
  w.url = noteUrl(n.id);
  const body = displayBody(n.body).split("\n");
  const rest = (n.title ? body : body.slice(1)).join("\n").trim();
  label(w, headline(n), Font.semiboldSystemFont(14), Color.white());
  if (rest) label(w, rest, Font.systemFont(12), Color.white(), 2);
}

function renderAccessoryCircular(w, data) {
  const s = w.addStack();
  s.layoutVertically();
  s.centerAlignContent();

  const top = s.addStack();
  top.addSpacer();
  try {
    const sym = SFSymbol.named("note.text");
    sym.applyFont(Font.systemFont(18));
    const img = top.addImage(sym.image);
    img.imageSize = new Size(20, 20);
    img.tintColor = Color.white();
  } catch {
    label(top, "✎", Font.systemFont(18), Color.white());
  }
  top.addSpacer();

  s.addSpacer(2);
  const bottom = s.addStack();
  bottom.addSpacer();
  const n = (data.notes || [])[0];
  const text = data.mode === "note" ? (n ? ago(n.updated_at) : "—") : String(data.total || 0);
  label(bottom, text, Font.semiboldSystemFont(11), Color.white());
  bottom.addSpacer();
}

function renderAccessoryInline(w, data) {
  const n = (data.notes || [])[0];
  label(w, n ? headline(n) : "No notes on the Brief", Font.systemFont(13), Color.white());
}

function renderError(w, message, family) {
  const small = family === "small" || String(family).startsWith("accessory");
  label(w, "BOARD ROOM", Font.semiboldSystemFont(10), C.accent);
  w.addSpacer(6);
  label(w, "Notes unavailable", Font.semiboldSystemFont(small ? 13 : 15), C.ink);
  w.addSpacer(4);
  label(w, message, Font.systemFont(small ? 10 : 12), C.sub, 4);
  w.addSpacer();
}

// ── assembly ─────────────────────────────────────────────────────────────────
function buildWidget(result, family) {
  const w = new ListWidget();
  const isAccessory = String(family).startsWith("accessory");

  if (isAccessory) {
    w.setPadding(2, 2, 2, 2);
    // The frosted plate only on the circular one, as Apple's own Lock Screen
    // widgets do it: under rectangular text it crowds the words to its edges.
    if (family === "accessoryCircular") {
      try { w.addAccessoryWidgetBackground = true; } catch {}
    }
  } else {
    w.setPadding(14, 14, 13, 14);
    const g = new LinearGradient();
    g.colors = [C.surface, C.bg];
    g.locations = [0, 1];
    g.startPoint = new Point(0, 0);
    g.endPoint = new Point(0.6, 1);
    w.backgroundGradient = g;
  }

  // Anywhere that isn't a note opens the Notes tab. Renderers that draw a
  // single note point the whole widget at it instead.
  w.url = notesUrl;

  if (!result.data) {
    if (isAccessory) label(w, "Notes unavailable", Font.systemFont(12), Color.white());
    else renderError(w, result.error, family);
    w.refreshAfterDate = new Date(Date.now() + 10 * 60000);
    return w;
  }

  const data = result.data;
  const one = data.mode === "note";

  switch (family) {
    case "accessoryInline": renderAccessoryInline(w, data); break;
    case "accessoryCircular": renderAccessoryCircular(w, data); break;
    case "accessoryRectangular": renderAccessoryRectangular(w, data); break;
    case "small": one ? renderOne(w, data, "small") : renderBriefSmall(w, data); break;
    case "large": one ? renderOne(w, data, "large") : renderBriefList(w, data, "large"); break;
    case "extraLarge": one ? renderOne(w, data, "extraLarge") : renderBriefList(w, data, "extraLarge"); break;
    default: one ? renderOne(w, data, "medium") : renderBriefList(w, data, "medium"); break;
  }

  // A quiet marker so stale notes never pass themselves off as live.
  if (result.stale && !isAccessory) {
    const at = new Date(result.cachedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    label(w, `cached ${at}`, Font.systemFont(8), C.faint);
  }

  w.refreshAfterDate = new Date(Date.now() + (result.stale ? 10 : REFRESH_MINUTES) * 60000);
  return w;
}

// ── run ──────────────────────────────────────────────────────────────────────
const result = await load();
const family = config.widgetFamily || PREVIEW;
const widget = buildWidget(result, family);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else if (family === "small") {
  await widget.presentSmall();
} else if (family === "large" || family === "extraLarge") {
  await widget.presentLarge();
} else {
  await widget.presentMedium();
}
Script.complete();
