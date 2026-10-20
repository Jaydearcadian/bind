import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken, revokeToken } from "../../src/auth/tokens.js";
import { newId } from "../../src/utils/ids.js";
import { countOpenStreamsFor, closeAllEventStreams } from "../../src/api/event-streams.js";
import { ROUTES } from "../../src/api/registry.js";
import { BindClient, BindApiError, type BindEvent } from "../../sdk/src/index.js";
import { OPERATIONS } from "../../sdk/src/generated/operations.js";

/*
 * The typed client against the real server (docs/decisions/0036): the app on port 0, PostgreSQL, real tokens and real
 * event streams. Nothing here is mocked. The SDK is imported from its source, as the rebuilt UI would import it.
 *
 * Event rows are written with direct INSERTs, the same columns WorkflowEngine.recordAudit writes (as in events.test.ts).
 */

const run = Date.now();
const WS1 = `ws-sdk-a-${run}`;
const WS2 = `ws-sdk-b-${run}`;
const FAST = { pollIntervalMs: 50, heartbeatMs: 200, maxStreamAgeMs: 60_000 };
const AUTH_REQUIRED = { error: "Authentication required" };

/** Every request the server received, recorded before any route runs. */
const serverSaw: Array<{ method: string; url: string; authorization?: string }> = [];
/** Every URL the SDK asked its fetch for. */
const sdkUrls: string[] = [];
/** The server's open sockets, so a test can cut the connection the way a network failure would. */
const sockets = new Set<Socket>();

const tokensUsed: string[] = [];

/** Writes one finished audit row for a workspace (committed at once, so it is visible to a stream straight away). */
async function insertEvent(workspaceId: string, action: string): Promise<void> {
  await query(
    `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
     VALUES ($1, $2, 'owner', 'owner:sdk-test', 'read', $3, 'ALLOW', '{}'::jsonb, NOW());`,
    [newId("audit"), workspaceId, action]
  );
}

/** The cursor of the newest event now, or "0.0" for an empty history. A stream started from it sees only later rows. */
async function currentCursor(client: BindClient, workspaceId: string): Promise<string> {
  return (await client.pollEvents(workspaceId)).nextCursor;
}

/** Waits for a condition, polling. Fails with the given message when it does not hold in time. */
async function waitFor(check: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A value or a timeout, whichever comes first. The timer is always cleared. */
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The next `count` events from an iterator, in order. */
async function nextN(iterator: AsyncIterator<BindEvent>, count: number, timeoutMs = 8000): Promise<BindEvent[]> {
  const out: BindEvent[] = [];
  while (out.length < count) {
    const next = await within(iterator.next(), timeoutMs, `fewer than ${count} events within ${timeoutMs} ms`);
    if (next.done) throw new Error(`the stream ended after ${out.length} of ${count} events`);
    out.push(next.value);
  }
  return out;
}

/** The first `count` events of a stream, then the stream is released. */
async function collect(iterable: AsyncIterable<BindEvent>, count: number): Promise<BindEvent[]> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    return await nextN(iterator, count);
  } finally {
    void iterator.return?.(undefined)?.catch(() => undefined);
  }
}

/** The contract's success schema for an operation (the first 2xx response that has one). */
function successSchema(operationId: string): z.ZodTypeAny {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`no registry entry for ${operationId}`);
  for (const [status, spec] of Object.entries(route.responses)) {
    if (Number(status) >= 200 && Number(status) < 300 && spec.schema) return spec.schema;
  }
  throw new Error(`${operationId} has no 2xx schema in the registry`);
}

function expectContract(operationId: string, value: unknown): void {
  const parsed = successSchema(operationId).safeParse(value);
  expect(parsed.success, `${operationId}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 400)}`).toBe(true);
}

/** Path parameters of an OpenAPI path template, by name. */
function templateParams(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

describe("typed client against the real server (docs/decisions/0036)", () => {
  const app = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, events: FAST });
  let server: Server;
  let baseUrl = "";

  let owner1: { id: string; token: string };
  let staff1: { id: string; token: string };
  let owner2: { id: string; token: string };
  let owner: BindClient;
  let staff: BindClient;

  /** A fetch that records the URL it was asked for, then makes the real request. */
  const tracked = (input: string | URL | Request, init?: RequestInit) => {
    sdkUrls.push(String(input));
    return fetch(input, init);
  };

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(WS1, "SDK Kitchen A", "kitchen-v1");
    await provisionWorkspace(WS2, "SDK Kitchen B", "kitchen-v1");
    owner1 = await issueToken(WS1, "owner", "sdk-owner");
    staff1 = await issueToken(WS1, "staff", "sdk-staff");
    owner2 = await issueToken(WS2, "owner", "sdk-owner-b");
    tokensUsed.push(owner1.token, staff1.token, owner2.token);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.prependListener("request", (req) => {
      serverSaw.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    });

    owner = new BindClient({ baseUrl, token: owner1.token, fetch: tracked, timeoutMs: 10_000 });
    staff = new BindClient({ baseUrl, token: staff1.token, fetch: tracked, timeoutMs: 10_000 });
  });

  afterAll(async () => {
    if (server) {
      closeAllEventStreams("shutdown");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await closePool();
  });

  it("the typed wrappers return what the contract says", async () => {
    // Settings and stock first, so the reads below have something to return.
    expectContract(
      "updatePolicy",
      await owner.owner.updatePolicy(WS1, { budgetDailyLimitCents: 150000, approvalThresholdCents: 25000 })
    );
    expectContract(
      "upsertInventoryItem",
      await staff.upsertInventory(WS1, {
        sku: "FOOD-SDK-1",
        name: "SDK Test Item",
        category: "General",
        unit: "unit",
        currentQuantity: 3,
        parLevel: 5,
        reorderQuantity: 10,
        unitPriceCents: 100,
      })
    );
    expectContract("replenish", await staff.replenish(WS1, "FOOD-FLOUR-50LB"));
    expectContract(
      "ingestFeedback",
      await staff.ingestFeedback(WS1, { source: "pos", externalId: `sdk-fb-${run}`, text: "Pasta sauce too salty" })
    );
    expectContract(
      "proposeMenuChange",
      await staff.proposeMenuChange(WS1, { change: { type: "add_item", name: "SDK Soup", priceCents: 600 }, rationale: "Guests asked" })
    );
    const kept = await staff.createCustomerOrder(WS1, { externalRef: `sdk-kept-${run}`, lines: [{ sku: "FOOD-FLOUR-50LB", quantity: 1 }] });
    expectContract("createCustomerOrder", kept);
    const dropped = await staff.createCustomerOrder(WS1, { externalRef: `sdk-drop-${run}`, lines: [{ sku: "FOOD-FLOUR-50LB", quantity: 1 }] });
    expectContract("cancelCustomerOrder", await staff.cancelCustomerOrder(WS1, dropped.orderId));

    expectContract("getWorkspace", await staff.workspace(WS1));
    expectContract("listInventory", await staff.listInventory(WS1));
    expectContract("listApprovals", await staff.listApprovals(WS1));
    expectContract("listOrders", await staff.listOrders(WS1));
    expectContract("listWorkflows", await staff.listWorkflows(WS1));
    expectContract("getNeedsAttention", await staff.needsAttention(WS1));
    expectContract("listCustomerOrders", await staff.listCustomerOrders(WS1));
    expectContract("listMenu", await staff.listMenu(WS1));
    expectContract("listAudit", await staff.listAudit(WS1));
    expectContract("getFeedbackSummary", await staff.feedbackSummary(WS1));
    expectContract("pollEvents", await staff.pollEvents(WS1, { limit: 5 }));
  });

  it("every GET operation in the contract is callable through call and returns what a direct fetch returns", async () => {
    // The member GET routes that have a contract test. Their path parameters are the workspace and a customer order.
    const kept = (await staff.listCustomerOrders(WS1)).find((o) => o.externalRef === `sdk-kept-${run}`);
    expect(kept, "the seeded customer order is listed").toBeDefined();
    const values: Record<string, string> = { id: WS1, orderId: kept!.orderId };
    // The feedback summary's default window starts at "now", so the parity check gives it a fixed one.
    const queries: Record<string, Record<string, string>> = { getFeedbackSummary: { since: "2026-01-01T00:00:00.000Z" } };

    const routes = ROUTES.filter((r) => r.method === "get" && r.access === "member" && r.contractTested);
    expect(routes.length).toBeGreaterThanOrEqual(10);
    // call is generic over operation ids; this loop has the ids as strings, so the signature is widened here only.
    const callLoose = staff.call.bind(staff) as unknown as (
      operationId: string,
      init: { params: Record<string, string>; query?: Record<string, string> }
    ) => Promise<unknown>;

    for (const route of routes) {
      const operation = OPERATIONS[route.operationId as keyof typeof OPERATIONS];
      const params: Record<string, string> = {};
      for (const name of templateParams(operation.path)) {
        if (!(name in values)) throw new Error(`${route.operationId} needs a path parameter the sweep does not supply: ${name}`);
        params[name] = values[name];
      }
      const search = queries[route.operationId] ?? {};
      const viaSdk = await callLoose(route.operationId, { params, query: search });

      const qs = new URLSearchParams(search).toString();
      const url = `${baseUrl}${operation.path.replace(/\{(\w+)\}/g, (_m, name: string) => encodeURIComponent(params[name]))}${qs ? `?${qs}` : ""}`;
      const direct = await fetch(url, { headers: { Authorization: `Bearer ${staff1.token}`, Accept: "application/json" } });
      expect(direct.status, route.operationId).toBe(200);
      expect(viaSdk, route.operationId).toEqual(await direct.json());
    }
  });

  it("owner operations work with an owner token and are refused with a staff token as BindApiError 403", async () => {
    const paused = await owner.owner.setAgentsPaused(WS1, true);
    expectContract("setAgentsPaused", paused);
    expectContract("setAgentsPaused", await owner.owner.setAgentsPaused(WS1, false));

    const refusedPolicy = await staff.owner
      .updatePolicy(WS1, { budgetDailyLimitCents: 1, approvalThresholdCents: 0 })
      .catch((e: unknown) => e);
    expect(refusedPolicy).toBeInstanceOf(BindApiError);
    expect((refusedPolicy as BindApiError).status).toBe(403);
    expect((refusedPolicy as BindApiError).message).toBe("Owner role required");

    const refusedPause = await staff.owner.setAgentsPaused(WS1, true).catch((e: unknown) => e);
    expect(refusedPause).toBeInstanceOf(BindApiError);
    expect((refusedPause as BindApiError).status).toBe(403);

    const issued = await owner.owner.issueToken(WS1, { role: "staff", label: "sdk-extra-staff" });
    tokensUsed.push(issued.token);
    expectContract("issueToken", issued);
    const refusedIssue = await staff.owner.issueToken(WS1, { role: "owner", label: "sdk-escalate" }).catch((e: unknown) => e);
    expect((refusedIssue as BindApiError).status).toBe(403);
  });

  it("a missing or revoked token gives BindApiError 401", async () => {
    // A missing token: the same client with its Authorization header removed on the way out.
    const withoutAuthorization = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
      delete headers.authorization;
      return fetch(input, { ...init, headers });
    }) as unknown as typeof fetch;
    const missing = new BindClient({ baseUrl, token: owner1.token, fetch: withoutAuthorization });
    const noToken = (await missing.workspace(WS1).catch((e: unknown) => e)) as BindApiError;
    expect(noToken).toBeInstanceOf(BindApiError);
    expect(noToken.status).toBe(401);
    expect(noToken.message).toBe(AUTH_REQUIRED.error);

    const revocable = await issueToken(WS1, "staff", "sdk-revocable");
    tokensUsed.push(revocable.token);
    const revocableClient = new BindClient({ baseUrl, token: revocable.token, fetch: tracked });
    expectContract("getWorkspace", await revocableClient.workspace(WS1));
    await revokeToken(WS1, revocable.id);
    const revoked = (await revocableClient.workspace(WS1).catch((e: unknown) => e)) as BindApiError;
    expect(revoked).toBeInstanceOf(BindApiError);
    expect(revoked.status).toBe(401);
  });

  it("another workspace is a 404 BindApiError", async () => {
    const otherTenant = (await staff.workspace(WS2).catch((e: unknown) => e)) as BindApiError;
    expect(otherTenant).toBeInstanceOf(BindApiError);
    expect(otherTenant.status).toBe(404);
    const crossWrite = (await owner.listInventory(WS2).catch((e: unknown) => e)) as BindApiError;
    expect(crossWrite.status).toBe(404);
  });

  it("events delivers new events in order", async () => {
    const start = await currentCursor(owner, WS1);
    const stream = owner.events(WS1, { lastEventId: start });
    await insertEvent(WS1, "sdk.first");
    await insertEvent(WS1, "sdk.second");
    await insertEvent(WS1, "sdk.third");
    const got = await collect(stream, 3);
    expect(got.map((e) => e.type)).toEqual(["sdk.first", "sdk.second", "sdk.third"]);
    expect(got[0]).toMatchObject({ effectClass: "read", decision: "ALLOW", actor: { type: "owner" } });
    expect(got[0].id).toMatch(/^\d+\.\d+$/);
    const ids = got.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => {
      const [ta, sa] = a.split(".").map(BigInt);
      const [tb, sb] = b.split(".").map(BigInt);
      return ta === tb ? (sa < sb ? -1 : sa > sb ? 1 : 0) : ta < tb ? -1 : 1;
    }));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("events reconnects after the connection is cut and delivers no gap and no duplicate", async () => {
    const start = await currentCursor(owner, WS1);
    const iterator = owner.events(WS1, { lastEventId: start })[Symbol.asyncIterator]();
    const requestsBefore = serverSaw.filter((r) => r.url.startsWith(`/api/workspaces/${WS1}/events`) && !r.url.includes("/poll")).length;

    await insertEvent(WS1, "cut.one");
    await insertEvent(WS1, "cut.two");
    const first = await nextN(iterator, 2);

    // A network failure: every socket the server holds is destroyed, so the client sees a dropped body.
    expect(sockets.size).toBeGreaterThan(0);
    for (const socket of sockets) socket.destroy();
    await insertEvent(WS1, "cut.three");
    await insertEvent(WS1, "cut.four");
    const second = await nextN(iterator, 2, 12_000);

    const authoritative = (await owner.pollEvents(WS1, { after: start, limit: 100 })).events.map((e) => e.id);
    expect([...first, ...second].map((e) => e.id)).toEqual(authoritative);
    const requestsAfter = serverSaw.filter((r) => r.url.startsWith(`/api/workspaces/${WS1}/events`) && !r.url.includes("/poll")).length;
    expect(requestsAfter - requestsBefore).toBeGreaterThanOrEqual(2);
    await iterator.return?.(undefined);
  });

  it("events resumes from lastEventId", async () => {
    const start = await currentCursor(owner, WS1);
    await insertEvent(WS1, "resume.a");
    await insertEvent(WS1, "resume.b");
    await insertEvent(WS1, "resume.c");
    const after = (await owner.pollEvents(WS1, { after: start, limit: 10 })).events.map((e) => e.id);
    expect(after).toHaveLength(3);
    const got = await collect(owner.events(WS1, { lastEventId: after[0] }), 2);
    expect(got.map((e) => e.id)).toEqual(after.slice(1));
  });

  it("events stops with a fatal error when the token is revoked", async () => {
    const start = await currentCursor(owner, WS1);
    const revocable = await issueToken(WS1, "staff", "sdk-stream-revoke");
    tokensUsed.push(revocable.token);
    const client = new BindClient({ baseUrl, token: revocable.token, fetch: tracked });
    const iterator = client.events(WS1, { lastEventId: start })[Symbol.asyncIterator]();
    const pending = iterator.next();

    await waitFor(() => countOpenStreamsFor({ tokenId: revocable.id }) === 1, "the stream never opened");
    await revokeToken(WS1, revocable.id);
    const error = await within(pending.catch((e: unknown) => e), 12_000, "the stream did not stop after revocation");
    expect(error).toBeInstanceOf(BindApiError);
    expect((error as BindApiError).status).toBe(401);
    expect(countOpenStreamsFor({ tokenId: revocable.id })).toBe(0);
  });

  it("events ends quietly on abort and on break, leaving no open handles", async () => {
    const start = await currentCursor(owner, WS1);
    const controller = new AbortController();
    const iterator = owner.events(WS1, { lastEventId: start, signal: controller.signal })[Symbol.asyncIterator]();
    await insertEvent(WS1, "abort.one");
    const [seen] = await nextN(iterator, 1);
    controller.abort();
    const ended = await within(iterator.next(), 4000, "the stream did not end on abort");
    expect(ended.done).toBe(true);
    await waitFor(() => countOpenStreamsFor({ tokenId: owner1.id }) === 0, "a stream stayed open after abort");

    await insertEvent(WS1, "break.one");
    let broken: BindEvent | undefined;
    for await (const event of owner.events(WS1, { lastEventId: seen.id })) {
      broken = event;
      break;
    }
    expect(broken?.type).toBe("break.one");
    await waitFor(() => countOpenStreamsFor({ tokenId: owner1.id }) === 0, "a stream stayed open after break");
  });

  it("events survives a server shutdown event by reconnecting", async () => {
    const start = await currentCursor(owner, WS1);
    const iterator = owner.events(WS1, { lastEventId: start })[Symbol.asyncIterator]();
    await insertEvent(WS1, "shutdown.before");
    const [before] = await nextN(iterator, 1);
    await waitFor(() => countOpenStreamsFor({ tokenId: owner1.id }) === 1, "the stream never opened");

    expect(closeAllEventStreams("shutdown")).toBeGreaterThanOrEqual(1);
    await insertEvent(WS1, "shutdown.after");
    const [after] = await nextN(iterator, 1, 6000);
    expect([before.type, after.type]).toEqual(["shutdown.before", "shutdown.after"]);
    expect(after.id).not.toBe(before.id);
    await iterator.return?.(undefined);
  });

  it("a stream pinned at call time delivers events written before the first connection succeeds", async () => {
    // The stream connection is held until released. The pin (the poll endpoint) is not held, and is observed to answer.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pinAnswered = 0;
    const gated = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/events/poll")) {
        return fetch(input, init).then((res) => {
          pinAnswered += 1;
          return res;
        });
      }
      if (url.includes("/events")) return held.then(() => fetch(input, init));
      return fetch(input, init);
    }) as unknown as typeof fetch;
    const client = new BindClient({ baseUrl, token: owner1.token, fetch: gated, timeoutMs: 10_000 });

    const iterable = client.events(WS1); // pinned now: the cursor is read at this call
    await waitFor(() => pinAnswered >= 1, "the pin never answered");
    await insertEvent(WS1, "pin.one");
    await insertEvent(WS1, "pin.two");
    const iterator = iterable[Symbol.asyncIterator]();
    const first = iterator.next();
    release();
    const got = [(await within(first, 10_000, "the pinned stream delivered nothing")).value as BindEvent];
    got.push(...(await nextN(iterator, 1, 10_000)));
    expect(got.map((e) => e.type)).toEqual(["pin.one", "pin.two"]);
    expect(got[0].id < got[1].id).toBe(true);
    await iterator.return?.(undefined);
  });

  it("a connection dropped before any event is received still delivers the events written during the outage", async () => {
    // Nothing is received before the cut, so only the pinned cursor can carry the outage events across the reconnect.
    // The stream of the test before may still be closing: wait for none to be open, then for exactly this one.
    await waitFor(() => countOpenStreamsFor({ tokenId: owner1.id }) === 0, "an earlier stream stayed open");
    const client = new BindClient({ baseUrl, token: owner1.token, fetch: tracked, timeoutMs: 10_000 });
    const iterator = client.events(WS1)[Symbol.asyncIterator]();
    const first = iterator.next();
    await waitFor(() => countOpenStreamsFor({ tokenId: owner1.id }) === 1, "the stream never opened");

    // The network failure: every server socket is destroyed while the stream holds no event for the caller.
    for (const socket of sockets) socket.destroy();
    await insertEvent(WS1, "outage.one");
    await insertEvent(WS1, "outage.two");

    const got = [(await within(first, 12_000, "the outage events were not delivered after reconnect")).value as BindEvent];
    got.push(...(await nextN(iterator, 1, 12_000)));
    expect(got.map((e) => e.type)).toEqual(["outage.one", "outage.two"]);
    await iterator.return?.(undefined);
  });

  it("the SDK never sends the token in a url", () => {
    expect(sdkUrls.length).toBeGreaterThan(0);
    for (const url of sdkUrls) {
      for (const token of tokensUsed) expect(url, url).not.toContain(token);
    }
    for (const request of serverSaw) {
      for (const token of tokensUsed) expect(request.url, request.url).not.toContain(token);
    }
    // Every request to the API carried the bearer token in its header, except the one the missing-token test sent on purpose.
    const apiRequests = serverSaw.filter((r) => r.url.startsWith("/api/workspaces/"));
    expect(apiRequests.length).toBeGreaterThan(0);
    const withoutToken = apiRequests.filter((r) => r.authorization === undefined);
    expect(withoutToken.map((r) => r.url)).toEqual([`/api/workspaces/${WS1}`]);
    for (const request of apiRequests.filter((r) => r.authorization !== undefined)) {
      expect(request.authorization, request.url).toMatch(/^Bearer bnd_/);
    }
  });
});
