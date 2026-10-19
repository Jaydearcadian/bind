import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { query, closePool, pool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { config } from "../../src/config/env.js";
import { EffectClass } from "../../src/policy/effect-classifier.js";
import {
  runEffect,
  listUnresolvedEffects,
  EffectConflictError,
  EffectInDoubtError,
  type EffectSpec,
} from "../../src/effects/ledger.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { decodeResult, requestHash } from "../../src/effects/serialize.js";

const run = Date.now();
const wsA = `ws-effects-a-${run}`;
const wsB = `ws-effects-b-${run}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every idempotency key in this file ends with the run id, so reruns never collide. */
function keyFor(name: string): string {
  return `idem_effects_${name}_${run}`;
}

function specFor(name: string, overrides: Partial<EffectSpec> = {}): EffectSpec {
  return {
    workspaceId: wsA,
    workflowId: `wf_effects_${run}`,
    effectClass: EffectClass.COMMERCIAL_COMMITMENT,
    operation: "orders.submit",
    idempotencyKey: keyFor(name),
    request: { quoteId: `quote_${name}`, quantity: 10, totalPriceCents: 24500n },
    ...overrides,
  };
}

async function rowFor(key: string): Promise<any> {
  const res = await query(`SELECT *, result::text AS result_text FROM effects WHERE idempotency_key = $1;`, [key]);
  return res.rows[0];
}

describe("effects ledger (PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
    await query(`INSERT INTO workspaces (id, name, template_id) VALUES ($1, $2, 'kitchen-v1'), ($3, $4, 'kitchen-v1');`, [
      wsA,
      "Effects Ledger A",
      wsB,
      "Effects Ledger B",
    ]);
  });

  afterEach(() => {
    setEffectFault(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[wsA, wsB]]);
    await closePool();
  });

  it("a fresh key runs fn once and stores the result", async () => {
    const fn = vi.fn(async () => ({ orderId: "po-fresh", totalCents: 24500n }));

    const out = await runEffect(specFor("fresh"), fn, { externalRef: (r) => r.orderId });

    expect(out.replayed).toBe(false);
    expect(out.result).toEqual({ orderId: "po-fresh", totalCents: 24500n });
    expect(fn).toHaveBeenCalledTimes(1);

    const row = await rowFor(keyFor("fresh"));
    expect(row.status).toBe("completed");
    expect(row.external_ref).toBe("po-fresh");
    expect(row.attempts).toBe(1);
    expect(decodeResult(row.result_text)).toEqual({ orderId: "po-fresh", totalCents: 24500n });
  });

  it("the same key returns the stored result without calling fn", async () => {
    const fn = vi.fn(async () => ({ totalCents: 24500n }));

    const first = await runEffect(specFor("replay"), fn);
    const second = await runEffect(specFor("replay"), fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(typeof second.result.totalCents).toBe("bigint");
    expect(second.result.totalCents).toBe(24500n);
  });

  it("the same key with a different request is refused", async () => {
    const fn = vi.fn(async () => "ok");
    await runEffect(specFor("conflict"), fn);

    const different = specFor("conflict", {
      request: { quoteId: "quote_other", quantity: 10, totalPriceCents: 24500n },
    });
    await expect(runEffect(different, fn)).rejects.toBeInstanceOf(EffectConflictError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a key owned by another workspace is refused without revealing it", async () => {
    const fn = vi.fn(async () => "ok");
    await runEffect(specFor("tenant"), fn);

    // The same request, presented from another workspace.
    const crossTenant = runEffect(specFor("tenant", { workspaceId: wsB }), fn);
    await expect(crossTenant).rejects.toBeInstanceOf(EffectConflictError);
    const err = (await crossTenant.then(
      () => new Error("expected a refusal"),
      (e: unknown) => e as Error
    )) as Error;

    expect(err.message).not.toContain(wsA);
    expect(err.message).not.toContain(wsB);
    expect(err.message).not.toMatch(/eff_/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a thrown error is stored as failed with a redacted message and rethrown", async () => {
    const secret = config.SESSION_SECRET;
    expect(secret.length).toBeGreaterThan(8);
    const original = new Error(`upstream rejected ${secret} via https://rpc.example.test/v1/TOKEN-XYZ-123`);
    const fn = vi.fn(async () => {
      throw original;
    });

    await expect(runEffect(specFor("thrown"), fn)).rejects.toBe(original);

    const row = await rowFor(keyFor("thrown"));
    expect(row.status).toBe("failed");
    expect(row.error_message).toContain("[redacted]");
    expect(row.error_message).toContain("[redacted-url]");
    expect(row.error_message).not.toContain(secret);
    expect(row.error_message).not.toContain("TOKEN-XYZ-123");
    expect(row.error_message.length).toBeLessThanOrEqual(500);
  });

  it("a started effect left by a crash is reported in doubt, never repeated", async () => {
    const fn = vi.fn(async () => ({ orderId: "po-crash" }));
    setEffectFault({ point: "after_call_before_complete", match: (s) => s.idempotencyKey === keyFor("crash") });

    await expect(runEffect(specFor("crash"), fn)).rejects.toThrow("injected fault");
    expect(fn).toHaveBeenCalledTimes(1);
    expect((await rowFor(keyFor("crash"))).status).toBe("started");

    const retry = runEffect(specFor("crash"), fn);
    await expect(retry).rejects.toBeInstanceOf(EffectInDoubtError);
    await expect(retry).rejects.toMatchObject({ status: "started", attempts: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a failed non-dedupe effect is reported in doubt on retry", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return "ok";
    });

    await expect(runEffect(specFor("failed-doubt"), fn)).rejects.toThrow("timeout");

    const retry = runEffect(specFor("failed-doubt"), fn);
    await expect(retry).rejects.toBeInstanceOf(EffectInDoubtError);
    await expect(retry).rejects.toMatchObject({ status: "failed", attempts: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("an externalDedupes effect is retried after a failure and attempts increases", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return { ok: true };
    });
    const spec = specFor("dedupe", { externalDedupes: true });

    await expect(runEffect(spec, fn)).rejects.toThrow("timeout");
    const out = await runEffect(spec, fn);

    expect(out).toEqual({ result: { ok: true }, replayed: false });
    expect(fn).toHaveBeenCalledTimes(2);
    const row = await rowFor(keyFor("dedupe"));
    expect(row.status).toBe("completed");
    expect(row.attempts).toBe(2);
  });

  it("reconcile found adopts the external result without calling fn", async () => {
    const fnFirst = vi.fn(async () => ({ orderId: "po-real-1" }));
    setEffectFault({ point: "after_call_before_complete", match: (s) => s.idempotencyKey === keyFor("adopt") });
    await expect(runEffect(specFor("adopt"), fnFirst)).rejects.toThrow("injected fault");

    const fn = vi.fn(async () => ({ orderId: "po-should-not-run" }));
    const reconcile = vi.fn(async () => ({ found: true as const, result: { orderId: "po-real-1" }, externalRef: "po-real-1" }));

    const out = await runEffect(specFor("adopt"), fn, { reconcile });

    expect(out).toEqual({ result: { orderId: "po-real-1" }, replayed: true });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
    const row = await rowFor(keyFor("adopt"));
    expect(row.status).toBe("completed");
    expect(row.external_ref).toBe("po-real-1");
  });

  it("reconcile not found retries exactly once", async () => {
    const fnFirst = vi.fn(async () => ({ orderId: "po-lost" }));
    setEffectFault({ point: "after_call_before_complete", match: (s) => s.idempotencyKey === keyFor("retry-once") });
    await expect(runEffect(specFor("retry-once"), fnFirst)).rejects.toThrow("injected fault");

    const fn = vi.fn(async () => ({ orderId: "po-retried" }));
    const reconcile = vi.fn(async () => ({ found: false as const }));

    const out = await runEffect(specFor("retry-once"), fn, { reconcile });
    expect(out).toEqual({ result: { orderId: "po-retried" }, replayed: false });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect((await rowFor(keyFor("retry-once"))).attempts).toBe(2);

    // A later call replays the completed result: no reconcile, no second fn call.
    const again = await runEffect(specFor("retry-once"), fn, { reconcile });
    expect(again).toEqual({ result: { orderId: "po-retried" }, replayed: true });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("thirty concurrent callers on one key run fn once", async () => {
    const fn = vi.fn(async () => {
      await sleep(25);
      return { orderId: "po-race" };
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 30 }, () => runEffect(specFor("race"), fn))
    );

    expect(fn).toHaveBeenCalledTimes(1);
    const fulfilled = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<{ replayed: boolean }>[];
    const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    for (const r of rejected) expect(r.reason).toBeInstanceOf(EffectInDoubtError);
    expect(fulfilled.filter((f) => f.value.replayed === false)).toHaveLength(1);
    // Callers that arrive while the first call is in flight wait for it, then replay its result.
    expect(fulfilled).toHaveLength(30);
  });

  it("a recovery call waits for an in-flight call instead of reconciling it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    const owner = runEffect(specFor("inflight"), async () => {
      signalStarted();
      await gate;
      return { orderId: "po-inflight" };
    });
    await started;

    const reconcile = vi.fn(async () => ({ found: false as const }));
    const neverRun = vi.fn(async () => "must not run");
    const recovery = runEffect(specFor("inflight"), neverRun, { reconcile });

    await sleep(50);
    expect(reconcile).not.toHaveBeenCalled();

    release();
    const [ownerOut, recoveryOut] = await Promise.all([owner, recovery]);
    expect(ownerOut.replayed).toBe(false);
    expect(recoveryOut).toEqual({ result: { orderId: "po-inflight" }, replayed: true });
    expect(reconcile).not.toHaveBeenCalled();
    expect(neverRun).not.toHaveBeenCalled();
  });

  it("a completed-mark failure leaves the effect in doubt", async () => {
    const original = (pool as any).query.bind(pool);
    const spy = vi.spyOn(pool as any, "query").mockImplementation((text: any, params: any) => {
      if (typeof text === "string" && text.includes("SET status = 'completed'")) {
        return Promise.reject(new Error("simulated write failure"));
      }
      return original(text, params);
    });
    const fn = vi.fn(async () => ({ orderId: "po-mark" }));

    try {
      await expect(runEffect(specFor("mark-fail"), fn)).rejects.toThrow("simulated write failure");
    } finally {
      spy.mockRestore();
    }

    expect(fn).toHaveBeenCalledTimes(1);
    expect((await rowFor(keyFor("mark-fail"))).status).toBe("started");

    await expect(runEffect(specFor("mark-fail"), fn)).rejects.toBeInstanceOf(EffectInDoubtError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a result that cannot be encoded leaves the effect in doubt", async () => {
    const fn = vi.fn(async () => ({ render: () => "not data" }));

    await expect(runEffect(specFor("unencodable"), fn)).rejects.toThrow(TypeError);
    expect((await rowFor(keyFor("unencodable"))).status).toBe("started");

    await expect(runEffect(specFor("unencodable"), fn)).rejects.toBeInstanceOf(EffectInDoubtError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fault injection cannot be armed outside the test environment", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => setEffectFault({ point: "before_call", match: () => true })).toThrow();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }

    // The refused arm did not take effect: the call runs normally.
    const fn = vi.fn(async () => "ok");
    await expect(runEffect(specFor("never-armed"), fn)).resolves.toEqual({ result: "ok", replayed: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("unresolved effects are listed oldest first", async () => {
    await expect(
      runEffect(specFor("unres-a"), async () => {
        throw new Error("upstream down");
      })
    ).rejects.toThrow("upstream down");
    await sleep(5);

    await runEffect(specFor("unres-done"), async () => "ok");
    await sleep(5);

    setEffectFault({ point: "after_call_before_complete", match: (s) => s.idempotencyKey === keyFor("unres-b") });
    await expect(runEffect(specFor("unres-b"), async () => "ok")).rejects.toThrow("injected fault");
    await sleep(5);

    await expect(
      runEffect(specFor("unres-c", { workspaceId: wsB }), async () => {
        throw new Error("other tenant down");
      })
    ).rejects.toThrow("other tenant down");

    const listedA = (await listUnresolvedEffects(wsA)).filter((r) => r.idempotencyKey.startsWith("idem_effects_unres-"));
    expect(listedA.map((r) => r.idempotencyKey)).toEqual([keyFor("unres-a"), keyFor("unres-b")]);
    expect(listedA.map((r) => r.status)).toEqual(["failed", "started"]);
    expect(listedA.every((r) => r.workspaceId === wsA)).toBe(true);

    const listedB = (await listUnresolvedEffects(wsB)).filter((r) => r.idempotencyKey.startsWith("idem_effects_unres-"));
    expect(listedB.map((r) => r.idempotencyKey)).toEqual([keyFor("unres-c")]);
  });

  it("request is never stored, only its hash", async () => {
    const marker = `MARKER-REQUEST-${run}`;
    const request = { note: marker, quantity: 3 };

    await runEffect(specFor("no-request", { request }), async () => "ok");

    const row = await rowFor(keyFor("no-request"));
    expect(JSON.stringify(row)).not.toContain(marker);
    expect(row.request_hash).toBe(requestHash(request));
    expect(row.request_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
