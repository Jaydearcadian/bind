import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import { loadArtifact } from "../helpers/bind-settlement.js";

const SOURCE_URL = new URL("../../contracts/src/BindSettlement.sol", import.meta.url);

describe("committed BindSettlement compile artifact", () => {
  it("the artifact matches the Solidity source hash", () => {
    const artifact = loadArtifact();
    const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(SOURCE_URL)).digest("hex");
    expect(
      artifact.sourceSha256,
      "contracts/artifacts/BindSettlement.json is stale: run `npm run contract:artifact` and commit the result"
    ).toBe(sourceSha256);
  });

  it("the artifact exposes settleOrder and the SettlementExecuted event", () => {
    const { abi } = loadArtifact();
    expect(abi).toContainEqual(expect.objectContaining({ type: "function", name: "settleOrder" }));
    expect(abi).toContainEqual(expect.objectContaining({ type: "event", name: "SettlementExecuted" }));
  });

  it("the artifact bytecode is non-empty hex", () => {
    const { bytecode } = loadArtifact();
    expect(bytecode).toMatch(/^0x(?:[0-9a-fA-F]{2})+$/);
  });
});
