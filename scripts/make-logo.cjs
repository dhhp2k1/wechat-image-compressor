const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const size = 256;
const mint = [168, 236, 209, 255];
const white = [246, 255, 250, 255];

function nearLine(x, y, ax, ay, bx, by, width) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= width / 2;
}

function polyline(x, y, points, width) {
  return points.slice(1).some(([bx, by], index) => {
    const [ax, ay] = points[index];
    return nearLine(x, y, ax, ay, bx, by, width);
  });
}

function rounded(x, y, left, top, right, bottom, radius) {
  const dx = x - Math.max(left + radius, Math.min(right - radius, x));
  const dy = y - Math.max(top + radius, Math.min(bottom - radius, y));
  return dx * dx + dy * dy <= radius * radius;
}

function pixel(x, y) {
  if (!rounded(x, y, 0, 0, 256, 256, 55)) return [0, 0, 0, 0];
  if (polyline(x, y, [[52, 76], [52, 53], [75, 53]], 11) ||
      polyline(x, y, [[181, 202], [204, 202], [204, 179]], 11)) return mint;
  const frame = rounded(x, y, 64, 72, 192, 184, 17);
  if (frame && !rounded(x, y, 75, 83, 181, 173, 8)) return white;
  if (Math.hypot(x - 155, y - 107) <= 9) return white;
  if (polyline(x, y, [[79, 152], [110, 119], [136, 145], [151, 131], [176, 153]], 10)) return white;
  const gradient = (x * .44 + y * .56) / size;
  return [32 - 9 * gradient, 132 - 41 * gradient, 96 - 21 * gradient, 255];
}

function crc32(data) {
  let n = -1;
  for (const byte of data) {
    n ^= byte;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  }
  return (~n) >>> 0;
}

function chunk(name, data = Buffer.alloc(0)) {
  const type = Buffer.from(name);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  type.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(dimension) {
  const stride = 4 * dimension + 1;
  const raw = Buffer.alloc(stride * dimension);
  const ratio = size / dimension;
  for (let y = 0; y < dimension; y++) {
    for (let x = 0; x < dimension; x++) {
      const sum = [0, 0, 0, 0];
      for (const fy of [0.125, 0.375, 0.625, 0.875]) {
        for (const fx of [0.125, 0.375, 0.625, 0.875]) {
          const p = pixel((x + fx) * ratio, (y + fy) * ratio);
          for (let c = 0; c < 3; c++) sum[c] += p[c] * p[3];
          sum[3] += p[3];
        }
      }
      const offset = y * stride + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[offset + c] = sum[3] ? Math.round(sum[c] / sum[3]) : 0;
      raw[offset + 3] = Math.round(sum[3] / 16);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(dimension, 0);
  header.writeUInt32BE(dimension, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND'),
  ]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(png);
const directory = Buffer.alloc(6 + 16 * sizes.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (const [index, dimension] of sizes.entries()) {
  const start = 6 + index * 16;
  directory[start] = directory[start + 1] = dimension % 256;
  directory.writeUInt16LE(1, start + 4);
  directory.writeUInt16LE(32, start + 6);
  directory.writeUInt32LE(images[index].length, start + 8);
  directory.writeUInt32LE(offset, start + 12);
  offset += images[index].length;
}
fs.mkdirSync(path.join(root, 'assets'), {recursive: true});
fs.writeFileSync(path.join(root, 'assets', 'logo.ico'), Buffer.concat([directory, ...images]));
fs.writeFileSync(path.join(root, 'ui', 'logo.png'), images.at(-1));
