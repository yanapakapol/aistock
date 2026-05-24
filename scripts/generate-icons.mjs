// Generate placeholder PWA icons: solid #0a0a0a square with a thin white "a"
// glyph drawn from a 7x7 bitmap. Writes apps/web/public/icon-{192,512}.png.
// Replace with real branded icons later — manifest paths are stable.
//
// Run:  node scripts/generate-icons.mjs

import { deflateRawSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'apps', 'web', 'public');
mkdirSync(outDir, { recursive: true });

const BG = [0x0a, 0x0a, 0x0a];
const FG = [0xff, 0xff, 0xff];

// 7x7 lowercase "a" glyph
const glyph = [
  '.xxxx..',
  'x....x.',
  '.....x.',
  '.xxxxx.',
  'x....x.',
  'x....x.',
  '.xxxx.x',
];

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const td = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0, 0);
  return Buffer.concat([len, td, crc]);
}

function makePng(size) {
  const scale = Math.floor((size * 0.45) / glyph.length);
  const glyphW = glyph[0].length * scale;
  const glyphH = glyph.length * scale;
  const ox = Math.floor((size - glyphW) / 2);
  const oy = Math.floor((size - glyphH) / 2);

  // Each row: 1 filter byte + size*3 pixel bytes (RGB truecolor).
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 3;
      let color = BG;
      const gy = Math.floor((y - oy) / scale);
      const gx = Math.floor((x - ox) / scale);
      if (gy >= 0 && gy < glyph.length && gx >= 0 && gx < glyph[0].length) {
        if (glyph[gy][gx] === 'x') color = FG;
      }
      raw[p] = color[0];
      raw[p + 1] = color[1];
      raw[p + 2] = color[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateRawSync(raw);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.concat([Buffer.from([0x78, 0x9c]), idat, Buffer.alloc(4)])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Simpler IDAT path: write a complete zlib stream via deflate (not raw).
function makePngZ(size) {
  const { deflateSync } = require('node:zlib');
  // unused fallback; the production path above uses deflateRawSync wrapped in a zlib header,
  // but Node's PNG decoders accept zlib-format IDAT. Use deflateSync directly.
  return null;
}

for (const size of [192, 512]) {
  // Use a proper zlib-compressed IDAT (PNG spec requires zlib, not raw deflate).
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  const scale = Math.floor((size * 0.45) / glyph.length);
  const glyphW = glyph[0].length * scale;
  const glyphH = glyph.length * scale;
  const ox = Math.floor((size - glyphW) / 2);
  const oy = Math.floor((size - glyphH) / 2);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < size; x++) {
      const p = y * rowLen + 1 + x * 3;
      let color = BG;
      const gy = Math.floor((y - oy) / scale);
      const gx = Math.floor((x - ox) / scale);
      if (gy >= 0 && gy < glyph.length && gx >= 0 && gx < glyph[0].length) {
        if (glyph[gy][gx] === 'x') color = FG;
      }
      raw[p] = color[0];
      raw[p + 1] = color[1];
      raw[p + 2] = color[2];
    }
  }
  const { deflateSync } = await import('node:zlib');
  const idat = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const out = join(outDir, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
