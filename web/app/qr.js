/*
 * A small QR code encoder (ISO/IEC 18004) for staff invite links: byte mode, error correction level M, versions 1 to 10.
 * No imports: the site's strict CSP allows scripts from this origin only. Returns a boolean matrix or an SVG path.
 */

const MAX_VERSION = 10;
// Per version 1 to 10 at level M (index 0 unused).
const ECC_CODEWORDS = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // error correction codewords per block
const ECC_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_GEN = 0x537; // BCH generator for the 15-bit format code
const FORMAT_XOR = 0x5412; // keeps the format code from ever being all zero
const VERSION_GEN = 0x1f25; // BCH generator for the 18-bit version code (versions 7+)
// Finder-like runs (1:1:3:1:1 with four light modules on one side) that the penalty rules count.
const FINDER_LIKE = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];

// The eight mask patterns. True means flip the module.
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Modules in the data area of a version, including remainder bits (ISO 18004 Annex). */
function rawModuleCount(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55; // alignment patterns
    if (version >= 7) n -= 36; // version information
  }
  return n;
}

/** Data codewords a version holds at level M. */
function dataCapacity(version) {
  return Math.floor(rawModuleCount(version) / 8) - ECC_CODEWORDS[version] * ECC_BLOCKS[version];
}

/** The smallest version whose byte-mode capacity fits the message, or a RangeError. */
function chooseVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCapacity(version) * 8) return version;
  }
  const maxBytes = Math.floor((dataCapacity(MAX_VERSION) * 8 - 20) / 8);
  throw new RangeError(`Text is ${byteLength} UTF-8 bytes; a QR code (level M, up to version 10) holds at most ${maxBytes}`);
}

/** Byte-mode data codewords: mode, length, bytes, terminator, byte alignment, then 0xEC/0x11 padding. */
function encodeData(bytes, version) {
  const bits = [];
  const push = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCapacity(version);
  push(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => acc * 2 + bit, 0));
  for (let pad = 0xec; codewords.length < capacity; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

// ---- Reed-Solomon over GF(256) with the QR polynomial 0x11D ----------------------------------------------------------

/** Multiplies two field elements (shift and reduce). */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator (x - 2^0)(x - 2^1)...(x - 2^(degree-1)), highest power first. */
function rsGenerator(degree) {
  let poly = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    poly.forEach((coef, j) => {
      next[j] ^= coef; // times x
      next[j + 1] ^= gfMul(coef, root); // times the root
    });
    poly = next;
    root = gfMul(root, 2);
  }
  return poly;
}

/** The ECC codewords for one block: the remainder of data * x^degree divided by the generator. */
function rsRemainder(data, gen) {
  const degree = gen.length - 1;
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

/** Splits the data into blocks (the last blocks get one more data codeword), adds ECC, and interleaves. */
function addEcc(data, version) {
  const numBlocks = ECC_BLOCKS[version];
  const eccLen = ECC_CODEWORDS[version];
  const rawCodewords = Math.floor(rawModuleCount(version) / 8);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const gen = rsGenerator(eccLen);
  const blocks = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + dataLen);
    k += dataLen;
    blocks.push({ data: dat, ecc: rsRemainder(dat, gen) });
  }
  const out = [];
  for (let i = 0; i <= shortLen - eccLen; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < eccLen; i++) for (const b of blocks) out.push(b.ecc[i]);
  return out;
}

// ---- Symbol construction ---------------------------------------------------------------------------------------------

/** Where the two copies of the 15 format bits go. Bit i of the format code is at index i of each list. */
function formatCells(size) {
  const first = [];
  for (let i = 0; i <= 5; i++) first.push([i, 8]);
  first.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i < 15; i++) first.push([8, 14 - i]);
  const second = [];
  for (let i = 0; i < 8; i++) second.push([8, size - 1 - i]);
  for (let i = 8; i < 15; i++) second.push([size - 15 + i, 8]);
  return { first, second };
}

/** The 15-bit format code for level M (bits 00) and a mask: BCH check bits, then XOR. */
function formatBits(mask) {
  let rem = mask;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * FORMAT_GEN);
  return ((mask << 10) | rem) ^ FORMAT_XOR;
}

/** The 18-bit version code (versions 7+). */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * VERSION_GEN);
  return (version << 12) | rem;
}

/** Centres of the alignment patterns in ascending order (none for version 1). */
function alignmentPositions(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const pos = [6];
  for (let p = size - 7; pos.length < count; p -= step) pos.splice(1, 0, p);
  return pos;
}

/** A blank symbol with the timing, finder, alignment and version patterns drawn. isFunc marks reserved modules. */
function drawFunctionPatterns(version) {
  const size = version * 4 + 17;
  const grid = () => Array.from({ length: size }, () => new Array(size).fill(false));
  const modules = grid();
  const isFunc = grid();
  const put = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = dark;
    isFunc[r][c] = true;
  };
  // A square of radius `half` around (r, c); `darkAt(distance)` says which rings are dark.
  const square = (r, c, half, darkAt) => {
    for (let dr = -half; dr <= half; dr++) {
      for (let dc = -half; dc <= half; dc++) put(r + dr, c + dc, darkAt(Math.max(Math.abs(dr), Math.abs(dc))));
    }
  };

  // Timing first, so the finders and alignment patterns can overwrite it.
  for (let i = 8; i < size - 8; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }
  // Finders: dark centre and outer ring, light ring at distance 2, light separator at distance 4.
  for (const [r, c] of [[3, 3], [3, size - 4], [size - 4, 3]]) square(r, c, 4, (d) => d !== 2 && d !== 4);
  // Alignment patterns, skipping the three that would sit on a finder.
  const last = size - 7;
  const centres = alignmentPositions(version, size);
  for (const r of centres) {
    for (const c of centres) {
      if (!((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6))) square(r, c, 2, (d) => d !== 1);
    }
  }
  // Format areas are reserved here and filled once the mask is known. The always-dark module goes at (size-8, 8).
  const { first, second } = formatCells(size);
  for (const [r, c] of [...first, ...second]) isFunc[r][c] = true;
  put(size - 8, 8, true);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      put(size - 11 + (i % 3), Math.floor(i / 3), dark); // bottom-left block
      put(Math.floor(i / 3), size - 11 + (i % 3), dark); // top-right block
    }
  }
  return { size, modules, isFunc };
}

/** Writes the codewords into the free modules in the spec's zigzag order, two columns at a time from the right. */
function placeData(g, codewords) {
  const { size, modules, isFunc } = g;
  const total = codewords.length * 8;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const r = ((right + 1) & 2) === 0 ? size - 1 - vert : vert; // upward or downward strip
        if (!isFunc[r][c] && bitIndex < total) {
          modules[r][c] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
      }
    }
  }
}

function applyMask(g, mask) {
  const { size, modules, isFunc } = g;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunc[r][c] && MASKS[mask](r, c)) modules[r][c] = !modules[r][c];
    }
  }
}

function drawFormat(g, mask) {
  const { size, modules } = g;
  const bits = formatBits(mask);
  const { first, second } = formatCells(size);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    modules[first[i][0]][first[i][1]] = dark;
    modules[second[i][0]][second[i][1]] = dark;
  }
}

/** The mask penalty from the four standard rules: runs, 2x2 blocks, finder-like patterns, and dark balance. */
function penalty(m) {
  const n = m.length;
  const cols = m[0].map((_, c) => m.map((row) => row[c]));
  let score = 0;
  for (const line of [...m, ...cols]) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= n; i++) {
      if (FINDER_LIKE.some((p) => p.every((v, k) => (line[i + k] ? 1 : 0) === v))) score += 40;
    }
  }
  for (let r = 0; r + 1 < n; r++) {
    for (let c = 0; c + 1 < n; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  const dark = m.flat().filter(Boolean).length;
  const total = n * n;
  // Ten points per 5% step the dark share is from 50%. The module count is odd, so the share is never exactly 50%.
  score += 10 * (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1);
  return score;
}

/** The symbol for one mask. */
function symbolWithMask(version, codewords, mask) {
  const g = drawFunctionPatterns(version);
  placeData(g, codewords);
  applyMask(g, mask);
  drawFormat(g, mask);
  return g.modules;
}

/** Tries all eight masks and keeps the one with the lowest penalty (the first on a tie). */
function bestSymbol(version, codewords) {
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = symbolWithMask(version, codewords, mask);
    const score = penalty(modules);
    if (best === null || score < best.score) best = { score, modules };
  }
  return best.modules;
}

/** The smallest version for a text, and its codewords with ECC. */
function codewordsFor(text) {
  const bytes = new TextEncoder().encode(String(text));
  const version = chooseVersion(bytes.length);
  return { version, codewords: addEcc(encodeData(bytes, version), version) };
}

/** Encodes text as a QR code. Returns { size, modules } with modules[row][col] true for a dark module. */
export function qrMatrix(text) {
  const { version, codewords } = codewordsFor(text);
  const modules = bestSymbol(version, codewords);
  return { size: modules.length, modules };
}

/** Encodes text with a fixed mask (0 to 7) instead of the lowest-penalty one. Used by the tests. */
export function qrMatrixWithMask(text, mask) {
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError(`Mask must be an integer from 0 to 7, got ${mask}`);
  const { version, codewords } = codewordsFor(text);
  const modules = symbolWithMask(version, codewords, mask);
  return { size: modules.length, modules };
}

/** The code as one SVG path of 1x1 squares, with a quiet zone of `margin` modules. size includes the margin. */
export function qrSvgPath(text, { margin = 4 } = {}) {
  if (!Number.isInteger(margin) || margin < 0) throw new RangeError(`margin must be a whole number of modules, got ${margin}`);
  const { size, modules } = qrMatrix(text);
  let d = "";
  modules.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  }));
  return { size: size + 2 * margin, d };
}
