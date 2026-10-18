// ─── Daily Plan smoke — the clock, the template, and what the screen claims ───
//
// The Plan tab's failures are all quiet ones. None of them throws; each one is
// a confident answer that is wrong, on the one screen whose job is to be the
// voice of reason at 7am:
//
//   1. THE WRONG TEMPLATE. A Friday evening read as Saturday (getUTCDay in the
//      Americas), so the weekend plan shows up a night early — or Monday 5:40am
//      shows Monday as having "nothing yet" because the day hasn't started.
//   2. THE WRONG BLOCK. Off-by-one at a boundary (at exactly 8:30 you are in the
//      8:30 block, not still in the one before it), or the night treated as a
//      void instead of as last night's last block still running.
//   3. A STORED VALUE THAT BLANKS THE TAB. daily_plan is a jsonb setting anyone
//      can hand-edit; a string, a block with no start, a kind from a future
//      build must all render, not throw.
//   4. AN EDIT THAT MUTATES. The plan is React state painted optimistically; an
//      edit helper that changes its input changes what's on screen before the
//      write, and the Undo restores a value that was never the old one.
//   5. A SCREEN THAT CLAIMS WHAT IT HASN'T READ. Before settings load, "No plan
//      yet — start from a suggested day" is a button that writes the starter over
//      a plan that exists and simply hasn't arrived.
//
// 1–4 are the pure functions in src/features/plan/planLogic.js. 5 renders the
// real PlanPage and the Brief's PlanTile to a string at a frozen clock, the
// page-render-smoke way: this file bundles itself with esbuild (the components
// are JSX) and re-enters with BR_PLAN_SMOKE_BUNDLED set.
//
// Zero network: fetch is replaced with a stub that throws and counts.
//   node scripts/plan-smoke.mjs

import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";

// Set before the first Date is constructed anywhere in the process. Chicago,
// the zone every date path in this app is written for (lib/dates.js).
process.env.TZ = "America/Chicago";

const REENTRY = "BR_PLAN_SMOKE_BUNDLED";

if (process.env[REENTRY] !== "1") {
  const root = path.resolve(import.meta.dirname, "..");
  const out = path.join(root, ".plan-smoke.tmp.mjs");
  await build({
    entryPoints: [path.join(root, "scripts", "plan-smoke.mjs")],
    bundle: true, platform: "node", format: "esm", outfile: out,
    loader: { ".jsx": "jsx" }, jsx: "automatic",
    // One React for the components and the harness — two copies of react-dom
    // render, but hooks from one can't see the dispatcher of the other.
    external: ["react", "react-dom", "react-dom/server", "@tanstack/react-query", "esbuild"],
    define: {
      "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", VITE_ANTHROPIC_API_KEY: "", DEV: false }),
    },
    logLevel: "error",
  });
  process.env[REENTRY] = "1";
  try {
    await import(pathToFileURL(out).href);
  } finally {
    await rm(out, { force: true });
  }
} else {
  await harness();
}

async function harness() {
  const L = await import("../src/features/plan/planLogic.js");
  const {
    PLAN_SETTING, DAY_TYPES, KINDS, kindMeta, parseHM, toHM, fmtTime, fmtDur, dayTypeOf, normalizePlan, planIsEmpty,
    withSpans, whereAmI, workWindow, upsertBlock, removeBlock, upsertRule, removeRule, restoreRule, restoreBlock, copyDay,
    blockProblem, firstWriteBase, STARTER,
  } = L;

  let failed = 0;
  const check = (name, cond, detail = "") => {
    if (cond) console.log(`ok: ${name}`);
    else { failed++; console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`); }
  };
  // Local wall-clock times, built from parts so they mean Chicago whatever the
  // machine is. 2026-10-12 is a Monday.
  const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi);
  const MON = (h, m) => at(2026, 10, 12, h, m);
  const FRI = (h, m) => at(2026, 10, 16, h, m);
  const SAT = (h, m) => at(2026, 10, 17, h, m);
  const SUN = (h, m) => at(2026, 10, 18, h, m);
  const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

  // ══ 1. time ════════════════════════════════════════════════════════════════
  check("parseHM reads a 24-hour HH:MM", parseHM("06:30") === 390 && parseHM("00:00") === 0 && parseHM("23:59") === 1439);
  check("parseHM tolerates a one-digit hour and padding", parseHM("7:05") === 425 && parseHM(" 06:00 ") === 360);
  check("parseHM refuses what isn't a time",
    [null, undefined, "", "24:00", "12:60", "7:5", "noon", 390, "06:30:61x", "06:30:"].every((v) => parseHM(v) === null));
  // A time input with a step under a minute reports seconds. Refusing that would
  // print "Pick a start time." under a time that is plainly picked.
  check("parseHM accepts seconds and drops them", parseHM("06:30:00") === 390 && parseHM("06:30:45.123") === 390);
  check("toHM is parseHM's inverse", ["00:00", "06:15", "12:00", "23:59"].every((s) => toHM(parseHM(s)) === s));
  check("toHM wraps past midnight", toHM(1440 + 30) === "00:30");
  check("fmtTime says AM and PM the American way",
    fmtTime(0) === "12:00 AM" && fmtTime(720) === "12:00 PM" && fmtTime(390) === "6:30 AM" && fmtTime(1439) === "11:59 PM",
    [0, 720, 390, 1439].map(fmtTime).join(" | "));
  check("fmtTime wraps a time tomorrow", fmtTime(1440 + 360) === "6:00 AM");
  check("fmtDur reads like a person", fmtDur(45) === "45m" && fmtDur(60) === "1h" && fmtDur(90) === "1h 30m" && fmtDur(0) === "0m");
  check("fmtDur never goes negative", fmtDur(-5) === "0m");

  // ══ 2. which template is today ══════════════════════════════════════════════
  check("Monday through Friday are weekdays", [12, 13, 14, 15, 16].every((d) => dayTypeOf(at(2026, 10, d, 12)) === "weekday"));
  check("Saturday and Sunday are the weekend", dayTypeOf(SAT(9)) === "weekend" && dayTypeOf(SUN(9)) === "weekend");
  // 23:30 Friday in Chicago is 04:30 Saturday UTC. getUTCDay would hand over the
  // weekend plan a night early.
  check("Friday night is still a weekday (local day, not UTC)",
    dayTypeOf(new Date("2026-10-16T23:30:00-05:00")) === "weekday" && new Date("2026-10-16T23:30:00-05:00").getUTCDay() === 6);
  check("two day types, weekday first", DAY_TYPES.map((d) => d.key).join(",") === "weekday,weekend");

  // ══ 3. the stored value, read tolerantly ════════════════════════════════════
  for (const [label, v] of [["null", null], ["a string", "garbage"], ["an array", [1, 2]], ["a number", 7], ["{}", {}], ["blocks as an object", { weekday: { blocks: { a: 1 } } }]]) {
    let p = null, threw = null;
    try { p = normalizePlan(v); } catch (e) { threw = e; }
    check(`a daily_plan that is ${label} reads as an empty plan`,
      !threw && p.weekday.blocks.length === 0 && p.weekend.blocks.length === 0 && Array.isArray(p.weekday.rules) && planIsEmpty(v),
      threw?.message);
  }
  const messy = normalizePlan({
    weekday: {
      blocks: [
        { id: "b", start: "13:00", title: "  Work  ", kind: "work" },
        { id: "a", start: "06:15", title: "Workout", kind: "body", protected: true },
        { id: "nostart", title: "Floating" },
        { id: "badstart", start: "25:00", title: "Nope" },
        { id: "notitle", start: "09:00", title: "   " },
        { id: "a", start: "07:00", title: "Duplicate id" },
        { id: "k", start: "18:00", title: "From the future", kind: "meditate", protected: "yes" },
        "a string block",
        { start: "21:00", title: "No id" },
      ],
      rules: ["Laptop closed until 8:30", { id: "r2", text: "  Hard stop  " }, { id: "r3", text: "" }, null, 5],
    },
  });
  const wd = messy.weekday;
  check("blocks with no usable start or title are dropped",
    !wd.blocks.some((b) => ["nostart", "badstart", "notitle"].includes(b.id)), wd.blocks.map((b) => b.id).join(","));
  check("a duplicate id keeps the first and drops the second", wd.blocks.filter((b) => b.id === "a").length === 1 && wd.blocks.find((b) => b.id === "a").title === "Workout");
  check("blocks come back in clock order", wd.blocks.map((b) => b.start).join(",") === "06:15,13:00,18:00,21:00", wd.blocks.map((b) => b.start).join(","));
  check("titles are trimmed", wd.blocks.find((b) => b.id === "b").title === "Work");
  check("an unknown kind lands on Life rather than vanishing", wd.blocks.find((b) => b.id === "k").kind === "life" && kindMeta("meditate").key === "life");
  check("protected is true only when it is literally true", wd.blocks.find((b) => b.id === "a").protected === true && wd.blocks.find((b) => b.id === "k").protected === false);
  check("a block with no id gets a stable one", (() => {
    const one = normalizePlan({ weekday: { blocks: [{ start: "21:00", title: "No id" }] } }).weekday.blocks[0].id;
    const two = normalizePlan({ weekday: { blocks: [{ start: "21:00", title: "No id" }] } }).weekday.blocks[0].id;
    return one && one === two;
  })());
  check("rules accept bare strings and drop the empty ones", wd.rules.map((r) => r.text).join("|") === "Laptop closed until 8:30|Hard stop", wd.rules.map((r) => r.text).join("|"));
  check("an over-long title is clipped, not refused",
    normalizePlan({ weekday: { blocks: [{ id: "x", start: "06:00", title: "x".repeat(500) }] } }).weekday.blocks[0].title.length === L.MAX_TITLE);
  check("four kinds, each a real token", KINDS.length === 4 && KINDS.every((k) => /^var\(--[a-z-]+\)$/.test(k.tone)));

  // ══ 4. where the day is ══════════════════════════════════════════════════════
  const plan = normalizePlan(STARTER);
  const w1 = whereAmI(plan, MON(7, 5));
  check("Monday 7:05 is the workout", w1.type === "weekday" && w1.current?.title === "Workout", w1.current?.title);
  check("…until 7:30, 25 minutes left", w1.current.endMin === 450 && Math.round(w1.minutesLeft) === 25, `${w1.current.endMin} ${w1.minutesLeft}`);
  check("…with breakfast next", w1.next?.title === "Shower, breakfast" && w1.next.startMin === 450);
  check("…and progress is the share of the block gone", Math.abs(w1.progress - 50 / 75) < 1e-9, String(w1.progress));
  const edge = whereAmI(plan, MON(8, 30));
  check("at exactly 8:30 you are IN the 8:30 block", edge.current?.start === "08:30", edge.current?.title);
  const w2 = whereAmI(plan, MON(5, 40));
  check("Monday 5:40 is still Sunday's sleep — the night belongs to the day before",
    w2.current?.title === "Sleep" && w2.current.carried === true && w2.current.id === "we-sleep", JSON.stringify(w2.current));
  check("…running until Monday's first block, 6:00", w2.current.endMin === 360 && Math.round(w2.minutesLeft) === 20);
  check("…and it began last night", w2.current.startMin === parseHM("23:30") - 1440);
  check("…with Monday's first block next", w2.next?.title === "Up — phone stays down");
  check("…and a progress that is a fraction", w2.progress > 0 && w2.progress < 1, String(w2.progress));
  const tue = whereAmI(plan, at(2026, 10, 13, 2, 0));
  check("Tuesday 2am carries Monday's (weekday) sleep", tue.current?.id === "wd-sleep" && tue.current.carried);
  const late = whereAmI(plan, MON(23, 0));
  check("Monday 11pm is sleep, ending at Tuesday's first block", late.current?.title === "Sleep" && late.current.endMin === 1440 + 360, String(late.current?.endMin));
  check("…and the next block is flagged as tomorrow", late.next?.tomorrow === true && late.next.title === "Up — phone stays down" && late.next.startMin === 1440 + 360);
  const fri = whereAmI(plan, FRI(23, 0));
  check("Friday 11pm runs until SATURDAY's first block (the weekend template)", fri.current.endMin === 1440 + parseHM("07:30") && fri.next.title === "Up, slow morning", `${fri.current.endMin} ${fri.next?.title}`);
  const sun = whereAmI(plan, SUN(23, 45));
  check("Sunday 11:45pm runs until Monday's 6:00", sun.current.endMin === 1440 + 360 && sun.next.title === "Up — phone stays down");
  const sat = whereAmI(plan, SAT(9, 0));
  check("Saturday 9am reads the weekend template", sat.type === "weekend" && sat.current?.title === "Workout or a long ride");

  const noWeekend = normalizePlan({ weekday: STARTER.weekday });
  const satEmpty = whereAmI(noWeekend, SAT(9, 0));
  check("a day whose template is empty says nothing, rather than inventing a block",
    satEmpty.current === null && satEmpty.next === null && satEmpty.minutesLeft === null);
  const monAfterEmpty = whereAmI(noWeekend, MON(5, 0));
  check("before the first block with nothing to carry over, there is no current block — only the start",
    monAfterEmpty.current === null && monAfterEmpty.next?.startMin === 360 && monAfterEmpty.minutesLeft === 60);
  const friNoWeekend = whereAmI(noWeekend, FRI(23, 0));
  check("the last block with an empty tomorrow ends at midnight", friNoWeekend.current.endMin === 1440 && friNoWeekend.next === null);
  check("whereAmI tolerates junk", whereAmI("junk", MON(9)).current === null && whereAmI(null, MON(9)).type === "weekday");
  for (const [label, d] of [["midnight", MON(0, 0)], ["one minute to midnight", MON(23, 59)], ["noon", MON(12, 0)], ["Saturday 3am", SAT(3, 0)]]) {
    const w = whereAmI(plan, d);
    check(`at ${label}, minutes left and progress are sane`,
      w.current && Number.isFinite(w.minutesLeft) && w.minutesLeft > 0 && w.progress >= 0 && w.progress <= 1, JSON.stringify({ l: w.minutesLeft, p: w.progress }));
  }

  // The night the clocks change. Which block you're in is read off the wall
  // clock (that's what the plan was written in); how long is LEFT is real time.
  // Wall-clock arithmetic said "7h 45m" on a night that was 8h 45m long.
  {
    const back = whereAmI(plan, at(2026, 10, 31, 23, 45)); // Sat, clocks go back at 2am
    check("clocks going back: Saturday 11:45pm to Sunday 7:30 is 8h 45m, not 7h 45m",
      back.current?.title === "Sleep" && Math.round(back.minutesLeft) === 525, String(back.minutesLeft));
    const backCarry = whereAmI(plan, at(2026, 11, 1, 0, 30)); // 12:30 CDT, before the repeat hour
    check("…and from 12:30am it is 8h, carried from the night before",
      backCarry.current?.carried && Math.round(backCarry.minutesLeft) === 480, String(backCarry.minutesLeft));
    const fwd = whereAmI(plan, at(2027, 3, 14, 1, 30)); // Sun, clocks go forward at 2am
    check("clocks going forward: Sunday 1:30am to 7:30 is 5h, not 6h",
      fwd.current?.title === "Sleep" && Math.round(fwd.minutesLeft) === 300, String(fwd.minutesLeft));
    check("…and progress stays a fraction on both nights", [back, backCarry, fwd].every((w) => w.progress > 0 && w.progress < 1));
  }

  // ══ 5. the work day ═════════════════════════════════════════════════════════
  const ww = workWindow(plan.weekday.blocks);
  check("the suggested weekday works 8:30 to 5:30", ww.start === 510 && ww.end === 1050 && !ww.open, JSON.stringify(ww));
  check("…which is 8h of work blocks, lunch excluded", ww.minutes === 480, String(ww.minutes));
  check("a day with no work has no work window", workWindow(plan.weekend.blocks) === null);
  const noStop = workWindow(normalizePlan({ weekday: { blocks: [{ id: "a", start: "08:00", title: "Work", kind: "work" }, { id: "b", start: "12:00", title: "Lunch", kind: "life" }, { id: "c", start: "13:00", title: "Work", kind: "work" }] } }).weekday.blocks);
  check("work as the LAST block is open-ended, not a 19-hour shift", noStop.open === true && noStop.end === null && noStop.minutes === 240, JSON.stringify(noStop));

  // ══ 6. edits — new values, never mutation ═══════════════════════════════════
  const frozen = deepFreeze(normalizePlan(STARTER));
  let added;
  try { added = upsertBlock(frozen, "weekday", { id: "new", start: "16:00", title: "Admin", kind: "work" }); } catch (e) { added = e; }
  check("upsertBlock never mutates (a frozen plan doesn't throw)", !(added instanceof Error), added?.message);
  check("…adds the block in time order", added.weekday.blocks.map((b) => b.id).indexOf("new") === added.weekday.blocks.map((b) => b.id).indexOf("wd-work2") + 1);
  check("…and leaves the other template alone", added.weekend === frozen.weekend || JSON.stringify(added.weekend) === JSON.stringify(frozen.weekend));
  const moved = upsertBlock(frozen, "weekday", { ...frozen.weekday.blocks.find((b) => b.id === "wd-workout"), start: "05:45" });
  check("editing a block's time re-sorts it", moved.weekday.blocks[0].id === "wd-workout" && moved.weekday.blocks.length === frozen.weekday.blocks.length);
  check("an invalid block is ignored, not half-saved", upsertBlock(frozen, "weekday", { id: "z", start: "nope", title: "x" }).weekday.blocks.length === frozen.weekday.blocks.length);
  const rm = removeBlock(frozen, "weekday", "wd-lunch");
  check("removeBlock removes exactly one", rm.weekday.blocks.length === frozen.weekday.blocks.length - 1 && !rm.weekday.blocks.some((b) => b.id === "wd-lunch"));
  const back = upsertBlock(rm, "weekday", frozen.weekday.blocks.find((b) => b.id === "wd-lunch"));
  check("undo puts a removed block back where it was", JSON.stringify(back.weekday) === JSON.stringify(frozen.weekday));
  const ruleGone = removeRule(frozen, "weekday", "wd-r2");
  const ruleBack = restoreRule(ruleGone, "weekday", frozen.weekday.rules[1], 1);
  check("undo puts a removed guardrail back at its index", ruleBack.weekday.rules.map((r) => r.id).join(",") === frozen.weekday.rules.map((r) => r.id).join(","));
  check("restoring a guardrail that is already there does nothing", restoreRule(frozen, "weekday", frozen.weekday.rules[0], 0).weekday.rules.length === frozen.weekday.rules.length);
  const ruleEdit = upsertRule(frozen, "weekday", { id: "wd-r1", text: "Laptop closed until 9." });
  check("upsertRule edits in place", ruleEdit.weekday.rules[0].text === "Laptop closed until 9." && ruleEdit.weekday.rules.length === frozen.weekday.rules.length);
  check("an empty guardrail is not saved", upsertRule(frozen, "weekday", { id: "q", text: "   " }).weekday.rules.length === frozen.weekday.rules.length);
  const copied = copyDay(frozen, "weekday", "weekend");
  check("copyDay makes the weekend a copy of the weekday", JSON.stringify(copied.weekend) === JSON.stringify(frozen.weekday));
  const tweaked = upsertBlock(copied, "weekend", { ...copied.weekend.blocks[0], title: "Sleep in" });
  check("…and editing the copy leaves the original alone", tweaked.weekday.blocks[0].title === frozen.weekday.blocks[0].title && tweaked.weekend.blocks[0].title === "Sleep in");

  // The Undo after a delete is applied to the plan as it is when tapped, and is
  // refused if another block has taken that minute in the meantime.
  {
    const lunch = frozen.weekday.blocks.find((b) => b.id === "wd-lunch");
    const gone = removeBlock(frozen, "weekday", "wd-lunch");
    const later = upsertBlock(gone, "weekday", { id: "nap", start: "15:00", title: "Walk", kind: "body" });
    const r = restoreBlock(later, "weekday", lunch);
    check("undo restores onto the CURRENT plan, keeping what was added since",
      r.plan && r.plan.weekday.blocks.some((b) => b.id === "wd-lunch") && r.plan.weekday.blocks.some((b) => b.id === "nap"));
    const taken = upsertBlock(gone, "weekday", { id: "call", start: "12:00", title: "Call", kind: "work" });
    const clash = restoreBlock(taken, "weekday", lunch);
    check("undo refuses to put a block on a minute something else now has", !clash.plan && /already starts at 12:00 PM/.test(clash.problem || ""), JSON.stringify(clash));
    check("undo of a block that is still there changes nothing", restoreBlock(frozen, "weekday", lunch).plan.weekday.blocks.length === frozen.weekday.blocks.length);
  }

  // The first write onto an EMPTY plan builds on what the database has. Settings
  // can be a stale {} (read before the two-factor step finished), and the first
  // button an empty plan offers writes the whole document.
  {
    const saved = normalizePlan(STARTER);
    const a = firstWriteBase({}, saved);
    check("an empty plan on screen with a saved plan in the database builds on the saved one",
      a.adopted === true && a.plan.weekday.blocks.length === saved.weekday.blocks.length);
    const b = firstWriteBase(null, null);
    check("empty on both sides is genuinely empty", b.adopted === false && planIsEmpty(b.plan));
    const c = firstWriteBase(saved, {});
    check("a plan already on screen is what gets built on — no adopting", c.adopted === false && c.plan.weekday.blocks.length === saved.weekday.blocks.length);
    check("a junk database value is not adopted", firstWriteBase({}, "junk").adopted === false);
  }

  // ══ 7. the editor's refusals ════════════════════════════════════════════════
  const day = frozen.weekday;
  check("a block needs a time", blockProblem(day, { id: "n", start: "", title: "x" }) === "Pick a start time.");
  check("a block needs a name", blockProblem(day, { id: "n", start: "10:00", title: "  " }) === "Give it a name.");
  check("two blocks can't start at the same minute", /already starts at 6:15 AM/.test(blockProblem(day, { id: "n", start: "06:15", title: "Run" }) || ""), blockProblem(day, { id: "n", start: "06:15", title: "Run" }));
  check("a block can be saved at its own time", blockProblem(day, { ...day.blocks[1] }) === null);
  check("a valid new block passes", blockProblem(day, { id: "n", start: "10:15", title: "Call" }) === null);

  // ══ 8. the suggested day says what this tab is for ══════════════════════════
  const s = normalizePlan(STARTER);
  check("the starter survives normalize intact",
    s.weekday.blocks.length === STARTER.weekday.blocks.length && s.weekend.blocks.length === STARTER.weekend.blocks.length
    && s.weekday.rules.length === STARTER.weekday.rules.length);
  const firstWork = s.weekday.blocks.find((b) => b.kind === "work");
  const workout = s.weekday.blocks.find((b) => b.kind === "body");
  check("the weekday workout comes BEFORE the first work block, and is protected",
    workout && firstWork && parseHM(workout.start) < parseHM(firstWork.start) && workout.protected);
  check("work does not start at 7", parseHM(firstWork.start) > 7 * 60, firstWork.start);
  check("the weekday has a protected hard stop after its last work block",
    (() => { const spans = withSpans(s.weekday.blocks); const lastWork = spans.filter((b) => b.kind === "work").pop(); const after = spans[spans.indexOf(lastWork) + 1]; return after && after.protected && after.kind !== "work"; })());
  check("block ids in the starter are unique per template", ["weekday", "weekend"].every((t) => new Set(s[t].blocks.map((b) => b.id)).size === s[t].blocks.length));

  // ══ 9. the wiring, read as source ═══════════════════════════════════════════
  const app = readFileSync("src/App.jsx", "utf8");
  const nav = readFileSync("src/shell/nav.js", "utf8");
  const cards = readFileSync("src/lib/brief-cards.js", "utf8");
  const brief = readFileSync("src/pages/brief/BriefPage.jsx", "utf8");
  const clock = readFileSync("src/features/plan/usePlanClock.js", "utf8");
  const db = readFileSync("src/data/db.js", "utf8");
  check("the tab is routed", /case "plan": return <PlanPage[^>]*updateSetting=\{updateSetting\}/.test(app));
  check("…lazily, so the editor stays out of the Brief's chunk", /const PlanPage = lazy\(/.test(app) && !/import \{ PlanPage \}/.test(app));
  check("the Brief card opens the tab", /onOpenPlan=\{\(\) => goToPage\("plan"\)\}/.test(app) && /onOpenPlan=\{onOpenPlan\}/.test(brief));
  check("the bar labels it Plan and the page titles it Daily Plan", /\{ key: "plan", label: "Plan" \}/.test(nav) && /plan: \{ title: "Daily Plan" \}/.test(nav));
  check("the plan card is first in the Brief catalogue", /BRIEF_CARDS = \[[\s\S]*?\{ id: "plan"/.test(cards) && (await import("../src/lib/brief-cards.js")).BRIEF_CARDS[0].id === "plan");
  check("the setting key is daily_plan", PLAN_SETTING === "daily_plan");
  // Deliberately a plain whole-value setting (see planLogic.js). If it ever
  // moves into the merging set, the SQL allowlist in 0033 has to move with it,
  // and systems-smoke is what checks those agree.
  check("daily_plan is not silently added to the merging settings", !/MERGING_SETTINGS = \{[^}]*daily_plan/.test(db));
  // The iOS resume: timers sleep while the PWA is backgrounded, so the clock
  // has to re-read the time when the app comes back, or the Brief shows last
  // night's block at 7am.
  check("the plan clock re-reads the time on return to the foreground",
    /visibilitychange/.test(clock) && /pageshow/.test(clock)
    && /const onShow = \(\) => \{ if \(document\.visibilityState !== "hidden"\) \{ tick\(\); arm\(\); \} \};/.test(clock));
  // Blocks start on the minute; an unaligned 30-second tick showed the old block
  // for up to half a minute after the new one began.
  check("…and wakes on the minute, not every 30 seconds from whenever",
    /setTimeout\(\(\) => \{ tick\(\); arm\(\); \}, 60000 - \(Date\.now\(\) % 60000\) \+ 50\)/.test(clock)
    && !/setInterval/.test(clock.replace(/\/\/[^\n]*/g, "")));
  // The component wiring the pure functions above can't reach. Source checks,
  // like section 9's others — each one is a bug a fresh review found by driving
  // the page in a browser, pinned so it can't come back quietly.
  const page = readFileSync("src/pages/plan/PlanPage.jsx", "utf8");
  check("each new day opens on that day's template (the choice lasts until midnight)",
    /const dayKey = localDayKey\(now\);/.test(page) && /useEffect\(\(\) => \{ setType\(todayType\); \}, \[dayKey\]\);/.test(page) && !/chose\.current/.test(page));
  check("a form saves into the template it was opened on, not whatever `type` is by then",
    /const \{ isNew, type: t, \.\.\.block \} = blockForm;/.test(page) && /save\(upsertRule\(res\.plan, ruleForm\.type,/.test(page));
  check("block and guardrail undo build on the plan as it is when tapped",
    /restoreBlock\(planRef\.current, t, gone\)/.test(page) && /restoreRule\(planRef\.current, t, gone, at\)/.test(page));
  check("the starter, a first block and a first guardrail all go through the database check",
    (page.match(/await baseForWrite\(\)/g) || []).length === 3 && /readRemote\(\)/.test(page) && /db\.loadSetting\(PLAN_SETTING\)/.test(page));
  check("copying a template reads the plan after the confirm, not before it",
    /if \(!ok\) return;[\s\S]{0,200}const cur = planRef\.current;/.test(page));

  // ══ 10. what the screen claims, rendered ════════════════════════════════════
  // Frozen at Monday 7:05 Central, mid-workout in the suggested day.
  const NOW = MON(7, 5).getTime();
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  globalThis.Date = FrozenDate;
  const fetchCalls = [];
  globalThis.fetch = (...a) => { fetchCalls.push(String(a[0])); throw new Error("plan-smoke: fetch is closed"); };

  const { PlanPage } = await import("../src/pages/plan/PlanPage.jsx");
  const { PlanTile } = await import("../src/pages/brief/PlanTile.jsx");
  const writes = [];
  const updateSetting = (k, v) => { writes.push([k, v]); return Promise.resolve({ ok: true }); };
  const text = (html) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const render = (el) => { try { return { html: renderToString(el), err: null }; } catch (e) { return { html: "", err: e }; } };
  const readRemote = () => Promise.resolve(null);
  const pageEl = (settings) => render(React.createElement(PlanPage, { isMobile: true, settings, updateSetting, readRemote }));
  const tile = (settings) => render(React.createElement(PlanTile, { isMobile: true, settings, collapsed: false, onToggle: () => {}, onOpenPlan: () => {} }));

  // settings not loaded
  {
    const p = pageEl(null), t = tile(null);
    check("PlanPage renders before settings load", !p.err, p.err?.message);
    check("…and says it is waiting, offering nothing to press", /Waiting for your saved plan/.test(text(p.html)) && !/suggested day|Start blank|Add a block/.test(text(p.html)));
    check("PlanTile renders before settings load", !t.err, t.err?.message);
    check("…as a skeleton, never 'no plan yet'", /class="sk /.test(t.html) && !/No weekday plan/.test(text(t.html)));
  }
  // loaded, no plan
  {
    const p = pageEl({}), t = tile({});
    check("an empty plan renders the first run", !p.err && /Start from a suggested day/.test(text(p.html)) && /Start blank/.test(text(p.html)), p.err?.message);
    check("the Brief card says there's no weekday plan and offers to set one", !t.err && /No weekday plan yet/.test(text(t.html)) && /Set the plan/.test(text(t.html)), t.err?.message);
    const junk = pageEl({ [PLAN_SETTING]: "garbage" }), junkTile = tile({ [PLAN_SETTING]: { weekday: { blocks: "nope" } } });
    check("a junk daily_plan renders the first run instead of throwing", !junk.err && /Start from a suggested day/.test(text(junk.html)) && !junkTile.err, junk.err?.message || junkTile.err?.message);
  }
  // loaded, the suggested day, Monday 7:05
  {
    const settings = { [PLAN_SETTING]: STARTER };
    const p = pageEl(settings), t = tile(settings);
    const pt = text(p.html), tt = text(t.html);
    check("PlanPage renders the plan", !p.err, p.err?.message);
    check("…opens on weekdays, marked Today", /Weekdays Today/.test(pt), pt.slice(0, 200));
    check("…with the workout as Now, until 7:30, 25m left", /Now until 7:30 AM Workout/.test(pt) && /25m left/.test(pt), pt.slice(0, 400));
    check("…called out as protected", /Protected — nothing gets scheduled over this/.test(pt));
    check("…with breakfast next", /Next 7:30 AM Shower, breakfast/.test(pt));
    check("…the work day in numbers", /Work day/.test(pt) && /8:30 AM – 5:30 PM/.test(pt) && /8h in work blocks/.test(pt), pt.match(/Work day.{0,80}/)?.[0]);
    check("…the guardrails", /Laptop stays closed until 8:30/.test(pt));
    check("…and every block of the day, in order", ["6:00", "6:15", "7:30", "8:30", "12:00", "1:00", "5:30", "6:00", "9:30", "10:30"].every((t) => pt.includes(t)));
    check("…with exactly one row marked as the current one", (p.html.match(/aria-current="time"/g) || []).length === 1);
    check("…the last block reads overnight, not a made-up duration", /Sleep overnight/.test(pt));
    check("nothing on the page is NaN or undefined", !/NaN|undefined/.test(pt));
    check("the Brief card leads with the same Now", !t.err && /Now until 7:30 AM Workout/.test(tt) && /25m left/.test(tt) && /Next 7:30 AM Shower, breakfast/.test(tt), tt.slice(0, 300));
    check("…shows the first three guardrails", /Laptop stays closed until 8:30/.test(tt) && /Hard stop at 5:30/.test(tt));
    check("…and links to the weekday plan", /Weekday/.test(tt));
    check("nothing on the card is NaN or undefined", !/NaN|undefined/.test(tt));
  }
  check("rendering wrote nothing", writes.length === 0, JSON.stringify(writes));
  check("nothing in this suite touched the network", fetchCalls.length === 0, fetchCalls.join(", "));
  globalThis.Date = RealDate;

  console.log(failed ? `\n${failed} plan check(s) failed` : "\nplan: all checks passed");
  // exitCode, not process.exit(): the finally in the wrapper still has to remove
  // the bundle this is running from.
  if (failed) process.exitCode = 1;
}
