import { describe, it, expect } from "vitest";
import { emailBaseUrlAllowed, envSchema } from "../../src/config/env.js";

/**
 * The owner email settings (ADR 0074). A base URL that carries a message or a key must be https. Only 127.0.0.1 and
 * localhost are allowed over http, and only outside production. The environment is refused at startup when a provider is
 * set without what it needs, and a refusal names a variable, never a value.
 */

const BASE_ENV = { NODE_ENV: "test", APP_BASE_URL: "http://127.0.0.1:3000" };

describe("emailBaseUrlAllowed", () => {
  it("accepts https anywhere", () => {
    expect(emailBaseUrlAllowed("https://api.resend.com", "production")).toBe(true);
    expect(emailBaseUrlAllowed("https://bind.example.com", "development")).toBe(true);
  });

  it("accepts http only on 127.0.0.1 or localhost, and only outside production", () => {
    expect(emailBaseUrlAllowed("http://127.0.0.1:4010", "test")).toBe(true);
    expect(emailBaseUrlAllowed("http://localhost:3000", "development")).toBe(true);
    expect(emailBaseUrlAllowed("http://127.0.0.1:3000", "production")).toBe(false);
    expect(emailBaseUrlAllowed("http://localhost", "production")).toBe(false);
  });

  it("refuses any other http host, a lookalike host, userinfo, and anything that is not a URL", () => {
    expect(emailBaseUrlAllowed("http://api.example.com", "test")).toBe(false);
    expect(emailBaseUrlAllowed("http://127.0.0.1.example.com", "test")).toBe(false);
    expect(emailBaseUrlAllowed("http://[::1]:3000", "test")).toBe(false);
    expect(emailBaseUrlAllowed("https://user:secret@api.resend.com", "production")).toBe(false);
    expect(emailBaseUrlAllowed("ftp://127.0.0.1", "test")).toBe(false);
    expect(emailBaseUrlAllowed("not a url", "test")).toBe(false);
  });
});

describe("the environment rules for email", () => {
  it("leaves email off when no provider is set, including empty values", () => {
    const parsed = envSchema.safeParse({ ...BASE_ENV, BIND_EMAIL_PROVIDER: "", BIND_EMAIL_API_KEY: "", BIND_EMAIL_FROM: "" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.BIND_EMAIL_PROVIDER).toBeUndefined();
      expect(parsed.data.BIND_EMAIL_API_KEY).toBeUndefined();
    }
  });

  it("accepts a complete provider setup", () => {
    const parsed = envSchema.safeParse({
      ...BASE_ENV,
      BIND_EMAIL_PROVIDER: "resend",
      BIND_EMAIL_API_KEY: "re_test_0123456789",
      BIND_EMAIL_FROM: "Bind <notices@example.com>",
      APP_BASE_URL: "https://bind.example.com",
      NODE_ENV: "production",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a provider without its key, its sender, or an https link base in production", () => {
    const noKey = envSchema.safeParse({ ...BASE_ENV, BIND_EMAIL_PROVIDER: "resend", BIND_EMAIL_FROM: "Bind <n@example.com>" });
    expect(noKey.success).toBe(false);
    expect(JSON.stringify(noKey)).toContain("BIND_EMAIL_API_KEY is required");

    const noFrom = envSchema.safeParse({ ...BASE_ENV, BIND_EMAIL_PROVIDER: "resend", BIND_EMAIL_API_KEY: "re_test_0123456789" });
    expect(noFrom.success).toBe(false);

    const insecure = envSchema.safeParse({
      ...BASE_ENV,
      NODE_ENV: "production",
      BIND_EMAIL_PROVIDER: "resend",
      BIND_EMAIL_API_KEY: "re_test_0123456789",
      BIND_EMAIL_FROM: "Bind <n@example.com>",
      APP_BASE_URL: "http://127.0.0.1:3000",
    });
    expect(insecure.success).toBe(false);
  });

  it("refuses an unknown provider, a sender without an address, and a key with a line break", () => {
    expect(envSchema.safeParse({ ...BASE_ENV, BIND_EMAIL_PROVIDER: "sendgrid" }).success).toBe(false);
    expect(envSchema.safeParse({ ...BASE_ENV, BIND_EMAIL_PROVIDER: "resend", BIND_EMAIL_API_KEY: "re_test_0123456789", BIND_EMAIL_FROM: "Bind" }).success).toBe(false);
    const withBreak = envSchema.safeParse({
      ...BASE_ENV,
      BIND_EMAIL_PROVIDER: "resend",
      BIND_EMAIL_API_KEY: "re_test\n0123456789",
      BIND_EMAIL_FROM: "Bind <n@example.com>",
    });
    expect(withBreak.success).toBe(false);
  });

  it("refuses an API base that is not https, unless it is local outside production, and never echoes the value", () => {
    const remote = envSchema.safeParse({ ...BASE_ENV, BIND_EMAIL_API_BASE: "http://api.example.com" });
    expect(remote.success).toBe(false);
    expect(JSON.stringify(remote)).not.toContain("api.example.com");

    expect(envSchema.safeParse({ ...BASE_ENV, BIND_EMAIL_API_BASE: "http://127.0.0.1:9999" }).success).toBe(true);
    expect(envSchema.safeParse({ ...BASE_ENV, NODE_ENV: "production", BIND_EMAIL_API_BASE: "http://127.0.0.1:9999" }).success).toBe(false);
  });
});
