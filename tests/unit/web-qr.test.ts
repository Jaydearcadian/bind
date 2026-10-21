import { describe, expect, it } from "vitest";
import jsQRModule from "jsqr";
import { qrMatrix, qrMatrixWithMask, qrSvgPath } from "../../web/app/qr.js";

// jsqr is CommonJS, so under NodeNext its default import is typed as the module object. Accept either shape at runtime.
type Decoder = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQR = ((jsQRModule as unknown as { default?: Decoder }).default ?? (jsQRModule as unknown as Decoder)) as Decoder;

const SCALE = 4;
const MARGIN = 4;

type Matrix = { size: number; modules: boolean[][] };

/** Draws a matrix into an RGBA buffer, scaled and with a quiet zone, the way a canvas would hand it to a decoder. */
function render({ size, modules }: Matrix) {
  const px = (size + 2 * MARGIN) * SCALE;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      for (let y = 0; y < SCALE; y++) {
        for (let x = 0; x < SCALE; x++) {
          const i = (((r + MARGIN) * SCALE + y) * px + (c + MARGIN) * SCALE + x) * 4;
          rgba[i] = 0;
          rgba[i + 1] = 0;
          rgba[i + 2] = 0;
        }
      }
    }
  }
  return { rgba, px };
}

function decodeMatrix(m: Matrix): string | null {
  const { rgba, px } = render(m);
  return jsQR(rgba, px, px)?.data ?? null;
}

function decode(text: string): string | null {
  return decodeMatrix(qrMatrix(text));
}

const INVITE = `https://bind.example/app/join#code=bni_${"Ab3_-xY9".repeat(5)}Zq1`;

// Byte-mode capacity at level M per version 1 to 10 (ISO 18004 tables).
const BYTE_CAPACITY = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

// Format code for level M and masks 0 to 7 (ISO 18004 Table C.1).
const FORMAT_CODES = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
// Version codes for versions 7 and 10 (ISO 18004 Table D.1).
const VERSION_CODES: Record<number, number> = { 7: 0x07c94, 10: 0x0a4d3 };

/** A text of exactly `n` bytes (ASCII), so it fills a version without spilling into the next. */
const textOfLength = (n: number) => "Bind staff invite ".repeat(Math.ceil(n / 17)).slice(0, n);

/** Module values at a list of [row, col] cells, read as a bit number with index i at cells[i]. */
function readBits(m: Matrix, cells: number[][]): number {
  return cells.reduce((acc, [r, c], i) => acc | ((m.modules[r][c] ? 1 : 0) << i), 0);
}

/** Format bit positions, written out from the standard (independent of the encoder's own table). */
function formatCopies(size: number): { first: number[][]; second: number[][] } {
  const first: number[][] = [];
  for (let i = 0; i <= 5; i++) first.push([i, 8]);
  first.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i <= 14; i++) first.push([8, 14 - i]);
  const second: number[][] = [];
  for (let i = 0; i <= 7; i++) second.push([8, size - 1 - i]);
  for (let i = 8; i <= 14; i++) second.push([size - 15 + i, 8]);
  return { first, second };
}

/** Version bit positions: the bottom-left 6x3 block and its transpose at the top-right. */
function versionCopies(size: number): { bottomLeft: number[][]; topRight: number[][] } {
  const bottomLeft: number[][] = [];
  const topRight: number[][] = [];
  for (let i = 0; i < 18; i++) {
    bottomLeft.push([size - 11 + (i % 3), Math.floor(i / 3)]);
    topRight.push([Math.floor(i / 3), size - 11 + (i % 3)]);
  }
  return { bottomLeft, topRight };
}

describe("web/app/qr.js encoder", () => {
  it("builds the invite URL shape the app uses (43 url-safe characters after bni_)", () => {
    expect(INVITE.split("bni_")[1]).toHaveLength(43);
  });

  // Byte capacities at level M: v1 14, v2 26, v4 62, v5 84, v6 106, v7 122, v9 180, v10 213.
  it.each([
    { label: "short string", text: "Hello, Bind!", version: 1 },
    { label: "version 2", text: "Bind staff invite link 1", version: 2 },
    { label: "invite URL (82 characters)", text: INVITE, version: 5 },
    { label: "version 5", text: textOfLength(70), version: 5 },
    { label: "version 7", text: textOfLength(110), version: 7 },
    { label: "version 10", text: textOfLength(200), version: 10 },
  ])("encodes $label as version $version and decodes it back", ({ text, version }) => {
    expect(qrMatrix(text).size).toBe(21 + 4 * (version - 1));
    expect(decode(text)).toBe(text);
  });

  describe.each(BYTE_CAPACITY.map((cap, i) => ({ version: i + 1, cap })))(
    "version $version",
    ({ version, cap }) => {
      it(`fills exactly ${cap} bytes in version ${version} and decodes it`, () => {
        const text = textOfLength(cap);
        expect(qrMatrix(text).size).toBe(21 + 4 * (version - 1));
        expect(decode(text)).toBe(text);
      });

      it(`moves to the next version at ${cap + 1} bytes`, () => {
        if (version === 10) {
          expect(() => qrMatrix(textOfLength(cap + 1))).toThrow(RangeError);
          return;
        }
        const text = textOfLength(cap + 1);
        expect(qrMatrix(text).size).toBe(21 + 4 * version);
        expect(decode(text)).toBe(text);
      });
    },
  );

  describe.each([1, 4, 7, 10])("version %i with every mask", (version) => {
    const cap = BYTE_CAPACITY[version - 1];
    it.each([0, 1, 2, 3, 4, 5, 6, 7])("decodes with mask %i", (mask) => {
      const text = textOfLength(cap);
      const m = qrMatrixWithMask(text, mask);
      expect(m.size).toBe(21 + 4 * (version - 1));
      expect(decodeMatrix(m)).toBe(text);
    });
  });

  it("chooses one of the eight masks when none is given", () => {
    const auto = qrMatrix(INVITE).modules;
    const matches = Array.from({ length: 8 }, (_, mask) => JSON.stringify(qrMatrixWithMask(INVITE, mask).modules));
    expect(matches).toContain(JSON.stringify(auto));
  });

  it("rejects a mask outside 0 to 7", () => {
    expect(() => qrMatrixWithMask("x", 8)).toThrow(RangeError);
    expect(() => qrMatrixWithMask("x", -1)).toThrow(RangeError);
    expect(() => qrMatrixWithMask("x", 1.5)).toThrow(RangeError);
  });

  it("writes the expected format code twice, for every mask, with the always-dark module", () => {
    for (let mask = 0; mask < 8; mask++) {
      const m = qrMatrixWithMask(INVITE, mask);
      const { first, second } = formatCopies(m.size);
      expect(readBits(m, first)).toBe(FORMAT_CODES[mask]);
      expect(readBits(m, second)).toBe(FORMAT_CODES[mask]);
      expect(m.modules[m.size - 8][8]).toBe(true);
    }
  });

  it.each([7, 10])("writes the version code in both blocks for version %i", (version) => {
    const m = qrMatrixWithMask(textOfLength(BYTE_CAPACITY[version - 1]), 0);
    const { bottomLeft, topRight } = versionCopies(m.size);
    expect(readBits(m, bottomLeft)).toBe(VERSION_CODES[version]);
    expect(readBits(m, topRight)).toBe(VERSION_CODES[version]);
  });

  it("encodes non-ASCII UTF-8 text", () => {
    expect(qrMatrix("Café ✓").size).toBe(21);
    expect(decode("Café ✓")).toBe("Café ✓");
  });

  it("accepts the version 10 byte limit (213 bytes) and rejects one more byte with RangeError", () => {
    const max = "x".repeat(213);
    expect(qrMatrix(max).size).toBe(57);
    expect(decode(max)).toBe(max);
    expect(() => qrMatrix("x".repeat(214))).toThrow(RangeError);
    expect(() => qrMatrix("x".repeat(300))).toThrow(RangeError);
  });

  it("returns a square matrix of booleans", () => {
    const { size, modules } = qrMatrix(INVITE);
    expect(modules).toHaveLength(size);
    for (const row of modules) {
      expect(row).toHaveLength(size);
      for (const v of row) expect(typeof v).toBe("boolean");
    }
  });

  describe("qrSvgPath", () => {
    it.each(["Hello, Bind!", INVITE])("adds the margin to the size and draws one square per dark module", (text) => {
      const margin = 4;
      const { size, modules } = qrMatrix(text);
      const dark = modules.flat().filter(Boolean).length;
      const out = qrSvgPath(text, { margin });
      expect(out.size).toBe(size + 2 * margin);
      expect(out.d.match(/h1v1h-1z/g)?.length ?? 0).toBe(dark);
      expect(out.d.startsWith("M4 4h1v1h-1z")).toBe(true); // top-left finder corner
    });

    it("defaults the quiet zone to 4 modules", () => {
      expect(qrSvgPath("Hello, Bind!").size).toBe(qrMatrix("Hello, Bind!").size + 8);
    });

    it("accepts a zero margin", () => {
      expect(qrSvgPath("Hello, Bind!", { margin: 0 }).size).toBe(qrMatrix("Hello, Bind!").size);
    });

    it.each([-1, 1.5, NaN, Infinity, "4" as unknown as number])("rejects margin %s with RangeError", (margin) => {
      expect(() => qrSvgPath("Hello, Bind!", { margin })).toThrow(RangeError);
    });
  });
});
