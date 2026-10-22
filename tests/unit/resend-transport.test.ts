import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createResendTransport, EmailTransportError } from "../../src/adapters/email/resend.js";
import { startFakeResend, type FakeResend } from "../helpers/fake-resend.js";
import { setLogSink } from "../../src/observability/logger.js";

/**
 * The Resend transport (ADR 0074), against a local fake server. No test reaches the real provider. A send succeeds only on a
 * 2xx answer with an id. Each failure is an EmailTransportError with a reason, and no error text carries the key, the
 * recipient, the subject or the provider's body.
 */

const KEY = "re_unit_secret_key_0123456789";
const RECIPIENT = "owner.private@kitchen.example";
const MESSAGE = { to: RECIPIENT, subject: "Something is waiting for you in Bind", text: "Body with a link.\n" };

let fake: FakeResend;
const logged: string[] = [];

beforeAll(async () => {
  fake = await startFakeResend();
  setLogSink((line) => logged.push(line));
});

afterAll(async () => {
  setLogSink(null);
  await fake.close();
});

beforeEach(() => {
  fake.received.length = 0;
  fake.status = 200;
  fake.delayMs = 0;
  fake.rawBody = null;
  logged.length = 0;
});

function transport(overrides: { apiBase?: string; timeoutMs?: number } = {}) {
  return createResendTransport({
    apiKey: KEY,
    from: "Bind <notices@example.com>",
    apiBase: overrides.apiBase ?? fake.baseUrl,
    timeoutMs: overrides.timeoutMs ?? 2000,
  });
}

async function failureOf(promise: Promise<unknown>): Promise<EmailTransportError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(EmailTransportError);
    return err as EmailTransportError;
  }
  throw new Error("expected the send to fail");
}

/** Everything a test could leak: the error text, its stack, and every log line written meanwhile. */
function leakSurface(err: Error): string {
  return [err.message, err.stack ?? "", String(err), ...logged].join("\n");
}

describe("Resend transport", () => {
  it("posts the message as the provider expects and returns the id it is given", async () => {
    const out = await transport().send(MESSAGE);
    expect(out).toEqual({ id: "email_fake_1" });

    expect(fake.received).toHaveLength(1);
    const request = fake.received[0];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/emails");
    expect(request.authorization).toBe(`Bearer ${KEY}`);
    expect(request.contentType).toBe("application/json");
    expect(request.body).toEqual({
      from: "Bind <notices@example.com>",
      to: [RECIPIENT],
      subject: "Something is waiting for you in Bind",
      text: "Body with a link.\n",
    });
  });

  it("refuses a 4xx answer with its status, and sends nothing again", async () => {
    fake.status = 422;
    fake.rawBody = JSON.stringify({ message: `invalid recipient ${RECIPIENT}`, key: KEY });
    const err = await failureOf(transport().send(MESSAGE));
    expect(err.reason).toBe("http");
    expect(err.status).toBe(422);
    expect(err.message).toBe("Email provider refused the message (HTTP 422)");
    expect(fake.received).toHaveLength(1);
  });

  it("refuses a 5xx answer and does not retry inside the adapter", async () => {
    fake.status = 500;
    const err = await failureOf(transport().send(MESSAGE));
    expect(err.reason).toBe("http");
    expect(err.status).toBe(500);
    expect(fake.received).toHaveLength(1);
  });

  it("times out when the provider is slow, and reports a timeout", async () => {
    fake.delayMs = 400;
    const err = await failureOf(transport({ timeoutMs: 100 }).send(MESSAGE));
    expect(err.reason).toBe("timeout");
    expect(err.message).toBe("Email provider did not answer in time");
  });

  it("refuses a 2xx answer that carries no usable id", async () => {
    for (const body of ["not json at all", "{}", '{"id": ""}', '{"id": 17}', "null"]) {
      fake.rawBody = body;
      const err = await failureOf(transport().send(MESSAGE));
      expect(err.reason, body).toBe("malformed_response");
    }
  });

  it("reports an unreachable provider as a network failure", async () => {
    const err = await failureOf(transport({ apiBase: "http://127.0.0.1:1", timeoutMs: 1000 }).send(MESSAGE));
    expect(err.reason).toBe("network");
    expect(err.message).toBe("Email provider could not be reached");
  });

  it("never puts the key, the recipient, the subject or the provider's body into an error or a log line", async () => {
    // The provider echoes everything back in its error body. None of it may reach the error or the log.
    fake.status = 400;
    fake.rawBody = JSON.stringify({ message: `bad ${RECIPIENT} ${MESSAGE.subject} ${KEY}` });
    const httpErr = await failureOf(transport().send(MESSAGE));
    const surface = leakSurface(httpErr);
    expect(surface).not.toContain(KEY);
    expect(surface).not.toContain(RECIPIENT);
    expect(surface).not.toContain(MESSAGE.subject);

    fake.status = 200;
    fake.rawBody = `{"id": ""}`;
    const malformed = await failureOf(transport().send(MESSAGE));
    expect(leakSurface(malformed)).not.toContain(KEY);
    expect(leakSurface(malformed)).not.toContain(RECIPIENT);
  });

  it("uses an injected fetch, so a caller can supply the network", async () => {
    const calls: string[] = [];
    const injected = createResendTransport({
      apiKey: KEY,
      from: "Bind <notices@example.com>",
      fetch: (async (url: string | URL) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ id: "email_injected" }), { status: 200 });
      }) as typeof fetch,
    });
    expect(await injected.send(MESSAGE)).toEqual({ id: "email_injected" });
    expect(calls).toEqual(["https://api.resend.com/emails"]);
  });
});
