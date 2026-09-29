// Board Room app icons — generated, no image deps.
// The compass (2026-09-30): a gold dial ring with cardinal and minor ticks, and a
// needle turned 40° toward the north-east — gold north half, darker south half —
// on true graphite. It replaced the ring-and-diamond seal; the in-app Seal
// (shell/Boot.jsx) is drawn separately.
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
const OBSIDIAN_TOP = hex("#1B1B1D");
const OBSIDIAN_BOT = hex("#000000");
const BRASS_HI = hex("#EACC80");
const BRASS_LO = hex("#C29A45");
const GLOW = hex("#D9B45C");

// ── geometry helpers (all in design units: the dial ring has radius 58) ──────
const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
};
const inTri = (px, py, a, b, c) => {
  const s1 = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
  const s2 = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]);
  const s3 = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};
const NEEDLE_DEG = 40;
const rot = (x, y) => {
  const a = (NEEDLE_DEG * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};
const NORTH = [rot(0, -42), rot(9, 0), rot(-9, 0)];
const SOUTH = [rot(0, 42), rot(9, 0), rot(-9, 0)];
const MAJOR = [[0, -56, 0, -44], [56, 0, 44, 0], [0, 56, 0, 44], [-56, 0, -44, 0]];
const MINOR = [[28, -49, 25, -44], [49, -28, 44, -25], [49, 28, 44, 25], [28, 49, 25, 44],
  [-28, 49, -25, 44], [-49, 28, -44, 25], [-49, -28, -44, -25], [-28, -49, -25, -44]];
const NEEDLE_SOUTH = hex("#A8843A");

// scale: motif fits within `fit` fraction of the canvas (maskable wants ~0.62)
function render(size, fit) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersampling — the needle and ticks are thin
  const c = size / 2;
  const ringR = size * 0.335 * fit / 0.78;   // ring radius (px)
  const u = ringR / 58;                       // px per design unit
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
          col = mix(col, GLOW, glowT * glowT * 0.07);
          const brass = mix(BRASS_HI, BRASS_LO, Math.min(1, Math.max(0, (Y - (c - ringR)) / (2 * ringR))));
          // design-space coordinates
          const dx = (X - c) / u, dy = (Y - c) / u;
          const dc = Math.hypot(dx, dy);
          if (Math.abs(dc - 58) <= 2.6) col = brass;                                   // dial ring
          if (MAJOR.some(([ax, ay, bx, by]) => segDist(dx, dy, ax, ay, bx, by) <= 2)) col = brass;       // N E S W ticks
          if (MINOR.some(([ax, ay, bx, by]) => segDist(dx, dy, ax, ay, bx, by) <= 1.3)) col = BRASS_LO;  // minor ticks
          if (inTri(dx, dy, ...SOUTH)) col = NEEDLE_SOUTH;                              // needle, south half
          if (inTri(dx, dy, ...NORTH)) col = mix(brass, BRASS_HI, 0.25);                // needle, north half
          if (dc <= 5) col = mix(OBSIDIAN_TOP, OBSIDIAN_BOT, ty);                       // pivot
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
