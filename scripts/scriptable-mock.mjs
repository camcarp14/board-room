// ─── A stand-in for Scriptable, so a widget script can run under Node ────────
// scriptable/*.js run inside the Scriptable app on iOS, where nothing in this
// repo can reach them. This is just enough of its API — ListWidget, stacks,
// text, colors, fonts, Keychain, FileManager, Request, Alert — for a smoke to
// run a widget file end to end and look at the tree it built.
//
// STRICT ON PURPOSE. Real Scriptable ignores a property it doesn't know, so
// `text.lineLimt = 2` is a widget that silently draws the wrong thing. Here every
// node only accepts the properties Scriptable documents, and anything else
// throws, so a typo fails the smoke instead of shipping.
//
// Used by scripts/notes-widget-smoke.mjs. Not a smoke itself.

import { readFileSync } from "node:fs";

function strict(target, allowed) {
  return new Proxy(target, {
    set(t, k, v) {
      if (!allowed.includes(k)) throw new Error(`Scriptable has no ${t.kind}.${String(k)}`);
      t[k] = v;
      return true;
    },
  });
}

export class Color {
  constructor(hex, alpha = 1) {
    if (!/^#?[0-9a-f]{6}$/i.test(hex)) throw new Error(`bad color hex ${hex}`);
    this.hex = hex.replace(/^#?/, "#");
    this.alpha = alpha ?? 1;
  }
  static dynamic(light, dark) {
    if (!(light instanceof Color) || !(dark instanceof Color)) throw new Error("Color.dynamic takes two Colors");
    const c = new Color(light.hex, light.alpha);
    c.dark = dark;
    return c;
  }
  static white() { return new Color("#FFFFFF"); }
  static black() { return new Color("#000000"); }
  static clear() { return new Color("#000000", 0); }
}

const font = (weight) => (size) => {
  if (typeof size !== "number" || !(size > 0)) throw new Error(`font size must be a positive number, got ${size}`);
  return { weight, size };
};
const fontFamily = (design) => (weight) => (size) => ({ ...font(weight)(size), design });
const mono = fontFamily("monospaced"), rounded = fontFamily("rounded");
export const Font = {
  systemFont: font(400), mediumSystemFont: font(500), semiboldSystemFont: font(600),
  boldSystemFont: font(700), heavySystemFont: font(800), lightSystemFont: font(300),
  regularMonospacedSystemFont: mono(400), mediumMonospacedSystemFont: mono(500),
  semiboldMonospacedSystemFont: mono(600), boldMonospacedSystemFont: mono(700),
  regularRoundedSystemFont: rounded(400), mediumRoundedSystemFont: rounded(500),
  semiboldRoundedSystemFont: rounded(600), boldRoundedSystemFont: rounded(700),
};

export class Size { constructor(width, height) { this.width = width; this.height = height; } }
export class Point { constructor(x, y) { this.x = x; this.y = y; } }
export class LinearGradient { constructor() { this.colors = []; this.locations = []; this.startPoint = null; this.endPoint = null; } }

const TEXT_PROPS = ["font", "textColor", "lineLimit", "minimumScaleFactor", "textOpacity", "shadowColor", "shadowRadius", "shadowOffset", "url"];
const aligned = (node) => Object.assign(node, {
  leftAlignText() { node.align = "left"; },
  centerAlignText() { node.align = "center"; },
  rightAlignText() { node.align = "right"; },
});

const STACK_PROPS = ["backgroundColor", "backgroundImage", "backgroundGradient", "spacing", "size", "cornerRadius", "borderWidth", "borderColor", "url"];

function makeContainer(kind, layout) {
  const node = { kind, layout, align: "top", children: [], padding: null };
  const add = (child) => { node.children.push(child); return child; };
  Object.assign(node, {
    addText(text) {
      if (typeof text !== "string") throw new Error(`addText takes a string, got ${typeof text}`);
      return add(strict(aligned({ kind: "text", text, align: "left" }), TEXT_PROPS));
    },
    // WidgetDate: text iOS keeps current by itself — a timer ticks every second
    // with no refresh. `style` records which apply…Style() was chosen.
    addDate(date) {
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error("addDate takes a valid Date");
      const node = aligned({ kind: "date", date, style: "date", align: "left" });
      for (const st of ["Timer", "Relative", "Offset", "Time", "Date"]) node[`apply${st}Style`] = () => { node.style = st.toLowerCase(); };
      return add(strict(node, TEXT_PROPS));
    },
    addStack() { return add(makeStack()); },
    addSpacer(length) {
      if (length != null && typeof length !== "number") throw new Error("addSpacer takes a number or nothing");
      return add({ kind: "spacer", length: length ?? null });
    },
    addImage(image) {
      if (!image) throw new Error("addImage needs an image");
      return add(strict({ kind: "image", image }, ["imageSize", "tintColor", "cornerRadius", "imageOpacity", "resizable", "url", "containerRelativeShape"]));
    },
    setPadding(top, leading, bottom, trailing) {
      if ([top, leading, bottom, trailing].some((n) => typeof n !== "number")) throw new Error("setPadding takes four numbers");
      node.padding = [top, leading, bottom, trailing];
    },
    useDefaultPadding() { node.padding = null; },
  });
  return node;
}

function makeStack() {
  const node = makeContainer("stack", "h");
  Object.assign(node, {
    layoutHorizontally() { node.layout = "h"; },
    layoutVertically() { node.layout = "v"; },
    topAlignContent() { node.align = "top"; },
    centerAlignContent() { node.align = "center"; },
    bottomAlignContent() { node.align = "bottom"; },
  });
  return strict(node, STACK_PROPS);
}

// A Date whose "now" is fixed. Subclassed rather than faked so `instanceof Date`,
// local-time constructors and DST all behave exactly as the real one does.
function frozenDate(now) {
  const RealDate = Date;
  return class FrozenDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  };
}

export class SFSymbol {
  static named(name) {
    return { name, applyFont() {}, image: { symbol: name } };
  }
}

/** Every text node under `node`, in drawing order. */
export function texts(node) {
  if (!node) return [];
  if (node.kind === "text") return [node.text];
  return (node.children || []).flatMap(texts);
}
/** Every live date (WidgetDate) under `node`, in drawing order. */
export function dates(node) {
  if (!node) return [];
  if (node.kind === "date") return [node];
  return (node.children || []).flatMap(dates);
}
/** Every url set on `node` or anything under it. */
export function urls(node) {
  if (!node) return [];
  return [...(node.url ? [node.url] : []), ...(node.children || []).flatMap(urls)];
}

/**
 * Run a widget script the way Scriptable would and hand back what it built.
 *
 *   family        config.widgetFamily ("small", "accessoryInline", …)
 *   param         args.widgetParameter
 *   inApp         run as if ▶ was tapped in the app rather than by the widget
 *   keychain      initial keychain entries
 *   files         initial FileManager contents, path → string
 *   respond(url)  what Request#loadJSON resolves to for `url`; throw to fail
 *   alertAnswers  for in-app runs: [{ action, value }] per Alert presented
 *   now           freeze the script's clock at this epoch ms: `new Date()` and
 *                 `Date.now()` both read it, and every other Date call works as
 *                 normal. Leave it out to run on the real clock.
 */
export async function runWidget(file, { family = "medium", param = "", inApp = false, keychain = {}, files = {}, respond, alertAnswers = [], now } = {}) {
  const out = { widget: null, presented: null, requests: [], alerts: [], keychain: new Map(Object.entries(keychain)), files: new Map(Object.entries(files)), completed: false };

  function ListWidget() {
    const node = makeContainer("widget", "v");
    let self = null;
    const present = (size) => async () => { out.presented = size; out.widget = self; };
    Object.assign(node, {
      presentSmall: present("small"), presentMedium: present("medium"),
      presentLarge: present("large"), presentExtraLarge: present("extraLarge"),
    });
    self = strict(node, ["backgroundColor", "backgroundImage", "backgroundGradient", "spacing", "url", "refreshAfterDate", "addAccessoryWidgetBackground"]);
    return self;
  }

  class Request {
    constructor(url) { this.url = url; this.timeoutInterval = 60; this.headers = {}; this.method = "GET"; }
    async loadJSON() { out.requests.push(this.url); return respond(this.url); }
  }
  class Alert {
    constructor() { this.title = ""; this.message = ""; this.fields = []; this.answer = null; }
    addTextField(p, v) { this.fields.push(v || ""); }
    addSecureTextField(p, v) { this.fields.push(v || ""); }
    addAction() {}
    addCancelAction() {}
    async present() {
      out.alerts.push(this.title);
      this.answer = alertAnswers.shift() || { action: -1 };
      return this.answer.action;
    }
    textFieldValue() { return this.answer?.value ?? ""; }
  }
  const Keychain = {
    contains: (k) => out.keychain.has(k),
    get: (k) => { if (!out.keychain.has(k)) throw new Error(`Keychain has no ${k}`); return out.keychain.get(k); },
    set: (k, v) => { out.keychain.set(k, String(v)); },
    remove: (k) => { out.keychain.delete(k); },
  };
  const FileManager = {
    local: () => ({
      cacheDirectory: () => "/cache",
      documentsDirectory: () => "/documents",
      joinPath: (a, b) => `${a}/${b}`,
      fileExists: (p) => out.files.has(p),
      readString: (p) => { if (!out.files.has(p)) throw new Error(`no file ${p}`); return out.files.get(p); },
      writeString: (p, s) => { out.files.set(p, String(s)); },
    }),
  };
  const Script = {
    setWidget: (w) => { out.widget = w; },
    complete: () => { out.completed = true; },
  };

  const globals = {
    ListWidget,
    Color, Font, Size, Point, LinearGradient, SFSymbol, Request, Alert, Keychain, FileManager, Script,
    Date: now == null ? Date : frozenDate(now),
    // In the app, Scriptable's widgetFamily is null and a script falls back to
    // its own PREVIEW size. Passing family: null reproduces that exactly; any
    // other value lets an in-app run be checked at a chosen size.
    config: { widgetFamily: family, runsInWidget: !inApp, runsInApp: inApp },
    args: { widgetParameter: param || null },
  };

  const src = readFileSync(file, "utf8");
  const AsyncFunction = (async () => {}).constructor;
  const run = new AsyncFunction(...Object.keys(globals), src);
  await run(...Object.values(globals));
  return out;
}
