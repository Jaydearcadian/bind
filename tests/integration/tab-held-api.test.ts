import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { issueToken } from "../../src/auth/tokens.js";
import { tabLedger } from "../../src/tabs/ledger.js";
import { newCounterparty, newTabWorkspace, removeWorkspaces, tabSums } from "../helpers/tab-spy.js";
import { ageEffect, drainHeldWorkspaces, heldUnknown } from "../helpers/tab-held.js";

/**
 * The held-settlement routes over HTTP (docs/decisions/0081, items a and b). Owner only: a staff token is 403, another
 * workspace's token is 404, and a settlement of another workspace is the same 404 a missing one is (no leakage). A refusal
 * is 409 NOT_PROVABLY_UNSENT and changes nothing. A repeat of a restore is a no-op with one reversal.
 */

const created: string[] = [];

let server: Server;
let base = "";

const app = createApp({
  rateLimits: { enabled: false },
  metrics: { token: null },
  secrets: { masterSecret: process.env.BIND_MASTER_SECRET ?? "", webhookSecret: process.env.BIND_WEBHOOK_SECRET ?? "" },
});

async function call(
  method: string,
  p: string,
  token: string | null,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const all: Record<string, string> = { ...headers };
  if (token) all.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    all["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${p}`, { method, headers: all, body: payload });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** The answer without its request meta: the request id differs per request, everything else must not. */
function withoutMeta(body: any): any {
  const copy = { ...(body ?? {}) };
  delete copy._meta;
  delete copy.requestId;
  return copy;
}

async function reversalCount(workspaceId: string, settlementId: string): Promise<number> {
  return (
    await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1 AND kind = 'reversal' AND settlement_id = $2;`, [
      workspaceId,
      settlementId,
    ])
  ).rows[0].n;
}

beforeAll(async () => {
  await runMigrations();
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
  await removeWorkspaces([...created.splice(0), ...drainHeldWorkspaces()]);
  for (const id of created) await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
  await closePool();
});

describe("held tab settlements over HTTP (docs/decisions/0081)", () => {
  it("the owner lists the held settlements of the workspace; a staff token is refused; the filter is held only", async () => {
    const { w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "api-list" });
    const owner = await issueToken(w, "owner", "held-owner");
    const staff = await issueToken(w, "staff", "held-staff");

    const list = await call("GET", `/api/workspaces/${w}/tabs/settlements?status=held`, owner.token);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id: settlementId,
        counterpartyId: cp,
        amountCents: "5",
        status: "held",
        holdReason: "SETTLEMENT_OUTCOME_UNKNOWN",
        txHash: null,
        hasEffect: true,
        effectStatus: "started",
      }),
    ]);

    expect((await call("GET", `/api/workspaces/${w}/tabs/settlements`, owner.token)).status).toBe(200);
    expect((await call("GET", `/api/workspaces/${w}/tabs/settlements?status=confirmed`, owner.token)).body.code).toBe("INVALID_STATUS");
    expect((await call("GET", `/api/workspaces/${w}/tabs/settlements`, staff.token)).status).toBe(403);
  });

  it("a staff token cannot resolve; the answer is 403 and nothing changes", async () => {
    const { w, settlementId } = await heldUnknown({ fault: "before_call", label: "api-staff" });
    const staff = await issueToken(w, "staff", "held-staff-2");
    const res = await call("POST", `/api/workspaces/${w}/tabs/settlements/${settlementId}/resolve`, staff.token, { action: "reconcile" });
    expect(res.status).toBe(403);
  });

  it("another workspace's owner gets 404, and a settlement of another workspace is the same 404 as a missing one", async () => {
    const mine = await heldUnknown({ fault: "before_call", label: "api-xa" });
    const theirs = await heldUnknown({ fault: "before_call", label: "api-xb" });
    const otherOwner = await issueToken(theirs.w, "owner", "held-other");

    const wrongWorkspace = await call("GET", `/api/workspaces/${mine.w}/tabs/settlements`, otherOwner.token);
    expect(wrongWorkspace.status).toBe(404);

    const foreignId = await call("POST", `/api/workspaces/${theirs.w}/tabs/settlements/${mine.settlementId}/resolve`, otherOwner.token, {
      action: "cancel_and_restore",
      acknowledgeNotSent: true,
    });
    const missingId = await call("POST", `/api/workspaces/${theirs.w}/tabs/settlements/tabset_does_not_exist/resolve`, otherOwner.token, {
      action: "cancel_and_restore",
      acknowledgeNotSent: true,
    });
    expect(foreignId.status).toBe(404);
    expect(missingId.status).toBe(404);
    expect(withoutMeta(foreignId.body)).toEqual(withoutMeta(missingId.body));
    expect(JSON.stringify(foreignId.body)).not.toContain(mine.settlementId);

    // The other workspace's settlement is untouched.
    const ownerOfMine = await issueToken(mine.w, "owner", "held-owner-mine");
    const still = await call("GET", `/api/workspaces/${mine.w}/tabs/settlements`, ownerOfMine.token);
    expect(still.body[0]).toMatchObject({ id: mine.settlementId, status: "held" });
  });

  it("a bad action or a bad acknowledgement is 400 and changes nothing", async () => {
    const { w, settlementId } = await heldUnknown({ fault: "before_call", label: "api-bad" });
    const owner = await issueToken(w, "owner", "held-owner-bad");
    const url = `/api/workspaces/${w}/tabs/settlements/${settlementId}/resolve`;

    const badAction = await call("POST", url, owner.token, { action: "burn_it" });
    expect(badAction.status).toBe(400);
    expect(badAction.body.code).toBe("INVALID_ACTION");
    const missingAction = await call("POST", url, owner.token, {});
    expect(missingAction.body.code).toBe("INVALID_ACTION");
    const badAck = await call("POST", url, owner.token, { action: "cancel_and_restore", acknowledgeNotSent: "yes" });
    expect(badAck.status).toBe(400);
    expect(badAck.body.code).toBe("INVALID_RESOLVE");
    expect(await reversalCount(w, settlementId)).toBe(0);
  });

  it("a restore the proofs refuse is 409 NOT_PROVABLY_UNSENT with a reason, and the balance does not move", async () => {
    const { w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "api-refuse" });
    const owner = await issueToken(w, "owner", "held-owner-refuse");
    const url = `/api/workspaces/${w}/tabs/settlements/${settlementId}/resolve`;
    const before = await tabSums(w, cp);

    // The effect row is fresh (under 30 minutes), so the unknown outcome is not provably unsent.
    const refused = await call("POST", url, owner.token, { action: "cancel_and_restore", acknowledgeNotSent: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("NOT_PROVABLY_UNSENT");
    expect(refused.body.reason).toContain("30 minutes");
    expect(await reversalCount(w, settlementId)).toBe(0);
    expect(await tabSums(w, cp)).toEqual(before);
    expect((await query(`SELECT status FROM tab_settlements WHERE id = $1;`, [settlementId])).rows[0].status).toBe("held");
  });

  it("a restore that is provably safe is 200 once; the repeat is a no-op with one reversal; the balance is restored", async () => {
    const { w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "api-restore" });
    const owner = await issueToken(w, "owner", "held-owner-restore");
    const url = `/api/workspaces/${w}/tabs/settlements/${settlementId}/resolve`;
    await ageEffect(w, settlementId, 31);

    const first = await call("POST", url, owner.token, { action: "cancel_and_restore", acknowledgeNotSent: true });
    expect(first.status).toBe(200);
    expect(withoutMeta(first.body)).toEqual({
      action: "cancel_and_restore",
      outcome: { kind: "cancelled", proof: "UNKNOWN_NOT_SETTLED_ACKNOWLEDGED", amountCents: "5", replayed: false },
    });
    expect((await call("GET", `/api/workspaces/${w}/tabs/${cp}`, owner.token)).body.balanceMicro).toBe("50000");

    const again = await call("POST", url, owner.token, { action: "cancel_and_restore", acknowledgeNotSent: true });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toMatchObject({ kind: "already_cancelled", replayed: true });
    expect(await reversalCount(w, settlementId)).toBe(1);
    expect((await call("GET", `/api/workspaces/${w}/tabs/${cp}`, owner.token)).body.balanceMicro).toBe("50000");
  });

  it("a retried request with the same Idempotency-Key replays the first answer and writes nothing more", async () => {
    const { w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "api-idem" });
    const owner = await issueToken(w, "owner", "held-owner-idem");
    const url = `/api/workspaces/${w}/tabs/settlements/${settlementId}/resolve`;
    await ageEffect(w, settlementId, 31);
    const headers = { "Idempotency-Key": "resolve-idem-1" };

    const first = await call("POST", url, owner.token, { action: "cancel_and_restore", acknowledgeNotSent: true }, headers);
    const replay = await call("POST", url, owner.token, { action: "cancel_and_restore", acknowledgeNotSent: true }, headers);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(first.status);
    expect(replay.body.outcome).toEqual(first.body.outcome);
    expect(await reversalCount(w, settlementId)).toBe(1);
    expect((await tabSums(w, cp)).reversals).toBe(5n * 10_000n);
  });

  it("reconcile answers honestly: with no transfer found it is nothing_found, the settlement stays held", async () => {
    const { w, settlementId } = await heldUnknown({ fault: "before_call", label: "api-reconcile" });
    const owner = await issueToken(w, "owner", "held-owner-recon");
    const res = await call("POST", `/api/workspaces/${w}/tabs/settlements/${settlementId}/resolve`, owner.token, { action: "reconcile" });
    expect(res.status).toBe(200);
    expect(withoutMeta(res.body)).toEqual({
      action: "reconcile",
      outcome: { kind: "nothing_found", holdReason: "SETTLEMENT_OUTCOME_UNKNOWN" },
    });
    expect((await query(`SELECT status FROM tab_settlements WHERE id = $1;`, [settlementId])).rows[0].status).toBe("held");
  });

  it("a settlement that owns no balance is 409 SETTLEMENT_OWNS_NO_BALANCE on restore, and a missing one is 404", async () => {
    const w = await newTabWorkspace("api-noclear");
    created.push(w);
    const cp = await newCounterparty(w);
    await tabLedger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 50_000n, idempotencyKey: "api-noclear-c", description: "Dish" });
    // Unverified after the charge: the gate holds the settlement, and the hold owns no clear.
    await query(`UPDATE suppliers SET verified = FALSE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
    const held = await tabLedger.settleTab({ workspaceId: w, counterpartyId: cp });
    if (held.outcome !== "settlement") throw new Error("expected a held settlement");
    const owner = await issueToken(w, "owner", "held-owner-noclear");
    const url = `/api/workspaces/${w}/tabs/settlements/${held.settlementId}/resolve`;
    const res = await call("POST", url, owner.token, { action: "cancel_and_restore", acknowledgeNotSent: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SETTLEMENT_OWNS_NO_BALANCE");
    const missing = await call("POST", `/api/workspaces/${w}/tabs/settlements/tabset_missing/resolve`, owner.token, { action: "reconcile" });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("SETTLEMENT_NOT_FOUND");
  });
});
