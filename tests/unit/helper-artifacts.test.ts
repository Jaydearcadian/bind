import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHelperArtifact } from "../helpers/bind-settlement.js";

/**
 * Each Solidity test helper in contracts/test/helpers/ has a committed artifact in contracts/artifacts/helpers/, produced
 * by tools/compile-contract/generate.mjs. The same checks as contract-artifact.test.ts, one per helper file.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_SOURCES = path.join(ROOT, "contracts/test/helpers");
const HELPER_ARTIFACTS = path.join(ROOT, "contracts/artifacts/helpers");

const helperNames = fs
  .readdirSync(HELPER_SOURCES)
  .filter((f) => f.endsWith(".sol"))
  .map((f) => path.basename(f, ".sol"))
  .sort();

describe("committed Solidity test helper artifacts", () => {
  it("there is at least one helper, and each helper has an artifact", () => {
    expect(helperNames.length).toBeGreaterThan(0);
    for (const name of helperNames) {
      expect(
        fs.existsSync(path.join(HELPER_ARTIFACTS, `${name}.json`)),
        `contracts/artifacts/helpers/${name}.json is missing: run \`npm run contract:artifact\` and commit the result`
      ).toBe(true);
    }
  });

  for (const name of helperNames) {
    describe(name, () => {
      it("the artifact matches the helper source hash", () => {
        const artifact = loadHelperArtifact(name);
        const sourceSha256 = crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(HELPER_SOURCES, `${name}.sol`)))
          .digest("hex");
        expect(
          artifact.sourceSha256,
          `contracts/artifacts/helpers/${name}.json is stale: run \`npm run contract:artifact\` and commit the result`
        ).toBe(sourceSha256);
      });

      it("the artifact names the contract it was compiled from", () => {
        expect(loadHelperArtifact(name).contractName).toBe(name);
      });

      it("the artifact bytecode is non-empty hex and the ABI is non-empty", () => {
        const artifact = loadHelperArtifact(name);
        expect(artifact.bytecode).toMatch(/^0x(?:[0-9a-fA-F]{2})+$/);
        expect(artifact.abi.length).toBeGreaterThan(0);
      });
    });
  }

  it("ReentrantSupplier exposes the configure entry point and receive is payable", () => {
    const { abi } = loadHelperArtifact("ReentrantSupplier");
    expect(abi).toContainEqual(expect.objectContaining({ type: "function", name: "configure" }));
    expect(abi).toContainEqual(expect.objectContaining({ type: "receive", stateMutability: "payable" }));
  });
});
