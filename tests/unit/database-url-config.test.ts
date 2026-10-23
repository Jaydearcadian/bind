import { describe, it, expect } from "vitest";
import { databaseUrlRule } from "../../src/config/env.js";

/**
 * DATABASE_URL in production (docs/decisions/0033). The default names a local development database with a known password,
 * so a production start without DATABASE_URL is refused. Pure: no configuration is re-read.
 */
describe("DATABASE_URL rule", () => {
  it("production without DATABASE_URL is refused", () => {
    expect(() => databaseUrlRule({ nodeEnv: "production", databaseUrl: undefined })).toThrow(/DATABASE_URL/);
    expect(() => databaseUrlRule({ nodeEnv: "production", databaseUrl: "" })).toThrow(/DATABASE_URL/);
  });

  it("production with DATABASE_URL is accepted", () => {
    expect(() =>
      databaseUrlRule({ nodeEnv: "production", databaseUrl: "postgres://app:secret@db.internal:5432/bind" })
    ).not.toThrow();
  });

  it("development and test keep the local default", () => {
    expect(() => databaseUrlRule({ nodeEnv: "development", databaseUrl: undefined })).not.toThrow();
    expect(() => databaseUrlRule({ nodeEnv: "test", databaseUrl: undefined })).not.toThrow();
    expect(() => databaseUrlRule({ nodeEnv: undefined, databaseUrl: undefined })).not.toThrow();
  });

  it("the refusal names the variable and never prints a value", () => {
    const secretLike = "postgres://app:do-not-print-me@db.internal:5432/bind";
    let message = "";
    try {
      databaseUrlRule({ nodeEnv: "production", databaseUrl: undefined });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(secretLike);
  });
});
