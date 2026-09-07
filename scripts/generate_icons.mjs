import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const outDir = path.resolve('assets/icons');
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];

function createIconPng(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.18;
  const cx = size / 2;
  const cy = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const alpha = roundedRectAlpha(x, y, size, radius);
      const shade = 1 - (0.72 * y + 0.28 * x) / size;
      rgba[i] = Math.round(28 + shade * 28);
      rgba[i + 1] = Math.round(43 + shade * 35);
      rgba[i + 2] = Math.round(55 + shade * 42);
      rgba[i + 3] = alpha;
      if (alpha) {
        const dx = x - cx;
        const dy = y - cy;
        const ring = Math.abs(Math.hypot(dx, dy) - size * 0.27) < Math.max(1.5, size * 0.035);
        const orbit = Math.abs(Math.hypot(dx + size * 0.05, dy - size * 0.02) - size * 0.16) < Math.max(1, size * 0.018);
        const stem = x > size * 0.36 && x < size * 0.43 && y > size * 0.25 && y < size * 0.75;
        const node = Math.hypot(dx - size * 0.23, dy + size * 0.22) < size * 0.055;
        if (ring || orbit || stem || node) {
          rgba[i] = 238;
          rgba[i + 1] = 244;
          rgba[i + 2] = 247;
          rgba[i + 3] = 255;
        }
        if (Math.hypot(dx + size * 0.24, dy - size * 0.23) < size * 0.06) {
          rgba[i] = 47;
          rgba[i + 1] = 143;
          rgba[i + 2] = 110;
          rgba[i + 3] = 255;
        }
      }
    }
  }
  return encodePng(size, size, rgba);
}

function roundedRectAlpha(x, y, size, radius) {
  const inset = size * 0.04;
  const left = inset;
  const right = size - inset - 1;
  const top = inset;
  const bottom = size - inset - 1;
  const cornerX = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cornerY = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  const distance = Math.hypot(x - cornerX, y - cornerY);
  if (x >= left && x <= right && y >= top && y <= bottom && distance <= radius) return 255;
  return 0;
}

function encodePng(width, height, rgba) {
  const scanline = width * 4 + 1;
  const raw = Buffer.alloc(scanline * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * scanline] = 0;
    rgba.copy(raw, y * scanline + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(([size, png], index) => {
    const base = 6 + index * 16;
    header[base] = size === 256 ? 0 : size;
    header[base + 1] = size === 256 ? 0 : size;
    header[base + 2] = 0;
    header[base + 3] = 0;
    header.writeUInt16LE(1, base + 4);
    header.writeUInt16LE(32, base + 6);
    header.writeUInt32LE(png.length, base + 8);
    header.writeUInt32LE(offset, base + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map(([, png]) => png)]);
}

function createIcns(entries) {
  const chunks = entries.map(([type, data]) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const total = chunks.reduce((sum, item) => sum + item.length, 8);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

mkdirSync(outDir, { recursive: true });
const pngs = new Map();
for (const size of sizes) {
  const png = createIconPng(size);
  pngs.set(size, png);
  writeFileSync(path.join(outDir, `${size}x${size}.png`), png);
}
writeFileSync(path.join(outDir, 'icon.png'), pngs.get(1024));
writeFileSync(path.join(outDir, 'icon.ico'), createIco([16, 32, 48, 256].map((size) => [size, pngs.get(size)])));
writeFileSync(path.join(outDir, 'icon.icns'), createIcns([
  ['icp4', pngs.get(16)],
  ['icp5', pngs.get(32)],
  ['icp6', pngs.get(64)],
  ['ic07', pngs.get(128)],
  ['ic08', pngs.get(256)],
  ['ic09', pngs.get(512)],
  ['ic10', pngs.get(1024)],
]));
