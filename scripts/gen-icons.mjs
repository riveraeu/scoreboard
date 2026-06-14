// Generates PWA icons (public/icon-192.png, icon-512.png) — a trophy motif on the
// app's dark surface, drawn with a tiny built-in PNG encoder (no native image deps).
// The same trophy backs the browser-tab favicon (index.html points at icon-192.png).
// Run: node scripts/gen-icons.mjs   (icons are committed; re-run only to restyle.)
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [0x0d, 0x11, 0x17];     // C.bg
const GREEN = [0x3f, 0xb9, 0x50];  // C.green

// CRC32 (PNG chunk checksum).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function drawIcon(size) {
  // RGBA pixel buffer, fully opaque.
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);

  // Trophy, drawn from fractions of `size` so both 192 and 512 stay crisp.
  // All geometry sits within the maskable safe zone (~62% center, 0.19 inset).
  const cx = size / 2;
  const rimTop = 0.21 * size;       // flat top of the cup
  const bowlBot = 0.49 * size;      // where the bowl tapers to the stem
  const wRim = 0.19 * size;         // cup half-width at the rim
  const fillSpan = (y, halfW) => {
    for (let x = cx - halfW; x <= cx + halfW; x++) set(x, y, GREEN);
  };

  // Cup bowl: quarter-ellipse — full width at the rim, narrowing to a round bottom.
  for (let y = rimTop; y <= bowlBot; y++) {
    const t = (y - rimTop) / (bowlBot - rimTop);   // 0 at rim → 1 at bottom
    fillSpan(y, wRim * Math.sqrt(Math.max(0, 1 - t * t)));
  }

  // Handles: outer arc of a thick ring on each side of the rim (open toward the cup).
  const hcy = 0.30 * size, rOut = 0.115 * size, rIn = 0.072 * size;
  for (const side of [-1, 1]) {
    const hcx = cx + side * 0.16 * size;
    for (let y = hcy - rOut; y <= hcy + rOut; y++) {
      for (let x = hcx - rOut; x <= hcx + rOut; x++) {
        const d = Math.hypot(x - hcx, y - hcy);
        if (d < rIn || d > rOut) continue;
        if (side < 0 && x > hcx) continue;          // keep outer (left) half
        if (side > 0 && x < hcx) continue;          // keep outer (right) half
        set(x, y, GREEN);
      }
    }
  }

  // Stem, foot (trapezoid), and plinth.
  const stemHalf = 0.035 * size, stemBot = 0.585 * size;
  for (let y = bowlBot; y <= stemBot; y++) fillSpan(y, stemHalf);
  const footBot = 0.625 * size, footHalfT = 0.06 * size, footHalfB = 0.115 * size;
  for (let y = stemBot; y <= footBot; y++) {
    const t = (y - stemBot) / (footBot - stemBot);
    fillSpan(y, footHalfT + (footHalfB - footHalfT) * t);
  }
  const plinthBot = 0.70 * size, plinthHalf = 0.165 * size;
  for (let y = footBot; y <= plinthBot; y++) fillSpan(y, plinthHalf);

  // Raw scanlines, each prefixed with filter byte 0.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const out = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(out, drawIcon(size));
  console.log(`wrote public/icon-${size}.png`);
}
