// ─── Where a calendar title is allowed to break ──────────────────────────────
// A day column in the month grid is a seventh of the screen. On a 375pt phone
// that is a 41.4px bar with 39.4px of usable width — about seven characters a
// line, two lines deep. Something has to give, and the question is only what.
//
// What the app used to do was `word-break: break-word`, which means "break
// wherever you run out of room". That fills line one to the last pixel and
// dumps whatever is left onto line two, so "Monkey" rendered as "Monke" over a
// lone "y", and "Jordan" as "Jorda" over "n". A single stranded letter reads
// as a rendering fault, not as a name.
//
// The obvious fixes do not work here:
//
//   · Breaking only at spaces (`overflow-wrap: normal`) removes the stranded
//     letters and replaces them with a worse bug — a word wider than the bar
//     has nowhere to go, overflows, and is sliced through the middle of a
//     glyph by the bar's `overflow: hidden`.
//   · `hyphens: auto`, `text-wrap: balance` and `text-wrap: pretty` are all
//     ignored inside a `-webkit-box` line clamp, which is what gives us the
//     two-line ellipsis in the first place. Measured, all three are exact
//     no-ops on this element; they are not an option, they are a nothing.
//
// So the break points come from the text instead. This inserts ZERO-WIDTH
// SPACES — break OPPORTUNITIES, not breaks — inside long words, everywhere
// except within KEEP characters of the word's end. The browser still lays out
// greedily and still fills line one as far as it can; it simply has no
// opportunity that would leave a stub behind, so it takes the last one that
// does not. "Christmas" becomes "Christ/mas", "Thanksgiving" "Thanks/giving",
// "Standup" "Stan/dup". Nothing is stranded and nothing is sliced.
//
// Two details that are load-bearing:
//
//   · MIN_WORD is 7 because a word that would have fit on a line of its own
//     must be left alone. Soften "change" (six characters, 34.3px, fits) and
//     the browser will happily break it as "Oil cha/nge" instead of moving the
//     whole word down to line two. Only words too wide to fit anywhere get
//     opportunities.
//   · `overflow-wrap: break-word` stays on the element as the floor. A zero-
//     width space is a suggestion; if even the first KEEP characters overrun
//     — a pathological run of wide glyphs — the browser still breaks rather
//     than letting the bar clip mid-letter.
//
// The softened string is for DISPLAY ONLY. Zero-width spaces must never reach
// the `title` tooltip, a search index, or the database — see the callers, which
// pass the raw title everywhere else. Pure; scripts/wrap-title-smoke.mjs
// exercises it.

const ZWSP = "\u200B";

// Shorter than this and the word fits a line unaided (see the note above).
const MIN_WORD = 7;
// Characters that must stay attached to the tail. Two would still permit "…dp"
// / "a"; three is the shortest that always reads as a fragment of a word.
const KEEP = 3;

// Built from MIN_WORD so the threshold has one home.
const LONG_WORD = new RegExp(`[^\\s${ZWSP}]{${MIN_WORD},}`, "gu");

// Count and cut by GRAPHEME, not by code unit. "🎂" is two code units and "é"
// written as e+U+0301 is two code points; slicing either down the middle puts
// a zero-width space inside a character and renders a replacement box or an
// accent on the wrong letter. Intl.Segmenter is the only thing that knows
// where a user-perceived character actually ends. The fallback is code points,
// which is still never wrong about surrogate pairs.
const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("en", { granularity: "grapheme" })
  : null;
const graphemes = (word) => (segmenter
  ? [...segmenter.segment(word)].map((g) => g.segment)
  : [...word]);

export function softWrapTitle(title) {
  const s = typeof title === "string" ? title : title == null ? "" : String(title);
  if (!s) return s;
  // Runs of non-whitespace, so "OOO/Vegas" is one unbreakable-by-default unit
  // and gets opportunities like any other long word. Existing zero-width
  // spaces are excluded from the run so re-softening an already-softened
  // string is a no-op rather than a doubling.
  return s.replace(LONG_WORD, (word) => {
    const g = graphemes(word);
    // The regex counts code units, so an eight-emoji title reaches it as a
    // 16-unit "word" that is only eight characters wide. Re-check in the unit
    // that matters, or emoji get break points a plain word of that width
    // would not.
    if (g.length < MIN_WORD) return word;
    const head = g.slice(0, KEEP).join("");
    const tail = g.slice(g.length - KEEP).join("");
    const middle = g.slice(KEEP, g.length - KEEP).map((c) => ZWSP + c).join("");
    return `${head}${middle}${ZWSP}${tail}`;
  });
}

// The inverse, for anywhere a softened string could be read back as data.
export const unwrapTitle = (s) => (typeof s === "string" ? s.split(ZWSP).join("") : s);
