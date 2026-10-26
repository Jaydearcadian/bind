import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ISO_DATE_TIME_WITH_OFFSET, isoDateTimeWithOffset } from "../../src/api/isoDateTime.js";
import { validationFields } from "../../src/server/errors.js";
import { InitialSupplyItemSchema } from "../../src/studio/onboarding.js";
import { ISO_DATE_TIME_WITH_OFFSET as MCP_ISO_DATE_TIME_WITH_OFFSET } from "../../mcp/src/isoDateTime.js";
import { TOOLS } from "../../mcp/src/tools.js";

/**
 * Pins the behaviour that the move from zod 3 to zod 4 had to keep (ADR 0089). The expectations for the date-time rule are the
 * answers of zod 3.25.76 (`z.string().datetime({ offset: true })`), recorded when the move was made.
 */

describe("offset date-time rule (zod 3 semantics)", () => {
  const truth: Array<[string, boolean]> = [
    ["2026-01-01T00:00:00Z", true],
    ["2026-01-01T00:00:00.123456Z", true],
    ["2026-01-01T00:00:00+05:30", true],
    ["2026-01-01T00:00:00-0800", true],
    ["2026-01-01T00:00:00+05", false],
    ["2026-01-01T00:00Z", true],
    ["2026-01-01T10:15+01:00", true],
    ["2026-01-01T00:00:00", false],
    ["2026-02-29T00:00:00Z", false],
    ["2024-02-29T00:00:00Z", true],
    ["2026-04-31T00:00:00Z", false],
    ["2026-13-01T00:00:00Z", false],
    ["2026-01-01T24:00:00Z", false],
    ["2026-01-01T23:59:60Z", false],
    ["2026-01-01 00:00:00Z", false],
    ["2026-01-01t00:00:00z", false],
    ["2026-01-01T00:00:00.Z", false],
    ["2026-01-01T00:00:00.1Z", true],
    ["2026-01-01T00:00:00+0530", true],
    ["", false],
    ["not a date", false],
  ];

  it.each(truth)("%j is %s", (value, accepted) => {
    expect(isoDateTimeWithOffset().safeParse(value).success).toBe(accepted);
    expect(ISO_DATE_TIME_WITH_OFFSET.test(value)).toBe(accepted);
  });

  it("the MCP tools carry the same expression as the HTTP API", () => {
    expect(MCP_ISO_DATE_TIME_WITH_OFFSET.source).toBe(ISO_DATE_TIME_WITH_OFFSET.source);
    expect(MCP_ISO_DATE_TIME_WITH_OFFSET.flags).toBe(ISO_DATE_TIME_WITH_OFFSET.flags);
  });
});

describe("email validation (zod 3 semantics, ADR 0089)", () => {
  // zod 3.25.76's answer for each sample (`z.string().email()`), recorded when the move was made.
  const truth: Array<[string, boolean]> = [
    ["a@b.co", true],
    ["user+tag@example.com", true],
    ["first.last@sub.example.co.uk", true],
    ["a..b@x.com", false],
    [".a@x.com", false],
    ["a.@x.com", false],
    ['"quoted"@x.com', false],
    ["a@localhost", false],
    ["x@1.com", true],
    ["a@b.c", false],
    ["ü@x.com", false],
    ["a@ü.com", false],
    [" a@b.com", false],
    ["a@b.com ", false],
    ["a b@c.com", false],
    ["a@b..com", false],
    ["a@-b.com", false],
    ["a@b-.com", true],
    ["a@b.c0m", false],
    ["a@b.com.", false],
    ["A@B.COM", true],
    ["a'b@x.org", true],
    ["a_b@x.io", true],
    ["a@x.com\n", false],
    ["a@[127.0.0.1]", false],
    ["a@b.com,c@d.com", false],
    ["a@@b.com", false],
    ["", false],
    ["@x.com", false],
    ["a@", false],
    ["a+@x.com", true],
    ["very.long." + "a".repeat(60) + "@x.com", true],
    ["a@" + "b".repeat(63) + ".com", true],
    ["a@" + "b".repeat(64) + ".com", true],
    ["A.B-C_d+e@sub-domain.example.org", true],
    ["x@y.z", false],
    ["name@domain.com.au", true],
    ["bad@", false],
    ["@@", false],
    ["a@b_c.com", false],
  ];

  it.each(truth)("%j is %s", (value, accepted) => {
    expect(z.email().safeParse(value).success).toBe(accepted);
  });
});

describe("validationFields (the fields a 400 names)", () => {
  it("names a field with a type error once, by that error", () => {
    // zod 4 also runs a too-small check on an empty array given for a string with min(1).
    expect(
      validationFields([
        { path: ["sku"], code: "invalid_type" },
        { path: ["sku"], code: "too_small" },
      ])
    ).toEqual(["sku"]);
  });

  it("keeps a repeat for two checks on a right-typed value, as before", () => {
    expect(
      validationFields([
        { path: ["workspaceId"], code: "too_small" },
        { path: ["workspaceId"], code: "invalid_format" },
      ])
    ).toEqual(["workspaceId", "workspaceId"]);
  });

  it("keeps the order of the other fields and joins nested paths with a dot", () => {
    expect(
      validationFields([
        { path: ["a", 0, "b"], code: "invalid_type" },
        { path: ["c"], code: "too_small" },
        { path: ["a", 0, "b"], code: "too_small" },
      ])
    ).toEqual(["a.0.b", "c"]);
  });
});

describe("MCP tool validation messages (the text an MCP client sees)", () => {
  const tool = (name: string) => {
    const found = TOOLS.find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found.inputSchema as { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } };
  };
  const messages = (name: string, input: unknown): string[] => {
    const result = tool(name).safeParse(input);
    return result.success ? [] : (result.error?.issues ?? []).map((i) => i.message);
  };

  it("an empty array for a text field gets the type message only", () => {
    expect(messages("request_replenishment", { sku: [] })).toEqual(["sku must be text"]);
  });

  it("a missing object gets zod 3's Required text", () => {
    expect(messages("propose_menu_change", {})).toContain("Required");
  });

  it("a wrong-typed top-level input is an expected object, as zod 3 said", () => {
    expect(messages("get_workspace", null)).toEqual(["Expected object, received null"]);
  });

  it("an unknown field gets the fixed text and never echoes the value", () => {
    expect(messages("request_replenishment", { sku: "ABC", zzz: "secret-value" })).toEqual(["unknown field"]);
  });

  it("an empty line list gets the type message only", () => {
    expect(messages("create_customer_order", { externalRef: "r", lines: "" })).not.toContain("lines must have at least 1 line");
  });

  it("an infinite number is refused as not a number", () => {
    expect(messages("poll_events", { limit: Infinity })).toEqual(["limit must be a number"]);
  });
});

describe("numbers outside the range zod 4 accepts (a documented change, ADR 0089)", () => {
  it("an integer beyond the safe integer range is refused", () => {
    const body = { sku: "ABC-1", name: "Item", currentQuantity: 1, parLevel: 1, reorderQuantity: 1, unitPriceCents: 2 ** 53 };
    expect(InitialSupplyItemSchema.safeParse(body).success).toBe(false);
  });

  it("an infinite quantity is refused", () => {
    const body = { sku: "ABC-1", name: "Item", currentQuantity: Infinity, parLevel: 1, reorderQuantity: 1, unitPriceCents: 2 };
    expect(InitialSupplyItemSchema.safeParse(body).success).toBe(false);
  });
});
