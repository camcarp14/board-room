// Board Room app icons — generated, no image deps.
// A brass seal: diamond mark inside an engraved ring, on candlelit obsidian.
// Pure node: hand-built PNG chunks (zlib deflate + CRC32) over a supersampled
// SDF rasterizer. Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

// ── PNG plumbing ─────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function writePng(path, size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  console.log(`ok: ${path} (${size}x${size}, ${png.length} bytes)`);
}

// ── scene ────────────────────────────────────────────────────────────────────
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const OBSIDIAN_TOP = hex("#1D2440");
const OBSIDIAN_BOT = hex("#080B16");
const BRASS_HI = hex("#F0D797");
const BRASS_LO = hex("#B08C3B");
const GLOW = hex("#D6B160");

// scale: motif fits within `fit` fraction of the canvas (maskable wants ~0.62)
function render(size, fit) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 3; // 3x3 supersampling
  const c = size / 2;
  const ringR = size * 0.335 * fit / 0.78;   // ring radius
  const ringW = size * 0.022 * fit / 0.78;   // ring stroke
  const diaR = size * 0.155 * fit / 0.78;    // diamond half-diagonal
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const X = x + (sx + 0.5) / SS;
          const Y = y + (sy + 0.5) / SS;
          const ty = Y / size;
          // obsidian base with a faint candle glow rising from the center
          let col = mix(OBSIDIAN_TOP, OBSIDIAN_BOT, ty);
          const dGlow = Math.hypot(X - c, Y - c * 1.05);
          const glowT = Math.max(0, 1 - dGlow / (size * 0.62));
          col = mix(col, GLOW, glowT * glowT * 0.10);
          // brass vertical sheen shared by ring + diamond
          const brass = mix(BRASS_HI, BRASS_LO, Math.min(1, Math.max(0, (Y - (c - ringR)) / (2 * ringR))));
          // engraved ring
          const dRing = Math.abs(Math.hypot(X - c, Y - c) - ringR);
          if (dRing < ringW) {
            const aa = Math.min(1, (ringW - dRing) / (size / 512));
            col = mix(col, brass, Math.min(1, aa));
          }
          // diamond seal
          const dDia = (Math.abs(X - c) + Math.abs(Y - c)) - diaR;
          if (dDia < 0) {
            const aa = Math.min(1, -dDia / (size / 256));
            // inner facet: lighter toward the top point
            const facet = mix(brass, BRASS_HI, Math.max(0, 1 - (Y - (c - diaR)) / diaR) * 0.35);
            col = mix(col, facet, Math.min(1, aa));
          }
          r += col[0]; g += col[1]; b += col[2];
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = 255;
    }
  }
  return px;
}

writePng(join(outDir, "icon-180.png"), 180, render(180, 0.78)); // apple-touch
writePng(join(outDir, "icon-192.png"), 192, render(192, 0.78));
writePng(join(outDir, "icon-512.png"), 512, render(512, 0.78));
writePng(join(outDir, "icon-512-maskable.png"), 512, render(512, 0.60));
