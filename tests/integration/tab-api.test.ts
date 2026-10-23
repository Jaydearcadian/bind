import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";

/**
 * The tab routes over HTTP (docs/decisions/0081), against PostgreSQL and the app's own authentication. Charges may be
 * recorded by a staff or an owner token; reading and settling are owner actions. Every route is workspace-scoped: another
 * workspace's token gets the same 404 a missing workspace gets. Amounts are decimal strings of micro-USDC.
 */

const run = Date.now().toString(36);
const WS_A = `ws-tabapi-a-${run}`;
const WS_B = `ws-tabapi-b-${run}`;
const MASTER_SECRET = process.env.BIND_MASTER_SECRET ?? "";
const WEBHOOK_SECRET = process.env.BIND_WEBHOOK_SECRET ?? "";
const SUPPLIER_A = `${WS_A}_supp-sysco-metro`;
const SUPPLIER_B = `${WS_B}_supp-sysco-metro`;
const WORKSPACE_NOT_FOUND = { error: "Workspace not found" };

const app = createApp({
  rateLimits: { enabled: false },
  metrics: { token: null },
  secrets: { masterSecret: MASTER_SECRET, webhookSecret: WEBHOOK_SECRET },
});
let server: Server;
let base = "";
let ownerA: { token: string };
let staffA: { token: string };
let ownerB: { token: string };

async function call(method: string, p: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${base}${p}`, { method, headers, body: payload });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** The answer without its request meta (`_meta` carries the request id and any warnings, which differ per request). */
function withoutMeta(body: any): any {
  const copy = { ...(body ?? {}) };
  delete copy._meta;
  return copy;
}

function charge(counterpartyId: string, amountMicro: unknown, key: string, description = "Dish") {
  return { counterpartyId, amountMicro, idempotencyKey: key, description };
}

describe("tab routes over HTTP (ADR 0081)", () => {
  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(WS_A, "Tab API A", "kitchen-v1", {
      customDailyLimitCents: 10_000_000n,
      customApprovalThresholdCents: 10_000_000n,
    });
    await provisionWorkspace(WS_B, "Tab API B", "kitchen-v1", {
      customDailyLimitCents: 10_000_000n,
      customApprovalThresholdCents: 10_000_000n,
    });
    await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = ANY($1::text[]);`, [
      [WS_A, WS_B],
      `0x${"11".repeat(20)}`,
    ]);
    ownerA = await issueToken(WS_A, "owner", "tab-owner");
    staffA = await issueToken(WS_A, "staff", "tab-staff");
    ownerB = await issueToken(WS_B, "owner", "tab-owner-b");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") base = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[WS_A, WS_B]]);
    for (const id of [WS_A, WS_B]) {
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  it("an owner records a charge (201 with the amount as a string); the same key and data answers 200 and adds nothing", async () => {
    const first = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, "3000", "api-1"));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, entry: { kind: "charge", amountMicro: "3000", counterpartyId: SUPPLIER_A, settlementId: null } });

    const replay = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, "3000", "api-1"));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ created: false, entry: { id: first.body.entry.id } });
    expect((await call("GET", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}`, ownerA.token)).body.balanceMicro).toBe("3000");
  });

  it("the same key with different data answers 409 IDEMPOTENCY_CONFLICT, and changes nothing", async () => {
    const res = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, "4000", "api-1"));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await call("GET", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}`, ownerA.token)).body.balanceMicro).toBe("3000");
  });

  it("a staff token may record a charge, and it is audited with the staff role", async () => {
    const res = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, staffA.token, charge(SUPPLIER_A, "5000", "api-staff"));
    expect(res.status).toBe(201);
    const audit = await query(
      `SELECT actor_type, actor_id FROM audit_logs WHERE workspace_id = $1 AND action = 'tab.charge_accrued' AND evidence->>'idempotencyKey' = 'api-staff';`,
      [WS_A]
    );
    expect(audit.rows).toEqual([{ actor_type: "agent", actor_id: "staff:tab-staff" }]);
  });

  it("amounts that are not a positive whole number of micro-USDC within the limit are 400 INVALID_CHARGE_AMOUNT", async () => {
    const bad: unknown[] = [3000, 1.5, "0", "-1", "1.5", "1e6", " 5", "25000001", "99999999999999999999999"];
    for (const amount of bad) {
      const res = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, amount, `bad-${String(amount)}`));
      expect(res.status, JSON.stringify(amount)).toBe(400);
      expect(res.body.code, JSON.stringify(amount)).toBe("INVALID_CHARGE_AMOUNT");
    }
    const limit = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, "25000000", "api-limit"));
    expect(limit.status).toBe(201);
  });

  it("a missing or malformed field is 400 and records nothing", async () => {
    const before = await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1;`, [WS_A]);
    const missingKey = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, { counterpartyId: SUPPLIER_A, amountMicro: "1000", description: "x" });
    expect(missingKey.status).toBe(400);
    const longDescription = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, "1000", "api-long", "x".repeat(201)));
    expect(longDescription.status).toBe(400);
    expect(longDescription.body.code).toBe("INVALID_CHARGE");
    const badKey = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, "1000", "has space"));
    expect(badKey.status).toBe(400);
    const after = await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1;`, [WS_A]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("an unknown counterparty and another workspace's counterparty answer the same 404", async () => {
    const missing = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge("sup-nope", "1000", "api-missing"));
    const other = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_B, "1000", "api-other"));
    expect(missing.status).toBe(404);
    expect(other.status).toBe(404);
    // The same error text and code; the request id differs per request, so the rest of the body is not compared.
    expect({ error: other.body.error, code: other.body.code }).toEqual({ error: missing.body.error, code: missing.body.code });
    expect(other.body.code).toBe("COUNTERPARTY_NOT_FOUND");
  });

  it("an unverified counterparty is 409 COUNTERPARTY_NOT_VERIFIED", async () => {
    await query(`UPDATE suppliers SET verified = FALSE WHERE id = $1;`, [SUPPLIER_A]);
    try {
      const res = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, "1000", "api-unverified"));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("COUNTERPARTY_NOT_VERIFIED");
    } finally {
      await query(`UPDATE suppliers SET verified = TRUE WHERE id = $1;`, [SUPPLIER_A]);
    }
  });

  it("no token is 401, and another workspace's token on this path is 404 with the missing-workspace body", async () => {
    const none = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, null, charge(SUPPLIER_A, "1000", "api-none"));
    expect(none.status).toBe(401);
    const wrong = await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerB.token, charge(SUPPLIER_A, "1000", "api-wrong"));
    expect(wrong.status).toBe(404);
    expect(wrong.body).toMatchObject(WORKSPACE_NOT_FOUND);
    const reads = await call("GET", `/api/workspaces/${WS_A}/tabs`, ownerB.token);
    expect(reads.status).toBe(404);
    expect(reads.body).toMatchObject(WORKSPACE_NOT_FOUND);
  });

  it("reading a tab list or a tab is owner only: a staff token is 403", async () => {
    const list = await call("GET", `/api/workspaces/${WS_A}/tabs`, staffA.token);
    expect(list.status).toBe(403);
    const one = await call("GET", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}`, staffA.token);
    expect(one.status).toBe(403);
    const settle = await call("POST", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}/settle`, staffA.token);
    expect(settle.status).toBe(403);
  });

  it("the owner reads the tab list with string amounts, and the tab with its entries, and never another workspace's tab", async () => {
    const list = await call("GET", `/api/workspaces/${WS_A}/tabs`, ownerA.token);
    expect(list.status).toBe(200);
    const row = list.body.find((r: any) => r.counterpartyId === SUPPLIER_A);
    // api-1 (3000), api-staff (5000) and the 25 USDC limit charge (25000000): three entries, 25008000 micro-USDC.
    expect(row).toMatchObject({ entryCount: 3, balanceMicro: "25008000", settleableCents: "2500" });
    expect(list.body.every((r: any) => r.counterpartyId.startsWith(WS_A))).toBe(true);

    const tab = await call("GET", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}`, ownerA.token);
    expect(tab.status).toBe(200);
    expect(tab.body.balanceMicro).toBe("25008000");
    expect(tab.body.entries.length).toBe(3);
    expect(tab.body.entries.every((e: any) => typeof e.amountMicro === "string")).toBe(true);

    const cross = await call("GET", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_B}`, ownerA.token);
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe("COUNTERPARTY_NOT_FOUND");
  });

  it("the owner settles the whole cents: a settlement is answered with its status, and the balance keeps the remainder", async () => {
    const res = await call("POST", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}/settle`, ownerA.token);
    expect(res.status).toBe(200);
    // 25008000 micro-USDC is 2500 whole cents and 8000 micro that carry over.
    expect(res.body).toMatchObject({ outcome: "settlement", status: "confirmed", amountCents: "2500" });
    expect(res.body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const tab = await call("GET", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}`, ownerA.token);
    expect(tab.body.balanceMicro).toBe("8000");
    expect(tab.body.settlements[0]).toMatchObject({ status: "confirmed", amountCents: "2500" });
  });

  it("a tab under one cent is answered below_threshold, and a paused workspace is refused with nothing moved", async () => {
    const dust = await call("POST", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}/settle`, ownerA.token);
    expect(withoutMeta(dust.body)).toEqual({ outcome: "below_threshold", balanceMicro: "8000" });

    await query(`UPDATE workspaces SET agents_paused = TRUE WHERE id = $1;`, [WS_A]);
    try {
      await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, "20000", "api-paused"));
      const paused = await call("POST", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}/settle`, ownerA.token);
      expect(paused.status).toBe(200);
      expect(paused.body).toMatchObject({ outcome: "refused", reason: "AGENTS_PAUSED", balanceMicro: "28000" });
    } finally {
      await query(`UPDATE workspaces SET agents_paused = FALSE WHERE id = $1;`, [WS_A]);
    }
  });

  it("a retried settle with the same Idempotency-Key replays its answer and does not settle again", async () => {
    await query(`UPDATE workspaces SET agents_paused = FALSE WHERE id = $1;`, [WS_A]);
    await call("POST", `/api/workspaces/${WS_A}/tabs/charges`, ownerA.token, charge(SUPPLIER_A, "1500000", "api-retry-charge"));
    const headers = { authorization: `Bearer ${ownerA.token}`, "idempotency-key": `settle-${run}` };
    const first = await fetch(`${base}/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}/settle`, { method: "POST", headers });
    const firstBody = await first.json();
    const retry = await fetch(`${base}/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}/settle`, { method: "POST", headers });
    const retryBody = await retry.json();

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(withoutMeta(retryBody)).toEqual(withoutMeta(firstBody));
    // The tab held 8000 + 20000 + 1500000 micro-USDC: 152 whole cents settle, and 8000 micro carries over.
    expect(firstBody).toMatchObject({ outcome: "settlement", status: "confirmed", amountCents: "152" });
    const rows = await query(`SELECT COUNT(*)::int AS n FROM tab_settlements WHERE workspace_id = $1 AND status = 'confirmed' AND amount_cents = 152;`, [WS_A]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("a settle of another workspace's counterparty is 404 for the owner of this one", async () => {
    const res = await call("POST", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_B}/settle`, ownerA.token);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("COUNTERPARTY_NOT_FOUND");
    const wrongToken = await call("POST", `/api/workspaces/${WS_A}/tabs/${SUPPLIER_A}/settle`, ownerB.token);
    expect(wrongToken.status).toBe(404);
    expect(wrongToken.body).toMatchObject(WORKSPACE_NOT_FOUND);
  });
});
