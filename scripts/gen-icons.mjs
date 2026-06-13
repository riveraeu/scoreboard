// Generates PWA icons (public/icon-192.png, icon-512.png) — a bar-chart motif on the
// app's dark surface, drawn with a tiny built-in PNG encoder (no native image deps).
// Run: node scripts/gen-icons.mjs   (icons are committed; re-run only to restyle.)
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [0x0d, 0x11, 0x17];   // C.bg
const BAR = [0x3f, 0xb9, 0x50];  // C.green

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
    const o = (y * size + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);

  // Three ascending bars within the maskable safe zone (center ~62%).
  const inset = Math.round(size * 0.19);
  const innerW = size - inset * 2;
  const baseY = size - inset;             // bottom of bars
  const gap = Math.round(innerW * 0.08);
  const barW = Math.round((innerW - gap * 2) / 3);
  const heights = [0.45, 0.68, 1.0];      // fractions of available height
  const maxH = size - inset * 2;
  for (let b = 0; b < 3; b++) {
    const x0 = inset + b * (barW + gap);
    const h = Math.round(maxH * heights[b]);
    const y0 = baseY - h;
    for (let y = y0; y < baseY; y++)
      for (let x = x0; x < x0 + barW; x++) set(x, y, BAR);
  }

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
