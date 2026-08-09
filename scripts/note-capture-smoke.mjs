// ─── Watch capture smoke — PLANTED problems, known answers ───────────────────
// Everything on the path from a dictated sentence to a row in personal_notes
// fails QUIETLY if it fails at all. A cancelled dictation posts an empty magic
// variable; a flaky watch radio makes Shortcuts re-run the action; a daily list
// whose title is built from the server's clock rolls over at 7pm Central
// instead of midnight. None of those throw — they produce an empty note, a
// doubled note, or a note filed under tomorrow.
//
// So the whole decision layer of netlify/functions/note-capture.js is pure and
// asserted here against fixed clocks. Run by `npm run verify`.

import {
  normalizeCapture, resolveTitle, appendEntry, isDuplicate, bool, lowerKeys,
  chicagoDate, chicagoTime, MAX_BODY, MAX_TITLE, DEDUPE_MS, SEALS,
} from "../netlify/functions/note-capture.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

// 11:40pm Central on Friday Aug 7 2026 — which is already Aug 8 in UTC. Every
// date assertion below uses it, because "which day does this file under" is
// the question a server-clock bug answers wrong.
const LATE = Date.parse("2026-08-07T23:40:00-05:00");
const MIDDAY = Date.parse("2026-08-07T14:05:00-05:00");

// ─── 0. the clock is Chicago's, not the region's ─────────────────────────────
check("a late-night capture files under the Central day", chicagoDate(LATE).label === "Aug 7", chicagoDate(LATE).label);
check("…and its weekday is Central's too", chicagoDate(LATE).weekday === "Fri", chicagoDate(LATE).weekday);
check("the stamp is the Central wall clock", /^11:40\s?PM$/.test(chicagoTime(LATE)), chicagoTime(LATE));
check("midday stamps read as PM", /^2:05\s?PM$/.test(chicagoTime(MIDDAY)), chicagoTime(MIDDAY));

// ─── 1. the title template — one Shortcut, a new list every day ──────────────
check("{date} resolves to the Central date", resolveTitle("Errands — {date}", LATE) === "Errands — Aug 7");
check("{today} is an alias for {date}", resolveTitle("{today}", LATE) === resolveTitle("{date}", LATE));
check("{weekday} resolves", resolveTitle("Log {weekday}", LATE) === "Log Fri");
check("{year} resolves", resolveTitle("Q3 {year}", LATE) === "Q3 2026");
check("tokens are case-insensitive", resolveTitle("{DATE}", LATE) === "Aug 7");
check("a plain title passes through untouched", resolveTitle("Reading list", LATE) === "Reading list");
check("the list rolls over at Central midnight, not UTC's",
  resolveTitle("{date}", LATE) !== resolveTitle("{date}", LATE + 25 * 60000),
  `${resolveTitle("{date}", LATE)} vs ${resolveTitle("{date}", LATE + 25 * 60000)}`);

// ─── 2. THE REGRESSION GUARD. A cancelled dictation is never a note. ─────────
check("empty text is rejected", !!normalizeCapture({ text: "" }).error);
check("whitespace-only text is rejected", !!normalizeCapture({ text: "   \n  " }).error);
check("a missing text field is rejected", !!normalizeCapture({ title: "Idea" }).error);
check("a non-string text is rejected", !!normalizeCapture({ text: 42 }).error);
check("a null body is rejected", !!normalizeCapture(null).error);
check("text past the ceiling is rejected loudly",
  /10000 characters/.test(normalizeCapture({ text: "x".repeat(MAX_BODY + 1) }).error || ""));
check("text at the ceiling is accepted", !normalizeCapture({ text: "x".repeat(MAX_BODY) }).error);

// ─── 3. the field aliases Shortcuts actually produces ────────────────────────
for (const key of ["text", "note", "body", "content", "dictation"]) {
  check(`"${key}" reads as the note body`, normalizeCapture({ [key]: "call the roofer" }).body === "call the roofer");
}
check("the body is trimmed", normalizeCapture({ text: "  spaced  " }).body === "spaced");
check("a title is optional and defaults empty", normalizeCapture({ text: "x" }).title === "");
check("an over-long title is rejected", !!normalizeCapture({ text: "x", title: "t".repeat(MAX_TITLE + 1) }).error);

// ─── 3b. THE CAPITAL LETTER YOU DIDN'T TYPE ──────────────────────────────────
// Shortcuts' JSON body editor auto-capitalizes the KEY field, so typing `token`
// yields `Token`, and a case-sensitive read 401s with "unknown token" while the
// shortcut looks correct on screen. Nothing about the error points at the one
// capital letter. Every field is read case-insensitively.
check("Token (as the Shortcuts editor types it) is the token field", lowerKeys({ Token: "abc" }).token === "abc");
check("Text reads as the body", normalizeCapture({ Text: "call the roofer" }).body === "call the roofer");
check("SEAL in caps still resolves", normalizeCapture({ text: "x", SEAL: "blue" }).color === "blue");
check("Into in caps still appends", normalizeCapture({ text: "x", Into: "Errands" }).into === "Errands");
check("Title in caps still titles", normalizeCapture({ text: "x", Title: "Idea" }).title === "Idea");
check("Pin in caps still pins", normalizeCapture({ text: "x", Pin: "1" }).pinned === true);
check("an exactly-lowercase key wins over a case variant", lowerKeys({ Token: "wrong", token: "right" }).token === "right");
check("…in either declaration order", lowerKeys({ token: "right", Token: "wrong" }).token === "right");
check("a padded key still lands", lowerKeys({ " token ": "abc" }).token === "abc");
check("lowerKeys leaves non-objects alone", lowerKeys(null) === null && lowerKeys("x") === "x");
check("lowerKeys does not flatten arrays", Array.isArray(lowerKeys(["a"])));

// ─── 4. seals — a typo must not silently drop the color ──────────────────────
for (const seal of SEALS) check(`seal "${seal}" is accepted`, normalizeCapture({ text: "x", seal }).color === seal);
check("seal is case-insensitive", normalizeCapture({ text: "x", seal: "Blue" }).color === "blue");
check("`color` is an accepted alias", normalizeCapture({ text: "x", color: "red" }).color === "red");
check("an unknown seal is a 400, not a silent null", /seal must be one of/.test(normalizeCapture({ text: "x", seal: "chartreuse" }).error || ""));
check("no seal means no color", normalizeCapture({ text: "x" }).color === null);
check("an empty seal string reads as absent", normalizeCapture({ text: "x", seal: "" }).color === null);

// ─── 5. the toggles Shortcuts sends in six different shapes ──────────────────
check("bool reads true-ish strings", bool("yes") === true && bool("1") === true && bool("True") === true);
check("bool reads false-ish strings", bool("no") === false && bool("0") === false);
check("bool reads numbers", bool(1) === true && bool(0) === false);
check("bool reads an unrecognized value as absent, not false", bool("maybe") === null && bool(undefined) === null);
check("pin defaults off", normalizeCapture({ text: "x" }).pinned === false);
check("pin:'1' from a Shortcut pins", normalizeCapture({ text: "x", pin: "1" }).pinned === true);
check("`pinned` is an accepted alias", normalizeCapture({ text: "x", pinned: true }).pinned === true);

// ─── 6. append mode ──────────────────────────────────────────────────────────
const app = normalizeCapture({ text: "grout sealer", into: "Errands — {date}" }, LATE);
check("into resolves its template", app.into === "Errands — Aug 7", app.into);
check("append mode stamps by default", app.stamp === true);
check("a plain note does NOT stamp by default", normalizeCapture({ text: "x" }).stamp === false);
check("stamp can be forced off in append mode", normalizeCapture({ text: "x", into: "L", stamp: "no" }, LATE).stamp === false);
check("stamp can be forced on for a plain note", normalizeCapture({ text: "x", stamp: "yes" }).stamp === true);
check("`append` is an accepted alias for into", normalizeCapture({ text: "x", append: "L" }).into === "L");
check("`list` is an accepted alias for into", normalizeCapture({ text: "x", list: "L" }).into === "L");
check("a blank into means a plain new note, not an error", normalizeCapture({ text: "x", into: "  " }).into === null);
check("an unknown {token} is left alone rather than erasing the title",
  normalizeCapture({ text: "x", into: "List {nope}" }, LATE).into === "List {nope}");
check("an into that resolves past the title ceiling is rejected",
  !!normalizeCapture({ text: "x", into: "t".repeat(MAX_TITLE + 1) }, LATE).error);

// ─── 7. the appended line speaks the editor's own list syntax ────────────────
// "- " is what continueListOnEnter (src/ui/shared.jsx) reads as a bullet, so a
// list built by the watch continues correctly the first time you press Enter
// in the phone editor. If this ever stops starting with "- ", that breaks.
const first = appendEntry("", "grout sealer", { now: LATE });
check("the first entry is a bullet", first.startsWith("- "), first);
check("the entry carries the Central time", /^- 11:40\s?PM · grout sealer$/.test(first), first);
const second = appendEntry(first, "return the drill", { now: LATE + 60000 });
check("the second entry lands on its own line", second.split("\n").length === 2, JSON.stringify(second));
check("the first entry survives verbatim", second.split("\n")[0] === first);
check("stamp:false still bullets", appendEntry("", "x", { stamp: false, now: LATE }) === "- x");
check("trailing whitespace in the existing body doesn't open a gap",
  appendEntry("- a\n\n  ", "b", { stamp: false }).split("\n").length === 2);
check("a multi-line dictation collapses to one bullet",
  appendEntry("", "buy milk\nand eggs", { stamp: false }) === "- buy milk and eggs");
check("appending to an existing note never rewrites it",
  appendEntry("hand-typed\nlines", "x", { stamp: false }).startsWith("hand-typed\nlines\n"));

// ─── 8. THE OTHER REGRESSION GUARD. A flaky radio never doubles a note. ──────
const iso = (ms) => new Date(ms).toISOString();
const recentNew = [{ id: "n1", title: "", body: "call the roofer", updated_at: iso(LATE - 10_000) }];
check("the same words 10s later are the same note",
  isDuplicate(recentNew, { body: "call the roofer", into: null }, LATE)?.id === "n1");
check("…and whitespace differences don't defeat it",
  isDuplicate(recentNew, { body: "  call the roofer  ".trim(), into: null }, LATE)?.id === "n1");
check("different words are a different note",
  isDuplicate(recentNew, { body: "call the plumber", into: null }, LATE) === null);
check("past the window it is a deliberate re-say, not a retry",
  isDuplicate([{ ...recentNew[0], updated_at: iso(LATE - DEDUPE_MS - 1000) }], { body: "call the roofer", into: null }, LATE) === null);

const recentList = [{ id: "l1", title: "Errands — Aug 7", body: "- 11:39 PM · grout sealer\n- 11:40 PM · return the drill", updated_at: iso(LATE - 5000) }];
check("a re-sent append is caught on the LAST line's words",
  isDuplicate(recentList, { body: "return the drill", into: "Errands — Aug 7" }, LATE)?.id === "l1");
check("…even though the retry's stamp would differ",
  isDuplicate([{ ...recentList[0], body: "- 11:41 PM · return the drill" }], { body: "return the drill", into: "Errands — Aug 7" }, LATE)?.id === "l1");
check("an earlier line in the same list is NOT a duplicate — you can repeat yourself",
  isDuplicate(recentList, { body: "grout sealer", into: "Errands — Aug 7" }, LATE) === null);
check("the same words into a DIFFERENT list are not a duplicate",
  isDuplicate(recentList, { body: "return the drill", into: "Errands — Aug 6" }, LATE) === null);
check("an append is never deduped against a plain note of the same text",
  isDuplicate(recentNew, { body: "call the roofer", into: "Errands — Aug 7" }, LATE) === null);
check("an unstamped list line still dedupes",
  isDuplicate([{ id: "l2", title: "L", body: "- return the drill", updated_at: iso(LATE - 5000) }], { body: "return the drill", into: "L" }, LATE)?.id === "l2");
check("no recent rows is not a duplicate", isDuplicate([], { body: "x", into: null }, LATE) === null && isDuplicate(null, { body: "x", into: null }, LATE) === null);

console.log(failed ? `\n${failed} FAILED` : "\nNOTE CAPTURE SMOKE PASS");
process.exit(failed ? 1 : 0);
