import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { custom, getAddress, type AbiEvent, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/server/app.js";
import { issueToken } from "../../src/auth/tokens.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { SettlementOrderError } from "../../src/workflows/settlement.js";
import { createReplenishmentTools } from "../../src/agents/replenishmentTools.js";
import { generateVerifiableDecisionRecord } from "../../src/agents/bindTemplateAgent.js";
import { MatchStatus } from "../../src/accounting/three-way-match.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { ArcL1SettlementAdapter } from "../../src/adapters/settlement/arc-l1.js";
import { SettlementTransportError } from "../../src/adapters/settlement/errors.js";
import type {
  SettlementAdapter,
  SettlementStatus,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";
import { createLocalChain, type LocalChain } from "../helpers/local-chain.js";
import { deployBindSettlement } from "../helpers/bind-settlement.js";

/**
 * Settlement confirmation: an order is paid only after the adapter confirms the transfer. A
 * `submitted` transfer leaves the order `settlement_submitted` until `confirmSettlement` runs.
 *
 * The Arc tests run the real ArcL1SettlementAdapter against the in-process BindSettlement contract.
 * The keys below are local test keys. They hold nothing outside the in-process chain of each test.
 */
const SIGNER_KEY: Hex = `0x${"11".repeat(32)}`;
const SUPPLIER_KEY: Hex = `0x${"22".repeat(32)}`;
const SIGNER = privateKeyToAccount(SIGNER_KEY).address;
const SUPPLIER = getAddress(privateKeyToAccount(SUPPLIER_KEY).address);
const CHAIN_ID = 31337;
const ONE_USDC_WEI = 10n ** 18n;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const FLOUR = "FOOD-FLOUR-50LB";
const MILK = "FOOD-MILK-CASE";
const AWAITING = "AWAITING_SETTLEMENT_CONFIRMATION";

/** Records every transfer and confirm call. Each outcome is scripted per test. */
class ScriptedSettlementAdapter implements SettlementAdapter {
  transferStatus: SettlementStatus = "submitted";
  confirmStatus: SettlementStatus = "confirmed";
  confirmFailureCode: string | undefined;
  confirmDelayMs = 0;
  transferCalls = 0;
  confirmCalls = 0;
  readonly requests: TransferRequest[] = [];

  constructor(readonly mode: "local" | "arc-testnet" = "local") {}

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transferCalls += 1;
    this.requests.push(req);
    const txHash = `0x${crypto.createHash("sha256").update(req.idempotencyKey).digest("hex")}`;
    return this.result(txHash, this.transferStatus);
  }

  async confirm(txHash: string): Promise<TransferResult> {
    this.confirmCalls += 1;
    if (this.confirmDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.confirmDelayMs));
    }
    return this.result(txHash, this.confirmStatus, this.confirmFailureCode);
  }

  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  private result(txHash: string, status: SettlementStatus, failureCode?: string): TransferResult {
    return {
      txHash,
      status,
      timestamp: new Date(),
      mode: this.mode,
      simulated: true,
      ...(failureCode ? { failureCode } : {}),
    };
  }
}

/** Real Arc transfer, but confirm() throws, as a transport failure during the receipt lookup would. */
class ConfirmThrowsAdapter implements SettlementAdapter {
  readonly mode = "arc-testnet" as const;
  transferCalls = 0;

  constructor(private readonly inner: ArcL1SettlementAdapter) {}

  getBalance(address: string): Promise<bigint> {
    return this.inner.getBalance(address);
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transferCalls += 1;
    return this.inner.transferUSDC(req);
  }

  async confirm(): Promise<TransferResult> {
    throw new SettlementTransportError("receipt lookup", "rpc unreachable");
  }

  depositEscrow(req: TransferRequest, milestoneId: string): Promise<TransferResult> {
    return this.inner.depositEscrow(req, milestoneId);
  }

  releaseEscrow(milestoneId: string, toAddress: string): Promise<TransferResult> {
    return this.inner.releaseEscrow(milestoneId, toAddress);
  }
}

interface ArcEnv {
  chain: LocalChain;
  deployed: Awaited<ReturnType<typeof deployBindSettlement>>;
  adapter: ArcL1SettlementAdapter;
}

function transportFor(chain: LocalChain): Transport {
  return custom({ request: chain.request as any });
}

/** Every RPC works except eth_getTransactionReceipt, so a send succeeds but confirm() cannot see the outcome. */
function receiptLookupDown(chain: LocalChain): Transport {
  return custom({
    request: (args: { method: string; params?: unknown[] }) =>
      args.method === "eth_getTransactionReceipt"
        ? Promise.reject(new Error("rpc down"))
        : chain.request(args),
  } as any);
}

function arcAdapter(chain: LocalChain, contractAddress: `0x${string}`, transport?: Transport): ArcL1SettlementAdapter {
  return new ArcL1SettlementAdapter({
    chainId: CHAIN_ID,
    contractAddress,
    signerPrivateKey: SIGNER_KEY,
    transport: transport ?? transportFor(chain),
    confirmWaitMs: 0,
  });
}

async function arcEnv(): Promise<ArcEnv> {
  const chain = await createLocalChain({ chainId: CHAIN_ID, balances: { [SIGNER]: 1000n * ONE_USDC_WEI } });
  const deployed = await deployBindSettlement(chain, SIGNER_KEY);
  return { chain, deployed, adapter: arcAdapter(chain, deployed.address) };
}

async function ownerWrite(env: ArcEnv, functionName: string, args: readonly unknown[]): Promise<void> {
  const hash = await env.deployed.walletClient.writeContract({
    address: env.deployed.address,
    abi: env.deployed.abi,
    functionName: functionName as never,
    args: args as never,
    gas: 300_000n,
  });
  const receipt = await env.deployed.publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
}

function settlementLogs(env: ArcEnv) {
  const event = env.deployed.abi.find((item) => item.type === "event" && item.name === "SettlementExecuted") as AbiEvent;
  return env.deployed.publicClient.getLogs({ address: env.deployed.address, event, fromBlock: 0n });
}

async function supplierBalance(env: ArcEnv): Promise<bigint> {
  return env.deployed.publicClient.getBalance({ address: SUPPLIER });
}

describe("Settlement waits for confirmation before an order is paid", () => {
  const wsIds: string[] = [];
  let artifactsDir = "";
  let previousArtifactsDir: string | undefined;

  beforeAll(async () => {
    await runMigrations();
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-settle-confirm-"));
    previousArtifactsDir = process.env.WORKFLOW_ARTIFACTS_DIR;
    process.env.WORKFLOW_ARTIFACTS_DIR = artifactsDir;
  });

  afterEach(async () => {
    for (const id of wsIds.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    if (previousArtifactsDir === undefined) delete process.env.WORKFLOW_ARTIFACTS_DIR;
    else process.env.WORKFLOW_ARTIFACTS_DIR = previousArtifactsDir;
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    await closePool();
  });

  async function newWorkspace(dailyLimitCents = 100000n): Promise<string> {
    const wsId = `ws-settle-conf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Settlement Confirmation Kitchen", "kitchen-v1", {
      customDailyLimitCents: dailyLimitCents,
      customApprovalThresholdCents: 25000n,
    });
    return wsId;
  }

  /**
   * An arc-testnet replenishment needs a live agent key, so every order is started on a local workspace.
   * The workspace is then switched to Arc settlement with the signer as its payer; settlement reads the
   * payer and the mode from the workspace row when it pays.
   */
  async function settleOnArc(wsId: string): Promise<void> {
    await query(`UPDATE workspaces SET settlement_mode = 'arc-testnet', settlement_address = $2 WHERE id = $1;`, [
      wsId,
      SIGNER,
    ]);
  }

  /** Starts a replenishment for `sku` and makes its supplier verified and payable at `payee`. */
  async function confirmedOrder(
    runner: ProcurementWorkflowRunner,
    wsId: string,
    sku: string,
    payee?: string
  ): Promise<{ workflowId: string; orderId: string; supplierId: string }> {
    const started = await runner.startReplenishment(wsId, sku);
    expect(started.state).toBe(WorkflowState.CONFIRMED);
    const orderId = started.orderId!;
    const supplierId = (await orderRow(orderId)).supplier_id as string;
    if (payee) {
      await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [supplierId, payee]);
    }
    return { workflowId: started.workflowId, orderId, supplierId };
  }

  async function orderRow(orderId: string): Promise<any> {
    return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
  }

  async function stockOf(wsId: string, sku: string): Promise<number> {
    const res = await query(
      `SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`,
      [wsId, sku]
    );
    return Number(res.rows[0].current_quantity);
  }

  async function auditRows(wsId: string, action: string): Promise<any[]> {
    const res = await query(
      `SELECT actor_type, actor_id, policy_decision, evidence FROM audit_logs
       WHERE workspace_id = $1 AND action = $2 ORDER BY created_at ASC;`,
      [wsId, action]
    );
    return res.rows;
  }

  /** The decision record is written by the policy tool; the settlement path reads it from the workflow. */
  async function attachDecisionRecord(workflowId: string): Promise<void> {
    const record = await generateVerifiableDecisionRecord({
      workflowId,
      templateId: "kitchen-ops",
      skuName: "Flour",
      quantityRequested: 1,
      candidateQuotes: [
        {
          vendorId: "v_settle_conf",
          vendorName: "Settlement Test Supplier",
          vendorWallet: SUPPLIER,
          unitPriceUsdc: "245.0000",
          totalPriceUsdc: "245.0000",
          leadTimeDays: 2,
          isWhitelistedOnChain: true,
        },
      ],
      dailyLimitUsdc: "1000.00",
    });
    await query(`UPDATE workflows SET context_data = context_data || $2::jsonb WHERE id = $1;`, [
      workflowId,
      JSON.stringify({ decisionRecord: record }),
    ]);
  }

  function anchorOf(workflowId: string): string {
    return fs.readFileSync(path.join(artifactsDir, workflowId, "STATE_ANCHOR.md"), "utf8");
  }

  it("a confirmed settlement reconciles the order, restocks once and pays the supplier on chain", async () => {
    const env = await arcEnv();
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => env.adapter });
    const wsId = await newWorkspace();
    const { workflowId, orderId } = await confirmedOrder(runner, wsId, FLOUR, SUPPLIER);
    await settleOnArc(wsId);
    await attachDecisionRecord(workflowId);
    const stockBefore = await stockOf(wsId, FLOUR);
    const order = await orderRow(orderId);
    const expectedWei = BigInt(order.total_price_cents) * 10n ** 16n;

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true });
    expect(result.txHash).toMatch(HASH_RE);
    expect(result.alreadyReconciled).toBeUndefined();
    expect(result.pending).toBeUndefined();

    // The payment is on chain: one settlement, to the supplier, for the order total.
    const logs = await settlementLogs(env);
    expect(logs).toHaveLength(1);
    expect(logs[0].transactionHash).toBe(result.txHash);
    expect(await supplierBalance(env)).toBe(expectedWei);

    const row = await orderRow(orderId);
    expect(row.status).toBe("reconciled");
    expect(row.tx_hash).toBe(result.txHash);
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore + Number(order.quantity));
    const journal = await query(`SELECT * FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0].tx_hash).toBe(result.txHash);

    // A confirmed on-chain settlement is labelled as Arc testnet settlement.
    expect(anchorOf(workflowId)).toContain("`SETTLED_ON_ARC_TESTNET`");

    const again = await runner.fulfillAndReconcile(orderId, wsId);
    expect(again).toMatchObject({ reconciled: true, alreadyReconciled: true, txHash: result.txHash });
    expect(await settlementLogs(env)).toHaveLength(1);
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore + Number(order.quantity));
  });

  it("a submitted but unconfirmed settlement leaves the order settlement_submitted with its hash, no restock and no journal entry", async () => {
    const env = await arcEnv();
    const unsure = arcAdapter(env.chain, env.deployed.address, receiptLookupDown(env.chain));
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => unsure });
    const wsId = await newWorkspace();
    const { workflowId, orderId } = await confirmedOrder(runner, wsId, FLOUR, SUPPLIER);
    await settleOnArc(wsId);
    const stockBefore = await stockOf(wsId, FLOUR);

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toEqual({
      status: MatchStatus.MATCHED,
      reconciled: false,
      txHash: expect.stringMatching(HASH_RE),
      pending: AWAITING,
    });

    const row = await orderRow(orderId);
    expect(row.status).toBe("settlement_submitted");
    expect(row.tx_hash).toBe(result.txHash);
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore);
    const journal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows.length).toBe(0);

    // The transfer was sent, so the send is recorded, and the workflow is still waiting.
    expect(await settlementLogs(env)).toHaveLength(1);
    const submittedAudit = await auditRows(wsId, "settlement.submitted");
    expect(submittedAudit).toHaveLength(1);
    expect(submittedAudit[0].evidence).toMatchObject({ orderId, txHash: result.txHash });
    const wf = await query(`SELECT state FROM workflows WHERE id = $1;`, [workflowId]);
    expect(wf.rows[0].state).toBe(WorkflowState.CONFIRMED);
  });

  it("confirmSettlement then finishes it exactly once, and a second call returns the stored result", async () => {
    const env = await arcEnv();
    const unsure = arcAdapter(env.chain, env.deployed.address, receiptLookupDown(env.chain));
    const unsureRunner = new ProcurementWorkflowRunner({ settlementFor: () => unsure });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(unsureRunner, wsId, FLOUR, SUPPLIER);
    await settleOnArc(wsId);
    const submitted = await unsureRunner.fulfillAndReconcile(orderId, wsId);
    expect(submitted.pending).toBe(AWAITING);
    const stockBefore = await stockOf(wsId, FLOUR);
    const order = await orderRow(orderId);

    const healthy = new ProcurementWorkflowRunner({ settlementFor: () => env.adapter });
    const first = await healthy.confirmSettlement(orderId, wsId);
    expect(first).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true, txHash: submitted.txHash });
    expect(first.alreadyReconciled).toBeUndefined();

    const second = await healthy.confirmSettlement(orderId, wsId);
    expect(second).toMatchObject({ reconciled: true, alreadyReconciled: true, txHash: submitted.txHash });

    expect(await settlementLogs(env)).toHaveLength(1);
    expect(await supplierBalance(env)).toBe(BigInt(order.total_price_cents) * 10n ** 16n);
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore + Number(order.quantity));
    const journal = await query(`SELECT * FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows).toHaveLength(1);
    expect((await orderRow(orderId)).status).toBe("reconciled");
  });

  it("a reverted transaction ends in payment_hold with SETTLEMENT_FAILED and nothing is restocked", async () => {
    const adapter = new ScriptedSettlementAdapter("local");
    adapter.transferStatus = "submitted";
    adapter.confirmStatus = "failed";
    adapter.confirmFailureCode = "REVERTED";
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId, FLOUR);
    const stockBefore = await stockOf(wsId, FLOUR);

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toEqual({
      status: MatchStatus.MATCHED,
      reconciled: false,
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      hold: "SETTLEMENT_FAILED",
    });

    const row = await orderRow(orderId);
    expect(row.status).toBe("payment_hold");
    expect(row.tx_hash).toBe(result.txHash);
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore);
    const journal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows.length).toBe(0);

    const failed = await auditRows(wsId, "settlement.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ actor_type: "system", actor_id: "settlement_engine", policy_decision: "DENY" });
    expect(failed[0].evidence).toMatchObject({ orderId, hold: "SETTLEMENT_FAILED", failureCode: "REVERTED" });
  });

  it("an over-limit rejection ends in payment_hold with SETTLEMENT_REJECTED and the audit row carries DailyLimitExceeded", async () => {
    const env = await arcEnv();
    await ownerWrite(env, "setDailyLimit", [ONE_USDC_WEI]);
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => env.adapter });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId, FLOUR, SUPPLIER);
    await settleOnArc(wsId);
    const stockBefore = await stockOf(wsId, FLOUR);

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "SETTLEMENT_REJECTED" });

    const row = await orderRow(orderId);
    expect(row.status).toBe("payment_hold");
    expect(row.tx_hash).toBeNull();
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore);
    expect(await settlementLogs(env)).toHaveLength(0);
    expect(await supplierBalance(env)).toBe(0n);

    const rejected = await auditRows(wsId, "settlement.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ actor_type: "system", actor_id: "settlement_engine", policy_decision: "DENY" });
    expect(rejected[0].evidence).toEqual({ orderId, code: "DailyLimitExceeded" });
  });

  it("a settlement_submitted order still counts toward the daily budget", async () => {
    const adapter = new ScriptedSettlementAdapter("local");
    adapter.transferStatus = "submitted";
    adapter.confirmStatus = "submitted";
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter });
    const wsId = await newWorkspace(30000n); // $300.00; the flour order is $245.00
    const { orderId } = await confirmedOrder(runner, wsId, FLOUR);

    expect((await runner.fulfillAndReconcile(orderId, wsId)).pending).toBe(AWAITING);
    expect((await orderRow(orderId)).status).toBe("settlement_submitted");

    const tools = createReplenishmentTools({ workspaceId: wsId, workflowId: "wf_unused" });
    const ctx = JSON.parse(await tools.getBusinessContextTool.invoke({}));
    expect(ctx.todayCumulativeSpentCents).toBe("24500");
    expect(ctx.remainingDailyBudgetCents).toBe("5500");
  });

  it("local simulation labels the decision record SETTLED_LOCAL_SIMULATION", async () => {
    const adapter = new ScriptedSettlementAdapter("local"); // submitted, then confirmed on the one confirm call
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter });
    const wsId = await newWorkspace();
    const { workflowId, orderId } = await confirmedOrder(runner, wsId, FLOUR);
    await attachDecisionRecord(workflowId);

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true });

    const anchor = anchorOf(workflowId);
    expect(anchor).toContain("`SETTLED_LOCAL_SIMULATION`");
    expect(anchor).not.toContain("SETTLED_ON_ARC_TESTNET");
  });

  it("POST confirm-settlement returns 404 for an unknown order, 409 for an order that is not awaiting confirmation, and 200 with the stored result when called again after reconcile", async () => {
    const app = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    const baseUrl = addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "";
    let ownerToken = "";
    const post = async (route: string) => {
      const res = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    try {
      const wsId = await newWorkspace();
      ownerToken = (await issueToken(wsId, "owner", "settle-owner")).token;
      const notYetPaid = await confirmedOrder(new ProcurementWorkflowRunner(), wsId, FLOUR);

      const unknown = await post(`/api/orders/ord_missing_${Date.now()}/confirm-settlement`);
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ error: expect.any(String), code: "ORDER_NOT_FOUND" });

      const notAwaiting = await post(`/api/orders/${notYetPaid.orderId}/confirm-settlement`);
      expect(notAwaiting.status).toBe(409);
      expect(notAwaiting.body).toMatchObject({ error: expect.any(String), code: "ORDER_NOT_AWAITING_CONFIRMATION" });

      await query(`UPDATE inventory_items SET current_quantity = 1 WHERE workspace_id = $1 AND sku = $2;`, [wsId, MILK]);
      const paid = await confirmedOrder(new ProcurementWorkflowRunner(), wsId, MILK);
      const reconciled = await post(`/api/orders/${paid.orderId}/reconcile`);
      expect(reconciled.status).toBe(200);
      expect(reconciled.body).toMatchObject({ reconciled: true });

      const again = await post(`/api/orders/${paid.orderId}/confirm-settlement`);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ reconciled: true, alreadyReconciled: true, txHash: reconciled.body.txHash });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a confirm() that throws after a successful send leaves the order settlement_submitted with its hash and never pays twice", async () => {
    const env = await arcEnv();
    const wrapped = new ConfirmThrowsAdapter(env.adapter);
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => wrapped });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId, FLOUR, SUPPLIER);
    await settleOnArc(wsId);
    const order = await orderRow(orderId);
    const stockBefore = await stockOf(wsId, FLOUR);

    const first = await runner.fulfillAndReconcile(orderId, wsId);
    expect(first).toEqual({
      status: MatchStatus.MATCHED,
      reconciled: false,
      txHash: expect.stringMatching(HASH_RE),
      pending: AWAITING,
    });
    const row = await orderRow(orderId);
    expect(row.status).toBe("settlement_submitted");
    expect(row.tx_hash).toBe(first.txHash);
    expect(await supplierBalance(env)).toBe(BigInt(order.total_price_cents) * 10n ** 16n);

    // A retry sees the stored hash and waits. It does not send a second transfer.
    const second = await runner.fulfillAndReconcile(orderId, wsId);
    expect(second).toMatchObject({ reconciled: false, pending: AWAITING, txHash: first.txHash });
    expect(wrapped.transferCalls).toBe(1);
    expect(await settlementLogs(env)).toHaveLength(1);
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore);
    expect((await orderRow(orderId)).status).toBe("settlement_submitted");
  });

  it("two concurrent confirmSettlement calls finish the order once", async () => {
    const adapter = new ScriptedSettlementAdapter("local");
    adapter.transferStatus = "submitted";
    adapter.confirmStatus = "submitted";
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId, FLOUR);
    expect((await runner.fulfillAndReconcile(orderId, wsId)).pending).toBe(AWAITING);
    const stockBefore = await stockOf(wsId, FLOUR);
    const order = await orderRow(orderId);

    // The confirm holds the claim open, so the second caller really races the first.
    adapter.confirmStatus = "confirmed";
    adapter.confirmDelayMs = 150;
    const results = await Promise.allSettled([runner.confirmSettlement(orderId, wsId), runner.confirmSettlement(orderId, wsId)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof runner.confirmSettlement>>>).value);

    const winners = values.filter((v) => v.reconciled && v.alreadyReconciled === undefined);
    expect(winners).toHaveLength(1);
    const txHash = winners[0].txHash;
    for (const value of values.filter((v) => v !== winners[0])) {
      const inProgress = value.reconciled === false && value.hold === "RECONCILE_IN_PROGRESS";
      const stored = value.reconciled === true && value.alreadyReconciled === true && value.txHash === txHash;
      expect(inProgress || stored).toBe(true);
    }

    expect(adapter.transferCalls).toBe(1);
    expect(adapter.confirmCalls).toBe(2); // one from settle, one from the winning confirmSettlement
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore + Number(order.quantity));
    const journal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows).toHaveLength(1);
    expect((await orderRow(orderId)).status).toBe("reconciled");
  });

  it("confirmSettlement rejects a missing order with ORDER_NOT_FOUND", async () => {
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => new ScriptedSettlementAdapter("local") });
    const wsId = await newWorkspace();
    const error = await runner.confirmSettlement("ord_does_not_exist", wsId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettlementOrderError);
    expect((error as SettlementOrderError).code).toBe("ORDER_NOT_FOUND");
  });

  it("confirmSettlement finishes against the receipt, bill and amount that were paid, not the latest stored documents", async () => {
    const adapter = new ScriptedSettlementAdapter("local");
    adapter.transferStatus = "submitted";
    adapter.confirmStatus = "submitted";
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId, FLOUR);
    const paid = await runner.fulfillAndReconcile(orderId, wsId);
    expect(paid.pending).toBe(AWAITING);
    const order = await orderRow(orderId);
    const stockBefore = await stockOf(wsId, FLOUR);
    const paidQuantity = Number(order.quantity);

    // Newer documents are stored after the payment was sent. They must not change what the payment was for.
    const laterReceiptId = `rcpt_later_${orderId}`;
    const laterBillId = `bill_later_${orderId}`;
    await query(
      `INSERT INTO delivery_receipts (id, order_id, received_quantity, received_at, condition_notes, discrepancy_reported)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour', 'later receipt', FALSE);`,
      [laterReceiptId, orderId, paidQuantity + 7]
    );
    await query(
      `INSERT INTO supplier_bills (id, order_id, bill_number, billed_quantity, billed_unit_price_cents, billed_total_cents, currency, received_at)
       VALUES ($1, $2, 'BILL-LATER', $3, 1000, 999999, 'USDC', NOW() + INTERVAL '1 hour');`,
      [laterBillId, orderId, paidQuantity + 7]
    );

    adapter.confirmStatus = "confirmed";
    const result = await runner.confirmSettlement(orderId, wsId);
    expect(result).toMatchObject({ reconciled: true, txHash: paid.txHash });

    const journal = await query(`SELECT amount_cents FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows).toHaveLength(1);
    expect(BigInt(journal.rows[0].amount_cents)).toBe(BigInt(order.total_price_cents));
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore + paidQuantity);
    const finished = await orderRow(orderId);
    expect(finished.status).toBe("reconciled");

    // The payment record keeps the documents that were matched when the transfer was sent.
    expect(BigInt(finished.settled_amount_cents)).toBe(BigInt(order.total_price_cents));
    expect(finished.settled_receipt_id).not.toBe(laterReceiptId);
    expect(finished.settled_bill_id).not.toBe(laterBillId);
    expect(finished.settled_receipt_id).toEqual(expect.any(String));
    expect(finished.settled_bill_id).toEqual(expect.any(String));
  });

  it("confirmSettlement refuses to guess when the payment record is incomplete", async () => {
    const adapter = new ScriptedSettlementAdapter("local");
    adapter.transferStatus = "submitted";
    adapter.confirmStatus = "submitted";
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId, FLOUR);
    expect((await runner.fulfillAndReconcile(orderId, wsId)).pending).toBe(AWAITING);
    const stockBefore = await stockOf(wsId, FLOUR);

    await query(`UPDATE orders SET settled_amount_cents = NULL WHERE id = $1;`, [orderId]);
    adapter.confirmStatus = "confirmed";

    const error = await runner.confirmSettlement(orderId, wsId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(orderId);
    expect((error as Error).message).toContain("settled_amount_cents");

    expect((await orderRow(orderId)).status).toBe("settlement_submitted");
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore);
    const journal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows).toHaveLength(0);
  });

  it("the payment record columns exist after migrations, and a second run changes nothing", async () => {
    const columns = async () =>
      (
        await query(
          `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orders'
             AND column_name IN ('settled_amount_cents', 'settled_receipt_id', 'settled_bill_id')
           ORDER BY column_name;`
        )
      ).rows;
    const expected = [
      { column_name: "settled_amount_cents", data_type: "bigint" },
      { column_name: "settled_bill_id", data_type: "text" },
      { column_name: "settled_receipt_id", data_type: "text" },
    ];

    // Recreate the table shape from before this change, then migrate.
    await query(`ALTER TABLE orders DROP COLUMN IF EXISTS settled_amount_cents, DROP COLUMN IF EXISTS settled_receipt_id, DROP COLUMN IF EXISTS settled_bill_id;`);
    expect(await columns()).toEqual([]);

    await runMigrations();
    expect(await columns()).toEqual(expected);
    await runMigrations();
    expect(await columns()).toEqual(expected);
  });
});
