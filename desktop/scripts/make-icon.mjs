import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/icons");
mkdirSync(root, { recursive: true });
const size = 256;
const pixels = Buffer.alloc(size * size * 4);
const put = (x, y, color) => { if (x < 0 || y < 0 || x >= size || y >= size) return; pixels.set(color, (y * size + x) * 4); };
const green = [38, 118, 82, 255], white = [255, 255, 255, 255], gold = [240, 191, 104, 255];
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const dx = x < 42 ? 42 - x : x > 214 ? x - 214 : 0;
  const dy = y < 42 ? 42 - y : y > 214 ? y - 214 : 0;
  if (dx * dx + dy * dy <= 42 * 42) put(x, y, green);
}
const rect = (x1, y1, x2, y2, color, radius = 0) => {
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
    const cx = x < x1 + radius ? x1 + radius : x > x2 - radius ? x2 - radius : x;
    const cy = y < y1 + radius ? y1 + radius : y > y2 - radius ? y2 - radius : y;
    if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) put(x, y, color);
  }
};
rect(66, 103, 190, 201, white, 20);
for (let y = 73; y <= 116; y++) for (let x = 98; x <= 158; x++) {
  const d = Math.hypot(x - 128, y - 103);
  if (d >= 24 && d <= 31 && y <= 104) put(x, y, white);
}
rect(100, 111, 108, 139, white, 3);
rect(148, 111, 156, 139, white, 3);
rect(107, 147, 149, 155, green, 4);
rect(107, 164, 149, 172, gold, 4);
rect(107, 181, 138, 189, green, 4);

function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type); const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0); name.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length); return result;
}
const png = (edge) => {
  const rows = Buffer.alloc(edge * (edge * 4 + 1));
  for (let y = 0; y < edge; y++) {
    rows[y * (edge * 4 + 1)] = 0;
    for (let x = 0; x < edge; x++) {
      const sx = Math.floor(x * size / edge), sy = Math.floor(y * size / edge), from = (sy * size + sx) * 4, to = y * (edge * 4 + 1) + 1 + x * 4;
      pixels.copy(rows, to, from, from + 4);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(edge, 0); ihdr.writeUInt32BE(edge, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
};
const icon256 = png(256);
writeFileSync(join(root, "32x32.png"), png(32));
writeFileSync(join(root, "128x128.png"), png(128));
writeFileSync(join(root, "128x128@2x.png"), icon256);
const ico = Buffer.alloc(22 + icon256.length);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; ico[8] = 0; ico[9] = 0; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(icon256.length, 14); ico.writeUInt32LE(22, 18); icon256.copy(ico, 22);
writeFileSync(join(root, "icon.ico"), ico);
