// ─── Calendar title wrapping smoke — the stranded letter, asserted away ──────
//
// A month-grid bar is a seventh of a phone screen: ~37px of usable width, two
// lines deep. With `word-break: break-word` the browser filled line one to the
// pixel and dropped the remainder on line two, so "Monkey" rendered as "Monke"
// above a lone "y". lib/wrap-title.js fixes that by supplying the break points
// itself — zero-width spaces everywhere inside a long word EXCEPT within three
// characters of its end, so greedy layout physically cannot leave a stub.
//
// Nothing here throws when it breaks. A regression is a cosmetic fault you
// only see by opening the app on a phone, which is exactly why it survived
// this long. So the assertions are about the property, not the strings:
//
//  1. NO SHORT TAIL. Whatever the browser chooses, the piece after the last
//     break opportunity is at least KEEP characters. This is the whole fix.
//  2. SHORT WORDS ARE UNTOUCHED. A word that fits a line on its own must get
//     no opportunities at all — soften "change" and the browser breaks it as
//     "Oil cha/nge" instead of moving the word down whole. The threshold is
//     the difference between fixing this and making it worse.
//  3. THE TEXT IS UNCHANGED. Strip the zero-width spaces and you must get the
//     input back, character for character. A softened title is for display
//     only; if one ever reaches the database, a search, or the `title`
//     tooltip, it silently stops matching itself.
//  4. IDEMPOTENT. Softening twice is softening once. Cheap to guarantee and it
//     removes a whole class of double-application bug.
//  5. THE CALLERS STILL CALL IT, and still hand the RAW title to the tooltip.
//     Both render sites are one line of JSX each; this is the assertion that
//     survives someone reformatting them.
//
// Pure, no DOM. Run by `npm run verify`.

import { readFileSync } from "node:fs";
import { softWrapTitle, unwrapTitle } from "../src/lib/wrap-title.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

const ZWSP = "​";
const KEEP = 3;
const MIN_WORD = 7;
const show = (s) => s.replace(/​/g, "·");

// Real titles off the calendar, plus the shapes that used to break it.
const TITLES = [
  "Monkey", "Grandpa Dittmer", "Brewers Game", "Rent Due", "2x Sleep Study",
  "Labor Day", "O/g Sox Game", "NFL Week 1", "NFL Sunday", "Shenanigans Day",
  "OOO/Vegas", "Vegas Flight", "Ryan", "Jordan", "Dani", "Dentist", "Payday",
  "Gran", "Mom", "Anniversary", "Trash Day", "Dad's Birthday", "Christmas",
  "Thanksgiving", "Haircut", "Standup", "Flight home", "Oil change",
  "Standup w/ Ryan", "Wisconsin", "Appointment", "Physiotherapy", "Grandma",
  "Ophthalmologist", "Café résumé naïve", "Ryan +2", "🎂 Mom", "a", "",
];

// ── 1. no break opportunity may leave a stub behind ─────────────────────────
// Every piece the browser could end a line with, and every piece it could
// start one with, has to be something a reader recognises as part of a word.
for (const t of TITLES) {
  const out = softWrapTitle(t);
  const pieces = out.split(ZWSP);
  if (pieces.length === 1) continue;
  // The tail after the LAST opportunity is the one that lands alone on line
  // two when the break falls late — the exact failure being fixed.
  check(`"${t}" leaves no stub after its last break (${show(out)})`,
    [...pieces[pieces.length - 1]].length >= KEEP,
    `tail=${JSON.stringify(pieces[pieces.length - 1])}`);
  // And the head before the first, which lands alone on line one when it
  // falls early.
  check(`"${t}" keeps a readable head before its first break`,
    [...pieces[0]].length >= KEEP, `head=${JSON.stringify(pieces[0])}`);
}

// ── 2. a word that fits on its own line is left completely alone ────────────
for (const w of ["Oil", "change", "Rent", "Due", "Monkey", "Jordan", "Payday", "Sunday", "Mom"]) {
  check(`"${w}" (${w.length} chars) gets no break opportunities`,
    !softWrapTitle(w).includes(ZWSP), show(softWrapTitle(w)));
}
check(`the threshold is exactly ${MIN_WORD}`,
  !softWrapTitle("a".repeat(MIN_WORD - 1)).includes(ZWSP)
  && softWrapTitle("a".repeat(MIN_WORD)).includes(ZWSP));
check("a space always wins over an inserted opportunity",
  softWrapTitle("Oil change") === "Oil change");

// ── 3. the text itself is never altered ────────────────────────────────────
for (const t of TITLES) {
  check(`"${t}" survives a round trip`, unwrapTitle(softWrapTitle(t)) === t,
    JSON.stringify(unwrapTitle(softWrapTitle(t))));
}
check("nothing but zero-width spaces is ever added",
  TITLES.every((t) => softWrapTitle(t).replace(new RegExp(ZWSP, "g"), "") === t));
check("whitespace is preserved exactly",
  softWrapTitle("  Thanksgiving   dinner  ").startsWith("  ")
  && softWrapTitle("  Thanksgiving   dinner  ").endsWith("  "));

// ── 4. idempotent, and safe on junk ────────────────────────────────────────
for (const t of TITLES) {
  check(`"${t}" softens the same the second time`,
    softWrapTitle(softWrapTitle(t)) === softWrapTitle(t));
}
check("null and undefined become an empty string, not a crash",
  softWrapTitle(null) === "" && softWrapTitle(undefined) === "");
check("a non-string is stringified rather than thrown at",
  unwrapTitle(softWrapTitle(20260902)) === "20260902", show(softWrapTitle(20260902)));
check("unwrapTitle passes non-strings through untouched", unwrapTitle(null) === null);

// Combining marks and emoji must not be split down the middle: a lone
// combining accent renders on the wrong letter, and half a surrogate pair
// renders as a replacement box.
// Assert the property directly: every piece between the inserted breaks is a
// whole grapheme, so no zero-width space can land inside a character.
// The property, stated directly: splitting on the inserted breaks must not
// change how many user-perceived characters there are. A zero-width space
// dropped inside one would leave a lone surrogate or a bare combining mark
// standing as a character of its own, and the count would go up.
const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
const graphemeCount = (s) => [...seg.segment(s)].length;
for (const s of ["🎂🎂🎂🎂🎂🎂🎂🎂", "Café résumé naïve", "e\u0301".repeat(8), "👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧"]) {
  const pieces = softWrapTitle(s).split(ZWSP);
  check(`"${s}" is only ever cut between whole characters`,
    pieces.reduce((n, p) => n + graphemeCount(p), 0) === graphemeCount(s),
    `${show(softWrapTitle(s))} — ${pieces.reduce((n, p) => n + graphemeCount(p), 0)} vs ${graphemeCount(s)}`);
}

// ── 5. both cramped calendars still use it, and still tooltip the raw name ──
const cal = readFileSync(new URL("../src/pages/personal/CalendarPanel.jsx", import.meta.url), "utf8");
check("the month grid imports softWrapTitle", /import \{ softWrapTitle \} from "\.\.\/\.\.\/lib\/wrap-title\.js"/.test(cal));
check("the month grid softens the bar title", /softWrapTitle\(ev\.title\)/.test(cal));
check("the month grid still hands the RAW title to the tooltip", /title=\{ev\.title\}/.test(cal));
// `word-break: break-word` is the property that strands letters; it must not
// come back. `overflow-wrap: break-word` is a different property and is the
// intended floor.
check("the month grid no longer sets wordBreak: break-word",
  !/wordBreak:\s*"break-word"/.test(cal));
check("the month grid keeps overflowWrap as the floor", /overflowWrap:\s*"break-word"/.test(cal));

const brief = readFileSync(new URL("../src/pages/brief/BriefPage.jsx", import.meta.url), "utf8");
check("the mini calendar imports softWrapTitle", /import \{ softWrapTitle \} from "\.\.\/\.\.\/lib\/wrap-title\.js"/.test(brief));
check("the mini calendar softens its pill", /softWrapTitle\(miniTitle\(dayEvents\)\)/.test(brief));
check("the mini pill tooltips the raw name", /title=\{miniTitle\(dayEvents\)\}/.test(brief));
check("the mini calendar no longer sets wordBreak: break-word",
  !/wordBreak:\s*"break-word"/.test(brief));

// ── 6. the width the fix is measured against ───────────────────────────────
// These two paddings are load-bearing, not taste. Measured in the app with its
// own self-hosted Inter, "Monkey" is 37.3px at the 9.5px both calendars now
// use. The month bar is 41.4px wide on a 375pt phone and the mini day cell is
// 45px, so 1px of padding a side leaves 39.4px and 39px — both fit with room
// to spare. Two pixels a side leaves 37.4px and 37px: one strands the "y"
// outright and the other clears it by a tenth of a pixel, which is not a
// margin, it is a coincidence. A word this short gets no break opportunities (it would fit
// a line of its own on any sane screen, and softening it would break "Oil
// change" as "Oil cha/nge"), so there is nothing to catch it if the padding
// grows back. Hence an assertion on the number itself.
check("the month bar keeps 1px of padding — 2px strands the last letter of \"Monkey\"",
  /padding: "0 1px", minWidth: 0/.test(cal));
check("the mini day cell keeps 1px of horizontal padding, for the same reason",
  /height: 56, overflow: "hidden", padding: "3px 1px"/.test(brief));
check("the month bar keeps its tightened tracking", /letterSpacing: "-0\.012em"/.test(cal));
check("both calendars render titles at the same 9.5px",
  /fontSize: 9\.5, lineHeight: 1\.15, fontWeight: 600/.test(cal) && /fontSize: 9\.5, fontWeight: 600, color: "var\(--chip-ink\)"/.test(brief));
check("the mini pill keeps its tightened tracking", /letterSpacing: "-0\.012em"/.test(brief));

console.log(failed ? `\nWRAP TITLE SMOKE FAILED (${failed})` : "\nWRAP TITLE SMOKE PASS");
process.exit(failed ? 1 : 0);
