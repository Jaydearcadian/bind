import http from "node:http";

/**
 * A local stand-in for the Resend API (ADR 0074). It listens on 127.0.0.1 only, so no test reaches a real provider. Each
 * request is recorded as the provider would receive it. The next answer is set by the test: a status, a delay, or a raw
 * body. The default answer is a 2xx with a provider id.
 */
export interface CapturedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: { from?: string; to?: string[]; subject?: string; text?: string } | null;
  rawBody: string;
}

export interface FakeResend {
  /** For BIND_EMAIL_API_BASE. */
  baseUrl: string;
  /** Every request received, in order, including the ones answered with an error. */
  received: CapturedRequest[];
  /** The status for every later request. Default 200. */
  status: number;
  /** A delay before answering, in milliseconds. Default 0. */
  delayMs: number;
  /** A raw body to answer with instead of the default JSON. Null for the default. */
  rawBody: string | null;
  close(): Promise<void>;
}

export async function startFakeResend(): Promise<FakeResend> {
  const fake = {
    baseUrl: "",
    received: [] as CapturedRequest[],
    status: 200,
    delayMs: 0,
    rawBody: null as string | null,
  } as FakeResend;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let parsed: CapturedRequest["body"] = null;
      try {
        parsed = JSON.parse(rawBody) as CapturedRequest["body"];
      } catch {
        parsed = null;
      }
      fake.received.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: parsed,
        rawBody,
      });
      const answer = () => {
        if (fake.status >= 200 && fake.status < 300 && fake.rawBody === null) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: `email_fake_${fake.received.length}` }));
          return;
        }
        res.writeHead(fake.status, { "Content-Type": "application/json" });
        res.end(fake.rawBody ?? JSON.stringify({ name: "provider_error", message: "fake failure" }));
      };
      if (fake.delayMs > 0) setTimeout(answer, fake.delayMs);
      else answer();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fake provider did not start");
  fake.baseUrl = `http://127.0.0.1:${addr.port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return fake;
}

/** The six-digit code in a verification mail. Throws when the mail carries none. */
export function codeIn(request: CapturedRequest): string {
  const match = /verification code is (\d{6})\./.exec(request.body?.text ?? "");
  if (!match) throw new Error("no verification code in the email");
  return match[1];
}
