import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { config } from "../../src/config/env.js";
import { effectiveIntegrationStatus } from "../../src/adapters/socialSurface.js";
import { setLogSink } from "../../src/observability/logger.js";
import { startFakeResend, codeIn, type FakeResend } from "../helpers/fake-resend.js";

/**
 * The owner email routes (ADR 0074), over HTTP against PostgreSQL. The provider is a local fake. These tests cover who may
 * call each route, the limits (sends, attempts, expiry), the binding a verified address creates, the removal, the audit
 * rows, and the rule that a response never carries a code or a hash.
 */

const run = Date.now();
const wsB = `ws-oe-b-${run}`;
const KEY = "re_route_test_key_0123456789";
const FROM = "Bind <notices@example.test>";

// Each test gets its own workspace for the owner, so the per-workspace send caps (ADR 0074) never leak between tests.
let wsA = "";
let server: Server;
let baseUrl = "";
let fake: FakeResend;
let ownerA: { token: string };
let staffA: { token: string };
let ownerB: { token: string };
const createdWorkspaces: string[] = [];
let workspaceCounter = 0;

async function newWorkspace(): Promise<string> {
  workspaceCounter += 1;
  const id = `ws-oe-${run}-${workspaceCounter}`;
  createdWorkspaces.push(id);
  await provisionWorkspace(id, "Email Kitchen", "kitchen-v1");
  return id;
}
const logged: string[] = [];
let addressCounter = 0;

const saved = {
  provider: config.BIND_EMAIL_PROVIDER,
  key: config.BIND_EMAIL_API_KEY,
  from: config.BIND_EMAIL_FROM,
  base: config.BIND_EMAIL_API_BASE,
};

function enableEmail(): void {
  config.BIND_EMAIL_PROVIDER = "resend";
  config.BIND_EMAIL_API_KEY = KEY;
  config.BIND_EMAIL_FROM = FROM;
  config.BIND_EMAIL_API_BASE = fake.baseUrl;
}

function disableEmail(): void {
  config.BIND_EMAIL_PROVIDER = undefined;
  config.BIND_EMAIL_API_KEY = undefined;
  config.BIND_EMAIL_FROM = undefined;
  config.BIND_EMAIL_API_BASE = undefined;
}

/** A fresh address, so the per-address limits of one test never touch another test. */
function freshAddress(): string {
  addressCounter += 1;
  return `Owner.${run}.${addressCounter}@Kitchen.Example`;
}

async function call(method: string, routePath: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, text, headers: res.headers };
}

const requestPath = (ws: string) => `/api/workspaces/${ws}/notifications/email`;
const verifyPath = (ws: string) => `/api/workspaces/${ws}/notifications/email/verify`;
const removePath = (ws: string, id: string) => `/api/workspaces/${ws}/notifications/email/${id}`;
const channelsPath = (ws: string) => `/api/workspaces/${ws}/notifications`;

/** Requests a code for an address as the owner of wsA and returns the id, the code and the request's answer. */
async function requestFor(address: string, token = ownerA.token) {
  const out = await call("POST", requestPath(wsA), { token, body: { email: address } });
  const sent = fake.received.at(-1);
  return { out, code: sent ? codeIn(sent) : null };
}

beforeAll(async () => {
  await runMigrations();
  await provisionWorkspace(wsB, "Email Kitchen B", "kitchen-v1");
  createdWorkspaces.push(wsB);
  ownerB = await issueToken(wsB, "owner", "owner-b");

  fake = await startFakeResend();
  setLogSink((line) => logged.push(line));
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

beforeEach(async () => {
  fake.received.length = 0;
  fake.status = 200;
  fake.delayMs = 0;
  fake.rawBody = null;
  logged.length = 0;
  enableEmail();
  wsA = await newWorkspace();
  ownerA = await issueToken(wsA, "owner", "owner-a");
  staffA = await issueToken(wsA, "staff", "line-cook");
});

afterAll(async () => {
  setLogSink(null);
  config.BIND_EMAIL_PROVIDER = saved.provider;
  config.BIND_EMAIL_API_KEY = saved.key;
  config.BIND_EMAIL_FROM = saved.from;
  config.BIND_EMAIL_API_BASE = saved.base;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.close();
  await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [createdWorkspaces]);
  await closePool();
});

describe("who may use the owner email routes", () => {
  it("a staff token is refused on every route, an anonymous call is 401, and another workspace is 404", async () => {
    const address = freshAddress();
    const staffPost = await call("POST", requestPath(wsA), { token: staffA.token, body: { email: address } });
    expect(staffPost.status).toBe(403);
    expect((await call("GET", channelsPath(wsA), { token: staffA.token })).status).toBe(403);
    expect((await call("POST", verifyPath(wsA), { token: staffA.token, body: { id: "x", code: "123456" } })).status).toBe(403);
    expect((await call("DELETE", removePath(wsA, "x"), { token: staffA.token })).status).toBe(403);
    expect(fake.received).toHaveLength(0);

    expect((await call("GET", channelsPath(wsA))).status).toBe(401);
    expect((await call("POST", requestPath(wsA), { body: { email: address } })).status).toBe(401);

    const otherWorkspace = await call("POST", requestPath(wsA), { token: ownerB.token, body: { email: address } });
    expect(otherWorkspace.status).toBe(404);
    expect(otherWorkspace.body).toMatchObject({ error: "Workspace not found" });
    expect(fake.received).toHaveLength(0);
  });
});

describe("when email is not configured on this server", () => {
  it("refuses to create a verification and says so plainly, and the listing shows email as simulated", async () => {
    disableEmail();
    const address = freshAddress();
    const out = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } });
    expect(out.status).toBe(503);
    expect(out.body.code).toBe("EMAIL_NOT_CONFIGURED");

    const rows = await query(`SELECT COUNT(*)::int AS n FROM owner_emails WHERE workspace_id = $1 AND email = $2;`, [wsA, address.toLowerCase()]);
    expect(rows.rows[0].n).toBe(0);

    const channels = await call("GET", channelsPath(wsA), { token: ownerA.token });
    expect(channels.status).toBe(200);
    expect(channels.body.emailDelivery).toBe("simulated");
    expect(fake.received).toHaveLength(0);
  });
});

describe("requesting a code", () => {
  it("sends a code by email only: the answer is pending, with an expiry, and carries no code or hash", async () => {
    const address = freshAddress();
    const { out, code } = await requestFor(address);
    expect(out.status).toBe(201);
    expect(Object.keys(out.body).sort()).toEqual(["email", "expiresAt", "id", "status"]);
    expect(out.body.status).toBe("pending");
    expect(out.body.email).toBe(address.toLowerCase());
    expect(Date.parse(out.body.expiresAt)).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(Date.parse(out.body.expiresAt)).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 5_000);

    // The code is in the email, and only there.
    expect(code).toMatch(/^\d{6}$/);
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0].authorization).toBe(`Bearer ${KEY}`);
    expect(fake.received[0].body?.to).toEqual([address.toLowerCase()]);
    expect(fake.received[0].body?.subject).toBe("Your Bind verification code");
    expect(out.text).not.toContain(code as string);
    expect(out.text).not.toMatch(/code_hash|code_salt|salt/);

    // The row keeps a salted hash, never the code.
    const row = await query(`SELECT code_hash, code_salt, verified_at FROM owner_emails WHERE id = $1;`, [out.body.id]);
    expect(row.rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0].code_hash).not.toContain(code as string);
    expect(row.rows[0].verified_at).toBeNull();

    // The provider's id and the logs carry no address and no key.
    const logText = logged.join("\n");
    expect(logText).not.toContain(KEY);
    expect(logText).not.toContain(address.toLowerCase());
    expect(logText).not.toContain(code as string);
  });

  it("refuses a malformed address before anything is sent", async () => {
    const out = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: "not-an-address" } });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe("INVALID_INPUT");
    expect(fake.received).toHaveLength(0);
  });

  it("allows three codes per address per hour, then refuses with Retry-After and sends nothing", async () => {
    const address = freshAddress();
    for (let i = 0; i < 3; i += 1) {
      const out = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } });
      expect(out.status, `send ${i + 1}`).toBe(201);
    }
    expect(fake.received).toHaveLength(3);

    const limited = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("EMAIL_SEND_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fake.received).toHaveLength(3);
  });

  it("does not let a removed and re-added address escape the send limit", async () => {
    const address = freshAddress();
    const first = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } });
    expect(first.status).toBe(201);
    await call("DELETE", removePath(wsA, first.body.id), { token: ownerA.token });
    for (let i = 0; i < 2; i += 1) {
      expect((await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } })).status).toBe(201);
    }
    const limited = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } });
    expect(limited.status).toBe(429);
  });

  it("a failed send is refused honestly, audited as failed, and leaves the address unverified", async () => {
    const address = freshAddress();
    fake.status = 500;
    const failed = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } });
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe("EMAIL_SEND_FAILED");
    expect(failed.text).not.toContain(address.toLowerCase());

    const audit = await query(
      `SELECT evidence::text AS evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'notification.email_send_failed' ORDER BY created_at DESC LIMIT 1;`,
      [wsA]
    );
    expect(audit.rows[0].evidence).toContain("o***@k***.example");
    expect(audit.rows[0].evidence).not.toContain(address.toLowerCase());

    const channels = await call("GET", channelsPath(wsA), { token: ownerA.token });
    const entry = channels.body.emails.find((e: any) => e.email === address.toLowerCase());
    expect(entry.status).toBe("pending");

    fake.status = 200;
    const retry = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } });
    expect(retry.status).toBe(201);
  });

  it("answers the same shape whether or not another workspace has verified the address", async () => {
    const address = freshAddress();
    const { out: first, code } = await requestFor(address);
    const verified = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: first.body.id, code } });
    expect(verified.status).toBe(200);

    // Owner B asks for the same address in its own workspace: the answer is pending, exactly as for a new address.
    const other = await call("POST", requestPath(wsB), { token: ownerB.token, body: { email: address } });
    expect(other.status).toBe(201);
    expect(other.body.status).toBe("pending");
    expect(Object.keys(other.body).sort()).toEqual(["email", "expiresAt", "id", "status"]);
  });

  it("an address already verified in this workspace is answered as verified, and nothing is sent", async () => {
    const address = freshAddress();
    const { out: first, code } = await requestFor(address);
    await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: first.body.id, code } });
    const sentBefore = fake.received.length;

    const again = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("verified");
    expect(again.body.expiresAt).toBeNull();
    expect(fake.received.length).toBe(sentBefore);
  });
});

describe("verifying a code", () => {
  it("a correct code verifies the address, creates the owner's email binding, and is idempotent", async () => {
    const address = freshAddress();
    const { out: requested, code } = await requestFor(address);
    const verified = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code } });
    expect(verified.status).toBe(200);
    expect(Object.keys(verified.body).sort()).toEqual(["email", "id", "status", "verifiedAt"]);
    expect(verified.body.status).toBe("verified");
    expect(verified.text).not.toContain(code as string);

    const binding = await query(
      `SELECT actor_role, surface, integration_status, actor_id FROM surface_bindings WHERE workspace_id = $1 AND surface = 'email' AND actor_id = $2;`,
      [wsA, address.toLowerCase()]
    );
    expect(binding.rows).toHaveLength(1);
    expect(binding.rows[0].actor_role).toBe("owner");
    // The binding's status follows the existing gate (ADR 0022): verified only with SURFACE_PROVIDER_VERIFIED.
    expect(binding.rows[0].integration_status).toBe(effectiveIntegrationStatus("verified"));

    const sentBefore = fake.received.length;
    const again = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code } });
    expect(again.status).toBe(200);
    expect(again.body.verifiedAt).toBe(verified.body.verifiedAt);
    const bindings = await query(`SELECT COUNT(*)::int AS n FROM surface_bindings WHERE workspace_id = $1 AND actor_id = $2;`, [wsA, address.toLowerCase()]);
    expect(bindings.rows[0].n).toBe(1);
    expect(fake.received.length).toBe(sentBefore);
  });

  it("a wrong code is refused with the attempts left, and five wrong codes end the code", async () => {
    const address = freshAddress();
    const { out: requested, code } = await requestFor(address);
    const wrong = code === "000000" ? "000001" : "000000";

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const out = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code: wrong } });
      expect(out.status, `attempt ${attempt}`).toBe(400);
      expect(out.body.code).toBe("EMAIL_CODE_INVALID");
      expect(out.body.error).toBe(`The code is not right. ${5 - attempt} attempts left.`);
    }
    // After the fifth wrong guess the code is used up: a sixth guess is refused as exceeded.
    const sixth = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code: wrong } });
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe("EMAIL_ATTEMPTS_EXCEEDED");

    // Even the right code is now refused: a new code is needed.
    const right = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code } });
    expect(right.status).toBe(409);
    expect(right.body.code).toBe("EMAIL_ATTEMPTS_EXCEEDED");

    const audit = await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'notification.email_verify_failed';`, [wsA]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it("a new request after exhaustion gives a new code that works", async () => {
    const address = freshAddress();
    const { out: requested, code: firstCode } = await requestFor(address);
    const wrong = firstCode === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i += 1) {
      await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code: wrong } });
    }
    const { out: again, code: secondCode } = await requestFor(address);
    expect(again.body.id).toBe(requested.body.id);
    const verified = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: again.body.id, code: secondCode } });
    expect(verified.status).toBe(200);
  });

  it("an expired code is refused, and says it has expired", async () => {
    const address = freshAddress();
    const { out: requested, code } = await requestFor(address);
    await query(`UPDATE owner_emails SET code_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1;`, [requested.body.id]);
    const out = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code } });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe("EMAIL_CODE_EXPIRED");
  });

  it("a code that is not six digits is refused before it is checked", async () => {
    const address = freshAddress();
    const { out: requested } = await requestFor(address);
    for (const code of ["12345", "1234567", "abcdef", 123456]) {
      const out = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code } });
      expect(out.status, JSON.stringify(code)).toBe(400);
      expect(out.body.code).toBe("INVALID_INPUT");
    }
    const row = await query(`SELECT attempts FROM owner_emails WHERE id = $1;`, [requested.body.id]);
    expect(row.rows[0].attempts).toBe(0);
  });

  it("an id from another workspace is not found, and another tenant cannot verify or remove it", async () => {
    const address = freshAddress();
    const { out: requested, code } = await requestFor(address);
    const crossVerify = await call("POST", verifyPath(wsB), { token: ownerB.token, body: { id: requested.body.id, code } });
    expect(crossVerify.status).toBe(404);
    expect(crossVerify.body.code).toBe("EMAIL_NOT_FOUND");

    const crossRemove = await call("DELETE", removePath(wsB, requested.body.id), { token: ownerB.token });
    expect(crossRemove.status).toBe(404);
    // The row is untouched in its own workspace.
    const row = await query(`SELECT removed_at FROM owner_emails WHERE id = $1;`, [requested.body.id]);
    expect(row.rows[0].removed_at).toBeNull();
  });

  it("an unknown id is not found", async () => {
    const out = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: "oem_does_not_exist", code: "123456" } });
    expect(out.status).toBe(404);
    expect(out.body.code).toBe("EMAIL_NOT_FOUND");
  });
});

describe("listing and removing", () => {
  it("lists each address with its status and never a code, a hash or a salt", async () => {
    const address = freshAddress();
    const { out: requested, code } = await requestFor(address);
    await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code } });

    const channels = await call("GET", channelsPath(wsA), { token: ownerA.token });
    expect(channels.status).toBe(200);
    expect(channels.body.emailDelivery).toBe("on");
    const entry = channels.body.emails.find((e: any) => e.id === requested.body.id);
    expect(entry).toMatchObject({ email: address.toLowerCase(), status: "verified", expiresAt: null, attemptsRemaining: null });
    expect(channels.text).not.toMatch(/code_hash|code_salt|codeHash|salt/);
    expect(channels.text).not.toContain(code as string);
  });

  it("removing an address stops it at once, removes the binding it created, and is not repeatable", async () => {
    const address = freshAddress();
    const { out: requested, code } = await requestFor(address);
    await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code } });
    const before = await query(`SELECT COUNT(*)::int AS n FROM surface_bindings WHERE workspace_id = $1 AND actor_id = $2;`, [wsA, address.toLowerCase()]);
    expect(before.rows[0].n).toBe(1);

    const removed = await call("DELETE", removePath(wsA, requested.body.id), { token: ownerA.token });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ id: requested.body.id, removed: true });

    const after = await query(`SELECT COUNT(*)::int AS n FROM surface_bindings WHERE workspace_id = $1 AND actor_id = $2;`, [wsA, address.toLowerCase()]);
    expect(after.rows[0].n).toBe(0);
    const channels = await call("GET", channelsPath(wsA), { token: ownerA.token });
    expect(channels.body.emails.some((e: any) => e.id === requested.body.id)).toBe(false);

    const again = await call("DELETE", removePath(wsA, requested.body.id), { token: ownerA.token });
    expect(again.status).toBe(404);
  });

  it("a binding that was already there before the address was verified is left alone on removal", async () => {
    const address = freshAddress();
    // An existing owner binding for the address (set through the surfaces route, before any verification).
    await query(
      `INSERT INTO surface_bindings (id, workspace_id, surface, actor_id, actor_label, actor_role, integration_status)
       VALUES ($1, $2, 'email', $3, $3, 'staff', 'simulated');`,
      [`surf_pre_${run}_${addressCounter}`, wsA, address.toLowerCase()]
    );
    const { out: requested, code } = await requestFor(address);
    const verified = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code } });
    expect(verified.status).toBe(200);

    // The existing binding keeps its role and status: verification did not change it.
    const row = await query(`SELECT actor_role, integration_status FROM surface_bindings WHERE workspace_id = $1 AND actor_id = $2;`, [wsA, address.toLowerCase()]);
    expect(row.rows[0]).toEqual({ actor_role: "staff", integration_status: "simulated" });

    await call("DELETE", removePath(wsA, requested.body.id), { token: ownerA.token });
    const still = await query(`SELECT COUNT(*)::int AS n FROM surface_bindings WHERE workspace_id = $1 AND actor_id = $2;`, [wsA, address.toLowerCase()]);
    expect(still.rows[0].n).toBe(1);
  });

  it("audits each change with a masked address and an id, never the full address or a code", async () => {
    const address = freshAddress();
    const { out: requested, code } = await requestFor(address);
    await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: requested.body.id, code } });
    await call("DELETE", removePath(wsA, requested.body.id), { token: ownerA.token });

    const rows = await query(
      `SELECT action, evidence::text AS evidence, actor_type, actor_id FROM audit_logs
        WHERE workspace_id = $1 AND action LIKE 'notification.email_%' AND evidence::text LIKE $2
        ORDER BY created_at ASC;`,
      [wsA, `%${requested.body.id}%`]
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toEqual(["notification.email_code_sent", "notification.email_verified", "notification.email_removed"]);
    for (const row of rows.rows) {
      expect(row.actor_type).toBe("owner");
      expect(row.actor_id).toBe("owner-a");
      expect(row.evidence).not.toContain(address.toLowerCase());
      expect(row.evidence).not.toContain(code as string);
      expect(row.evidence).toMatch(/"maskedEmail":\s*"o\*\*\*@k\*\*\*\.example"/);
    }
  });
});

/** Marks a workspace as a demo, which is the flag the server reads (ADR 0057). */
async function makeDemo(ws: string): Promise<void> {
  await query(`UPDATE workspaces SET is_demo = true, demo_expires_at = NOW() + INTERVAL '1 day' WHERE id = $1;`, [ws]);
}

const wrongCodeFor = (code: string | null) => (code === "000000" ? "000001" : "000000");

describe("demo workspaces send and verify no email (ADR 0074)", () => {
  it("refuses a request and a verification with a plain message, and sends nothing", async () => {
    await makeDemo(wsA);
    const sent = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: freshAddress() } });
    expect(sent.status).toBe(403);
    expect(sent.body.code).toBe("EMAIL_DEMO_REFUSED");
    expect(sent.body.error).toMatch(/Demo workspaces do not send email/);

    const verified = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: "oem_none", code: "123456" } });
    expect(verified.status).toBe(403);
    expect(verified.body.code).toBe("EMAIL_DEMO_REFUSED");

    expect(fake.received).toHaveLength(0);
    const rows = await query(`SELECT COUNT(*)::int AS n FROM owner_emails WHERE workspace_id = $1;`, [wsA]);
    expect(rows.rows[0].n).toBe(0);
  });
});

describe("per-workspace limits on codes (ADR 0074)", () => {
  it("the sixth distinct address in a day is refused, while an address already asked for is not counted again", async () => {
    const addresses = Array.from({ length: 5 }, () => freshAddress());
    for (const address of addresses) {
      expect((await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } })).status).toBe(201);
    }
    const sixth = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: freshAddress() } });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe("EMAIL_SEND_LIMITED");
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);

    // One of the five may still be sent to again.
    expect((await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: addresses[0] } })).status).toBe(201);
    expect(fake.received).toHaveLength(6);
  });

  it("the eleventh code in a day is refused", async () => {
    const addresses = Array.from({ length: 5 }, () => freshAddress());
    for (const address of addresses) {
      expect((await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } })).status).toBe(201);
    }
    for (const address of addresses) {
      expect((await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } })).status).toBe(201);
    }
    expect(fake.received).toHaveLength(10);

    // The third code for the first address is within its own hourly limit, so only the daily total refuses it.
    const eleventh = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: addresses[0] } });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.code).toBe("EMAIL_SEND_LIMITED");
    expect(fake.received).toHaveLength(10);
  });

  it("concurrent requests for one new address send no more than the hourly limit", async () => {
    const address = freshAddress();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    expect(fake.received).toHaveLength(3);
  });
});

describe("wrong guesses per address survive re-sends (ADR 0074)", () => {
  it("ten wrong guesses across two codes refuse the address, sending nothing, until the day passes", async () => {
    const address = freshAddress();
    const first = await requestFor(address);
    for (let i = 0; i < 5; i += 1) {
      await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: first.out.body.id, code: wrongCodeFor(first.code) } });
    }
    // A new code does not reset the count.
    const second = await requestFor(address);
    expect(second.out.status).toBe(201);
    for (let i = 0; i < 5; i += 1) {
      await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: second.out.body.id, code: wrongCodeFor(second.code) } });
    }
    const failures = await query(`SELECT COUNT(*)::int AS n FROM owner_email_failures WHERE workspace_id = $1 AND email = $2;`, [wsA, address.toLowerCase()]);
    expect(failures.rows[0].n).toBe(10);

    const sentBefore = fake.received.length;
    const refused = await call("POST", requestPath(wsA), { token: ownerA.token, body: { email: address } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("EMAIL_ATTEMPTS_EXCEEDED");
    expect(refused.body.error).toMatch(/Try again in a day/);
    expect(fake.received.length).toBe(sentBefore);

    const right = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: second.out.body.id, code: second.code } });
    expect(right.status).toBe(409);
    expect(right.body.code).toBe("EMAIL_ATTEMPTS_EXCEEDED");

    // Once the day has passed, the address may be asked again, and a correct code verifies it.
    await query(`UPDATE owner_email_failures SET failed_at = NOW() - INTERVAL '25 hours' WHERE workspace_id = $1 AND email = $2;`, [
      wsA,
      address.toLowerCase(),
    ]);
    const later = await requestFor(address);
    expect(later.out.status).toBe(201);
    const verified = await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: later.out.body.id, code: later.code } });
    expect(verified.status).toBe(200);
    const cleared = await query(`SELECT COUNT(*)::int AS n FROM owner_email_failures WHERE workspace_id = $1 AND email = $2;`, [wsA, address.toLowerCase()]);
    expect(cleared.rows[0].n).toBe(0);
  });

  it("twenty concurrent wrong guesses on one code: exactly five are counted, five answer wrong-code and fifteen are exceeded", async () => {
    const address = freshAddress();
    const { out, code } = await requestFor(address);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: out.body.id, code: wrongCodeFor(code) } }))
    );
    expect(results.filter((r) => r.body.code === "EMAIL_CODE_INVALID")).toHaveLength(5);
    expect(results.filter((r) => r.body.code === "EMAIL_ATTEMPTS_EXCEEDED")).toHaveLength(15);

    const row = await query(`SELECT attempts FROM owner_emails WHERE id = $1;`, [out.body.id]);
    expect(row.rows[0].attempts).toBe(5);
    const failures = await query(`SELECT COUNT(*)::int AS n FROM owner_email_failures WHERE workspace_id = $1 AND email = $2;`, [wsA, address.toLowerCase()]);
    expect(failures.rows[0].n).toBe(5);
  });
});

describe("the email binding is removed only if the verification created it and it is unchanged (ADR 0074)", () => {
  it("a binding the owner sets through /surfaces after verification survives removal", async () => {
    const address = freshAddress();
    const { out, code } = await requestFor(address);
    await call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: out.body.id, code } });

    const touched = await call("POST", `/api/workspaces/${wsA}/surfaces`, {
      token: ownerA.token,
      body: { surface: "email", actorId: address.toLowerCase(), actorRole: "owner", integrationStatus: "simulated" },
    });
    expect(touched.status).toBe(201);

    expect((await call("DELETE", removePath(wsA, out.body.id), { token: ownerA.token })).status).toBe(200);
    const still = await query(`SELECT COUNT(*)::int AS n FROM surface_bindings WHERE workspace_id = $1 AND actor_id = $2;`, [wsA, address.toLowerCase()]);
    expect(still.rows[0].n).toBe(1);
  });

  it("a /surfaces write that races the verification: both succeed and one binding is left", async () => {
    const address = freshAddress();
    const { out, code } = await requestFor(address);
    const [verified, surfaced] = await Promise.all([
      call("POST", verifyPath(wsA), { token: ownerA.token, body: { id: out.body.id, code } }),
      call("POST", `/api/workspaces/${wsA}/surfaces`, {
        token: ownerA.token,
        body: { surface: "email", actorId: address.toLowerCase(), actorRole: "owner", integrationStatus: "simulated" },
      }),
    ]);
    expect(verified.status).toBe(200);
    expect(surfaced.status).toBe(201);
    const rows = await query(`SELECT COUNT(*)::int AS n FROM surface_bindings WHERE workspace_id = $1 AND actor_id = $2;`, [wsA, address.toLowerCase()]);
    expect(rows.rows[0].n).toBe(1);
  });
});

describe("a live provider with the simulated server is never mixed up", () => {
  it("the fake provider is the only place a message went", async () => {
    // Every message in this file went to the local fake server, which listens on 127.0.0.1 only.
    expect(fake.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    for (const request of fake.received) {
      expect(request.path).toBe("/emails");
    }
  });
});
