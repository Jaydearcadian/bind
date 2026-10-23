import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const queryMock = vi.hoisted(() => vi.fn());

// The pure token helpers and the malformed-token shortcut must not reach the database at all.
vi.mock("../../src/db/client.js", () => ({
  query: queryMock,
  withTransaction: vi.fn(),
  closePool: vi.fn(),
}));

import { generateToken, hashToken, resolveToken } from "../../src/auth/tokens.js";

describe("workspace tokens (pure parts)", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("a token has the expected prefix and entropy", () => {
    const first = generateToken();
    const second = generateToken();

    expect(first).toMatch(/^bnd_[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^bnd_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    // 43 base64url characters carry 32 random bytes.
    expect(Buffer.from(first.slice("bnd_".length), "base64url")).toHaveLength(32);
  });

  it("only the hash is derived from a token", () => {
    const token = generateToken();
    const hash = hashToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).not.toContain(token.slice("bnd_".length));
  });

  it("a malformed token is rejected without a lookup", async () => {
    const malformed = [
      "",
      "bnd_",
      "bnd_short",
      `xyz_${"A".repeat(43)}`,
      `bnd_${"A".repeat(43)} `,
      `bnd_${"A".repeat(43)}=`,
      "x".repeat(300),
      `bnd_${"A".repeat(300)}`,
    ];

    for (const raw of malformed) {
      expect(await resolveToken(raw)).toBeNull();
    }
    expect(queryMock).not.toHaveBeenCalled();
  });
});
