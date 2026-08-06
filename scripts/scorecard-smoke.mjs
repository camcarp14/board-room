// ─── ScoreCard smoke — the picture must not outrun the payload ───────────────
//
// The card's one idea is that a block's bar LENGTH is what it is worth out of
// 100 and its FILL is what the name earned. That is a strong visual claim, and
// every way it goes wrong is silent:
//
//   1. A HARDCODED DENOMINATOR. If the block maxes were written into the
//      client, reweighting a part in the screener would leave every bar drawn
//      against a total that no longer exists — and nothing on screen would
//      look wrong. The maxes are summed from the parts themselves; this file
//      proves the client contains no copy of them.
//   2. A DROPPED PART. A part whose key no block claims would vanish from the
//      picture while still counting toward the headline, so the blocks would
//      quietly stop adding up to the score. Orphans get their own row.
//   3. NOT MEASURED DRAWN AS ZERO. An empty bar meaning "SPY did not come
//      back" is a claim about the stock nobody made. This is the same
//      Number(null)===0 trap that has already cost this codebase a fake
//      "decelerating hard" and a fleet of price-0 rows.
//   4. A PENALTY IN A METER. parabolic carries max 0 and points -25. There is
//      no denominator, so a bar is impossible; it must render as a deduction.
//      And it must render LOUDLY — the live parabolic row had "this is a
//      chase, not an entry" as grey bullet four of five at the bottom of a
//      1900px sheet, in the same colour as "5 sessions +15.7% vs SPY".
//   5. THE TWO TABS DRIFTING. One component serves both sheets. If the block
//      tables stop covering every key their engine emits, one tab silently
//      loses a block.
//
// Run with `node scripts/scorecard-smoke.mjs`.

import esbuild from "esbuild";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const OUT_DIR = ".scorecard-smoke";
const require_ = createRequire(import.meta.url);

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`ok: ${name}`);
  else { failed++; console.error(`FAIL: ${name} ${detail}`); }
};

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

try {
  // groupParts is the whole of the card's arithmetic. Bundle just it — the JSX
  // around it is checked by the source assertions further down.
  const out = resolve(OUT_DIR, "scorecard.cjs");
  esbuild.buildSync({
    entryPoints: ["src/pages/markets/ScoreCard.jsx"],
    bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent",
    jsx: "automatic", external: ["react", "react/jsx-runtime"],
  });
  const { groupParts } = require_(out);
  check("groupParts is exported", typeof groupParts === "function");

  const BLOCKS = [
    { key: "trend", label: "Trend vs SPY", keys: ["rs5", "rs21"] },
    { key: "pace", label: "Pace", keys: ["accelSession", "accel5v21"] },
    { key: "volume", label: "Volume behind it", keys: ["rvol"] },
    { key: "break", label: "Range & break", keys: ["range", "break"] },
    { key: "high", label: "Near its high", keys: ["high"] },
  ];
  // FCX exactly as the live settle wrote it — 70/100.
  const FCX = [
    { key: "rs5", max: 15, points: 15, measured: true },
    { key: "rs21", max: 10, points: 8, measured: true },
    { key: "accelSession", max: 18, points: 3, measured: true },
    { key: "accel5v21", max: 12, points: 12, measured: true },
    { key: "rvol", max: 15, points: 4, measured: true },
    { key: "range", max: 10, points: 10, measured: true },
    { key: "break", max: 10, points: 10, measured: true },
    { key: "high", max: 10, points: 8, measured: true },
  ];

  const g = groupParts(FCX, BLOCKS);
  const by = Object.fromEntries(g.blocks.map((b) => [b.key, b]));
  check("the five blocks offer exactly 100 between them",
    g.blocks.reduce((s, b) => s + b.max, 0) === 100, String(g.blocks.reduce((s, b) => s + b.max, 0)));
  check("the blocks sum to the score the engine published",
    g.blocks.reduce((s, b) => s + b.points, 0) === 70, String(g.blocks.reduce((s, b) => s + b.points, 0)));
  check("trend is 23 of 25", by.trend.points === 23 && by.trend.max === 25, JSON.stringify(by.trend));
  check("pace is 15 of 30 — the hole the reader is meant to see",
    by.pace.points === 15 && by.pace.max === 30, JSON.stringify(by.pace));
  check("volume is 4 of 15 — the other hole", by.volume.points === 4 && by.volume.max === 15);
  check("range & break is a full 20", by.break.points === 20 && by.break.max === 20);
  check("no penalties on a clean row", g.penalties.length === 0);

  // ─── 1. the denominator is never written down in the client ───────────────
  const cardSrc = readFileSync("src/pages/markets/ScoreCard.jsx", "utf8");
  const stockSrc = readFileSync("src/pages/markets/StockSheet.jsx", "utf8");
  const cryptoSrc = readFileSync("src/pages/markets/AltCoinSheet.jsx", "utf8");
  check("the card sums each block's max from its own parts",
    /max:\s*mine\.reduce\(/.test(cardSrc));
  check("no block table hardcodes a max, on either tab",
    !/max:\s*\d+/.test(stockSrc.slice(stockSrc.indexOf("SCORE_BLOCKS"), stockSrc.indexOf("const num =")))
    && !/max:\s*\d+/.test(cryptoSrc.slice(cryptoSrc.indexOf("CRYPTO_BLOCKS"), cryptoSrc.indexOf("const num ="))));
  // Reweight the screener and the picture must follow with no client change.
  const REWEIGHTED = FCX.map((p) => (p.key === "rvol" ? { ...p, max: 30, points: 8 } : p));
  const g2 = groupParts(REWEIGHTED, BLOCKS);
  check("reweighting a part upstream moves the block without a client edit",
    g2.blocks.find((b) => b.key === "volume").max === 30, JSON.stringify(g2.blocks.find((b) => b.key === "volume")));

  // ─── the bar's width IS the weight, with no padding ──────────────────────
  // The tempting version floors small blocks at a minimum width so they do not
  // look like smears, and it destroys the only claim the drawing makes: a 30
  // and a 10 stop being 3:1. At 354pt of card the smallest block still draws
  // 35pt, which needs no help.
  check("bar width is a straight percentage of max — no floor, no additive pad",
    /width:\s*`\$\{b\.max\}%`/.test(cardSrc), "width is not a bare b.max%");
  check("...so nothing rescales, offsets or clamps the track",
    !/Math\.max\(\s*\d+\s*,\s*b\.max/.test(cardSrc) && !/\d+\s*\+\s*\(?b\.max/.test(cardSrc));
  // The fill is POINTS, not performance. The ladder is ordinal — level with SPY
  // earns 6 of 15 — so the sub-line must always carry the raw number, or the
  // bar becomes the only information and a reader would take 40% for an edge.
  for (const [tab, src, marker] of [["stock", stockSrc, "SCORE_BLOCKS"], ["crypto", cryptoSrc, "CRYPTO_BLOCKS"]]) {
    const seg = src.slice(src.indexOf(marker), src.indexOf("const num ="));
    const subs = (seg.match(/sub:\s*\(r\)\s*=>/g) || []).length;
    check(`every ${tab} block carries a sub-line with the raw number it was scored from`,
      subs === 5, `${subs} of 5`);
  }

  // ─── 2. an unclaimed part still gets drawn ────────────────────────────────
  const WITH_NEW = [...FCX, { key: "sentiment", max: 12, points: 7, measured: true, label: "a block nobody has mapped yet" }];
  const g3 = groupParts(WITH_NEW, BLOCKS);
  check("a part no block claims gets its own row rather than vanishing",
    g3.blocks.some((b) => b.key === "sentiment"), g3.blocks.map((b) => b.key).join(","));
  check("...so the columns still add up to the engine's total",
    g3.blocks.reduce((s, b) => s + b.points, 0) === 77 && g3.blocks.reduce((s, b) => s + b.max, 0) === 112);
  check("...and it keeps the server's own label, since the client has no name for it",
    g3.blocks.find((b) => b.key === "sentiment").label === "a block nobody has mapped yet");

  // ─── 3. not measured is not zero ─────────────────────────────────────────
  const NO_BENCH = FCX.map((p) => (p.key === "rs5" || p.key === "rs21" ? { ...p, points: 0, measured: false } : p));
  const g4 = groupParts(NO_BENCH, BLOCKS);
  check("a block with no measured member reports itself unmeasured",
    g4.blocks.find((b) => b.key === "trend").measured === false);
  check("...while every block that was measured stays measured",
    g4.blocks.filter((b) => b.key !== "trend").every((b) => b.measured));
  check("the card draws no fill at all for an unmeasured block",
    /b\.measured\s*&&\s*\(/.test(cardSrc) || /\{b\.measured && </.test(cardSrc));
  check("...and says so in words rather than showing 0 of something",
    cardSrc.includes('"not measured"'));
  // Half-measured is still a real denominator: rs5 present, rs21 absent.
  const HALF = FCX.map((p) => (p.key === "rs21" ? { ...p, points: 0, measured: false } : p));
  check("a half-measured block still reads as measured — it has a real fill",
    groupParts(HALF, BLOCKS).blocks.find((b) => b.key === "trend").measured === true);

  // ─── 4. penalties are deductions, never meters ───────────────────────────
  const PARA = [...FCX,
    { key: "parabolic", max: 0, points: -25, measured: true, label: "parabolic — already gone" },
    { key: "thin", max: 0, points: -15, measured: true, label: "too thin to trade" },
  ];
  const g5 = groupParts(PARA, BLOCKS);
  check("a penalty never enters a block", g5.blocks.every((b) => b.max > 0));
  check("both penalties are separated out", g5.penalties.length === 2, JSON.stringify(g5.penalties.map((p) => p.key)));
  check("the blocks still offer 100 with penalties present",
    g5.blocks.reduce((s, b) => s + b.max, 0) === 100);
  check("a max-0 part with POSITIVE points is not mistaken for a penalty",
    groupParts([...FCX, { key: "odd", max: 0, points: 3, measured: true }], BLOCKS).penalties.length === 0);
  check("the deductions render above the blocks, where judgment goes",
    cardSrc.indexOf("penalties.map") < cardSrc.indexOf("rows.map"));
  check("a deduction is drawn in the red the sheet reserves for loss",
    /penalties\.map[\s\S]{0,420}T\.red/.test(cardSrc));
  check("the earned/docked caption appears ONLY when something was docked",
    /penalties\.length > 0 &&[\s\S]{0,200}docked/.test(cardSrc));

  // ─── degenerate input never throws ───────────────────────────────────────
  for (const [name, parts] of [["null", null], ["empty", []], ["undefined", undefined]]) {
    const r = groupParts(parts, BLOCKS);
    check(`${name} parts[] yields no blocks and no crash`, r.blocks.length === 0 && r.penalties.length === 0);
  }
  check("a part with a non-numeric points contributes 0 rather than NaN",
    Number.isFinite(groupParts([{ key: "rs5", max: 15, points: null }], BLOCKS).blocks[0].points));

  // ─── 5. the two tabs stay twins ──────────────────────────────────────────
  const keysIn = (src, marker) => {
    const seg = src.slice(src.indexOf(marker), src.indexOf("const num ="));
    return [...seg.matchAll(/keys:\s*\[([^\]]+)\]/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/["']/g, "")));
  };
  const stockKeys = keysIn(stockSrc, "SCORE_BLOCKS");
  const cryptoKeys = keysIn(cryptoSrc, "CRYPTO_BLOCKS");
  const engineKeys = (file) => {
    const src = readFileSync(file, "utf8");
    return [...src.matchAll(/parts\.push\(\{\s*\n?\s*key:\s*"([a-zA-Z0-9]+)"/g)].map((m) => m[1])
      .concat([...src.matchAll(/key:\s*"([a-zA-Z0-9]+)",\s*max:\s*\d+/g)].map((m) => m[1]));
  };
  const stockEngine = [...new Set(engineKeys("netlify/functions/stock-settle-background.js"))].filter((k) => k !== "parabolic" && k !== "thin");
  const cryptoEngine = [...new Set(engineKeys("netlify/functions/alt-cron-background.js"))].filter((k) => k !== "parabolic" && k !== "thin");
  const missStock = stockEngine.filter((k) => !stockKeys.includes(k));
  const missCrypto = cryptoEngine.filter((k) => !cryptoKeys.includes(k));
  check("every scored key the stock engine emits has a block on the stock sheet",
    missStock.length === 0, missStock.join(","));
  check("every scored key the crypto engine emits has a block on the crypto sheet",
    missCrypto.length === 0, missCrypto.join(","));
  // The tabs are twins in SHAPE, not in every key: volume/turnover and
  // high/room differ because the underlying facts do (equities have relative
  // volume and a 251-session high; crypto has turnover against cap and an
  // all-time high). What must not drift is the count, the order, and the three
  // blocks that mean the same thing on both sides — one component draws them.
  const blockKeys = (src, marker) => {
    const seg = src.slice(src.indexOf(marker), src.indexOf("const num ="));
    return [...seg.matchAll(/key:\s*"([a-z]+)",\s*label:/g)].map((m) => m[1]);
  };
  const sb = blockKeys(stockSrc, "SCORE_BLOCKS"), cb = blockKeys(cryptoSrc, "CRYPTO_BLOCKS");
  check("both tabs declare five blocks", sb.length === 5 && cb.length === 5, `${sb.length}/${cb.length}`);
  check("the blocks that mean the same thing on both tabs sit in the same slots",
    sb[0] === cb[0] && sb[1] === cb[1] && sb[3] === cb[3] && sb[0] === "trend" && sb[1] === "pace" && sb[3] === "break",
    `${sb.join(",")} vs ${cb.join(",")}`);
  check("the two that legitimately differ are the ones that measure different things",
    sb[2] === "volume" && cb[2] === "turnover" && sb[4] === "high" && cb[4] === "room",
    `${sb[2]}/${cb[2]} and ${sb[4]}/${cb[4]}`);

  // ─── the sheets actually render it, and the prose is retired ─────────────
  for (const [name, src] of [["stock", stockSrc], ["crypto", cryptoSrc]]) {
    check(`the ${name} sheet renders the ScoreCard`, /<ScoreCard/.test(src));
    check(`the ${name} sheet no longer prints facts[] on the default surface`,
      !/facts\.map\(/.test(src), "facts.map still present");
    check(`the ${name} sheet still HANDS facts to the card, so nothing is deleted`,
      /facts=\{facts\}/.test(src));
    check(`the ${name} sheet's episode line is its own row, not middot-joined to the score`,
      !/\{tier && <>\{tier\.label\} · <\/>\}/.test(src));
  }
  check("the stock sheet renders the catalyst the payload has always carried",
    /catalyst\?\.note/.test(stockSrc) && /Why it might move/i.test(stockSrc));
  check("...and the relevance-filtered headline under it", /headline\.title/.test(stockSrc));
  const stockBody = stockSrc.slice(stockSrc.indexOf("export default function"));
  check("ATR is a labelled number now, not a clause in a grey run-on",
    /label="Normal day"/.test(stockSrc) && !/a normal day for this one is/.test(stockBody));
  check("...and the bare trailing sector word got a label",
    /label="Sector"/.test(stockSrc) && !/` · \$\{row\.sector\}`/.test(stockBody));

  // ─── house rules ─────────────────────────────────────────────────────────
  const sizes = [...cardSrc.matchAll(/fontSize:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check("nothing on the card is under the 10.5px floor", sizes.every((n) => n >= 10.5), sizes.filter((n) => n < 10.5).join(","));
  check("the disclosure is a real touch target", /minHeight:\s*44/.test(cardSrc));
  // The expand contract: grid-template-rows 0fr takes its minimum from the
  // item's min-content, and padding is NOT clipped by overflow:hidden — so the
  // inner div must carry none, exactly as CollapsibleCard's does not. This
  // leaked the first bullet through a shut disclosure until it was fixed.
  check("the collapse wrapper's immediate child carries no padding",
    /className=\{`expand\$\{open \? " open" : ""\}`\}>\s*\n\s*<div>\s*\n/.test(cardSrc));
  // The house rule bans DRAWN borders. `border: "none"` is the kit's idiom for
  // stripping a <button>'s default chrome and is the opposite of a violation.
  const drawnBorders = [...cardSrc.matchAll(/border(?:Top|Bottom|Left|Right)?:\s*"([^"]+)"/g)]
    .map((m) => m[1]).filter((v) => v !== "none");
  check("no drawn borders on the card", drawnBorders.length === 0, drawnBorders.join(" | "));
  check("no emoji in the card's chrome", !/\p{Extended_Pictographic}/u.test(cardSrc));
  check("no dollar-denominated position sizing",
    !/position siz|\$\d+\s*(position|stake|size)/i.test(cardSrc + stockSrc + cryptoSrc));
} catch (e) {
  failed++;
  console.error(`FAIL: smoke crashed — ${(e && e.stack) || e}`);
} finally {
  rmSync(OUT_DIR, { recursive: true, force: true });
}

console.log(failed ? `\nSCORECARD SMOKE FAILED (${failed})` : "\nSCORECARD SMOKE PASS");
process.exit(failed ? 1 : 0);
