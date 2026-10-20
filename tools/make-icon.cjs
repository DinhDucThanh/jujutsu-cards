/**
 * Generates the desktop icon set from code, so the repository carries a real icon without
 * a binary design file and `build/` never depends on a machine-local export step.
 *
 * The mark is drawn as a badge: a deep violet rounded tile, a cursed-energy ring, a white
 * diamond sigil and one crimson slash. Every pixel is supersampled 4x4, so the 16px
 * favicon-sized layers stay readable rather than turning into a smear.
 *
 * Writes build/icon.png (512px, for taskbars and non-Windows targets) and build/icon.ico
 * (16-256px PNG-compressed layers, the format Windows and electron-builder expect).
 *
 * Usage: node tools/make-icon.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 512;
const SUBSAMPLES = 4;

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

const VIOLET = [139, 92, 246];
const CYAN = [56, 189, 248];
const WHITE = [244, 241, 255];
const CRIMSON = [225, 29, 72];

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const mix = (a, b, t) => a.map((channel, i) => channel + (b[i] - channel) * t);

/** Signed distance to a rounded rectangle centred on the origin. */
function roundedRectDistance(u, v, half, radius) {
  const qx = Math.abs(u) - half + radius;
  const qy = Math.abs(v) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance from (u, v) to the segment a-b, used for the slash. */
function segmentDistance(u, v, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(u - (ax + dx * t), v - (ay + dy * t));
}

function shadeAt(u, v) {
  // The badge: a slightly squashed square with generous corners.
  if (roundedRectDistance(u, v, 0.44, 0.16) > 0) return [0, 0, 0, 0];

  // Vertical gradient with a violet glow behind the sigil.
  const base = mix([29, 18, 64], [8, 6, 15], clamp01(v + 0.5));
  const glow = clamp01(1 - Math.hypot(u + 0.02, v + 0.06) / 0.62) ** 2;
  const badge = mix(base, [76, 29, 149], glow * 0.55);

  let color = badge;
  let alpha = 1;

  // Cursed-energy ring, angling from violet to cyan.
  const ringDistance = Math.abs(Math.hypot(u, v + 0.015) - 0.305);
  if (ringDistance < 0.027) {
    const angle = Math.atan2(v + 0.015, u);
    const t = (angle + Math.PI) / (Math.PI * 2);
    color = mix(VIOLET, CYAN, t);
  }

  // White diamond sigil, hollow so the badge shows through the middle.
  const diamond = Math.abs(u) + Math.abs(v + 0.012);
  if (diamond < 0.165 && diamond > 0.092) color = WHITE;

  // One crimson slash across the sigil.
  if (diamond < 0.2 && segmentDistance(u, v, -0.26, 0.22, 0.26, -0.22) < 0.028) color = CRIMSON;

  return [color[0], color[1], color[2], alpha];
}

/** Renders one square RGBA image with 4x4 supersampling for smooth edges. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUBSAMPLES * SUBSAMPLES;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          const u = (x + (sx + 0.5) / SUBSAMPLES) / size - 0.5;
          const v = (y + (sy + 0.5) / SUBSAMPLES) / size - 0.5;
          const [cr, cg, cb, ca] = shadeAt(u, v);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const offset = (y * size + x) * 4;
      if (a > 0) {
        pixels[offset] = Math.round(r / a);
        pixels[offset + 1] = Math.round(g / a);
        pixels[offset + 2] = Math.round(b / a);
        pixels[offset + 3] = Math.round((a / samples) * 255);
      }
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// PNG / ICO encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * ICO container with PNG-compressed layers, which Windows has supported since Vista and
 * which keeps the 256px layer small enough for electron-builder's rcedit step.
 */
function encodeIco(layers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(layers.length, 4);

  const entries = [];
  let offset = 6 + layers.length * 16;
  for (const layer of layers) {
    const entry = Buffer.alloc(16);
    entry[0] = layer.size >= 256 ? 0 : layer.size;
    entry[1] = layer.size >= 256 ? 0 : layer.size;
    entry[2] = 0; // palette size
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(layer.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += layer.png.length;
  }

  return Buffer.concat([header, ...entries, ...layers.map((layer) => layer.png)]);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const master = render(PNG_SIZE);
  const pngPath = path.join(BUILD_DIR, 'icon.png');
  fs.writeFileSync(pngPath, encodePng(PNG_SIZE, master));

  const layers = ICO_SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));
  const icoPath = path.join(BUILD_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, encodeIco(layers));

  console.log(`icon.png ${PNG_SIZE}x${PNG_SIZE} ${fs.statSync(pngPath).size} bytes`);
  console.log(`icon.ico ${ICO_SIZES.join('/')} ${fs.statSync(icoPath).size} bytes`);
}

main();
