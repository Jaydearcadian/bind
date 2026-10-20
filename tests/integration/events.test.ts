import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, getClient, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { issueToken, revokeToken } from "../../src/auth/tokens.js";
import { newId } from "../../src/utils/ids.js";
import { countOpenStreams, closeAllEventStreams } from "../../src/api/event-streams.js";

/*
 * The replayable workspace event stream (docs/decisions/0035). Every event is a persisted audit row. The stream is read over
 * HTTP against PostgreSQL: nothing here is mocked. A small SSE reader below parses the wire format.
 *
 * Each test makes its own tenants (a workspace with an owner and a staff token), so the history it reads is its own.
 */

const run = Date.now();
const METRICS_TOKEN = `events-metrics-token-${run}-0123456789abcdef`;
const FAST = { pollIntervalMs: 50, heartbeatMs: 200, maxStreamAgeMs: 60_000 };
const AUTH_REQUIRED = { error: "Authentication required" };
const NOT_FOUND = { error: "Workspace not found" };
/** A token-shaped value, built at run time, so the test never holds a real credential in source. */
const SEEDED_TOKEN = `bnd_${"Q".repeat(43)}`;

interface Tenant {
  id: string;
  owner: { id: string; token: string };
  staff: { id: string; token: string };
}

const tenantIds: string[] = [];

/** A workspace row with no templates, an owner token and a staff token. Each call is a fresh tenant. */
async function makeTenant(label: string): Promise<Tenant> {
  const id = `ws-events-${label}-${run}-${tenantIds.length}`;
  tenantIds.push(id);
  await query(`INSERT INTO workspaces (id, name, template_id) VALUES ($1, $2, 'kitchen-v1');`, [id, `Events ${label}`]);
  const owner = await issueToken(id, "owner", `${label}-owner`);
  const staff = await issueToken(id, "staff", `${label}-staff`);
  return {
    id,
    owner: { id: owner.id, token: owner.token },
    staff: { id: staff.id, token: staff.token },
  };
}

/** Writes one audit row by direct INSERT, the same columns WorkflowEngine.recordAudit writes. */
async function insertAudit(
  exec: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  workspaceId: string,
  action: string,
  evidence: Record<string, unknown> = {},
  options: { actorType?: string; actorId?: string; txHash?: string | null; workflowId?: string | null } = {}
): Promise<void> {
  await exec.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, tx_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, 'read', $6, 'ALLOW', $7::jsonb, $8, NOW());`,
    [
      newId("audit"),
      workspaceId,
      options.workflowId ?? null,
      options.actorType ?? "owner",
      options.actorId ?? "owner:events-test",
      action,
      JSON.stringify(evidence),
      options.txHash ?? null,
    ]
  );
}

/** A row written by its own autocommit statement. */
const record = (workspaceId: string, action: string, evidence: Record<string, unknown> = {}) =>
  insertAudit({ query }, workspaceId, action, evidence);

// -----------------------------------------------------------------------------------------------------------------------
// A small Server-Sent Events reader. It parses `id`, `event`, `data`, `retry` and comment lines.
// -----------------------------------------------------------------------------------------------------------------------

interface SseMessage {
  id?: string;
  event?: string;
  data?: any;
}

interface Waiter {
  resolve: (message: SseMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SseReader {
  pings = 0;
  ended = false;
  private buffer = "";
  private readonly pending: SseMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private endWaiters: Array<() => void> = [];

  constructor(private readonly body: ReadableStream<Uint8Array>) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    const reader = this.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let at = this.buffer.indexOf("\n\n");
        while (at >= 0) {
          const block = this.buffer.slice(0, at);
          this.buffer = this.buffer.slice(at + 2);
          this.accept(block);
          at = this.buffer.indexOf("\n\n");
        }
      }
    } catch {
      // An aborted or failed body ends the stream the same way a clean end does.
    }
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("stream ended"));
    }
    for (const done of this.endWaiters.splice(0)) done();
  }

  private accept(block: string): void {
    const message: SseMessage = {};
    let isComment = false;
    let data: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        isComment = true;
        if (line.slice(1).trim() === "ping") this.pings += 1;
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") message.id = value;
      else if (field === "event") message.event = value;
      else if (field === "data") data = data === undefined ? value : `${data}\n${value}`;
    }
    if (isComment && data === undefined && message.event === undefined) return;
    if (data !== undefined) message.data = data === "" ? undefined : JSON.parse(data);
    if (message.event === undefined && message.id === undefined && message.data === undefined) return; // retry: and the like
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.pending.push(message);
    }
  }

  /** The next message, in order. Rejects when no message arrives within the time, or the stream has ended. */
  next(timeoutMs = 5000): Promise<SseMessage> {
    const ready = this.pending.shift();
    if (ready) return Promise.resolve(ready);
    if (this.ended) return Promise.reject(new Error("stream ended"));
    return new Promise<SseMessage>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new Error(`no message within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Messages that arrive within the window. Pings are counted in `pings`, not returned. */
  async collect(windowMs: number): Promise<SseMessage[]> {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    return this.pending.splice(0);
  }

  /** Resolves when the stream has ended, or rejects after the timeout. */
  endedWithin(timeoutMs: number): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stream still open after ${timeoutMs} ms`)), timeoutMs);
      this.endWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

interface OpenedStream {
  status: number;
  headers: Headers;
  text: string;
  body: any;
  sse: SseReader | null;
  abort: () => void;
}

const opened: OpenedStream[] = [];

describe("workspace event stream and poll (docs/decisions/0035)", () => {
  // The per-token, per-workspace and global caps are the defaults here; the cap tests build their own apps.
  const app = createApp({ metrics: { token: METRICS_TOKEN, cacheMs: 0 }, events: FAST });
  let server: Server;
  let baseUrl = "";

  async function listen(target: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
    return new Promise((resolve) => {
      const s = target.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        const port = addr && typeof addr === "object" ? addr.port : 0;
        resolve({ server: s, url: `http://127.0.0.1:${port}` });
      });
    });
  }

  /** Opens a stream. A non-200 answer is returned as status, text and body, with no reader. */
  async function openStream(
    url: string,
    workspaceId: string,
    options: { token?: string; lastEventId?: string; query?: string } = {}
  ): Promise<OpenedStream> {
    const controller = new AbortController();
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    if (options.lastEventId !== undefined) headers["Last-Event-ID"] = options.lastEventId;
    const res = await fetch(`${url}/api/workspaces/${workspaceId}/events${options.query ?? ""}`, {
      headers,
      signal: controller.signal,
    });
    const isStream = res.status === 200;
    if (!isStream) {
      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const closed: OpenedStream = { status: res.status, headers: res.headers, text, body, sse: null, abort: () => controller.abort() };
      return closed;
    }
    const stream: OpenedStream = {
      status: res.status,
      headers: res.headers,
      text: "",
      body: undefined,
      sse: new SseReader(res.body!),
      abort: () => controller.abort(),
    };
    opened.push(stream);
    return stream;
  }

  async function send(
    url: string,
    path: string,
    options: { token?: string; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; text: string; body: any; headers: Headers }> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    const res = await fetch(`${url}${path}`, { headers, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, text, body, headers: res.headers };
  }

  /** A poll request. The route is the fallback for clients that cannot hold a stream (ADR 0035). */
  const poll = (tenant: Tenant, query = "", token = tenant.owner.token) =>
    send(baseUrl, `/api/workspaces/${tenant.id}/events/poll${query}`, { token });

  /** The cursor of the newest visible event of a tenant, as a client would take it from the poll route. */
  async function latestOf(tenant: Tenant): Promise<string> {
    const res = await poll(tenant);
    expect(res.status).toBe(200);
    return res.body.nextCursor;
  }

  /**
   * Stops a server a test started for itself. Its streams are aborted first: a server waits for open connections, and an open
   * stream is one that never ends by itself.
   */
  async function stopServer(target: Server): Promise<void> {
    for (const stream of opened.splice(0)) stream.abort();
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }

  /** Waits until the process holds no open stream: the cleanup of every test is checked, not assumed. */
  async function waitForNoStreams(timeoutMs = 5000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (countOpenStreams() > 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(countOpenStreams(), "open streams left after the test").toBe(0);
  }

  beforeAll(async () => {
    await runMigrations();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const stream of opened.splice(0)) stream.abort();
    await waitForNoStreams();
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tenantIds.length > 0) {
      await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [tenantIds]);
    }
    await closePool();
  });

  it("a new stream starts after the latest event and does not replay history", async () => {
    const t = await makeTenant("history");
    await record(t.id, "history.before", { units: 1 });
    await record(t.id, "history.before", { units: 2 });
    await record(t.id, "history.before", { units: 3 });

    const stream = await openStream(baseUrl, t.id, { token: t.owner.token });
    expect(stream.status).toBe(200);
    expect(stream.sse!.ended).toBe(false);
    expect(await stream.sse!.collect(300)).toEqual([]);

    await record(t.id, "history.after", { units: 4 });
    const next = await stream.sse!.next();
    expect(next.event).toBe("history.after");
    expect(next.data.data.units).toBe(4);
  });

  it("a stream delivers events written after it connected, in order", async () => {
    const t = await makeTenant("order");
    const stream = await openStream(baseUrl, t.id, { token: t.owner.token });
    for (let units = 1; units <= 5; units += 1) await record(t.id, "order.step", { units });

    const seen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const message = await stream.sse!.next();
      expect(message.event).toBe("order.step");
      seen.push(message.data.data.units);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(await stream.sse!.collect(200)).toEqual([]);
  });

  it("reconnecting with the last event id replays exactly the missed events with no gaps and no duplicates", async () => {
    const t = await makeTenant("replay");
    const start = await latestOf(t);
    for (let units = 1; units <= 20; units += 1) await record(t.id, "replay.step", { units });

    const first = await openStream(baseUrl, t.id, { token: t.owner.token, lastEventId: start });
    const firstSeen: SseMessage[] = [];
    for (let i = 0; i < 7; i += 1) firstSeen.push(await first.sse!.next());
    expect(firstSeen.map((m) => m.data.data.units)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const seventh = firstSeen[6].id!;
    first.abort();

    // Ten more are written while the client is away.
    for (let units = 21; units <= 30; units += 1) await record(t.id, "replay.step", { units });

    const second = await openStream(baseUrl, t.id, { token: t.owner.token, lastEventId: seventh });
    const replayed: SseMessage[] = [];
    for (let i = 0; i < 23; i += 1) replayed.push(await second.sse!.next());
    expect(replayed.map((m) => m.data.data.units)).toEqual(Array.from({ length: 23 }, (_, i) => i + 8));
    const ids = replayed.map((m) => m.id);
    expect(new Set(ids).size).toBe(23);
    expect(await second.sse!.collect(300)).toEqual([]);

    // The ids are the same ids the poll route gives for the same events: one identity, two transports.
    const polled = await poll(t, `?after=${encodeURIComponent(start)}&limit=200`);
    expect(polled.body.events.map((e: any) => e.id)).toEqual([...firstSeen.map((m) => m.id), ...ids]);
  });

  it("the query parameter lastEventId works for clients that cannot set headers", async () => {
    const t = await makeTenant("query");
    const start = await latestOf(t);
    for (let units = 1; units <= 5; units += 1) await record(t.id, "query.step", { units });
    const events = (await poll(t, `?after=${encodeURIComponent(start)}&limit=200`)).body.events;
    expect(events).toHaveLength(5);

    const stream = await openStream(baseUrl, t.id, {
      token: t.owner.token,
      query: `?lastEventId=${encodeURIComponent(events[1].id)}`,
    });
    const units = [];
    for (let i = 0; i < 3; i += 1) units.push((await stream.sse!.next()).data.data.units);
    expect(units).toEqual([3, 4, 5]);
    expect(await stream.sse!.collect(200)).toEqual([]);
  });

  it("a late-committing transaction is never skipped", { timeout: 30_000 }, async () => {
    const t = await makeTenant("late");
    const compared = (a: string, b: string) => {
      const [ta, sa] = a.split(".").map((n) => BigInt(n));
      const [tb, sb] = b.split(".").map((n) => BigInt(n));
      return ta === tb ? (sa < sb ? -1 : sa > sb ? 1 : 0) : ta < tb ? -1 : 1;
    };
    let previous: string | null = null;

    for (let round = 1; round <= 5; round += 1) {
      const start = await latestOf(t);
      const stream = await openStream(baseUrl, t.id, { token: t.owner.token, lastEventId: start });
      const a = await getClient();
      try {
        // A takes its transaction id first, then B writes and commits, then A writes. A's transaction id is lower than B's,
        // but A's row gets a higher sequence number than B's. So the order by (txid, seq) and the order by seq disagree.
        await a.query("BEGIN");
        await a.query("SELECT pg_current_xact_id();");
        await insertAudit({ query: (text, params) => query(text, params as any[]) }, t.id, `late.b${round}`, { units: 2 });
        await insertAudit(a, t.id, `late.a${round}`, { units: 1 });

        // B is committed but A is not: nothing is delivered, not even B.
        expect(await stream.sse!.collect(600), `round ${round}: nothing before A commits`).toEqual([]);

        await a.query("COMMIT");
      } finally {
        a.release();
      }

      const first = await stream.sse!.next();
      const second = await stream.sse!.next();
      expect(first.event, `round ${round}`).toBe(`late.a${round}`);
      expect(second.event, `round ${round}`).toBe(`late.b${round}`);
      expect(compared(first.id!, second.id!), `round ${round}: (txid, seq) order`).toBeLessThan(0);
      if (previous !== null) expect(compared(previous, first.id!), `round ${round}: cursor never goes backwards`).toBeLessThan(0);
      previous = second.id!;
      expect(await stream.sse!.collect(200), `round ${round}: no duplicate or extra event`).toEqual([]);
      stream.abort();
    }
  });

  it("the order is numeric: transaction ids of different digit counts keep their order", async () => {
    const t = await makeTenant("numeric-order");
    // Explicit transaction ids below the snapshot horizon, so they are visible. As text, "10" sorts before "9": the
    // order must be the numeric order of the transaction id.
    for (const [txid, units] of [
      ["9", 9],
      ["10", 10],
      ["100", 100],
    ] as const) {
      await query(
        `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, txid, created_at)
         VALUES ($1, $2, 'owner', 'owner:numeric', 'read', 'numeric.step', 'ALLOW', $3::jsonb, $4::xid8, NOW());`,
        [newId("audit"), t.id, JSON.stringify({ units }), txid]
      );
    }
    const polled = await poll(t, "?after=0.0&limit=200");
    expect(polled.body.events.slice(0, 3).map((e: any) => e.data.units)).toEqual([9, 10, 100]);
    expect(polled.body.events.slice(0, 3).map((e: any) => e.id.split(".")[0])).toEqual(["9", "10", "100"]);
    const streamed = await openStream(baseUrl, t.id, { token: t.owner.token, lastEventId: "0.0" });
    const first = [];
    for (let i = 0; i < 3; i += 1) first.push((await streamed.sse!.next()).data.data.units);
    expect(first).toEqual([9, 10, 100]);
  });

  it("events of another workspace are never delivered on a stream or by poll", async () => {
    const mine = await makeTenant("isolation-a");
    const theirs = await makeTenant("isolation-b");
    const start = await latestOf(mine);
    const stream = await openStream(baseUrl, mine.id, { token: mine.owner.token, lastEventId: start });

    const theirsStart = await latestOf(theirs);
    await record(theirs.id, "tenant.other_only", { units: 9 });
    await record(theirs.id, "tenant.other_only", { units: 10 });
    expect(await stream.sse!.collect(300)).toEqual([]);

    await record(mine.id, "tenant.mine_only", { units: 1 });
    const message = await stream.sse!.next();
    expect(message.event).toBe("tenant.mine_only");

    const polled = await poll(mine, `?after=${encodeURIComponent(start)}&limit=200`);
    expect(polled.body.events.map((e: any) => e.type)).toEqual(["tenant.mine_only"]);
    const theirsPolled = await poll(theirs, `?after=${encodeURIComponent(theirsStart)}&limit=200`);
    expect(theirsPolled.body.events.map((e: any) => e.type)).toEqual(["tenant.other_only", "tenant.other_only"]);
  });

  it("event data contains only allowed keys and no free text", async () => {
    const t = await makeTenant("data");
    const start = await latestOf(t);
    await insertAudit({ query }, t.id, "data.shape", {
      orderId: "ord_42",
      code: "STOCK_SHORT",
      status: "held",
      units: 3,
      reason: "owner typed a private reason",
      error: "raw database text",
      note: "a note",
      label: "a label",
      message: "a message",
      rationale: "why",
      extractedData: { payee: "someone" },
      nested: { anything: true },
      // A kept key whose value is a seeded credential: the stream must redact it.
      sku: `sku ${SEEDED_TOKEN}`,
    });

    const { body } = await poll(t, `?after=${encodeURIComponent(start)}&limit=200`);
    expect(body.events).toHaveLength(1);
    const event = body.events[0];
    expect(Object.keys(event.data).sort()).toEqual(["code", "orderId", "sku", "status", "units"]);
    expect(event.data.sku).toBe("sku [redacted-token]");
    expect(JSON.stringify(event)).not.toContain("private reason");
    expect(JSON.stringify(event)).not.toContain("raw database text");
    expect(JSON.stringify(event)).not.toContain(SEEDED_TOKEN);
  });

  it("staff do not receive auth, connector and capacity events but the owner does", async () => {
    const t = await makeTenant("roles");
    const start = await latestOf(t);
    await insertAudit({ query }, t.id, "auth.test_event", {});
    await insertAudit({ query }, t.id, "connector.test_event", { connectorId: "bank.main" });
    await insertAudit({ query }, t.id, "kitchen_capacity.test_event", { slotId: "slot-1" });
    await insertAudit({ query }, t.id, "approval.test_event", { orderId: "ord_1" });

    const staffPoll = await poll(t, `?after=${encodeURIComponent(start)}&limit=200`, t.staff.token);
    expect(staffPoll.status).toBe(200);
    expect(staffPoll.body.events.map((e: any) => e.type)).toEqual(["approval.test_event"]);

    const ownerPoll = await poll(t, `?after=${encodeURIComponent(start)}&limit=200`, t.owner.token);
    expect(ownerPoll.body.events.map((e: any) => e.type)).toEqual([
      "auth.test_event",
      "connector.test_event",
      "kitchen_capacity.test_event",
      "approval.test_event",
    ]);

    const staffStream = await openStream(baseUrl, t.id, { token: t.staff.token, lastEventId: start });
    const seen = await staffStream.sse!.next();
    expect(seen.event).toBe("approval.test_event");
    expect(await staffStream.sse!.collect(200)).toEqual([]);
  });

  it("a stream ends when its token is revoked", async () => {
    const t = await makeTenant("revoke");
    const stream = await openStream(baseUrl, t.id, { token: t.staff.token });
    expect(stream.status).toBe(200);
    await revokeToken(t.id, t.staff.id);
    // The stream checks its token on every loop, so it ends within a few poll intervals.
    await stream.sse!.endedWithin(2000);
    expect(stream.sse!.ended).toBe(true);
  });

  it("heartbeat comments are sent while the stream is idle", async () => {
    const t = await makeTenant("heartbeat");
    const stream = await openStream(baseUrl, t.id, { token: t.owner.token });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(stream.sse!.pings).toBeGreaterThanOrEqual(2);
    expect(await stream.sse!.collect(10)).toEqual([]);
  });

  it("the per-token stream cap answers 429 and a closed stream frees its slot", async () => {
    const capped = createApp({
      metrics: { token: null },
      events: { ...FAST, perTokenStreams: 2 },
    });
    const { server: capServer, url } = await listen(capped);
    try {
      const t = await makeTenant("token-cap");
      const one = await openStream(url, t.id, { token: t.owner.token });
      const two = await openStream(url, t.id, { token: t.owner.token });
      expect(one.status).toBe(200);
      expect(two.status).toBe(200);

      const refused = await openStream(url, t.id, { token: t.owner.token });
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("5");
      expect(refused.body).toEqual({ error: "Too many event streams", code: "TOO_MANY_STREAMS" });

      // Another token of the same workspace still has its own slots.
      const staffStream = await openStream(url, t.id, { token: t.staff.token });
      expect(staffStream.status).toBe(200);

      one.abort();
      let freed: OpenedStream | null = null;
      const until = Date.now() + 3000;
      while (freed === null && Date.now() < until) {
        const attempt = await openStream(url, t.id, { token: t.owner.token });
        if (attempt.status === 200) freed = attempt;
        else await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(freed, "a closed stream frees its slot").not.toBeNull();
    } finally {
      await stopServer(capServer);
    }
  });

  it("the workspace cap and the global cap answer 429", async () => {
    const t = await makeTenant("ws-cap");
    const other = await makeTenant("global-cap");

    const workspaceCapped = createApp({ metrics: { token: null }, events: { ...FAST, perWorkspaceStreams: 2 } });
    const wsServer = await listen(workspaceCapped);
    try {
      const a = await openStream(wsServer.url, t.id, { token: t.owner.token });
      const b = await openStream(wsServer.url, t.id, { token: t.staff.token });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const refused = await openStream(wsServer.url, t.id, { token: t.owner.token });
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe("TOO_MANY_STREAMS");
    } finally {
      await stopServer(wsServer.server);
    }
    for (const stream of opened.splice(0)) stream.abort();
    await waitForNoStreams();

    const globalCapped = createApp({ metrics: { token: null }, events: { ...FAST, globalStreams: 2 } });
    const globalServer = await listen(globalCapped);
    try {
      const a = await openStream(globalServer.url, t.id, { token: t.owner.token });
      const b = await openStream(globalServer.url, other.id, { token: other.owner.token });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const refused = await openStream(globalServer.url, other.id, { token: other.staff.token });
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe("TOO_MANY_STREAMS");
      expect(refused.headers.get("retry-after")).toBe("5");
    } finally {
      await stopServer(globalServer.server);
    }
  });

  it("a token in the query string is not accepted", async () => {
    const t = await makeTenant("query-token");
    const stream = await openStream(baseUrl, t.id, { query: `?token=${t.owner.token}` });
    expect(stream.status).toBe(401);
    expect(stream.body).toEqual(AUTH_REQUIRED);

    const polled = await send(baseUrl, `/api/workspaces/${t.id}/events/poll?token=${t.owner.token}`);
    expect(polled.status).toBe(401);
    expect(polled.body).toEqual(AUTH_REQUIRED);
    expect(polled.text).not.toContain(t.owner.token);
  });

  it("no token gives 401 and another workspace's token gives 404", async () => {
    const mine = await makeTenant("auth-a");
    const theirs = await makeTenant("auth-b");

    const bare = await openStream(baseUrl, mine.id);
    expect(bare.status).toBe(401);
    expect(bare.body).toEqual(AUTH_REQUIRED);

    const crossStream = await openStream(baseUrl, mine.id, { token: theirs.owner.token });
    expect(crossStream.status).toBe(404);
    expect(crossStream.body).toEqual(NOT_FOUND);

    const crossPoll = await poll(mine, "", theirs.staff.token);
    expect(crossPoll.status).toBe(404);
    expect(crossPoll.body).toEqual(NOT_FOUND);

    const barePoll = await send(baseUrl, `/api/workspaces/${mine.id}/events/poll`);
    expect(barePoll.status).toBe(401);
    expect(barePoll.body).toEqual(AUTH_REQUIRED);
  });

  it("a malformed cursor is a 400", async () => {
    const t = await makeTenant("cursor-400");
    const badHeader = await openStream(baseUrl, t.id, { token: t.owner.token, lastEventId: "not-a-cursor" });
    expect(badHeader.status).toBe(400);
    expect(badHeader.body).toEqual({ error: "Invalid cursor", code: "INVALID_CURSOR" });

    const badQuery = await openStream(baseUrl, t.id, { token: t.owner.token, query: "?lastEventId=1.2.3" });
    expect(badQuery.status).toBe(400);
    expect(badQuery.body).toEqual({ error: "Invalid cursor", code: "INVALID_CURSOR" });

    const badPoll = await poll(t, "?after=abc");
    expect(badPoll.status).toBe(400);
    expect(badPoll.body).toEqual({ error: "Invalid cursor", code: "INVALID_CURSOR" });
  });

  it("hostile input to the stream and poll routes is a JSON 4xx with no internal detail", async () => {
    const t = await makeTenant("hostile");
    const LEAK = /stack|SELECT|INSERT|pg_|relation|syntax|invalid input|at \/|\.ts:|\.js:/i;
    const cases: Array<{ name: string; run: () => Promise<{ status: number; headers: Headers; text: string; body: any }> }> = [
      {
        name: "a NUL character in the cursor (query)",
        run: () => openStream(baseUrl, t.id, { token: t.owner.token, query: "?lastEventId=1.2%00" }),
      },
      {
        name: "a 5,000-character Last-Event-ID header",
        run: () => openStream(baseUrl, t.id, { token: t.owner.token, lastEventId: "9".repeat(5000) }),
      },
      {
        name: "a SQL-looking cursor",
        run: () => openStream(baseUrl, t.id, { token: t.owner.token, query: "?lastEventId=%27%20OR%201%3D1%20--" }),
      },
      {
        name: "an array cursor on poll",
        run: () => send(baseUrl, `/api/workspaces/${t.id}/events/poll?after[a]=1`, { token: t.owner.token }),
      },
      {
        name: "an array limit on poll",
        run: () => send(baseUrl, `/api/workspaces/${t.id}/events/poll?limit[]=1`, { token: t.owner.token }),
      },
      {
        name: "a NUL character in the limit on poll",
        run: () => send(baseUrl, `/api/workspaces/${t.id}/events/poll?limit=%00`, { token: t.owner.token }),
      },
    ];
    for (const c of cases) {
      const res = await c.run();
      expect(res.status, c.name).toBeGreaterThanOrEqual(400);
      expect(res.status, c.name).toBeLessThan(500);
      expect(res.headers.get("content-type") ?? "", c.name).toContain("application/json");
      expect(typeof res.body?.error, c.name).toBe("string");
      expect(res.text, `${c.name} leaks detail`).not.toMatch(LEAK);
    }
  });

  it("poll returns events after a cursor with a next cursor and has-more", async () => {
    const t = await makeTenant("poll-pages");
    const start = await latestOf(t);
    for (let units = 1; units <= 5; units += 1) await record(t.id, "pages.step", { units });

    const first = await poll(t, `?after=${encodeURIComponent(start)}&limit=2`);
    expect(first.body.events.map((e: any) => e.data.units)).toEqual([1, 2]);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBe(first.body.events[1].id);

    const second = await poll(t, `?after=${encodeURIComponent(first.body.nextCursor)}&limit=2`);
    expect(second.body.events.map((e: any) => e.data.units)).toEqual([3, 4]);
    expect(second.body.hasMore).toBe(true);

    const third = await poll(t, `?after=${encodeURIComponent(second.body.nextCursor)}&limit=2`);
    expect(third.body.events.map((e: any) => e.data.units)).toEqual([5]);
    expect(third.body.hasMore).toBe(false);
    expect(third.body.nextCursor).toBe(third.body.events[0].id);

    const none = await poll(t, `?after=${encodeURIComponent(third.body.nextCursor)}&limit=2`);
    expect(none.body).toEqual({ events: [], nextCursor: third.body.nextCursor, hasMore: false });
  });

  it("poll without a cursor returns the latest events in ascending order", async () => {
    const t = await makeTenant("poll-latest");
    for (let units = 1; units <= 5; units += 1) await record(t.id, "latest.step", { units });

    const latest = await poll(t, "?limit=3");
    expect(latest.status).toBe(200);
    expect(latest.body.events.map((e: any) => e.data.units)).toEqual([3, 4, 5]);
    expect(latest.body.nextCursor).toBe(latest.body.events[2].id);

    // Without a limit the default is 50: the two token rows issued by makeTenant come first, then the five steps.
    const defaulted = await poll(t);
    expect(defaulted.body.events.map((e: any) => e.type)).toEqual([
      "auth.token_issued",
      "auth.token_issued",
      "latest.step",
      "latest.step",
      "latest.step",
      "latest.step",
      "latest.step",
    ]);
    expect(defaulted.body.events.slice(2).map((e: any) => e.data.units)).toEqual([1, 2, 3, 4, 5]);
  });

  it("poll limit outside 1 to 200 is a 400", async () => {
    const t = await makeTenant("poll-limit");
    for (const limit of ["0", "201", "abc", "-1", "1.5", "1000"]) {
      const res = await poll(t, `?limit=${limit}`);
      expect(res.status, `limit ${limit}`).toBe(400);
      expect(res.body.code, `limit ${limit}`).toBe("INVALID_LIMIT");
    }
    expect((await poll(t, "?limit=1")).status).toBe(200);
    expect((await poll(t, "?limit=200")).status).toBe(200);
  });

  it("the stream metrics count open streams and sent events", async () => {
    const t = await makeTenant("metrics");
    const scrape = async () => (await send(baseUrl, "/metrics", { token: METRICS_TOKEN })).text;
    const sample = (text: string, selector: string) => {
      for (const line of text.split("\n")) {
        if (line.startsWith(`${selector} `)) return Number(line.slice(selector.length + 1));
      }
      return undefined;
    };

    const before = await scrape();
    const sentBefore = sample(before, "bind_sse_events_sent_total") ?? 0;
    const stream = await openStream(baseUrl, t.id, { token: t.owner.token });
    expect(sample(await scrape(), "bind_sse_streams")).toBe(1);

    for (let units = 1; units <= 3; units += 1) await record(t.id, "metrics.step", { units });
    for (let i = 0; i < 3; i += 1) await stream.sse!.next();
    expect(sample(await scrape(), "bind_sse_events_sent_total")).toBe(sentBefore + 3);

    stream.abort();
    await waitForNoStreams();
    expect(sample(await scrape(), "bind_sse_streams")).toBe(0);
  });

  it("a client that disconnects releases its resources", async () => {
    const t = await makeTenant("disconnect");
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    // One warm-up stream, so the connection pool and the first timers already exist.
    const warm = await openStream(baseUrl, t.id, { token: t.owner.token });
    warm.abort();
    await waitForNoStreams();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const baseline = timers();

    for (let round = 0; round < 3; round += 1) {
      const stream = await openStream(baseUrl, t.id, { token: t.owner.token });
      await record(t.id, "disconnect.step", { units: round });
      await stream.sse!.next();
      expect(countOpenStreams()).toBeGreaterThanOrEqual(1);
      stream.abort();
      await waitForNoStreams();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The streams' heartbeat and poll timers are gone with the streams. Pool timers may come and go, so allow a small margin.
    expect(timers()).toBeLessThanOrEqual(baseline + 2);
    expect(countOpenStreams()).toBe(0);
  });

  it("closeAllEventStreams ends every open stream with a shutdown event", async () => {
    const t = await makeTenant("close-all");
    const stream = await openStream(baseUrl, t.id, { token: t.owner.token });
    expect(stream.status).toBe(200);
    expect(closeAllEventStreams("shutdown")).toBeGreaterThanOrEqual(1);
    const message = await stream.sse!.next();
    expect(message.event).toBe("shutdown");
    expect(message.data).toEqual({});
    await stream.sse!.endedWithin(2000);
  });
});
