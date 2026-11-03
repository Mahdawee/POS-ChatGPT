/**
 * Self-contained QR Code generator — byte mode, ECC levels L/M/Q/H,
 * versions 1–40, automatic mask selection.
 *
 * Vendored port of the `qrcode` npm package core (v1.5.4, MIT © Kazuhiko
 * Arase, Ryan Day and contributors — https://github.com/soldair/node-qrcode),
 * reduced to what receipt printing needs. Carrying it in-tree keeps the app
 * free of an npm dependency whose absence used to crash the dev server.
 */

export type EccLevel = "L" | "M" | "Q" | "H";

/** Format-information bits per level (QR spec). */
const LEVEL_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_INDEX: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };

/** Total codewords (data + ECC) per version 1–40. */
const CODEWORDS_COUNT = [
  0, // not used
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

/** Number of Reed–Solomon blocks per version × ECC level. */
const EC_BLOCKS_TABLE = [
  // L  M  Q  H
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4, 1, 2, 4, 4, 2, 4, 4, 4, 2, 4, 6, 5, 2, 4, 6, 6, 2, 5, 8, 8,
  4, 5, 8, 8, 4, 5, 8, 11, 4, 8, 10, 11, 4, 9, 12, 16, 4, 9, 16, 16, 6, 10, 12, 18, 6, 10, 17, 16, 6, 11, 16, 19,
  6, 13, 18, 21, 7, 14, 21, 25, 8, 16, 20, 25, 8, 17, 23, 25, 9, 17, 23, 34, 9, 18, 25, 30, 10, 20, 27, 32,
  12, 21, 29, 35, 12, 23, 34, 37, 12, 25, 34, 40, 13, 26, 35, 42, 14, 28, 38, 45, 15, 29, 40, 48, 16, 31, 43, 51,
  17, 33, 45, 54, 18, 35, 48, 57, 19, 37, 51, 60, 19, 38, 53, 63, 20, 40, 56, 66, 21, 43, 59, 70, 22, 45, 62, 74,
  24, 47, 65, 77, 25, 49, 68, 81,
];

/** Error-correction codewords per version × ECC level. */
const EC_CODEWORDS_TABLE = [
  // L  M  Q  H
  7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64, 26, 48, 72, 88, 36, 64, 96, 112, 40, 72, 108, 130,
  48, 88, 132, 156, 60, 110, 160, 192, 72, 130, 192, 224, 80, 150, 224, 264, 96, 176, 260, 308, 104, 198, 288, 352,
  120, 216, 320, 384, 132, 240, 360, 432, 144, 280, 408, 480, 168, 308, 448, 532, 180, 338, 504, 588, 196, 364, 546, 650,
  224, 416, 600, 700, 224, 442, 644, 750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960, 312, 588, 870, 1050,
  336, 644, 952, 1110, 360, 700, 1020, 1200, 390, 728, 1050, 1260, 420, 784, 1140, 1350, 450, 812, 1200, 1440,
  480, 868, 1290, 1530, 510, 924, 1350, 1620, 540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570, 1064, 1590, 1890,
  600, 1120, 1680, 1980, 630, 1204, 1770, 2100, 660, 1260, 1860, 2220, 720, 1316, 1950, 2310, 750, 1372, 2040, 2430,
];

const getSymbolSize = (version: number): number => {
  if (version < 1 || version > 40) throw new Error("Invalid QR version");
  return version * 4 + 17;
};
const getSymbolTotalCodewords = (version: number): number => CODEWORDS_COUNT[version];
const getBCHDigit = (data: number): number => {
  let digit = 0;
  while (data !== 0) { digit++; data >>>= 1; }
  return digit;
};

// ── Galois field GF(2^8) ────────────────────────────────────────────────
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP_TABLE[i] = EXP_TABLE[i - 255];
})();
const gmul = (x: number, y: number): number => (x === 0 || y === 0 ? 0 : EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]]);

// ── Polynomial arithmetic over GF(2^8) ─────────────────────────────────
const polyMul = (p1: Uint8Array, p2: Uint8Array): Uint8Array => {
  const coeff = new Uint8Array(p1.length + p2.length - 1);
  for (let i = 0; i < p1.length; i++) for (let j = 0; j < p2.length; j++) coeff[i + j] ^= gmul(p1[i], p2[j]);
  return coeff;
};
const polyMod = (divident: Uint8Array, divisor: Uint8Array): Uint8Array => {
  let result = new Uint8Array(divident);
  while (result.length - divisor.length >= 0) {
    const coeff = result[0];
    for (let i = 0; i < divisor.length; i++) result[i] ^= gmul(divisor[i], coeff);
    let offset = 0;
    while (offset < result.length && result[offset] === 0) offset++;
    result = result.slice(offset);
  }
  return result;
};
const generateECPolynomial = (degree: number): Uint8Array => {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) poly = polyMul(poly, new Uint8Array([1, EXP_TABLE[i]]));
  return poly;
};

/** Reed–Solomon encoder for one ECC-block size. */
class ReedSolomonEncoder {
  private genPoly: Uint8Array;
  constructor(private degree: number) { this.genPoly = generateECPolynomial(degree); }
  encode(data: Uint8Array): Uint8Array {
    const paddedData = new Uint8Array(data.length + this.degree);
    paddedData.set(data);
    const remainder = polyMod(paddedData, this.genPoly);
    const start = this.degree - remainder.length;
    if (start > 0) {
      const buff = new Uint8Array(this.degree);
      buff.set(remainder, start);
      return buff;
    }
    return remainder;
  }
}

// ── Bit helpers ─────────────────────────────────────────────────────────
class BitBuffer {
  buffer: number[] = [];
  length = 0;
  get(index: number): boolean {
    const bufIndex = Math.floor(index / 8);
    return ((this.buffer[bufIndex] >>> (7 - (index % 8))) & 1) === 1;
  }
  put(num: number, length: number): void {
    for (let i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
  }
  getLengthInBits(): number { return this.length; }
  putBit(bit: boolean): void {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) this.buffer.push(0);
    if (bit) this.buffer[bufIndex] |= 0x80 >>> (this.length % 8);
    this.length++;
  }
}

class BitMatrix {
  size: number;
  data: Uint8Array;
  private reservedBit: Uint8Array;
  constructor(size: number) {
    if (!size || size < 1) throw new Error("BitMatrix size must be defined and greater than 0");
    this.size = size;
    this.data = new Uint8Array(size * size);
    this.reservedBit = new Uint8Array(size * size);
  }
  set(row: number, col: number, value: boolean, reserved?: boolean): void {
    const index = row * this.size + col;
    this.data[index] = value ? 1 : 0;
    if (reserved) this.reservedBit[index] = 1;
  }
  get(row: number, col: number): number { return this.data[row * this.size + col]; }
  xor(row: number, col: number, value: number): void { this.data[row * this.size + col] ^= value; }
  isReserved(row: number, col: number): boolean { return this.reservedBit[row * this.size + col] === 1; }
}

// ── Data mode (byte only) ───────────────────────────────────────────────
const BYTE_MODE = { id: "Byte" as const, bit: 1 << 2, ccBits: [8, 16, 16] as const };
const getCharCountIndicator = (version: number): number => {
  if (version >= 1 && version < 10) return BYTE_MODE.ccBits[0];
  if (version < 27) return BYTE_MODE.ccBits[1];
  return BYTE_MODE.ccBits[2];
};

class ByteData {
  mode = BYTE_MODE;
  data: Uint8Array;
  constructor(text: string) { this.data = new TextEncoder().encode(text); }
  getLength(): number { return this.data.length; }
  getBitsLength(): number { return this.data.length * 8; }
  write(bitBuffer: BitBuffer): void {
    for (let i = 0; i < this.data.length; i++) bitBuffer.put(this.data[i], 8);
  }
}

// ── Version selection ───────────────────────────────────────────────────
const getCapacityBytes = (version: number, level: EccLevel): number => {
  const totalCodewords = getSymbolTotalCodewords(version);
  const ecTotalCodewords = EC_CODEWORDS_TABLE[(version - 1) * 4 + ECC_INDEX[level]];
  const usableBits = (totalCodewords - ecTotalCodewords) * 8 - (getCharCountIndicator(version) + 4);
  return Math.floor(usableBits / 8);
};
const getBestVersionForData = (data: ByteData, level: EccLevel): number | undefined => {
  for (let version = 1; version <= 40; version++) {
    if (data.getLength() <= getCapacityBytes(version, level)) return version;
  }
  return undefined;
};

/** Version information bits (versions ≥ 7) — (18,6) Golay code. */
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const G18_BCH = getBCHDigit(G18);
const getEncodedVersionBits = (version: number): number => {
  let d = version << 12;
  while (getBCHDigit(d) - G18_BCH >= 0) d ^= G18 << (getBCHDigit(d) - G18_BCH);
  return (version << 12) | d;
};

// ── Function patterns ───────────────────────────────────────────────────
const getFinderPositions = (version: number): Array<[number, number]> => {
  const size = getSymbolSize(version);
  return [[0, 0], [size - 7, 0], [0, size - 7]];
};
const getAlignmentRowCol = (version: number): number[] => {
  if (version === 1) return [];
  const posCount = Math.floor(version / 7) + 2;
  const size = getSymbolSize(version);
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < posCount - 1; i++) positions[i] = positions[i - 1] - intervals;
  positions.push(6);
  return positions.reverse();
};
const getAlignmentPositions = (version: number): Array<[number, number]> => {
  const pos = getAlignmentRowCol(version);
  const coords: Array<[number, number]> = [];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      coords.push([pos[i], pos[j]]);
    }
  }
  return coords;
};

/** Format information bits — (15,5) BCH code with mask. */
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const G15_BCH = getBCHDigit(G15);
const getEncodedFormatBits = (level: EccLevel, mask: number): number => {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let d = data << 10;
  while (getBCHDigit(d) - G15_BCH >= 0) d ^= G15 << (getBCHDigit(d) - G15_BCH);
  return ((data << 10) | d) ^ G15_MASK;
};

// ── Masking ─────────────────────────────────────────────────────────────
const getMaskAt = (maskPattern: number, i: number, j: number): boolean => {
  switch (maskPattern) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error(`bad maskPattern: ${maskPattern}`);
  }
};
const applyMask = (pattern: number, data: BitMatrix): void => {
  const size = data.size;
  for (let col = 0; col < size; col++) {
    for (let row = 0; row < size; row++) {
      if (data.isReserved(row, col)) continue;
      data.xor(row, col, getMaskAt(pattern, row, col) ? 1 : 0);
    }
  }
};
const PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 };
const getPenaltyN1 = (data: BitMatrix): number => {
  const size = data.size;
  let points = 0;
  for (let row = 0; row < size; row++) {
    let sameCountCol = 0, sameCountRow = 0, lastCol: number | null = null, lastRow: number | null = null;
    for (let col = 0; col < size; col++) {
      let module = data.get(row, col);
      if (module === lastCol) sameCountCol++;
      else {
        if (sameCountCol >= 5) points += PENALTY.N1 + (sameCountCol - 5);
        lastCol = module;
        sameCountCol = 1;
      }
      module = data.get(col, row);
      if (module === lastRow) sameCountRow++;
      else {
        if (sameCountRow >= 5) points += PENALTY.N1 + (sameCountRow - 5);
        lastRow = module;
        sameCountRow = 1;
      }
    }
    if (sameCountCol >= 5) points += PENALTY.N1 + (sameCountCol - 5);
    if (sameCountRow >= 5) points += PENALTY.N1 + (sameCountRow - 5);
  }
  return points;
};
const getPenaltyN2 = (data: BitMatrix): number => {
  const size = data.size;
  let points = 0;
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
      if (last === 4 || last === 0) points++;
    }
  }
  return points * PENALTY.N2;
};
const getPenaltyN3 = (data: BitMatrix): number => {
  const size = data.size;
  let points = 0;
  for (let row = 0; row < size; row++) {
    let bitsCol = 0, bitsRow = 0;
    for (let col = 0; col < size; col++) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | data.get(row, col);
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points++;
      bitsRow = ((bitsRow << 1) & 0x7ff) | data.get(col, row);
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points++;
    }
  }
  return points * PENALTY.N3;
};
const getPenaltyN4 = (data: BitMatrix): number => {
  let darkCount = 0;
  for (let i = 0; i < data.data.length; i++) darkCount += data.data[i];
  const k = Math.abs(Math.ceil((darkCount * 100) / data.data.length / 5) - 10);
  return k * PENALTY.N4;
};
const getBestMask = (data: BitMatrix, setupFormat: (mask: number) => void): number => {
  let bestPattern = 0;
  let lowerPenalty = Infinity;
  for (let p = 0; p < 8; p++) {
    setupFormat(p);
    applyMask(p, data);
    const penalty = getPenaltyN1(data) + getPenaltyN2(data) + getPenaltyN3(data) + getPenaltyN4(data);
    applyMask(p, data); // undo — XOR is its own inverse on non-reserved modules
    if (penalty < lowerPenalty) { lowerPenalty = penalty; bestPattern = p; }
  }
  return bestPattern;
};

// ── Symbol construction ─────────────────────────────────────────────────
const setupFinderPattern = (matrix: BitMatrix, version: number): void => {
  const size = matrix.size;
  const pos = getFinderPositions(version);
  for (const [row, col] of pos) {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || size <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || size <= col + c) continue;
        if ((r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
          matrix.set(row + r, col + c, true, true);
        } else {
          matrix.set(row + r, col + c, false, true);
        }
      }
    }
  }
};
const setupTimingPattern = (matrix: BitMatrix): void => {
  const size = matrix.size;
  for (let r = 8; r < size - 8; r++) {
    const value = r % 2 === 0;
    matrix.set(r, 6, value, true);
    matrix.set(6, r, value, true);
  }
};
const setupAlignmentPattern = (matrix: BitMatrix, version: number): void => {
  const pos = getAlignmentPositions(version);
  for (const [row, col] of pos) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) matrix.set(row + r, col + c, true, true);
        else matrix.set(row + r, col + c, false, true);
      }
    }
  }
};
const setupVersionInfo = (matrix: BitMatrix, version: number): void => {
  const size = matrix.size;
  const bits = getEncodedVersionBits(version);
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 8 - 3;
    const mod = ((bits >> i) & 1) === 1;
    matrix.set(row, col, mod, true);
    matrix.set(col, row, mod, true);
  }
};
const setupFormatInfo = (matrix: BitMatrix, level: EccLevel, maskPattern: number): void => {
  const size = matrix.size;
  const bits = getEncodedFormatBits(level, maskPattern);
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1;
    // vertical
    if (i < 6) matrix.set(i, 8, mod, true);
    else if (i < 8) matrix.set(i + 1, 8, mod, true);
    else matrix.set(size - 15 + i, 8, mod, true);
    // horizontal
    if (i < 8) matrix.set(8, size - i - 1, mod, true);
    else if (i < 9) matrix.set(8, 15 - i - 1 + 1, mod, true);
    else matrix.set(8, 15 - i - 1, mod, true);
  }
  matrix.set(size - 8, 8, true, true);
};
const setupData = (matrix: BitMatrix, data: Uint8Array): void => {
  const size = matrix.size;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (!matrix.isReserved(row, col - c)) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          matrix.set(row, col - c, dark);
          bitIndex--;
          if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
        }
      }
      row += inc;
      if (row < 0 || size <= row) { row -= inc; inc = -inc; break; }
    }
  }
};

const createData = (version: number, level: EccLevel, segments: ByteData[]): Uint8Array => {
  const buffer = new BitBuffer();
  for (const segment of segments) {
    buffer.put(segment.mode.bit, 4);
    buffer.put(segment.getLength(), getCharCountIndicator(version));
    segment.write(buffer);
  }
  const totalCodewords = getSymbolTotalCodewords(version);
  const ecTotalCodewords = EC_CODEWORDS_TABLE[(version - 1) * 4 + ECC_INDEX[level]];
  const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
  if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) buffer.put(0, 4);
  while (buffer.getLengthInBits() % 8 !== 0) buffer.putBit(false);
  const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
  for (let i = 0; i < remainingByte; i++) buffer.put(i % 2 ? 0x11 : 0xec, 8);
  return createCodewords(buffer, version, level);
};

const createCodewords = (bitBuffer: BitBuffer, version: number, level: EccLevel): Uint8Array => {
  const totalCodewords = getSymbolTotalCodewords(version);
  const ecTotalCodewords = EC_CODEWORDS_TABLE[(version - 1) * 4 + ECC_INDEX[level]];
  const dataTotalCodewords = totalCodewords - ecTotalCodewords;
  const ecTotalBlocks = EC_BLOCKS_TABLE[(version - 1) * 4 + ECC_INDEX[level]];
  const blocksInGroup2 = totalCodewords % ecTotalBlocks;
  const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
  const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
  const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
  const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
  const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
  const rs = new ReedSolomonEncoder(ecCount);
  let offset = 0;
  const dcData: Uint8Array[] = new Array(ecTotalBlocks);
  const ecData: Uint8Array[] = new Array(ecTotalBlocks);
  let maxDataSize = 0;
  const buffer = new Uint8Array(bitBuffer.buffer);
  for (let b = 0; b < ecTotalBlocks; b++) {
    const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
    dcData[b] = buffer.slice(offset, offset + dataSize);
    ecData[b] = rs.encode(dcData[b]);
    offset += dataSize;
    maxDataSize = Math.max(maxDataSize, dataSize);
  }
  const data = new Uint8Array(totalCodewords);
  let index = 0;
  for (let i = 0; i < maxDataSize; i++) {
    for (let r = 0; r < ecTotalBlocks; r++) if (i < dcData[r].length) data[index++] = dcData[r][i];
  }
  for (let i = 0; i < ecCount; i++) {
    for (let r = 0; r < ecTotalBlocks; r++) data[index++] = ecData[r][i];
  }
  return data;
};

export type QrSymbol = { size: number; version: number; maskPattern: number; get(row: number, col: number): number };

/** Builds the QR matrix for `text` (UTF-8 byte mode) at the given level. */
export function qrCreate(text: string, level: EccLevel = "M"): QrSymbol {
  const segments = [new ByteData(text)];
  const version = getBestVersionForData(segments[0], level);
  if (!version) throw new Error("The amount of data is too big to be stored in a QR Code");
  const dataBits = createData(version, level, segments);
  const moduleCount = getSymbolSize(version);
  const modules = new BitMatrix(moduleCount);
  setupFinderPattern(modules, version);
  setupTimingPattern(modules);
  setupAlignmentPattern(modules, version);
  setupFormatInfo(modules, level, 0); // dummy pass, reserves the cells
  if (version >= 7) setupVersionInfo(modules, version);
  setupData(modules, dataBits);
  const maskPattern = getBestMask(modules, (mask) => setupFormatInfo(modules, level, mask));
  applyMask(maskPattern, modules);
  setupFormatInfo(modules, level, maskPattern);
  return { size: modules.size, version, maskPattern, get: (row, col) => modules.get(row, col) };
}
