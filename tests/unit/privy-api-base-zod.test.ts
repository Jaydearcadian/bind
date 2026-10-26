import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/*
 * @privy-io/api-base declares zod ^3.25.76, and this repository forces it onto zod 4 with an npm override so the high-severity
 * audit passes (docs/decisions/0089). The Privy SDK only reads PrivyErrorCode and never parses with APIError, but if a Privy
 * release starts to, this test says whether the schema still works on zod 4. Remove the override and this note when Privy
 * ships zod 4 support.
 */
const require = createRequire(import.meta.url);

describe("@privy-io/api-base on the overridden zod (ADR 0089)", () => {
  it("resolves to the single zod 4 copy", () => {
    const zodVersion = (require("zod/package.json") as { version: string }).version;
    expect(zodVersion.startsWith("4.")).toBe(true);
    const nested = (() => {
      try {
        return require.resolve("zod/package.json", { paths: [require.resolve("@privy-io/api-base")] });
      } catch {
        return null;
      }
    })();
    expect(nested).toBe(require.resolve("zod/package.json"));
  });

  it("APIError still accepts a well-formed error and refuses a malformed one", () => {
    const { APIError, PrivyErrorCode } = require("@privy-io/api-base") as {
      APIError: { safeParse: (v: unknown) => { success: boolean } };
      PrivyErrorCode: Record<string, string>;
    };
    const code = Object.values(PrivyErrorCode)[0];
    expect(APIError.safeParse({ error: "nope", code }).success).toBe(true);
    expect(APIError.safeParse({ error: 12 }).success).toBe(false);
    expect(APIError.safeParse(null).success).toBe(false);
  });
});
