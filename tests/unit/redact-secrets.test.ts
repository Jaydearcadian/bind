import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../src/adapters/settlement/errors.js";

describe("redactSecrets", () => {
  it("replaces every http and https URL with [redacted-url]", () => {
    expect(
      redactSecrets("failed: https://rpc.example.test/v1/SECRETTOKEN-123 and http://127.0.0.1:8545/x", [])
    ).toBe("failed: [redacted-url] and [redacted-url]");
  });

  it("ends a URL at quotes, angle brackets and closing parentheses", () => {
    expect(redactSecrets(`(url "https://a.test/t1" <https://b.test/t2>)`, [])).toBe(
      `(url "[redacted-url]" <[redacted-url]>)`
    );
  });

  it("replaces every occurrence of each secret with [redacted]", () => {
    expect(redactSecrets("token SECRETTOKEN-123 in body, again SECRETTOKEN-123", ["SECRETTOKEN-123"])).toBe(
      "token [redacted] in body, again [redacted]"
    );
  });

  it("ignores empty secret entries", () => {
    expect(redactSecrets("plain text", ["", ""])).toBe("plain text");
    expect(redactSecrets("abc", [""])).toBe("abc");
  });

  it("leaves text without secrets unchanged", () => {
    const text = "eth_call reverted with no data (code 3)";
    expect(redactSecrets(text, ["0x" + "ab".repeat(32)])).toBe(text);
    expect(redactSecrets("", ["SECRET"])).toBe("");
  });
});
