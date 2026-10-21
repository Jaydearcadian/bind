import { describe, expect, it } from "vitest";
import jsQRModule from "jsqr";
import { qrMatrix, qrSvgPath } from "../../web/app/qr.js";

// jsqr is CommonJS, so under NodeNext its default import is typed as the module object. Accept either shape at runtime.
type Decoder = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQR = ((jsQRModule as unknown as { default?: Decoder }).default ?? (jsQRModule as unknown as Decoder)) as Decoder;

const SCALE = 4;
const MARGIN = 4;

/** Draws the matrix into an RGBA buffer, scaled and with a quiet zone, the way a canvas would hand it to a decoder. */
function render(text: string) {
  const { size, modules } = qrMatrix(text);
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

function decode(text: string): string | null {
  const { rgba, px } = render(text);
  return jsQR(rgba, px, px)?.data ?? null;
}

const INVITE = `https://bind.example/app/join#code=bni_${"Ab3_-xY9".repeat(5)}Zq1`;

describe("web/app/qr.js encoder", () => {
  it("builds the invite URL shape the app uses (43 url-safe characters after bni_)", () => {
    expect(INVITE.split("bni_")[1]).toHaveLength(43);
  });

  // Byte capacities at level M: v1 14, v2 26, v4 62, v5 84, v6 106, v7 122, v9 180, v10 213.
  it.each([
    { label: "short string", text: "Hello, Bind!", version: 1 },
    { label: "version 2", text: "Bind staff invite link 1", version: 2 },
    { label: "invite URL (82 characters)", text: INVITE, version: 5 },
    { label: "version 5", text: "Bind staff invite ".repeat(5).slice(0, 70), version: 5 },
    { label: "version 7", text: "Bind staff invite ".repeat(7).slice(0, 110), version: 7 },
    { label: "version 10", text: "Bind staff invite ".repeat(12).slice(0, 200), version: 10 },
  ])("encodes $label as version $version and decodes it back", ({ text, version }) => {
    expect(qrMatrix(text).size).toBe(21 + 4 * (version - 1));
    expect(decode(text)).toBe(text);
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
  });
});
